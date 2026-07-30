import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_VERSION } from '../src/db/schema-version.js';
import { REQUIRED_SECRET_FILES, COMPONENT_ARTIFACT_NAMES } from '../src/ops/backup-components.js';
import { verifyBackupSet } from '../src/ops/backup-set-verification.js';
import {
  digestTreeAt,
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
  RESTORE_JOURNAL_VERSION,
  operationSuffix,
  safetySetClaimDirName,
  SAFETY_CLAIM_NONCE_RE,
  abandonRestore,
  canonicalOperation,
  classifyTarget,
  composeOccupancyProbe,
  pathsOverlap,
  HOST_PATHS_ARE_CASE_INSENSITIVE,
  planCompleteRestore,
  prepareRuntimeRoleSql,
  readRestoreJournal,
  readStagingMarker,
  removeOwnedStaging,
  stageComponents,
  verifyOwnedStaging,
  writeRestoreJournal,
  renderCompleteRestore,
  renderRestorePlan,
  resolveCompleteRestoreRequest,
  runCompleteRestore,
  type CompleteRestoreReport,
  type RestoreJournal,
  type CompleteRestoreRequest,
  type OccupancyProbe,
} from '../src/ops/complete-restore.js';
import {
  DESTRUCTIVE_STEP_IDS,
  PROOF_STEP_IDS,
  RESTORE_STEP_IDS,
  STEP_RECOVERY,
  STEP_REWIND_TO,
  RESTORE_SUFFIX_RE,
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
import { CRASH_EXIT_CODE } from './helpers/restore-crash-child.mjs';

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
/** The name a safety set is published under for the suite's injected suffix. Derived, never chosen. */
/** Where this run actually published its safety set, read from the journal it wrote. Never predicted. */
function publishedSafetySet(root: string): string {
  const journal = readRestoreJournal(root);
  assert(journal !== null && journal.safetySetClaim !== null, 'the run recorded a claim');
  return `${safetySetClaimDirName(journal!.safetySetClaim!.nonce)}/pre-restore-set-1`;
}
/** The claim directory of a run, from its journal. */
function claimDir(root: string): string {
  const journal = readRestoreJournal(root);
  assert(journal !== null && journal.safetySetClaim !== null, 'the run recorded a claim');
  return safetySetClaimDirName(journal!.safetySetClaim!.nonce);
}
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
  assert(report.safetySet !== null && report.safetySet.startsWith('.pre-restore-claim-'),
    'a safety set was taken, inside a directory this run claimed for itself');
  assert(existsSync(join(root, 'backups', report.safetySet!)), 'and it is really there');
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
  assertEq(journal.steps.find((step) => step.id === 'place-secrets')!.state, 'complete',
    'and it records the swaps that completed');

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
  assertEq(journal.steps.find((step) => step.id === 'safety-set')!.state, 'failed', 'the step did not complete');

  // AND THE RESUME WORKS, from the same plan, with the safety set taken this time.
  const second = worldFor(setDir);
  const resumed = runCompleteRestore(request(root, 'set-1'), depsFor(second), { kind: 'resume', confirm: plan.digest });
  assertEq(resumed.ok, true, `the resumed run held: ${resumed.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assert(resumed.safetySet !== null && resumed.safetySet.startsWith('.pre-restore-claim-'),
    'and it took a safety set inside a directory it claimed for itself');
  assert(existsSync(join(root, 'backups', resumed.safetySet!)), 'which is really on disk');
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
  assert(carried.safetySet !== null && carried.safetySet.startsWith('.pre-restore-claim-'),
    'and the report it carries names the safety set');
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
    journal: 'catalog-authority.restore', version: RESTORE_JOURNAL_VERSION, planDigest: 'a'.repeat(64),
    setName: 'set-1',
    destination: 'backups', custodian: 'inline', targetState: 'OCCUPIED', safetySetName: 'pre-restore-set-1',
    suffix: 'aaaaaaaaaaaa', phase: 'restoring', safetySetClaim: { nonce: 'a'.repeat(24), created: true },
    safetySetPlanned: true, safetySetTaken: true,
    request: { secrets: 'secrets', promotionRecords: 'promotion-records', sidecarState: null },
    steps: [{ id: 'safety-set', state: 'complete', detail: null }], swaps: [],
    evidence: { custodyProven: false, safetySetTaken: true, safetySetVerified: true },
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
  write({ steps: [{ id: 'not-a-step', state: 'complete', detail: null }] });
  refuses(() => readRestoreJournal(root), 'does not have', 'a step this build does not have is refused');
  write({ steps: [{ id: 'safety-set', state: 'complete', detail: null }, { id: 'safety-set', state: 'pending', detail: null }] });
  refuses(() => readRestoreJournal(root), 'one step twice', 'a duplicated step is refused');
  // ONE PROCESS, ONE STEP. A crash leaves exactly the step it was inside; two is a file somebody edited.
  write({ steps: [{ id: 'safety-set', state: 'running', detail: null }, { id: 'stage-components', state: 'running', detail: null }] });
  refuses(() => readRestoreJournal(root), 'more than one step as running', 'two running steps is refused');
  write({ steps: [{ id: 'safety-set', state: 'sideways', detail: null }] });
  refuses(() => readRestoreJournal(root), 'state this build does not have', 'an unknown step state is refused');
  // A FAILURE WITHOUT A REASON IS A FAILURE NOBODY CAN ACT ON, and a success with one records two things.
  write({ steps: [{ id: 'safety-set', state: 'failed', detail: null }] });
  refuses(() => readRestoreJournal(root), 'records no reason', 'a failure with no reason is refused');
  write({ steps: [{ id: 'safety-set', state: 'complete', detail: 'why' }] });
  refuses(() => readRestoreJournal(root), 'carries a reason', 'a non-failure carrying a reason is refused');
  write({ steps: [] });
  refuses(() => readRestoreJournal(root), 'records no steps', 'an empty step list is refused');
  // THE EVIDENCE IS ACTED ON, so it is validated like everything else that is.
  write({ evidence: { custodyProven: false, safetySetTaken: false, safetySetVerified: true } });
  refuses(() => readRestoreJournal(root), 'verified that was never taken', 'impossible evidence is refused');
  write({ evidence: { custodyProven: 'yes', safetySetTaken: false, safetySetVerified: false } });
  refuses(() => readRestoreJournal(root), 'not a boolean', 'evidence that is not a boolean is refused');
  write({ safetySetPlanned: false, evidence: { custodyProven: false, safetySetTaken: true, safetySetVerified: false } });
  refuses(() => readRestoreJournal(root), 'never planned', 'evidence of an unplanned safety set is refused');
  write({ phase: 'sideways' });
  refuses(() => readRestoreJournal(root), 'phase is not one this build has', 'an unknown direction is refused');
  write({ safetySetClaim: { nonce: '../elsewhere', created: true } });
  refuses(() => readRestoreJournal(root), 'nonce is not the twenty-four hex', 'a claim nonce that is a path is refused');
  write({ safetySetClaim: { nonce: 'a'.repeat(24), created: 'yes' } });
  refuses(() => readRestoreJournal(root), 'does not say whether it was created', 'a claim with no creation fact is refused');
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

test('a journal in a state no run of this operation could have produced is refused before anything runs', () => {
  // A LIST OF COMPLETED STEPS COULD NOT EXPRESS AN INDEPENDENT PROOF FAILURE, and a per-step model can
  // express states a real run never reaches. So the legality rules are the shape of the executor, written
  // down: non-proof steps are complete* then at most one running/failed then pending*; the proofs stay
  // pending until every step before them is complete; and the proofs themselves are (complete|failed)* then
  // at most one running then pending*.
  const root = makeProject('journal-legality');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  const journal = readRestoreJournal(root)!;

  const put = (steps: unknown): void => {
    writeFileSync(join(root, RESTORE_JOURNAL_NAME), `${JSON.stringify({ ...journal, steps })}\n`, 'utf8');
  };
  const at = (id: string, state: string, detail: string | null = null) => ({ id, state, detail });
  const ids = plan.steps.map((step) => step.id);
  const allBut = (overrides: Record<string, [string, string | null]>) => ids.map((id) => {
    const over = overrides[id];
    return over === undefined ? at(id, 'complete') : at(id, over[0], over[1]);
  });

  // A LATER NON-PROOF STEP DONE BEFORE AN EARLIER ONE. A run cannot do that.
  put(allBut({ 'stop-and-destroy': ['pending', null] }));
  refuses(() => runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'resume', confirm: plan.digest }),
    'no run of this operation could have produced', 'a gap before a completed later step is refused');

  // A PROOF REACHED BEFORE THE STEPS BEFORE IT COMPLETED.
  put(allBut({ 'stack-up': ['pending', null] }));
  refuses(() => runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'resume', confirm: plan.digest }),
    'no run of this operation could have produced', 'a proof reached too early is refused');

  // A STEP LIST THAT IS NOT THIS OPERATION'S STEPS.
  put(ids.slice(0, 3).map((id) => at(id, 'complete')));
  refuses(() => runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'resume', confirm: plan.digest }),
    'does not describe this operation', 'a short step list is refused');

  // AND THE STATE A REAL RUN DID PRODUCE IS ACCEPTED — which is the whole point of the model.
  put(allBut({ 'prove-history': ['failed', 'the durable history could not be read'] }));
  const resumed = runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'resume', confirm: plan.digest });
  assertEq(resumed.ok, true, 'a legal interrupted state resumes');
});

test('an EARLIER proof may fail while LATER ones succeed, and that state is legal and resumable', () => {
  // THE DEFECT THIS PINS, AND IT LEFT AN INSTALLATION WITH NO WAY FORWARD. Every proof runs even after an
  // earlier one fails — that is correct, and it is what made the old journal illegal. Progress was an
  // ORDERED LIST OF COMPLETED STEPS validated as a PREFIX, so a run whose `prove-version` failed and whose
  // `prove-doctor` succeeded wrote a list with a hole in the middle, which its own reader then refused.
  // The project then refused a fresh restore (a journal is present) AND a resume (the journal is illegal).
  const root = makeProject('proof-independence');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  // The pinned image expects a later schema, so prove-version fails; every later proof still succeeds.
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION + 1,
    initialSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  });
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  assertEq(report.steps.find((step) => step.id === 'prove-version')!.outcome, 'failed', 'the first proof failed');
  assertEq(report.steps.find((step) => step.id === 'prove-doctor')!.outcome, 'held', 'and a later one held');

  // THE JOURNAL IT WROTE IS ONE ITS OWN READER ACCEPTS.
  const journal = readRestoreJournal(root)!;
  assert(journal !== null, 'the journal this run wrote reads back');
  assertEq(journal.steps.find((step) => step.id === 'prove-version')!.state, 'failed', 'the failure is recorded');
  assertEq(journal.steps.find((step) => step.id === 'prove-doctor')!.state, 'complete',
    'AND SO IS THE LATER SUCCESS — which a prefix of completed steps could not represent');
  assert(journal.steps.find((step) => step.id === 'prove-version')!.detail !== null,
    'and the failure stays diagnosable, with its reason');

  // AND THE INSTALLATION IS RESUMABLE, which is what the old model made impossible.
  const fixed = worldFor(setDir);
  const resumed = runCompleteRestore(request(root, 'set-1'), depsFor(fixed), { kind: 'resume', confirm: plan.digest });
  assertEq(resumed.ok, true, `the resume completed: ${resumed.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assertEq(resumed.steps.find((step) => step.id === 'prove-version')!.outcome, 'held',
    'the previously failed proof was RE-RUN, not skipped — a read-only diagnosis is worth refreshing');
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), false, 'and the journal is cleared');
});

test('custody proven by an earlier process survives a resume that skips the step which proved it', () => {
  // THE DEFECT THIS PINS. `custodyProven` lived only in the running process. A run that PROVED custody and
  // then failed `prove-history` left a journal with `prove-decrypt` complete; the resume skipped that step,
  // because it was complete, and so never set the flag — and reported a fully successful restore as
  // "custody proven: NO". The most important claim this command makes was destroyed by the recovery path
  // for an unrelated failure.
  const root = makeProject('custody-evidence');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const first = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  const firstReport = runCompleteRestore(request(root, 'set-1'), depsFor(first),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  assertEq(firstReport.custodyProven, true, 'the first run PROVED custody');
  assertEq(firstReport.ok, false, 'and then failed a later, unrelated proof');

  // THE EVIDENCE IS IN THE JOURNAL, not only in a process that has ended.
  const journal = readRestoreJournal(root)!;
  assertEq(journal.evidence.custodyProven, true, 'the journal carries what the operation established');

  const second = worldFor(setDir);
  const resumed = runCompleteRestore(request(root, 'set-1'), depsFor(second), { kind: 'resume', confirm: plan.digest });
  assertEq(resumed.ok, true, 'the resume completed');
  assertEq(resumed.steps.find((step) => step.id === 'prove-decrypt')!.outcome, 'skipped',
    'the step that proved custody was skipped, because it had already completed');
  assertEq(resumed.custodyProven, true, 'AND CUSTODY IS STILL PROVEN — the operation established it');
  assert(renderCompleteRestore(resumed).includes('custody proven     YES'), 'and the rendering says so');
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
  assert(report.unresolved.includes('secrets'), 'it names the target that is still out of place');
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
    '--confirm', 'd', '--no-safety-set', '--accept-data-loss', 'd']);
  assertEq(run.mode, 'run', 'a run parses');
  assertEq(run.noSafetySet, true, 'with the choice it is acknowledging');
  assertEq(run.acceptDataLoss, 'd', 'and the acknowledgement, which IS relevant here');
});

test('the usage text and the abandon behaviour agree about what abandon needs', () => {
  const cli = readRepo('src/ops/complete-restore-cli.ts');
  assert(cli.includes('TAKES ONLY --project'), 'the usage says abandon takes only the project');
  // AND THE CODE AGREES: the mode's allowlist is exactly that.
  assertEq(MODE_VALUE_FLAGS.abandon.join(','), 'project', 'and the allowlist says the same');
  assertEq(MODE_VALUE_FLAGS.resume.join(','), 'project,resume', 'and a resume takes its digest and nothing else');
});


// ===========================================================================================================
// CRASH BOUNDARIES — the process dies between an effect and the journal write that records it
// ===========================================================================================================
//
// EVERY CHECK ABOVE COVERS A FAILURE THAT WAS RETURNED. A step that answers "this did not hold" leaves the
// journal correct by construction, because the code that wrote the failure also ran. THE STATE NOBODY HAD
// TESTED IS THE ONE WHERE NO CODE RAN AT ALL: a kill, a power loss or an OOM between the effect landing and
// the journal recording it. That state is reachable in production and was unreachable in the suite.
//
// It is reachable here because the two effectful primitives are injected — `CommandRunner` and now `Renamer`.
// A runner or a renamer that THROWS A HARD ERROR (not a `MaintenanceRefused`, which the step machinery would
// catch and record) after the effect has landed is exactly a process that stopped existing at that point:
// the effect is on disk, the journal still says `running`, and nothing recorded the outcome.
//
// Each check below therefore does three things: drive a run to a real crash at a NAMED boundary, assert the
// on-disk state a crash there actually leaves, and then RESUME and assert the installation ends up somewhere
// describable. A recovery path nobody can execute is a recovery path nobody can claim works.

/**
 * Run a restore in its own process and kill it at a named boundary.
 *
 * `process.exit` inside an injected primitive is the only faithful simulation of a process death: an
 * exception is CAUGHT by `runGuarded` and by the step machinery, and correctly so, which is exactly why a
 * suite that threw would be re-testing the error path rather than the crash path. See the child.
 */
function crashAt(config: Record<string, unknown>): void {
  const child = spawnSync(process.execPath,
    [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), CRASH_CHILD, JSON.stringify(config)],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  if (child.status !== CRASH_EXIT_CODE) {
    throw new Error(`the run did not die at ${String(config.crashAt)}: exit ${String(child.status)} `
      + `${(child.stderr ?? '').slice(0, 400)}`);
  }

  // A PROCESS THAT STOPPED EXISTING NEVER RELEASED THE LOCK. That is real, and this command deliberately
  // does not break a lock on its own — so it names both facts, and the operator does what it says.
  const root = String(config.projectRoot);
  const lock = join(root, MAINTENANCE_LOCK_DIRNAME);
  assert(existsSync(lock), `a killed run leaves ${MAINTENANCE_LOCK_DIRNAME} behind`);
  rmSync(lock, { recursive: true, force: true });
}

/** The refusal an operator meets first, before they clear the lock the dead process left. */
function crashAtKeepingLock(config: Record<string, unknown>): void {
  const child = spawnSync(process.execPath,
    [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), CRASH_CHILD, JSON.stringify(config)],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  if (child.status !== CRASH_EXIT_CODE) {
    throw new Error(`the run did not die at ${String(config.crashAt)}: exit ${String(child.status)}`);
  }
}
const CRASH_CHILD = fileURLToPath(new URL('./helpers/restore-crash-child.mts', import.meta.url));
test('CRASH with the target moved aside and the replacement not yet in place: a resume finishes it', () => {
  // THE STATE THIS PRODUCES IS THE WORST ONE IN THE WHOLE COMMAND. Between the two renames the installation
  // has NO secrets directory at all: the previous contents are under `.replaced-`, the new ones under
  // `.restoring-`, and the name everything reads is empty. The first cut's resume would have found no target,
  // tried to copy the staged component to a `.restoring-` name that already existed, and REFUSED — leaving
  // the installation with no secrets and a command that would not move.
  const root = makeProject('crash-mid-swap');
  const setDir = takeSet(root, 'set-1');
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
  const { plan } = planFor(request(root, 'set-1'));
  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'rename:2' });

  // THE ON-DISK STATE A CRASH THERE REALLY LEAVES.
  assertEq(existsSync(join(root, 'secrets')), false, 'the secrets directory is GONE — this is the dangerous state');
  assert(existsSync(join(root, '.secrets.replaced-aaaaaaaaaaaa')), 'the previous contents are beside it');
  assert(existsSync(join(root, '.secrets.restoring-aaaaaaaaaaaa')), 'and so is the replacement that never landed');
  const journal = readRestoreJournal(root)!;
  assertEq(journal.steps.find((step) => step.id === 'place-secrets')!.state, 'running',
    'and the journal names the step the process was inside');

  // THE RESUME FINISHES WHAT THE CRASH INTERRUPTED.
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(restoreStack({
    buildSchema: MIGRATION_VERSION, startDestroyed: true,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  })),
    { kind: 'resume', confirm: plan.digest });
  assertEq(report.ok, true, `the resume completed: ${report.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), SECRET_VALUE,
    'THE SECRETS DIRECTORY IS BACK, holding the restored bytes');
  assertEq(existsSync(join(root, '.secrets.restoring-aaaaaaaaaaaa')), false, 'nothing is left half-renamed');
  assert(report.replaced.includes('.secrets.replaced-aaaaaaaaaaaa'),
    'and the previous contents are still named, so an abandon could still put them back');
});

test('CRASH after every rename but before the record: the swap is recognised, not performed twice', () => {
  // A crash here leaves a correct installation and a journal that does not know it. Re-running the swap
  // would rename the RESTORED directory aside and record it as "the previous contents" — losing the real
  // previous contents behind a second `.replaced-` name and corrupting what `--abandon` would put back.
  const root = makeProject('crash-after-swap');
  const setDir = takeSet(root, 'set-1');
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
  const { plan } = planFor(request(root, 'set-1'));

  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'rename:3' });

  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), SECRET_VALUE, 'the swap did land');
  const before = readdirSync(root).filter((entry) => entry.includes('.replaced-'));
  assertEq(before.length, 1, 'and exactly one directory was moved aside');

  const report = runCompleteRestore(request(root, 'set-1'), depsFor(restoreStack({
    buildSchema: MIGRATION_VERSION, startDestroyed: true,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  })),
    { kind: 'resume', confirm: plan.digest });
  assertEq(report.ok, true, 'the resume completed');
  assertEq(readdirSync(root).filter((entry) => entry.includes('.replaced-')).length, 1,
    'AND THE SWAP WAS NOT PERFORMED A SECOND TIME');
  assertEq(readFileSync(join(root, '.secrets.replaced-aaaaaaaaaaaa', 'custodian_kek'), 'utf8'), 'a-later-value\n',
    'the directory kept aside is still the one the installation had before the restore');
  assert(report.replaced.includes('.secrets.replaced-aaaaaaaaaaaa'),
    'and the reconstructed record names it, so --abandon can still undo it');
});

test('CRASH after the safety set is published, before it is recorded: it is recognised, not retaken', () => {
  // `ops:complete-backup` REFUSES AN EXISTING SET NAME — deliberately, because replacing a set is how the
  // only copy of something irrecoverable gets overwritten. So a blind retry after this crash would fail at
  // the first step, every time, and the operator's only way forward would be to delete the very set that was
  // protecting them.
  const root = makeProject('crash-after-safety-set');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);

  // The safety set's last command is the `compose start` that brings the stack back; dying after it means
  // the whole verified cycle completed and only the record was lost.
  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'complete:safety-set' });

  assert(existsSync(join(root, 'backups', publishedSafetySet(root))), 'the safety set IS on disk');
  assertEq(readRestoreJournal(root)!.steps.find((step) => step.id === 'safety-set')!.state, 'running',
    'and the journal says the process was inside that step');

  const report = runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'resume', confirm: plan.digest });
  assertEq(report.ok, true, `the resume completed: ${report.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assertEq(report.steps.find((step) => step.id === 'safety-set')!.outcome, 'skipped',
    'THE SET WAS RECOGNISED, not taken again into a name that would have refused it');
  assert(report.safetySet !== null && report.safetySet.endsWith('pre-restore-set-1'),
    'and the operation still knows it has one');
  assertEq(report.safetySetVerified, true, 'proved by verifying it, not by finding a directory of that name');
});

test('CRASH inside the replay: the whole database leg is run again, because a partial dump cannot be repaired', () => {
  // A `psql` replay killed halfway leaves a PARTIAL SCHEMA. Nothing can repair that in place, and replaying
  // the same dump over it produces conflicts rather than a restore. The only honest recovery is to destroy
  // the volumes and do the leg again — which the step declares, so the journal's own state is rewritten
  // rather than a human reasoning about which earlier steps have been invalidated.
  const root = makeProject('crash-mid-replay');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);

  // The replay goes through the stdin-bound runner; dying there is dying inside `psql`.
  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'complete:replay-database' });
  const journal = readRestoreJournal(root)!;
  assertEq(journal.steps.find((step) => step.id === 'replay-database')!.state, 'running',
    'the replay had landed and was not recorded');
  assertEq(journal.steps.find((step) => step.id === 'stop-and-destroy')!.state, 'complete', 'after a completed teardown');

  const second = restoreStack({
    buildSchema: MIGRATION_VERSION, startDestroyed: true,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  });
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(second), { kind: 'resume', confirm: plan.digest });
  assertEq(report.ok, true, `the resume completed: ${report.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assertEq(second.teardowns(), 1, 'THE VOLUMES WERE DESTROYED AGAIN — the leg was rewound, not continued');
  assertEq(report.steps.find((step) => step.id === 'stop-and-destroy')!.outcome, 'held',
    'the teardown ran again rather than being skipped as complete');
  assertEq(report.steps.find((step) => step.id === 'replay-database')!.outcome, 'held', 'and the dump replayed');
  assert(report.notes.some((note) => note.includes('cannot be repeated or repaired')),
    'and the report says why the leg was repeated');
});

test('CRASH after the teardown, before it is recorded: it is simply done again', () => {
  // Most steps are idempotent and the recovery for them is the boring one. It is checked anyway, because
  // "most steps are fine" is the assumption that made the other three dangerous.
  const root = makeProject('crash-after-teardown');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'complete:stop-and-destroy' });
  assertEq(readRestoreJournal(root)!.steps.find((step) => step.id === 'stop-and-destroy')!.state, 'running',
    'the teardown ran and was not recorded');

  const second = restoreStack({
    buildSchema: MIGRATION_VERSION, startDestroyed: true,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  });
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(second), { kind: 'resume', confirm: plan.digest });
  assertEq(report.ok, true, 'the resume completed');
  assert(report.notes.some((note) => note.includes('changes nothing that repeating it would damage')),
    'and said the step was simply repeated');
});

test('every step declares a recovery policy, and the three that are not plain retries are the known ones', () => {
  // THE POLICY IS DISPATCHED FROM THE DECLARATION, not from a reader's memory of which steps are idempotent.
  // A step added to the model has to answer this question before it compiles.
  for (const id of RESTORE_STEP_IDS) {
    const policy = STEP_RECOVERY[id];
    assert(['retry', 'confirm-or-retry', 'repair-swap', 'rewind'].includes(policy), `${id} declares a policy`);
  }
  assertEq(STEP_RECOVERY['safety-set'], 'confirm-or-retry', 'a published set is looked for before it is retaken');
  for (const id of ['place-secrets', 'place-promotion-records', 'place-sidecar-keystore'] as const) {
    assertEq(STEP_RECOVERY[id], 'repair-swap', `${id} is two renames and is repaired, not repeated`);
  }
  assertEq(STEP_RECOVERY['replay-database'], 'rewind', 'a partial replay rewinds the leg');
  assertEq(STEP_REWIND_TO['replay-database'], 'stage-components',
    'back to the STAGING, because the suspect artifact must be rebuilt before the leg is repeated');
  assertEq(STEP_REWIND_TO['place-inline-keystore'], 'stage-components',
    'and the keystore copy rewinds the same way, for the same reason');
  // AND EVERY REWIND NAMES A STEP THAT REALLY COMES BEFORE IT.
  for (const [id, to] of Object.entries(STEP_REWIND_TO)) {
    const ids = RESTORE_STEP_IDS as readonly string[];
    assert(ids.indexOf(to!) < ids.indexOf(id), `${id} rewinds to a step that precedes it`);
  }
});

test('a half-published safety set is refused rather than trusted or replaced', () => {
  // THE ONE CASE WHERE A HUMAN HAS TO LOOK. Retaking is refused by the name, and trusting it is refused by
  // the verification — so the command says so and changes nothing, rather than choosing one of two bad
  // options on the operator's behalf.
  const root = makeProject('half-safety-set');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'complete:safety-set' });

  // Something damages the published set before the resume: now it neither verifies nor may be replaced.
  writeFileSync(join(root, 'backups', publishedSafetySet(root), COMPONENT_ARTIFACT_NAMES.database),
    'tampered\n', 'utf8');
  refuses(() => runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'resume', confirm: plan.digest }),
  'does NOT verify', 'a half-published safety set is refused');
  // AND THE JOURNAL STILL SAYS RUNNING, so the next attempt sees the same state rather than one the refusal invented.
  assertEq(readRestoreJournal(root)!.steps.find((step) => step.id === 'safety-set')!.state, 'running',
    'the refusal changed nothing, including the journal');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});


// ---------------------------------------------------------------------------------------------------------
// The boundaries the previous commit named and did not cover
// ---------------------------------------------------------------------------------------------------------

test('CRASH after staging is verified, before its completion record: the tree is unmarked and refused, not reused', () => {
  // A KILL INSIDE `stage-components` LEAVES A PLAUSIBLE-LOOKING TREE at a name derived from a suffix an
  // operator can read in a journal. The marker is written LAST, so a tree without one is a tree whose
  // components were never all staged and verified — and it is neither trusted nor removed, because a plain
  // directory at an expected name is not proof of anything.
  const root = makeProject('crash-mid-staging');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'complete:stage-components' });

  const staging = join(root, '.catalog-restore.staged-aaaaaaaaaaaa');
  assert(existsSync(staging), 'the staged tree is on disk');
  assert(existsSync(join(staging, 'catalog-restore-staging.json')), 'and it carries its ownership marker');
  assertEq(readRestoreJournal(root)!.steps.find((step) => step.id === 'stage-components')!.state, 'running',
    'and the journal says the process was inside that step');

  // THE RESUME RE-STAGES, because the step never completed — and it may, because the tree is provably ours.
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'resume', confirm: plan.digest });
  assertEq(report.ok, true, `the resume completed: ${report.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assertEq(existsSync(staging), false, 'and the staging tree is gone once the restore completed');
});

test('a staging tree that is NOT ours is refused, never reused and never removed', () => {
  // THE NAME IS PREDICTABLE. `removeOwnTreeNoFollow` refuses links and special files and would happily have
  // removed — or staged into — any plain directory sitting here.
  const root = makeProject('foreign-staging');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const staging = join(root, '.catalog-restore.staged-aaaaaaaaaaaa');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'somebody-elses-file'), 'not ours\n', 'utf8');

  const report = runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  const staged = report.steps.find((step) => step.id === 'stage-components')!;
  assertEq(staged.outcome, 'failed', 'staging refused to use it');
  assert(staged.detail!.includes('no ownership marker'), 'because it carries no marker of ours');
  assert(existsSync(join(staging, 'somebody-elses-file')), 'AND IT WAS NOT REMOVED');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
  rmSync(staging, { recursive: true, force: true });
});

test('a staged component modified after the interruption is never placed or replayed', () => {
  // THE ARTIFACT SITS AT A PREDICTABLE NAME BETWEEN PROCESSES, for an unbounded time. It is re-verified
  // against the backup manifest immediately before every single consumption, not once when it was staged.
  const root = makeProject('staged-mutation');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'complete:stop-and-destroy' });

  // Something rewrites the staged dump while the project sits interrupted.
  const staging = join(root, '.catalog-restore.staged-aaaaaaaaaaaa');
  writeFileSync(join(staging, COMPONENT_ARTIFACT_NAMES.database), `${fakeDumpText(MIGRATION_VERSION)}-- tampered\n`, 'utf8');

  const world = restoreStack({
    buildSchema: MIGRATION_VERSION, startDestroyed: true,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  });
  let report: CompleteRestoreReport;
  try {
    report = runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'resume', confirm: plan.digest });
  } catch (err) {
    assert(err instanceof CompleteRestoreFailed, 'the volumes were already destroyed, so this is a step failure');
    report = (err as CompleteRestoreFailed).report;
  }
  const replay = report.steps.find((step) => step.id === 'replay-database')!;
  assertEq(replay.outcome, 'failed', 'the replay refused the changed dump');
  assert(replay.detail!.includes('changed after it was staged'), 'naming what happened');
  assertEq(world.replays().length, 0, 'AND THE TAMPERED BYTES NEVER REACHED A DATABASE');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

test('CRASH after the last step is recorded, before the journal is cleared: the completed run is not re-run', () => {
  // THE WINDOW THIS PINS was open because the lock was released BEFORE the verdict, the staging cleanup and
  // the journal clear. In it, this project held a journal describing a COMPLETE operation and no lock — so a
  // resume could start against it and an abandon could begin unwinding a restore that had just succeeded.
  const root = makeProject('crash-before-clear');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'after:prove-history' });

  const journal = readRestoreJournal(root)!;
  for (const step of journal.steps) {
    assertEq(step.state, 'complete', `${step.id} is recorded complete`);
  }
  assertEq(journal.evidence.custodyProven, true, 'and the evidence survived with it');

  // A RESUME OVER A COMPLETED OPERATION PERFORMS NOTHING and finishes the bookkeeping the crash interrupted.
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION, startDestroyed: true,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  });
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'resume', confirm: plan.digest });
  assertEq(report.ok, true, 'the resume reports the operation as complete');
  assertEq(report.custodyProven, true, 'with the custody the earlier process proved');
  for (const step of report.steps) {
    assertEq(step.outcome, 'skipped', `${step.id} was not performed again`);
  }
  assertEq(world.teardowns(), 0, 'NOTHING WAS DESTROYED A SECOND TIME');
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), false, 'and the journal is cleared now');
  assertEq(existsSync(join(root, '.catalog-restore.staged-aaaaaaaaaaaa')), false, 'as is the staging copy');
});

test('the finalization happens under the lock, so nothing can act on a completed operation in between', () => {
  // The property, asserted against the source rather than inferred: the verdict, the staging cleanup and the
  // journal clear are all INSIDE the try whose `finally` releases the lock.
  const source = readRepo('src/ops/complete-restore.ts');
  const body = source.slice(source.indexOf('lock = acquireMaintenanceLock(resolved.projectRoot);'));
  const release = body.indexOf('    lock.release();');
  for (const marker of ['clearRestoreJournal(resolved.projectRoot)', 'removeOwnedStaging(stagingDir',
    'const everyStepHeld =', 'report = {']) {
    const at = body.indexOf(marker);
    assert(at > 0 && at < release, `${marker} happens before the lock is released`);
  }
  // AND ABANDON TAKES THE SAME LOCK.
  const abandon = source.slice(source.indexOf('export function abandonRestore'));
  assert(abandon.slice(0, 2000).includes('acquireMaintenanceLock(projectRoot)'),
    'abandon serialises every effect it performs under the project lock');
});

// ---------------------------------------------------------------------------------------------------------
// Abandon: absence is a state, and both halves are crashable
// ---------------------------------------------------------------------------------------------------------

test('abandon restores ABSENCE when the target did not exist before the restore', () => {
  // THE DEFECT THIS PINS. With `replaced: null` the first version marked the swap undone and left the
  // RESTORED copy at the target — so abandon reported success having restored nothing, and left a directory
  // of the set's secrets at a path the installation had never had.
  const root = join(WORK, 'abandon-absence');
  mkdirSync(join(root, 'secrets'), { recursive: true });
  const source = makeProject('abandon-absence-source');
  const setDir = takeSet(source, 'set-1');
  mkdirSync(join(root, 'backups'), { recursive: true });
  copyDirectory(setDir, join(root, 'backups', 'set-1'));
  // The records directory does not exist here at all: the restore will create it.
  assertEq(existsSync(join(root, 'promotion-records')), false, 'the target is absent before the restore');

  const req = request(root, 'set-1');
  const { plan } = planFor(req, false);
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  runCompleteRestore(req, depsFor(world), { kind: 'run', confirm: plan.digest, acceptDataLoss: plan.digest });
  assert(existsSync(join(root, 'promotion-records')), 'the restore created it');
  const journal = readRestoreJournal(root)!;
  assertEq(journal.swaps.find((swap) => swap.component === 'promotion-records')!.replaced, null,
    'and recorded that there had been nothing to move aside');

  const report = abandonRestore(root);
  assertEq(existsSync(join(root, 'promotion-records')), false,
    'ABSENCE IS RESTORED — the directory the installation never had is gone again');
  assert(report.restored.includes('promotion-records'), 'and the abandon says it restored it');
  const kept = report.retained.find((name) => name.includes('promotion-records'));
  assert(kept !== undefined, 'the restored copy is RETAINED under a named .abandoned- copy');
  assert(existsSync(join(root, kept!)), 'which is really on disk');
  assert(report.notes.some((note) => note.includes('hold secret material')), 'and is named as holding secrets');
  assertEq(report.journalCleared, true, 'and the journal is cleared, because every target state is back');
});

test('CRASH inside abandon after the restored copy is moved aside: retrying finishes it', () => {
  // THE WINDOW WHERE THE TARGET DOES NOT EXIST AT ALL. A retry must finish the unwind rather than see an
  // absent target and call it done.
  const root = makeProject('abandon-crash-first');
  const setDir = takeSet(root, 'set-1');
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'rename:1', operation: 'abandon' });
  assertEq(existsSync(join(root, 'secrets')), false, 'the secrets directory is GONE mid-abandon');
  assert(existsSync(join(root, '.secrets.abandoned-aaaaaaaaaaaa')), 'the restored copy is set aside');
  assert(existsSync(join(root, '.secrets.replaced-aaaaaaaaaaaa')), 'and the original is still waiting');
  assert(existsSync(join(root, RESTORE_JOURNAL_NAME)), 'and the journal is still there');

  const report = abandonRestore(root);
  assertEq(report.ok, true, 'the retry finished the abandon');
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), 'a-later-value\n',
    'THE ORIGINAL CONTENTS ARE BACK');
  assert(report.retained.some((name) => name.includes('secrets')), 'and the restored copy is named');
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), false, 'and the journal is cleared');
});

test('CRASH inside abandon after the original is put back: retrying clears without undoing it again', () => {
  const root = makeProject('abandon-crash-second');
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

  // Die after the SECOND rename: the first target is fully unwound and nothing has recorded it.
  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'rename:2', operation: 'abandon' });
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), 'a-later-value\n',
    'the first target is already back');
  assert(existsSync(join(root, RESTORE_JOURNAL_NAME)), 'and the journal still records the operation');

  const report = abandonRestore(root);
  assertEq(report.ok, true, 'the retry completed');
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), 'a-later-value\n',
    'the finished target was NOT undone a second time');
  assert(existsSync(join(root, 'promotion-records', 'record-later.json')), 'and the other one was finished');
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), false, 'and the journal is cleared');
});

test('a corrupt swap record cannot redirect abandon at another directory in the project', () => {
  // ABANDON RENAMES DIRECTORIES ON THE STRENGTH OF THE JOURNAL. Every recorded swap is cross-validated
  // against the rest of it — the request, the topology, the placement step, the leaf, and the names this
  // run's suffix derives — so a swap can only ever name the place this operation actually placed.
  const root = makeProject('abandon-corrupt-swap');
  const setDir = takeSet(root, 'set-1');
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
  mkdirSync(join(root, 'innocent'), { recursive: true });
  writeFileSync(join(root, 'innocent', 'keep-me'), 'untouched\n', 'utf8');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  const journal = readRestoreJournal(root)!;
  // The names stay internally consistent, so the journal READER accepts it: what catches this is the
  // cross-validation of the swap against the operation's own request.
  const redirected = journal.swaps.map((swap) => (swap.component === 'secrets'
    ? { ...swap, target: 'innocent', name: 'innocent', replaced: '.innocent.replaced-aaaaaaaaaaaa' } : swap));
  writeFileSync(join(root, RESTORE_JOURNAL_NAME), `${JSON.stringify({ ...journal, swaps: redirected })}\n`, 'utf8');

  const report = abandonRestore(root);
  assertEq(report.ok, false, 'the abandon did not succeed');
  assert(report.unresolved.includes('innocent'), 'it names the swap it refused to act on');
  assertEq(readFileSync(join(root, 'innocent', 'keep-me'), 'utf8'), 'untouched\n',
    'AND THE DIRECTORY IT WAS POINTED AT IS UNTOUCHED');
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), true, 'and the journal is not cleared');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

test('abandon does not clear while the staging copy of every secret is still unresolved', () => {
  const root = makeProject('abandon-staging');
  const setDir = takeSet(root, 'set-1');
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  // The marker is destroyed, so the tree can no longer be proved ours — and must not be removed.
  const staging = join(root, '.catalog-restore.staged-aaaaaaaaaaaa');
  rmSync(join(staging, 'catalog-restore-staging.json'));
  const report = abandonRestore(root);
  assertEq(report.ok, false, 'the abandon did not complete');
  assertEq(report.stagingUnresolved, '.catalog-restore.staged-aaaaaaaaaaaa', 'it names the staging tree');
  assert(existsSync(staging), 'AND DID NOT REMOVE A TREE IT COULD NOT PROVE WAS ITS OWN');
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), true, 'and kept the journal');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

// ---------------------------------------------------------------------------------------------------------
// Overlapping destructive paths
// ---------------------------------------------------------------------------------------------------------

test('overlapping component targets are refused before a command, a lock or a journal exists', () => {
  // EQUALITY WAS NOT THE PROPERTY. A nested target has one component's directory renamed aside WHOLE with
  // the other still inside it, leaving a single kept copy an abandon would put back over the wrong one.
  const root = makeProject('overlap');
  takeSet(root, 'set-1');
  mkdirSync(join(root, 'nest', 'inner'), { recursive: true });
  writeFileSync(join(root, 'nest', 'x'), 'x\n', 'utf8');

  const cases: Array<[Partial<CompleteRestoreRequest>, string]> = [
    [{ secrets: 'nest', promotionRecords: 'nest' }, 'equal targets'],
    [{ secrets: 'nest', promotionRecords: 'nest/inner' }, 'a records target INSIDE the secrets target'],
    [{ secrets: 'nest/inner', promotionRecords: 'nest' }, 'a secrets target inside the records target'],
  ];
  for (const [over, why] of cases) {
    refuses(() => resolveCompleteRestoreRequest(request(root, 'set-1', over)),
      'at the same directory, or at one inside the other', why);
  }
  // AND NOTHING WAS CREATED BY THE ATTEMPT.
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), false, 'no journal');
  assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false, 'no lock');
});

test('a target that is, contains, or sits inside the backups destination or the set is refused', () => {
  // `--secrets backups` renames the destination aside WITH THE SET BEING RESTORED AND THE SAFETY SET IN IT,
  // and the very next step reads from a path that has just moved.
  for (const sidecar of [false, true]) {
    const label = sidecar ? 'sidecar' : 'inline';
    const root = makeProject(`overlap-dest-${label}`, { sidecar });
    takeSet(root, 'set-1', { sidecar });
    const over = sidecar ? { custodian: 'sidecar' as const, sidecarState: 'sidecar-state' } : {};
    for (const [patch, why] of [
      [{ secrets: 'backups' }, `${label}: the destination itself`],
      [{ secrets: 'backups/set-1' }, `${label}: the set being restored`],
      [{ promotionRecords: 'backups' }, `${label}: the destination as a records target`],
    ] as Array<[Partial<CompleteRestoreRequest>, string]>) {
      refuses(() => resolveCompleteRestoreRequest(request(root, 'set-1', { ...over, ...patch })),
        'containing it or inside it', why);
    }
    if (sidecar) {
      refuses(() => resolveCompleteRestoreRequest(request(root, 'set-1', { ...over, sidecarState: 'backups' })),
        'containing it or inside it', 'sidecar: the destination as a keystore target');
    }
    assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), false, `${label}: no journal was created`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The data-loss CLI, de-circularised
// ---------------------------------------------------------------------------------------------------------

test('planning without a safety set is a value-free CHOICE, and its digest is what a run acknowledges', () => {
  // THE CIRCULARITY THIS PINS. `--accept-data-loss` takes the digest of the no-safety plan, and seeing that
  // digest meant running `--plan --accept-data-loss <something>` — with nothing correct to put there. The
  // value was ignored, which teaches an operator that their acknowledgement does not matter.
  const root = makeProject('cli-no-safety');
  takeSet(root, 'set-1');

  // 1. A PLACEHOLDER IS REFUSED, NOT IGNORED.
  refuses(() => parseCompleteRestoreArgs(['--project', 'p', '--set', 's', '--custodian', 'inline',
    '--plan', '--accept-data-loss', 'placeholder']),
  'will not take a digest it would ignore', 'a placeholder at plan time is refused');

  // 2. THE SAFE PLAN AND THE NO-SAFETY PLAN ARE DIFFERENT OPERATIONS WITH DIFFERENT DIGESTS.
  const printed: string[] = [];
  const realLog = console.log;
  const capture = (): string => { const out = printed.join('\n'); printed.length = 0; return out; };
  console.log = (...parts: unknown[]): void => { printed.push(parts.map(String).join(' ')); };
  let safe: string;
  let unsafe: string;
  try {
    assertEq(cliMain(['--project', root, '--set', 'set-1', '--custodian', 'inline',
      '--promotion-records', 'promotion-records', '--plan']), 0, 'the safe plan exits zero');
    safe = capture();
    assertEq(cliMain(['--project', root, '--set', 'set-1', '--custodian', 'inline',
      '--promotion-records', 'promotion-records', '--plan', '--no-safety-set']), 0,
    'the no-safety plan exits zero');
    unsafe = capture();
  } finally {
    console.log = realLog;
  }
  const digestOfPlan = (text: string): string => /plan digest: ([0-9a-f]{64})/.exec(text)![1]!;
  assert(digestOfPlan(safe) !== digestOfPlan(unsafe), 'the two plans have different digests');
  assert(safe.includes('a verified safety set would be taken first'), 'the safe plan says so');
  assert(unsafe.includes('NO SAFETY SET WOULD BE TAKEN'), 'and the other one says so');
  assert(unsafe.includes('!! THIS PLAN TAKES NO SAFETY SET'), 'loudly');
  assert(unsafe.includes('BOTH --no-safety-set and --accept-data-loss'), 'and says exactly what running it takes');

  // 3. THE RUN TAKES THAT SAME DIGEST, TWICE, AND THE CHOICE WITH IT.
  const expected = planFor(request(root, 'set-1'), false).plan.digest;
  assertEq(digestOfPlan(unsafe), expected, 'the printed digest is the one the run will require');
  const parsed = parseCompleteRestoreArgs(['--project', root, '--set', 'set-1', '--custodian', 'inline',
    '--no-safety-set', '--confirm', expected, '--accept-data-loss', expected]);
  assertEq(parsed.mode, 'run', 'the run parses');
  assertEq(parsed.noSafetySet, true, 'carrying the choice');
  assertEq(parsed.acceptDataLoss, expected, 'and the acknowledgement');

  // 4. HALF OF IT IS NOT ENOUGH, IN EITHER DIRECTION.
  refuses(() => parseCompleteRestoreArgs(['--project', 'p', '--set', 's', '--custodian', 'inline',
    '--no-safety-set', '--confirm', 'd']), 'without --accept-data-loss', 'the choice alone is refused');
  refuses(() => parseCompleteRestoreArgs(['--project', 'p', '--set', 's', '--custodian', 'inline',
    '--confirm', 'd', '--accept-data-loss', 'd']), 'without --no-safety-set',
  'an acknowledgement of a loss this run would not cause is refused');
  refuses(() => parseCompleteRestoreArgs(['--project', 'p', '--resume', 'd', '--no-safety-set']),
    'not part of --resume', 'and the choice is irrelevant to a resume');
  refuses(() => parseCompleteRestoreArgs(['--project', 'p', '--abandon', '--no-safety-set']),
    'not part of --abandon', 'and to an abandon');
});


// ---------------------------------------------------------------------------------------------------------
// Concurrency: the whole transaction is one locked window
// ---------------------------------------------------------------------------------------------------------

test('a resume that arrives while a run holds the lock is refused, not admitted to the same journal', () => {
  // TWO PROCESSES ACTING ON ONE HALF-FINISHED RESTORE is the interleaving the lock exists to prevent, and the
  // window it had to be widened to cover is the finalization: the verdict, the staging cleanup and the
  // journal clear used to happen AFTER the lock was released.
  const root = makeProject('locked-window');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);

  // The second command arrives at the instant the first is recording its LAST step — which is inside the
  // finalization window, and used to be outside the lock.
  let secondAttempt: unknown = null;
  const deps = {
    ...depsFor(world),
    journalWriter: (projectRoot: string, journal: RestoreJournal) => {
      writeRestoreJournal(projectRoot, journal);
      const done = journal.steps.every((step) => step.state === 'complete');
      if (done && secondAttempt === null) {
        try {
          runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
            { kind: 'resume', confirm: plan.digest });
          secondAttempt = 'admitted';
        } catch (err) { secondAttempt = (err as Error).message; }
      }
    },
  };
  const report = runCompleteRestore(request(root, 'set-1'), deps,
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  assertEq(report.ok, true, 'the first run completed');
  assert(typeof secondAttempt === 'string' && secondAttempt !== 'admitted',
    `the second command was refused rather than admitted, got: ${String(secondAttempt)}`);
  assert((secondAttempt as string).includes('maintenance lock')
    || (secondAttempt as string).includes('already running'),
  `and it was refused BY THE LOCK, got: ${String(secondAttempt)}`);
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), false, 'and the journal was cleared exactly once');
});

test('an abandon that arrives while a run holds the lock cannot begin unwinding a restore that succeeded', () => {
  // THE SAME WINDOW, FROM THE OTHER SIDE. An abandon admitted between the last step committing and the
  // journal being cleared would start putting back directories a successful restore had just placed.
  const root = makeProject('abandon-races-run');
  const setDir = takeSet(root, 'set-1');
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
  const { plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);

  let raced: unknown = null;
  const deps = {
    ...depsFor(world),
    journalWriter: (projectRoot: string, journal: RestoreJournal) => {
      writeRestoreJournal(projectRoot, journal);
      const done = journal.steps.every((step) => step.state === 'complete');
      if (done && raced === null) {
        try { abandonRestore(root); raced = 'admitted'; } catch (err) { raced = (err as Error).message; }
      }
    },
  };
  const report = runCompleteRestore(request(root, 'set-1'), deps,
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  assertEq(report.ok, true, 'the restore completed');
  assert(typeof raced === 'string' && raced !== 'admitted',
    `the abandon was refused rather than admitted, got: ${String(raced)}`);
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), SECRET_VALUE,
    'AND THE RESTORED SECRETS WERE NOT PUT BACK by a racing abandon');
});

test('no stale pre-lock journal snapshot may drive an effect', () => {
  // The journal must be read once BEFORE the lock — that is how a run knows which operation it is — and
  // anything that acted in between makes that description stale. Acting on it would place components and
  // destroy volumes against a view that had stopped being true. There is no injectable seam between the two
  // reads (the seam IS the lock), so what is asserted is the guarantee itself: the re-read happens under the
  // lock, BEFORE any step runs, and a difference is a refusal.
  const source = readRepo('src/ops/complete-restore.ts');
  const locked = source.slice(source.indexOf('lock = acquireMaintenanceLock(resolved.projectRoot);'));
  const reread = locked.indexOf('const underLock = readRestoreJournal(resolved.projectRoot);');
  const firstStep = locked.indexOf('for (const step of plan.steps)');
  const firstPersist = locked.indexOf('persist();');
  assert(reread > 0, 'the journal is re-read under the lock');
  assert(reread < firstStep, 'before any step runs');
  assert(reread < firstPersist, 'and before anything is written');
  assert(locked.includes('changed between reading it and taking the lock'),
    'and a journal that changed in between is refused rather than reconciled');

  // ABANDON HOLDS THE SAME RULE, and it is a separate function that had to be given it separately.
  const abandon = source.slice(source.indexOf('export function abandonRestore'));
  const scope = abandon.slice(0, abandon.indexOf('function abandonUnderLock'));
  assert(scope.includes('acquireMaintenanceLock(projectRoot)'), 'abandon takes the project lock');
  assert(scope.indexOf('const journal = readRestoreJournal(projectRoot);') > scope.indexOf('acquireMaintenanceLock'),
    'and re-reads the journal after taking it');
  assert(scope.includes('changed between reading it and taking the lock'),
    'refusing one that changed in between');
});
test('a completed operation left unresolved staging keeps its journal, so nothing forgets the second copy', () => {
  // THE JOURNAL IS THE ONLY THING THAT NAMES THE STAGING TREE. Clearing it while a copy of every secret in
  // the installation sits in the project would leave that copy named by nothing at all.
  const root = makeProject('staging-unresolved');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);
  const deps = {
    ...depsFor(world),
    journalWriter: (projectRoot: string, journal: RestoreJournal) => {
      writeRestoreJournal(projectRoot, journal);
      // Destroy the ownership marker just before the run would clean up: the tree can no longer be proved
      // ours, so it must not be removed and the journal must not be cleared.
      if (journal.steps.every((step) => step.state === 'complete')) {
        const marker = join(root, '.catalog-restore.staged-aaaaaaaaaaaa', 'catalog-restore-staging.json');
        if (existsSync(marker)) rmSync(marker);
      }
    },
  };
  const report = runCompleteRestore(request(root, 'set-1'), deps,
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  assertEq(report.stagingUnresolved, '.catalog-restore.staged-aaaaaaaaaaaa', 'the report names the tree');
  assertEq(report.ok, false, 'and the run does not report success while a copy of every secret is loose');
  assert(existsSync(join(root, '.catalog-restore.staged-aaaaaaaaaaaa')), 'the tree was NOT removed');
  assert(existsSync(join(root, RESTORE_JOURNAL_NAME)), 'AND THE JOURNAL WAS KEPT, so something still names it');
  assert(report.notes.some((note) => note.includes('second copy of every secret')), 'and says why');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});


// ---------------------------------------------------------------------------------------------------------
// A RETURNED failure after a partial effect is not a fresh start
// ---------------------------------------------------------------------------------------------------------
//
// Every crash check above kills a process. THESE DO NOT: the step RETURNS an ordinary failure, the executor
// records `failed`, and the resume used to mark that same step running and perform it again from the top —
// with no recovery, because recovery only ever ran for a step recorded `running`. For three steps that is
// unsafe, and for two it is a dead end the installation cannot be moved out of.

test('a replay that EXITS NON-ZERO is not stacked on a possibly partial schema: the leg is rewound first', () => {
  // `psql` can exit non-zero having applied PART of the dump. Replaying the same dump onto that produces
  // conflicts, not a restore — which is exactly what the `rewind` policy exists for, and it was skipped
  // because the journal said "failed" rather than "running".
  const root = makeProject('replay-nonzero');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const first = worldFor(setDir);
  const partial = {
    ...depsFor(first),
    // The dump goes in — and then the command reports failure, the way a real `psql` does when it stops at
    // an error part way through applying one.
    fileRunner: (command: Parameters<typeof first.inputRunner>[0], source: string) => {
      first.inputRunner(command, source);
      return { status: 1, stdout: '', stderr: 'ERROR: relation already exists\n' };
    },
  };
  let thrown: unknown = null;
  try {
    runCompleteRestore(request(root, 'set-1'), partial, { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  } catch (err) { thrown = err; }
  assert(thrown instanceof CompleteRestoreFailed, 'the volumes were destroyed and the replay then failed');
  assertEq(readRestoreJournal(root)!.steps.find((step) => step.id === 'replay-database')!.state, 'failed',
    'the journal records a RETURNED failure, not an interrupted step');
  assertEq(first.teardowns(), 1, 'and the leg had been torn down once');

  // THE RESUME REWINDS BEFORE IT REPLAYS. The world it meets has volumes that were never re-emptied, so a
  // second replay stacked on the first would be refused by the modelled psql exactly as a real one refuses.
  const second = worldFor(setDir);
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(second), { kind: 'resume', confirm: plan.digest });
  assertEq(report.ok, true, `the resume completed: ${report.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assertEq(second.teardowns(), 1, 'THE VOLUMES WERE DESTROYED AGAIN before the second replay');
  assertEq(report.steps.find((step) => step.id === 'stop-and-destroy')!.outcome, 'held',
    'the teardown really ran again rather than being skipped as complete');
  assertEq(report.steps.find((step) => step.id === 'database-up')!.outcome, 'held',
    'and a fresh database was started for it');
  assertEq(second.replays().length, 1, 'and exactly one replay landed, into that fresh database');
  assert(report.notes.some((note) => note.includes('cannot be repeated or repaired')),
    'and the report says why the leg was repeated');
});

for (const failAt of [2, 3] as const) {
  test(`a swap whose rename #${failAt} FAILS is repaired on resume, not restarted with its source gone`, () => {
    // THE DEAD END THIS PINS. The first rename moves the staged component OUT of staging. If either later
    // rename then fails, the step is recorded `failed` — and the resume re-ran it from the top, found no
    // staged source, and answered "the staged secrets directory is not there... re-run the staging step",
    // forever, with the installation's secrets directory missing or half-placed.
    const root = makeProject(`swap-rename-${failAt}`);
    const setDir = takeSet(root, 'set-1');
    writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
    const { plan } = planFor(request(root, 'set-1'));
    const first = worldFor(setDir);
    let renames = 0;
    const failing = {
      ...depsFor(first),
      rename: (from: string, to: string): void => {
        renames += 1;
        if (renames === failAt) throw new Error('injected rename failure');
        renameSync(from, to);
      },
    };
    let thrown: unknown = null;
    try {
      runCompleteRestore(request(root, 'set-1'), failing, { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
    } catch (err) { thrown = err; }
    assert(thrown instanceof CompleteRestoreFailed, 'the volumes were already destroyed, so this is a step failure');

    // THE STATE IT LEAVES: the staged source has MOVED, and the journal says `failed`.
    assertEq(readRestoreJournal(root)!.steps.find((step) => step.id === 'place-secrets')!.state, 'failed',
      'the journal records a returned failure');
    assertEq(existsSync(join(root, '.catalog-restore.staged-aaaaaaaaaaaa', COMPONENT_ARTIFACT_NAMES.secrets)), false,
      'and the staged component is no longer in staging — the first rename moved it');
    assert(existsSync(join(root, '.secrets.restoring-aaaaaaaaaaaa')), 'it is in flight');
    if (failAt === 3) {
      assertEq(existsSync(join(root, 'secrets')), false, 'and at rename 3 the target is MISSING entirely');
    }

    // THE RESUME REPAIRS IT. It meets volumes the previous process destroyed.
    const second = restoreStack({
      buildSchema: MIGRATION_VERSION, startDestroyed: true,
      moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    });
    const report = runCompleteRestore(request(root, 'set-1'), depsFor(second), { kind: 'resume', confirm: plan.digest });
    assertEq(report.ok, true, `the resume completed: ${report.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
    assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), SECRET_VALUE,
      'the secrets directory holds the restored bytes');
    assertEq(existsSync(join(root, '.secrets.restoring-aaaaaaaaaaaa')), false, 'nothing is left in flight');
    assert(report.replaced.includes('.secrets.replaced-aaaaaaaaaaaa'),
      'and the previous contents are still named, so an abandon could put them back');
  });
}

test('a swap that landed onto an ABSENT target is recognised, not read as "nothing moved"', () => {
  // THE DEFECT THIS PINS. Landed-but-unrecorded was recognised only when BOTH a `.replaced-` and the target
  // existed — the shape a swap leaves when the target was ALREADY THERE. With an absent original there is no
  // `.replaced-` to find, so a completed swap left the target present, nothing in flight and nothing kept
  // aside, which the recovery read as "nothing moved" and retried — into a staging directory whose component
  // the placement had already moved out.
  const root = join(WORK, 'landed-onto-absent');
  mkdirSync(join(root, 'secrets'), { recursive: true });
  const source = makeProject('landed-onto-absent-source');
  const setDir = takeSet(source, 'set-1');
  mkdirSync(join(root, 'backups'), { recursive: true });
  copyDirectory(setDir, join(root, 'backups', 'set-1'));
  assertEq(existsSync(join(root, 'promotion-records')), false, 'the records target does not exist here');

  const req = request(root, 'set-1');
  const { plan } = planFor(req, false);
  const first = worldFor(setDir);
  let renames = 0;
  const dying = {
    ...depsFor(first),
    rename: (from: string, to: string): void => {
      renameSync(from, to);
      renames += 1;
      // 1-3 are the secrets swap; 4 and 5 are the records swap onto an ABSENT target (staged -> in flight,
      // in flight -> target). Fail immediately after the last one, before anything records it.
      if (renames === 5) throw new Error('injected failure after the placement landed');
    },
  };
  let thrown: unknown = null;
  try {
    runCompleteRestore(req, dying, { kind: 'run', confirm: plan.digest, acceptDataLoss: plan.digest });
  } catch (err) { thrown = err; }
  assert(thrown instanceof CompleteRestoreFailed, 'the run failed after the volumes had gone');

  // THE STATE: target present, nothing in flight, nothing kept aside — and no record of the swap.
  assert(existsSync(join(root, 'promotion-records', 'record-live.json')), 'the placement landed');
  assertEq(existsSync(join(root, '.promotion-records.restoring-aaaaaaaaaaaa')), false, 'nothing is in flight');
  assertEq(existsSync(join(root, '.promotion-records.replaced-aaaaaaaaaaaa')), false, 'nothing was kept aside');
  const journal = readRestoreJournal(root)!;
  assertEq(journal.swaps.some((swap) => swap.component === 'promotion-records'), false,
    'and the swap was never recorded');

  // THE RESUME RECOGNISES IT rather than retrying into empty staging.
  const second = restoreStack({
    buildSchema: MIGRATION_VERSION, startDestroyed: true,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  });
  const report = runCompleteRestore(req, depsFor(second), { kind: 'resume', confirm: plan.digest });
  assertEq(report.ok, true, `the resume completed: ${report.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assert(existsSync(join(root, 'promotion-records', 'record-live.json')), 'the placement is still there');
  assert(report.notes.some((note) => note.includes('nothing at that name to keep')),
    'and the report says the original had been absent');
});

test('a target holding something that is NOT this set\'s component is never accepted as landed', () => {
  // "LANDED" IS DECIDED BY WHAT IS AT THE TARGET, and a directory at that name is not evidence that this
  // operation put it there. It is compared against the component the manifest declares first.
  const root = makeProject('landed-verified');
  const setDir = takeSet(root, 'set-1');
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
  const { plan } = planFor(request(root, 'set-1'));
  const first = worldFor(setDir);
  let renames = 0;
  const dying = {
    ...depsFor(first),
    rename: (from: string, to: string): void => {
      renameSync(from, to);
      renames += 1;
      if (renames === 3) throw new Error('injected failure after the placement landed');
    },
  };
  try {
    runCompleteRestore(request(root, 'set-1'), dying, { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  } catch { /* expected */ }
  // Something rewrites the placed directory before the resume looks at it.
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'NOT THE SET\'S BYTES\n', 'utf8');

  const second = worldFor(setDir);
  let refused = false;
  try {
    runCompleteRestore(request(root, 'set-1'), depsFor(second), { kind: 'resume', confirm: plan.digest });
  } catch (err) {
    refused = (err as Error).message.includes('not the component this set declares')
      || (err as Error).message.includes('nothing verified to place');
  }
  assertEq(refused, true, 'a target that is not the declared component is refused, not accepted as landed');
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), 'NOT THE SET\'S BYTES\n',
    'and nothing was changed');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

test('every effectful step declares whether a returned failure needs recovery, and the executor uses it', () => {
  // THE ROUTING IS THE FIX, so it is asserted directly: a `failed` step whose policy is not a plain retry is
  // recovered exactly as a `running` one is.
  const source = readRepo('src/ops/complete-restore.ts');
  const routing = source.slice(source.indexOf('const needsRecovery ='), source.indexOf('if (interrupted !== undefined)'));
  assert(routing.includes("step.state === 'running'"), 'an interrupted step needs recovery');
  assert(routing.includes("step.state === 'failed'") && routing.includes("STEP_RECOVERY[step.id] !== 'retry'"),
    'AND SO DOES A RETURNED FAILURE whose effect cannot simply be repeated');
  // The three that matter are exactly the non-retry policies.
  const risky = RESTORE_STEP_IDS.filter((id) => STEP_RECOVERY[id] !== 'retry');
  assertEq([...risky].sort().join(','),
    'place-inline-keystore,place-promotion-records,place-secrets,place-sidecar-keystore,replay-database,'
    + 'safety-set',
    'the steps a returned failure must not simply repeat are the ones declared non-idempotent');
});


// ---------------------------------------------------------------------------------------------------------
// Safety-set provenance: an unrelated set is never adopted
// ---------------------------------------------------------------------------------------------------------

test('an unrelated valid set at the chosen name is NEVER adopted as this operation\'s safety set', () => {
  // THE DEFECT THIS PINS, AND IT IS THE WORST ONE IN THE COMMAND. Recovery adopted any set at the operator's
  // chosen safety-set name that VERIFIED. But `ops:complete-backup` REFUSES an existing set name — so "a
  // valid set already sits there" is precisely the condition under which this run's backup FAILS, and dying
  // just before that refusal leaves exactly the state the old check read as success. A resume then adopted a
  // stranger's backup as the only thing standing between this installation and unrecoverable loss, and
  // reported `safetySetVerified: true` about a set that had nothing to do with it.
  const root = makeProject('foreign-safety-set');
  const setDir = takeSet(root, 'set-1');
  // A perfectly valid, completely unrelated set already occupies the operator's chosen name.
  const stranger = takeSet(root, 'pre-restore-set-1');
  assert(verifyBackupSet(stranger).ok, 'the stranger\'s set is valid');
  const strangerDigest = digestTreeAt(stranger, 'the stranger\'s set').digest;

  const { plan } = planFor(request(root, 'set-1'));
  // Die inside the safety-set step, exactly as a process would that never reached the refusal.
  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'command:compose stop app' });
  assertEq(readRestoreJournal(root)!.steps.find((step) => step.id === 'safety-set')!.state, 'running',
    'the journal says the process was inside the safety-set step');

  const report = runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'resume', confirm: plan.digest });
  assertEq(report.ok, true, `the resume completed: ${report.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);

  // IT TOOK ITS OWN, AND LEFT THE STRANGER'S ALONE.
  assert(report.safetySet !== null && report.safetySet.startsWith('.pre-restore-claim-'),
    'the safety set it holds is the one IT published, inside its own claim');
  assert(report.safetySet !== 'pre-restore-set-1', 'and NOT the set that was already sitting at the base name');
  assert(report.safetySet !== null && existsSync(join(root, 'backups', report.safetySet)),
    'its own set is on disk, inside its own claim');
  assertEq(digestTreeAt(stranger, 'the stranger\'s set').digest, strangerDigest,
    'AND THE STRANGER\'S SET WAS NOT TOUCHED, adopted, replaced or removed');
});

test('a set this operation published is recognised on resume, and not taken twice', () => {
  const root = makeProject('own-safety-set');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'complete:safety-set' });
  const ours = publishedSafetySet(root);
  assert(existsSync(join(root, 'backups', ours)), 'the set this run published is on disk, inside its claim');
  const published = digestTreeAt(join(root, 'backups', ours), 'the published set').digest;

  const report = runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'resume', confirm: plan.digest });
  assertEq(report.steps.find((step) => step.id === 'safety-set')!.outcome, 'skipped',
    'it was recognised rather than retaken');
  assertEq(report.safetySetVerified, true, 'by VERIFYING it, not by finding a directory of that name');
  assertEq(digestTreeAt(join(root, 'backups', ours), 'the published set').digest, published,
    'and the set is byte-for-byte the one the first process published');
});

test('a claimed safety set whose final set is absent is simply taken again', () => {
  const root = makeProject('absent-safety-set');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'command:compose stop app' });
  assertEq(existsSync(join(root, 'backups', publishedSafetySet(root))), false,
    'the claim is there and empty: nothing was published into it');

  const report = runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'resume', confirm: plan.digest });
  assertEq(report.steps.find((step) => step.id === 'safety-set')!.outcome, 'held', 'the safety set was taken');
  assert(report.safetySet !== null && report.safetySet.startsWith('.pre-restore-claim-'),
    'inside a directory this run claimed');
  assert(report.notes.some((note) => note.includes('claimed somewhere to publish the safety set')
    || note.includes('before it had claimed anywhere')), 'and the report says why');
});

test('a partial or invalid set at this operation\'s own name is refused, not trusted and not replaced', () => {
  const root = makeProject('invalid-own-set');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'complete:safety-set' });
  // Something damages it before the resume looks.
  const damaged = publishedSafetySet(root);
  writeFileSync(join(root, 'backups', damaged, COMPONENT_ARTIFACT_NAMES.database), 'tampered\n', 'utf8');

  refuses(() => runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'resume', confirm: plan.digest }),
  'does NOT verify', 'a set that does not verify is refused');
  assert(existsSync(join(root, 'backups', damaged)), 'and it was NOT replaced or removed');
  assertEq(readRestoreJournal(root)!.steps.find((step) => step.id === 'safety-set')!.state, 'running',
    'and the journal is untouched by the refusal');
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});

test('the claim is an unguessable nonce and a directory this run created, not a name', () => {
  // A NAME — ANY NAME — IS NOT PROVENANCE. A deterministic one is PREDICTABLE, and an unrelated valid set
  // sitting at a predictable name is a state a name check cannot tell apart from "we published it".
  const root = makeProject('claim-shape');
  const setDir = takeSet(root, 'set-1');
  const { resolved, plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);
  const report = runCompleteRestore(request(root, 'set-1'), depsFor(world),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  assertEq(report.ok, true, 'the restore held');

  // THE SET IS INSIDE A CLAIMED DIRECTORY, and the nonce is 24 hex characters of real randomness.
  const claimed = report.safetySet!;
  assert(claimed.startsWith('.pre-restore-claim-'), 'the safety set is inside a claim directory');
  const nonce = claimed.slice('.pre-restore-claim-'.length, claimed.indexOf('/'));
  assert(SAFETY_CLAIM_NONCE_RE.test(nonce), 'whose nonce is twenty-four hex characters');
  assert(existsSync(join(root, 'backups', claimed)), 'and the set is really there');

  // A SECOND RUN OF THE SAME PLAN CLAIMS SOMEWHERE ELSE — which a plan-derived name could never do, and
  // which is exactly why a derived name cannot serve as provenance.
  const twin = makeProject('claim-shape-twin');
  const twinSet = takeSet(twin, 'set-1');
  const twinPlan = planFor(request(twin, 'set-1')).plan;
  const twinReport = runCompleteRestore(request(twin, 'set-1'), depsFor(worldFor(twinSet)),
    { kind: 'run', confirm: twinPlan.digest, acceptDataLoss: null });
  assert(twinReport.safetySet !== claimed, 'two runs claim different places');

  // AND THE PLAN SAYS WHAT WILL HAPPEN, without pretending to know the nonce in advance.
  const rendered = renderRestorePlan(resolved, plan);
  assert(rendered.includes('claims exclusively with mkdir under an unguessable nonce'),
    'the plan describes the claim');
  assert(rendered.includes('not merely that something valid sits at a predictable name'),
    'and says why a name would not do');
});
// ---------------------------------------------------------------------------------------------------------
// Mid-copy staging death, and a marker that authorises deletion
// ---------------------------------------------------------------------------------------------------------

for (const [component, artifact] of [
  ['database', COMPONENT_ARTIFACT_NAMES.database],
  ['secrets', COMPONENT_ARTIFACT_NAMES.secrets],
] as const) {
  test(`a REAL death while copying the ${component} component leaves a CLAIMED tree the same operation rebuilds`, () => {
    // THE DEFECT THIS PINS. The marker used to be written LAST, so a process that died DURING the copy left
    // an UNMARKED tree at a predictable name — and "an unmarked tree is not ours" then meant the next resume
    // could neither trust it nor remove it. Every resume refused, and the only way out was an operator
    // deleting a directory full of secrets by hand.
    const root = makeProject(`mid-copy-${component}`);
    const setDir = takeSet(root, 'set-1');
    const { plan } = planFor(request(root, 'set-1'));
    crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
      crashAt: `staging:${component}` });

    const staging = join(root, '.catalog-restore.staged-aaaaaaaaaaaa');
    assert(existsSync(staging), 'the half-built tree is on disk');
    assert(existsSync(join(staging, artifact)), `and the ${component} component is part of it`);
    // THE CLAIM IS THERE, BECAUSE IT IS WRITTEN BEFORE A SINGLE BYTE IS COPIED.
    const marker = JSON.parse(readFileSync(join(staging, 'catalog-restore-staging.json'), 'utf8')) as
      { state: string; planDigest: string; suffix: string };
    assertEq(marker.state, 'claimed', 'the tree is CLAIMED — not sealed, because the copy never finished');
    assertEq(marker.planDigest, plan.digest, 'and the claim names this operation');
    assertEq(readRestoreJournal(root)!.steps.find((step) => step.id === 'stage-components')!.state, 'running',
      'and the journal says the process was inside the staging step');

    // THE RESUME REBUILDS IT — which it may, because the claim proves the tree is this operation's.
    const report = runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
      { kind: 'resume', confirm: plan.digest });
    assertEq(report.ok, true, `the resume completed: ${report.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
    assertEq(existsSync(staging), false, 'and the staging tree is gone once the restore completed');
  });
}

test('a claimed-but-unsealed tree is never CONSUMED, only rebuilt', () => {
  // `claimed` says whose the tree is. `sealed` says its contents were all copied and verified. Only a sealed
  // tree may be placed or replayed — a half-copied keystore that happened to digest correctly for the one
  // component reached must not be installable.
  const root = makeProject('claimed-not-sealed');
  const setDir = takeSet(root, 'set-1');
  const { resolved, plan } = planFor(request(root, 'set-1'));
  const staging = join(root, '.catalog-restore.staged-aaaaaaaaaaaa');
  const sealed = stageComponents(resolved, staging, plan, 'aaaaaaaaaaaa');
  assertEq(sealed, null, 'a full staging seals');
  assertEq(verifyOwnedStaging(staging, plan, 'aaaaaaaaaaaa', resolved.manifest, ['secrets']), null,
    'and a sealed tree is usable');

  // Roll it back to claimed, as a mid-copy death leaves it.
  const path = join(staging, 'catalog-restore-staging.json');
  const marker = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify({ ...marker, state: 'claimed' })}\n`, 'utf8');
  const refusal = verifyOwnedStaging(staging, plan, 'aaaaaaaaaaaa', resolved.manifest, ['secrets']);
  assert(refusal !== null && refusal.includes('CLAIMED but not sealed'),
    'a claimed tree is refused for consumption');
  rmSync(staging, { recursive: true, force: true });
});

test('a marker that does not prove ownership NEVER authorises removal — including a malformed matching one', () => {
  // THIS DOCUMENT DECIDES WHETHER A DIRECTORY OF SECRETS IS RECURSIVELY DELETED. A shape check that only
  // asked "is this an object naming the right plan" would let a malformed-but-matching document authorise
  // both deletion and installation.
  const root = makeProject('marker-guard');
  const setDir = takeSet(root, 'set-1');
  const { resolved, plan } = planFor(request(root, 'set-1'));
  const staging = join(root, '.catalog-restore.staged-aaaaaaaaaaaa');
  stageComponents(resolved, staging, plan, 'aaaaaaaaaaaa');
  const path = join(staging, 'catalog-restore-staging.json');
  const good = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const canary = join(staging, 'canary');
  writeFileSync(canary, 'must survive every refusal\n', 'utf8');

  const put = (patch: Record<string, unknown> | null): void => {
    if (patch === null) rmSync(path);
    else writeFileSync(path, `${JSON.stringify({ ...good, ...patch })}\n`, 'utf8');
  };
  const components = good.components as Array<Record<string, unknown>>;
  // TWO BARS, DELIBERATELY DIFFERENT. Removing a tree needs OWNERSHIP: this operation's plan and suffix, in
  // a document whose every field is canonical. USING its contents needs more — agreement with the backup
  // manifest. A merely manifest-inconsistent marker is still provably ours, and must stay removable, or a
  // mid-copy death would wedge the project all over again.
  const cases: Array<[Record<string, unknown> | null, string, 'unowned' | 'inconsistent']> = [
    [null, 'no claim at all', 'unowned'],
    [{ planDigest: 'f'.repeat(64) }, 'another operation\'s claim', 'unowned'],
    [{ suffix: 'ffffffffffff' }, 'another run\'s suffix', 'unowned'],
    [{ state: 'sideways' }, 'a state this build does not have', 'unowned'],
    [{ components: 'not a list' }, 'components that are not a list', 'unowned'],
    [{ components: [{ ...components[0], id: 'not-a-component' }] }, 'an unknown component id', 'unowned'],
    [{ components: [components[0], components[0]] }, 'one component named twice', 'unowned'],
    [{ components: components.map((c) => ({ ...c, artifact: 'somewhere-else' })) }, 'a non-canonical artifact name', 'unowned'],
    [{ components: components.map((c) => ({ ...c, digest: 'not-a-digest' })) }, 'a digest that is not one', 'unowned'],
    [{ components: components.map((c) => ({ ...c, digest: 'A'.repeat(64) })) }, 'a digest in the wrong case', 'unowned'],
    [{ components: components.map((c) => ({ ...c, entries: -1 })) }, 'a negative count', 'unowned'],
    [{ components: components.map((c) => ({ ...c, bytes: 1.5 })) }, 'a fractional byte count', 'unowned'],
    [{ components: components.map((c) => ({ ...c, bytes: Number.MAX_VALUE })) }, 'a count outside safe integers', 'unowned'],
    [{ components: components.slice(1) }, 'fewer components than the set declares', 'inconsistent'],
    [{ components: components.map((c) => ({ ...c, digest: 'b'.repeat(64) })) }, 'digests the manifest disagrees with', 'inconsistent'],
  ];
  for (const [patch, why, bar] of cases) {
    put(patch);
    const owned = readStagingMarker(staging, plan.digest, 'aaaaaaaaaaaa', resolved.manifest);
    assert('refusal' in owned, `refused: ${why}`);
    // AND NOTHING WAS REMOVED BY THE REFUSAL.
    if (bar === 'unowned') {
      const removal = removeOwnedStaging(staging,
        { planDigest: plan.digest, suffix: 'aaaaaaaaaaaa' } as unknown as RestoreJournal);
      assert(removal !== null, `and removal is refused too: ${why}`);
      assert(existsSync(canary), `and the directory survives: ${why}`);
    }
  }
  // THE GOOD ONE STILL WORKS, so the guard is not simply refusing everything.
  put({});
  assert(!('refusal' in readStagingMarker(staging, plan.digest, 'aaaaaaaaaaaa', resolved.manifest)),
    'the marker this command wrote is accepted');
  rmSync(staging, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------------------------------------
// The direction of travel is persisted, and exclusive
// ---------------------------------------------------------------------------------------------------------

test('an abandon that stalls part way keeps the project ABANDONING: no resume may rebuild over it', () => {
  // THE DEFECT THIS PINS. An abandon could unwind one target, fail on another, remove the staging tree and
  // leave the restore's own step states behind — and a `--resume` arriving next read those step states and
  // REBUILT THE RESTORE ON TOP OF THE UNWIND, placing components back over directories an operator had just
  // asked to have returned. Nothing anywhere recorded that a decision to abandon had been made.
  const root = makeProject('abandon-exclusive');
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
  assertEq(journal.phase, 'restoring', 'the interrupted restore is a RESTORE');
  assertEq(journal.swaps.length, 2, 'and it swapped two targets');

  // THE SECOND SWAP CANNOT BE PUT BACK: something took what it had moved aside.
  const records = journal.swaps.find((swap) => swap.component === 'promotion-records')!;
  rmSync(join(root, records.replaced!), { recursive: true, force: true });

  const first = abandonRestore(root);
  assertEq(first.ok, false, 'the abandon could not finish');
  assert(first.restored.includes('secrets'), 'it unwound the one it could');
  assert(first.unresolved.includes('promotion-records'), 'and named the one it could not');

  // THE PROJECT IS NOW EXPLICITLY ABANDONING.
  const midway = readRestoreJournal(root)!;
  assertEq(midway.phase, 'abandoning', 'THE DIRECTION IS RECORDED');
  assert(existsSync(join(root, '.catalog-restore.staged-aaaaaaaaaaaa')),
    'and the staging tree is still here, because a swap is still out of place');

  // A RUN AND A RESUME BOTH REFUSE, WITH ZERO EFFECTS.
  const watcher = restoreStack({
    buildSchema: MIGRATION_VERSION, startDestroyed: true,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  });
  let renames = 0;
  const watching = {
    ...depsFor(watcher),
    rename: (from: string, to: string): void => { renames += 1; renameSync(from, to); },
  };
  const before = readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8');
  refuses(() => runCompleteRestore(request(root, 'set-1'), watching, { kind: 'resume', confirm: plan.digest }),
    'being ABANDONED, not restored', 'a resume refuses over an abandon');
  refuses(() => runCompleteRestore(request(root, 'set-1'), watching,
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null }),
  'part way through a restore', 'and so does a fresh run');
  assertEq(renames, 0, 'NEITHER PERFORMED A SINGLE RENAME');
  assertEq(watcher.ledger.all().length, 0, 'nor issued a single command');
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), before,
    'and the unwound target is exactly as the abandon left it');

  // ONLY ANOTHER ABANDON CONTINUES. Put back what was taken, and finish.
  mkdirSync(join(root, records.replaced!), { recursive: true });
  writeFileSync(join(root, records.replaced!, 'record-later.json'), '{"later":1}\n', 'utf8');
  const second = abandonRestore(root);
  assertEq(second.ok, true, 'the second abandon finished');
  assert(existsSync(join(root, 'promotion-records', 'record-later.json')), 'the second target is back');

  // EVERY ABANDONED COPY ON DISK IS NAMED.
  const onDisk = readdirSync(root).filter((entry) => entry.includes('.abandoned-'));
  assert(onDisk.length > 0, 'there are abandoned copies on disk');
  for (const name of onDisk) {
    assert(second.retained.includes(name), `${name} is named in the report`);
  }
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), false, 'and the journal clears only at the true end');
});

test('an already-undone swap whose original EXISTED still has its abandoned copy named', () => {
  // THE DEFECT THIS PINS. Only the `replaced === null` branch reported a retained copy. A swap whose original
  // target HAD existed leaves an `.abandoned-` copy too — and an earlier attempt that finished it left that
  // copy on disk with nothing naming it: a directory of the installation's secrets no report mentioned.
  const root = makeProject('retained-reporting');
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
  const records = journal.swaps.find((swap) => swap.component === 'promotion-records')!;
  assert(records.replaced !== null, 'the records target HAD existed, so something was kept aside');

  // A first abandon finishes the secrets swap and stalls on the records one.
  rmSync(join(root, records.replaced!), { recursive: true, force: true });
  const first = abandonRestore(root);
  assertEq(first.ok, false, 'it stalled');
  const secretsCopy = first.retained.find((name) => name.includes('secrets'));
  assert(secretsCopy !== undefined && existsSync(join(root, secretsCopy)),
    'and the copy it set aside for the FINISHED swap is on disk and named');

  // The second attempt must name it again — it is still there, and it still holds secrets.
  mkdirSync(join(root, records.replaced!), { recursive: true });
  writeFileSync(join(root, records.replaced!, 'r.json'), '{}\n', 'utf8');
  const second = abandonRestore(root);
  assertEq(second.ok, true, 'the second abandon finished');
  assert(second.retained.includes(secretsCopy!),
    'AND THE ALREADY-UNDONE SWAP\'S ABANDONED COPY IS STILL NAMED, because it is still on disk');
  assert(second.notes.some((note) => note.includes('hold secret material')), 'and said what it holds');
});

test('CRASH at the abandon phase transition is recoverable by another abandon', () => {
  // The window between "an operator asked to abandon" and "anything on disk says so". A process that dies
  // here has performed no rename at all, and the next abandon simply starts.
  const root = makeProject('abandon-phase-crash');
  const setDir = takeSet(root, 'set-1');
  writeFileSync(join(root, 'secrets', 'custodian_kek'), 'a-later-value\n', 'utf8');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'phase:abandoning', operation: 'abandon' });
  assertEq(readRestoreJournal(root)!.phase, 'abandoning', 'the direction reached disk before the death');
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), SECRET_VALUE,
    'and no rename had happened yet');

  // A RESUME IS ALREADY REFUSED, and another abandon finishes.
  refuses(() => runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'resume', confirm: plan.digest }),
  'being ABANDONED, not restored', 'the recorded direction is already binding');
  const report = abandonRestore(root);
  assertEq(report.ok, true, 'another abandon finished it');
  assertEq(readFileSync(join(root, 'secrets', 'custodian_kek'), 'utf8'), 'a-later-value\n',
    'and the original contents are back');
});


// ---------------------------------------------------------------------------------------------------------
// Mutation DURING consumption, and the rewind it forces
// ---------------------------------------------------------------------------------------------------------
//
// Two steps verify a component and then hand a PATHNAME to another process. Verifying before that proves
// what was there a moment before the child opened it — nothing about what the child actually read. These
// inject the mutation from INSIDE the runner, which is the window itself.

test('a dump rewritten WHILE psql reads it stops the run, and the resume rewinds the whole database leg', () => {
  const root = makeProject('mutate-during-replay');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const first = worldFor(setDir);
  const staged = join(root, '.catalog-restore.staged-aaaaaaaaaaaa', COMPONENT_ARTIFACT_NAMES.database);
  const meddling = {
    ...depsFor(first),
    fileRunner: (command: Parameters<typeof first.inputRunner>[0], source: string) => {
      const outcome = first.inputRunner(command, source);
      // The bytes change inside the window between the check and the child's read.
      writeFileSync(staged, `${fakeDumpText(MIGRATION_VERSION)}-- rewritten mid-read\n`, 'utf8');
      return outcome;
    },
  };
  let thrown: unknown = null;
  try {
    runCompleteRestore(request(root, 'set-1'), meddling, { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  } catch (err) { thrown = err; }
  assert(thrown instanceof CompleteRestoreFailed, 'the volumes were destroyed and the replay then failed');
  const report = (thrown as CompleteRestoreFailed).report;
  const replay = report.steps.find((step) => step.id === 'replay-database')!;
  assertEq(replay.outcome, 'failed', 'the replay step did not hold');
  assert(replay.detail!.includes('WHILE psql was reading it'), 'and says the change happened during the read');

  // THE RUN STOPPED THERE. Nothing after it was attempted.
  for (const later of ['place-inline-keystore', 'stack-up', 'prove-version', 'prove-decrypt'] as const) {
    const step = report.steps.find((entry) => entry.id === later);
    assert(step === undefined || step.outcome !== 'held', `${later} was NOT run over an unknown database`);
  }
  assertEq(first.state().stackUp, false, 'and the stack was never booted over it');

  // THE RESUME REWINDS THE WHOLE LEG — including the STAGING, because the staged artifact is the thing that
  // changed. Rebuilding the leg without rebuilding it would replay the same suspect bytes again.
  const second = worldFor(setDir);
  const resumed = runCompleteRestore(request(root, 'set-1'), depsFor(second), { kind: 'resume', confirm: plan.digest });
  assertEq(resumed.ok, true, `the resume completed: ${resumed.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assertEq(second.teardowns(), 1, 'THE VOLUMES WERE DESTROYED AGAIN before anything was replayed');
  assertEq(resumed.steps.find((step) => step.id === 'stop-and-destroy')!.outcome, 'held', 'the teardown ran again');
  assertEq(resumed.steps.find((step) => step.id === 'database-up')!.outcome, 'held', 'into a fresh database');
  assertEq(second.replays().length, 1, 'and exactly ONE replay landed — nothing was stacked');
});

test('a keystore rewritten WHILE compose cp reads it stops the run, and the resume rebuilds the volume', () => {
  const root = makeProject('mutate-during-cp');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const first = worldFor(setDir);
  const stagedKeystore = join(root, '.catalog-restore.staged-aaaaaaaaaaaa', COMPONENT_ARTIFACT_NAMES.keystore);
  const meddling = {
    ...depsFor(first),
    runner: (command: Parameters<typeof first.runner>[0]) => {
      const outcome = first.runner(command);
      const last = command.args[command.args.length - 1] ?? '';
      if (command.args.includes('cp') && last.startsWith('app:')) {
        // The tree changes inside the window the container is reading it.
        writeFileSync(join(stagedKeystore, 'slipped-in'), 'not in the manifest\n', 'utf8');
      }
      return outcome;
    },
  };
  let thrown: unknown = null;
  try {
    runCompleteRestore(request(root, 'set-1'), meddling, { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  } catch (err) { thrown = err; }
  assert(thrown instanceof CompleteRestoreFailed, 'the volumes were destroyed and the copy then failed');
  const report = (thrown as CompleteRestoreFailed).report;
  const place = report.steps.find((step) => step.id === 'place-inline-keystore')!;
  assertEq(place.outcome, 'failed', 'the placement did not hold');
  assert(place.detail!.includes('WHILE it was being copied into the container'),
    'and says the change happened during the copy');
  assertEq(first.state().stackUp, false, 'AND THE STACK WAS NEVER BOOTED over unknown key material');

  // THE RESUME REWINDS: a partially-copied volume is not repaired by copying again over the top.
  const second = worldFor(setDir);
  const resumed = runCompleteRestore(request(root, 'set-1'), depsFor(second), { kind: 'resume', confirm: plan.digest });
  assertEq(resumed.ok, true, `the resume completed: ${resumed.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);
  assertEq(second.teardowns(), 1, 'THE VOLUMES WERE DESTROYED AGAIN, emptying the keystore volume');
  assertEq(resumed.steps.find((step) => step.id === 'place-inline-keystore')!.outcome, 'held',
    'and the keystore was placed into an empty volume, not over a partial copy');
  assertEq(second.state().keystore, setKeystoreDigest(setDir), 'which now holds exactly the set\'s keystore');
  assert(resumed.notes.some((note) => note.includes('cannot be repeated or repaired')),
    'and the report says why the leg was repeated');
});


// ---------------------------------------------------------------------------------------------------------
// Case variants identify the same directory where the filesystem says they do
// ---------------------------------------------------------------------------------------------------------

test('a case variant of a component target overlaps it where the host filesystem says so', () => {
  // ON WINDOWS `SECRETS` AND `secrets` ARE ONE DIRECTORY, and the guard that stops two components naming one
  // directory compared strings. Explicit semantics are unit-tested on every platform; the real behaviour is
  // exercised through the resolver below on whichever host this runs on.
  assertEq(pathsOverlap('/p/secrets', '/p/SECRETS', true), true, 'case-insensitive: the same directory');
  assertEq(pathsOverlap('/p/secrets', '/p/SECRETS', false), false, 'case-sensitive: two directories');
  assertEq(pathsOverlap('/p/a', '/p/A/b', true), true, 'case-insensitive containment');
  assertEq(pathsOverlap('/p/a', '/p/A/b', false), false, 'and none when case matters');
  // WHOLE SEGMENTS STILL, in both modes: `a/bc` is not inside `a/b`.
  for (const folded of [true, false]) {
    assertEq(pathsOverlap('/p/a/bc', '/p/a/b', folded), false, `whole-segment prefix holds (folded=${folded})`);
    assertEq(pathsOverlap('/p/ab', '/p/a', folded), false, `and a sibling is not a child (folded=${folded})`);
  }
  assertEq(HOST_PATHS_ARE_CASE_INSENSITIVE, process.platform === 'win32' || process.platform === 'darwin',
    'and the default follows the host');
});

test('on a case-insensitive host, case variants are refused as overlapping targets and reserved paths', () => {
  // REAL BEHAVIOUR, through the shipped resolver. On a case-sensitive host these are genuinely different
  // directories and the resolution is expected to succeed — which is the correct answer there.
  const root = makeProject('case-overlap');
  takeSet(root, 'set-1');
  mkdirSync(join(root, 'nest'), { recursive: true });
  writeFileSync(join(root, 'nest', 'x'), 'x\n', 'utf8');

  const cases: Array<[Partial<CompleteRestoreRequest>, string, string]> = [
    [{ secrets: 'nest', promotionRecords: 'NEST' }, 'at the same directory, or at one inside the other',
      'two components, one directory, two spellings'],
    [{ secrets: 'nest', promotionRecords: 'NEST/inner' }, 'at the same directory, or at one inside the other',
      'a records target inside the secrets target, spelled differently'],
    [{ secrets: 'BACKUPS' }, 'containing it or inside it', 'the backup destination in another case'],
    [{ secrets: 'Backups/Set-1' }, 'containing it or inside it', 'the set being restored in another case'],
  ];
  for (const [over, needle, why] of cases) {
    if (HOST_PATHS_ARE_CASE_INSENSITIVE) {
      refuses(() => resolveCompleteRestoreRequest(request(root, 'set-1', over)), needle, why);
    } else {
      // On a case-sensitive host these name different directories; refusing them would be wrong.
      let refused = false;
      try { resolveCompleteRestoreRequest(request(root, 'set-1', over)); } catch { refused = true; }
      assertEq(refused && needle.length > 0, refused, `${why}: whatever happens here, it is not a crash`);
    }
  }
  assertEq(existsSync(join(root, RESTORE_JOURNAL_NAME)), false, 'and nothing was created by the attempts');
  assertEq(existsSync(join(root, MAINTENANCE_LOCK_DIRNAME)), false, 'no lock either');
});

test('a component target that is a case variant of a maintenance-owned path is refused', () => {
  // The journal and the lock live at fixed names in the project root. A target spelled in another case would,
  // on Windows, be the same file or directory.
  const journal = join('/p', RESTORE_JOURNAL_NAME);
  const lock = join('/p', MAINTENANCE_LOCK_DIRNAME);
  assertEq(pathsOverlap(journal.toUpperCase(), journal, true), true, 'the journal, in another case');
  assertEq(pathsOverlap(lock.toUpperCase(), lock, true), true, 'the lock, in another case');
  assertEq(pathsOverlap(join('/p', 'x'), journal, true), false, 'and an unrelated name still does not overlap');
});

// ---------------------------------------------------------------------------------------------------------
// The journal reader rejects combinations no operation can produce
// ---------------------------------------------------------------------------------------------------------

test('impossible phase, claim and step combinations are refused before anything acts on them', () => {
  const root = makeProject('journal-matrix');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
    failWhen: [{ contains: 'ops:collections -- history', status: 1 }],
  });
  runCompleteRestore(request(root, 'set-1'), depsFor(world), { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  const good = readRestoreJournal(root)!;
  const put = (patch: Record<string, unknown>): void => {
    writeFileSync(join(root, RESTORE_JOURNAL_NAME), `${JSON.stringify({ ...good, ...patch })}\n`, 'utf8');
  };

  // THE VERSION MOVED, so a journal from the previous build is refused rather than half-understood.
  assertEq(RESTORE_JOURNAL_VERSION, 4, 'the journal version reflects the fields that were added');
  put({ version: 3 });
  refuses(() => readRestoreJournal(root), 'not one this build writes', 'a previous version is refused');

  for (const [patch, needle, why] of [
    [{ phase: 'sideways' }, 'phase is not one this build has', 'a direction this build does not have'],
    [{ phase: null }, 'phase is not one this build has', 'no direction at all'],
    [{ safetySetClaim: { nonce: 'zz', created: true } }, 'nonce is not the twenty-four hex', 'a claim nonce that is not one'],
    [{ safetySetClaim: { nonce: 'a'.repeat(24), created: 1 } }, 'does not say whether it was created', 'a claim with no creation fact'],
    [{ evidence: { ...good.evidence, safetySetVerified: true, safetySetTaken: false } },
      'verified that was never taken', 'evidence that contradicts itself'],
    [{ safetySetPlanned: false }, 'never planned', 'evidence of a safety set this operation never planned'],
  ] as Array<[Record<string, unknown>, string, string]>) {
    put(patch);
    refuses(() => readRestoreJournal(root), needle, why);
  }

  // AND EVERY GENUINE CRASH STATE IS ACCEPTED. These are the shapes real runs leave.
  for (const [patch, why] of [
    [{ phase: 'restoring' }, 'an interrupted restore'],
    [{ phase: 'abandoning' }, 'an interrupted abandon'],
    [{ steps: good.steps.map((s) => (s.id === 'prove-doctor' ? { ...s, state: 'running', detail: null } : s)) },
      'a step the process died inside'],
  ] as Array<[Record<string, unknown>, string]>) {
    put(patch);
    assert(readRestoreJournal(root) !== null, `accepted: ${why}`);
  }
  rmSync(join(root, RESTORE_JOURNAL_NAME));
});


test('a valid set sitting at the PREDICTED location is never adopted, because the claim is not a name', () => {
  // -------------------------------------------------------------------------------------------------
  // THE TEST THE DERIVED NAME COULD NOT PASS.
  // -------------------------------------------------------------------------------------------------
  //
  // The first attempt at provenance published to `<base>.<twelve hex of the plan digest>` and argued that no
  // other operation could produce that name. The argument was wrong in the way that matters: the plan digest
  // is DETERMINISTIC, so the name is PREDICTABLE — and an ordinary sequence puts a valid, unrelated set at
  // it. Run the restore, abandon it, leave its safety set behind; run the SAME restore again and die inside
  // the safety-set step before `ops:complete-backup` refuses the existing name. The set now sitting there is
  // a backup of the installation as it was before the FIRST run: a different moment. A recovery that adopts
  // it hands the operator a "safety set" that does not describe what is about to be destroyed.
  //
  // This reproduces exactly that, and asserts the second run publishes its OWN.
  const root = makeProject('predicted-location');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));

  // A valid set is placed at every location a NAME-BASED scheme would have predicted: the operator's chosen
  // base name, and the plan-derived name the first attempt used.
  const strangers: string[] = [];
  for (const predicted of ['pre-restore-set-1', `pre-restore-set-1.${operationSuffix(plan.digest)}`]) {
    const source = takeSet(root, `donor-${strangers.length}`);
    copyDirectory(source, join(root, 'backups', predicted));
    assert(verifyBackupSet(join(root, 'backups', predicted)).ok, `the set at ${predicted} is VALID`);
    strangers.push(predicted);
  }
  const before = strangers.map((name) => digestTreeAt(join(root, 'backups', name), 'a stranger\'s set').digest);

  // Die inside the safety-set step, before the backup could reject anything.
  crashAt({ projectRoot: root, setDir, setName: 'set-1', confirm: plan.digest, suffix: 'aaaaaaaaaaaa',
    crashAt: 'command:compose stop app' });
  assertEq(readRestoreJournal(root)!.steps.find((step) => step.id === 'safety-set')!.state, 'running',
    'the journal says the process was inside the safety-set step');

  const report = runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'resume', confirm: plan.digest });
  assertEq(report.ok, true, `the resume completed: ${report.steps.filter((s) => s.outcome === 'failed').map((s) => s.detail).join('; ')}`);

  // IT ADOPTED NEITHER. Its own set is inside a directory it created under a nonce nothing could predict.
  assert(report.safetySet !== null && report.safetySet.startsWith('.pre-restore-claim-'),
    'the safety set it holds is inside its own claim');
  for (const predicted of strangers) {
    assert(!report.safetySet!.startsWith(predicted), `it did not adopt the set at ${predicted}`);
  }
  assertEq(report.steps.find((step) => step.id === 'safety-set')!.outcome, 'held',
    'it TOOK a safety set rather than recognising one');
  for (const [index, name] of strangers.entries()) {
    assertEq(digestTreeAt(join(root, 'backups', name), 'a stranger\'s set').digest, before[index],
      `and the set at ${name} was not touched, adopted, replaced or removed`);
  }
});

test('a claim directory somebody else created is not adopted: the run claims elsewhere', () => {
  // THE CLAIM IS THE `mkdir`, WHICH SUCCEEDS FOR EXACTLY ONE PARTY. A directory that already exists was not
  // created by this run — whoever put it there and whatever is inside it — so the run draws another nonce
  // rather than publishing into, or adopting from, somebody else's space.
  const root = makeProject('occupied-claim');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));

  // Occupy a claim directory and fill it with a perfectly valid set under the name this run would use.
  const squatted = safetySetClaimDirName('f'.repeat(24));
  const donor = takeSet(root, 'donor');
  mkdirSync(join(root, 'backups', squatted), { recursive: true });
  copyDirectory(donor, join(root, 'backups', squatted, 'pre-restore-set-1'));
  const squattedDigest = digestTreeAt(join(root, 'backups', squatted), 'the squatted claim').digest;

  const report = runCompleteRestore(request(root, 'set-1'), depsFor(worldFor(setDir)),
    { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  assertEq(report.ok, true, 'the restore held');
  assert(report.safetySet !== null && !report.safetySet.startsWith(squatted),
    'it claimed somewhere else entirely');
  assertEq(digestTreeAt(join(root, 'backups', squatted), 'the squatted claim').digest, squattedDigest,
    'and the occupied directory was not touched');
});

test('a claim recorded but never created sends the run to a fresh one, adopting nothing', () => {
  // The window between `mkdir` returning and the journal recording it. A crash there leaves a directory
  // nothing claims — and the honest recovery is a NEW nonce, because "we created it" is exactly what this
  // run can no longer establish about the old one.
  const root = makeProject('claim-not-created');
  const setDir = takeSet(root, 'set-1');
  const { plan } = planFor(request(root, 'set-1'));
  const world = worldFor(setDir);
  runCompleteRestore(request(root, 'set-1'), {
    ...depsFor(world),
    runner: (command: Parameters<typeof world.runner>[0]) => world.runner(command),
  }, { kind: 'run', confirm: plan.digest, acceptDataLoss: null });

  // A journal whose claim was never confirmed created is the shape that crash leaves.
  const orphan = safetySetClaimDirName('e'.repeat(24));
  mkdirSync(join(root, 'backups', orphan), { recursive: true });
  const second = makeProject('claim-not-created-2');
  const secondSet = takeSet(second, 'set-1');
  const secondPlan = planFor(request(second, 'set-1')).plan;
  const secondWorld = worldFor(secondSet);
  const secondReport = runCompleteRestore(request(second, 'set-1'), depsFor(secondWorld),
    { kind: 'run', confirm: secondPlan.digest, acceptDataLoss: null });
  assert(secondReport.safetySet !== null && secondReport.safetySet.startsWith('.pre-restore-claim-'),
    'a fresh run claims its own place');
  assert(existsSync(join(root, 'backups', orphan)), 'and an orphaned claim is left alone, not reused');
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
