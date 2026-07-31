import {
  chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import {
  KEK_RING_VERSION,
  RingMovedUnderReSeal,
  RootReSealFailed,
  activeKek,
  adoptStaticKekAsRing,
  beginPendingGeneration,
  decodeKey,
  initializeKekRing,
  kekForGeneration,
  kekRingPath,
  loadKekRing,
  rootKeyId,
  rotateRootWrappingKey,
  wholeRingDigest,
} from '../src/core/crypto/kek-ring.js';
import {
  readStateDocument, stateDirectoryIdentity, writeStateDocument,
} from '../src/core/crypto/custodian-state-io.js';
import { validateSidecarHealth } from '../src/core/crypto/local-sidecar-runtime.js';
import { SIDECAR_PROTOCOL_VERSION } from '../src/core/crypto/sidecar-ipc.js';
import { REQUIRED_SECRET_FILES } from '../src/ops/backup-components.js';
import { runVerifiedCompleteBackup } from '../src/ops/complete-backup.js';
import {
  KekRotationFailed,
  ROTATION_LOCK_DIRNAME,
  countKeystoreEntries,
  keystoreSetDigest,
  planKekMigration,
  planKekRetirement,
  planKekRotation,
  planRootKeyRotation,
  proveBackupRestoresCustody,
  readRotationJournal,
  retireKekGeneration,
  runKekMigration,
  runKekRotation,
  runRootKeyRotation,
} from '../src/ops/kek-rotation.js';
import { main as kekRingMain } from '../src/ops/kek-ring-cli.js';
import { CommandLedger, MaintenanceRefused, type MaintenanceCommand } from '../src/ops/maintenance-safety.js';
import { fakeDumpText, fakeToolchain } from './helpers/fake-toolchain.js';
import { asMap, parseYaml } from '../src/ops/minimal-yaml.js';
import {
  callSites,
  code as shellCode,
  functionBody,
  parseShellSource,
  textOf as shellText,
} from './helpers/shell-source.js';

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

  return { project, stateDir, rootFile, root, staticKek, backupSet: takeBackup(project, 'set-1'), keyIds };
}

/** A complete backup of a world, verified, at a named set. Returns where it landed. */
function takeBackup(project: string, setName: string): string {
  const tools = fakeToolchain({ dumpText: fakeDumpText(schemaVersion()) });
  const outcome = runVerifiedCompleteBackup({
    projectRoot: project, destination: 'backups', setName, custodian: 'sidecar',
    sidecarState: 'sidecar-state', secrets: 'secrets', promotionRecords: 'promotion-records',
  }, { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  assert(outcome.ok, `the backup at ${setName} verifies: ${JSON.stringify(outcome.failures)}`);
  return join(project, 'backups', setName);
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

  // THE PLAN ITSELF NOW REFUSES IT, which is stricter than this suite originally demanded. The first version
  // let `--plan` print a digest for any key and refused at the adoption; a plan is a statement that an
  // operation would work, so issuing one for an adoption that cannot is issuing a plan that is wrong. The
  // property under test is unchanged and is checked twice below: the wrong key never becomes a ring.
  const planExit = kekRingMain(argv(wrongFile, ['--plan']));
  assertEq(planExit, 3, 'planning a migration onto the WRONG static KEK is refused');
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
  // AND SO DOES THE ADOPTION, whatever digest is presented with it — including the one belonging to the plan
  // for the RIGHT key, which is the closest thing to a usable confirmation an operator could hold.
  const rightFile = join(world.project, 'right_static');
  writeFileSync(rightFile, `${world.staticKek.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  const rightDigest = digestFor(rightFile);
  for (const [what, digest] of [['a digest that is not this plan\'s', 'a'.repeat(64)],
    ['the digest of the plan for the RIGHT key', rightDigest]] as Array<[string, string]>) {
    assertEq(kekRingMain(argv(wrongFile, ['--confirm-digest', digest])), 3,
      `adopting the WRONG static KEK is refused with ${what}`);
    assertEq(readdirSync(world.stateDir).includes('ring'), false, 'and NO RING WAS WRITTEN');
  }

  // The right key still works, and the keys really do open afterwards.
  assertEq(kekRingMain(argv(rightFile, ['--confirm-digest', rightDigest])), 0, 'the right key is adopted');
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

await test('the root key is delivered by a bind mount, because a Compose secret cannot carry ownership', () => {
  // THE DEFECT THIS REPLACES, AND IT WAS A FALSE PROOF OF MY OWN MAKING. A previous version declared the root
  // key as a LONG-SYNTAX Compose secret with `uid`, `gid` and `mode`, and asserted those fields were present
  // — while OUTSIDE SWARM Compose implements a `file:` secret as a BIND MOUNT and IGNORES all three. The
  // test passed, the YAML matched, and the guarantee did not exist. Matching YAML is not proof of a runtime
  // property; what follows asserts the mechanism that actually carries ownership.
  const stack = readRepo('docker-compose.unraid.runtime.yml');
  assert(!/uid: "1000"/.test(stack) && !/mode: 0400/.test(stack),
    'the stack makes no long-syntax uid/gid/mode claim, because Compose would ignore it here');
  const doc = parseYaml(stack);
  const services = asMap(doc.services ?? null, 'services');
  const sidecar = asMap(services.sidecar ?? null, 'sidecar');
  // THE SIDECAR GETS IT AS A READ-ONLY BIND, whose host ownership and mode carry through unchanged.
  const mounts = JSON.stringify(sidecar.volumes ?? []);
  assert(mounts.includes('/secrets/custodian_root_key:/run/catalog-custody/custodian_root_key:ro'),
    `the sidecar binds the root key read-only: ${mounts}`);
  assert(!JSON.stringify(sidecar.secrets ?? []).includes('custodian_root_key'),
    'and does NOT take it through the secret mechanism that cannot carry ownership');
  // AND NOTHING ELSE CAN REACH IT — no mount and no secret entry, in any other service.
  for (const name of ['app', 'migrate', 'ops', 'postgres']) {
    const service = services[name] === undefined ? {} : asMap(services[name]!, name);
    const wired = `${JSON.stringify(service.volumes ?? [])}${JSON.stringify(service.secrets ?? [])}`;
    assert(!wired.includes('custodian_root_key'), `${name} has no path to the root key`);
  }
  // THE HOST SIDE IS WHERE THE GUARANTEE LIVES, and the setup script FAILS rather than continuing if it
  // cannot establish it. No best-effort chown for custody.
  for (const script of ['deploy/local-runtime-setup.sh', 'deploy/arcane-setup.sh']) {
    const source = parseShellSource(readRepo(script), script);
    const text = readRepo(script);
    assert(callSites(source, 'write_custody_secret').some((call) => call[1] === 'custodian_root_key'),
      `${script} writes the root key through the custody helper`);
    // AND IT DELEGATES TO A DESCRIPTOR-BASED HELPER, not to a sequence of path operations. A shell version
    // resolved the name at every step — check, redirect, chmod, chown, stat — and a swap between any two of
    // them would have had root re-mode and overwrite whatever the name then pointed at.
    assert(text.includes('write-custody-secret.mjs'), `${script} delegates to the no-follow helper`);
    // BRACE-MATCHED, NOT SLICED TO THE NEXT `\n}\n` (Phase 329). The literal below used to be a bare LF
    // sandwiched around a closing brace. On a CRLF checkout it never matched, `indexOf` answered -1,
    // `slice(0, -1)` handed back THE REST OF THE FILE, and the region searched for `chmod` ran on past this
    // helper into `write_secret_if_absent` — which chmods ordinary app secrets, legitimately and by design.
    // The gate then reported a custody violation that did not exist, in four consecutive release baselines.
    // The extractor now matches braces and REFUSES if the function is missing or never closed, so the only
    // outcomes are the right region or a named error; there is no silent wrong region left to get.
    const helperBody = shellText(shellCode({
      path: script, lines: functionBody(source, 'write_custody_secret'),
    }).lines);
    assert(!/\bchmod\b/.test(helperBody) && !/\bchown\b/.test(helperBody) && !/\bstat\b/.test(helperBody),
      `${script} performs no path-based mode, owner or stat operation for custody: ${helperBody}`);
    // AND THE CONTRAST THAT PROVES THE REGION WAS REALLY THE HELPER'S. `write_secret_if_absent` in the same
    // script DOES chmod, correctly, because an operator token is not a root wrapping key. An empty region and
    // a region with no chmod in it read identically to the assertion above; this tells them apart, so a future
    // extractor that quietly returns nothing fails here instead of passing everywhere.
    const ordinary = shellText(functionBody(source, 'write_secret_if_absent'));
    assert(/\bchmod\b/.test(ordinary),
      `${script}: the ordinary-secret writer is the one that chmods, so the custody region above was real`);
    assert(text.includes('refusing.'), `${script} says it is refusing rather than continuing`);
  }
  // AND THE READER STILL REQUIRES OWNER-ONLY — the fix is the delivery mechanism, not a weakened check.
  assert(readRepo('src/core/crypto/kek-ring.ts').includes('(stats.mode & 0o077) !== 0'),
    'the reader still refuses any group or other bit');
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

await test('the writer lock spans the whole read-modify-write, not just the write', async () => {
  // THE DEFECT: the lock was taken INSIDE the store. Every ring mutation is load -> decide -> store, so two
  // processes could each load the same ring, each decide, and each store — the second silently discarding the
  // first. Two well-formed writes, no corruption a digest catches, and one generation gone.
  const world = await makeWorld('rmw-lock');
  const { acquireStateLock } = await import('../src/core/crypto/custodian-state-io.js');
  const ringModule = await import('../src/core/crypto/kek-ring.js');
  const ringDir = join(world.stateDir, 'ring');

  // A competing writer holds the lock. EVERY mutating operation must refuse — including the ones whose
  // decision is taken from a ring they loaded, which is the whole point.
  const held = acquireStateLock(ringDir, ringModule.KEK_RING_WRITER_LOCK);
  try {
    refuses(() => ringModule.beginPendingGeneration(world.stateDir, world.root), 'another writer holds', 'beginPending');
    refuses(() => ringModule.activatePendingGeneration(world.stateDir, world.root), 'another writer holds', 'activate');
    refuses(() => ringModule.retireGeneration(world.stateDir, world.root, 1), 'another writer holds', 'retire');
    refuses(() => ringModule.rotateRootWrappingKey(world.stateDir, world.root, randomBytes(32)),
      'another writer holds', 'root re-seal');
    // ...and creating one, which re-checks existence INSIDE the lock rather than before it.
    const fresh = await makeWorld('rmw-lock-fresh', { migrate: false });
    mkdirSync(join(fresh.stateDir, 'ring'), { recursive: true });
    const freshLock = acquireStateLock(join(fresh.stateDir, 'ring'), ringModule.KEK_RING_WRITER_LOCK);
    try {
      refuses(() => ringModule.initializeKekRing(fresh.stateDir, fresh.root), 'another writer holds', 'initialise');
    } finally {
      freshLock.release();
    }
  } finally {
    held.release();
  }
  // Released, the same mutations succeed — so every refusal above was the lock and not the operation. And a
  // mutation COMPLETING proves load-and-store under one lock does not deadlock against itself, which is what
  // a lock left inside the store would have done once the outer one was added.
  assertEq(ringModule.beginPendingGeneration(world.stateDir, world.root).generation, 2, 'it works once released');
  assertEq(ringModule.activatePendingGeneration(world.stateDir, world.root).active, 2, 'and does not self-deadlock');
});

await test('an EMPTY keystore is a complete all-keys proof, not a permanent refusal', async () => {
  // THE DEFECT: `plan.total > 0 && ...` made "every key opens" FALSE over zero keys — so an installation that
  // had stored nothing yet could never rotate and never retire. "Every key opens" over nothing is true.
  const empty = await makeWorld('empty-keystore', { keys: 0 });
  assertEq(countKeystoreEntries(empty.stateDir), 0, 'this keystore really is empty');
  const plan = planKekRotation(rotationRequest(empty));
  const report = runKekRotation({ ...rotationRequest(empty), confirmDigest: plan.planDigest }, runnerFor());
  assertEq(report.ok, true, `a rotation over an empty keystore completes: ${JSON.stringify(report.notes)}`);
  assertEq(report.stage, 'activated', 'reaching activation');
  assertEq(loadKekRing(empty.stateDir, empty.root).active, 2, 'and the ring really moved');

  // AND THE POPULATED CASE IS STILL PROVED, so relaxing the empty one did not make the check vacuous.
  const populated = await makeWorld('populated-keystore', { keys: 3 });
  assertEq(countKeystoreEntries(populated.stateDir), 3, 'this one has keys');
  const populatedPlan = planKekRotation(rotationRequest(populated));
  const populatedReport = runKekRotation(
    { ...rotationRequest(populated), confirmDigest: populatedPlan.planDigest }, runnerFor());
  assertEq(populatedReport.keys.rewrapped, 3, 'every one of which was rewrapped');
  assertEq(populatedReport.verifiedAll, true, 'and proved to open under the new generation');
});

await test('the ring refuses a pending pointer and entry that disagree, and incoherent timestamps', async () => {
  const world = await makeWorld('ring-coherence');
  const path = kekRingPath(world.stateDir);
  const sealed = readStateDocument<Record<string, unknown>>(path)!;
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
  const generations = (r: Record<string, unknown>) => r.generations as Array<Record<string, unknown>>;
  for (const [what, mutate, needle] of [
    // A pending ENTRY with a null POINTER: the ring disagrees with itself about whether a rotation is running,
    // and which half a reader believes decides whether the next rotation is refused.
    ['a pending entry the pointer does not name', (r: Record<string, unknown>) => ({
      ...r,
      generations: [...generations(r), { ...generations(r)[0], generation: 5, state: 'pending' }],
      pending: null,
    }), 'pending generation it does not point at'],
    ['no record of whether there is a pending generation', (r: Record<string, unknown>) => {
      const copy = { ...r };
      delete copy.pending;
      return copy;
    }, 'does not record whether'],
    ['an update from before the ring existed', (r: Record<string, unknown>) => ({
      ...r, createdAt: 5_000, updatedAt: 1_000,
    }), 'update from before it was created'],
    ['a generation dated outside the ring lifetime', (r: Record<string, unknown>) => ({
      ...r, createdAt: 9_000, updatedAt: 9_000,
    }), 'dated outside the ring'],
  ] as Array<[string, (r: Record<string, unknown>) => Record<string, unknown>, string]>) {
    reseal(mutate);
    refuses(() => loadKekRing(world.stateDir, world.root), needle, what);
  }
});

// ---------------------------------------------------------------------------------------------------------
// 9. The custody transaction: a re-seal that puts the ring back, a gate that proves the way back, a plan
//    that cannot be spent on inputs that moved, a journal that must describe THIS ring, and a state
//    boundary that is checked rather than assumed.
// ---------------------------------------------------------------------------------------------------------

/** A world with a second root key file beside it, which is what every re-seal here needs. */
async function reSealWorld(name: string): Promise<{ world: World; newRoot: Buffer; request: {
  stateDir: string; rootKeyFile: string; newRootKeyFile: string; backupSet: string;
} }> {
  const world = await makeWorld(name);
  const newRootFile = join(world.project, 'next_root');
  const newRoot = randomBytes(32);
  writeFileSync(newRootFile, `${newRoot.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  if (POSIX) chmodSync(newRootFile, 0o600);
  return {
    world,
    newRoot,
    request: {
      stateDir: world.stateDir, rootKeyFile: world.rootFile,
      newRootKeyFile: newRootFile, backupSet: world.backupSet,
    },
  };
}

await test('a re-seal whose proof fails puts the EXACT previous bytes back and proves it did', async () => {
  // THE DEFECT: the proof was three statements after the write — re-seal, re-read under the new root, refuse
  // if the contents differed. The refusal LEFT THE NEW FILE IN PLACE. At that moment the old root no longer
  // opens the ring and the new one has just been shown not to either: every key in the catalog is behind a
  // file nothing can open, and the operator was handed a sentence about a failed check.
  const { world, newRoot, request } = await reSealWorld('reseal-rollback');
  const ringFile = kekRingPath(world.stateDir);
  const beforeBytes = readFileSync(ringFile);
  const beforeRing = loadKekRing(world.stateDir, world.root);
  const beforeDigest = wholeRingDigest(beforeRing);
  const planned = planRootKeyRotation(request);

  let caught: unknown = null;
  try {
    runRootKeyRotation({ ...request, confirmDigest: planned.planDigest }, {
      // SOMETHING CHANGED THE FILE BETWEEN THE WRITE AND THE PROOF. A share that truncated, a filesystem that
      // reordered, another writer: the injection stands for all of them, and what is under test is what this
      // command does when its own post-write proof fails, not which of those caused it.
      afterWrite: () => { writeFileSync(ringFile, Buffer.concat([readFileSync(ringFile), Buffer.from('!')])); },
    });
  } catch (err) { caught = err; }

  assert(caught instanceof RootReSealFailed, `a failed proof is its own kind: ${String(caught)}`);
  const failure = caught as RootReSealFailed;
  assertEq(failure.rolledBack, true, 'the ring was rolled back');
  assertEq(failure.rollbackProblem, null, 'with nothing wrong in the rollback');
  assert(failure.primary.includes('does not open under the new root'), `the primary is preserved: ${failure.primary}`);
  assert(failure.message.includes('PUT BACK'), 'and the message says the ring was put back');

  // BYTE FOR BYTE. Not "a ring with the same contents" — the same file. The envelope is AEAD-authenticated
  // over itself, so a re-encoding would be a different file that happens to decrypt to the same thing.
  assertEq(readFileSync(ringFile).equals(beforeBytes), true, 'the sealed ring is byte for byte what it was');
  // AND THE OLD ROOT OPENS THE WHOLE LOGICAL RING AGAIN — every generation, both pointers, both timestamps.
  const after = loadKekRing(world.stateDir, world.root);
  assertEq(wholeRingDigest(after), beforeDigest, 'the previous root opens the exact ring it opened before');
  assertEq(after.generations.length, beforeRing.generations.length, 'with every generation still in it');
  refuses(() => loadKekRing(world.stateDir, newRoot), 'DIFFERENT root wrapping key', 'the new root, which never landed');
  for (const forbidden of [world.root.toString('hex'), newRoot.toString('hex'), SECRET, world.stateDir]) {
    assert(!failure.message.includes(forbidden), 'and the refusal carries no key or path');
  }

  // THE INSTALLATION IS STILL USABLE, which is the whole point of putting it back.
  const custodian = new FileCustodian(world.stateDir, SECRET, activeKek(after));
  for (const keyId of world.keyIds) assertEq((await custodian.get(keyId, 0)).length, 32, 'every key still opens');
});

await test('a re-seal whose ROLLBACK also fails names the more urgent of the two problems', async () => {
  const { world, request } = await reSealWorld('reseal-rollback-fails');
  const ringFile = kekRingPath(world.stateDir);
  const planned = planRootKeyRotation(request);
  let caught: unknown = null;
  try {
    runRootKeyRotation({ ...request, confirmDigest: planned.planDigest }, {
      afterWrite: () => { writeFileSync(ringFile, Buffer.concat([readFileSync(ringFile), Buffer.from('!')])); },
      // AND THE WAY BACK IS GONE TOO. A full filesystem, a share that went away, a read-only remount: the
      // rollback is not guaranteed to succeed, and a command that assumed it did would report "put back" over
      // a ring that was not.
      restore: () => { throw new Error('the state directory went away'); },
    });
  } catch (err) { caught = err; }
  assert(caught instanceof RootReSealFailed, `still its own kind: ${String(caught)}`);
  const failure = caught as RootReSealFailed;
  assertEq(failure.rolledBack, false, 'and it does NOT claim the ring was put back');
  assert(failure.rollbackProblem !== null, 'the rollback problem is carried');
  assert(failure.primary.includes('does not open under the new root'), 'the primary failure is still preserved');
  assert(failure.message.includes('ROLLBACK DID NOT COMPLETE'), 'both facts are in the message');
  assert(failure.message.includes('MAY OPEN UNDER NEITHER'), 'and the urgent one is stated plainly');
  assert(failure.message.includes('restore the sidecar state from the verified complete backup'),
    'with the one action that helps');
  for (const forbidden of [world.root.toString('hex'), SECRET, world.stateDir]) {
    assert(!failure.message.includes(forbidden), 'and it carries no key or path');
  }
});

await test('a re-seal that verifies preserves the whole ring, timestamps included', async () => {
  const { world, newRoot, request } = await reSealWorld('reseal-exact');
  const before = loadKekRing(world.stateDir, world.root);
  const planned = planRootKeyRotation(request);
  const report = runRootKeyRotation({ ...request, confirmDigest: planned.planDigest });
  assertEq(report.ok, true, 'the re-seal succeeds');
  assertEq(report.ringUnchanged, true, 'and claims the ring is unchanged');
  const after = loadKekRing(world.stateDir, newRoot);
  // THE WHOLE DOCUMENT, INCLUDING BOTH TIMESTAMPS. A re-seal that stamped `updatedAt` would make the claim
  // true only of the parts somebody remembered to exclude.
  assertEq(wholeRingDigest(after), wholeRingDigest(before), 'and the whole ring really is the same document');
  assertEq(after.updatedAt, before.updatedAt, 'with no timestamp quietly rewritten');
});

await test('a root re-seal refuses a verified backup that cannot restore custody, and proves the one it takes', async () => {
  // THE DEFECT: the gate was `verifyBackupSet(...).ok` and nothing else. A set can be internally consistent —
  // every artifact present, every digest matching — and still be unable to restore anything: no keystore, a
  // keystore with no ring, or a root wrapping key that does not open its own ring. This is the ONE operation
  // after which the previous root opens nothing, so the fallback was the one thing that had to be real.
  const { world, request } = await reSealWorld('root-gate');

  // A SET WHOSE KEYSTORE HOLDS NO RING — what a backup of a pre-migration installation looks like. It
  // verifies perfectly.
  const preMigration = await makeWorld('root-gate-no-ring', { migrate: false });
  refuses(() => planRootKeyRotation({ ...request, backupSet: preMigration.backupSet }),
    'does not open the ring inside it', 'a set whose keystore holds no ring');
  // A SET WHOSE OWN ROOT KEY DOES NOT OPEN ITS OWN RING.
  const mismatched = await makeWorld('root-gate-mismatch', { mismatchedBackupRoot: true });
  refuses(() => planRootKeyRotation({ ...request, backupSet: mismatched.backupSet }),
    'does not open the ring inside it', 'a set whose root key does not open its ring');
  // AND THE TWO ABSENCES, against the proof itself: a set cannot be made to verify without these, so they
  // are put to the function that is the gate rather than through a set that could not exist.
  const bare = join(WORK, 'bare-set');
  mkdirSync(bare, { recursive: true });
  refuses(() => proveBackupRestoresCustody(bare, 'nothing was changed.'), 'holds no keystore component',
    'a set with no keystore at all');
  mkdirSync(join(bare, 'keystore-backup'), { recursive: true });
  refuses(() => proveBackupRestoresCustody(bare, 'nothing was changed.'), 'holds no root wrapping key',
    'a set with a keystore and no root key');
  // NOTHING WAS CHANGED BY ANY OF THAT.
  assertEq(loadKekRing(world.stateDir, world.root).active, 1, 'and the ring is where it was');

  // THE SET IT DOES ACCEPT REALLY RESTORES. Not "the proof passed" — the set is restored into a fresh
  // directory and every key in the installation is opened out of it, using only what is inside the set.
  const planned = planRootKeyRotation(request);
  const restored = join(WORK, 'root-gate-restored');
  cpSync(join(world.backupSet, 'keystore-backup'), restored, { recursive: true });
  const backedUpRoot = decodeKey(readFileSync(join(world.backupSet, 'secrets-backup', 'custodian_root_key'), 'utf8').trim());
  assert(backedUpRoot !== null, 'the set carries a 32-byte root wrapping key');
  const backedUpRing = loadKekRing(restored, backedUpRoot!);
  assertEq(wholeRingDigest(backedUpRing), planned.backupRingDigest, 'the plan bound THAT ring');
  assertEq(planned.backupActiveGeneration, backedUpRing.active, 'and that generation');
  const custodian = new FileCustodian(restored, SECRET, activeKek(backedUpRing));
  for (const keyId of world.keyIds) {
    assertEq((await custodian.get(keyId, 0)).length, 32, 'every key opens out of the restored set');
  }
  // AND THE PLAN IS FROZEN AND CARRIES NO KEY.
  assertEq(Object.isFrozen(planned), true, 'a plan cannot be edited between reading it and running it');
  for (const forbidden of [world.root.toString('hex'), world.staticKek.toString('hex'), SECRET]) {
    assert(!JSON.stringify(planned).includes(forbidden), 'and no key is in it');
  }
});

await test('a migration plan is pure, and every input that moves afterwards is refused', async () => {
  // THE DEFECT: the migration's digest covered three labels — where, which root, which static key. The
  // KEYSTORE the static key was proved against was bound by nothing, and neither was the backup that is the
  // only way back. "Every wrapped key opens under this key" is a statement about a SET of files, and a file
  // added between the proof and the adoption was never in it.
  const world = await makeWorld('migrate-plan', { migrate: false });
  const staticFile = join(world.project, 'static_kek');
  writeFileSync(staticFile, `${world.staticKek.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  const request = {
    stateDir: world.stateDir, rootKeyFile: world.rootFile,
    staticKeyFile: staticFile, backupSet: world.backupSet,
  };

  const planned = planKekMigration(request);
  assertEq(planned.keysProved, world.keyIds.length, 'the plan says how many keys its proof covered');
  assertEq(Object.isFrozen(planned), true, 'and the plan cannot be edited afterwards');
  assertEq(readdirSync(world.stateDir).includes('ring'), false, 'PLANNING WROTE NOTHING');
  for (const forbidden of [world.root.toString('hex'), world.staticKek.toString('hex'), SECRET]) {
    assert(!JSON.stringify(planned).includes(forbidden), 'and no key is in the plan');
  }

  // A KEY ADDED TO THE KEYSTORE AFTER THE PLAN. It opens under the same static key, so every check the old
  // digest covered still passes — and the proof an operator read covered three files, not four. The refusal
  // is the digest comparison, which is the whole point: the plan is bound to the SET, so a set that moved
  // makes the confirmation stop matching. (A change that lands later still meets the same comparison again,
  // recomputed under the lock.)
  const late = new FileCustodian(world.stateDir, SECRET, world.staticKek);
  await late.provision('op-late', 'item-late', 0);
  await late.commitProvision('op-late');
  refuses(() => runKekMigration({ ...request, confirmDigest: planned.planDigest }),
    'digest you confirmed', 'a key file added after the plan was read');
  assertEq(readdirSync(world.stateDir).includes('ring'), false, 'and no ring was written');
  const replanned = planKekMigration(request);
  assert(replanned.planDigest !== planned.planDigest, 'a re-plan is a different decision');
  assertEq(replanned.keysProved, world.keyIds.length + 1, 'covering the key that appeared');

  // THE STATIC KEY FILE REPLACED AFTER THE PLAN.
  writeFileSync(staticFile, `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  refuses(() => runKekMigration({ ...request, confirmDigest: replanned.planDigest }),
    'does not open the wrapped keys', 'a static key swapped after the plan was read');
  assertEq(readdirSync(world.stateDir).includes('ring'), false, 'and still no ring');
  writeFileSync(staticFile, `${world.staticKek.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });

  // THE BACKUP SET REPLACED AT THE SAME PATH BY A DIFFERENT SET THAT ALSO VERIFIES — what a retention
  // schedule does. The path is unchanged, the set is not, and the set is the only way back.
  const bound = planKekMigration(request);
  writeFileSync(join(world.project, 'promotion-records', 'later.json'), '{}\n', 'utf8');
  const second = takeBackup(world.project, 'set-2');
  rmSync(world.backupSet, { recursive: true, force: true });
  renameSync(second, world.backupSet);
  refuses(() => runKekMigration({ ...request, confirmDigest: bound.planDigest }),
    'digest you confirmed', 'a different backup set at the same path');
  assertEq(readdirSync(world.stateDir).includes('ring'), false, 'and still no ring');

  // A KEY OPERATION ALREADY RUNNING IS A REFUSAL, NOT A SECOND WRITER.
  const held = join(world.stateDir, ROTATION_LOCK_DIRNAME);
  mkdirSync(held, { recursive: true });
  const current = planKekMigration(request);
  refuses(() => runKekMigration({ ...request, confirmDigest: current.planDigest }),
    'already running', 'a migration while another key operation holds the lock');
  rmSync(held, { recursive: true, force: true });

  // AND THE ADOPTION ITSELF, once the plan describes what is actually there.
  const outcome = runKekMigration({ ...request, confirmDigest: planKekMigration(request).planDigest });
  assertEq(outcome.ok, true, 'the adoption succeeds against a current plan');
  const ring = loadKekRing(world.stateDir, world.root);
  assertEq(activeKek(ring).toString('hex'), world.staticKek.toString('hex'), 'as generation 1');
  const opens = new FileCustodian(world.stateDir, SECRET, activeKek(ring));
  for (const keyId of world.keyIds) assertEq((await opens.get(keyId, 0)).length, 32, 'and every key opens');
  // A RING IS CREATED ONCE. The second attempt is refused at the plan, before a digest exists to confirm.
  refuses(() => planKekMigration(request), 'already migrated', 'a second migration');
});

await test('the key-set proof reads the keystore the way the rest of this product does', async () => {
  // THE DEFECT: the first version of this proof was `readdirSync(...).filter(endsWith('.json'))
  // .map(readFileSync(join(...)))`. It followed links, accepted anything with the right suffix whatever kind
  // of object it was, allocated whatever was on disk, and silently skipped everything else — in the one path
  // whose entire job is to state WHICH FILES an adoption was justified by.
  const world = await makeWorld('keyset-proof', { migrate: false });
  const staticFile = join(world.project, 'static_kek');
  writeFileSync(staticFile, `${world.staticKek.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  const request = {
    stateDir: world.stateDir, rootKeyFile: world.rootFile,
    staticKeyFile: staticFile, backupSet: world.backupSet,
  };
  const keysDir = join(world.stateDir, 'keys');
  const files = readdirSync(keysDir).filter((entry) => entry.endsWith('.json'));
  assertEq(files.length, world.keyIds.length, 'the keystore is what this test thinks it is');
  const victim = join(keysDir, files[0]!);
  const original = readFileSync(victim);
  const baseline = keystoreSetDigest(world.stateDir);
  const planned = planKekMigration(request);

  // A CHANGED FILE, SAME COUNT, SAME NAMES. A digest over the file list alone would not have moved.
  const touched = JSON.parse(original.toString('utf8')) as Record<string, unknown>;
  writeFileSync(victim, JSON.stringify({ ...touched, createdAt: (touched.createdAt as number) + 1 }), 'utf8');
  assert(keystoreSetDigest(world.stateDir) !== baseline, 'a changed key file moves the set digest');
  refuses(() => runKekMigration({ ...request, confirmDigest: planned.planDigest }),
    'digest you confirmed', 'a key file whose contents changed after the plan');
  writeFileSync(victim, original);
  assertEq(keystoreSetDigest(world.stateDir), baseline, 'and putting it back puts the digest back');

  // AN ENTRY THIS CUSTODIAN DOES NOT WRITE. A `.tmp` left by an interrupted write is exactly the state in
  // which the set is not settled, and the old filter skipped it in silence.
  const stray = join(keysDir, `${files[0]!}.4f2a.tmp`);
  writeFileSync(stray, '{}', 'utf8');
  refuses(() => keystoreSetDigest(world.stateDir), 'not a wrapped key file this custodian wrote', 'a leftover temp file');
  refuses(() => planKekMigration(request), 'not a wrapped key file this custodian wrote', 'and the plan refuses it');
  rmSync(stray, { force: true });

  // A DIRECTORY WEARING A KEY FILE'S NAME.
  const impostor = join(keysDir, `${'b'.repeat(64)}.json`);
  mkdirSync(impostor, { recursive: true });
  refuses(() => keystoreSetDigest(world.stateDir), 'not a regular file', 'a directory with a key file\'s name');
  rmSync(impostor, { recursive: true, force: true });

  // A FILE LARGER THAN THIS BUILD WILL READ. It is still valid JSON and still unwraps, so nothing upstream
  // rejects it — the bound is what refuses, and the bound is the point.
  writeFileSync(victim, JSON.stringify({ ...touched, padding: 'x'.repeat(1_100_000) }), 'utf8');
  refuses(() => keystoreSetDigest(world.stateDir), 'larger than this custodian will read', 'an over-large key file');
  refuses(() => planKekMigration(request), 'larger than this custodian will read', 'and the plan refuses it');
  writeFileSync(victim, original);

  // A SYMBOLIC LINK WEARING A KEY FILE'S NAME, pointing at a file that WOULD read and unwrap perfectly. The
  // old reader followed it and digested the target as though the keystore contained it.
  if (POSIX) {
    const elsewhere = join(world.project, 'planted.json');
    writeFileSync(elsewhere, original);
    const link = join(keysDir, `${'c'.repeat(64)}.json`);
    symlinkSync(elsewhere, link);
    refuses(() => keystoreSetDigest(world.stateDir), 'not a regular file', 'a key entry that is a symbolic link');
    refuses(() => planKekMigration(request), 'not a regular file', 'and the plan refuses it');
    rmSync(link, { force: true });
  } else {
    console.log('        (the symlink case is POSIX-only here)');
  }

  // AND WITH ALL OF THAT REMOVED, THE SET IS EXACTLY WHAT IT WAS — so every refusal above was the entry and
  // not a proof that had stopped working.
  assertEq(keystoreSetDigest(world.stateDir), baseline, 'the keystore is back to the set the plan bound');
  assertEq(planKekMigration(request).planDigest, planned.planDigest, 'and the plan is the same decision again');
});

await test('the key-set proof refuses a keys DIRECTORY that is a link, not only key files that are', async () => {
  // THE DEFECT: every per-entry check was a no-follow check on a FILE, and none of them said anything about
  // the directory the names came from. `readdirSync('<state>/keys')` follows a `keys` that is a symlink — so
  // the proof could walk somebody else's directory with every individual entry passing. The no-follow
  // boundary escaped through the parent.
  if (!POSIX) { console.log('        (POSIX-only: there is no symlink to plant here)'); return; }
  const world = await makeWorld('keyset-parent', { migrate: false });
  const staticFile = join(world.project, 'static_kek');
  writeFileSync(staticFile, `${world.staticKek.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  const request = {
    stateDir: world.stateDir, rootKeyFile: world.rootFile,
    staticKeyFile: staticFile, backupSet: world.backupSet,
  };
  const keysDir = join(world.stateDir, 'keys');
  const baseline = keystoreSetDigest(world.stateDir);

  // A DECOY DIRECTORY HOLDING PERFECTLY WELL-FORMED KEY FILES — a copy of the real ones, so every entry check
  // passes and only the parent is wrong.
  const decoy = join(world.project, 'decoy-keys');
  cpSync(keysDir, decoy, { recursive: true });
  renameSync(keysDir, join(world.project, 'real-keys'));
  symlinkSync(decoy, keysDir);
  refuses(() => keystoreSetDigest(world.stateDir), 'symbolic link', 'a keys directory that is a link');
  refuses(() => planKekMigration(request), 'symbolic link', 'and the plan refuses it');
  rmSync(keysDir, { force: true });
  renameSync(join(world.project, 'real-keys'), keysDir);
  assertEq(keystoreSetDigest(world.stateDir), baseline, 'and the real keystore still reads as the same set');
});

await test('the custodian\'s OWN writers take the lock the key operations take', async () => {
  // THE DEFECT: the migration and the rotation both reason about the SET of wrapped keys, and neither
  // excluded the class that writes key files. `FileCustodian.provision`, `commitProvision`, `destroy` and
  // `rewrapKeystore` took no lock at all, so "every key in this keystore opens under the adopted key" was a
  // proof about a set anything could change while it was being acted on. Recomputing the set afterwards
  // narrows that window; it cannot close it, because there is always a moment after the last check.
  const world = await makeWorld('custodian-lock');
  const custodian = new FileCustodian(world.stateDir, SECRET, world.staticKek);
  const { acquireStateLock, CUSTODIAN_WRITER_LOCK } = await import('../src/core/crypto/custodian-state-io.js');

  const held = acquireStateLock(world.stateDir, CUSTODIAN_WRITER_LOCK);
  try {
    // EVERY MUTATING ENTRY POINT IS REFUSED while another writer holds it. Not queued, not interleaved.
    let provisionRefused = false;
    try { await custodian.provision('op-locked', 'item-locked', 0); } catch (err) {
      provisionRefused = (err as Error).message.includes('another writer holds');
    }
    assertEq(provisionRefused, true, 'a provision is refused');
    let commitRefused = false;
    try { await custodian.commitProvision('op-0'); } catch (err) {
      commitRefused = (err as Error).message.includes('another writer holds');
    }
    assertEq(commitRefused, true, 'a commit is refused');
    let destroyRefused = false;
    try { await custodian.destroy('op-destroy', world.keyIds[0]!); } catch (err) {
      destroyRefused = (err as Error).message.includes('another writer holds');
    }
    assertEq(destroyRefused, true, 'a destroy is refused');
    refuses(() => FileCustodian.rewrapKeystore(world.stateDir, { fromKek: world.staticKek, toKek: world.staticKek }),
      'another writer holds', 'a rewrap');
    // ...AND READING IS NOT. A read takes nothing, so a held writer lock does not make the catalog unreadable.
    assertEq((await custodian.get(world.keyIds[0]!, 0)).length, 32, 'but a read still works');
    assertEq(await custodian.status(world.keyIds[0]!), 'active', 'and so does a status');
  } finally {
    held.release();
  }
  // RELEASED, EVERY ONE OF THEM WORKS — so each refusal above was the lock and not the operation.
  const fresh = await custodian.provision('op-after', 'item-after', 0);
  await custodian.commitProvision('op-after');
  assertEq((await custodian.get(fresh.keyId, 0)).length, 32, 'the provision lands once the lock is free');
  assertEq(FileCustodian.rewrapKeystore(world.stateDir, { fromKek: world.staticKek, toKek: world.staticKek }).total,
    world.keyIds.length + 1, 'and so does a rewrap');
  // AND CONCURRENT CALLERS IN ONE PROCESS SERIALISE RATHER THAN COLLIDE — every body is synchronous end to
  // end, so the lock is never held across an await.
  const many = await Promise.all([0, 1, 2, 3, 4].map(async (index) => {
    const result = await custodian.provision(`op-par-${index}`, `item-par-${index}`, 0);
    await custodian.commitProvision(`op-par-${index}`);
    return result.keyId;
  }));
  assertEq(new Set(many).size, 5, 'five concurrent provisions produce five keys');
  for (const keyId of many) assertEq((await custodian.get(keyId, 0)).length, 32, 'and every one of them opens');
});

await test('a migration holds the keystore writer lock, and a stray write still undoes the adoption', async () => {
  // TWO THINGS, AND THE FIRST IS THE GUARANTEE. The migration holds the custodian's own writer lock across
  // re-read → prove → adopt, so a provision or a destroy landing in the middle is refused rather than
  // interleaved. The post-adoption recheck stays as defence in depth, for something writing into `keys/`
  // without going through the class at all — which is what the injected fault below is.
  const world = await makeWorld('migrate-concurrent', { migrate: false });
  const staticFile = join(world.project, 'static_kek');
  writeFileSync(staticFile, `${world.staticKek.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  const request = {
    stateDir: world.stateDir, rootKeyFile: world.rootFile,
    staticKeyFile: staticFile, backupSet: world.backupSet,
  };
  const keysDir = join(world.stateDir, 'keys');
  // The stray key file, made the only way a real one is made: by a custodian, under the same static KEK, in
  // a state directory of its own. Its name is the hash of its own key id, so it is a key file this keystore
  // could legitimately have gained — which is the point of the injection.
  const donor = new FileCustodian(join(WORK, 'migrate-concurrent-donor'), SECRET, world.staticKek);
  await donor.provision('donor-op', 'donor-item', 0);
  await donor.commitProvision('donor-op');
  const donorKeys = join(WORK, 'migrate-concurrent-donor', 'keys');
  const donorName = readdirSync(donorKeys)[0]!;
  const donorBytes = readFileSync(join(donorKeys, donorName));
  const planned = planKekMigration(request);

  let caught: unknown = null;
  try {
    runKekMigration({ ...request, confirmDigest: planned.planDigest }, {
      afterAdopt: () => {
        // THE LOCK IS REALLY HELD RIGHT NOW: a custodian write attempted from inside the transaction is
        // refused, which is the thing that makes the set stable rather than merely rechecked.
        refuses(() => FileCustodian.rewrapKeystore(world.stateDir,
          { fromKek: world.staticKek, toKek: world.staticKek }),
        'another writer holds', 'a custodian write during the migration');
        // AND THEN A WRITE THAT DOES NOT GO THROUGH THE CLASS AT ALL, which no lock can stop. A REAL key
        // file — provisioned by another custodian under the same static KEK, so it is filed under its own
        // id's hash and opens under the key being adopted — is exactly what a provision leaves behind.
        //
        // It used to be a COPY of an existing key file under a different valid name, which is not what a
        // provision produces at all: it is one key file wearing another key's address, and the custodian now
        // refuses that outright. Injecting it here would have been testing the readdressing rule and calling
        // it a concurrency test.
        writeFileSync(join(keysDir, donorName), donorBytes);
      },
    });
  } catch (err) { caught = err; }

  assert(caught instanceof MaintenanceRefused, `a concurrent write is a refusal: ${String(caught)}`);
  const failure = caught as MaintenanceRefused;
  assert(failure.message.includes('changed while the ring was being adopted'), `it says what happened: ${failure.message}`);
  assert(failure.message.includes('THE ADOPTION WAS UNDONE'), 'and that the ring was removed again');
  // THE STATE IT FOUND IS THE STATE IT LEFT: no ring, and every key file untouched.
  refuses(() => loadKekRing(world.stateDir, world.root), 'holds no KEK ring', 'the ring that was rolled back');
  const custodian = new FileCustodian(world.stateDir, SECRET, world.staticKek);
  for (const keyId of world.keyIds) assertEq((await custodian.get(keyId, 0)).length, 32, 'every key still opens');
  // AND A PLAN AGAINST WHAT IS NOW THERE ADOPTS CLEANLY — so the refusal was the race, not a broken command.
  const again = planKekMigration(request);
  assert(again.planDigest !== planned.planDigest, 'the keystore really did change');
  assertEq(runKekMigration({ ...request, confirmDigest: again.planDigest }).ok, true, 'and the migration then works');
});

await test('a migration of an EMPTY keystore is valid, and says its proof covered nothing', async () => {
  const empty = await makeWorld('migrate-empty', { migrate: false, keys: 0 });
  const staticFile = join(empty.project, 'static_kek');
  writeFileSync(staticFile, `${empty.staticKek.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  const request = {
    stateDir: empty.stateDir, rootKeyFile: empty.rootFile,
    staticKeyFile: staticFile, backupSet: empty.backupSet,
  };
  const planned = planKekMigration(request);
  assertEq(planned.keysProved, 0, 'nothing to prove against');
  const outcome = runKekMigration({ ...request, confirmDigest: planned.planDigest });
  assertEq(outcome.ok, true, 'and an installation that has stored nothing can still migrate');
  // AND THE REPORT DOES NOT PRESENT A VACUOUS PROOF AS AN EXHAUSTIVE ONE.
  assert(outcome.notes.some((note) => note.includes('covered nothing')), 'the emptiness is stated');
  assertEq(loadKekRing(empty.stateDir, empty.root).active, 1, 'the ring is there');
});

await test('a rotation journal must describe a rotation THIS ring could be in the middle of', async () => {
  // THE DEFECT, AND IT REPORTED SUCCESS. `readRotationJournal` checked the journal's shape and nothing about
  // its relationship to the ring beside it. This file passed every check:
  //
  //     { fromGeneration: 1, toGeneration: 1, stage: 'verified' }
  //
  // On an installation active on generation 1 it made the plan take `fromGeneration` from the journal (so the
  // digest matched), and the stage reconciliation then found generation 1 in the ring, found it active, found
  // every key opening under it, and concluded `activated`. Every stage was skipped. The ring never moved, no
  // key was rewrapped, and the command printed a completed rotation — to an operator rotating because they
  // believed a key had been disclosed.
  const world = await makeWorld('journal-noop');
  const journalPath = join(world.stateDir, 'ring', 'rotation-journal.json');
  const forge = (fields: Record<string, unknown>): void => {
    writeStateDocument(journalPath, {
      rotation: 'phase-283-kek-rotation', version: 1, planDigest: 'a'.repeat(64),
      stage: 'verified', startedAt: 1, ...fields,
    });
  };
  const before = planKekRotation(rotationRequest(world));
  forge({ planDigest: before.planDigest, fromGeneration: 1, toGeneration: 1 });
  refuses(() => planKekRotation(rotationRequest(world)), 'not a rotation', 'a journal rotating a generation onto itself');
  const tools = runnerFor();
  refuses(() => runKekRotation({ ...rotationRequest(world), confirmDigest: before.planDigest }, tools),
    'not a rotation', 'and the run refuses it too');
  assertEq(tools.ledger.all().length, 0, 'nothing was stopped');
  assertEq(loadKekRing(world.stateDir, world.root).generations.length, 1, 'and the ring did not move');

  // A GENERATION THIS RING NEVER HAD.
  forge({ fromGeneration: 7, toGeneration: 8 });
  refuses(() => planKekRotation(rotationRequest(world)), 'not in this ring', 'a journal about another installation');

  // A SUCCESSOR THAT IS NOT THE ONE THIS RING IS PENDING ON. The rotation in progress is 1 -> 2; a journal
  // naming 3 describes a different rotation, and resuming it would rewrap onto a generation nothing points at.
  rmSync(journalPath, { force: true });
  assertEq(beginPendingGeneration(world.stateDir, world.root, () => 2_000).generation, 2, 'a rotation is begun');
  forge({ fromGeneration: 1, toGeneration: 3, stage: 'pending-created' });
  refuses(() => planKekRotation(rotationRequest(world)), 'names a different one', 'a journal naming another successor');
  // ...and the TRUE one is accepted, so the rule refuses a mismatch rather than every resume.
  forge({ fromGeneration: 1, toGeneration: 2, stage: 'pending-created' });
  assertEq(planKekRotation(rotationRequest(world)).fromGeneration, 1, 'the real pending rotation still plans');

  // A JOURNAL FROM A DIFFERENT PLACE IN THIS RING'S HISTORY. After a completed rotation the ring is active on
  // 2 with 1 retained beside it; a journal claiming 2 -> 1 names generations that are both in the ring and
  // describes a state it is not in.
  const done = await makeWorld('journal-history');
  const plan = planKekRotation(rotationRequest(done));
  assertEq(runKekRotation({ ...rotationRequest(done), confirmDigest: plan.planDigest }, runnerFor()).ok, true,
    'a rotation completes');
  writeStateDocument(join(done.stateDir, 'ring', 'rotation-journal.json'), {
    rotation: 'phase-283-kek-rotation', version: 1, planDigest: 'a'.repeat(64),
    fromGeneration: 2, toGeneration: 1, stage: 'verified', startedAt: 1,
  });
  refuses(() => planKekRotation(rotationRequest(done)), 'is not active on',
    'a journal describing a rotation backwards through this ring');
});

await test('a state envelope and a state directory are proved, not assumed', async () => {
  // THE ENVELOPE, FIELD BY FIELD. It used to be `typeof bytes === 'number' && typeof digest === 'string' &&
  // 'doc' in envelope` — which accepts a fourth field, a fractional length, a negative one, and a digest that
  // is not a digest. A document carrying a field this custodian does not write was written by something that
  // does not know the contract, and reading its `doc` anyway is deciding which half of a foreign file to
  // trust.
  const dir = join(WORK, 'envelope');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'doc.json');
  writeStateDocument(path, { a: 1 });
  const good = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  for (const [what, doc] of [
    ['an extra envelope field', { ...good, extra: 1 }],
    ['a length that is not a number', { ...good, bytes: String(good.bytes) }],
    ['a fractional length', { ...good, bytes: 1.5 }],
    ['a negative length', { ...good, bytes: -1 }],
    ['a digest that is not one', { ...good, digest: 'not-a-digest' }],
    ['no document at all', { bytes: good.bytes, digest: good.digest }],
    ['an array', []],
    ['a null', null],
  ] as Array<[string, unknown]>) {
    writeFileSync(path, JSON.stringify(doc), 'utf8');
    refuses(() => readStateDocument(path), 'custodian', what);
  }
  writeFileSync(path, JSON.stringify(good), 'utf8');
  assertEq(JSON.stringify(readStateDocument(path)), JSON.stringify({ a: 1 }), 'and the good one still reads');

  // THE SEALED RING ENVELOPE, BEFORE ANY KEY IS APPLIED TO IT. A `null`, an array or a numeric nonce used to
  // reach six regular expressions through `String(...)` coercions that answer for values that are not there.
  const world = await makeWorld('envelope-ring');
  const ringFile = kekRingPath(world.stateDir);
  const sealed = readStateDocument<Record<string, unknown>>(ringFile)!;
  for (const [what, doc] of [
    ['a document that is not an object', []],
    ['a nonce that is not a string', { ...sealed, nonceHex: 12 }],
    ['a missing tag', { ...sealed, tagHex: undefined }],
  ] as Array<[string, unknown]>) {
    writeStateDocument(ringFile, doc);
    refuses(() => loadKekRing(world.stateDir, world.root), 'envelope', what);
  }
  // AND A RING FILE HOLDING NOTHING IS STILL A RING FILE. `readStateDocument` answers `null` both for "there
  // is no file" and for a file whose document is a literal null; treating the second as absence would let an
  // initialisation write over a ring somebody needs, which is the one irreversible mistake in this module.
  writeStateDocument(ringFile, null);
  refuses(() => loadKekRing(world.stateDir, world.root), 'envelope', 'a ring file holding a null document');
  refuses(() => initializeKekRing(world.stateDir, world.root), 'already',
    'initialising over a ring file that will not parse');
});

await test('a custodian state directory is created AND proved: no link, right owner, owner-only', async () => {
  if (!POSIX) { console.log('        (POSIX-only: ownership and mode are not concepts here)'); return; }
  // THE DEFECT: `mkdirSync(p, { recursive: true, mode })` establishes nothing about a name that already
  // exists. A ring directory left at 0755 by a restore that used `cp -r` held the sealed ring where any
  // account on the host could read it, and a ring directory that is a SYMLINK returned EEXIST and was treated
  // as success — with every subsequent write going through the link.
  const world = await makeWorld('state-dir');
  const ringDir = join(world.stateDir, 'ring');
  chmodSync(ringDir, 0o755);
  refuses(() => beginPendingGeneration(world.stateDir, world.root), 'somebody other than its owner',
    'a ring directory another account can read');
  chmodSync(ringDir, 0o700);
  assertEq(beginPendingGeneration(world.stateDir, world.root).generation, 2,
    'and the same mutation works once it is private — so the refusal was the mode, not the operation');

  const linked = await makeWorld('state-dir-link', { migrate: false });
  const elsewhere = join(linked.project, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
  symlinkSync(elsewhere, join(linked.stateDir, 'ring'));
  refuses(() => initializeKekRing(linked.stateDir, linked.root), 'symbolic link',
    'a ring directory that is a link to somewhere else');
  assertEq(readdirSync(elsewhere).length, 0, 'and NOTHING was written through it');
});

// ---------------------------------------------------------------------------------------------------------
// 10. The custody writer: fail closed where the guarantee cannot be established, and write every byte.
// ---------------------------------------------------------------------------------------------------------

await test('the custody writer refuses a host that cannot hold custody, and creates nothing there', async () => {
  // THE DEFECT: an earlier version of this helper, on a host with no ownership model, CREATED the root
  // wrapping key anyway and printed a warning next to it. A warning is not a custody gate — that is an
  // unprotected key plus a sentence, and the setup script that called it exited 0 and reported a ready
  // installation. The refusal now happens before anything is created, and no platform turns it into success.
  const helperPath = join(repoRoot, 'deploy', 'write-custody-secret.mjs');
  const helper = await import(pathToFileURL(helperPath).href) as {
    writeCustodySecret: (path: string, value: string, uid: number, gid: number,
      write?: (fd: number, b: Buffer, off: number, len: number, pos: number) => number) => string;
    writeAllOrRefuse: (fd: number, bytes: Buffer,
      write?: (fd: number, b: Buffer, off: number, len: number, pos: number) => number) => number;
    assertPlatformCanHoldCustody: (platform?: string) => void;
    CUSTODY_FILE_MODE: number;
  };
  const dir = join(WORK, 'custody-writer');
  mkdirSync(dir, { recursive: true });

  // THE PLATFORM GATE ITSELF, ASKED DIRECTLY, so the rule is exercised on every host this suite runs on
  // rather than only on the one it happens to be running on today.
  refuses(() => helper.assertPlatformCanHoldCustody('win32'), 'no file ownership model',
    'a host with no ownership model');
  refuses(() => helper.assertPlatformCanHoldCustody('win32'), 'NOTHING WAS CREATED', 'and it says so');

  // AND THE WHOLE HELPER, RUN THE WAY THE SETUP SCRIPT RUNS IT.
  const target = join(dir, 'custodian_root_key');
  const run = spawnSync(process.execPath, [helperPath, target, 'a'.repeat(64), '1000', '1000'], { encoding: 'utf8' });
  if (!POSIX) {
    assert(run.status !== 0, `the helper refuses on a host with no ownership model: ${run.stdout}`);
    assert(run.stderr.includes('REFUSING'), `and says it is refusing: ${run.stderr}`);
    assertEq(existsSync(target), false, 'AND NO KEY FILE WAS LEFT BEHIND');
    return;
  }
  assertEq(run.status, 0, `on a POSIX host it creates one: ${run.stderr}`);
  assertEq(readFileSync(target, 'utf8'), 'a'.repeat(64), 'holding exactly the value it was given');
  assertEq(statSync(target).mode & 0o777, helper.CUSTODY_FILE_MODE, 'owner-read only');
  // A SECOND RUN VERIFIES AND DOES NOT REPAIR.
  chmodSync(target, 0o644);
  const second = spawnSync(process.execPath, [helperPath, target, 'a'.repeat(64), '1000', '1000'], { encoding: 'utf8' });
  assert(second.status !== 0, 'an existing key with a loose mode is refused');
  assert(second.stderr.includes('will not silently repair'), `rather than repaired: ${second.stderr}`);
});

await test('the custody writer writes EVERY byte, and leaves nothing behind when it cannot', async () => {
  // THE DEFECT: `writeSync` was called once and its return value ignored. A short write — a full filesystem,
  // a signal, a network-backed mount — produces 31 bytes that look like a key: the setup script exits 0, the
  // sidecar starts, and the ring is sealed under something nobody can reproduce.
  const helperPath = join(repoRoot, 'deploy', 'write-custody-secret.mjs');
  const helper = await import(pathToFileURL(helperPath).href) as {
    writeCustodySecret: (path: string, value: string, uid: number, gid: number,
      write?: (fd: number, b: Buffer, off: number, len: number, pos: number) => number) => string;
    writeAllOrRefuse: (fd: number, bytes: Buffer,
      write?: (fd: number, b: Buffer, off: number, len: number, pos: number) => number) => number;
  };
  const dir = join(WORK, 'custody-short-write');
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from('b'.repeat(64), 'utf8');

  // ONE BYTE AT A TIME. The loop is what makes the file whole; a single call would leave 1 byte of 64.
  const dribble = join(dir, 'dribbled');
  const fd = openSync(dribble, 'w+', 0o600);
  try {
    let calls = 0;
    const written = helper.writeAllOrRefuse(fd, bytes, (target, buffer, offset, _length, position) => {
      calls += 1;
      return writeSync(target, buffer, offset, 1, position);
    });
    assertEq(written, bytes.byteLength, 'every byte was written');
    assertEq(calls, bytes.byteLength, 'across as many calls as it took');
  } finally {
    closeSync(fd);
  }
  assertEq(readFileSync(dribble, 'utf8'), bytes.toString('utf8'), 'and the file is exactly the value');

  // A WRITER THAT STOPS MAKING PROGRESS IS A REFUSAL, not a loop that spins or a file that is short.
  const stalled = join(dir, 'stalled');
  const stalledFd = openSync(stalled, 'w+', 0o600);
  try {
    refuses(() => helper.writeAllOrRefuse(stalledFd, bytes, () => 0), 'could not be written in full',
      'a write that returns zero');
  } finally {
    closeSync(stalledFd);
  }

  if (!POSIX) { console.log('        (the create-and-clean-up path is POSIX-only: the helper fails closed here)'); return; }
  // AND A SHORT WRITE THROUGH THE WHOLE HELPER LEAVES NO FILE AT ALL. A partial key file is worse than none:
  // the next run would find it, take the "existing" branch, and verify whatever the failure produced.
  const truncated = join(dir, 'custodian_root_key');
  refuses(() => helper.writeCustodySecret(truncated, 'c'.repeat(64), process.getuid!(), process.getgid!(),
    (target, buffer, offset, _length, position) => writeSync(target, buffer, offset, 1, position) * 0),
  'could not be written in full', 'a helper run whose writes make no progress');
  assertEq(existsSync(truncated), false, 'AND NOTHING WAS LEFT AT THAT NAME');
  // The same call with a real writer succeeds, so the refusal was the write and not the helper.
  assertEq(helper.writeCustodySecret(truncated, 'c'.repeat(64), process.getuid!(), process.getgid!()), 'created',
    'and a real write creates it');
  assertEq(readFileSync(truncated, 'utf8'), 'c'.repeat(64), 'holding exactly the value');
});

// ---------------------------------------------------------------------------------------------------------
// 8. The transaction is a transaction: one lock domain, one set of bytes, one boundary
// ---------------------------------------------------------------------------------------------------------

await test('a ring that moves after the plan is refused BEFORE the re-seal writes anything', async () => {
  // THE DEFECT: two locks that exclude nothing of each other's. `runRootKeyRotation` holds the ROTATION lock;
  // every other ring mutator holds the RING WRITER lock. Between the re-plan under the first and the write
  // under the second, a begun rotation, an activation or a retirement could land — and the re-seal would take
  // THAT ring, put it under the new root, prove it perfectly, and hand back its digest. The comparison then
  // happened AFTER the write: the command refused, saying nothing was changed, over an installation whose
  // ring only the new root opened.
  const { world, newRoot, request } = await reSealWorld('reseal-interposed');
  const ringFile = kekRingPath(world.stateDir);
  const planned = planRootKeyRotation(request);

  let interposedBytes: Buffer | null = null;
  let interposedDigest: string | null = null;
  let caught: unknown = null;
  try {
    runRootKeyRotation({ ...request, confirmDigest: planned.planDigest }, {
      // A REAL RING MUTATOR, TAKING THE REAL RING WRITER LOCK, in the exact window the defect lived in: after
      // the under-lock re-plan and before the re-seal takes that lock. Not a file edit standing in for one —
      // the point at issue is that this mutator's lock and the rotation's lock are different locks.
      beforeLock: () => {
        beginPendingGeneration(world.stateDir, world.root, () => 2_000);
        interposedBytes = readFileSync(ringFile);
        interposedDigest = wholeRingDigest(loadKekRing(world.stateDir, world.root));
      },
    });
  } catch (err) { caught = err; }

  assert(caught !== null, 'the re-seal is refused');
  assert(caught instanceof RingMovedUnderReSeal, `and as its own kind: ${String(caught)}`);
  assert(!(caught instanceof RootReSealFailed), 'NOT as a rollback: there is nothing to roll back');
  assert((caught as Error).message.includes('NOTHING WAS WRITTEN'), 'and it says so plainly');

  // BYTE FOR BYTE WHAT THE INTERPOSED WRITER LEFT. The re-seal did not touch the file at all — not "wrote it
  // and put it back", which is a different and worse claim.
  assert(interposedBytes !== null, 'the mutation ran');
  assertEq(readFileSync(ringFile).equals(interposedBytes!), true, 'the sealed ring is untouched by the re-seal');
  // AND THE OLD ROOT STILL OPENS THE WHOLE LOGICAL RING — including the generation the interposed writer added.
  const after = loadKekRing(world.stateDir, world.root);
  assertEq(wholeRingDigest(after), interposedDigest!, 'the previous root opens the exact ring on disk');
  assert(after.pending !== null, 'with the interposed writer\'s work still in it');
  refuses(() => loadKekRing(world.stateDir, newRoot), 'DIFFERENT root wrapping key', 'the new root never landed');
  // THE INSTALLATION IS USABLE, which is what "nothing was written" has to mean to be worth saying.
  const custodian = new FileCustodian(world.stateDir, SECRET, activeKek(after));
  for (const keyId of world.keyIds) assertEq((await custodian.get(keyId, 0)).length, 32, 'every key still opens');
  for (const forbidden of [world.root.toString('hex'), newRoot.toString('hex'), SECRET, world.stateDir]) {
    assert(!(caught as Error).message.includes(forbidden), 'and the refusal carries no key or path');
  }
});

await test('the re-seal itself refuses a ring that is not the one it was handed, and writes nothing', async () => {
  // The precondition put directly: the same expectation the command passes, made stale on purpose. This is
  // what makes the "the ring that was re-sealed is not the ring this plan was computed against" refusal
  // unreachable — the mismatch is now caught inside the writer lock, before the capture is written over.
  const { world, newRoot } = await reSealWorld('reseal-expectation');
  const ringFile = kekRingPath(world.stateDir);
  const beforeBytes = readFileSync(ringFile);
  const beforeDigest = wholeRingDigest(loadKekRing(world.stateDir, world.root));

  refuses(() => rotateRootWrappingKey(world.stateDir, world.root, newRoot, 'a'.repeat(64)),
    'NOTHING WAS WRITTEN', 'a re-seal handed a ring digest that is not the ring on disk');
  assertEq(readFileSync(ringFile).equals(beforeBytes), true, 'the file was never opened for writing');
  assertEq(wholeRingDigest(loadKekRing(world.stateDir, world.root)), beforeDigest, 'the old root still opens it');
  refuses(() => loadKekRing(world.stateDir, newRoot), 'DIFFERENT root wrapping key', 'and the new root does not');

  // AND THE EXPECTATION THAT MATCHES STILL RE-SEALS, so the precondition is a gate and not a wall.
  const done = rotateRootWrappingKey(world.stateDir, world.root, newRoot, beforeDigest);
  assertEq(done.ringDigest, beforeDigest, 'the re-seal reports the ring it was handed');
  assertEq(wholeRingDigest(loadKekRing(world.stateDir, newRoot)), beforeDigest, 'and the new root opens it');
});

await test('a root rotation will not bind one set\'s digest to another set\'s custody proof', async () => {
  // THE DEFECT: `verifyBackupSet` and `proveBackupRestoresCustody` are two reads of a directory nothing holds
  // still. The plan recorded `backupSetDigest` from the first and the custody fields from the second, so a
  // set replaced at the same path in between — a retention schedule rolling a nightly, a sync finishing —
  // produced a plan whose digest named SET A and whose proof described SET B, with nothing saying so.
  const { world, request } = await reSealWorld('backup-toctou');
  const decoy = await makeWorld('backup-toctou-decoy');
  const before = planRootKeyRotation(request);

  // The swap is real: the set at the plan's path is REPLACED by a different set that verifies just as well.
  const swap = (): void => {
    rmSync(request.backupSet, { recursive: true, force: true });
    cpSync(decoy.backupSet, request.backupSet, { recursive: true });
  };
  refuses(() => planRootKeyRotation(request, { betweenProofAndRebind: swap }),
    'not the same bytes', 'a set replaced between the proof and the digest');
  assertEq(loadKekRing(world.stateDir, world.root).active, 1, 'and nothing was changed');

  // AND THE TWO SETS REALLY ARE DIFFERENT, so what was refused was a binding that would have been wrong
  // rather than a comparison that could never fail. The decoy now plans on its own terms, self-consistently.
  const after = planRootKeyRotation(request);
  assert(after.backupSetDigest !== before.backupSetDigest, 'the swapped set has its own digest');
  assert(after.backupRingDigest !== before.backupRingDigest, 'and its own custody state');
  assert(after.planDigest !== before.planDigest, 'so the plan an operator confirmed cannot be spent on it');
});

await test('a retirement will not bind one set\'s digest to another set\'s custody proof', async () => {
  const world = await makeWorld('retire-toctou');
  const plan = planKekRotation(rotationRequest(world));
  runKekRotation({ ...rotationRequest(world), confirmDigest: plan.planDigest }, runnerFor());
  // The POST-rotation set, which is the only kind a retirement will look at.
  const request = {
    stateDir: world.stateDir, rootKeyFile: world.rootFile,
    backupSet: takeBackup(world.project, 'set-post'), generation: 1,
  };
  const planned = planKekRetirement(request);
  assert(planned.planDigest.length === 64, 'the retirement plans against the set it verified');

  const decoy = await makeWorld('retire-toctou-decoy');
  refuses(() => planKekRetirement(request, {
    betweenProofAndRebind: () => {
      rmSync(request.backupSet, { recursive: true, force: true });
      cpSync(decoy.backupSet, request.backupSet, { recursive: true });
    },
  }), 'not the same bytes', 'a set replaced between the retirement proof and the digest');
  assertEq(loadKekRing(world.stateDir, world.root).generations.length, 2,
    'and the generation is still in the ring');
});

await test('a migration plan will not claim a key-set proof over a keystore that moved', async () => {
  // THE SAME RULE, ONE DIRECTORY OVER. `keystoreSetDigest` and the unwrap proof are two walks of the
  // keystore; a plan that took the digest from one and the proof from the other would tell an operator that
  // all N of these keys open under this key about a set the digest does not describe.
  const world = await makeWorld('migrate-set-toctou', { migrate: false });
  const staticFile = join(world.project, 'static_kek');
  writeFileSync(staticFile, `${world.staticKek.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  const request = {
    stateDir: world.stateDir, rootKeyFile: world.rootFile,
    staticKeyFile: staticFile, backupSet: world.backupSet,
  };
  const planned = planKekMigration(request);
  assertEq(planned.keysProved, world.keyIds.length, 'the plan covers every key in the keystore');

  const keysDir = join(world.stateDir, 'keys');
  const victim = join(keysDir, readdirSync(keysDir)[0]!);
  const held = readFileSync(victim);
  refuses(() => planKekMigration(request, {
    betweenProofAndRebind: () => { rmSync(victim, { force: true }); },
  }), 'changed while this plan was being computed', 'a key file removed between the proof and the digest');
  assertEq(existsSync(kekRingPath(world.stateDir)), false, 'and no ring was written');
  writeFileSync(victim, held);
  assertEq(planKekMigration(request).planDigest, planned.planDigest, 'the restored keystore plans as it did');
});

await test('a state directory whose descriptor will not open is refused, not downgraded to a name check', async () => {
  // THE DEFECT: the comment said the `lstat` fallback was for Windows, which has no `O_NOFOLLOW`. The code
  // took it on ANY open failure — so on POSIX a permission refusal silently answered a question about a NAME
  // in place of the descriptor identity a caller asked for. Every proof that brackets a listing with this is
  // resting on it being a boundary.
  const dir = join(WORK, 'identity-boundary');
  mkdirSync(dir, { recursive: true });
  const real = stateDirectoryIdentity(dir);
  assert(Number.isFinite(real.dev), 'a real directory has an identity');

  const throwing = (code: string) => (): number => {
    const err = new Error(code) as NodeJS.ErrnoException;
    err.code = code;
    throw err;
  };
  // THE THREE THE PLATFORM IS ACTUALLY TELLING US SOMETHING WITH, mapped as they always were.
  refuses(() => stateDirectoryIdentity(dir, { open: throwing('ENOENT') }), 'is not there', 'an absent name');
  refuses(() => stateDirectoryIdentity(dir, { open: throwing('ELOOP') }), 'symbolic link', 'a link');
  refuses(() => stateDirectoryIdentity(dir, { open: throwing('ENOTDIR') }), 'not a directory', 'a non-directory');

  // AND EVERY OTHER ONE, ON POSIX, IS A REFUSAL RATHER THAN A WEAKER ANSWER. Both platform branches are put
  // here rather than only the one this suite happens to be running on: a rule checked on one host is a rule
  // half-checked, and the shipped deployment is the branch a Windows dev box would never reach.
  for (const code of ['EACCES', 'EPERM', 'EMFILE', 'EIO']) {
    refuses(() => stateDirectoryIdentity(dir, { open: throwing(code), windows: false }), 'could not be opened',
      `a POSIX ${code} must not become an lstat`);
    // Windows has neither `O_NOFOLLOW` nor `O_DIRECTORY`, so the name-based check IS the guarantee that
    // platform can support, and it is still a check — a link and a non-directory are still refused there.
    assertEq(stateDirectoryIdentity(dir, { open: throwing(code), windows: true }).ino, real.ino,
      'on Windows the stated fallback answers');
  }
  if (POSIX) {
    const link = join(WORK, 'identity-link');
    if (!existsSync(link)) symlinkSync(dir, link, 'dir');
    refuses(() => stateDirectoryIdentity(link, { open: throwing('EACCES'), windows: true }), 'symbolic link',
      'the Windows fallback still refuses a link');
  }

  // AND A REAL PERMISSION REFUSAL, where the platform can produce one and this process is not root.
  if (POSIX && process.getuid!() !== 0) {
    const walled = join(WORK, 'identity-walled');
    const inner = join(walled, 'keys');
    mkdirSync(inner, { recursive: true });
    chmodSync(walled, 0o000);
    try {
      refuses(() => stateDirectoryIdentity(inner), 'could not be opened', 'a directory this process cannot reach');
      // AND THE CALLER THAT BRACKETS ITS LISTING WITH IT REFUSES TOO, rather than digesting an empty set.
      refuses(() => keystoreSetDigest(walled), 'not one this build will read', 'the key-set proof over it');
    } finally { chmodSync(walled, 0o700); }
  }
});

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
