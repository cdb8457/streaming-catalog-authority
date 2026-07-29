import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_VERSION } from '../src/db/schema-version.js';
import { REQUIRED_SECRET_FILES } from '../src/ops/backup-components.js';
import { COMPONENT_ARTIFACT_NAMES, runCompleteBackup, type CompleteBackupRequest } from '../src/ops/complete-backup.js';
import {
  FLOATING_TAGS,
  REHEARSAL_IMPORT_NAME,
  REHEARSAL_MARKER_NAME,
  REHEARSAL_OVERRIDE_NAMES,
  REHEARSAL_PROJECT_PREFIX,
  REHEARSAL_RESTORE_DIRNAME,
  assertImmutableImageRef,
  claimDisposableRoot,
  digestConfirmed,
  planRehearsal,
  planRehearsalCommands,
  readNpmVersion,
  readSchemaVersions,
  referenceDigest,
  rehearsalCleanupCommand,
  rehearsalPlanDigest,
  renderRehearsal,
  resolveRehearsal,
  runRehearsal,
  type RehearsalRequestWithConfirmation,
} from '../src/ops/upgrade-rehearsal.js';
import { assertPermittedCommand } from '../src/ops/maintenance-safety.js';
import { parseRehearsalArgs } from '../src/ops/upgrade-rehearsal-cli.js';
import {
  assertLedgerIsClean,
  fakeDoctorJson,
  fakeDumpText,
  fakeToolchain,
  rehearsalProblems,
  rehearsalWorld,
  type RehearsalWorldOptions,
} from './helpers/fake-toolchain.js';

// Phases 279-280 — the disposable upgrade rehearsal, and the rollback that makes an upgrade reversible.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - IT RUNS SOMEWHERE ELSE, PROVED FIVE WAYS: a marker FILE binding the root to one project and one plan, a
//     marker-bearing project name, a disposable root that is neither production nor inside it nor containing
//     it, a project name that is not production's, and every command's `cwd` in the disposable root.
//   - THE UPGRADE IS REALLY AN UPGRADE. Two different images are SELECTED — through override files this
//     product writes — and the rollback puts the first one back.
//   - ALL FOUR COMPONENTS ARE RESTORED, from a workspace prepared out of a set that is never written to.
//   - VERSIONS ARE READ AND COMPARED, never inferred from a tag, on every leg.
//   - THE REPRESENTATIVE WORK REALLY RUNS: an import preview, an apply, a replay after the migration, the
//     durable history, and a catalog read that must decrypt.
//   - IMAGES ARE IMMUTABLE. `latest` and its friends are refused by name, a bare repository is refused, and a
//     digest is accepted.
//   - NOTHING RUNS WITHOUT THE EXACT PLAN DIGEST, and nothing runs without a backup set that verifies NOW.
//   - A FAILED STEP KEEPS THE EVIDENCE AND REMOVES NOTHING; a cleanup runs only while the marker still binds
//     the root to this exact rehearsal, and names only this rehearsal's own project.
//   - THE EVIDENCE IS REDACTED: reference digests and closed version words, never a reference, a version
//     string, a doctor detail, a host path or a runner's message.
//   - THE LEDGER CONTAINS NO PULL, NO REGISTRY, NO MEDIA PATH, NO MEDIA SERVER AND NO ACQUISITION COMMAND.

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
    assert((err as Error).message.includes(needle), `${msg}: expected "${needle}", got: ${(err as Error).message}`);
    return;
  }
  throw new Error(`${msg}: nothing was refused`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').split('\r\n').join('\n');

const WORK = mkdtempSync(join(tmpdir(), 'ca-rehearsal-'));
const CURRENT = 'catalog-authority-ops:v1.1.3';
const CANDIDATE = 'catalog-authority-ops:v1.1.4';
const CURRENT_VERSION = '1.1.3';
const CANDIDATE_VERSION = '1.1.4';
/** The set is taken at the CURRENT build's schema; the candidate migrates past it. */
const SET_SCHEMA = MIGRATION_VERSION;
const CANDIDATE_SCHEMA = MIGRATION_VERSION + 1;
const COMPOSE_FILE = 'compose.yml';
const SECRET_VALUE = 'a-kek-value-that-must-never-reach-any-rehearsal-report';

interface World {
  readonly production: string;
  readonly disposable: string;
  readonly backupSet: string;
  readonly importSnapshot: string;
}

/** A production project with a verified backup set in it, and a disposable root beside it. */
function makeWorld(name: string): World {
  const world = join(WORK, name);
  const production = join(world, 'production');
  const disposable = join(world, 'disposable');
  mkdirSync(join(production, 'secrets'), { recursive: true });
  mkdirSync(join(production, 'promotion-records'), { recursive: true });
  mkdirSync(disposable, { recursive: true });
  for (const file of REQUIRED_SECRET_FILES) {
    writeFileSync(join(production, 'secrets', file), file === 'custodian_kek' ? SECRET_VALUE : `${file}\n`, 'utf8');
  }
  writeFileSync(join(production, 'promotion-records', 'r.json'), '{}\n', 'utf8');
  // The operator's own definition for the disposable stack. This product overrides it and never writes it.
  writeFileSync(join(disposable, COMPOSE_FILE), 'services:\n  postgres: {}\n  app: {}\n', 'utf8');
  const importSnapshot = join(world, 'representative-import.json');
  writeFileSync(importSnapshot, '{"records":[{"title":"a representative record"}]}\n', 'utf8');

  const request: CompleteBackupRequest = {
    projectRoot: production, destination: 'backups', setName: 'set-1', custodian: 'inline',
    secrets: 'secrets', promotionRecords: 'promotion-records',
  };
  const tools = fakeToolchain({ dumpText: fakeDumpText(SET_SCHEMA) });
  runCompleteBackup(request, { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
  return { production, disposable, backupSet: join(production, 'backups', 'set-1'), importSnapshot };
}

function req(world: World, overrides: Partial<RehearsalRequestWithConfirmation> = {}): RehearsalRequestWithConfirmation {
  return {
    productionRoot: world.production,
    productionProject: 'catalogauthority-local',
    disposableRoot: world.disposable,
    label: 'r1',
    composeFile: COMPOSE_FILE,
    backupSet: world.backupSet,
    importSnapshot: world.importSnapshot,
    currentImage: CURRENT,
    candidateImage: CANDIDATE,
    expect: {
      currentVersion: CURRENT_VERSION,
      candidateVersion: CANDIDATE_VERSION,
      currentSchema: SET_SCHEMA,
      candidateSchema: CANDIDATE_SCHEMA,
    },
    confirmDigest: null,
    ...overrides,
  };
}

/** The images this host is pretending to hold, and what is inside each of them. */
function images(): RehearsalWorldOptions['images'] {
  return {
    [CURRENT]: { version: CURRENT_VERSION, schema: SET_SCHEMA },
    [CANDIDATE]: { version: CANDIDATE_VERSION, schema: CANDIDATE_SCHEMA },
  };
}

function rehearse(world: World, options: Partial<RehearsalWorldOptions> = {}, overrides: Partial<RehearsalRequestWithConfirmation> = {}) {
  const resolved = resolveRehearsal(req(world, overrides));
  const tools = rehearsalWorld({
    disposableRoot: world.disposable, images: images(), setSchema: SET_SCHEMA, ...options,
  });
  const report = runRehearsal(req(world, { ...overrides, confirmDigest: resolved.planDigest }),
    { runner: tools.runner, ledger: tools.ledger });
  return { report, tools, resolved };
}

console.log('Running Phase 279-280 upgrade and rollback rehearsal suite:\n');

// ---------------------------------------------------------------------------------------------------------
// Immutable images and declared versions
// ---------------------------------------------------------------------------------------------------------

test('a floating or missing tag is refused, and a version tag or digest is accepted', () => {
  for (const tag of FLOATING_TAGS) {
    refuses(() => assertImmutableImageRef(`repo/name:${tag}`, 'current'), 'moving tag', `the tag ${tag}`);
    refuses(() => assertImmutableImageRef(`repo/name:${tag.toUpperCase()}`, 'current'), 'moving tag',
      `the tag ${tag} in another case`);
  }
  refuses(() => assertImmutableImageRef('repo/name', 'current'), 'no tag and no digest', 'a bare repository');
  refuses(() => assertImmutableImageRef('', 'current'), 'empty', 'an empty reference');
  refuses(() => assertImmutableImageRef('repo/name :v1', 'current'), 'whitespace', 'a reference with a space');
  // Accepted.
  assertImmutableImageRef('catalog-authority-ops:v1.1.4', 'current');
  assertImmutableImageRef('registry.local:5000/catalog/app:v2.0.0-rc1', 'current');
  assertImmutableImageRef(`repo/name@sha256:${'a'.repeat(64)}`, 'current');
});

test('the same reference for both images is refused: there is nothing to rehearse', () => {
  const world = makeWorld('same-image');
  refuses(() => resolveRehearsal(req(world, { candidateImage: CURRENT })), 'nothing to rehearse',
    'one image twice');
});

// ---------------------------------------------------------------------------------------------------------
// Production identity
// ---------------------------------------------------------------------------------------------------------

test('a disposable root that IS, contains, or is inside production is refused', () => {
  const world = makeWorld('identity');
  refuses(() => resolveRehearsal(req(world, { disposableRoot: world.production })), 'runs somewhere else',
    'the production root itself');
  const inside = join(world.production, 'scratch');
  mkdirSync(inside, { recursive: true });
  refuses(() => resolveRehearsal(req(world, { disposableRoot: inside })), 'contain one another',
    'a directory inside production');
  refuses(() => resolveRehearsal(req(world, { productionRoot: join(world.disposable), disposableRoot: world.disposable })),
    'runs somewhere else', 'production and disposable the same');
});

test('a disposable project name that collides with production is refused, including by case', () => {
  const world = makeWorld('collision');
  const resolved = resolveRehearsal(req(world));
  assert(resolved.projectName.startsWith(REHEARSAL_PROJECT_PREFIX), 'the project carries the marker');
  refuses(() => resolveRehearsal(req(world, { productionProject: resolved.projectName })),
    'is the production project name', 'the same project name');
  refuses(() => resolveRehearsal(req(world, { productionProject: resolved.projectName.toUpperCase() })),
    'is the production project name', 'the same name in another case');
  refuses(() => resolveRehearsal(req(world, { productionProject: `${REHEARSAL_PROJECT_PREFIX}prod` })),
    'begins with', 'a production project wearing the rehearsal marker');
});

test('a backup set or import snapshot inside the disposable root is refused: cleanup owns that directory', () => {
  const world = makeWorld('set-inside');
  const inside = join(world.disposable, 'backups', 'set-1');
  mkdirSync(inside, { recursive: true });
  refuses(() => resolveRehearsal(req(world, { backupSet: inside })), 'the cleanup removes',
    'a set inside the disposable root');
  refuses(() => resolveRehearsal(req(world, { importSnapshot: join(world.disposable, 'snap.json') })),
    'the cleanup removes', 'an import snapshot inside the disposable root');
});

// ---------------------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------------------

test('nothing runs without the exact plan digest', () => {
  const world = makeWorld('gate');
  const resolved = resolveRehearsal(req(world));
  const tools = fakeToolchain();
  refuses(() => runRehearsal(req(world, { confirmDigest: null }), { runner: tools.runner, ledger: tools.ledger }),
    'digest you confirmed', 'no digest');
  refuses(() => runRehearsal(req(world, { confirmDigest: 'f'.repeat(64) }), { runner: tools.runner, ledger: tools.ledger }),
    'digest you confirmed', 'a wrong digest');
  assertEq(tools.lines().length, 0, 'and NOTHING was run for either refusal');
  assertEq(existsSync(join(world.disposable, REHEARSAL_MARKER_NAME)), false, 'and the root was not even claimed');

  // The digest is deterministic over what decides the run, and moves when any of it moves.
  assertEq(rehearsalPlanDigest(resolved), resolved.planDigest, 'the digest is stable');
  for (const [overrides, what] of [
    [{ candidateImage: 'catalog-authority-ops:v1.2.0' }, 'a different candidate image'],
    [{ expect: { ...req(world).expect, candidateVersion: '9.9.9' } }, 'a different expected version'],
    [{ expect: { ...req(world).expect, candidateSchema: CANDIDATE_SCHEMA + 3 } }, 'a different expected schema'],
  ] as Array<[Partial<RehearsalRequestWithConfirmation>, string]>) {
    assert(resolveRehearsal(req(world, overrides)).planDigest !== resolved.planDigest,
      `${what} is a different plan, so it is a different digest`);
  }
  assert(digestConfirmed(resolved.planDigest, resolved.planDigest), 'the echo comparison accepts the right one');
  assert(!digestConfirmed(resolved.planDigest.slice(0, 63), resolved.planDigest), 'and refuses a short one');
});

test('a backup set that does not verify stops the rehearsal before a container exists', () => {
  const world = makeWorld('unverified');
  // Tamper with the published set: the verification runs NOW, not when the set was taken.
  const dump = join(world.backupSet, COMPONENT_ARTIFACT_NAMES.database);
  writeFileSync(dump, `${readFileSync(dump, 'utf8')}-- tampered\n`, 'utf8');
  const resolved = resolveRehearsal(req(world));
  const tools = fakeToolchain();
  refuses(() => runRehearsal(req(world, { confirmDigest: resolved.planDigest }), { runner: tools.runner, ledger: tools.ledger }),
    'does not verify', 'a tampered set');
  assertEq(tools.lines().length, 0, 'and nothing was started');
});

test('a set whose schema is not the one declared for the current image stops the rehearsal', () => {
  const world = makeWorld('schema-mismatch');
  const resolved = resolveRehearsal(req(world, { expect: { ...req(world).expect, currentSchema: SET_SCHEMA - 1,
    candidateSchema: SET_SCHEMA } }));
  const tools = fakeToolchain();
  refuses(() => runRehearsal(req(world, {
    expect: { ...req(world).expect, currentSchema: SET_SCHEMA - 1, candidateSchema: SET_SCHEMA },
    confirmDigest: resolved.planDigest,
  }), { runner: tools.runner, ledger: tools.ledger }), 'different schema version', 'a set at another schema');
  assertEq(tools.lines().length, 0, 'and nothing was started');
});

// ---------------------------------------------------------------------------------------------------------
// The corrections. Every test below FAILS on the first implementation of this tranche.
// ---------------------------------------------------------------------------------------------------------

test('the rehearsal is REAL: two images are selected, four components restored, everything exercised', () => {
  // THE DEFECT: the accepted images were never applied to Compose — both `up` commands were byte-identical —
  // and only `database.sql` was ever replayed. The rehearsal reported an upgrade it had not performed, from a
  // restore that was missing the keystore its every decrypt depended on.
  const world = makeWorld('real');
  const { report, tools } = rehearse(world);
  assertEq(report.ok, true, `both legs held: ${JSON.stringify(report.steps.filter((s) => !s.ok))}`);

  const problems = rehearsalProblems(tools, {
    currentImage: CURRENT,
    candidateImage: CANDIDATE,
    components: [COMPONENT_ARTIFACT_NAMES.database, COMPONENT_ARTIFACT_NAMES.keystore,
      COMPONENT_ARTIFACT_NAMES.secrets, COMPONENT_ARTIFACT_NAMES['promotion-records']],
  });
  assertEq(problems.join('; '), '', 'the harness found nothing missing from what a rehearsal must do');

  // And the specific facts, spelled out rather than left to the harness alone.
  const selected = tools.ups.map((up) => up.image);
  assert(selected.includes(CANDIDATE), 'the candidate image was really booted');
  assertEq(selected[selected.length - 1], CURRENT, 'and the rollback put the previous image back');
  assertEq(tools.restores.length, 2, 'the set was restored twice');
  assertEq(tools.restores[0]!.digest, tools.restores[1]!.digest, 'and the second restore was the same bytes');
  assertEq(report.versions.current, 'as-declared', 'the current version was read and matched');
  assertEq(report.versions.candidate, 'as-declared', 'the candidate version was read and matched');
  assertEq(report.versions.afterRollback, 'as-declared', 'and the previous version was back after the rollback');
  assertEq(report.backupSetUnchanged, true, 'and the set it restored from was never written to');
});

test('the harness itself would CATCH a rehearsal that never switched images', () => {
  // The harness is the thing claiming the rehearsal was real, so its own ability to say NO is asserted. A
  // world in which every boot selects the current image must produce exactly the finding that describes it.
  const world = makeWorld('harness-honesty');
  const { tools } = rehearse(world);
  const pretendUnchanged = {
    ...tools,
    ups: tools.ups.map((up) => ({ ...up, image: CURRENT })),
  };
  const problems = rehearsalProblems(pretendUnchanged, {
    currentImage: CURRENT, candidateImage: CANDIDATE, components: [COMPONENT_ARTIFACT_NAMES.database],
  });
  assert(problems.some((p) => p.includes('CANDIDATE')), `the harness objects: ${problems.join('; ')}`);
  assert(problems.some((p) => p.includes('same image')), 'and says every boot was the same image');

  // ...and one that restored only the database.
  const missing = rehearsalProblems(tools, {
    currentImage: CURRENT, candidateImage: CANDIDATE,
    components: [COMPONENT_ARTIFACT_NAMES.database, 'a-component-that-was-never-restored'],
  });
  assert(missing.some((p) => p.includes('never restored')), 'and objects to a component that is not there');
});

test('the override files this product writes pin the image and mount all four components', () => {
  const world = makeWorld('overrides');
  rehearse(world);
  for (const [role, image] of [['current', CURRENT], ['candidate', CANDIDATE]] as Array<[('current' | 'candidate'), string]>) {
    const text = readFileSync(join(world.disposable, REHEARSAL_OVERRIDE_NAMES[role]), 'utf8');
    assert(text.includes(`image: "${image}"`), `the ${role} override pins the ${role} image`);
    for (const artifact of Object.values(COMPONENT_ARTIFACT_NAMES)) {
      assert(text.includes(artifact), `and mounts the ${artifact} component`);
    }
    assert(text.includes(REHEARSAL_IMPORT_NAME), 'and the representative import snapshot');
    // A HOST PATH NEVER REACHES THE FILE. Every path in it is relative to the root it lives in.
    assert(!text.includes(world.disposable) && !text.includes(WORK), 'and it carries no host path');
  }
});

test('the restore workspace holds every component, copied out of a set that is never written to', () => {
  const world = makeWorld('workspace');
  const before = readdirSync(world.backupSet).slice().sort().join(',');
  const { report } = rehearse(world);
  const workspace = join(world.disposable, REHEARSAL_RESTORE_DIRNAME);
  for (const artifact of Object.values(COMPONENT_ARTIFACT_NAMES)) {
    assertEq(existsSync(join(workspace, artifact)), true, `the workspace holds ${artifact}`);
  }
  assertEq(existsSync(join(workspace, REHEARSAL_IMPORT_NAME)), true, 'and the representative import');
  // THE SECRETS REALLY ARE THERE — a rehearsal that mounted an empty directory would decrypt nothing.
  assertEq(readFileSync(join(workspace, COMPONENT_ARTIFACT_NAMES.secrets, 'custodian_kek'), 'utf8'), SECRET_VALUE,
    'and the restored secrets are the real ones');
  assertEq(readdirSync(world.backupSet).slice().sort().join(','), before, 'while the SET itself is untouched');
  assertEq(report.backupSetUnchanged, true, 'and the report says the set verified identically afterwards');
  assertEq(Object.keys(report.restored).length, 4, 'and all four components are recorded as restored');
});

test('a version or schema that is not the declared one fails the leg it was read on', () => {
  // THE DEFECT: no version was ever read, so an "upgrade" to an image that was not the candidate — or that
  // carried something other than the operator believed — passed silently.
  const world = makeWorld('wrong-version');
  const wrong = rehearse(world, {
    images: {
      [CURRENT]: { version: CURRENT_VERSION, schema: SET_SCHEMA },
      // The candidate image is really something else inside.
      [CANDIDATE]: { version: '9.9.9', schema: CANDIDATE_SCHEMA },
    },
  });
  assertEq(wrong.report.ok, false, 'the rehearsal did not hold');
  const failedStep = wrong.report.steps.find((step) => !step.ok)!;
  assertEq(failedStep.id, 'candidate-version', 'and it is the candidate version step that failed');
  assertEq(wrong.report.versions.candidate, 'not-as-declared', 'recorded as a closed word, with no version in it');
  assert(!JSON.stringify(wrong.report).includes('9.9.9'), 'and the version it actually read is not disclosed');

  // ...and the same for a schema version.
  const schema = rehearse(makeWorld('wrong-schema'), {
    images: {
      [CURRENT]: { version: CURRENT_VERSION, schema: SET_SCHEMA },
      [CANDIDATE]: { version: CANDIDATE_VERSION, schema: CANDIDATE_SCHEMA + 5 },
    },
  });
  assertEq(schema.report.ok, false, 'a candidate at another schema version does not hold');
  assert(schema.report.steps.some((step) => !step.ok && step.id === 'candidate-schema'),
    `and the schema step is the one that failed: ${JSON.stringify(schema.report.steps.filter((s) => !s.ok))}`);
});

test('the plan and the run are ONE ordered list', () => {
  // THE DEFECT: the printed plan and the executed sequence were built by two different functions, which is
  // how they came to disagree about something as large as which image boots.
  const world = makeWorld('one-plan');
  const resolved = resolveRehearsal(req(world));
  const planned = planRehearsalCommands(resolved).map((command) => command.args.join(' '));
  const { tools } = rehearse(world);
  const ran = tools.ledger.all().map((entry) => entry.args.join(' '));
  assertEq(ran.length, planned.length, 'the run issued exactly the planned commands');
  for (let index = 0; index < planned.length; index += 1) {
    assertEq(ran[index], planned[index], `command ${index} is the one that was planned`);
  }
  // ...and the ids in the report are the ids in the plan, in order.
  const planIds = planRehearsal(resolved).map((step) => step.id);
  const { report } = rehearse(makeWorld('one-plan-ids'));
  assertEq(report.steps.map((step) => step.id).join(','), planIds.join(','), 'and the steps are the plan\'s steps');
});

test('an unmarked root holding somebody\'s files is never claimed, and never cleaned', () => {
  // THE DEFECT: a rehearsal wrote into, and offered to remove volumes from, any directory it was pointed at.
  const world = makeWorld('unowned');
  writeFileSync(join(world.disposable, 'notes-i-care-about.txt'), 'mine\n', 'utf8');
  const resolved = resolveRehearsal(req(world));
  refuses(() => claimDisposableRoot(resolved), 'did not put there', 'a root holding somebody\'s file');
  assertEq(existsSync(join(world.disposable, REHEARSAL_MARKER_NAME)), false, 'and no marker was written');

  // A run against it fails at the first step and removes nothing.
  const tools = rehearsalWorld({ disposableRoot: world.disposable, images: images(), setSchema: SET_SCHEMA });
  const report = runRehearsal(req(world, { confirmDigest: resolved.planDigest, cleanup: true }),
    { runner: tools.runner, ledger: tools.ledger });
  assertEq(report.ok, false, 'the rehearsal did not hold');
  assertEq(report.steps[0]!.id, 'own-the-root', 'and it stopped at the very first step');
  assertEq(tools.lines().length, 0, 'having run no command at all');
  assertEq(report.cleanup.performed, false, 'and removed nothing');
});

test('a root marked for a DIFFERENT rehearsal is refused rather than adopted', () => {
  const world = makeWorld('other-marker');
  const mine = resolveRehearsal(req(world));
  claimDisposableRoot(mine);
  assertEq(claimDisposableRoot(mine), 'already-ours', 'my own marker is mine on a second run');

  const other = resolveRehearsal(req(world, { candidateImage: 'catalog-authority-ops:v2.0.0',
    expect: { ...req(world).expect, candidateVersion: '2.0.0' } }));
  refuses(() => claimDisposableRoot(other), 'DIFFERENT rehearsal', 'a root marked for another plan');

  // And a marker that is not this build's is never replaced silently.
  writeFileSync(join(world.disposable, REHEARSAL_MARKER_NAME), '{"report":"something-else"}\n', 'utf8');
  refuses(() => claimDisposableRoot(mine), 'not one of this command', 'a foreign marker');
});

test('a restore workspace left by an earlier run is never silently replaced', () => {
  const world = makeWorld('leftover-workspace');
  rehearse(world);
  // A second rehearsal of the same plan finds its own keystore and secrets copy still there.
  const resolved = resolveRehearsal(req(world));
  const tools = rehearsalWorld({ disposableRoot: world.disposable, images: images(), setSchema: SET_SCHEMA });
  const report = runRehearsal(req(world, { confirmDigest: resolved.planDigest }),
    { runner: tools.runner, ledger: tools.ledger });
  assertEq(report.ok, false, 'the second run did not proceed');
  assert(report.steps[0]!.detail.includes('remove it deliberately'),
    `and says what to do: ${report.steps[0]!.detail}`);
});

test('the evidence carries reference DIGESTS and closed words, never a reference or a version', () => {
  // THE DEFECT: the durable report printed both image references in full. A reference names a registry, and
  // often a host or an owner — which is exactly what a support bundle must not travel with.
  const world = makeWorld('redaction');
  const { report } = rehearse(world);
  const printed = [renderRehearsal(report), JSON.stringify(report)].join('\n');
  for (const forbidden of [CURRENT, CANDIDATE, CURRENT_VERSION, CANDIDATE_VERSION, 'catalog-authority-ops',
    world.production, world.disposable, world.backupSet, WORK, SECRET_VALUE,
    'ghcr.io', 'docker.io', '/mnt/user', 'password', 'a detail']) {
    assert(!printed.includes(forbidden), `the evidence carried ${forbidden.slice(0, 40)}`);
  }
  // What it DOES carry is what an operator acts on and can match against the plan they kept.
  assert(printed.includes(report.planDigest), 'the plan digest is in the evidence');
  assertEq(report.images.currentDigest, referenceDigest(CURRENT), 'and a digest of the current reference');
  assertEq(report.images.candidateDigest, referenceDigest(CANDIDATE), 'and of the candidate');
  assertEq(report.images.distinct, true, 'and the fact that they differ');
  assert(printed.includes('set-1'), 'and the set name they chose');
  assert(printed.includes('as-declared'), 'and closed words for the version comparisons');
});

test('a doctor detail and a runner message never reach the evidence', () => {
  const world = makeWorld('closed-details');
  const secretDetail = 'a-doctor-detail-naming-/var/lib/postgresql-and-a-password';
  const sick = rehearse(world, {
    doctorJson: JSON.stringify({
      reportVersion: 1, ok: false,
      checks: [{ name: 'db-owner-reachable', state: 'fail', detail: secretDetail }],
    }),
  });
  assertEq(sick.report.ok, false, 'the rehearsal did not hold');
  const printed = [renderRehearsal(sick.report), JSON.stringify(sick.report)].join('\n');
  assert(!printed.includes(secretDetail), 'the doctor detail is not carried');
  assert(!printed.includes('/var/lib/postgresql'), 'nor any path inside it');
  assert(printed.includes('the doctor reported FAIL'), 'while the closed verdict IS carried');

  // A runner that throws an arbitrary message is reported as a closed category, not as its message.
  const world2 = makeWorld('closed-thrown');
  const resolved = resolveRehearsal(req(world2));
  const tools = rehearsalWorld({ disposableRoot: world2.disposable, images: images(), setSchema: SET_SCHEMA });
  const exploding = (command: Parameters<typeof tools.runner>[0]) => {
    if (command.args.includes('up')) throw new Error(`the runner blew up and named ${world2.disposable}`);
    return tools.runner(command);
  };
  const report = runRehearsal(req(world2, { confirmDigest: resolved.planDigest }),
    { runner: exploding, ledger: tools.ledger });
  assertEq(report.ok, false, 'a thrown runner fails the rehearsal');
  const thrownPrinted = JSON.stringify(report);
  assert(!thrownPrinted.includes(world2.disposable), 'and its message is not repeated into the evidence');
  assert(!thrownPrinted.includes('blew up'), 'in any form');
});

// ---------------------------------------------------------------------------------------------------------
// Scoping, failure and cleanup
// ---------------------------------------------------------------------------------------------------------

test('every command runs in the disposable root, under the marker project, and never pulls', () => {
  const world = makeWorld('scoping');
  const resolved = resolveRehearsal(req(world));
  for (const command of [...planRehearsalCommands(resolved), rehearsalCleanupCommand(resolved)]) {
    assertEq(command.cwd, resolved.disposableRoot, `every planned command runs in the disposable root: ${command.args.join(' ')}`);
    assertEq(command.args[0], 'compose', 'and is a compose command');
    assertEq(command.args[1], '-p', 'with an explicit project');
    assertEq(command.args[2], resolved.projectName, 'which is this rehearsal\'s own');
    assertEq(command.args[3], '-f', 'and an explicit definition');
    assertPermittedCommand(command);
    if (command.args.includes('up')) {
      assert(command.args.includes('--pull') && command.args.includes('never'),
        `every up refuses to fetch: ${command.args.join(' ')}`);
      assert(command.args.includes(REHEARSAL_OVERRIDE_NAMES.current) || command.args.includes(REHEARSAL_OVERRIDE_NAMES.candidate),
        `every up selects an image through an override: ${command.args.join(' ')}`);
    }
  }
  const { tools } = rehearse(world);
  for (const entry of tools.ledger.all()) {
    assertEq(entry.args[2], resolved.projectName, 'and every command that RAN carried the marker project');
    // THE WORKING DIRECTORY OF WHAT RAN, not only of what was planned. Production is never addressed, and
    // that is checked against the ledger rather than inferred from how the commands are constructed.
    assertEq(entry.cwd, resolved.disposableRoot, 'and every command that RAN did so in the disposable root');
    assert(!entry.cwd.includes('production'), 'and never anywhere under production');
  }
  assertEq(assertLedgerIsClean(tools.lines()).join('; '), '', `the ledger is clean: ${tools.lines().join(' | ')}`);
  assert(tools.lines().length > 8, 'and it is not empty, so the scan is not vacuous');
});

test('a doctor FAIL on the candidate stops the rehearsal and keeps the evidence', () => {
  const world = makeWorld('candidate-sick');
  const { report, tools } = rehearse(world, { doctorJson: fakeDoctorJson(['pass', 'fail']) });
  assertEq(report.ok, false, 'the rehearsal did not hold');
  const failedStep = report.steps.find((step) => !step.ok);
  assert(failedStep !== undefined, 'a step is recorded as failed');
  assert(failedStep.detail.includes('FAIL'), `and says what the doctor reported: ${failedStep.detail}`);
  // NOTHING WAS REMOVED, and the report says where to look.
  assertEq(report.cleanup.performed, false, 'no cleanup was performed');
  assert(report.notes.some((n) => n.includes('LEFT IN PLACE for diagnosis')), 'and the evidence was kept');
  assert(!tools.lines().slice(-1)[0]!.includes('down -v'), 'the last thing it did was not a teardown');
  assertEq(existsSync(join(world.disposable, REHEARSAL_MARKER_NAME)), true, 'and the marker is still there to clean by');
});

test('a rollback restore that fails is reported as "this upgrade is not reversible"', () => {
  const world = makeWorld('irreversible');
  // The second psql — the rollback restore — fails. The first one must succeed, so the injection counts.
  let seen = 0;
  const tools = rehearsalWorld({ disposableRoot: world.disposable, images: images(), setSchema: SET_SCHEMA });
  const counting = (command: Parameters<typeof tools.runner>[0]) => {
    if (command.args.includes('psql')) { seen += 1; if (seen === 2) return { status: 1, stdout: '', stderr: '' }; }
    return tools.runner(command);
  };
  const resolved = resolveRehearsal(req(world));
  const report = runRehearsal(req(world, { confirmDigest: resolved.planDigest }),
    { runner: counting, ledger: tools.ledger });
  assertEq(report.ok, false, 'the rehearsal did not hold');
  const failedStep = report.steps.find((step) => !step.ok)!;
  assertEq(failedStep.id, 'rollback-restore', 'and it is the rollback restore that failed');
  assert(failedStep.detail.includes('not reversible'), `saying what that means: ${failedStep.detail}`);
});

test('cleanup happens only when asked, only when everything held, and only by the marker project', () => {
  const world = makeWorld('cleanup');
  const kept = rehearse(world);
  assertEq(kept.report.cleanup.performed, false, 'by default nothing is removed');
  assert(kept.report.notes.some((n) => n.includes('left in place')), 'and the report says so');

  const removedWorld = makeWorld('cleanup-removed');
  const removed = rehearse(removedWorld, {}, { cleanup: true });
  assertEq(removed.report.cleanup.performed, true, 'with --cleanup the project is removed');
  const last = removed.tools.lines()[removed.tools.lines().length - 1]!;
  assert(last.includes(`-p ${removed.resolved.projectName}`), `and only by this project: ${last}`);
  assert(last.includes('down -v --remove-orphans'), 'through compose, which removes only what it labelled');

  // A failed run NEVER cleans up, even when asked.
  const sick = rehearse(makeWorld('cleanup-sick'), { doctorJson: fakeDoctorJson(['fail']) }, { cleanup: true });
  assertEq(sick.report.cleanup.performed, false, 'a failed rehearsal removes nothing even with --cleanup');
  assertEq(sick.report.cleanup.plan.length, 1, 'and leaves exactly one cleanup command as a plan');
  assert(sick.report.cleanup.plan[0]!.includes(sick.resolved.projectName), 'naming only its own project');
});

test('a cleanup whose marker has gone removes NOTHING', () => {
  // THE DEFECT THIS CLOSES: cleanup was bound to a project NAME computed in this process. If the root it was
  // pointed at is no longer the one this rehearsal owns, removing volumes by that name reaches somebody
  // else's project. The marker is the binding, and it is checked at the moment of removal.
  const world = makeWorld('marker-gone');
  const resolved = resolveRehearsal(req(world));
  const tools = rehearsalWorld({ disposableRoot: world.disposable, images: images(), setSchema: SET_SCHEMA });
  const removingMarker = (command: Parameters<typeof tools.runner>[0]) => {
    // Something removes the marker part-way through — a person tidying up, another tool, a failed disk.
    if (command.args.includes('history')) rmSync(join(world.disposable, REHEARSAL_MARKER_NAME), { force: true });
    return tools.runner(command);
  };
  const report = runRehearsal(req(world, { confirmDigest: resolved.planDigest, cleanup: true }),
    { runner: removingMarker, ledger: tools.ledger });
  assertEq(report.cleanup.performed, false, 'nothing was removed');
  assert(report.notes.some((n) => n.includes('no longer carries this rehearsal\'s marker')), 'and it says why');
  assert(!tools.lines().slice(-1)[0]!.includes('down -v --remove-orphans')
    || tools.lines().filter((l) => l.includes('down -v')).length <= 2,
  'and no extra teardown was issued beyond the two the legs require');
});

// ---------------------------------------------------------------------------------------------------------
// Parsers and the boundary
// ---------------------------------------------------------------------------------------------------------

test('the version and schema readers accept only what the shipped commands print', () => {
  assertEq(readNpmVersion('"1.1.4"\n'), '1.1.4', 'npm pkg get version answers a JSON string');
  assertEq(readNpmVersion('1.1.4'), null, 'a bare number is not that shape');
  assertEq(readNpmVersion('"not a version"'), null, 'nor is arbitrary text');
  assertEq(readNpmVersion(`"${'9'.repeat(400)}"`), null, 'nor is something enormous');
  const schema = readSchemaVersions('schema version: db=41 expected=42 — MISMATCH (run ops:migrate)\n');
  assert(schema !== null, 'the shipped ops:version line parses');
  assertEq(schema.database, 41, 'the database version is read');
  assertEq(schema.build, 42, 'and the build version');
  assertEq(readSchemaVersions('everything is fine'), null, 'and anything else is unreadable rather than guessed');
});

test('the CLI requires a plan or a digest, never both, and takes no credential', () => {
  const base = ['--production', '/a/b', '--production-project', 'p', '--disposable', '/a/c', '--label', 'r1',
    '--compose-file', 'compose.yml', '--backup-set', '/a/b/backups/s', '--import-snapshot', '/a/d/snap.json',
    '--current-image', CURRENT, '--candidate-image', CANDIDATE,
    '--expect-current-version', CURRENT_VERSION, '--expect-candidate-version', CANDIDATE_VERSION,
    '--expect-current-schema', String(SET_SCHEMA), '--expect-candidate-schema', String(CANDIDATE_SCHEMA)];
  const planned = parseRehearsalArgs([...base, '--plan']);
  assertEq(planned.plan, true, 'a plan parses');
  assertEq(planned.request.expect.candidateSchema, CANDIDATE_SCHEMA, 'and the declared schema comes through');
  const confirmed = parseRehearsalArgs([...base, '--confirm-digest', 'a'.repeat(64)]);
  assertEq(confirmed.request.confirmDigest, 'a'.repeat(64), 'and a confirmation parses');
  for (const [argv, needle] of [
    [base, '--confirm-digest is required'],
    [[...base, '--plan', '--confirm-digest', 'a'.repeat(64)], 'takes no --confirm-digest'],
    [[...base, '--confirm-digest', 'short'], '64-character digest'],
    [base.slice(2), '--production is required'],
    [base.slice(0, 18), '--expect-current-version is required'],
    [[...base.slice(0, base.length - 1), 'not-a-number', '--plan'], 'whole schema version number'],
    [[...base, '--plan', '--registry-password', 'x'], 'looks like a credential'],
  ] as Array<[string[], string]>) {
    refuses(() => parseRehearsalArgs(argv), needle, `the arguments ${argv.slice(-3).join(' ')}`);
  }
});

test('the rehearsal module can issue no media, media-server or acquisition command at all', () => {
  const source = readRepo('src/ops/upgrade-rehearsal.ts');
  for (const forbidden of ['jellyfin', 'plex', 'emby', '/mnt/user/media', '.mkv', 'nzb', 'torrent', 'magnet',
    'curl', 'wget', 'docker pull', 'docker login', 'docker push']) {
    assert(!source.toLowerCase().includes(forbidden.toLowerCase()), `the rehearsal must not name ${forbidden}`);
  }
  // And the guard would refuse one even if a future edit built it.
  refuses(() => assertPermittedCommand({ program: 'docker', args: ['compose', 'pull'], cwd: WORK, purpose: 'p' }),
    'compose subcommands', 'a compose pull');
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
