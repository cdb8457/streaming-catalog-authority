import { chmodSync, lchownSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Phase 263 — repairing a custodian keystore an EXISTING installation already created.
//
// THE DEFECT THIS FINISHES. Phase 262's browser gate found that a fresh named volume for
// /var/lib/catalog/keystore is created ROOT-owned while the container runs as `node`, so the first
// FileCustodian construction died with EACCES and took ops:doctor, /api/status and the whole catalog panel
// with it. Dockerfile.runtime now creates the directory owned by `node` before dropping user, which fixes
// every install made from that image onwards — and fixes NOTHING for a volume that already exists. Docker
// initialises a named volume exactly once; an installation from v1.1.2 or earlier still has a root-owned
// keystore, and an image change cannot reach back into it. That is the remaining real limitation, and it is
// what this module exists to close.
//
// WHAT IT IS ALLOWED TO DO, AND NOTHING ELSE. Two operations: create the keystore root if it is missing, and
// change the OWNER (and, on the root only, the mode) of things that are already there. That is the complete
// list.
//
// WHAT IT WILL NEVER DO. It does not read, write, move, rename, truncate or delete one byte of keystore
// material. It does not generate, rotate, unwrap or print a key, a KEK or a completion secret. It does not
// create, destroy or recreate a volume. It does not touch the database. It opens no socket and needs no
// network. It reads no secret file, so there is no secret for it to leak.
//
// IT FAILS CLOSED ON ANYTHING IT DOES NOT UNDERSTAND. A symlink anywhere in the tree, a device/socket/FIFO, a
// world-writable file, more than one foreign owner, an unexpected top-level entry, a tree deeper or larger
// than a keystore can be: every one of those is a REFUSAL with a named code, not a best-effort chown. An
// ambiguous state is a state a human has to look at, and quietly "fixing" it is how a repair tool destroys
// something it was never asked to touch.
//
// EVERY DIAGNOSTIC IS REDACTION-SAFE BY CONSTRUCTION. The report carries counts, uids, gids, a mode and fixed
// code strings. It never carries a file name from inside the keystore, a path beyond the configured root, or
// any file content. It is safe to paste into an issue exactly as printed.
//
// IT WALKS WITH lstat AND CHOWNS WITH lchown. Both refuse to follow a symlink, so even in the impossible case
// where a link survived the scan (it cannot — a link is a refusal), the repair could not follow it out of the
// keystore.

export const KEYSTORE_REPAIR_REPORT = 'phase-263-keystore-repair';

/** The four directories FileCustodian creates under the keystore root. Nothing else belongs there. */
export const KEYSTORE_EXPECTED_TOP_LEVEL: readonly string[] = ['journal', 'keys', 'ops', 'tombstones'];

/** How many entries the scan will look at before refusing. A keystore is one small file per key. */
export const KEYSTORE_MAX_ENTRIES = 500_000;
/** How deep the tree may go. FileCustodian writes root/<dir>/<file>, so two levels is the whole layout. */
export const KEYSTORE_MAX_DEPTH = 2;
/** The mode a repaired keystore root is left at: the owner, and nobody else. */
export const KEYSTORE_ROOT_MODE = 0o700;

export type KeystoreVerdict =
  /** The root does not exist. Creating it is the whole repair. */
  | 'MISSING'
  /** Every entry is owned by the target and the root is private. Nothing to do. */
  | 'ALREADY_CORRECT'
  /** A safe, understood mismatch: one foreign owner and/or a too-open root mode. */
  | 'REPAIRABLE'
  | 'UNSAFE_ROOT_NOT_A_DIRECTORY'
  | 'UNSAFE_SYMLINK'
  | 'UNSAFE_SPECIAL_FILE'
  | 'UNSAFE_MIXED_OWNERSHIP'
  | 'UNSAFE_WORLD_WRITABLE'
  | 'UNSAFE_UNEXPECTED_ENTRY'
  | 'UNSAFE_TOO_MANY_ENTRIES'
  | 'UNSAFE_TOO_DEEP'
  | 'UNSAFE_UNREADABLE';

export type KeystoreAction = 'NONE' | 'CREATE' | 'CHOWN' | 'REFUSE';

export interface KeystoreOwner {
  readonly uid: number;
  readonly gid: number;
  /** How the owner was named, for the report. A user name is not a secret; it is in every image. */
  readonly label: string;
}

export interface KeystoreEntryStat {
  readonly kind: 'dir' | 'file' | 'symlink' | 'other';
  readonly uid: number;
  readonly gid: number;
  /** Permission bits only (mode & 0o7777). */
  readonly mode: number;
}

/**
 * The filesystem operations this module is allowed to perform.
 *
 * Injected so the decision logic can be proved against every ownership state — including ones a test cannot
 * create without being root, and ones that do not exist at all on the platform a developer is sitting at.
 * The real implementation below is four calls, none of which follows a symlink.
 */
export interface KeystoreFs {
  /** lstat, never stat. `null` means "not there"; a throw means "there but unreadable". */
  lstat(path: string): KeystoreEntryStat | null;
  readdir(path: string): readonly string[];
  mkdir(path: string, mode: number): void;
  lchown(path: string, uid: number, gid: number): void;
  chmod(path: string, mode: number): void;
}

export const realKeystoreFs: KeystoreFs = {
  lstat(path) {
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const kind = stats.isSymbolicLink() ? 'symlink'
      : stats.isDirectory() ? 'dir'
        : stats.isFile() ? 'file'
          : 'other';
    return { kind, uid: stats.uid, gid: stats.gid, mode: stats.mode & 0o7777 };
  },
  readdir: (path) => readdirSync(path),
  mkdir: (path, mode) => { mkdirSync(path, { recursive: true, mode }); },
  lchown: (path, uid, gid) => { lchownSync(path, uid, gid); },
  chmod: (path, mode) => { chmodSync(path, mode); },
};

export interface KeystoreInspection {
  readonly verdict: KeystoreVerdict;
  readonly action: KeystoreAction;
  /** Entries looked at, including the root. */
  readonly entries: number;
  /** Entries whose owner is not the target. */
  readonly foreignEntries: number;
  /** The single foreign uid, when there is exactly one. `null` when there is none. */
  readonly foreignUid: number | null;
  /** The root's permission bits, or `null` when the root does not exist. */
  readonly rootMode: number | null;
  /** True when the root is readable/writable by anyone other than its owner. */
  readonly rootTooOpen: boolean;
  readonly owner: KeystoreOwner;
  /** One sentence an operator can act on. Never a path, a file name or any content. */
  readonly detail: string;
}

export interface KeystoreRepairResult extends KeystoreInspection {
  readonly report: typeof KEYSTORE_REPAIR_REPORT;
  readonly mode: 'check' | 'repair';
  /** True when this run is allowed to proceed. A refusal is `false`. */
  readonly ok: boolean;
  /** How many entries had their owner changed. Always 0 in `check` mode. */
  readonly chowned: number;
  /** True when the root's mode was tightened. Always false in `check` mode. */
  readonly tightened: boolean;
  /** True when the root was created by this run. */
  readonly created: boolean;
  /** What the operator should do next, when there is anything. */
  readonly guidance: readonly string[];
}

export class KeystoreRepairError extends Error {
  readonly code = 'KEYSTORE_REPAIR_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'KeystoreRepairError';
  }
}

/**
 * Resolve `node`, `1000`, or `1000:1000` into a uid/gid pair.
 *
 * A NAME is resolved against the image's own /etc/passwd rather than assumed, because "node is 1000" is true
 * of the base image this project pins today and is not a fact about container images. A numeric form is
 * accepted so a deployment whose image has no passwd entry — or whose runtime user is set numerically in
 * Compose — can still say exactly what it means.
 */
export function resolveKeystoreOwner(
  spec: string,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): KeystoreOwner {
  const trimmed = spec.trim();
  if (trimmed === '') throw new KeystoreRepairError('no owner was named');

  const numeric = /^(\d{1,7})(?::(\d{1,7}))?$/.exec(trimmed);
  if (numeric !== null) {
    const uid = Number(numeric[1]);
    const gid = numeric[2] === undefined ? uid : Number(numeric[2]);
    return { uid, gid, label: `${uid}:${gid}` };
  }

  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(trimmed)) {
    // Refused rather than looked up: a name that is not a name is a configuration mistake, and passing it to
    // a passwd scan would only turn a clear message into "no such user".
    throw new KeystoreRepairError('the owner must be a user name or a numeric uid[:gid]');
  }
  let passwd: string;
  try {
    passwd = read('/etc/passwd');
  } catch {
    throw new KeystoreRepairError(`the owner "${trimmed}" could not be resolved: this system has no readable passwd database, so name the owner numerically instead`);
  }
  for (const line of passwd.split('\n')) {
    const fields = line.split(':');
    if (fields.length < 4 || fields[0] !== trimmed) continue;
    const uid = Number(fields[2]);
    const gid = Number(fields[3]);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) break;
    return { uid, gid, label: `${trimmed} (${uid}:${gid})` };
  }
  throw new KeystoreRepairError(`the owner "${trimmed}" is not a user on this system`);
}

interface Walked {
  readonly path: string;
  readonly stat: KeystoreEntryStat;
}

/**
 * Look at the keystore and decide what — if anything — may be done to it.
 *
 * READ-ONLY, ALWAYS. This function performs no mkdir, no chown and no chmod on any path, in any verdict. It
 * is what `--check` runs, and it is also the first thing `repair` runs: the decision an operator reads and
 * the decision the repair acts on are produced by the same code, not by two descriptions of it.
 */
export function inspectKeystore(root: string, owner: KeystoreOwner, fs: KeystoreFs = realKeystoreFs): KeystoreInspection {
  const base = {
    entries: 0, foreignEntries: 0, foreignUid: null as number | null,
    rootMode: null as number | null, rootTooOpen: false, owner,
  };
  const refuse = (verdict: KeystoreVerdict, detail: string, over: Partial<KeystoreInspection> = {}): KeystoreInspection =>
    ({ ...base, ...over, verdict, action: 'REFUSE', detail });

  let rootStat: KeystoreEntryStat | null;
  try {
    rootStat = fs.lstat(root);
  } catch {
    return refuse('UNSAFE_UNREADABLE', 'The keystore directory exists but could not be examined. Nothing was changed.');
  }
  if (rootStat === null) {
    return {
      ...base,
      verdict: 'MISSING',
      action: 'CREATE',
      detail: `The keystore directory does not exist. It will be created, owned by ${owner.label}, readable only by its owner.`,
    };
  }
  if (rootStat.kind === 'symlink') {
    return refuse('UNSAFE_SYMLINK', 'The keystore path is a symbolic link. A repair will not follow one, because what it points at is not what was configured.');
  }
  if (rootStat.kind !== 'dir') {
    return refuse('UNSAFE_ROOT_NOT_A_DIRECTORY', 'The keystore path exists and is not a directory. Nothing was changed.');
  }

  // ---- the walk. lstat only, bounded in both breadth and depth, and no symlink is ever followed. --------
  const walked: Walked[] = [{ path: root, stat: rootStat }];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let names: readonly string[];
    try {
      names = fs.readdir(current.path);
    } catch {
      return refuse('UNSAFE_UNREADABLE', 'A directory inside the keystore could not be listed, so the state of what is in it is unknown. Nothing was changed.');
    }
    for (const name of names) {
      if (walked.length >= KEYSTORE_MAX_ENTRIES) {
        return refuse('UNSAFE_TOO_MANY_ENTRIES',
          `The keystore holds more than ${KEYSTORE_MAX_ENTRIES} entries, which is more than a keystore can be. Nothing was changed.`);
      }
      if (current.depth === 0 && !KEYSTORE_EXPECTED_TOP_LEVEL.includes(name)) {
        // Deliberately a refusal. The four directory names are the complete layout FileCustodian creates;
        // anything else means this volume is not only a keystore, and a repair has no business deciding what
        // the other thing is. The name is NOT echoed — it is somebody's filesystem, not ours to publish.
        return refuse('UNSAFE_UNEXPECTED_ENTRY',
          'The keystore holds an entry that is not part of a keystore, so this directory is being used for something else as well. Nothing was changed.');
      }
      const childPath = join(current.path, name);
      let stat: KeystoreEntryStat | null;
      try {
        stat = fs.lstat(childPath);
      } catch {
        return refuse('UNSAFE_UNREADABLE', 'An entry inside the keystore could not be examined. Nothing was changed.');
      }
      if (stat === null) continue; // it went away between the listing and the look; it is not ours to chase
      if (stat.kind === 'symlink') {
        return refuse('UNSAFE_SYMLINK',
          'The keystore contains a symbolic link. A repair will not follow one out of the directory it was told to fix. Nothing was changed.');
      }
      if (stat.kind === 'other') {
        return refuse('UNSAFE_SPECIAL_FILE',
          'The keystore contains something that is neither a file nor a directory. Nothing was changed.');
      }
      if (stat.kind === 'file' && (stat.mode & 0o002) !== 0) {
        return refuse('UNSAFE_WORLD_WRITABLE',
          'The keystore contains a file that anybody on this host can write. That is a state to investigate, not to re-own. Nothing was changed.');
      }
      walked.push({ path: childPath, stat });
      if (stat.kind === 'dir') {
        if (current.depth + 1 > KEYSTORE_MAX_DEPTH) {
          return refuse('UNSAFE_TOO_DEEP',
            `The keystore nests deeper than ${KEYSTORE_MAX_DEPTH} levels, which is deeper than a keystore goes. Nothing was changed.`);
        }
        queue.push({ path: childPath, depth: current.depth + 1 });
      }
    }
  }

  // ---- the verdict ------------------------------------------------------------------------------------
  const foreign = walked.filter((entry) => entry.stat.uid !== owner.uid || entry.stat.gid !== owner.gid);
  const foreignUids = new Set(foreign.map((entry) => entry.stat.uid));
  const rootTooOpen = (rootStat.mode & 0o077) !== 0;
  const facts = {
    entries: walked.length,
    foreignEntries: foreign.length,
    foreignUid: foreignUids.size === 1 ? [...foreignUids][0]! : null,
    rootMode: rootStat.mode,
    rootTooOpen,
    owner,
  };

  if (foreignUids.size > 1) {
    // TWO OR MORE foreign owners is the state that must never be flattened. One of them may be a legitimate
    // legacy owner; another may be a different application sharing the mount, or a partially-completed
    // earlier repair someone interrupted. Choosing for the operator here would be choosing blind.
    return refuse('UNSAFE_MIXED_OWNERSHIP',
      `The keystore is owned by ${foreignUids.size} different users other than the one it should belong to. Which of them is correct is not something a repair may decide. Nothing was changed.`,
      facts);
  }

  if (foreign.length === 0 && !rootTooOpen) {
    return {
      ...facts,
      verdict: 'ALREADY_CORRECT',
      action: 'NONE',
      detail: `The keystore is already owned by ${owner.label} throughout (${walked.length} entries) and readable only by its owner. Nothing to do.`,
    };
  }

  const parts: string[] = [];
  if (foreign.length > 0) {
    parts.push(`${foreign.length} of ${walked.length} entries are owned by uid ${facts.foreignUid} instead of ${owner.label}`);
  }
  if (rootTooOpen) parts.push(`the keystore directory is readable beyond its owner (mode ${formatMode(rootStat.mode)})`);
  return {
    ...facts,
    verdict: 'REPAIRABLE',
    action: 'CHOWN',
    detail: `${parts.join(', and ')}. A repair changes ownership and permissions only; no key material is read, written or removed.`,
  };
}

export interface KeystoreRepairOptions {
  /** `check` inspects and writes nothing. `repair` acts on a verdict that permits it. */
  readonly mode: 'check' | 'repair';
}

/**
 * Inspect, and — in `repair` mode, and only for a verdict that permits it — act.
 *
 * IDEMPOTENT BY CONSTRUCTION, because the action is derived from the state rather than from a flag: a second
 * run sees ALREADY_CORRECT and performs no filesystem call at all. Running it on every `up` is therefore free
 * after the first time, which is what makes it safe to wire in as a startup gate.
 *
 * FAIL-CLOSED IN BOTH DIRECTIONS. A refusing verdict returns `ok: false` and writes nothing. A repair that
 * throws part-way (a chown denied because the process is not privileged) also returns `ok: false` and says so
 * — a partially re-owned keystore is reported as exactly that, never as a success.
 */
export function repairKeystore(
  root: string,
  owner: KeystoreOwner,
  options: KeystoreRepairOptions,
  fs: KeystoreFs = realKeystoreFs,
): KeystoreRepairResult {
  const resolved = resolve(root);
  const inspection = inspectKeystore(resolved, owner, fs);
  const finish = (over: Partial<KeystoreRepairResult>): KeystoreRepairResult => ({
    ...inspection,
    report: KEYSTORE_REPAIR_REPORT,
    mode: options.mode,
    ok: inspection.action !== 'REFUSE',
    chowned: 0,
    tightened: false,
    created: false,
    guidance: guidanceFor(inspection),
    ...over,
  });

  if (options.mode === 'check' || inspection.action === 'NONE' || inspection.action === 'REFUSE') {
    return finish({});
  }

  try {
    if (inspection.action === 'CREATE') {
      fs.mkdir(resolved, KEYSTORE_ROOT_MODE);
      fs.lchown(resolved, owner.uid, owner.gid);
      // mkdir's mode argument is masked by the process umask, so it is asserted rather than assumed.
      fs.chmod(resolved, KEYSTORE_ROOT_MODE);
      // Re-inspected rather than asserted: what the report says about the keystore is what the keystore says
      // about itself, AFTER the change. A create that somehow did not land reports REFUSED, not success.
      const after = inspectKeystore(resolved, owner, fs);
      return {
        ...finish({}), ...after,
        report: KEYSTORE_REPAIR_REPORT, mode: options.mode,
        ok: after.verdict === 'ALREADY_CORRECT', created: true, chowned: 1, tightened: true,
        guidance: guidanceFor(after),
      };
    }

    // CHOWN. The walk is redone rather than carried over from the inspection so that the paths being changed
    // are the paths that exist now, and every one of them is re-checked by the same refusal rules first.
    let chowned = 0;
    for (const path of collectPaths(resolved, fs)) {
      const stat = fs.lstat(path);
      if (stat === null) continue;
      if (stat.uid === owner.uid && stat.gid === owner.gid) continue;
      fs.lchown(path, owner.uid, owner.gid);
      chowned += 1;
    }
    let tightened = false;
    if (inspection.rootTooOpen) { fs.chmod(resolved, KEYSTORE_ROOT_MODE); tightened = true; }
    const after = inspectKeystore(resolved, owner, fs);
    return {
      ...finish({}), ...after,
      report: KEYSTORE_REPAIR_REPORT, mode: options.mode,
      ok: after.verdict === 'ALREADY_CORRECT', chowned, tightened, created: false,
      guidance: guidanceFor(after),
    };
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === 'EPERM' || (err as NodeJS.ErrnoException).code === 'EACCES'
      ? 'this process is not permitted to change ownership in the keystore'
      : 'the repair could not be completed';
    return finish({
      ok: false,
      detail: `${reason}. The keystore may be partly re-owned; run the check again to see its current state, and nothing was read, written or removed from any key file.`,
      guidance: [
        'Run the check again to see the keystore\'s current state before doing anything else.',
        'A repair needs to run as root with the keystore mounted; the shipped stacks do that in a one-shot service.',
      ],
    });
  }
}

/** Every path under the root, root first, parents before children. Uses the same bounded walk as the scan. */
function collectPaths(root: string, fs: KeystoreFs): readonly string[] {
  const out: string[] = [root];
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const stat = fs.lstat(current);
    if (stat === null || stat.kind !== 'dir') continue;
    for (const name of fs.readdir(current)) {
      if (out.length >= KEYSTORE_MAX_ENTRIES) return out;
      const child = join(current, name);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

function guidanceFor(inspection: KeystoreInspection): readonly string[] {
  switch (inspection.verdict) {
    case 'ALREADY_CORRECT':
      return [];
    case 'MISSING':
    case 'REPAIRABLE':
      return inspection.action === 'CHOWN' || inspection.action === 'CREATE'
        ? ['Start the stack normally: the shipped Compose files run this repair as a one-shot before anything else, so there is nothing to do by hand.']
        : [];
    case 'UNSAFE_MIXED_OWNERSHIP':
      return [
        'Stop the stack, then list the keystore volume yourself and decide which owner is correct — a repair must not guess.',
        'docs/PHASE_263_KEYSTORE_REPAIR.md has the manual commands and the rollback.',
      ];
    case 'UNSAFE_UNEXPECTED_ENTRY':
      return [
        'This directory holds something besides a keystore. Point CUSTODIAN_KEYSTORE_DIR at a directory used for nothing else, or move the other content out.',
        'docs/PHASE_263_KEYSTORE_REPAIR.md has the manual commands and the rollback.',
      ];
    default:
      return [
        'Stop the stack and look at the keystore directory yourself; this state is not one a repair may act on.',
        'docs/PHASE_263_KEYSTORE_REPAIR.md has the manual commands and the rollback.',
      ];
  }
}

function formatMode(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, '0')}`;
}

/**
 * The human-readable report.
 *
 * Counts, uids, a mode and fixed sentences. No file name from inside the keystore, no path beyond the root
 * that was configured, and no file content — so the whole thing is safe to paste into an issue.
 */
export function renderKeystoreRepairResult(result: KeystoreRepairResult): string {
  const lines: string[] = [];
  lines.push(`Custodian keystore — ${result.mode === 'check' ? 'CHECK (nothing was changed)' : 'REPAIR'}`);
  lines.push(`  verdict           ${result.verdict}`);
  lines.push(`  action            ${result.action}`);
  lines.push(`  intended owner    ${result.owner.label}`);
  lines.push(`  entries examined  ${result.entries}`);
  lines.push(`  wrongly owned     ${result.foreignEntries}${result.foreignUid === null ? '' : ` (uid ${result.foreignUid})`}`);
  lines.push(`  keystore mode     ${result.rootMode === null ? 'n/a' : formatMode(result.rootMode)}`);
  if (result.mode === 'repair') {
    lines.push(`  created           ${result.created ? 'yes' : 'no'}`);
    lines.push(`  ownership changed ${result.chowned}`);
    lines.push(`  mode tightened    ${result.tightened ? 'yes' : 'no'}`);
  }
  lines.push(`  ${result.detail}`);
  for (const step of result.guidance) lines.push(`  next: ${step}`);
  lines.push(`  RESULT: ${result.ok ? 'OK' : 'REFUSED'}`);
  return lines.join('\n');
}
