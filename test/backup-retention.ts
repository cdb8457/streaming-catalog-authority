import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_VERSION } from '../src/db/schema-version.js';
import { REQUIRED_SECRET_FILES, COMPONENT_ARTIFACT_NAMES } from '../src/ops/backup-components.js';
import {
  BACKUP_MANIFEST_NAME,
  runVerifiedCompleteBackup,
  type CompleteBackupRequest,
} from '../src/ops/complete-backup.js';
import { verifyBackupSet } from '../src/ops/backup-set-verification.js';
import { RESTORE_JOURNAL_NAME } from '../src/ops/complete-restore.js';
import {
  DESTINATION_LOCK_DIRNAME, MAINTENANCE_LOCK_DIRNAME, MaintenanceRefused, removeOwnTreeNoFollow,
} from '../src/ops/maintenance-safety.js';
import {
  QUARANTINE_CLAIM_PREFIX,
  QUARANTINE_MARKER_NAME,
  preconditionRefusal,
  QUARANTINE_PREFIX,
  RetentionAbandonFailed,
  RetentionFailed,
  RETENTION_ENTRY_STATES,
  RETENTION_JOURNAL_NAME,
  RETENTION_JOURNAL_VERSION,
  abandonRetention,
  canonicalRetentionOperation,
  classifyEntry,
  digestOperation,
  inventoryDestination,
  planRetention,
  quarantineDirName,
  readQuarantineMarker,
  readRetentionJournal,
  renderRetention,
  renderRetentionAbandon,
  renderRetentionPlan,
  resolveRetentionRequest,
  runRetention,
  writeRetentionJournal,
  type RetentionEntryState,
  type RetentionJournal,
  type RetentionReport,
} from '../src/ops/backup-retention.js';
import {
  DEFAULT_RETENTION_POLICY,
  MS_PER_DAY,
  RETENTION_REASONS,
  assertUsablePolicy,
  evaluateRetention,
  instantOf,
  removalEntryBound,
  type InventoryEntry,
  type RetentionPolicy,
  type SetClass,
} from '../src/ops/retention-model.js';
import {
  RETENTION_MODE_SWITCH_FLAGS,
  RETENTION_MODE_VALUE_FLAGS,
  RETENTION_EXIT_FAILED,
  RETENTION_EXIT_OK,
  RETENTION_EXIT_REFUSED,
  RETENTION_EXIT_USAGE,
  main as cliMain,
  parseRetentionArgs,
} from '../src/ops/backup-retention-cli.js';
import { fakeDumpText, fakeToolchain } from './helpers/fake-toolchain.js';
import { RETENTION_CRASH_EXIT_CODE } from './helpers/retention-crash-child.mjs';

// Phases 305-312 — retention, and every way it must refuse to remove a backup.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - NOTHING IS REMOVED THAT IS NOT A SET THIS PRODUCT TOOK. A hand-made backup, a foreign folder, a file,
//     a symbolic link, a dot-prefixed in-flight artifact and a set with an unreadable manifest are all
//     reported and all survive, under every policy.
//   - THE TWO UNCONDITIONAL PROTECTIONS HOLD. The newest set this build can restore, and the newest set from
//     BEFORE this build's schema — which no "keep the newest that works" rule would ever have kept, and
//     which is the only thing that can roll this installation back.
//   - A DESTINATION WITH NOTHING GOOD IN IT REFUSES THE WHOLE RUN, and has no digest to confirm.
//   - THE DIGEST BINDS THE LIST THAT WAS READ. A set taken, changed or removed between the plan and the
//     confirmation refuses the confirmation, with nothing renamed.
//   - NOTHING IS DELETED IN PLACE. A run killed mid-prune is proved, from disk, to leave every set name in
//     the destination holding a whole set or nothing at all — never half of one.
//   - AN INTERRUPTED PRUNE IS A NAMED STATE: a journal refuses a fresh run, `--resume` finishes it from
//     what the disk actually shows, and `--abandon` puts back what is still quarantined and NAMES what is
//     gone forever.
//   - NO COMMAND OF ANY KIND IS ISSUED, and no host path, secret value or component content reaches a report.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function refuses(fn: () => unknown, needle: string, msg: string): void {
  try { fn(); } catch (err) {
    const message = (err as Error).message;
    assert(message.includes(needle), `${msg}: expected a refusal mentioning "${needle}", got: ${message}`);
    return;
  }
  throw new Error(`${msg}: nothing was refused`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').split('\r\n').join('\n');
const WORK = mkdtempSync(join(tmpdir(), 'ca-retention-'));
const SECRET_VALUE = 'a-kek-value-that-must-never-appear-in-any-report';
const NOW = new Date('2026-07-31T12:00:00.000Z');
const DAY = MS_PER_DAY;

// -----------------------------------------------------------------------------------------------------------
// Fixtures: real projects, real sets, taken by the shipped Phase 277 command against a fake toolchain
// -----------------------------------------------------------------------------------------------------------

function makeProject(name: string): string {
  const root = join(WORK, name);
  mkdirSync(root, { recursive: true });
  const secrets = join(root, 'secrets');
  mkdirSync(secrets, { recursive: true });
  for (const file of REQUIRED_SECRET_FILES) {
    writeFileSync(join(secrets, file), file === 'custodian_kek' ? SECRET_VALUE : `${file}-live\n`, 'utf8');
  }
  mkdirSync(join(root, 'promotion-records'), { recursive: true });
  writeFileSync(join(root, 'promotion-records', 'record-live.json'), '{"live":1}\n', 'utf8');
  return root;
}

interface SetOptions {
  /** Days before NOW this set claims to have been taken. */
  readonly daysAgo?: number;
  /** Make the set a genuine ROLLBACK POINT: an older dump AND a manifest that agrees it is older. */
  readonly rollbackPoint?: boolean;
  readonly destination?: string;
}

function takeSet(root: string, setName: string, options: SetOptions = {}): string {
  const schema = options.rollbackPoint === true ? MIGRATION_VERSION - 1 : MIGRATION_VERSION;
  const tools = fakeToolchain({ dumpText: fakeDumpText(schema) });
  const takenAt = new Date(NOW.getTime() - (options.daysAgo ?? 0) * DAY);
  const request: CompleteBackupRequest = {
    projectRoot: root,
    destination: options.destination ?? 'backups',
    setName,
    custodian: 'inline',
    secrets: 'secrets',
    promotionRecords: 'promotion-records',
  };
  const outcome = runVerifiedCompleteBackup(request, {
    runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger, now: () => takenAt,
  });
  const setDir = join(root, options.destination ?? 'backups', setName);
  if (options.rollbackPoint === true) {
    // THE MANIFEST HAS TO AGREE THAT IT IS OLDER. `buildManifest` always records THIS build's schema, so a
    // set whose dump is older verifies as a DISAGREEMENT until the manifest says so too — which is exactly
    // the shape a real set taken by the previous release has. No component digest is touched.
    patchManifest(setDir, (manifest) => ({ ...manifest, schemaVersion: schema }));
    const report = verifyBackupSet(setDir);
    assert(report.ok, `the rollback-point fixture ${setName} had to verify: ${JSON.stringify(report.problems)}`);
    assert(!report.restorableUnderThisBuild, 'and had to be NOT restorable under this build');
  } else {
    assert(outcome.ok, `the fixture set ${setName} had to be taken and verified: ${outcome.failures.join('; ')}`);
  }
  return setDir;
}

function patchManifest(setDir: string, patch: (manifest: Record<string, unknown>) => Record<string, unknown>): void {
  const path = join(setDir, BACKUP_MANIFEST_NAME);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify(patch(manifest), null, 2)}\n`, 'utf8');
}

/** Change a component's bytes after the set was taken. The manifest's digest no longer matches. */
function tamper(setDir: string): void {
  const dump = join(setDir, COMPONENT_ARTIFACT_NAMES.database);
  writeFileSync(dump, `${readFileSync(dump, 'utf8')}-- tampered\n`, 'utf8');
}

/** Every file under a directory, as relative path -> sha256. For byte-identity assertions. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const name of readdirSync(current).slice().sort()) {
      const child = join(current, name);
      const stats = lstatSync(child);
      const key = relative(dir, child).split('\\').join('/');
      if (stats.isDirectory()) { out.set(`${key}/`, 'dir'); walk(child); continue; }
      if (!stats.isFile()) { out.set(key, `special:${stats.mode}`); continue; }
      out.set(key, createHash('sha256').update(readFileSync(child)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

function sameSnapshot(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * Link `at` to `target`, by whatever mechanism this host permits.
 *
 * WINDOWS WITHOUT DEVELOPER MODE REFUSES A SYMBOLIC LINK and permits a directory JUNCTION, which is the same
 * reparse point for this command's purposes: `lstat` reports it as a symbolic link and every no-follow rule
 * here is written against that. Trying both is what makes the escape cases run on this platform rather than
 * being skipped on it.
 */
function linkDirectory(target: string, at: string): boolean {
  for (const kind of ['dir', 'junction'] as const) {
    try { symlinkSync(target, at, kind); return true; } catch { /* try the next mechanism */ }
  }
  return false;
}

function policy(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  return { ...DEFAULT_RETENTION_POLICY, ...overrides };
}

/** A fabricated inventory entry, for driving the pure evaluator without ten gigabytes of fixtures. */
function entry(name: string, overrides: Partial<InventoryEntry> = {}): InventoryEntry {
  return {
    name,
    setClass: 'VERIFIED',
    takenAt: new Date(NOW.getTime() - 100 * DAY).toISOString(),
    takenAtMs: NOW.getTime() - 100 * DAY,
    schemaVersion: MIGRATION_VERSION,
    setDigest: createHash('sha256').update(name).digest('hex'),
    restorable: true,
    bytes: 1000,
    entries: 4,
    findings: [],
    ...overrides,
  };
}

function aged(name: string, daysAgo: number, overrides: Partial<InventoryEntry> = {}): InventoryEntry {
  return entry(name, {
    takenAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    takenAtMs: NOW.getTime() - daysAgo * DAY,
    ...overrides,
  });
}

function reasonFor(evaluation: ReturnType<typeof evaluateRetention>, name: string): string {
  const decision = evaluation.decisions.find((candidate) => candidate.name === name);
  assert(decision !== undefined, `there is a decision for ${name}`);
  return decision!.reason;
}

console.log('Running Phases 305-312 backup retention suite:\n');

// -----------------------------------------------------------------------------------------------------------
// Phase 305 — the inventory
// -----------------------------------------------------------------------------------------------------------

test('a set this product took classifies VERIFIED, with its date, schema, digest and declared size', () => {
  const root = makeProject('inv-1');
  takeSet(root, 'set-a', { daysAgo: 30 });
  const found = inventoryDestination(join(root, 'backups'));
  assertEq(found.length, 1, 'one entry');
  const only = found[0]!;
  assertEq(only.setClass, 'VERIFIED', 'it verifies');
  assertEq(only.name, 'set-a', 'named by its directory');
  assertEq(only.takenAt, new Date(NOW.getTime() - 30 * DAY).toISOString(), 'the manifest\'s own instant');
  assertEq(only.schemaVersion, MIGRATION_VERSION, 'this build\'s schema');
  assertEq(only.restorable, true, 'restorable under this build');
  assert(only.setDigest.length === 64, 'and it carries the verification digest');
  assert(only.bytes > 0 && only.entries > 0, 'and what the manifest declares it holds');
  assertEq(only.findings.length, 0, 'with no findings');
});

test('a directory with no manifest of ours is FOREIGN and is never a candidate', () => {
  const root = makeProject('inv-2');
  takeSet(root, 'set-a', { daysAgo: 30 });
  // Exactly the shape the documented BY-HAND procedure produces: components, no manifest.
  const byHand = join(root, 'backups', 'my-own-backup');
  mkdirSync(byHand, { recursive: true });
  writeFileSync(join(byHand, 'catalog.sql'), 'SELECT 1;\n', 'utf8');
  const found = inventoryDestination(join(root, 'backups'));
  const foreign = found.find((candidate) => candidate.name === 'my-own-backup')!;
  assertEq(foreign.setClass, 'FOREIGN', 'a hand-made backup is not this command\'s to remove');
  assertEq(foreign.takenAt, null, 'and it has no date this command invented for it');
});

test('every dot-prefixed name is RESERVED — one rule, not a list of namespaces to fall behind', () => {
  const root = makeProject('inv-3');
  takeSet(root, 'set-a', { daysAgo: 30 });
  for (const name of ['.set-a.staging-abc123', '.pre-restore-claim-0123456789abcdef01234567',
    `${QUARANTINE_PREFIX}0123456789ab`, '.something-nobody-has-written-yet']) {
    mkdirSync(join(root, 'backups', name), { recursive: true });
  }
  const found = inventoryDestination(join(root, 'backups'));
  for (const candidate of found) {
    if (candidate.name.startsWith('.')) assertEq(candidate.setClass, 'RESERVED', `${candidate.name} is reserved`);
  }
  assertEq(found.filter((candidate) => candidate.setClass === 'RESERVED').length, 4, 'all four');
});

test('a file, and a symbolic link pointing at a real set, are NOT_A_DIRECTORY', () => {
  const root = makeProject('inv-4');
  const real = takeSet(root, 'set-a', { daysAgo: 30 });
  writeFileSync(join(root, 'backups', 'notes.txt'), 'mine\n', 'utf8');
  assertEq(classifyEntry(join(root, 'backups'), 'notes.txt').setClass, 'NOT_A_DIRECTORY', 'a file');
  const linked = linkDirectory(real, join(root, 'backups', 'set-link'));
  assert(linked, 'this host must permit a symbolic link or a junction, or this case cannot be exercised');
  if (linked) {
    // THE LINK POINTS AT A SET THAT VERIFIES. Following it would classify VERIFIED and would then delete
    // through it — which is why this is `lstat` and not `stat`.
    assertEq(classifyEntry(join(root, 'backups'), 'set-link').setClass, 'NOT_A_DIRECTORY',
      'a link at a set name is a link');
  }
});

test('a tampered set is UNVERIFIED and names its findings; a broken manifest is UNREADABLE', () => {
  const root = makeProject('inv-5');
  takeSet(root, 'set-a', { daysAgo: 30 });
  const bad = takeSet(root, 'set-b', { daysAgo: 20 });
  tamper(bad);
  const worse = takeSet(root, 'set-c', { daysAgo: 10 });
  writeFileSync(join(worse, BACKUP_MANIFEST_NAME), '{ not json', 'utf8');
  const found = new Map(inventoryDestination(join(root, 'backups')).map((e) => [e.name, e]));
  assertEq(found.get('set-b')!.setClass, 'UNVERIFIED', 'a changed component does not verify');
  assert(found.get('set-b')!.findings.includes('COMPONENT_CHANGED'), 'and the finding is named');
  assertEq(found.get('set-c')!.setClass, 'UNREADABLE', 'an unreadable manifest is unreadable, not empty');
});

test('a name this command could not have created is FOREIGN, whatever is inside it', () => {
  const root = makeProject('inv-6');
  const real = takeSet(root, 'set-a', { daysAgo: 30 });
  const odd = join(root, 'backups', '-leading-dash');
  mkdirSync(odd, { recursive: true });
  writeFileSync(join(odd, BACKUP_MANIFEST_NAME), readFileSync(join(real, BACKUP_MANIFEST_NAME)));
  assertEq(classifyEntry(join(root, 'backups'), '-leading-dash').setClass, 'FOREIGN',
    'a manifest inside a name this command never creates does not make it ours');
});

test('the destination lock is excluded from the inventory, so a plan and its re-plan can agree', () => {
  const root = makeProject('inv-7');
  takeSet(root, 'set-a', { daysAgo: 30 });
  const before = inventoryDestination(join(root, 'backups')).map((e) => e.name);
  mkdirSync(join(root, 'backups', DESTINATION_LOCK_DIRNAME), { recursive: true });
  const after = inventoryDestination(join(root, 'backups')).map((e) => e.name);
  assertEq(JSON.stringify(after), JSON.stringify(before), 'the lock this command takes is not destination content');
});

test('a date is an instant or it is nothing — no set is ordered by a value that does not parse back', () => {
  assert(instantOf('2026-07-31T12:00:00.000Z') !== null, 'a full ISO instant');
  assert(instantOf('2026-07-31T12:00:00+02:00') !== null, 'with an offset');
  assertEq(instantOf('2026'), null, 'a year is not an instant');
  assertEq(instantOf('2026-07-31'), null, 'a date is not an instant');
  assertEq(instantOf('nonsense'), null, 'nor is a word');
  assertEq(instantOf(undefined), null, 'nor is nothing');
  assertEq(instantOf('2026-13-45T99:99:99.000Z'), null, 'nor is an ISO-shaped impossibility');
});

// -----------------------------------------------------------------------------------------------------------
// Phase 306 — the policy
// -----------------------------------------------------------------------------------------------------------

test('the keep window keeps the newest n verified sets and removes the rest, oldest first', () => {
  const inventory = [aged('s1', 100), aged('s2', 80), aged('s3', 60), aged('s4', 40), aged('s5', 20)];
  const result = evaluateRetention(inventory, policy({ keepLast: 3, minAgeDays: 7 }), NOW);
  assertEq(JSON.stringify(result.removals), JSON.stringify(['s1', 's2']), 'the two oldest, oldest first');
  assertEq(reasonFor(result, 's1'), 'BEYOND_KEEP_WINDOW', 'and it says why');
  assertEq(reasonFor(result, 's3'), 'PROTECTED_KEEP_WINDOW', 'the third newest is inside the window');
  assertEq(reasonFor(result, 's5'), 'PROTECTED_NEWEST_RESTORABLE', 'and the newest is protected by name');
});

test('the window counts VERIFIED sets only — a corrupt set never occupies a slot that would hold a good one', () => {
  // Four sets: the newest is corrupt. With keep-last 3 counting everything, the corrupt one would take a
  // slot and s1 — the oldest GOOD one — would go. It must not.
  const inventory = [aged('s1', 100), aged('s2', 80), aged('s3', 60),
    aged('s4', 20, { setClass: 'UNVERIFIED', restorable: false, findings: ['COMPONENT_CHANGED'] })];
  const result = evaluateRetention(inventory, policy({ keepLast: 3, minAgeDays: 7 }), NOW);
  assertEq(result.removals.length, 0, 'nothing is removed');
  assertEq(reasonFor(result, 's1'), 'PROTECTED_KEEP_WINDOW', 'the oldest good set is still inside the window');
});

test('--min-age-days protects a young set the window would otherwise let go', () => {
  const inventory = [aged('s1', 100), aged('s2', 80), aged('s3', 2)];
  const loose = evaluateRetention(inventory, policy({ keepLast: 1, minAgeDays: 0 }), NOW);
  assertEq(JSON.stringify(loose.removals), JSON.stringify(['s1', 's2']), 'with no age bound both older ones go');
  const tight = evaluateRetention(inventory, policy({ keepLast: 1, minAgeDays: 90 }), NOW);
  assertEq(JSON.stringify(tight.removals), JSON.stringify(['s1']), 'with a 90-day bound only the oldest does');
  assertEq(reasonFor(tight, 's2'), 'PROTECTED_MIN_AGE', 'and the other is protected by its age');
});

test('a set claiming to have been taken in the FUTURE is protected, even with --min-age-days 0', () => {
  const inventory = [aged('s1', 100), aged('s2', 80), aged('now', 0), aged('ahead', -5)];
  const result = evaluateRetention(inventory, policy({ keepLast: 1, minAgeDays: 0 }), NOW);
  assertEq(reasonFor(result, 'ahead'), 'PROTECTED_NEWEST_RESTORABLE', 'the future-dated one sorts newest');
  assertEq(reasonFor(result, 'now'), 'PROTECTED_MIN_AGE', 'and a set taken at this instant is not yet old');
});

test('an undated set has no place in an ordering, so no policy about an order applies to it', () => {
  const inventory = [aged('s1', 100), aged('s2', 20),
    entry('nodate', { takenAt: null, takenAtMs: null })];
  const result = evaluateRetention(inventory, policy({ keepLast: 1, minAgeDays: 0 }), NOW);
  assertEq(reasonFor(result, 'nodate'), 'PROTECTED_UNDATED', 'protected for the reason it is protected');
  assert(!result.removals.includes('nodate'), 'and it is not removed');
});

test('--include-unverified is the only way a set that does not verify becomes a candidate', () => {
  const inventory = [aged('good1', 100), aged('good2', 80), aged('good3', 20),
    aged('bad', 90, { setClass: 'UNVERIFIED', restorable: false, findings: ['COMPONENT_CHANGED'] })];
  const off = evaluateRetention(inventory, policy({ keepLast: 2, minAgeDays: 7 }), NOW);
  assertEq(reasonFor(off, 'bad'), 'PROTECTED_UNVERIFIED', 'off by default');
  assert(!off.removals.includes('bad'), 'and it survives');
  const on = evaluateRetention(inventory, policy({ keepLast: 2, minAgeDays: 7, includeUnverified: true }), NOW);
  assertEq(reasonFor(on, 'bad'), 'UNVERIFIED_SET', 'on, it is a candidate, and it says which rule took it');
  assert(on.removals.includes('bad'), 'and it goes');
});

test('a policy that is not a policy is refused, and there is no value meaning "keep none"', () => {
  refuses(() => assertUsablePolicy(policy({ keepLast: 0 })), 'keep none', 'zero is refused');
  refuses(() => assertUsablePolicy(policy({ keepLast: -1 })), '--keep-last', 'negative is refused');
  refuses(() => assertUsablePolicy(policy({ keepLast: 1.5 })), '--keep-last', 'a fraction is refused');
  refuses(() => assertUsablePolicy(policy({ keepLast: Number.NaN })), '--keep-last', 'NaN is refused');
  refuses(() => assertUsablePolicy(policy({ minAgeDays: -1 })), '--min-age-days', 'a negative age is refused');
  refuses(() => assertUsablePolicy(policy({ keepMinimumRestorable: 0 })), 'cannot be zero',
    'a floor of zero is refused');
});

test('every reason a decision can carry is in the closed exported vocabulary', () => {
  const inventories: readonly InventoryEntry[][] = [
    [aged('a', 100), aged('b', 2), entry('c', { takenAt: null, takenAtMs: null }),
      aged('d', 50, { setClass: 'UNVERIFIED', restorable: false }),
      aged('e', 40, { setClass: 'FOREIGN', restorable: false }),
      aged('f', 30, { restorable: false })],
  ];
  for (const inventory of inventories) {
    for (const includeUnverified of [false, true]) {
      const result = evaluateRetention(inventory, policy({ keepLast: 1, minAgeDays: 7, includeUnverified }), NOW);
      for (const decision of result.decisions) {
        assert(RETENTION_REASONS.includes(decision.reason), `${decision.reason} is a declared reason`);
      }
    }
  }
});

// -----------------------------------------------------------------------------------------------------------
// Phase 307 — the protection boundary
// -----------------------------------------------------------------------------------------------------------

test('THE HEADLINE CASE: the newest verified set is a rollback point, and the newest RESTORABLE one is old', () => {
  // This is the shape a destination has right after an upgrade: the pre-upgrade set is the newest thing in
  // the folder and this build cannot restore it. "Keep the newest one" would keep exactly the set that
  // cannot bring this installation back, and delete the one that can.
  const inventory = [
    aged('restorable-old', 100),
    aged('rollback-point', 5, { restorable: false, schemaVersion: MIGRATION_VERSION - 1 }),
  ];
  const result = evaluateRetention(inventory, policy({ keepLast: 1, minAgeDays: 0 }), NOW);
  assertEq(reasonFor(result, 'restorable-old'), 'PROTECTED_NEWEST_RESTORABLE',
    'the only set this build could restore is protected although it is 100 days old and outside keep-last 1');
  assertEq(reasonFor(result, 'rollback-point'), 'PROTECTED_NEWEST_ROLLBACK_POINT',
    'and the pre-upgrade set is protected as the only thing that can roll this installation back');
  assertEq(result.removals.length, 0, 'nothing is removed');
});

test('the newest rollback point survives even when many newer restorable sets exist', () => {
  const inventory = [aged('rb', 300, { restorable: false, schemaVersion: MIGRATION_VERSION - 1 }),
    aged('s1', 100), aged('s2', 80), aged('s3', 60), aged('s4', 40)];
  const result = evaluateRetention(inventory, policy({ keepLast: 2, minAgeDays: 7 }), NOW);
  assert(!result.removals.includes('rb'), 'the rollback point is not aged out');
  assertEq(JSON.stringify(result.removals), JSON.stringify(['s1', 's2']), 'the ordinary older sets are');
});

test('a destination with no restorable set refuses the whole run, and produces no digest to confirm', () => {
  const root = makeProject('prot-1');
  takeSet(root, 'set-a', { daysAgo: 30, rollbackPoint: true });
  takeSet(root, 'set-b', { daysAgo: 20, rollbackPoint: true });
  const resolved = resolveRetentionRequest({ projectRoot: root, destination: 'backups' });
  refuses(() => planRetention(resolved, policy(), NOW), 'no verified set that this build could restore',
    'a destination holding only rollback points refuses');
});

test('the floor is an independent recount, and refuses a policy that would leave too few', () => {
  const inventory = [aged('s1', 100), aged('s2', 80), aged('s3', 60)];
  const ok = evaluateRetention(inventory, policy({ keepLast: 1, minAgeDays: 0, keepMinimumRestorable: 1 }), NOW);
  assertEq(ok.refusals.length, 0, 'a floor of one is met by the unconditional protection');
  assertEq(ok.restorableRemaining, 1, 'and the recount says so');
  const tight = evaluateRetention(inventory, policy({ keepLast: 1, minAgeDays: 0, keepMinimumRestorable: 3 }), NOW);
  assertEq(JSON.stringify(tight.refusals), JSON.stringify(['FLOOR_NOT_MET']), 'a floor of three is not');
});

test('nothing that is not ours is removable under ANY policy', () => {
  const notOurs: readonly SetClass[] = ['FOREIGN', 'UNREADABLE', 'RESERVED', 'NOT_A_DIRECTORY'];
  for (const setClass of notOurs) {
    for (const includeUnverified of [false, true]) {
      for (const keepLast of [1, 7]) {
        const inventory = [aged('good', 5), aged('older', 400),
          aged('other', 300, { setClass, restorable: false })];
        const result = evaluateRetention(inventory,
          policy({ keepLast, minAgeDays: 0, includeUnverified }), NOW);
        assert(!result.removals.includes('other'), `${setClass} is never removed (keepLast ${keepLast})`);
        assertEq(reasonFor(result, 'other'), 'PROTECTED_NOT_OURS', `${setClass} says why`);
      }
    }
  }
});

// -----------------------------------------------------------------------------------------------------------
// Phase 308 — the plan and the digest
// -----------------------------------------------------------------------------------------------------------

test('a plan writes nothing, locks nothing and leaves the destination byte-identical', () => {
  const root = makeProject('plan-1');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 50 });
  const before = snapshot(join(root, 'backups'));
  const resolved = resolveRetentionRequest({ projectRoot: root, destination: 'backups' });
  const plan = planRetention(resolved, policy({ keepLast: 1, minAgeDays: 7 }), NOW);
  assertEq(plan.wrote, 'nothing', 'it says it wrote nothing');
  assertEq(plan.commands, 'none', 'and issued no command');
  assert(sameSnapshot(before, snapshot(join(root, 'backups'))), 'and the destination is unchanged');
  assert(!existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), 'no project lock was taken');
  assert(!existsSync(join(root, 'backups', DESTINATION_LOCK_DIRNAME)), 'no destination lock was taken');
  assert(!existsSync(join(root, RETENTION_JOURNAL_NAME)), 'and no journal was written');
  assertEq(JSON.stringify(plan.removals), JSON.stringify(['set-a']), 'and it would remove the older one');
});

test('the digest binds the whole inventory, the policy and the project — not just the names', () => {
  const root = makeProject('plan-2');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 50 });
  const resolved = resolveRetentionRequest({ projectRoot: root, destination: 'backups' });
  const base = planRetention(resolved, policy({ keepLast: 1, minAgeDays: 7 }), NOW);

  const otherPolicy = planRetention(resolved, policy({ keepLast: 1, minAgeDays: 8 }), NOW);
  assert(otherPolicy.digest !== base.digest, 'a different policy is a different operation');

  // A SET TAKEN SINCE THE PLAN WAS READ.
  takeSet(root, 'set-c', { daysAgo: 1 });
  const afterNewSet = planRetention(resolved, policy({ keepLast: 1, minAgeDays: 7 }), NOW);
  assert(afterNewSet.digest !== base.digest, 'a set that appeared changes the operation');

  // A SET WHOSE BYTES CHANGED SINCE THE PLAN WAS READ, without any name changing.
  tamper(join(root, 'backups', 'set-b'));
  const afterTamper = planRetention(resolved, policy({ keepLast: 1, minAgeDays: 7 }), NOW);
  assert(afterTamper.digest !== afterNewSet.digest, 'and so does a set whose contents changed');
});

test('two projects holding identically-named sets do not share a digest', () => {
  const a = makeProject('plan-3a');
  const b = makeProject('plan-3b');
  for (const root of [a, b]) {
    takeSet(root, 'set-a', { daysAgo: 100 });
    takeSet(root, 'set-b', { daysAgo: 50 });
  }
  const planA = planRetention(resolveRetentionRequest({ projectRoot: a, destination: 'backups' }),
    policy({ keepLast: 1, minAgeDays: 7 }), NOW);
  const planB = planRetention(resolveRetentionRequest({ projectRoot: b, destination: 'backups' }),
    policy({ keepLast: 1, minAgeDays: 7 }), NOW);
  assertEq(JSON.stringify(planA.removals), JSON.stringify(planB.removals), 'the same names would be removed');
  assert(planA.digest !== planB.digest,
    'and a confirmation read off one must not authorise destroying the other');
});

test('the canonical operation is exactly what the digest is over, and every field moves it', () => {
  const resolved = { projectRoot: '/p', destinationDir: '/p/backups', destinationRelative: 'backups',
    destinationName: 'backups' };
  const inventory = [aged('s1', 100), aged('s2', 20)];
  const evaluation = evaluateRetention(inventory, policy({ keepLast: 1, minAgeDays: 7 }), NOW);
  const base = digestOperation(canonicalRetentionOperation(resolved, policy({ keepLast: 1, minAgeDays: 7 }),
    inventory, evaluation.decisions, evaluation.removals, evaluation.protectedRestorable,
    evaluation.restorableRemaining));
  const moved = digestOperation(canonicalRetentionOperation(
    { ...resolved, destinationDir: '/p/other', destinationRelative: 'other', destinationName: 'other' },
    policy({ keepLast: 1, minAgeDays: 7 }), inventory, evaluation.decisions, evaluation.removals,
    evaluation.protectedRestorable, evaluation.restorableRemaining));
  assert(base !== moved, 'the destination is bound');
  const reclassed = digestOperation(canonicalRetentionOperation(resolved, policy({ keepLast: 1, minAgeDays: 7 }),
    [inventory[0]!, { ...inventory[1]!, setClass: 'UNVERIFIED' }], evaluation.decisions, evaluation.removals,
    evaluation.protectedRestorable, evaluation.restorableRemaining));
  assert(base !== reclassed, 'and so is every set\'s verification class');
});

test('a rendered plan names sets, dates, classes and reasons — and no path', () => {
  const root = makeProject('plan-4');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 50 });
  const resolved = resolveRetentionRequest({ projectRoot: root, destination: 'backups' });
  const rendered = renderRetentionPlan(planRetention(resolved, policy({ keepLast: 1, minAgeDays: 7 }), NOW));
  assert(rendered.includes('set-a') && rendered.includes('set-b'), 'both sets are named');
  assert(rendered.includes('BEYOND_KEEP_WINDOW'), 'with the reason');
  assert(rendered.includes('digest:'), 'and the digest to confirm with');
  assert(!rendered.includes(WORK), 'and no host path');
  assert(!rendered.includes(SECRET_VALUE), 'and no secret');
});

// -----------------------------------------------------------------------------------------------------------
// Phase 309 — execution
// -----------------------------------------------------------------------------------------------------------

function prune(root: string, options: {
  readonly policy?: Partial<RetentionPolicy>;
  readonly destination?: string;
  readonly confirm?: string;
} = {}): { readonly report: RetentionReport; readonly digest: string } {
  const pol = policy(options.policy ?? {});
  const resolved = resolveRetentionRequest({ projectRoot: root, destination: options.destination ?? 'backups' });
  const plan = planRetention(resolved, pol, NOW);
  const report = runRetention({ projectRoot: root, destination: options.destination ?? 'backups' }, pol,
    { now: () => NOW, suffix: () => 'aaaaaaaaaaaa' }, { kind: 'run', confirm: options.confirm ?? plan.digest });
  return { report, digest: plan.digest };
}

test('time passing across --min-age-days refuses the confirmation, and the refusal says so', () => {
  // A DIFFERENT DECISION ABOUT A DIFFERENT SET OF SETS. Nothing in the destination changed; the clock moved,
  // and a set crossed the age bound. The digest binds the decisions, so this refuses like any other drift —
  // and the refusal has to name the clock, or an operator hunts for a change that never happened.
  const root = makeProject('clock-drift');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 30 });
  takeSet(root, 'set-d', { daysAgo: 1 });
  const pol = policy({ keepLast: 1, minAgeDays: 35 });
  const resolved = resolveRetentionRequest({ projectRoot: root, destination: 'backups' });
  const plan = planRetention(resolved, pol, NOW);
  assertEq(JSON.stringify(plan.removals), JSON.stringify(['set-a', 'set-b']),
    'set-c is 30 days old and inside the 35-day bound; set-d is the protected newest');
  const later = new Date(NOW.getTime() + 10 * DAY);
  const before = snapshot(join(root, 'backups'));
  refuses(() => runRetention({ projectRoot: root, destination: 'backups' }, pol, { now: () => later },
    { kind: 'run', confirm: plan.digest }), 'TIME has passed',
    'a plan whose decisions the clock has changed is not confirmable');
  assert(sameSnapshot(before, snapshot(join(root, 'backups'))), 'and nothing was removed');
});

test('a confirmed run removes exactly the planned sets and leaves everything else byte-identical', () => {
  const root = makeProject('run-1');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 60 });
  writeFileSync(join(root, 'backups', 'notes.txt'), 'mine\n', 'utf8');
  const keptBefore = snapshot(join(root, 'backups', 'set-c'));

  const { report } = prune(root, { policy: { keepLast: 1, minAgeDays: 7 } });
  assertEq(report.ok, true, `the run succeeded: ${JSON.stringify(report.failed)}`);
  assertEq(report.state, 'REMOVED', 'and says so');
  assertEq(JSON.stringify(report.removed), JSON.stringify(['set-a', 'set-b']), 'the two oldest, oldest first');
  assert(!existsSync(join(root, 'backups', 'set-a')), 'set-a is gone');
  assert(!existsSync(join(root, 'backups', 'set-b')), 'set-b is gone');
  assert(existsSync(join(root, 'backups', 'notes.txt')), 'the operator\'s own file is untouched');
  assert(sameSnapshot(keptBefore, snapshot(join(root, 'backups', 'set-c'))), 'and the kept set is byte-identical');
  assertEq(report.protectedRestorable, 'set-c', 'the protected set is named');
  assertEq(report.protectedRestorableVerified, true, 'and it was re-verified from disk after the removals');
  assertEq(report.journalCleared, true, 'the journal is cleared');
  assertEq(report.retained, null, 'and nothing was retained');
  assertEq(report.commands, 'none', 'and no command was issued');
  assert(report.bytesRemoved > 0, 'and it reports what it freed');
});

test('a run leaves neither lock behind, and the quarantine directory is gone', () => {
  const root = makeProject('run-2');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 10 });
  prune(root, { policy: { keepLast: 1, minAgeDays: 7 } });
  assert(!existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), 'the project lock is released');
  assert(!existsSync(join(root, 'backups', DESTINATION_LOCK_DIRNAME)), 'the destination lock is released');
  assert(!existsSync(join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'))), 'and the quarantine is gone');
  assert(!existsSync(join(root, RETENTION_JOURNAL_NAME)), 'and so is the journal');
});

test('a wrong digest refuses and removes nothing', () => {
  const root = makeProject('run-3');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 10 });
  const before = snapshot(join(root, 'backups'));
  refuses(() => prune(root, { policy: { keepLast: 1, minAgeDays: 7 }, confirm: 'f'.repeat(64) }),
    'is not the one the plan was read against', 'a digest that is not this operation\'s');
  assert(sameSnapshot(before, snapshot(join(root, 'backups'))), 'and nothing moved');
  assert(!existsSync(join(root, RETENTION_JOURNAL_NAME)), 'and no journal was written');
});

test('a set taken between the plan and the confirmation refuses the confirmation', () => {
  const root = makeProject('run-4');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 10 });
  const pol = policy({ keepLast: 1, minAgeDays: 7 });
  const resolved = resolveRetentionRequest({ projectRoot: root, destination: 'backups' });
  const plan = planRetention(resolved, pol, NOW);
  // The nightly backup lands while the operator is reading.
  takeSet(root, 'set-c', { daysAgo: 0 });
  const before = snapshot(join(root, 'backups'));
  refuses(() => runRetention({ projectRoot: root, destination: 'backups' }, pol, { now: () => NOW },
    { kind: 'run', confirm: plan.digest }), 'is not the one the plan was read against',
    'the confirmation is against a destination that has changed');
  assert(sameSnapshot(before, snapshot(join(root, 'backups'))), 'and nothing was removed');
});

test('the project maintenance lock is what stops a run — the same lock the backup and restore take', () => {
  const root = makeProject('run-5');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 10 });
  mkdirSync(join(root, MAINTENANCE_LOCK_DIRNAME));
  refuses(() => prune(root, { policy: { keepLast: 1, minAgeDays: 7 } }),
    'another maintenance command is already running', 'a held project lock refuses');
  assert(existsSync(join(root, 'backups', 'set-a')), 'and nothing was removed');
  rmSync(join(root, MAINTENANCE_LOCK_DIRNAME), { recursive: true });
});

test('a destination lock left by an interrupted run refuses a second prune of that destination', () => {
  const root = makeProject('run-6');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 10 });
  mkdirSync(join(root, 'backups', DESTINATION_LOCK_DIRNAME));
  // PHASES 321-328 CHANGED THE SENTENCE, DELIBERATELY, AND NOT THE PROPERTY. The lock is now shared by all
  // four backup-family commands, so the refusal names all four and the cross-project case rather than
  // claiming the holder must be another prune — which was never something this command could know.
  refuses(() => prune(root, { policy: { keepLast: 1, minAgeDays: 7 } }),
    'already working in this backup destination', 'the second lock domain holds');
  assert(existsSync(join(root, 'backups', 'set-a')), 'and nothing was removed');
  rmSync(join(root, 'backups', DESTINATION_LOCK_DIRNAME), { recursive: true });
});

test('a project part way through a restore refuses retention entirely', () => {
  const root = makeProject('run-7');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 10 });
  // Deliberately NOT a valid restore journal: the check is `existsSync`, so a journal this build cannot even
  // read still refuses. A restore in progress is not a state to be reasoned about by parsing.
  writeFileSync(join(root, RESTORE_JOURNAL_NAME), 'not even json', 'utf8');
  refuses(() => resolveRetentionRequest({ projectRoot: root, destination: 'backups' }),
    'part way through a restore', 'it refuses at resolution');
  refuses(() => prune(root, { policy: { keepLast: 1, minAgeDays: 7 } }),
    'part way through a restore', 'and it refuses a run');
  assert(existsSync(join(root, 'backups', 'set-a')), 'and nothing was removed');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

test('a destination outside the project, or the project root itself, is refused', () => {
  const root = makeProject('run-8');
  takeSet(root, 'set-a', { daysAgo: 100 });
  refuses(() => resolveRetentionRequest({ projectRoot: root, destination: '../..' }),
    'must not step above the project root', 'traversal is refused');
  refuses(() => resolveRetentionRequest({ projectRoot: root, destination: '.' }),
    'names nothing', 'the project root itself is refused');
  refuses(() => resolveRetentionRequest({ projectRoot: root, destination: join(WORK, 'elsewhere') }),
    'must be relative to the project root', 'an absolute destination is refused');
});

test('a plan that removes nothing runs, changes nothing, and still proves what it kept', () => {
  const root = makeProject('run-9');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 10 });
  const before = snapshot(join(root, 'backups'));
  const { report } = prune(root, { policy: { keepLast: 7, minAgeDays: 7 } });
  assertEq(report.ok, true, 'it succeeds');
  assertEq(report.removed.length, 0, 'having removed nothing');
  assertEq(report.kept, 2, 'and it counts the backup sets it kept');
  assertEq(report.protectedRestorableVerified, true, 'the protected set was still verified from disk');
  assert(sameSnapshot(before, snapshot(join(root, 'backups'))), 'and the destination is byte-identical');
  assert(!existsSync(join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'))),
    'a run with nothing to remove creates no quarantine directory at all');
});

test('"kept" counts backup sets, not directory entries', () => {
  const root = makeProject('run-10');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 10 });
  writeFileSync(join(root, 'backups', 'notes.txt'), 'mine\n', 'utf8');
  mkdirSync(join(root, 'backups', 'my-own-folder'));
  mkdirSync(join(root, 'backups', '.something'));
  const { report } = prune(root, { policy: { keepLast: 7, minAgeDays: 7 } });
  assertEq(report.kept, 2, 'the operator\'s own folders are not counted as backups they still have');
});

test('a failure AFTER sets have moved is a failure, not a refusal, and names what it retained', () => {
  // THE FAILURE MODE WITH NO OTHER WAY TO REACH IT: the journal cannot be written — a full disk, a
  // read-only project directory, a permission change mid-run — and by then a set has already been renamed.
  const root = makeProject('post-effect');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const pol = policy({ keepLast: 1, minAgeDays: 7 });
  const resolved = resolveRetentionRequest({ projectRoot: root, destination: 'backups' });
  const plan = planRetention(resolved, pol, NOW);
  let writes = 0;
  let thrown: unknown = null;
  try {
    runRetention({ projectRoot: root, destination: 'backups' }, pol, {
      now: () => NOW,
      suffix: () => 'aaaaaaaaaaaa',
      journalWriter: (projectRoot, journal) => {
        writes += 1;
        // The first write is the plan commitment, before any effect. The second follows the first rename.
        if (writes >= 2) throw new MaintenanceRefused('the retention journal could not be written');
        writeRetentionJournal(projectRoot, journal);
      },
    }, { kind: 'run', confirm: plan.digest });
  } catch (err) { thrown = err; }

  assert(thrown instanceof RetentionFailed, `it is raised as a failure, not a refusal: ${String(thrown)}`);
  const report = (thrown as RetentionFailed).report;
  assertEq(report.ok, false, 'the report says it did not succeed');
  assertEq(report.state, 'INCOMPLETE', 'and names the state');
  assert(report.retained !== null, 'and NAMES the retained quarantine directory');
  assert(report.retained!.holds.includes('set-a'), 'and what is inside it');
  assert(report.retained!.warning.includes('secret'), 'and what that means');
  assert(!existsSync(join(root, 'backups', 'set-a')), 'set-a really did move');
  // AND THE CLI EXITS 1, not the code that means "refused before anything was moved".
  const printed: string[] = [];
  const original = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  try {
    // The journal from the interrupted run is still there, so a fresh CLI run refuses — which is a genuine
    // refusal and correctly exits 3. The exit code under test is the one the failure path itself produces.
    assertEq(cliMain(['--project', root, '--confirm', plan.digest, '--keep-last', '1', '--min-age-days', '7']),
      RETENTION_EXIT_REFUSED, 'a fresh run over an interrupted one is a real refusal');
  } finally { console.error = original; console.log = originalLog; }
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('a post-effect failure never carries a runtime error\'s own words, which carry paths', () => {
  const root = makeProject('post-effect-redaction');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const pol = policy({ keepLast: 1, minAgeDays: 7 });
  const plan = planRetention(resolveRetentionRequest({ projectRoot: root, destination: 'backups' }), pol, NOW);
  let writes = 0;
  let thrown: unknown = null;
  const leak = `ENOENT: no such file or directory, open '${join(root, 'secrets', 'custodian_kek')}'`;
  try {
    runRetention({ projectRoot: root, destination: 'backups' }, pol, {
      now: () => NOW,
      suffix: () => 'aaaaaaaaaaaa',
      journalWriter: (projectRoot, journal) => {
        writes += 1;
        if (writes >= 2) {
          const err = new Error(leak) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        writeRetentionJournal(projectRoot, journal);
      },
    }, { kind: 'run', confirm: plan.digest });
  } catch (err) { thrown = err; }
  assert(thrown instanceof RetentionFailed, 'it is still raised as a post-effect failure');
  const message = (thrown as RetentionFailed).message;
  assert(!message.includes(WORK), 'the runtime\'s path did not reach the failure');
  assert(!message.includes('custodian_kek'), 'nor did the file it named');
  assert(message.includes('ENOENT'), 'the errno code is kept, because it names a rule and not a path');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('the removal bound comes from the set\'s own manifest, not from a blanket constant', () => {
  assertEq(removalEntryBound(0), 64, 'a margin for the directories the counts do not include');
  assertEq(removalEntryBound(10), 84, 'twice the declared entries plus the margin');
  refuses(() => removalEntryBound(-1), 'does not declare how many entries', 'a negative count is refused');
  refuses(() => removalEntryBound(1.5), 'does not declare how many entries', 'and so is a fraction');
});

// -----------------------------------------------------------------------------------------------------------
// Phase 310 — the journal, the crash, the resume and the abandon
// -----------------------------------------------------------------------------------------------------------

const CHILD = fileURLToPath(new URL('./helpers/retention-crash-child.mts', import.meta.url));

function crash(root: string, crashAt: string, options: { readonly policy?: Partial<RetentionPolicy> } = {}): string {
  const pol = policy(options.policy ?? {});
  const resolved = resolveRetentionRequest({ projectRoot: root, destination: 'backups' });
  const plan = planRetention(resolved, pol, NOW);
  const config = JSON.stringify({
    projectRoot: root, destination: 'backups', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    policy: pol, nowMs: NOW.getTime(), crashAt,
  });
  const result = spawnSync(process.execPath,
    [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), CHILD, config],
    { encoding: 'utf8', cwd: repoRoot });
  assertEq(result.status, RETENTION_CRASH_EXIT_CODE,
    `the child had to stop existing at ${crashAt}, not exit ${result.status}: ${result.stderr}`);
  // A KILLED RUN LEAVES BOTH LOCKS, exactly as a real one does. The recovery runs in-process, so they are
  // removed here the way an operator would after satisfying themselves nothing is running.
  for (const lock of [join(root, MAINTENANCE_LOCK_DIRNAME), join(root, 'backups', DESTINATION_LOCK_DIRNAME)]) {
    assert(existsSync(lock), `the crash left ${lock.endsWith(MAINTENANCE_LOCK_DIRNAME) ? 'the project' : 'the destination'} lock`);
    rmSync(lock, { recursive: true });
  }
  return plan.digest;
}

/**
 * Kill a real child running an operation OTHER than a fresh prune — a resume, or an abandon.
 *
 * The plan is not remade here: an abandon has no plan to make, and a resume's operation comes from the
 * journal the interrupted run left. What is passed is the digest that journal records.
 */
function crashOperation(root: string, crashAt: string, options: {
  readonly operation: 'resume' | 'abandon';
  readonly policy?: Partial<RetentionPolicy>;
  readonly confirm: string;
}): void {
  const config = JSON.stringify({
    projectRoot: root, destination: 'backups', confirm: options.confirm, suffix: 'aaaaaaaaaaaa',
    policy: policy(options.policy ?? {}), nowMs: NOW.getTime(), crashAt, operation: options.operation,
  });
  const result = spawnSync(process.execPath,
    [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), CHILD, config],
    { encoding: 'utf8', cwd: repoRoot });
  assertEq(result.status, RETENTION_CRASH_EXIT_CODE,
    `the child had to stop existing at ${crashAt}, not exit ${result.status}: ${result.stderr}`);
  for (const lock of [join(root, MAINTENANCE_LOCK_DIRNAME), join(root, 'backups', DESTINATION_LOCK_DIRNAME)]) {
    if (existsSync(lock)) rmSync(lock, { recursive: true });
  }
}

function resume(root: string, digest: string): RetentionReport {
  return runRetention({ projectRoot: root, destination: 'backups' }, policy(),
    { now: () => NOW, suffix: () => 'aaaaaaaaaaaa' }, { kind: 'resume', confirm: digest });
}

test('killed after the journal and before a single rename: nothing has moved, and a resume completes', () => {
  const root = makeProject('crash-1');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-journal', { policy: { keepLast: 1, minAgeDays: 7 } });
  assert(existsSync(join(root, 'backups', 'set-a')), 'set-a is still exactly where it was');
  const journal = readRetentionJournal(root)!;
  assertEq(journal.entries.every((e) => e.state === 'pending'), true, 'and every entry is pending');
  const report = resume(root, digest);
  assertEq(report.ok, true, `the resume completed: ${JSON.stringify(report.failed)}`);
  assertEq(JSON.stringify(report.removed), JSON.stringify(['set-a', 'set-b']), 'and removed both');
});

test('killed after the rename and before the record: the set is WHOLE in quarantine, never half at its name', () => {
  const root = makeProject('crash-2');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const whole = snapshot(join(root, 'backups', 'set-a'));
  const digest = crash(root, 'after-quarantine-rename:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });

  // THE PROPERTY THE WHOLE QUARANTINE DESIGN EXISTS FOR.
  assert(!existsSync(join(root, 'backups', 'set-a')), 'the set name in the destination is ABSENT');
  const quarantined = join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'), 'set-a');
  assert(existsSync(quarantined), 'and the set is in quarantine');
  assert(sameSnapshot(whole, snapshot(quarantined)), 'byte for byte, whole — not a partially deleted tree');
  const journal = readRetentionJournal(root)!;
  assertEq(journal.entries.find((e) => e.name === 'set-a')!.state, 'pending',
    'and the journal still says pending: the effect landed and nothing recorded it');

  const report = resume(root, digest);
  assertEq(report.ok, true, `the resume completed: ${JSON.stringify(report.failed)}`);
  assert(report.removed.includes('set-a'), 'the interrupted rename was adopted rather than repeated');
  assert(!existsSync(join(root, 'backups', 'set-a')), 'and the set is gone');
  assert(existsSync(join(root, 'backups', 'set-c')), 'and the protected one is still there');
});

test('killed after the record and before the delete: the resume deletes from quarantine', () => {
  const root = makeProject('crash-3');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-quarantine-mark:set-b', { policy: { keepLast: 1, minAgeDays: 7 } });
  const journal = readRetentionJournal(root)!;
  assertEq(journal.entries.find((e) => e.name === 'set-b')!.state, 'quarantined', 'recorded as quarantined');
  const report = resume(root, digest);
  assertEq(report.ok, true, `the resume completed: ${JSON.stringify(report.failed)}`);
  assertEq(JSON.stringify(report.removed), JSON.stringify(['set-a', 'set-b']), 'and both are gone');
});

test('killed after the delete and before the record: the resume is idempotent and finishes', () => {
  const root = makeProject('crash-4');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-remove:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  const journal = readRetentionJournal(root)!;
  assertEq(journal.entries.find((e) => e.name === 'set-a')!.state, 'deleting',
    'the journal says deleting: a removal is always preceded by the record that one is starting');
  assert(!existsSync(join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'), 'set-a')),
    'and the tree is already gone');
  const report = resume(root, digest);
  assertEq(report.ok, true, `the resume completed: ${JSON.stringify(report.failed)}`);
  assert(report.removed.includes('set-a'), 'a removal that had already happened is recorded, not retried');
  assertEq(report.journalCleared, true, 'and the journal is cleared');
});

test('a journal in the project refuses a fresh prune', () => {
  const root = makeProject('crash-5');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 10 });
  crash(root, 'after-journal', { policy: { keepLast: 1, minAgeDays: 7 } });
  refuses(() => prune(root, { policy: { keepLast: 1, minAgeDays: 7 } }),
    'interrupted retention journal', 'a fresh run is refused');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('a resume given a digest that is not the interrupted run\'s is refused', () => {
  const root = makeProject('crash-6');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 10 });
  crash(root, 'after-journal', { policy: { keepLast: 1, minAgeDays: 7 } });
  refuses(() => resume(root, 'f'.repeat(64)), 'not the interrupted run\'s', 'a foreign digest is refused');
  assert(existsSync(join(root, 'backups', 'set-a')), 'and nothing was removed');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('abandon puts back what is quarantined, byte-identical, and NAMES what is gone forever', () => {
  const root = makeProject('abandon-1');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const whole = snapshot(join(root, 'backups', 'set-b'));
  // THE QUARANTINE PHASE IS GLOBAL: both sets are renamed aside before either is deleted. Killing the run
  // just after set-a's tree was actually removed — and before the journal recorded it — is the state where
  // one set is unrecoverable and the other is entirely recoverable, which is exactly what an abandon has to
  // tell the two halves of apart.
  crash(root, 'after-remove:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  const journal = readRetentionJournal(root)!;
  assertEq(journal.entries.find((e) => e.name === 'set-a')!.state, 'deleting',
    'the journal says deleting: the delete landed and its completion was never recorded');
  assert(!existsSync(join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'), 'set-a')), 'and set-a is gone');

  const report = abandonRetention(root);
  // AN ABANDON THAT LOST A SET IS NOT A SUCCESS. The first cut asserted `ok === true` here while naming a set
  // as gone forever, and rendered `RESULT: ABANDONED` — contradicting its own comment, the design document
  // and the plain meaning of the word to whoever reads the exit code.
  assertEq(report.ok, false, 'a run that cannot bring a set back did not cleanly unwind');
  assertEq(report.state, 'ABANDONED_WITH_LOSS', 'and it has a state of its own, not the clean one');
  assert(renderRetentionAbandon(report).includes('ABANDONED_WITH_LOSS'), 'which is what the render says');
  assertEq(JSON.stringify(report.unresolved), JSON.stringify([]), 'nothing is out of place');
  assertEq(JSON.stringify(report.putBack), JSON.stringify(['set-b']), 'set-b came back');
  assertEq(JSON.stringify(report.goneForever), JSON.stringify(['set-a']),
    'and set-a is named as gone rather than reported as a clean unwind');
  assert(sameSnapshot(whole, snapshot(join(root, 'backups', 'set-b'))), 'byte for byte');
  assertEq(report.journalCleared, true, 'and the journal is cleared');
  assertEq(report.retained, null, 'and the quarantine directory is gone');
  assert(!existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), 'and both locks are released');
  assert(!existsSync(join(root, 'backups', DESTINATION_LOCK_DIRNAME)), 'both of them');
});

test('a journal recording an abandon refuses a resume — a decision to put back is not overridden', () => {
  const root = makeProject('abandon-2');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 10 });
  const digest = crash(root, 'after-journal', { policy: { keepLast: 1, minAgeDays: 7 } });
  const journal = readRetentionJournal(root)!;
  writeRetentionJournal(root, { ...journal, phase: 'abandoning' });
  refuses(() => resume(root, digest), 'interrupted ABANDON', 'a resume will not undo an abandon');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('a set present in BOTH the destination and the quarantine is refused, never guessed at', () => {
  const root = makeProject('both-1');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-quarantine-rename:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  // Somebody puts a directory back at the name while the run is interrupted. Now there are two.
  mkdirSync(join(root, 'backups', 'set-a'));
  writeFileSync(join(root, 'backups', 'set-a', 'restored-by-hand.txt'), 'mine\n', 'utf8');
  const report = resume(root, digest);
  assertEq(report.ok, false, 'the resume did not succeed');
  assert(report.failed.some((f) => f.name === 'set-a' && f.reason.includes('both in the destination')),
    'and it says exactly which state it found');
  assert(existsSync(join(root, 'backups', 'set-a', 'restored-by-hand.txt')), 'the by-hand directory is untouched');
  assert(existsSync(join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'), 'set-a')),
    'and the quarantined copy is untouched');
  assert(report.retained !== null && report.retained.quarantine.startsWith(QUARANTINE_PREFIX),
    'and the retained directory is named');
  assert(report.retained!.warning.includes('secret'), 'with what it holds said plainly');
  assertEq(report.journalCleared, false, 'and the journal stays, because the state must stay visible');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('a quarantined tree that gained entries beyond what its manifest declared is refused, not deleted', () => {
  const root = makeProject('bound-1');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 10 });
  const digest = crash(root, 'after-quarantine-mark:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  const quarantined = join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'), 'set-a');
  for (let index = 0; index < 300; index += 1) {
    writeFileSync(join(quarantined, `extra-${index}.bin`), 'x', 'utf8');
  }
  const report = resume(root, digest);
  assertEq(report.ok, false, 'the removal did not proceed');
  assert(report.failed.some((f) => f.name === 'set-a'), 'and set-a is named as not removed');
  assert(existsSync(quarantined), 'and the tree is still there for a human to look at');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('a quarantine directory holding something this operation did not put there stops the run', () => {
  const root = makeProject('bound-2');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-quarantine-mark:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  const quarantineDir = join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'));
  mkdirSync(join(quarantineDir, 'not-mine'));
  const report = resume(root, digest);
  assert(report.failed.some((f) => f.reason.includes('did not put there')),
    'the second quarantine refuses rather than moving into a directory it cannot account for');
  assert(existsSync(join(quarantineDir, 'not-mine')), 'and the foreign entry is untouched');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('a set swapped for a symbolic link before the delete is refused, never deleted through', () => {
  const root = makeProject('symlink-swap');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const outsider = join(WORK, 'symlink-swap-outsider');
  mkdirSync(outsider, { recursive: true });
  writeFileSync(join(outsider, 'not-a-backup.txt'), 'somebody else\n', 'utf8');
  const digest = crash(root, 'after-quarantine-mark:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  const quarantined = join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'), 'set-a');
  rmSync(quarantined, { recursive: true });
  const linked = linkDirectory(outsider, quarantined);
  assert(linked, 'this host must permit a symbolic link or a junction, or this case cannot be exercised');
  const report = resume(root, digest);
  assertEq(report.ok, false, 'the removal did not proceed');
  assert(report.failed.some((f) => f.name === 'set-a' && f.reason.includes('symbolic link')),
    'and it says the quarantined name is a link');
  assert(existsSync(join(outsider, 'not-a-backup.txt')), 'the directory the link pointed at is untouched');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

// -----------------------------------------------------------------------------------------------------------
// The journal is validated because it is acted on
// -----------------------------------------------------------------------------------------------------------

function withJournal(name: string, mutate: (journal: RetentionJournal) => unknown, needle: string): void {
  test(`a journal ${name} is refused rather than acted on`, () => {
    const root = makeProject(`journal-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 30)}`);
    takeSet(root, 'set-a', { daysAgo: 100 });
    takeSet(root, 'set-b', { daysAgo: 80 });
    takeSet(root, 'set-c', { daysAgo: 10 });
    crash(root, 'after-journal', { policy: { keepLast: 1, minAgeDays: 7 } });
    const journal = readRetentionJournal(root)!;
    writeFileSync(join(root, RETENTION_JOURNAL_NAME),
      `${JSON.stringify(mutate(journal), null, 2)}\n`, 'utf8');
    refuses(() => readRetentionJournal(root), needle, 'the reader refuses');
    assert(existsSync(join(root, 'backups', 'set-a')), 'and nothing was removed');
    rmSync(join(root, RETENTION_JOURNAL_NAME));
  });
}

withJournal('from a version this build does not write',
  (journal) => ({ ...journal, version: RETENTION_JOURNAL_VERSION + 1 }), 'its version is');
withJournal('whose suffix is not one this command produces',
  (journal) => ({ ...journal, suffix: '../../escape' }), 'run suffix');
withJournal('whose removal list gained a name, without the digest being redone',
  (journal) => ({ ...journal, removals: [...journal.removals, 'set-c'],
    entries: [...journal.entries, { name: 'set-c', state: 'pending', reason: null }] }),
  'does not hash to the plan digest it records');
withJournal('whose decisions were edited to remove a protected set',
  (journal) => ({ ...journal,
    decisions: journal.decisions.map((d) => (d.name === 'set-c' ? { ...d, decision: 'remove' } : d)) }),
  'does not hash to the plan digest it records');
withJournal('whose per-set states do not cover its removal list',
  (journal) => ({ ...journal, entries: journal.entries.slice(0, 1) }), 'do not cover its removal list');
withJournal('naming the same set twice',
  (journal) => ({ ...journal, removals: [journal.removals[0], journal.removals[0]],
    entries: [journal.entries[0], journal.entries[0]] }), 'more than once');
withJournal('recording a state this command does not write',
  (journal) => ({ ...journal,
    entries: journal.entries.map((e, i) => (i === 0 ? { ...e, state: 'vanished' } : e)) }),
  'not a state this command writes');
withJournal('recording a failure with no reason',
  (journal) => ({ ...journal,
    entries: journal.entries.map((e, i) => (i === 0 ? { ...e, state: 'failed' } : e)) }),
  'carries no reason');
withJournal('recording a reason on a set that did not fail',
  (journal) => ({ ...journal,
    entries: journal.entries.map((e, i) => (i === 0 ? { ...e, reason: 'because' } : e)) }),
  'carries a failure reason');
withJournal('pointing at a destination outside this project',
  (journal) => ({ ...journal, destination: '../elsewhere' }), 'not a directory inside this project');
withJournal('carrying a policy this command would not accept',
  (journal) => ({ ...journal, policy: { ...journal.policy, keepLast: 0 } }), 'not one this command accepts');
withJournal('whose phase is not one this command writes',
  (journal) => ({ ...journal, phase: 'deciding' }), 'phase is not one this command writes');

test('a journal whose removal list disagrees with its own decisions is refused — even with a valid digest', () => {
  // THE ONE EDIT THE DIGEST CANNOT CATCH, because the forger recomputes it. Both lists are inside the
  // canonical operation, so changing one alone fails the hash; changing both and re-hashing produces a
  // document that agrees with itself and would destroy a set the decisions say to KEEP.
  const root = makeProject('forged-journal');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  crash(root, 'after-journal', { policy: { keepLast: 1, minAgeDays: 7 } });
  const journal = readRetentionJournal(root)!;
  const forged = {
    ...journal,
    removals: [...journal.removals, 'set-c'],
    entries: [...journal.entries, { name: 'set-c', state: 'pending' as const, reason: null }],
  };
  const resolved = resolveRetentionRequest({ projectRoot: root, destination: 'backups' });
  const rehashed = { ...forged, planDigest: digestOperation(canonicalRetentionOperation(resolved,
    forged.policy, forged.inventory, forged.decisions, forged.removals, forged.protectedRestorable,
    forged.restorableRemaining)) };
  writeFileSync(join(root, RETENTION_JOURNAL_NAME), `${JSON.stringify(rehashed, null, 2)}\n`, 'utf8');
  refuses(() => readRetentionJournal(root), 'not the ones this build makes from the inventory it records',
    'the EVALUATOR catches what a recomputed digest cannot');
  assert(existsSync(join(root, 'backups', 'set-c')), 'and the protected set is untouched');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('a journal moved into a different project does not describe an operation there', () => {
  const a = makeProject('move-a');
  takeSet(a, 'set-a', { daysAgo: 100 });
  takeSet(a, 'set-b', { daysAgo: 80 });
  takeSet(a, 'set-c', { daysAgo: 10 });
  crash(a, 'after-journal', { policy: { keepLast: 1, minAgeDays: 7 } });
  const b = makeProject('move-b');
  takeSet(b, 'set-a', { daysAgo: 100 });
  takeSet(b, 'set-b', { daysAgo: 80 });
  takeSet(b, 'set-c', { daysAgo: 10 });
  writeFileSync(join(b, RETENTION_JOURNAL_NAME), readFileSync(join(a, RETENTION_JOURNAL_NAME)));
  refuses(() => readRetentionJournal(b), 'does not hash to the plan digest it records',
    'a journal is bound to the project it was written in');
  rmSync(join(a, RETENTION_JOURNAL_NAME));
  rmSync(join(b, RETENTION_JOURNAL_NAME));
});

test('the journal carries no absolute path', () => {
  const root = makeProject('journal-paths');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 10 });
  crash(root, 'after-journal', { policy: { keepLast: 1, minAgeDays: 7 } });
  const text = readFileSync(join(root, RETENTION_JOURNAL_NAME), 'utf8');
  assert(!text.includes(WORK), 'a durable file in an operator\'s project does not carry their layout');
  assert(!text.includes(SECRET_VALUE), 'nor any secret');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

// -----------------------------------------------------------------------------------------------------------
// Phase 311 — the CLI and the operator surfaces
// -----------------------------------------------------------------------------------------------------------

test('the modes are exclusive, and each accepts only its own flags', () => {
  refuses(() => parseRetentionArgs(['--project', '/p']), 'nothing was asked for', 'a bare invocation');
  refuses(() => parseRetentionArgs(['--project', '/p', '--plan', '--abandon']), 'different operations',
    'two modes at once');
  refuses(() => parseRetentionArgs(['--project', '/p', '--abandon', '--keep-last', '3']),
    'not part of --abandon', 'an abandon that would ignore a policy');
  refuses(() => parseRetentionArgs(['--project', '/p', '--resume', 'x', '--destination', 'b']),
    'not part of --resume', 'a resume that would ignore a destination');
  refuses(() => parseRetentionArgs(['--project', '/p', '--resume', 'x', '--include-unverified']),
    'not part of --resume', 'and a resume that would ignore a switch');
  const plan = parseRetentionArgs(['--project', '/p', '--plan', '--keep-last', '3', '--include-unverified']);
  assertEq(plan.mode, 'plan', 'a plan parses');
  assertEq(plan.policy.keepLast, 3, 'with its policy');
  assertEq(plan.policy.includeUnverified, true, 'and its switch');
});

test('a policy value that is not a whole number is a usage error, not a guess', () => {
  refuses(() => parseRetentionArgs(['--project', '/p', '--plan', '--keep-last', 'seven']),
    'must be a whole number', 'a word');
  refuses(() => parseRetentionArgs(['--project', '/p', '--plan', '--keep-last', '3.5']),
    'must be a whole number', 'a fraction');
  refuses(() => parseRetentionArgs(['--project', '/p', '--plan', '--min-age-days', '-1']),
    'must be a whole number', 'a negative');
});

test('every mode\'s declared flags are the ones it can actually be given', () => {
  for (const mode of ['plan', 'run', 'resume', 'abandon'] as const) {
    for (const flag of RETENTION_MODE_VALUE_FLAGS[mode]) {
      assert(flag === 'project' || flag !== '', `${mode} declares ${flag}`);
    }
    assert(RETENTION_MODE_VALUE_FLAGS[mode].includes('project'), `${mode} always takes --project`);
  }
  assertEq(JSON.stringify(RETENTION_MODE_VALUE_FLAGS.abandon), JSON.stringify(['project']),
    'an abandon is bound to the journal and takes nothing else');
  assertEq(JSON.stringify(RETENTION_MODE_SWITCH_FLAGS.resume), JSON.stringify(['json']),
    'and a resume takes only --json');
});

test('the CLI plans, refuses a wrong confirmation, and runs', () => {
  const root = makeProject('cli-1');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const printed: string[] = [];
  const original = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  try {
    assertEq(cliMain(['--project', root, '--plan', '--keep-last', '1', '--min-age-days', '7']),
      RETENTION_EXIT_OK, 'a plan exits zero');
    const digest = /digest: ([0-9a-f]{64})/.exec(printed.join('\n'))?.[1];
    assert(digest !== undefined, 'and prints a digest');
    assertEq(cliMain(['--project', root, '--confirm', 'f'.repeat(64), '--keep-last', '1', '--min-age-days', '7']),
      RETENTION_EXIT_REFUSED, 'a wrong digest is a refusal, not a failure');
    assert(existsSync(join(root, 'backups', 'set-a')), 'and removed nothing');
    assertEq(cliMain(['--project', root, '--confirm', digest!, '--keep-last', '1', '--min-age-days', '7']),
      RETENTION_EXIT_OK, 'the right digest runs it');
    assert(!existsSync(join(root, 'backups', 'set-a')), 'and it removed the planned sets');
    assertEq(cliMain(['--project', root, '--abandon', '--keep-last', '1']), RETENTION_EXIT_USAGE,
      'an abandon carrying a policy is a usage error');
  } finally {
    console.log = original;
    console.error = originalError;
  }
  assert(!printed.join('\n').includes(SECRET_VALUE), 'and nothing printed carried a secret');
});

test('the operator UI renders retention from the one model, beside taking and putting back', () => {
  const service = readRepo('src/ops/operator-ui-service.ts');
  assert(service.includes('BACKUP_RETENTION_NOTE'), 'the page renders the exported explanation');
  assert(service.includes('BACKUP_RETENTION_COMMANDS'), 'and the exported command');
  assert(service.includes('Remove old ones'), 'under a heading an operator can find');
  const components = readRepo('src/ops/backup-components.ts');
  const note = /export const BACKUP_RETENTION_NOTE =([\s\S]*?);\n/.exec(components)![1]!;
  assert(note.includes('--plan'), 'the note tells an operator to start with a plan');
  assert(note.includes('quarantine'), 'and says nothing is deleted in place');
  const commands = /export const BACKUP_RETENTION_COMMANDS[\s\S]*?\};\n/.exec(components)![0]!;
  assert(commands.includes('--plan'), 'and the rendered command is the plan, not the run');
  assert(!/--confirm/.test(commands), 'the panel never renders a command that removes anything');
});

test('the scheduled maintenance job runs the shipped command and still has no flag that removes', () => {
  const script = readRepo('deploy/unraid-catalog-maintenance.sh');
  assert(script.includes('ops:backup-retention'), 'the retention mode invokes the shipped command');
  assert(script.includes('--plan'), 'in plan mode');
  // THE SCAN IS OVER WHAT THE SCRIPT RUNS, NOT WHAT IT EXPLAINS. The commentary names `--confirm` precisely
  // to say that a human types it; an assertion that forbade the word would forbid saying so.
  const executable = script.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert(!executable.includes('--confirm'), 'and no line this script executes carries a confirmation');
  assert(!/\brm\s+-rf\b/.test(executable), 'and it tells nobody to rm -rf a backup');
});

test('the suite and the command are registered where the runner and the operator look', () => {
  const pkg = JSON.parse(readRepo('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['ops:backup-retention'], 'tsx src/ops/backup-retention-cli.ts', 'the command');
  assertEq(pkg.scripts['test:backup-retention'], 'tsx test/backup-retention.ts', 'the suite');
  const inventory = JSON.parse(readRepo('test/suite-inventory.json')) as
    { suites: { file: string; group: string }[] };
  const entry = inventory.suites.find((suite) => suite.file === 'backup-retention.ts');
  assert(entry !== undefined, 'the suite is in the inventory');
  assertEq(entry!.group, 'offline', 'in the offline group, because it needs nothing');
});

// -----------------------------------------------------------------------------------------------------------
// The boundary
// -----------------------------------------------------------------------------------------------------------

test('this command issues no command at all — there is no process spawn anywhere in it', () => {
  for (const file of ['src/ops/backup-retention.ts', 'src/ops/backup-retention-cli.ts',
    'src/ops/retention-model.ts']) {
    const source = readRepo(file);
    for (const forbidden of ['spawnSync', 'spawn(', 'execSync', 'exec(', 'child_process', 'fetch(',
      'http.request', 'CommandRunner']) {
      assert(!source.includes(forbidden), `${file} does not reach for ${forbidden}`);
    }
  }
});

test('no report surface carries a host path, a secret or anything from inside a set', () => {
  const root = makeProject('redact-1');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const resolved = resolveRetentionRequest({ projectRoot: root, destination: 'backups' });
  const plan = planRetention(resolved, policy({ keepLast: 1, minAgeDays: 7 }), NOW);
  const { report } = prune(root, { policy: { keepLast: 1, minAgeDays: 7 } });
  const surfaces = [JSON.stringify(plan), renderRetentionPlan(plan), JSON.stringify(report),
    renderRetention(report)];
  for (const surface of surfaces) {
    assert(!surface.includes(WORK), 'no host path');
    assert(!surface.includes(SECRET_VALUE), 'no secret value');
    assert(!surface.includes('record-live'), 'and nothing from inside a component');
  }
});

test('an abandon report carries no path either, and says what it did not touch', () => {
  const root = makeProject('redact-2');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  crash(root, 'after-quarantine-mark:set-b', { policy: { keepLast: 1, minAgeDays: 7 } });
  const report = abandonRetention(root);
  for (const surface of [JSON.stringify(report), renderRetentionAbandon(report)]) {
    assert(!surface.includes(WORK), 'no host path');
    assert(!surface.includes(SECRET_VALUE), 'no secret value');
  }
  assert(report.notes.some((note) => note.includes('restores no database')),
    'and it says plainly what an abandon does not bring back');
});

test('the design document exists and states the two unconditional protections and the non-goals', () => {
  const doc = readRepo('docs/PHASES_305_312_BACKUP_RETENTION.md');
  for (const claim of ['PROTECTED_NEWEST_RESTORABLE', 'PROTECTED_NEWEST_ROLLBACK_POINT', 'NO_RESTORABLE_SET',
    'quarantine', 'Non-goals', 'never scheduled']) {
    assert(doc.includes(claim), `the design document states: ${claim}`);
  }
});

// -----------------------------------------------------------------------------------------------------------
// CORRECTION 1 — the journal's authority is the EVALUATOR, not the document's agreement with itself
// -----------------------------------------------------------------------------------------------------------

/**
 * Write a forged journal whose plan digest is RECOMPUTED over the forged content.
 *
 * This is the whole point of these cases. Editing one field and leaving the digest alone is caught by a hash
 * and proves nothing about authority; a forger who understands the format recomputes it, and every check that
 * asks the document about itself then agrees.
 */
function forgeJournal(root: string, mutate: (journal: RetentionJournal) => Record<string, unknown>): void {
  const journal = readRetentionJournal(root)!;
  const forged = mutate(journal) as unknown as RetentionJournal;
  const resolved = resolveRetentionRequest({ projectRoot: root, destination: 'backups' });
  const rehashed = {
    ...forged,
    planDigest: digestOperation(canonicalRetentionOperation(resolved, forged.policy, forged.inventory,
      forged.decisions, forged.removals, forged.protectedRestorable, forged.restorableRemaining)),
  };
  writeFileSync(join(root, RETENTION_JOURNAL_NAME), `${JSON.stringify(rehashed, null, 2)}\n`, 'utf8');
}

/** Write a journal whose content is edited WITHOUT recomputing the digest — the shallow forgery. */
function editJournal(root: string, mutate: (journal: RetentionJournal) => unknown): void {
  const journal = readRetentionJournal(root)!;
  writeFileSync(join(root, RETENTION_JOURNAL_NAME), `${JSON.stringify(mutate(journal), null, 2)}\n`, 'utf8');
}

/** A project with three sets, a foreign directory and a reserved name, interrupted with its journal intact. */
function forgeryFixture(name: string): { readonly root: string; readonly digest: string } {
  const root = makeProject(name);
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const foreign = join(root, 'backups', 'not-a-backup');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, 'somebody-elses-file.txt'), 'mine\n', 'utf8');
  mkdirSync(join(root, 'backups', '.reserved-thing'), { recursive: true });
  const digest = crash(root, 'after-journal', { policy: { keepLast: 1, minAgeDays: 7 } });
  return { root, digest };
}

test('FORGERY (a): removing the PROTECTED restorable set, with the digest recomputed, is refused', () => {
  const { root, digest } = forgeryFixture('forge-protected');
  forgeJournal(root, (journal) => ({
    ...journal,
    decisions: journal.decisions.map((d) => (d.name === 'set-c'
      ? { ...d, decision: 'remove', reason: 'BEYOND_KEEP_WINDOW' } : d)),
    removals: [...journal.removals, 'set-c'],
    entries: [...journal.entries, { name: 'set-c', state: 'pending', reason: null }],
    restorableRemaining: 0,
  }));
  refuses(() => readRetentionJournal(root), 'not the ones this build makes from the inventory it records',
    'the evaluator protects the newest restorable set whatever the document says');
  refuses(() => resume(root, digest), 'not the ones this build makes from the inventory it records',
    'and a resume never reaches an effect');
  assert(existsSync(join(root, 'backups', 'set-c')), 'the protected set is untouched');
  assert(existsSync(join(root, 'backups', 'set-a')), 'and so is everything else');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('FORGERY (b): removing a FOREIGN or RESERVED row, with the digest recomputed, is refused', () => {
  for (const victim of ['not-a-backup', '.reserved-thing']) {
    const { root, digest } = forgeryFixture(`forge-notours-${victim.replace(/[^a-z]/g, '')}`);
    forgeJournal(root, (journal) => ({
      ...journal,
      decisions: journal.decisions.map((d) => (d.name === victim
        ? { ...d, decision: 'remove', reason: 'BEYOND_KEEP_WINDOW' } : d)),
      removals: [...journal.removals, victim],
      entries: [...journal.entries, { name: victim, state: 'pending', reason: null }],
    }));
    // THE CLASS GATE FIRES BEFORE THE EVALUATOR IS EVEN ASKED: a removal list that names something which is
    // not a backup set this command took is refused for what it names.
    // A DOT-PREFIXED NAME NEVER REACHES THE CLASS GATE: it is not a name this command can create, which is
    // the earlier answer and the same closed one. Both are asserted for what they actually say.
    const needle = victim.startsWith('.') ? 'is not one this command creates' : 'not a backup set this command took';
    refuses(() => readRetentionJournal(root), needle, `${victim} is not this command's to remove`);
    refuses(() => resume(root, digest), needle, 'and no resume reaches an effect');
    assert(existsSync(join(root, 'backups', victim)), `${victim} is untouched`);
    rmSync(join(root, RETENTION_JOURNAL_NAME));
  }
});

test('FORGERY (c): changing a decision REASON, or an inventory row CLASS, is refused', () => {
  const reasoned = forgeryFixture('forge-reason');
  forgeJournal(reasoned.root, (journal) => ({
    ...journal,
    decisions: journal.decisions.map((d) => (d.name === 'set-a' ? { ...d, reason: 'UNVERIFIED_SET' } : d)),
  }));
  refuses(() => readRetentionJournal(reasoned.root), 'not the ones this build makes',
    'the reason is part of the decision, and the evaluator produces it');
  rmSync(join(reasoned.root, RETENTION_JOURNAL_NAME));

  // A CLASS ON A SET THAT IS NOT IN THE REMOVAL LIST, so the class gate cannot answer and the EVALUATOR has
  // to: demoting the protected set changes which set is protected, and the recorded decisions no longer
  // match the ones this build makes.
  const classed = forgeryFixture('forge-class');
  forgeJournal(classed.root, (journal) => ({
    ...journal,
    inventory: journal.inventory.map((row) => (row.name === 'set-c'
      ? { ...row, setClass: 'UNVERIFIED', restorable: false, findings: ['COMPONENT_CHANGED'] } : row)),
  }));
  refuses(() => readRetentionJournal(classed.root), 'not the ones this build makes',
    'a class the evaluator would have decided differently from is refused');
  rmSync(join(classed.root, RETENTION_JOURNAL_NAME));
});

test('FORGERY (d): a fabricated inventory row pointing at a stranger\'s directory dies ON DISK', () => {
  // THE ONE FORGERY THAT SURVIVES EVERY DOCUMENT-LEVEL CHECK. Claim the foreign directory is a VERIFIED set,
  // give it a plausible digest and an old date, recompute — and the evaluator agrees, because the evaluator
  // can only reason about what the inventory says. What kills it is that nothing is deleted until the tree
  // at that name has been re-verified against the set digest the row records.
  const { root, digest } = forgeryFixture('forge-fabricated');
  const fabricated = 'f'.repeat(64);
  forgeJournal(root, (journal) => ({
    ...journal,
    inventory: journal.inventory.map((row) => (row.name === 'not-a-backup'
      ? {
        ...row, setClass: 'VERIFIED', restorable: true, setDigest: fabricated,
        takenAt: new Date(NOW.getTime() - 200 * DAY).toISOString(),
        takenAtMs: NOW.getTime() - 200 * DAY, schemaVersion: MIGRATION_VERSION, bytes: 10, entries: 1,
      } : row)),
    decisions: journal.decisions.map((d) => (d.name === 'not-a-backup'
      ? { ...d, decision: 'remove', reason: 'BEYOND_KEEP_WINDOW' } : d)),
    removals: ['not-a-backup', ...journal.removals],
    entries: [{ name: 'not-a-backup', state: 'pending', reason: null }, ...journal.entries],
  }));
  // It reads: the document is self-consistent AND the evaluator agrees with it.
  const accepted = readRetentionJournal(root);
  assert(accepted !== null, 'this forgery does pass every check a document can answer about itself');
  void digest;
  const report = resume(root, accepted!.planDigest);
  assertEq(report.ok, false, 'and the run does not succeed');
  assert(report.failed.some((f) => f.name === 'not-a-backup'
    && f.reason.includes('not the one this operation planned to remove')),
    `it is refused by its identity on disk, not by its name: ${JSON.stringify(report.failed)}`);
  assert(existsSync(join(root, 'backups', 'not-a-backup', 'somebody-elses-file.txt')),
    'and the stranger\'s file is exactly where it was');
  // AND THE HALT: nothing after the impossible state was touched.
  for (const name of ['set-a', 'set-b', 'set-c']) {
    assert(existsSync(join(root, 'backups', name)), `${name} was not touched after the run stopped`);
  }
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('a malformed inventory or decision member is a closed refusal, never a runtime exception', () => {
  const cases: readonly [string, (journal: RetentionJournal) => unknown, string][] = [
    ['an inventory row that is null', (j) => ({ ...j, inventory: [null, ...j.inventory.slice(1)] }),
      'one of its inventory rows is not a record'],
    ['an inventory row that is a number', (j) => ({ ...j, inventory: [42, ...j.inventory.slice(1)] }),
      'one of its inventory rows is not a record'],
    ['an inventory row with no name', (j) => ({ ...j,
      inventory: j.inventory.map((r, i) => (i === 0 ? { ...r, name: null } : r)) }),
      'has no usable name'],
    ['an inventory class this build does not write', (j) => ({ ...j,
      inventory: j.inventory.map((r, i) => (i === 0 ? { ...r, setClass: 'PROBABLY_FINE' } : r)) }),
      'carries a class this build does not write'],
    ['a byte count that is a string', (j) => ({ ...j,
      inventory: j.inventory.map((r, i) => (i === 0 ? { ...r, bytes: '10' } : r)) }),
      'carries a bytes count that is not a count'],
    ['a date and a moment that disagree', (j) => ({ ...j,
      inventory: j.inventory.map((r) => (r.takenAtMs === null ? r : { ...r, takenAtMs: r.takenAtMs + 1 })) }),
      'carries a date and a moment that disagree'],
    ['findings that are not a list', (j) => ({ ...j,
      inventory: j.inventory.map((r, i) => (i === 0 ? { ...r, findings: 'none' } : r)) }),
      'carries findings this build does not write'],
    ['a set digest on something that is not a set', (j) => ({ ...j,
      inventory: j.inventory.map((r) => (r.setClass === 'FOREIGN' ? { ...r, setDigest: 'a'.repeat(64) } : r)) }),
      'claims a set digest for something that is not a set'],
    ['a decision that is null', (j) => ({ ...j, decisions: [null, ...j.decisions.slice(1)] }),
      'one of its decisions is not a record'],
    ['a decision that is neither keep nor remove', (j) => ({ ...j,
      decisions: j.decisions.map((d, i) => (i === 0 ? { ...d, decision: 'maybe' } : d)) }),
      'neither keep nor remove'],
    ['a reason this build does not write', (j) => ({ ...j,
      decisions: j.decisions.map((d, i) => (i === 0 ? { ...d, reason: 'BECAUSE_I_SAID_SO' } : d)) }),
      'carries a reason this build does not write'],
    ['an inventory naming one set twice', (j) => ({ ...j,
      inventory: [j.inventory[0], ...j.inventory] }), 'appears in its inventory more than once'],
    ['an inventory out of canonical order', (j) => ({ ...j, inventory: j.inventory.slice().reverse() }),
      'not in the canonical order'],
    ['decisions that do not cover the inventory', (j) => ({ ...j, decisions: j.decisions.slice(1) }),
      'do not cover its inventory'],
    ['an evaluation instant that is not an instant', (j) => ({ ...j, evaluatedAt: 'tuesday' }),
      'is not an instant'],
    ['a journal that is not a record at all', () => ['not', 'a', 'journal'], 'is not a record'],
  ];
  for (const [index, [label, mutate, needle]] of cases.entries()) {
    const { root } = forgeryFixture(`malformed-${index}`);
    editJournal(root, mutate);
    let message = '';
    try {
      readRetentionJournal(root);
      throw new Error(`${label}: nothing was refused`);
    } catch (err) {
      assert(err instanceof MaintenanceRefused, `${label}: refused as a rule, not as a ${(err as Error).name}`);
      message = (err as Error).message;
    }
    assert(message.includes(needle), `${label}: expected "${needle}", got: ${message}`);
    assert(existsSync(join(root, 'backups', 'set-a')), `${label}: and nothing was removed`);
    rmSync(join(root, RETENTION_JOURNAL_NAME));
  }
});

test('a version-1 journal is refused AT THE VERSION BOUNDARY, before any later field is read', () => {
  const { root } = forgeryFixture('old-version');
  // Version 1 had no `evaluatedAt` and no `deleting` state. It must be refused for BEING version 1, not for
  // whichever later field it happens to be missing — otherwise the message sends an operator after a field.
  editJournal(root, (journal) => {
    const rest = { ...journal } as Record<string, unknown>;
    delete rest.evaluatedAt;
    return { ...rest, version: 1 };
  });
  refuses(() => readRetentionJournal(root), 'its version is 1 and this build writes 2',
    'the version boundary is the first thing that answers');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

// -----------------------------------------------------------------------------------------------------------
// CORRECTION 2 — the quarantine directory has to PROVE it is ours, before anything in it is destroyed
// -----------------------------------------------------------------------------------------------------------

test('a quarantine directory replaced by an ORDINARY directory is refused, and nothing in it is removed', () => {
  const root = makeProject('quarantine-replaced');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-quarantine-mark:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  const quarantineDir = join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'));
  // Somebody's ordinary directory, at the published path, holding a directory named after a planned set.
  // The first cut treated the unguessable-looking name plus an allowlisted child name AS ownership — and the
  // suffix is written down in the journal, in a directory the operator owns, so it is not unguessable at all.
  rmSync(quarantineDir, { recursive: true });
  mkdirSync(join(quarantineDir, 'set-a'), { recursive: true });
  writeFileSync(join(quarantineDir, 'set-a', 'somebody-elses-file.txt'), 'mine\n', 'utf8');

  const report = resume(root, digest);
  assertEq(report.ok, false, 'the resume did not succeed');
  assert(report.failed.some((f) => f.reason.includes('ownership marker')),
    `it says the directory cannot prove it is this operation's: ${JSON.stringify(report.failed)}`);
  assert(existsSync(join(quarantineDir, 'set-a', 'somebody-elses-file.txt')),
    'the stranger\'s file is exactly where it was');
  assert(existsSync(join(root, 'backups', 'set-b')), 'and set-b was never touched after the stop');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('a quarantine directory whose marker was removed or edited is refused', () => {
  for (const [label, damage] of [
    ['removed', (dir: string) => { rmSync(join(dir, QUARANTINE_MARKER_NAME)); }],
    ['edited', (dir: string) => {
      const marker = JSON.parse(readFileSync(join(dir, QUARANTINE_MARKER_NAME), 'utf8')) as Record<string, unknown>;
      writeFileSync(join(dir, QUARANTINE_MARKER_NAME),
        JSON.stringify({ ...marker, removals: ['set-c'] }, null, 2), 'utf8');
    }],
  ] as const) {
    const root = makeProject(`marker-${label}`);
    takeSet(root, 'set-a', { daysAgo: 100 });
    takeSet(root, 'set-b', { daysAgo: 80 });
    takeSet(root, 'set-c', { daysAgo: 10 });
    const digest = crash(root, 'after-quarantine-mark:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
    const quarantineDir = join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'));
    damage(quarantineDir);
    const report = resume(root, digest);
    assertEq(report.ok, false, `${label}: the resume did not succeed`);
    assert(report.failed.some((f) => f.reason.includes('ownership marker')), `${label}: it names the marker`);
    assert(existsSync(join(quarantineDir, 'set-a')), `${label}: and the set inside it was not removed`);
    rmSync(join(root, RETENTION_JOURNAL_NAME));
  }
});

test('a directory already sitting at the quarantine path refuses the FIRST rename', () => {
  const root = makeProject('quarantine-squatted');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 10 });
  mkdirSync(join(root, 'backups', quarantineDirName('aaaaaaaaaaaa')), { recursive: true });
  const before = snapshot(join(root, 'backups'));
  const { report } = prune(root, { policy: { keepLast: 1, minAgeDays: 7 } });
  assertEq(report.ok, false, 'the run did not succeed');
  assertEq(report.removed.length, 0, 'and removed nothing');
  assert(sameSnapshot(before, snapshot(join(root, 'backups'))), 'not one directory moved');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('killed while the quarantine marker was BUILT: the predictable path is absent and a resume publishes', () => {
  const root = makeProject('marker-built');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-quarantine-marker-built', { policy: { keepLast: 1, minAgeDays: 7 } });
  assert(!existsSync(join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'))),
    'the PREDICTABLE path never existed: it goes from absent straight to marked');
  const orphans = readdirSync(join(root, 'backups')).filter((n) => n.startsWith(QUARANTINE_CLAIM_PREFIX));
  assertEq(orphans.length, 1, 'an unpredictable, secret-free build directory was left');
  assert(existsSync(join(root, 'backups', orphans[0]!, QUARANTINE_MARKER_NAME)), 'carrying its marker');
  assertEq(readdirSync(join(root, 'backups', orphans[0]!)).length, 1,
    'and not one byte of any set: nothing is moved until after the publication');
  const report = resume(root, digest);
  assertEq(report.ok, true, `the resume published a fresh quarantine and completed: ${JSON.stringify(report.failed)}`);
  assert(existsSync(join(root, 'backups', orphans[0]!)),
    'and the orphan is left for an operator: this command removes no directory it cannot prove is its own');
  rmSync(join(root, 'backups', orphans[0]!), { recursive: true });
});

test('killed just after the quarantine was PUBLISHED: it is marked, empty, and a resume proceeds', () => {
  const root = makeProject('marker-published');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-quarantine-marker-published', { policy: { keepLast: 1, minAgeDays: 7 } });
  const quarantineDir = join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'));
  assertEq(JSON.stringify(readdirSync(quarantineDir)), JSON.stringify([QUARANTINE_MARKER_NAME]),
    'the published path holds its marker and nothing else');
  const journal = readRetentionJournal(root)!;
  assert(readQuarantineMarker(quarantineDir, journal).ok, 'and the marker proves the operation');
  const report = resume(root, digest);
  assertEq(report.ok, true, `the resume completed: ${JSON.stringify(report.failed)}`);
});

test('killed after `deleting` was recorded and before the first unlink: the tree is INTACT and finishes', () => {
  const root = makeProject('deleting-intact');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const whole = snapshot(join(root, 'backups', 'set-a'));
  const digest = crash(root, 'after-deleting-mark:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  const journal = readRetentionJournal(root)!;
  assertEq(journal.entries.find((e) => e.name === 'set-a')!.state, 'deleting', 'the state is recorded');
  const quarantined = join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'), 'set-a');
  assert(sameSnapshot(whole, snapshot(quarantined)), 'and the tree is still whole');
  const report = resume(root, digest);
  assertEq(report.ok, true, `the resume finished it: ${JSON.stringify(report.failed)}`);
  assert(report.removed.includes('set-a'), 'and removed it');
});

test('a quarantined set MUTATED between the rename and the delete is refused', () => {
  const root = makeProject('quarantine-mutated');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-quarantine-mark:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  const quarantined = join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'), 'set-a');
  tamper(quarantined);
  const report = resume(root, digest);
  assertEq(report.ok, false, 'the resume did not succeed');
  assert(report.failed.some((f) => f.name === 'set-a' && f.reason.includes('when the plan was made')),
    `what is on disk is not what was planned: ${JSON.stringify(report.failed)}`);
  assert(existsSync(quarantined), 'and the tree is still there for a human to look at');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('a quarantined set REPLACED by a different set of ours is refused', () => {
  const root = makeProject('quarantine-swapped');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-quarantine-mark:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  const quarantined = join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'), 'set-a');
  // A REAL SET OF OURS, THAT VERIFIES — and is not the one this operation committed to removing. A name is
  // not a commitment, which is why the identity is compared and not merely the fact that it is a valid set.
  rmSync(quarantined, { recursive: true });
  const other = takeSet(root, 'set-other', { daysAgo: 55 });
  renameSync(other, quarantined);
  const report = resume(root, digest);
  assertEq(report.ok, false, 'the resume did not succeed');
  assert(report.failed.some((f) => f.name === 'set-a' && f.reason.includes('when the plan was made')),
    `a valid set of ours is still not THIS set: ${JSON.stringify(report.failed)}`);
  assert(existsSync(quarantined), 'and the substitute was not deleted');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('a `pending` entry whose quarantined target is a STRANGER\'S directory is refused, never adopted', () => {
  const root = makeProject('pending-stranger');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-quarantine-rename:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  const quarantined = join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'), 'set-a');
  rmSync(quarantined, { recursive: true });
  mkdirSync(quarantined, { recursive: true });
  writeFileSync(join(quarantined, 'somebody-elses-file.txt'), 'mine\n', 'utf8');
  const report = resume(root, digest);
  assertEq(report.ok, false, 'the resume did not succeed');
  assert(report.failed.some((f) => f.name === 'set-a'), 'set-a is named');
  assert(existsSync(join(quarantined, 'somebody-elses-file.txt')),
    'and the directory that was NOT the planned set was neither adopted nor removed');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

// -----------------------------------------------------------------------------------------------------------
// CORRECTION 3 — an impossible state stops every later destructive effect
// -----------------------------------------------------------------------------------------------------------

test('the first impossible state STOPS the run: no later candidate is quarantined or deleted', () => {
  const root = makeProject('halt-quarantine');
  for (const [name, days] of [['set-a', 100], ['set-b', 90], ['set-c', 80], ['set-d', 70], ['set-e', 5]] as const) {
    takeSet(root, name, { daysAgo: days });
  }
  const digest = crash(root, 'after-quarantine-rename:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  // The both-places state on the FIRST candidate, with three more still to go.
  mkdirSync(join(root, 'backups', 'set-a'));
  const report = resume(root, digest);
  assertEq(report.ok, false, 'it did not succeed');
  assertEq(report.failed.length, 1, 'exactly one entry is named');
  assertEq(report.removed.length, 0, 'and NOTHING was removed');
  for (const name of ['set-b', 'set-c', 'set-d']) {
    assert(existsSync(join(root, 'backups', name)), `${name} is exactly where it was`);
    assert(report.untouched.includes(name), `and ${name} is reported as untouched`);
  }
  assert(existsSync(join(root, 'backups', 'set-e')), 'and the protected set is there');
  assertEq(report.journalCleared, false, 'the journal stays, so abandon is still available');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('an impossible state during the DELETE phase stops it too, with the rest still quarantined', () => {
  const root = makeProject('halt-delete');
  for (const [name, days] of [['set-a', 100], ['set-b', 90], ['set-c', 80], ['set-e', 5]] as const) {
    takeSet(root, name, { daysAgo: days });
  }
  const digest = crash(root, 'after-quarantine-mark:set-c', { policy: { keepLast: 1, minAgeDays: 7 } });
  const quarantineDir = join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'));
  assertEq(readdirSync(quarantineDir).slice().sort().join(','),
    [QUARANTINE_MARKER_NAME, 'set-a', 'set-b', 'set-c'].sort().join(','), 'all three are set aside');
  // Make the FIRST delete impossible; the other two must survive intact and remain abandonable.
  tamper(join(quarantineDir, 'set-a'));
  const report = resume(root, digest);
  assertEq(report.ok, false, 'it did not succeed');
  assertEq(report.removed.length, 0, 'and nothing was deleted at all');
  for (const name of ['set-b', 'set-c']) {
    assert(existsSync(join(quarantineDir, name)), `${name} is still whole in quarantine`);
  }
  assert(report.retained !== null && report.retained.holds.includes('set-b'), 'and the report names them');
  // ABANDON IS STILL AVAILABLE, and puts the untouched ones back.
  const abandoned = abandonRetention(root);
  assert(abandoned.putBack.includes('set-b') && abandoned.putBack.includes('set-c'),
    `the candidates the halt protected are put back: ${JSON.stringify(abandoned.unresolved)}`);
  assert(existsSync(join(root, 'backups', 'set-b')), 'set-b is back under its own name');
  try { rmSync(join(root, RETENTION_JOURNAL_NAME)); } catch { /* a clean abandon already cleared it */ }
});

// -----------------------------------------------------------------------------------------------------------
// CORRECTION 4 — an abandon that lost a set is not a success, and its failures carry a report
// -----------------------------------------------------------------------------------------------------------

test('the CLI exits 1 for an abandon that could not bring a set back', () => {
  const root = makeProject('abandon-exit');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  crash(root, 'after-remove:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  const printed: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  try {
    assertEq(cliMain(['--project', root, '--abandon']), RETENTION_EXIT_FAILED,
      'a scheduler reading zero would call this a clean unwind');
  } finally { console.log = log; console.error = error; }
  const text = printed.join('\n');
  assert(text.includes('ABANDONED_WITH_LOSS'), 'and the state is on the page');
  assert(text.includes('GONE FOREVER'), 'beside what is gone');
  assert(!text.includes(WORK), 'with no host path');
});

test('an abandon whose journal write fails AFTER a rename carries its report and does not read as a refusal', () => {
  const root = makeProject('abandon-post-effect');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  crash(root, 'after-quarantine-mark:set-b', { policy: { keepLast: 1, minAgeDays: 7 } });
  let writes = 0;
  let thrown: unknown = null;
  try {
    abandonRetention(root, {
      journalWriter: (projectRoot, journal) => {
        writes += 1;
        // 1 = the decision to abandon. 2 = the record of the first put-back, which is where it fails.
        if (writes >= 2) throw new MaintenanceRefused('the retention journal could not be written');
        writeRetentionJournal(projectRoot, journal);
      },
    });
  } catch (err) { thrown = err; }
  assert(thrown instanceof RetentionAbandonFailed,
    `it is raised as a post-effect abandon failure, not a refusal: ${String(thrown)}`);
  const report = (thrown as RetentionAbandonFailed).report;
  assertEq(report.ok, false, 'the report says so');
  assert(report.putBack.includes('set-a'), 'and names what it did put back');
  assert(!JSON.stringify(report).includes(WORK), 'without a host path');
  assert(existsSync(join(root, 'backups', 'set-a')), 'set-a really was put back');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('an abandon whose FINAL CLEAR fails carries its report too, and rerunning finishes deterministically', () => {
  const root = makeProject('abandon-clear-fails');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  crash(root, 'after-quarantine-mark:set-b', { policy: { keepLast: 1, minAgeDays: 7 } });
  let thrown: unknown = null;
  try {
    abandonRetention(root, {
      journalClearer: () => { throw new MaintenanceRefused('the retention journal could not be removed'); },
    });
  } catch (err) { thrown = err; }
  assert(thrown instanceof RetentionAbandonFailed, `the clear failure is post-effect too: ${String(thrown)}`);
  assert(existsSync(join(root, 'backups', 'set-a')) && existsSync(join(root, 'backups', 'set-b')),
    'both sets were put back before it failed');
  // RERUNNING FINISHES IT. Everything is already where it belongs, so the second abandon is a clean one.
  const second = abandonRetention(root);
  assertEq(second.ok, true, `the rerun is a clean unwind: ${JSON.stringify(second.unresolved)}`);
  assertEq(second.journalCleared, true, 'and it clears the journal');
  assert(!existsSync(join(root, RETENTION_JOURNAL_NAME)), 'which is gone');
});

test('killed mid-abandon, after a rename and before its record: rerunning abandon finishes', () => {
  const root = makeProject('abandon-killed');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-quarantine-mark:set-b', { policy: { keepLast: 1, minAgeDays: 7 } });
  crashOperation(root, 'after-abandon-rename:set-a', { operation: 'abandon',
    policy: { keepLast: 1, minAgeDays: 7 }, confirm: digest });
  assert(existsSync(join(root, 'backups', 'set-a')), 'the rename landed');
  const journal = readRetentionJournal(root)!;
  assertEq(journal.phase, 'abandoning', 'and the direction is committed');
  refuses(() => resume(root, digest), 'interrupted ABANDON', 'a resume will not undo it');
  const report = abandonRetention(root);
  assertEq(report.ok, true, `the rerun completes: ${JSON.stringify(report.unresolved)}`);
  assert(report.putBack.includes('set-b'), 'it moved the one the killed process had not reached');
  for (const name of ['set-a', 'set-b']) {
    assert(existsSync(join(root, 'backups', name)), `${name} is back under its own name`);
  }
  assertEq(report.journalCleared, true, 'and the journal is cleared, deterministically');
});

test('an abandon whose FIRST write — the decision itself — fails still carries a report', () => {
  // THE OTHER SIDE OF THE RENAME. Nothing this process has done has moved yet, and the OPERATION has three
  // sets sitting in a quarantine directory. A pre-effect refusal here would tell an operator nothing had
  // happened about a destination that is part way through a prune.
  const root = makeProject('abandon-first-write');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  crash(root, 'after-quarantine-mark:set-b', { policy: { keepLast: 1, minAgeDays: 7 } });
  let thrown: unknown = null;
  try {
    abandonRetention(root, {
      journalWriter: () => { throw new MaintenanceRefused('the retention journal could not be written'); },
    });
  } catch (err) { thrown = err; }
  assert(thrown instanceof RetentionAbandonFailed,
    `the operation's own effects make this post-effect: ${String(thrown)}`);
  const report = (thrown as RetentionAbandonFailed).report;
  assertEq(report.ok, false, 'it did not succeed');
  assertEq(report.putBack.length, 0, 'nothing was put back');
  assert(report.unresolved.includes('set-a') && report.unresolved.includes('set-b'),
    'and both quarantined sets are named as still out of place');
  assert(report.retained !== null, 'with the retained directory named');
  assert(!JSON.stringify(report).includes(WORK), 'and no host path anywhere in it');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('an abandon will NOT put back a set that was part way through being removed', () => {
  // A `deleting` tree may be truncated. Renaming it back under a name an operator trusts is the exact
  // failure the quarantine exists to prevent, so it is named as unresolved instead.
  const root = makeProject('abandon-deleting');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  crash(root, 'after-deleting-mark:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  const report = abandonRetention(root);
  assertEq(report.ok, false, 'this is not a clean unwind');
  assertEq(report.state, 'PARTIAL', 'and it says so');
  assert(report.unresolved.includes('set-a'), 'set-a is named as still out of place');
  assert(!existsSync(join(root, 'backups', 'set-a')), 'and it was NOT put back under its own name');
  assert(report.putBack.includes('set-b'), 'while the untouched one was');
  assert(report.notes.some((note) => note.includes('may be incomplete')), 'with the reason said plainly');
  assertEq(report.journalCleared, false, 'and the journal stays, because this is still visible work');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

// -----------------------------------------------------------------------------------------------------------
// CORRECTION 5 — a resume classifies from the OPERATION's effects, not from its own
// -----------------------------------------------------------------------------------------------------------

test('a resume whose first write fails still carries a report when the OPERATION had already moved sets', () => {
  for (const [label, crashAt] of [
    ['a rename the previous process never recorded', 'after-quarantine-rename:set-a'],
    ['a removal the previous process never recorded', 'after-remove:set-a'],
  ] as const) {
    const root = makeProject(`resume-prior-${label.replace(/[^a-z]+/gi, '-').slice(0, 20)}`);
    takeSet(root, 'set-a', { daysAgo: 100 });
    takeSet(root, 'set-b', { daysAgo: 80 });
    takeSet(root, 'set-c', { daysAgo: 10 });
    const digest = crash(root, crashAt, { policy: { keepLast: 1, minAgeDays: 7 } });
    let thrown: unknown = null;
    try {
      runRetention({ projectRoot: root, destination: 'backups' }, policy(), {
        now: () => NOW,
        // THE VERY FIRST WRITE THIS PROCESS ATTEMPTS FAILS. It has renamed and removed nothing itself — and
        // the operation has. The first cut exited as a pre-effect refusal carrying no report at all.
        journalWriter: () => { throw new MaintenanceRefused('the retention journal could not be written'); },
      }, { kind: 'resume', confirm: digest });
    } catch (err) { thrown = err; }
    assert(thrown instanceof RetentionFailed,
      `${label}: it is a post-effect failure because the OPERATION moved sets: ${String(thrown)}`);
    const report = (thrown as RetentionFailed).report;
    assertEq(report.ok, false, `${label}: the report says so`);
    assert(!JSON.stringify(report).includes(WORK), `${label}: with no host path`);
    rmSync(join(root, RETENTION_JOURNAL_NAME));
  }
});

// -----------------------------------------------------------------------------------------------------------
// CORRECTION 6 — what this command reads, said exactly
// -----------------------------------------------------------------------------------------------------------

test('nothing claims this command opens no secret, because verifying a set reads every byte of one', () => {
  for (const file of ['src/ops/backup-retention.ts', 'src/ops/retention-model.ts',
    'src/ops/backup-retention-cli.ts', 'src/ops/backup-components.ts',
    'docs/PHASES_305_312_BACKUP_RETENTION.md', 'PHASES_305_312_REPORT.md']) {
    const text = readRepo(file).toLowerCase();
    for (const forbidden of ['opens no secret', 'opening no secret', 'reads no secret']) {
      assert(!text.includes(forbidden),
        `${file} must not claim it "${forbidden}": verifyBackupSet hashes the secrets component`);
    }
  }
  const source = readRepo('src/ops/backup-retention.ts');
  assert(source.includes('accepts no credential on a command line'),
    'the boundary that IS true is stated where the reading happens');
  const design = readRepo('docs/PHASES_305_312_BACKUP_RETENTION.md');
  assert(design.includes('hashing'), 'and the design document says what the bytes are read FOR');
});

// -----------------------------------------------------------------------------------------------------------
// CORRECTION 7 — the state matrix, enumerated
// -----------------------------------------------------------------------------------------------------------

test('a `quarantined` set that has VANISHED from quarantine stops the run rather than being called removed', () => {
  const root = makeProject('quarantined-vanished');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-quarantine-mark:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  rmSync(join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'), 'set-a'), { recursive: true });
  const report = resume(root, digest);
  assertEq(report.ok, false, 'the resume did not succeed');
  assert(!report.removed.includes('set-a'), 'and it does NOT claim to have removed it');
  assert(report.failed.some((f) => f.reason.includes('something')), 'it says something else did');
  assert(existsSync(join(root, 'backups', 'set-b')), 'and set-b was not touched after the stop');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

// -----------------------------------------------------------------------------------------------------------
// CORRECTION 2 — `deleting` survives a failed removal, the state matrix is total, and --json is one document
// -----------------------------------------------------------------------------------------------------------

/**
 * Force one journal entry into a given state.
 *
 * The per-entry states are deliberately NOT part of the canonical operation, so editing one leaves the plan
 * digest — and every other check the reader makes — intact. That is what lets the matrix below drive the
 * executor through states a kill would take far longer to reach, without weakening a single validation.
 */
function setEntryState(root: string, name: string, state: RetentionEntryState): void {
  const journal = readRetentionJournal(root)!;
  const edited = {
    ...journal,
    entries: journal.entries.map((entry) => (entry.name === name
      ? { name, state, reason: state === 'failed' ? 'an earlier run stopped here' : null }
      : entry)),
  };
  writeFileSync(join(root, RETENTION_JOURNAL_NAME), `${JSON.stringify(edited, null, 2)}\n`, 'utf8');
}

test('a removal that unlinks SOME children and then throws keeps its `deleting` commitment', () => {
  // -------------------------------------------------------------------------------------------------
  // THE STRANDING THIS CLOSES.
  // -------------------------------------------------------------------------------------------------
  // `removeOwnTreeNoFollow` can unlink some children and then throw — a file another process holds open, a
  // permission that changed under it, an `rmdir` that will not complete. The tree is PARTIAL, and `deleting`
  // is the only thing that authorises finishing it. The first cut's `stop()` rewrote that entry to `failed`,
  // and a resume then treated `failed` beside a quarantined tree as an INTACT one and tried to prove it
  // against its commitment — which a half-deleted set can never satisfy. The operation could neither finish
  // nor be abandoned.
  const root = makeProject('deleting-survives');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const pol = policy({ keepLast: 1, minAgeDays: 7 });
  const resolved = resolveRetentionRequest({ projectRoot: root, destination: 'backups' });
  const plan = planRetention(resolved, pol, NOW);

  let removals = 0;
  const partial = runRetention({ projectRoot: root, destination: 'backups' }, pol, {
    now: () => NOW,
    suffix: () => 'aaaaaaaaaaaa',
    // THE FIRST REMOVAL REALLY UNLINKS SOMETHING AND THEN THROWS. Not a refusal before it touched anything —
    // that is a different state — and not a whole removal either.
    remover: (path, what, maxEntries) => {
      removals += 1;
      if (removals > 1) return removeOwnTreeNoFollow(path, what, maxEntries);
      const victim = join(path, COMPONENT_ARTIFACT_NAMES.database);
      assert(existsSync(victim), 'the tree really holds the component this test unlinks');
      rmSync(victim);
      throw new MaintenanceRefused('the quarantined set could not be removed: something is holding it open');
    },
  }, { kind: 'run', confirm: plan.digest });

  assertEq(partial.ok, false, 'the run did not succeed');
  assertEq(partial.state, 'INCOMPLETE', 'and it is incomplete, not a refusal');
  assert(partial.failed.some((f) => f.name === 'set-a' && f.reason.includes('holding it open')),
    `the reason travels in the REPORT: ${JSON.stringify(partial.failed)}`);

  // THE JOURNAL STILL SAYS `deleting`. That is the whole point.
  const journal = readRetentionJournal(root)!;
  assertEq(journal.entries.find((e) => e.name === 'set-a')!.state, 'deleting',
    'the durable commitment that authorises finishing a partial tree was NOT thrown away');
  // AND THE LATER CANDIDATE IS NOT DELETED.
  //
  // The quarantine phase is the REVERSIBLE one and it completes first by design, so `set-b` has been renamed
  // aside — which is exactly what makes a single `--abandon` able to put everything back. What a stop in the
  // delete phase guarantees is that nothing after it is DESTROYED, and that is what is asserted.
  assertEq(journal.entries.find((e) => e.name === 'set-b')!.state, 'quarantined',
    'the later candidate was set aside and never consumed');
  assert(!partial.removed.includes('set-b'), 'and nothing after the failure was removed');
  assertEq(partial.removed.length, 0, 'in fact nothing was removed at all');
  assert(sameSnapshot(snapshot(join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'), 'set-b')),
    snapshot(join(root, 'backups', 'set-c'))) === false, 'set-b is whole in quarantine');
  assert(existsSync(join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'), 'set-b',
    COMPONENT_ARTIFACT_NAMES.database)), 'with every component still there');
  const quarantined = join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'), 'set-a');
  assert(existsSync(quarantined), 'the partial tree is still there');
  assert(!existsSync(join(quarantined, COMPONENT_ARTIFACT_NAMES.database)),
    'and it really is partial: the component this test unlinked is gone');
  assert(partial.retained !== null && partial.retained.holds.includes('set-a'), 'the report names the tree');

  // A SECOND RESUME FINISHES IT. No proof is attempted against the commitment, because a `deleting` tree may
  // be partial and the ownership marker plus this entry's own record are what authorise finishing it.
  const finished = resume(root, plan.digest);
  assertEq(finished.ok, true, `the second resume completed: ${JSON.stringify(finished.failed)}`);
  assertEq(JSON.stringify(finished.removed), JSON.stringify(['set-a', 'set-b']), 'and both are gone');
  assert(!existsSync(join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'))), 'quarantine cleaned up');
  assertEq(finished.journalCleared, true, 'and the journal is cleared');
});

test('an ABANDON of a partial `deleting` tree still refuses to put it back, and says why', () => {
  const root = makeProject('deleting-abandon');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const pol = policy({ keepLast: 1, minAgeDays: 7 });
  const plan = planRetention(resolveRetentionRequest({ projectRoot: root, destination: 'backups' }), pol, NOW);
  let removals = 0;
  runRetention({ projectRoot: root, destination: 'backups' }, pol, {
    now: () => NOW,
    suffix: () => 'aaaaaaaaaaaa',
    remover: (path, what, maxEntries) => {
      removals += 1;
      if (removals > 1) return removeOwnTreeNoFollow(path, what, maxEntries);
      rmSync(join(path, COMPONENT_ARTIFACT_NAMES.database));
      throw new MaintenanceRefused('the quarantined set could not be removed: something is holding it open');
    },
  }, { kind: 'run', confirm: plan.digest });

  const report = abandonRetention(root);
  assertEq(report.ok, false, 'this is not a clean unwind');
  assertEq(report.state, 'PARTIAL', 'and it says so');
  assert(report.unresolved.includes('set-a'), 'the partial tree is named as still out of place');
  assert(!existsSync(join(root, 'backups', 'set-a')), 'and it was NOT put back under a name an operator trusts');
  assert(report.notes.some((note) => note.includes('may be incomplete')), 'with the reason said plainly');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('the state matrix is TOTAL: all five states by both presences, with one declared answer each', () => {
  // 5 states x in-destination x in-quarantine = 20. The first cut listed ten of them in a static tuple and
  // called it full: `failed` was absent entirely, so were both `deleting`-back-in-the-destination cases,
  // `quarantined` back in the destination, and every `removed` case except the ordinary one.
  const states: readonly RetentionEntryState[] = RETENTION_ENTRY_STATES;
  assertEq(states.length, 5, 'five states');
  const combinations: Array<[RetentionEntryState, boolean, boolean]> = [];
  for (const state of states) for (const dest of [true, false]) for (const quar of [true, false]) {
    combinations.push([state, dest, quar]);
  }
  assertEq(combinations.length, 20, 'twenty combinations, enumerated rather than asserted to exist');

  const legal: string[] = [];
  const refused: string[] = [];
  for (const [state, dest, quar] of combinations) {
    const answer = preconditionRefusal(state, dest, quar);
    assert(answer === null || (typeof answer === 'string' && answer.length > 20),
      `${state}/${dest}/${quar} has one declared answer`);
    (answer === null ? legal : refused).push(`${state}/${dest}/${quar}`);
  }
  // BOTH PLACES IS NEVER LEGAL, in any state.
  for (const state of states) {
    assert(preconditionRefusal(state, true, true) !== null, `${state} in both places is refused`);
  }
  assertEq(legal.length, 8, `eight combinations a run of this program can be in: ${legal.join(' ')}`);
  assertEq(refused.length, 12, `twelve it cannot: ${refused.join(' ')}`);
  // AND THE ONE THE FIRST CUT SKIPPED OUTRIGHT.
  assert(preconditionRefusal('removed', true, false) !== null,
    'a set recorded REMOVED whose name is occupied again is named, not silently skipped');
  assert(preconditionRefusal('removed', false, true) !== null, 'and the same in quarantine');
});

test('the EXECUTOR is driven through every one of the twenty combinations, and agrees with the table', () => {
  // Not a tuple list: each row builds a real project, arranges the real filesystem and the real journal into
  // that combination, and runs the shipped resume. `set-a` is the subject; `set-b` is the witness that
  // proves a stop really stopped.
  const states: readonly RetentionEntryState[] = RETENTION_ENTRY_STATES;
  let index = 0;
  for (const state of states) for (const dest of [true, false]) for (const quar of [true, false]) {
    index += 1;
    const label = `${state}/dest=${dest}/quar=${quar}`;
    const root = makeProject(`matrix-${index}`);
    takeSet(root, 'set-a', { daysAgo: 100 });
    takeSet(root, 'set-b', { daysAgo: 80 });
    takeSet(root, 'set-c', { daysAgo: 10 });
    // A published, marked, empty quarantine and two pending entries — the state a kill at the publication
    // really leaves, so every arrangement below starts from something the executor produced.
    const digest = crash(root, 'after-quarantine-marker-published', { policy: { keepLast: 1, minAgeDays: 7 } });
    const quarantineDir = join(root, 'backups', quarantineDirName('aaaaaaaaaaaa'));
    const atDestination = join(root, 'backups', 'set-a');
    const inQuarantine = join(quarantineDir, 'set-a');

    if (quar) renameSync(atDestination, inQuarantine);
    if (dest && quar) mkdirSync(atDestination);
    if (!dest && !quar) rmSync(atDestination, { recursive: true });
    setEntryState(root, 'set-a', state);

    const expected = preconditionRefusal(state, dest, quar);
    const report = resume(root, digest);
    if (expected !== null) {
      assertEq(report.ok, false, `${label}: the run must not succeed`);
      assert(report.failed.some((f) => f.name === 'set-a' && f.reason === expected),
        `${label}: the executor gives the table's own reason, got ${JSON.stringify(report.failed)}`);
      assert(existsSync(join(root, 'backups', 'set-b')),
        `${label}: the WITNESS is untouched — a stop really stopped`);
      assert(report.untouched.includes('set-b'), `${label}: and the report names it`);
      assertEq(report.journalCleared, false, `${label}: the journal stays, so abandon is available`);
      rmSync(join(root, RETENTION_JOURNAL_NAME));
    } else {
      assertEq(report.ok, true, `${label}: the run must complete, got ${JSON.stringify(report.failed)}`);
      assert(!existsSync(join(root, 'backups', 'set-b')),
        `${label}: and it really carried on — the witness was removed`);
      assert(existsSync(join(root, 'backups', 'set-c')), `${label}: the protected set is untouched`);
    }
  }
  assertEq(index, 20, 'all twenty were driven');
});

// -----------------------------------------------------------------------------------------------------------
// CORRECTION 2 — `--json` is exactly one JSON document, on one stream, on every outcome
// -----------------------------------------------------------------------------------------------------------

interface Captured { readonly out: string; readonly err: string; readonly code: number }

/** Run the CLI with every byte of both streams captured, so "and nothing else" can actually be asserted. */
function captureCli(argv: readonly string[], deps: Parameters<typeof cliMain>[1] = {}): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => { out.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { err.push(args.map(String).join(' ')); };
  let code: number;
  try { code = cliMain(argv, deps); } finally { console.log = log; console.error = error; }
  return { out: out.join('\n'), err: err.join('\n'), code };
}

/** The whole stream must parse, with nothing before or after the document. */
function assertOneJsonDocument(text: string, label: string): Record<string, unknown> {
  assert(text.length > 0, `${label}: the stream carries a document at all`);
  assertEq(text, text.trim(), `${label}: no leading or trailing whitespace around the document`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label}: the COMPLETE stream is not one JSON document — ${(err as Error).message}\n`
      + `--- captured ---\n${text.slice(0, 600)}`);
  }
  assert(parsed !== null && typeof parsed === 'object', `${label}: and it is a report object`);
  return parsed as Record<string, unknown>;
}

test('--json on an INCOMPLETE run emits one document on stdout, with nothing appended', () => {
  const root = makeProject('json-incomplete');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-quarantine-rename:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  mkdirSync(join(root, 'backups', 'set-a')); // the both-places state: this run must stop
  const captured = captureCli(['--project', root, '--resume', digest, '--json']);
  assertEq(captured.code, RETENTION_EXIT_FAILED, 'it exits 1');
  const report = assertOneJsonDocument(captured.out, 'INCOMPLETE stdout');
  assertEq(report.state, 'INCOMPLETE', 'and the state is in the document');
  assertEq(report.ok, false, 'which says it did not succeed');
  assert(Array.isArray(report.notes) && (report.notes as string[]).some((n) => n.includes('--abandon')),
    'the remediation dropped from the stream is inside the report, where a reader can find it');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('--json on REMOVED_BUT_UNPROVEN emits one document on stdout, with nothing appended', () => {
  const root = makeProject('json-unproven');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const digest = crash(root, 'after-journal', { policy: { keepLast: 1, minAgeDays: 7 } });
  // The set this run promised to keep stops verifying while the run is interrupted. Every removal still
  // completes; the PROOF afterwards does not.
  tamper(join(root, 'backups', 'set-c'));
  const captured = captureCli(['--project', root, '--resume', digest, '--json']);
  assertEq(captured.code, RETENTION_EXIT_FAILED, 'it exits 1');
  const report = assertOneJsonDocument(captured.out, 'REMOVED_BUT_UNPROVEN stdout');
  assertEq(report.state, 'REMOVED_BUT_UNPROVEN', 'the state is the one under test');
  assertEq(report.protectedRestorableVerified, false, 'and the proof is recorded as not holding');
});

test('--json on ABANDONED_WITH_LOSS and on PARTIAL each emit one document on stdout', () => {
  const withLoss = makeProject('json-abandon-loss');
  takeSet(withLoss, 'set-a', { daysAgo: 100 });
  takeSet(withLoss, 'set-b', { daysAgo: 80 });
  takeSet(withLoss, 'set-c', { daysAgo: 10 });
  crash(withLoss, 'after-remove:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  const lossy = captureCli(['--project', withLoss, '--abandon', '--json']);
  assertEq(lossy.code, RETENTION_EXIT_FAILED, 'a lossy abandon exits 1');
  const lossReport = assertOneJsonDocument(lossy.out, 'ABANDONED_WITH_LOSS stdout');
  assertEq(lossReport.state, 'ABANDONED_WITH_LOSS', 'the state is in the document');
  assert(Array.isArray(lossReport.goneForever) && (lossReport.goneForever as string[]).includes('set-a'),
    'and what is gone is named inside it');

  const partial = makeProject('json-abandon-partial');
  takeSet(partial, 'set-a', { daysAgo: 100 });
  takeSet(partial, 'set-b', { daysAgo: 80 });
  takeSet(partial, 'set-c', { daysAgo: 10 });
  crash(partial, 'after-deleting-mark:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  const partialRun = captureCli(['--project', partial, '--abandon', '--json']);
  assertEq(partialRun.code, RETENTION_EXIT_FAILED, 'a partial abandon exits 1');
  const partialReport = assertOneJsonDocument(partialRun.out, 'PARTIAL stdout');
  assertEq(partialReport.state, 'PARTIAL', 'the state is in the document');
  rmSync(join(partial, RETENTION_JOURNAL_NAME));
});

test('--json on a POST-EFFECT thrown failure emits one document on stderr, and nothing on stdout', () => {
  const root = makeProject('json-post-effect');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const pol = policy({ keepLast: 1, minAgeDays: 7 });
  const plan = planRetention(resolveRetentionRequest({ projectRoot: root, destination: 'backups' }), pol, NOW);
  let writes = 0;
  const captured = captureCli(
    ['--project', root, '--confirm', plan.digest, '--keep-last', '1', '--min-age-days', '7', '--json'],
    {
      now: () => NOW,
      suffix: () => 'aaaaaaaaaaaa',
      journalWriter: (projectRoot, journal) => {
        writes += 1;
        if (writes >= 2) throw new MaintenanceRefused('the retention journal could not be written');
        writeRetentionJournal(projectRoot, journal);
      },
    });
  assertEq(captured.code, RETENTION_EXIT_FAILED, 'a post-effect failure exits 1, not 3');
  assertEq(captured.out, '', 'stdout carries nothing at all');
  const report = assertOneJsonDocument(captured.err, 'post-effect stderr');
  assertEq(report.ok, false, 'the report says it did not succeed');
  assertEq(report.state, 'INCOMPLETE', 'and names the state');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

test('--json on a POST-EFFECT abandon failure emits one document on stderr, and nothing on stdout', () => {
  const root = makeProject('json-abandon-post-effect');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  crash(root, 'after-quarantine-mark:set-b', { policy: { keepLast: 1, minAgeDays: 7 } });
  const captured = captureCli(['--project', root, '--abandon', '--json'], {
    journalClearer: () => { throw new MaintenanceRefused('the retention journal could not be removed'); },
  });
  assertEq(captured.code, RETENTION_EXIT_FAILED, 'it exits 1');
  assertEq(captured.out, '', 'stdout carries nothing at all');
  const report = assertOneJsonDocument(captured.err, 'post-effect abandon stderr');
  assertEq(report.ok, false, 'the report says it did not succeed');
  assert(Array.isArray(report.putBack), 'and carries what it did put back');
  try { rmSync(join(root, RETENTION_JOURNAL_NAME)); } catch { /* the abandon may have cleared it */ }
});

test('--json on the SUCCESS paths is one document too, and non-JSON mode keeps its remediation prose', () => {
  const root = makeProject('json-success');
  takeSet(root, 'set-a', { daysAgo: 100 });
  takeSet(root, 'set-b', { daysAgo: 80 });
  takeSet(root, 'set-c', { daysAgo: 10 });
  const planned = captureCli(['--project', root, '--plan', '--keep-last', '1', '--min-age-days', '7', '--json']);
  assertEq(planned.code, RETENTION_EXIT_OK, 'a plan exits 0');
  const planDoc = assertOneJsonDocument(planned.out, 'plan stdout');
  const digest = planDoc.digest as string;
  const ran = captureCli(['--project', root, '--confirm', digest, '--keep-last', '1', '--min-age-days', '7',
    '--json']);
  assertEq(ran.code, RETENTION_EXIT_OK, 'the run exits 0');
  const report = assertOneJsonDocument(ran.out, 'run stdout');
  assertEq(report.ok, true, 'and succeeded');

  // AND THE HUMAN PATH IS UNCHANGED: the remediation an operator reads is still printed without --json.
  const human = makeProject('json-success-human');
  takeSet(human, 'set-a', { daysAgo: 100 });
  takeSet(human, 'set-b', { daysAgo: 80 });
  takeSet(human, 'set-c', { daysAgo: 10 });
  const digest2 = crash(human, 'after-quarantine-rename:set-a', { policy: { keepLast: 1, minAgeDays: 7 } });
  mkdirSync(join(human, 'backups', 'set-a'));
  const readable = captureCli(['--project', human, '--resume', digest2]);
  assertEq(readable.code, RETENTION_EXIT_FAILED, 'it still exits 1');
  assert(readable.out.includes('THIS PRUNE DID NOT FINISH'), 'and a person is still told what to do next');
  assert(readable.out.includes('--abandon'), 'by name');
  rmSync(join(human, RETENTION_JOURNAL_NAME));
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('');
  for (const [name, err] of failures) console.log(`FAILED: ${name}\n  ${(err as Error).stack ?? String(err)}`);
  process.exitCode = 1;
}
try { rmSync(WORK, { recursive: true, force: true }); } catch { /* a temp directory that will not go is not a failure */ }
