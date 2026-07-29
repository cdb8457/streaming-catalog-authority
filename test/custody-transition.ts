import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import {
  adoptStaticKekAsRing,
  beginPendingGeneration,
  initializeKekRing,
} from '../src/core/crypto/kek-ring.js';
import { runVerifiedCompleteBackup } from '../src/ops/complete-backup.js';
import { REQUIRED_SECRET_FILES } from '../src/ops/backup-components.js';
import {
  BOOTSTRAP_COMPOSE_FILE,
  CUSTODY_MODE_FILENAME,
  RUNTIME_COMPOSE_FILE,
  clearCustodyRuntimeMode,
  readCustodyRuntimeMode,
  writeCustodyRuntimeMode,
} from '../src/ops/custody-runtime-mode.js';
import {
  classifyCustodyState,
  launcherComposeArgs,
  planCustodyTransition,
  runCustodyTransition,
  type CustodyTransitionRequest,
} from '../src/ops/custody-transition.js';
import { CommandLedger, type MaintenanceCommand } from '../src/ops/maintenance-safety.js';
import { fakeDumpText, fakeToolchain } from './helpers/fake-toolchain.js';

// Phases 293-296 — the upgrade that must not strand a v1.1.4 installation.
//
// THE POPULATION THIS IS FOR HAS NO MARKER AND NO ROOT KEY. Phase 289 made the runtime stack root-only by
// default; every installation shipped before it has neither the marker that would say otherwise nor the root
// wrapping key file that arrived with the ring. A classifier that read a root key before asking whether
// there was a ring would refuse all of them on its first line, and a classifier that trusted a marker would
// have nothing to read. So the verdict comes from key material, and the marker is consulted for exactly one
// thing: telling apart two states that are cryptographically identical.
//
// FAKE COMMAND LEDGER, LABELLED. The only command this transaction runs is `docker compose config`, which
// renders a merged configuration. The runner is injected so the suite does not need a Docker daemon; every
// proof under it — the keystore, the ring, the backup — is real.

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
const WORK = mkdtempSync(join(tmpdir(), 'ca-custody-transition-'));
const POSIX = process.platform !== 'win32';
const SECRET = 'a-completion-secret-that-must-never-reach-a-report';

function schemaVersion(): number {
  return Number(/MIGRATION_VERSION\s*=\s*([0-9]+)/.exec(readRepo('src/db/schema-version.ts'))![1]);
}

interface World {
  readonly projectRoot: string;
  readonly appdata: string;
  readonly stateDir: string;
  readonly staticKek: Buffer;
  readonly root: Buffer;
  readonly request: CustodyTransitionRequest;
}

/**
 * An installation as a RELEASED v1.1.4 one is: wrapped keys under a static KEK, no ring, no marker — and,
 * unless asked for, NO ROOT WRAPPING KEY FILE, because that file arrived with the ring.
 */
async function installation(name: string, options: { keys?: number; withRootKey?: boolean } = {}): Promise<World> {
  const projectRoot = join(WORK, name);
  const appdata = join(projectRoot, 'appdata');
  const stateDir = join(appdata, 'sidecar-state');
  mkdirSync(join(appdata, 'secrets'), { recursive: true });
  mkdirSync(join(appdata, 'promotion-records'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  for (const file of [RUNTIME_COMPOSE_FILE, BOOTSTRAP_COMPOSE_FILE]) {
    writeFileSync(join(projectRoot, file), readRepo(file));
  }
  for (const file of REQUIRED_SECRET_FILES) {
    writeFileSync(join(appdata, 'secrets', file), `${file}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  const staticKek = randomBytes(32);
  const custodian = new FileCustodian(stateDir, SECRET, staticKek);
  for (let index = 0; index < (options.keys ?? 2); index += 1) {
    await custodian.provision(`op-${index}`, randomUUID(), 0);
    await custodian.commitProvision(`op-${index}`);
  }
  writeFileSync(join(appdata, 'secrets', 'custodian_kek'), `${staticKek.toString('hex')}\n`,
    { encoding: 'utf8', mode: 0o600 });
  const root = randomBytes(32);
  if (options.withRootKey === true) {
    writeFileSync(join(appdata, 'secrets', 'custodian_root_key'), `${root.toString('hex')}\n`,
      { encoding: 'utf8', mode: 0o600 });
    if (POSIX) chmodSync(join(appdata, 'secrets', 'custodian_root_key'), 0o600);
  } else {
    // A RELEASED v1.1.4 INSTALLATION HAS NO SUCH FILE. The backup component model requires the name, so the
    // set below carries the placeholder every other required secret carries; what matters here is that the
    // classifier is not handed a usable root key.
    rmSync(join(appdata, 'secrets', 'custodian_root_key'), { force: true });
    writeFileSync(join(appdata, 'secrets', 'custodian_root_key'), 'not-a-key-this-installation-ever-had\n',
      { encoding: 'utf8', mode: 0o600 });
  }
  const tools = fakeToolchain({ dumpText: fakeDumpText(schemaVersion()) });
  const outcome = runVerifiedCompleteBackup({
    projectRoot: appdata, destination: 'backups', setName: 'set-1', custodian: 'sidecar',
    sidecarState: 'sidecar-state', secrets: 'secrets', promotionRecords: 'promotion-records',
  }, { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  assert(outcome.ok, `the backup verifies: ${JSON.stringify(outcome.failures)}`);

  return {
    projectRoot,
    appdata,
    stateDir,
    staticKek,
    root,
    request: {
      projectRoot,
      projectName: 'catalogauthority',
      backupSetName: 'set-1',
      hostStateDir: stateDir,
      hostRootKeyFile: join(appdata, 'secrets', 'custodian_root_key'),
      hostStaticKeyFile: join(appdata, 'secrets', 'custodian_kek'),
      hostBackupsDir: join(appdata, 'backups'),
    },
  };
}

/** THE FAKE LEDGER, AND IT IS LABELLED: the only command is `compose config`, which renders and returns. */
function composeRunner() {
  const ledger = new CommandLedger();
  const runner = (command: MaintenanceCommand) => ({
    status: 0,
    stdout: `name: catalogauthority\nfiles: ${command.args.filter((a) => a.endsWith('.yml')).join(',')}\n`,
    stderr: '',
  });
  return { runner, ledger };
}

console.log('Running the Phases 293-296 custody transition gates:\n');

// ---------------------------------------------------------------------------------------------------------
// 1. The released v1.1.4 installation: no marker, no ring, and NO ROOT KEY
// ---------------------------------------------------------------------------------------------------------

await test('a released no-root legacy installation is classified from its static KEK, not refused', async () => {
  // THE DEFECT THIS CLOSES, AND IT MISSED THE ENTIRE POPULATION. The classifier read the ROOT WRAPPING KEY
  // before it asked whether there was a ring — and a v1.1.4 installation has no such file, because that file
  // arrived with the ring. The command written to rescue installations that predate the ring refused every
  // one of them on its first line, for not having a file their version never created.
  const world = await installation('legacy-no-root');
  const evidence = classifyCustodyState(world.request);
  assertEq(evidence.verdict, 'legacy-static', 'the evidence says legacy static custody');
  assertEq(evidence.selectedMode, 'bootstrap', 'and selects the wiring that keeps it running');
  assertEq(evidence.keysProved, 2, 'having proved its static KEK opens every wrapped key it has');
  assertEq(evidence.rootKeyReady, false, 'and reports the missing root key as the prerequisite it is');

  const tools = composeRunner();
  const planned = planCustodyTransition(world.request, tools);
  assertEq(planned.currentMode, 'root-only', 'the absent marker currently defaults to the steady state');
  assertEq(planned.currentModeDeclared, false, 'which is a default rather than a declaration');
  assertEq(planned.changes, true, 'so this installation really does need the selection written');

  const report = runCustodyTransition({ ...world.request, confirmDigest: planned.planDigest }, tools);
  assertEq(report.changed, true, 'the transition changed the selection');
  assertEq(report.toMode, 'bootstrap', 'to the temporary bootstrap wiring');
  assertEq(readCustodyRuntimeMode(world.projectRoot).mode, 'bootstrap', 'and the marker says so');
  // AND THE PREREQUISITE IS NAMED, with the command that creates a root key without ever printing one.
  assert(report.notes.some((note) => note.includes('write-custody-secret.mjs --generate')),
    'the report names how a root wrapping key is created');
  assert(report.notes.some((note) => note.includes('predates the ring')), 'and why this one has none');
});

await test('the launcher starts a legacy installation on the overlay, and a migrated one on the steady state', async () => {
  const world = await installation('launcher-selection');
  assertEq(launcherComposeArgs(world.projectRoot).join(' '), `-f ${RUNTIME_COMPOSE_FILE}`,
    'with no marker the launcher uses the steady-state file');
  writeCustodyRuntimeMode(world.projectRoot, 'bootstrap');
  assertEq(launcherComposeArgs(world.projectRoot).join(' '),
    `-f ${RUNTIME_COMPOSE_FILE} -f ${BOOTSTRAP_COMPOSE_FILE}`,
    'and with the marker declared it adds the overlay');

  // THE SHIPPED LAUNCHER READS IT TOO. An upgrade command that ignored the selection would start the wrong
  // stack — on an unmigrated installation, one with no static KEK in it at all.
  const launcher = readRepo('deploy/unraid-ops-launcher.sh');
  assert(launcher.includes('compose_files()'), 'the launcher resolves its compose files');
  assert(launcher.includes('MARKER_FILE'), 'from the custody mode marker');
  assert(launcher.includes('BOOTSTRAP_FILE'), 'and can add the overlay');
  assert(/case "\$mode" in/.test(launcher), 'reading it as a closed set of words');
  // AND NOTHING IT RUNS MAY FETCH OR BUILD.
  // THE CODE, NOT THE COMMENT THAT EXPLAINS IT. The file NAMES the pull policy in prose, which is where a
  // reader learns why these flags are here.
  const launcherCode = launcher.split('\n').filter((entry) => !/^\s*#/.test(entry));
  for (const line of launcherCode.filter((entry) => /^\s*compose (run|up)/.test(entry))) {
    assert(line.includes('$NO_FETCH'), `every compose run/up refuses to fetch: ${line.trim()}`);
  }
  assert(readRepo('deploy/unraid-ops-launcher.sh').includes('--pull never'), 'and that is what it means');
});

// ---------------------------------------------------------------------------------------------------------
// 2. The two cryptographically identical ring states
// ---------------------------------------------------------------------------------------------------------

await test('a COMPLETED unrotated cutover is managed-ring, even with the static file still on disk', async () => {
  // THE DEFECT THIS CLOSES. Every post-adoption ring was being called an INTERRUPTED migration, and a
  // cutover that COMPLETED and has not yet rotated leaves exactly the same ring: one generation, active,
  // adopted from the static KEK, with the static key file still there because nothing removes it. The old
  // branch sent that healthy managed installation BACK to bootstrap — static custody, restored by the
  // command that exists to protect it.
  const world = await installation('completed-cutover', { withRootKey: true });
  adoptStaticKekAsRing(world.stateDir, world.root, world.staticKek, () => 1_800_000_000_000);
  // A completed cutover removes the marker; the static key file is deliberately left in place.
  clearCustodyRuntimeMode(world.projectRoot);
  assert(existsSync(world.request.hostStaticKeyFile), 'the static key file is still on disk');

  const evidence = classifyCustodyState(world.request);
  assertEq(evidence.verdict, 'managed-ring', 'a finished cutover is a managed ring');
  assertEq(evidence.selectedMode, 'root-only', 'and stays on the steady state');
  assertEq(evidence.ringGeneration, 1, 'on its first generation, unrotated');

  // AND NOTHING CHANGES: the steady state is the marker's absence, so there is nothing to write.
  const tools = composeRunner();
  const planned = planCustodyTransition(world.request, tools);
  assertEq(planned.changes, false, 'an absent marker already IS the canonical steady state');
  const report = runCustodyTransition({ ...world.request, confirmDigest: planned.planDigest }, tools);
  assertEq(report.changed, false, 'so the transition changes nothing');
  assert(!existsSync(join(world.projectRoot, CUSTODY_MODE_FILENAME)), 'and writes no marker to say so');
});

await test('an INTERRUPTED cutover is recognised by the selection it was left on, and keeps its backup gate', async () => {
  const world = await installation('interrupted-cutover', { withRootKey: true });
  // Exactly the state an interrupted cutover leaves: the ring is written, the marker still says bootstrap.
  writeCustodyRuntimeMode(world.projectRoot, 'bootstrap');
  adoptStaticKekAsRing(world.stateDir, world.root, world.staticKek, () => 1_800_000_000_000);

  const evidence = classifyCustodyState(world.request);
  assertEq(evidence.verdict, 'interrupted-adoption', 'the same ring, read with the runtime selection');
  assertEq(evidence.selectedMode, 'bootstrap', 'stays on bootstrap so the cutover can resume');

  // THE MARKER RESOLVES THE AMBIGUITY AND NEVER SUBSTITUTES FOR A PROOF. A ring holding a different key is
  // refused whatever the marker says.
  const other = await installation('interrupted-wrong-key', { withRootKey: true });
  writeCustodyRuntimeMode(other.projectRoot, 'bootstrap');
  adoptStaticKekAsRing(other.stateDir, other.root, other.staticKek, () => 1_800_000_000_000);
  // The ring holds the key the keystore really is under, so the keystore proof PASSES — and the static key
  // FILE this installation is wired to is now a different one. Only the static comparison catches that, and
  // a marker saying `bootstrap` does not excuse it.
  writeFileSync(other.request.hostStaticKeyFile, `${randomBytes(32).toString('hex')}\n`);
  refuses(() => classifyCustodyState(other.request), 'not the static KEK this installation is wired to',
    'a bootstrap marker over a ring whose key is not the one this installation is wired to');

  // AND THE BACKUP GATE THE RESUMED CUTOVER WILL DEMAND IS CHECKED HERE, not left to be discovered there.
  const manifest = join(world.appdata, 'backups', 'set-1', 'catalog-backup-manifest.json');
  const held = readFileSync(manifest);
  writeFileSync(manifest, '{"tampered":true}');
  refuses(() => classifyCustodyState(world.request), 'does not verify', 'an interrupted state with no way back');
  writeFileSync(manifest, held);
});

// ---------------------------------------------------------------------------------------------------------
// 3. Everything this will not classify
// ---------------------------------------------------------------------------------------------------------

await test('corrupt, wrong-root, mixed, raced, empty and symlinked states are refused with a name', async () => {
  // A RING THE ROOT DOES NOT OPEN.
  const wrongRoot = await installation('refuse-wrong-root', { withRootKey: true });
  adoptStaticKekAsRing(wrongRoot.stateDir, randomBytes(32), wrongRoot.staticKek, () => 1_800_000_000_000);
  refuses(() => classifyCustodyState(wrongRoot.request), 'root wrapping key does not open it',
    'a ring sealed under another root');

  // A RING WHOSE KEYSTORE DOES NOT OPEN UNDER IT — a genuinely mixed installation.
  const mixed = await installation('refuse-mixed', { withRootKey: true });
  adoptStaticKekAsRing(mixed.stateDir, mixed.root, randomBytes(32), () => 1_800_000_000_000);
  clearCustodyRuntimeMode(mixed.projectRoot);
  refuses(() => classifyCustodyState(mixed.request), 'does not open the wrapped keys',
    'a ring that opens nothing in its own keystore');

  // A ROTATION CAUGHT IN FLIGHT.
  const racing = await installation('refuse-racing', { withRootKey: true });
  adoptStaticKekAsRing(racing.stateDir, racing.root, racing.staticKek, () => 1_800_000_000_000);
  beginPendingGeneration(racing.stateDir, racing.root, () => 1_800_000_001_000);
  refuses(() => classifyCustodyState(racing.request), 'rotation in progress', 'a rotation mid-flight');

  // A STATIC KEK THAT OPENS NOTHING.
  const wrongStatic = await installation('refuse-wrong-static');
  writeFileSync(wrongStatic.request.hostStaticKeyFile, `${randomBytes(32).toString('hex')}\n`);
  refuses(() => classifyCustodyState(wrongStatic.request), 'does not open the wrapped keys',
    'a static key that is not this installation\'s');

  // THE GENUINELY AMBIGUOUS EMPTY INSTALLATION: fresh, or a keystore that is not where it was said to be.
  const empty = await installation('refuse-empty', { keys: 0 });
  refuses(() => classifyCustodyState(empty.request), 'does not say which it is', 'an installation with no keys');

  // A MISSING BACKUP, on the path that is about to be carried through a migration.
  const noBackup = await installation('refuse-no-backup');
  writeFileSync(join(noBackup.appdata, 'backups', 'set-1', 'catalog-backup-manifest.json'), '{"tampered":true}');
  refuses(() => classifyCustodyState(noBackup.request), 'does not verify', 'a legacy state with no way back');
  // AND A SET THAT IS SIMPLY NOT THERE IS ITS OWN REFUSAL, in the words the path resolver uses.
  rmSync(join(noBackup.appdata, 'backups', 'set-1'), { recursive: true, force: true });
  refuses(() => classifyCustodyState(noBackup.request), 'does not exist',
    'a legacy state with no backup at all');

  if (POSIX) {
    // A STATE DIRECTORY REACHED THROUGH A LINK is not a state directory this will classify.
    const linked = await installation('refuse-symlink');
    const aside = join(WORK, 'refuse-symlink-elsewhere');
    mkdirSync(aside, { recursive: true });
    rmSync(linked.stateDir, { recursive: true, force: true });
    symlinkSync(aside, linked.stateDir, 'dir');
    refuses(() => classifyCustodyState(linked.request), 'not one this command will classify',
      'a symlinked state directory');
  }
});

// ---------------------------------------------------------------------------------------------------------
// 4. The transaction around it
// ---------------------------------------------------------------------------------------------------------

await test('planning changes nothing, and a stale or wrong confirmation changes nothing either', async () => {
  const world = await installation('transaction');
  const tools = composeRunner();
  const planned = planCustodyTransition(world.request, tools);
  assert(!existsSync(join(world.projectRoot, CUSTODY_MODE_FILENAME)), 'planning wrote no marker');
  assertEq(Object.isFrozen(planned), true, 'and a plan cannot be edited between reading and running it');

  refuses(() => runCustodyTransition({ ...world.request, confirmDigest: null }, tools),
    'digest you confirmed', 'no confirmation');
  refuses(() => runCustodyTransition({ ...world.request, confirmDigest: 'f'.repeat(64) }, tools),
    'digest you confirmed', 'a wrong confirmation');
  assert(!existsSync(join(world.projectRoot, CUSTODY_MODE_FILENAME)), 'and neither wrote a marker');

  // A CONFIRMATION FROM BEFORE THE INSTALLATION MOVED IS STALE: the keystore is part of the evidence.
  const custodian = new FileCustodian(world.stateDir, SECRET, world.staticKek);
  await custodian.provision('op-late', randomUUID(), 0);
  refuses(() => runCustodyTransition({ ...world.request, confirmDigest: planned.planDigest }, tools),
    'digest you confirmed', 'a confirmation from before the keystore moved');

  // AND NO KEY REACHES A PLAN OR A REPORT.
  const rendered = JSON.stringify(planned);
  for (const forbidden of [world.staticKek.toString('hex'), world.root.toString('hex'), SECRET]) {
    assert(!rendered.includes(forbidden), 'no key material is in a plan');
  }
});

await test('the custody secret helper never takes key material on a command line', () => {
  // THE DEFECT THIS CLOSES. The helper took the VALUE as argv[3], and the setup scripts called it with
  // `"$(random_secret)"` — so the root wrapping key of a new installation was placed on a command line,
  // visible in `ps` to every account on the host, recorded in shell history, and copied into any
  // scheduler's log. The file it then wrote so carefully was created from a value already published.
  const helper = readRepo('deploy/write-custody-secret.mjs');
  assert(helper.includes('(--generate|--stdin)'), 'the helper takes a source, not a value');
  assert(helper.includes("randomBytes(32).toString('hex')"), 'and can generate the key inside its own process');
  assert(!/const \[, , path, value/.test(helper), 'the value is no longer an argv position');
  for (const script of ['deploy/local-runtime-setup.sh', 'deploy/arcane-setup.sh']) {
    const source = readRepo(script);
    assert(source.includes('write_custody_secret custodian_root_key\n'),
      `${script} passes no value for the root key`);
    assert(/CUSTODY_HELPER\}" "\$\{SECRETS_DIR\}\/\$\{name\}" --generate/.test(source),
      `${script} asks the helper to generate it`);
    assert(!/write_custody_secret custodian_root_key "/.test(source),
      `${script} never puts a generated key on a command line`);
  }
});

await test('this tranche reaches no network, media server or acquisition system', () => {
  for (const file of ['src/ops/custody-transition.ts', 'src/ops/custody-transition-cli.ts',
    'deploy/unraid-ops-launcher.sh']) {
    const source = readRepo(file).toLowerCase();
    for (const forbidden of ['jellyfin', 'plex', 'emby', '/mnt/user/media', '.mkv', 'nzb', 'torrent', 'magnet',
      'sabnzbd', 'curl ', 'wget ', 'node:http', 'fetch(']) {
      assert(!source.includes(forbidden), `${file} must not name ${forbidden}`);
    }
  }
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
