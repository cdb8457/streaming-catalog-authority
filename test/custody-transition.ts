import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import { spawnSync } from 'node:child_process';
import { CommandLedger, type MaintenanceCommand } from '../src/ops/maintenance-safety.js';
import { fakeDumpText, fakeToolchain } from './helpers/fake-toolchain.js';
import { callSite, callSites, parseShellSource } from './helpers/shell-source.js';

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
  }
  const tools = fakeToolchain({ dumpText: fakeDumpText(schemaVersion()) });
  const outcome = runVerifiedCompleteBackup({
    projectRoot: appdata, destination: 'backups', setName: 'set-1', custodian: 'sidecar',
    sidecarState: 'sidecar-state', secrets: 'secrets', promotionRecords: 'promotion-records',
  }, { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  assert(outcome.ok, `the backup verifies: ${JSON.stringify(outcome.failures)}`);
  if (options.withRootKey !== true) {
    // A RELEASED v1.1.4 INSTALLATION HAS NO ROOT KEY FILE AT ALL. The backup component model requires the
    // NAME, so the set was taken with the placeholder every other required secret carries; removing it now
    // leaves exactly what such an installation is — a genuine absence at that path, and a backup that
    // predates any root key.
    rmSync(join(appdata, 'secrets', 'custodian_root_key'), { force: true });
  }

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

  // ---- BUT CONFIRMING IT WRITES NOTHING WHILE THE ROOT KEY IS MISSING -------------------------------
  //
  // The base compose file BINDS the root wrapping key, and the bootstrap overlay does not take that mount
  // away — so the runtime this would select cannot start, and Docker asked to bind a source that is not
  // there may create a DIRECTORY where the installation's most sensitive file belongs. A marker written in
  // that state hands an operator something worse than what they had.
  refuses(() => runCustodyTransition({ ...world.request, confirmDigest: planned.planDigest }, tools),
    'cannot start', 'a confirmed legacy transition with no root wrapping key');
  assert(!existsSync(join(world.projectRoot, CUSTODY_MODE_FILENAME)), 'and no marker was written');
  assertEq(readCustodyRuntimeMode(world.projectRoot).declared, false, 'the selection is untouched');
});

await test('a legacy transition succeeds only after a valid root key AND a fresh backup that carries it', async () => {
  const world = await installation('legacy-then-root');
  const tools = composeRunner();

  // 1. THE ROOT KEY APPEARS, and the backup this installation already has was taken before it existed.
  //    That set restores an installation that cannot open the ring the cutover is about to write, so it is
  //    a good backup of the custody being LEFT and no way back from the custody being entered.
  writeFileSync(world.request.hostRootKeyFile, `${world.root.toString('hex')}\n`,
    { encoding: 'utf8', mode: 0o600 });
  if (POSIX) chmodSync(world.request.hostRootKeyFile, 0o600);
  refuses(() => classifyCustodyState(world.request), 'taken before that key existed',
    'a pre-root backup cannot authorize a custody-changing selection');
  assert(!existsSync(join(world.projectRoot, CUSTODY_MODE_FILENAME)), 'and no marker was written');

  // 2. A FRESH COMPLETE BACKUP, taken now that the root key is in place, is what authorizes it.
  const fresh = fakeToolchain({ dumpText: fakeDumpText(schemaVersion()) });
  const outcome = runVerifiedCompleteBackup({
    projectRoot: world.appdata, destination: 'backups', setName: 'set-2', custodian: 'sidecar',
    sidecarState: 'sidecar-state', secrets: 'secrets', promotionRecords: 'promotion-records',
  }, { runner: fresh.runner, fileRunner: fresh.fileRunner, ledger: fresh.ledger });
  assert(outcome.ok, 'the fresh backup verifies');
  const request = { ...world.request, backupSetName: 'set-2' };
  const evidence = classifyCustodyState(request);
  assertEq(evidence.rootKeyReady, true, 'the root key is in place');
  assertEq(evidence.verdict, 'legacy-static', 'and the installation is still legacy static custody');

  const planned = planCustodyTransition(request, tools);
  const report = runCustodyTransition({ ...request, confirmDigest: planned.planDigest }, tools);
  assertEq(report.changed, true, 'only now does the transition write a selection');
  assertEq(report.toMode, 'bootstrap', 'to the temporary bootstrap wiring');
  assertEq(readCustodyRuntimeMode(world.projectRoot).mode, 'bootstrap', 'and the marker says so');
});

await test('anything AT the root key path that is not a root key is a refusal, not a missing prerequisite', async () => {
  // THE DEFECT THIS CLOSES. Every `readRootWrappingKey` failure was reported as "not ready", which told an
  // operator to CREATE a root key when what they had was a custody failure sitting where one belongs.
  const world = await installation('root-key-invalid');
  writeFileSync(world.request.hostRootKeyFile, 'this is not a key\n', { encoding: 'utf8', mode: 0o600 });
  refuses(() => classifyCustodyState(world.request), 'not a missing prerequisite',
    'an invalid file at the root key path');

  const asDirectory = await installation('root-key-directory');
  rmSync(asDirectory.request.hostRootKeyFile, { force: true });
  mkdirSync(asDirectory.request.hostRootKeyFile, { recursive: true });
  refuses(() => classifyCustodyState(asDirectory.request), 'not a missing prerequisite',
    'a directory at the root key path');

  if (POSIX) {
    const linked = await installation('root-key-symlink');
    const elsewhere = join(WORK, 'root-key-elsewhere');
    writeFileSync(elsewhere, `${linked.root.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
    rmSync(linked.request.hostRootKeyFile, { force: true });
    symlinkSync(elsewhere, linked.request.hostRootKeyFile);
    refuses(() => classifyCustodyState(linked.request), 'not a missing prerequisite',
      'a symbolic link at the root key path');
  }

  // AND A GENUINE ABSENCE IS STILL THE PREREQUISITE IT IS, which is the whole distinction.
  const absent = await installation('root-key-absent');
  assertEq(classifyCustodyState(absent.request).rootKeyReady, false, 'nothing there at all is not a refusal');
});

await test('a backup set name is one contained name, not a path', async () => {
  const world = await installation('set-name');
  for (const [what, name] of [
    ['a traversal', '../set-1'],
    ['a deeper traversal', '../../etc'],
    ['an absolute path', POSIX ? '/etc' : 'C:/Windows'],
    ['a nested path', 'nested/set-1'],
  ] as const) {
    // The repository's own rule for a maintenance name is what refuses these, and it says so in its own
    // words: one name, no folder part.
    refuses(() => classifyCustodyState({ ...world.request, backupSetName: name }), 'no folder part',
      `${what} is not a backup set name`);
  }
  // A BLANK NAME IS ITS OWN REFUSAL, in the words the gate uses: there is no set to verify at all.
  refuses(() => classifyCustodyState({ ...world.request, backupSetName: '   ' }), 'no backup set was named',
    'a blank name');
});

await test('the launcher starts a legacy installation on the overlay, and a migrated one on the steady state', async () => {
  const world = await installation('launcher-selection');
  assertEq(launcherComposeArgs(world.projectRoot).join(' '), `-f ${RUNTIME_COMPOSE_FILE}`,
    'with no marker the launcher uses the steady-state file');
  writeCustodyRuntimeMode(world.projectRoot, 'bootstrap');
  assertEq(launcherComposeArgs(world.projectRoot).join(' '),
    `-f ${RUNTIME_COMPOSE_FILE} -f ${BOOTSTRAP_COMPOSE_FILE}`,
    'and with the marker declared it adds the overlay');

});

/**
 * RUN the shipped launcher with a FAKE `docker` on PATH and return the argv it was handed.
 *
 * EXECUTED, NOT READ. A source-string assertion cannot see a `$(...)` that word-splits, a path that gets
 * glob-expanded, or a newline left on the end of a filename — which is exactly the class of defect the first
 * version of this launcher had. The only way to know what `docker compose` receives is to be `docker` and
 * write down what arrived.
 */
function runLauncher(projectDir: string, verb: string, helper?: string): {
  readonly status: number; readonly argv: readonly string[]; readonly stderr: string;
} {
  const binDir = join(WORK, `bin-${randomUUID().slice(0, 8)}`);
  mkdirSync(binDir, { recursive: true });
  const record = join(binDir, 'argv.txt');
  // One argument per line, so a path containing a space is still one line and a stray newline inside an
  // argument would be visible as an extra one.
  writeFileSync(join(binDir, 'docker'),
    `#!/bin/sh
for a in "$@"; do printf '%s\n' "$a" >> '${record.split('\\').join('/')}'; done
exit 0
`,
    { encoding: 'utf8', mode: 0o755 });
  const outcome = spawnSync('sh', [join(repoRoot, 'deploy', 'unraid-ops-launcher.sh'), verb], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      CATALOG_AUTHORITY_REPO_DIR: projectDir,
      CATALOG_AUTHORITY_COMPOSE_FILE: join(projectDir, RUNTIME_COMPOSE_FILE),
      CATALOG_AUTHORITY_BOOTSTRAP_COMPOSE_FILE: join(projectDir, BOOTSTRAP_COMPOSE_FILE),
      CATALOG_AUTHORITY_CUSTODY_MODE_FILE: join(projectDir, CUSTODY_MODE_FILENAME),
      CATALOG_AUTHORITY_CUSTODY_MODE_HELPER: helper ?? join(repoRoot, 'deploy', 'read-custody-mode.mjs'),
    },
  });
  const argv = existsSync(record)
    ? readFileSync(record, 'utf8').split('\n').filter((line) => line !== '')
    : [];
  return { status: outcome.status ?? -1, argv, stderr: outcome.stderr ?? '' };
}

await test('the shipped launcher, EXECUTED against a fake docker, hands over exactly the right arguments', () => {
  // RUN IT WHEREVER THERE IS A POSIX SHELL, which on a Windows development host means the one Git ships. The
  // launcher is a `sh` script and the fake `docker` is one too; if no shell can run them this says so and
  // skips rather than asserting something it did not observe.
  if (spawnSync('sh', ['-c', 'exit 0']).status !== 0) {
    console.log('        (no POSIX shell on this host: the executed launcher test is skipped, not assumed)');
    return;
  }
  // A PROJECT DIRECTORY WITH A SPACE IN IT, deliberately. The first version word-split a string of
  // arguments, so a path like this arrived as two arguments and Docker was handed a file that does not
  // exist. Nothing here can tear it in half, because nothing here builds a string.
  const project = join(WORK, 'launcher project with spaces');
  mkdirSync(project, { recursive: true });
  for (const file of [RUNTIME_COMPOSE_FILE, BOOTSTRAP_COMPOSE_FILE]) writeFileSync(join(project, file), 'x');
  const runtimeFile = join(project, RUNTIME_COMPOSE_FILE);
  const bootstrapFile = join(project, BOOTSTRAP_COMPOSE_FILE);

  // 1. NO MARKER — the steady state, and the file arrives whole.
  const absent = runLauncher(project, 'status');
  assertEq(absent.status, 0, `a project with no marker runs: ${absent.stderr}`);
  assertEq(absent.argv.join('|'), `compose|-f|${runtimeFile}|ps|-a`, 'one compose file, unsplit');

  // 2. root-only DECLARED — the same, and no overlay.
  writeCustodyRuntimeMode(project, 'root-only');
  const rootOnly = runLauncher(project, 'status');
  assertEq(rootOnly.status, 0, `a root-only marker runs: ${rootOnly.stderr}`);
  assertEq(rootOnly.argv.join('|'), `compose|-f|${runtimeFile}|ps|-a`, 'still one compose file');

  // 3. bootstrap DECLARED — the overlay is added, as four separate arguments.
  writeCustodyRuntimeMode(project, 'bootstrap');
  const bootstrap = runLauncher(project, 'status');
  assertEq(bootstrap.status, 0, `a bootstrap marker runs: ${bootstrap.stderr}`);
  assertEq(bootstrap.argv.join('|'), `compose|-f|${runtimeFile}|-f|${bootstrapFile}|ps|-a`,
    'both compose files, each one argument');

  // 4. EVERY run AND up REFUSES TO FETCH, and every up refuses to build — proved from what docker received.
  for (const verb of ['start-postgres', 'start-ui', 'restart-ui']) {
    const started = runLauncher(project, verb);
    assertEq(started.status, 0, `${verb} runs`);
    assert(started.argv.includes('up'), `${verb} brings something up`);
    assert(started.argv.includes('--pull') && started.argv.includes('never'), `${verb} passes --pull never`);
    assert(started.argv.includes('--no-build'), `${verb} passes --no-build`);
  }
  const opsRun = runLauncher(project, 'doctor');
  assert(opsRun.argv.includes('run'), 'doctor runs a one-shot container');
  assert(opsRun.argv.includes('--pull') && opsRun.argv.includes('never'), 'and it too refuses to fetch');

  // 5. A MARKER THIS BUILD WILL NOT READ IS A REFUSAL, AND DOCKER IS NEVER CALLED.
  for (const [what, write] of [
    ['a word this build does not define', () => writeFileSync(join(project, CUSTODY_MODE_FILENAME), 'half\n')],
    ['whitespace hiding an invalid word', () => writeFileSync(join(project, CUSTODY_MODE_FILENAME), 'boot strap\n')],
    ['a directory', () => {
      rmSync(join(project, CUSTODY_MODE_FILENAME), { force: true });
      mkdirSync(join(project, CUSTODY_MODE_FILENAME), { recursive: true });
    }],
  ] as const) {
    write();
    const refused = runLauncher(project, 'status');
    assertEq(refused.status, 3, `${what} is refused`);
    assertEq(refused.argv.length, 0, `${what}: docker was never called`);
  }
  rmSync(join(project, CUSTODY_MODE_FILENAME), { recursive: true, force: true });

  // 6. A MARKER THAT WAS THERE AND IS GONE BY THE TIME THE DESCRIPTOR OPENS IS A RACE, NOT A STEADY STATE.
  //
  // THE HOLE THIS CLOSES. Reaching that point means the name check SAW something and the descriptor read
  // found nothing, so the marker was removed in between. Mapping it to "no marker, therefore root-only"
  // would let anything that can unlink one file downgrade an unmigrated installation onto the steady-state
  // stack — the exact outcome this launcher was changed to prevent. A genuinely absent marker never reaches
  // the helper at all: it returns the steady state before the helper is invoked, which is case 1 above.
  //
  // INJECTED DETERMINISTICALLY. A real race is a few microseconds wide; a stub reader that answers ABSENT
  // while a real marker sits on disk puts the launcher in exactly the state the race produces.
  writeCustodyRuntimeMode(project, 'bootstrap');
  const stub = join(WORK, 'absent-reader.mjs');
  writeFileSync(stub, 'process.exit(4);', 'utf8');
  const raced = runLauncher(project, 'status', stub);
  assertEq(raced.status, 3, 'a marker that vanished under the reader is refused');
  assertEq(raced.argv.length, 0, 'and docker was never called');
  assert(raced.stderr.includes('removed while this command was reading it'), 'and it says what happened');
  rmSync(join(project, CUSTODY_MODE_FILENAME), { recursive: true, force: true });

  // AND THE ABSENCE THAT IS NOT A RACE STILL STARTS THE STEADY STATE, so the refusal above is about the
  // race and not about absence.
  const genuinelyAbsent = runLauncher(project, 'status');
  assertEq(genuinelyAbsent.status, 0, 'a genuinely absent marker still runs');
  assertEq(genuinelyAbsent.argv.join('|'), `compose|-f|${runtimeFile}|ps|-a`, 'on the steady-state file');

  // A SYMBOLIC LINK AT THE MARKER IS THE SHARPEST CASE OF ALL — the old reader checked for one and then read
  // through a redirect that follows one — and CREATING a link needs a privilege Windows does not hand a test
  // process. So it runs where links can be made, and is skipped rather than assumed where they cannot.
  if (POSIX) {
    const elsewhere = join(WORK, 'marker-elsewhere');
    writeFileSync(elsewhere, 'bootstrap\n');
    symlinkSync(elsewhere, join(project, CUSTODY_MODE_FILENAME));
    const linked = runLauncher(project, 'status');
    assertEq(linked.status, 3, 'a symlinked marker is refused');
    assertEq(linked.argv.length, 0, 'and docker was never called');
    rmSync(join(project, CUSTODY_MODE_FILENAME), { force: true });
  } else {
    console.log('        (the symlinked-marker case needs a platform that lets a test create one)');
  }
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
    const text = readRepo(script);
    const source = parseShellSource(text, script);
    // COUNTED, NOT TERMINATED (Phase 329). This used to assert the literal
    // `'write_custody_secret custodian_root_key\n'` — an LF glued to the end, standing in for "and nothing
    // after it". On a CRLF checkout the byte after the name is a CR, the literal never matched, and the gate
    // announced that the setup script passes a value for the root key when it passes none. The line ending was
    // never the property under test; the ARGUMENT COUNT is. So the call site is split into words and counted,
    // which says exactly what this gate means and says it the same way on every checkout.
    const call = callSite(source, 'write_custody_secret');
    assertEq(call.join(' '), 'write_custody_secret custodian_root_key',
      `${script} passes no value for the root key`);
    assertEq(call.length, 2, `${script} hands the helper a name and nothing else`);
    assert(/CUSTODY_HELPER\}" "\$\{SECRETS_DIR\}\/\$\{name\}" --generate/.test(text),
      `${script} asks the helper to generate it`);
    // AND THE HELPER'S OWN INVOCATION CARRIES NO VALUE EITHER: a path, a source word, and two ids. This is
    // the argv that would appear in `ps` for every account on the host, so it is the one worth counting.
    const invocations = callSites(source, 'node').filter((call) => call[1] === '${CUSTODY_HELPER}');
    assertEq(invocations.length, 1, `${script} runs the custody helper exactly once`);
    const invocation = invocations[0]!;
    assertEq(invocation.length, 6,
      `${script} runs the helper with a path, a source and two ids: ${invocation.join(' ')}`);
    assertEq(invocation[3], '--generate', `${script} names the source rather than supplying the value`);
    // NOT ONE WORD OF THAT COMMAND LINE IS A SECRET. Every argument is a path or an id expanded from a
    // variable this script set from its own configuration; none is a substitution that produces key material.
    for (const word of invocation.slice(1)) {
      assert(!/random_secret|randomBytes|openssl/.test(word),
        `${script} puts no generated value on the helper's command line: ${word}`);
    }
    assert(!/write_custody_secret custodian_root_key ["'$]/.test(text),
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

await test('a root key path that cannot be EXAMINED is refused, not reported as absent', async () => {
  // `lstat(path, { throwIfNoEntry: false })` answers `undefined` for ENOENT and THROWS for everything else.
  // Absence is the prerequisite this command exists to name; a path that cannot be examined at all is not
  // absence, and letting the raw filesystem error escape would put an unclassified failure in the middle of
  // the classifier — an operator would see a stack, not a decision.
  const world = await installation('root-key-unexaminable');
  // A path the operating system will not accept AT ALL stands in for the field cases on every host:
  // it throws from `lstat` with something that is not ENOENT, which is precisely the branch under test.
  const unexaminable = {
    ...world.request,
    hostRootKeyFile: `${world.request.hostRootKeyFile}${String.fromCharCode(0)}x`,
  };
  refuses(() => classifyCustodyState(unexaminable), 'could not be examined at all',
    'a root key path the operating system will not answer for');

  if (POSIX && typeof process.getuid === 'function' && process.getuid() !== 0) {
    // AND THE CASE THAT ACTUALLY HAPPENS IN THE FIELD: a secrets directory this process cannot search.
    const blocked = await installation('root-key-unsearchable');
    const secrets = join(blocked.appdata, 'secrets');
    chmodSync(secrets, 0o000);
    try {
      refuses(() => classifyCustodyState(blocked.request), 'could not be examined at all',
        'a secrets directory this process cannot search');
    } finally {
      chmodSync(secrets, 0o700);
    }
  } else {
    console.log('        (skipped: an unsearchable directory needs POSIX permissions this host does not apply)');
  }
});

await test('the marker reader reads to END OF FILE under its own bound, and a prefix is not a word', () => {
  // THE DEFECT THIS CLOSES. The reader allocated exactly what `fstat` reported and read exactly that many
  // bytes, so a marker that GREW between the two was accepted as its own first N bytes — and the prefix of
  // an invalid word can be a valid one: `bootstrapX` cut to nine bytes is `bootstrap`. The read now goes to
  // EOF with a byte of headroom above the bound, and anything that does not match what `fstat` promised is a
  // file that moved underneath the read.
  const helper = join(repoRoot, 'deploy', 'read-custody-mode.mjs');
  const read = (contents: string | null): { status: number; stdout: string } => {
    const path = join(WORK, `marker-${randomUUID()}`);
    if (contents !== null) writeFileSync(path, contents, 'utf8');
    const run = spawnSync(process.execPath, [helper, path], { encoding: 'utf8' });
    return { status: run.status ?? -1, stdout: run.stdout.trim() };
  };

  assertEq(read('bootstrap\n').status, 0, 'a mode this build defines is answered');
  assertEq(read('bootstrap\n').stdout, 'bootstrap', 'and it is the word itself');
  assertEq(read('bootstrapX\n').status, 3, 'a longer word is NOT its own valid prefix');
  assertEq(read(`bootstrap${' '.repeat(64)}`).status, 3, 'and neither is one padded past the bound');
  assertEq(read(null).status, 4, 'nothing there at all is the steady state, not a refusal');
});

await test('the marker reader runs its command line only when it IS the program', () => {
  // THE DEFECT THIS CLOSES. Direct-run detection compared this module's URL against the BASENAME of the
  // entry point, so ANY program named `read-custody-mode.mjs` made the module run its CLI while merely being
  // imported — exiting the host process mid-import with 3 or 4. It is a path question now.
  const imposter = join(WORK, `imposter-${randomUUID()}`);
  mkdirSync(imposter, { recursive: true });
  const marker = join(WORK, `marker-${randomUUID()}`);
  writeFileSync(marker, 'bootstrap\n', 'utf8');
  const real = pathToFileURL(join(repoRoot, 'deploy', 'read-custody-mode.mjs')).href;
  writeFileSync(join(imposter, 'read-custody-mode.mjs'),
    `import { readCustodyModeMarker } from ${JSON.stringify(real)};\n`
    + 'process.stdout.write("imposter:" + readCustodyModeMarker(process.argv[2]).state);\n', 'utf8');

  const run = spawnSync(process.execPath, [join(imposter, 'read-custody-mode.mjs'), marker], { encoding: 'utf8' });
  assertEq(run.status, 0, 'importing the reader does not exit the importing program');
  assertEq(run.stdout.trim(), 'imposter:mode', 'and the importer, not the import, produced the output');
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
