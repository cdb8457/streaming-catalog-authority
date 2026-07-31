import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  symlinkSync, utimesSync, writeFileSync,
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
import {
  RESTORE_JOURNAL_NAME,
  RESTORE_JOURNAL_VERSION,
  SAFETY_CLAIM_MARKER_NAME,
  operationSuffix,
  proveClaimOwnership,
  safetySetClaimDirName,
  writeClaimMarker,
} from '../src/ops/complete-restore.js';
import {
  RETENTION_JOURNAL_NAME,
  RETENTION_LOCK_DIRNAME,
  classifyEntry,
  inventoryDestination,
} from '../src/ops/backup-retention.js';
import {
  SAFETY_CLAIM_MARKER_FILE,
  SAFETY_CLAIM_MARKER_ID,
  proveBackupSetIdentity,
  readRestoreClaimMarker,
  type ClaimMarkerRefusal,
} from '../src/ops/maintenance-identity.js';
import {
  MAINTENANCE_LOCK_DIRNAME, MaintenanceRefused,
} from '../src/ops/maintenance-safety.js';
import {
  CLAIM_MARKER_EXPECTATION,
  CLAIM_NAME_RE,
  MAX_CLAIM_ENTRIES,
  SAFETY_CONSUMING_MARKER_NAME,
  consumingMarkerPresent,
  SAFETY_ENTRY_STATES,
  SAFETY_QUARANTINE_CLAIM_PREFIX,
  SAFETY_QUARANTINE_MARKER_NAME,
  SAFETY_QUARANTINE_PREFIX,
  SAFETY_SET_JOURNAL_NAME,
  SAFETY_SET_JOURNAL_VERSION,
  SAFETY_SET_REPORT,
  SafetySetAbandonFailed,
  SafetySetFailed,
  abandonSafetySetLifecycle,
  canonicalSafetySetOperation,
  classifyClaim,
  digestSafetySetOperation,
  inventoryClaims,
  planSafetySetLifecycle,
  proveFloorFromDisk,
  readSafetySetJournal,
  renderSafetySetAbandon,
  renderSafetySetPlan,
  renderSafetySetRun,
  resolveSafetySetDestination,
  resolveSafetySetRequest,
  runSafetySetLifecycle,
  safetyPreconditionRefusal,
  writeSafetySetJournal,
  safetyQuarantineDirName,
  type SafetyEntryState,
  type SafetySetJournal,
  type SafetySetRunReport,
} from '../src/ops/safety-set-lifecycle.js';
import {
  CLAIM_CLASSES,
  CLAIM_EVIDENCE,
  CLAIM_EVIDENCE_TEXT,
  DEFAULT_SAFETY_SET_POLICY,
  REMOVABLE_CLAIM_CLASSES,
  SAFETY_SET_REASONS,
  SAFETY_SET_REASON_TEXT,
  assertUsableSafetyPolicy,
  evaluateSafetySetLifecycle,
  type ClaimClass,
  type ClaimInventoryEntry,
  type SafetySetPolicy,
} from '../src/ops/safety-set-model.js';
import { MS_PER_DAY, type InventoryEntry } from '../src/ops/retention-model.js';
import {
  SAFETY_SET_MODE_SWITCH_FLAGS,
  SAFETY_SET_MODE_VALUE_FLAGS,
  SAFETY_SET_EXIT_FAILED,
  SAFETY_SET_EXIT_OK,
  SAFETY_SET_EXIT_REFUSED,
  SAFETY_SET_EXIT_USAGE,
  main as cliMain,
  parseSafetySetArgs,
} from '../src/ops/safety-set-lifecycle-cli.js';
import { fakeDumpText, fakeToolchain } from './helpers/fake-toolchain.js';
import { SAFETY_CRASH_EXIT_CODE } from './helpers/safety-set-crash-child.mjs';

// Phases 313-320 — the lifecycle of the safety sets a RESTORE creates, and every way it must refuse.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - NOTHING IS REMOVED THAT IS NOT A CLAIM `ops:complete-restore` OF THIS BUILD CREATED. A claim-shaped
//     directory with no marker, one with a foreign marker, one from another schema, one that has been MOVED,
//     one holding something unaccounted for, one with work in flight, a link at a claim's name and every
//     ordinary backup set all survive, under every policy.
//   - `ops:backup-retention` STILL NEVER DESCENDS. Its rule that every dot-prefixed name is RESERVED is
//     asserted here, against the same fixtures, so this tranche cannot have quietly weakened it.
//   - THE UNCONDITIONAL PROTECTIONS HOLD, and the floor is counted over the WHOLE destination — so a
//     destination whose only restorable set is a safety set keeps it whatever `--keep-last` says.
//   - THE DIGEST BINDS THE LIST THAT WAS READ, claims and ordinary sets both.
//   - NOTHING IS DELETED IN PLACE. A run killed mid-run is proved, from disk, to leave every claim name in
//     the destination holding a whole claim or nothing at all.
//   - A SELF-CONSISTENT FORGED JOURNAL, WITH A RECOMPUTED DIGEST, IS STILL REFUSED.
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
    assert(err instanceof MaintenanceRefused, `${msg}: expected a MaintenanceRefused, got ${(err as Error).name}`);
    assert(message.includes(needle), `${msg}: expected a refusal mentioning "${needle}", got: ${message}`);
    return;
  }
  throw new Error(`${msg}: nothing was refused`);
}
/** The CLI's own argument errors are `MaintenanceUsageError`, which is a different kind and exits `2`. */
function rejectsUsage(fn: () => unknown, needle: string, msg: string): void {
  try { fn(); } catch (err) {
    const message = (err as Error).message;
    assertEq((err as Error).name, 'MaintenanceUsageError', `${msg}: the kind of error`);
    assert(message.includes(needle), `${msg}: expected a usage error mentioning "${needle}", got: ${message}`);
    return;
  }
  throw new Error(`${msg}: nothing was rejected`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').split('\r\n').join('\n');
const WORK = mkdtempSync(join(tmpdir(), 'ca-safety-set-'));
const SECRET_VALUE = 'a-kek-value-that-must-never-appear-in-any-report';
const NOW = new Date('2026-07-31T12:00:00.000Z');
const DAY = MS_PER_DAY;

// -----------------------------------------------------------------------------------------------------------
// Fixtures: real projects, real claims made by the shipped marker writer, real safety sets taken by the
// shipped Phase 277 command
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
  mkdirSync(join(root, 'backups'), { recursive: true });
  return root;
}

interface SetOptions {
  readonly daysAgo?: number;
  /** Make the set a genuine ROLLBACK POINT: an older dump AND a manifest that agrees it is older. */
  readonly rollbackPoint?: boolean;
  readonly destination?: string;
}

function takeSetInto(root: string, destination: string, setName: string, options: SetOptions = {}): string {
  const schema = options.rollbackPoint === true ? MIGRATION_VERSION - 1 : MIGRATION_VERSION;
  const tools = fakeToolchain({ dumpText: fakeDumpText(schema) });
  const takenAt = new Date(NOW.getTime() - (options.daysAgo ?? 0) * DAY);
  const request: CompleteBackupRequest = {
    projectRoot: root, destination, setName, custodian: 'inline',
    secrets: 'secrets', promotionRecords: 'promotion-records',
  };
  const outcome = runVerifiedCompleteBackup(request, {
    runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger, now: () => takenAt,
  });
  const setDir = join(root, destination, setName);
  if (options.rollbackPoint === true) {
    // THE MANIFEST HAS TO AGREE THAT IT IS OLDER, which is exactly the shape a set taken by the previous
    // release has. No component digest is touched.
    patchManifest(setDir, (manifest) => ({ ...manifest, schemaVersion: schema }));
    const report = verifyBackupSet(setDir);
    assert(report.ok, `the rollback-point fixture ${setName} had to verify`);
    assert(!report.restorableUnderThisBuild, 'and had to be NOT restorable under this build');
  } else {
    assert(outcome.ok, `the fixture set ${setName} had to be taken and verified: ${outcome.failures.join('; ')}`);
  }
  return setDir;
}

/** An ordinary top-level backup set, of the kind `ops:backup-retention` owns and this command never touches. */
function takeTopSet(root: string, setName: string, options: SetOptions = {}): string {
  return takeSetInto(root, options.destination ?? 'backups', setName, options);
}

interface ClaimOptions extends SetOptions {
  /** Publish no safety set: the claim a restore made and died before backing anything up into. */
  readonly empty?: boolean;
  readonly setName?: string;
}

interface MadeClaim {
  readonly name: string;
  readonly dir: string;
  readonly nonce: string;
  readonly planDigest: string;
  readonly setName: string | null;
}

/**
 * A claim exactly as `ops:complete-restore` publishes one: a nonce, a directory created for it, the SHIPPED
 * marker writer, and a safety set taken into it by the SHIPPED backup command.
 *
 * The nonce and the plan digest are derived from a label so the fixtures are deterministic and the names
 * sort predictably; a real run draws the nonce from the system CSPRNG, which changes nothing this command
 * checks.
 */
function makeClaim(root: string, label: string, options: ClaimOptions = {}): MadeClaim {
  const nonce = createHash('sha256').update(`nonce:${label}`).digest('hex').slice(0, 24);
  const planDigest = createHash('sha256').update(`plan:${label}`).digest('hex');
  const destination = options.destination ?? 'backups';
  const name = safetySetClaimDirName(nonce);
  const relative = `${destination}/${name}`;
  const dir = join(root, relative);
  mkdirSync(dir, { recursive: true });
  writeClaimMarker(dir, planDigest, operationSuffix(planDigest), nonce);
  if (options.empty === true) return { name, dir, nonce, planDigest, setName: null };
  const setName = options.setName ?? `pre-restore-${label}`;
  takeSetInto(root, relative, setName, options);
  return { name, dir, nonce, planDigest, setName };
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

/** Rewrite a claim's marker, keeping everything else. Used to forge, downgrade and corrupt it. */
function patchClaimMarker(claimDir: string, patch: (marker: Record<string, unknown>) => unknown): void {
  const path = join(claimDir, SAFETY_CLAIM_MARKER_NAME);
  const marker = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify(patch(marker), null, 2)}\n`, 'utf8');
}

/** Every file under a directory, as relative path -> sha256. For byte-identity assertions. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const name of readdirSync(current).slice().sort()) {
      const child = join(current, name);
      const stats = lstatSync(child);
      const key = relative(dir, child).split('\\').join('/');
      if (stats.isDirectory() && !stats.isSymbolicLink()) { out.set(`${key}/`, 'dir'); walk(child); continue; }
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
 * here is written against that.
 */
function linkDirectory(target: string, at: string): boolean {
  for (const kind of ['dir', 'junction'] as const) {
    try { symlinkSync(target, at, kind); return true; } catch { /* try the next mechanism */ }
  }
  return false;
}

function policy(overrides: Partial<SafetySetPolicy> = {}): SafetySetPolicy {
  return { ...DEFAULT_SAFETY_SET_POLICY, ...overrides };
}

/** A fabricated claim row, for driving the pure evaluator without ten gigabytes of fixtures. */
function claimRow(label: string, overrides: Partial<ClaimInventoryEntry> = {}): ClaimInventoryEntry {
  const nonce = createHash('sha256').update(`nonce:${label}`).digest('hex').slice(0, 24);
  return {
    name: safetySetClaimDirName(nonce),
    claimClass: 'OWNED_SET',
    evidence: 'MARKER_PROVED',
    nonce,
    claimDigest: createHash('sha256').update(`plan:${label}`).digest('hex'),
    setName: `pre-restore-${label}`,
    setDigest: createHash('sha256').update(label).digest('hex'),
    takenAt: new Date(NOW.getTime() - 100 * DAY).toISOString(),
    takenAtMs: NOW.getTime() - 100 * DAY,
    schemaVersion: MIGRATION_VERSION,
    restorable: true,
    bytes: 1000,
    entries: 4,
    findings: [],
    observedAtMs: NOW.getTime() - 100 * DAY,
    ...overrides,
  };
}

function agedRow(label: string, daysAgo: number, overrides: Partial<ClaimInventoryEntry> = {}): ClaimInventoryEntry {
  return claimRow(label, {
    takenAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    takenAtMs: NOW.getTime() - daysAgo * DAY,
    observedAtMs: NOW.getTime() - daysAgo * DAY,
    ...overrides,
  });
}

/** A fabricated ordinary top-level set row, for the floor. */
function destRow(name: string, overrides: Partial<InventoryEntry> = {}): InventoryEntry {
  return {
    name,
    setClass: 'VERIFIED',
    takenAt: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    takenAtMs: NOW.getTime() - 10 * DAY,
    schemaVersion: MIGRATION_VERSION,
    setDigest: createHash('sha256').update(name).digest('hex'),
    restorable: true,
    bytes: 1000,
    entries: 4,
    findings: [],
    ...overrides,
  };
}

function sortedRows(rows: readonly ClaimInventoryEntry[]): readonly ClaimInventoryEntry[] {
  return rows.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function reasonFor(evaluation: ReturnType<typeof evaluateSafetySetLifecycle>, name: string): string {
  const decision = evaluation.decisions.find((candidate) => candidate.name === name);
  assert(decision !== undefined, `there is a decision for ${name}`);
  return decision!.reason;
}

interface RunOptions {
  readonly policy?: Partial<SafetySetPolicy>;
  readonly now?: Date;
  readonly destination?: string;
  readonly deps?: Record<string, unknown>;
}

function planFor(root: string, options: RunOptions = {}): ReturnType<typeof planSafetySetLifecycle> {
  const resolved = resolveSafetySetRequest({
    projectRoot: root, destination: options.destination ?? 'backups',
  });
  return planSafetySetLifecycle(resolved, policy(options.policy), options.now ?? NOW);
}

function sweep(root: string, options: RunOptions = {}): {
  readonly plan: ReturnType<typeof planSafetySetLifecycle>;
  readonly report: SafetySetRunReport;
} {
  const plan = planFor(root, options);
  const report = runSafetySetLifecycle(
    { projectRoot: root, destination: options.destination ?? 'backups' },
    policy(options.policy),
    { now: () => options.now ?? NOW, suffix: () => 'bbbbbbbbbbbb', ...(options.deps ?? {}) },
    { kind: 'run', confirm: plan.digest },
  );
  return { plan, report };
}

console.log('Running Phases 313-320 restore safety-set lifecycle suite:\n');

// -----------------------------------------------------------------------------------------------------------
// Phase 313 — the claim inventory, classified from evidence and never from a name
// -----------------------------------------------------------------------------------------------------------

test('a claim published by the shipped writer, holding a verified safety set, is OWNED_SET', () => {
  const root = makeProject('inv-1');
  const claim = makeClaim(root, 'a', { daysAgo: 100 });
  const row = classifyClaim(join(root, 'backups'), claim.name);
  assertEq(row.claimClass, 'OWNED_SET', 'the class');
  assertEq(row.evidence, 'MARKER_PROVED', 'the evidence');
  assertEq(row.nonce, claim.nonce, 'the nonce comes out of the marker');
  assertEq(row.claimDigest, claim.planDigest, 'and so does the restore\'s plan digest');
  assertEq(row.setName, claim.setName, 'the safety set is named');
  assert(row.restorable, 'and this build could restore it');
  assert(row.setDigest.length === 64, 'with a verification digest');
  assert(row.takenAt !== null, 'and the manifest\'s own date');
});

test('a safety set from before this build\'s schema is a ROLLBACK POINT: verified and not restorable', () => {
  const root = makeProject('inv-2');
  const claim = makeClaim(root, 'rb', { daysAgo: 200, rollbackPoint: true });
  const row = classifyClaim(join(root, 'backups'), claim.name);
  assertEq(row.claimClass, 'OWNED_SET', 'it is a complete safety set');
  assertEq(row.restorable, false, 'and it is NOT restorable under this build');
});

test('a claim whose safety set was tampered with is OWNED_UNVERIFIED, and says which finding', () => {
  const root = makeProject('inv-3');
  const claim = makeClaim(root, 'c', { daysAgo: 100 });
  tamper(join(claim.dir, claim.setName!));
  const row = classifyClaim(join(root, 'backups'), claim.name);
  assertEq(row.claimClass, 'OWNED_UNVERIFIED', 'the class');
  assertEq(row.evidence, 'SET_DOES_NOT_VERIFY', 'the evidence');
  assert(row.findings.includes('COMPONENT_CHANGED'), `the finding is named: ${row.findings.join(',')}`);
  // `restorableUnderThisBuild` IS ABOUT THE SCHEMA VERSION ALONE, and a truncated set still satisfies it.
  // This field is what the floor counts and what the unconditional protection is chosen by, so it has to
  // mean "complete AND this build could put it back" or the floor could be met by a set that is not there.
  assertEq(verifyBackupSet(join(claim.dir, claim.setName!)).restorableUnderThisBuild, true,
    'the verification still says the SCHEMA is restorable');
  assertEq(row.restorable, false, 'and the inventory still says this claim is not');
});

test('a claim whose safety set has an unreadable manifest is OWNED_UNVERIFIED with SET_UNREADABLE', () => {
  const root = makeProject('inv-4');
  const claim = makeClaim(root, 'd', { daysAgo: 100 });
  writeFileSync(join(claim.dir, claim.setName!, BACKUP_MANIFEST_NAME), 'not json at all\n', 'utf8');
  const row = classifyClaim(join(root, 'backups'), claim.name);
  assertEq(row.claimClass, 'OWNED_UNVERIFIED', 'the class');
  assertEq(row.evidence, 'SET_UNREADABLE', 'the evidence');
  assertEq(row.setDigest, '', 'and it carries no identity, so nothing can ever be removed for it');
});

test('a claim a restore made and never published into is OWNED_EMPTY', () => {
  const root = makeProject('inv-5');
  const claim = makeClaim(root, 'e', { empty: true });
  const row = classifyClaim(join(root, 'backups'), claim.name);
  assertEq(row.claimClass, 'OWNED_EMPTY', 'the class');
  assertEq(row.evidence, 'EMPTY', 'the evidence');
  assertEq(row.setName, null, 'it names no set');
  assertEq(row.takenAt, null, 'and it has no manifest date at all');
  assert(row.observedAtMs !== null, 'only the directory\'s own modification time');
});

test('a claim holding a backup staging tree is OWNED_IN_FLIGHT: something is still writing into it', () => {
  const root = makeProject('inv-6');
  const claim = makeClaim(root, 'f', { empty: true });
  mkdirSync(join(claim.dir, '.pre-restore-f.staging-0123456789ab'), { recursive: true });
  const row = classifyClaim(join(root, 'backups'), claim.name);
  assertEq(row.claimClass, 'OWNED_IN_FLIGHT', 'the class');
  assertEq(row.evidence, 'IN_FLIGHT_ARTIFACT', 'the evidence');
});

test('a proved claim holding two sets, a stray file, or a link, is OWNED_UNEXPECTED', () => {
  const root = makeProject('inv-7');
  const two = makeClaim(root, 'g', { daysAgo: 100 });
  takeSetInto(root, `backups/${two.name}`, 'pre-restore-g2', { daysAgo: 99 });
  assertEq(classifyClaim(join(root, 'backups'), two.name).claimClass, 'OWNED_UNEXPECTED', 'two sets');

  const stray = makeClaim(root, 'h', { empty: true });
  writeFileSync(join(stray.dir, 'notes.txt'), 'mine\n', 'utf8');
  const strayRow = classifyClaim(join(root, 'backups'), stray.name);
  assertEq(strayRow.claimClass, 'OWNED_UNEXPECTED', 'a stray file');
  assertEq(strayRow.evidence, 'UNEXPECTED_MEMBERS', 'named as such');

  const linked = makeClaim(root, 'i', { empty: true });
  if (linkDirectory(join(root, 'promotion-records'), join(linked.dir, 'pre-restore-i'))) {
    assertEq(classifyClaim(join(root, 'backups'), linked.name).claimClass, 'OWNED_UNEXPECTED',
      'a link where the safety set should be');
  }
});

test('a claim-shaped name with no marker is MALFORMED, and is still INVENTORIED rather than invisible', () => {
  const root = makeProject('inv-8');
  const name = safetySetClaimDirName('0'.repeat(24));
  mkdirSync(join(root, 'backups', name), { recursive: true });
  writeFileSync(join(root, 'backups', name, 'theirs.txt'), 'not ours\n', 'utf8');
  const row = classifyClaim(join(root, 'backups'), name);
  assertEq(row.claimClass, 'MALFORMED', 'the class');
  assertEq(row.evidence, 'NO_MARKER', 'the evidence');
  assertEq(row.nonce, null, 'nothing about it is proved');
  assert(inventoryClaims(join(root, 'backups')).some((entry) => entry.name === name),
    'and it appears in the inventory, because a directory nobody looks at is one whose state nobody sees');
});

test('every way a marker can fail maps to its own evidence, and none of them is removable', () => {
  const root = makeProject('inv-9');
  const cases: Array<[string, (dir: string) => void, ClaimMarkerRefusal, ClaimClass]> = [
    ['unreadable', (dir) => writeFileSync(join(dir, SAFETY_CLAIM_MARKER_NAME), '{ nope', 'utf8'),
      'MARKER_UNREADABLE', 'MALFORMED'],
    ['not ours', (dir) => patchClaimMarker(dir, (marker) => ({ ...marker, marker: 'somebody.else' })),
      'MARKER_NOT_OURS', 'MALFORMED'],
    ['a scalar', (dir) => writeFileSync(join(dir, SAFETY_CLAIM_MARKER_NAME), '42', 'utf8'),
      'MARKER_NOT_OURS', 'MALFORMED'],
    ['an older journal schema', (dir) => patchClaimMarker(dir,
      (marker) => ({ ...marker, journalVersion: RESTORE_JOURNAL_VERSION - 1 })),
      'MARKER_OTHER_SCHEMA', 'OTHER_BUILD'],
    ['a newer journal schema', (dir) => patchClaimMarker(dir,
      (marker) => ({ ...marker, journalVersion: RESTORE_JOURNAL_VERSION + 1 })),
      'MARKER_OTHER_SCHEMA', 'OTHER_BUILD'],
    ['a marker version this build does not write', (dir) => patchClaimMarker(dir,
      (marker) => ({ ...marker, version: 2 })), 'MARKER_OTHER_SCHEMA', 'OTHER_BUILD'],
    ['a suffix that does not come from its own plan digest', (dir) => patchClaimMarker(dir,
      (marker) => ({ ...marker, suffix: 'ffffffffffff' })), 'MARKER_MALFORMED', 'MALFORMED'],
    ['a plan digest that is not one', (dir) => patchClaimMarker(dir,
      (marker) => ({ ...marker, planDigest: 'short' })), 'MARKER_MALFORMED', 'MALFORMED'],
    ['a nonce that is not one', (dir) => patchClaimMarker(dir,
      (marker) => ({ ...marker, nonce: 'zz' })), 'MARKER_MALFORMED', 'MALFORMED'],
    ['a null marker', (dir) => writeFileSync(join(dir, SAFETY_CLAIM_MARKER_NAME), 'null', 'utf8'),
      'MARKER_NOT_OURS', 'MALFORMED'],
  ];
  for (const [label, mutate, why, expectedClass] of cases) {
    const claim = makeClaim(root, `m-${label.replace(/[^a-z]/g, '')}`, { daysAgo: 100 });
    mutate(claim.dir);
    const reading = readRestoreClaimMarker(claim.dir, claim.name, CLAIM_MARKER_EXPECTATION);
    assert(!reading.ok, `${label}: the marker must not read as ours`);
    assertEq(reading.ok === false ? reading.why : 'ok', why, `${label}: the refusal`);
    const row = classifyClaim(join(root, 'backups'), claim.name);
    assertEq(row.claimClass, expectedClass, `${label}: the class`);
    assert(!REMOVABLE_CLAIM_CLASSES.includes(row.claimClass), `${label}: and no policy may consider it`);
  }
});

test('a valid claim MOVED to another name is found, and refused for the name disagreeing', () => {
  const root = makeProject('inv-10');
  const claim = makeClaim(root, 'moved', { daysAgo: 100 });
  const elsewhere = join(root, 'backups', safetySetClaimDirName('a'.repeat(24)));
  renameSync(claim.dir, elsewhere);
  const row = classifyClaim(join(root, 'backups'), safetySetClaimDirName('a'.repeat(24)));
  assertEq(row.claimClass, 'MALFORMED', 'the class');
  assertEq(row.evidence, 'MARKER_NAME_DISAGREES', 'the evidence');
  // AND THE SAME IN THE OTHER DIRECTION: a claim renamed to something that is not claim-shaped at all is
  // still inventoried, because it carries a marker file — the name decides nothing.
  const notShaped = join(root, 'backups', 'backups-old');
  renameSync(elsewhere, notShaped);
  const found = inventoryClaims(join(root, 'backups')).find((entry) => entry.name === 'backups-old');
  assert(found !== undefined, 'a marker under an ordinary name is still found');
  assertEq(found!.claimClass, 'MALFORMED', 'and still refused');
  assertEq(found!.evidence, 'MARKER_NAME_DISAGREES', 'for exactly this reason');
});

test('CORRECTION 1: admission never probes a child of a link, shaped or not', () => {
  const root = makeProject('link-admission');
  // A DIRECTORY OUTSIDE THE DESTINATION, holding a marker that would read as a perfectly valid claim. The
  // whole point is that this command must never find out.
  const outside = makeProject('link-admission-outside');
  const nonce = createHash('sha256').update('nonce:outside').digest('hex').slice(0, 24);
  const planDigest = createHash('sha256').update('plan:outside').digest('hex');
  const bait = join(outside, safetySetClaimDirName(nonce));
  mkdirSync(bait, { recursive: true });
  writeClaimMarker(bait, planDigest, operationSuffix(planDigest), nonce);
  const baitBefore = snapshot(bait);

  // 1. AN UNSHAPED LINK. The first cut `lstat`ed `<entry>/catalog-restore-claim.json` to decide admission,
  // which RESOLVES `<entry>` — so this junction was traversed, out of the destination, purely to answer a
  // question about whether to look at it. It is now not admitted, not opened and not followed.
  const unshaped = join(root, 'backups', 'somebody-elses-folder');
  if (linkDirectory(bait, unshaped)) {
    const names = inventoryClaims(join(root, 'backups')).map((entry) => entry.name);
    assertEq(names.includes('somebody-elses-folder'), false,
      `an unshaped link is not inventoried at all: ${names.join(', ')}`);
    assert(sameSnapshot(baitBefore, snapshot(bait)), 'and what it points at is untouched');
  }

  // 2. A SHAPED LINK is still admitted — by its NAME alone — so an operator sees it. It is classified from
  // an `lstat` of the link itself and is never opened.
  const shaped = join(root, 'backups', safetySetClaimDirName('d'.repeat(24)));
  if (linkDirectory(bait, shaped)) {
    const row = inventoryClaims(join(root, 'backups'))
      .find((entry) => entry.name === safetySetClaimDirName('d'.repeat(24)));
    assert(row !== undefined, 'a shaped link IS inventoried, so it is visible');
    assertEq(row!.claimClass, 'NOT_A_DIRECTORY', 'and classified from the link itself');
    assertEq(row!.evidence, 'NOT_A_DIRECTORY', 'with the evidence to match');
    assertEq(row!.nonce, null, 'nothing about it is proved');
    assert(sameSnapshot(baitBefore, snapshot(bait)), 'and what it points at is STILL untouched');
  }

  // 3. A DANGLING link at a shaped name is not a reason to throw, either.
  const dangling = join(root, 'backups', safetySetClaimDirName('f'.repeat(24)));
  if (linkDirectory(join(outside, 'never-existed'), dangling)) {
    const row = inventoryClaims(join(root, 'backups'))
      .find((entry) => entry.name === safetySetClaimDirName('f'.repeat(24)));
    assert(row !== undefined && !REMOVABLE_CLAIM_CLASSES.includes(row.claimClass),
      'a dangling shaped link is inventoried and is not removable');
  }
});

test('a reparse point at a claim-shaped name is NOT_A_DIRECTORY, and is never opened', () => {
  const root = makeProject('inv-11');
  const target = makeProject('inv-11-target');
  const name = safetySetClaimDirName('b'.repeat(24));
  if (!linkDirectory(target, join(root, 'backups', name))) return;
  const row = classifyClaim(join(root, 'backups'), name);
  assertEq(row.claimClass, 'NOT_A_DIRECTORY', 'the class');
  assertEq(row.evidence, 'NOT_A_DIRECTORY', 'the evidence');
  assert(existsSync(join(target, 'secrets')), 'and what it points at is untouched');
});

test('ordinary sets, this command\'s own artifacts and the shared lock are not claims', () => {
  const root = makeProject('inv-12');
  takeTopSet(root, 'set-a', { daysAgo: 100 });
  makeClaim(root, 'only', { daysAgo: 100 });
  mkdirSync(join(root, 'backups', RETENTION_LOCK_DIRNAME), { recursive: true });
  mkdirSync(join(root, 'backups', `${SAFETY_QUARANTINE_PREFIX}0123456789ab`), { recursive: true });
  mkdirSync(join(root, 'backups', `${SAFETY_QUARANTINE_CLAIM_PREFIX}0123456789abcdefgh`), { recursive: true });
  mkdirSync(join(root, 'backups', 'my-own-folder'), { recursive: true });
  const names = inventoryClaims(join(root, 'backups')).map((entry) => entry.name);
  assertEq(names.length, 1, `exactly one claim was found: ${names.join(', ')}`);
  assert(CLAIM_NAME_RE.test(names[0]!), 'and it is the claim');
});

test('a destination with more entries than this command inventories is refused rather than walked', () => {
  const root = makeProject('inv-13');
  assertEq(inventoryClaims(join(root, 'backups')).length, 0, 'an empty destination inventories to nothing');
  // REALLY OVER THE BOUND. A destination this large is not one this product manages, and the refusal has to
  // happen BEFORE anything is examined — so it is driven with real entries rather than asserted from source.
  for (let index = 0; index <= MAX_CLAIM_ENTRIES; index += 1) {
    writeFileSync(join(root, 'backups', `entry-${index}`), '\n', 'utf8');
  }
  refuses(() => inventoryClaims(join(root, 'backups')), 'more than this command', 'too many entries');
  rmSync(join(root, 'backups'), { recursive: true });
});

// -----------------------------------------------------------------------------------------------------------
// Phase 314 — the policy, and Phase 315 — the protection boundary, driven purely
// -----------------------------------------------------------------------------------------------------------

test('only three classes are ever removable, and every other one keeps with a named protection', () => {
  const expected: Readonly<Record<ClaimClass, string>> = {
    OWNED_SET: 'BEYOND_KEEP_WINDOW',
    OWNED_UNVERIFIED: 'PROTECTED_UNVERIFIED',
    OWNED_EMPTY: 'PROTECTED_EMPTY_CLAIM',
    OWNED_IN_FLIGHT: 'PROTECTED_IN_FLIGHT',
    OWNED_UNEXPECTED: 'PROTECTED_UNEXPECTED_CONTENTS',
    OTHER_BUILD: 'PROTECTED_NOT_PROVED_OURS',
    MALFORMED: 'PROTECTED_NOT_PROVED_OURS',
    UNREADABLE: 'PROTECTED_NOT_PROVED_OURS',
    NOT_A_DIRECTORY: 'PROTECTED_NOT_PROVED_OURS',
  };
  for (const claimClass of CLAIM_CLASSES) {
    // A newer, restorable set is present so the one under test is never the protected newest, and never the
    // newest rollback point either.
    const subject = agedRow('subject', 300, { claimClass, restorable: claimClass === 'OWNED_SET' });
    const rows = sortedRows([agedRow('newest', 1), agedRow('rollback', 2, { restorable: false }), subject]);
    const evaluation = evaluateSafetySetLifecycle(rows, [destRow('set-top')], policy({ keepLast: 1 }), NOW);
    assertEq(reasonFor(evaluation, subject.name), expected[claimClass], `${claimClass}`);
    assertEq(evaluation.removals.includes(subject.name), claimClass === 'OWNED_SET',
      `${claimClass}: only a complete safety set is ever a candidate by default`);
  }
});

test('the newest restorable safety set is protected unconditionally, however small --keep-last is', () => {
  const rows = sortedRows([agedRow('old', 300), agedRow('newest', 200)]);
  const evaluation = evaluateSafetySetLifecycle(rows, [destRow('set-top')],
    policy({ keepLast: 1, minAgeDays: 0 }), NOW);
  const newest = rows.find((row) => row.takenAtMs === NOW.getTime() - 200 * DAY)!;
  assertEq(reasonFor(evaluation, newest.name), 'PROTECTED_NEWEST_RESTORABLE', 'it is protected by name');
  assertEq(evaluation.protectedNewestRestorable, newest.name, 'and reported as the protected one');
});

test('the newest ROLLBACK POINT is protected unconditionally too — "keep the newest that works" would not', () => {
  const rows = sortedRows([
    agedRow('rollback', 300, { restorable: false }),
    agedRow('restorable', 10),
  ]);
  const evaluation = evaluateSafetySetLifecycle(rows, [destRow('set-top')],
    policy({ keepLast: 1, minAgeDays: 0 }), NOW);
  const rollback = rows.find((row) => !row.restorable)!;
  assertEq(reasonFor(evaluation, rollback.name), 'PROTECTED_NEWEST_ROLLBACK_POINT', 'protected');
  assertEq(evaluation.protectedNewestRollbackPoint, rollback.name, 'and named');
  assertEq(evaluation.removals.length, 0, 'so nothing at all is removed');
});

test('THE HEADLINE: a destination whose only restorable set is a SAFETY set keeps it', () => {
  // Ordinary top-level sets exist and NONE of them is restorable under this build — the shape a destination
  // has after an upgrade. The only thing that could put this installation back is inside a claim.
  const rows = sortedRows([agedRow('only', 300)]);
  const destination = [destRow('set-old', { restorable: false }), destRow('set-older', { restorable: false })];
  const evaluation = evaluateSafetySetLifecycle(rows, destination, policy({ keepLast: 1, minAgeDays: 0 }), NOW);
  assertEq(reasonFor(evaluation, rows[0]!.name), 'PROTECTED_NEWEST_RESTORABLE', 'it is the newest restorable');
  assertEq(evaluation.restorableRemaining, 1, 'and it is the whole floor');
  assertEq(evaluation.restorableTopLevel, 0, 'nothing at the top level could restore this installation');
});

test('the floor counts the WHOLE destination, and refuses a policy that would breach it', () => {
  const rows = sortedRows([agedRow('a', 300), agedRow('b', 250), agedRow('c', 200)]);
  const destination = [destRow('set-top', { restorable: false })];
  const kept = evaluateSafetySetLifecycle(rows, destination,
    policy({ keepLast: 1, minAgeDays: 0, keepMinimumRestorable: 1 }), NOW);
  assertEq(kept.refusals.length, 0, 'one restorable safety set survives, so the floor is met');
  const refused = evaluateSafetySetLifecycle(rows, destination,
    policy({ keepLast: 1, minAgeDays: 0, keepMinimumRestorable: 3 }), NOW);
  assert(refused.refusals.includes('FLOOR_NOT_MET'), 'a floor of three is not met and the run refuses');
  const withTopLevel = evaluateSafetySetLifecycle(rows, [destRow('s1'), destRow('s2')],
    policy({ keepLast: 1, minAgeDays: 0, keepMinimumRestorable: 3 }), NOW);
  assertEq(withTopLevel.refusals.length, 0, 'and two ordinary restorable sets meet the same floor');
  assertEq(withTopLevel.restorableTopLevel, 2, 'counted as top-level sets');
});

test('a destination with nothing restorable anywhere refuses the whole run', () => {
  const rows = sortedRows([agedRow('rb', 300, { restorable: false })]);
  const evaluation = evaluateSafetySetLifecycle(rows, [destRow('set-top', { restorable: false })],
    policy(), NOW);
  assert(evaluation.refusals.includes('NO_RESTORABLE_SET'), 'the whole run refuses');
});

test('min-age protects, and a claim dated in the FUTURE is protected by the same branch', () => {
  const rows = sortedRows([
    // `futuremost` exists so the one being tested is never ALSO the newest restorable, which is protected by
    // an earlier branch and would hide what this test is about.
    agedRow('futuremost', -10),
    agedRow('young', 3),
    agedRow('future', -5),
    agedRow('old', 300),
  ]);
  const evaluation = evaluateSafetySetLifecycle(rows, [destRow('set-top')],
    policy({ keepLast: 1, minAgeDays: 7 }), NOW);
  assertEq(reasonFor(evaluation, rows.find((r) => r.takenAtMs === NOW.getTime() - 3 * DAY)!.name),
    'PROTECTED_MIN_AGE', 'the young one');
  assertEq(reasonFor(evaluation, rows.find((r) => r.takenAtMs === NOW.getTime() + 5 * DAY)!.name),
    'PROTECTED_MIN_AGE', 'and the one from the future');
  const zeroAge = evaluateSafetySetLifecycle(rows, [destRow('set-top')],
    policy({ keepLast: 1, minAgeDays: 0 }), NOW);
  assertEq(reasonFor(zeroAge, rows.find((r) => r.takenAtMs === NOW.getTime() + 5 * DAY)!.name),
    'PROTECTED_MIN_AGE', 'even with --min-age-days 0');
});

test('the keep window ranks COMPLETE safety sets only, so a broken one never occupies a slot', () => {
  const rows = sortedRows([
    agedRow('n1', 10),
    agedRow('n2', 20),
    agedRow('broken', 30, { claimClass: 'OWNED_UNVERIFIED', restorable: false, evidence: 'SET_DOES_NOT_VERIFY' }),
    agedRow('n3', 40),
    agedRow('n4', 300),
  ]);
  const evaluation = evaluateSafetySetLifecycle(rows, [destRow('set-top')],
    policy({ keepLast: 3, minAgeDays: 0 }), NOW);
  const inWindow = rows.filter((row) => [10, 20, 40].includes(Math.round((NOW.getTime() - row.takenAtMs!) / DAY)));
  for (const row of inWindow) {
    const reason = reasonFor(evaluation, row.name);
    assert(reason === 'PROTECTED_KEEP_WINDOW' || reason === 'PROTECTED_NEWEST_RESTORABLE',
      `${row.name} is inside the window (${reason})`);
  }
  assertEq(evaluation.removals.length, 1, 'and only the one beyond it goes');
});

test('an empty claim is protected without the flag, aged by mtime with it, and undated without one', () => {
  const empty = agedRow('empty', 300, {
    claimClass: 'OWNED_EMPTY', evidence: 'EMPTY', restorable: false, setName: null, setDigest: '',
    takenAt: null, takenAtMs: null,
  });
  const rows = sortedRows([agedRow('keeper', 1), empty]);
  const off = evaluateSafetySetLifecycle(rows, [destRow('set-top')], policy({ minAgeDays: 0 }), NOW);
  assertEq(reasonFor(off, empty.name), 'PROTECTED_EMPTY_CLAIM', 'protected by default');
  const on = evaluateSafetySetLifecycle(rows, [destRow('set-top')],
    policy({ minAgeDays: 0, includeEmptyClaims: true }), NOW);
  assertEq(reasonFor(on, empty.name), 'EMPTY_CLAIM', 'removable with the flag');
  const young = evaluateSafetySetLifecycle(
    sortedRows([agedRow('keeper', 1), { ...empty, observedAtMs: NOW.getTime() - DAY }]),
    [destRow('set-top')], policy({ minAgeDays: 14, includeEmptyClaims: true }), NOW);
  assertEq(reasonFor(young, empty.name), 'PROTECTED_MIN_AGE', 'and its mtime still has to clear --min-age-days');
  const undated = evaluateSafetySetLifecycle(
    sortedRows([agedRow('keeper', 1), { ...empty, observedAtMs: null }]),
    [destRow('set-top')], policy({ minAgeDays: 0, includeEmptyClaims: true }), NOW);
  assertEq(reasonFor(undated, empty.name), 'PROTECTED_UNDATED',
    'with no date at all it has no place in an ordering');
});

test('an unverified claim is a candidate only with --include-unverified, and never a protected one', () => {
  const broken = agedRow('broken', 300, {
    claimClass: 'OWNED_UNVERIFIED', evidence: 'SET_DOES_NOT_VERIFY', restorable: false,
  });
  const rows = sortedRows([agedRow('keeper', 1), broken]);
  assertEq(reasonFor(evaluateSafetySetLifecycle(rows, [destRow('s')], policy({ minAgeDays: 0 }), NOW),
    broken.name), 'PROTECTED_UNVERIFIED', 'off by default');
  assertEq(reasonFor(evaluateSafetySetLifecycle(rows, [destRow('s')],
    policy({ minAgeDays: 0, includeUnverified: true }), NOW), broken.name), 'UNVERIFIED_SAFETY_SET',
    'and a candidate with the flag');
});

test('a claim whose safety set has NO recorded identity is never a candidate, whatever flag is given', () => {
  // A claim whose set could not be examined at all carries no set digest, and the identity proof refuses to
  // act on a commitment with nothing in it. A plan that named it would be a plan that can never be performed
  // — and worse, the run would STOP on it and leave every later candidate untouched.
  const noIdentity = agedRow('unreadable', 300, {
    claimClass: 'OWNED_UNVERIFIED', evidence: 'SET_UNREADABLE', restorable: false, setDigest: '',
    takenAt: null, takenAtMs: null,
  });
  const rows = sortedRows([agedRow('keeper', 1), noIdentity]);
  for (const flags of [{}, { includeUnverified: true }, { includeUnverified: true, includeEmptyClaims: true }]) {
    const evaluation = evaluateSafetySetLifecycle(rows, [destRow('s')],
      policy({ minAgeDays: 0, keepLast: 1, ...flags }), NOW);
    assertEq(reasonFor(evaluation, noIdentity.name), 'PROTECTED_NO_IDENTITY', JSON.stringify(flags));
    assertEq(evaluation.removals.includes(noIdentity.name), false, 'and it is never in the removal list');
  }
});

test('END TO END: --include-unverified on a claim with an unreadable manifest still removes the others', () => {
  const root = makeProject('no-identity');
  takeTopSet(root, 'set-a', { daysAgo: 100 });
  const unreadable = makeClaim(root, 'unreadable', { daysAgo: 500 });
  writeFileSync(join(unreadable.dir, unreadable.setName!, BACKUP_MANIFEST_NAME), 'not json\n', 'utf8');
  const removable = makeClaim(root, 'removable', { daysAgo: 300 });
  makeClaim(root, 'keeper', { daysAgo: 10 });
  const before = snapshot(unreadable.dir);
  const { plan, report } = sweep(root, { policy: { keepLast: 1, minAgeDays: 7, includeUnverified: true } });
  assertEq(plan.removals.includes(unreadable.name), false, 'the plan does not name what it could never remove');
  assert(report.ok, `and the run finishes: ${JSON.stringify(report.failed)}`);
  assertEq(JSON.stringify(report.removed), JSON.stringify([removable.name]), 'removing the one it can');
  assert(sameSnapshot(before, snapshot(unreadable.dir)), 'the unreadable claim is byte-identical');
});

test('removals are ordered OLDEST FIRST, deterministically, with ties broken by name', () => {
  const rows = sortedRows([agedRow('keeper', 1), agedRow('x', 300), agedRow('y', 400), agedRow('z', 350)]);
  const evaluation = evaluateSafetySetLifecycle(rows, [destRow('s')],
    policy({ keepLast: 1, minAgeDays: 0 }), NOW);
  const ages = evaluation.removals.map((name) =>
    Math.round((NOW.getTime() - rows.find((row) => row.name === name)!.takenAtMs!) / DAY));
  assertEq(JSON.stringify(ages), JSON.stringify([400, 350, 300]), 'oldest first');
});

test('a policy that is not a policy is refused, and there is no value that means "keep none"', () => {
  refuses(() => assertUsableSafetyPolicy(policy({ keepLast: 0 })), 'keep none', 'keep-last 0');
  refuses(() => assertUsableSafetyPolicy(policy({ keepLast: 1.5 })), '--keep-last', 'a fraction');
  refuses(() => assertUsableSafetyPolicy(policy({ minAgeDays: -1 })), '--min-age-days', 'a negative age');
  refuses(() => assertUsableSafetyPolicy(policy({ keepMinimumRestorable: 0 })), 'cannot be zero', 'a zero floor');
  refuses(() => evaluateSafetySetLifecycle([], [], policy(), new Date(Number.NaN)), 'usable time', 'a broken clock');
});

test('the class, evidence and reason vocabularies are closed, total and rendered', () => {
  assertEq(new Set(CLAIM_CLASSES).size, CLAIM_CLASSES.length, 'no class appears twice');
  assertEq(new Set(SAFETY_SET_REASONS).size, SAFETY_SET_REASONS.length, 'no reason appears twice');
  for (const reason of SAFETY_SET_REASONS) {
    assert(typeof SAFETY_SET_REASON_TEXT[reason] === 'string' && SAFETY_SET_REASON_TEXT[reason].length > 10,
      `${reason} is rendered in words an operator can read`);
  }
  for (const evidence of CLAIM_EVIDENCE) {
    assert(typeof CLAIM_EVIDENCE_TEXT[evidence] === 'string' && CLAIM_EVIDENCE_TEXT[evidence].length > 10,
      `${evidence} is rendered in words an operator can read`);
  }
  for (const removable of REMOVABLE_CLAIM_CLASSES) {
    assert(CLAIM_CLASSES.includes(removable), `${removable} is a class`);
    assert(removable.startsWith('OWNED_'), `${removable} is only ever a claim proved to be ours`);
  }
});

// -----------------------------------------------------------------------------------------------------------
// Phase 315 — the plan and the digest
// -----------------------------------------------------------------------------------------------------------

test('--plan changes nothing at all: the destination is byte-identical afterwards', () => {
  const root = makeProject('plan-1');
  takeTopSet(root, 'set-a', { daysAgo: 100 });
  makeClaim(root, 'a', { daysAgo: 300 });
  makeClaim(root, 'b', { daysAgo: 200 });
  const before = snapshot(join(root, 'backups'));
  const plan = planFor(root, { policy: { keepLast: 1, minAgeDays: 0 } });
  assert(plan.digest.length === 64, 'a plan has a digest');
  assertEq(plan.wrote, 'nothing', 'and it says it wrote nothing');
  assert(sameSnapshot(before, snapshot(join(root, 'backups'))), 'and the destination is byte-identical');
  assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false, 'no project lock was taken');
  assertEq(existsSync(join(root, 'backups', RETENTION_LOCK_DIRNAME)), false, 'no destination lock either');
});

test('a refused evaluation prints no digest — there is nothing to confirm', () => {
  const root = makeProject('plan-2');
  makeClaim(root, 'rb', { daysAgo: 300, rollbackPoint: true });
  refuses(() => planFor(root), 'holds no verified set that this build could restore', 'nothing restorable');
});

test('the digest refuses a confirmation once ANYTHING relevant has changed', () => {
  const cases: Array<[string, (root: string) => void]> = [
    ['a new restore took a safety set', (root) => { makeClaim(root, 'late', { daysAgo: 0 }); }],
    ['a nightly backup landed at the top level', (root) => { takeTopSet(root, 'set-late', { daysAgo: 0 }); }],
    ['a safety set\'s bytes changed', (root) => {
      const claims = inventoryClaims(join(root, 'backups'));
      const victim = claims.find((claim) => claim.setName !== null)!;
      tamper(join(root, 'backups', victim.name, victim.setName!));
    }],
    ['a claim\'s ownership marker was rewritten', (root) => {
      const victim = inventoryClaims(join(root, 'backups'))[0]!;
      patchClaimMarker(join(root, 'backups', victim.name), (marker) => ({ ...marker, version: 2 }));
    }],
  ];
  for (const [label, mutate] of cases) {
    const root = makeProject(`digest-${label.replace(/[^a-z]/g, '')}`);
    takeTopSet(root, 'set-a', { daysAgo: 100 });
    makeClaim(root, 'a', { daysAgo: 300 });
    makeClaim(root, 'b', { daysAgo: 200 });
    const plan = planFor(root, { policy: { keepLast: 1, minAgeDays: 0 } });
    mutate(root);
    const before = snapshot(join(root, 'backups'));
    refuses(() => runSafetySetLifecycle({ projectRoot: root, destination: 'backups' },
      policy({ keepLast: 1, minAgeDays: 0 }), { now: () => NOW }, { kind: 'run', confirm: plan.digest }),
      'not the one the plan was read against', label);
    assert(sameSnapshot(before, snapshot(join(root, 'backups'))), `${label}: and nothing moved`);
  }
});

test('a different policy, a different project and ten days of clock each refuse the same digest', () => {
  const root = makeProject('digest-policy');
  takeTopSet(root, 'set-a', { daysAgo: 100 });
  makeClaim(root, 'a', { daysAgo: 300 });
  // `b` is INSIDE --min-age-days at NOW and outside it thirty-five days later. Nothing about the destination
  // changes; only the clock does, and that alone is a different decision about a different set of claims.
  makeClaim(root, 'b', { daysAgo: 3 });
  makeClaim(root, 'c', { daysAgo: 1 });
  const plan = planFor(root, { policy: { keepLast: 1, minAgeDays: 7 } });
  assertEq(plan.removals.length, 1, 'today, exactly one claim is beyond every protection');

  refuses(() => runSafetySetLifecycle({ projectRoot: root, destination: 'backups' },
    policy({ keepLast: 2, minAgeDays: 7 }), { now: () => NOW }, { kind: 'run', confirm: plan.digest }),
    'not the one the plan was read against', 'a different policy');

  const twin = makeProject('digest-twin');
  takeTopSet(twin, 'set-a', { daysAgo: 100 });
  makeClaim(twin, 'a', { daysAgo: 300 });
  makeClaim(twin, 'b', { daysAgo: 3 });
  makeClaim(twin, 'c', { daysAgo: 1 });
  const twinPlan = planFor(twin, { policy: { keepLast: 1, minAgeDays: 7 } });
  assert(twinPlan.digest !== plan.digest, 'two projects holding identical claims do not share a digest');

  // TIME ALONE IS ENOUGH. Thirty-five days on, claim `b` has crossed --min-age-days: that is a different
  // decision about a different set of claims, and it is refused for the same reason as any other change.
  const later = new Date(NOW.getTime() + 35 * DAY);
  refuses(() => runSafetySetLifecycle({ projectRoot: root, destination: 'backups' },
    policy({ keepLast: 1, minAgeDays: 7 }), { now: () => later }, { kind: 'run', confirm: plan.digest }),
    'crossed --min-age-days', 'the clock moved');
});

test('the plan names every claim, its evidence, its decision and both protections — and no path', () => {
  const root = makeProject('plan-render');
  takeTopSet(root, 'set-a', { daysAgo: 100 });
  const old = makeClaim(root, 'a', { daysAgo: 300 });
  makeClaim(root, 'b', { daysAgo: 200 });
  const plan = planFor(root, { policy: { keepLast: 1, minAgeDays: 0 } });
  const rendered = renderSafetySetPlan(plan);
  assert(rendered.includes(old.name), 'every claim is named');
  assert(rendered.includes('MARKER_PROVED'), 'with the evidence for its class');
  assert(rendered.includes('BEYOND_KEEP_WINDOW'), 'and the reason for its decision');
  assert(rendered.includes('set-a'), 'the ordinary sets are listed too, so the floor is legible');
  assert(rendered.includes(plan.digest), 'and the digest is printed');
  assert(!rendered.includes(WORK), 'no host path reaches the plan');
  assert(!rendered.includes(SECRET_VALUE), 'and no secret value');
});

// -----------------------------------------------------------------------------------------------------------
// Phases 316-317 — a real run
// -----------------------------------------------------------------------------------------------------------

test('a real run removes exactly the planned claims and leaves every ordinary set byte-identical', () => {
  const root = makeProject('run-1');
  takeTopSet(root, 'set-a', { daysAgo: 100 });
  takeTopSet(root, 'set-b', { daysAgo: 50 });
  const a = makeClaim(root, 'a', { daysAgo: 300 });
  const b = makeClaim(root, 'b', { daysAgo: 250 });
  const keeper = makeClaim(root, 'keeper', { daysAgo: 20 });
  const ordinaryBefore = new Map([...snapshot(join(root, 'backups', 'set-a'))].map(([k, v]) => [`a/${k}`, v]));
  for (const [k, v] of snapshot(join(root, 'backups', 'set-b'))) ordinaryBefore.set(`b/${k}`, v);

  const { report } = sweep(root, { policy: { keepLast: 1, minAgeDays: 7 } });
  assert(report.ok, `the run succeeded: ${JSON.stringify(report.failed)}`);
  assertEq(report.state, 'REMOVED', 'the state');
  assertEq(JSON.stringify([...report.removed].sort()), JSON.stringify([a.name, b.name].sort()), 'what went');
  assertEq(existsSync(a.dir), false, 'the oldest claim is gone');
  assertEq(existsSync(b.dir), false, 'and the next one');
  assert(existsSync(keeper.dir), 'the newest is still there');
  assert(report.protectedNewestRestorableVerified, 'and it still verifies, proved from disk');
  assertEq(report.journalCleared, true, 'the journal was cleared');
  assertEq(report.retained, null, 'and the quarantine directory is gone');
  const ordinaryAfter = new Map([...snapshot(join(root, 'backups', 'set-a'))].map(([k, v]) => [`a/${k}`, v]));
  for (const [k, v] of snapshot(join(root, 'backups', 'set-b'))) ordinaryAfter.set(`b/${k}`, v);
  assert(sameSnapshot(ordinaryBefore, ordinaryAfter), 'and no ordinary backup set was touched');
  assertEq(report.commands, 'none', 'no command was issued');
});

test('a claim that is not provably ours survives a run that removes the ones beside it', () => {
  const root = makeProject('run-2');
  takeTopSet(root, 'set-a', { daysAgo: 100 });
  const removable = makeClaim(root, 'a', { daysAgo: 300 });
  makeClaim(root, 'keeper', { daysAgo: 10 });
  const stranger = join(root, 'backups', safetySetClaimDirName('c'.repeat(24)));
  mkdirSync(stranger, { recursive: true });
  writeFileSync(join(stranger, 'theirs.txt'), 'not ours at all\n', 'utf8');
  const strangerBefore = snapshot(stranger);
  const foreignMarker = makeClaim(root, 'foreign', { daysAgo: 300 });
  patchClaimMarker(foreignMarker.dir, (marker) => ({ ...marker, journalVersion: RESTORE_JOURNAL_VERSION - 1 }));

  const { report } = sweep(root, { policy: { keepLast: 1, minAgeDays: 7 } });
  assert(report.ok, 'the run succeeded');
  assertEq(JSON.stringify(report.removed), JSON.stringify([removable.name]), 'only the proved claim went');
  assert(sameSnapshot(strangerBefore, snapshot(stranger)), 'the stranger\'s directory is byte-identical');
  assert(existsSync(foreignMarker.dir), 'and the claim from another build is still there');
});

test('a run kills its own quarantine directory and never leaves a marked one behind on success', () => {
  const root = makeProject('run-3');
  takeTopSet(root, 'set-a', { daysAgo: 100 });
  makeClaim(root, 'a', { daysAgo: 300 });
  makeClaim(root, 'keeper', { daysAgo: 10 });
  sweep(root, { policy: { keepLast: 1, minAgeDays: 7 } });
  const leftovers = readdirSync(join(root, 'backups'))
    .filter((name) => name.startsWith(SAFETY_QUARANTINE_PREFIX) || name.startsWith(SAFETY_QUARANTINE_CLAIM_PREFIX));
  assertEq(leftovers.length, 0, `no quarantine artifact survives: ${leftovers.join(', ')}`);
  assertEq(existsSync(join(root, SAFETY_SET_JOURNAL_NAME)), false, 'and no journal');
  assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false, 'both locks were released');
  assertEq(existsSync(join(root, 'backups', RETENTION_LOCK_DIRNAME)), false, 'including the shared one');
});

test('a run refuses a project part way through a restore, or through a backup prune', () => {
  for (const [label, journal] of [['a restore', RESTORE_JOURNAL_NAME], ['a prune', RETENTION_JOURNAL_NAME]] as const) {
    const root = makeProject(`busy-${journal}`);
    takeTopSet(root, 'set-a', { daysAgo: 100 });
    const claim = makeClaim(root, 'a', { daysAgo: 300 });
    makeClaim(root, 'keeper', { daysAgo: 10 });
    const plan = planFor(root, { policy: { keepLast: 1, minAgeDays: 7 } });
    writeFileSync(join(root, journal), '{"whatever":true}\n', 'utf8');
    const before = snapshot(join(root, 'backups'));
    refuses(() => planFor(root, { policy: { keepLast: 1, minAgeDays: 7 } }),
      journal === RESTORE_JOURNAL_NAME ? 'part way through a restore' : 'part way through a backup prune',
      `${label}: the plan`);
    refuses(() => runSafetySetLifecycle({ projectRoot: root, destination: 'backups' },
      policy({ keepLast: 1, minAgeDays: 7 }), { now: () => NOW }, { kind: 'run', confirm: plan.digest }),
      journal === RESTORE_JOURNAL_NAME ? 'part way through a restore' : 'part way through a backup prune',
      `${label}: the run`);
    assert(sameSnapshot(before, snapshot(join(root, 'backups'))), `${label}: and nothing moved`);
    assert(existsSync(claim.dir), `${label}: the claim is exactly where it was`);
    rmSync(join(root, journal));
  }
});

test('the destination lock is the SAME one ops:backup-retention takes, so the two cannot overlap', () => {
  const root = makeProject('lock-1');
  takeTopSet(root, 'set-a', { daysAgo: 100 });
  makeClaim(root, 'a', { daysAgo: 300 });
  makeClaim(root, 'keeper', { daysAgo: 10 });
  const plan = planFor(root, { policy: { keepLast: 1, minAgeDays: 7 } });
  mkdirSync(join(root, 'backups', RETENTION_LOCK_DIRNAME), { recursive: true });
  refuses(() => runSafetySetLifecycle({ projectRoot: root, destination: 'backups' },
    policy({ keepLast: 1, minAgeDays: 7 }), { now: () => NOW }, { kind: 'run', confirm: plan.digest }),
    RETENTION_LOCK_DIRNAME, 'the shared destination lock is honoured');
  rmSync(join(root, 'backups', RETENTION_LOCK_DIRNAME), { recursive: true });
  mkdirSync(join(root, MAINTENANCE_LOCK_DIRNAME), { recursive: true });
  refuses(() => runSafetySetLifecycle({ projectRoot: root, destination: 'backups' },
    policy({ keepLast: 1, minAgeDays: 7 }), { now: () => NOW }, { kind: 'run', confirm: plan.digest }),
    'another maintenance command', 'and so is the project lock');
  rmSync(join(root, MAINTENANCE_LOCK_DIRNAME), { recursive: true });
});

// -----------------------------------------------------------------------------------------------------------
// Real deaths, at named boundaries, in real child processes
// -----------------------------------------------------------------------------------------------------------

const CHILD = fileURLToPath(new URL('./helpers/safety-set-crash-child.mts', import.meta.url));
const SUFFIX = 'aaaaaaaaaaaa';

function spawnChild(config: Record<string, unknown>): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath,
    [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), CHILD, JSON.stringify(config)],
    { encoding: 'utf8', cwd: repoRoot });
}

function clearLocks(root: string): void {
  // A KILLED RUN LEAVES BOTH LOCKS, exactly as a real one does. The recovery runs in-process, so they are
  // removed here the way an operator would after satisfying themselves nothing is running.
  for (const lock of [join(root, MAINTENANCE_LOCK_DIRNAME), join(root, 'backups', RETENTION_LOCK_DIRNAME)]) {
    assert(existsSync(lock), `the crash left ${lock}`);
    rmSync(lock, { recursive: true });
  }
}

function crash(root: string, crashAt: string, options: { readonly policy?: Partial<SafetySetPolicy> } = {}): string {
  const pol = policy(options.policy ?? {});
  const plan = planSafetySetLifecycle(
    resolveSafetySetRequest({ projectRoot: root, destination: 'backups' }), pol, NOW);
  const result = spawnChild({
    projectRoot: root, destination: 'backups', confirm: plan.digest, suffix: SUFFIX,
    policy: pol, nowMs: NOW.getTime(), crashAt,
  });
  assertEq(result.status, SAFETY_CRASH_EXIT_CODE,
    `the child had to stop existing at ${crashAt}, not exit ${result.status}: ${result.stderr}`);
  clearLocks(root);
  return plan.digest;
}

function resume(root: string, digest: string, deps: Record<string, unknown> = {}): SafetySetRunReport {
  return runSafetySetLifecycle({ projectRoot: root, destination: 'backups' }, policy(),
    { now: () => NOW, ...deps }, { kind: 'resume', confirm: digest });
}

function journalOf(root: string): SafetySetJournal {
  return JSON.parse(readFileSync(join(root, SAFETY_SET_JOURNAL_NAME), 'utf8')) as SafetySetJournal;
}

/** A project with one removable claim, one keeper claim and one ordinary set. The standard crash fixture. */
function crashFixture(name: string): { readonly root: string; readonly a: MadeClaim; readonly keeper: MadeClaim } {
  const root = makeProject(name);
  takeTopSet(root, 'set-a', { daysAgo: 100 });
  const a = makeClaim(root, 'a', { daysAgo: 300 });
  const keeper = makeClaim(root, 'keeper', { daysAgo: 10 });
  return { root, a, keeper };
}

const CRASH_POLICY = { keepLast: 1, minAgeDays: 7 };

/** The consumption nonce the precondition matrix arranges for a `deleting` entry. Twenty-four hex. */
const MATRIX_CONSUME_NONCE = 'abcdef0123456789abcdef01';

test('killed after the journal: nothing has moved, and a resume finishes the operation', () => {
  const { root, a, keeper } = crashFixture('crash-journal');
  const digest = crash(root, 'after-journal', { policy: CRASH_POLICY });
  assert(existsSync(join(root, SAFETY_SET_JOURNAL_NAME)), 'the journal is on disk');
  assert(existsSync(a.dir), 'and not one directory has moved');
  assertEq(journalOf(root).entries.every((entry) => entry.state === 'pending'), true, 'every entry is pending');
  const report = resume(root, digest);
  assert(report.ok, `the resume finished: ${JSON.stringify(report.failed)}`);
  assertEq(existsSync(a.dir), false, 'the claim is gone');
  assert(existsSync(keeper.dir), 'and the keeper is not');
});

test('killed between the rename and the record: NOTHING IS HALF-DELETED', () => {
  const { root, a } = crashFixture('crash-rename');
  const whole = snapshot(a.dir);
  const digest = crash(root, `after-quarantine-rename:${a.name}`, { policy: CRASH_POLICY });
  // READ OFF DISK, not inferred: the claim name in the destination holds NOTHING, and the quarantine holds
  // the claim byte for byte.
  assertEq(existsSync(a.dir), false, 'the claim name in the destination is absent');
  const quarantined = join(root, 'backups', safetyQuarantineDirName(SUFFIX), a.name);
  assert(existsSync(quarantined), 'and the claim is in the quarantine directory');
  assert(sameSnapshot(whole, snapshot(quarantined)), 'byte for byte whole');
  assertEq(journalOf(root).entries[0]!.state, 'pending', 'and the journal had not recorded the rename yet');
  const report = resume(root, digest);
  assert(report.ok, `the resume adopted it and finished: ${JSON.stringify(report.failed)}`);
  assert(report.notes.some((note) => note.includes('already in the quarantine directory')),
    'and said so rather than repeating the rename');
});

test('killed at the marker build and at the marker publication leave states a resume walks out of', () => {
  const built = crashFixture('crash-marker-built');
  const builtDigest = crash(built.root, 'after-quarantine-marker-built', { policy: CRASH_POLICY });
  const claiming = readdirSync(join(built.root, 'backups'))
    .filter((name) => name.startsWith(SAFETY_QUARANTINE_CLAIM_PREFIX));
  assertEq(claiming.length, 1, 'the half-built tree is beside the predictable path, under an unguessable name');
  assertEq(existsSync(join(built.root, 'backups', safetyQuarantineDirName(SUFFIX))), false,
    'and the predictable path does not exist at all');
  assert(existsSync(join(built.root, 'backups', claiming[0]!, SAFETY_QUARANTINE_MARKER_NAME)),
    'the marker was written while the tree was still invisible');
  const builtReport = resume(built.root, builtDigest);
  assert(builtReport.ok, 'a resume publishes a fresh one and finishes');

  const published = crashFixture('crash-marker-published');
  const publishedDigest = crash(published.root, 'after-quarantine-marker-published', { policy: CRASH_POLICY });
  const dir = join(published.root, 'backups', safetyQuarantineDirName(SUFFIX));
  assertEq(JSON.stringify(readdirSync(dir)), JSON.stringify([SAFETY_QUARANTINE_MARKER_NAME]),
    'the published path holds its marker and nothing else');
  assert(resume(published.root, publishedDigest).ok, 'and a resume finishes');
});

test('killed after the deleting mark: the tree is INTACT, and a resume destroys it once', () => {
  const { root, a } = crashFixture('crash-deleting');
  const whole = snapshot(a.dir);
  const digest = crash(root, `after-deleting-mark:${a.name}`, { policy: CRASH_POLICY });
  const quarantined = join(root, 'backups', safetyQuarantineDirName(SUFFIX), a.name);
  assert(sameSnapshot(whole, snapshot(quarantined)), 'the tree is still whole');
  assertEq(journalOf(root).entries[0]!.state, 'deleting', 'and the journal says it was about to be destroyed');
  const report = resume(root, digest);
  assert(report.ok, 'the resume finished');
  assertEq(existsSync(quarantined), false, 'and the tree is gone');
});

test('killed after the removal and before its record: the resume is idempotent', () => {
  const { root, a } = crashFixture('crash-removed');
  const digest = crash(root, `after-remove:${a.name}`, { policy: CRASH_POLICY });
  assertEq(journalOf(root).entries[0]!.state, 'deleting', 'the record did not land');
  assertEq(existsSync(join(root, 'backups', safetyQuarantineDirName(SUFFIX), a.name)), false,
    'and the tree really is gone');
  const report = resume(root, digest);
  assert(report.ok, 'the resume closed it out');
  assert(report.removed.includes(a.name), 'and still reports what the OPERATION removed');
});

test('two resumes of the same interrupted run produce the same answer', () => {
  const { root, a } = crashFixture('crash-deterministic');
  const digest = crash(root, `after-quarantine-mark:${a.name}`, { policy: CRASH_POLICY });
  const first = resume(root, digest);
  assert(first.ok, 'the first resume finished');
  refuses(() => resume(root, digest), 'no interrupted safety-set lifecycle run', 'and a second has nothing to do');
});

test('a RESUME refuses while another command is part way through, and --abandon still works', () => {
  const { root, a } = crashFixture('busy-resume');
  const digest = crash(root, `after-quarantine-mark:${a.name}`, { policy: CRASH_POLICY });
  writeFileSync(join(root, RETENTION_JOURNAL_NAME), '{"whatever":true}\n', 'utf8');
  refuses(() => resume(root, digest), 'part way through a backup prune',
    'a resume deletes, so it refuses while the destination is mid-prune');
  // AND THE RECOVERY IS STILL AVAILABLE. Two commands that each refuse while the other is interrupted is a
  // pair neither can ever be resumed, so --abandon deliberately does not take this refusal.
  const abandon = abandonSafetySetLifecycle(root);
  assertEq(abandon.state, 'ABANDONED', 'the abandon put everything back');
  assert(existsSync(a.dir), 'and the claim is under its own name again');
  rmSync(join(root, RETENTION_JOURNAL_NAME));
});

// -----------------------------------------------------------------------------------------------------------
// The floor, proved again from live disk before the first irreversible act
// -----------------------------------------------------------------------------------------------------------

test('a resume whose destination lost its restorable sets HALTS BEFORE DELETING, and abandon puts it back', () => {
  const { root, a, keeper } = crashFixture('floor-1');
  const whole = snapshot(a.dir);
  const digest = crash(root, `after-quarantine-mark:${a.name}`, { policy: CRASH_POLICY });
  // A prune ran in between and took the ordinary set; the keeper claim is the last restorable thing, and the
  // claim already set aside would have been the second. Removing it now breaches the floor.
  rmSync(join(root, 'backups', 'set-a'), { recursive: true });
  rmSync(keeper.dir, { recursive: true });
  const live = proveFloorFromDisk(join(root, 'backups'));
  assertEq(live.topLevel + live.claims, 0, 'nothing in the destination could restore this installation now');

  const report = resume(root, digest);
  assertEq(report.ok, false, 'the run did not succeed');
  assert(report.haltedBeforeDeleting !== null, 'it halted on the live recount');
  assertEq(report.restorableProvenBeforeDeleting, 0, 'and says what it counted');
  assertEq(report.removed.length, 0, 'NOTHING was deleted');
  const quarantined = join(root, 'backups', safetyQuarantineDirName(SUFFIX), a.name);
  assert(sameSnapshot(whole, snapshot(quarantined)), 'the claim it set aside is whole');

  const abandon = abandonSafetySetLifecycle(root);
  assertEq(abandon.state, 'ABANDONED', 'and a clean unwind puts it back');
  assert(sameSnapshot(whole, snapshot(a.dir)), 'byte for byte, under its own name');
});

// -----------------------------------------------------------------------------------------------------------
// Correction 1 — live ownership of the child being consumed
// -----------------------------------------------------------------------------------------------------------

/** Where the tree being consumed lives once a run has set it aside. */
function quarantinedClaim(root: string, name: string): string {
  return join(root, 'backups', safetyQuarantineDirName(SUFFIX), name);
}

test('THE DEFECT: a child REPLACED after `deleting` was persisted is refused, not recursively deleted', () => {
  const { root, a, keeper } = crashFixture('replace-deleting');
  const digest = crash(root, `after-deleting-mark:${a.name}`, { policy: CRASH_POLICY });
  const quarantined = quarantinedClaim(root, a.name);
  // THE EXACT WINDOW. The journal says `deleting`; nothing has been unlinked yet, so there is no consumption
  // marker. The first cut proved only the OUTER quarantine marker here — whose allowlist is a list of NAMES —
  // and then recursively removed whatever directory occupied this one.
  assertEq(journalOf(root).entries[0]!.state, 'deleting', 'the state is persisted');
  assertEq(consumingMarkerPresent(quarantined), false, 'and nothing has been unlinked, so there is no marker');

  rmSync(quarantined, { recursive: true });
  mkdirSync(quarantined, { recursive: true });
  writeFileSync(join(quarantined, 'their-photos.txt'), 'irreplaceable\n', 'utf8');
  mkdirSync(join(quarantined, 'a-folder'), { recursive: true });
  writeFileSync(join(quarantined, 'a-folder', 'more.txt'), 'also irreplaceable\n', 'utf8');
  const before = snapshot(quarantined);

  const report = resume(root, digest);
  assertEq(report.ok, false, 'the run did not succeed');
  assert(report.failed.some((failure) => failure.name === a.name), 'it stopped on the replaced claim');
  assert(sameSnapshot(before, snapshot(quarantined)), 'THE STRANGER TREE IS BYTE-IDENTICAL');
  assertEq(report.removed.length, 0, 'nothing was removed at all');
  assert(existsSync(keeper.dir), 'and the protected claim is exactly where it was');
});

test('a LEGITIMATE tree at the same moment still resumes, and its authority is written before the first unlink', () => {
  const { root, a } = crashFixture('legit-deleting');
  const digest = crash(root, `after-deleting-mark:${a.name}`, { policy: CRASH_POLICY });
  const quarantined = quarantinedClaim(root, a.name);
  assertEq(consumingMarkerPresent(quarantined), false, 'no marker yet');
  const report = resume(root, digest);
  assert(report.ok, `the resume finished: ${JSON.stringify(report.failed)}`);
  assertEq(existsSync(quarantined), false, 'and the tree is gone');
});

test('killed AFTER the consumption marker: the tree is intact, marked, and a resume finishes it', () => {
  const { root, a } = crashFixture('after-consuming');
  const whole = snapshot(a.dir);
  const digest = crash(root, `after-consuming-marker:${a.name}`, { policy: CRASH_POLICY });
  const quarantined = quarantinedClaim(root, a.name);
  assert(consumingMarkerPresent(quarantined), 'the authority for the first unlink is in place');
  const marker = JSON.parse(readFileSync(join(quarantined, SAFETY_CONSUMING_MARKER_NAME), 'utf8')) as
    { consumeNonce: string; claim: string };
  assertEq(marker.claim, a.name, 'it names this claim');
  assertEq(marker.consumeNonce, journalOf(root).entries[0]!.consumeNonce, 'and the nonce the journal recorded');
  // The tree is otherwise untouched — the marker is written before anything is removed, not during. The
  // safety set is still byte-identical to the one that was quarantined.
  const members = readdirSync(quarantined).slice().sort()
    .filter((name) => name !== SAFETY_CONSUMING_MARKER_NAME);
  assertEq(JSON.stringify(members), JSON.stringify([SAFETY_CLAIM_MARKER_NAME, a.setName].sort()),
    'the claim still holds exactly its marker and its safety set');
  const setBefore = new Map([...whole].filter(([key]) => key.startsWith(`${a.setName!}/`)));
  const setAfter = new Map([...snapshot(quarantined)].filter(([key]) => key.startsWith(`${a.setName!}/`)));
  assert(sameSnapshot(setBefore, setAfter), 'and the safety set inside it is byte-identical');
  assert(resume(root, digest).ok, 'a resume finishes it');
  assertEq(existsSync(quarantined), false, 'and the tree is gone');
});

test('a PARTIALLY consumed tree keeps its authority, and a replacement of it is still refused', () => {
  const { root, a } = crashFixture('partial-then-replaced');
  const digest = crash(root, `after-deleting-mark:${a.name}`, { policy: CRASH_POLICY });
  const quarantined = quarantinedClaim(root, a.name);
  // A REAL PARTIAL REMOVAL: one component is unlinked and the removal then fails.
  const partial = resume(root, digest, {
    remover: (path: string) => {
      rmSync(join(path, COMPONENT_ARTIFACT_NAMES.database));
      throw new MaintenanceRefused('the safety set could not be removed in full');
    },
  });
  assertEq(partial.ok, false, 'the removal did not complete');
  assert(consumingMarkerPresent(quarantined), 'the authority SURVIVED the partial removal — it goes last');
  assertEq(journalOf(root).entries[0]!.state, 'deleting', 'and the journal still authorises finishing it');

  // NOW REPLACE THE PARTIAL TREE. A stranger's directory carries no consumption marker, so the run falls to
  // the "nothing has been unlinked" branch and has to prove it is the planned claim, which it is not.
  rmSync(quarantined, { recursive: true });
  mkdirSync(quarantined, { recursive: true });
  writeFileSync(join(quarantined, 'theirs.txt'), 'not ours\n', 'utf8');
  const before = snapshot(quarantined);
  const refused = resume(root, digest);
  assertEq(refused.ok, false, 'the replacement is refused');
  assertEq(refused.removed.length, 0, 'nothing was removed');
  assert(sameSnapshot(before, snapshot(quarantined)), 'and it is byte-identical');
});

test('a legitimate partial removal still finishes on a later resume', () => {
  const { root, a } = crashFixture('partial-finishes');
  const digest = crash(root, `after-deleting-mark:${a.name}`, { policy: CRASH_POLICY });
  const quarantined = quarantinedClaim(root, a.name);
  const partial = resume(root, digest, {
    remover: (path: string) => {
      rmSync(join(path, COMPONENT_ARTIFACT_NAMES.database));
      throw new MaintenanceRefused('the safety set could not be removed in full');
    },
  });
  assertEq(partial.ok, false, 'the first attempt did not complete');
  assert(partial.retained !== null && partial.retained.holds.includes(a.name), 'and the report names the tree');
  const second = resume(root, digest);
  assert(second.ok, `the second resume finishes it: ${JSON.stringify(second.failed)}`);
  assert(second.removed.includes(a.name), 'and reports what the OPERATION removed');
  assertEq(existsSync(quarantined), false, 'the tree is gone');
  assertEq(existsSync(join(root, 'backups', safetyQuarantineDirName(SUFFIX))), false,
    'and the quarantine directory was cleaned up');
});

test('the TAIL of a consumption — emptied, marker gone, rmdir failed — resumes rather than stranding', () => {
  // The consumption marker is unlinked immediately before the directory itself, so a removal that got
  // everything out and then could not `rmdir` leaves an EMPTY directory with no authority in it. Requiring
  // the marker there would strand the operation: nothing can prove an empty directory is the planned claim,
  // and an abandon will not put an empty tree back under a trusted name either.
  const { root, a } = crashFixture('consumption-tail');
  const digest = crash(root, `after-consuming-marker:${a.name}`, { policy: CRASH_POLICY });
  const quarantined = quarantinedClaim(root, a.name);
  rmSync(quarantined, { recursive: true });
  mkdirSync(quarantined, { recursive: true });
  assertEq(consumingMarkerPresent(quarantined), false, 'the authority is gone with everything else');
  assertEq(readdirSync(quarantined).length, 0, 'and the directory is empty');
  const report = resume(root, digest);
  assert(report.ok, `the resume finishes it: ${JSON.stringify(report.failed)}`);
  assert(report.removed.includes(a.name), 'and reports the claim as removed');
  assertEq(existsSync(quarantined), false, 'the empty directory is gone');
  // AND AN EMPTY DIRECTORY IS THE ONLY THING THAT PASSES THAT BRANCH: one stray byte in it and the tree has
  // to prove it is the planned claim again.
  const strict = crashFixture('consumption-tail-strict');
  const strictDigest = crash(strict.root, `after-consuming-marker:${strict.a.name}`, { policy: CRASH_POLICY });
  const strictDir = quarantinedClaim(strict.root, strict.a.name);
  rmSync(strictDir, { recursive: true });
  mkdirSync(strictDir, { recursive: true });
  writeFileSync(join(strictDir, 'theirs.txt'), 'not empty\n', 'utf8');
  const before = snapshot(strictDir);
  const refused = resume(strict.root, strictDigest);
  assertEq(refused.ok, false, 'a non-empty replacement is still refused');
  assert(sameSnapshot(before, snapshot(strictDir)), 'and is byte-identical');
});

test('a consumption marker for another consumption, or an edited one, authorises nothing', () => {
  const cases: Array<[string, (path: string) => void]> = [
    ['a different consumption nonce', (path) => {
      const marker = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      writeFileSync(path, `${JSON.stringify({ ...marker, consumeNonce: MATRIX_CONSUME_NONCE }, null, 2)}\n`, 'utf8');
    }],
    ['a different claim', (path) => {
      const marker = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      writeFileSync(path, `${JSON.stringify({ ...marker, claim: safetySetClaimDirName('e'.repeat(24)) }, null, 2)}\n`, 'utf8');
    }],
    ['an edited commitment', (path) => {
      const marker = JSON.parse(readFileSync(path, 'utf8')) as { commitment: Record<string, unknown> };
      marker.commitment = { ...marker.commitment, bytes: 1 };
      writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    }],
    ['a marker that is not readable', (path) => { writeFileSync(path, '{ broken', 'utf8'); }],
    ['a marker that is not a record', (path) => { writeFileSync(path, '42', 'utf8'); }],
  ];
  for (const [label, mutate] of cases) {
    const { root, a } = crashFixture(`consuming-${label.replace(/[^a-z]/g, '')}`);
    const digest = crash(root, `after-consuming-marker:${a.name}`, { policy: CRASH_POLICY });
    const quarantined = quarantinedClaim(root, a.name);
    mutate(join(quarantined, SAFETY_CONSUMING_MARKER_NAME));
    const before = snapshot(quarantined);
    const report = resume(root, digest);
    assertEq(report.ok, false, `${label}: the run did not succeed`);
    assertEq(report.removed.length, 0, `${label}: and removed nothing`);
    assert(sameSnapshot(before, snapshot(quarantined)), `${label}: the tree is byte-identical`);
  }
});

test('a consumption never removes anything that was not committed to, and never in place', () => {
  const { root, a } = crashFixture('consuming-shape');
  const digest = crash(root, `after-consuming-marker:${a.name}`, { policy: CRASH_POLICY });
  const quarantined = quarantinedClaim(root, a.name);
  // A MEMBER THIS OPERATION DID NOT COMMIT TO. The bound from the manifest is about SIZE; this is about
  // SHAPE, and a tree that grew a member is not the tree that was proved.
  mkdirSync(join(quarantined, 'appeared'), { recursive: true });
  writeFileSync(join(quarantined, 'appeared', 'theirs.txt'), 'not ours\n', 'utf8');
  const before = snapshot(quarantined);
  const report = resume(root, digest);
  assertEq(report.ok, false, 'the run did not succeed');
  assert(sameSnapshot(before, snapshot(quarantined)), 'and nothing inside it was removed');
  // AND NOTHING WAS EVER DELETED IN PLACE: the destination still holds only claims and ordinary sets.
  assert(!existsSync(a.dir), 'the claim is set aside, not at its own name');
  assert(digest.length === 64, 'the digest was real');
});

// -----------------------------------------------------------------------------------------------------------
// Phase 316 — journal authority: forgeries with recomputed digests
// -----------------------------------------------------------------------------------------------------------

/** Rewrite the journal exactly as given, RECOMPUTING the plan digest over the edited content. */
function forgeJournal(root: string, mutate: (journal: SafetySetJournal) => SafetySetJournal): void {
  const edited = mutate(journalOf(root));
  const resolved = resolveSafetySetDestination(root, edited.destination);
  const planDigest = digestSafetySetOperation(canonicalSafetySetOperation(
    resolved, edited.policy, edited.claims, edited.destinationSets, edited.decisions, edited.removals,
    edited.protectedNewestRestorable, edited.protectedNewestRollbackPoint, edited.restorableRemaining,
    edited.restorableTopLevel));
  writeFileSync(join(root, SAFETY_SET_JOURNAL_NAME),
    `${JSON.stringify({ ...edited, planDigest }, null, 2)}\n`, 'utf8');
}

/**
 * Insert a fabricated claim row and let the REAL evaluator recompute everything around it.
 *
 * This is the forgery that a document-level check can never catch, because the document is not merely
 * self-consistent — it is exactly what this program would have written if the inventory had really said that.
 */
function forgeWithFabricatedClaim(root: string, row: ClaimInventoryEntry): void {
  forgeJournal(root, (journal) => {
    const claims = sortedRows([...journal.claims, row]);
    const evaluation = evaluateSafetySetLifecycle(claims, journal.destinationSets, journal.policy,
      new Date(journal.evaluatedAt));
    return {
      ...journal,
      claims,
      decisions: evaluation.decisions,
      removals: evaluation.removals,
      protectedNewestRestorable: evaluation.protectedNewestRestorable,
      protectedNewestRollbackPoint: evaluation.protectedNewestRollbackPoint,
      restorableRemaining: evaluation.restorableRemaining,
      restorableTopLevel: evaluation.restorableTopLevel,
      entries: evaluation.removals.map((name) => {
        const existing = journal.entries.find((entry) => entry.name === name);
        return existing ?? { name, state: 'pending' as const, reason: null, consumeNonce: null };
      }),
    };
  });
}

test('a forged journal that moves the PROTECTED claim into the removal list is refused by the evaluator', () => {
  const { root, keeper } = crashFixture('forge-1');
  crash(root, 'after-journal', { policy: CRASH_POLICY });
  forgeJournal(root, (journal) => ({
    ...journal,
    decisions: journal.decisions.map((decision) => (decision.name === keeper.name
      ? { ...decision, decision: 'remove' as const, reason: 'BEYOND_KEEP_WINDOW' as const } : decision)),
    removals: [...journal.removals, keeper.name],
    entries: [...journal.entries,
      { name: keeper.name, state: 'pending' as const, reason: null, consumeNonce: null }],
    restorableRemaining: 1,
  }));
  refuses(() => readSafetySetJournal(root), 'not the ones this build makes', 'the forgery');
  assert(existsSync(keeper.dir), 'and the protected claim is exactly where it was');
});

test('a forged journal naming a class no policy admits dies at the class gate', () => {
  for (const claimClass of ['MALFORMED', 'OTHER_BUILD', 'OWNED_IN_FLIGHT', 'OWNED_UNEXPECTED'] as const) {
    const { root } = crashFixture(`forge-class-${claimClass}`);
    crash(root, 'after-journal', { policy: CRASH_POLICY });
    forgeJournal(root, (journal) => {
      const victim = journal.removals[0]!;
      return {
        ...journal,
        claims: journal.claims.map((claim) => (claim.name === victim
          ? {
            ...claim,
            claimClass,
            evidence: claimClass === 'MALFORMED' ? 'NO_MARKER' as const
              : claimClass === 'OTHER_BUILD' ? 'MARKER_OTHER_SCHEMA' as const
                : claimClass === 'OWNED_IN_FLIGHT' ? 'IN_FLIGHT_ARTIFACT' as const : 'UNEXPECTED_MEMBERS' as const,
            // ONLY A CLAIM THAT HOLDS A SET MAY CARRY A SET DIGEST, so a forgery has to drop it too — which
            // is what makes this test reach the CLASS GATE rather than dying on a row-shape rule first.
            restorable: false, setDigest: '',
            ...(claimClass === 'MALFORMED' || claimClass === 'OTHER_BUILD'
              ? { nonce: null, claimDigest: '' } : {}),
          }
          : claim)),
      };
    });
    refuses(() => readSafetySetJournal(root), 'is not a restore claim this build created',
      `${claimClass} in the removal list`);
  }
});

test('an unverified or empty claim in the removal list is refused under a policy that did not admit one', () => {
  for (const [claimClass, needle] of [
    ['OWNED_UNVERIFIED', 'does not verify'],
    ['OWNED_EMPTY', 'names an empty claim'],
  ] as const) {
    const { root } = crashFixture(`forge-admit-${claimClass}`);
    crash(root, 'after-journal', { policy: CRASH_POLICY });
    forgeJournal(root, (journal) => {
      const victim = journal.removals[0]!;
      return {
        ...journal,
        claims: journal.claims.map((claim) => (claim.name === victim
          ? {
            ...claim, claimClass, restorable: false,
            evidence: claimClass === 'OWNED_EMPTY' ? 'EMPTY' as const : 'SET_DOES_NOT_VERIFY' as const,
            ...(claimClass === 'OWNED_EMPTY' ? { setName: null, setDigest: '' } : {}),
          }
          : claim)),
      };
    });
    refuses(() => readSafetySetJournal(root), needle, `${claimClass} under a policy that did not admit one`);
  }
});

test('A SELF-CONSISTENT FORGERY pointing at a stranger\'s directory passes every document check and dies on disk', () => {
  const { root, a } = crashFixture('forge-ondisk');
  const digest = crash(root, 'after-journal', { policy: CRASH_POLICY });
  const strangerNonce = '0'.repeat(24);
  const strangerName = safetySetClaimDirName(strangerNonce);
  const stranger = join(root, 'backups', strangerName);
  mkdirSync(stranger, { recursive: true });
  writeFileSync(join(stranger, 'their-photos.txt'), 'irreplaceable\n', 'utf8');
  const before = snapshot(stranger);

  // The fabricated row is the OLDEST, so it heads the removal list and is the first thing acted on. It is
  // `restorable` because a row that is not is the newest ROLLBACK POINT, which the evaluator protects — and
  // a forgery the evaluator protects is not the forgery this test is about.
  forgeWithFabricatedClaim(root, claimRow('stranger', {
    name: strangerName,
    nonce: strangerNonce,
    takenAt: new Date(NOW.getTime() - 900 * DAY).toISOString(),
    takenAtMs: NOW.getTime() - 900 * DAY,
    observedAtMs: NOW.getTime() - 900 * DAY,
  }));
  const forged = readSafetySetJournal(root);
  assert(forged !== null, 'the document passes EVERY document-level check, including the evaluator');
  assertEq(forged!.removals[0], strangerName, 'and it points the operation at a stranger\'s directory');

  const report = resume(root, forged!.planDigest);
  assertEq(report.ok, false, 'the run did not succeed');
  assert(report.failed.some((failure) => failure.name === strangerName), 'it stopped on the fabricated claim');
  assert(sameSnapshot(before, snapshot(stranger)), 'the stranger\'s directory is byte-identical');
  assert(existsSync(a.dir), 'and NOTHING AFTER IT WAS TOUCHED');
  assertEq(report.removed.length, 0, 'nothing was removed at all');
  assert(digest !== forged!.planDigest, 'the forgery had to recompute the digest, and it did');
});

test('a VERSION 1 journal is refused for being one, because it can carry no consumption record', () => {
  // The correction that added `consumeNonce` could not be a compatible addition: a version-1 `deleting`
  // entry describes a consumption whose live child can never be identified, and there is nothing correct to
  // fill the field in with. An old document is refused AT THE BOUNDARY rather than upgraded.
  const { root } = crashFixture('version-one');
  crash(root, 'after-journal', { policy: CRASH_POLICY });
  const raw = JSON.parse(readFileSync(join(root, SAFETY_SET_JOURNAL_NAME), 'utf8')) as Record<string, unknown>;
  assertEq(raw.version, SAFETY_SET_JOURNAL_VERSION, 'this build writes the current version');
  assertEq(SAFETY_SET_JOURNAL_VERSION, 2, 'which is 2');
  writeFileSync(join(root, SAFETY_SET_JOURNAL_NAME),
    `${JSON.stringify({ ...raw, version: 1 }, null, 2)}\n`, 'utf8');
  refuses(() => readSafetySetJournal(root), 'its version is 1 and this build writes 2', 'a version-1 journal');
});

test('a `deleting` entry without a consumption nonce, or a nonce on any other state, is refused', () => {
  const { root, a } = crashFixture('nonce-shape');
  crash(root, `after-deleting-mark:${a.name}`, { policy: CRASH_POLICY });
  const original = readFileSync(join(root, SAFETY_SET_JOURNAL_NAME), 'utf8');
  const withEntries = (mutate: (entry: Record<string, unknown>) => Record<string, unknown>): void => {
    const journal = JSON.parse(original) as Record<string, unknown>;
    const entries = (journal.entries as Array<Record<string, unknown>>).map((entry) => mutate(entry));
    writeFileSync(join(root, SAFETY_SET_JOURNAL_NAME),
      `${JSON.stringify({ ...journal, entries }, null, 2)}\n`, 'utf8');
  };
  assert((JSON.parse(original) as SafetySetJournal).entries[0]!.consumeNonce !== null,
    'the real transition drew and persisted one');
  withEntries((entry) => (entry.state === 'deleting' ? { ...entry, consumeNonce: null } : entry));
  refuses(() => readSafetySetJournal(root), 'carries no consumption nonce', 'a deleting entry with no nonce');
  withEntries((entry) => (entry.state === 'deleting' ? { ...entry, consumeNonce: 'not-hex' } : entry));
  refuses(() => readSafetySetJournal(root), 'carries no consumption nonce', 'a nonce that is not one');
  withEntries((entry) => ({ ...entry, state: 'pending', reason: null, consumeNonce: MATRIX_CONSUME_NONCE }));
  refuses(() => readSafetySetJournal(root), 'is not being removed carries a consumption nonce',
    'a nonce on a state that never has one');
  writeFileSync(join(root, SAFETY_SET_JOURNAL_NAME), original, 'utf8');
  assert(readSafetySetJournal(root) !== null, 'and the untouched journal still reads');
});

test('a journal at any other version is refused AT THE VERSION BOUNDARY', () => {
  for (const version of [0, 3, '2', null]) {
    const { root } = crashFixture(`version-${String(version)}`);
    crash(root, 'after-journal', { policy: CRASH_POLICY });
    const raw = JSON.parse(readFileSync(join(root, SAFETY_SET_JOURNAL_NAME), 'utf8')) as Record<string, unknown>;
    // EVERY LATER FIELD IS REMOVED TOO. A version boundary that only fires when the rest of the document is
    // well formed is not a boundary.
    writeFileSync(join(root, SAFETY_SET_JOURNAL_NAME),
      `${JSON.stringify({ journal: raw.journal, version }, null, 2)}\n`, 'utf8');
    refuses(() => readSafetySetJournal(root), 'this build writes', `version ${String(version)}`);
  }
});

test('sixteen malformed journal members are closed refusals, never runtime exceptions', () => {
  const mutations: Array<[string, (journal: Record<string, unknown>) => unknown]> = [
    ['a null claim row', (j) => ({ ...j, claims: [null] })],
    ['a scalar claim row', (j) => ({ ...j, claims: [7] })],
    ['claims that are not a list', (j) => ({ ...j, claims: 'all of them' })],
    ['a null destination row', (j) => ({ ...j, destinationSets: [null] })],
    ['destination sets that are not a list', (j) => ({ ...j, destinationSets: {} })],
    ['a null decision', (j) => ({ ...j, decisions: [null] })],
    ['decisions that are not a list', (j) => ({ ...j, decisions: 3 })],
    ['a removal that is not a name', (j) => ({ ...j, removals: [42] })],
    ['a removal list that is not a list', (j) => ({ ...j, removals: 'one' })],
    ['a per-claim state that is not a record', (j) => ({ ...j, entries: ['pending'] })],
    ['a state this command does not write', (j) => ({
      ...j, entries: (j.entries as Array<Record<string, unknown>>).map((e) => ({ ...e, state: 'exploding' })) })],
    ['a failed claim with no reason', (j) => ({
      ...j, entries: (j.entries as Array<Record<string, unknown>>).map((e) => ({ ...e, state: 'failed' })) })],
    ['a policy that is not a record', (j) => ({ ...j, policy: 'keep everything' })],
    ['a policy this command does not accept', (j) => ({ ...j, policy: { ...(j.policy as object), keepLast: 0 } })],
    ['an evaluation instant that is not one', (j) => ({ ...j, evaluatedAt: 'yesterday' })],
    ['a suffix this command does not produce', (j) => ({ ...j, suffix: 'nope' })],
    ['a destination outside the project', (j) => ({ ...j, destination: '../elsewhere' })],
    ['a plan digest that is not one', (j) => ({ ...j, planDigest: 'nope' })],
    ['a phase this command does not write', (j) => ({ ...j, phase: 'thinking' })],
    ['a protected claim that is not a claim name', (j) => ({ ...j, protectedNewestRestorable: 'set-a' })],
    ['a count that is not a count', (j) => ({ ...j, restorableRemaining: -1 })],
  ];
  const { root } = crashFixture('malformed');
  crash(root, 'after-journal', { policy: CRASH_POLICY });
  const original = readFileSync(join(root, SAFETY_SET_JOURNAL_NAME), 'utf8');
  for (const [label, mutate] of mutations) {
    const journal = JSON.parse(original) as Record<string, unknown>;
    writeFileSync(join(root, SAFETY_SET_JOURNAL_NAME), `${JSON.stringify(mutate(journal), null, 2)}\n`, 'utf8');
    try {
      readSafetySetJournal(root);
      throw new Error(`${label}: nothing was refused`);
    } catch (err) {
      assert(err instanceof MaintenanceRefused,
        `${label}: expected a closed refusal, got ${(err as Error).name}: ${(err as Error).message}`);
    }
  }
  writeFileSync(join(root, SAFETY_SET_JOURNAL_NAME), original, 'utf8');
  assert(readSafetySetJournal(root) !== null, 'and the untouched journal still reads');
});

test('a claim row whose nonce does not name it, or which claims proof it does not have, is refused', () => {
  const { root } = crashFixture('row-consistency');
  crash(root, 'after-journal', { policy: CRASH_POLICY });
  const original = readFileSync(join(root, SAFETY_SET_JOURNAL_NAME), 'utf8');
  const cases: Array<[string, (claim: Record<string, unknown>) => Record<string, unknown>]> = [
    ['a nonce that names a different directory', (claim) => ({ ...claim, nonce: '9'.repeat(24) })],
    ['no nonce at all on a proved class', (claim) => ({ ...claim, nonce: null })],
    ['no marker digest on a proved class', (claim) => ({ ...claim, claimDigest: '' })],
    ['a date and a moment that disagree', (claim) => ({ ...claim, takenAtMs: 1 })],
    ['findings this build does not write', (claim) => ({ ...claim, findings: [{ nope: true }] })],
    ['a set digest that is not one', (claim) => ({ ...claim, setDigest: 'xyz' })],
    ['an unusable safety set name', (claim) => ({ ...claim, setName: '../escape' })],
  ];
  for (const [label, mutate] of cases) {
    const journal = JSON.parse(original) as Record<string, unknown>;
    const claims = (journal.claims as Array<Record<string, unknown>>).map((claim, index) =>
      (index === 0 ? mutate(claim) : claim));
    writeFileSync(join(root, SAFETY_SET_JOURNAL_NAME),
      `${JSON.stringify({ ...journal, claims }, null, 2)}\n`, 'utf8');
    try {
      readSafetySetJournal(root);
      throw new Error(`${label}: nothing was refused`);
    } catch (err) {
      assert(err instanceof MaintenanceRefused, `${label}: ${(err as Error).name}`);
    }
  }
  writeFileSync(join(root, SAFETY_SET_JOURNAL_NAME), original, 'utf8');
});

// -----------------------------------------------------------------------------------------------------------
// Quarantine ownership
// -----------------------------------------------------------------------------------------------------------

test('a quarantine directory that cannot prove it is ours is never written into or removed from', () => {
  const cases: Array<[string, (dir: string) => void]> = [
    ['an ordinary directory at the predictable path', (dir) => {
      rmSync(join(dir, SAFETY_QUARANTINE_MARKER_NAME));
    }],
    ['a marker that describes another operation', (dir) => {
      const path = join(dir, SAFETY_QUARANTINE_MARKER_NAME);
      const marker = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      writeFileSync(path, `${JSON.stringify({ ...marker, suffix: 'ffffffffffff' }, null, 2)}\n`, 'utf8');
    }],
    ['a marker whose commitments were edited', (dir) => {
      const path = join(dir, SAFETY_QUARANTINE_MARKER_NAME);
      const marker = JSON.parse(readFileSync(path, 'utf8')) as { commitments: Record<string, unknown>[] };
      marker.commitments = marker.commitments.map((commitment) => ({ ...commitment, bytes: 1 }));
      writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    }],
    ['a marker that is not readable', (dir) => {
      writeFileSync(join(dir, SAFETY_QUARANTINE_MARKER_NAME), '{ broken', 'utf8');
    }],
  ];
  for (const [label, mutate] of cases) {
    const { root, a } = crashFixture(`quar-${label.replace(/[^a-z]/g, '')}`);
    const digest = crash(root, `after-quarantine-rename:${a.name}`, { policy: CRASH_POLICY });
    const dir = join(root, 'backups', safetyQuarantineDirName(SUFFIX));
    mutate(dir);
    const before = snapshot(dir);
    const report = resume(root, digest);
    assertEq(report.ok, false, `${label}: the run did not succeed`);
    assertEq(report.removed.length, 0, `${label}: and removed nothing`);
    assert(sameSnapshot(before, snapshot(dir)), `${label}: the directory is byte-identical`);
  }
});

test('a directory squatting the quarantine path before the first rename stops the run', () => {
  const { root, a } = crashFixture('quar-squat');
  const digest = crash(root, 'after-journal', { policy: CRASH_POLICY });
  const dir = join(root, 'backups', safetyQuarantineDirName(SUFFIX));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'theirs.txt'), 'not ours\n', 'utf8');
  const before = snapshot(dir);
  const report = resume(root, digest);
  assertEq(report.ok, false, 'the run did not succeed');
  assert(sameSnapshot(before, snapshot(dir)), 'the squatter is byte-identical');
  assert(existsSync(a.dir), 'and the claim was never moved');
});

test('a link at the quarantine path is refused rather than followed', () => {
  const { root, a } = crashFixture('quar-link');
  const digest = crash(root, 'after-journal', { policy: CRASH_POLICY });
  const target = makeProject('quar-link-target');
  if (!linkDirectory(target, join(root, 'backups', safetyQuarantineDirName(SUFFIX)))) return;
  const report = resume(root, digest);
  assertEq(report.ok, false, 'the run did not succeed');
  assert(existsSync(join(target, 'secrets')), 'and what the link pointed at is untouched');
  assert(existsSync(a.dir), 'the claim was never moved');
});

test('a quarantined claim replaced, mutated or stripped of its marker is refused, not deleted', () => {
  const cases: Array<[string, (claimDir: string, root: string) => void]> = [
    ['its safety set mutated', (claimDir) => {
      const setName = readdirSync(claimDir).find((name) => name !== SAFETY_CLAIM_MARKER_NAME)!;
      tamper(join(claimDir, setName));
    }],
    ['its ownership marker removed', (claimDir) => { rmSync(join(claimDir, SAFETY_CLAIM_MARKER_NAME)); }],
    ['its ownership marker rewritten for another restore', (claimDir) => {
      patchClaimMarker(claimDir, (marker) => ({
        ...marker,
        planDigest: createHash('sha256').update('another').digest('hex'),
        suffix: operationSuffix(createHash('sha256').update('another').digest('hex')),
      }));
    }],
    ['its safety set swapped for a different set of ours', (claimDir, root) => {
      const setName = readdirSync(claimDir).find((name) => name !== SAFETY_CLAIM_MARKER_NAME)!;
      rmSync(join(claimDir, setName), { recursive: true });
      cpSync(join(root, 'backups', 'set-a'), join(claimDir, setName), { recursive: true });
    }],
    ['an extra member appearing inside it', (claimDir) => {
      writeFileSync(join(claimDir, 'extra.txt'), 'appeared\n', 'utf8');
    }],
  ];
  for (const [label, mutate] of cases) {
    const { root, a } = crashFixture(`swap-${label.replace(/[^a-z]/g, '')}`);
    const digest = crash(root, `after-quarantine-mark:${a.name}`, { policy: CRASH_POLICY });
    const quarantined = join(root, 'backups', safetyQuarantineDirName(SUFFIX), a.name);
    mutate(quarantined, root);
    const before = snapshot(quarantined);
    const report = resume(root, digest);
    assertEq(report.ok, false, `${label}: the run did not succeed`);
    assertEq(report.removed.length, 0, `${label}: and nothing was destroyed`);
    assert(sameSnapshot(before, snapshot(quarantined)), `${label}: the tree is byte-identical`);
  }
});

test('the outer claim replaced by a stranger between the plan and the rename is refused', () => {
  const { root, a } = crashFixture('swap-outer');
  const digest = crash(root, 'after-journal', { policy: CRASH_POLICY });
  rmSync(a.dir, { recursive: true });
  mkdirSync(a.dir, { recursive: true });
  writeFileSync(join(a.dir, 'theirs.txt'), 'somebody else entirely\n', 'utf8');
  const before = snapshot(a.dir);
  const report = resume(root, digest);
  assertEq(report.ok, false, 'the run did not succeed');
  assert(sameSnapshot(before, snapshot(a.dir)), 'and the replacement was never even renamed aside');
});

// -----------------------------------------------------------------------------------------------------------
// The precondition table, enumerated and DRIVEN
// -----------------------------------------------------------------------------------------------------------

test('the precondition table is total over all twenty combinations, and eight of them are legal', () => {
  let legal = 0;
  for (const state of SAFETY_ENTRY_STATES) {
    for (const inDestination of [true, false]) {
      for (const inQuarantine of [true, false]) {
        const answer = safetyPreconditionRefusal(state, inDestination, inQuarantine);
        assert(answer === null || (typeof answer === 'string' && answer.length > 20),
          `${state}/${inDestination}/${inQuarantine} has a real answer`);
        if (answer === null) legal += 1;
        if (inDestination && inQuarantine) {
          assert(answer !== null, `${state}: both places is never legal`);
        }
      }
    }
  }
  assertEq(legal, 8, 'eight of the twenty are states a run of this program can be in');
});

test('the executor agrees with the table on every combination, and an illegal one destroys nothing after it', () => {
  for (const state of SAFETY_ENTRY_STATES) {
    for (const inDestination of [true, false]) {
      for (const inQuarantine of [true, false]) {
        const label = `${state}/dest=${inDestination}/quar=${inQuarantine}`;
        const root = makeProject(`matrix-${state}-${inDestination}-${inQuarantine}`);
        takeTopSet(root, 'set-a', { daysAgo: 100 });
        const subject = makeClaim(root, 'aaa', { daysAgo: 400 });
        const witness = makeClaim(root, 'bbb', { daysAgo: 300 });
        makeClaim(root, 'keeper', { daysAgo: 10 });
        // Crash once the SUBJECT is quarantined and recorded, so a real, marked quarantine directory exists.
        const digest = crash(root, `after-quarantine-mark:${subject.name}`, { policy: CRASH_POLICY });
        const quarantineDir = join(root, 'backups', safetyQuarantineDirName(SUFFIX));
        const inQuarantinePath = join(quarantineDir, subject.name);
        const stash = join(root, 'stash');

        // ARRANGE THE FILESYSTEM. The claim is at exactly the places the combination says.
        rmSync(stash, { recursive: true, force: true });
        renameSync(inQuarantinePath, stash);
        if (inQuarantine) cpSync(stash, inQuarantinePath, { recursive: true });
        if (inDestination) cpSync(stash, subject.dir, { recursive: true });

        // ARRANGE THE JOURNAL. Per-entry states are not part of the plan digest, so this is an edit an
        // operator's own text editor could make, and it is exactly the tampering the table has to answer.
        const journal = journalOf(root);
        const entries = journal.entries.map((entry) => (entry.name === subject.name
          ? {
            name: entry.name,
            state,
            reason: state === 'failed' ? 'a previous run said so' : null,
            // A `deleting` ENTRY WITHOUT A CONSUMPTION NONCE IS NOT A STATE THIS COMMAND WRITES, and the
            // journal reader refuses it before the executor sees it — so the matrix arranges the nonce the
            // real transition would have drawn, and the consumption marker beside it where one is needed.
            consumeNonce: state === 'deleting' ? MATRIX_CONSUME_NONCE : null,
          }
          : entry));
        writeFileSync(join(root, SAFETY_SET_JOURNAL_NAME),
          `${JSON.stringify({ ...journal, entries }, null, 2)}\n`, 'utf8');

        const expected = safetyPreconditionRefusal(state as SafetyEntryState, inDestination, inQuarantine);
        const report = resume(root, digest);
        if (expected === null) {
          assertEq(report.failed.length, 0, `${label}: the table says legal, so nothing stops`);
          assert(report.removed.includes(witness.name), `${label}: and the WITNESS was processed`);
        } else {
          assert(report.failed.some((failure) => failure.name === subject.name),
            `${label}: the table says refuse, and the executor refused`);
          assertEq(report.failed[0]!.reason, expected, `${label}: with the table's own words`);
          assertEq(report.removed.includes(witness.name), false,
            `${label}: and NOTHING AFTER IT WAS DESTROYED`);
          assert(existsSync(witness.dir) || existsSync(join(quarantineDir, witness.name)),
            `${label}: the witness is still somewhere whole`);
        }
      }
    }
  }
});

// -----------------------------------------------------------------------------------------------------------
// A removal that fails part way, and the states that follow it
// -----------------------------------------------------------------------------------------------------------

test('a removal that unlinks something and then throws stays `deleting`, and a second resume finishes it', () => {
  const { root, a } = crashFixture('partial-delete');
  const digest = crash(root, `after-quarantine-mark:${a.name}`, { policy: CRASH_POLICY });
  const quarantined = join(root, 'backups', safetyQuarantineDirName(SUFFIX), a.name);
  const report = resume(root, digest, {
    remover: (path: string) => {
      // A REAL PARTIAL REMOVAL. One component is really unlinked and then the removal fails, which is what a
      // file another process holds open, a permission change or an rmdir that will not complete produces.
      // The injected seam now receives the SAFETY SET, because a consumption removes the set first and keeps
      // its own authority alive until last.
      rmSync(join(path, COMPONENT_ARTIFACT_NAMES.database));
      throw new MaintenanceRefused('the safety set could not be removed in full');
    },
  });
  assertEq(report.ok, false, 'the run did not succeed');
  assertEq(journalOf(root).entries.find((entry) => entry.name === a.name)!.state, 'deleting',
    'the journal still says deleting, because that is the only state that authorises finishing it');
  assert(existsSync(quarantined), 'the partial tree is in the quarantine directory');
  assert(report.retained !== null && report.retained.holds.includes(a.name), 'and the report names it');
  const second = resume(root, digest);
  assert(second.ok, `a second resume finishes it: ${JSON.stringify(second.failed)}`);
  assertEq(existsSync(quarantined), false, 'the tree is gone');
  assertEq(existsSync(join(root, 'backups', safetyQuarantineDirName(SUFFIX))), false,
    'and the quarantine directory was cleaned up');
});

test('a `deleting` tree is never put back by an abandon, and is named as possibly incomplete', () => {
  const { root, a } = crashFixture('abandon-deleting');
  const digest = crash(root, `after-deleting-mark:${a.name}`, { policy: CRASH_POLICY });
  assertEq(journalOf(root).entries[0]!.state, 'deleting', 'the state is deleting');
  const report = abandonSafetySetLifecycle(root);
  assertEq(report.state, 'PARTIAL', 'the abandon is partial');
  assertEq(report.ok, false, 'and not a success');
  assert(report.unresolved.includes(a.name), 'the claim is named as unresolved');
  assert(report.notes.some((note) => note.includes('may be incomplete')), 'with the reason said plainly');
  assertEq(existsSync(a.dir), false, 'and it was NOT put back under its own name');
  assert(digest.length === 64, 'the digest was real');
});

// -----------------------------------------------------------------------------------------------------------
// Phase 318 — abandon
// -----------------------------------------------------------------------------------------------------------

test('CORRECTION 1: --abandon refuses while a restore is live, before it writes or moves anything', () => {
  const { root, a } = crashFixture('abandon-restore');
  crash(root, `after-quarantine-mark:${a.name}`, { policy: CRASH_POLICY });
  const quarantined = quarantinedClaim(root, a.name);
  const whole = snapshot(quarantined);
  const journalBefore = readFileSync(join(root, SAFETY_SET_JOURNAL_NAME), 'utf8');

  writeFileSync(join(root, RESTORE_JOURNAL_NAME), '{"whatever":true}\n', 'utf8');
  refuses(() => abandonSafetySetLifecycle(root), 'part way through a restore', 'an abandon mid-restore');
  // NOT ONE BYTE. The phase was not flipped to `abandoning`, nothing was renamed, and the lock was released.
  assertEq(readFileSync(join(root, SAFETY_SET_JOURNAL_NAME), 'utf8'), journalBefore,
    'the journal is byte-identical, so phase=abandoning was never written');
  assert(sameSnapshot(whole, snapshot(quarantined)), 'and the quarantined claim is byte-identical');
  assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false, 'the project lock was not left behind');

  rmSync(join(root, RESTORE_JOURNAL_NAME));
  const report = abandonSafetySetLifecycle(root);
  assertEq(report.state, 'ABANDONED', 'and once the restore is gone the recovery works');
  assert(sameSnapshot(whole, snapshot(a.dir)), 'putting the claim back byte for byte');
});

test('CORRECTION 1: a restore journal blocks by PRESENCE — a dangling link and a directory both refuse', () => {
  const cases: Array<[string, (path: string) => boolean]> = [
    ['a dangling symbolic link', (path) => linkDirectory(join(WORK, 'never-existed-at-all'), path)],
    ['a directory', (path) => { mkdirSync(path, { recursive: true }); return true; }],
    ['an empty file', (path) => { writeFileSync(path, '', 'utf8'); return true; }],
  ];
  for (const [label, place] of cases) {
    const { root, a } = crashFixture(`presence-${label.replace(/[^a-z]/g, '')}`);
    const digest = crash(root, `after-quarantine-mark:${a.name}`, { policy: CRASH_POLICY });
    const journalPath = join(root, RESTORE_JOURNAL_NAME);
    if (!place(journalPath)) continue;
    // `existsSync` FOLLOWS A LINK, so a dangling one answers false and this used to sail straight past.
    // Presence of the NAME is the question, and it is asked without following anything.
    refuses(() => planFor(root, { policy: CRASH_POLICY }), 'part way through a restore', `${label}: plan`);
    refuses(() => resume(root, digest), 'part way through a restore', `${label}: resume`);
    refuses(() => abandonSafetySetLifecycle(root), 'part way through a restore', `${label}: abandon`);
    rmSync(journalPath, { recursive: true, force: true });
    assert(abandonSafetySetLifecycle(root).state === 'ABANDONED', `${label}: and the recovery works after`);
  }
});

test('CORRECTION 1: a `deleting` claim whose tree is gone is LOSS, even when something took its name', () => {
  const { root, a } = crashFixture('abandon-deleting-replaced');
  crash(root, `after-remove:${a.name}`, { policy: CRASH_POLICY });
  assertEq(journalOf(root).entries[0]!.state, 'deleting', 'the removal landed and the record did not');
  assertEq(existsSync(quarantinedClaim(root, a.name)), false, 'the tree really is gone');

  // SOMETHING UNRELATED TAKES THE OLD NAME. The first cut read "source absent, target present" as "never
  // quarantined, or already put back", marked the entry `pending`, counted it as neither put back nor lost,
  // and could report RESULT: ABANDONED with an exit code of zero about a destroyed safety set.
  mkdirSync(a.dir, { recursive: true });
  writeFileSync(join(a.dir, 'theirs.txt'), 'somebody put this here\n', 'utf8');
  const before = snapshot(a.dir);

  const report = abandonSafetySetLifecycle(root);
  assert(report.goneForever.includes(a.name), 'the claim is named as GONE FOREVER');
  assertEq(report.putBack.includes(a.name), false, 'it is NOT reported as put back');
  assertEq(report.ok, false, 'and this is not a clean unwind');
  assertEq(report.state, 'ABANDONED_WITH_LOSS', 'it is loss, and it says so');
  assert(report.notes.some((note) => note.includes('is at its name again')),
    'with the sentence that reconciles "gone" and a directory that is plainly there');
  assert(sameSnapshot(before, snapshot(a.dir)), 'and the replacement is byte-identical');
});

test('CORRECTION 1: an interrupted abandon rename is told apart from a replacement at the same name', () => {
  // 1. A GENUINE interrupted rename: the claim really is back under its own name, and it proves it.
  const genuine = crashFixture('abandon-interrupted-genuine');
  const digest = crash(genuine.root, `after-quarantine-mark:${genuine.a.name}`, { policy: CRASH_POLICY });
  const whole = snapshot(quarantinedClaim(genuine.root, genuine.a.name));
  const crashed = spawnChild({
    projectRoot: genuine.root, destination: 'backups', confirm: digest, suffix: SUFFIX,
    policy: policy(CRASH_POLICY), nowMs: NOW.getTime(),
    crashAt: `after-abandon-rename:${genuine.a.name}`, operation: 'abandon',
  });
  assertEq(crashed.status, SAFETY_CRASH_EXIT_CODE, `the abandon had to die mid-rename: ${crashed.stderr}`);
  clearLocks(genuine.root);
  assertEq(journalOf(genuine.root).entries.find((entry) => entry.name === genuine.a.name)!.state,
    'quarantined', 'the rename landed and nothing recorded it');
  const rerun = abandonSafetySetLifecycle(genuine.root);
  assert(rerun.putBack.includes(genuine.a.name),
    'a rerun REPORTS it as put back, because that is what happened to it');
  assertEq(rerun.state, 'ABANDONED', 'and the unwind is clean');
  assert(sameSnapshot(whole, snapshot(genuine.a.dir)), 'byte for byte');

  // 2. A REPLACEMENT at the same name, in the same journal state, is not the same sentence.
  const replaced = crashFixture('abandon-interrupted-replaced');
  crash(replaced.root, `after-quarantine-mark:${replaced.a.name}`, { policy: CRASH_POLICY });
  rmSync(quarantinedClaim(replaced.root, replaced.a.name), { recursive: true });
  mkdirSync(replaced.a.dir, { recursive: true });
  writeFileSync(join(replaced.a.dir, 'theirs.txt'), 'not the claim\n', 'utf8');
  const strangerBefore = snapshot(replaced.a.dir);
  const report = abandonSafetySetLifecycle(replaced.root);
  assertEq(report.putBack.includes(replaced.a.name), false, 'a replacement is NOT reported as put back');
  assert(report.unresolved.includes(replaced.a.name), 'it is named as still out of place');
  assertEq(report.ok, false, 'and the abandon is not clean');
  assert(sameSnapshot(strangerBefore, snapshot(replaced.a.dir)), 'the replacement is byte-identical');
});

test('an abandon puts back every quarantined claim, byte for byte, and clears the journal', () => {
  const root = makeProject('abandon-1');
  takeTopSet(root, 'set-a', { daysAgo: 100 });
  const a = makeClaim(root, 'a', { daysAgo: 400 });
  const b = makeClaim(root, 'b', { daysAgo: 300 });
  makeClaim(root, 'keeper', { daysAgo: 10 });
  const wholeA = snapshot(a.dir);
  const wholeB = snapshot(b.dir);
  crash(root, `after-quarantine-mark:${b.name}`, { policy: CRASH_POLICY });
  const report = abandonSafetySetLifecycle(root);
  assertEq(report.state, 'ABANDONED', 'a clean unwind');
  assert(report.ok, 'and it says so');
  assertEq(JSON.stringify([...report.putBack].sort()), JSON.stringify([a.name, b.name].sort()), 'both went back');
  assert(sameSnapshot(wholeA, snapshot(a.dir)), 'byte for byte');
  assert(sameSnapshot(wholeB, snapshot(b.dir)), 'both of them');
  assertEq(report.journalCleared, true, 'the journal was cleared');
  assertEq(existsSync(join(root, 'backups', safetyQuarantineDirName(SUFFIX))), false,
    'and the quarantine directory is gone');
});

test('an abandon that lost a claim is ABANDONED_WITH_LOSS, is not ok, and names what is gone', () => {
  const root = makeProject('abandon-2');
  takeTopSet(root, 'set-a', { daysAgo: 100 });
  const a = makeClaim(root, 'a', { daysAgo: 400 });
  const b = makeClaim(root, 'b', { daysAgo: 300 });
  makeClaim(root, 'keeper', { daysAgo: 10 });
  const wholeB = snapshot(b.dir);
  crash(root, `after-remove:${a.name}`, { policy: CRASH_POLICY });
  const report = abandonSafetySetLifecycle(root);
  assertEq(report.state, 'ABANDONED_WITH_LOSS', 'the state');
  assertEq(report.ok, false, 'it is NOT a success');
  assert(report.goneForever.includes(a.name), 'the lost claim is named');
  assert(report.putBack.includes(b.name), 'and the recoverable one went back');
  assert(sameSnapshot(wholeB, snapshot(b.dir)), 'byte for byte');
  assert(renderSafetySetAbandon(report).includes('GONE FOREVER'), 'and the render says so in words');
});

test('an abandon will not overwrite something that has taken a claim\'s name back', () => {
  const { root, a } = crashFixture('abandon-3');
  crash(root, `after-quarantine-mark:${a.name}`, { policy: CRASH_POLICY });
  mkdirSync(a.dir, { recursive: true });
  writeFileSync(join(a.dir, 'theirs.txt'), 'somebody put this here\n', 'utf8');
  const before = snapshot(a.dir);
  const report = abandonSafetySetLifecycle(root);
  assertEq(report.state, 'PARTIAL', 'partial');
  assert(report.unresolved.includes(a.name), 'and the claim is named as still out of place');
  assert(sameSnapshot(before, snapshot(a.dir)), 'what took its name is byte-identical');
});

test('an abandon killed mid-rename reruns deterministically', () => {
  const { root, a } = crashFixture('abandon-crash');
  const digest = crash(root, `after-quarantine-mark:${a.name}`, { policy: CRASH_POLICY });
  const whole = snapshot(join(root, 'backups', safetyQuarantineDirName(SUFFIX), a.name));
  const result = spawnChild({
    projectRoot: root, destination: 'backups', confirm: digest, suffix: SUFFIX,
    policy: policy(CRASH_POLICY), nowMs: NOW.getTime(), crashAt: `after-abandon-rename:${a.name}`,
    operation: 'abandon',
  });
  assertEq(result.status, SAFETY_CRASH_EXIT_CODE, `the abandon had to die mid-rename: ${result.stderr}`);
  clearLocks(root);
  assert(sameSnapshot(whole, snapshot(a.dir)), 'the rename landed even though nothing recorded it');
  const report = abandonSafetySetLifecycle(root);
  assertEq(report.state, 'ABANDONED', 'and a rerun completes cleanly');
  assert(sameSnapshot(whole, snapshot(a.dir)), 'with the claim still byte-identical');
});

test('a journal write or clear that fails after a rename is a POST-EFFECT failure carrying its report', () => {
  const { root, a } = crashFixture('post-effect');
  const digest = crash(root, 'after-journal', { policy: CRASH_POLICY });
  let thrown: unknown = null;
  try {
    resume(root, digest, {
      journalWriter: () => { throw new MaintenanceRefused('the safety-set lifecycle journal could not be written'); },
    });
  } catch (err) { thrown = err; }
  assert(thrown instanceof SafetySetFailed, `a post-effect failure, not a refusal: ${(thrown as Error).name}`);
  const report = (thrown as SafetySetFailed).report;
  assertEq(report.state, 'INCOMPLETE', 'the report says incomplete');
  assert(report.retained !== null, 'and names the retained quarantine directory');
  assert(report.retained!.holds.includes(a.name), 'with what it holds');

  const clearFixture = crashFixture('post-effect-clear');
  const clearDigest = crash(clearFixture.root, 'after-journal', { policy: CRASH_POLICY });
  let clearThrown: unknown = null;
  try {
    abandonSafetySetLifecycle(clearFixture.root, {
      journalClearer: () => { throw new MaintenanceRefused('the journal could not be removed'); },
    });
  } catch (err) { clearThrown = err; }
  // Nothing had been renamed yet at `after-journal`, so this abandon is pre-effect for the RENAMES but the
  // journal write itself is the operation's first act; either way it must never be reported as a success.
  assert(clearThrown === null || clearThrown instanceof MaintenanceRefused,
    `the failure is a closed one: ${(clearThrown as Error | null)?.name}`);
  assertEq(clearDigest.length, 64, 'the digest was real');
});

// -----------------------------------------------------------------------------------------------------------
// Phase 319 — the CLI
// -----------------------------------------------------------------------------------------------------------

test('each mode accepts only its own flags, and there is no --force and no --yes', () => {
  rejectsUsage(() => parseSafetySetArgs(['--project', 'x']), 'nothing was asked for', 'no mode');
  rejectsUsage(() => parseSafetySetArgs(['--plan']), '--project is required', 'no project');
  rejectsUsage(() => parseSafetySetArgs(['--project', 'x', '--plan', '--confirm', 'd']),
    'different operations', 'two modes');
  rejectsUsage(() => parseSafetySetArgs(['--project', 'x', '--resume', 'd', '--keep-last', '3']),
    'not part of --resume', 'a policy flag on a resume');
  rejectsUsage(() => parseSafetySetArgs(['--project', 'x', '--abandon', '--destination', 'b']),
    'not part of --abandon', 'a destination on an abandon');
  rejectsUsage(() => parseSafetySetArgs(['--project', 'x', '--plan', '--force']), 'unknown option', 'a --force');
  rejectsUsage(() => parseSafetySetArgs(['--project', 'x', '--plan', '--yes']), 'unknown option', 'a --yes');
  rejectsUsage(() => parseSafetySetArgs(['--project', 'x', '--plan', '--keep-last', 'seven']),
    'whole number', 'a word where a number goes');
  const usage = readRepo('src/ops/safety-set-lifecycle-cli.ts');
  assert(!/'force'/.test(usage) && !/'yes'/.test(usage), 'neither flag exists anywhere in the CLI');
  for (const mode of ['plan', 'run', 'resume', 'abandon'] as const) {
    assert(SAFETY_SET_MODE_VALUE_FLAGS[mode].includes('project'), `${mode} takes --project`);
    assert(!SAFETY_SET_MODE_SWITCH_FLAGS[mode].includes('force'), `${mode} has no --force`);
  }
});

test('a credential-looking flag is refused before anything else happens', () => {
  rejectsUsage(() => parseSafetySetArgs(['--project', 'x', '--plan', '--password', 'hunter2']),
    'looks like a credential', 'a password');
  rejectsUsage(() => parseSafetySetArgs(['--project', 'x', '--plan', '--token', 'abc']),
    'looks like a credential', 'a token');
});

test('--json emits exactly one document on every report path, and nothing else on that stream', () => {
  const captured = { out: [] as string[], err: [] as string[] };
  const realLog = console.log;
  const realError = console.error;
  const capture = <T>(fn: () => T): { readonly value: T; readonly out: string; readonly err: string } => {
    captured.out = []; captured.err = [];
    console.log = (...args: unknown[]) => { captured.out.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { captured.err.push(args.map(String).join(' ')); };
    try { return { value: fn(), out: captured.out.join('\n'), err: captured.err.join('\n') }; }
    finally { console.log = realLog; console.error = realError; }
  };

  // 1. a plan
  const planRoot = makeProject('cli-json-plan');
  takeTopSet(planRoot, 'set-a', { daysAgo: 100 });
  makeClaim(planRoot, 'a', { daysAgo: 300 });
  makeClaim(planRoot, 'keeper', { daysAgo: 10 });
  const plan = capture(() => cliMain(['--project', planRoot, '--plan', '--keep-last', '1',
    '--min-age-days', '7', '--json']));
  assertEq(plan.value, SAFETY_SET_EXIT_OK, 'the plan exits zero');
  assertEq(plan.err, '', 'and puts nothing on stderr');
  JSON.parse(plan.out.trim());
  assertEq(plan.out.trim(), plan.out.trim(), 'the document is the whole stream');

  // 2. a successful run
  const runRoot = makeProject('cli-json-run');
  takeTopSet(runRoot, 'set-a', { daysAgo: 100 });
  makeClaim(runRoot, 'a', { daysAgo: 300 });
  makeClaim(runRoot, 'keeper', { daysAgo: 10 });
  const digest = planFor(runRoot, { policy: CRASH_POLICY }).digest;
  const run = capture(() => cliMain(['--project', runRoot, '--confirm', digest, '--keep-last', '1',
    '--min-age-days', '7', '--json'], { now: () => NOW }));
  assertEq(run.value, SAFETY_SET_EXIT_OK, 'a successful run exits zero');
  const runDoc = JSON.parse(run.out.trim()) as { state: string };
  assertEq(runDoc.state, 'REMOVED', 'and the document is the report');
  assertEq(run.err, '', 'with nothing on stderr');

  // 3. a POST-EFFECT failure: the document goes to stderr, and stdout carries nothing at all
  const failFixture = crashFixture('cli-json-fail');
  const failDigest = crash(failFixture.root, 'after-journal', { policy: CRASH_POLICY });
  const failed = capture(() => cliMain(['--project', failFixture.root, '--resume', failDigest, '--json'], {
    now: () => NOW,
    journalWriter: () => { throw new MaintenanceRefused('the journal could not be written'); },
  }));
  assertEq(failed.value, SAFETY_SET_EXIT_FAILED, 'it exits 1, not the code meaning "refused before anything moved"');
  assertEq(failed.out, '', 'stdout carries NOTHING');
  const failedDoc = JSON.parse(failed.err.trim()) as { ok: boolean; state: string };
  assertEq(failedDoc.ok, false, 'and stderr carries exactly one document');
  assertEq(failedDoc.state, 'INCOMPLETE', 'saying what happened');

  // 4. an abandon
  const abandon = capture(() => cliMain(['--project', failFixture.root, '--abandon', '--json']));
  assertEq(abandon.value, SAFETY_SET_EXIT_OK, 'a clean abandon exits zero');
  JSON.parse(abandon.out.trim());
  assertEq(abandon.err, '', 'with nothing on stderr');

  // 5. A PRE-EFFECT REFUSAL. CORRECTION 1: this used to emit plain prose, on the path a scheduled --plan
  // against a busy project meets first. It is one document now, on stderr, with stdout carrying nothing.
  const refusal = capture(() => cliMain(['--project', planRoot, '--resume', 'a'.repeat(64), '--json']));
  assertEq(refusal.value, SAFETY_SET_EXIT_REFUSED, 'a refusal exits 3');
  assertEq(refusal.out, '', 'stdout carries NOTHING');
  const refusalDoc = JSON.parse(refusal.err.trim()) as
    { ok: boolean; state: string; exitCode: number; message: string; report: string };
  assertEq(refusalDoc.ok, false, 'the document says it is not ok');
  assertEq(refusalDoc.state, 'REFUSED', 'and which kind of outcome it is');
  assertEq(refusalDoc.exitCode, SAFETY_SET_EXIT_REFUSED, 'carrying the exit code a reader would otherwise lose');
  assertEq(refusalDoc.report, SAFETY_SET_REPORT, 'under the same header as every other document');
  assert(refusalDoc.message.length > 10, 'and this product\'s own words');
  assert(!refusalDoc.message.includes(WORK), 'redacted the way every other surface is');

  // 6. A USAGE ERROR — the first thing an automated caller meets when it gets a flag wrong.
  const usage = capture(() => cliMain(['--project', planRoot, '--json']));
  assertEq(usage.value, SAFETY_SET_EXIT_USAGE, 'a usage error exits 2');
  assertEq(usage.out, '', 'stdout carries NOTHING');
  const usageDoc = JSON.parse(usage.err.trim()) as { ok: boolean; state: string; exitCode: number };
  assertEq(usageDoc.state, 'USAGE', 'the document names the outcome');
  assertEq(usageDoc.exitCode, SAFETY_SET_EXIT_USAGE, 'with its exit code');
  // AND THE WHOLE USAGE TEXT IS NOT APPENDED AFTER IT, which is what made this unparseable before. The
  // stream IS the document: nothing before the opening brace, nothing after the closing one.
  for (const [label, stream] of [['a refusal', refusal.err], ['a usage error', usage.err]] as const) {
    const trimmed = stream.trim();
    assert(trimmed.startsWith('{') && trimmed.endsWith('}'), `${label}: the stream is one document`);
    assertEq(JSON.stringify(JSON.parse(trimmed)), JSON.stringify(JSON.parse(trimmed)),
      `${label}: and it parses whole`);
  }
  assert(!usage.err.includes('usage: npm run ops:safety-set-lifecycle'), 'no usage prose follows it');
  assertEq(usageDoc.ok, false, 'and a usage error is not ok');

  // 7. WITHOUT --json both paths keep their human prose, including the usage text.
  const humanUsage = capture(() => cliMain(['--project', planRoot]));
  assertEq(humanUsage.value, SAFETY_SET_EXIT_USAGE, 'a human usage error still exits 2');
  assert(humanUsage.err.includes('usage: npm run ops:safety-set-lifecycle'), 'and still prints the manual');
  const humanRefusal = capture(() => cliMain(['--project', planRoot, '--resume', 'a'.repeat(64)]));
  assertEq(humanRefusal.value, SAFETY_SET_EXIT_REFUSED, 'a human refusal still exits 3');
  assertEq(humanRefusal.out, '', 'on stderr only');

  // 8. --help is the one documented exception, and stays human text even beside --json.
  const help = capture(() => cliMain(['--help', '--json']));
  assertEq(help.value, SAFETY_SET_EXIT_OK, '--help exits 0');
  assert(help.out.includes('usage: npm run ops:safety-set-lifecycle'), 'and prints the manual as text');
});

test('CORRECTION 1: a journal write that fails AFTER the tree is gone still names what is gone', () => {
  const { root, a } = crashFixture('removed-write-truth');
  const digest = crash(root, `after-consuming-marker:${a.name}`, { policy: CRASH_POLICY });
  const bytes = journalOf(root).claims.find((claim) => claim.name === a.name)!.bytes;
  assert(bytes > 0, 'the claim declares a size');

  // THE FAILPOINT IS AIMED AT THE `removed` PUBLICATION AND NOTHING ELSE. The recursive removal succeeds;
  // only the record of it fails. The first cut published the state before adding the claim to the report,
  // so this threw out with `removed` empty — a post-effect report that said NOTHING WAS REMOVED about a
  // safety set that no longer exists.
  let thrown: unknown = null;
  try {
    resume(root, digest, {
      journalWriter: (projectRoot: string, journal: SafetySetJournal) => {
        if (journal.entries.some((entry) => entry.name === a.name && entry.state === 'removed')) {
          throw new MaintenanceRefused('the safety-set lifecycle journal could not be written');
        }
        writeSafetySetJournal(projectRoot, journal);
      },
    });
  } catch (err) { thrown = err; }

  assert(thrown instanceof SafetySetFailed, `a post-effect failure: ${(thrown as Error).name}`);
  const report = (thrown as SafetySetFailed).report;
  assert(report.removed.includes(a.name), 'THE REPORT NAMES THE CLAIM THAT IS GONE');
  assertEq(report.bytesRemoved, bytes, 'and the bytes it freed');
  assertEq(report.state, 'INCOMPLETE', 'the run did not finish');
  assertEq(existsSync(quarantinedClaim(root, a.name)), false, 'the tree really is gone from disk');
  // THE DURABLE STATE STILL PERMITS RECOVERY: it says `deleting`, which is what lets a resume close it out.
  assertEq(journalOf(root).entries.find((entry) => entry.name === a.name)!.state, 'deleting',
    'and the journal on disk still says deleting, because the write never landed');

  const closing = resume(root, digest);
  assert(closing.ok, `a resume closes it out: ${JSON.stringify(closing.failed)}`);
  assert(closing.removed.includes(a.name), 'still reporting what the OPERATION removed');
  assertEq(existsSync(join(root, SAFETY_SET_JOURNAL_NAME)), false, 'and the journal is cleared');
});

test('CORRECTION 1: an abandon after that same failure reports the loss truthfully', () => {
  const { root, a } = crashFixture('removed-write-abandon');
  const digest = crash(root, `after-consuming-marker:${a.name}`, { policy: CRASH_POLICY });
  try {
    resume(root, digest, {
      journalWriter: (projectRoot: string, journal: SafetySetJournal) => {
        if (journal.entries.some((entry) => entry.name === a.name && entry.state === 'removed')) {
          throw new MaintenanceRefused('the safety-set lifecycle journal could not be written');
        }
        writeSafetySetJournal(projectRoot, journal);
      },
    });
  } catch { /* the post-effect failure is the setup, not the assertion */ }
  const report = abandonSafetySetLifecycle(root);
  assert(report.goneForever.includes(a.name), 'the abandon names the claim as gone forever');
  assertEq(report.ok, false, 'and does not call that a clean unwind');
  assertEq(report.state, 'ABANDONED_WITH_LOSS', 'it is loss');
});

test('the human render carries its remediation prose, and JSON mode carries it in notes instead', () => {
  const { root } = crashFixture('cli-prose');
  const digest = crash(root, 'after-journal', { policy: CRASH_POLICY });
  const journal = readSafetySetJournal(root);
  assert(journal !== null, 'the journal reads');
  const report = resume(root, digest);
  assert(report.ok, 'the resume finished');
  const rendered = renderSafetySetRun(report);
  assert(rendered.includes('RESULT: REMOVED'), 'the render states the result');
  assert(!rendered.includes(WORK), 'and carries no host path');
});

// -----------------------------------------------------------------------------------------------------------
// Phase 320 — the boundary, the integration and the anti-drift proofs
// -----------------------------------------------------------------------------------------------------------

test('ops:backup-retention STILL classifies every claim as RESERVED and never descends', () => {
  const root = makeProject('retention-boundary');
  takeTopSet(root, 'set-a', { daysAgo: 100 });
  const claim = makeClaim(root, 'a', { daysAgo: 300 });
  const row = classifyEntry(join(root, 'backups'), claim.name);
  assertEq(row.setClass, 'RESERVED', 'the claim is RESERVED to retention');
  assertEq(row.setDigest, '', 'it never looked inside');
  const inventory = inventoryDestination(join(root, 'backups'));
  assert(inventory.every((entry) => entry.name !== claim.setName),
    'and the safety set inside it is invisible to retention');
  const model = readRepo('src/ops/retention-model.ts');
  assert(model.includes('RESERVED` is every dot-prefixed name'), 'the rule is still written down');
  assert(model.includes('.pre-restore-claim-'), 'and still names this exact namespace as covered by it');
});

test('the shared claim-marker reader and ops:complete-restore\'s own prover agree, field for field', () => {
  const root = makeProject('drift-1');
  const claim = makeClaim(root, 'a', { empty: true });
  const suffix = operationSuffix(claim.planDigest);
  // The marker the SHIPPED writer produced is accepted by both readers.
  assertEq(proveClaimOwnership(claim.dir, claim.planDigest, suffix, claim.nonce).kind, 'owned', 'the prover');
  assert(readRestoreClaimMarker(claim.dir, claim.name, CLAIM_MARKER_EXPECTATION).ok, 'and the shared reader');
  // Mutating ANY field makes both refuse.
  for (const field of ['marker', 'version', 'journalVersion', 'planDigest', 'suffix', 'nonce'] as const) {
    const twin = makeClaim(root, `drift-${field}`, { empty: true });
    patchClaimMarker(twin.dir, (marker) => ({ ...marker, [field]: 'changed' }));
    assert(proveClaimOwnership(twin.dir, twin.planDigest, operationSuffix(twin.planDigest), twin.nonce).kind
      === 'foreign', `${field}: the prover refuses`);
    assert(!readRestoreClaimMarker(twin.dir, twin.name, CLAIM_MARKER_EXPECTATION).ok,
      `${field}: and so does the shared reader`);
  }
  // And the marker id and file name are ONE definition, imported by both modules.
  const restore = readRepo('src/ops/complete-restore.ts');
  assertEq((restore.match(/catalog-authority\.restore-safety-claim/g) ?? []).length, 0,
    'complete-restore holds no literal copy of the marker id');
  assertEq((restore.match(/'catalog-restore-claim\.json'/g) ?? []).length, 0,
    'nor of the marker file name');
  assert(restore.includes('SAFETY_CLAIM_MARKER_ID') && restore.includes('SAFETY_CLAIM_MARKER_FILE'),
    'it imports both from the shared module');
  assertEq(SAFETY_CLAIM_MARKER_NAME, SAFETY_CLAIM_MARKER_FILE, 'and the two names are the same value');
  assertEq(SAFETY_CLAIM_MARKER_ID, 'catalog-authority.restore-safety-claim', 'which is the shipped one');
});

test('the shared set-identity proof is the one ops:backup-retention uses', () => {
  const root = makeProject('drift-2');
  const setDir = takeTopSet(root, 'set-a', { daysAgo: 100 });
  const row = classifyEntry(join(root, 'backups'), 'set-a');
  const commitment = {
    name: row.name, setDigest: row.setDigest, takenAt: row.takenAt, schemaVersion: row.schemaVersion,
    bytes: row.bytes, entries: row.entries, verified: true, findings: row.findings,
  };
  proveBackupSetIdentity(setDir, commitment);
  tamper(setDir);
  refuses(() => proveBackupSetIdentity(setDir, commitment), 'no longer verifies the way it did',
    'a tampered set');
  const retention = readRepo('src/ops/backup-retention.ts');
  assert(retention.includes('proveBackupSetIdentity'), 'retention delegates to it');
  assertEq((retention.match(/its contents do not match the identity/g) ?? []).length, 0,
    'and holds no second copy of the proof');
});

test('this command issues no command at all — there is no process spawn anywhere in it', () => {
  for (const file of ['src/ops/safety-set-lifecycle.ts', 'src/ops/safety-set-lifecycle-cli.ts',
    'src/ops/safety-set-model.ts', 'src/ops/maintenance-identity.ts']) {
    const source = readRepo(file);
    for (const forbidden of ['spawnSync', 'spawn(', 'execSync', 'exec(', 'child_process', 'fetch(',
      'http.request', 'CommandRunner']) {
      assert(!source.includes(forbidden), `${file} does not reach for ${forbidden}`);
    }
  }
});

test('no report surface carries a host path, a secret or anything from inside a set', () => {
  const root = makeProject('redact');
  takeTopSet(root, 'set-a', { daysAgo: 100 });
  makeClaim(root, 'a', { daysAgo: 300 });
  makeClaim(root, 'keeper', { daysAgo: 10 });
  const plan = planFor(root, { policy: CRASH_POLICY });
  const { report } = sweep(root, { policy: CRASH_POLICY });
  const surfaces = [JSON.stringify(plan), renderSafetySetPlan(plan), JSON.stringify(report),
    renderSafetySetRun(report)];
  for (const surface of surfaces) {
    assert(!surface.includes(WORK), 'no host path');
    assert(!surface.includes(SECRET_VALUE), 'no secret value');
    assert(!surface.includes('BEGIN'), 'nothing that looks like key material');
  }
});

test('the command and its suite are registered where the runner and the operator look', () => {
  const pkg = JSON.parse(readRepo('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['ops:safety-set-lifecycle'], 'tsx src/ops/safety-set-lifecycle-cli.ts', 'the command');
  assertEq(pkg.scripts['test:safety-set-lifecycle'], 'tsx test/safety-set-lifecycle.ts', 'the suite');
  assertEq(pkg.scripts['test:phase313-local'], 'npm run test:safety-set-lifecycle', 'the phase alias');
  const inventory = JSON.parse(readRepo('test/suite-inventory.json')) as
    { suites: { file: string; group: string }[] };
  const entry = inventory.suites.find((suite) => suite.file === 'safety-set-lifecycle.ts');
  assert(entry !== undefined, 'the suite is in the inventory');
  assertEq(entry!.group, 'offline', 'in the offline group, because it needs nothing');
});

test('the destructive-command CI gate names this suite too', () => {
  const readiness = readRepo('src/ops/release-readiness.ts');
  assert(readiness.includes('test:phase313-local'), 'the required-suite list names it');
  const workflow = readRepo('.github/workflows/runtime-image.yml');
  assert(workflow.includes('npm run test:phase313-local'), 'and the workflow runs it');
});

test('the operator panel renders this command from the one component model, and never a --confirm', () => {
  const service = readRepo('src/ops/operator-ui-service.ts');
  assert(service.includes('SAFETY_SET_LIFECYCLE_NOTE'), 'the panel renders the exported note');
  assert(service.includes('SAFETY_SET_LIFECYCLE_COMMANDS'), 'and the exported command');
  const components = readRepo('src/ops/backup-components.ts');
  const note = /export const SAFETY_SET_LIFECYCLE_NOTE =([\s\S]*?);\n/.exec(components)![1]!;
  assert(note.includes('--plan'), 'the note tells an operator to start with a plan');
  assert(note.includes('quarantine'), 'and says nothing is deleted in place');
  assert(note.includes('ops:backup-retention'), 'and explains why the other command never descends');
  const commands = /export const SAFETY_SET_LIFECYCLE_COMMANDS[\s\S]*?\};\n/.exec(components)![0]!;
  assert(commands.includes('--plan'), 'the rendered command is the plan, not the run');
  assert(!/--confirm/.test(commands), 'the panel never renders a command that removes anything');
});

test('the scheduled maintenance job can print this plan and has no mode that acts on it', () => {
  const script = readRepo('deploy/unraid-catalog-maintenance.sh');
  assert(script.includes('safety-set-plan'), 'the mode exists');
  assert(script.includes('ops:safety-set-lifecycle'), 'and runs the shipped command');
  const executable = script.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert(!executable.includes('--confirm'), 'no line this script executes carries a confirmation');
  assert(!executable.includes('--yes'), 'nor anything else that would remove a backup on a timer');
  assert(!/\brm\s+-rf\b/.test(executable), 'and it tells nobody to rm -rf anything');
});

test('the design document states the threat model, the boundary and the non-goals', () => {
  const doc = readRepo('docs/PHASES_313_320_SAFETY_SET_LIFECYCLE.md');
  for (const needle of ['Threat', 'shared destination', 'Non-goals', 'never descends', 'quarantine',
    'keep-minimum-restorable']) {
    assert(doc.includes(needle), `the document covers "${needle}"`);
  }
  const readme = readRepo('README.md');
  assert(readme.includes('ops:safety-set-lifecycle'), 'and the README names the command');
});

// -----------------------------------------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`\nFAILED: ${name}\n${(err as Error).stack ?? String(err)}`);
rmSync(WORK, { recursive: true, force: true });
if (failed > 0) process.exitCode = 1;
