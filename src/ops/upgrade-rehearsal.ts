import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { MIGRATION_VERSION } from '../db/schema-version.js';
import { verifyBackupSet, type BackupVerificationReport } from './backup-set-verification.js';
import { COMPONENT_ARTIFACT_NAMES, readBackupManifest } from './complete-backup.js';
import { classifyDoctor, parseDoctorJson } from './doctor-monitor.js';
import {
  CommandLedger,
  MaintenanceRefused,
  assertUsableName,
  resolveMaintenanceRoot,
  runGuarded,
  type CommandRunner,
  type MaintenanceCommand,
} from './maintenance-safety.js';

// Phases 279 and 280 — rehearsing an upgrade, and rehearsing the rollback that makes it reversible.
//
// WHY A REHEARSAL AT ALL. This product has no down-migrations. That is a deliberate, documented choice, and
// its consequence is that "roll the image back" is not a rollback once a migration has run: the old binary
// meets a schema it does not know. The only real rollback is RESTORE THE PRE-UPGRADE BACKUP — and an operator
// finds out whether that works on the day they need it, in the worst hour of the week, unless something
// rehearses it first.
//
// -----------------------------------------------------------------------------------------------------
// IT HAPPENS SOMEWHERE ELSE, AND "SOMEWHERE ELSE" IS PROVED, NOT ASSERTED.
// -----------------------------------------------------------------------------------------------------
//
// Everything runs in a DISPOSABLE Compose project, in a disposable root, under a project name carrying this
// product's rehearsal marker. Four independent things make that real:
//
//   1. THE PROJECT NAME MUST CARRY THE MARKER. Every command passes `-p catalog-rehearsal-<label>`, so every
//      container, network and volume Compose creates is labelled with it. That label is what the cleanup
//      removes by, so cleanup cannot reach anything this rehearsal did not create.
//   2. THE DISPOSABLE ROOT MUST BE STRUCTURALLY DIFFERENT FROM THE PRODUCTION ROOT. Not merely a different
//      string: resolved, and then required to be neither the production root, nor inside it, nor containing
//      it. A rehearsal that ran in a subdirectory of production would share its volumes' project name and
//      could stop the operator's real stack.
//   3. THE PROJECT NAME MUST NOT BE PRODUCTION'S. Checked against the production project name explicitly,
//      including case, because Compose lower-cases project names and two names that differ only in case are
//      one project.
//   4. NOTHING EVER NAMES THE PRODUCTION ROOT AS A `cwd`. Every command in the plan runs in the disposable
//      root. That is asserted by a test over the planned commands, not promised here.
//
// -----------------------------------------------------------------------------------------------------
// IMAGES ARE IMMUTABLE AND ALREADY PRESENT.
// -----------------------------------------------------------------------------------------------------
//
// A rehearsal of "current -> candidate" is worthless if either ref can move underneath it. `latest` and its
// friends are refused by name; a bare repository with no tag is refused; a digest is accepted and preferred.
// Every `up` carries `--pull never`, and `pull`, `login` and `push` are not in the permitted subcommand set
// at all — so this cannot fetch anything even if a future edit asked it to.
//
// -----------------------------------------------------------------------------------------------------
// AND IT NEEDS A REAL BACKUP FIRST.
// -----------------------------------------------------------------------------------------------------
//
// The disposable stack is populated by RESTORING a complete backup set that has already verified. That is
// what makes the rehearsal about the operator's own data rather than about an empty database, and it is what
// makes the rollback leg honest: the same set, restored again, is exactly what a real rollback would do.
//
// NOTHING HERE TOUCHES MEDIA, A MEDIA SERVER OR AN ACQUISITION SYSTEM. The representative checks are the
// product's own safe primitives — an import replay, the import history, a catalog read — and
// `maintenance-safety.ts` refuses any argument that would reach further.

export const REHEARSAL_REPORT = 'phase-279-280-upgrade-rehearsal';
export const REHEARSAL_VERSION = 1;

/** Every disposable project this product creates begins with it. The cleanup removes by exactly this. */
export const REHEARSAL_PROJECT_PREFIX = 'catalog-rehearsal-';

/** Tags that are not a version. A ref carrying one of these can mean different bytes tomorrow. */
export const FLOATING_TAGS: readonly string[] = Object.freeze([
  'latest', 'edge', 'main', 'master', 'stable', 'nightly', 'dev', 'develop', 'testing', 'rolling', 'head',
]);

export type RehearsalLeg = 'upgrade' | 'rollback';

export interface RehearsalStep {
  readonly id: string;
  readonly leg: RehearsalLeg | 'setup' | 'cleanup';
  /** What it establishes, in one sentence. Never a path, never an address. */
  readonly proves: string;
  readonly ok: boolean;
  /** A closed-set reason when it did not hold. */
  readonly detail: string;
}

export interface RehearsalRequest {
  /** The PRODUCTION project root. Read only to prove the disposable one is not it. Never a `cwd`. */
  readonly productionRoot: string;
  /** The production Compose project name, so the disposable one can be proved different. */
  readonly productionProject: string;
  /** The disposable root. Resolved, and proved structurally separate from production. */
  readonly disposableRoot: string;
  /** The disposable project's label. The full name is the marker prefix plus this. */
  readonly label: string;
  /** The verified backup set to restore, absolute. */
  readonly backupSet: string;
  /** The image the installation runs now. Immutable ref. */
  readonly currentImage: string;
  /** The image being rehearsed. Immutable ref. */
  readonly candidateImage: string;
}

export interface ResolvedRehearsal {
  readonly disposableRoot: string;
  readonly projectName: string;
  readonly backupSet: string;
  readonly currentImage: string;
  readonly candidateImage: string;
  readonly planDigest: string;
}

/**
 * An image reference that cannot mean different bytes tomorrow.
 *
 * A DIGEST IS ALWAYS ACCEPTED. A TAG IS ACCEPTED IF IT IS NOT FLOATING. A bare repository is refused: it
 * means `:latest` and the refusal says so, because "I did not write a tag" and "I chose the moving one" look
 * identical afterwards.
 */
export function assertImmutableImageRef(ref: string, what: string): void {
  if (ref.trim() === '' || ref !== ref.trim()) {
    throw new MaintenanceRefused(`the ${what} image reference is empty or padded`);
  }
  if (/\s/.test(ref)) throw new MaintenanceRefused(`the ${what} image reference contains whitespace`);
  const digest = /^([^@\s]+)@sha256:([0-9a-f]{64})$/.exec(ref);
  if (digest !== null) return;
  const tagged = /^([^@:\s]+(?::[0-9]+)?(?:\/[^@:\s]+)*):([A-Za-z0-9_][A-Za-z0-9._-]{0,127})$/.exec(ref);
  if (tagged === null) {
    throw new MaintenanceRefused(
      `the ${what} image reference has no tag and no digest, which means "latest" and therefore means "whatever `
      + 'that is next week". Give an exact version tag or a sha256 digest.');
  }
  const tag = tagged[2]!.toLowerCase();
  if (FLOATING_TAGS.includes(tag)) {
    throw new MaintenanceRefused(
      `the ${what} image reference is tagged "${tagged[2]}", which is a moving tag. A rehearsal of a moving tag `
      + 'proves nothing about what will actually be deployed. Give an exact version tag or a sha256 digest.');
  }
}

/** Validate everything, and refuse anything that could reach production. */
export function resolveRehearsal(request: RehearsalRequest): ResolvedRehearsal {
  assertUsableName(request.label, 'rehearsal label');
  const projectName = `${REHEARSAL_PROJECT_PREFIX}${request.label}`.toLowerCase();

  const productionRoot = resolveMaintenanceRoot(request.productionRoot, 'production project root');
  const disposableRoot = resolveMaintenanceRoot(request.disposableRoot, 'disposable rehearsal root');

  // STRUCTURALLY SEPARATE, all three ways.
  if (disposableRoot === productionRoot) {
    throw new MaintenanceRefused(
      'the disposable rehearsal root is the production project root. A rehearsal runs somewhere else, or it is '
      + 'not a rehearsal.');
  }
  if (isInside(disposableRoot, productionRoot) || isInside(productionRoot, disposableRoot)) {
    throw new MaintenanceRefused(
      'the disposable rehearsal root and the production project root contain one another. Compose would derive '
      + 'overlapping project state from them, and a cleanup could reach the installation this is meant to '
      + 'protect. Use a directory beside production, not inside it.');
  }
  const production = request.productionProject.trim().toLowerCase();
  if (production === '') throw new MaintenanceRefused('the production Compose project name was not given');
  if (production === projectName) {
    throw new MaintenanceRefused(
      'the disposable project name is the production project name. Compose lower-cases project names, so two that '
      + 'differ only in case are one project — and one project means one set of volumes.');
  }
  if (production.startsWith(REHEARSAL_PROJECT_PREFIX)) {
    throw new MaintenanceRefused(
      `the production project name begins with "${REHEARSAL_PROJECT_PREFIX}", which is the marker this command `
      + 'removes resources by. Rename the production project before rehearsing against it.');
  }

  assertImmutableImageRef(request.currentImage, 'current');
  assertImmutableImageRef(request.candidateImage, 'candidate');
  if (request.currentImage === request.candidateImage) {
    throw new MaintenanceRefused('the current and candidate images are the same reference, so there is nothing to rehearse');
  }

  const backupSet = resolveMaintenanceRoot(request.backupSet, 'backup set directory');
  if (isInside(backupSet, disposableRoot)) {
    throw new MaintenanceRefused(
      'the backup set is inside the disposable rehearsal root, which the cleanup removes. Keep the set somewhere '
      + 'the rehearsal does not own.');
  }

  const resolved = {
    disposableRoot,
    projectName,
    backupSet,
    currentImage: request.currentImage,
    candidateImage: request.candidateImage,
  };
  return { ...resolved, planDigest: rehearsalPlanDigest(resolved) };
}

function isInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

/**
 * The digest an operator confirms.
 *
 * Over the things that decide what would happen: where it runs, under which project name, from which backup,
 * between which two exact images. It deliberately does NOT cover a timestamp, so the same rehearsal confirmed
 * twice has the same digest — a digest that changed every second would be one nobody could type.
 */
export function rehearsalPlanDigest(plan: Omit<ResolvedRehearsal, 'planDigest'>): string {
  const canonical = JSON.stringify({
    report: REHEARSAL_REPORT,
    version: REHEARSAL_VERSION,
    projectName: plan.projectName,
    disposableRoot: createHash('sha256').update(plan.disposableRoot, 'utf8').digest('hex'),
    backupSet: createHash('sha256').update(plan.backupSet, 'utf8').digest('hex'),
    currentImage: plan.currentImage,
    candidateImage: plan.candidateImage,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Constant-time-ish comparison of an operator's echo against the plan's own digest. */
export function digestConfirmed(echo: string | null, expected: string): boolean {
  if (echo === null || echo.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= echo.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

// -----------------------------------------------------------------------------------------------------------
// The plan
// -----------------------------------------------------------------------------------------------------------

/**
 * Every command a rehearsal would run, in order, as values.
 *
 * `--plan` prints this and stops, and the acceptance harness asserts the argument arrays. Every one of them
 * carries `-p <marker project>` and runs in the disposable root; a test checks both for every entry rather
 * than trusting the construction below.
 */
export function planRehearsal(resolved: ResolvedRehearsal): readonly MaintenanceCommand[] {
  const cwd = resolved.disposableRoot;
  const p = (...args: readonly string[]): MaintenanceCommand => ({
    program: 'docker', args: ['compose', '-p', resolved.projectName, ...args], cwd, purpose: 'rehearsal step',
  });
  return [
    { ...p('down', '-v', '--remove-orphans'), purpose: 'remove any previous disposable state' },
    { ...p('up', '-d', '--pull', 'never', 'postgres'), purpose: 'start only the database, from an image already here' },
    { ...p('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'catalog', '-f', `/restore/${COMPONENT_ARTIFACT_NAMES.database}`), purpose: 'restore the backup dump into fresh disposable state' },
    { ...p('up', '-d', '--pull', 'never'), purpose: 'boot the CURRENT image' },
    { ...p('exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:version'), purpose: 'read the running version on the current image' },
    { ...p('exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:doctor', '--', '--json'), purpose: 'the doctor must report no FAIL on the current image' },
    { ...p('up', '-d', '--pull', 'never'), purpose: 'switch to the CANDIDATE image and let its migration run' },
    { ...p('exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:version'), purpose: 'read the running version on the candidate image' },
    { ...p('exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:doctor', '--', '--json'), purpose: 'the doctor must report no FAIL on the candidate image' },
    { ...p('exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:catalog-import', '--', '--file', 'rehearsal-replay.json'), purpose: 'replay a representative import and prove it is idempotent' },
    { ...p('down', '-v', '--remove-orphans'), purpose: 'ROLLBACK: destroy the upgraded disposable state entirely' },
    { ...p('up', '-d', '--pull', 'never', 'postgres'), purpose: 'ROLLBACK: fresh disposable database' },
    { ...p('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'catalog', '-f', `/restore/${COMPONENT_ARTIFACT_NAMES.database}`), purpose: 'ROLLBACK: restore the SAME pre-upgrade set' },
    { ...p('up', '-d', '--pull', 'never'), purpose: 'ROLLBACK: boot the PREVIOUS image again' },
    { ...p('exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:version'), purpose: 'ROLLBACK: the previous version is running again' },
    { ...p('exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:doctor', '--', '--json'), purpose: 'ROLLBACK: the doctor reports no FAIL on the restored installation' },
  ];
}

// -----------------------------------------------------------------------------------------------------------
// Running it
// -----------------------------------------------------------------------------------------------------------

export interface RehearsalRequestWithConfirmation extends RehearsalRequest {
  /** The digest the operator typed. Nothing runs without it. */
  readonly confirmDigest: string | null;
  /** Remove the disposable project afterwards. Off by default: evidence outlives a failed run. */
  readonly cleanup?: boolean;
}

export interface RehearsalDeps {
  readonly runner: CommandRunner;
  readonly ledger: CommandLedger;
  readonly now?: () => Date;
}

export interface RehearsalReport {
  readonly report: typeof REHEARSAL_REPORT;
  readonly version: typeof REHEARSAL_VERSION;
  readonly ok: boolean;
  readonly projectName: string;
  readonly planDigest: string;
  readonly currentImage: string;
  readonly candidateImage: string;
  readonly backupVerification: Pick<BackupVerificationReport, 'ok' | 'setName' | 'inspectorVerdict' | 'manifestSchemaVersion'>;
  readonly steps: readonly RehearsalStep[];
  /** What was removed at the end, and by what. Empty when evidence was deliberately kept. */
  readonly cleanup: { readonly performed: boolean; readonly by: string; readonly plan: readonly string[] };
  readonly touchedProduction: false;
  readonly network: 'none';
  readonly mediaOperations: 'none';
  readonly notes: readonly string[];
}

/**
 * Rehearse the upgrade and then the rollback, in a disposable project, from a verified backup.
 *
 * A FAILED ASSERTION STOPS THE LEG AND KEEPS THE EVIDENCE. It never broadens what is removed, and it never
 * cleans up silently: a rehearsal that tore down the thing you need to look at has cost you the run.
 */
export function runRehearsal(request: RehearsalRequestWithConfirmation, deps: RehearsalDeps): RehearsalReport {
  const resolved = resolveRehearsal(request);
  if (!digestConfirmed(request.confirmDigest, resolved.planDigest)) {
    throw new MaintenanceRefused(
      'the digest you confirmed is not the digest of the rehearsal this command just computed. Nothing was '
      + 'started. Run with --plan, read what it would do, and copy the digest from the plan you actually read.');
  }

  // A REHEARSAL NEEDS A BACKUP THAT HAS ALREADY VERIFIED. Not one that exists: one that verifies now, here,
  // before a container is created.
  const verification = verifyBackupSet(resolved.backupSet);
  if (!verification.ok) {
    throw new MaintenanceRefused(
      'the backup set this rehearsal would restore does not verify, so the rehearsal would prove nothing about a '
      + 'restore. Fix or retake the set first. Nothing was started.');
  }
  const manifest = readBackupManifest(resolved.backupSet);

  const steps: RehearsalStep[] = [];
  const notes: string[] = [];
  let failed = false;

  const step = (id: string, leg: RehearsalStep['leg'], proves: string, run: () => string | null): void => {
    if (failed) return;
    let detail: string | null;
    try {
      detail = run();
    } catch (err) {
      detail = err instanceof Error ? err.message : 'the step could not be run';
    }
    if (detail === null) {
      steps.push({ id, leg, proves, ok: true, detail: 'held' });
      return;
    }
    steps.push({ id, leg, proves, ok: false, detail });
    failed = true;
  };

  const compose = (args: readonly string[], purpose: string): MaintenanceCommand => ({
    program: 'docker',
    args: ['compose', '-p', resolved.projectName, ...args],
    cwd: resolved.disposableRoot,
    purpose,
  });
  const expectZero = (command: MaintenanceCommand, whenNot: string): string | null => {
    const outcome = runGuarded(deps.runner, deps.ledger, command);
    return outcome.status === 0 ? null : whenNot;
  };
  const doctorHasNoFail = (command: MaintenanceCommand): string | null => {
    const outcome = runGuarded(deps.runner, deps.ledger, command);
    if (outcome.status !== 0 && outcome.stdout.trim() === '') return 'the doctor could not be run at all';
    const parsed = parseDoctorJson(outcome.stdout);
    if (parsed === null) return 'the doctor did not answer in the shape this build understands';
    const state = classifyDoctor(parsed);
    return state === 'FAIL' || state === 'INVALID' ? `the doctor reported ${state}` : null;
  };

  step('fresh-state', 'setup', 'the disposable project starts from nothing', () =>
    expectZero(compose(['down', '-v', '--remove-orphans'], 'remove any previous disposable state'),
      'the previous disposable state could not be removed'));

  step('restore-current', 'setup', 'the verified backup restores into fresh disposable state', () => {
    const up = expectZero(compose(['up', '-d', '--pull', 'never', 'postgres'], 'start only the database'),
      'the disposable database did not start from an image already on this host');
    if (up !== null) return up;
    return expectZero(
      compose(['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'catalog', '-f',
        `/restore/${COMPONENT_ARTIFACT_NAMES.database}`], 'restore the backup dump'),
      'the backup dump did not replay into the disposable database');
  });

  step('boot-current', 'upgrade', 'the installation boots on the image it runs today', () =>
    expectZero(compose(['up', '-d', '--pull', 'never'], 'boot the CURRENT image'),
      'the current image did not start from what is already on this host'));

  step('current-doctor', 'upgrade', 'the restored installation is healthy before anything is upgraded', () =>
    doctorHasNoFail(compose(['exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:doctor', '--', '--json'],
      'the doctor must report no FAIL on the current image')));

  step('switch-candidate', 'upgrade', 'the candidate image starts and its migration runs', () =>
    expectZero(compose(['up', '-d', '--pull', 'never'], 'switch to the CANDIDATE image'),
      'the candidate image did not start, or its migration did not complete'));

  step('candidate-doctor', 'upgrade', 'the upgraded installation is healthy', () =>
    doctorHasNoFail(compose(['exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:doctor', '--', '--json'],
      'the doctor must report no FAIL on the candidate image')));

  step('candidate-read', 'upgrade', 'the upgraded installation can still read and decrypt its own catalog', () =>
    expectZero(compose(['exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:collections', '--', 'status'],
      'read the catalog through a shipped, safe primitive'),
    'the upgraded installation could not read its own durable state'));

  step('candidate-history', 'upgrade', 'the import history survived the migration', () =>
    expectZero(compose(['exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:collections', '--', 'history'],
      'read the durable history'),
    'the durable history could not be read after the migration'));

  // ---- Phase 280: the rollback, which is a RESTORE and not an image change --------------------------
  step('rollback-teardown', 'rollback', 'the upgraded disposable state is destroyed entirely', () =>
    expectZero(compose(['down', '-v', '--remove-orphans'], 'destroy the upgraded disposable state'),
      'the upgraded disposable state could not be destroyed, so a rollback from it would not be a rollback'));

  step('rollback-restore', 'rollback', 'the SAME pre-upgrade set restores into fresh state', () => {
    const up = expectZero(compose(['up', '-d', '--pull', 'never', 'postgres'], 'fresh disposable database'),
      'the disposable database did not start again');
    if (up !== null) return up;
    return expectZero(
      compose(['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'catalog', '-f',
        `/restore/${COMPONENT_ARTIFACT_NAMES.database}`], 'restore the SAME pre-upgrade set'),
      'the pre-upgrade set did not replay, which means this upgrade is not reversible');
  });

  step('rollback-boot', 'rollback', 'the PREVIOUS image boots against the restored schema', () =>
    expectZero(compose(['up', '-d', '--pull', 'never'], 'boot the PREVIOUS image again'),
      'the previous image did not come back up against the restored schema'));

  step('rollback-doctor', 'rollback', 'the rolled-back installation is healthy', () =>
    doctorHasNoFail(compose(['exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:doctor', '--', '--json'],
      'the doctor reports no FAIL on the restored installation')));

  step('rollback-read', 'rollback', 'the rolled-back installation can read and decrypt its own catalog', () =>
    expectZero(compose(['exec', '-T', 'app', 'npm', 'run', '--silent', 'ops:collections', '--', 'status'],
      'read the catalog after the rollback'),
    'the rolled-back installation could not read its own durable state'));

  // ---- cleanup: only what carries the marker, and only when nothing failed --------------------------
  const cleanupPlan = [
    `docker compose -p ${resolved.projectName} down -v --remove-orphans`,
  ];
  let cleanupPerformed = false;
  if (failed) {
    notes.push('A step did not hold, so the disposable project was LEFT IN PLACE for diagnosis. Nothing was '
      + 'removed. When you have finished looking, remove it with the one command in the cleanup plan — which '
      + 'names only this rehearsal\'s own project.');
  } else if (request.cleanup === true) {
    const outcome = runGuarded(deps.runner, deps.ledger,
      compose(['down', '-v', '--remove-orphans'], 'remove ONLY this rehearsal\'s own project'));
    cleanupPerformed = outcome.status === 0;
    if (!cleanupPerformed) {
      notes.push('The disposable project could not be removed. It carries this rehearsal\'s marker and nothing '
        + 'else does; remove it with the command in the cleanup plan.');
    }
  } else {
    notes.push('The disposable project was left in place. Pass --cleanup to remove it, or run the one command in '
      + 'the cleanup plan yourself.');
  }

  if (manifest.schemaVersion === MIGRATION_VERSION) {
    notes.push(`The restored set is at this build's own schema version (${MIGRATION_VERSION}). A rehearsal is most `
      + 'meaningful when the set predates the candidate\'s migration.');
  }
  notes.push('Nothing was fetched: every image came from this host and no pull, login or push is available to this '
    + 'command at all.');
  notes.push('Production was never addressed. Every command ran in the disposable root under this rehearsal\'s own '
    + 'project name.');

  return {
    report: REHEARSAL_REPORT,
    version: REHEARSAL_VERSION,
    ok: !failed,
    projectName: resolved.projectName,
    planDigest: resolved.planDigest,
    currentImage: resolved.currentImage,
    candidateImage: resolved.candidateImage,
    backupVerification: {
      ok: verification.ok,
      setName: verification.setName,
      inspectorVerdict: verification.inspectorVerdict,
      manifestSchemaVersion: verification.manifestSchemaVersion,
    },
    steps,
    cleanup: { performed: cleanupPerformed, by: `compose project ${resolved.projectName}`, plan: cleanupPlan },
    touchedProduction: false,
    network: 'none',
    mediaOperations: 'none',
    notes,
  };
}

/**
 * The evidence report an operator keeps.
 *
 * Step ids, what each proves, whether it held, the two image references and the plan digest. No host path, no
 * address, no registry, no secret and nothing from inside the backup.
 */
export function renderRehearsal(report: RehearsalReport): string {
  const lines: string[] = [];
  lines.push(`Upgrade rehearsal — ${report.ok ? 'BOTH LEGS HELD' : 'A STEP DID NOT HOLD'}`);
  lines.push(`  project           ${report.projectName}`);
  lines.push(`  plan digest       ${report.planDigest}`);
  lines.push(`  current image     ${report.currentImage}`);
  lines.push(`  candidate image   ${report.candidateImage}`);
  lines.push(`  backup set        ${report.backupVerification.setName} (${report.backupVerification.inspectorVerdict}, `
    + `schema ${report.backupVerification.manifestSchemaVersion})`);
  lines.push(`  touched production ${report.touchedProduction}`);
  lines.push(`  network           ${report.network}`);
  lines.push(`  media operations  ${report.mediaOperations}`);
  lines.push('  steps:');
  for (const entry of report.steps) {
    lines.push(`    ${entry.ok ? 'HELD' : 'FAIL'}  ${entry.leg.padEnd(8)} ${entry.id.padEnd(20)} ${entry.proves}`);
    if (!entry.ok) lines.push(`          -> ${entry.detail}`);
  }
  lines.push(`  cleanup           ${report.cleanup.performed ? 'removed' : 'not performed'} (${report.cleanup.by})`);
  for (const command of report.cleanup.plan) lines.push(`    plan: ${command}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push(`  RESULT: ${report.ok ? 'OK' : 'INCOMPLETE'}`);
  return lines.join('\n');
}

/**
 * A disposable root must look disposable.
 *
 * Exported for the CLI's own preflight: a directory that already holds an operator's secrets or promotion
 * records is not a scratch directory, whatever it is called, and a rehearsal that removed its volumes would
 * be removing something somebody wanted.
 */
export function assertDisposableRootIsEmptyish(root: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    if (entry === 'secrets' || entry === 'promotion-records' || entry === 'import') {
      throw new MaintenanceRefused(
        `the disposable rehearsal root holds a "${entry}" directory, which is what a real installation looks `
        + 'like. Rehearse in a directory that holds only the Compose file and what this command puts there.');
    }
  }
}

/** Where the restore mount lands inside the disposable database container. Fixed, so the plan can name it. */
export const REHEARSAL_RESTORE_MOUNT = '/restore';

/** The artifact the restore step reads, inside that mount. Named from the component model, never retyped. */
export function restoreDumpPath(): string {
  return join(REHEARSAL_RESTORE_MOUNT, COMPONENT_ARTIFACT_NAMES.database).replace(/\\/g, '/');
}
