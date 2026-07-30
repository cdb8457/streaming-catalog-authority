import { spawnSync } from 'node:child_process';
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, openSync, unlinkSync } from 'node:fs';
import {
  MaintenanceRefused,
  assertPermittedCommand,
  type CommandOutcome,
  type CommandRunner,
  type FileInputRunner,
  type FileOutputRunner,
  type MaintenanceCommand,
} from './maintenance-safety.js';

// Phases 277-280 — the ONE place a maintenance command actually starts a process, and the argument parser
// every one of them shares.
//
// `shell: false`, ALWAYS, AND THERE IS NO OPTION FOR ANYTHING ELSE. A program and an argument array go to the
// operating system unchanged: there is no command line for a shell to re-split, so an operator-supplied name
// containing a semicolon, a backtick or a newline is a name containing those characters and nothing more.
// Every module above this one builds commands as values precisely so this can be true.
//
// -----------------------------------------------------------------------------------------------------
// A DATABASE DUMP GOES TO A DESCRIPTOR, NOT THROUGH A STRING.
// -----------------------------------------------------------------------------------------------------
//
// THE DEFECT THIS CLOSES. The first version captured `pg_dump` with `encoding: 'utf8'` into a JavaScript
// string and wrote that string back out. Two things were wrong with it, and both are the kind that only show
// up on somebody else's database:
//
//   * IT WAS NOT BYTE-FAITHFUL. A plain dump is bytes in the database's own encoding. Decoding them as UTF-8
//     replaces every invalid sequence with U+FFFD, silently, and re-encoding produces a file that is not what
//     `pg_dump` emitted — which is precisely the corruption the Phase 256 Windows guidance exists to prevent,
//     reintroduced in the automation that was meant to replace those hand commands.
//   * IT WAS NOT USABLE ON A REAL DATABASE. The whole dump had to fit in one string inside a 512 MiB buffer,
//     so a backup of an installation that had grown would fail at the moment it mattered.
//
// SO THE CHILD WRITES STRAIGHT INTO THE FILE. The destination is pre-created with `O_EXCL` and 0600 inside the
// same staging directory, its descriptor is handed to the child as stdout, and the bytes never enter this
// process at all: no encoding, no buffer, no bound but the disk's. `stderr` is still captured and bounded,
// because a diagnostic is worth having and is not the artifact.
//
// IT IS NOT A GENERAL REDIRECTION SURFACE. `runToFile` takes a command that has already passed the same guard
// every other command passes, and a descriptor this module opened itself. There is no shell, no `>` and no
// caller-supplied redirection — the only thing that can be written is the file this function created.

/** How much of a command's stderr is kept. A diagnostic, not an artifact. */
export const MAINTENANCE_MAX_STDERR_BYTES = 64 * 1024;

/** How much output a NON-file command may produce. Dumps do not go through here; reports do. */
export const MAINTENANCE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** How long any one maintenance command may take. A step that hangs is a schedule that never ends. */
export const MAINTENANCE_STEP_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The real runner.
 *
 * One of the two functions in this tranche that can start a process. Everything else takes a `CommandRunner`
 * and is therefore drivable by a suite with no daemon, no images and no network.
 */
export function realCommandRunner(): CommandRunner {
  return (command: MaintenanceCommand): CommandOutcome => {
    const run = spawnSync(command.program, [...command.args], {
      cwd: command.cwd,
      shell: false,
      encoding: 'utf8',
      maxBuffer: MAINTENANCE_MAX_OUTPUT_BYTES,
      timeout: MAINTENANCE_STEP_TIMEOUT_MS,
      windowsHide: true,
      // NO INHERITED ENVIRONMENT BEYOND WHAT DOCKER NEEDS TO FIND ITS DAEMON. A maintenance command has no
      // business carrying this shell's variables into a container's exec, and a narrowed environment is one
      // fewer way for a credential to travel somewhere nobody looked.
      env: narrowedEnvironment(),
    });
    if (run.error !== undefined) throw run.error;
    return {
      status: run.status ?? -1,
      stdout: run.stdout ?? '',
      stderr: boundedStderr(run.stderr ?? ''),
    };
  };
}

/**
 * The real BINARY-OUTPUT runner: the child's stdout is the file, byte for byte.
 *
 * The caller has already resolved the destination inside a private staging directory it created; this opens
 * it `O_EXCL` so it cannot be an existing file or a link, hands the descriptor to the child, `fsync`s it, and
 * removes it on every failure — a partial dump left behind under a name a later step reads is worse than no
 * dump at all.
 */
export function realFileOutputRunner(): FileOutputRunner {
  return (command: MaintenanceCommand, destination: string): CommandOutcome => {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    let fd: number;
    try {
      fd = openSync(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
    } catch {
      throw new MaintenanceRefused('the output file for this step could not be created; check the folder is writable');
    }
    let run;
    try {
      run = spawnSync(command.program, [...command.args], {
        cwd: command.cwd,
        shell: false,
        // 'ignore' for stdin, the DESCRIPTOR for stdout, a pipe for stderr. The bytes go from the child to
        // the file without this process seeing them.
        stdio: ['ignore', fd, 'pipe'],
        maxBuffer: MAINTENANCE_MAX_STDERR_BYTES,
        timeout: MAINTENANCE_STEP_TIMEOUT_MS,
        windowsHide: true,
        env: narrowedEnvironment(),
      });
      if (run.error === undefined && (run.status ?? -1) === 0) {
        // FLUSHED BEFORE THE DESCRIPTOR IS LET GO, so a dump that is durable-looking is durable.
        try { fsyncSync(fd); } catch { /* a filesystem that will not flush is reported by the size check below */ }
      }
    } finally {
      try { closeSync(fd); } catch { /* as above */ }
    }

    if (run.error !== undefined) { removeQuietly(destination); throw run.error; }
    const status = run.status ?? -1;
    if (status !== 0) { removeQuietly(destination); }
    return {
      status,
      // The stdout of a file-output command is the file. Nothing is returned here, and a caller that expected
      // bytes would be a caller that had misunderstood which runner it asked for.
      stdout: '',
      stderr: boundedStderr(run.stderr === null || run.stderr === undefined ? '' : String(run.stderr)),
    };
  };
}

/**
 * The real BINARY-INPUT runner: the child's stdin is the file, byte for byte. Phase 301.
 *
 * The mirror of `realFileOutputRunner`, and the reason a restore never copies a dump into a container. The
 * source is opened `O_RDONLY` **without following a symbolic link** and `fstat`ed on that descriptor, so the
 * bytes that reach `psql` are the bytes of the object that was verified — a leaf swapped for a link between
 * the verification and the replay is refused at the open rather than followed.
 *
 * Nothing is written by this function at all. It reads a file the caller resolved inside a verified set and
 * hands the descriptor to a child; there is no shell, no `<`, and no destination.
 */
export function realFileInputRunner(): FileInputRunner {
  return (command: MaintenanceCommand, source: string): CommandOutcome => {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    let fd: number;
    try {
      fd = openSync(source, fsConstants.O_RDONLY | noFollow);
    } catch {
      throw new MaintenanceRefused(
        'the file this step replays could not be opened, or it is a symbolic link. Nothing was replayed.');
    }
    let run;
    try {
      // WINDOWS HAS NO `O_NOFOLLOW`, so the guarantee is re-established the way every other read in this
      // family re-establishes it: ask the OPEN DESCRIPTOR what it is. A directory, a device or a named pipe
      // at that path is refused here rather than streamed into a database.
      if (!fstatSync(fd).isFile()) {
        throw new MaintenanceRefused('the file this step replays is not a regular file. Nothing was replayed.');
      }
      run = spawnSync(command.program, [...command.args], {
        cwd: command.cwd,
        shell: false,
        // The DESCRIPTOR for stdin, pipes for the rest. The bytes go from the file to the child without this
        // process seeing them, so nothing is decoded and nothing is bounded by a buffer.
        stdio: [fd, 'pipe', 'pipe'],
        maxBuffer: MAINTENANCE_MAX_STDERR_BYTES,
        timeout: MAINTENANCE_STEP_TIMEOUT_MS,
        windowsHide: true,
        env: narrowedEnvironment(),
      });
    } finally {
      try { closeSync(fd); } catch { /* nothing rests on this close */ }
    }

    if (run.error !== undefined) throw run.error;
    return {
      status: run.status ?? -1,
      // A replay's stdout is `psql`'s chatter. It is bounded and stripped the same way stderr is, because it
      // can carry a table name and is never an artifact.
      stdout: boundedStderr(run.stdout === null || run.stdout === undefined ? '' : String(run.stdout)),
      stderr: boundedStderr(run.stderr === null || run.stderr === undefined ? '' : String(run.stderr)),
    };
  };
}

/** The size of a file this process just wrote through a descriptor, asked of the file itself. */
export function writtenFileSize(destination: string): number {
  let fd: number;
  try {
    fd = openSync(destination, fsConstants.O_RDONLY);
  } catch {
    return 0;
  }
  try {
    return fstatSync(fd).size;
  } finally {
    try { closeSync(fd); } catch { /* nothing rests on this close */ }
  }
}

function removeQuietly(path: string): void {
  try { unlinkSync(path); } catch { /* the step already failed; a leftover is not a second failure */ }
}

/**
 * Bound and strip a child's stderr.
 *
 * A diagnostic is worth keeping and is not worth trusting: it is truncated so a chatty failure cannot fill
 * memory, and control characters are removed so a hostile one cannot rewrite a terminal.
 */
export function boundedStderr(text: string): string {
  const bounded = text.length > MAINTENANCE_MAX_STDERR_BYTES ? text.slice(0, MAINTENANCE_MAX_STDERR_BYTES) : text;
  return [...bounded].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join('');
}

/**
 * The environment a maintenance command runs with.
 *
 * An allowlist. `PATH` so the program can be found, `HOME` so Docker can find its own config, and the three
 * `DOCKER_*` variables that decide which daemon it talks to. Nothing else — and in particular nothing whose
 * name suggests a secret, which is how a credential ends up in a child process nobody audited.
 */
export function narrowedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP',
    'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// -----------------------------------------------------------------------------------------------------------
// Arguments
// -----------------------------------------------------------------------------------------------------------

export class MaintenanceUsageError extends Error {
  readonly code = 'CATALOG_MAINTENANCE_USAGE_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceUsageError';
  }
}

/**
 * A strict long-flag parser shared by every maintenance CLI.
 *
 * NO CREDENTIAL EVER ARRIVES THIS WAY, and the parser enforces it: a flag whose name suggests a secret is
 * refused outright, with the reason. A command line is visible in `ps`, in a scheduler's log and in shell
 * history, and a tool that accepts a password there has made that somebody else's problem.
 */
export const CREDENTIAL_FLAG_WORDS: readonly string[] = Object.freeze([
  'password', 'passwd', 'secret', 'token', 'key', 'credential', 'kek', 'apikey',
]);

/**
 * Flag names that name a DIRECTORY OF credentials rather than a credential.
 *
 * THE DEFECT THIS CLOSES, AND IT WAS PRE-EXISTING. The scan above is a substring scan, deliberately blunt so
 * nobody can argue their way past it. `--secrets` contains `secret`, so `ops:complete-backup -- --secrets
 * <rel>` — a flag its own usage text documents, and which names the FOLDER the setup script created — was
 * refused as though somebody had typed a password on a command line. The blunt check was right and its
 * verdict here was wrong.
 *
 * The exemption is an EXACT-NAME allowlist, not a relaxation of the scan: `--secrets` is permitted and
 * `--secret`, `--secrets-value`, `--db-secrets` and everything else are still refused. A relative path to a
 * folder is not a credential; the credential is the bytes in the files inside it, which no command here reads
 * from a command line.
 */
export const NON_CREDENTIAL_FLAG_NAMES: readonly string[] = Object.freeze(['secrets']);

export interface ParsedFlags {
  readonly values: Readonly<Record<string, string>>;
  readonly switches: ReadonlySet<string>;
}

export function parseMaintenanceFlags(
  argv: readonly string[],
  spec: { readonly values: readonly string[]; readonly switches: readonly string[] },
): ParsedFlags {
  const values: Record<string, string> = {};
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) throw new MaintenanceUsageError(`unexpected argument: ${argument}`);
    const name = argument.slice(2);
    const lower = name.toLowerCase();
    for (const word of NON_CREDENTIAL_FLAG_NAMES.includes(lower) ? [] : CREDENTIAL_FLAG_WORDS) {
      if (lower.includes(word)) {
        throw new MaintenanceUsageError(
          `--${name} looks like a credential, and this command takes none on a command line: a command line is `
          + 'visible in the process list, in your scheduler\'s log and in your shell history. Secrets reach this '
          + 'product through the files the setup script created.');
      }
    }
    if (spec.switches.includes(name)) { switches.add(name); continue; }
    if (!spec.values.includes(name)) throw new MaintenanceUsageError(`unknown option: --${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new MaintenanceUsageError(`--${name} needs a value`);
    values[name] = value;
    index += 1;
  }
  return { values, switches };
}

/**
 * Print a refusal, and ONLY a refusal this product wrote.
 *
 * THE DEFECT THIS CLOSES. The first version fell through to `err.message` for anything unexpected — and an
 * unexpected error here is a driver's or the runtime's, whose message routinely carries the absolute path it
 * failed on. A CLI that prints one has put an operator's appdata layout into whatever they paste into an
 * issue, through the one branch nobody writes a test for. So the two domain errors are printed in full,
 * because this product wrote every word of them, and everything else becomes a fixed sentence plus an errno
 * code — which names a rule and never a path.
 */
export function reportRefusal(err: unknown): string {
  if (err instanceof MaintenanceRefused || err instanceof MaintenanceUsageError) return err.message;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const named = typeof code === 'string' && /^[A-Z]{1,16}$/.test(code) ? ` (${code})` : '';
  return `this command failed for a reason it does not have safe wording for${named}. Nothing was published. `
    + 'Re-run with the same arguments to see whether it is repeatable.';
}

/** Belt-and-braces: every command a CLI hands to a real runner passes the guard here too. */
export function guardBeforeRunning(command: MaintenanceCommand): void {
  assertPermittedCommand(command);
}
