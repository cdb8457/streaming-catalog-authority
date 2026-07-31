import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Phases 277-280 — the safety floor every host-side maintenance command stands on.
//
// WHAT THESE COMMANDS ARE. `ops:complete-backup`, `ops:backup-verify-set`, `ops:doctor-monitor` and
// `ops:upgrade-rehearsal` run on the HOST, beside a Compose project, and drive `docker compose` and the
// project's own already-shipped tools. They are automation around primitives that already exist — the Phase
// 256 component model, the Phase 257 offline inspector, the Phase 5/6 doctor — and they deliberately invent
// no second definition of what a backup is or of whether an installation is healthy.
//
// -----------------------------------------------------------------------------------------------------
// EVERY COMMAND IS A VALUE BEFORE IT IS AN EXECUTION.
// -----------------------------------------------------------------------------------------------------
//
// Nothing here builds a shell string. A command is a PROGRAM and an ARGUMENT ARRAY, and it is handed to an
// injected runner. Three things follow from that, and they are the reason for the shape:
//
//   1. THERE IS NO SHELL, SO THERE IS NOTHING TO INJECT INTO. Nothing is handed to an interpreter to
//      re-split, nothing is interpolated into a command line, and there are no quoting rules to get wrong. An
//      operator-supplied name that contains a semicolon is an argument containing a semicolon. (A suite scans
//      this file for the spelling of a shell invocation, so this comment deliberately does not write one.)
//   2. A SUITE CAN ASSERT THE EXACT ARGUMENTS. What this product would run is inspectable without running it,
//      so the acceptance harness drives the real planner against a recording runner and checks the argv
//      arrays and the files on disk — no daemon, no images, no network.
//   3. EVERY COMMAND PASSES A GUARD BEFORE IT RUNS. `assertPermittedCommand` refuses a program outside a
//      closed allowlist and refuses any argument carrying a URL, a registry, a media path, a media extension
//      or an acquisition word. The absolute invariant — this product never downloads, scrapes, plays or
//      acquires media, and never creates a media symlink — is therefore enforced at the one place every
//      maintenance command has to pass through, rather than by reading four files and hoping.
//
// -----------------------------------------------------------------------------------------------------
// PATHS ARE THE OTHER HALF, AND THEY ARE TREATED AS HOSTILE.
// -----------------------------------------------------------------------------------------------------
//
// These commands copy state and, in one place, remove what they created. Everything they touch must be inside
// a project root the operator named, must not be reached through a symbolic link, must not be a special file,
// and must not be a broad root somebody typed by accident. A path that cannot be proved to satisfy all four
// is REFUSED — never normalised into something that looks acceptable.
//
// NO PATH EVER REACHES AN OUTPUT. Reports carry base names, counts, digests and closed-set words. A support
// bundle that named an operator's appdata layout would be a support bundle that travels further than the
// question it answers.

export const MAINTENANCE_LOCK_DIRNAME = '.catalog-maintenance.lock';

/** Directories these commands create are private; files inside them are private too. */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export class MaintenanceRefused extends Error {
  readonly code = 'CATALOG_MAINTENANCE_REFUSED';

  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceRefused';
  }
}

// -----------------------------------------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------------------------------------

export interface MaintenanceCommand {
  readonly program: string;
  readonly args: readonly string[];
  /** Absolute, and always inside a resolved project root. Never printed. */
  readonly cwd: string;
  /** What this command is for, in the report. A closed phrase, never an interpolated path. */
  readonly purpose: string;
}

export interface CommandOutcome {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injected. Nothing in this module can start a process on its own. */
export type CommandRunner = (command: MaintenanceCommand) => CommandOutcome;

/**
 * A runner that binds the child's stdout DIRECTLY to a file this product created.
 *
 * Separate from `CommandRunner` on purpose: a command whose output is an artifact and a command whose output
 * is a report are different things, and giving them one type is how a dump ends up decoded into a string. The
 * `destination` is always a path the caller created inside its own private staging directory; there is no
 * shell and no caller-supplied redirection anywhere in this tranche.
 */
export type FileOutputRunner = (command: MaintenanceCommand, destination: string) => CommandOutcome;

/**
 * A runner that binds the child's stdin DIRECTLY to a file this product opened. Phase 301.
 *
 * THE EXACT MIRROR OF `FileOutputRunner`, AND FOR THE SAME REASONS. Phase 277 binds `pg_dump`'s stdout to a
 * descriptor so a dump is byte-faithful and unbounded; a restore replays those same bytes, and reading them
 * into a string to hand to a child would reintroduce both defects at the other end — U+FFFD for every byte
 * sequence that is not valid UTF-8, and a whole dump inside one buffer.
 *
 * IT IS ALSO WHY NOTHING IS COPIED INTO THE CONTAINER. `psql` reads its script from this descriptor, so there
 * is no temporary copy of an operator's entire database written inside a container for somebody to forget to
 * remove, and the file that is replayed is the one that was verified rather than a name that could have
 * become a link in between.
 *
 * `source` is always a path the caller has already resolved inside a verified backup set. There is no shell,
 * no `<` and no caller-supplied redirection: the only thing that can be read is the file this function opens.
 */
export type FileInputRunner = (command: MaintenanceCommand, source: string) => CommandOutcome;

export interface LedgerEntry {
  readonly program: string;
  readonly args: readonly string[];
  /** Where it ran. Recorded so a suite can PROVE production was never addressed, rather than infer it. */
  readonly cwd: string;
  readonly purpose: string;
  readonly status: number;
}

/**
 * Every command a run attempted, in order.
 *
 * It is evidence, and it is what the acceptance harness asserts against: "no network, no media, no
 * acquisition and no media-server command was issued" is a property of this list, checked after the fact,
 * rather than a claim about intent.
 */
export class CommandLedger {
  private readonly entries: LedgerEntry[] = [];

  record(command: MaintenanceCommand, status: number): void {
    this.entries.push({
      program: command.program, args: [...command.args], cwd: command.cwd, purpose: command.purpose, status,
    });
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  /** The flattened argv of every command, for a scan. */
  flat(): readonly string[] {
    return this.entries.flatMap((entry) => [entry.program, ...entry.args]);
  }
}

/**
 * The only programs a maintenance command may start.
 *
 * A closed set, and a short one. `docker` is how the shipped stack is driven; `node` is how this project's
 * own already-shipped tools are run. There is no `sh`, no `bash`, no `curl`, no `wget`, no package manager
 * and no compression tool — every one of those is either a shell (and therefore an injection surface) or a
 * way to reach the network.
 */
export const PERMITTED_PROGRAMS: readonly string[] = Object.freeze(['docker', 'node']);

/**
 * Argument substrings no maintenance command may carry, and what each one would mean if it did.
 *
 * The list is deliberately blunt. It is a last line rather than the only one — the planners below never build
 * such an argument — and a blunt check is one nobody can argue their way past.
 */
export const FORBIDDEN_ARGUMENT_TOKENS: readonly string[] = Object.freeze([
  '://',                                     // any URL, of any scheme
  'ghcr.io', 'docker.io', 'quay.io', 'registry-1',  // a registry, which means a fetch
  'jellyfin', 'plex', 'emby',                // a media server: not this command's business
  '/mnt/user/media', '/media/', 'Movies', 'Shows',  // a media library path
  '.mkv', '.mp4', '.m4v', '.avi',            // a media file
  'nzb', 'torrent', 'magnet', 'usenet', 'sabnzbd', 'nzbget',  // acquisition
  'curl', 'wget',                            // a fetch by another name
]);

/**
 * The ONLY `docker` family a maintenance command may use.
 *
 * IT USED TO BE SEVEN, AND THAT WAS A GUARD THAT DID NOT MATCH ITS CLAIM. `image`, `volume`, `container`,
 * `inspect`, `info` and `version` were listed because they sounded harmless, and nothing then constrained the
 * VERB under them — so `docker image pull`, `docker volume rm` and `docker container rm` were all permitted by
 * a guard whose documented purpose is that this product never fetches and never removes what it did not
 * create. Nothing in this tranche used any of them. A family nobody uses is a family that should not be
 * reachable, so there is one, and its verbs are closed.
 */
export const PERMITTED_DOCKER_SUBCOMMANDS: readonly string[] = Object.freeze(['compose']);

/** Compose verbs. `pull` is absent so that `--pull never` is a description rather than a hope. */
export const PERMITTED_COMPOSE_SUBCOMMANDS: readonly string[] = Object.freeze([
  'up', 'down', 'stop', 'start', 'create', 'exec', 'run', 'cp', 'ps', 'config', 'kill',
]);

/**
 * The ONLY global flags that may sit between `compose` and its verb, and whether each takes a value.
 *
 * A CLOSED SHAPE RATHER THAN A SKIP LOOP. The first version stepped forward by two for anything starting with
 * `-`, which means a malformed or unknown flag could shift the verb out of view entirely: `compose --nonsense
 * pull` parsed as if the verb were whatever landed at the index it happened to reach. Parsing the flags this
 * product actually emits — and refusing everything else — makes the verb the verb.
 */
export const PERMITTED_COMPOSE_GLOBAL_FLAGS: Readonly<Record<string, 'value'>> = Object.freeze({
  '-f': 'value',
  '-p': 'value',
  '--file': 'value',
  '--project-name': 'value',
});

/**
 * Refuse a command that is outside what maintenance is allowed to do.
 *
 * Called on EVERY command before it is handed to the runner, including by the planners' own tests, so a
 * command that would be forbidden cannot even be planned.
 */
export function assertPermittedCommand(command: MaintenanceCommand): void {
  if (!PERMITTED_PROGRAMS.includes(command.program)) {
    throw new MaintenanceRefused(
      `maintenance may only run ${PERMITTED_PROGRAMS.join(' or ')}, and something asked to run another program`);
  }
  for (const argument of command.args) {
    if (typeof argument !== 'string' || argument.length === 0) {
      throw new MaintenanceRefused('a maintenance command was built with an empty argument');
    }
    // The scan is case-insensitive on purpose: a registry or a media path spelled differently is the same
    // registry and the same media path.
    const lower = argument.toLowerCase();
    for (const token of FORBIDDEN_ARGUMENT_TOKENS) {
      if (lower.includes(token.toLowerCase())) {
        // The TOKEN is named — it is this project's own word — and the argument is not, because an argument
        // can be a host path.
        throw new MaintenanceRefused(
          `a maintenance command carried "${token}", which would make it reach a network, a media library or an `
          + 'acquisition system. Maintenance does none of those.');
      }
    }
  }
  if (command.program !== 'docker') return;

  const family = command.args[0];
  if (family === undefined || !PERMITTED_DOCKER_SUBCOMMANDS.includes(family)) {
    throw new MaintenanceRefused(
      `maintenance may only use these docker subcommands: ${PERMITTED_DOCKER_SUBCOMMANDS.join(', ')}. Every other `
      + 'family — image, volume, container — carries verbs that fetch or remove, and maintenance does neither.');
  }

  // The global flags, parsed as a closed shape. Anything unknown ends the command, not the loop.
  let index = 1;
  while (index < command.args.length) {
    const argument = command.args[index]!;
    if (!argument.startsWith('-')) break;
    const kind = PERMITTED_COMPOSE_GLOBAL_FLAGS[argument];
    if (kind === undefined) {
      throw new MaintenanceRefused(
        `a compose command carried the global flag "${argument}", which is not one of the ones this product `
        + `emits (${Object.keys(PERMITTED_COMPOSE_GLOBAL_FLAGS).join(', ')}). A flag nobody parses is a flag that `
        + 'can move the verb out of view.');
    }
    const value = command.args[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new MaintenanceRefused(`the compose global flag "${argument}" was given no value`);
    }
    index += 2;
  }
  const verb = command.args[index];
  if (verb === undefined || !PERMITTED_COMPOSE_SUBCOMMANDS.includes(verb)) {
    throw new MaintenanceRefused(
      `maintenance may only use these compose subcommands: ${PERMITTED_COMPOSE_SUBCOMMANDS.join(', ')}`);
  }
}

/**
 * Run one command through the injected runner, after the guard, recording it either way.
 *
 * The ledger records the command BEFORE its status is known and again with it, so a command that hung or
 * threw is still in the evidence. A refusal never reaches the runner at all.
 */
export function runGuardedToFile(
  runner: FileOutputRunner,
  ledger: CommandLedger,
  command: MaintenanceCommand,
  destination: string,
): CommandOutcome {
  assertPermittedCommand(command);
  let outcome: CommandOutcome;
  try {
    outcome = runner(command, destination);
  } catch (err) {
    ledger.record(command, -1);
    throw new MaintenanceRefused(`a maintenance step could not be run: ${describeRunnerFailure(err)}`);
  }
  ledger.record(command, outcome.status);
  return outcome;
}

/**
 * Run one command with its stdin bound to a file, after the same guard, recording it either way. Phase 301.
 *
 * A refusal never reaches the runner, and a runner that threw is still in the ledger — the same contract
 * `runGuarded` and `runGuardedToFile` have, because evidence that omits the step that failed is not evidence.
 */
export function runGuardedFromFile(
  runner: FileInputRunner,
  ledger: CommandLedger,
  command: MaintenanceCommand,
  source: string,
): CommandOutcome {
  assertPermittedCommand(command);
  let outcome: CommandOutcome;
  try {
    outcome = runner(command, source);
  } catch (err) {
    ledger.record(command, -1);
    throw new MaintenanceRefused(`a maintenance step could not be run: ${describeRunnerFailure(err)}`);
  }
  ledger.record(command, outcome.status);
  return outcome;
}

export function runGuarded(runner: CommandRunner, ledger: CommandLedger, command: MaintenanceCommand): CommandOutcome {
  assertPermittedCommand(command);
  let outcome: CommandOutcome;
  try {
    outcome = runner(command);
  } catch (err) {
    ledger.record(command, -1);
    throw new MaintenanceRefused(`a maintenance step could not be run: ${describeRunnerFailure(err)}`);
  }
  ledger.record(command, outcome.status);
  return outcome;
}

/** A runner failure, reduced to something safe: a code or a class name, never a message with a path in it. */
function describeRunnerFailure(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z]{1,16}$/.test(code)) return code;
  // THE NAME, ONLY IF IT LOOKS LIKE ONE. An error's `name` is writable, so a thrown object can carry anything
  // there — including a path or a fragment of a message somebody meant to keep out of a report.
  const name = err instanceof Error ? err.name : '';
  return /^[A-Za-z]{1,32}$/.test(name) ? name : 'an unknown failure';
}

// -----------------------------------------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------------------------------------

/**
 * Roots nothing may be a project root, a backup destination, or a cleanup target.
 *
 * A path somebody typed with a missing suffix is the classic way an automated cleanup removes a machine. The
 * list is short and absolute: a root is refused by SHAPE, before anything is read.
 */
export const BROAD_ROOTS: readonly string[] = Object.freeze([
  '/', '/root', '/home', '/etc', '/var', '/usr', '/bin', '/sbin', '/lib', '/opt', '/tmp', '/boot', '/dev',
  '/proc', '/sys', '/mnt', '/mnt/user', '/srv', '/media',
]);

/** How few path segments is too few for anything these commands create or remove. */
export const MIN_ROOT_SEGMENTS = 2;

/**
 * Resolve a directory an operator named, and refuse anything that is not a plain, contained, real directory.
 *
 * `realpath` FIRST, so every later comparison is between resolved paths: a symlinked root is not rejected
 * (an operator may legitimately keep their appdata behind one) but it is resolved once, here, so that nothing
 * downstream compares a link against a target and concludes containment that does not hold.
 */
export function resolveMaintenanceRoot(requested: string, what: string): string {
  if (requested.trim() === '') throw new MaintenanceRefused(`no ${what} was given`);
  if (requested.includes(NUL)) throw new MaintenanceRefused(`the ${what} is not a usable path`);
  if (!isAbsolute(requested)) {
    throw new MaintenanceRefused(`the ${what} must be an absolute path, so it cannot depend on where this ran`);
  }
  let real: string;
  try {
    real = realpathSync(resolve(requested));
  } catch {
    throw new MaintenanceRefused(`the ${what} does not exist or cannot be read`);
  }
  let stats;
  try {
    stats = lstatSync(real);
  } catch {
    throw new MaintenanceRefused(`the ${what} could not be examined`);
  }
  if (!stats.isDirectory()) throw new MaintenanceRefused(`the ${what} is not a directory`);
  assertNotBroadRoot(real, what);
  return real;
}

/** Refuse a path that is a system root or too shallow to be anything but a mistake. */
export function assertNotBroadRoot(real: string, what: string): void {
  const normalised = real.replace(/\\/g, '/').replace(/\/+$/, '');
  const comparable = normalised === '' ? '/' : normalised;
  for (const broad of BROAD_ROOTS) {
    if (comparable === broad || comparable.toLowerCase() === broad) {
      throw new MaintenanceRefused(`the ${what} is a system directory, and this command will not use one`);
    }
  }
  // A Windows drive root, and any path with too few segments to be a project.
  if (/^[A-Za-z]:$/.test(comparable) || /^[A-Za-z]:\/?$/.test(comparable)) {
    throw new MaintenanceRefused(`the ${what} is a drive root, and this command will not use one`);
  }
  const segments = comparable.split('/').filter((segment) => segment !== '' && !/^[A-Za-z]:$/.test(segment));
  if (segments.length < MIN_ROOT_SEGMENTS) {
    throw new MaintenanceRefused(
      `the ${what} is only ${segments.length} level(s) below the filesystem root, which is too shallow to be a `
      + 'project directory. Name the directory itself, not the folder it lives in.');
  }
}

const NUL = String.fromCharCode(0);

/** A name a maintenance command may create: no separator, no traversal, no leading dot, no surprises. */
export const MAINTENANCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export function assertUsableName(name: string, what: string): void {
  if (!MAINTENANCE_NAME_RE.test(name)) {
    throw new MaintenanceRefused(
      `the ${what} must be 1-96 characters of letters, digits, dot, dash and underscore, starting with a letter `
      + 'or digit, and must contain no folder part');
  }
}

/**
 * A path inside a resolved root, proved to be inside it and reached through no symbolic link.
 *
 * EVERY COMPONENT IS `lstat`ED. A path is contained only if each step from the root down is a real directory
 * (or, for the final component, whatever kind is expected) — a symlink anywhere along it is refused, because
 * containment established against a name says nothing about where the bytes are.
 */
export function resolveInsideRoot(root: string, relativePath: string, what: string): string {
  if (relativePath.includes(NUL)) throw new MaintenanceRefused(`the ${what} is not a usable path`);
  if (isAbsolute(relativePath)) throw new MaintenanceRefused(`the ${what} must be relative to the project root`);
  const segments = relativePath.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) throw new MaintenanceRefused(`the ${what} names nothing`);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    if (segment === '..') throw new MaintenanceRefused(`the ${what} must not step above the project root`);
    current = join(current, segment);
    const last = index === segments.length - 1;
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      if (last) return current; // a name that does not exist yet is legitimate for something being created
      throw new MaintenanceRefused(`the ${what} passes through a folder that is not there`);
    }
    if (stats.isSymbolicLink()) {
      throw new MaintenanceRefused(
        `the ${what} is reached through a symbolic link, and this command will not follow one out of the project`);
    }
    if (!last && !stats.isDirectory()) {
      throw new MaintenanceRefused(`the ${what} passes through something that is not a folder`);
    }
    if (last && !stats.isDirectory() && !stats.isFile()) {
      throw new MaintenanceRefused(`the ${what} is a special file, and this command handles only folders and files`);
    }
  }
  const inside = relative(root, current);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('..')) {
    throw new MaintenanceRefused(`the ${what} is outside the project root`);
  }
  return current;
}

/**
 * Refuse a directory tree that contains anything a maintenance command must not copy or trust.
 *
 * Walks bounded and refuses on the first finding, naming the KIND rather than the entry: a hostile name is a
 * value like any other. Reparse points on Windows surface as symbolic links here where Node can see them;
 * where it cannot, the refusal is stated as a limit rather than claimed as coverage.
 */
export function assertPlainTree(directory: string, what: string, maxEntries = 5000): number {
  let seen = 0;
  const walk = (current: string): void => {
    let entries: readonly string[];
    try {
      entries = readdirSync(current);
    } catch {
      throw new MaintenanceRefused(`the ${what} could not be listed`);
    }
    for (const entry of entries) {
      if (seen >= maxEntries) {
        throw new MaintenanceRefused(`the ${what} holds more than ${maxEntries} entries, which is more than this command will copy`);
      }
      seen += 1;
      const child = join(current, entry);
      let stats;
      try {
        stats = lstatSync(child);
      } catch {
        throw new MaintenanceRefused(`the ${what} holds an entry that could not be examined`);
      }
      if (stats.isSymbolicLink()) {
        throw new MaintenanceRefused(
          `the ${what} holds a symbolic link. A backup that follows one copies something else's bytes under this `
          + 'name, and a backup that stores one restores a link to a path that may not exist. Refused.');
      }
      if (stats.isDirectory()) { walk(child); continue; }
      if (!stats.isFile()) {
        throw new MaintenanceRefused(
          `the ${what} holds something that is neither a folder nor a regular file — a device, socket or pipe is `
          + 'not state a backup can capture. Refused.');
      }
    }
  };
  walk(directory);
  return seen;
}

// -----------------------------------------------------------------------------------------------------------
// Creating and publishing
// -----------------------------------------------------------------------------------------------------------

// -----------------------------------------------------------------------------------------------------------
// Reading a file that must not have been swapped underneath us
// -----------------------------------------------------------------------------------------------------------

/**
 * Can this platform open a file and be certain it did not follow a symbolic link to get there?
 *
 * The same question `catalog-import-inbox.ts` asks, for the same reason and with the same answer: where the
 * guarantee cannot be given, the answer is to REFUSE rather than to read and hope.
 */
export function noFollowSupported(): boolean {
  return typeof fsConstants.O_NOFOLLOW === 'number';
}

/**
 * Open a name ONCE, without following a symbolic link to reach it, and hand back the descriptor.
 *
 * WHERE THE PLATFORM CAN PROMISE IT, THE PROMISE IS ATOMIC. `O_NOFOLLOW` refuses a link at the open itself,
 * so there is no window at all between deciding what a name is and holding what it named.
 *
 * WHERE IT CANNOT — Windows, which has no `O_NOFOLLOW` — the fallback is stated honestly rather than either
 * skipped or fatal. `lstat` refuses a link (Windows reports reparse points as links, so this is a real
 * refusal, not a formality), the name is opened, and the open file description's identity is compared to the
 * one that was inspected. A swap between the two operations changes the file index and is refused. That is a
 * DETECTED race rather than an IMPOSSIBLE one, and the difference is written down here rather than implied by
 * a shared function name. The shipped deployment is Linux and takes the atomic path.
 *
 * Returning 0 or "unsupported" instead would have made every read on this platform fail closed — which sounds
 * safe and is actually how a suite stops testing anything.
 */
function openNoFollowDescriptor(path: string, what: string): number {
  if (noFollowSupported()) {
    try {
      return openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW as number));
    } catch (err) {
      throw openFailure(err, what);
    }
  }
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch {
    throw new MaintenanceRefused(`the ${what} could not be opened`);
  }
  if (before.isSymbolicLink()) {
    throw new MaintenanceRefused(`the ${what} is a symbolic link, and this command will not follow one`);
  }
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY);
  } catch (err) {
    throw openFailure(err, what);
  }
  let after: Stats;
  try {
    after = fstatSync(fd);
  } catch {
    try { closeSync(fd); } catch { /* the refusal below is the outcome either way */ }
    throw new MaintenanceRefused(`the ${what} could not be inspected once it was open`);
  }
  // A ZERO INDEX PROVES NOTHING, so it is not accepted as agreement.
  if (before.ino === 0 || after.ino === 0 || before.ino !== after.ino) {
    try { closeSync(fd); } catch { /* as above */ }
    throw new MaintenanceRefused(
      `the ${what} was replaced while it was being opened, so what was checked is not what would have been read`);
  }
  return fd;
}

function openFailure(err: unknown, what: string): MaintenanceRefused {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ELOOP' || code === 'EMLINK') {
    return new MaintenanceRefused(`the ${what} is a symbolic link, and this command will not follow one`);
  }
  if (code === 'EISDIR') return new MaintenanceRefused(`the ${what} is not a regular file`);
  return new MaintenanceRefused(`the ${what} could not be opened`);
}

/** How much of one component file this module will read into memory at once. */
export const MAX_COMPONENT_FILE_BYTES = 256 * 1024 * 1024;

export interface OpenedFile {
  readonly bytes: Buffer;
  readonly size: number;
}

/**
 * Read a file through ONE descriptor, opened without following a link, and answer every question of that
 * descriptor rather than of the name.
 *
 * THE DEFECT THIS CLOSES. The first version of the backup `lstat`ed each entry, decided it was a plain file,
 * and then RE-OPENED it by path to read, copy or digest it. Three resolutions of one name with a window
 * between each: a leaf swapped to a symbolic link in that window would be `lstat`ed as a file and read as
 * whatever it pointed at, and the digest recorded for a component would describe somebody else's bytes.
 * Backups run on a schedule, against a directory other things can write to, which is exactly where that
 * window is real.
 *
 * SO THE NAME IS USED ONCE. `open(O_RDONLY | O_NOFOLLOW)` refuses a link AT THE OPEN, atomically; `fstat`
 * then asks the open file description what it is; the bytes are read from that descriptor; and the size is
 * re-checked against what was actually read, so a file that grew or was truncated mid-read is refused rather
 * than absorbed.
 */
export function readFileNoFollow(path: string, what: string, maxBytes = MAX_COMPONENT_FILE_BYTES): OpenedFile {
  const fd = openNoFollowDescriptor(path, what);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new MaintenanceRefused(`the ${what} is not a regular file`);
    if (stats.size > maxBytes) {
      throw new MaintenanceRefused(`the ${what} is larger than the ${maxBytes} bytes this command will read`);
    }
    // ONE BYTE MORE THAN THE FSTAT SAID. That extra byte is what detects a file which GREW between the fstat
    // and the read; a short read is caught by the same comparison from the other side.
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, stats.size + 1));
    let total = 0;
    for (;;) {
      if (total >= buffer.byteLength) break;
      const read = readSync(fd, buffer, total, buffer.byteLength - total, total);
      if (read <= 0) break;
      total += read;
    }
    if (total !== stats.size) {
      throw new MaintenanceRefused(
        `the ${what} changed size while it was being read, so what was checked is not what was read`);
    }
    return { bytes: buffer.subarray(0, total), size: stats.size };
  } finally {
    try { closeSync(fd); } catch { /* a descriptor that will not close is not a reason to fail a completed read */ }
  }
}

/**
 * List a directory that was opened without following a link, and classify each entry from an `lstat` taken
 * for the walk only.
 *
 * The classification is advisory and is stated as such: what makes the WALK safe is that every FILE it
 * reaches is then opened with `O_NOFOLLOW`, so an entry that turns into a link between the listing and the
 * open is refused at the open rather than followed. A directory that turns into a link is refused when the
 * walk descends into it, for the same reason.
 */
export function assertDirectoryNoFollow(path: string, what: string): void {
  let fd: number;
  try {
    fd = openNoFollowDescriptor(path, what);
  } catch (err) {
    // A DIRECTORY OPENED FOR READING IS `EISDIR` ON SOME PLATFORMS AND FINE ON OTHERS. Either way the name
    // exists and was not a link — which is the entire question being asked — so that one refusal is the
    // answer "yes", and every other refusal still propagates.
    if (err instanceof MaintenanceRefused && err.message.endsWith('is not a regular file')) return;
    throw err;
  }
  try {
    if (!fstatSync(fd).isDirectory()) throw new MaintenanceRefused(`the ${what} is not a directory`);
  } finally {
    try { closeSync(fd); } catch { /* as above */ }
  }
}

/** Create a directory that only its owner can read, refusing an existing name. */
export function createPrivateDirectory(path: string, what: string): void {
  try {
    mkdirSync(path, { mode: PRIVATE_DIR_MODE });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MaintenanceRefused(`the ${what} already exists; this command will not write into one it did not create`);
    }
    throw new MaintenanceRefused(`the ${what} could not be created; check the parent folder is writable`);
  }
}

/**
 * Write a file inside a private directory, private itself, replacing nothing.
 *
 * TAKES BYTES OR TEXT, AND WRITES WHAT IT WAS GIVEN. A backup that re-encoded a component would be a backup
 * that restores something subtly different from what it copied — which is the same defect the Phase 256
 * Windows guidance exists for, and it must not reappear here through a convenient string round-trip.
 */
export function writePrivateFile(path: string, contents: string | Buffer, what: string): void {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, PRIVATE_FILE_MODE);
  } catch {
    throw new MaintenanceRefused(`the ${what} could not be created`);
  }
  try {
    writeFileSync(fd, typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents);
    fsyncSync(fd);
  } catch {
    throw new MaintenanceRefused(`the ${what} could not be written`);
  } finally {
    try { closeSync(fd); } catch { /* a descriptor that will not close is not a reason to fail a written file */ }
  }
}

/**
 * Publish a completed staging directory to its final name.
 *
 * REFUSES AN EXISTING FINAL NAME. That is checked and then done, and the honest description of the gap is
 * this: the LOCK below is what stops two of this product's own runs racing, and the rename is what makes the
 * final name appear complete or not at all. A third party creating the final name inside the window gets a
 * failed rename rather than a silent replacement, because `rename` onto a non-empty directory fails.
 */
export function publishDirectory(staging: string, final: string, what: string): void {
  if (existsSync(final)) {
    throw new MaintenanceRefused(
      `a ${what} of that name is already there. This command will not replace one: name a new one, or move the `
      + 'old one aside deliberately.');
  }
  try {
    renameSync(staging, final);
  } catch {
    throw new MaintenanceRefused(`the ${what} could not be moved into place; something already holds that name`);
  }
}

// -----------------------------------------------------------------------------------------------------------
// The lock
// -----------------------------------------------------------------------------------------------------------

/**
 * WHICH DIRECTORY THIS IS, as the filesystem answers it rather than as a path spells it.
 *
 * -----------------------------------------------------------------------------------------------------
 * A PATH IS NOT AN IDENTITY, AND `process.platform` IS NOT A FILESYSTEM — CORRECTION 1.
 * -----------------------------------------------------------------------------------------------------
 *
 * TWO WRONG ANSWERS WERE TRIED BEFORE THIS ONE, and both are worth writing down because both looked right.
 *
 *   1. FOLDING CASE ON `win32`/`darwin`. That is a guess about a HOST when the question is about a
 *      DIRECTORY: macOS ships case-sensitive APFS volumes, Windows supports per-directory case sensitivity,
 *      and a Linux host can mount a case-insensitive filesystem. On a case-SENSITIVE volume, `backups` and
 *      `Backups` are two real different directories that a folded comparison treats as one — so a
 *      capability for the first would have authorised writing into the second, which nothing holds a lock on.
 *   2. COMPARING THE CURRENT DIRECTORY AT A PATH WITH THE CURRENT DIRECTORY AT THAT SAME PATH. That is a
 *      tautology dressed as a proof. Rename the held destination away, create a new directory at the
 *      original path, and the check passes — while the lock that was actually taken sits in the inode that
 *      moved. The capability would authorise publishing into a directory nothing is holding.
 *
 * SO THE IDENTITY IS CAPTURED WHEN THE LOCK IS TAKEN and compared against the directory that is there NOW.
 * `ino`/`dev` survive a rename and change when a name is reused, which is exactly the distinction a path
 * cannot make.
 */
interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * The identity of a directory, or `null` when this filesystem will not say.
 *
 * A ZERO INODE PROVES NOTHING, and every caller of this treats `null` as a refusal rather than as a pass —
 * so a filesystem that cannot answer stops the nested operation instead of silently authorising it. `dev`
 * is NOT required to be non-zero: Windows reports `0` for it and a real, stable, rename-surviving `ino`.
 */
function directoryIdentity(path: string): DirectoryIdentity | null {
  // `bigint`, AND IT IS NOT A STYLE CHOICE. A Windows file index is 64 bits and routinely exceeds 2^53 —
  // this repository's own worktree reports one — so the default `number` inode is a LOSSY reading of it.
  // Two distinct directories whose indices differ only below the float's precision would compare EQUAL,
  // which is the one mistake an identity check may never make: it is what decides whether a capability
  // authorises a directory and whether a release deletes a lock. Exact integers, or nothing.
  const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink()) return null;
  if (stats.ino === 0n) return null;
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(a: DirectoryIdentity | null, b: DirectoryIdentity | null): boolean {
  return a !== null && b !== null && a.ino === b.ino && a.dev === b.dev;
}

export interface MaintenanceLock {
  readonly path: string;
  release(): void;
}

/**
 * One maintenance command at a time, per project root.
 *
 * `mkdir` IS THE LOCK. It is the one filesystem operation that both creates and refuses atomically, so two
 * runs started a millisecond apart cannot both believe they hold it — which matters because these commands
 * stop services, and two of them stopping and starting the same stack is how a backup ends up spanning two
 * different states of the database.
 *
 * A STALE LOCK IS NOT BROKEN AUTOMATICALLY. A directory left by a killed run is reported, with what is inside
 * it, and removing it is an operator's decision. Automatic staleness detection means guessing whether another
 * process is alive, and guessing wrong here means two writers.
 *
 * AND A RUN ONLY EVER RELEASES ITS OWN. Release is bound to the identity of the directory this call created
 * and to a token inside it, so a lock that has been renamed away and replaced at the same path is left
 * exactly where it is rather than deleted out from under whoever now holds it. See `releaseOwnedLock`.
 */
export function acquireMaintenanceLock(root: string): MaintenanceLock {
  return acquireLockDirectory(join(root, MAINTENANCE_LOCK_DIRNAME),
    'another maintenance command is already running for this project, or one was interrupted and left its '
    + `lock behind (${MAINTENANCE_LOCK_DIRNAME} in the project root). Wait for it, or remove that directory `
    + 'once you are sure nothing is running.');
}

/**
 * `mkdir` as a lock, at a caller-chosen name.
 *
 * SEPARATE LOCKS FOR SEPARATE INVARIANTS. The project lock exists so two commands cannot stop and start the
 * same stack at once. A read-modify-write of one small state file needs its own, held for a much shorter
 * time and taken where the file lives — sharing the project lock would mean a five-minute monitor schedule
 * refusing every time a backup is running, which teaches an operator to ignore its exit code.
 */
export function acquireLockDirectory(path: string, contention: string): MaintenanceLock {
  try {
    mkdirSync(path, { mode: PRIVATE_DIR_MODE });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new MaintenanceRefused(contention);
    throw new MaintenanceRefused('the maintenance lock could not be taken; check the directory it lives in is writable');
  }
  // ---- WHAT THIS CALL OWNS, CAPTURED AT THE MOMENT IT OWNED IT ------------------------------------
  //
  // The identity of the directory the `mkdir` just created, and an unguessable token written inside it.
  // Release is bound to BOTH — see below for the deletion this prevents.
  const mine = directoryIdentity(path);
  const token = randomBytes(16).toString('hex');
  // What is inside it is diagnostic plus this one token. No secret, no path: a pid, the token, nothing else.
  try {
    writePrivateFile(join(path, HOLDER_FILE_NAME), `pid=${process.pid}\ntoken=${token}\n`,
      'maintenance lock holder file');
  } catch { /* the lock is the directory; a missing note inside it does not weaken it */ }
  return {
    path,
    release: () => releaseOwnedLock(path, mine, token),
  };
}

/** The note a lock directory carries. Diagnostic, plus the token that says whose lock it is. */
export const HOLDER_FILE_NAME = 'holder.txt';

/**
 * Release a lock ONLY IF IT IS STILL THE LOCK THIS CALL CREATED.
 *
 * -----------------------------------------------------------------------------------------------------
 * A PATH IS NOT OWNERSHIP — CORRECTION 1.
 * -----------------------------------------------------------------------------------------------------
 *
 * THE DEFECT THIS CLOSES, and it was found by a test written for a different bug. Release used to `unlink`
 * and `rmdir` whatever was at the remembered PATH. Rename the directory a lock lives in — a backup
 * destination moved aside, a project directory renamed — and create a new directory at the old path, and
 * that path now holds SOMEBODY ELSE'S lock. The `finally` of the first run would then delete a live lock
 * belonging to another process, while its own real lock sat, still held, inside the directory that moved.
 * One command tidying up would silently unlock a destination another command was working in.
 *
 * SO RELEASE PROVES OWNERSHIP FIRST, two ways, and does NOTHING when either fails:
 *
 *   * THE DIRECTORY IDENTITY captured when the `mkdir` returned. `ino`/`dev` survive a rename and change
 *     when a name is reused, which is exactly the distinction a path cannot make.
 *   * A UNIQUE TOKEN written inside it. It covers the filesystems that report no usable inode, and it is
 *     checked whenever the note is readable — so a lock directory that was emptied and rebuilt by another
 *     process is not ours either.
 *
 * AND THE FAILURE MODE IS THE SAFE ONE. Refusing to release leaves a stale lock, which the next run reports
 * and an operator removes deliberately. Releasing the wrong one removes a live lock and nobody finds out.
 * Between "somebody has to clean up" and "two writers in one destination", this picks the first, every time.
 */
function releaseOwnedLock(path: string, mine: DirectoryIdentity | null, token: string): void {
  const now = directoryIdentity(path);
  if (mine !== null) {
    // The normal case: we know which directory we made, so anything else at this path is not it.
    if (!sameIdentity(mine, now)) return;
  } else if (readHolderToken(path) !== token) {
    // No usable identity from this filesystem, so the token is the only proof there is. No token, no removal.
    return;
  }
  // A NOTE THAT IS THERE MUST BE OURS, AND MUST BE READABLE AS OURS. Three outcomes, three answers:
  //
  //   ABSENT      — fine. Writing it is best-effort at acquisition, and the identity above already proved
  //                 this is the directory this call created.
  //   OUR TOKEN   — fine.
  //   ANYTHING ELSE — somebody else's token, a note that is a symbolic link, one larger than a note has any
  //                 business being, or bytes that are not a note at all. Every one of those means this
  //                 directory is not in the state this call left it in, and the safe answer to that is to
  //                 remove NOTHING. A stale lock is reported by the next run; a wrongly deleted one is not.
  const found = readHolderToken(path);
  if (found !== HOLDER_ABSENT && found !== token) return;
  try { unlinkSync(join(path, HOLDER_FILE_NAME)); } catch { /* may not exist */ }
  try { rmdirSync(path); } catch { /* a lock that will not release is reported by the next run, not hidden */ }
}

/** There is nothing at the note's name. Distinct from "there is something and it is not ours". */
const HOLDER_ABSENT = Symbol('catalog-authority.lock-holder-absent');
/** There is something, and it is not a note this product wrote. Never equal to any token. */
const HOLDER_UNREADABLE = Symbol('catalog-authority.lock-holder-unreadable');

/** How large a lock's holder note may be. It is two short lines; anything more is not one of ours. */
export const MAX_HOLDER_FILE_BYTES = 4096;

/**
 * The token inside a lock directory: our token, ABSENT, or UNREADABLE. Never throws.
 *
 * IT IS READ THE WAY EVERY OTHER FILE IN THIS MODULE IS READ — through `readFileNoFollow`, which opens the
 * name once without following a symbolic link and refuses one larger than the bound. A lock directory sits
 * in a backup destination an operator owns, and the note inside it decides whether this process DELETES a
 * lock; reading it by name with no bound would mean a link at that name could point release at somebody
 * else's file, and a large file at that name could be pulled whole into memory to answer a question about
 * thirty-two hex characters.
 *
 * THE THREE OUTCOMES ARE KEPT APART on purpose. Absent is a legitimate state — writing the note is
 * best-effort at acquisition — while unreadable is evidence that something touched this directory, and the
 * caller must be able to tell those apart rather than treating both as "no token".
 */
function readHolderToken(path: string): string | typeof HOLDER_ABSENT | typeof HOLDER_UNREADABLE {
  const notePath = join(path, HOLDER_FILE_NAME);
  try {
    // `throwIfNoEntry: false` COVERS ONLY ENOENT. `EACCES`, `EIO`, `ENOTDIR` and a path that has become
    // something `lstat` will not answer about all still THROW — and this is called from a `finally`, so an
    // escaping error would replace whatever result the command was carrying with a filesystem error about
    // a lock note. Absence is the ONLY outcome of this probe that means "there is nothing here"; every
    // other failure means "this cannot be read", which is not permission to delete anything.
    if (lstatSync(notePath, { throwIfNoEntry: false }) === undefined) return HOLDER_ABSENT;
    const raw = readFileNoFollow(notePath, 'maintenance lock holder file', MAX_HOLDER_FILE_BYTES)
      .bytes.toString('utf8');
    const match = /^token=([0-9a-f]{32})$/m.exec(raw);
    return match === null ? HOLDER_UNREADABLE : match[1]!;
  } catch {
    // A link, a special file, one that changed size while it was read, one over the bound, or a name this
    // process cannot examine at all.
    return HOLDER_UNREADABLE;
  }
}

/** A short, unguessable suffix for a staging directory beside its final name. */
export function stagingSuffix(): string {
  return randomBytes(6).toString('hex');
}

// -----------------------------------------------------------------------------------------------------------
// Phases 321-328 — the SECOND lock domain: one physical backup destination, across projects
// -----------------------------------------------------------------------------------------------------------

/**
 * The lock every command that reads or writes a backup destination takes, by name.
 *
 * -----------------------------------------------------------------------------------------------------
 * WHY IT IS HERE AND NOT IN ONE OF THE COMMANDS.
 * -----------------------------------------------------------------------------------------------------
 *
 * It used to live in `ops:backup-retention` and be reachable only from there, and `ops:safety-set-lifecycle`
 * imported it. That was already the wrong home by the second command and it became a hole with the third and
 * fourth: `ops:complete-backup` and `ops:complete-restore` took only their own PROJECT lock, so a second
 * Compose project pointed at the same physical directory could publish a set, claim a safety-set directory or
 * destroy an installation while a prune held that directory mid-quarantine. The Phase 313-320 report named it
 * as its first remaining risk. This is the one definition that closes it.
 *
 * -----------------------------------------------------------------------------------------------------
 * THE NAME DID NOT CHANGE, AND THAT IS THE WHOLE POINT — CORRECTION 1.
 * -----------------------------------------------------------------------------------------------------
 *
 * The first cut renamed this to `.catalog-destination.lock` because the old name says "retention" and the
 * lock is not retention's any more. It then had to keep the old name working, so it `lstat`ed
 * `.catalog-retention.lock` first and `mkdir`ed `.catalog-destination.lock` afterwards. THAT IS A CHECK
 * FOLLOWED BY A CREATE ON A DIFFERENT NAME, WHICH IS NOT A LOCK: an `ops:backup-retention` from an older
 * build could `mkdir` the old name in the window between the two, and both processes would then believe they
 * held the destination. The rename made a tidier word and a WEAKER guarantee than the one it inherited.
 *
 * So the FILENAME is the compatibility contract and it is frozen. One name, one `mkdir`, one atomic
 * operation, and an old build and a new build contend on exactly the same directory entry with no window at
 * all between them. What changed is the VOCABULARY around it — the constant, the type, the refusal sentence
 * and the documentation all say "destination" — because a name on disk that two versions must agree on is
 * not the same kind of thing as a name in the source that only this version reads.
 *
 * IT IS A DIRECTORY IN THE DESTINATION, WHICH IS WHY IT IS PHYSICAL. Two projects that reach one directory
 * by two different relative paths still `mkdir` the same inode, so exclusion holds across projects without
 * any registry, daemon, port or shared file anywhere.
 */
export const DESTINATION_LOCK_DIRNAME = '.catalog-retention.lock';

/**
 * Every name that is a destination lock to this build.
 *
 * ONE ENTRY, DELIBERATELY. A second name here would mean a second `mkdir` or a pre-check, and a pre-check of
 * one name followed by an acquisition of another is exactly the race Correction 1 removed. The list exists
 * because two inventories have to EXCLUDE the lock from what they count, and one list is better than two
 * literals in two files.
 */
export const DESTINATION_LOCK_DIRNAMES: readonly string[] = Object.freeze([DESTINATION_LOCK_DIRNAME]);

/**
 * The ONE sentence an operator reads when a destination is busy, whichever of the four commands they ran.
 *
 * It names all four, and it names the cross-project case, because the whole point of this lock is that the
 * command holding it may not be one in the project the operator is standing in.
 */
export const DESTINATION_LOCK_CONTENTION =
  'another command is already working in this backup destination — ops:complete-backup, ops:complete-restore, '
  + 'ops:backup-retention or ops:safety-set-lifecycle, in this project or in ANOTHER project pointed at the '
  + `same directory — or one was interrupted and left its lock behind (${DESTINATION_LOCK_DIRNAME} in the `
  + 'destination). Nothing was changed. Wait for it, or remove that directory once you are sure nothing is '
  + 'running.';

/** A destination resolved to the physical directory a lock would be taken in. */
export interface ResolvedDestination {
  readonly projectRoot: string;
  readonly destinationDir: string;
  /** Exactly what the operator wrote, relative to the project. This is what a journal records. */
  readonly destinationRelative: string;
  /** The destination's own leaf name. The only part of it that ever reaches a report. */
  readonly destinationName: string;
}

/**
 * Turn a named destination directory into the PHYSICAL one, and refuse the two shapes nothing may use.
 *
 * `realpath` narrows the ways two callers can disagree about which directory they mean — a symlinked
 * ancestor, a `.` segment, a separator spelling. It is NOT what makes the lock exclusive: that is the
 * `mkdir` inside the directory, which two spellings of one directory share whether or not `realpath`
 * normalises them (Node's does not canonicalise case on Windows, and it does not need to).
 *
 * The caller has ALREADY proved containment with `resolveInsideRoot`, which refuses a symbolic link at every
 * component — so this cannot be handed a name that resolves out of the project.
 */
export function provePhysicalDestination(projectRoot: string, destinationDir: string): string {
  const real = resolveMaintenanceRoot(destinationDir, 'backup destination');
  if (real === projectRoot) {
    throw new MaintenanceRefused('the backup destination cannot be the project root itself');
  }
  return real;
}

/**
 * Resolve a destination named RELATIVE to the project, to the physical directory a lock lives in.
 *
 * IT IS RELATIVE, AND THAT IS WHY A JOURNAL CAN RECORD IT. A durable file in an operator's project directory
 * has no business carrying that operator's absolute appdata layout; the journal lives IN the project root,
 * so the project root is the one path a reader always already has, and everything else is expressed against
 * it. `destinationRelative` is therefore what the operator wrote, unchanged — never the resolved path.
 */
export function resolveBackupDestination(projectRoot: string, relative: string): ResolvedDestination {
  const destinationDir = provePhysicalDestination(
    projectRoot, resolveInsideRoot(projectRoot, relative, 'backup destination'));
  return {
    projectRoot,
    destinationDir,
    destinationRelative: relative,
    destinationName: basename(destinationDir),
  };
}

/**
 * THE ONE DEFINITION of the namespace `ops:complete-restore` claims inside a backup destination.
 *
 * It lives here, on the floor every backup-family command already stands on, because THREE things now
 * depend on agreeing about it exactly: the restore builds the name, `ops:safety-set-lifecycle` recognises
 * it, and — since Correction 1 — `ops:complete-backup` refuses to be pointed at one and the capability
 * check authorises exactly one of them. Three copies of a regular expression is how those four commands
 * would eventually disagree about which directories are claims.
 */
export const SAFETY_CLAIM_DIR_PREFIX = '.pre-restore-claim-';

/** `.pre-restore-claim-<24 hex>` and nothing else. The nonce shape is the restore's CSPRNG output. */
export const SAFETY_CLAIM_DIR_RE = /^\.pre-restore-claim-[0-9a-f]{24}$/;

/** Is this base name a restore's claim directory? Asked of a LEAF, never of a path. */
export function isSafetyClaimDirName(name: string): boolean {
  return SAFETY_CLAIM_DIR_RE.test(name);
}

/**
 * Refuse an ordinary backup that was pointed INTO a restore's claim namespace.
 *
 * -----------------------------------------------------------------------------------------------------
 * WHY A STANDALONE BACKUP MAY NOT PUBLISH INTO A CLAIM — CORRECTION 1.
 * -----------------------------------------------------------------------------------------------------
 *
 * The destination lock is taken in the directory a command was told to publish into. So an operator who
 * hand-points `ops:complete-backup --destination backups/.pre-restore-claim-<nonce>` takes a lock INSIDE
 * the claim — while `ops:backup-retention` and `ops:safety-set-lifecycle` are locking the destination
 * ABOVE it. Two commands would then be working in one destination at the same time, each holding a lock
 * the other never looks at, and the lifecycle command would be counting and quarantining claim directories
 * whose contents were being written underneath it. The first cut of this tranche listed exactly that as an
 * open risk; it is closed here rather than described.
 *
 * EVERY COMPONENT IS CHECKED, not just the leaf. `backups/.pre-restore-claim-<nonce>/deeper` is inside a
 * claim too, and the lock it would take is just as far below the one that matters.
 *
 * THE LEGITIMATE PATH IS UNAFFECTED, because it is not this path: `ops:complete-restore` publishes its
 * safety set through a `HeldDestination` minted while it holds the enclosing destination, and that
 * capability — not a flag and not a name — is what authorises the claim as a target.
 */
export function assertNotSafetyClaimNamespace(projectRoot: string, relativeDestination: string): void {
  const segments = relativeDestination.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
  let parent = projectRoot;
  let claim = false;
  for (const segment of segments) {
    if (segmentNamesAClaim(parent, segment)) { claim = true; break; }
    parent = join(parent, segment);
  }
  // ---- AND AGAIN OVER WHAT IS REALLY THERE ---------------------------------------------------------
  //
  // The literal request is what an operator typed; the resolved path is what the filesystem has. They can
  // differ — a `.` segment, a separator spelling, a symlinked ancestor above the project root — and the
  // question "is this inside a claim" is about the second one. `resolveInsideRoot` has already refused a
  // link at any component below the root, so this is a cheap confirmation rather than a second policy.
  if (!claim) {
    const real = fullyExistingRealPath(join(projectRoot, ...segments));
    if (real !== null) {
      const inside = relative(projectRoot, real).split(/[\\/]/).filter((part) => part !== '' && part !== '.');
      let realParent = projectRoot;
      for (const segment of inside) {
        if (segmentNamesAClaim(realParent, segment)) { claim = true; break; }
        realParent = join(realParent, segment);
      }
    }
  }
  if (!claim) return;
  throw new MaintenanceRefused(
    'this backup was pointed at a directory inside a restore\'s safety-set claim namespace '
    + `(${SAFETY_CLAIM_DIR_PREFIX}<nonce>). A claim belongs to the ops:complete-restore run that created `
    + 'it, and publishing into one would take this command\'s destination lock BELOW the lock '
    + 'ops:backup-retention and ops:safety-set-lifecycle take on the destination above it — so two commands '
    + 'would be working in one destination at once. Name the backup destination itself. Nothing was taken.');
}

/**
 * Is this one path segment a claim directory, ASKED OF THE FILESYSTEM THE PARENT IS ON?
 *
 * -----------------------------------------------------------------------------------------------------
 * CASE INSENSITIVITY IS A PROPERTY OF A DIRECTORY, NOT OF A HOST, AND NOT OF EVERY DIRECTORY.
 * -----------------------------------------------------------------------------------------------------
 *
 * A literal match is the easy half. The hard half is `backups/.PRE-RESTORE-CLAIM-<nonce>`: on a
 * case-insensitive volume that names the SAME directory as the lower-case claim and must be refused, and on
 * a case-SENSITIVE volume it is a different directory an operator is entitled to use as a destination.
 * Folding case for everyone breaks the second; folding it for `win32`/`darwin` guesses at a machine when
 * the question is about a volume — macOS ships case-sensitive APFS and Windows supports per-directory case
 * sensitivity.
 *
 * SO IT IS MEASURED, HERE, ON THIS PARENT. If the segment is a claim once lower-cased, the lower-cased name
 * is looked up beside it: same directory by `ino`/`dev`, and the two spellings are one directory and this IS
 * a claim; a different directory or no directory at all, and they are genuinely two names and this is not.
 * Nothing is inferred from a platform and nothing is folded anywhere else.
 */
function segmentNamesAClaim(parent: string, segment: string): boolean {
  if (isSafetyClaimDirName(segment)) return true;
  const folded = segment.toLowerCase();
  if (folded === segment || !isSafetyClaimDirName(folded)) return false;

  // ---- IDENTITY FIRST, AS CORROBORATION AND NEVER AS THE ONLY DETECTOR ---------------------------
  //
  // When the filesystem answers with inodes, two spellings that resolve to one inode ARE one directory and
  // two that resolve to different inodes are two. But `directoryIdentity` returns null on a filesystem
  // that reports `ino` 0 — and a `sameIdentity` that is false because nothing could be measured would
  // ALLOW the alias, which is failing OPEN in the one place the capability code deliberately fails closed.
  const requested = directoryIdentity(join(parent, segment));
  const lower = directoryIdentity(join(parent, folded));
  if (sameIdentity(requested, lower)) return true;
  if (requested !== null && lower !== null) return false;   // measured, and genuinely two directories

  // ---- SO THE LISTING IS THE DETECTOR THAT STILL WORKS WITHOUT INODES ----------------------------
  //
  // A directory entry exists under exactly the spelling the filesystem stores. If the parent lists the
  // requested spelling, that spelling is a real, distinct entry and this volume is case-sensitive here. If
  // it lists only the lower-case claim while the requested spelling nevertheless RESOLVES, the two names
  // reach one entry: an alias, and refused.
  let names: readonly string[];
  try {
    names = readdirSync(parent);
  } catch {
    // Cannot tell. If the requested spelling resolves at all, refuse: an unanswerable question about a
    // claim namespace is not permission to publish into one.
    return entryExists(join(parent, segment));
  }
  if (names.includes(segment)) return false;
  return names.includes(folded) && entryExists(join(parent, segment));
}

/** Is there anything at this name? Never throws — an unanswerable name is reported as absent to callers
 * that treat absence as "not an alias", and every one of those has already required the name to resolve. */
function entryExists(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/**
 * The real path of this path when ALL of it exists, or `null`.
 *
 * It is deliberately not a deepest-existing-ancestor walk: the caller uses it to re-ask the claim question
 * of what is really on disk, and a path that is not fully there has no components on disk to re-ask about.
 */
function fullyExistingRealPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Take the destination lock. ONE `mkdir`, ONE name, no pre-check of anything.
 *
 * NOT EXPORTED — CORRECTION 1. A command module that could call this could take it before the project lock,
 * or take it and forget to release it, and the ordering guarantee would be four files agreeing to be careful.
 * The only route is `MaintenanceLocks`, which cannot exist without the project lock.
 *
 * A STALE LOCK IS NEVER BROKEN AUTOMATICALLY. Automatic staleness detection means guessing whether another
 * process is alive, and the four commands behind this lock stop stacks, destroy volumes and delete the only
 * copy of things nobody can produce again. Guessing wrong here means two writers in one destination.
 */
function acquireDestinationLock(destinationDir: string): MaintenanceLock {
  return acquireLockDirectory(join(destinationDir, DESTINATION_LOCK_DIRNAME), DESTINATION_LOCK_CONTENTION);
}


/**
 * PROOF THAT A CALLER HOLDS BOTH LOCKS FOR A NAMED PROJECT AND A NAMED PHYSICAL DESTINATION.
 *
 * -----------------------------------------------------------------------------------------------------
 * WHAT THIS REPLACED, AND WHY A BOOLEAN COULD NOT DO THE JOB — CORRECTION 1.
 * -----------------------------------------------------------------------------------------------------
 *
 * `ops:complete-backup` used to accept a `holdingLock` boolean. That is an unbound bypass: it names no project,
 * no destination and no holder, so ANY caller could set it and suppress BOTH locks for ANY project and ANY
 * destination. The only thing standing between that flag and an unlocked backup was a suite that grepped
 * `src/` for the word — and a source allowlist is a lint rule, not an authority. A future route, a future
 * scheduler or a copy-paste into a new module would have passed the grep and skipped the locks.
 *
 * A CAPABILITY IS THE ANSWER, AND IT IS NOT FORGEABLE.
 *
 *   * IT CAN ONLY BE MINTED BY A REAL `MaintenanceLocks` THAT ALREADY HOLDS BOTH. There is no exported
 *     constructor and no exported factory; `MINTED` is a module-private `WeakSet` and membership in it is
 *     the identity check. A plain object cast to this type — the one forgery TypeScript cannot stop — is
 *     refused at runtime because it was never put in that set.
 *   * IT IS BOUND TO A CANONICAL PROJECT ROOT AND A CLOSED SET OF TWO TARGETS: the held destination
 *     itself, or ONE EXISTING `.pre-restore-claim-<nonce>` directory directly inside it. Not every
 *     descendant — the one caller publishes into exactly one directory, and that is exactly what this
 *     permits. A sibling, a parent, another project, an arbitrary subdirectory and a claim that does not
 *     exist are all refused.
 *   * IT IS BOUND TO A DIRECTORY, NOT TO A PATH. The `ino`/`dev` of the destination and of the lock
 *     directory inside it are captured when the lock is TAKEN, so a destination renamed away and rebuilt
 *     at the same path is a different directory and is refused. `physical` in the documentation means
 *     this: path reuse does not satisfy it.
 *   * IT DIES WITH ITS OWNER. `release()` invalidates it, so a scope that outlived the locks it describes
 *     authorises nothing — which is the exact shape of the bug this whole correction exists for.
 */
export interface HeldDestination {
  /** The canonical project root whose maintenance lock the holder is holding. */
  readonly projectRoot: string;
  /** The physical destination directory whose lock the holder is holding. */
  readonly destinationDir: string;
}

/** Genuine capabilities. Membership is the identity: a cast object is not in here and never can be. */
const MINTED = new WeakSet<object>();
/** Every capability a given stack has minted, so `release()` can invalidate them all. */
const LIVE = new WeakSet<object>();

/**
 * WHAT A CAPABILITY IS REALLY BOUND TO, kept where nothing outside this module can read or fabricate it.
 *
 * It is a `WeakMap` rather than fields on the object for one reason: the public shape stays the two strings
 * a caller may legitimately want to read, and the part that decides authority — the identity of the
 * directory the lock was taken in, and of the lock directory itself — cannot be spelled by a cast at all.
 */
interface CapabilityBinding {
  /** The destination directory as it was when the lock was taken. */
  readonly destination: DirectoryIdentity;
  /** The lock directory this stack created inside it. The owner token, tied to the actual lock. */
  readonly lock: DirectoryIdentity;
}
const BINDING = new WeakMap<object, CapabilityBinding>();

/**
 * Refuse anything that is not a live capability for exactly this project and this destination.
 *
 * CALLED BEFORE THE FIRST EFFECT, ALWAYS. The whole value of a capability is that the check happens before a
 * directory is created, a journal or claim is written, a staging tree is built or a child command runs.
 */
export function assertHeldDestination(
  held: HeldDestination,
  projectRoot: string,
  destinationDir: string,
): void {
  if (typeof held !== 'object' || held === null || !MINTED.has(held)) {
    throw new MaintenanceRefused(
      'this operation was handed something claiming to prove that its caller already holds this project\'s '
      + 'lock and this destination\'s, and it is not one this product minted. Nothing was changed. Only a '
      + 'command that is really holding both locks can authorise a nested operation to skip them.');
  }
  if (!LIVE.has(held)) {
    throw new MaintenanceRefused(
      'the caller that authorised this nested operation has already released its locks, so nothing is '
      + 'holding this destination and this operation would run unprotected. Nothing was changed.');
  }
  if (held.projectRoot !== projectRoot) {
    throw new MaintenanceRefused(
      'this operation was authorised by a command holding a DIFFERENT project\'s lock. A lock on one project '
      + 'is not permission to act in another. Nothing was changed.');
  }
  // ---- A CLOSED SET OF TWO TARGETS, NOT "ANYTHING UNDERNEATH" — CORRECTION 1 -----------------------
  //
  // The first cut authorised every descendant of the held destination. That is far more than the one
  // caller needs and it is a real widening: a capability minted for `backups` would have authorised
  // publishing into `backups/anything/at/all`, including a directory a future phase gives its own meaning
  // to. What the legitimate caller actually does is publish into ONE directory — the claim it has already
  // created — so that is what a capability authorises, and nothing else.
  //
  //   1. THE HELD DESTINATION ITSELF. Exactly the directory whose lock is held; there is nothing to widen.
  //   2. ONE EXISTING CLAIM DIRECTORY DIRECTLY INSIDE IT. The leaf must be `.pre-restore-claim-<24 hex>`,
  //      its parent must be the held destination, and it must ALREADY EXIST as a real directory — because
  //      creating the claim is how the restore takes ownership of it, and a capability is permission to
  //      publish into something owned, never permission to invent it.
  const claimTarget = destinationDir !== held.destinationDir;
  const enclosing = claimTarget ? dirname(destinationDir) : destinationDir;
  if (claimTarget && !(isSafetyClaimDirName(basename(destinationDir)) && enclosing === held.destinationDir)) {
    throw new MaintenanceRefused(
      'this operation was authorised by a command holding a DIFFERENT backup destination. A held '
      + 'destination permits exactly two targets: that directory itself, and one EXISTING safety-set claim '
      + 'directory immediately inside it. A sibling, a parent, an arbitrary directory underneath it, or a '
      + 'name that is not a claim is not covered by that lock. Nothing was changed.');
  }

  // ---- AND THE ENCLOSING DIRECTORY MUST STILL BE THE ONE THE LOCK IS IN -----------------------------
  //
  // The path matching is necessary and nowhere near sufficient. If the held destination were renamed away
  // and a NEW directory created at the same path, every string here would still line up while the lock
  // that was actually taken sat in the inode that moved — so this compares the directory that is there NOW
  // against the identity captured when `lockDestination` acquired, AND against the identity of the lock
  // directory itself, which is the owner token: a replacement directory does not contain this run's lock.
  const binding = BINDING.get(held);
  if (binding === undefined
    || !sameIdentity(binding.destination, directoryIdentity(enclosing))
    || !sameIdentity(binding.lock, directoryIdentity(join(enclosing, DESTINATION_LOCK_DIRNAME)))) {
    throw new MaintenanceRefused(
      'the backup destination this operation was authorised for is not the directory that is at that path '
      + 'now — it has been renamed, replaced or unmounted since its lock was taken, so the lock is not in '
      + 'the directory this would publish into. Nothing was changed.');
  }

  if (!claimTarget) return;
  const claim = lstatSync(destinationDir, { throwIfNoEntry: false });
  if (claim !== undefined && claim.isDirectory() && !claim.isSymbolicLink()) return;
  throw new MaintenanceRefused(
    'this operation was authorised to publish into a safety-set claim directory that is not there. '
    + 'Creating the claim is how a restore takes ownership of it, so a claim that has gone is a claim '
    + 'nothing owns, and this command will not recreate one behind that recovery\'s back. Nothing was '
    + 'changed.');
}

/**
 * The project lock and the destination lock, in the ONE order this product takes them.
 *
 * -----------------------------------------------------------------------------------------------------
 * THE ORDER IS STRUCTURAL, NOT A CONVENTION FOUR FILES AGREE TO FOLLOW.
 * -----------------------------------------------------------------------------------------------------
 *
 * PROJECT FIRST, DESTINATION SECOND, AND THE RELEASE IS THE EXACT REVERSE. Two projects sharing one
 * destination is the whole reason the second lock exists, and it is also the shape that deadlocks: if one
 * command took the destination first and another took the project first, two runs could each hold what the
 * other is waiting for. There is no waiting here — `mkdir` refuses rather than blocks — so the failure would
 * be mutual refusal rather than a hang, which is better and still wrong.
 *
 * SO THERE IS NO WAY TO EXPRESS THE OTHER ORDER. `acquireDestinationLock` is not exported; the only way to
 * reach it is through an instance of this class, and the only way to get one of those is to take the project
 * lock. `release()` releases what it holds innermost-first regardless of what a call site remembers.
 *
 * THE DESTINATION IS LOCKED LATE ON PURPOSE. Three of the four commands do not know which destination they
 * are acting on until they have read a journal — and that journal may only be read under the project lock,
 * because a journal read before the lock describes a moment that has passed. So this is acquired in two
 * steps: the project at construction, the destination once the operation knows what it is.
 */
export class MaintenanceLocks {
  /** Canonical. Every capability this stack mints is bound to it, and compared against it exactly. */
  private readonly projectRoot: string;
  private project: MaintenanceLock | null;
  private destination: MaintenanceLock | null = null;
  private destinationDir: string | null = null;
  /** Captured when the lock was taken, not read again later. This is what a capability is bound to. */
  private binding: CapabilityBinding | null = null;
  private held: HeldDestination | null = null;
  private released = false;

  private constructor(projectRoot: string, project: MaintenanceLock) {
    this.projectRoot = projectRoot;
    this.project = project;
  }

  /**
   * Take this project's maintenance lock. Everything else follows it.
   *
   * THE ROOT IS CANONICALISED HERE rather than trusted from the caller, so the project a capability is bound
   * to is the project the lock is in — not a second spelling of it that a later comparison would reject, and
   * not a first spelling that a later comparison would wrongly accept.
   */
  static open(projectRoot: string): MaintenanceLocks {
    const canonical = resolveMaintenanceRoot(projectRoot, 'project directory');
    return new MaintenanceLocks(canonical, acquireMaintenanceLock(canonical));
  }

  /** Whether this stack holds the destination lock. */
  get holdsDestination(): boolean {
    return this.destination !== null;
  }

  /**
   * Take the destination lock, once, after the project lock.
   *
   * `destinationDir` must already be physical — see `provePhysicalDestination`.
   */
  lockDestination(destinationDir: string): void {
    if (this.released) {
      throw new MaintenanceRefused('a destination lock was asked for after the locks were released');
    }
    if (this.destination !== null) {
      throw new MaintenanceRefused('one operation may hold one destination lock, and this one asked twice');
    }
    const lock = acquireDestinationLock(destinationDir);
    this.destination = lock;
    this.destinationDir = destinationDir;
    // CAPTURED HERE, AT THE MOMENT THE `mkdir` SUCCEEDED, and never re-read. A capability minted from this
    // stack is bound to THESE two inodes: the destination this lock is in, and the lock directory itself.
    const destination = directoryIdentity(destinationDir);
    const owner = directoryIdentity(lock.path);
    this.binding = destination === null || owner === null ? null : { destination, lock: owner };
  }

  /**
   * Mint the proof a NESTED operation needs in order to skip locks this stack is already holding.
   *
   * REFUSED UNLESS BOTH LOCKS ARE REALLY HELD. There is no way to obtain one of these speculatively, before
   * the destination is locked, or after the locks are gone.
   */
  heldDestination(): HeldDestination {
    if (this.released) {
      throw new MaintenanceRefused('a held-destination proof was asked for after the locks were released');
    }
    if (this.destination === null || this.destinationDir === null) {
      throw new MaintenanceRefused(
        'a held-destination proof was asked for by a command that has not taken the destination lock');
    }
    if (this.held !== null) return this.held;
    // FAIL CLOSED WHEN IDENTITY CANNOT BE PROVEN. A capability that could not say WHICH directory it is for
    // could only ever be checked against a path, and a path can be renamed away and rebuilt. No capability
    // is better than one that means nothing: the nested operation refuses rather than running unprotected.
    if (this.binding === null) {
      throw new MaintenanceRefused(
        'this filesystem does not report a usable identity for the backup destination, so a nested '
        + 'operation could not be tied to the directory the lock is actually in. Nothing was changed.');
    }
    const held: HeldDestination = Object.freeze({
      projectRoot: this.projectRoot,
      destinationDir: this.destinationDir,
    });
    MINTED.add(held);
    LIVE.add(held);
    BINDING.set(held, this.binding);
    this.held = held;
    return held;
  }

  /** Release what is held, innermost first. Safe to call twice; every path out of an operation runs it. */
  release(): void {
    this.released = true;
    // THE CAPABILITY DIES FIRST. Anything still holding one must be refused from this instant, and it must
    // be refused even if a lock below fails to release — an authorisation that outlives its locks is the
    // whole class of defect this exists to close.
    if (this.held !== null) {
      LIVE.delete(this.held);
      BINDING.delete(this.held);
      this.held = null;
    }
    const destination = this.destination;
    this.destination = null;
    this.destinationDir = null;
    this.binding = null;
    const project = this.project;
    this.project = null;
    // DESTINATION FIRST, THEN PROJECT. A release that let go of the project first would open a window in
    // which this project could start a second command while this one still held the shared destination.
    //
    // AND THE SECOND RELEASE HAPPENS EVEN IF THE FIRST FAILS. `acquireLockDirectory`'s release swallows its
    // own failures today, so this `finally` is defence rather than a fix — but a lock that could not be
    // released is exactly the moment a bare sequence would leave THIS PROJECT permanently locked by a
    // process that has finished, which is a worse outcome than the stale destination lock that caused it.
    try {
      if (destination !== null) destination.release();
    } finally {
      if (project !== null) project.release();
    }
  }
}

// -----------------------------------------------------------------------------------------------------------
// Removing something this product created — and nothing else
// -----------------------------------------------------------------------------------------------------------

/**
 * Remove ONE regular file whose bytes are the ones this product wrote.
 *
 * THE DIGEST IS THE PROOF OF OWNERSHIP. A cleanup that removed "the file at the name we chose" removes
 * whatever is at that name, which after an operator has edited or replaced it is their file. Opening it
 * without following a link, digesting THAT descriptor and refusing on a mismatch means the only thing this can
 * delete is a byte-for-byte copy of something it produced.
 *
 * `unlink` is used rather than any recursive removal, so this can never reach a directory or a link target.
 */
export function removeOwnFileNoFollow(path: string, expectedDigest: string, what: string): void {
  const actual = digestFileNoFollow(path, what);
  if (actual.digest !== expectedDigest) {
    throw new MaintenanceRefused(
      `the ${what} is not the file this command wrote, so it was left alone. Look at it and remove it yourself `
      + 'if it is stale.');
  }
  try {
    unlinkSync(path);
  } catch {
    throw new MaintenanceRefused(`the ${what} could not be removed`);
  }
}

/** How many entries a removal will walk before it refuses. A tree larger than this is not one of ours. */
export const MAX_REMOVAL_ENTRIES = 5000;

/**
 * Remove a directory tree this product created, refusing to follow anything out of it.
 *
 * NEVER A RECURSIVE DELETE OF AN UNVERIFIED PATH. `assertPlainTree` walks first and refuses the whole
 * operation — before a single entry is unlinked — if the tree holds a symbolic link, a device, a socket, a
 * pipe or more entries than this will handle. Only then is it removed, bottom-up, with `unlink` and `rmdir`:
 * neither follows a link, so even a link created in the window between the walk and the removal is unlinked as
 * a link rather than followed to somebody else's bytes.
 *
 * The root itself is `lstat`ed and refused if it is a link, so the tree that is walked is the tree that is
 * removed.
 */
export function removeOwnTreeNoFollow(path: string, what: string, maxEntries = MAX_REMOVAL_ENTRIES): number {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new MaintenanceRefused(`the ${what} could not be examined, so it was left alone`);
  }
  if (stats.isSymbolicLink()) {
    throw new MaintenanceRefused(`the ${what} is a symbolic link, and this command will not remove through one`);
  }
  if (!stats.isDirectory()) throw new MaintenanceRefused(`the ${what} is not a directory, so it was left alone`);
  const walked = assertPlainTree(path, what, maxEntries);

  const removeInside = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const child = join(current, entry);
      let childStats;
      try {
        childStats = lstatSync(child);
      } catch {
        throw new MaintenanceRefused(`the ${what} holds an entry that could not be examined`);
      }
      // A directory is descended into; EVERYTHING ELSE is unlinked as itself. `unlink` on a symbolic link
      // removes the link and never the target, which is what makes a race here harmless.
      if (childStats.isDirectory() && !childStats.isSymbolicLink()) { removeInside(child); continue; }
      try {
        unlinkSync(child);
      } catch {
        throw new MaintenanceRefused(`the ${what} could not be removed in full`);
      }
    }
    try {
      rmdirSync(current);
    } catch {
      throw new MaintenanceRefused(`the ${what} could not be removed in full`);
    }
  };
  removeInside(path);
  return walked;
}

/**
 * The size of a file, asked of a descriptor opened without following a link.
 *
 * Used to check that a command which wrote straight into a file actually wrote something: a runner that
 * reported success and produced nothing is exactly what a status check misses.
 */
export function fileSizeNoFollow(path: string): number {
  let fd: number;
  try {
    fd = openNoFollowDescriptor(path, 'file');
  } catch {
    // ABSENT, UNREADABLE AND SWAPPED-FOR-A-LINK ALL ANSWER THE SAME QUESTION HERE: how many bytes are there to
    // be trusted? In each case, none — and the caller refuses on a zero.
    return 0;
  }
  try {
    const stats = fstatSync(fd);
    return stats.isFile() ? stats.size : 0;
  } finally {
    try { closeSync(fd); } catch { /* nothing rests on this close */ }
  }
}

/** How much of a file is held in memory while it is being digested or copied. The file itself is streamed. */
export const DIGEST_CHUNK_BYTES = 1 << 20;

/**
 * Copy one file, streaming, from a descriptor opened without following a link into a private new one.
 *
 * SAME REASON AS THE DIGEST. A database dump is larger than any bound this module is willing to hold in
 * memory, and a restore workspace needs its own writable copy of it — so the copy is streamed rather than the
 * file being read whole and written back. The destination is created `O_EXCL` and private, and a failure
 * removes it: a half-written dump that stayed on disk would be restored from.
 */
export function copyFileNoFollow(source: string, destination: string, what: string): number {
  const from = openNoFollowDescriptor(source, what);
  let to: number;
  try {
    if (!fstatSync(from).isFile()) throw new MaintenanceRefused(`the ${what} is not a regular file`);
    try {
      to = openSync(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, PRIVATE_FILE_MODE);
    } catch {
      throw new MaintenanceRefused(`the ${what} copy could not be created; something already holds that name`);
    }
    let copied = 0;
    try {
      const buffer = Buffer.allocUnsafe(DIGEST_CHUNK_BYTES);
      for (;;) {
        const read = readSync(from, buffer, 0, buffer.byteLength, copied);
        if (read <= 0) break;
        writeSync(to, buffer, 0, read, copied);
        copied += read;
      }
      fsyncSync(to);
    } catch {
      try { unlinkSync(destination); } catch { /* the refusal is the outcome either way */ }
      throw new MaintenanceRefused(`the ${what} could not be copied in full, so the copy was removed`);
    } finally {
      try { closeSync(to); } catch { /* nothing rests on this close */ }
    }
    return copied;
  } finally {
    try { closeSync(from); } catch { /* as above */ }
  }
}

/**
 * Digest a file through ONE descriptor, streaming, with no bound on the file and a fixed bound on memory.
 *
 * THE DUMP IS WHY THIS EXISTS. A database dump can be larger than any sensible in-memory limit, and
 * `readFileNoFollow`'s bound is there to stop a component file from deciding how much memory this process
 * uses. Digesting is the one operation that needs the whole file and none of it at once, so it gets its own
 * function rather than a raised limit that would apply everywhere.
 *
 * Same discipline as every other read here: opened without following a link, `fstat`ed on the descriptor, and
 * the size re-checked against what was actually read, so a file that changed under it is refused rather than
 * digested halfway.
 */
export function digestFileNoFollow(path: string, what: string): { readonly digest: string; readonly size: number } {
  const fd = openNoFollowDescriptor(path, what);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new MaintenanceRefused(`the ${what} is not a regular file`);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(DIGEST_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.byteLength, total);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
      total += read;
    }
    if (total !== stats.size) {
      throw new MaintenanceRefused(
        `the ${what} changed size while it was being digested, so what was measured is not what is there`);
    }
    return { digest: hash.digest('hex'), size: total };
  } finally {
    try { closeSync(fd); } catch { /* nothing rests on this close */ }
  }
}
