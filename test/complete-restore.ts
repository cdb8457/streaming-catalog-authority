import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_VERSION } from '../src/db/schema-version.js';
import { REQUIRED_SECRET_FILES, COMPONENT_ARTIFACT_NAMES } from '../src/ops/backup-components.js';
import {
  runVerifiedCompleteBackup,
  type CompleteBackupRequest,
} from '../src/ops/complete-backup.js';
import {
  MAINTENANCE_LOCK_DIRNAME,
  MaintenanceRefused,
  assertPermittedCommand,
  CommandLedger,
} from '../src/ops/maintenance-safety.js';
import {
  CompleteRestoreFailed,
  RESTORE_JOURNAL_NAME,
  abandonRestore,
  canonicalOperation,
  classifyTarget,
  composeOccupancyProbe,
  planCompleteRestore,
  prepareRuntimeRoleSql,
  readRestoreJournal,
  renderCompleteRestore,
  renderRestorePlan,
  resolveCompleteRestoreRequest,
  runCompleteRestore,
  type CompleteRestoreRequest,
  type OccupancyProbe,
} from '../src/ops/complete-restore.js';
import {
  DESTRUCTIVE_STEP_IDS,
  PROOF_STEP_IDS,
  RESTORE_STEP_IDS,
  placementsFor,
  requiredPlacementIds,
  stepsFor,
} from '../src/ops/restore-model.js';
import {
  COMPLETE_RESTORE_EXIT_FAILED,
  COMPLETE_RESTORE_EXIT_REFUSED,
  MODE_VALUE_FLAGS,
  main as cliMain,
  parseCompleteRestoreArgs,
} from '../src/ops/complete-restore-cli.js';
import { fakeDumpText, fakeToolchain } from './helpers/fake-toolchain.js';
import { restoreStack, setDumpDigest, setKeystoreDigest } from './helpers/fake-restore-stack.js';

// Phases 297-304 — the restore, and every way it must refuse to perform one.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - A RESTORE PUTS ALL FOUR COMPONENTS BACK, in the one order that works: the teardown before the replay,
//     the SECRETS before the fresh database is initialised from them, and the keystore into a volume that has
//     been emptied rather than merged into.
//   - EVERYTHING THAT CAN REFUSE HAPPENS BEFORE ANYTHING IS DESTROYED. A set that does not verify, a set from
//     another schema, a topology that disagrees with the set's manifest, a missing component, a hostile path,
//     a wrong confirmation — every one of them leaves the modelled volumes intact and the stack running.
//   - THE SAFETY SET IS PHASE 277'S OWN CYCLE, taken inside this run's lock, and a safety set that does not
//     verify STOPS the restore before the teardown.
//   - THE PROOFS ARE NOT SATISFIABLE BY LIVENESS. A restore that placed a keystore from a DIFFERENT moment
//     starts, passes the doctor, and FAILS the decryption proof — which is the failure this whole family
//     exists for.
//   - AN INTERRUPTED RESTORE IS A NAMED STATE: a journal refuses a fresh run, `--resume` continues without
//     re-swapping, and `--abandon` puts the host directories back and says what it cannot bring back.
//   - NOTHING IN THE COMMAND LEDGER REACHES A NETWORK, A REGISTRY, A MEDIA PATH, A MEDIA SERVER OR AN
//     ACQUISITION SYSTEM — asserted against the commands that were actually issued.
//   - NO SECRET CONTENT, HOST PATH OR COMPONENT CONTENT REACHES A REPORT.

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
/** Read a repository file with line endings normalised, so a CRLF checkout reads the same as an LF one. */
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').split('\r\n').join('\n');
const WORK = mkdtempSync(join(tmpdir(), 'ca-restore-'));
const SECRET_VALUE = 'a-kek-value-that-must-never-appear-in-any-report';
const HOST_MARKER = 'ca-restore-host-marker';

/** A project shaped like a real one, with a live installation in it. */
function makeProject(name: string, options: {
  readonly sidecar?: boolean;
  readonly records?: boolean;
  readonly secrets?: readonly string[];
} = {}): string {
  const root = join(WORK, name);
  mkdirSync(root, { recursive: true });
  const secrets = join(root, 'secrets');
  mkdirSync(secrets, { recursive: true });
  for (const file of options.secrets ?? REQUIRED_SECRET_FILES) {
    writeFileSync(join(secrets, file), file === 'custodian_kek' ? SECRET_VALUE : `${file}-live\n`, 'utf8');
  }
  if (options.records !== false) {
    mkdirSync(join(root, 'promotion-records'), { recursive: true });
    writeFileSync(join(root, 'promotion-records', 'record-live.json'), '{"live":1}\n', 'utf8');
  }
  if (options.sidecar === true) {
    // BOTH SUBDIRECTORIES, because that is what the shipped inspector recognises a FileCustodian root BY.
    // A fixture with only `keys` produces a set that does not verify — correctly.
    mkdirSync(join(root, 'sidecar-state', 'keys'), { recursive: true });
    mkdirSync(join(root, 'sidecar-state', 'tombstones'), { recursive: true });
    writeFileSync(join(root, 'sidecar-state', 'keys', 'live'), 'live-wrapped\n', 'utf8');
  }
  return root;
}

/** Take a real, verified set out of a project, using the shipped Phase 277 command against a fake toolchain. */
function takeSet(root: string, setName: string, options: { readonly sidecar?: boolean } = {}): string {
  const tools = fakeToolchain();
  const request: CompleteBackupRequest = {
    projectRoot: root,
    destination: 'backups',
    setName,
    custodian: options.sidecar === true ? 'sidecar' : 'inline',
    secrets: 'secrets',
    promotionRecords: 'promotion-records',
    ...(options.sidecar === true ? { sidecarState: 'sidecar-state' } : {}),
  };
  const outcome = runVerifiedCompleteBackup(request, {
    runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger, now: () => new Date(0),
  });
  assert(outcome.ok, `the fixture set ${setName} had to be taken and verified: ${outcome.failures.join('; ')}`);
  return join(root, 'backups', setName);
}

function request(root: string, setName: string, overrides: Partial<CompleteRestoreRequest> = {}): CompleteRestoreRequest {
  return {
    projectRoot: root,
    destination: 'backups',
    setName,
    custodian: 'inline',
    secrets: 'secrets',
    promotionRecords: 'promotion-records',
    ...overrides,
  };
}

/** A world in which the set being restored IS a coherent moment. */
function worldFor(setDir: string, options: Parameters<typeof restoreStack>[0] | null = null) {
  return restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    ...(options ?? {}),
  } as Parameters<typeof restoreStack>[0]);
}

function depsFor(world: ReturnType<typeof restoreStack>, suffix = 'aaaaaaaaaaaa') {
  return {
    runner: world.runner,
    fileRunner: world.inputRunner,
    backupFileRunner: world.outputRunner,
    ledger: world.ledger,
    suffix: () => suffix,
    now: () => new Date(0),
  };
}

/**
 * Plan a restore and hand back both the plan and the digest a confirmation needs.
 *
 * A safety set is the default because there is no longer any state in which this command believes it has
 * nothing to lose: `--accept-data-loss` is the only way to plan without one.
 */
function planFor(req: CompleteRestoreRequest, safetySet = true, probe?: OccupancyProbe) {
  const resolved = resolveCompleteRestoreRequest(req, probe);
  return { resolved, plan: planCompleteRestore(resolved, { safetySet, acceptDataLoss: !safetySet }) };
}

console.log('Running Phases 297-304 complete restore suite:\n');

// ---------------------------------------------------------------------------------------------------------
// Phase 297 — the model
// ---------------------------------------------------------------------------------------------------------

test('every component declares exactly one placement, and only the keystore moves with the topology', () => {
  const inline = placementsFor('inline');
  const sidecar = placementsFor('sidecar');
  assertEq(inline.length, 4, 'all four components are placed');
  assertEq(sidecar.length, 4, 'in both topologies');
  for (const placement of [...inline, ...sidecar]) {
    assert(['swap', 'container-copy', 'replay'].includes(placement.kind), `${placement.id} declares a known kind`);
    assert(placement.proves.length > 10, `${placement.id} says what it establishes`);
  }
  // THE ONLY DIFFERENCE BETWEEN THE TWO TOPOLOGIES IS THE KEYSTORE. If a second component ever moved, the
  // "declared, never guessed" claim would be covering more than it says.
  const differing = inline.filter((placement, index) => placement.kind !== sidecar[index]!.kind);
  assertEq(differing.length, 1, 'exactly one placement depends on the topology');
  assertEq(differing[0]!.id, 'keystore', 'and it is the keystore');
  assertEq(inline.find((p) => p.id === 'keystore')!.kind, 'container-copy', 'inline custody copies into a container');
  assertEq(sidecar.find((p) => p.id === 'keystore')!.kind, 'swap', 'sidecar custody swaps a host directory');
});

test('only the promotion records are optional, and the required list is derived rather than retyped', () => {
  for (const custodian of ['inline', 'sidecar'] as const) {
    const optional = placementsFor(custodian).filter((placement) => placement.optional).map((p) => p.id);
    assertEq(optional.join(','), 'promotion-records', `${custodian}: only the records are optional`);
    const required = requiredPlacementIds(custodian);
    assertEq(required.includes('promotion-records'), false, 'and they are not required');
    for (const id of ['database', 'keystore', 'secrets'] as const) {
      assert(required.includes(id), `${custodian}: ${id} is required`);
    }
  }
});

test('the step order puts the teardown before the replay and the secrets before the fresh database', () => {
  const ids = stepsFor({ custodian: 'inline', safetySet: true, promotionRecords: true });
  const at = (id: string): number => ids.indexOf(id as never);
  assert(at('safety-set') < at('stop-and-destroy'), 'the safety set is taken before anything is destroyed');
  assert(at('stop-and-destroy') < at('replay-database'), 'the volumes are destroyed before the dump is replayed');
  // THE ONE THAT CLOSES THE `postgres_password` CAVEAT. A fresh volume is initialised with the password in the
  // secret file it is given, so placing the set's secrets after `database-up` would leave an installation that
  // cannot authenticate to its own database.
  assert(at('place-secrets') < at('database-up'), 'the secrets are placed before the fresh database starts');
  assert(at('database-up') < at('prepare-runtime-role'), 'the database is up before its role is prepared');
  assert(at('prepare-runtime-role') < at('replay-database'), 'the role exists before the grants land on it');
  assert(at('replay-database') < at('stack-up'), 'the data is in before the app starts on it');
  for (const proof of PROOF_STEP_IDS) {
    assert(at(proof) > at('stack-up'), `${proof} runs after the stack is up`);
  }
});

test('a step list has no operation that will not happen', () => {
  const inline = stepsFor({ custodian: 'inline', safetySet: false, promotionRecords: false });
  assertEq(inline.includes('safety-set'), false, 'a run taking no safety set does not list one');
  assertEq(inline.includes('place-promotion-records'), false, 'nor a records placement it will not do');
  assertEq(inline.includes('place-sidecar-keystore'), false, 'nor the other topology\'s keystore placement');
  assert(inline.includes('place-inline-keystore'), 'it lists its own');
  const sidecar = stepsFor({ custodian: 'sidecar', safetySet: true, promotionRecords: true });
  assert(sidecar.includes('place-sidecar-keystore'), 'sidecar custody lists the swap');
  assertEq(sidecar.includes('place-inline-keystore'), false, 'and not the container copy');
});

test('every destructive step is one of the model\'s, and no proof is destructive', () => {
  for (const id of DESTRUCTIVE_STEP_IDS) {
    assert((RESTORE_STEP_IDS as readonly string[]).includes(id), `${id} is a real step`);
    assertEq(PROOF_STEP_IDS.includes(id), false, `${id} is not both a proof and destructive`);
  }
  assert(DESTRUCTIVE_STEP_IDS.includes('stop-and-destroy'), 'the teardown is destructive');
  assert(DESTRUCTIVE_STEP_IDS.includes('replay-database'), 'so is the replay');
  assertEq(DESTRUCTIVE_STEP_IDS.includes('safety-set'), false, 'the safety set is not');
});

// ---------------------------------------------------------------------------------------------------------
// Phase 298 — classification and refusal, before anything is destroyed
// ---------------------------------------------------------------------------------------------------------

test('a set that does not verify is refused, and nothing is stopped', () => {
  const root = makeProject('unverifiable');
  const setDir = takeSet(root, 'set-1');
  // TAMPER WITH A COMPONENT AFTER THE SET WAS TAKEN. The verification is what catches this, and the restore
  // must consume its verdict rather than merely running it.
  writeFileSync(join(setDir, COMPONENT_ARTIFACT_NAMES.database), 'not the dump that was digested\n', 'utf8');
  refuses(() => resolveCompleteRestoreRequest(request(root, 'set-1')), 'does not verify',
    'a tampered set is refused');
});

test('an intact set from another schema version is refused as a rollback point, not replayed', () => {
  const root = makeProject('older-set');
  const setDir = takeSet(root, 'set-old');
  // REWRITE THE MANIFEST AND THE DUMP TOGETHER, so the set is INTACT and genuinely older — the case that
  // verifies and must still not be restored here.
  const older = MIGRATION_VERSION - 1;
  writeFileSync(join(setDir, COMPONENT_ARTIFACT_NAMES.database), fakeDumpText(older), 'utf8');
  const manifestPath = join(setDir, 'catalog-backup-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.schemaVersion = older;
  const components = manifest.components as Array<Record<string, unknown>>;
  const dump = components.find((component) => component.id === 'database')!;
  // Re-digest the rewritten dump so the set is internally consistent: this is an INTACT older set.
  dump.digest = digestOf(join(setDir, COMPONENT_ARTIFACT_NAMES.database));
  dump.bytes = readFileSync(join(setDir, COMPONENT_ARTIFACT_NAMES.database)).byteLength;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  refuses(() => resolveCompleteRestoreRequest(request(root, 'set-old')), 'rollback point',
    'an intact older set is refused with the reason, not restored');
});

test('a set taken under another custody topology is refused rather than reinterpreted', () => {
  const root = makeProject('topology', { sidecar: true });
  takeSet(root, 'set-sidecar', { sidecar: true });
  refuses(() => resolveCompleteRestoreRequest(request(root, 'set-sidecar', {
    custodian: 'inline',
  })), 'will not choose which of the two you meant', 'a sidecar set restored as inline is refused');
});

test('sidecar custody with no state directory is refused, and inline custody with one is too', () => {
  const root = makeProject('declared', { sidecar: true });
  takeSet(root, 'set-s', { sidecar: true });
  refuses(() => resolveCompleteRestoreRequest(request(root, 'set-s', { custodian: 'sidecar' })),
    'will not guess where', 'sidecar custody must name its directory');
  const inlineRoot = makeProject('declared-inline');
  takeSet(inlineRoot, 'set-i');
  refuses(() => resolveCompleteRestoreRequest(request(inlineRoot, 'set-i', { sidecarState: 'sidecar-state' })),
    'will not choose which', 'inline custody must not be given one');
});

test('a set carrying promotion records with nowhere to put them is refused, never silently dropped', () => {
  const root = makeProject('records');
  takeSet(root, 'set-r');
  const bare = { ...request(root, 'set-r') } as Record<string, unknown>;
  delete bare.promotionRecords;
  refuses(() => resolveCompleteRestoreRequest(bare as unknown as CompleteRestoreRequest), 'nowhere to put them',
    'a component with no destination is a refusal');
});

test('hostile target paths are refused rather than normalised', () => {
  const root = makeProject('hostile');
  takeSet(root, 'set-h');
  refuses(() => resolveCompleteRestoreRequest(request(root, 'set-h', { secrets: '../outside' })),
    'must not step above the project root', 'traversal out of the project is refused');
  // A SYMBOLIC LINK AT A TARGET. `assertPlainTree` is what refuses it, and it runs before anything is stopped.
  const linked = makeProject('hostile-link');
  takeSet(linked, 'set-l');
  const away = join(WORK, 'somewhere-else');
  mkdirSync(away, { recursive: true });
  writeFileSync(join(away, 'x'), 'x\n', 'utf8');
  try {
    symlinkSync(away, join(linked, 'promotion-records', 'link'), 'dir');
  } catch {
    return; // A platform without symbolic link permission; the traversal case above still holds.
  }
  refuses(() => resolveCompleteRestoreRequest(request(linked, 'set-l')), 'symbolic link',
    'a symlink inside a target directory is refused');
});

test('emptiness is NEVER inferred: empty host directories are UNKNOWN, and UNKNOWN is not empty', () => {
  // THE DEFECT THIS PINS. The first cut called a project with empty host directories EMPTY and skipped the
  // safety set on the strength of it. But `docker compose down -v` destroys the DATABASE VOLUME and, in
  // inline custody, the KEYSTORE VOLUME — neither of which is on the host. A project can have an empty
  // secrets directory and a volume holding an entire catalog, which is exactly the state of an installation
  // whose host files were lost and whose Docker state was not.
  const populated = makeProject('occupied');
  const target = (dir: string, name: string) => ({ relative: name, dir: join(dir, name), name });
  assertEq(classifyTarget(populated, [target(populated, 'secrets'), target(populated, 'promotion-records')]),
    'OCCUPIED', 'a project with secrets in it has something to lose');

  const bare = join(WORK, 'bare-project');
  mkdirSync(join(bare, 'secrets'), { recursive: true });
  assertEq(classifyTarget(bare, [target(bare, 'secrets')]), 'UNKNOWN',
    'EMPTY HOST DIRECTORIES ARE NOT PROOF — the volumes are unread, and unreadable without a mutation');

  // A NON-MUTATING PROBE CAN ONLY EVER ADD OCCUPANCY, NEVER SUBTRACT IT. `compose ps` starts nothing; a
  // project WITH containers has been up and has state, and one without could still hold volumes from a
  // `down` that kept them.
  assertEq(classifyTarget(bare, [target(bare, 'secrets')], () => 'containers'), 'OCCUPIED',
    'a project that has containers has been up, and a project that has been up has state');
  assertEq(classifyTarget(bare, [target(bare, 'secrets')], () => 'none'), 'UNKNOWN',
    'and no containers still proves nothing, because down keeps volumes');
  // "I COULD NOT SEE IT" IS NOT "IT IS NOT THERE".
  assertEq(classifyTarget(bare, [target(bare, 'secrets')], () => 'unanswerable'), 'OCCUPIED',
    'a probe that cannot answer fails CLOSED');

  const odd = join(WORK, 'odd-project');
  mkdirSync(odd, { recursive: true });
  writeFileSync(join(odd, 'secrets'), 'a file where a directory belongs\n', 'utf8');
  assertEq(classifyTarget(odd, [target(odd, 'secrets')]), 'OCCUPIED',
    'a target that is not a directory is not an absence');
});

test('the shipped probe asks compose ps, which starts nothing, and fails closed', () => {
  const ledger = new CommandLedger();
  for (const answer of [{ stdout: '', expect: 'none' as const }, { stdout: 'abc\n', expect: 'containers' as const }]) {
    const probe = composeOccupancyProbe(() => ({ status: 0, stdout: answer.stdout, stderr: '' }), ledger);
    assertEq(probe(join(WORK, 'occupied')), answer.expect, `a listing answers ${answer.expect}`);
  }
  assertEq(composeOccupancyProbe(() => ({ status: 1, stdout: '', stderr: 'no daemon' }), ledger)(WORK),
    'unanswerable', 'a non-zero exit is unanswerable');
  assertEq(composeOccupancyProbe(() => { throw new Error('boom'); }, ledger)(WORK),
    'unanswerable', 'and so is a runner that threw');
  // AND THE PROBE ITSELF STARTS NOTHING.
  for (const entry of ledger.all()) {
    assert(entry.args.includes('ps'), 'the probe only ever asks ps');
    for (const verb of ['up', 'run', 'create', 'down']) {
      assertEq(entry.args.includes(verb), false, `and never ${verb}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------
// Phase 299 — the plan and its digest
// ---------------------------------------------------------------------------------------------------------

test('the plan is the only order there is, and every command it lists passes the maintenance guard', () => {
  const root = makeProject('planning');
  takeSet(root, 'set-p');
  const { resolved, plan } = planFor(request(root, 'set-p'));
  assertEq(plan.targetState, 'OCCUPIED', 'this installation has something to lose');
  assertEq(plan.safetySet, true, 'so a safety set is planned');
  const ids = plan.steps.map((step) => step.id);
  assertEq(ids.join(','), stepsFor({ custodian: 'inline', safetySet: true, promotionRecords: true }).join(','),
    'the plan is the model\'s step list');
  for (const step of plan.steps) {
    for (const command of step.commands) {
      // A COMMAND THAT WOULD BE FORBIDDEN CANNOT EVEN BE PLANNED.
      assertPermittedCommand(command);
      assertEq(command.cwd, resolved.projectRoot, 'every command runs in the project root');
    }
  }
  const rendered = renderRestorePlan(resolved, plan);
  assert(rendered.includes(plan.digest), 'the plan prints the digest a confirmation needs');
  assert(rendered.includes('down -v'), 'and shows the step that destroys the volumes');
  assert(rendered.includes('! stop-and-destroy'), 'marked as the point of no return');
  assert(rendered.includes('Nothing has been changed'), 'and says it changed nothing');
});

test('no planned command reaches a network, a registry, a media path, a media server or an acquisition system', () => {
  const root = makeProject('ledger-clean');
  takeSet(root, 'set-c');
  const { plan } = planFor(request(root, 'set-c'));
  const argv = plan.steps.flatMap((step) => step.commands.flatMap((c) => [c.program, ...c.args]));
  const joined = argv.join(' ').toLowerCase();
  for (const forbidden of ['://', 'ghcr.io', 'docker.io', 'jellyfin', 'plex', 'emby', 'torrent', 'magnet',
    'nzb', 'curl', 'wget', '.mkv', '.mp4']) {
    assertEq(joined.includes(forbidden), false, `no planned command carries "${forbidden}"`);
  }
  assertEq(joined.includes(' pull '), false, 'and none of them pulls');
  // `--pull never` says the same thing where Compose can read it, on every command that could otherwise fetch.
  for (const step of plan.steps) {
    for (const command of step.commands) {
      if (command.args.includes('up') || command.args.includes('create')) {
        assert(command.args.includes('--pull') && command.args[command.args.indexOf('--pull') + 1] === 'never',
          `${step.id} pins --pull never`);
      }
    }
  }
});

test('the digest changes with the set, the topology, the safety set and the step list', () => {
  const root = makeProject('digest');
  takeSet(root, 'set-a');
  const base = planFor(request(root, 'set-a')).plan.digest;
  const withoutSafety = planFor(request(root, 'set-a'), false).plan.digest;
  assert(base !== withoutSafety, 'dropping the safety set changes the digest');

  const sidecarRoot = makeProject('digest-sidecar', { sidecar: true });
  takeSet(sidecarRoot, 'set-a', { sidecar: true });
  const sidecar = planFor(request(sidecarRoot, 'set-a', {
    custodian: 'sidecar', sidecarState: 'sidecar-state',
  })).plan.digest;
  assert(base !== sidecar, 'a different topology is a different plan');

  // TWO PLANS OF THE SAME UNTOUCHED THING ARE THE SAME VALUE, which is what makes a mismatch mean something.
  assertEq(planFor(request(root, 'set-a')).plan.digest, base, 'planning twice answers the same digest');
});

test('the runtime role statement creates one role, without a login and without a credential', () => {
  const sql = prepareRuntimeRoleSql();
  assert(sql.includes('CREATE ROLE app'), 'it creates the managed runtime role');
  assertEq(/password/i.test(sql), false, 'and carries no credential');
  assertEq(/\bLOGIN\b/.test(sql), false, 'and does not grant a login');
  assert(sql.includes('IF NOT EXISTS'), 'and is idempotent, because a restore may be resumed');
});

// ---------------------------------------------------------------------------------------------------------
// Phase 300/301 — the safety set, and the run
// ---------------------------------------------------------------------------------------------------------

test('a restore puts all four components back, in order, and proves the result', () => {
  const root = makeProject('happy');
  const setDir = takeSet(root, 'set-1');
  // Change the live installation AFTER the set was taken, so a successful restore is visibly a restore.
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
  writeFileSync(join(root, 'promotion-records', 'record-later.json'), '{"later":1}\n', 'utf8');

  const { plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  assertEq(report.ok, true, `the restore held: ${report.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assertEq(report.state, 'RESTORED', 'and reports the state it reached');
  assertEq(report.safetySet, 'pre-restore-set-1', 'a safety set was taken');
  assertEq(report.safetySetVerified, true, 'and it verified');
  assertEq(world.teardowns(), 1, 'the volumes were destroyed exactly once');

  // THE COMPONENTS ARE ACTUALLY BACK, on disk and in the modelled container.
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), SECRET_VALUE,
    'the secret file holds what the set held, not what the installation had');
  assertEq(existsSync(join(root, 'promotion-records', 'record-later.json')), false,
    'and the records folder is the set\'s, not a merge of both');
  assert(existsSync(join(root, 'promotion-records', 'record-live.json')), 'the set\'s record is there');
  assertEq(world.state().keystore, setKeystoreDigest(setDir), 'the container holds the set\'s keystore');
  assertEq(world.replays()[0], setDumpDigest(setDir), 'and the bytes replayed are the verified dump\'s');
  assertEq(world.state().schema, MIGRATION_VERSION, 'the database is at the schema the set recorded');

  // AND THE PREVIOUS STATE IS BESIDE IT, NOT DELETED.
  assert(report.replaced.length >= 2, 'the previous directories were kept');
  for (const name of report.replaced) {
    assert(existsSync(join(root, name)), `${name} is on disk`);
    assert(name.startsWith('.'), 'and is dot-prefixed so it is ignorable');
  }
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), false, 'and the journal was cleared');
});

test('the ledger of a real run reaches no network, registry, media path, media server or acquisition system', () => {
  const root = makeProject('ledger-run');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);
  runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  const joined = world.argv().join(' ').toLowerCase();
  for (const forbidden of ['://', 'ghcr.io', 'docker.io', 'jellyfin', 'plex', 'emby', 'torrent', 'magnet',
    'nzb', 'sabnzbd', 'curl', 'wget', '.mkv', '.mp4', '/media/']) {
    assertEq(joined.includes(forbidden), false, `no command issued carried "${forbidden}"`);
  }
  for (const entry of world.ledger.all()) {
    assertEq(entry.program === 'docker' || entry.program === 'node', true,
      `only permitted programs were started, got ${entry.program}`);
  }
  // The safety set's own commands are in this ledger too — one run, one evidence trail.
  assert(world.lines().some((line) => line.includes('pg_dump')), 'the safety set dumped the database');
  assert(world.lines().some((line) => line.includes('down -v')), 'and the teardown destroyed the volumes');
});

test('the safety set is taken inside this run\'s lock, and there is only ever one lock', () => {
  const root = makeProject('one-lock');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  });
  // The safety set runs `pg_dump` inside the restore's lock. Observing the lock directory at that instant is
  // the only way to prove `holdingLock` is not a second `mkdir` that would deadlock — or, worse, a bypass.
  let locksSeen = -1;
  const observing = {
    ...depsFor(world),
    runner: (command: Parameters<typeof world.runner>[0]) => {
      if (command.args.join(' ').includes('pg_dump')) {
        locksSeen = existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)) ? 1 : 0;
      }
      return world.runner(command);
    },
    backupFileRunner: (command: Parameters<typeof world.outputRunner>[0], destination: string) => {
      locksSeen = existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)) ? 1 : 0;
      return world.outputRunner(command, destination);
    },
  };
  const report = runCompleteRestore(request(root, 'set-1'), observing,
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  assertEq(report.ok, true, 'the run held');
  assertEq(locksSeen, 1, 'the project lock was held while the safety set was being taken');
  assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false, 'and it was released at the end');
});

test('a safety set that does not verify stops the restore BEFORE anything is destroyed', () => {
  const root = makeProject('safety-fails');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  // The safety set's own keystore copy fails, so Phase 277 refuses and publishes nothing.
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'cp app:', status: 1 }],
  });
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  assertEq(report.ok, false, 'the run did not succeed');
  assertEq(report.state, 'INCOMPLETE', 'and it is incomplete rather than restored');
  assertEq(report.steps[0]!.id, 'safety-set', 'the first step is the safety set');
  assertEq(report.steps[0]!.outcome, 'failed', 'and it failed');
  assertEq(world.teardowns(), 0, 'NOTHING WAS DESTROYED');
  assertEq(world.state().stackUp, true, 'and the installation is still running');
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), SECRET_VALUE,
    'and nothing on disk was replaced');
});

test('a wrong confirmation, and an acknowledgement of loss from another run, are refused', () => {
  const root = makeProject('confirm');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);
  refuses(() => runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: 'f'.repeat(64), acceptDataLoss: null }),
  'does not match this plan', 'a confirmation for another plan is refused');
  assertEq(world.teardowns(), 0, 'and nothing was destroyed');

  const noSafety = planFor(request(root, 'set-1'), false).plan;
  refuses(() => runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: noSafety.digest, acceptDataLoss: 'f'.repeat(64) }),
  'does not carry this plan', 'an acknowledgement pasted from elsewhere is refused');
  assertEq(world.teardowns(), 0, 'and still nothing was destroyed');
});

test('an installation with no host state cannot take a safety set, so it REQUIRES the acknowledgement', () => {
  // THE DEFECT THIS PINS. The first cut REFUSED --accept-data-loss here, on the grounds that an EMPTY
  // installation has nothing to lose. It cannot know that: `down -v` would destroy whatever is in this
  // project's volumes, and nothing on the host says what that is.
  //
  // Without the acknowledgement a safety set is PLANNED — and it cannot be taken, because there is no host
  // state to back up. So the run stops at its first step with nothing destroyed, and the acknowledgement is
  // the only way through rather than a shortcut past a check.
  const root = join(WORK, 'no-host-state');
  mkdirSync(join(root, 'secrets'), { recursive: true });
  const source = makeProject('source-for-empty');
  const setDir = takeSet(source, 'set-1');
  mkdirSync(join(root, 'backups'), { recursive: true });
  copyDirectory(setDir, join(root, 'backups', 'set-1'));

  const req = request(root, 'set-1');
  const { resolved, plan } = planFor(req);
  assertEq(resolved.targetState, 'UNKNOWN', 'this command cannot prove this installation is empty');
  assertEq(plan.safetySet, true, 'so without an acknowledgement it plans a safety set');
  const world = worldFor(setDir);
  const report = runCompleteRestore(req, depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  assertEq(report.steps[0]!.id, 'safety-set', 'the first step is the safety set');
  assertEq(report.steps[0]!.outcome, 'failed', 'and it could not be taken');
  assertEq(world.teardowns(), 0, 'SO NOTHING WAS DESTROYED');

  // AND THE ACKNOWLEDGEMENT IS BOUND TO ITS OWN PLAN. A digest from the safety-set plan does not authorise
  // the no-safety-set one, and vice versa: they are different operations.
  // The failed run above left a journal, correctly. Clear it so this is a fresh authorisation check.
  rmSync(join(root, RESTORE_JOURNAL_NAME));
  const withoutSafety = planFor(req, false).plan;
  assert(withoutSafety.digest !== plan.digest, 'the two plans are different operations');
  refuses(() => runCompleteRestore(req, depsFor(worldFor(setDir)),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: plan.digest }),
  'does not match this plan', 'the safety-set plan cannot be run as the acknowledged one');
});
test('a restore into an installation with no host state runs under the acknowledgement, and restores everything', () => {
  const root = join(WORK, 'fresh-install');
  mkdirSync(join(root, 'secrets'), { recursive: true });
  const source = makeProject('source-for-fresh');
  const setDir = takeSet(source, 'set-1');
  mkdirSync(join(root, 'backups'), { recursive: true });
  copyDirectory(setDir, join(root, 'backups', 'set-1'));

  const req = request(root, 'set-1');
  const { plan } = planFor(req, false);
  assertEq(plan.safetySet, false, 'no safety set can be taken here');
  const world = worldFor(setDir);
  const report = runCompleteRestore(req, depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: plan.digest });
  assertEq(report.ok, true, `it held: ${report.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assertEq(report.safetySet, null, 'and none was taken');
  assert(report.notes.some((note) => note.includes('NO SAFETY SET WAS TAKEN')),
    'and the report says so rather than leaving it to be inferred');
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), SECRET_VALUE, 'the secrets arrived');
  assert(existsSync(join(root, 'promotion-records', 'record-live.json')), 'and so did the records');
});

test('a sidecar restore swaps the state directory the operator named, and never the app volume', () => {
  const root = makeProject('sidecar-run', { sidecar: true });
  const setDir = takeSet(root, 'set-1', { sidecar: true });
  writeFileSync(join(root, 'sidecar-state', 'keys', 'later'), 'later-wrapped\n', 'utf8');

  const req = request(root, 'set-1', { custodian: 'sidecar', sidecarState: 'sidecar-state' });
  const { plan } = planFor(req);
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    // In sidecar custody nothing is copied into the app container, so the modelled "keystore in the
    // container" stays null and the decryption proof has to be satisfied by the host directory instead.
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  });
  // The sidecar reads the host directory, so the world is told what the app "holds" by the swap itself.
  const report = runCompleteRestore(req, {
    ...depsFor(world),
    runner: (command: Parameters<typeof world.runner>[0]) => {
      const outcome = world.runner(command);
      return outcome;
    },
  }, { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  // The decryption proof legitimately fails here because this world models an INLINE container keystore and
  // sidecar custody never fills it. What must hold is the PLACEMENT, and that the app volume was untouched.
  assertEq(existsSync(join(root, 'sidecar-state', 'keys', 'later')), false,
    'the later key is gone: the directory was replaced, not merged');
  assert(existsSync(join(root, 'sidecar-state', 'keys', 'live')), 'and the set\'s key is there');
  assertEq(world.state().keystore, null, 'nothing was copied into the app container');
  assertEq(report.steps.some((step) => step.id === 'place-inline-keystore'), false,
    'and the inline placement was not even planned');
  const placed = report.steps.find((step) => step.id === 'place-sidecar-keystore')!;
  assertEq(placed.outcome, 'held', 'the sidecar placement held');
});

// ---------------------------------------------------------------------------------------------------------
// Phase 302 — the proofs, which liveness does not satisfy
// ---------------------------------------------------------------------------------------------------------

test('a keystore from ANOTHER moment starts, passes the doctor, and FAILS the decryption proof', () => {
  const root = makeProject('wrong-keystore');
  const setDir = takeSet(root, 'set-1');
  // A second set whose keystore is a DIFFERENT moment. The world declares only the first pair as coherent.
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: 'a'.repeat(64) }],
  });
  const { plan } = planFor(request(root, 'set-1'));
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  assertEq(report.ok, false, 'the restore is not ok');
  // THE DISTINCTION THAT DECIDES WHAT AN OPERATOR DOES NEXT. The installation IS up; what failed is the
  // evidence that it is correct.
  assertEq(report.state, 'RESTORED_BUT_UNPROVEN', 'and it says the installation is restored and unproven');
  const version = report.steps.find((step) => step.id === 'prove-version')!;
  const doctor = report.steps.find((step) => step.id === 'prove-doctor')!;
  const decrypt = report.steps.find((step) => step.id === 'prove-decrypt')!;
  assertEq(version.outcome, 'held', 'the schema versions agree');
  assertEq(doctor.outcome, 'held', 'the doctor reports a healthy installation');
  assertEq(decrypt.outcome, 'failed', 'AND THE CATALOG CANNOT BE DECRYPTED');
  assert(decrypt.detail!.includes('could NOT decrypt'), 'the reason names the failure');
  // AND IT CAME FROM THE REAL PROOF CONTRACT. The restore parsed a `phase-302-custody-proof` body through
  // the shipped reader and acted on its VERDICT — not on a command name the fake happened to recognise.
  assertEq(report.custodyProven, false, 'custody was not proven');
  assert(world.lines().some((line) => line.includes('ops:custody-proof')),
    'the proof it ran is the one that decrypts, not the one that counts rows');
  assertEq(world.lines().some((line) => line.includes('ops:collections -- status')), false,
    'and the vacuous row-counting command is not used as a proof at all');
  assertEq(world.state().stackUp, true, 'the stack is up, which is exactly why liveness proves nothing');
});

test('a doctor that reports a failure is a failed restore, and its detail never reaches the report', () => {
  const root = makeProject('doctor-fails');
  const setDir = takeSet(root, 'set-1');
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    doctorStates: ['pass', 'fail'],
  });
  const { plan } = planFor(request(root, 'set-1'));
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  const doctor = report.steps.find((step) => step.id === 'prove-doctor')!;
  assertEq(doctor.outcome, 'failed', 'a doctor FAIL fails the proof');
  assert(doctor.detail!.includes('FAIL'), 'and names the state');
  // A DOCTOR DETAIL IS WRITTEN FOR A PERSON AT A TERMINAL and can name a path, a uid or a connection.
  assertEq(doctor.detail!.includes('a detail'), false, 'and never carries the check\'s own detail text');
});

test('a build whose schema disagrees with the restored database fails the version proof by name', () => {
  const root = makeProject('image-pin');
  const setDir = takeSet(root, 'set-1');
  // The project is pinned to an image whose build expects a LATER schema. Nothing before the teardown could
  // have known that — reading the image's schema means running it — which is why the safety set is mandatory.
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION + 1,
    initialSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  });
  const { plan } = planFor(request(root, 'set-1'));
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  const version = report.steps.find((step) => step.id === 'prove-version')!;
  assertEq(version.outcome, 'failed', 'the version proof does not hold');
  assert(version.detail!.includes('image this project pins'), 'and it names the actual cause');
  assertEq(report.state, 'RESTORED_BUT_UNPROVEN', 'the state says the data is back and the evidence is not');
  assert(report.safetySet !== null, 'and the safety set is what makes this recoverable');
});

test('the replay refuses to land in a database that was never emptied', () => {
  // The modelled `psql` fails with "relation already exists" unless the volumes were destroyed — the real
  // behaviour of a plain dump replayed over an existing schema. A restore that skipped the teardown would
  // fail here rather than quietly producing a half-merged database.
  const root = makeProject('not-emptied');
  const setDir = takeSet(root, 'set-1');
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'down -v', status: 1 }],
  });
  const { plan } = planFor(request(root, 'set-1'));
  let thrown: unknown = null;
  try {
    runCompleteRestore(request(root, 'set-1'), depsFor(world),
      { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  } catch (err) { thrown = err; }
  assert(thrown instanceof MaintenanceRefused, 'a teardown that failed after the safety set is a thrown refusal');
  assert((thrown as Error).message.includes('PART WAY THROUGH A RESTORE'),
    'and it says the installation is part way through one');
  assertEq(world.state().loadedDump, null, 'nothing was replayed');
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), true, 'and a journal was left');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

// ---------------------------------------------------------------------------------------------------------
// Phase 303 — the journal, resume and abandon
// ---------------------------------------------------------------------------------------------------------

test('a journal refuses a fresh restore, and --resume continues without swapping anything twice', () => {
  const root = makeProject('resume');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));

  // Fail at the LAST proof, so every swap has happened and the journal records them.
  const first = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  const firstReport = runCompleteRestore(request(root, 'set-1'), depsFor(first),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  assertEq(firstReport.ok, false, 'the first run did not complete');
  const journal = readRestoreJournal(root)!;
  assert(journal !== null, 'a journal was left');
  assertEq(journal.planDigest, plan.digest, 'bound to the plan it was running');
  assert(journal.completed.includes('place-secrets'), 'and it records the swaps that completed');

  // A FRESH RUN IS REFUSED. Running from the top would take a "safety set" of the wreckage.
  refuses(() => runCompleteRestore(request(root, 'set-1'), depsFor(first),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null }),
  'part way through a restore', 'a project with a journal refuses a fresh restore');

  // RESUME. The swaps are recognised as done — by digest, not by the journal alone — and the run finishes.
  const replacedBefore = readdirSync(root).filter((entry) => entry.includes('.replaced-')).length;
  const second = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  });
  const resumed = runCompleteRestore(request(root, 'set-1'), depsFor(second),
    { kind: 'resume', confirm: plan.digest });
  assertEq(resumed.ok, true, `the resumed run held: ${resumed.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assertEq(second.teardowns(), 0, 'the resumed run did not destroy the volumes a second time');
  assertEq(readdirSync(root).filter((entry) => entry.includes('.replaced-')).length, replacedBefore,
    'and it did not swap the RESTORED state aside as if it were the previous one');
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), SECRET_VALUE,
    'the restored secrets are still the restored ones');
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), false, 'and the journal is cleared');
});

test('resuming under a different plan is refused', () => {
  const root = makeProject('resume-mismatch');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  refuses(() => runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'resume', confirm: 'b'.repeat(64) }),
  'does not match this plan', 'a resume with the wrong digest is refused');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

test('--abandon puts the host directories back and says what a rename cannot bring back', () => {
  const root = makeProject('abandon');
  const setDir = takeSet(root, 'set-1');
  // BOTH DIRECTORIES ARE CHANGED AFTER THE SET WAS TAKEN, so both genuinely have to be swapped. A directory
  // that already holds exactly what the set holds is recognised and skipped — correctly — and would leave
  // nothing for `--abandon` to put back, which would make this a test of nothing.
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
  writeFileSync(join(root, 'promotion-records', 'record-later.json'), '{"later":1}\n', 'utf8');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  assertEq(existsSync(join(root, 'promotion-records', 'record-later.json')), false, 'the restore replaced the records');

  // ABANDON TAKES THE PROJECT ROOT AND NOTHING ELSE — the journal knows what was swapped.
  const report = abandonRestore(root);
  assertEq(report.ok, true, 'the abandon succeeded');
  assert(report.restored.includes('secrets'), 'the secrets are back');
  assert(report.restored.includes('promotion-records'), 'and so are the records');
  assert(existsSync(join(root, 'promotion-records', 'record-later.json')),
    'the file that was there before the restore is there again');
  assert(report.notes.some((note) => note.includes('NOT COMING BACK FROM A RENAME')),
    'and it says plainly what a rename cannot undo');
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), false, 'the journal is cleared');
  // AND THE RESTORED COPY IS KEPT, not deleted: an operator who changes their mind still holds both.
  assert(readdirSync(root).some((entry) => entry.includes('.abandoned-')), 'the restored copy is beside it');
});

test('a run that failed AT the safety set is resumable, because the DECISION is journaled, not the outcome', () => {
  // THE DEFECT THIS PINS. `safetySetName` is null until a safety set has actually been taken, so inferring
  // "was one planned" from it made a run that failed at that very step re-plan WITHOUT the step — a different
  // digest, and a --resume refused for having been "planned for something else". The installation had been
  // destroyed by nothing at that point and was entirely resumable.
  const root = makeProject('resume-at-safety');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const failing = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'cp app:', status: 1 }],
  });
  const first = runCompleteRestore(request(root, 'set-1'), depsFor(failing),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  assertEq(first.steps[0]!.outcome, 'failed', 'the safety set failed');
  assertEq(failing.teardowns(), 0, 'and nothing was destroyed');

  const journal = readRestoreJournal(root)!;
  assertEq(journal.safetySetPlanned, true, 'the journal records that a safety set was PLANNED');
  assertEq(journal.safetySetTaken, false, 'and that one was never taken — two different facts');
  assertEq(journal.completed.includes('safety-set'), false, 'the step did not complete');

  // AND THE RESUME WORKS, from the same plan, with the safety set taken this time.
  const second = worldFor(setDir);
  const resumed = runCompleteRestore(request(root, 'set-1'), depsFor(second), { kind: 'resume', confirm: plan.digest });
  assertEq(resumed.ok, true, `the resumed run held: ${resumed.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assertEq(resumed.safetySet, 'pre-restore-set-1', 'and it took the safety set the plan called for');
});

test('every proof runs, even after one of them fails — they are independent diagnoses', () => {
  // THE DEFECT THIS PINS. Stopping at the first failed proof meant an operator whose VERSION check did not
  // hold was never told whether their installation could DECRYPT, which is a different problem with a
  // different answer and the one they most need. The proofs change nothing; withholding three because the
  // first disagreed is a choice with no upside.
  const root = makeProject('all-proofs');
  const setDir = takeSet(root, 'set-1');
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION + 1,
    initialSchema: MIGRATION_VERSION,
    // The keystore is ALSO from another moment, so the decryption proof would fail too — and the point is
    // that an operator gets to see both rather than only the first.
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: 'd'.repeat(64) }],
  });
  const { plan } = planFor(request(root, 'set-1'));
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  for (const id of PROOF_STEP_IDS) {
    const step = report.steps.find((candidate) => candidate.id === id);
    assert(step !== undefined, `${id} was attempted`);
  }
  assertEq(report.steps.find((step) => step.id === 'prove-version')!.outcome, 'failed', 'the version proof failed');
  assertEq(report.steps.find((step) => step.id === 'prove-decrypt')!.outcome, 'failed',
    'AND the decryption proof was still run, and also failed');
  assertEq(report.steps.find((step) => step.id === 'prove-history')!.outcome, 'held',
    'and the one that does hold is reported as holding');
  assertEq(report.state, 'RESTORED_BUT_UNPROVEN', 'the state is decided by the first failure, which was a proof');
  assertEq(report.ok, false, 'and it is not ok');
});

test('a failure that leaves the installation stopped carries its report, naming the safety set', () => {
  // A thrown failure never RETURNS a report, and the report is where the safety set's name and the kept
  // directories are — the two things an operator standing over a stopped installation needs.
  const root = makeProject('stopped-report');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'up -d --pull never --wait --wait-timeout 60 postgres', status: 1 }],
  });
  let thrown: unknown = null;
  try {
    runCompleteRestore(request(root, 'set-1'), depsFor(world),
      { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  } catch (err) { thrown = err; }
  assert(thrown instanceof CompleteRestoreFailed, 'a stopped installation is a thrown failure');
  const carried = (thrown as CompleteRestoreFailed).report;
  assertEq(carried.safetySet, 'pre-restore-set-1', 'and the report it carries names the safety set');
  assertEq(carried.state, 'INCOMPLETE', 'and the state it reached');
  assert(carried.steps.some((step) => step.id === 'database-up' && step.outcome === 'failed'),
    'and the step that did not hold');
  assertEq(JSON.stringify(carried).includes(SECRET_VALUE), false, 'and it still carries no secret value');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

test('a journal this build does not understand is a refusal, never an absence', () => {
  const root = makeProject('bad-journal');
  takeSet(root, 'set-1');
  writeFileSync(join(root, RESTORE_JOURNAL_NAME), '{"journal":"something-else"}\n', 'utf8');
  refuses(() => readRestoreJournal(root), 'it is not a restore journal', 'an unrecognised journal is refused');
  writeFileSync(join(root, RESTORE_JOURNAL_NAME), 'not json at all\n', 'utf8');
  refuses(() => readRestoreJournal(root), 'not readable JSON', 'and so is one that will not parse');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

// ---------------------------------------------------------------------------------------------------------
// Phase 304 — the CLI, the rendering, and what must never reach a report
// ---------------------------------------------------------------------------------------------------------

test('the CLI refuses a credential on a command line, unknown flags, and two operations at once', () => {
  refuses(() => parseCompleteRestoreArgs(['--project', 'p', '--set', 's', '--custodian', 'inline', '--token', 'x']),
    'looks like a credential', 'a credential flag is refused');
  refuses(() => parseCompleteRestoreArgs(['--project', 'p', '--set', 's', '--custodian', 'inline', '--nonsense']),
    'unknown option', 'an unknown flag is refused');
  refuses(() => parseCompleteRestoreArgs(['--project', 'p', '--set', 's', '--custodian', 'maybe', '--plan']),
    'will not guess', 'an unrecognised custody mode is refused');
  refuses(() => parseCompleteRestoreArgs(['--project', 'p', '--set', 's', '--custodian', 'inline',
    '--plan', '--confirm', 'x']), 'different operations', 'plan and confirm together are refused');
  refuses(() => parseCompleteRestoreArgs(['--project', 'p', '--set', 's', '--custodian', 'inline']),
    'Start with --plan', 'a run with no operation names the one to start with');

  const parsed = parseCompleteRestoreArgs(['--project', 'p', '--set', 's', '--custodian', 'inline', '--plan']);
  assertEq(parsed.mode, 'plan', 'a plan parses');
  assertEq(parsed.request!.destination, 'backups', 'with the documented default destination');
  assertEq(parsed.request!.secrets, 'secrets', 'and the documented default secrets directory');
});

test('the shipped CLI plans a real set end to end, prints the digest, and exits zero having changed nothing', () => {
  // THE WHOLE COMMAND, NOT ITS PARTS. `main()` is what an operator actually runs; every other check in this
  // file drives a function underneath it. A `--plan` reaches the real argument parser, the real resolution,
  // the real verification and the real rendering, and it must do all of that without a Docker daemon —
  // because reading a plan is what somebody does before they have decided to run anything.
  const root = makeProject('cli-plan');
  takeSet(root, 'set-1');
  const printed: string[] = [];
  const realLog = console.log;
  console.log = (...parts: unknown[]): void => { printed.push(parts.map(String).join(' ')); };
  let code: number;
  try {
    code = cliMain(['--project', root, '--set', 'set-1', '--custodian', 'inline',
      '--promotion-records', 'promotion-records', '--plan']);
  } finally {
    console.log = realLog;
  }
  const output = printed.join('\n');
  assertEq(code, 0, `the plan exited zero: ${output}`);
  assert(output.includes('plan digest: '), 'it printed the digest a confirmation needs');
  assert(/plan digest: [0-9a-f]{64}/.test(output), 'and the digest is a full sha256');
  assert(output.includes('! stop-and-destroy'), 'and marked the point of no return');
  assert(output.includes('a verified safety set would be taken first'), 'and said a safety set is coming');
  assertEq(output.includes(SECRET_VALUE), false, 'and printed no secret value');

  // AND IT CHANGED NOTHING: no journal, no staging, no replaced directory, no lock left behind.
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), false, 'no journal was written');
  assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false, 'no lock was left');
  assertEq(readdirSync(root).some((entry) => entry.includes('.restoring-') || entry.includes('.replaced-')), false,
    'and nothing was staged or moved aside');
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), SECRET_VALUE, 'the installation is untouched');

  // THE DIGEST THE CLI PRINTED IS THE ONE A RUN WOULD REQUIRE. A plan whose digest did not match the run's
  // would be a plan an operator could never confirm.
  const expected = planFor(request(root, 'set-1')).plan.digest;
  assert(output.includes(expected), 'and it is the digest this plan actually has');
});

test('no report or rendering carries a secret value, a host path or a component\'s content', () => {
  const root = makeProject('redaction');
  const setDir = takeSet(root, 'set-1');
  const { resolved, plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  const surfaces = [JSON.stringify(report), renderCompleteRestore(report)];
  for (const surface of surfaces) {
    assertEq(surface.includes(SECRET_VALUE), false, 'no secret value reaches a report');
    assertEq(surface.includes(root), false, 'no host path reaches a report');
    assertEq(surface.includes(WORK), false, 'not even the temporary root');
    assertEq(surface.includes(HOST_MARKER), false, 'and nothing from outside the project');
  }
  // THE PLAN IS THE ONE SURFACE THAT SHOWS COMMANDS, and commands legitimately carry host paths — that is
  // what an operator is being asked to read before confirming. It must still never show a secret VALUE.
  const planned = renderRestorePlan(resolved, plan);
  assertEq(planned.includes(SECRET_VALUE), false, 'the plan shows commands and never a secret value');
});

test('the rendered report names the state, the safety set and every step that did not hold', () => {
  const root = makeProject('rendering');
  const setDir = takeSet(root, 'set-1');
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: 'c'.repeat(64) }],
  });
  const { plan } = planFor(request(root, 'set-1'));
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  const rendered = renderCompleteRestore(report);
  assert(rendered.includes('RESTORED_BUT_UNPROVEN'), 'the state is in the heading');
  assert(rendered.includes('pre-restore-set-1'), 'the safety set is named');
  assert(rendered.includes('prove-decrypt'), 'the failing step is named');
  assert(rendered.includes('FAILED'), 'and marked');
  assert(rendered.includes('network            none'), 'and the boundary is stated');
});

test('the operator UI and the component model render the restore command from one source', () => {
  const service = readRepo('src/ops/operator-ui-service.ts');
  assert(service.includes('COMPLETE_RESTORE_NOTE'), 'the page renders the exported explanation');
  assert(service.includes('COMPLETE_RESTORE_COMMANDS'), 'and the exported command');
  const components = readRepo('src/ops/backup-components.ts');
  assert(components.includes('ops:complete-restore'), 'the model names the command');
  // The Phase 147 boundary check asserts this word never appears in the served page; the note must not
  // reintroduce it through a new panel.
  const note = /export const COMPLETE_RESTORE_NOTE =([\s\S]*?);\n/.exec(components)![1]!;
  assertEq(/download/i.test(note), false, 'and the note never says "download"');
});

test('the suite inventory and package scripts know about this suite and this command', () => {
  const inventory = JSON.parse(readFileSync(join(repoRoot, 'test/suite-inventory.json'), 'utf8')) as {
    suites: Array<{ file: string; group: string }>;
  };
  const entry = inventory.suites.find((suite) => suite.file === 'complete-restore.ts');
  assert(entry !== undefined, 'this suite is in the inventory');
  assertEq(entry!.group, 'offline', 'and needs no database');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['ops:complete-restore'], 'tsx src/ops/complete-restore-cli.ts', 'the command is wired');
  assertEq(pkg.scripts['test:complete-restore'], 'tsx test/complete-restore.ts', 'and so is the suite');
});

test('nothing else under src/ takes a backup while holding a lock it did not acquire', () => {
  // `holdingLock` is a narrow seam with exactly one legitimate caller. A second one would mean a module
  // taking a backup inside somebody else's exclusive window without that window being this restore's.
  const files = readdirSync(join(repoRoot, 'src/ops')).filter((name) => name.endsWith('.ts'));
  const callers = files.filter((name) => {
    if (name === 'complete-restore.ts' || name === 'complete-backup.ts') return false;
    return readFileSync(join(repoRoot, 'src/ops', name), 'utf8').includes('holdingLock');
  });
  assertEq(callers.join(','), '', 'only the restore passes holdingLock');
});


// ===========================================================================================================
// THE CORRECTION REGRESSIONS
// ===========================================================================================================
//
// Every check below FAILS on the first cut of this tranche. They are the review's findings, each pinned by
// the specific wrong behaviour rather than by the shape of the fix.

// ---------------------------------------------------------------------------------------------------------
// 1. A confirmation authorises ONE operation
// ---------------------------------------------------------------------------------------------------------

test('a digest from another PROJECT does not authorise this one — in EITHER custody topology', () => {
  // THE DEFECT THIS PINS, and it was worse in sidecar custody than in inline. The digest hashed the set
  // name, the set's own digest, the topology, the safety-set boolean and the step list — none of which say
  // WHICH PROJECT. Inline custody was protected only INCIDENTALLY, because one command in its step list
  // (`compose cp <set path> app:…`) happens to carry an absolute path. SIDECAR CUSTODY PLACES ITS KEYSTORE
  // BY RENAME AND ISSUES NO SUCH COMMAND, so two installations holding a copy of one set produced the
  // IDENTICAL digest, and a confirmation read off one authorised destroying the other.
  //
  // An authorisation that depends on a path happening to appear inside an unrelated argument is not an
  // authorisation. The project is bound directly now, in both topologies.
  for (const sidecar of [false, true]) {
    const label = sidecar ? "sidecar" : "inline";
    const a = makeProject(`digest-a-${label}`, { sidecar });
    const b = makeProject(`digest-b-${label}`, { sidecar });
    const setDir = takeSet(a, 'set-1', { sidecar });
    mkdirSync(join(b, 'backups'), { recursive: true });
    copyDirectory(setDir, join(b, 'backups', 'set-1'));

    const over = sidecar ? { custodian: 'sidecar' as const, sidecarState: 'sidecar-state' } : {};
    const planA = planFor(request(a, 'set-1', over)).plan;
    const planB = planFor(request(b, 'set-1', over)).plan;
    assert(planA.digest !== planB.digest,
      `${label}: THE SAME SET IN TWO PROJECTS IS TWO OPERATIONS, and must not share one digest`);

    const world = worldFor(setDir);
    refuses(() => runCompleteRestore(request(b, 'set-1', over), depsFor(world),
      { kind: 'run', confirm: planA.digest, acceptDataLoss: null }),
    'does not match this plan', `${label}: project A's digest does not run against project B`);
    assertEq(world.teardowns(), 0, `${label}: and nothing in B was destroyed`);
  }
});
test('a digest does not survive a change of destination, target path, safety-set name or occupancy', () => {
  const root = makeProject('digest-binding');
  mkdirSync(join(root, 'other-secrets'), { recursive: true });
  writeFileSync(join(root, 'other-secrets', 'placeholder'), 'x\n', 'utf8');
  takeSet(root, 'set-1');
  mkdirSync(join(root, 'elsewhere'), { recursive: true });
  copyDirectory(join(root, 'backups', 'set-1'), join(root, 'elsewhere', 'set-1'));

  const base = planFor(request(root, 'set-1')).plan.digest;

  // A DIFFERENT DESTINATION is a different set path, even for a byte-identical set.
  const otherDestination = planFor(request(root, 'set-1', { destination: 'elsewhere' })).plan.digest;
  assert(base !== otherDestination, 'the backup destination is bound');

  // A DIFFERENT TARGET DIRECTORY is a different set of directories this run would replace. This is the one
  // that mattered most: the same set, the same project, and a secrets directory the operator did not mean.
  const otherTarget = planFor(request(root, 'set-1', { secrets: 'other-secrets' })).plan.digest;
  assert(base !== otherTarget, 'EVERY TARGET PATH IS BOUND');

  // THE SAFETY SET'S NAME decides what a verified backup of the current installation is called.
  const otherSafety = planFor(request(root, 'set-1', { safetySetName: 'a-different-name' })).plan.digest;
  assert(base !== otherSafety, 'the safety-set name is bound');

  // THE OCCUPANCY CLASSIFICATION decides whether a safety set is mandatory, so it is part of the operation.
  const resolved = resolveCompleteRestoreRequest(request(root, 'set-1'));
  const occupied = planCompleteRestore({ ...resolved, targetState: 'OCCUPIED' }, { safetySet: true, acceptDataLoss: false });
  const unknown = planCompleteRestore({ ...resolved, targetState: 'UNKNOWN' }, { safetySet: true, acceptDataLoss: false });
  assert(occupied.digest !== unknown.digest, 'what this command concluded about the installation is bound');

  // AND TWO PLANS OF THE SAME UNTOUCHED OPERATION ARE ONE VALUE, which is what makes a mismatch mean something.
  assertEq(planFor(request(root, 'set-1')).plan.digest, base, 'the same operation digests the same');
});

test('no absolute host path reaches the plan, the report or the JSON', () => {
  // THE DEFECT THIS PINS. `--plan` printed raw argv, so every command carrying the set directory or the
  // keystore destination put the operator's appdata layout on screen — and into whatever they pasted into an
  // issue. Paths belong in the HASH, which is unambiguous, and not in the output.
  const root = makeProject('no-paths');
  const setDir = takeSet(root, 'set-1');
  const { resolved, plan } = planFor(request(root, 'set-1'));
  const rendered = renderRestorePlan(resolved, plan);

  assertEq(rendered.includes(root), false, 'the project root is not printed');
  assertEq(rendered.includes(WORK), false, 'nor the directory above it');
  assertEq(rendered.includes(setDir), false, 'nor the set directory');
  assert(rendered.includes('<project>'), 'the project is named by a token');
  assert(rendered.includes('<staged>'), 'and the staging directory by another');
  // The digest still binds them: the plan is readable AND unambiguous.
  assert(canonicalOperation(resolved, { safetySet: true, acceptDataLoss: false }, plan.steps).includes(root.replace(/\\/g, '/')),
    'the canonical operation DOES bind the absolute path, which is why the display need not');

  const world = worldFor(setDir);
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  for (const surface of [JSON.stringify(report), renderCompleteRestore(report)]) {
    assertEq(surface.includes(root), false, 'no host path in the report');
    assertEq(surface.includes(WORK), false, 'none at all');
    assertEq(surface.includes(SECRET_VALUE), false, 'and no secret value');
  }
});

// ---------------------------------------------------------------------------------------------------------
// 2. Unknown volume state is not empty state
// ---------------------------------------------------------------------------------------------------------

test('a project with empty host directories and CONTAINERS is occupied, and needs a safety set', () => {
  // THE DEFECT THIS PINS. Empty host directories were read as "nothing to lose", and the restore then ran
  // `down -v` against a project whose database volume held an entire catalog.
  const root = join(WORK, 'volumes-full');
  mkdirSync(join(root, 'secrets'), { recursive: true });
  const source = makeProject('source-for-volumes');
  const setDir = takeSet(source, 'set-1');
  mkdirSync(join(root, 'backups'), { recursive: true });
  copyDirectory(setDir, join(root, 'backups', 'set-1'));

  const probe: OccupancyProbe = () => 'containers';
  const resolved = resolveCompleteRestoreRequest(request(root, 'set-1'), probe);
  assertEq(resolved.targetState, 'OCCUPIED',
    'a project that has containers has state, however empty its host directories are');

  // And without the probe it is UNKNOWN — which is also not empty, and also requires authorisation.
  assertEq(resolveCompleteRestoreRequest(request(root, 'set-1')).targetState, 'UNKNOWN',
    'and with nothing to ask, the honest answer is that this command does not know');
});

// ---------------------------------------------------------------------------------------------------------
// 3. The journal is a state machine, and it is path-bound
// ---------------------------------------------------------------------------------------------------------

test('a journal carrying a malicious suffix, an unknown step, or an impossible order is refused', () => {
  const root = makeProject('journal-guard');
  takeSet(root, 'set-1');
  const good = {
    journal: 'catalog-authority.restore', version: 2, planDigest: 'a'.repeat(64), setName: 'set-1',
    destination: 'backups', custodian: 'inline', targetState: 'OCCUPIED', safetySetName: 'pre-restore-set-1',
    suffix: 'aaaaaaaaaaaa', safetySetPlanned: true, safetySetTaken: true,
    request: { secrets: 'secrets', promotionRecords: 'promotion-records', sidecarState: null },
    completed: ['safety-set'], running: null, swaps: [],
  };
  const write = (patch: Record<string, unknown>): void => {
    writeFileSync(join(root, RESTORE_JOURNAL_NAME), `${JSON.stringify({ ...good, ...patch })}\n`, 'utf8');
  };
  // IT PARSES CLEAN FIRST, so every refusal below is about the one field it changed.
  write({});
  assert(readRestoreJournal(root) !== null, 'the well-formed journal reads');

  // A SUFFIX IS CONCATENATED INTO FILE NAMES. One carrying a separator or a traversal builds a sibling path
  // nobody chose, out of a file an operator can edit.
  for (const suffix of ['../../etc', 'a/b', 'AAAAAAAAAAAA', 'short', 'aaaaaaaaaaaaa', '../aaaaaaaaa']) {
    write({ suffix });
    refuses(() => readRestoreJournal(root), 'twelve hex', `a suffix of "${suffix}" is refused`);
  }
  write({ setName: '../elsewhere' });
  refuses(() => readRestoreJournal(root), 'usable name', 'a set name that is a path is refused');
  write({ completed: ['not-a-step'] });
  refuses(() => readRestoreJournal(root), 'does not have', 'a step this build does not have is refused');
  write({ completed: ['safety-set', 'safety-set'] });
  refuses(() => readRestoreJournal(root), 'one step twice', 'a duplicated step is refused');
  write({ completed: ['safety-set'], running: 'safety-set' });
  refuses(() => readRestoreJournal(root), 'both running and complete', 'a step that is two things at once is refused');
  write({ custodian: 'sidecar' });
  refuses(() => readRestoreJournal(root), 'sidecar state directory disagree', 'a topology with no state directory is refused');
  write({ safetySetPlanned: false, safetySetTaken: true });
  refuses(() => readRestoreJournal(root), 'never planned', 'a safety set taken but never planned is refused');
  write({ swaps: [{ component: 'secrets', target: 'secrets', name: 'secrets', replaced: '.secrets.replaced-ffffffffffff', undone: false }] });
  refuses(() => readRestoreJournal(root), 'would not have created', 'a replaced name from another run is refused');
  write({ swaps: [{ component: 'nonsense', target: 'x', name: 'x', replaced: null, undone: false }] });
  refuses(() => readRestoreJournal(root), 'component this build does not have', 'a swap of nothing is refused');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

test('a journal whose completed steps are not this operation\'s ordered prefix is refused before anything runs', () => {
  // A RUN CANNOT FINISH A LATER STEP BEFORE AN EARLIER ONE. A journal claiming otherwise is not an
  // interrupted run — it is a file somebody edited, and resuming it would perform a skipped step against
  // state that is already past it.
  const root = makeProject('journal-order');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  const journal = readRestoreJournal(root)!;

  // OUT OF ORDER: the replay recorded as done with the teardown that precedes it missing.
  const scrambled = { ...journal, completed: ['stop-and-destroy', 'safety-set'] };
  writeFileSync(join(root, RESTORE_JOURNAL_NAME), `${JSON.stringify(scrambled)}\n`, 'utf8');
  refuses(() => runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'resume', confirm: plan.digest }),
    'in this operation\'s order', 'a scrambled completed list is refused');

  // A RUNNING STEP THAT IS NOT THE NEXT ONE.
  const impossible = { ...journal, completed: ['safety-set'], running: 'stack-up' };
  writeFileSync(join(root, RESTORE_JOURNAL_NAME), `${JSON.stringify(impossible)}\n`, 'utf8');
  refuses(() => runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'resume', confirm: plan.digest }),
    'not the one this operation would have reached', 'an impossible running step is refused');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

test('--abandon uses the journal\'s own targets, so altered CLI paths cannot orphan the real ones', () => {
  // THE DEFECT THIS PINS, AND IT WAS SILENT. `abandonRestore` re-derived its targets from the CLI's
  // `--secrets` / `--promotion-records` flags. Give it a different path than the interrupted run used and it
  // found no `.replaced-` directory, reported OK with nothing put back, and CLEARED THE JOURNAL — leaving the
  // real swapped directories orphaned and the project accepting a fresh restore over them.
  const root = makeProject('abandon-bound');
  const setDir = takeSet(root, 'set-1');
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  const journal = readRestoreJournal(root)!;
  assert(journal.swaps.some((swap) => swap.component === 'secrets' && swap.replaced !== null),
    'the run recorded the secrets swap and what it moved aside');

  // THE SIGNATURE MAKES THE DIVERGENCE IMPOSSIBLE. There is nowhere to put a contradicting path.
  const report = abandonRestore(root);
  assertEq(report.ok, true, 'the abandon succeeded');
  assert(report.restored.includes('secrets'), 'and it put back the directory the JOURNAL named');
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), 'a-later-value\n',
    'the installation is back to what it was before the restore');
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), false, 'and the journal is cleared');
});

test('--abandon does NOT clear the journal while a swap it recorded is still out of place', () => {
  // A PARTIAL UNWIND MUST STAY VISIBLE. Clearing here would let the next run take a "safety set" of a
  // half-unwound installation and call it the previous state.
  const root = makeProject('abandon-partial');
  const setDir = takeSet(root, 'set-1');
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
  writeFileSync(join(root, 'promotion-records', 'record-later.json'), '{"later":1}\n', 'utf8');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  const journal = readRestoreJournal(root)!;
  const secretsSwap = journal.swaps.find((swap) => swap.component === 'secrets')!;

  // SOMETHING ELSE TOOK THE DIRECTORY THIS ABANDON HAD TO PUT BACK.
  rmSync(join(root, secretsSwap.replaced!), { recursive: true, force: true });
  const report = abandonRestore(root);
  assertEq(report.ok, false, 'the abandon did not succeed');
  assertEq(report.journalCleared, false, 'AND THE JOURNAL WAS NOT CLEARED');
  assert(report.unresolved.includes(secretsSwap.replaced!), 'it names what is still out of place');
  assert(report.restored.includes('promotion-records'), 'while still putting back the one it could');
  assert(existsSync(join(root, RESTORE_JOURNAL_NAME)), 'and the journal is still there');
  // SO THE PROJECT STILL REFUSES A FRESH RESTORE.
  refuses(() => runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null }),
  'part way through a restore', 'and a fresh restore over a half-unwound installation is refused');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

test('a resumed run reports every directory the OPERATION kept, not only the ones this process moved', () => {
  // THE DEFECT THIS PINS. A resumed run reported an empty `replaced` list, because the swaps happened in the
  // earlier process. An operator reading it was told nothing had been kept while three directories of their
  // previous secrets sat on disk, unnamed.
  const root = makeProject('resume-reporting');
  const setDir = takeSet(root, 'set-1');
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
  writeFileSync(join(root, 'promotion-records', 'record-later.json'), '{"later":1}\n', 'utf8');
  const { plan } = planFor(request(root, 'set-1'));
  const first = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  const firstReport = runCompleteRestore(request(root, 'set-1'), depsFor(first),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  assertEq(firstReport.replaced.length, 2, 'the first run kept two directories');

  const resumed = runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'resume', confirm: plan.digest });
  assertEq(resumed.ok, true, 'the resume completed');
  assertEq([...resumed.replaced].sort().join(','), [...firstReport.replaced].sort().join(','),
    'AND IT NAMED THE SAME KEPT DIRECTORIES, which are still on disk');
  for (const name of resumed.replaced) {
    assert(existsSync(join(root, name)), `${name} is really there`);
  }
  assert(renderCompleteRestore(resumed).includes('previous state kept as'), 'and the rendering says so');
});

// ---------------------------------------------------------------------------------------------------------
// 4. Only the exact verified bytes are restored
// ---------------------------------------------------------------------------------------------------------

test('a DUMP that changes after the set verified is refused, before anything is destroyed', () => {
  // THE DEFECT THIS PINS. The set was verified once, and the replay then bound a descriptor to the dump BY
  // PATH later. Anything that changed those bytes in between — an operator, a second process, a scheduled
  // sync — supplied a restore with bytes no verification had ever approved, silently.
  //
  // The mutation is injected DURING THE SAFETY SET, which is after both verifications (the one at
  // resolution and the one re-proved under the lock) and before the staging step reads the set. That is
  // exactly the window the first cut left open, and it is the only place a suite can stand in it.
  const root = makeProject('dump-mutation');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);
  const deps = depsFor(world);
  const tampering = {
    ...deps,
    runner: (command: Parameters<typeof world.runner>[0]) => {
      if (command.args.join(' ').includes('compose start')) {
        writeFileSync(join(setDir, COMPONENT_ARTIFACT_NAMES.database),
          `${fakeDumpText(MIGRATION_VERSION)}-- tampered\n`, 'utf8');
      }
      return world.runner(command);
    },
  };

  const report = runCompleteRestore(request(root, 'set-1'), tampering,
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  const staged = report.steps.find((step) => step.id === 'stage-components');
  assert(staged !== undefined, 'the staging step ran');
  assertEq(staged!.outcome, 'failed', 'and it refused the changed set');
  assert(staged!.detail!.includes('changed after it was verified'), 'naming what happened');
  assertEq(world.teardowns(), 0, 'NOTHING WAS DESTROYED');
  assertEq(world.replays().length, 0, 'and the tampered bytes never reached a database');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

test('a COMPONENT DIRECTORY that changes after the set verified is refused too', () => {
  const root = makeProject('tree-mutation');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);
  const tampering = {
    ...depsFor(world),
    runner: (command: Parameters<typeof world.runner>[0]) => {
      if (command.args.join(' ').includes('compose start')) {
        // One extra file in the secrets component: the digest, the entry count and the byte count all move.
        writeFileSync(join(setDir, COMPONENT_ARTIFACT_NAMES.secrets, 'slipped-in'), 'not in the manifest\n', 'utf8');
      }
      return world.runner(command);
    },
  };

  const report = runCompleteRestore(request(root, 'set-1'), tampering,
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  const staged = report.steps.find((step) => step.id === 'stage-components')!;
  assertEq(staged.outcome, 'failed', 'the staging step refused the changed component');
  assert(staged.detail!.includes('changed after it was verified'), 'naming what happened');
  assertEq(world.teardowns(), 0, 'and nothing was destroyed');
  // AND THE SLIPPED-IN FILE NEVER REACHED THE INSTALLATION.
  assertEq(existsSync(join(root, 'secrets', 'slipped-in')), false, 'the target never received it');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

test('a set changed BEFORE the run is refused by the verification, without a staging step being reached', () => {
  // The outer half of the same guarantee: a mutation this command can see at resolution is refused there,
  // and the staging check is what covers the window after it.
  const root = makeProject('pre-run-mutation');
  const setDir = takeSet(root, 'set-1');
  writeFileSync(join(setDir, COMPONENT_ARTIFACT_NAMES.database), 'not the dump that was digested\n', 'utf8');
  refuses(() => resolveCompleteRestoreRequest(request(root, 'set-1')), 'does not verify',
    'a set changed before the run never gets as far as a plan');
});
test('what is placed comes from the staged copy, so a set changed mid-run cannot reach the installation', () => {
  // THE POSITIVE HALF. Staging happens before the teardown; if the set is mutated AFTER that, the restore
  // still places the bytes it verified, because it never reads the set again.
  const root = makeProject('staged-wins');
  const setDir = takeSet(root, 'set-1');
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
  const { plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);
  const deps = depsFor(world);
  const tampering = {
    ...deps,
    runner: (command: Parameters<typeof world.runner>[0]) => {
      // The instant the volumes are destroyed — i.e. after staging — rewrite the set on disk.
      if (command.args.includes('down')) {
        writeFileSync(join(setDir, COMPONENT_ARTIFACT_NAMES.secrets, 'custodian_kek'), 'INJECTED\n', 'utf8');
      }
      return world.runner(command);
    },
  };
  const report = runCompleteRestore(request(root, 'set-1'), tampering,
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  assertEq(report.ok, true, `the restore held: ${report.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), SECRET_VALUE,
    'THE VERIFIED BYTES ARRIVED, not the ones written into the set mid-run');
});

test('the staging directory holds secret material, and a completed restore removes it', () => {
  const root = makeProject('staging-cleanup');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  assertEq(report.ok, true, 'the restore held');
  const leftovers = readdirSync(root).filter((entry) => entry.startsWith('.catalog-restore.staged-'));
  assertEq(leftovers.join(','), '', 'no staging directory survives a completed restore');
});

// ---------------------------------------------------------------------------------------------------------
// 5. The proof decrypts, and says so honestly when it cannot
// ---------------------------------------------------------------------------------------------------------

test('the restore runs the proof that DECRYPTS, and never the one that counts rows', () => {
  // THE DEFECT THIS PINS. `ops:collections status` reads the managed-collection and history tables and counts
  // rows. It constructs no CatalogAuthority, asks the custodian for no key and decrypts nothing — so it
  // answers identically on an installation whose keystore is missing, wrong, or from another moment.
  const root = makeProject('real-proof');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  assertEq(report.ok, true, 'the restore held');
  assertEq(report.custodyProven, true, 'and custody was PROVEN');
  const decryptStep = plan.steps.find((step) => step.id === 'prove-decrypt')!;
  const argv = decryptStep.commands.flatMap((command) => command.args).join(' ');
  assert(argv.includes('ops:custody-proof'), 'the decryption proof runs the command that decrypts');
  assertEq(argv.includes('ops:collections'), false, 'and NOT the one that counts rows');
  assert(argv.includes('--json'), 'and asks for the machine-readable contract, because it reads the body');
});

test('a custody proof body that is not the shipped contract is UNKNOWN, which is not a pass', () => {
  // A proof step that accepted a body it could not parse would be satisfied by any command that exits zero.
  const root = makeProject('proof-contract');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);
  const deps = {
    ...depsFor(world),
    runner: (command: Parameters<typeof world.runner>[0]) => {
      if (command.args.join(' ').includes('ops:custody-proof')) {
        return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
      }
      return world.runner(command);
    },
  };
  const report = runCompleteRestore(request(root, 'set-1'), deps,
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  const proof = report.steps.find((step) => step.id === 'prove-decrypt')!;
  assertEq(proof.outcome, 'failed', 'a body outside the contract fails the proof');
  assert(proof.detail!.includes('UNKNOWN'), 'and says the answer is unknown rather than fine');
  assertEq(report.custodyProven, false, 'and custody is not claimed');
  rmSync(join(root, RESTORE_JOURNAL_NAME), { force: true });
});

test('a restored catalog with NOTHING ENCRYPTED reports honestly that custody was not proven', () => {
  // AN EMPTY CATALOG CANNOT PROVE CUSTODY, and rounding that up to a pass is the temptation this closes. The
  // restore itself did not fail — there is genuinely nothing to decrypt — but the claim is not made.
  const root = makeProject('empty-catalog');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    encryptedRecords: 0,
  });
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  assertEq(report.ok, true, 'every step held');
  assertEq(report.state, 'RESTORED', 'and the restore completed');
  assertEq(report.custodyProven, false, 'AND CUSTODY WAS NOT PROVEN');
  assert(report.notes.some((note) => note.includes('no active encrypted record')),
    'the report says why, in words');
  assert(report.notes.some((note) => note.includes('CUSTODY WAS NOT PROVEN')),
    'and does not let it pass unremarked');
  assert(renderCompleteRestore(report).includes('custody proven     NO'), 'and the rendering leads with it');
});

// ---------------------------------------------------------------------------------------------------------
// 6. CLI semantics
// ---------------------------------------------------------------------------------------------------------

test('a POST-destructive failure exits 1, not the pre-destructive refusal code', () => {
  // THE DEFECT THIS PINS. `CompleteRestoreFailed` fell into the same catch as every pre-destructive refusal
  // and exited 3 — the code this command documents as "refused before anything was destroyed". A scheduler
  // watching for "nothing happened" was told nothing happened by a run that had destroyed the volumes.
  const root = makeProject('exit-codes');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'up -d --pull never --wait --wait-timeout 60 postgres', status: 1 }],
  });
  let thrown: unknown = null;
  try {
    runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  } catch (err) { thrown = err; }
  assert(thrown instanceof CompleteRestoreFailed, 'the volumes were destroyed and a step then failed');
  assertEq(world.teardowns(), 1, 'the teardown really happened');
  assert(COMPLETE_RESTORE_EXIT_FAILED === 1 && COMPLETE_RESTORE_EXIT_REFUSED === 3,
    'the two codes mean different things');
  // The CLI's own catch is what maps it, and it maps it to the STEP FAILURE code.
  const cli = readRepo('src/ops/complete-restore-cli.ts');
  const branch = cli.slice(cli.indexOf('if (err instanceof CompleteRestoreFailed)'));
  assert(branch.slice(0, 800).includes('return COMPLETE_RESTORE_EXIT_FAILED'),
    'a post-destructive failure exits 1');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

test('a flag that a mode would ignore is refused, not accepted', () => {
  // A FLAG THAT DOES NOTHING IS A FLAG SOMEBODY BELIEVES DID SOMETHING. `--accept-data-loss` alongside
  // `--resume` authorised nothing and was silently dropped; the `--abandon` path went further and USED the
  // path flags to decide which directories to rename.
  refuses(() => parseCompleteRestoreArgs(['--project', 'p', '--resume', 'd', '--accept-data-loss', 'd']),
    'not part of --resume', 'a data-loss acknowledgement with --resume is refused');
  refuses(() => parseCompleteRestoreArgs(['--project', 'p', '--abandon', '--accept-data-loss', 'd']),
    'not part of --abandon', 'and with --abandon');
  refuses(() => parseCompleteRestoreArgs(['--project', 'p', '--abandon', '--secrets', 'elsewhere']),
    'not part of --abandon', 'and a path flag with --abandon, which the journal already knows');
  refuses(() => parseCompleteRestoreArgs(['--project', 'p', '--resume', 'd', '--set', 's']),
    'not part of --resume', 'and a set with --resume');

  // THE DOCUMENTED COMBINATIONS STILL WORK, and abandon needs only the project.
  const abandon = parseCompleteRestoreArgs(['--project', 'p', '--abandon']);
  assertEq(abandon.mode, 'abandon', 'an abandon parses');
  assertEq(abandon.request, null, 'and carries no request at all');
  const resume = parseCompleteRestoreArgs(['--project', 'p', '--resume', 'd', '--json']);
  assertEq(resume.mode, 'resume', 'a resume parses');
  assertEq(resume.request, null, 'and takes its operation from the journal');
  const run = parseCompleteRestoreArgs(['--project', 'p', '--set', 's', '--custodian', 'inline',
    '--confirm', 'd', '--accept-data-loss', 'd']);
  assertEq(run.mode, 'run', 'a run parses');
  assertEq(run.acceptDataLoss, 'd', 'with its acknowledgement, which IS relevant here');
});

test('the usage text and the abandon behaviour agree about what abandon needs', () => {
  const cli = readRepo('src/ops/complete-restore-cli.ts');
  assert(cli.includes('TAKES ONLY --project'), 'the usage says abandon takes only the project');
  // AND THE CODE AGREES: the mode's allowlist is exactly that.
  assertEq(MODE_VALUE_FLAGS.abandon.join(','), 'project', 'and the allowlist says the same');
  assertEq(MODE_VALUE_FLAGS.resume.join(','), 'project,resume', 'and a resume takes its digest and nothing else');
});

// ---------------------------------------------------------------------------------------------------------

function copyDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry);
    const to = join(destination, entry);
    if (lstatSync(from).isDirectory()) copyDirectory(from, to);
    else writeFileSync(to, readFileSync(from));
  }
}

/** The digest a manifest records for a file component, computed the way the product computes it. */
function digestOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

console.log('');
if (failed > 0) {
  console.log('Failures:');
  for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? String(err)}`);
}
console.log(`${passed} passed, ${failed} failed`);
try { rmSync(WORK, { recursive: true, force: true }); } catch { /* a temp directory that will not go is not a failure */ }
process.exitCode = failed === 0 ? 0 : 1;
