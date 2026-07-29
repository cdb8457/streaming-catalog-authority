import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  // What is inside it is diagnostic only. No secret, no path: a pid and the moment it was taken.
  try {
    writePrivateFile(join(path, 'holder.txt'), `pid=${process.pid}\n`, 'maintenance lock holder file');
  } catch { /* the lock is the directory; a missing note inside it does not weaken it */ }
  return {
    path,
    release: () => {
      try { unlinkSync(join(path, 'holder.txt')); } catch { /* may not exist */ }
      try { rmdirSync(path); } catch { /* a lock that will not release is reported by the next run, not hidden */ }
    },
  };
}

/** A short, unguessable suffix for a staging directory beside its final name. */
export function stagingSuffix(): string {
  return randomBytes(6).toString('hex');
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
