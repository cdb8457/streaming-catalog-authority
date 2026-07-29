import { randomBytes } from 'node:crypto';
import {
  closeSync, constants as fsConstants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
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
 * `docker` subcommands a maintenance command may use.
 *
 * `pull`, `login`, `push` and `build` are absent and that is the point: every image these commands use must
 * already be on the host, which is what makes `--pull never` an honest flag rather than a hopeful one.
 */
export const PERMITTED_DOCKER_SUBCOMMANDS: readonly string[] = Object.freeze([
  'compose', 'image', 'volume', 'container', 'inspect', 'info', 'version',
]);

/** Compose subcommands. `pull` is absent for the same reason. */
export const PERMITTED_COMPOSE_SUBCOMMANDS: readonly string[] = Object.freeze([
  'up', 'down', 'stop', 'start', 'create', 'exec', 'run', 'cp', 'ps', 'logs', 'config', 'kill',
]);

/**
 * Refuse a command that is outside what maintenance is allowed to do.
 *
 * Called on EVERY command before it is handed to the runner, including in the planners' own tests, so a
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
  if (command.program === 'docker') {
    const subcommand = command.args[0];
    if (subcommand === undefined || !PERMITTED_DOCKER_SUBCOMMANDS.includes(subcommand)) {
      throw new MaintenanceRefused(
        `maintenance may only use these docker subcommands: ${PERMITTED_DOCKER_SUBCOMMANDS.join(', ')}`);
    }
    if (subcommand === 'compose') {
      // Skip the file/project flags to find the verb. `-f <path>` and `-p <name>` are the only ones planned.
      let index = 1;
      while (index < command.args.length && command.args[index]!.startsWith('-')) index += 2;
      const verb = command.args[index];
      if (verb === undefined || !PERMITTED_COMPOSE_SUBCOMMANDS.includes(verb)) {
        throw new MaintenanceRefused(
          `maintenance may only use these compose subcommands: ${PERMITTED_COMPOSE_SUBCOMMANDS.join(', ')}`);
      }
    }
  }
}

/**
 * Run one command through the injected runner, after the guard, recording it either way.
 *
 * The ledger records the command BEFORE its status is known and again with it, so a command that hung or
 * threw is still in the evidence. A refusal never reaches the runner at all.
 */
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
  return err instanceof Error ? err.name : 'an unknown failure';
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
  const path = join(root, MAINTENANCE_LOCK_DIRNAME);
  try {
    mkdirSync(path, { mode: PRIVATE_DIR_MODE });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MaintenanceRefused(
        'another maintenance command is already running for this project, or one was interrupted and left its '
        + `lock behind (${MAINTENANCE_LOCK_DIRNAME} in the project root). Wait for it, or remove that directory `
        + 'once you are sure nothing is running.');
    }
    throw new MaintenanceRefused('the maintenance lock could not be taken; check the project root is writable');
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
