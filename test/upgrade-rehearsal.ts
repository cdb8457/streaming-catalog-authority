import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_VERSION } from '../src/db/schema-version.js';
import { REQUIRED_SECRET_FILES } from '../src/ops/backup-components.js';
import { COMPONENT_ARTIFACT_NAMES, takeCompleteBackupWithoutVerifying, type CompleteBackupRequest } from '../src/ops/complete-backup.js';
import {
  FLOATING_TAGS,
  MAX_ASSERTION_STDOUT_BYTES,
  REHEARSAL_IMPORT_NAME,
  REHEARSAL_MARKER_NAME,
  REHEARSAL_OVERRIDE_NAMES,
  REHEARSAL_PROJECT_PREFIX,
  REHEARSAL_RESTORE_DIRNAME,
  REHEARSAL_SECRET_CONSUMERS,
  assertImmutableImageRef,
  claimDisposableRoot,
  digestConfirmed,
  pinnedImagesFor,
  planRehearsal,
  planRehearsalCommands,
  readImportReport,
  readNpmVersion,
  readSchemaVersions,
  referenceDigest,
  rehearsalCleanupCommand,
  rehearsalPlanDigest,
  renderRehearsal,
  requiredRehearsalWiring,
  resolveRehearsal,
  runRehearsal,
  type RehearsalRequestWithConfirmation,
} from '../src/ops/upgrade-rehearsal.js';
import {
  REHEARSAL_SERVICES,
  parseResolvedComposeModel,
  resolvedComposeDigest,
  validateResolvedCompose,
} from '../src/ops/rehearsal-compose-model.js';
import { assertPermittedCommand } from '../src/ops/maintenance-safety.js';
import { narrowedEnvironment } from '../src/ops/maintenance-cli-shared.js';
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

/**
 * A DISPOSABLE definition, of the shape this command now requires: the four services this product's stack
 * has, project-scoped named volumes for every piece of persistent state, no bind mount, no Docker secret, no
 * external anything, and NO `${…}` — so what it resolves to is a function of its bytes.
 *
 * The product-image services deliberately name a placeholder reference this host does not hold. Pinning is
 * therefore load-bearing in every test: a leg that failed to pin `migrate` or `sidecar` gets an image the fake
 * host does not have and fails, exactly as it would on a real machine.
 */
const DISPOSABLE_COMPOSE = [
  'services:',
  '  postgres:',
  '    image: postgres:16',
  '    environment:',
  '      POSTGRES_DB: catalog',
  '      POSTGRES_USER: postgres',
  '    volumes:',
  '      - pgdata:/var/lib/postgresql/data',
  '  migrate:',
  '    image: catalog-authority-ops:v0.0.0-placeholder',
  '    environment:',
  '      APP_ENV: production',
  '  app:',
  '    image: catalog-authority-ops:v0.0.0-placeholder',
  '    environment:',
  '      APP_ENV: production',
  '      CUSTODIAN_MODE: sidecar',
  '    volumes:',
  '      - sidecarrun:/run/catalog-sidecar',
  '  sidecar:',
  '    image: catalog-authority-ops:v0.0.0-placeholder',
  '    environment:',
  '      APP_ENV: production',
  '    volumes:',
  '      - sidecarrun:/run/catalog-sidecar',
  'volumes:',
  '  pgdata: {}',
  '  sidecarrun: {}',
  '',
].join('\n');

interface World {
  readonly production: string;
  readonly disposable: string;
  readonly backupSet: string;
  readonly importSnapshot: string;
}

/** A production project with a verified backup set in it, and a disposable root beside it. */
function makeWorld(name: string, kek: string = SECRET_VALUE): World {
  const world = join(WORK, name);
  const production = join(world, 'production');
  const disposable = join(world, 'disposable');
  mkdirSync(join(production, 'secrets'), { recursive: true });
  mkdirSync(join(production, 'promotion-records'), { recursive: true });
  mkdirSync(disposable, { recursive: true });
  for (const file of REQUIRED_SECRET_FILES) {
    writeFileSync(join(production, 'secrets', file), file === 'custodian_kek' ? kek : `${file}\n`, 'utf8');
  }
  writeFileSync(join(production, 'promotion-records', 'r.json'), '{}\n', 'utf8');
  // The operator's own definition for the disposable stack. This product overrides it and never writes it.
  writeFileSync(join(disposable, COMPOSE_FILE), DISPOSABLE_COMPOSE, 'utf8');
  const importSnapshot = join(world, 'representative-import.json');
  writeFileSync(importSnapshot, '{"records":[{"title":"a representative record"}]}\n', 'utf8');

  const request: CompleteBackupRequest = {
    projectRoot: production, destination: 'backups', setName: 'set-1', custodian: 'inline',
    secrets: 'secrets', promotionRecords: 'promotion-records',
  };
  const tools = fakeToolchain({ dumpText: fakeDumpText(SET_SCHEMA) });
  takeCompleteBackupWithoutVerifying(request, { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger });
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
  // The plan is computed while the set is intact — an operator reads it and copies its digest.
  const resolved = resolveRehearsal(req(world));
  // Then the published set is tampered with. The verification runs NOW, not when the set was taken.
  const dump = join(world.backupSet, COMPONENT_ARTIFACT_NAMES.database);
  writeFileSync(dump, `${readFileSync(dump, 'utf8')}-- tampered\n`, 'utf8');
  const tools = fakeToolchain();
  refuses(() => runRehearsal(req(world, { confirmDigest: resolved.planDigest }), { runner: tools.runner, ledger: tools.ledger }),
    'does not verify', 'a tampered set');
  assertEq(tools.lines().length, 0, 'and nothing was started');
  // And resolving it at all is refused, so --plan cannot print a plan for a set that does not verify.
  refuses(() => resolveRehearsal(req(world)), 'does not verify', 'planning against a tampered set');
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
  refuses(() => claimDisposableRoot(resolved), 'carries no marker', 'a root holding somebody\'s file');
  assertEq(existsSync(join(world.disposable, REHEARSAL_MARKER_NAME)), false, 'and no marker was written');

  // A run against it fails at the claim and removes nothing. The stack resolved first — that check runs
  // BEFORE anything is claimed — so the failure is the second step, and no container was ever created.
  const tools = rehearsalWorld({ disposableRoot: world.disposable, images: images(), setSchema: SET_SCHEMA });
  const report = runRehearsal(req(world, { confirmDigest: resolved.planDigest, cleanup: true }),
    { runner: tools.runner, ledger: tools.ledger });
  assertEq(report.ok, false, 'the rehearsal did not hold');
  assertEq(report.steps.find((step) => !step.ok)!.id, 'own-the-root', 'and it stopped at the claim');
  assertEq(tools.lines().join(' | ').includes('up'), false, 'having created nothing');
  assertEq(tools.lines().join(' | ').includes('down'), false, 'and removed nothing');
  assertEq(report.cleanup.performed, false, 'and no cleanup was performed');
});

test('an ARTIFACT of this command\'s own name, with no valid marker, is unowned content', () => {
  // THE DEFECT THIS CLOSES. The first-claim allowlist held the marker's own name, the restore workspace and
  // both override files — the names this command writes. Reaching the claim at all means there is NO valid
  // marker, so a file at one of those names was not put there by a rehearsal this command can account for.
  // The old rule let it pass, WROTE A MARKER over it, and only then failed on the leftover workspace.
  for (const [name, make] of [
    [REHEARSAL_RESTORE_DIRNAME, (path: string) => mkdirSync(path, { recursive: true })],
    [REHEARSAL_OVERRIDE_NAMES.current, (path: string) => writeFileSync(path, 'services: {}\n', 'utf8')],
    [REHEARSAL_OVERRIDE_NAMES.candidate, (path: string) => writeFileSync(path, 'services: {}\n', 'utf8')],
  ] as Array<[string, (path: string) => void]>) {
    const world = makeWorld(`unowned-${name.replace(/[^a-z]/g, '')}`);
    make(join(world.disposable, name));
    const resolved = resolveRehearsal(req(world));
    refuses(() => claimDisposableRoot(resolved), 'carries no marker', `a leftover ${name}`);
    assertEq(existsSync(join(world.disposable, REHEARSAL_MARKER_NAME)), false,
      `and NO MARKER was written over it (${name})`);
  }
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
  const stopped = report.steps.find((step) => !step.ok)!;
  assertEq(stopped.id, 'own-the-root', 'at the claim');
  assert(stopped.detail.includes('remove it deliberately'), `and says what to do: ${stopped.detail}`);
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

  assertEq(kept.report.cleanup.artifacts, 'not-attempted', 'and its own artifacts are still there');
  assertEq(existsSync(join(world.disposable, REHEARSAL_RESTORE_DIRNAME)), true, 'workspace kept for diagnosis');
  assert(kept.report.notes.some((n) => n.includes('COPY OF YOUR CUSTODIAN KEYSTORE')),
    'and the report says plainly what is still sitting in that directory');

  const removedWorld = makeWorld('cleanup-removed');
  const removed = rehearse(removedWorld, {}, { cleanup: true });
  assertEq(removed.report.cleanup.performed, true, 'with --cleanup the project is removed');
  const composeDown = removed.tools.lines().filter((line) => line.includes('down -v --remove-orphans'));
  const last = composeDown[composeDown.length - 1]!;
  assert(last.includes(`-p ${removed.resolved.projectName}`), `and only by this project: ${last}`);

  // ...AND THE FILES. `cleanup.performed` used to mean "compose down ran" while a private workspace holding a
  // copy of the keystore and every secret file stayed on disk under a word that said it had been cleaned up.
  assertEq(removed.report.cleanup.artifacts, 'removed', 'its own artifacts are gone too');
  for (const name of [REHEARSAL_RESTORE_DIRNAME, REHEARSAL_OVERRIDE_NAMES.current,
    REHEARSAL_OVERRIDE_NAMES.candidate, REHEARSAL_MARKER_NAME]) {
    assertEq(existsSync(join(removedWorld.disposable, name)), false, `${name} was removed`);
    assert(removed.report.cleanup.removed.includes(name), `and the report names it: ${name}`);
  }
  // THE OPERATOR'S OWN DEFINITION IS NEVER TOUCHED.
  assertEq(existsSync(join(removedWorld.disposable, COMPOSE_FILE)), true, 'the Compose definition is preserved');
  assertEq(readFileSync(join(removedWorld.disposable, COMPOSE_FILE), 'utf8'), DISPOSABLE_COMPOSE, 'byte for byte');
  assertEq(readdirSync(removedWorld.disposable).join(','), COMPOSE_FILE, 'and it is the only thing left');

  // A failed run NEVER cleans up, even when asked.
  const sick = rehearse(makeWorld('cleanup-sick'), { doctorJson: fakeDoctorJson(['fail']) }, { cleanup: true });
  assertEq(sick.report.cleanup.performed, false, 'a failed rehearsal removes nothing even with --cleanup');
  assertEq(sick.report.cleanup.artifacts, 'not-attempted', 'not its files either');
  assertEq(sick.report.cleanup.removed.length, 0, 'nothing was removed');
  assert(sick.report.cleanup.plan[0]!.includes(sick.resolved.projectName), 'the plan names only its own project');
  assertEq(sick.report.cleanup.plan.length, 5, 'and then the four fixed artifacts it would remove by name');
  // The removal lines are FIXED NAMES this command chose. The operator's own definition is on none of them —
  // it appears in the first line only as the `-f` argument of the Compose command, which removes a project.
  assert(!sick.report.cleanup.plan.slice(1).join(' ').includes(COMPOSE_FILE),
    'and never removes the operator\'s own Compose definition');
  for (const name of [REHEARSAL_RESTORE_DIRNAME, REHEARSAL_OVERRIDE_NAMES.current,
    REHEARSAL_OVERRIDE_NAMES.candidate, REHEARSAL_MARKER_NAME]) {
    assert(sick.report.cleanup.plan.slice(1).some((line) => line.includes(name)), `the plan names ${name}`);
  }
});

test('cleanup refuses a workspace whose contents are not the ones this run made', () => {
  // A recursive delete of a path this command has not proved it owns is how an automated cleanup removes
  // somebody's data. Every component is re-digested against what was recorded when it was copied.
  const world = makeWorld('cleanup-tampered');
  const resolved = resolveRehearsal(req(world));
  const tools = rehearsalWorld({ disposableRoot: world.disposable, images: images(), setSchema: SET_SCHEMA });
  const tampering = (command: Parameters<typeof tools.runner>[0]) => {
    // Something writes into the workspace after it was prepared — the last `down` is the cleanup itself, so
    // this lands just before the removal is attempted.
    if (command.args.includes('history')) {
      writeFileSync(join(world.disposable, REHEARSAL_RESTORE_DIRNAME, COMPONENT_ARTIFACT_NAMES.secrets,
        'something-that-was-not-there'), 'x\n', 'utf8');
    }
    return tools.runner(command);
  };
  const report = runRehearsal(req(world, { confirmDigest: resolved.planDigest, cleanup: true }),
    { runner: tampering, ledger: tools.ledger });
  assertEq(report.cleanup.artifacts, 'incomplete', 'the artifact removal did not complete');
  assertEq(report.cleanup.performed, false, 'so cleanup is NOT reported as performed');
  assertEq(existsSync(join(world.disposable, REHEARSAL_RESTORE_DIRNAME)), true, 'and the workspace is still there');
  assert(report.notes.some((n) => n.includes('reported as incomplete rather than done')), 'and it says so');
  assert(report.notes.some((n) => n.includes('COPY OF YOUR CUSTODIAN KEYSTORE')), 'with the recovery plan');
});

test('cleanup will not remove a workspace reached through, or holding, a symbolic link', () => {
  const world = makeWorld('cleanup-symlink');
  const resolved = resolveRehearsal(req(world));
  const tools = rehearsalWorld({ disposableRoot: world.disposable, images: images(), setSchema: SET_SCHEMA });
  let linked = false;
  const linking = (command: Parameters<typeof tools.runner>[0]) => {
    if (command.args.includes('history') && !linked) {
      try {
        symlinkSync(world.production,
          join(world.disposable, REHEARSAL_RESTORE_DIRNAME, COMPONENT_ARTIFACT_NAMES.secrets, 'escape'), 'dir');
        linked = true;
      } catch { /* an unprivileged Windows session cannot create one; the digest check below still refuses */ }
    }
    return tools.runner(command);
  };
  const report = runRehearsal(req(world, { confirmDigest: resolved.planDigest, cleanup: true }),
    { runner: linking, ledger: tools.ledger });
  // WHAT IS ASSERTED UNCONDITIONALLY: the link's TARGET survives, whether or not this session could create
  // one. Where a link was made, the removal must also have refused rather than followed it.
  assertEq(existsSync(world.production), true, 'production is still there');
  assertEq(existsSync(join(world.production, 'secrets', 'custodian_kek')), true, 'and so is what it holds');
  if (!linked) {
    console.log('        (this session cannot create a symbolic link; the target-survives half still ran)');
    return;
  }
  assertEq(report.cleanup.performed, false, 'nothing was removed through a link');
  assertEq(report.cleanup.artifacts, 'incomplete', 'and the cleanup is honest about it');
  assertEq(existsSync(join(world.disposable, REHEARSAL_RESTORE_DIRNAME)), true, 'the workspace was left alone');
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
// THE DISPOSABLE STACK IS PROVED DISPOSABLE — before a marker is claimed and before anything could exist
// ---------------------------------------------------------------------------------------------------------

/** A world whose disposable definition is whatever the test wants it to be. */
function worldWith(name: string, compose: string): World {
  const world = makeWorld(name);
  writeFileSync(join(world.disposable, COMPOSE_FILE), compose, 'utf8');
  return world;
}

/** The valid definition with one service's block replaced. Keeps every other rule satisfied. */
function withService(service: string, body: readonly string[]): string {
  const lines = DISPOSABLE_COMPOSE.split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  let end = start + 1;
  while (end < lines.length && lines[end]!.startsWith('    ')) end += 1;
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n');
}

test('a definition that would reach PRODUCTION is refused before a marker, a volume or a container exists', () => {
  // THE DEFECT: `touchedProduction: false` was a literal in the report. A Compose definition decides for
  // itself what it touches, and every one of these resolves to something outside this rehearsal.
  const productionPath = join(WORK, 'a-production-appdata-directory');
  mkdirSync(productionPath, { recursive: true });
  const cases: Array<[string, string, string]> = [
    ['a production bind mount', withService('postgres', ['    image: postgres:16',
      '    volumes:', `      - ${productionPath}:/var/lib/postgresql/data`]), 'BIND MOUNT'],
    ['a Docker secret naming a host file', `${withService('sidecar', ['    image: catalog-authority-ops:v0.0.0-placeholder',
      '    secrets:', '      - custodian_kek'])}\nsecrets:\n  custodian_kek:\n    file: ${productionPath}/custodian_kek\n`,
    'Docker secrets or configs'],
    ['an external volume', DISPOSABLE_COMPOSE.replace('  pgdata: {}', '  pgdata:\n    external: true'),
      'EXTERNAL volume'],
    // `external: false` PROVES NOTHING. These four are all non-external and every one of them reaches out.
    ['a volume with an explicit global name',
      DISPOSABLE_COMPOSE.replace('  pgdata: {}', '  pgdata:\n    name: catalog-authority-pgdata'),
      'explicit name instead of this project\'s own'],
    ['a network with an explicit global name',
      `${DISPOSABLE_COMPOSE}networks:\n  default:\n    name: catalogauthority_default\n`,
      'explicit name instead of this project\'s own'],
    ['a local volume that is really a host bind',
      DISPOSABLE_COMPOSE.replace('  pgdata: {}',
        '  pgdata:\n    driver: local\n    driver_opts:\n      type: none\n      o: bind\n'
        + '      device: /mnt/user/appdata/catalog/pgdata'),
      'driver options'],
    ['a volume on a storage driver nobody can audit',
      DISPOSABLE_COMPOSE.replace('  pgdata: {}', '  pgdata:\n    driver: a-storage-plugin'),
      'a "a-storage-plugin" driver'],
    ['a network on the host\'s own networking',
      `${DISPOSABLE_COMPOSE}networks:\n  default:\n    driver: host\n`,
      'a "host" driver'],
    ['a volume describing a mechanism this build has not read',
      DISPOSABLE_COMPOSE.replace('  pgdata: {}', '  pgdata:\n    some_future_mechanism: whatever'),
      'cannot prove is contained'],
    ['a container name', withService('app', ['    image: catalog-authority-ops:v0.0.0-placeholder',
      '    container_name: catalog-app']), 'container_name'],
    ['the host network', withService('app', ['    image: catalog-authority-ops:v0.0.0-placeholder',
      '    network_mode: host']), 'network_mode'],
    ['a privileged container', withService('app', ['    image: catalog-authority-ops:v0.0.0-placeholder',
      '    privileged: true']), 'privileged'],
    ['a host device', withService('app', ['    image: catalog-authority-ops:v0.0.0-placeholder',
      '    devices:', '      - /dev/dri:/dev/dri']), 'devices'],
    ['a published host port', withService('app', ['    image: catalog-authority-ops:v0.0.0-placeholder',
      '    ports:', '      - "8099:8099"']), 'ports'],
    ['a service nothing pins', DISPOSABLE_COMPOSE.replace('volumes:\n  pgdata:',
      '  ops:\n    image: catalog-authority-ops:v0.0.0-placeholder\nvolumes:\n  pgdata:'),
    'does not know how to pin'],
    ['a missing sidecar', DISPOSABLE_COMPOSE.split('\n').slice(0, DISPOSABLE_COMPOSE.split('\n')
      .findIndex((line) => line === '  sidecar:')).concat(['volumes:', '  pgdata: {}', '  sidecarrun: {}', ''])
      .join('\n'), 'no "sidecar" service'],
  ];
  for (const [what, compose, needle] of cases) {
    const world = worldWith(`escape-${what.replace(/[^a-z]/g, '')}`, compose);
    const resolved = resolveRehearsal(req(world));
    const tools = rehearsalWorld({ disposableRoot: world.disposable, images: images(), setSchema: SET_SCHEMA });
    const report = runRehearsal(req(world, { confirmDigest: resolved.planDigest, cleanup: true }),
      { runner: tools.runner, ledger: tools.ledger });
    assertEq(report.ok, false, `${what} is refused`);
    const stopped = report.steps.find((step) => !step.ok)!;
    assertEq(stopped.id, 'disposable-stack', `${what} stops at the preflight`);
    assert(stopped.detail.includes(needle), `${what}: expected "${needle}", got: ${stopped.detail}`);

    // BEFORE ANYTHING. The only command issued was `config`, which starts nothing; no marker was written, no
    // workspace prepared and no override left behind.
    const ran = tools.lines();
    assertEq(ran.length, 1, `${what}: exactly one command ran`);
    assert(ran[0]!.includes('config'), `${what}: and it was the resolve, which creates nothing`);
    for (const forbidden of ['down', 'up', 'exec']) {
      assert(!ran.join(' ').includes(` ${forbidden}`), `${what}: no ${forbidden} was issued`);
    }
    assertEq(existsSync(join(world.disposable, REHEARSAL_MARKER_NAME)), false, `${what}: no marker`);
    assertEq(existsSync(join(world.disposable, REHEARSAL_RESTORE_DIRNAME)), false, `${what}: no workspace`);
    assertEq(readdirSync(world.disposable).join(','), COMPOSE_FILE, `${what}: the root is as it was`);
    assertEq(report.composeModel.base, null, `${what}: no resolved model was accepted`);
    assertEq(report.cleanup.performed, false, `${what}: nothing was cleaned up`);
  }
});

test('a top-level volume or network is proved OWNED, by its effective name and its mechanism', () => {
  // THE DEFECT: the model kept a top-level entry's KEY and its `external` flag, and treated `external: false`
  // as proof of ownership. It is not. An explicit `name:` puts the volume in the GLOBAL namespace where an
  // installation's real volumes live — and this command runs `down -v` on what it believes it owns. A `local`
  // volume with `driver_opts: {type: none, o: bind, device: /…}` is a host directory that no service's mount
  // list ever calls a bind, so every check that looked at mounts alone walked past it.
  const world = makeWorld('owned-resources');
  const resolved = resolveRehearsal(req(world));
  const project = resolved.projectName;
  const model = (volumes: Record<string, unknown>, networks: Record<string, unknown>) =>
    parseResolvedComposeModel(JSON.stringify({
      name: project,
      services: {
        postgres: { image: 'postgres:16', environment: {},
          volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' }] },
        migrate: { image: CURRENT, environment: {}, volumes: [] },
        app: { image: CURRENT, environment: {}, volumes: [] },
        sidecar: { image: CURRENT, environment: {}, volumes: [] },
      },
      volumes, networks, secrets: {}, configs: {},
    }), 'resolved disposable stack');
  const check = (volumes: Record<string, unknown>, networks: Record<string, unknown> = {}) =>
    validateResolvedCompose(model(volumes, networks), {
      projectName: project,
      disposableRoot: resolved.disposableRoot,
      workspace: null,
      pinnedImages: null,
      wiring: requiredRehearsalWiring(),
    });

  // A PROJECT-SCOPED NAMED VOLUME IS FINE, and is what the disposable stack is supposed to use. Asserted
  // first, so every refusal below is a refusal of something specific rather than of the whole shape.
  check({ pgdata: { name: `${project}_pgdata` } }, { default: { name: `${project}_default` } });
  check({ pgdata: { name: `${project}_pgdata`, driver: 'local', labels: { a: 'b' } } },
    { default: { name: `${project}_default`, driver: 'bridge' } });

  for (const [what, volumes, networks, needle] of [
    ['an explicit global volume name', { pgdata: { name: 'catalog-authority-pgdata' } }, {},
      'explicit name instead of this project\'s own'],
    ['a name that merely CONTAINS the project name', { pgdata: { name: `x-${project}_pgdata` } }, {},
      'explicit name instead of this project\'s own'],
    ['an explicit global network name', { pgdata: { name: `${project}_pgdata` } },
      { default: { name: 'catalogauthority_default' } }, 'explicit name instead of this project\'s own'],
    ['a host-bind driver option', {
      pgdata: {
        name: `${project}_pgdata`, driver: 'local',
        driver_opts: { type: 'none', o: 'bind', device: '/mnt/user/appdata/catalog/pgdata' },
      },
    }, {}, 'driver options'],
    ['a driver option of any kind at all', {
      pgdata: { name: `${project}_pgdata`, driver_opts: { anything: 'at-all' } },
    }, {}, 'driver options'],
    ['a custom volume driver', { pgdata: { name: `${project}_pgdata`, driver: 'a-storage-plugin' } }, {},
      'a "a-storage-plugin" driver'],
    ['a custom network driver', { pgdata: { name: `${project}_pgdata` } },
      { default: { name: `${project}_default`, driver: 'macvlan' } }, 'a "macvlan" driver'],
    ['a mechanism this build has not read', {
      pgdata: { name: `${project}_pgdata`, some_future_mechanism: { whatever: true } },
    }, {}, 'cannot prove is contained'],
    ['an external volume, still', { pgdata: { name: `${project}_pgdata`, external: true } }, {},
      'EXTERNAL volume'],
  ] as Array<[string, Record<string, unknown>, Record<string, unknown>, string]>) {
    refuses(() => check(volumes, networks), needle, what);
  }

  // A RESOLVED CONFIGURATION ALWAYS CARRIES THE EFFECTIVE NAME. One that does not is not Compose's own
  // answer, and deriving the default on its behalf would be inventing the fact the whole check rests on.
  refuses(() => model({ pgdata: {} }, {}), 'carries no effective name', 'an entry with no resolved name');

  // AND THE MOUNT STILL RESOLVES, by whichever spelling Compose used for the source.
  const byEffectiveName = parseResolvedComposeModel(JSON.stringify({
    name: project,
    services: {
      postgres: { image: 'postgres:16', environment: {},
        volumes: [{ type: 'volume', source: `${project}_pgdata`, target: '/var/lib/postgresql/data' }] },
      migrate: { image: CURRENT, environment: {}, volumes: [] },
      app: { image: CURRENT, environment: {}, volumes: [] },
      sidecar: { image: CURRENT, environment: {}, volumes: [] },
    },
    volumes: { pgdata: { name: `${project}_pgdata` } }, networks: {}, secrets: {}, configs: {},
  }), 'resolved disposable stack');
  validateResolvedCompose(byEffectiveName, {
    projectName: project,
    disposableRoot: resolved.disposableRoot,
    workspace: null,
    pinnedImages: null,
    wiring: requiredRehearsalWiring(),
  });
  refuses(() => validateResolvedCompose(parseResolvedComposeModel(JSON.stringify({
    name: project,
    services: {
      postgres: { image: 'postgres:16', environment: {},
        volumes: [{ type: 'volume', source: 'a-volume-nobody-declared', target: '/var/lib/postgresql/data' }] },
      migrate: { image: CURRENT, environment: {}, volumes: [] },
      app: { image: CURRENT, environment: {}, volumes: [] },
      sidecar: { image: CURRENT, environment: {}, volumes: [] },
    },
    volumes: { pgdata: { name: `${project}_pgdata` } }, networks: {}, secrets: {}, configs: {},
  }), 'resolved disposable stack'), {
    projectName: project,
    disposableRoot: resolved.disposableRoot,
    workspace: null,
    pinnedImages: null,
    wiring: requiredRehearsalWiring(),
  }), 'the definition does not declare', 'a mount naming a volume nobody declared');
});

test('the resolved-stack digest moves when any value a refusal rests on moves', () => {
  // THE DEFECT: the digest hashed a top-level resource's KEY and `external` flag — exactly the two fields
  // that turned out to decide nothing. A volume that gained a global name, a `device:` option or another
  // driver produced a BYTE-IDENTICAL digest, so the value recorded as "this is the stack that was checked"
  // could not have told the difference between the checked stack and one that reaches production.
  const project = 'catalog-rehearsal-r1';
  const stack = (volumes: Record<string, unknown>) => parseResolvedComposeModel(JSON.stringify({
    name: project,
    services: { app: { image: CURRENT, environment: {}, volumes: [] } },
    volumes, networks: {}, secrets: {}, configs: {},
  }), 'resolved disposable stack');
  const safe = resolvedComposeDigest(stack({ pgdata: { name: `${project}_pgdata` } }));
  assertEq(resolvedComposeDigest(stack({ pgdata: { name: `${project}_pgdata` } })), safe, 'it is stable');
  for (const [what, volumes] of [
    ['an explicit global name', { pgdata: { name: 'catalog-authority-pgdata' } }],
    ['a driver', { pgdata: { name: `${project}_pgdata`, driver: 'local' } }],
    ['a host-bind driver option', {
      pgdata: {
        name: `${project}_pgdata`, driver_opts: { type: 'none', o: 'bind', device: '/somewhere/on/the/host' },
      },
    }],
    ['a different driver option value', {
      pgdata: { name: `${project}_pgdata`, driver_opts: { device: '/somewhere/else' } },
    }],
    ['an external flag', { pgdata: { name: `${project}_pgdata`, external: true } }],
    ['a key nobody has read', { pgdata: { name: `${project}_pgdata`, some_future_mechanism: 'x' } }],
  ] as Array<[string, Record<string, unknown>]>) {
    assert(resolvedComposeDigest(stack(volumes)) !== safe, `${what} is a different stack, so a different digest`);
  }
});

test('Compose 2.40 resolved KEY=value environment arrays are accepted, while unresolved forms are refused', () => {
  const model = parseResolvedComposeModel(JSON.stringify({
    name: 'catalog-rehearsal-r1',
    services: {
      app: {
        image: CURRENT,
        environment: [
          'APP_ENV=production',
          'DATABASE_URL_FILE=/run/catalog-rehearsal-secrets/database_url',
          'VALUE_WITH_EQUALS=left=right',
        ],
        volumes: [],
      },
    },
    volumes: {}, networks: {}, secrets: {}, configs: {},
  }), 'Compose 2.40 resolved stack');
  assertEq(model.services[0]!.environment.APP_ENV, 'production', 'an exact assignment is read');
  assertEq(model.services[0]!.environment.DATABASE_URL_FILE,
    '/run/catalog-rehearsal-secrets/database_url', 'a file-path assignment is read');
  assertEq(model.services[0]!.environment.VALUE_WITH_EQUALS, 'left=right',
    'only the first equals sign separates the name from the value');

  const withEnvironment = (environment: unknown): string => JSON.stringify({
    name: 'catalog-rehearsal-r1',
    services: { app: { image: CURRENT, environment, volumes: [] } },
    volumes: {}, networks: {}, secrets: {}, configs: {},
  });
  refuses(() => parseResolvedComposeModel(withEnvironment(['UNRESOLVED']), 'resolved stack'),
    'unresolved environment', 'a bare pass-through name');
  refuses(() => parseResolvedComposeModel(withEnvironment(['A=one', 'A=two']), 'resolved stack'),
    'duplicate environment assignment', 'a duplicate assignment');
  refuses(() => parseResolvedComposeModel(withEnvironment([{}]), 'resolved stack'),
    'environment entry this build cannot read', 'a non-string array entry');
  refuses(() => parseResolvedComposeModel(withEnvironment({ FROM_CALLER: null }), 'resolved stack'),
    'unresolved environment', 'a null mapping value');
});

test('no ambient variable can reach a compose command, and an unresolved one is refused', () => {
  // THE ENVIRONMENT IS AN ALLOWLIST, AND IT IS THE SECOND HALF OF THE INTERPOLATION RULE. The definition may
  // name no variable; and even if one slipped through, none of the ones that decide where the shipped stacks
  // point is ever handed to a child process.
  const hostile: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    CATALOG_AUTHORITY_APPDATA_DIR: '/mnt/user/appdata/catalog',
    CATALOG_AUTHORITY_OPS_IMAGE: 'something-else',
    COMPOSE_FILE: 'a-file-nobody-named.yml',
    COMPOSE_PROJECT_NAME: 'catalogauthority',
    OPERATOR_UI_TOKEN: 'a-token',
  };
  const narrowed = narrowedEnvironment(hostile);
  assertEq(narrowed.PATH, '/usr/bin', 'a command can still be found');
  assertEq(narrowed.DOCKER_HOST, 'unix:///var/run/docker.sock', 'and the daemon it talks to is still chosen');
  for (const name of ['CATALOG_AUTHORITY_APPDATA_DIR', 'CATALOG_AUTHORITY_OPS_IMAGE', 'COMPOSE_FILE',
    'COMPOSE_PROJECT_NAME', 'OPERATOR_UI_TOKEN']) {
    assertEq(narrowed[name], undefined, `${name} never reaches a compose command`);
  }

  // And a source that still carries a variable is refused rather than joined onto a root and called contained.
  const world = makeWorld('unresolved-variable');
  const resolved = resolveRehearsal(req(world));
  const model = parseResolvedComposeModel(JSON.stringify({
    name: resolved.projectName,
    services: {
      postgres: { image: 'postgres:16', environment: {},
        volumes: [{ type: 'bind', source: '${CATALOG_AUTHORITY_APPDATA_DIR}/pgdata', target: '/var/lib/postgresql/data' }] },
      migrate: { image: CURRENT, environment: {}, volumes: [] },
      app: { image: CURRENT, environment: {}, volumes: [] },
      sidecar: { image: CURRENT, environment: {}, volumes: [] },
    },
    volumes: {}, networks: {}, secrets: {}, configs: {},
  }), 'resolved disposable stack');
  refuses(() => validateResolvedCompose(model, {
    projectName: resolved.projectName,
    disposableRoot: resolved.disposableRoot,
    workspace: join(resolved.disposableRoot, REHEARSAL_RESTORE_DIRNAME),
    pinnedImages: pinnedImagesFor(resolved, 'current'),
    wiring: requiredRehearsalWiring(),
  }), 'still carries a variable', 'an unsubstituted bind source');
});

test('after the merge, a Docker socket, an escape from the root or a writable bind outside the workspace is refused', () => {
  // These are the rules that apply once there IS a workspace — the state each override preflight validates.
  // The base definition may declare no bind at all, so these can only be reached through a merge, which is
  // exactly the situation an override cannot undo and must therefore refuse.
  const world = makeWorld('merged-escapes');
  const resolved = resolveRehearsal(req(world));
  const workspace = join(resolved.disposableRoot, REHEARSAL_RESTORE_DIRNAME);
  const wiring = requiredRehearsalWiring();
  const mountsFor = (service: string) => wiring.filter((entry) => entry.service === service).map((entry) => ({
    type: 'bind',
    source: join(workspace, entry.workspaceEntry),
    target: entry.containerPath,
    read_only: !entry.writable,
  }));
  const environmentFor = (service: string) => {
    const env: Record<string, string> = {};
    for (const entry of wiring.filter((one) => one.service === service)) {
      if (entry.env !== null) env[entry.env] = entry.containerPath;
      Object.assign(env, entry.alsoEnv ?? {});
    }
    return env;
  };
  const stack = (extra: Record<string, unknown>) => parseResolvedComposeModel(JSON.stringify({
    name: resolved.projectName,
    services: {
      postgres: { image: 'postgres:16', environment: environmentFor('postgres'), volumes: mountsFor('postgres') },
      migrate: { image: CURRENT, environment: environmentFor('migrate'), volumes: mountsFor('migrate') },
      app: { image: CURRENT, environment: environmentFor('app'), volumes: mountsFor('app') },
      sidecar: { image: CURRENT, environment: environmentFor('sidecar'), volumes: mountsFor('sidecar') },
      ...extra,
    },
    volumes: {}, networks: {}, secrets: {}, configs: {},
  }), 'resolved disposable stack');
  const check = (model: ReturnType<typeof parseResolvedComposeModel>) => validateResolvedCompose(model, {
    projectName: resolved.projectName,
    disposableRoot: resolved.disposableRoot,
    workspace,
    pinnedImages: pinnedImagesFor(resolved, 'current'),
    wiring,
  });
  // A well-formed one passes, so the refusals below are not vacuous.
  check(stack({}));

  refuses(() => check(stack({
    app: { image: CURRENT, environment: environmentFor('app'),
      volumes: [...mountsFor('app'),
        { type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }] },
  })), 'IS the host', 'a Docker socket mount');
  refuses(() => check(stack({
    app: { image: CURRENT, environment: environmentFor('app'),
      volumes: [...mountsFor('app'),
        { type: 'bind', source: join(world.production, 'secrets'), target: '/somewhere', read_only: true }] },
  })), 'OUTSIDE the disposable rehearsal root', 'a bind reaching production');
  refuses(() => check(stack({
    app: { image: CURRENT, environment: environmentFor('app'),
      volumes: [...mountsFor('app'),
        { type: 'bind', source: resolved.disposableRoot, target: '/somewhere' }] },
  })), 'WRITABLE bind mount outside the restore workspace', 'a writable bind beside the workspace');
  refuses(() => check(stack({
    app: { image: CURRENT, environment: environmentFor('app'),
      volumes: [...mountsFor('app'), { type: 'volume', source: 'a-volume-nobody-declared', target: '/somewhere' }] },
  })), 'the definition does not declare', 'an undeclared named volume');

  // AND THE WIRING ITSELF. A component mounted where the image does not read it, or a variable left pointing
  // at the base definition's production path, is the defect the mount check alone could not see.
  refuses(() => check(stack({
    sidecar: { image: CURRENT, environment: { ...environmentFor('sidecar'), SIDECAR_KEK_FILE: '/run/secrets/custodian_kek' },
      volumes: mountsFor('sidecar') },
  })), 'read the restored "custodian_kek" secret from the', 'a KEK variable still naming a production path');
  refuses(() => check(stack({
    sidecar: { image: CURRENT, environment: environmentFor('sidecar'),
      volumes: mountsFor('sidecar').filter((mount) => !mount.target.endsWith('catalog-sidecar/state')) },
  })), 'does not mount anything at the path', 'a sidecar with no restored keystore');
});

test('the SHIPPED Unraid stack is refused as a disposable definition, which is what it is', () => {
  // THE DEFECT, EXACTLY AS DOCUMENTED. The shipped launcher stack binds `${CATALOG_AUTHORITY_APPDATA_DIR:-
  // /mnt/user/appdata/catalog}` — production BY DEFAULT — and declares six Docker secrets naming real key
  // material. Following the previous documentation would have rehearsed against production while the report
  // said `touchedProduction: false`.
  const world = worldWith('shipped-stack', readRepo('docker-compose.unraid.runtime.yml'));
  refuses(() => resolveRehearsal(req(world)), 'interpolates an environment variable',
    'the shipped launcher stack as a disposable definition');
  assertEq(existsSync(join(world.disposable, REHEARSAL_MARKER_NAME)), false, 'and nothing was claimed');

  // ...and so is anything that brings part of the stack in from outside the file the digest binds.
  for (const [key, line] of [
    ['env_file', '    env_file:\n      - ./somewhere.env'],
    ['extends', '    extends:\n      file: another.yml\n      service: app'],
    ['profiles', '    profiles:\n      - rehearsal'],
  ] as Array<[string, string]>) {
    const other = worldWith(`external-${key}`,
      DISPOSABLE_COMPOSE.replace('  app:\n', `  app:\n${line}\n`));
    refuses(() => resolveRehearsal(req(other)), `uses "${key}"`, `a definition using ${key}`);
  }
  const included = worldWith('external-include', `include:\n  - another.yml\n${DISPOSABLE_COMPOSE}`);
  refuses(() => resolveRehearsal(req(included)), 'uses "include"', 'a definition using include');

  // And a `.env` beside it, which Compose reads whether or not anybody meant it to.
  const dotenv = makeWorld('dotenv');
  writeFileSync(join(dotenv.disposable, '.env'), 'COMPOSE_PROFILES=something\n', 'utf8');
  refuses(() => resolveRehearsal(req(dotenv)), '".env" file', 'a .env beside the definition');
});

test('the resolved stack shows every restored component as the EFFECTIVE source, at the path its image reads', () => {
  // THE DEFECT: the keystore and a generic secrets directory were mounted into `app`, which in sidecar custody
  // mode reads neither — while `sidecar` kept the base definition's state bind and its `/run/secrets/*` files.
  const world = makeWorld('effective-sources');
  const { tools } = rehearse(world);
  const workspace = join(world.disposable, REHEARSAL_RESTORE_DIRNAME);
  // Every configuration this run validated, not only the last.
  const overrideModels = tools.configurations.filter((stack) => Object.values(stack.services)
    .some((service) => String((service as Record<string, unknown>).image ?? '').includes('v1.1.')));
  assert(overrideModels.length >= 2, 'both overrides were resolved');
  for (const stack of overrideModels) {
    const mountsOf = (service: string): Array<Record<string, unknown>> =>
      ((stack.services[service] as Record<string, unknown>).volumes ?? []) as Array<Record<string, unknown>>;
    const sourceAt = (service: string, target: string): string => {
      const found = mountsOf(service).find((mount) => mount.target === target);
      return found === undefined ? 'nothing is mounted there' : String(found.source);
    };
    const environmentOf = (service: string): Record<string, string> =>
      (stack.services[service] as Record<string, unknown>).environment as Record<string, string>;

    assertEq(sourceAt('sidecar', '/var/lib/catalog-sidecar/state'),
      join(workspace, COMPONENT_ARTIFACT_NAMES.keystore), 'the SIDECAR state directory is the restored keystore');
    assertEq(environmentOf('sidecar').SIDECAR_STATE_DIR, '/var/lib/catalog-sidecar/state',
      'and the sidecar is told to read it there');
    assertEq(sourceAt('sidecar', '/run/catalog-rehearsal-secrets/custodian_kek'),
      join(workspace, COMPONENT_ARTIFACT_NAMES.secrets, 'custodian_kek'), 'the KEK is the restored one');
    assertEq(environmentOf('sidecar').SIDECAR_KEK_FILE, '/run/catalog-rehearsal-secrets/custodian_kek',
      'and the sidecar reads it from there rather than from /run/secrets');
    assertEq(sourceAt('postgres', '/restore/catalog-backup.sql'),
      join(workspace, COMPONENT_ARTIFACT_NAMES.database), 'the dump the restore replays is the restored one');
    assertEq(environmentOf('postgres').POSTGRES_PASSWORD_FILE, '/run/catalog-rehearsal-secrets/postgres_password',
      'and postgres takes its password from the restored secret');
    assertEq(sourceAt('app', '/var/lib/catalog/promotion-records'),
      join(workspace, COMPONENT_ARTIFACT_NAMES['promotion-records']), 'promotion records are the restored ones');
    assertEq(sourceAt('app', `/var/lib/catalog/import/${REHEARSAL_IMPORT_NAME}`),
      join(workspace, REHEARSAL_IMPORT_NAME), 'and the representative import is the copied one');
    // EVERY REQUIRED SECRET, at the exact path and variable its consumer uses.
    for (const [file, consumers] of Object.entries(REHEARSAL_SECRET_CONSUMERS)) {
      for (const consumer of consumers) {
        const target = `/run/catalog-rehearsal-secrets/${file}`;
        assertEq(sourceAt(consumer.service, target),
          join(workspace, COMPONENT_ARTIFACT_NAMES.secrets, file), `${consumer.service} reads the restored ${file}`);
        if (consumer.env === null) {
          // A CUSTODY SECRET THE STACK CHOOSES BETWEEN. Mounted so a restore that lost it fails, and
          // deliberately NOT pointed at — the sidecar refuses to start wired to both key sources, so which
          // one is used is the operator's migration state and not this command's to decide.
          const environment = environmentOf(consumer.service);
          for (const [name, value] of Object.entries(environment)) {
            assert(value !== target, `nothing points at ${file}: ${name} does`);
          }
          continue;
        }
        assertEq(environmentOf(consumer.service)[consumer.env], target, `and ${consumer.env} names it`);
      }
    }
  }
  // AND NO PRODUCTION SOURCE SURVIVED ANYWHERE. Every bind in either resolved stack is inside the workspace.
  for (const stack of overrideModels) {
    for (const service of Object.values(stack.services)) {
      for (const mount of (((service as Record<string, unknown>).volumes ?? []) as Array<Record<string, unknown>>)) {
        if (mount.type !== 'bind') continue;
        assert(String(mount.source).startsWith(workspace), `a bind points outside the workspace: ${String(mount.source)}`);
      }
    }
  }
});

test('every required secret file has a declared consumer, and every one is the shipped stack\'s own', () => {
  // ANTI-DRIFT, THE SAME RULE THE COMPONENT MODEL FOLLOWS. A stack that starts requiring a seventh secret must
  // not leave a rehearsal quietly restoring six and calling the restore complete.
  const declared = Object.keys(REHEARSAL_SECRET_CONSUMERS).slice().sort().join(',');
  assertEq(declared, [...REQUIRED_SECRET_FILES].slice().sort().join(','),
    'the consumer map covers exactly the required secret files');
  // PHASE 289. THE SHIPPED UNRAID STACK IS TWO SELECTABLE FILES. The steady state is root-only custody; the
  // static KEK — which an installation that has not migrated still needs, and which a rehearsal must still
  // restore — is declared and read in the temporary bootstrap overlay. Reading only the steady-state file
  // here would assert that a secret half the fleet depends on has no consumer at all.
  const shipped = readRepo('docker-compose.unraid.runtime.yml')
    + readRepo('docker-compose.unraid.bootstrap.yml');
  for (const consumers of Object.values(REHEARSAL_SECRET_CONSUMERS)) {
    for (const consumer of consumers) {
      if (consumer.env !== null) {
        assert(shipped.includes(`${consumer.env}:`), `the shipped stack reads ${consumer.env}`);
      }
      assert(shipped.includes(`  ${consumer.service}:`), `and has a ${consumer.service} service`);
    }
  }
  for (const wiring of requiredRehearsalWiring()) {
    assert(REHEARSAL_SERVICES.includes(wiring.service), `${wiring.service} is one of the modelled services`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// THE CANDIDATE MIGRATION IS PINNED
// ---------------------------------------------------------------------------------------------------------

test('every product service — migrate and sidecar as well as app — runs the leg\'s own image', () => {
  // THE DEFECT: only `app.image` was pinned. In this stack `migrate` and `sidecar` are the SAME product image,
  // so the candidate leg ran the candidate app against the CURRENT build's migration and custodian sidecar —
  // and the migration is the entire reason a rollback is hard.
  const world = makeWorld('pinning');
  const { report, tools } = rehearse(world);
  assertEq(report.ok, true, 'the rehearsal held');
  assert(tools.ups.length >= 4, `every leg booted: ${tools.ups.length}`);
  for (const up of tools.ups) {
    for (const service of ['migrate', 'app', 'sidecar']) {
      assertEq(up.images[service], up.image, `${service} runs the same image as the app on every boot`);
    }
  }
  const legs = tools.ups.map((up) => up.images.migrate);
  assert(legs.includes(CANDIDATE), 'the CANDIDATE migration really ran');
  assertEq(legs[legs.length - 1], CURRENT, 'and the rollback put the current migration back');
  assertEq(tools.ups[tools.ups.length - 1]!.images.sidecar, CURRENT, 'with the current sidecar');

  // ...and each override file itself pins all three, which is what makes the above true.
  for (const [role, image] of [['current', CURRENT], ['candidate', CANDIDATE]] as Array<['current' | 'candidate', string]>) {
    const text = readFileSync(join(world.disposable, REHEARSAL_OVERRIDE_NAMES[role]), 'utf8');
    assertEq(text.split(`image: "${image}"`).length - 1, 3, `the ${role} override pins three product services`);
  }
});

test('an override that pinned only the app is refused by the resolved model', () => {
  // The check that catches the defect, exercised directly: a stack where `migrate` is still on the base
  // reference must not resolve to something this command is willing to boot.
  const world = makeWorld('pin-only-app');
  const resolved = resolveRehearsal(req(world));
  const model = parseResolvedComposeModel(JSON.stringify({
    name: resolved.projectName,
    services: {
      postgres: { image: 'postgres:16', environment: {}, volumes: [] },
      migrate: { image: 'catalog-authority-ops:v0.0.0-placeholder', environment: {}, volumes: [] },
      app: { image: CANDIDATE, environment: {}, volumes: [] },
      sidecar: { image: 'catalog-authority-ops:v0.0.0-placeholder', environment: {}, volumes: [] },
    },
    volumes: {}, networks: {}, secrets: {}, configs: {},
  }), 'resolved disposable stack');
  refuses(() => validateResolvedCompose(model, {
    projectName: resolved.projectName,
    disposableRoot: resolved.disposableRoot,
    workspace: null,
    pinnedImages: pinnedImagesFor(resolved, 'candidate'),
    wiring: requiredRehearsalWiring(),
  }), 'does not run this leg\'s image on "migrate"', 'a stack with an unpinned migration');

  // And a pin naming a service the definition does not declare is refused rather than inventing one.
  const pinned = parseResolvedComposeModel(JSON.stringify({
    name: resolved.projectName,
    services: {
      postgres: { image: 'postgres:16', environment: {}, volumes: [] },
      migrate: { image: CANDIDATE, environment: {}, volumes: [] },
      app: { image: CANDIDATE, environment: {}, volumes: [] },
      sidecar: { image: CANDIDATE, environment: {}, volumes: [] },
    },
    volumes: {}, networks: {}, secrets: {}, configs: {},
  }), 'resolved disposable stack');
  refuses(() => validateResolvedCompose(pinned, {
    projectName: resolved.projectName,
    disposableRoot: resolved.disposableRoot,
    workspace: null,
    pinnedImages: { ...pinnedImagesFor(resolved, 'candidate'), 'a-service-nobody-declared': CANDIDATE },
    wiring: requiredRehearsalWiring(),
  }), 'never adds one', 'a phantom service');
});

// ---------------------------------------------------------------------------------------------------------
// THE PLAN DIGEST BINDS BYTES, NOT PATHS
// ---------------------------------------------------------------------------------------------------------

test('swapping the compose definition, the import snapshot or the backup set after --plan is refused', () => {
  // THE DEFECT: the digest hashed the three PATHS. Between the plan an operator reads and the command they
  // run, the definition could gain a production bind, the snapshot could be replaced, and the whole set could
  // be swapped for another one at the same name — and every one of those still confirmed the digest shown.
  for (const [what, swap] of [
    ['the compose definition', (world: World) => {
      writeFileSync(join(world.disposable, COMPOSE_FILE), `${DISPOSABLE_COMPOSE}# and one more line\n`, 'utf8');
    }],
    ['the import snapshot', (world: World) => {
      writeFileSync(world.importSnapshot, '{"records":[{"title":"a DIFFERENT record"}]}\n', 'utf8');
    }],
    ['the backup set', (world: World) => {
      // A DIFFERENT SET, VERIFYING PERFECTLY, AT THE SAME PATH — which is exactly what a retention schedule
      // writing a new set over an old name does.
      const other = makeWorld('swap-replacement-set', 'a-completely-different-kek');
      rmSync(world.backupSet, { recursive: true, force: true });
      cpSync(other.backupSet, world.backupSet, { recursive: true });
    }],
  ] as Array<[string, (world: World) => void]>) {
    const world = makeWorld(`swap-${what.replace(/[^a-z]/g, '')}`);
    // The operator reads the plan and copies its digest.
    const planned = resolveRehearsal(req(world));
    swap(world);
    const tools = rehearsalWorld({ disposableRoot: world.disposable, images: images(), setSchema: SET_SCHEMA });
    refuses(() => runRehearsal(req(world, { confirmDigest: planned.planDigest }),
      { runner: tools.runner, ledger: tools.ledger }), 'digest you confirmed', `${what} swapped after the plan`);
    assertEq(tools.lines().length, 0, `${what}: and nothing was started`);
    assertEq(existsSync(join(world.disposable, REHEARSAL_MARKER_NAME)), false, `${what}: nothing was claimed`);
    // The plan digest MOVED because the content moved, which is the property that makes the refusal possible.
    assert(resolveRehearsal(req(world)).planDigest !== planned.planDigest, `${what} is a different plan`);
  }
});

test('a definition swapped between the resolve and the marker claim is refused at the claim', () => {
  // The other window: `resolveRehearsal` reads the three inputs, then steps run, and the marker is claimed.
  // Anything with write access to that directory can act in between, including this product's own scheduler.
  const world = makeWorld('swap-mid-run');
  const resolved = resolveRehearsal(req(world));
  const tools = rehearsalWorld({ disposableRoot: world.disposable, images: images(), setSchema: SET_SCHEMA });
  const swapping = (command: Parameters<typeof tools.runner>[0]) => {
    const outcome = tools.runner(command);
    // The resolve has just happened and the claim has not. This is the whole window.
    if (command.args.includes('config')) {
      writeFileSync(join(world.disposable, COMPOSE_FILE), `${DISPOSABLE_COMPOSE}# swapped mid-run\n`, 'utf8');
    }
    return outcome;
  };
  const report = runRehearsal(req(world, { confirmDigest: resolved.planDigest }),
    { runner: swapping, ledger: tools.ledger });
  assertEq(report.ok, false, 'the run stopped');
  const stopped = report.steps.find((step) => !step.ok)!;
  assertEq(stopped.id, 'own-the-root', 'at the claim, which is the last moment before anything is created');
  assert(stopped.detail.includes('its contents changed after'), `saying why: ${stopped.detail}`);
  assertEq(existsSync(join(world.disposable, REHEARSAL_MARKER_NAME)), false, 'and no marker was written');
  assertEq(existsSync(join(world.disposable, REHEARSAL_RESTORE_DIRNAME)), false, 'and no workspace was prepared');
});

// ---------------------------------------------------------------------------------------------------------
// A BODY IS NEVER A PASS ON ITS OWN, AND A REPLAY IS NOT IDEMPOTENCE
// ---------------------------------------------------------------------------------------------------------

test('a healthy body behind a FAILED process is a failure, not a pass', () => {
  // THE DEFECT: `doctor-no-fail` and `schema-version` refused only when a failed process had ALSO printed
  // nothing — so a process that failed while printing a healthy report passed both.
  const doctor = rehearse(makeWorld('healthy-body-failed-process'), {
    doctorJson: fakeDoctorJson(['pass', 'pass']),
    doctorStatus: 1,
  });
  assertEq(doctor.report.ok, false, 'a doctor that printed health and did not succeed is not a pass');
  const failedDoctor = doctor.report.steps.find((step) => !step.ok)!;
  assertEq(failedDoctor.id, 'current-doctor', 'and it is the doctor step');
  assert(failedDoctor.detail.includes('do not agree'), `saying what is wrong: ${failedDoctor.detail}`);

  // ...and the same for the schema reader, whose matching line behind a non-zero exit used to pass.
  const world = makeWorld('schema-body-failed-process');
  const resolved = resolveRehearsal(req(world));
  const tools = rehearsalWorld({ disposableRoot: world.disposable, images: images(), setSchema: SET_SCHEMA });
  const failingVersion = (command: Parameters<typeof tools.runner>[0]) => {
    const outcome = tools.runner(command);
    return command.args.join(' ').includes('ops:version') ? { ...outcome, status: 1 } : outcome;
  };
  const report = runRehearsal(req(world, { confirmDigest: resolved.planDigest }),
    { runner: failingVersion, ledger: tools.ledger });
  assertEq(report.ok, false, 'a schema line behind a failed process is not a pass');
  const failedSchema = report.steps.find((step) => !step.ok)!;
  assertEq(failedSchema.id, 'current-schema', 'and it is the schema step');
  assert(failedSchema.detail.includes('do not agree'), `saying what is wrong: ${failedSchema.detail}`);
});

test('output larger than this command will read as evidence is a failure, not a parse', () => {
  const world = makeWorld('unbounded-output');
  const resolved = resolveRehearsal(req(world));
  const tools = rehearsalWorld({ disposableRoot: world.disposable, images: images(), setSchema: SET_SCHEMA });
  const shouting = (command: Parameters<typeof tools.runner>[0]) => {
    const outcome = tools.runner(command);
    return command.args.join(' ').includes('pkg get version')
      ? { ...outcome, stdout: `${'x'.repeat(MAX_ASSERTION_STDOUT_BYTES + 1)}` } : outcome;
  };
  const report = runRehearsal(req(world, { confirmDigest: resolved.planDigest }),
    { runner: shouting, ledger: tools.ledger });
  assertEq(report.ok, false, 'the rehearsal did not hold');
  assert(report.steps.find((step) => !step.ok)!.detail.includes('more output than'), 'and says why');
});

test('a replay that exits ZERO and reports a duplicate write is NOT idempotence', () => {
  // THE DEFECT: two exit-zero `--apply` calls were the whole of the idempotence claim. An import that
  // re-created every record would exit zero and would have doubled the catalog.
  const world = makeWorld('false-idempotence');
  const { report } = rehearse(world, { importReplayDuplicates: true });
  assertEq(report.ok, false, 'the rehearsal did not hold');
  const stopped = report.steps.find((step) => !step.ok)!;
  assertEq(stopped.id, 'candidate-import-replay', 'and it is the replay that failed');
  assert(stopped.detail.includes('not idempotent'), `saying what that means: ${stopped.detail}`);
  assertEq(report.importIdempotence, 'not-proved', 'and the evidence says so as a closed word');

  // On a good run it IS proved, and the apply really did write something for the replay to not repeat.
  const good = rehearse(makeWorld('true-idempotence'));
  assertEq(good.report.importIdempotence, 'proved', 'a real run proves it');
  const applies = good.tools.appCommands.filter((entry) => entry.includes('catalog-import') && entry.includes('--apply'));
  assertEq(applies.length, 2, 'from exactly two applies');
  for (const entry of good.tools.appCommands.filter((entry) => entry.includes('catalog-import'))) {
    assert(entry.includes('--json'), `every import reads its own report: ${entry}`);
  }

  // A snapshot that changes nothing is a WEAKER result, and gets a different word rather than the same one.
  const vacuous = rehearse(makeWorld('vacuous-idempotence'), { importRecords: 0 });
  assertEq(vacuous.report.ok, false, 'and a snapshot with no records at all does not hold');
  assert(vacuous.report.steps.find((step) => !step.ok)!.detail.includes('proves nothing'), 'saying why');
});

test('the shipped import report is read by name and shape, never guessed at', () => {
  const good = JSON.stringify({
    ok: true, report: 'phase-259-catalog-import', mode: 'apply',
    total: 2, created: 2, updated: 0, unchanged: 0, blocked: 0, failed: 0, notAttempted: 0, items: [], notes: [],
  });
  assertEq(readImportReport(good)!.created, 2, 'the shipped report parses');
  assertEq(readImportReport(good.replace('phase-259-catalog-import', 'something-else')), null,
    'another report is not this one');
  assertEq(readImportReport(good.replace('"created":2', '"created":-1')), null, 'a negative count is not a count');
  assertEq(readImportReport(good.replace('"mode":"apply"', '"mode":"whatever"')), null, 'nor is an unknown mode');
  assertEq(readImportReport('not json at all'), null, 'and text is not a report');
  assertEq(readImportReport(`{"x":"${'y'.repeat(MAX_ASSERTION_STDOUT_BYTES)}"}`), null, 'nor is something enormous');
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
  // BOTH FILES OF THE MODULE. The Compose validator is new and reasons about host paths, which is exactly the
  // kind of file a media path could arrive in without anybody meaning it to.
  for (const file of ['src/ops/upgrade-rehearsal.ts', 'src/ops/rehearsal-compose-model.ts']) {
    const source = readRepo(file);
    for (const forbidden of ['jellyfin', 'plex', 'emby', '/mnt/user/media', '.mkv', 'nzb', 'torrent', 'magnet',
      'curl', 'wget', 'docker pull', 'docker login', 'docker push']) {
      assert(!source.toLowerCase().includes(forbidden.toLowerCase()), `${file} must not name ${forbidden}`);
    }
  }
  // And the guard would refuse one even if a future edit built it.
  refuses(() => assertPermittedCommand({ program: 'docker', args: ['compose', 'pull'], cwd: WORK, purpose: 'p' }),
    'compose subcommands', 'a compose pull');
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
