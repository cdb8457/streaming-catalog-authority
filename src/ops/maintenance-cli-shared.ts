import { spawnSync } from 'node:child_process';
import { MaintenanceRefused, type CommandOutcome, type CommandRunner, type MaintenanceCommand } from './maintenance-safety.js';

// Phases 277-280 — the ONE place a maintenance command actually starts a process, and the argument parser
// every one of them shares.
//
// `shell: false`, ALWAYS, AND THERE IS NO OPTION FOR ANYTHING ELSE. A program and an argument array go to the
// operating system unchanged: there is no command line for a shell to re-split, so an operator-supplied name
// containing a semicolon, a backtick or a newline is a name containing those characters and nothing more.
// Every module above this one builds commands as values precisely so this can be true.
//
// THE OUTPUT IS BOUNDED. A database dump can be large and is captured in memory here, so the bound is stated
// rather than discovered: past it the command fails rather than growing until the host does something worse.

/** How much output one maintenance command may produce. A dump larger than this needs a different tool. */
export const MAINTENANCE_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

/** How long any one maintenance command may take. A step that hangs is a schedule that never ends. */
export const MAINTENANCE_STEP_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The real runner.
 *
 * The only function in this tranche that can start a process. Everything else takes a `CommandRunner` and is
 * therefore drivable by a suite with no daemon, no images and no network.
 */
export function realCommandRunner(): CommandRunner {
  return (command: MaintenanceCommand): CommandOutcome => {
    const run = spawnSync(command.program, [...command.args], {
      cwd: command.cwd,
      shell: false,
      encoding: 'utf8',
      maxBuffer: MAINTENANCE_MAX_OUTPUT_BYTES,
      timeout: MAINTENANCE_STEP_TIMEOUT_MS,
      // NO INHERITED ENVIRONMENT BEYOND WHAT DOCKER NEEDS TO FIND ITS DAEMON. A maintenance command has no
      // business carrying this shell's variables into a container's exec, and a narrowed environment is one
      // fewer way for a credential to travel somewhere nobody looked.
      env: narrowedEnvironment(),
    });
    if (run.error !== undefined) throw run.error;
    return {
      status: run.status ?? -1,
      stdout: run.stdout ?? '',
      stderr: run.stderr ?? '',
    };
  };
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
    for (const word of CREDENTIAL_FLAG_WORDS) {
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

/** Print a refusal the way every maintenance CLI does: the message, and nothing else. */
export function reportRefusal(err: unknown): string {
  if (err instanceof MaintenanceRefused || err instanceof MaintenanceUsageError) return err.message;
  return err instanceof Error ? err.message : 'the command failed';
}
