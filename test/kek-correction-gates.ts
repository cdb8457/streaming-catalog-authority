import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import {
  KEK_RING_VERSION,
  activeKek,
  adoptStaticKekAsRing,
  initializeKekRing,
  kekForGeneration,
  kekRingPath,
  loadKekRing,
  rootKeyId,
} from '../src/core/crypto/kek-ring.js';
import { readStateDocument, writeStateDocument } from '../src/core/crypto/custodian-state-io.js';
import { validateSidecarHealth } from '../src/core/crypto/local-sidecar-runtime.js';
import { SIDECAR_PROTOCOL_VERSION } from '../src/core/crypto/sidecar-ipc.js';
import { REQUIRED_SECRET_FILES } from '../src/ops/backup-components.js';
import { runVerifiedCompleteBackup } from '../src/ops/complete-backup.js';
import {
  KekRotationFailed,
  planKekRetirement,
  planKekRotation,
  planRootKeyRotation,
  readRotationJournal,
  retireKekGeneration,
  runKekRotation,
  runRootKeyRotation,
} from '../src/ops/kek-rotation.js';
import { main as kekRingMain } from '../src/ops/kek-ring-cli.js';
import { CommandLedger, MaintenanceRefused, type MaintenanceCommand } from '../src/ops/maintenance-safety.js';
import { fakeDumpText, fakeToolchain } from './helpers/fake-toolchain.js';

// The review corrections to Phases 281-284, each held to the defect it closes.
//
// EVERY TEST HERE FAILED AGAINST THE COMMIT BEING CORRECTED. That is the bar: a regression that passes both
// before and after proves the code compiles, not that a defect is gone.
//
//   1. `--root-rotate --plan` MUTATED. The flag whose purpose is "tell me what would happen" re-sealed the
//      ring, and the only warning was the past tense in its output.
//   2. THE MIGRATION NEVER CHECKED THE STATIC KEK. Adopting the wrong one produces a well-formed ring that
//      opens nothing, and an item nothing opens is indistinguishable from a correctly erased one.
//   3. A FAILED SIDECAR STOP LEFT THE APP STOPPED. The quiesce loop sat outside the block whose `finally`
//      restarts, so an operator was told a rotation did not start and not that their stack was down.
//   4. RETIREMENT SKIPPED ITS WHOLE PROOF when the set had no keystore — the one set that cannot restore a
//      custodian at all.
//   5. A JOURNAL WAS TRUSTED. `verified` skipped the check that makes activation safe.
//   6. HEALTH WAS READ FIELD BY FIELD as far as the ones that matched.

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
const WORK = mkdtempSync(join(tmpdir(), 'ca-kek-corrections-'));
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

function schemaVersion(): number {
  return Number(/MIGRATION_VERSION\s*=\s*([0-9]+)/.exec(readRepo('src/db/schema-version.ts'))![1]);
}

async function makeWorld(
  name: string,
  options: { migrate?: boolean; keys?: number; mismatchedBackupRoot?: boolean } = {},
): Promise<World> {
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
  for (let index = 0; index < (options.keys ?? 3); index += 1) {
    const provision = await custodian.provision(`op-${index}`, `item-${index}`, 0);
    await custodian.commitProvision(`op-${index}`);
    keyIds.push(provision.keyId);
  }

  const root = randomBytes(32);
  const rootFile = join(project, 'root_wrapping_key');
  writeFileSync(rootFile, `${root.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  // The copy of the root key that lands in the BACKUP. Deliberately not the sealing one for the mismatched
  // case, so the resulting set verifies against its own manifest and still cannot open the ring beside it.
  writeFileSync(join(project, 'secrets', 'custodian_root_key'),
    `${(options.mismatchedBackupRoot === true ? randomBytes(32) : root).toString('hex')}\n`,
    { encoding: 'utf8', mode: 0o600 });
  if (POSIX) chmodSync(rootFile, 0o600);
  if (options.migrate !== false) adoptStaticKekAsRing(stateDir, root, staticKek, () => 1_000);

  const tools = fakeToolchain({ dumpText: fakeDumpText(schemaVersion()) });
  const outcome = runVerifiedCompleteBackup({
    projectRoot: project, destination: 'backups', setName: 'set-1', custodian: 'sidecar',
    sidecarState: 'sidecar-state', secrets: 'secrets', promotionRecords: 'promotion-records',
  }, { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  assert(outcome.ok, `the world's backup verifies: ${JSON.stringify(outcome.failures)}`);
  return { project, stateDir, rootFile, root, staticKek, backupSet: join(project, 'backups', 'set-1'), keyIds };
}

function rotationRequest(world: World) {
  return {
    stateDir: world.stateDir,
    rootKeyFile: world.rootFile,
    backupSet: world.backupSet,
    projectRoot: world.project,
    projectName: 'catalogauthority-local',
  };
}

function runnerFor(options: { failOn?: (command: MaintenanceCommand) => boolean } = {}) {
  const ledger = new CommandLedger();
  const runner = (command: MaintenanceCommand) => ({
    status: options.failOn?.(command) === true ? 1 : 0,
    stdout: '',
    stderr: '',
  });
  return { runner, ledger };
}

function keyFileFor(world: World, root = world.root): Buffer {
  const ring = loadKekRing(world.stateDir, root);
  return activeKek(ring);
}

console.log('Running the Phases 281-284 review-correction gates:\n');

// ---------------------------------------------------------------------------------------------------------
// 1. A plan changes nothing
// ---------------------------------------------------------------------------------------------------------

await test('root rotation PLANS without mutating, and refuses a wrong, missing or stale confirmation', async () => {
  // THE DEFECT: `--root-rotate --plan` called the re-seal directly. Planning had already done it.
  const world = await makeWorld('root-plan');
  const newRootFile = join(world.project, 'next_root');
  const newRoot = randomBytes(32);
  writeFileSync(newRootFile, `${newRoot.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  if (POSIX) chmodSync(newRootFile, 0o600);
  const request = {
    stateDir: world.stateDir,
    rootKeyFile: world.rootFile,
    newRootKeyFile: newRootFile,
    backupSet: world.backupSet,
  };
  const before = readStateDocument<Record<string, string>>(kekRingPath(world.stateDir))!;

  const planned = planRootKeyRotation(request);
  // NOTHING MOVED. The sealed bytes are the same and the OLD root still opens the ring.
  const afterPlan = readStateDocument<Record<string, string>>(kekRingPath(world.stateDir))!;
  assertEq(JSON.stringify(afterPlan), JSON.stringify(before), 'planning left the sealed ring byte for byte');
  assertEq(loadKekRing(world.stateDir, world.root).active, 1, 'and the OLD root still opens it');

  // AND SO DOES THE CLI PATH, which is where the defect actually lived.
  const exit = kekRingMain(['rotate', '--state', world.stateDir, '--root-file', world.rootFile,
    '--root-rotate', '--new-root-file', newRootFile, '--backup-set', world.backupSet, '--plan']);
  assertEq(exit, 0, 'the CLI plan succeeds');
  assertEq(JSON.stringify(readStateDocument<Record<string, string>>(kekRingPath(world.stateDir))!),
    JSON.stringify(before), 'and the CLI plan ALSO changed nothing');
  assertEq(loadKekRing(world.stateDir, world.root).active, 1, 'the old root still opens the ring after --plan');

  // WRONG AND MISSING CONFIRMATIONS DO NOTHING.
  refuses(() => runRootKeyRotation({ ...request, confirmDigest: null }), 'digest you confirmed', 'no confirmation');
  refuses(() => runRootKeyRotation({ ...request, confirmDigest: 'f'.repeat(64) }), 'digest you confirmed',
    'a wrong confirmation');
  assertEq(loadKekRing(world.stateDir, world.root).active, 1, 'and neither moved the ring');

  // A STALE ONE DOES NOTHING EITHER: the digest binds the generation, so a rotation in between invalidates it.
  const rotated = runKekRotation({ ...rotationRequest(world), confirmDigest: planKekRotation(rotationRequest(world)).planDigest }, runnerFor());
  assertEq(rotated.ok, true, 'a KEK rotation happens in between');
  refuses(() => runRootKeyRotation({ ...request, confirmDigest: planned.planDigest }), 'digest you confirmed',
    'a confirmation from before the ring moved');

  // AND THE REAL THING WORKS, re-sealing without re-wrapping.
  const fresh = planRootKeyRotation(request);
  const report = runRootKeyRotation({ ...request, confirmDigest: fresh.planDigest });
  assertEq(report.ok, true, 'a confirmed re-seal succeeds');
  assertEq(report.ringUnchanged, true, 'and proves the new root opens the EXACT ring');
  refuses(() => loadKekRing(world.stateDir, world.root), 'DIFFERENT root wrapping key', 'the old root afterwards');
  const after = loadKekRing(world.stateDir, newRoot);
  assertEq(after.active, rotated.toGeneration!, 'the generation is untouched');
  assertEq(JSON.stringify(report).includes(newRoot.toString('hex')), false, 'and no key is in the report');
});

// ---------------------------------------------------------------------------------------------------------
// 2. The migration proves the key it adopts
// ---------------------------------------------------------------------------------------------------------

await test('migration refuses a static KEK that does not open the live keystore', async () => {
  // THE DEFECT: nothing checked. Adopting the wrong key produces a well-formed ring that opens NOTHING, and
  // an item nothing can open is indistinguishable from a correctly erased one — so the installation would
  // look empty rather than broken, and the migration would have reported success.
  const world = await makeWorld('migrate-wrong-key', { migrate: false });
  const wrongFile = join(world.project, 'wrong_static');
  writeFileSync(wrongFile, `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });

  const argv = (staticFile: string, extra: string[]) => ['migrate', '--state', world.stateDir,
    '--root-file', world.rootFile, '--static-file', staticFile, '--backup-set', world.backupSet, ...extra];

  // The plan prints a digest for either key — it is the ADOPTION that must refuse.
  const planExit = kekRingMain(argv(wrongFile, ['--plan']));
  assertEq(planExit, 0, 'a plan is printed');
  assertEq(readdirSync(world.stateDir).includes('ring'), false, 'and the plan wrote no ring');

  // THE DIGEST THE COMMAND ITSELF PRINTED. Recomputing it beside the CLI would be this suite asserting
  // against its own arithmetic rather than against what an operator would actually copy.
  const digestFor = (staticFile: string): string => {
    const printed: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => { printed.push(parts.join(' ')); };
    try {
      kekRingMain(argv(staticFile, ['--plan']));
    } finally {
      console.log = original;
    }
    const line = printed.find((entry) => entry.startsWith('plan digest: '));
    assert(line !== undefined, `the plan printed a digest: ${printed.join(' | ')}`);
    return line!.slice('plan digest: '.length).trim();
  };
  const wrongExit = kekRingMain(argv(wrongFile, ['--confirm-digest', digestFor(wrongFile)]));
  assertEq(wrongExit, 3, 'adopting the WRONG static KEK is refused');
  assertEq(readdirSync(world.stateDir).includes('ring'), false, 'and NO RING WAS WRITTEN');

  // The right key still works, and the keys really do open afterwards.
  const rightFile = join(world.project, 'right_static');
  writeFileSync(rightFile, `${world.staticKek.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  assertEq(kekRingMain(argv(rightFile, ['--confirm-digest', digestFor(rightFile)])), 0, 'the right key is adopted');
  const ring = loadKekRing(world.stateDir, world.root);
  assertEq(activeKek(ring).toString('hex'), world.staticKek.toString('hex'), 'as generation 1');
  const custodian = new FileCustodian(world.stateDir, SECRET, activeKek(ring));
  assertEq((await custodian.get(world.keyIds[0]!, 0)).length, 32, 'and the live keys open under it');
});

// ---------------------------------------------------------------------------------------------------------
// 3. The quiesce unwind, and both facts of a dual failure
// ---------------------------------------------------------------------------------------------------------

await test('a sidecar stop that fails RESTARTS the app it already stopped', async () => {
  // THE DEFECT: the quiesce loop sat OUTSIDE the block whose `finally` restarts. Stopping `app` succeeded,
  // stopping `sidecar` failed, and the app was left down by a command that reported a refusal about the
  // sidecar and changed nothing. An operator was told a rotation did not start.
  const world = await makeWorld('unwind');
  const plan = planKekRotation(rotationRequest(world));
  const tools = runnerFor({ failOn: (c) => c.args.includes('stop') && c.args.includes('sidecar') });
  refuses(() => runKekRotation({ ...rotationRequest(world), confirmDigest: plan.planDigest }, tools),
    'could not be stopped', 'a sidecar that will not stop');
  const lines = tools.ledger.all().map((entry) => entry.args.join(' '));
  assert(lines.includes('compose -p catalogauthority-local stop app'), 'the app was stopped');
  assert(lines.includes('compose -p catalogauthority-local start app'), 'AND THE APP WAS STARTED AGAIN');
  assertEq(loadKekRing(world.stateDir, world.root).active, 1, 'and the ring did not move');
});

await test('a failure whose restart ALSO fails carries both facts', async () => {
  const world = await makeWorld('dual-failure');
  const plan = planKekRotation(rotationRequest(world));
  // The sidecar will not stop, and once the app has been stopped it will not start again either.
  const tools = runnerFor({
    failOn: (c) => (c.args.includes('stop') && c.args.includes('sidecar'))
      || (c.args.includes('start') && c.args.includes('app')),
  });
  let caught: unknown = null;
  try {
    runKekRotation({ ...rotationRequest(world), confirmDigest: plan.planDigest }, tools);
  } catch (err) { caught = err; }
  assert(caught instanceof KekRotationFailed, `a dual failure is its own kind: ${String(caught)}`);
  const failure = caught as KekRotationFailed;
  assert(failure.primary.includes('could not be stopped'), `the primary refusal is preserved: ${failure.primary}`);
  assert(failure.message.includes('THE STACK IS STILL DOWN'), 'and the outage is named');
  assertEq(failure.stillStopped.join(','), 'app', 'with the service that did not come back');
  for (const forbidden of [world.root.toString('hex'), world.staticKek.toString('hex'), SECRET, world.stateDir]) {
    assert(!failure.message.includes(forbidden), 'and it carries no key or path');
  }
});

// ---------------------------------------------------------------------------------------------------------
// 4. Retirement never skips its proof
// ---------------------------------------------------------------------------------------------------------

await test('retirement refuses a backup with no keystore instead of silently skipping the proof', async () => {
  // THE DEFECT: the whole proof was inside `if (existsSync(staged))`. A set with no keystore — precisely the
  // set that cannot restore a custodian — skipped it and retired the generation on the strength of the set
  // merely verifying.
  const world = await makeWorld('retire-no-keystore');
  const plan = planKekRotation(rotationRequest(world));
  runKekRotation({ ...rotationRequest(world), confirmDigest: plan.planDigest }, runnerFor());

  // A SET THAT VERIFIES PERFECTLY AND WHOSE KEYSTORE HOLDS NO RING. It is exactly what a backup of a
  // pre-migration installation looks like, and the old code's `if (existsSync(staged))` guard is what let a
  // set like this reach the removal at all.
  const preMigration = await makeWorld('retire-pre-migration', { migrate: false });
  refuses(() => planKekRetirement({
    stateDir: world.stateDir, rootKeyFile: world.rootFile, backupSet: preMigration.backupSet, generation: 1,
  }), 'does not open the ring inside it', 'a set whose keystore holds no ring');
  assertEq(loadKekRing(world.stateDir, world.root).generations.length, 2, 'and nothing was removed');

  // AND THE PROOF IS NOT INSIDE AN EXISTENCE GUARD ANY MORE. The missing-keystore case is its own refusal
  // rather than a branch that skips everything.
  const source = readRepo('src/ops/kek-rotation.ts');
  assert(source.includes('holds no keystore component'), 'a missing keystore is its own refusal');
  assert(!/if (existsSync(staged)) {/.test(source), 'and the proof is no longer wrapped in an existence guard');

  // A SET WHOSE OWN ROOT KEY DOES NOT OPEN ITS OWN RING. Built by taking a real backup of a project whose
  // secrets copy of the root key is not the one sealing the ring — so the set VERIFIES against its own
  // manifest and is still unusable. Tampering with a published set instead would only prove the verification
  // works, which is a different check and one that already has its own test.
  const mismatched = await makeWorld('retire-mismatched-root', { mismatchedBackupRoot: true });
  // Rotated, so there IS a retained generation to ask about — otherwise the "cannot retire the active one"
  // rule fires first and the proof under test is never reached.
  const mismatchedPlan = planKekRotation(rotationRequest(mismatched));
  runKekRotation({ ...rotationRequest(mismatched), confirmDigest: mismatchedPlan.planDigest }, runnerFor());
  refuses(() => planKekRetirement({
    stateDir: mismatched.stateDir, rootKeyFile: mismatched.rootFile,
    backupSet: mismatched.backupSet, generation: 1,
  }), 'does not open the ring inside it', 'a set whose root does not open its ring');
  assertEq(loadKekRing(world.stateDir, world.root).generations.length, 2, 'and still nothing was removed');
});

// ---------------------------------------------------------------------------------------------------------
// 5. A journal is a claim, not a fact
// ---------------------------------------------------------------------------------------------------------

await test('a forged journal claiming "verified" does not skip the verification', async () => {
  // THE DEFECT: a resumed run took the journal's stage at face value, so a journal saying `verified` skipped
  // the one check that makes activation safe — proving every live key reads under the new generation.
  const world = await makeWorld('forged-journal');
  const plan = planKekRotation(rotationRequest(world));
  // A pending generation exists and NOTHING has been rewrapped onto it, but the journal claims otherwise.
  const { beginPendingGeneration } = await import('../src/core/crypto/kek-ring.js');
  const pending = beginPendingGeneration(world.stateDir, world.root, () => 2_000);
  writeStateDocument(join(world.stateDir, 'ring', 'rotation-journal.json'), {
    rotation: 'phase-283-kek-rotation',
    version: 1,
    planDigest: plan.planDigest,
    fromGeneration: 1,
    toGeneration: pending.generation,
    stage: 'verified',
    startedAt: 1,
  });
  const resumed = runKekRotation({ ...rotationRequest(world), confirmDigest: plan.planDigest }, runnerFor());
  // The claim was reconciled away and the work was actually done.
  assertEq(resumed.ok, true, 'the resumed run completed');
  assert(resumed.notes.some((n) => n.includes('claimed a later stage')), 'and says the journal overclaimed');
  assertEq(resumed.keys.rewrapped, world.keyIds.length, 'having really rewrapped every key');
  const ring = loadKekRing(world.stateDir, world.root);
  const custodian = new FileCustodian(world.stateDir, SECRET, kekForGeneration(ring, ring.active));
  for (const keyId of world.keyIds) assertEq((await custodian.get(keyId, 0)).length, 32, 'every key opens');
});

await test('a journal with an unknown field, a bad digest or a zero timestamp is refused', async () => {
  const world = await makeWorld('journal-schema');
  const base = {
    rotation: 'phase-283-kek-rotation', version: 1, planDigest: 'a'.repeat(64),
    fromGeneration: 1, toGeneration: 2, stage: 'claimed', startedAt: 1,
  };
  const path = join(world.stateDir, 'ring', 'rotation-journal.json');
  writeStateDocument(path, base);
  assert(readRotationJournal(world.stateDir) !== null, 'a well-formed journal reads');
  for (const [what, doc] of [
    ['an unknown field', { ...base, somethingElse: 1 }],
    ['a digest that is not one', { ...base, planDigest: 'not-a-digest' }],
    ['a zero timestamp', { ...base, startedAt: 0 }],
    ['a generation that is not one', { ...base, fromGeneration: 0 }],
    ['a stage this build does not know', { ...base, stage: 'whatever' }],
  ] as Array<[string, unknown]>) {
    writeStateDocument(path, doc);
    refuses(() => readRotationJournal(world.stateDir), 'journal', what);
  }
});

// ---------------------------------------------------------------------------------------------------------
// 6. Health, the ring schema, and the writer lock
// ---------------------------------------------------------------------------------------------------------

await test('a health answer is validated field by field, with no extras and no contradictions', () => {
  const good = {
    op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: true,
    custodian: 'sidecar-managed-ring', ringGeneration: 2, ringActiveCreatedAt: 1_700_000_000_000,
  };
  assert(validateSidecarHealth(good) !== null, 'a well-formed answer is accepted');
  assert(validateSidecarHealth({ ...good, custodian: 'file-reference-harness', ringGeneration: null, ringActiveCreatedAt: null }) !== null,
    'and so is a deployment with no ring');
  for (const [what, doc] of [
    ['an extra field', { ...good, extra: 1 }],
    ['a missing field', { op: 'health', protocol: 1, ready: true, custodian: 'sidecar-managed-ring', ringGeneration: 1 }],
    ['a protocol this build does not know', { ...good, protocol: 99 }],
    ['a custodian word this build does not know', { ...good, custodian: 'something-else' }],
    ['ready that is not true', { ...good, ready: false }],
    // THE CONTRADICTION: a timestamp beside a null generation, or a zero timestamp the age check would read
    // as the epoch and call five decades overdue.
    ['a timestamp with no generation', { ...good, ringGeneration: null }],
    ['a zero timestamp', { ...good, ringActiveCreatedAt: 0 }],
    ['a generation of zero', { ...good, ringGeneration: 0 }],
    ['an array', []],
    ['a null', null],
  ] as Array<[string, unknown]>) {
    assertEq(validateSidecarHealth(doc), null, `${what} is refused`);
  }
});

await test('the ring envelope and the ring itself are closed and bounded', async () => {
  const world = await makeWorld('ring-schema');
  const path = kekRingPath(world.stateDir);
  const sealed = readStateDocument<Record<string, unknown>>(path)!;
  for (const [what, doc] of [
    ['an unknown envelope field', { ...sealed, somethingElse: 1 }],
    ['a nonce that is not 12 bytes', { ...sealed, nonceHex: 'ab' }],
    ['a tag that is not 16 bytes', { ...sealed, tagHex: 'ab' }],
    ['a root label that is not one', { ...sealed, rootKeyId: 'short' }],
  ] as Array<[string, unknown]>) {
    writeStateDocument(path, doc);
    refuses(() => loadKekRing(world.stateDir, world.root), 'envelope', what);
  }
  // ...and the INNER ring, re-sealed honestly so the failure is structural rather than a tag failure.
  const reseal = (mutate: (ring: Record<string, unknown>) => Record<string, unknown>): void => {
    writeStateDocument(path, sealed);
    const ring = loadKekRing(world.stateDir, world.root) as unknown as Record<string, unknown>;
    const label = rootKeyId(world.root);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', world.root, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(['catalog-authority.kek-ring', KEK_RING_VERSION, label]), 'utf8'));
    const ct = Buffer.concat([cipher.update(JSON.stringify(mutate(ring)), 'utf8'), cipher.final()]);
    writeStateDocument(path, {
      document: 'catalog-authority.kek-ring', version: KEK_RING_VERSION, rootKeyId: label,
      nonceHex: nonce.toString('hex'), ciphertextHex: ct.toString('hex'), tagHex: cipher.getAuthTag().toString('hex'),
    });
  };
  for (const [what, mutate, needle] of [
    ['an unknown ring field', (r: Record<string, unknown>) => ({ ...r, somethingElse: 1 }), 'field this build does not know'],
    ['two active generations', (r: Record<string, unknown>) => ({
      ...r,
      generations: [...(r.generations as Array<Record<string, unknown>>),
        { ...(r.generations as Array<Record<string, unknown>>)[0]!, generation: 9, state: 'active' }],
    }), 'exactly one active generation'],
    ['a zero timestamp', (r: Record<string, unknown>) => ({
      ...r,
      generations: (r.generations as Array<Record<string, unknown>>).map((g) => ({ ...g, createdAt: 0 })),
    }), 'no usable timestamp'],
    ['a ring with no created time', (r: Record<string, unknown>) => ({ ...r, createdAt: 0 }), 'no usable created time'],
  ] as Array<[string, (r: Record<string, unknown>) => Record<string, unknown>, string]>) {
    reseal(mutate);
    refuses(() => loadKekRing(world.stateDir, world.root), needle, what);
  }
});

await test('the writer lock is TAKEN by the thing that writes the ring, not merely available', async () => {
  // THE DEFECT: `acquireStateLock` existed and nothing called it, so "single-writer" was a property of a
  // helper nobody used. Every ring mutation goes through `storeRing`, so the lock is taken there.
  const world = await makeWorld('writer-lock');
  const { acquireStateLock } = await import('../src/core/crypto/custodian-state-io.js');
  const held = acquireStateLock(join(world.stateDir, 'ring'), '.kek-ring-writer.lock');
  try {
    const { beginPendingGeneration } = await import('../src/core/crypto/kek-ring.js');
    refuses(() => beginPendingGeneration(world.stateDir, world.root), 'another writer holds',
      'a ring mutation while another writer holds the lock');
  } finally {
    held.release();
  }
  // Released, the same mutation succeeds — so the refusal was the lock and not the operation.
  const { beginPendingGeneration } = await import('../src/core/crypto/kek-ring.js');
  assertEq(beginPendingGeneration(world.stateDir, world.root).generation, 2, 'and it works once released');
});

await test('a state document is written in full even when the write returns short', () => {
  // The loop exists for a short `writeSync`; this proves the round trip is exact for a document large enough
  // that a single write is not guaranteed.
  const dir = join(WORK, 'partial-write');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'big.json');
  const doc = { blob: 'x'.repeat(512 * 1024) };
  writeStateDocument(path, doc);
  assertEq(JSON.stringify(readStateDocument(path)), JSON.stringify(doc), 'a large document round-trips exactly');
  assert(readRepo('src/core/crypto/custodian-state-io.ts').includes('while (written < bytes.byteLength)'),
    'and the writer loops rather than trusting one call');
});

// ---------------------------------------------------------------------------------------------------------
// 7. The shipped transition is actually runnable
// ---------------------------------------------------------------------------------------------------------

await test('the setup script writes the root key owner-only and the stack mounts it owner-only', () => {
  // THE DEFECT: setup wrote `custodian_root_key` 0644 while the reader refuses ANY group or other bit, and
  // Compose's short syntax mounts a secret 0444 root-owned. The shipped stack could not have started.
  for (const script of ['deploy/local-runtime-setup.sh', 'deploy/arcane-setup.sh']) {
    const text = readRepo(script);
    assert(/SECRET_MODE_CUSTODY=600/.test(text), `${script} declares an owner-only custody mode`);
    assert(text.includes('write_secret_if_absent custodian_root_key "$(random_secret)" "${SECRET_MODE_CUSTODY}"'),
      `${script} writes the root key owner-only, not with the app mode`);
    assert(!text.includes('write_secret_if_absent custodian_root_key "$(random_secret)" "${SECRET_MODE_APP}"'),
      `${script} no longer writes it world-readable`);
  }
  const stack = readRepo('docker-compose.unraid.runtime.yml');
  // LONG SYNTAX, so the mode inside the container is owner-only for the user the image runs as.
  assert(/- source: custodian_root_key/.test(stack), 'the stack mounts the root key in long syntax');
  assert(/mode: 0400/.test(stack), 'with an owner-read mode');
  assert(/uid: "1000"/.test(stack) && /gid: "1000"/.test(stack), 'owned by the non-root user the image runs as');
  assert(readRepo(['Dockerfile', 'runtime'].join('.')).includes('USER node'),
    'which is the non-root user the runtime image actually declares');
  // AND THE READER STILL REFUSES A LOOSE MODE — the fix is the mount, not a weakened check.
  const reader = readRepo('src/core/crypto/kek-ring.ts');
  assert(reader.includes('(stats.mode & 0o077) !== 0'), 'the reader still requires owner-only');
});

await test('a root key file the setup script would produce is accepted by the reader it feeds', async () => {
  if (!POSIX) { console.log('        (POSIX-only: modes are not a concept here)'); return; }
  // END TO END, with the modes the corrected pipeline actually produces: 0600 on the host, 0400 in the
  // container. Both are owner-only, so both are accepted; 0644 — what setup used to write — is not.
  const { readRootWrappingKey } = await import('../src/core/crypto/kek-ring.js');
  const dir = join(WORK, 'reader-compat');
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  for (const mode of [0o600, 0o400]) {
    const path = join(dir, `key-${mode.toString(8)}`);
    writeFileSync(path, `${key.toString('hex')}\n`, { encoding: 'utf8', mode });
    chmodSync(path, mode);
    assertEq(readRootWrappingKey(path).toString('hex'), key.toString('hex'), `mode 0${mode.toString(8)} is read`);
  }
  const loose = join(dir, 'key-644');
  writeFileSync(loose, `${key.toString('hex')}\n`, { encoding: 'utf8', mode: 0o644 });
  chmodSync(loose, 0o644);
  refuses(() => readRootWrappingKey(loose), 'readable by somebody other than its owner', 'the old 0644 mode');
});

// ---------------------------------------------------------------------------------------------------------
// 8. The invariant, still
// ---------------------------------------------------------------------------------------------------------

await test('the corrections reach no network, media server or acquisition system', () => {
  for (const file of ['src/ops/kek-rotation.ts', 'src/ops/kek-ring-cli.ts', 'src/core/crypto/kek-ring.ts',
    'src/core/crypto/custodian-state-io.ts', 'src/core/crypto/local-sidecar-runtime.ts']) {
    const source = readRepo(file).toLowerCase();
    for (const forbidden of ['jellyfin', 'plex', 'emby', '/mnt/user/media', '.mkv', 'nzb', 'torrent', 'magnet',
      'usenet', 'sabnzbd', 'curl ', 'wget ', 'node:http', 'fetch(']) {
      assert(!source.includes(forbidden), `${file} must not name ${forbidden}`);
    }
  }
  for (const file of ['src/ops/kek-rotation.ts', 'src/ops/kek-ring-cli.ts', 'src/core/crypto/kek-ring.ts',
    'src/core/crypto/custodian-state-io.ts', 'src/core/crypto/sidecar-ipc.ts']) {
    const bytes = readFileSync(join(repoRoot, file));
    let control = 0;
    for (const byte of bytes) if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) control += 1;
    assertEq(control, 0, `${file} carries no literal control byte`);
  }
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
