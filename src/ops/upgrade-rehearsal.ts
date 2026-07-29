import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { MIGRATION_VERSION } from '../db/schema-version.js';
import { BACKUP_COMPONENT_IDS, type BackupComponentId } from './backup-components.js';
import { verifyBackupSet, type BackupVerificationReport } from './backup-set-verification.js';
import { COMPONENT_ARTIFACT_NAMES, copyTree, readBackupManifest } from './complete-backup.js';
import { classifyDoctor, parseDoctorJson } from './doctor-monitor.js';
import {
  CommandLedger,
  MaintenanceRefused,
  assertDirectoryNoFollow,
  assertUsableName,
  copyFileNoFollow,
  createPrivateDirectory,
  digestFileNoFollow,
  readFileNoFollow,
  resolveInsideRoot,
  resolveMaintenanceRoot,
  runGuarded,
  writePrivateFile,
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
// WHAT THE FIRST VERSION OF THIS FILE GOT WRONG, AND WHY IT MATTERS MORE THAN THE FEATURE.
// -----------------------------------------------------------------------------------------------------
//
// It accepted a current image and a candidate image, printed both, digested both — and never applied either.
// Both `up` commands were byte-identical, so the "upgrade" booted the same image twice, and the rehearsal
// reported that an upgrade it had never performed was safe. It restored `database.sql` and nothing else, so
// the keystore the database's rows are encrypted against was never in the picture: every decrypt in the
// rehearsal ran against whatever the disposable stack happened to hold. And it inferred versions from tags.
//
// A REHEARSAL THAT PROVES SOMETHING WEAKER THAN IT CLAIMS IS WORSE THAN NO REHEARSAL, because an operator
// spends their upgrade-window confidence on it. So the corrections below are all of one kind: every claim in
// the report is now made by an action that could fail.
//
//   * THE IMAGE IS SELECTED, not merely named. Two Compose OVERRIDE FILES are written into the disposable
//     root, one per role, each pinning `services.app.image` to an exact immutable reference; the boot steps
//     pass `-f <definition> -f <that override>`. Which image a step runs is therefore visible in its argv and
//     provable from the file on disk.
//   * ALL FOUR COMPONENTS ARE RESTORED. A private restore workspace is prepared from the verified set —
//     database, keystore, secrets and promotion records — and the overrides mount every one of them. A
//     rehearsal that decrypted nothing real proved nothing about a restore.
//   * VERSIONS ARE READ, NOT INFERRED. The plan carries the exact product version and schema version expected
//     on each image; the run reads them out of the running container and compares exactly. A tag is a label
//     somebody typed, and this never treats one as evidence of what is inside an image.
//   * ONE ORDERED PLAN. `planRehearsal` builds the steps and `runRehearsal` executes THAT list. There is no
//     second copy of the order to drift from the first.
//
// -----------------------------------------------------------------------------------------------------
// IT HAPPENS SOMEWHERE ELSE, AND "SOMEWHERE ELSE" IS PROVED, NOT ASSERTED.
// -----------------------------------------------------------------------------------------------------
//
// Everything runs in a DISPOSABLE Compose project, in a disposable root, under a project name carrying this
// product's rehearsal marker. Five independent things make that real:
//
//   1. THE PROJECT NAME MUST CARRY THE MARKER. Every command passes `-p catalog-rehearsal-<label>`, so every
//      container, network and volume Compose creates is labelled with it. That label is what the cleanup
//      removes by, so cleanup cannot reach anything this rehearsal did not create.
//   2. THE ROOT MUST BE MARKED, AND MARKED FOR THIS EXACT REHEARSAL. A marker file is created `O_EXCL` naming
//      the project and the plan digest. An unmarked root is never cleaned and never written into; a root
//      marked for a different rehearsal is refused rather than adopted.
//   3. THE DISPOSABLE ROOT MUST BE STRUCTURALLY DIFFERENT FROM THE PRODUCTION ROOT. Not merely a different
//      string: resolved, and then required to be neither the production root, nor inside it, nor containing
//      it. A rehearsal that ran in a subdirectory of production would share its volumes' project name and
//      could stop the operator's real stack.
//   4. THE PROJECT NAME MUST NOT BE PRODUCTION'S. Checked against the production project name explicitly,
//      including case, because Compose lower-cases project names and two names that differ only in case are
//      one project.
//   5. NOTHING EVER NAMES THE PRODUCTION ROOT AS A `cwd`. Every command in the plan runs in the disposable
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
// AND THE EVIDENCE IS REDACTED, INCLUDING THE PARTS THAT LOOK HARMLESS.
// -----------------------------------------------------------------------------------------------------
//
// An image reference names a registry and often a host or an owner. The durable report carries a DIGEST of
// each reference and a closed-set label for each version comparison — never the reference itself, never a
// version string read out of a container, never a doctor `detail`, and never a message from a runner. The
// PLAN, which an operator reads on their own terminal about refs they themselves typed, prints them in full;
// that asymmetry is deliberate and is the only place it exists.
//
// NOTHING HERE TOUCHES MEDIA, A MEDIA SERVER OR AN ACQUISITION SYSTEM. The representative checks are the
// product's own safe primitives — an import preview, an import apply, a replay, the import history, a
// catalog read that decrypts — and `maintenance-safety.ts` refuses any argument that would reach further.

export const REHEARSAL_REPORT = 'phase-279-280-upgrade-rehearsal';
export const REHEARSAL_VERSION = 1;

/** Every disposable project this product creates begins with it. The cleanup removes by exactly this. */
export const REHEARSAL_PROJECT_PREFIX = 'catalog-rehearsal-';

/** The file that says "this root belongs to that rehearsal". Created `O_EXCL`; never adopted. */
export const REHEARSAL_MARKER_NAME = '.catalog-rehearsal-marker.json';

/** Where the four restored components are prepared, inside the disposable root. Private. */
export const REHEARSAL_RESTORE_DIRNAME = 'catalog-rehearsal-restore';

/** The Compose override this product writes, per image role. Named so the argv says which image is running. */
export const REHEARSAL_OVERRIDE_NAMES: Readonly<Record<RehearsalImageRole, string>> = Object.freeze({
  current: 'catalog-rehearsal.current.override.yml',
  candidate: 'catalog-rehearsal.candidate.override.yml',
});

/** Where the restore workspace lands inside the containers. Fixed, so the plan can name it. */
export const REHEARSAL_RESTORE_MOUNT = '/restore';
export const REHEARSAL_KEYSTORE_MOUNT = '/var/lib/catalog/keystore';
export const REHEARSAL_SECRETS_MOUNT = '/run/catalog-rehearsal-secrets';
export const REHEARSAL_PROMOTION_MOUNT = '/var/lib/catalog/promotion-records';
export const REHEARSAL_IMPORT_MOUNT = '/var/lib/catalog/import';

/** The representative import snapshot, inside the restore workspace and inside the container. */
export const REHEARSAL_IMPORT_NAME = 'catalog-rehearsal-import.json';

/** Tags that are not a version. A ref carrying one of these can mean different bytes tomorrow. */
export const FLOATING_TAGS: readonly string[] = Object.freeze([
  'latest', 'edge', 'main', 'master', 'stable', 'nightly', 'dev', 'develop', 'testing', 'rolling', 'head',
]);

export type RehearsalImageRole = 'current' | 'candidate';
export type RehearsalLeg = 'setup' | 'upgrade' | 'rollback' | 'cleanup';

/**
 * The exact facts an operator declares about each image, which the rehearsal then CHECKS.
 *
 * NEVER INFERRED FROM A TAG. A tag is a label somebody typed; the version inside an image is a fact about its
 * contents. A rehearsal that read `:1.2.0` off a reference and reported "1.2.0 is running" would report the
 * label back to the person who wrote it, and would pass against an image that had been rebuilt and re-tagged.
 */
export interface RehearsalExpectations {
  /** The product version inside the current image, exactly as its own package declares it. */
  readonly currentVersion: string;
  /** The product version inside the candidate image. */
  readonly candidateVersion: string;
  /** The schema version the CURRENT build expects — which is also the restored set's version. */
  readonly currentSchema: number;
  /** The schema version the CANDIDATE build expects, after its migration has run. */
  readonly candidateSchema: number;
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
  /**
   * The Compose definition to rehearse against, relative to the disposable root.
   *
   * EXPLICIT AND OPERATOR-SUPPLIED. There is no default and no probe: the file that defines the disposable
   * stack is the operator's, this product only adds an override beside it, and a rehearsal that guessed which
   * definition it was overriding would be overriding something nobody chose.
   */
  readonly composeFile: string;
  /** The verified backup set to restore, absolute. Read, never written. */
  readonly backupSet: string;
  /**
   * A representative catalog import snapshot, absolute. Copied into the workspace and previewed, applied and
   * replayed. Required: a rehearsal in which no import ran proves nothing about the one that matters.
   */
  readonly importSnapshot: string;
  /** The image the installation runs now. Immutable ref. */
  readonly currentImage: string;
  /** The image being rehearsed. Immutable ref. */
  readonly candidateImage: string;
  readonly expect: RehearsalExpectations;
}

export interface ResolvedRehearsal {
  readonly disposableRoot: string;
  readonly projectName: string;
  readonly composeFile: string;
  readonly backupSet: string;
  readonly importSnapshot: string;
  readonly currentImage: string;
  readonly candidateImage: string;
  readonly expect: RehearsalExpectations;
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

/** A declared product version: the shape a package version has, and nothing else. */
export function assertDeclaredVersion(version: string, what: string): void {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,32})?$/.test(version)) {
    throw new MaintenanceRefused(
      `the expected ${what} product version is not a version. Give the exact version that image's own package `
      + 'declares — this command reads it out of the running container and compares it, and will not guess it.');
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

  assertDeclaredVersion(request.expect.currentVersion, 'current');
  assertDeclaredVersion(request.expect.candidateVersion, 'candidate');
  assertSchemaVersion(request.expect.currentSchema, 'current');
  assertSchemaVersion(request.expect.candidateSchema, 'candidate');
  if (request.expect.candidateSchema < request.expect.currentSchema) {
    throw new MaintenanceRefused(
      'the candidate image is declared to expect an OLDER schema than the current one. This product has no '
      + 'down-migrations, so that is not an upgrade and rehearsing it would prove nothing.');
  }

  // The definition this overrides is named, relative and inside the disposable root. Its existence is checked
  // here rather than at the first `up`, so a typo is a refusal before anything is created.
  const composeFile = resolveInsideRoot(disposableRoot, request.composeFile, 'compose definition');
  if (!existsSync(composeFile)) {
    throw new MaintenanceRefused(
      'the Compose definition named for the disposable stack is not there. This command overrides a definition '
      + 'you supply; it does not write one, because a stack nobody declared is a stack nobody reviewed.');
  }
  const composeName = relative(disposableRoot, composeFile);
  if (composeName === REHEARSAL_OVERRIDE_NAMES.current || composeName === REHEARSAL_OVERRIDE_NAMES.candidate) {
    throw new MaintenanceRefused('the Compose definition names one of the override files this command writes');
  }

  const backupSet = resolveMaintenanceRoot(request.backupSet, 'backup set directory');
  if (isInside(backupSet, disposableRoot) || backupSet === disposableRoot) {
    throw new MaintenanceRefused(
      'the backup set is inside the disposable rehearsal root, which the cleanup removes. Keep the set somewhere '
      + 'the rehearsal does not own.');
  }
  const importSnapshot = request.importSnapshot;
  if (!isAbsolute(importSnapshot)) {
    throw new MaintenanceRefused('the representative import snapshot must be an absolute path');
  }
  if (isInside(importSnapshot, disposableRoot)) {
    throw new MaintenanceRefused(
      'the representative import snapshot is inside the disposable rehearsal root, which the cleanup removes');
  }

  const resolved = {
    disposableRoot,
    projectName,
    composeFile: composeName,
    backupSet,
    importSnapshot,
    currentImage: request.currentImage,
    candidateImage: request.candidateImage,
    expect: { ...request.expect },
  };
  return { ...resolved, planDigest: rehearsalPlanDigest(resolved) };
}

function assertSchemaVersion(version: number, what: string): void {
  if (!Number.isInteger(version) || version <= 0) {
    throw new MaintenanceRefused(`the expected ${what} schema version is not a schema version`);
  }
}

function isInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

/**
 * The digest an operator confirms.
 *
 * Over EVERYTHING that decides what would happen and what would be asserted: where it runs, under which
 * project name, against which definition, from which backup and import, between which two exact images, and
 * with which four declared versions. It deliberately does NOT cover a timestamp, so the same rehearsal
 * confirmed twice has the same digest — a digest that changed every second would be one nobody could type.
 *
 * THE EXPECTATIONS ARE IN IT ON PURPOSE. Changing what the rehearsal will accept as a pass changes the plan,
 * so it must change the digest the operator confirms.
 */
export function rehearsalPlanDigest(plan: Omit<ResolvedRehearsal, 'planDigest'>): string {
  const canonical = JSON.stringify({
    report: REHEARSAL_REPORT,
    version: REHEARSAL_VERSION,
    projectName: plan.projectName,
    disposableRoot: createHash('sha256').update(plan.disposableRoot, 'utf8').digest('hex'),
    composeFile: plan.composeFile,
    backupSet: createHash('sha256').update(plan.backupSet, 'utf8').digest('hex'),
    importSnapshot: createHash('sha256').update(plan.importSnapshot, 'utf8').digest('hex'),
    currentImage: plan.currentImage,
    candidateImage: plan.candidateImage,
    expect: [plan.expect.currentVersion, plan.expect.candidateVersion,
      plan.expect.currentSchema, plan.expect.candidateSchema],
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
// The one ordered plan
// -----------------------------------------------------------------------------------------------------------

/**
 * What a step asserts about the command it ran. A CLOSED SET.
 *
 * Every one of these can fail, and the failure of each has a fixed sentence. There is deliberately no
 * "whatever the runner said" case: a report that repeated a runner's message would carry whatever that
 * message happened to contain, which on this boundary means a host path or a connection string.
 */
export type RehearsalAssertion =
  | { readonly kind: 'exit-zero' }
  | { readonly kind: 'doctor-no-fail' }
  | { readonly kind: 'product-version'; readonly role: RehearsalImageRole; readonly expected: string }
  | { readonly kind: 'schema-version'; readonly expectedBuild: number; readonly expectedDatabase: number };

export type RehearsalAction =
  /** Prepare the private restore workspace and the import snapshot from the verified set. */
  | { readonly kind: 'prepare-workspace' }
  /** Write the Compose override that pins one role's image and mounts all four components. */
  | { readonly kind: 'write-override'; readonly role: RehearsalImageRole }
  | { readonly kind: 'command'; readonly command: MaintenanceCommand; readonly assertion: RehearsalAssertion };

export interface RehearsalPlanStep {
  readonly id: string;
  readonly leg: RehearsalLeg;
  /** What it establishes, in one sentence. Never a path, never an address. */
  readonly proves: string;
  /** The closed-set sentence used when it does not hold. Never interpolated with anything read at runtime. */
  readonly whenNot: string;
  readonly actions: readonly RehearsalAction[];
}

/**
 * Every step a rehearsal performs, in order, as values.
 *
 * THIS IS THE ONLY ORDER THAT EXISTS. `--plan` renders it and `runRehearsal` executes it. The previous
 * version built the printed plan in one function and the executed sequence in another, which is how the two
 * came to disagree about something as large as which image boots.
 */
export function planRehearsal(resolved: ResolvedRehearsal): readonly RehearsalPlanStep[] {
  const cwd = resolved.disposableRoot;
  /** A compose command against the operator's definition, optionally with one of our overrides on top. */
  const compose = (role: RehearsalImageRole | null, args: readonly string[], purpose: string): MaintenanceCommand => ({
    program: 'docker',
    args: [
      'compose', '-p', resolved.projectName, '-f', resolved.composeFile,
      ...(role === null ? [] : ['-f', REHEARSAL_OVERRIDE_NAMES[role]]),
      ...args,
    ],
    cwd,
    purpose,
  });
  const app = (role: RehearsalImageRole, script: readonly string[], purpose: string): MaintenanceCommand =>
    compose(role, ['exec', '-T', 'app', 'npm', ...script], purpose);
  const exitZero: RehearsalAssertion = { kind: 'exit-zero' };
  const restore = (role: RehearsalImageRole, purpose: string): MaintenanceCommand => compose(role,
    ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'catalog', '-v', 'ON_ERROR_STOP=1',
      '-f', `${REHEARSAL_RESTORE_MOUNT}/${COMPONENT_ARTIFACT_NAMES.database}`], purpose);
  const importFile = `${REHEARSAL_IMPORT_MOUNT}/${REHEARSAL_IMPORT_NAME}`;

  /** The three checks that prove an installation is really an installation, run on every leg. */
  const installationChecks = (role: RehearsalImageRole, prefix: string, leg: RehearsalLeg): RehearsalPlanStep[] => [
    {
      id: `${prefix}-version`,
      leg,
      proves: 'the product version inside the running image is the one the plan declared',
      whenNot: 'the running product version was not the version this rehearsal was told to expect',
      actions: [{
        kind: 'command',
        command: compose(role, ['exec', '-T', 'app', 'npm', 'pkg', 'get', 'version'],
          'read the product version out of the running image'),
        assertion: { kind: 'product-version', role, expected: expectedVersion(resolved, role) },
      }],
    },
    {
      id: `${prefix}-schema`,
      leg,
      proves: 'the running build and the restored database agree on an exact schema version',
      whenNot: 'the running build or the database was not at the schema version this rehearsal was told to expect',
      actions: [{
        kind: 'command',
        command: app(role, ['run', '--silent', 'ops:version'], 'read the build and database schema versions'),
        assertion: {
          kind: 'schema-version',
          expectedBuild: expectedSchema(resolved, role),
          expectedDatabase: expectedSchema(resolved, role),
        },
      }],
    },
    {
      id: `${prefix}-doctor`,
      leg,
      proves: 'the shipped doctor reports no failure on this installation',
      whenNot: 'the doctor did not report a healthy installation',
      actions: [{
        kind: 'command',
        command: app(role, ['run', '--silent', 'ops:doctor', '--', '--json'], 'run the shipped read-only doctor'),
        assertion: { kind: 'doctor-no-fail' },
      }],
    },
    {
      id: `${prefix}-read`,
      leg,
      proves: 'the installation reads and DECRYPTS its own catalog with the restored keystore and secrets',
      whenNot: 'the installation could not read and decrypt its own durable state',
      actions: [{
        kind: 'command',
        command: app(role, ['run', '--silent', 'ops:collections', '--', 'status'],
          'read the catalog through a shipped, safe primitive that must decrypt to answer'),
        assertion: exitZero,
      }],
    },
    {
      id: `${prefix}-history`,
      leg,
      proves: 'the durable import and collection history is readable',
      whenNot: 'the durable history could not be read',
      actions: [{
        kind: 'command',
        command: app(role, ['run', '--silent', 'ops:collections', '--', 'history'], 'read the durable history'),
        assertion: exitZero,
      }],
    },
  ];

  return [
    {
      id: 'own-the-root',
      leg: 'setup',
      proves: 'the disposable root belongs to THIS rehearsal, and holds nothing of anybody\'s',
      whenNot: 'the disposable root could not be claimed for this rehearsal',
      actions: [{ kind: 'prepare-workspace' },
        { kind: 'write-override', role: 'current' }, { kind: 'write-override', role: 'candidate' }],
    },
    {
      id: 'fresh-state',
      leg: 'setup',
      proves: 'the disposable project starts from nothing',
      whenNot: 'the previous disposable state could not be removed',
      actions: [{
        kind: 'command',
        command: compose('current', ['down', '-v', '--remove-orphans'], 'remove any previous disposable state'),
        assertion: exitZero,
      }],
    },
    {
      id: 'database-up',
      leg: 'setup',
      proves: 'the disposable database starts from an image already on this host',
      whenNot: 'the disposable database did not start from an image already on this host',
      actions: [{
        kind: 'command',
        command: compose('current', ['up', '-d', '--pull', 'never', 'postgres'], 'start only the database'),
        assertion: exitZero,
      }],
    },
    {
      id: 'restore-set',
      leg: 'setup',
      proves: 'the verified set — all four components — restores into fresh disposable state',
      whenNot: 'the backup dump did not replay into the disposable database',
      actions: [{ kind: 'command', command: restore('current', 'restore the backup dump'), assertion: exitZero }],
    },
    {
      id: 'boot-current',
      leg: 'upgrade',
      proves: 'the installation boots on the image it runs TODAY, with the restored keystore and secrets',
      whenNot: 'the current image did not start from what is already on this host',
      actions: [{
        kind: 'command',
        command: compose('current', ['up', '-d', '--pull', 'never'], 'boot the CURRENT image'),
        assertion: exitZero,
      }],
    },
    ...installationChecks('current', 'current', 'upgrade'),
    {
      id: 'current-import-preview',
      leg: 'upgrade',
      proves: 'a representative import previews against the restored catalog, writing nothing',
      whenNot: 'the representative import could not be previewed',
      actions: [{
        kind: 'command',
        command: app('current', ['run', '--silent', 'ops:catalog-import', '--', '--file', importFile],
          'preview a representative import — without --apply nothing is written'),
        assertion: exitZero,
      }],
    },
    {
      id: 'current-import-apply',
      leg: 'upgrade',
      proves: 'that same import applies to the restored catalog',
      whenNot: 'the representative import could not be applied',
      actions: [{
        kind: 'command',
        command: app('current', ['run', '--silent', 'ops:catalog-import', '--', '--file', importFile, '--apply'],
          'apply the representative import'),
        assertion: exitZero,
      }],
    },
    {
      id: 'switch-candidate',
      leg: 'upgrade',
      proves: 'the CANDIDATE image starts and its migration runs against the restored data',
      whenNot: 'the candidate image did not start, or its migration did not complete',
      actions: [{
        kind: 'command',
        command: compose('candidate', ['up', '-d', '--pull', 'never'], 'switch to the CANDIDATE image'),
        assertion: exitZero,
      }],
    },
    ...installationChecks('candidate', 'candidate', 'upgrade'),
    {
      id: 'candidate-import-replay',
      leg: 'upgrade',
      proves: 'the same import replays after the migration and is idempotent',
      whenNot: 'the representative import did not replay after the migration',
      actions: [{
        kind: 'command',
        command: app('candidate', ['run', '--silent', 'ops:catalog-import', '--', '--file', importFile, '--apply'],
          'replay the same import and prove it is idempotent'),
        assertion: exitZero,
      }],
    },
    // ---- Phase 280: the rollback, which is a RESTORE and not an image change ------------------------------
    {
      id: 'rollback-teardown',
      leg: 'rollback',
      proves: 'the upgraded disposable state, VOLUMES INCLUDED, is destroyed entirely',
      whenNot: 'the upgraded disposable state could not be destroyed, so a rollback from it would not be a rollback',
      actions: [{
        kind: 'command',
        command: compose('candidate', ['down', '-v', '--remove-orphans'], 'destroy the upgraded disposable state'),
        assertion: exitZero,
      }],
    },
    {
      id: 'rollback-database',
      leg: 'rollback',
      proves: 'a fresh disposable database starts again',
      whenNot: 'the disposable database did not start again',
      actions: [{
        kind: 'command',
        command: compose('current', ['up', '-d', '--pull', 'never', 'postgres'], 'fresh disposable database'),
        assertion: exitZero,
      }],
    },
    {
      id: 'rollback-restore',
      leg: 'rollback',
      proves: 'the SAME pre-upgrade set restores again, byte for byte',
      whenNot: 'the pre-upgrade set did not replay, which means this upgrade is not reversible',
      actions: [{ kind: 'command', command: restore('current', 'restore the SAME pre-upgrade set'), assertion: exitZero }],
    },
    {
      id: 'rollback-boot',
      leg: 'rollback',
      proves: 'the PREVIOUS image boots again against the restored schema',
      whenNot: 'the previous image did not come back up against the restored schema',
      actions: [{
        kind: 'command',
        command: compose('current', ['up', '-d', '--pull', 'never'], 'boot the PREVIOUS image again'),
        assertion: exitZero,
      }],
    },
    ...installationChecks('current', 'rollback', 'rollback'),
  ];
}

function expectedVersion(resolved: ResolvedRehearsal, role: RehearsalImageRole): string {
  return role === 'current' ? resolved.expect.currentVersion : resolved.expect.candidateVersion;
}

function expectedSchema(resolved: ResolvedRehearsal, role: RehearsalImageRole): number {
  return role === 'current' ? resolved.expect.currentSchema : resolved.expect.candidateSchema;
}

/** The commands the plan would run, flattened in order. Derived from the plan; never a second list. */
export function planRehearsalCommands(resolved: ResolvedRehearsal): readonly MaintenanceCommand[] {
  return planRehearsal(resolved).flatMap((step) =>
    step.actions.flatMap((action) => (action.kind === 'command' ? [action.command] : [])));
}

/** The one command a cleanup would run. Marker-bound, and never anything else. */
export function rehearsalCleanupCommand(resolved: ResolvedRehearsal): MaintenanceCommand {
  return {
    program: 'docker',
    args: ['compose', '-p', resolved.projectName, '-f', resolved.composeFile,
      '-f', REHEARSAL_OVERRIDE_NAMES.current, 'down', '-v', '--remove-orphans'],
    cwd: resolved.disposableRoot,
    purpose: 'remove ONLY this rehearsal\'s own project, by its marker project name',
  };
}

// -----------------------------------------------------------------------------------------------------------
// Owning the root: the marker, the workspace, the overrides
// -----------------------------------------------------------------------------------------------------------

export interface RehearsalMarker {
  readonly report: typeof REHEARSAL_REPORT;
  readonly version: typeof REHEARSAL_VERSION;
  readonly projectName: string;
  readonly planDigest: string;
}

/**
 * What a rehearsal is allowed to find in a root it is about to own.
 *
 * Anything else is somebody's. A rehearsal removes volumes and, on a later run, reuses this directory; a
 * directory that already holds a person's files is not a scratch directory, whatever it is named.
 */
function ownedEntries(resolved: ResolvedRehearsal): readonly string[] {
  return [
    REHEARSAL_MARKER_NAME,
    REHEARSAL_RESTORE_DIRNAME,
    REHEARSAL_OVERRIDE_NAMES.current,
    REHEARSAL_OVERRIDE_NAMES.candidate,
    resolved.composeFile,
  ];
}

/**
 * Read the marker, if this root has one.
 *
 * A root with no marker is UNOWNED — it may be claimed if it holds nothing else, and it is never cleaned. A
 * root whose marker names a different project or a different plan is refused outright: adopting it would mean
 * removing volumes some other rehearsal is using.
 */
export function readRehearsalMarker(disposableRoot: string): RehearsalMarker | null {
  const path = join(disposableRoot, REHEARSAL_MARKER_NAME);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileNoFollow(path, 'rehearsal marker', 64 * 1024).bytes.toString('utf8'));
  } catch {
    throw new MaintenanceRefused(
      'the disposable root holds a rehearsal marker this build cannot read. It is not this command\'s to '
      + 'replace: look at it, and remove it deliberately if it is stale.');
  }
  const doc = parsed as Partial<RehearsalMarker>;
  if (doc === null || typeof doc !== 'object' || doc.report !== REHEARSAL_REPORT
    || doc.version !== REHEARSAL_VERSION || typeof doc.projectName !== 'string'
    || typeof doc.planDigest !== 'string') {
    throw new MaintenanceRefused('the disposable root holds a marker that is not one of this command\'s');
  }
  return doc as RehearsalMarker;
}

/**
 * Claim the disposable root for this exact rehearsal, or refuse.
 *
 * THE MARKER IS CREATED `O_EXCL`, so two rehearsals racing for one root cannot both believe they own it.
 * Where one is already there it must name THIS project and THIS plan digest — a marker for a different plan
 * means the volumes in that project were created for different images, and reusing them would rehearse a
 * mixture of the two.
 */
export function claimDisposableRoot(resolved: ResolvedRehearsal): 'claimed' | 'already-ours' {
  const existing = readRehearsalMarker(resolved.disposableRoot);
  if (existing !== null) {
    if (existing.projectName !== resolved.projectName || existing.planDigest !== resolved.planDigest) {
      throw new MaintenanceRefused(
        'the disposable root is marked for a DIFFERENT rehearsal — another project name or another plan. Its '
        + 'volumes were created for other images, so this command will neither reuse nor remove them. Use '
        + 'another directory, or finish and clean up that rehearsal first.');
    }
    return 'already-ours';
  }
  const owned = new Set(ownedEntries(resolved));
  for (const entry of readdirSync(resolved.disposableRoot)) {
    if (!owned.has(entry)) {
      throw new MaintenanceRefused(
        'the disposable rehearsal root holds files this command did not put there and does not recognise. A '
        + 'rehearsal destroys volumes and rewrites its own workspace; it will not do that in a directory that '
        + 'is somebody\'s. Use an empty directory holding only your Compose definition.');
    }
  }
  const marker: RehearsalMarker = {
    report: REHEARSAL_REPORT,
    version: REHEARSAL_VERSION,
    projectName: resolved.projectName,
    planDigest: resolved.planDigest,
  };
  writePrivateFile(join(resolved.disposableRoot, REHEARSAL_MARKER_NAME),
    `${JSON.stringify(marker, null, 2)}\n`, 'rehearsal marker');
  return 'claimed';
}

export interface RestoreWorkspace {
  readonly path: string;
  /** Every component the workspace holds, and the digest of what was copied. */
  readonly components: Readonly<Record<BackupComponentId, string>>;
  readonly importDigest: string;
}

/**
 * Prepare the private, writable restore workspace from the verified set.
 *
 * ALL FOUR COMPONENTS, OR NONE. Phase 256 says a complete backup is four things; restoring one of them and
 * calling it a restore is the defect this replaces. The keystore in particular is what every decrypt in the
 * rehearsal depends on: without it the disposable stack would decrypt with keys that never encrypted this
 * data, and a fail-closed unreadable row looks exactly like a correctly erased one.
 *
 * THE SET ITSELF IS NEVER WRITTEN. Everything is COPIED out of it into a workspace the rehearsal owns; the
 * caller verifies the set again afterwards to prove that held.
 */
export function prepareRestoreWorkspace(resolved: ResolvedRehearsal): RestoreWorkspace {
  const path = join(resolved.disposableRoot, REHEARSAL_RESTORE_DIRNAME);
  if (existsSync(path)) {
    throw new MaintenanceRefused(
      'a restore workspace from an earlier run is still in the disposable root. It holds a copy of your keystore '
      + 'and secrets, so this command will not silently replace it: remove it deliberately, then rehearse again.');
  }
  createPrivateDirectory(path, 'rehearsal restore workspace');

  const components: Record<string, string> = {};
  for (const id of BACKUP_COMPONENT_IDS) {
    const artifact = COMPONENT_ARTIFACT_NAMES[id];
    const source = join(resolved.backupSet, artifact);
    const destination = join(path, artifact);
    if (!existsSync(source)) {
      if (id === 'promotion-records') {
        // Absent promotion records are a correct and permanent state for most installations, and the set's own
        // verification has already decided that. The SLOT is still created, so the mount is never missing.
        createPrivateDirectory(destination, 'restored promotion records');
        components[id] = digestOfDirectory(destination);
        continue;
      }
      throw new MaintenanceRefused(
        `the verified set has no ${id} component, so a restore from it would not be a restore. Retake the set.`);
    }
    if (id === 'database') {
      // STREAMED. A dump is larger than anything this process is willing to hold, and the workspace needs its
      // own writable copy of it rather than a mount of the operator's set.
      copyFileNoFollow(source, destination, 'restored database dump');
      components[id] = digestFileNoFollow(destination, 'restored database dump').digest;
      continue;
    }
    copyTree(source, destination, `restored ${id}`);
    components[id] = digestOfDirectory(destination);
  }

  const importDestination = join(path, REHEARSAL_IMPORT_NAME);
  copyFileNoFollow(resolved.importSnapshot, importDestination, 'representative import snapshot');
  const importDigest = digestFileNoFollow(importDestination, 'representative import snapshot').digest;

  return {
    path,
    components: components as Readonly<Record<BackupComponentId, string>>,
    importDigest,
  };
}

/** A digest over a directory's structure and contents. Names no content, and is stable across runs. */
function digestOfDirectory(directory: string): string {
  const hash = createHash('sha256');
  const walk = (from: string, prefix: string): void => {
    assertDirectoryNoFollow(from, 'restored component directory');
    for (const entry of readdirSync(from).slice().sort()) {
      const child = join(from, entry);
      const relativeName = `${prefix}${entry}`;
      // The `lstat` decides which branch to try; what makes it safe is that the file branch opens the leaf
      // without following a link and digests THAT descriptor.
      if (lstatSync(child).isDirectory()) {
        hash.update(`d ${relativeName}\n`);
        walk(child, `${relativeName}/`);
        continue;
      }
      hash.update(`f ${relativeName} ${digestFileNoFollow(child, 'restored component entry').digest}\n`);
    }
  };
  walk(directory, '');
  return hash.digest('hex');
}

/**
 * Write the Compose override that PINS one role's image and MOUNTS all four restored components.
 *
 * This is the file that makes "the candidate image was rehearsed" a fact rather than a claim. It is written
 * by this product, into a root this product owns, and every path in it is RELATIVE to that root — so the file
 * carries no host path, and a rehearsal is portable to wherever it is run.
 *
 * The image reference is safe to embed unquoted-in-YAML terms because `assertImmutableImageRef` has already
 * refused whitespace and anything that is not a reference; it is still quoted, because "already validated" is
 * a reason to write it correctly rather than a reason not to.
 */
export function renderRehearsalOverride(resolved: ResolvedRehearsal, role: RehearsalImageRole): string {
  const image = role === 'current' ? resolved.currentImage : resolved.candidateImage;
  const workspace = `./${REHEARSAL_RESTORE_DIRNAME}`;
  const names = COMPONENT_ARTIFACT_NAMES;
  return [
    '# Written by ops:upgrade-rehearsal. Disposable: this file belongs to one rehearsal in one scratch root.',
    `# role: ${role}`,
    'services:',
    '  postgres:',
    '    volumes:',
    `      - ${workspace}/${names.database}:${REHEARSAL_RESTORE_MOUNT}/${names.database}:ro`,
    '  app:',
    `    image: "${image}"`,
    '    volumes:',
    `      - ${workspace}/${names.keystore}:${REHEARSAL_KEYSTORE_MOUNT}`,
    `      - ${workspace}/${names.secrets}:${REHEARSAL_SECRETS_MOUNT}:ro`,
    `      - ${workspace}/${names['promotion-records']}:${REHEARSAL_PROMOTION_MOUNT}`,
    `      - ${workspace}/${REHEARSAL_IMPORT_NAME}:${REHEARSAL_IMPORT_MOUNT}/${REHEARSAL_IMPORT_NAME}:ro`,
    '',
  ].join('\n');
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

/** What a version comparison concluded. A CLOSED SET: no version string reaches durable evidence. */
export type VersionVerdict = 'as-declared' | 'not-as-declared' | 'unreadable' | 'not-reached';

export interface RehearsalStep {
  readonly id: string;
  readonly leg: RehearsalLeg;
  readonly proves: string;
  readonly ok: boolean;
  /** A closed-set reason when it did not hold. Never a runtime value, never a runner's message. */
  readonly detail: string;
}

export interface RehearsalReport {
  readonly report: typeof REHEARSAL_REPORT;
  readonly version: typeof REHEARSAL_VERSION;
  readonly ok: boolean;
  readonly projectName: string;
  readonly planDigest: string;
  /**
   * NON-REVERSIBLE DIGESTS OF THE TWO REFERENCES, not the references.
   *
   * An image reference names a registry, and often an owner or a host. Two digests are enough to prove the
   * rehearsal used two DIFFERENT images and to match a report against a plan the operator still has, which is
   * everything a support conversation needs from them.
   */
  readonly images: {
    readonly currentDigest: string;
    readonly candidateDigest: string;
    readonly distinct: boolean;
  };
  /** What each version comparison concluded, as closed words. */
  readonly versions: {
    readonly current: VersionVerdict;
    readonly candidate: VersionVerdict;
    readonly afterRollback: VersionVerdict;
  };
  readonly backupVerification: Pick<BackupVerificationReport, 'ok' | 'setName' | 'inspectorVerdict' | 'manifestSchemaVersion'>;
  /** The set was verified again at the end and was unchanged. A rehearsal never writes to the set. */
  readonly backupSetUnchanged: boolean;
  /** Which components were restored, and the digest of the copy. Names no content. */
  readonly restored: Readonly<Record<string, string>>;
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
 * A FAILED STEP STOPS THE RUN AND KEEPS THE EVIDENCE. It never broadens what is removed, and it never cleans
 * up silently: a rehearsal that tore down the thing you need to look at has cost you the run.
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
  if (manifest.schemaVersion !== resolved.expect.currentSchema) {
    throw new MaintenanceRefused(
      'the set\'s own manifest records a different schema version than the one declared for the current image. '
      + 'One of the two is wrong, and a rehearsal built on the wrong one would assert against a schema that was '
      + 'never restored. Nothing was started.');
  }

  const steps: RehearsalStep[] = [];
  const notes: string[] = [];
  const versions: Record<'current' | 'candidate' | 'rollback', VersionVerdict> = {
    current: 'not-reached', candidate: 'not-reached', rollback: 'not-reached',
  };
  let restored: Readonly<Record<BackupComponentId, string>> = {} as Readonly<Record<BackupComponentId, string>>;
  let failed = false;

  const plan = planRehearsal(resolved);
  for (const step of plan) {
    if (failed) break;
    let detail: string | null = null;
    for (const action of step.actions) {
      detail = performAction(action, resolved, deps, (role, verdict) => {
        const slot = step.id.startsWith('rollback') ? 'rollback' : role;
        versions[slot] = verdict;
      }, (workspace) => { restored = workspace.components; });
      if (detail !== null) break;
    }
    if (detail === null) {
      steps.push({ id: step.id, leg: step.leg, proves: step.proves, ok: true, detail: 'held' });
      continue;
    }
    // THE CLOSED SENTENCE OF THE STEP, plus the closed category of the action. Nothing read at runtime and
    // nothing a runner said appears here.
    steps.push({ id: step.id, leg: step.leg, proves: step.proves, ok: false, detail: `${step.whenNot} (${detail})` });
    failed = true;
  }

  // THE SET IS READ, NEVER WRITTEN, and that is checked rather than asserted.
  const after = verifyBackupSet(resolved.backupSet);
  const backupSetUnchanged = after.ok && after.setDigest === verification.setDigest;
  if (!backupSetUnchanged) {
    notes.push('The backup set did not verify identically after the rehearsal. A rehearsal only ever COPIES out '
      + 'of a set, so treat this as a problem with the set or its storage, and do not rely on it for a restore.');
  }

  // ---- cleanup: only the marker-bearing project, and only when nothing failed ---------------------------
  const cleanupCommand = rehearsalCleanupCommand(resolved);
  const cleanupPlan = [`${cleanupCommand.program} ${cleanupCommand.args.join(' ')}`];
  let cleanupPerformed = false;
  if (failed) {
    notes.push('A step did not hold, so the disposable project was LEFT IN PLACE for diagnosis. Nothing was '
      + 'removed, and the root still carries this rehearsal\'s marker, which names the project and the exact '
      + 'plan. When you have finished looking, run the one command in the cleanup plan — it addresses only '
      + 'that marked project.');
  } else if (request.cleanup === true) {
    // MARKER-BOUND. Cleanup is refused unless the root still says it belongs to this exact rehearsal, so a
    // cleanup cannot reach a project this run did not create.
    const marker = readRehearsalMarker(resolved.disposableRoot);
    if (marker === null || marker.projectName !== resolved.projectName || marker.planDigest !== resolved.planDigest) {
      notes.push('The disposable root no longer carries this rehearsal\'s marker, so nothing was removed. '
        + 'Removing resources by anything other than that marker is how a cleanup reaches a real installation.');
    } else {
      const outcome = runGuarded(deps.runner, deps.ledger, cleanupCommand);
      cleanupPerformed = outcome.status === 0;
      if (!cleanupPerformed) {
        notes.push('The disposable project could not be removed. It carries this rehearsal\'s marker and nothing '
          + 'else does; remove it with the command in the cleanup plan.');
      }
    }
  } else {
    notes.push('The disposable project was left in place. Pass --cleanup to remove it, or run the one command in '
      + 'the cleanup plan yourself.');
  }

  if (manifest.schemaVersion === MIGRATION_VERSION && resolved.expect.candidateSchema === MIGRATION_VERSION) {
    notes.push(`The restored set and the candidate are both at this build's own schema version `
      + `(${MIGRATION_VERSION}), so no migration ran during the rehearsal. A rehearsal is most meaningful when `
      + 'the set predates the candidate\'s migration.');
  }
  notes.push('Nothing was fetched: every image came from this host and no pull, login or push is available to this '
    + 'command at all.');
  notes.push('Production was never addressed. Every command ran in the disposable root under this rehearsal\'s own '
    + 'project name.');

  return {
    report: REHEARSAL_REPORT,
    version: REHEARSAL_VERSION,
    ok: !failed && backupSetUnchanged,
    projectName: resolved.projectName,
    planDigest: resolved.planDigest,
    images: {
      currentDigest: referenceDigest(resolved.currentImage),
      candidateDigest: referenceDigest(resolved.candidateImage),
      distinct: resolved.currentImage !== resolved.candidateImage,
    },
    versions: {
      current: versions.current,
      candidate: versions.candidate,
      afterRollback: versions.rollback,
    },
    backupVerification: {
      ok: verification.ok,
      setName: verification.setName,
      inspectorVerdict: verification.inspectorVerdict,
      manifestSchemaVersion: verification.manifestSchemaVersion,
    },
    backupSetUnchanged,
    restored,
    steps,
    cleanup: { performed: cleanupPerformed, by: `compose project ${resolved.projectName}`, plan: cleanupPlan },
    touchedProduction: false,
    network: 'none',
    mediaOperations: 'none',
    notes,
  };
}

/**
 * A non-reversible digest of an image reference. Proves identity and difference; discloses neither.
 *
 * Domain-separated by a canonical JSON array rather than by a separator character, so the domain and the
 * reference cannot be blurred by a reference that contains the separator — and so this file carries no
 * control byte, which a repository-wide guard (rightly) refuses in source.
 */
export function referenceDigest(ref: string): string {
  return createHash('sha256').update(JSON.stringify([REHEARSAL_REPORT, 'image', ref]), 'utf8').digest('hex');
}

/**
 * Perform one planned action, and answer with a CLOSED failure category or `null`.
 *
 * Nothing this returns is derived from what a command printed. A runner that threw, a container that answered
 * something unexpected and a check that did not hold are three closed categories — which is what a support
 * report can carry and what an operator can act on.
 */
function performAction(
  action: RehearsalAction,
  resolved: ResolvedRehearsal,
  deps: RehearsalDeps,
  recordVersion: (role: RehearsalImageRole, verdict: VersionVerdict) => void,
  recordWorkspace: (workspace: RestoreWorkspace) => void,
): string | null {
  if (action.kind === 'prepare-workspace') {
    try {
      claimDisposableRoot(resolved);
      recordWorkspace(prepareRestoreWorkspace(resolved));
      return null;
    } catch (err) {
      // A refusal this product wrote is its own closed sentence and is safe to carry; anything else is not.
      return err instanceof MaintenanceRefused ? err.message : 'the restore workspace could not be prepared';
    }
  }
  if (action.kind === 'write-override') {
    try {
      writePrivateFile(join(resolved.disposableRoot, REHEARSAL_OVERRIDE_NAMES[action.role]),
        renderRehearsalOverride(resolved, action.role), `${action.role} image override`);
      return null;
    } catch (err) {
      return err instanceof MaintenanceRefused ? err.message : 'the image override could not be written';
    }
  }

  let outcome;
  try {
    outcome = runGuarded(deps.runner, deps.ledger, action.command);
  } catch (err) {
    return err instanceof MaintenanceRefused ? err.message : 'the step could not be run';
  }
  switch (action.assertion.kind) {
    case 'exit-zero':
      return outcome.status === 0 ? null : 'the command did not succeed';
    case 'doctor-no-fail': {
      if (outcome.status !== 0 && outcome.stdout.trim() === '') return 'the doctor could not be run at all';
      const parsed = parseDoctorJson(outcome.stdout);
      if (parsed === null) return 'the doctor did not answer in the shape this build understands';
      const state = classifyDoctor(parsed);
      // THE STATE, WHICH IS ONE OF FOUR WORDS. Never a `detail`: a doctor detail is written for a person at a
      // terminal and can name a path, a uid or a connection.
      return state === 'FAIL' || state === 'INVALID' ? `the doctor reported ${state}` : null;
    }
    case 'product-version': {
      const { role } = action.assertion;
      if (outcome.status !== 0) { recordVersion(role, 'unreadable'); return 'the product version could not be read'; }
      const read = readNpmVersion(outcome.stdout);
      if (read === null) { recordVersion(role, 'unreadable'); return 'the product version could not be read'; }
      if (read !== action.assertion.expected) {
        recordVersion(role, 'not-as-declared');
        return 'the running product version is not the declared one';
      }
      recordVersion(role, 'as-declared');
      return null;
    }
    case 'schema-version': {
      if (outcome.status !== 0 && outcome.stdout.trim() === '') return 'the schema version could not be read';
      const read = readSchemaVersions(outcome.stdout);
      if (read === null) return 'the schema version could not be read';
      if (read.build !== action.assertion.expectedBuild) return 'the running build expects another schema version';
      if (read.database !== action.assertion.expectedDatabase) return 'the database is at another schema version';
      return null;
    }
    default:
      return 'the step could not be run';
  }
}

/** `npm pkg get version` answers a JSON string. Anything else is unreadable, not guessed at. */
export function readNpmVersion(stdout: string): string | null {
  const text = stdout.trim();
  if (text.length === 0 || text.length > 256) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,32})?$/.test(parsed)
      ? parsed : null;
  } catch {
    return null;
  }
}

/** `ops:version` answers `schema version: db=<n> expected=<m> — ...`, which is its shipped stable line. */
export function readSchemaVersions(stdout: string): { readonly database: number; readonly build: number } | null {
  const match = /schema version: db=([0-9]+) expected=([0-9]+)/.exec(stdout);
  if (match === null) return null;
  return { database: Number(match[1]), build: Number(match[2]) };
}

/**
 * The evidence report an operator keeps.
 *
 * Step ids, what each proves, whether it held, two image DIGESTS, closed version verdicts and the plan
 * digest. No image reference, no version string, no host path, no address, no registry, no secret, no doctor
 * detail and nothing from inside the backup.
 */
export function renderRehearsal(report: RehearsalReport): string {
  const lines: string[] = [];
  lines.push(`Upgrade rehearsal — ${report.ok ? 'BOTH LEGS HELD' : 'A STEP DID NOT HOLD'}`);
  lines.push(`  project            ${report.projectName}`);
  lines.push(`  plan digest        ${report.planDigest}`);
  lines.push(`  current image      sha256:${report.images.currentDigest.slice(0, 32)} (reference digest)`);
  lines.push(`  candidate image    sha256:${report.images.candidateDigest.slice(0, 32)} (reference digest)`);
  lines.push(`  images differ      ${report.images.distinct}`);
  lines.push(`  version on current    ${report.versions.current}`);
  lines.push(`  version on candidate  ${report.versions.candidate}`);
  lines.push(`  version after rollback ${report.versions.afterRollback}`);
  lines.push(`  backup set         ${report.backupVerification.setName} (${report.backupVerification.inspectorVerdict}, `
    + `schema ${report.backupVerification.manifestSchemaVersion})`);
  lines.push(`  set unchanged      ${report.backupSetUnchanged}`);
  lines.push('  restored components:');
  for (const [id, digest] of Object.entries(report.restored)) {
    lines.push(`    ${id.padEnd(20)} ${digest.slice(0, 16)}`);
  }
  lines.push(`  touched production ${report.touchedProduction}`);
  lines.push(`  network            ${report.network}`);
  lines.push(`  media operations   ${report.mediaOperations}`);
  lines.push('  steps:');
  for (const entry of report.steps) {
    lines.push(`    ${entry.ok ? 'HELD' : 'FAIL'}  ${entry.leg.padEnd(8)} ${entry.id.padEnd(22)} ${entry.proves}`);
    if (!entry.ok) lines.push(`          -> ${entry.detail}`);
  }
  lines.push(`  cleanup            ${report.cleanup.performed ? 'removed' : 'not performed'} (${report.cleanup.by})`);
  for (const command of report.cleanup.plan) lines.push(`    plan: ${command}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push(`  RESULT: ${report.ok ? 'OK' : 'INCOMPLETE'}`);
  return lines.join('\n');
}
