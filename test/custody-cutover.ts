import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import {
  adoptStaticKekAsRing,
  beginPendingGeneration,
  initializeKekRing,
  kekRingPath,
} from '../src/core/crypto/kek-ring.js';
import { SIDECAR_PROTOCOL_VERSION } from '../src/core/crypto/sidecar-ipc.js';
import { runVerifiedCompleteBackup } from '../src/ops/complete-backup.js';
import { REQUIRED_SECRET_FILES } from '../src/ops/backup-components.js';
import {
  BOOTSTRAP_COMPOSE_FILE,
  CUSTODY_MODE_FILENAME,
  RUNTIME_COMPOSE_FILE,
  clearCustodyRuntimeMode,
  composeFileArgs,
  composeFilesForMode,
  readCustodyRuntimeMode,
  writeCustodyRuntimeMode,
} from '../src/ops/custody-runtime-mode.js';
import {
  CustodyCutoverFailed,
  planCustodyCutover,
  runCustodyCutover,
} from '../src/ops/custody-cutover.js';
import { parseCutoverArgs } from '../src/ops/custody-cutover-cli.js';
import { CommandLedger, type MaintenanceCommand } from '../src/ops/maintenance-safety.js';
import { runDoctor, type DoctorCheck, type DoctorReport } from '../src/ops/doctor.js';
import { fakeDumpText, fakeToolchain } from './helpers/fake-toolchain.js';
import { asMap, parseYaml } from '../src/ops/minimal-yaml.js';
import {
  caseArm,
  caseBlock,
  code as shellCode,
  parseShellSource,
  textOf as shellText,
} from './helpers/shell-source.js';

// Phases 289-292 — the shipped stack moving from static bootstrap custody onto the ring, and a doctor that
// reports what it finds there.
//
// WHAT THESE GATES ARE ABOUT. Every piece of the migration already existed and none of it was joined up:
// `ops:kek-ring migrate` writes the ring, and the shipped compose file's advice for the RUNTIME half was to
// edit three lines of YAML by hand and to remember to redo it after every upgrade. The doctor, meanwhile,
// told every production deployment that "managed age KEK custody/scheduling is not built" — on a build where
// it was built, migrated onto, rotated and retired from.
//
// FAKE COMMAND LEDGERS, DELIBERATELY, FOR THE ORCHESTRATION. The destructive half of this transaction stops
// and starts containers on a NAS. A suite that ran those for real would be a suite nobody could run, so the
// runner is injected and the LEDGER is the evidence: which commands were built, in which order, with which
// mounts and which files. The cryptography under it is NOT faked — the migration digest, the backup proof
// and the ring are the real ones.

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
const WORK = mkdtempSync(join(tmpdir(), 'ca-custody-cutover-'));
const POSIX = process.platform !== 'win32';
const SECRET = 'a-completion-secret-that-must-never-reach-a-report';

function schemaVersion(): number {
  return Number(/MIGRATION_VERSION\s*=\s*([0-9]+)/.exec(readRepo('src/db/schema-version.ts'))![1]);
}

/**
 * An installation exactly as the shipped stack leaves one: a project directory with both compose files, an
 * appdata tree with real secrets, a keystore holding real wrapped keys under the STATIC KEK, and a verified
 * complete backup. No ring — that is what the cutover is for.
 */
async function installation(name: string, options: { keys?: number } = {}): Promise<{
  projectRoot: string; appdata: string; stateDir: string; backupSetName: string; staticKek: Buffer; root: Buffer;
  request: Parameters<typeof planCustodyCutover>[0];
}> {
  const projectRoot = join(WORK, name);
  const appdata = join(projectRoot, 'appdata');
  const stateDir = join(appdata, 'sidecar-state');
  mkdirSync(join(appdata, 'secrets'), { recursive: true });
  mkdirSync(join(appdata, 'promotion-records'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  // The compose files, as an installation has them: copied from the repository, never edited by this suite.
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
  const root = randomBytes(32);
  writeFileSync(join(appdata, 'secrets', 'custodian_root_key'), `${root.toString('hex')}\n`,
    { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(appdata, 'secrets', 'custodian_kek'), `${staticKek.toString('hex')}\n`,
    { encoding: 'utf8', mode: 0o600 });
  if (POSIX) chmodSync(join(appdata, 'secrets', 'custodian_root_key'), 0o600);

  // A REAL VERIFIED COMPLETE BACKUP, taken by the real command. The cutover is gated on one and the gate is
  // not something this suite may stub.
  const tools = fakeToolchain({ dumpText: fakeDumpText(schemaVersion()) });
  const outcome = runVerifiedCompleteBackup({
    projectRoot: appdata, destination: 'backups', setName: 'set-1', custodian: 'sidecar',
    sidecarState: 'sidecar-state', secrets: 'secrets', promotionRecords: 'promotion-records',
  }, { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  assert(outcome.ok, `the backup verifies: ${JSON.stringify(outcome.failures)}`);

  writeCustodyRuntimeMode(projectRoot, 'bootstrap');
  return {
    projectRoot,
    appdata,
    stateDir,
    backupSetName: 'set-1',
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

/**
 * A runner that answers like a working stack, and records everything.
 *
 * `migrationPerforms` decides whether the confirmed migrate command really writes the ring — the suite hands
 * it the real `adoptStaticKekAsRing`, so a "successful cutover" in these tests is one after which a real ring
 * really exists and the old static key really opens it as generation 1.
 */
function stackRunner(options: {
  planDigest: string;
  onMigrate?: () => void;
  failMigrate?: boolean;
  health?: (mode: 'bootstrap' | 'root-only') => unknown | null;
  failService?: (command: MaintenanceCommand) => boolean;
  /** Runs after a command whose joined arguments contain this text. The interference seam. */
  after?: { readonly when: string; readonly run: () => void };
} ) {
  const ledger = new CommandLedger();
  const runner = (command: MaintenanceCommand) => {
    const args = command.args.join(' ');
    const outcome = respond(command, args);
    // THE INTERFERENCE SEAM. It fires AFTER the command it names has been answered, which is how a test puts
    // a rotation or a custodian write into the exact window between one step of this transaction and the
    // next. Waiting for that window to happen by chance would make the test a coin toss.
    if (options.after !== undefined && args.includes(options.after.when)) options.after.run();
    return outcome;
  };
  const respond = (command: MaintenanceCommand, args: string) => {
    const mode: 'bootstrap' | 'root-only' = args.includes(BOOTSTRAP_COMPOSE_FILE) ? 'bootstrap' : 'root-only';
    if (options.failService?.(command) === true) return { status: 1, stdout: '', stderr: '' };
    if (args.includes('config')) return { status: 0, stdout: `name: catalogauthority\nmode: ${mode}\n`, stderr: '' };
    if (args.includes('migrate') && args.includes('--plan')) {
      return { status: 0, stdout: `plan digest: ${options.planDigest}\n`, stderr: '' };
    }
    if (args.includes('migrate') && args.includes('--confirm-digest')) {
      if (options.failMigrate === true) return { status: 1, stdout: '', stderr: '' };
      options.onMigrate?.();
      return { status: 0, stdout: 'The static KEK is now generation 1 of a sidecar-managed ring.\n', stderr: '' };
    }
    if (args.includes('ops:sidecar-health')) {
      // `?? defaultHealth(mode)` WOULD SWALLOW A DELIBERATE `null`: a test that says "this selection does not
      // answer" means it, and `null ?? x` is `x`. The presence of the override is what decides.
      const health = options.health === undefined ? defaultHealth(mode) : options.health(mode);
      if (health === null) return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: `> catalog-authority\n${JSON.stringify(health)}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { runner, ledger };
}

function defaultHealth(mode: 'bootstrap' | 'root-only'): unknown {
  return mode === 'root-only'
    ? {
      op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: true, custodian: 'sidecar-managed-ring',
      ringGeneration: 1, ringActiveCreatedAt: Date.now() - 24 * 60 * 60 * 1000,
    }
    : {
      op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: true, custodian: 'file-reference-harness',
      ringGeneration: null, ringActiveCreatedAt: null,
    };
}

/** The migration digest the container would print. Computed from the real planner over the real state. */
async function migrationDigestFor(world: Awaited<ReturnType<typeof installation>>): Promise<string> {
  const { planKekMigration } = await import('../src/ops/kek-rotation.js');
  return planKekMigration({
    stateDir: world.stateDir,
    rootKeyFile: world.request.hostRootKeyFile,
    staticKeyFile: world.request.hostStaticKeyFile,
    backupSet: join(world.appdata, 'backups', 'set-1'),
  }).planDigest;
}

console.log('Running the Phases 289-292 custody cutover and monitoring gates:\n');

// ---------------------------------------------------------------------------------------------------------
// 1. Two modes, selected rather than edited
// ---------------------------------------------------------------------------------------------------------

await test('the runtime stack resolves to exactly two custody wirings, and neither is assembled by hand', () => {
  assertEq(composeFilesForMode('root-only').join(','), RUNTIME_COMPOSE_FILE, 'the steady state is one file');
  assertEq(composeFilesForMode('bootstrap').join(','), `${RUNTIME_COMPOSE_FILE},${BOOTSTRAP_COMPOSE_FILE}`,
    'and bootstrap is the runtime file plus the overlay, in that order');
  assertEq(composeFileArgs('bootstrap').join(' '), `-f ${RUNTIME_COMPOSE_FILE} -f ${BOOTSTRAP_COMPOSE_FILE}`,
    'expressed as the -f arguments compose takes');

  const project = join(WORK, 'mode-marker');
  mkdirSync(project, { recursive: true });
  // NO MARKER IS THE STEADY STATE, and it says so rather than guessing.
  const fresh = readCustodyRuntimeMode(project);
  assertEq(fresh.mode, 'root-only', 'an installation nobody has spoken for runs the canonical stack');
  assertEq(fresh.declared, false, 'and the report says the default was used');

  writeCustodyRuntimeMode(project, 'bootstrap');
  assertEq(readCustodyRuntimeMode(project).mode, 'bootstrap', 'a declared mode reads back');
  assertEq(readCustodyRuntimeMode(project).declared, true, 'as declared');
  assertEq(readFileSync(join(project, CUSTODY_MODE_FILENAME), 'utf8').trim(), 'bootstrap', 'as one plain word');
  clearCustodyRuntimeMode(project);
  assertEq(readCustodyRuntimeMode(project).mode, 'root-only', 'and clearing it returns to the steady state');

  // A MARKER THIS BUILD CANNOT READ IS A REFUSAL, NOT A GUESS. It decides which key material the sidecar is
  // wired to; reading it wrong is starting an installation on the wrong custody.
  for (const [what, contents] of [
    ['a word this build does not define', 'half-migrated'],
    ['two words', 'bootstrap root-only'],
    ['nothing at all', ''],
  ] as const) {
    writeFileSync(join(project, CUSTODY_MODE_FILENAME), contents);
    refuses(() => readCustodyRuntimeMode(project), 'does not name a mode this build defines',
      `a marker holding ${what}`);
  }
  rmSync(join(project, CUSTODY_MODE_FILENAME), { force: true });
  if (POSIX) {
    const elsewhere = join(WORK, 'mode-elsewhere');
    writeFileSync(elsewhere, 'bootstrap\n');
    symlinkSync(elsewhere, join(project, CUSTODY_MODE_FILENAME));
    refuses(() => readCustodyRuntimeMode(project), 'symbolic link', 'a marker that is a link');
    rmSync(join(project, CUSTODY_MODE_FILENAME), { force: true });
  }
});

await test('the steady-state stack has no static KEK anywhere, and the overlay is the only place it exists', () => {
  // PARSED, NOT MATCHED (Phase 329). The last claim here used to be `/custodian_kek:\n\s+file:/` — a regular
  // expression with a bare LF in it, asserting that a declared secret and its `file:` key were adjacent in the
  // BYTES of the checkout. On any checkout with CRLF endings, which is what Git produces on Windows by
  // default, the LF never matched and the gate reported that the overlay declares no static KEK — while the
  // overlay declared one perfectly well, four lines further down the same file. The stack is a structure;
  // asking the parser what it declares cannot be decided by a line ending, an indent width or a key order.
  const runtime = parseYaml(readRepo(RUNTIME_COMPOSE_FILE));
  const bootstrap = parseYaml(readRepo(BOOTSTRAP_COMPOSE_FILE));
  const runtimeText = readRepo(RUNTIME_COMPOSE_FILE);

  const sidecarEnv = (doc: ReturnType<typeof parseYaml>): Record<string, unknown> => asMap(
    asMap(asMap(doc.services ?? null, 'services').sidecar ?? null, 'sidecar').environment ?? null,
    'sidecar environment');

  // THE CANONICAL FILE. Root-only custody, and the static key is not mounted, not a secret, and not named as
  // an environment variable anywhere in it.
  assertEq(sidecarEnv(runtime).SIDECAR_ROOT_KEY_FILE, '/run/catalog-custody/custodian_root_key',
    'the steady state wires the sidecar to the root wrapping key');
  assert(!('SIDECAR_KEK_FILE' in sidecarEnv(runtime)), 'and names no static KEK file');
  // Nowhere AT ALL, which is a claim about the whole file rather than about one service, so the text is the
  // right instrument for it: a comment mentioning the static KEK would fail this, and that is intended.
  assert(!runtimeText.includes('custodian_kek'), 'and mounts and declares no static KEK at all');

  // THE OVERLAY. It puts the static key back and takes the root wiring away — the daemon refuses both.
  assertEq(sidecarEnv(bootstrap).SIDECAR_KEK_FILE, '/run/secrets/custodian_kek', 'the overlay wires the static KEK');
  assertEq(sidecarEnv(bootstrap).SIDECAR_ROOT_KEY_FILE, '', 'and explicitly unsets the root key wiring');
  const declared = asMap(bootstrap.secrets ?? null, 'secrets');
  assert('custodian_kek' in declared, 'and declares the secret the runtime file does not');
  assert(typeof asMap(declared.custodian_kek ?? null, 'custodian_kek').file === 'string',
    'as a file-backed secret, which is the only kind an ordinary Compose install can serve');
});

await test('no service gets a Docker socket, a privilege escalation, a host network or a new port', () => {
  for (const file of [RUNTIME_COMPOSE_FILE, BOOTSTRAP_COMPOSE_FILE]) {
    const text = readRepo(file);
    for (const forbidden of [
      '/var/run/docker.sock', 'docker.sock', 'privileged:', 'network_mode: host', 'network_mode: "host"',
      'cap_add', 'pid: host', 'ipc: host', 'userns_mode', 'devices:',
    ]) {
      assert(!text.includes(forbidden), `${file} must not carry ${forbidden}`);
    }
    // The only published port in the stack is the operator UI's, and it is unchanged.
    const ports = text.match(/^\s+ports:/gm) ?? [];
    assert(ports.length <= 1, `${file} publishes at most the one port this stack already published`);
  }
  // AND THE ONE-SHOT CUSTODY SERVICE IS AS CONFINED AS THE SIDECAR.
  const runtime = readRepo(RUNTIME_COMPOSE_FILE);
  const service = runtime.slice(runtime.indexOf('  custody-maintenance:'), runtime.indexOf('  app:'));
  for (const required of ['read_only: true', 'cap_drop', 'no-new-privileges:true', 'profiles:',
    // NO NETWORK AT ALL. It is the one service that holds the root key and, under the overlay, the static
    // key too — so it is the one that most deserves to be unable to speak to anything.
    'network_mode: none']) {
    assert(service.includes(required), `custody-maintenance declares ${required}`);
  }
  assert(!service.includes('ports:'), 'and publishes nothing');
});

await test('every client mounts the sidecar socket directory read-only, and only the sidecar writes it', () => {
  // A client CONNECTS to a socket, which is a read on the directory entry. It never needs to create, remove
  // or rename anything in there — and a client that can rename the socket can put its own socket at that
  // name and be asked for keys.
  const runtime = readRepo(RUNTIME_COMPOSE_FILE);
  const mounts = runtime.match(/sidecar\/run:\/run\/catalog-sidecar(:ro)?/g) ?? [];
  assert(mounts.length >= 4, `every service that talks to the sidecar has a mount (${mounts.length})`);
  const writable = mounts.filter((mount) => !mount.endsWith(':ro'));
  assertEq(writable.length, 1, 'exactly one service mounts it read-write');
  // And that one is the sidecar: the block that owns the socket also owns the state directory.
  const sidecarBlock = runtime.slice(runtime.indexOf('  sidecar:'), runtime.indexOf('  custody-maintenance:'));
  assert(/sidecar\/run:\/run\/catalog-sidecar$/m.test(sidecarBlock), 'and it is the sidecar');

  // THE BEHAVIOUR THIS ENCODES IS A CONTAINER FACT, AND IT IS NOT PROVED HERE.
  //
  // "A read-only bind mount can connect but cannot create, remove or rename" is a property of the Linux
  // kernel and the container runtime. Proving it needs a Linux host with a working Docker daemon, which this
  // suite does not require and this platform does not have; asserting it from a YAML string would be
  // asserting that the file says so. The static contract above is the secondary evidence, and the
  // limitation is stated in the phases 289-292 document rather than papered over.
  if (!POSIX) console.log('        (the read-only mount BEHAVIOUR needs Linux + Docker: contract-only here)');
});

// ---------------------------------------------------------------------------------------------------------
// 2. The plan is pure, and bound to the exact installation
// ---------------------------------------------------------------------------------------------------------

await test('planning a cutover changes nothing and binds the backup and the exact pre-state', async () => {
  const world = await installation('plan-purity');
  const digest = await migrationDigestFor(world);
  const tools = stackRunner({ planDigest: digest });
  const before = readFileSync(join(world.projectRoot, CUSTODY_MODE_FILENAME), 'utf8');

  const planned = planCustodyCutover(world.request, tools);
  assertEq(planned.fromMode, 'bootstrap', 'the plan names where it is starting from');
  assertEq(planned.toMode, 'root-only', 'and where it would end');
  assertEq(planned.migrationPlanDigest, digest, 'and carries the migration digest the container printed');
  assertEq(planned.planDigest.length, 64, 'and its own confirmation digest');
  assertEq(Object.isFrozen(planned), true, 'a plan cannot be edited between reading it and running it');

  // NOTHING MOVED. No ring, no marker change, and every command that ran was read-only.
  assert(!existsSync(join(world.stateDir, 'ring')), 'no ring was written by planning');
  assertEq(readFileSync(join(world.projectRoot, CUSTODY_MODE_FILENAME), 'utf8'), before, 'the marker is untouched');
  const verbs = tools.ledger.all().map((entry) => entry.args.filter((a) => !a.startsWith('-')).join(' '));
  for (const entry of verbs) {
    assert(!/\b(up|stop|start|down|kill)\b/.test(entry), `planning ran no lifecycle command: ${entry}`);
  }
  assert(verbs.some((v) => v.includes('config')), 'it did resolve the compose configuration');
  assert(verbs.some((v) => v.includes('migrate')), 'and did ask the container for its migration plan');

  // AND NO KEY OR HOST PATH REACHES THE PLAN.
  const rendered = JSON.stringify(planned);
  for (const forbidden of [world.staticKek.toString('hex'), world.root.toString('hex'), SECRET]) {
    assert(!rendered.includes(forbidden), 'no key material is in a plan');
  }
  assert(!planCustodyCutover(world.request, tools).planDigest.includes(world.projectRoot),
    'and the digest carries no host layout');
});

await test('a cutover is refused unless the installation is in bootstrap mode', async () => {
  const world = await installation('plan-mode-gate');
  const tools = stackRunner({ planDigest: await migrationDigestFor(world) });
  clearCustodyRuntimeMode(world.projectRoot);
  refuses(() => planCustodyCutover(world.request, tools), 'not in custody bootstrap mode',
    'a cutover planned against an installation already in the steady state');
  assertEq(tools.ledger.all().length, 0, 'and nothing was run at all');
});

await test('a wrong, missing or stale confirmation changes nothing', async () => {
  const world = await installation('confirm-gate');
  const digest = await migrationDigestFor(world);
  const tools = stackRunner({ planDigest: digest });
  refuses(() => runCustodyCutover({ ...world.request, confirmDigest: null }, tools),
    'digest you confirmed', 'no confirmation');
  refuses(() => runCustodyCutover({ ...world.request, confirmDigest: 'f'.repeat(64) }, tools),
    'digest you confirmed', 'a wrong confirmation');

  // A CONFIRMATION FROM BEFORE AN INPUT MOVED IS STALE. The keystore is what the static key was proved
  // against, so a key file added after the plan is a different plan.
  const planned = planCustodyCutover(world.request, tools);
  const custodian = new FileCustodian(world.stateDir, SECRET, world.staticKek);
  await custodian.provision('op-late', randomUUID(), 0);
  const moved = stackRunner({ planDigest: await migrationDigestFor(world) });
  refuses(() => runCustodyCutover({ ...world.request, confirmDigest: planned.planDigest }, moved),
    'digest you confirmed', 'a confirmation from before the keystore moved');
  assert(!existsSync(join(world.stateDir, 'ring')), 'and no ring was written by any of that');
});

// ---------------------------------------------------------------------------------------------------------
// 3. The cutover itself
// ---------------------------------------------------------------------------------------------------------

await test('a confirmed cutover migrates, switches the runtime selection and proves the handshake', async () => {
  const world = await installation('cutover-success');
  const digest = await migrationDigestFor(world);
  const tools = stackRunner({
    planDigest: digest,
    // THE REAL MIGRATION. The container is faked; what it does is not — this is the same function the
    // migration calls, over the real keystore, with the real keys.
    onMigrate: () => { adoptStaticKekAsRing(world.stateDir, world.root, world.staticKek, () => 1_800_000_000_000); },
  });
  const planned = planCustodyCutover(world.request, tools);
  const report = runCustodyCutover({ ...world.request, confirmDigest: planned.planDigest }, tools);

  assertEq(report.ok, true, 'the cutover succeeds');
  assertEq(report.migrationPerformed, true, 'and says the ring was written');
  assertEq(report.custodian, 'sidecar-managed-ring', 'and that the sidecar is running the ring');
  assertEq(report.network, 'none', 'and that it reached no network');

  // THE RUNTIME SELECTION IS THE STEADY STATE, and the marker is gone rather than rewritten.
  assertEq(readCustodyRuntimeMode(world.projectRoot).mode, 'root-only', 'the installation is in the steady state');
  assert(!existsSync(join(world.projectRoot, CUSTODY_MODE_FILENAME)), 'with no marker left behind');
  // AND A REAL RING EXISTS, holding the static key as generation 1.
  assert(existsSync(join(world.stateDir, 'ring')), 'a ring was written');

  // THE ORDER OF OPERATIONS, FROM THE LEDGER: quiesce app then sidecar, migrate, then start on the steady
  // state, then ask for a handshake.
  const commands = tools.ledger.all().map((entry) => entry.args.join(' '));
  const stopApp = commands.findIndex((c) => c.includes('stop app'));
  const stopSidecar = commands.findIndex((c) => c.includes('stop sidecar'));
  const migrate = commands.findIndex((c) => c.includes('--confirm-digest'));
  const start = commands.findIndex((c) => c.includes('up -d'));
  const health = commands.findIndex((c) => c.includes('ops:sidecar-health'));
  assert(stopApp >= 0 && stopApp < stopSidecar, 'the app is stopped before the sidecar');
  assert(stopSidecar < migrate, 'and both before the migration');
  assert(migrate < start && start < health, 'and the restart and the handshake follow it');
  // THE MIGRATION RAN ON THE BOOTSTRAP SELECTION AND THE RESTART DID NOT.
  assert(commands[migrate]!.includes(BOOTSTRAP_COMPOSE_FILE), 'the migration used the overlay');
  assert(!commands[start]!.includes(BOOTSTRAP_COMPOSE_FILE), 'the restart used the steady-state file alone');
  // NO PULL, NO BUILD.
  assert(commands[start]!.includes('--pull never') && commands[start]!.includes('--no-build'),
    'the restart neither pulls nor builds');
  for (const command of commands) {
    const withoutSafeFlags = command.split('--pull never').join('').split('--no-build').join('');
    assert(!withoutSafeFlags.includes('pull'), `no command pulls: ${command}`);
  }
});

await test('an interrupted cutover is RESUMABLE: a ring already there means the runtime half is what is left', async () => {
  // THE STATE THIS CLOSES. A cutover is two operations and the first is not reversible. If the ring was
  // written and the runtime switch did not finish — a NAS rebooted, a container did not come up, the command
  // was interrupted — the installation is left with a bootstrap runtime and a ring beside it. `migrate`
  // refuses to run against an installation that has a ring, correctly, so a plan that always tried to
  // migrate would leave that installation with no way forward but a manual one.
  const world = await installation('cutover-resume');
  // Exactly the on-disk state that interruption leaves: the ring exists, the marker still says bootstrap.
  adoptStaticKekAsRing(world.stateDir, world.root, world.staticKek, () => 1_800_000_000_000);
  assertEq(readCustodyRuntimeMode(world.projectRoot).mode, 'bootstrap', 'the runtime never moved');

  const tools = stackRunner({ planDigest: 'unused-because-there-is-nothing-left-to-migrate' });
  const planned = planCustodyCutover(world.request, tools);
  assertEq(planned.stage, 'switch-only', 'the plan is the remaining half');
  assertEq(planned.migrationPlanDigest, null, 'and there is no migration left to confirm');
  const plannedCommands = tools.ledger.all().map((entry) => entry.args.join(' '));
  assert(!plannedCommands.some((c) => c.includes('migrate')), 'planning did not ask for a migration plan');

  const report = runCustodyCutover({ ...world.request, confirmDigest: planned.planDigest }, tools);
  assertEq(report.ok, true, 'the resume completes');
  assertEq(report.resumed, true, 'and says it finished an interrupted cutover');
  assertEq(report.migrationPerformed, false, 'and does NOT claim to have migrated anything');
  assertEq(readCustodyRuntimeMode(world.projectRoot).mode, 'root-only', 'the runtime is now the steady state');
  const commands = tools.ledger.all().map((entry) => entry.args.join(' '));
  assert(!commands.some((c) => c.includes('--confirm-digest')), 'and no migration command was ever run');
  assert(report.notes.some((note) => note.includes('ALREADY')), 'the report says a ring was already there');
});

await test('a cutover whose health handshake fails puts the RUNTIME back and says what it did not undo', async () => {
  const world = await installation('cutover-health-rollback');
  const digest = await migrationDigestFor(world);
  let migrated = false;
  const tools = stackRunner({
    planDigest: digest,
    onMigrate: () => {
      migrated = true;
      adoptStaticKekAsRing(world.stateDir, world.root, world.staticKek, () => 1_800_000_000_000);
    },
    // The steady-state stack comes up and its sidecar does not answer; the bootstrap selection still does.
    health: (mode) => (mode === 'root-only' ? null : defaultHealth('bootstrap')),
  });
  const planned = planCustodyCutover(world.request, tools);
  let caught: unknown = null;
  try {
    runCustodyCutover({ ...world.request, confirmDigest: planned.planDigest }, tools);
  } catch (err) { caught = err; }

  assert(caught instanceof CustodyCutoverFailed, `a failed cutover is its own kind: ${String(caught)}`);
  const failure = caught as CustodyCutoverFailed;
  assertEq(migrated, true, 'the migration had already happened');
  assertEq(failure.migrationPerformed, true, 'and the failure says so');
  assertEq(failure.runtimeRestored, true, 'the runtime was put back');

  // THE RUNTIME SELECTION IS BACK ON BOOTSTRAP, and the stack was started on it.
  assertEq(readCustodyRuntimeMode(world.projectRoot).mode, 'bootstrap', 'the marker is back');
  const commands = tools.ledger.all().map((entry) => entry.args.join(' '));
  const restart = commands.filter((c) => c.includes('up -d') && c.includes(BOOTSTRAP_COMPOSE_FILE));
  assert(restart.length >= 1, 'the stack was started again on the bootstrap selection');
  assert(commands[commands.length - 1]!.includes('ops:sidecar-health'),
    'and the last thing it did was prove that selection answers');

  // AND IT DOES NOT CLAIM TO HAVE UNDONE THE MIGRATION.
  assert(failure.message.includes('RING WAS ALREADY WRITTEN'), 'the message names the ring that exists');
  assert(/does not remove it/i.test(failure.message), 'and says the runtime rollback did not remove it');
  assert(!/rolled back the migration|undone the migration/i.test(failure.message),
    'and never claims the migration was undone');
  assert(existsSync(join(world.stateDir, 'ring')), 'because the ring really is still there');
});

await test('a migration that does not complete leaves the installation cryptographically as it was', async () => {
  const world = await installation('cutover-migrate-fails');
  const digest = await migrationDigestFor(world);
  const tools = stackRunner({ planDigest: digest, failMigrate: true });
  const planned = planCustodyCutover(world.request, tools);
  let caught: unknown = null;
  try {
    runCustodyCutover({ ...world.request, confirmDigest: planned.planDigest }, tools);
  } catch (err) { caught = err; }

  assert(caught instanceof CustodyCutoverFailed, 'the cutover failed');
  const failure = caught as CustodyCutoverFailed;
  assertEq(failure.migrationPerformed, false, 'no ring was written');
  assert(failure.message.includes('NO RING WAS WRITTEN'), 'and the message says so plainly');
  assertEq(failure.runtimeRestored, true, 'and the runtime was put back');
  assert(!existsSync(join(world.stateDir, 'ring')), 'there is no ring in the state directory');
  assertEq(readCustodyRuntimeMode(world.projectRoot).mode, 'bootstrap', 'and the installation is as it was');
});

await test('the cutover never runs a command that could fetch, build or reach a media system', async () => {
  const world = await installation('cutover-boundary');
  const digest = await migrationDigestFor(world);
  const tools = stackRunner({
    planDigest: digest,
    onMigrate: () => { adoptStaticKekAsRing(world.stateDir, world.root, world.staticKek, () => 1_800_000_000_000); },
  });
  const planned = planCustodyCutover(world.request, tools);
  runCustodyCutover({ ...world.request, confirmDigest: planned.planDigest }, tools);
  for (const entry of tools.ledger.all()) {
    assertEq(entry.program, 'docker', 'every command is docker compose');
    // `--pull never` and `--no-build` are the flags that FORBID a fetch and a build, so they are removed
    // before the scan rather than tripping it — and their presence is asserted where the restart is checked.
    const line = entry.args.join(' ').toLowerCase().split('--pull never').join('').split('--no-build').join('');
    for (const forbidden of ['pull', 'build', 'jellyfin', 'plex', 'emby', 'torrent', 'usenet', 'nzb',
      'sabnzbd', 'magnet', '://', '.mkv', 'curl', 'wget']) {
      assert(!line.includes(forbidden), `no command carries ${forbidden}: ${line}`);
    }
  }
});

await test('a resume PROVES the ring it is finishing onto, and refuses everything that is not one', async () => {
  // THE HOLE THIS CLOSES, AND IT WAS THE WHOLE RESUME PATH. `switch-only` was selected by `kekRingExists`,
  // which asks whether there is a FILE at the ring's name — and then skipped every proof: no root key check,
  // no static key check, no keystore proof, no backup gate. The last act of that path is to switch the
  // runtime to ROOT-ONLY custody, where the sidecar opens exactly that file. So anything anybody could write
  // into the state directory was a runtime switch this command would perform on request.
  const world = await installation('resume-adversarial');
  const ringFile = kekRingPath(world.stateDir);
  const tools = () => stackRunner({ planDigest: 'not-reached' });

  // 1. A CORRUPT RING — bytes at the name that are not a ring this build wrote.
  mkdirSync(join(world.stateDir, 'ring'), { recursive: true });
  writeFileSync(ringFile, '{"not":"a ring"}');
  refuses(() => planCustodyCutover(world.request, tools()), 'does not open it', 'a corrupt ring');

  // 2. A RING SEALED UNDER A DIFFERENT ROOT — a real ring, from somewhere else.
  rmSync(join(world.stateDir, 'ring'), { recursive: true, force: true });
  adoptStaticKekAsRing(world.stateDir, randomBytes(32), world.staticKek, () => 1_800_000_000_000);
  refuses(() => planCustodyCutover(world.request, tools()), 'does not open it', 'a ring under another root');

  // 3. A RING WHOSE GENERATION 1 IS NOT THIS INSTALLATION'S STATIC KEK. Adoption changes the MECHANISM and
  //    not the key, so this ring is one these wrapped keys were never under.
  rmSync(join(world.stateDir, 'ring'), { recursive: true, force: true });
  adoptStaticKekAsRing(world.stateDir, world.root, randomBytes(32), () => 1_800_000_000_000);
  refuses(() => planCustodyCutover(world.request, tools()), 'static KEK as its', 'a ring holding another key');

  // 4. A RING THAT IS NOT THE POST-ADOPTION SHAPE — generated rather than adopted.
  rmSync(join(world.stateDir, 'ring'), { recursive: true, force: true });
  initializeKekRing(world.stateDir, world.root, () => 1_800_000_000_000);
  refuses(() => planCustodyCutover(world.request, tools()), 'interrupted migration would have left',
    'a ring an initialisation wrote rather than an adoption');

  // 5. A RING WITH AN EXTRA (PENDING) GENERATION — a rotation was already under way on it.
  rmSync(join(world.stateDir, 'ring'), { recursive: true, force: true });
  adoptStaticKekAsRing(world.stateDir, world.root, world.staticKek, () => 1_800_000_000_000);
  beginPendingGeneration(world.stateDir, world.root, () => 1_800_000_001_000);
  refuses(() => planCustodyCutover(world.request, tools()), 'interrupted migration would have left',
    'a ring that has already been rotated on');

  // AND THE REAL POST-ADOPTION RING IS ACCEPTED, so the proof is a gate and not a wall.
  rmSync(join(world.stateDir, 'ring'), { recursive: true, force: true });
  adoptStaticKekAsRing(world.stateDir, world.root, world.staticKek, () => 1_800_000_000_000);
  const planned = planCustodyCutover(world.request, tools());
  assertEq(planned.stage, 'switch-only', 'the genuine interrupted cutover resumes');
  assert(planned.resumeStateDigest !== null, 'and carries a digest over the state it proved');
});

await test('a resume re-proves the keystore and the backup, and a change to either is a refusal', async () => {
  const world = await installation('resume-bindings');
  adoptStaticKekAsRing(world.stateDir, world.root, world.staticKek, () => 1_800_000_000_000);
  const tools = () => stackRunner({ planDigest: 'not-reached' });
  const planned = planCustodyCutover(world.request, tools());

  // THE BACKUP IS STILL A PRECONDITION OF THE WHOLE OPERATION, not only of its first half. A resume that
  // skipped it would be a custody switch with no way back.
  const backupSet = join(world.appdata, 'backups', 'set-1');
  const manifest = join(backupSet, 'catalog-backup-manifest.json');
  const held = readFileSync(manifest);
  writeFileSync(manifest, '{"tampered":true}');
  refuses(() => planCustodyCutover(world.request, tools()), 'does not verify', 'a resume with a broken backup');
  writeFileSync(manifest, held);

  // AND A KEYSTORE THAT MOVED CHANGES THE PLAN, so a confirmation from before it moved cannot be spent.
  const custodian = new FileCustodian(world.stateDir, SECRET, world.staticKek);
  await custodian.provision('op-after-plan', randomUUID(), 0);
  const after = planCustodyCutover(world.request, tools());
  assert(after.planDigest !== planned.planDigest, 'the plan digest moves with the key set');
  refuses(() => runCustodyCutover({ ...world.request, confirmDigest: planned.planDigest }, tools()),
    'digest you confirmed', 'a stale confirmation over a moved keystore');
});

await test('the custody mode marker is written through the atomic no-follow writer', () => {
  // A hand-rolled temp-and-rename was three rules short of the writer this product already has. The one that
  // mattered: a file — or a symbolic link — already sitting at the temp name would have been written THROUGH.
  const project = join(WORK, 'marker-writer');
  mkdirSync(project, { recursive: true });
  writeCustodyRuntimeMode(project, 'bootstrap');
  assertEq(readCustodyRuntimeMode(project).mode, 'bootstrap', 'the marker round-trips');
  // NO TEMPORARY FILE IS LEFT BEHIND, which is what a walk of the project directory would otherwise trip on.
  const stray = readdirSync(project).filter((entry) => entry !== CUSTODY_MODE_FILENAME);
  assertEq(stray.length, 0, `nothing else is left in the project directory: ${stray.join(',')}`);
  // AND THE SOURCE USES THE ESTABLISHED WRITER RATHER THAN A RAW ONE.
  const source = readRepo('src/ops/custody-runtime-mode.ts');
  assert(source.includes('writeStateFileBytes('), 'the marker is written with the state writer');
  assert(!source.includes('writeFileSync('), 'and not with a raw writeFileSync');
});

await test('state that moves while the stack is quiesced is refused BEFORE the marker or the root-only start', async () => {
  // THE HOLE THIS CLOSES. The resume proved the ring and then held only the CUTOVER'S OWN lock, which
  // excludes nothing else in this product: a rotation and a retirement take the ROTATION lock and the
  // custodian's own writers take the CUSTODIAN WRITER lock. So between the proof and the marker removal the
  // ring could be rotated or a key file written, and the runtime would then be switched onto a state nobody
  // had proved. The proof was real; the window after it was open.
  //
  // Both interferences are injected at the moment the stack is quiesced — after everything the old code had
  // established, and before the switch — which is exactly the window that was unguarded.
  for (const [what, interfere] of [
    ['the ring is rotated', (world: Awaited<ReturnType<typeof installation>>) => {
      beginPendingGeneration(world.stateDir, world.root, () => 1_800_000_002_000);
    }],
    ['a key file is written', (world: Awaited<ReturnType<typeof installation>>) => {
      const custodian = new FileCustodian(world.stateDir, SECRET, world.staticKek);
      void custodian.provision(`op-race-${randomUUID().slice(0, 8)}`, randomUUID(), 0);
    }],
  ] as const) {
    const world = await installation(`quiesce-race-${what.split(' ')[1]}`);
    adoptStaticKekAsRing(world.stateDir, world.root, world.staticKek, () => 1_800_000_000_000);
    let fired = false;
    const tools = stackRunner({
      planDigest: 'not-reached',
      after: {
        when: 'stop sidecar',
        run: () => { if (!fired) { fired = true; interfere(world); } },
      },
    });
    const planned = planCustodyCutover(world.request, tools);
    let caught: unknown = null;
    try {
      runCustodyCutover({ ...world.request, confirmDigest: planned.planDigest }, tools);
    } catch (err) { caught = err; }

    assertEq(fired, true, `${what}: the interference really happened during the quiesce`);
    assert(caught instanceof CustodyCutoverFailed, `${what}: the cutover is refused: ${String(caught)}`);
    const failure = caught as CustodyCutoverFailed;
    assertEq(failure.migrationPerformed, false, `${what}: and nothing was migrated`);

    // REFUSED BEFORE THE SWITCH. The marker is untouched and nothing was ever started on the steady state.
    assertEq(readCustodyRuntimeMode(world.projectRoot).mode, 'bootstrap', `${what}: the marker is untouched`);
    const commands = tools.ledger.all().map((entry) => entry.args.join(' '));
    for (const command of commands.filter((entry) => entry.includes('up -d'))) {
      assert(command.includes(BOOTSTRAP_COMPOSE_FILE),
        `${what}: nothing was ever started on the root-only selection: ${command}`);
    }
    // AND THE SERVICES ARE BACK, proved by a handshake on the selection they were on.
    assertEq(failure.runtimeRestored, true, `${what}: the runtime was put back`);
    assert(commands[commands.length - 1]!.includes('ops:sidecar-health'),
      `${what}: and the last thing it did was prove that selection answers`);
  }
});

await test('no compose run can fetch an image, and the mode marker is never written by a predictable temp', async () => {
  // ---- `docker compose run` PULLS BY DEFAULT ----------------------------------------------------------
  //
  // THE HOLE THIS CLOSES. `--pull never` was on the `up` and on nothing else, and `compose run` applies the
  // project's pull policy — which for a missing image means it FETCHES one. That mattered most exactly where
  // it was missing: the migration (planning and execution) and the health probe. The maintenance container's
  // `network_mode: none` cannot help, because the pull happens before there is a container to confine.
  const world = await installation('no-fetch');
  const digest = await migrationDigestFor(world);
  const tools = stackRunner({
    planDigest: digest,
    onMigrate: () => { adoptStaticKekAsRing(world.stateDir, world.root, world.staticKek, () => 1_800_000_000_000); },
  });
  const planned = planCustodyCutover(world.request, tools);
  runCustodyCutover({ ...world.request, confirmDigest: planned.planDigest }, tools);
  const commands = tools.ledger.all().map((entry) => entry.args.join(' '));
  const runs = commands.filter((command) => / run /.test(command));
  assert(runs.length >= 3, `every leg of this uses compose run (${runs.length})`);
  for (const command of runs) {
    assert(command.includes('--pull never'), `a compose run that could fetch: ${command}`);
  }
  for (const command of commands.filter((entry) => entry.includes('up -d'))) {
    assert(command.includes('--pull never') && command.includes('--no-build'), `an up that could fetch: ${command}`);
  }

  // ---- AND THE HOST SCRIPT WRITES THE MARKER THE WAY THE TYPESCRIPT WRITER DOES -----------------------
  //
  // It wrote `printf ... > "${MARKER}.tmp.$$"`: a name anybody can predict, through a redirection that
  // FOLLOWS A SYMBOLIC LINK — so a link planted at that name is a write wherever it points, as whichever
  // account runs the script. On Unraid that is root, in a web terminal.
  const script = parseShellSource(readRepo('deploy/unraid-custody-mode.sh'), 'deploy/unraid-custody-mode.sh');
  // THE WRITE, NOT THE WORD. The file still NAMES the old defect in a comment, which is where a reader
  // learns why this is the way it is; what must be gone is a redirection into a predictable name.
  const executable = shellText(shellCode(script).lines);
  assert(!/>\s*"\$\{MARKER\}\.tmp/.test(executable), 'nothing is written through a predictable temporary name');
  assert(!/\$\$/.test(executable), 'and no process id names a file');
  const whole = shellText(script.lines);
  assert(/mktemp .*XXXXXXXXXX/.test(whole), 'it creates an unpredictable temp with mktemp');
  assert(whole.includes('umask 077'), 'private from the instant it exists');
  assert(/trap cleanup EXIT/.test(whole), 'and removed on every exit path');
  assert(/mv -f "\$\{TEMP\}" "\$\{MARKER\}"/.test(whole), 'and published by an atomic rename');

  // ROOT-ONLY REMOVES THE MARKER AND NEVER WRITES ONE FIRST: the steady state is defined by its absence.
  //
  // PARSED, NOT SLICED (Phase 329). The old version knew exactly what was hard here — its comment said "a
  // bare `root-only)` also appears inside the command printer, and a slice that started there would swallow
  // the bootstrap case and prove nothing" — and then anchored on `'\n  root-only)\n'`, a literal carrying a
  // bare LF and a guess at the indent. On a CRLF checkout `indexOf` answered -1 for BOTH ends, `slice(-1, -1)`
  // returned the EMPTY STRING, and the gate searched nothing and failed. Had the two literals been reversed
  // it would have searched nothing and PASSED, which is the same defect with a worse outcome.
  //
  // There are in fact THREE `root-only)` arms in that script — one validating a marker's contents, one in the
  // command printer, one performing the action — so the arm is selected by the `case` it belongs to rather
  // than by which occurrence comes first. Asking for an arm that is missing, duplicated or unterminated is an
  // error naming the script; there is no slice-shaped way to get a silent wrong answer.
  const rootOnly = shellText(shellCode({ path: 'root-only', lines: caseArm(caseBlock(script, 'ACTION'), 'root-only') }).lines);
  assert(rootOnly.includes('rm -f "${MARKER}"'), 'root-only removes the marker');
  assert(!rootOnly.includes('mktemp') && !rootOnly.includes('printf'), 'and writes nothing on the way there');
  // AND THE CONTRAST THAT PROVES THE ARM WAS REALLY SELECTED: the bootstrap arm, from the same `case`, is the
  // one that writes. A reader of the two lines above cannot tell an arm that writes nothing from an arm that
  // was never found; this can.
  const bootstrapArm = shellText(caseArm(caseBlock(script, 'ACTION'), 'bootstrap'));
  assert(bootstrapArm.includes('mktemp') && !bootstrapArm.includes('rm -f "${MARKER}"'),
    'while the bootstrap arm of the same case is the one that creates a marker');
});

// ---------------------------------------------------------------------------------------------------------
// 4. The CLI surface
// ---------------------------------------------------------------------------------------------------------

await test('the cutover CLI takes paths and names, never a key, and demands exactly one of plan/confirm', () => {
  const base = ['--project', '/mnt/user/projects/catalog', '--project-name', 'catalogauthority',
    '--backup-set', 'set-1'];
  const planned = parseCutoverArgs([...base, '--plan']);
  assertEq(planned.plan, true, 'a plan parses');
  assertEq(planned.hostRootKeyFile, '/mnt/user/appdata/catalog/secrets/custodian_root_key',
    'and the key paths come from the appdata default rather than from an operator typing one');
  const confirmed = parseCutoverArgs([...base, '--confirm-digest', 'a'.repeat(64)]);
  assertEq(confirmed.confirmDigest, 'a'.repeat(64), 'a confirmation parses');
  for (const [what, argv] of [
    ['both', [...base, '--plan', '--confirm-digest', 'a'.repeat(64)]],
    ['neither', base],
  ] as const) {
    let threw = false;
    try { parseCutoverArgs(argv); } catch { threw = true; }
    assertEq(threw, true, `${what} of plan and confirm is a usage error`);
  }
  for (const flag of ['--root-key', '--kek', '--secret', '--static-key']) {
    let threw = false;
    try { parseCutoverArgs([...base, flag, 'deadbeef']); } catch { threw = true; }
    assertEq(threw, true, `${flag} is not an option this command has`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// 5. The doctor reports custody, in every state
// ---------------------------------------------------------------------------------------------------------

/** A doctor run with the database halves stubbed out: this suite is about the custody checks. */
async function doctorWith(sidecarCustody: unknown): Promise<DoctorReport> {
  const failing = { query: async () => { throw new Error('no database in this suite'); } };
  return runDoctor({
    admin: failing as never,
    pool: failing as never,
    custodian: { status: async () => 'not_found' } as never,
    custodianMode: 'sidecar',
    appEnv: 'production',
    sidecarCustody: sidecarCustody as never,
  });
}
const check = (report: DoctorReport, name: string): DoctorCheck | undefined =>
  report.checks.find((entry) => entry.name === name);

await test('the doctor no longer tells a production deployment that managed KEK custody is not built', async () => {
  const report = await doctorWith({
    attempted: true,
    health: {
      op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: true, custodian: 'sidecar-managed-ring',
      ringGeneration: 2, ringActiveCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
    },
  });
  assertEq(check(report, 'production-gate-o5-managed-kek'), undefined,
    'the stale gate warning is gone in sidecar mode');
  const text = JSON.stringify(report);
  assert(!text.includes('is not built'), 'and nothing in the report says the mechanism is not built');
});

await test('a sidecar that does not answer is a FAIL, and the KEK-age check does not disappear', async () => {
  for (const [what, probe] of [
    ['no probe at all', undefined],
    ['a probe that got nothing this build will act on', { attempted: true, health: null }],
  ] as const) {
    const report = await doctorWith(probe);
    assertEq(check(report, 'custody-sidecar-health')?.state, 'fail', `${what} is a custody failure`);
    // THE CHECK THAT SAYS A KEY IS TOO OLD MUST NEVER VANISH IN THE STATES WHERE SOMETHING IS WRONG.
    assertEq(check(report, 'kek-rotation-age')?.state, 'fail', `${what} still reports the age check`);
    assertEq(report.ok, false, `${what} fails the report`);
  }
});

await test('valid static custody is a clearly named WARN that migration is pending', async () => {
  const report = await doctorWith({
    attempted: true,
    health: {
      op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: true, custodian: 'file-reference-harness',
      ringGeneration: null, ringActiveCreatedAt: null,
    },
  });
  assertEq(check(report, 'custody-sidecar-health')?.state, 'pass', 'the sidecar answered');
  const pending = check(report, 'custody-ring-migration');
  assertEq(pending?.state, 'warn', 'and static custody is a warning, not a failure');
  assert(pending!.detail.includes('PENDING'), 'that names the state');
  assert(pending!.detail.includes('ops:custody-cutover'), 'and the command that ends it');
  assertEq(check(report, 'kek-rotation-age')?.state, 'warn', 'and the age check is still emitted');
});

await test('ring metadata decides PASS, WARN or FAIL, and a contradiction is never the agreeable half', async () => {
  const day = 24 * 60 * 60 * 1000;
  const ring = (createdAt: number | null, generation: number | null): unknown => ({
    attempted: true,
    health: {
      op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: true, custodian: 'sidecar-managed-ring',
      ringGeneration: generation, ringActiveCreatedAt: createdAt,
    },
  });
  const fresh = await doctorWith(ring(Date.now() - 3 * day, 1));
  assertEq(check(fresh, 'custody-ring-metadata')?.state, 'pass', 'a coherent ring passes');
  assertEq(check(fresh, 'kek-rotation-age')?.state, 'pass', 'and a young key passes');

  const due = await doctorWith(ring(Date.now() - 200 * day, 3));
  assertEq(check(due, 'kek-rotation-age')?.state, 'warn', 'a key past the due age warns');

  const overdue = await doctorWith(ring(Date.now() - 800 * day, 4));
  assertEq(check(overdue, 'kek-rotation-age')?.state, 'fail', 'and one past the limit fails');

  // A SIDECAR THAT SAYS "RING" AND REPORTS NO GENERATION IS A CONTRADICTION. Both halves cannot be true and
  // this build refuses to pick one — and the age check still appears, as a failure.
  const contradiction = await doctorWith(ring(null, null));
  assertEq(check(contradiction, 'custody-ring-metadata')?.state, 'fail', 'a ring with no generation fails');
  assertEq(check(contradiction, 'kek-rotation-age')?.state, 'fail', 'and the age check says why');
  assert(check(contradiction, 'kek-rotation-age')!.detail.includes('contradicts itself'), 'in those words');
});

await test('no custody check carries a key, a path or a peer\'s own text', async () => {
  const report = await doctorWith({
    attempted: true,
    health: {
      op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: true, custodian: 'sidecar-managed-ring',
      ringGeneration: 1, ringActiveCreatedAt: Date.now() - 1000,
    },
  });
  const custody = report.checks.filter((entry) => entry.name.startsWith('custody-') || entry.name === 'kek-rotation-age');
  assert(custody.length >= 2, 'there are custody checks to inspect');
  for (const entry of custody) {
    assert(!/\//.test(entry.detail), `no check detail carries a path: ${entry.detail}`);
    assert(!/[0-9a-f]{32}/.test(entry.detail), `no check detail carries key-shaped material: ${entry.detail}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// 6. The invariant
// ---------------------------------------------------------------------------------------------------------

await test('this tranche reaches no network, media server or acquisition system', () => {
  for (const file of ['src/ops/custody-cutover.ts', 'src/ops/custody-cutover-cli.ts',
    'src/ops/custody-runtime-mode.ts', 'docker-compose.unraid.bootstrap.yml', 'deploy/unraid-custody-mode.sh']) {
    const source = readRepo(file).toLowerCase();
    for (const forbidden of ['jellyfin', 'plex', 'emby', '/mnt/user/media', '.mkv', 'nzb', 'torrent', 'magnet',
      'usenet', 'sabnzbd', 'curl ', 'wget ', 'node:http', 'fetch(']) {
      assert(!source.includes(forbidden), `${file} must not name ${forbidden}`);
    }
  }
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
