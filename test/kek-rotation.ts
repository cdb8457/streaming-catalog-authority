import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import {
  activatePendingGeneration,
  activeKek,
  adoptStaticKekAsRing,
  beginPendingGeneration,
  kekForGeneration,
  loadKekRing,
  summarizeKekRing,
} from '../src/core/crypto/kek-ring.js';
import { writeStateDocument } from '../src/core/crypto/custodian-state-io.js';
import { REQUIRED_SECRET_FILES } from '../src/ops/backup-components.js';
import { runVerifiedCompleteBackup, type CompleteBackupRequest } from '../src/ops/complete-backup.js';
import {
  KEK_ROTATION_DUE_DAYS,
  KEK_ROTATION_OVERDUE_DAYS,
  ROTATION_STAGES,
  classifyKekRotationAge,
  countKeystoreEntries,
  planKekRotation,
  readRotationJournal,
  retireKekGeneration,
  runKekRotation,
  type RotationStage,
} from '../src/ops/kek-rotation.js';
import { CommandLedger, MaintenanceRefused, type MaintenanceCommand } from '../src/ops/maintenance-safety.js';
import { assertLedgerIsClean, fakeDumpText, fakeToolchain } from './helpers/fake-toolchain.js';

// Phase 283 — rotating a KEK, and every way an interrupted rotation could otherwise leave a catalog it
// cannot read.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - NOTHING RUNS WITHOUT THE PLAN DIGEST, and nothing runs without a complete backup that verifies NOW.
//   - THE APP AND THE SIDECAR ARE STOPPED, and started again through a `finally` on every path out.
//   - THE PENDING KEY IS GENERATED INSIDE THE RING and nothing is under it until everything is.
//   - A CRASH AT EVERY STAGE RESUMES, and a ring that never activated leaves the installation exactly as it
//     was — every key still readable under the generation that is still active.
//   - VERIFY-ALL HAPPENS BEFORE ACTIVATION. A rewrap that left one file behind does not move the ring.
//   - THE OUTGOING GENERATION IS RETAINED, and retirement is refused against a PRE-rotation backup.
//   - IT IS IDEMPOTENT: a second run over a rotated keystore changes nothing.
//   - NO KEY, PATH OR RUNTIME MESSAGE REACHES A REPORT, AND THE LEDGER REACHES NO NETWORK OR MEDIA SYSTEM.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function refuses(fn: () => unknown, needle: string, msg: string): void {
  try { fn(); } catch (err) {
    assert((err as Error).message.includes(needle), `${msg}: expected "${needle}", got: ${(err as Error).message}`);
    return;
  }
  throw new Error(`${msg}: nothing was refused`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');
const WORK = mkdtempSync(join(tmpdir(), 'ca-kek-rotation-'));
const POSIX = process.platform !== 'win32';
const SECRET = 'a-completion-secret-that-must-never-reach-a-report';

interface World {
  readonly project: string;
  readonly stateDir: string;
  readonly rootFile: string;
  readonly root: Buffer;
  readonly staticKek: Buffer;
  readonly backupSet: string;
  readonly keyIds: readonly string[];
}

/**
 * A project with a real keystore holding real wrapped keys, a ring migrated from its static KEK, and a
 * complete backup set that verifies.
 *
 * THE KEYS ARE REAL. A rotation that was tested against an empty keystore would prove that a command ran.
 */
async function makeWorld(name: string, keyCount = 4): Promise<World> {
  const project = join(WORK, name);
  const stateDir = join(project, 'sidecar-state');
  mkdirSync(join(project, 'secrets'), { recursive: true });
  mkdirSync(join(project, 'promotion-records'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  for (const file of REQUIRED_SECRET_FILES) {
    writeFileSync(join(project, 'secrets', file), `${file}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  writeFileSync(join(project, 'promotion-records', 'r.json'), '{}\n', 'utf8');

  const staticKek = randomBytes(32);
  const custodian = new FileCustodian(stateDir, SECRET, staticKek);
  const keyIds: string[] = [];
  for (let index = 0; index < keyCount; index += 1) {
    const provision = await custodian.provision(`op-${index}`, `item-${index}`, 0);
    await custodian.commitProvision(`op-${index}`);
    keyIds.push(provision.keyId);
  }

  const root = randomBytes(32);
  const rootFile = join(project, 'root_wrapping_key');
  writeFileSync(rootFile, `${root.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  if (POSIX) chmodSync(rootFile, 0o600);
  adoptStaticKekAsRing(stateDir, root, staticKek, () => 1_000);

  const request: CompleteBackupRequest = {
    projectRoot: project, destination: 'backups', setName: 'set-1', custodian: 'sidecar',
    sidecarState: 'sidecar-state', secrets: 'secrets', promotionRecords: 'promotion-records',
  };
  const tools = fakeToolchain({ dumpText: fakeDumpText(schemaVersion()) });
  const outcome = runVerifiedCompleteBackup(request, {
    runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger,
  });
  assert(outcome.ok, `the world's backup verifies: ${JSON.stringify(outcome.failures)}`);
  return { project, stateDir, rootFile, root, staticKek, backupSet: join(project, 'backups', 'set-1'), keyIds };
}

function schemaVersion(): number {
  // Read from the build rather than retyped, so a real migration cannot leave this suite asserting an old one.
  const source = readRepo('src/db/schema-version.ts');
  return Number(/MIGRATION_VERSION\s*=\s*([0-9]+)/.exec(source)![1]);
}

function request(world: World) {
  return {
    stateDir: world.stateDir,
    rootKeyFile: world.rootFile,
    backupSet: world.backupSet,
    projectRoot: world.project,
    projectName: 'catalogauthority-local',
  };
}

/** A runner that answers every compose command, and can be made to throw at a chosen moment. */
function runnerFor(world: World, options: { crashOn?: (command: MaintenanceCommand) => boolean } = {}) {
  const ledger = new CommandLedger();
  const runner = (command: MaintenanceCommand) => {
    if (options.crashOn?.(command) === true) throw new Error('a deliberate interruption');
    return { status: 0, stdout: '', stderr: '' };
  };
  return { runner, ledger };
}

/** Every live wrapped key reads under this generation. The property a rotation actually has to preserve. */
function everyKeyReadsUnder(world: World, generation: number): boolean {
  const ring = loadKekRing(world.stateDir, world.root);
  const kek = kekForGeneration(ring, generation);
  const plan = FileCustodian.planRewrapKeystore(world.stateDir, { fromKek: kek, toKek: kek });
  return plan.total > 0 && plan.alreadyCurrent === plan.total;
}

console.log('Running Phase 283 KEK rotation suite:\n');

// ---------------------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------------------

await test('nothing rotates without the exact plan digest, or without a backup that verifies NOW', async () => {
  const world = await makeWorld('gate');
  const resolved = planKekRotation(request(world));
  const tools = runnerFor(world);
  refuses(() => runKekRotation({ ...request(world), confirmDigest: null }, tools),
    'digest you confirmed', 'no digest');
  refuses(() => runKekRotation({ ...request(world), confirmDigest: 'f'.repeat(64) }, tools),
    'digest you confirmed', 'a wrong digest');
  assertEq(tools.ledger.all().length, 0, 'and nothing was run for either');
  assertEq(everyKeyReadsUnder(world, 1), true, 'every key is still under generation 1');

  // A TAMPERED SET STOPS IT BEFORE THE LOCK.
  const dump = join(world.backupSet, 'catalog-backup.sql');
  writeFileSync(dump, `${readFileSync(dump, 'utf8')}-- tampered\n`, 'utf8');
  refuses(() => runKekRotation({ ...request(world), confirmDigest: resolved.planDigest }, tools),
    'does not verify', 'a tampered backup set');
  assertEq(tools.ledger.all().length, 0, 'and still nothing ran');

  // THE DIGEST BINDS THE GENERATION IT IS ROTATING AWAY FROM.
  const other = await makeWorld('gate-2');
  assert(planKekRotation(request(other)).planDigest !== resolved.planDigest, 'two installations, two plans');
});

// ---------------------------------------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------------------------------------

await test('a rotation moves every key, verifies all of them, and only then activates', async () => {
  const world = await makeWorld('happy');
  const before = activeKek(loadKekRing(world.stateDir, world.root)).toString('hex');
  assertEq(before, world.staticKek.toString('hex'), 'the ring starts on the adopted static KEK');

  const resolved = planKekRotation(request(world));
  const tools = runnerFor(world);
  const report = runKekRotation({ ...request(world), confirmDigest: resolved.planDigest }, tools);

  assertEq(report.ok, true, `the rotation completed: ${JSON.stringify(report.notes)}`);
  assertEq(report.stage, 'activated', 'reaching the last stage');
  assertEq(report.fromGeneration, 1, 'from generation 1');
  assertEq(report.toGeneration, 2, 'to generation 2');
  assertEq(report.verifiedAll, true, 'having proved every key reads under the new generation');
  assertEq(report.keys.rewrapped, world.keyIds.length, 'every key was rewrapped');

  const after = loadKekRing(world.stateDir, world.root);
  assertEq(after.active, 2, 'the ring moved');
  assert(activeKek(after).toString('hex') !== before, 'onto a key that is not the old one');
  assertEq(activeKek(after).toString('hex') !== world.staticKek.toString('hex'), true,
    'and specifically not the static KEK this installation came from');
  assertEq(everyKeyReadsUnder(world, 2), true, 'every key on disk reads under it');

  // THE OUTGOING GENERATION IS STILL THERE, which is what makes the pre-rotation backup restorable.
  assertEq(after.generations.length, 2, 'the outgoing generation is retained');
  assertEq(kekForGeneration(after, 1).toString('hex'), world.staticKek.toString('hex'), 'and is still the old key');
  assert(report.notes.some((note) => note.includes('OUTGOING generation is still in the ring')), 'and the report says so');

  // THE QUIESCE HAPPENED AND WAS UNDONE.
  assertEq(report.quiesced.join(','), 'app,sidecar', 'the app and the sidecar were stopped');
  assertEq(report.restarted, true, 'and started again');
  assertEq(report.stillStopped.length, 0, 'with nothing left down');
  const lines = tools.ledger.all().map((entry) => entry.args.join(' '));
  assert(lines.includes('compose -p catalogauthority-local stop app'), 'the app was stopped');
  assert(lines.includes('compose -p catalogauthority-local start sidecar'), 'and the sidecar started again');
  assertEq(assertLedgerIsClean(tools.ledger.all().map((e) => [e.program, ...e.args].join(' '))).join('; '), '',
    'and the ledger reaches no network, registry, media system or acquisition system');
  assertEq(readRotationJournal(world.stateDir), null, 'the journal is gone once the ring is authoritative');
});

// ---------------------------------------------------------------------------------------------------------
// Crash injection, at every stage
// ---------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------
// Crash injection, at every stage
// ---------------------------------------------------------------------------------------------------------

/**
 * Put a world into exactly the state a crash after `stage` leaves.
 *
 * BUILT FROM THE REAL OPERATIONS, not from a hand-written ring. Each stage of the rotation is one public
 * call; performing the calls up to N and writing the journal N would have written IS the post-crash state,
 * rather than an approximation of it. Anything else would be this suite inventing the thing it is checking.
 */
function crashAfter(world: World, planDigest: string, stage: RotationStage): void {
  const from = loadKekRing(world.stateDir, world.root).active;
  let to: number | null = null;
  if (stage !== 'claimed') {
    to = beginPendingGeneration(world.stateDir, world.root, () => 2_000).generation;
  }
  if (stage === 'rewrapped' || stage === 'verified' || stage === 'activated') {
    const ring = loadKekRing(world.stateDir, world.root);
    FileCustodian.rewrapKeystore(world.stateDir, {
      fromKek: kekForGeneration(ring, from),
      toKek: kekForGeneration(ring, to!),
    });
  }
  if (stage === 'activated') activatePendingGeneration(world.stateDir, world.root, () => 3_000);
  writeStateDocument(join(world.stateDir, 'ring', 'rotation-journal.json'), {
    rotation: 'phase-283-kek-rotation',
    version: 1,
    planDigest,
    fromGeneration: from,
    toGeneration: to,
    stage,
    startedAt: 1,
  });
}

/**
 * Can a sidecar restarted right now open every key?
 *
 * ASKED THE WAY THE DAEMON ASKS IT. The custodian is constructed exactly as `startSidecarDaemon` constructs
 * one — the active generation to wrap under, and every retained generation to unwrap under — so this is the
 * real restart question and not a friendlier one.
 */
async function aRestartedSidecarReadsEverything(world: World): Promise<boolean> {
  const ring = loadKekRing(world.stateDir, world.root);
  const retained = ring.generations
    .filter((entry) => entry.generation !== ring.active)
    .map((entry) => Buffer.from(entry.keyHex, 'hex'));
  const custodian = new FileCustodian(world.stateDir, SECRET, activeKek(ring), () => Date.now(), retained);
  for (const keyId of world.keyIds) {
    try {
      if ((await custodian.get(keyId, 0)).length !== 32) return false;
    } catch {
      return false;
    }
  }
  return true;
}

await test('a crash at EVERY stage leaves an installation a restarted sidecar can still read', async () => {
  // THE PROPERTY THAT MATTERS, AND THE ONE THAT WAS NOT TRUE UNTIL THIS TRANCHE. A rotation rewrites every
  // key file BEFORE it moves the ring's active pointer, so between those two moments the files are under a
  // generation the ring does not call active. A sidecar holding only the active KEK would fail to open
  // anything — and every item would read as unreadable, which is indistinguishable from a correct erasure.
  // The daemon therefore holds every RETAINED generation for unwrapping, and this asserts that at each stage.
  for (const stage of ROTATION_STAGES) {
    const world = await makeWorld(`crash-${stage}`);
    const plan = planKekRotation(request(world));
    crashAfter(world, plan.planDigest, stage);

    assertEq(await aRestartedSidecarReadsEverything(world), true,
      `after a crash at "${stage}", a restarted sidecar opens every key`);

    // AND THE JOURNAL SAYS WHERE IT STOPPED, so a resume is the same decision continued.
    assertEq(readRotationJournal(world.stateDir)!.stage, stage, `the journal records "${stage}"`);
  }
});

await test('a crash at EVERY stage RESUMES to a complete rotation, and only then', async () => {
  for (const stage of ROTATION_STAGES) {
    const world = await makeWorld(`resume-${stage}`);
    const plan = planKekRotation(request(world));
    const before = activeKek(loadKekRing(world.stateDir, world.root)).toString('hex');
    crashAfter(world, plan.planDigest, stage);

    const resumed = runKekRotation({ ...request(world), confirmDigest: plan.planDigest }, runnerFor(world));
    assertEq(resumed.ok, true, `a re-run after a crash at "${stage}" completes`);
    assertEq(resumed.stage, 'activated', `reaching activation ("${stage}")`);
    assert(resumed.notes.some((note) => note.includes('RESUMED')), `and says it resumed ("${stage}")`);

    const after = loadKekRing(world.stateDir, world.root);
    assertEq(after.pending, null, `no pending generation is left ("${stage}")`);
    assert(activeKek(after).toString('hex') !== before, `the active key really moved ("${stage}")`);
    assertEq(everyKeyReadsUnder(world, after.active), true, `every key is under it ("${stage}")`);
    assertEq(await aRestartedSidecarReadsEverything(world), true, `and a restart reads everything ("${stage}")`);
    assertEq(readRotationJournal(world.stateDir), null, `the journal is cleared ("${stage}")`);
  }
});

await test('a journal from a DIFFERENT rotation is refused rather than resumed', async () => {
  const world = await makeWorld('foreign-journal');
  const plan = planKekRotation(request(world));
  crashAfter(world, 'f'.repeat(64), 'pending-created');
  refuses(() => runKekRotation({ ...request(world), confirmDigest: plan.planDigest }, runnerFor(world)),
    'a rotation journal from a DIFFERENT rotation', 'a foreign journal');
  assertEq(loadKekRing(world.stateDir, world.root).active, 1, 'and the ring did not move');
});

await test('a pending generation with NO journal is refused, not adopted', async () => {
  // A rotation somebody interrupted and then removed the record of. Guessing which keys are under which
  // generation is guessing at which items are readable.
  const world = await makeWorld('orphan-pending');
  beginPendingGeneration(world.stateDir, world.root);
  refuses(() => planKekRotation(request(world)), 'pending generation and no rotation journal', 'an orphan pending');
});



// ---------------------------------------------------------------------------------------------------------
// Verify-all, idempotence, retirement, the doctor
// ---------------------------------------------------------------------------------------------------------

await test('a key that does NOT read under the new generation stops the rotation before the ring moves', async () => {
  const world = await makeWorld('unverifiable');
  const resolved = planKekRotation(request(world));
  // A key file wrapped under something else entirely — the shape a partial rewrap on a bad disk leaves.
  const foreign = new FileCustodian(join(world.stateDir), SECRET, randomBytes(32));
  void foreign;
  const keysDir = join(world.stateDir, 'keys');
  const { readdirSync } = await import('node:fs');
  const victim = readdirSync(keysDir).filter((f) => f.endsWith('.json'))[0]!;
  const kf = JSON.parse(readFileSync(join(keysDir, victim), 'utf8')) as { wrappedHex: string };
  writeFileSync(join(keysDir, victim), JSON.stringify({ ...kf, wrappedHex: `ff${kf.wrappedHex.slice(2)}` }), 'utf8');

  let threw: unknown = null;
  try {
    runKekRotation({ ...request(world), confirmDigest: resolved.planDigest }, runnerFor(world));
  } catch (err) { threw = err; }
  assert(threw instanceof MaintenanceRefused, `the rotation is refused: ${String(threw)}`);
  assertEq(loadKekRing(world.stateDir, world.root).active, 1, 'and THE RING DID NOT MOVE');
});

await test('a second rotation over a rotated keystore is a no-op, not a second rewrap', async () => {
  const world = await makeWorld('idempotent');
  const first = planKekRotation(request(world));
  const one = runKekRotation({ ...request(world), confirmDigest: first.planDigest }, runnerFor(world));
  assertEq(one.keys.rewrapped, world.keyIds.length, 'the first pass moved every key');

  // The plan digest MOVES with the generation, so a second rotation is a new decision an operator confirms.
  const second = planKekRotation(request(world));
  assert(second.planDigest !== first.planDigest, 'the plan digest moved with the generation');
  assertEq(second.fromGeneration, 2, 'and now rotates away from 2');
  const two = runKekRotation({ ...request(world), confirmDigest: second.planDigest }, runnerFor(world));
  assertEq(two.ok, true, 'a second rotation completes');
  assertEq(loadKekRing(world.stateDir, world.root).active, 3, 'onto generation 3');
  assertEq(everyKeyReadsUnder(world, 3), true, 'with every key under it');
});

await test('retirement is refused against a PRE-rotation backup and allowed against a post-rotation one', async () => {
  const world = await makeWorld('retire');
  const resolved = planKekRotation(request(world));
  runKekRotation({ ...request(world), confirmDigest: resolved.planDigest }, runnerFor(world));

  // The set in `world` was taken BEFORE the rotation: its keystore copy is under generation 1.
  refuses(() => retireKekGeneration({
    stateDir: world.stateDir, rootKeyFile: world.rootFile, backupSet: world.backupSet, generation: 1,
  }), 'taken BEFORE this rotation', 'retiring against a pre-rotation backup');
  assertEq(loadKekRing(world.stateDir, world.root).generations.length, 2, 'and the generation is still there');

  // A backup taken NOW holds keys under the active generation.
  const tools = fakeToolchain({ dumpText: fakeDumpText(schemaVersion()) });
  const after = runVerifiedCompleteBackup({
    projectRoot: world.project, destination: 'backups', setName: 'set-2', custodian: 'sidecar',
    sidecarState: 'sidecar-state', secrets: 'secrets', promotionRecords: 'promotion-records',
  }, { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  assert(after.ok, 'the post-rotation backup verifies');
  const outcome = retireKekGeneration({
    stateDir: world.stateDir, rootKeyFile: world.rootFile,
    backupSet: join(world.project, 'backups', 'set-2'), generation: 1,
  });
  assertEq(outcome.ok, true, 'retirement against a post-rotation backup is allowed');
  assertEq(loadKekRing(world.stateDir, world.root).generations.length, 1, 'and the generation is gone');
});

await test('the doctor says due and overdue as closed words over a real interval', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 1_000 * day;
  assertEq(classifyKekRotationAge(now - 1 * day, now), 'current', 'a fresh key is current');
  assertEq(classifyKekRotationAge(now - (KEK_ROTATION_DUE_DAYS + 1) * day, now), 'due', 'past the due mark it is due');
  assertEq(classifyKekRotationAge(now - (KEK_ROTATION_OVERDUE_DAYS + 1) * day, now), 'overdue', 'and then overdue');
  assertEq(classifyKekRotationAge(0, now), 'unknown', 'and a missing timestamp is unknown, not current');
  assert(KEK_ROTATION_DUE_DAYS < KEK_ROTATION_OVERDUE_DAYS, 'due comes before overdue');
});

await test('no key, path or runtime message reaches a rotation report', async () => {
  const world = await makeWorld('redaction');
  const resolved = planKekRotation(request(world));
  const report = runKekRotation({ ...request(world), confirmDigest: resolved.planDigest }, runnerFor(world));
  const printed = JSON.stringify(report);
  const ring = loadKekRing(world.stateDir, world.root);
  for (const forbidden of [
    world.staticKek.toString('hex'), world.root.toString('hex'), world.root.toString('base64'),
    activeKek(ring).toString('hex'), SECRET, world.stateDir, world.project, WORK,
    ...world.keyIds,
  ]) {
    assert(!printed.includes(forbidden), `the report must not carry ${forbidden.slice(0, 24)}`);
  }
  assert(printed.includes('"stage"'), 'what it DOES carry is the stage');
  assertEq(summarizeKekRing(ring, world.root).rootKeyId.length, 32, 'and a root LABEL, not the root');
  assert(countKeystoreEntries(world.stateDir) > 0, 'and a count of what it moved');
});

await test('the rotation module can issue no media, media-server or acquisition command at all', () => {
  const source = [readRepo('src/ops/kek-rotation.ts'), readRepo('src/ops/kek-ring-cli.ts')].join('\n');
  for (const forbidden of ['jellyfin', 'plex', 'emby', '/mnt/user/media', '.mkv', 'nzb', 'torrent', 'magnet',
    'curl', 'wget', 'docker pull', 'docker login', 'docker push', 'node:http', 'fetch(']) {
    assert(!source.toLowerCase().includes(forbidden.toLowerCase()), `the rotation must not name ${forbidden}`);
  }
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
