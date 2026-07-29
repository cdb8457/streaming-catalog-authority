import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { SCHEMA_VERSION, decryptUtf8, encryptUtf8, type Aad } from '../src/core/crypto/envelope.js';
import {
  activeKek,
  adoptStaticKekAsRing,
  beginPendingGeneration,
  kekForGeneration,
  kekRingExists,
  loadKekRing,
  readRootWrappingKey,
  summarizeKekRing,
  wholeRingDigest,
  type KekRing,
} from '../src/core/crypto/kek-ring.js';
import { writeStateDocument } from '../src/core/crypto/custodian-state-io.js';
import { SIDECAR_PROTOCOL_VERSION } from '../src/core/crypto/sidecar-ipc.js';
import { REQUIRED_SECRET_FILES } from '../src/ops/backup-components.js';
import {
  COMPONENT_ARTIFACT_NAMES,
  copyTree,
  runVerifiedCompleteBackup,
} from '../src/ops/complete-backup.js';
import {
  planCustodyCutover,
  runCustodyCutover,
  type CustodyCutoverRequest,
} from '../src/ops/custody-cutover.js';
import { verifyBackupSet } from '../src/ops/backup-set-verification.js';
import {
  BOOTSTRAP_COMPOSE_FILE,
  CUSTODY_MODE_FILENAME,
  RUNTIME_COMPOSE_FILE,
  readCustodyRuntimeMode,
} from '../src/ops/custody-runtime-mode.js';
import {
  launcherComposeArgs,
  planCustodyTransition,
  runCustodyTransition,
  type CustodyTransitionRequest,
} from '../src/ops/custody-transition.js';
import {
  assertStaticKekOpensKeystore,
  countKeystoreEntries,
  keystoreSetDigest,
  ROTATION_JOURNAL_NAME,
  planKekMigration,
  planKekRetirement,
  planKekRotation,
  readRotationJournal,
  retireKekGeneration,
  runKekRotation,
} from '../src/ops/kek-rotation.js';
import {
  CommandLedger,
  publishDirectory,
  writePrivateFile,
  removeOwnTreeNoFollow,
  type MaintenanceCommand,
} from '../src/ops/maintenance-safety.js';
import { assertLedgerIsClean, fakeDumpText, fakeToolchain } from './helpers/fake-toolchain.js';

// Phases 294-296 — ONE managed-custody lifecycle, rehearsed end to end on a disposable installation.
//
// -----------------------------------------------------------------------------------------------------
// WHAT THIS FILE IS, AND WHAT IT IS NOT.
// -----------------------------------------------------------------------------------------------------
//
// Every piece of this tranche has its own suite: the transition classifies, the cutover switches, the
// rotation rotates, the backup verifies, the restore restores. What none of them says is whether the WHOLE
// SEQUENCE holds together on one installation — whether the keys a released v1.1.4 deployment is holding
// today survive being classified, backed up, adopted into a ring, rotated, audited, interrupted, resumed,
// retired from and finally rolled back to exactly where they started.
//
// So this is not a unit suite and it is not written as independent cases. It is ONE installation walked
// through ONE lifecycle in order, and each stage depends on the one before it. A failure aborts the rest,
// because a rehearsal that continued past a broken stage would be reporting on a state nobody produced.
//
// THE CRYPTOGRAPHY IS REAL. The keystore, the wrapped keys, the ring, the root wrapping key, the backup
// manifests and their verification, the rotation and the retirement are all the shipped code paths over a
// real filesystem. The DATA is real too: every item is sealed with a DEK this custodian provisioned, and
// the exact plaintext is demanded back after every custody change — which is the only claim an operator
// actually cares about.
//
// THE DOCKER SIDE IS FAKE, AND IT IS LABELLED. Stopping containers on a NAS is not something a suite may
// do, so the orchestration runner is injected and the LEDGER is the evidence: which commands would have
// been built, with which compose files and which mounts. No daemon, no image, no pull, no network.
//
// WHAT IS DELIBERATELY ABSENT. There is no database here. The complete backup's database component is the
// fake toolchain's dump, as it is in every other suite in this tranche, and the product's DATABASE restore
// rehearsal (`src/ops/rehearse.ts`) needs a live throwaway PostgreSQL — it is out of scope for a no-network
// run and is named here rather than silently skipped.

let passed = 0;
let failed = 0;
let skipped = 0;
let aborted = false;
const failures: Array<[string, unknown]> = [];

/**
 * One stage of the lifecycle. Ordered, and the first failure stops the rest.
 *
 * A REHEARSAL IS NOT A TEST MATRIX. Stage 7b restores what stage 1 recorded; running it after stage 4 failed
 * would produce a green line about an installation that never reached the state being rolled back from.
 */
async function stage(title: string, fn: () => void | Promise<void>): Promise<void> {
  if (aborted) { skipped += 1; console.log(`  SKIP  ${title} (an earlier stage failed)`); return; }
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${title}`);
  } catch (err) {
    failed += 1;
    aborted = true;
    failures.push([title, err]);
    console.log(`  FAIL  ${title}: ${(err as Error).message}`);
  }
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
const POSIX = process.platform !== 'win32';
const SECRET = 'a-completion-secret-that-must-never-reach-a-report';

/** The disposable root. Everything this rehearsal creates lives under it and nothing outside it is touched. */
const WORK = mkdtempSync(join(tmpdir(), 'catalog-custody-rehearsal-'));

function schemaVersion(): number {
  return Number(/MIGRATION_VERSION\s*=\s*([0-9]+)/.exec(readRepo('src/db/schema-version.ts'))![1]);
}

/** One catalog item: a real DEK, real sealed bytes, and the exact text that must come back out. */
interface SealedItem {
  readonly itemId: string;
  readonly keyId: string;
  readonly plaintext: string;
  readonly sealed: Buffer;
}

/** The installation this rehearsal walks. Populated by stage 1 and mutated by the stages after it. */
interface Installation {
  readonly projectRoot: string;
  readonly appdata: string;
  readonly stateDir: string;
  readonly secretsDir: string;
  readonly backupsDir: string;
  readonly rootKeyFile: string;
  readonly staticKeyFile: string;
  readonly staticKek: Buffer;
  readonly items: readonly SealedItem[];
  /** Digests of the legacy pre-state, recorded before anything moved. */
  readonly preState: { readonly keystoreDigest: string; readonly keyCount: number };
}

let live!: Installation;
/** Every ledger this rehearsal produced, so the no-secret and no-media scans cover all of them at the end. */
const ledgers: CommandLedger[] = [];
/** Every report object this rehearsal produced, scanned at the end for key material. */
const reports: unknown[] = [];
/** Values that must never appear in a report, a ledger or a rendered line. */
const forbidden: string[] = [];
/** The digest of the pre-upgrade set as it verified, so the rollback can prove the set was only ever read. */
let preUpgradeSetDigest = '';
/** The digest of the rotation an operator confirmed, carried across the interruption and the resume. */
let rotationPlanDigestNow = '';

const aadFor = (itemId: string): Aad => ({ itemId, keyEpoch: 0, schemaVersion: SCHEMA_VERSION, field: 'identity' });

/** Where a backup set lands. A NAME inside the installation's own backups directory, never a path. */
const setDir = (name: string): string => join(live.backupsDir, name);

/** Take a complete backup with the real command over the fake toolchain, and keep its ledger for the scans. */
function takeBackup(name: string): ReturnType<typeof runVerifiedCompleteBackup> {
  const tools = fakeToolchain({ dumpText: fakeDumpText(schemaVersion()) });
  ledgers.push(tools.ledger);
  const outcome = runVerifiedCompleteBackup({
    projectRoot: live.appdata,
    destination: 'backups',
    setName: name,
    custodian: 'sidecar',
    sidecarState: 'sidecar-state',
    secrets: 'secrets',
    promotionRecords: 'promotion-records',
  }, { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  reports.push(outcome.backup, outcome.verification);
  return outcome;
}

/** The ring as it is right now. */
const ringNow = (): KekRing => loadKekRing(live.stateDir, readRootWrappingKey(live.rootKeyFile));

/**
 * A custodian built the way `startSidecarDaemon` builds one — the active generation to wrap under, every
 * retained generation to unwrap under — or, before there is a ring, the static KEK the installation came
 * with. Asking the readability question any other way would be asking a friendlier question than the one a
 * restarted sidecar actually faces.
 */
function daemonCustodian(): FileCustodian {
  if (!kekRingExists(live.stateDir)) return new FileCustodian(live.stateDir, SECRET, live.staticKek);
  const ring = ringNow();
  const retained = ring.generations
    .filter((entry) => entry.generation !== ring.active)
    .map((entry) => Buffer.from(entry.keyHex, 'hex'));
  return new FileCustodian(live.stateDir, SECRET, activeKek(ring), () => Date.now(), retained);
}

/**
 * THE CLAIM AN OPERATOR ACTUALLY CARES ABOUT: every item still gives back the exact bytes it was sealed with.
 *
 * Not "the key file parses", not "the count matches" — the original plaintext, through the real custodian,
 * the real ring and the real envelope, after whatever the last stage did to the custody underneath it.
 */
async function everyItemReturnsItsExactData(what: string): Promise<void> {
  const custodian = daemonCustodian();
  for (const item of live.items) {
    const dek = await custodian.get(item.keyId, 0);
    assertEq(decryptUtf8(dek, item.sealed, aadFor(item.itemId)), item.plaintext,
      `${what}: item ${item.itemId.slice(0, 8)} returns exactly what it was sealed with`);
  }
}

/** The request every transition call in this rehearsal makes, against one named set inside the backups dir. */
function transitionRequest(setName: string): CustodyTransitionRequest {
  return {
    projectRoot: live.projectRoot,
    projectName: 'catalogauthority',
    backupSetName: setName,
    hostStateDir: live.stateDir,
    hostRootKeyFile: live.rootKeyFile,
    hostStaticKeyFile: live.staticKeyFile,
    hostBackupsDir: live.backupsDir,
  };
}

/** A runner for the plan-time `compose config`, which renders a configuration and touches nothing. */
function composeRunner(): { runner: (command: MaintenanceCommand) => { status: number; stdout: string; stderr: string }; ledger: CommandLedger } {
  const ledger = new CommandLedger();
  ledgers.push(ledger);
  const runner = (command: MaintenanceCommand) => ({
    status: 0,
    stdout: `name: catalogauthority
files: ${command.args.filter((word) => word.endsWith('.yml')).join(',')}
`,
    stderr: '',
  });
  return { runner, ledger };
}

/** The cutover request: the same installation, addressed by the set NAME the compose files already mount. */
function cutoverRequest(): CustodyCutoverRequest {
  return {
    projectRoot: live.projectRoot,
    projectName: 'catalogauthority',
    backupSetName: 'authorizing',
    hostStateDir: live.stateDir,
    hostRootKeyFile: live.rootKeyFile,
    hostStaticKeyFile: live.staticKeyFile,
    hostBackupsDir: live.backupsDir,
  };
}

/**
 * A FAKE STACK: it answers every compose command the cutover builds, and records all of them.
 *
 * It is fake on purpose and it is labelled everywhere it is used. What it stands in for is a Docker daemon
 * on a NAS; what it does NOT stand in for is the migration, which really runs the shipped adoption over this
 * installation's real state directory.
 */
function stackRunner(options: { planDigest: string; onMigrate?: () => void }): {
  runner: (command: MaintenanceCommand) => { status: number; stdout: string; stderr: string };
  ledger: CommandLedger;
} {
  const ledger = new CommandLedger();
  ledgers.push(ledger);
  const runner = (command: MaintenanceCommand) => {
    const args = command.args.join(' ');
    const mode: 'bootstrap' | 'root-only' = args.includes(BOOTSTRAP_COMPOSE_FILE) ? 'bootstrap' : 'root-only';
    if (args.includes('config')) return { status: 0, stdout: `name: catalogauthority\nmode: ${mode}\n`, stderr: '' };
    if (args.includes('migrate') && args.includes('--plan')) {
      return { status: 0, stdout: `plan digest: ${options.planDigest}\n`, stderr: '' };
    }
    if (args.includes('migrate') && args.includes('--confirm-digest')) {
      options.onMigrate?.();
      return { status: 0, stdout: 'The static KEK is now generation 1 of a sidecar-managed ring.\n', stderr: '' };
    }
    if (args.includes('ops:sidecar-health')) {
      const health = mode === 'root-only'
        ? {
          op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: true, custodian: 'sidecar-managed-ring',
          ringGeneration: 1, ringActiveCreatedAt: 1_000,
        }
        : {
          op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: true, custodian: 'file-reference-harness',
          ringGeneration: null, ringActiveCreatedAt: null,
        };
      return { status: 0, stdout: `> catalog-authority\n${JSON.stringify(health)}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { runner, ledger };
}

/** The rotation request: this installation, its root key and the set that must verify before anything moves. */
function rotationRequest(): { stateDir: string; rootKeyFile: string; backupSet: string; projectRoot: string; projectName: string } {
  return {
    stateDir: live.stateDir,
    rootKeyFile: live.rootKeyFile,
    backupSet: setDir('pre-rotation'),
    projectRoot: live.projectRoot,
    projectName: 'catalogauthority',
  };
}

/** The FAKE quiesce: a rotation stops and starts the app and the sidecar, and this records that it did. */
function rotationRunner(): { runner: (command: MaintenanceCommand) => { status: number; stdout: string; stderr: string }; ledger: CommandLedger } {
  const ledger = new CommandLedger();
  ledgers.push(ledger);
  return { runner: () => ({ status: 0, stdout: '', stderr: '' }), ledger };
}

console.log('Running the Phases 294-296 managed-custody lifecycle rehearsal:\n');
console.log('  (the cryptography, the backups and the ring are real; the Docker orchestration is a FAKE');
console.log('   injected command ledger — no daemon, no image, no pull, no network)\n');

// ---------------------------------------------------------------------------------------------------------
// 1. A released v1.1.4 installation, and the rollback set taken before anything moves
// ---------------------------------------------------------------------------------------------------------

await stage('1. a released v1.1.4 installation: static KEK custody, no ring, no root key, no marker', async () => {
  const projectRoot = join(WORK, 'installation');
  const appdata = join(projectRoot, 'appdata');
  const stateDir = join(appdata, 'sidecar-state');
  const secretsDir = join(appdata, 'secrets');
  mkdirSync(secretsDir, { recursive: true });
  mkdirSync(join(appdata, 'promotion-records'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  // The compose files exactly as an installation has them: copied from the repository, never edited here.
  for (const file of [RUNTIME_COMPOSE_FILE, BOOTSTRAP_COMPOSE_FILE]) {
    writeFileSync(join(projectRoot, file), readRepo(file));
  }
  for (const file of REQUIRED_SECRET_FILES) {
    writeFileSync(join(secretsDir, file), `${file}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  writeFileSync(join(appdata, 'promotion-records', 'record.json'), '{}\n', 'utf8');

  // ---- REAL KEYS OVER REAL DATA ----------------------------------------------------------------------
  //
  // A lifecycle rehearsed over an empty keystore would prove that commands ran. Every item below is sealed
  // with a DEK this custodian provisioned, and the exact plaintext is demanded back after every custody
  // change from here to the rollback.
  const staticKek = randomBytes(32);
  writeFileSync(join(secretsDir, 'custodian_kek'), `${staticKek.toString('hex')}\n`,
    { encoding: 'utf8', mode: 0o600 });
  const custodian = new FileCustodian(stateDir, SECRET, staticKek);
  const items: SealedItem[] = [];
  for (let index = 0; index < 4; index += 1) {
    const itemId = randomUUID();
    const provision = await custodian.provision(`op-${index}`, itemId, 0);
    await custodian.commitProvision(`op-${index}`);
    const dek = await custodian.get(provision.keyId, 0);
    const plaintext = `catalog identity ${index} — ${itemId}`;
    items.push({ itemId, keyId: provision.keyId, plaintext, sealed: encryptUtf8(dek, plaintext, aadFor(itemId)) });
    forbidden.push(dek.toString('hex'), plaintext);
  }
  forbidden.push(staticKek.toString('hex'), SECRET);

  // ---- THE PRE-STATE, STATED RATHER THAN ASSUMED -----------------------------------------------------
  assertEq(kekRingExists(stateDir), false, 'a v1.1.4 installation has no ring');
  assertEq(existsSync(join(secretsDir, 'custodian_root_key')), true,
    'the required-secret placeholder is at the root key path while the rollback set is taken (see 1b)');
  assertEq(readCustodyRuntimeMode(projectRoot).declared, false, 'and nobody has declared a runtime mode');
  assertEq(readCustodyRuntimeMode(projectRoot).mode, 'root-only', 'so the default is the steady state');
  const keystoreDigest = keystoreSetDigest(stateDir);
  const keyCount = countKeystoreEntries(stateDir);
  assertEq(keyCount, items.length, 'every provisioned key is on disk');
  assertEq(assertStaticKekOpensKeystore(stateDir, staticKek), items.length,
    'and the static KEK opens every one of them');

  live = {
    projectRoot,
    appdata,
    stateDir,
    secretsDir,
    backupsDir: join(appdata, 'backups'),
    rootKeyFile: join(secretsDir, 'custodian_root_key'),
    staticKeyFile: join(secretsDir, 'custodian_kek'),
    staticKek,
    items,
    preState: { keystoreDigest, keyCount },
  };
});

await stage('1b. the pre-upgrade rollback set is taken by the real command and verifies', () => {
  const outcome = takeBackup('pre-upgrade');
  assertEq(outcome.ok, true, `the pre-upgrade set verifies as it is taken: ${JSON.stringify(outcome.failures)}`);

  // AND IT IS VERIFIED AGAIN, BY THE VERIFIER, FROM WHAT IS ON DISK. The set this rehearsal rolls back to at
  // the end is the one thing it may not take on trust.
  const verification = verifyBackupSet(setDir('pre-upgrade'));
  reports.push(verification);
  assertEq(verification.ok, true, `the set on disk verifies: ${JSON.stringify(verification.problems)}`);
  for (const component of ['keystore', 'secrets', 'database'] as const) {
    assertEq(verification.verified.includes(component), true, `the set carries a verified ${component}`);
  }
  assertEq(verification.restorableUnderThisBuild, true, 'and this build could actually restore it');
  preUpgradeSetDigest = verification.setDigest;

  // THE HONEST NOTE ABOUT THIS SET, because it is the one place the rehearsal cannot reproduce a released
  // installation exactly. `REQUIRED_SECRET_FILES` has held `custodian_root_key` since the stack declared it,
  // so the shipped verifier refuses a complete backup that has no file at that name — which means a genuine
  // v1.1.4 deployment cannot take a complete rollback set until SOMETHING is there. What this fixture puts
  // there is the same placeholder every other required secret carries, and the rollback stage at the end
  // proves exactly that, rather than pretending the file is absent.
  const restoredRoot = join(setDir('pre-upgrade'), COMPONENT_ARTIFACT_NAMES.secrets, 'custodian_root_key');
  assertEq(readFileSync(restoredRoot, 'utf8'), 'custodian_root_key\n',
    'the pre-upgrade set carries the placeholder, not a root wrapping key');

  // AND NOW THE INSTALLATION IS EXACTLY WHAT A RELEASED ONE IS: nothing at all at that path. The placeholder
  // existed to satisfy the required-secret NAME while the set was taken; leaving it there would make this
  // rehearsal classify a state no v1.1.4 deployment is in — and the classifier is right to call a file that
  // is not a key a custody failure rather than a missing prerequisite.
  rmSync(live.rootKeyFile, { force: true });
  assertEq(existsSync(live.rootKeyFile), false, 'the live installation has no root wrapping key at all');
  assertEq(existsSync(join(setDir('pre-upgrade'), COMPONENT_ARTIFACT_NAMES.secrets, 'custodian_root_key')), true,
    'while the set it just took still holds that name');
});

// ---------------------------------------------------------------------------------------------------------
// 2. The plan that changes nothing, the confirmation that is refused, and the root key
// ---------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------
// 3. The transition onto the bootstrap overlay
// ---------------------------------------------------------------------------------------------------------

await stage('2. the transition plans read-only, and a confirmation with no root key is refused', async () => {
  const before = keystoreSetDigest(live.stateDir);
  const tools = composeRunner();
  const plan = planCustodyTransition(transitionRequest('pre-upgrade'), tools);
  reports.push(plan.evidence);

  assertEq(plan.evidence.verdict, 'legacy-static', 'the installation is classified from its static KEK');
  assertEq(plan.evidence.selectedMode, 'bootstrap', 'which the bootstrap overlay is the runtime for');
  assertEq(plan.evidence.keysProved, live.items.length, 'every wrapped key was proved to open under it');
  assertEq(plan.evidence.ringGeneration, null, 'there is no ring to have a generation');
  assertEq(plan.evidence.rootKeyReady, false, 'and the root wrapping key this build needs is not there yet');
  assertEq(plan.changes, true, 'so something would change');

  // PLANNING CHANGED NOTHING. Not the keystore, not the ring, not the marker.
  assertEq(keystoreSetDigest(live.stateDir), before, 'planning moved no key file');
  assertEq(kekRingExists(live.stateDir), false, 'planning wrote no ring');
  assertEq(readCustodyRuntimeMode(live.projectRoot).declared, false, 'planning declared no mode');

  // ---- AND THE CONFIRMATION IS REFUSED, BECAUSE THE PREREQUISITE IS MISSING ---------------------------
  //
  // This is the refusal the whole transition exists to make safely: the base compose file BINDS the root key
  // path, so starting the stack with nothing there is how Docker creates a DIRECTORY at the name the most
  // sensitive file in the installation belongs at.
  refuses(() => runCustodyTransition({ ...transitionRequest('pre-upgrade'), confirmDigest: plan.planDigest }, tools),
    'root wrapping key', 'confirming a transition with no root key');
  assertEq(readCustodyRuntimeMode(live.projectRoot).declared, false, 'and no mode was selected');
  assertEq(keystoreSetDigest(live.stateDir), before, 'and no key file moved');
  assertEq(existsSync(join(live.projectRoot, CUSTODY_MODE_FILENAME)), false, 'and no marker was written');
  await everyItemReturnsItsExactData('after a refused transition');
});

await stage('2b. the root wrapping key is established through the shipped primitive, off argv and off env', () => {
  const helper = join(repoRoot, 'deploy', 'write-custody-secret.mjs');
  const uid = POSIX && typeof process.getuid === 'function' ? String(process.getuid()) : '0';
  const gid = POSIX && typeof process.getgid === 'function' ? String(process.getgid()) : '0';
  const argv = [helper, live.rootKeyFile, '--generate', uid, gid];
  const run = spawnSync(process.execPath, argv, { encoding: 'utf8' });

  // THE KEY IS NOT ON THE COMMAND LINE AND NOT IN THE ENVIRONMENT, whichever way this host answers. A
  // command line is readable in `ps` by every account on the box for as long as the process lives.
  assertEq(argv.some((word) => /^[0-9a-f]{64}$/.test(word)), false, 'no key material was passed as an argument');
  assertEq(/[0-9a-f]{64}/.test(`${run.stdout}${run.stderr}`), false, 'and none was printed');

  if (run.status === 0) {
    const root = readRootWrappingKey(live.rootKeyFile);
    assertEq(root.length, 32, 'the helper established a real 32-byte root wrapping key');
    forbidden.push(root.toString('hex'));
    root.fill(0);
    return;
  }

  // ---- THE HOST CANNOT HOLD IT, AND THE SHIPPED PRIMITIVE SAYS SO RATHER THAN PRODUCING A WEAKER KEY ----
  //
  // `assertPlatformCanHoldCustody` refuses on a platform with no file ownership model, BEFORE anything is
  // created, and there is no flag that turns that into a success. That refusal is proved here — and only
  // then does the rehearsal put a key in place itself, through the product's own private-file writer, so
  // the lifecycle can continue. It is a FIXTURE STEP, forced by the host, and it is labelled as one: no
  // production path is being invented, and the shipped path's answer on this host is "nothing was created".
  assert(run.stderr.includes('REFUSING'), `the shipped helper refused with a reason: ${run.stderr.trim()}`);
  assertEq(existsSync(live.rootKeyFile), false, 'and NOTHING was created at the root key path');
  console.log(`        (the shipped custody-secret helper refuses on ${process.platform}: no file ownership`);
  console.log('         model. Its refusal and its "nothing was created" are proved above; the root key is');
  console.log('         then placed by the product\'s own private-file writer so the rehearsal can continue)');
  const generated = randomBytes(32).toString('hex');
  writePrivateFile(live.rootKeyFile, `${generated}\n`, 'rehearsal root wrapping key');
  forbidden.push(generated);
  assertEq(readRootWrappingKey(live.rootKeyFile).length, 32, 'and a real root wrapping key is now in place');
});

await stage('3. only a backup that carries the new root key may authorize the transition', async () => {
  const tools = composeRunner();

  // THE PRE-UPGRADE SET PREDATES THE ROOT KEY. It is a perfectly good rollback set and it is NOT an
  // authorization: restoring it would put back an installation whose secrets do not open the ring this
  // transition leads to.
  refuses(() => planCustodyTransition(transitionRequest('pre-upgrade'), tools),
    'root wrapping key', 'a set taken before the root key existed');
  assertEq(readCustodyRuntimeMode(live.projectRoot).declared, false, 'and nothing was selected');

  const outcome = takeBackup('authorizing');
  assertEq(outcome.ok, true, `the authorizing set verifies: ${JSON.stringify(outcome.failures)}`);
  const verification = verifyBackupSet(setDir('authorizing'));
  reports.push(verification);
  assertEq(verification.ok, true, 'and verifies again from disk');
  assertEq(readFileSync(join(setDir('authorizing'), COMPONENT_ARTIFACT_NAMES.secrets, 'custodian_root_key'), 'utf8'),
    readFileSync(live.rootKeyFile, 'utf8'), 'and it carries the live root wrapping key itself');

  const plan = planCustodyTransition(transitionRequest('authorizing'), tools);
  assertEq(plan.evidence.rootKeyReady, true, 'now the prerequisite is in place');
  assertEq(plan.evidence.selectedMode, 'bootstrap', 'and the overlay is still what this state runs on');

  // A STALE CONFIRMATION IS NOT A CONFIRMATION.
  refuses(() => runCustodyTransition({ ...transitionRequest('authorizing'), confirmDigest: null }, tools),
    'digest you confirmed', 'a transition with no digest');
  refuses(() => runCustodyTransition({ ...transitionRequest('authorizing'), confirmDigest: 'f'.repeat(64) }, tools),
    'digest you confirmed', 'a transition with a wrong digest');
  assertEq(readCustodyRuntimeMode(live.projectRoot).declared, false, 'and neither selected anything');

  const report = runCustodyTransition(
    { ...transitionRequest('authorizing'), confirmDigest: plan.planDigest }, tools);
  reports.push(report);
  assertEq(report.ok, true, 'the confirmed transition completes');
  assertEq(report.changed, true, 'and it changed the selection');
  assertEq(report.toMode, 'bootstrap', 'onto the bootstrap overlay');
  assertEq(report.network, 'none', 'reaching no network');
  assertEq(readCustodyRuntimeMode(live.projectRoot).mode, 'bootstrap', 'and the marker says so');
  assertEq(launcherComposeArgs(live.projectRoot).join(' '),
    `-f ${RUNTIME_COMPOSE_FILE} -f ${BOOTSTRAP_COMPOSE_FILE}`, 'so the launcher starts the overlay');

  // AND THE KEYS ARE UNTOUCHED. A transition selects a runtime; it does not move key material.
  assertEq(keystoreSetDigest(live.stateDir), live.preState.keystoreDigest, 'no key file moved');
  assertEq(kekRingExists(live.stateDir), false, 'and there is still no ring');
  await everyItemReturnsItsExactData('after the transition');
});

// ---------------------------------------------------------------------------------------------------------
// 4. The cutover: the static KEK becomes generation 1, and the runtime becomes root-only
// ---------------------------------------------------------------------------------------------------------

await stage('4. the confirmed cutover adopts the static KEK as generation 1 and ends root-only', async () => {
  const migrationDigest = planKekMigration({
    stateDir: live.stateDir,
    rootKeyFile: live.rootKeyFile,
    staticKeyFile: live.staticKeyFile,
    backupSet: setDir('authorizing'),
  }).planDigest;

  // THE MIGRATION THE FAKE STACK PERFORMS IS THE REAL ONE. `onMigrate` runs the shipped adoption over the
  // real state directory, so a "successful cutover" here is one after which a real ring really exists and
  // the old static key really is generation 1 of it.
  let adopted = false;
  const tools = stackRunner({
    planDigest: migrationDigest,
    onMigrate: () => {
      const root = readRootWrappingKey(live.rootKeyFile);
      try {
        adoptStaticKekAsRing(live.stateDir, root, live.staticKek, () => 1_000);
        adopted = true;
      } finally { root.fill(0); }
    },
  });

  const plan = planCustodyCutover(cutoverRequest(), tools);
  assertEq(plan.stage, 'migrate-and-switch', 'there is a migration to do and a runtime to switch');
  assertEq(plan.fromMode, 'bootstrap', 'from the overlay the transition selected');
  assertEq(plan.toMode, 'root-only', 'to the canonical steady state');
  assertEq(kekRingExists(live.stateDir), false, 'and planning wrote no ring');

  refuses(() => runCustodyCutover({ ...cutoverRequest(), confirmDigest: 'f'.repeat(64) }, tools),
    'digest you confirmed', 'a cutover with a wrong digest');
  assertEq(kekRingExists(live.stateDir), false, 'and nothing was migrated');

  const report = runCustodyCutover({ ...cutoverRequest(), confirmDigest: plan.planDigest }, tools);
  reports.push(report);
  assertEq(report.ok, true, `the cutover completes: ${JSON.stringify(report.notes)}`);
  assertEq(adopted, true, 'the real adoption ran');
  assertEq(report.migrationPerformed, true, 'and the report says this run performed it');
  assertEq(report.toMode, 'root-only', 'the runtime ends on the steady state');
  assertEq(report.network, 'none', 'reaching no network');
  assertEq(readCustodyRuntimeMode(live.projectRoot).declared, false, 'the marker is gone, which IS root-only');
  assertEq(existsSync(join(live.projectRoot, CUSTODY_MODE_FILENAME)), false, 'no marker file is left behind');

  // ---- THE RING IS REAL, AND GENERATION 1 IS THE KEY THIS INSTALLATION ALREADY HAD --------------------
  const ring = ringNow();
  assertEq(ring.active, 1, 'the ring is on generation 1');
  assertEq(kekForGeneration(ring, 1).toString('hex'), live.staticKek.toString('hex'),
    'and generation 1 IS the static KEK this installation came with');

  // NOTHING WAS REWRAPPED, which is what makes the adoption non-destructive: the same key, held differently.
  assertEq(keystoreSetDigest(live.stateDir), live.preState.keystoreDigest, 'every wrapped key is byte-identical');
  assertEq(countKeystoreEntries(live.stateDir), live.preState.keyCount, 'and none was added or lost');
  await everyItemReturnsItsExactData('after the cutover');

  // ---- AND THE STATIC KEK IS NOT IN THE RUNTIME THE STACK NOW STARTS ----------------------------------
  assertEq(launcherComposeArgs(live.projectRoot).join(' '), `-f ${RUNTIME_COMPOSE_FILE}`,
    'the launcher now starts the steady-state file alone');
  const runtimeText = readRepo(RUNTIME_COMPOSE_FILE);
  assertEq(/custodian_kek/.test(runtimeText), false, 'which names no static KEK at all');
  // TOKENS, NOT SUBSTRINGS: '--backup-set' contains the letters of 'up', and a proof that matched it would
  // be reading the migration's own argument list as though it were a service start.
  const afterSwitch = tools.ledger.all()
    .filter((entry) => entry.args.includes('up') || entry.args.includes('start'))
    .map((entry) => entry.args.join(' '));
  assert(afterSwitch.length > 0, 'the stack really was started again');
  for (const line of afterSwitch) {
    assertEq(line.includes(BOOTSTRAP_COMPOSE_FILE), false,
      `no post-cutover command carries the overlay: ${line}`);
    assertEq(line.includes('custodian_kek'), false, `and none carries the static KEK: ${line}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// 5. Rotation to generation 2, interrupted, observed, and resumed
// ---------------------------------------------------------------------------------------------------------

await stage('5. the rotation is gated on a digest and a backup that verifies NOW', () => {
  const outcome = takeBackup('pre-rotation');
  assertEq(outcome.ok, true, `the pre-rotation set verifies: ${JSON.stringify(outcome.failures)}`);

  const plan = planKekRotation(rotationRequest());
  assertEq(plan.fromGeneration, 1, 'the rotation is away from generation 1');
  assertEq(kekRingExists(live.stateDir) && ringNow().pending, null, 'and planning created no pending generation');

  refuses(() => runKekRotation({ ...rotationRequest(), confirmDigest: null }, rotationRunner()),
    'digest you confirmed', 'a rotation with no digest');
  refuses(() => runKekRotation({ ...rotationRequest(), confirmDigest: 'f'.repeat(64) }, rotationRunner()),
    'digest you confirmed', 'a rotation with a wrong digest');
  assertEq(ringNow().active, 1, 'and the ring did not move for either');
  rotationPlanDigestNow = plan.planDigest;
});

await stage('5b. an interrupted rotation is OBSERVED without being repaired by the observation', async () => {
  // ---- THE INTERRUPTION IS BUILT FROM THE PRODUCT'S OWN OPERATIONS ------------------------------------
  //
  // A rotation runs its commands at the QUIESCE boundaries, so no injected runner failure can land in the
  // middle of the rewrap. The state a crash there leaves is therefore produced the way `test/kek-rotation.ts`
  // produces it: by performing the real steps up to that point — a real pending generation, a real rewrap of
  // every key onto it — and writing the journal the rotation itself would have written. Nothing here is a
  // hand-made ring.
  const root = readRootWrappingKey(live.rootKeyFile);
  try {
    const pending = beginPendingGeneration(live.stateDir, root, () => 2_000).generation;
    const ring = loadKekRing(live.stateDir, root);
    FileCustodian.rewrapKeystore(live.stateDir, {
      fromKek: kekForGeneration(ring, ring.active),
      toKek: kekForGeneration(ring, pending),
    });
    writeStateDocument(join(live.stateDir, 'ring', ROTATION_JOURNAL_NAME), {
      rotation: 'phase-283-kek-rotation',
      version: 1,
      planDigest: rotationPlanDigestNow,
      fromGeneration: ring.active,
      toGeneration: pending,
      stage: 'rewrapped',
      startedAt: 1,
    });
  } finally { root.fill(0); }

  // ---- THE OBSERVATION, AND WHAT IT MUST NOT DO ------------------------------------------------------
  const keystoreBefore = keystoreSetDigest(live.stateDir);
  const ringBefore = wholeRingDigest(ringNow());

  const journal = readRotationJournal(live.stateDir);
  assert(journal !== null, 'the interruption is detected by the product, from its own journal');
  assertEq(journal.stage, 'rewrapped', 'and the journal says exactly where it stopped');
  assertEq(ringNow().active, 1, 'the ring has NOT moved: the keys are ahead of the pointer');
  assertEq(ringNow().pending, 2, 'and a pending generation is waiting');
  await everyItemReturnsItsExactData('while a rotation is interrupted');

  assertEq(keystoreSetDigest(live.stateDir), keystoreBefore, 'observing changed no key file');
  assertEq(wholeRingDigest(ringNow()), ringBefore, 'and it changed no part of the ring');

  // ---- A DRIFT WITH NO REPAIR PATH IS REFUSED, AND THE FIXTURE IS PUT BACK ----------------------------
  //
  // A journal from a DIFFERENT rotation is the one shape the product deliberately does NOT repair: which
  // keys are under which generation would be a guess, and guessing is guessing at which items are readable.
  // There is no resume for it, so what is proved is the refusal — and then this rehearsal returns its own
  // fixture to the state it borrowed, rather than inventing a recovery the product does not have.
  const journalPath = join(live.stateDir, 'ring', ROTATION_JOURNAL_NAME);
  const genuine = readFileSync(journalPath);
  writeStateDocument(journalPath, { ...journal, planDigest: 'a'.repeat(64) });
  refuses(() => runKekRotation({ ...rotationRequest(), confirmDigest: rotationPlanDigestNow }, rotationRunner()),
    'DIFFERENT rotation', 'a journal from another rotation');
  assertEq(ringNow().active, 1, 'and the ring still did not move');
  assertEq(keystoreSetDigest(live.stateDir), keystoreBefore, 'nor did any key file');
  rmSync(journalPath, { force: true });
  writeFileSync(journalPath, genuine);
  assertEq(readRotationJournal(live.stateDir)!.planDigest, rotationPlanDigestNow,
    'and the interrupted rotation this stage is actually about is back exactly as it was');
});

await stage('5c. the product RESUMES the interrupted rotation to generation 2, and the audit is clean', async () => {
  const report = runKekRotation({ ...rotationRequest(), confirmDigest: rotationPlanDigestNow }, rotationRunner());
  reports.push(report);
  assertEq(report.ok, true, `the resume completes: ${JSON.stringify(report.notes)}`);
  assertEq(report.stage, 'activated', 'reaching activation');
  assertEq(report.toGeneration, 2, 'on generation 2');
  assertEq(report.verifiedAll, true, 'having proved every key reads under it before the ring moved');
  assert(report.notes.some((note) => note.includes('RESUMED')), 'and the report says it resumed');
  assertEq(report.restarted, true, 'the stack was started again');
  assertEq(report.stillStopped.length, 0, 'with nothing left down');

  // ---- THE AUDIT: THE REAL RING SUMMARY, THE REAL JOURNAL, THE REAL KEYSTORE SET ----------------------
  const ring = ringNow();
  const root = readRootWrappingKey(live.rootKeyFile);
  const summary = summarizeKekRing(ring, root);
  root.fill(0);
  reports.push(summary);
  assertEq(summary.active, 2, 'the audit reports generation 2 active');
  assertEq(summary.pending, null, 'with nothing pending');
  assertEq(summary.retained.join(','), '1', 'and generation 1 RETAINED, which is what keeps the pre-rotation set restorable');
  assertEq(summary.origin, 'generated-in-sidecar', 'the ACTIVE generation was made by the sidecar, not adopted');
  assertEq(ring.generations.find((entry) => entry.generation === 1)!.origin, 'adopted-from-static-kek',
    'while generation 1 still records that this ring began as the static KEK this installation had');
  assertEq(ring.generations.length, 2, 'two generations are in the ring');
  assertEq(readRotationJournal(live.stateDir), null, 'the journal is gone once the ring is authoritative');
  assertEq(countKeystoreEntries(live.stateDir), live.preState.keyCount, 'no key was added or lost');

  // EVERY KEY IS UNDER THE NEW GENERATION, asked the way the rotation itself asks it.
  const plan = FileCustodian.planRewrapKeystore(live.stateDir, {
    fromKek: activeKek(ring), toKek: activeKek(ring),
  });
  assertEq(plan.alreadyCurrent, plan.total, 'every wrapped key is under the active generation');
  assertEq(plan.total, live.preState.keyCount, 'and that is all of them');

  // AND THE STATIC KEK NO LONGER OPENS THE KEYSTORE, which is the difference a rotation actually makes.
  refuses(() => assertStaticKekOpensKeystore(live.stateDir, live.staticKek), 'does not open',
    'the key this installation was born with');
  assert(keystoreSetDigest(live.stateDir) !== live.preState.keystoreDigest,
    'and every key file really was rewritten');
  await everyItemReturnsItsExactData('after the rotation');
});

// ---------------------------------------------------------------------------------------------------------
// 6. Retirement of generation 1
// ---------------------------------------------------------------------------------------------------------

await stage('6. retirement is refused without its own backup gate, and allowed with it', async () => {
  // THE PRE-ROTATION SET WAS TAKEN WHILE GENERATION 1 WAS ACTIVE. Removing generation 1 with only that set
  // in hand would leave a backup nothing in the installation can open.
  refuses(() => planKekRetirement({
    stateDir: live.stateDir, rootKeyFile: live.rootKeyFile, backupSet: setDir('pre-rotation'), generation: 1,
  }), 'DIFFERENT generation', 'retiring against a pre-rotation set');
  assertEq(ringNow().generations.length, 2, 'and generation 1 is still there');

  const outcome = takeBackup('post-rotation');
  assertEq(outcome.ok, true, `the post-rotation set verifies: ${JSON.stringify(outcome.failures)}`);
  const retirement = {
    stateDir: live.stateDir, rootKeyFile: live.rootKeyFile, backupSet: setDir('post-rotation'), generation: 1,
  };
  const plan = planKekRetirement(retirement);
  assertEq(ringNow().generations.length, 2, 'planning removed nothing');

  refuses(() => retireKekGeneration({ ...retirement, confirmDigest: null }), 'digest you confirmed',
    'retiring with no confirmation');
  refuses(() => retireKekGeneration({ ...retirement, confirmDigest: 'f'.repeat(64) }), 'digest you confirmed',
    'retiring with a wrong confirmation');
  assertEq(ringNow().generations.length, 2, 'and neither removed anything');

  const report = retireKekGeneration({ ...retirement, confirmDigest: plan.planDigest });
  reports.push(report);
  assertEq(report.ok, true, 'the confirmed retirement completes');
  const ring = ringNow();
  assertEq(ring.generations.length, 1, 'generation 1 is gone from the ring');
  assertEq(ring.active, 2, 'and generation 2 is what is left');
  assertEq(ring.generations.some((entry) => entry.generation === 1), false, 'nothing of it remains');

  // AND GENERATION 2 STILL OPENS EVERY KEY, which is the only reason removing the other one was safe.
  await everyItemReturnsItsExactData('after generation 1 was retired');
  const plan2 = FileCustodian.planRewrapKeystore(live.stateDir, {
    fromKek: activeKek(ring), toKek: activeKek(ring),
  });
  assertEq(plan2.alreadyCurrent, live.preState.keyCount, 'every key still reads under generation 2');
});

// ---------------------------------------------------------------------------------------------------------
// 7. Rollback to the exact pre-upgrade set, and the disposable state removed
// ---------------------------------------------------------------------------------------------------------

await stage('7. the pre-upgrade set still verifies, byte for byte, after the whole lifecycle', () => {
  const verification = verifyBackupSet(setDir('pre-upgrade'));
  reports.push(verification);
  assertEq(verification.ok, true, `the rollback set still verifies: ${JSON.stringify(verification.problems)}`);
  assertEq(verification.setDigest, preUpgradeSetDigest,
    'and it is digest-for-digest the set that was taken before anything moved — it was only ever READ');
});

await stage('7b. the exact pre-upgrade state is restored, and the original data comes back', async () => {
  // ---- THE RESTORE USES THE PRODUCT'S OWN PRIMITIVES, NOT A CONVENIENT COPY ---------------------------
  //
  // WHAT EXISTS AND WHAT DOES NOT. This repository has no single "restore a complete set" command: the
  // DATABASE half is `src/ops/rehearse.ts`, which restores into a throwaway PostgreSQL and is out of scope
  // for a run with no database. What it does have are the bounded, no-follow primitives the backup itself is
  // built from — `copyTree`, `removeOwnTreeNoFollow`, `publishDirectory` — and the CUSTODY half of a
  // rollback is exactly a tree copy of the keystore and the secrets. Those are used here, unmodified. No
  // restore behaviour is invented; what is absent is named.
  const restored = join(WORK, 'restore-staging');
  copyTree(join(setDir('pre-upgrade'), COMPONENT_ARTIFACT_NAMES.keystore), restored, 'restored keystore');
  removeOwnTreeNoFollow(live.stateDir, 'live keystore');
  assertEq(existsSync(live.stateDir), false, 'the migrated state directory is gone');
  publishDirectory(restored, live.stateDir, 'restored keystore');
  assertEq(existsSync(restored), false, 'and the staging directory was consumed, not left behind');

  const restoredSecrets = join(WORK, 'restore-secrets');
  copyTree(join(setDir('pre-upgrade'), COMPONENT_ARTIFACT_NAMES.secrets), restoredSecrets, 'restored secrets');
  removeOwnTreeNoFollow(live.secretsDir, 'live secrets');
  publishDirectory(restoredSecrets, live.secretsDir, 'restored secrets');

  // ---- THE ORIGINAL CUSTODY, PROVED FROM THE RESTORED FILES THEMSELVES --------------------------------
  const restoredStatic = Buffer.from(readFileSync(live.staticKeyFile, 'utf8').trim(), 'hex');
  assertEq(restoredStatic.toString('hex'), live.staticKek.toString('hex'),
    'the restored static KEK is the key this installation was born with');
  assertEq(assertStaticKekOpensKeystore(live.stateDir, restoredStatic), live.preState.keyCount,
    'and it opens every wrapped key in the restored keystore');
  assertEq(keystoreSetDigest(live.stateDir), live.preState.keystoreDigest,
    'which is byte-for-byte the keystore that existed before the upgrade');
  assertEq(countKeystoreEntries(live.stateDir), live.preState.keyCount, 'with the same number of keys');

  // ---- NO RING, NO MARKER, AND THE ROOT KEY PATH HOLDS WHAT THAT SET HOLDS ----------------------------
  assertEq(kekRingExists(live.stateDir), false, 'the restored installation has no ring, as it had none');
  assertEq(readCustodyRuntimeMode(live.projectRoot).declared, false, 'and no runtime mode is declared');
  assertEq(readCustodyRuntimeMode(live.projectRoot).mode, 'root-only', 'so the launcher default applies');
  assertEq(readFileSync(live.rootKeyFile, 'utf8'), 'custodian_root_key\n',
    'and the root key path holds the set placeholder, because that is what the set holds');

  // THE HONEST CONSEQUENCE, STATED RATHER THAN HIDDEN. `REQUIRED_SECRET_FILES` makes that name mandatory in
  // every complete backup, so a rollback set taken before the root key existed restores a placeholder there
  // — and the transition classifier is right to call a file that is not a key a CUSTODY FAILURE rather than
  // a missing prerequisite. A rolled-back installation therefore has to be given a real root wrapping key
  // again before it can be re-upgraded, and the command says so instead of silently treating it as absent.
  refuses(() => planCustodyTransition(transitionRequest('pre-upgrade'), composeRunner()),
    'not a missing prerequisite', 'a rolled-back installation with the placeholder still at that path');

  // ---- AND THE DATA. THE EXACT ORIGINAL BYTES, OUT OF THE RESTORED CUSTODY. ---------------------------
  await everyItemReturnsItsExactData('after the rollback');
});

await stage('7c. no temporary state is left behind, and the disposable installation is removed', () => {
  // NOTHING THIS LIFECYCLE TOOK IS STILL HELD. A lock directory or a rotation journal left in the state
  // directory would block the next command and is exactly the litter an interrupted run leaves.
  const leftovers = readdirSync(live.stateDir).filter((entry) => entry.startsWith('.') || entry.endsWith('.tmp'));
  assertEq(leftovers.join(','), '', 'no lock directory or temporary file is left in the state directory');
  assertEq(readdirSync(WORK).filter((entry) => entry.startsWith('restore-')).join(','), '',
    'and no restore staging directory survived');

  rmSync(WORK, { recursive: true, force: true });
  assertEq(existsSync(WORK), false, 'the disposable installation is gone, and it was the only thing created');
});

// ---------------------------------------------------------------------------------------------------------
// 8. What every stage above must not have done
// ---------------------------------------------------------------------------------------------------------

await stage('8. no key material reached a report or a ledger, and nothing reached a media system', () => {
  const lines = ledgers.flatMap((ledger) => ledger.all().map((entry) => [entry.program, ...entry.args].join(' ')));
  assert(lines.length > 0, 'there are commands to check');
  const written = JSON.stringify(reports);
  assert(written.length > 0, 'and reports to check');

  // ---- NOT ONE SECRET, ANYWHERE -----------------------------------------------------------------------
  //
  // Every DEK, both wrapping keys, the root key and every plaintext this rehearsal sealed. A report that
  // named any of them would be a report an operator cannot paste into an issue.
  assert(forbidden.length >= live.items.length + 2, 'the forbidden list really was populated');
  for (const secret of forbidden) {
    assertEq(written.includes(secret), false, 'no report carries a key, a secret or a plaintext');
    for (const line of lines) {
      assertEq(line.includes(secret), false, `no command line carries one either: ${line.slice(0, 60)}`);
    }
  }

  // ---- AND NOTHING WENT NEAR A MEDIA SERVER, A DOWNLOADER OR A REGISTRY --------------------------------
  //
  // The invariant this whole product is built around: Catalog Authority never downloads, scrapes, plays or
  // acquires media, and it never writes to Jellyfin. That is asserted against the COMMANDS THEMSELVES.
  // TWO FLAGS SPELL WORDS THEY FORBID. `--pull never` is the flag that stops fetching and `--no-build` is
  // the flag that stops building; the shared checker already exempts the first by its EXACT token and knows
  // nothing of the second. So the exemption here is exact too — the token, not the word — which means a bare
  // `pull` or `build` subcommand is still caught, and it is asserted that those flags are the only place
  // either word occurs at all.
  const neutral = lines.map((line) => line
    .split('--pull never').join('--<flag:never-fetch>')
    .split('--no-build').join('--<flag:never-assemble-an-image>'));
  for (const line of neutral) {
    assertEq(/pull|build/.test(line.toLowerCase()), false,
      `the words 'pull' and 'build' appear only as the flags that forbid them: ${line.slice(0, 80)}`);
  }
  assertEq(assertLedgerIsClean(neutral).join('; '), '',
    'no command reaches a network, a registry, a media system or an acquisition system');
  for (const line of lines) {
    for (const forbiddenToken of [
      'jellyfin', 'plex', 'emby', 'torrent', 'magnet', 'nzb', 'sabnzbd', '.mkv', '.mp4', 'curl', 'wget',
      'http://', 'https://',
    ]) {
      assertEq(line.toLowerCase().includes(forbiddenToken), false,
        `a command named ${forbiddenToken}: ${line.slice(0, 80)}`);
    }
    assertEq(['docker', 'node'].includes(line.split(' ')[0]!), true, `and ran only permitted programs: ${line}`);
  }

  // THE ONLY COMPOSE FILES IN PLAY ARE THIS STACK'S TWO CUSTODY FILES.
  for (const line of lines) {
    for (const word of line.split(' ')) {
      if (!word.endsWith('.yml') && !word.endsWith('.yaml')) continue;
      assertEq([RUNTIME_COMPOSE_FILE, BOOTSTRAP_COMPOSE_FILE].includes(word), true,
        `an unexpected compose file was used: ${word}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
