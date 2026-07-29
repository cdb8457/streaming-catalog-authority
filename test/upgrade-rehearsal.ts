import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_SECRET_FILES } from '../src/ops/backup-components.js';
import { COMPONENT_ARTIFACT_NAMES, runCompleteBackup, type CompleteBackupRequest } from '../src/ops/complete-backup.js';
import {
  FLOATING_TAGS,
  REHEARSAL_PROJECT_PREFIX,
  assertDisposableRootIsEmptyish,
  assertImmutableImageRef,
  digestConfirmed,
  planRehearsal,
  rehearsalPlanDigest,
  renderRehearsal,
  resolveRehearsal,
  runRehearsal,
  type RehearsalRequestWithConfirmation,
} from '../src/ops/upgrade-rehearsal.js';
import { assertPermittedCommand } from '../src/ops/maintenance-safety.js';
import { parseRehearsalArgs } from '../src/ops/upgrade-rehearsal-cli.js';
import { assertLedgerIsClean, fakeDoctorJson, fakeToolchain } from './helpers/fake-toolchain.js';

// Phases 279-280 — the disposable upgrade rehearsal, and the rollback that makes an upgrade reversible.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - IT RUNS SOMEWHERE ELSE, PROVED FOUR WAYS: a marker-owned project name, a disposable root that is
//     neither production nor inside it nor containing it, a project name that is not production's, and every
//     command's `cwd` in the disposable root.
//   - IMAGES ARE IMMUTABLE. `latest` and its friends are refused by name, a bare repository is refused, and a
//     digest is accepted.
//   - NOTHING RUNS WITHOUT THE EXACT PLAN DIGEST, and nothing runs without a backup set that verifies NOW.
//   - THE ROLLBACK IS A RESTORE, NOT AN IMAGE CHANGE. The leg tears the upgraded state down, restores the
//     SAME set, and boots the previous image.
//   - A FAILED STEP KEEPS THE EVIDENCE AND REMOVES NOTHING, and the cleanup that does run names only this
//     rehearsal's own project.
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

/** A production project with a verified backup set in it, and a disposable root beside it. */
function makeWorld(name: string): { production: string; disposable: string; backupSet: string } {
  const world = join(WORK, name);
  const production = join(world, 'production');
  const disposable = join(world, 'disposable');
  mkdirSync(join(production, 'secrets'), { recursive: true });
  mkdirSync(join(production, 'promotion-records'), { recursive: true });
  mkdirSync(disposable, { recursive: true });
  for (const file of REQUIRED_SECRET_FILES) writeFileSync(join(production, 'secrets', file), `${file}\n`, 'utf8');
  writeFileSync(join(production, 'promotion-records', 'r.json'), '{}\n', 'utf8');

  const request: CompleteBackupRequest = {
    projectRoot: production, destination: 'backups', setName: 'set-1', custodian: 'inline',
    secrets: 'secrets', promotionRecords: 'promotion-records',
  };
  const tools = fakeToolchain();
  runCompleteBackup(request, { runner: tools.runner, ledger: tools.ledger });
  return { production, disposable, backupSet: join(production, 'backups', 'set-1') };
}

function req(world: ReturnType<typeof makeWorld>, overrides: Partial<RehearsalRequestWithConfirmation> = {}): RehearsalRequestWithConfirmation {
  return {
    productionRoot: world.production,
    productionProject: 'catalogauthority-local',
    disposableRoot: world.disposable,
    label: 'r1',
    backupSet: world.backupSet,
    currentImage: CURRENT,
    candidateImage: CANDIDATE,
    confirmDigest: null,
    ...overrides,
  };
}

console.log('Running Phase 279-280 upgrade and rollback rehearsal suite:\n');

// ---------------------------------------------------------------------------------------------------------
// Immutable images
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
  refuses(() => resolveRehearsal(req(world, { productionRoot: join(world.disposable) , disposableRoot: world.disposable })),
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

test('a disposable root that looks like a real installation is refused', () => {
  const world = makeWorld('looks-real');
  mkdirSync(join(world.disposable, 'secrets'), { recursive: true });
  // The resolve itself allows it; the CLI preflight is what refuses, and it is exported so this can prove it.
  refuses(() => assertDisposableRootIsEmptyish(world.disposable), 'looks like', 'a disposable root with secrets in it');
});

test('a backup set inside the disposable root is refused: the cleanup owns that directory', () => {
  const world = makeWorld('set-inside');
  const inside = join(world.disposable, 'backups', 'set-1');
  mkdirSync(inside, { recursive: true });
  refuses(() => resolveRehearsal(req(world, { backupSet: inside })), 'the cleanup removes',
    'a set inside the disposable root');
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

  // The digest is deterministic over what decides the run, and moves when any of it moves.
  assertEq(rehearsalPlanDigest(resolved), resolved.planDigest, 'the digest is stable');
  const other = resolveRehearsal(req(world, { candidateImage: 'catalog-authority-ops:v1.2.0' }));
  assert(other.planDigest !== resolved.planDigest, 'and a different candidate is a different plan');
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

// ---------------------------------------------------------------------------------------------------------
// The two legs
// ---------------------------------------------------------------------------------------------------------

function rehearse(world: ReturnType<typeof makeWorld>, options: Parameters<typeof fakeToolchain>[0] = {}, overrides: Partial<RehearsalRequestWithConfirmation> = {}) {
  const resolved = resolveRehearsal(req(world, overrides));
  const tools = fakeToolchain(options);
  const report = runRehearsal(req(world, { ...overrides, confirmDigest: resolved.planDigest }),
    { runner: tools.runner, ledger: tools.ledger });
  return { report, tools, resolved };
}

test('both legs hold, and the rollback is a RESTORE rather than an image change', () => {
  const world = makeWorld('both-legs');
  const { report, tools } = rehearse(world);
  assertEq(report.ok, true, `both legs held: ${JSON.stringify(report.steps.filter((s) => !s.ok))}`);
  assertEq(report.touchedProduction, false, 'production was never addressed');

  const ids = report.steps.map((step) => step.id);
  for (const required of ['restore-current', 'boot-current', 'current-doctor', 'switch-candidate',
    'candidate-doctor', 'candidate-read', 'candidate-history', 'rollback-teardown', 'rollback-restore',
    'rollback-boot', 'rollback-doctor', 'rollback-read']) {
    assert(ids.includes(required), `the rehearsal ran ${required}`);
  }
  // THE ROLLBACK TEARS DOWN AND RESTORES. An image change alone is not a rollback once a migration has run.
  const lines = tools.lines();
  const teardowns = lines.map((line, index) => (line.includes('down -v') ? index : -1)).filter((index) => index >= 0);
  const restores = lines.map((line, index) => (line.includes('psql') ? index : -1)).filter((index) => index >= 0);
  assert(teardowns.length >= 2, 'the upgraded state is destroyed for the rollback');
  assert(restores.length >= 2, 'and the SAME set is restored a second time');
  // The ROLLBACK teardown is the one after the first restore, and the second restore comes after it.
  const rollbackTeardown = teardowns.find((index) => index > restores[0]!);
  assert(rollbackTeardown !== undefined, 'a teardown happens after the upgrade leg');
  assert(restores[1]! > rollbackTeardown, 'and the second restore comes after that teardown');
});

test('every command runs in the disposable root, under the marker project, and never pulls', () => {
  const world = makeWorld('scoping');
  const resolved = resolveRehearsal(req(world));
  for (const command of planRehearsal(resolved)) {
    assertEq(command.cwd, resolved.disposableRoot, `every planned command runs in the disposable root: ${command.args.join(' ')}`);
    assertEq(command.args[0], 'compose', 'and is a compose command');
    assertEq(command.args[1], '-p', 'with an explicit project');
    assertEq(command.args[2], resolved.projectName, 'which is this rehearsal\'s own');
    assertPermittedCommand(command);
    if (command.args.includes('up')) {
      assert(command.args.includes('--pull') && command.args.includes('never'),
        `every up refuses to fetch: ${command.args.join(' ')}`);
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
  // Healthy on the current image, sick on the candidate: the fake answers the same either way, so this
  // injects the failure at the SECOND doctor by failing the whole doctor from the start of the candidate leg.
  const { report, tools } = rehearse(world, { doctorJson: fakeDoctorJson(['pass', 'fail']) });
  assertEq(report.ok, false, 'the rehearsal did not hold');
  const failedStep = report.steps.find((step) => !step.ok);
  assert(failedStep !== undefined, 'a step is recorded as failed');
  assert(failedStep.detail.includes('FAIL'), `and says what the doctor reported: ${failedStep.detail}`);
  // NOTHING WAS REMOVED, and the report says where to look.
  assertEq(report.cleanup.performed, false, 'no cleanup was performed');
  assert(report.notes.some((n) => n.includes('LEFT IN PLACE for diagnosis')), 'and the evidence was kept');
  assert(!tools.lines().slice(-1)[0]!.includes('down -v'), 'the last thing it did was not a teardown');
});

test('a rollback restore that fails is reported as "this upgrade is not reversible"', () => {
  const world = makeWorld('irreversible');
  // The second psql — the rollback restore — fails. The first one must succeed, so the injection counts.
  let seen = 0;
  const tools = fakeToolchain();
  const counting = {
    ...tools,
    runner: (command: Parameters<typeof tools.runner>[0]) => {
      if (command.args.includes('psql')) { seen += 1; if (seen === 2) return { status: 1, stdout: '', stderr: '' }; }
      return tools.runner(command);
    },
  };
  const resolved = resolveRehearsal(req(world));
  const report = runRehearsal(req(world, { confirmDigest: resolved.planDigest }),
    { runner: counting.runner, ledger: tools.ledger });
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

  const removed = rehearse(world, {}, { cleanup: true });
  assertEq(removed.report.cleanup.performed, true, 'with --cleanup the project is removed');
  const last = removed.tools.lines()[removed.tools.lines().length - 1]!;
  assert(last.includes(`-p ${removed.resolved.projectName}`), `and only by this project: ${last}`);
  assert(last.includes('down -v --remove-orphans'), 'through compose, which removes only what it labelled');
  // A failed run NEVER cleans up, even when asked.
  const sick = rehearse(world, { doctorJson: fakeDoctorJson(['fail']) }, { cleanup: true });
  assertEq(sick.report.cleanup.performed, false, 'a failed rehearsal removes nothing even with --cleanup');
  assertEq(sick.report.cleanup.plan.length, 1, 'and leaves exactly one cleanup command as a plan');
  assert(sick.report.cleanup.plan[0]!.includes(sick.resolved.projectName), 'naming only its own project');
});

// ---------------------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------------------

test('the evidence report names no host path, no registry, no address and no secret', () => {
  const world = makeWorld('evidence');
  const { report } = rehearse(world);
  const printed = [renderRehearsal(report), JSON.stringify(report)].join('\n');
  for (const forbidden of [world.production, world.disposable, world.backupSet, WORK,
    'ghcr.io', 'docker.io', '/mnt/user', 'password']) {
    assert(!printed.includes(forbidden), `the evidence carried ${forbidden.slice(0, 40)}`);
  }
  // What it DOES carry is what an operator acts on.
  assert(printed.includes(report.planDigest), 'the plan digest is in the evidence');
  assert(printed.includes(CURRENT) && printed.includes(CANDIDATE), 'and both exact image references');
  assert(printed.includes('set-1'), 'and the set name they chose');
});

test('the CLI requires a plan or a digest, never both, and takes no credential', () => {
  const base = ['--production', '/a/b', '--production-project', 'p', '--disposable', '/a/c', '--label', 'r1',
    '--backup-set', '/a/b/backups/s', '--current-image', CURRENT, '--candidate-image', CANDIDATE];
  const planned = parseRehearsalArgs([...base, '--plan']);
  assertEq(planned.plan, true, 'a plan parses');
  const confirmed = parseRehearsalArgs([...base, '--confirm-digest', 'a'.repeat(64)]);
  assertEq(confirmed.request.confirmDigest, 'a'.repeat(64), 'and a confirmation parses');
  for (const [argv, needle] of [
    [base, '--confirm-digest is required'],
    [[...base, '--plan', '--confirm-digest', 'a'.repeat(64)], 'takes no --confirm-digest'],
    [[...base, '--confirm-digest', 'short'], '64-character digest'],
    [base.slice(2), '--production is required'],
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
