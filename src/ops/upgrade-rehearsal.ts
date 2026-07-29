import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { MIGRATION_VERSION } from '../db/schema-version.js';
import {
  BACKUP_COMPONENT_IDS, REQUIRED_SECRET_FILES, type BackupComponentId,
} from './backup-components.js';
import { verifyBackupSet, type BackupVerificationReport } from './backup-set-verification.js';
import { RUNTIME_ROLE_NAME } from './bootstrap.js';
import { CATALOG_IMPORT_CONTAINER_DIR, CATALOG_IMPORT_DIR_ENV } from './catalog-import.js';
import { COMPONENT_ARTIFACT_NAMES, copyTree, readBackupManifest } from './complete-backup.js';
import { classifyDoctor, parseDoctorJson } from './doctor-monitor.js';
import { PROMOTION_RECORDS_DEFAULT_DIR, PROMOTION_RECORDS_DIR_ENV } from './operator-ui-promotion-chain.js';
import {
  REHEARSAL_PRODUCT_SERVICES,
  REHEARSAL_SERVICES,
  assertNoComposeInterpolation,
  assertNoExternalComposeInputs,
  parseResolvedComposeModel,
  resolvedComposeDigest,
  validateResolvedCompose,
  type RequiredWiring,
} from './rehearsal-compose-model.js';
import {
  CommandLedger,
  MaintenanceRefused,
  assertDirectoryNoFollow,
  assertUsableName,
  copyFileNoFollow,
  createPrivateDirectory,
  digestFileNoFollow,
  readFileNoFollow,
  removeOwnFileNoFollow,
  removeOwnTreeNoFollow,
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
//
// -----------------------------------------------------------------------------------------------------
// AND THE SECOND ROUND OF CORRECTIONS: WHAT THE FIRST ONE STILL ASSERTED RATHER THAN PROVED.
// -----------------------------------------------------------------------------------------------------
//
// Everything above was true and none of it was enough, because six claims were still made by a constant.
//
//   1. `touchedProduction: false` WAS A LITERAL. A Compose definition decides for itself what it touches: a
//      bind mount names a host directory, a Docker secret names a host file, an external volume is somebody
//      else's, and `${VAR:-/mnt/user/appdata/catalog}` is production BY DEFAULT. The shipped Unraid stack
//      does all of those, so following the documentation exactly would have rehearsed against production
//      while the report said it had not. Now the fully resolved configuration — Compose's own answer, from
//      `config`, which starts nothing — is obtained and validated BEFORE the marker is claimed and before a
//      container could exist, and again after each override is written. See `rehearsal-compose-model.ts`.
//   2. ONLY `app.image` WAS PINNED. In this stack `migrate` and `sidecar` are the SAME product image, so the
//      candidate leg ran the candidate app against the CURRENT build's migration and the CURRENT build's
//      custodian sidecar. The migration is the entire reason a rollback is hard. Every product service is
//      now pinned in every override, and the resolved model is what proves it.
//   3. THE RESTORED SECRETS WERE MOUNTED SOMEWHERE NOTHING READ. A generic secrets directory into `app` does
//      not replace a Docker secret, and the sidecar kept its base state bind and its `/run/secrets/*` files
//      — production files. Each restored file is now bound at the exact path its service reads, and the
//      environment variable that names that path is set to it, and both are checked in the resolved model.
//   4. THE PLAN DIGEST COVERED PATHS, NOT BYTES. A definition, an import snapshot or a whole backup set could
//      be swapped between `--plan` and the run. The digest now binds the CONTENT of all three, and they are
//      recomputed immediately before the marker is claimed and refused if any moved.
//   5. TWO EXIT-ZERO APPLIES ARE NOT IDEMPOTENCE, and a matching stdout behind a NON-ZERO status is not a
//      pass. The import runs with `--json` and its shipped report is read: the replay must report no new and
//      no updated record. Every successful assertion requires status zero, and stdout is bounded before it is
//      parsed.
//   6. `cleanup.performed: true` MEANT "compose down ran" while a workspace holding a copy of the keystore
//      and every secret file stayed on disk. Cleanup now removes the fixed, marker-owned artifacts it wrote —
//      by identity and digest, never a recursive delete of an unverified path — and the marker last.

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
export const REHEARSAL_SECRETS_MOUNT = '/run/catalog-rehearsal-secrets';

/** The representative import snapshot, inside the restore workspace and inside the container. */
export const REHEARSAL_IMPORT_NAME = 'catalog-rehearsal-import.json';

/** How large a Compose definition this command will read. A stack description, not a data file. */
export const MAX_COMPOSE_DEFINITION_BYTES = 1024 * 1024;

/**
 * How much a step's output may be before it is used as evidence.
 *
 * A CHECK PARSES WHAT A CONTAINER PRINTED, which is the one place in this command where a value crosses from
 * inside the disposable stack into this process. Bounding it before `JSON.parse` or a regular expression sees
 * it means a container that printed a gigabyte cannot decide how much memory this uses, and cannot make a
 * pattern match take unbounded time.
 */
export const MAX_ASSERTION_STDOUT_BYTES = 1024 * 1024;

/** The container path the custodian sidecar keeps its keystore at. The shipped stack's `SIDECAR_STATE_DIR`. */
export const REHEARSAL_SIDECAR_STATE_MOUNT = '/var/lib/catalog-sidecar/state';

/**
 * Which service reads each required secret file, and the variable it reads the path from.
 *
 * KEYED BY THE PHASE 256 REQUIRED LIST, AND CHECKED AGAINST IT. `requiredRehearsalWiring` refuses if any
 * entry of `REQUIRED_SECRET_FILES` has no consumer here — so a stack that starts requiring a seventh secret
 * cannot leave a rehearsal quietly restoring six and calling the restore complete.
 *
 * The paths and variable names are the shipped stack's own; a suite asserts every one of them appears in
 * `docker-compose.unraid.runtime.yml`, so this cannot drift away from the thing it is modelling.
 */
export const REHEARSAL_SECRET_CONSUMERS: Readonly<Record<string, readonly {
  readonly service: string;
  /**
   * The variable that must name the mounted path, or `null` where the rehearsal must NOT set one.
   *
   * `null` IS FOR THE CUSTODY SECRETS THE STACK CHOOSES BETWEEN. Phase 282 gives the sidecar two possible
   * sources of key material — the static KEK and the ring's root wrapping key — and the daemon REFUSES to
   * start wired to both, because a process with two answers to "what wraps a DEK" uses whichever branch ran
   * first. Which one an installation uses is a fact about whether it has migrated, and that is the operator's
   * stack's decision, not the rehearsal's. So the file is mounted (a restore that did not put it back is a
   * restore this command must fail) and the choice is left to the definition being rehearsed.
   */
  readonly env: string | null;
}[]>> = Object.freeze({
  postgres_password: [{ service: 'postgres', env: 'POSTGRES_PASSWORD_FILE' }],
  admin_database_url: [
    { service: 'migrate', env: 'ADMIN_DATABASE_URL_FILE' },
    { service: 'app', env: 'ADMIN_DATABASE_URL_FILE' },
  ],
  database_url: [
    { service: 'migrate', env: 'DATABASE_URL_FILE' },
    { service: 'app', env: 'DATABASE_URL_FILE' },
  ],
  operator_ui_token: [{ service: 'app', env: 'OPERATOR_UI_TOKEN_FILE' }],
  completion_secret: [{ service: 'sidecar', env: 'SIDECAR_COMPLETION_SECRET_FILE' }],
  custodian_kek: [{ service: 'sidecar', env: 'SIDECAR_KEK_FILE' }],
  // Phase 282. Mounted so a restore that lost it fails here, and NOT pointed at: see the `env` docs above.
  custodian_root_key: [{ service: 'sidecar', env: null }],
});

/**
 * Everything the restored set must actually reach, derived from the component model and the secret list.
 *
 * THIS IS THE WHOLE OF "THE RESTORE WAS REAL". Each entry is checked against the RESOLVED configuration, so
 * "the keystore is mounted" means Compose, after merging the operator's definition with this command's
 * override, would give the sidecar the copy this rehearsal made — and not the base definition's production
 * bind, which merging cannot remove and which this therefore refuses instead of hiding.
 */
export function requiredRehearsalWiring(): readonly RequiredWiring[] {
  const names = COMPONENT_ARTIFACT_NAMES;
  const wiring: RequiredWiring[] = [
    {
      service: 'postgres',
      containerPath: `${REHEARSAL_RESTORE_MOUNT}/${names.database}`,
      env: null,
      workspaceEntry: names.database,
      writable: false,
      proves: 'the database dump the restore replays',
    },
    {
      // THE KEYSTORE GOES WHERE THE CUSTODIAN LIVES, WHICH IN THIS STACK IS THE SIDECAR — not the app. Mounting
      // it into `app` would have been a mount nothing opened: in sidecar custody mode every unwrap goes through
      // the sidecar's own state directory, so a rehearsal that left that as the base definition's production
      // bind decrypted with production's keys and proved nothing about the restored ones.
      service: 'sidecar',
      containerPath: REHEARSAL_SIDECAR_STATE_MOUNT,
      env: 'SIDECAR_STATE_DIR',
      workspaceEntry: names.keystore,
      writable: true,
      proves: 'the custodian keystore every decrypt depends on',
    },
    {
      service: 'app',
      containerPath: PROMOTION_RECORDS_DEFAULT_DIR,
      env: PROMOTION_RECORDS_DIR_ENV,
      workspaceEntry: names['promotion-records'],
      writable: false,
      proves: 'the promotion record artifacts',
    },
    {
      service: 'app',
      containerPath: `${CATALOG_IMPORT_CONTAINER_DIR}/${REHEARSAL_IMPORT_NAME}`,
      env: null,
      alsoEnv: { [CATALOG_IMPORT_DIR_ENV]: CATALOG_IMPORT_CONTAINER_DIR },
      workspaceEntry: REHEARSAL_IMPORT_NAME,
      writable: false,
      proves: 'the representative import snapshot',
    },
  ];
  for (const file of REQUIRED_SECRET_FILES) {
    const consumers = REHEARSAL_SECRET_CONSUMERS[file];
    if (consumers === undefined || consumers.length === 0) {
      throw new MaintenanceRefused(
        `this build does not know which service reads the "${file}" secret, so it cannot prove a rehearsal `
        + 'restored it into the place that uses it. A secret this product requires and this command cannot '
        + 'place is a restore nobody can verify: add it to REHEARSAL_SECRET_CONSUMERS.');
    }
    for (const consumer of consumers) {
      wiring.push({
        service: consumer.service,
        containerPath: `${REHEARSAL_SECRETS_MOUNT}/${file}`,
        env: consumer.env,
        workspaceEntry: `${names.secrets}/${file}`,
        writable: false,
        proves: `the restored "${file}" secret`,
      });
    }
  }
  return wiring;
}

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

/**
 * The CONTENT of the three inputs a rehearsal reads, not the names of them.
 *
 * THE DEFECT THIS CLOSES. The plan digest hashed the compose, import and backup-set PATHS. A path is a
 * promise about where something is, not about what it is: between the `--plan` an operator reads and the
 * `--confirm-digest` they run, the Compose definition could be edited to add a production bind, the import
 * snapshot could be replaced, and the whole backup set could be swapped for another one at the same name —
 * and every one of those would still confirm the digest they had been shown.
 *
 * All three are therefore read through the same no-follow, streaming primitives everything else here uses,
 * bound into the digest, and RE-READ immediately before the marker is claimed. A change between the two is a
 * refusal, not a note.
 *
 * The compose digest is over the definition's BYTES, and that is sufficient BECAUSE `assertNoComposeInterpolation`
 * refuses any definition whose meaning depends on a variable — so the configuration Compose resolves is a
 * function of those bytes and of the two overrides this product writes itself. The resolved model is
 * separately obtained, validated and digested at run time; both facts are in the evidence.
 */
export interface RehearsalInputDigests {
  readonly compose: string;
  readonly importSnapshot: string;
  /** The verified set's own digest, from the verification that has to pass before anything runs. */
  readonly backupSet: string;
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
  readonly inputs: RehearsalInputDigests;
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
  // THE DEFINITION'S MEANING MUST BE IN THE DEFINITION. Read through one no-follow descriptor and refused if
  // it interpolates anything — see `rehearsal-compose-model.ts` for why a variable here is a production escape
  // and not a convenience.
  const composeText = readFileNoFollow(composeFile, 'disposable Compose definition', MAX_COMPOSE_DEFINITION_BYTES);
  assertDisposableComposeText(composeText.bytes.toString('utf8'));
  const composeDigest = createHash('sha256').update(composeText.bytes).digest('hex');
  // A `.env` beside the definition is read by Compose whether or not anybody meant it to be, and it can set
  // `COMPOSE_PROFILES` — which decides which services the resolved stack even has. The definition's bytes are
  // what the plan digest binds; a second file quietly deciding part of the answer is refused rather than
  // digested as an afterthought.
  if (existsSync(join(disposableRoot, '.env'))) {
    throw new MaintenanceRefused(
      'the disposable rehearsal root holds a ".env" file. Compose reads it, and what it holds can change which '
      + 'services the stack resolves to — so the definition would no longer be the whole of what this command '
      + 'binds into the plan you confirm. Remove it from the rehearsal directory.');
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
    inputs: {
      compose: composeDigest,
      // STREAMED, so a representative snapshot larger than any in-memory bound is still bound by content.
      importSnapshot: digestFileNoFollow(importSnapshot, 'representative import snapshot').digest,
      // THE SET'S DIGEST IS THE VERIFICATION'S, and a set that does not verify has none. Binding an
      // unverifiable set's digest into a plan an operator could confirm would be binding nothing.
      backupSet: verifiedSetDigest(backupSet),
    },
  };
  return { ...resolved, planDigest: rehearsalPlanDigest(resolved) };
}

/**
 * Everything a disposable Compose definition must satisfy in its own TEXT, before Compose ever resolves it.
 *
 * Both rules exist for the same reason: the plan digest binds the definition's BYTES, and a definition whose
 * resolved meaning depends on an ambient variable or on a second file is one whose meaning those bytes do not
 * determine. See `rehearsal-compose-model.ts` for what each would reach.
 */
export function assertDisposableComposeText(text: string): void {
  assertNoComposeInterpolation(text, 'disposable Compose definition');
  assertNoExternalComposeInputs(text, 'disposable Compose definition');
}

/**
 * The digest of a backup set that verifies NOW, or a refusal.
 *
 * Called from `resolveRehearsal`, so `--plan` and the run both fail on an unverifiable set — and so the plan
 * digest an operator confirms is bound to the exact CONTENTS of the set that was verified when they read it.
 */
function verifiedSetDigest(backupSet: string): string {
  const verification = verifyBackupSet(backupSet);
  if (!verification.ok || verification.setDigest === '') {
    throw new MaintenanceRefused(
      'the backup set this rehearsal would restore does not verify, so the rehearsal would prove nothing about a '
      + 'restore. Fix or retake the set first. Nothing was started.');
  }
  return verification.setDigest;
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
    // THE CONTENT, NOT ONLY THE NAMES. Swapping the file, the snapshot or the whole set behind any of the
    // three paths above now produces a different digest, so a confirmation issued for one set of bytes cannot
    // be spent on another.
    inputs: [plan.inputs.compose, plan.inputs.importSnapshot, plan.inputs.backupSet],
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Read the three inputs AGAIN and refuse if any of them moved.
 *
 * RUN IMMEDIATELY BEFORE THE MARKER IS CLAIMED, which is the last moment before this command creates anything.
 * `resolveRehearsal` read them when the plan was computed; between then and here an operator has read a plan,
 * copied a digest and typed a command, and a definition or a set can be replaced in that window by anything
 * with write access to it — including this product's own scheduled backup writing a new set over the name.
 *
 * The comparison is against the digests bound into the plan the operator confirmed, so this is not "did it
 * change since a moment ago" but "is it still the thing you agreed to".
 */
export function reverifyRehearsalInputs(resolved: ResolvedRehearsal): void {
  const composeFile = resolveInsideRoot(resolved.disposableRoot, resolved.composeFile, 'compose definition');
  const composeText = readFileNoFollow(composeFile, 'disposable Compose definition', MAX_COMPOSE_DEFINITION_BYTES);
  const compose = createHash('sha256').update(composeText.bytes).digest('hex');
  if (compose !== resolved.inputs.compose) {
    throw new MaintenanceRefused(
      'the disposable Compose definition is not the file whose plan you confirmed — its contents changed after '
      + 'the plan was computed. Nothing was claimed and nothing was started. Re-run with --plan, read it again, '
      + 'and confirm the digest of what is actually there.');
  }
  // Belt and braces: the interpolation rule is re-applied to the bytes that will actually be resolved.
  assertDisposableComposeText(composeText.bytes.toString('utf8'));

  const snapshot = digestFileNoFollow(resolved.importSnapshot, 'representative import snapshot').digest;
  if (snapshot !== resolved.inputs.importSnapshot) {
    throw new MaintenanceRefused(
      'the representative import snapshot is not the file whose plan you confirmed. Nothing was claimed and '
      + 'nothing was started.');
  }
  if (verifiedSetDigest(resolved.backupSet) !== resolved.inputs.backupSet) {
    throw new MaintenanceRefused(
      'the backup set is not the one whose plan you confirmed — a set at that name verifies, and it is a '
      + 'different set. A rehearsal restores the set an operator chose, not whichever one is there when it runs. '
      + 'Nothing was claimed and nothing was started.');
  }
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
  | { readonly kind: 'schema-version'; readonly expectedBuild: number; readonly expectedDatabase: number }
  /**
   * The fully resolved configuration is obtained and validated. `role` is `null` for the operator's bare
   * definition — the check that runs before anything is claimed or created — and a role once that role's
   * override has been written on top of it.
   */
  | { readonly kind: 'compose-model'; readonly role: RehearsalImageRole | null }
  /** The shipped import report, read as JSON. `phase` decides what the numbers in it must say. */
  | { readonly kind: 'import-report'; readonly phase: 'preview' | 'apply' | 'replay' };

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
  const prepareRuntimeRole = (role: RehearsalImageRole, purpose: string): MaintenanceCommand => {
    // pg_dump preserves GRANT targets but does not dump cluster-wide roles. The managed runtime role is a
    // product constant, not input from the dump. Create it without login so the ACL replay is portable; the
    // normal bootstrap later sets LOGIN and its restored credential through set_app_role_password().
    // CREATE ROLE defaults to NOLOGIN. Spell only CREATE ROLE so the maintenance command vocabulary contains
    // no registry "login" token and the no-network ledger remains mechanically enforceable.
    const sql = `DO $catalog$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = `
      + `'${RUNTIME_ROLE_NAME}') THEN CREATE ROLE ${RUNTIME_ROLE_NAME}; END IF; END $catalog$;`;
    return compose(role,
      ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'catalog', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      purpose);
  };
  const importFile = `${CATALOG_IMPORT_CONTAINER_DIR}/${REHEARSAL_IMPORT_NAME}`;
  /**
   * `docker compose config`, which RESOLVES and STARTS NOTHING.
   *
   * It is the only authority on what a definition means: the same merge, extension and normalisation the
   * daemon would apply at `up`, answered as JSON, with no container, network or volume created. `--no-interpolate`
   * is deliberate — the definition is already refused if it interpolates, and asking Compose not to do it makes
   * a variable that slipped past that check produce a visible `${…}` in a bind source rather than a silently
   * resolved production path.
   */
  const configure = (role: RehearsalImageRole | null): MaintenanceCommand =>
    compose(role, ['config', '--format', 'json', '--no-interpolate'],
      'resolve the disposable stack without starting any part of it');

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
      // FIRST, AND BEFORE ANYTHING IS CLAIMED OR CREATED. Everything after this depends on the disposable stack
      // being disposable, and that is a property of the DEFINITION, not of the directory it sits in.
      id: 'disposable-stack',
      leg: 'setup',
      proves: 'the operator\'s definition resolves to a stack that touches nothing outside this rehearsal',
      whenNot: 'the disposable Compose definition could reach something this rehearsal does not own',
      actions: [{ kind: 'command', command: configure(null), assertion: { kind: 'compose-model', role: null } }],
    },
    {
      id: 'own-the-root',
      leg: 'setup',
      proves: 'the disposable root belongs to THIS rehearsal, and holds nothing of anybody\'s',
      whenNot: 'the disposable root could not be claimed for this rehearsal',
      actions: [{ kind: 'prepare-workspace' }],
    },
    {
      id: 'pin-current',
      leg: 'setup',
      proves: 'the CURRENT override pins every product service and wires every restored component in',
      whenNot: 'the current override did not produce a stack running the current image on the restored copies',
      actions: [{ kind: 'write-override', role: 'current' },
        { kind: 'command', command: configure('current'), assertion: { kind: 'compose-model', role: 'current' } }],
    },
    {
      id: 'pin-candidate',
      leg: 'setup',
      proves: 'the CANDIDATE override pins every product service and wires every restored component in',
      whenNot: 'the candidate override did not produce a stack running the candidate image on the restored copies',
      actions: [{ kind: 'write-override', role: 'candidate' },
        { kind: 'command', command: configure('candidate'), assertion: { kind: 'compose-model', role: 'candidate' } }],
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
      proves: 'the disposable database becomes healthy from an image already on this host',
      whenNot: 'the disposable database did not become healthy from an image already on this host',
      actions: [{
        kind: 'command',
        command: compose('current',
          ['up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '60', 'postgres'],
          'start only the database and wait for its declared healthcheck'),
        assertion: exitZero,
      }],
    },
    {
      id: 'prepare-runtime-role',
      leg: 'setup',
      proves: 'the managed runtime role exists without a login before the backup replays its grants',
      whenNot: 'the credential-free managed runtime role could not be prepared for the restore',
      actions: [{
        kind: 'command',
        command: prepareRuntimeRole('current', 'prepare the credential-free managed runtime role'),
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
        command: app('current', ['run', '--silent', 'ops:catalog-import', '--', '--file', importFile, '--json'],
          'preview a representative import — without --apply nothing is written'),
        assertion: { kind: 'import-report', phase: 'preview' },
      }],
    },
    {
      id: 'current-import-apply',
      leg: 'upgrade',
      proves: 'that same import applies to the restored catalog, and its own report says what it wrote',
      whenNot: 'the representative import could not be applied',
      actions: [{
        kind: 'command',
        command: app('current',
          ['run', '--silent', 'ops:catalog-import', '--', '--file', importFile, '--apply', '--json'],
          'apply the representative import'),
        assertion: { kind: 'import-report', phase: 'apply' },
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
      proves: 'the same import replays after the migration and its own report shows it wrote nothing new',
      whenNot: 'the replayed import was not idempotent: its report records a durable write on the second run',
      actions: [{
        kind: 'command',
        // THE SHIPPED REPORT, NOT THE EXIT CODE. Two exit-zero applies prove that an import ran twice, which is
        // not idempotence: a second run that created every record again would exit zero and would have doubled
        // the catalog. The `--json` report says `created` and `updated`, and on a replay both must be nought.
        command: app('candidate',
          ['run', '--silent', 'ops:catalog-import', '--', '--file', importFile, '--apply', '--json'],
          'replay the same import and read its report to prove it is idempotent'),
        assertion: { kind: 'import-report', phase: 'replay' },
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
      proves: 'a fresh disposable database becomes healthy again',
      whenNot: 'the disposable database did not become healthy again',
      actions: [{
        kind: 'command',
        command: compose('current',
          ['up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '60', 'postgres'],
          'start a fresh disposable database and wait for its declared healthcheck'),
        assertion: exitZero,
      }],
    },
    {
      id: 'rollback-runtime-role',
      leg: 'rollback',
      proves: 'the managed runtime role exists without a login before the rollback replays its grants',
      whenNot: 'the credential-free managed runtime role could not be prepared for the rollback restore',
      actions: [{
        kind: 'command',
        command: prepareRuntimeRole('current',
          'prepare the credential-free managed runtime role for rollback'),
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
 * What a rehearsal is allowed to find in a root it is about to claim FOR THE FIRST TIME: the operator's
 * Compose definition, and nothing else at all.
 *
 * THE DEFECT THIS CLOSES. The first version allowlisted the marker's own name, the restore workspace and both
 * override files here — the names this command writes. Reaching this function at all means there is no valid
 * marker, so a file at one of those names was NOT put there by a rehearsal this command can account for: an
 * interrupted run whose marker was deleted, a directory somebody copied, or something written deliberately.
 * The old rule let all of those pass the ownership check, wrote a marker over them, and only then failed on
 * the leftover workspace — having claimed a directory it had just decided it did not own.
 *
 * An artifact bearing one of this command's names WITHOUT a matching marker is therefore unowned content, and
 * unowned content is refused before a marker is written.
 */
function ownedEntriesBeforeFirstClaim(resolved: ResolvedRehearsal): readonly string[] {
  return [resolved.composeFile];
}

/**
 * The fixed artifacts a rehearsal writes into a root it owns.
 *
 * A CLOSED LIST OF NAMES, used by the cleanup. Everything on it is produced by this command, at a name this
 * command chose, and each is verified by identity before it is removed.
 */
export function rehearsalOwnedArtifacts(): readonly string[] {
  return [REHEARSAL_RESTORE_DIRNAME, REHEARSAL_OVERRIDE_NAMES.current, REHEARSAL_OVERRIDE_NAMES.candidate];
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
  const owned = new Set(ownedEntriesBeforeFirstClaim(resolved));
  for (const entry of readdirSync(resolved.disposableRoot)) {
    if (!owned.has(entry)) {
      throw new MaintenanceRefused(
        'the disposable rehearsal root holds something other than your Compose definition, and it carries no '
        + 'marker saying this rehearsal owns it. A rehearsal destroys volumes and rewrites its own workspace; it '
        + 'will not do that in a directory that is somebody\'s — and a leftover workspace, override or marker '
        + 'from a run this command cannot account for is exactly the case where it must not. Use an empty '
        + 'directory holding only your Compose definition, or look at what is there and remove it deliberately.');
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
  const wiring = requiredRehearsalWiring();
  const lines: string[] = [
    '# Written by ops:upgrade-rehearsal. Disposable: this file belongs to one rehearsal in one scratch root.',
    `# role: ${role}`,
    '#',
    '# Every product-image service is pinned to ONE reference, because in this product\'s stack the migration',
    '# and the custodian sidecar are the same image as the app — so pinning only the app would rehearse the',
    '# candidate build against the CURRENT build\'s migration, which is the one thing this exists to exercise.',
    '#',
    '# Every restored component is bound at the exact path the running image reads, and the variable that names',
    '# that path is set to it. What Compose actually resolves from this is read back and validated; a base',
    '# entry that survived the merge is a refusal rather than something this file pretends to have replaced.',
    'services:',
  ];
  for (const service of [...REHEARSAL_SERVICES]) {
    lines.push(`  ${service}:`);
    if (REHEARSAL_PRODUCT_SERVICES.includes(service)) lines.push(`    image: "${image}"`);
    const mine = wiring.filter((entry) => entry.service === service);
    const environment: [string, string][] = [];
    for (const entry of mine) {
      if (entry.env !== null) environment.push([entry.env, entry.containerPath]);
      for (const pair of Object.entries(entry.alsoEnv ?? {})) environment.push(pair);
    }
    if (environment.length > 0) {
      lines.push('    environment:');
      for (const [name, value] of environment) lines.push(`      ${name}: "${value}"`);
    }
    if (mine.length > 0) {
      lines.push('    volumes:');
      for (const entry of mine) {
        lines.push(`      - ${workspace}/${entry.workspaceEntry}:${entry.containerPath}${entry.writable ? '' : ':ro'}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
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
  /**
   * The digest of the fully resolved configuration at each point it was validated.
   *
   * `base` is the operator's definition alone, checked before anything was claimed or created; the other two
   * are that definition with each override merged on top. Non-reversible, so they name no host path — and
   * enough to prove the two legs really resolved to different stacks.
   */
  readonly composeModel: {
    readonly base: string | null;
    readonly current: string | null;
    readonly candidate: string | null;
  };
  /**
   * What the representative import actually proved. A CLOSED SET.
   *
   * `proved` — the apply made a durable change and the replay made none. `proved-vacuously` — the replay made
   * none, and neither did the apply, so the snapshot was already present and the second run had nothing to
   * repeat; true, and weaker than it looks, which is why it is a different word.
   */
  readonly importIdempotence: 'proved' | 'proved-vacuously' | 'not-proved' | 'not-reached';
  /**
   * What was removed at the end, and by what.
   *
   * `performed` is true only when the disposable PROJECT was removed AND every artifact this command wrote —
   * the workspace holding a copy of the keystore and every secret file, both overrides, and the marker — was
   * removed with it. `artifacts` says which of those happened, because "cleanup performed" over a directory
   * still holding key material was the least honest word in the previous report.
   */
  readonly cleanup: {
    readonly performed: boolean;
    readonly by: string;
    readonly plan: readonly string[];
    readonly artifacts: 'not-attempted' | 'removed' | 'incomplete';
    /** The fixed names that were removed. This command's own, never anything else's. */
    readonly removed: readonly string[];
  };
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
  const seen: RehearsalObservations = {
    composeModel: { base: null, current: null, candidate: null },
    workspace: null,
    importApplyMutations: null,
    importReplayMutations: null,
  };
  let failed = false;

  const plan = planRehearsal(resolved);
  for (const step of plan) {
    if (failed) break;
    let detail: string | null = null;
    for (const action of step.actions) {
      detail = performAction(action, resolved, deps, seen, (role, verdict) => {
        const slot = step.id.startsWith('rollback') ? 'rollback' : role;
        versions[slot] = verdict;
      });
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
  const cleanupPlan = [`${cleanupCommand.program} ${cleanupCommand.args.join(' ')}`, ...artifactCleanupPlan()];
  let cleanupPerformed = false;
  let artifacts: RehearsalReport['cleanup']['artifacts'] = 'not-attempted';
  let removed: readonly string[] = [];
  if (failed) {
    notes.push('A step did not hold, so the disposable project was LEFT IN PLACE for diagnosis. Nothing was '
      + 'removed, and the root still carries this rehearsal\'s marker, which names the project and the exact '
      + 'plan. When you have finished looking, run the one command in the cleanup plan — it addresses only '
      + 'that marked project.');
    notes.push(RESTORE_WORKSPACE_WARNING);
  } else if (request.cleanup === true) {
    // MARKER-BOUND. Cleanup is refused unless the root still says it belongs to this exact rehearsal, so a
    // cleanup cannot reach a project this run did not create.
    const marker = readRehearsalMarker(resolved.disposableRoot);
    if (marker === null || marker.projectName !== resolved.projectName || marker.planDigest !== resolved.planDigest) {
      notes.push('The disposable root no longer carries this rehearsal\'s marker, so nothing was removed. '
        + 'Removing resources by anything other than that marker is how a cleanup reaches a real installation.');
      notes.push(RESTORE_WORKSPACE_WARNING);
    } else {
      const outcome = runGuarded(deps.runner, deps.ledger, cleanupCommand);
      if (outcome.status !== 0) {
        notes.push('The disposable project could not be removed. It carries this rehearsal\'s marker and nothing '
          + 'else does; remove it with the command in the cleanup plan.');
        notes.push(RESTORE_WORKSPACE_WARNING);
      } else {
        // ---- AND THE FILES, WHICH THE PROJECT REMOVAL DOES NOT TOUCH -------------------------------------
        //
        // THE DEFECT THIS CLOSES. `cleanup.performed: true` used to mean "compose down ran", and left behind a
        // private workspace holding a COPY OF THE KEYSTORE AND EVERY SECRET FILE, both overrides and the
        // marker. An operator who read that word and moved on had key material sitting in a scratch directory
        // they believed had been cleaned up.
        const outcomeOfArtifacts = removeRehearsalArtifacts(resolved, seen.workspace);
        removed = outcomeOfArtifacts.removed;
        artifacts = outcomeOfArtifacts.complete ? 'removed' : 'incomplete';
        cleanupPerformed = outcomeOfArtifacts.complete;
        if (!outcomeOfArtifacts.complete) {
          notes.push('The disposable PROJECT was removed and this rehearsal\'s own files were not, so cleanup is '
            + 'reported as incomplete rather than done: ' + outcomeOfArtifacts.reason);
          notes.push(RESTORE_WORKSPACE_WARNING);
        }
      }
    }
  } else {
    notes.push('The disposable project was left in place. Pass --cleanup to remove it, or run the one command in '
      + 'the cleanup plan yourself.');
    notes.push(RESTORE_WORKSPACE_WARNING);
  }

  // ---- what the import actually proved ------------------------------------------------------------------
  const idempotence = importVerdict(seen);
  if (idempotence === 'proved-vacuously') {
    notes.push('The representative import created and updated nothing on its first apply, so the replay had '
      + 'nothing to repeat. That is a true idempotence result and a weak one: give a snapshot holding at least '
      + 'one record this installation does not already have, and the replay proves something.');
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
    restored: seen.workspace === null ? {} : seen.workspace.components,
    steps,
    composeModel: { ...seen.composeModel },
    importIdempotence: idempotence,
    cleanup: {
      performed: cleanupPerformed,
      by: `compose project ${resolved.projectName}`,
      plan: cleanupPlan,
      artifacts,
      removed,
    },
    // NOT A LITERAL ANY MORE. This is emitted only on a path where the fully resolved configuration of every
    // stack that could have been started was obtained from Compose itself and validated: no bind, secret or
    // config source outside the marker-owned root, nothing external, no container name, host network,
    // privileged flag, device, socket or published port, and every writable target inside the workspace this
    // rehearsal prepared. A run that could not establish that stopped at its first step.
    touchedProduction: false,
    network: 'none',
    mediaOperations: 'none',
    notes,
  };
}

/** What one run observed, gathered as it goes so the report is assembled from facts rather than from hope. */
interface RehearsalObservations {
  composeModel: { base: string | null; current: string | null; candidate: string | null };
  workspace: RestoreWorkspace | null;
  /** `created + updated` on the first apply, and on the replay. `null` until that step has run. */
  importApplyMutations: number | null;
  importReplayMutations: number | null;
}

const RESTORE_WORKSPACE_WARNING =
  'The restore workspace in the disposable root holds a COPY OF YOUR CUSTODIAN KEYSTORE AND EVERY SECRET FILE. '
  + 'Treat that directory the way you treat the originals, and remove it when you have finished looking.';

function importVerdict(seen: RehearsalObservations): RehearsalReport['importIdempotence'] {
  if (seen.importApplyMutations === null || seen.importReplayMutations === null) return 'not-reached';
  if (seen.importReplayMutations !== 0) return 'not-proved';
  return seen.importApplyMutations > 0 ? 'proved' : 'proved-vacuously';
}

/** The removals a cleanup would perform, as fixed names. Printed in the plan; never interpolated with a path. */
function artifactCleanupPlan(): readonly string[] {
  return [...rehearsalOwnedArtifacts(), REHEARSAL_MARKER_NAME]
    .map((name) => `remove ${name} from the disposable root, after verifying it is the one this command wrote`);
}

/**
 * Remove the fixed artifacts this rehearsal wrote, and nothing else.
 *
 * FOUR RULES, AND EACH IS A REFUSAL RATHER THAN A BEST EFFORT.
 *
 *   1. ONLY FIXED NAMES. The list is `rehearsalOwnedArtifacts()` plus the marker — names this command chose,
 *      not names derived from anything read at run time. The operator's Compose definition is not on it and
 *      is never removed.
 *   2. VERIFIED BEFORE REMOVED. Each override is digested and compared against the bytes this run wrote; each
 *      restored component is re-digested and compared against what was recorded when it was copied. A file
 *      somebody replaced is left alone and makes the cleanup incomplete.
 *   3. NEVER THROUGH A LINK. `removeOwnTreeNoFollow` walks the tree first and refuses the whole removal if it
 *      holds a symbolic link, a device, a socket or a pipe, and then unlinks entries as themselves.
 *   4. THE MARKER LAST. While it is there the root is still bound to this rehearsal, so an interruption
 *      part-way through leaves a root that the next run refuses rather than one it would claim over.
 */
function removeRehearsalArtifacts(resolved: ResolvedRehearsal, workspace: RestoreWorkspace | null): {
  readonly complete: boolean; readonly removed: readonly string[]; readonly reason: string;
} {
  const removed: string[] = [];
  try {
    if (workspace === null) {
      return { complete: false, removed, reason: 'this run did not record what it restored, so nothing was removed.' };
    }
    // THE WORKSPACE, RE-VERIFIED. Every component is digested again and must be the copy this run made.
    for (const [id, digest] of Object.entries(workspace.components)) {
      const artifact = COMPONENT_ARTIFACT_NAMES[id as BackupComponentId];
      const path = join(workspace.path, artifact);
      const actual = id === 'database'
        ? digestFileNoFollow(path, 'restored database dump').digest
        : digestOfDirectory(path);
      if (actual !== digest) {
        return {
          complete: false,
          removed,
          reason: 'a restored component in the workspace is not the copy this run made, so the workspace was '
            + 'left in place.',
        };
      }
    }
    if (digestFileNoFollow(join(workspace.path, REHEARSAL_IMPORT_NAME), 'representative import snapshot').digest
      !== workspace.importDigest) {
      return {
        complete: false,
        removed,
        reason: 'the representative import copy is not the one this run made, so the workspace was left in place.',
      };
    }
    removeOwnTreeNoFollow(workspace.path, 'rehearsal restore workspace');
    removed.push(REHEARSAL_RESTORE_DIRNAME);

    for (const role of ['current', 'candidate'] as const) {
      const name = REHEARSAL_OVERRIDE_NAMES[role];
      const expected = createHash('sha256').update(renderRehearsalOverride(resolved, role), 'utf8').digest('hex');
      removeOwnFileNoFollow(join(resolved.disposableRoot, name), expected, `${role} image override`);
      removed.push(name);
    }

    // THE MARKER LAST, and only after re-reading it: the root stays bound to this rehearsal until the very
    // last thing this command owns has gone.
    const marker = readRehearsalMarker(resolved.disposableRoot);
    if (marker === null || marker.projectName !== resolved.projectName || marker.planDigest !== resolved.planDigest) {
      return { complete: false, removed, reason: 'the marker changed while the cleanup was running.' };
    }
    const markerBytes = `${JSON.stringify({
      report: REHEARSAL_REPORT, version: REHEARSAL_VERSION,
      projectName: resolved.projectName, planDigest: resolved.planDigest,
    }, null, 2)}\n`;
    removeOwnFileNoFollow(join(resolved.disposableRoot, REHEARSAL_MARKER_NAME),
      createHash('sha256').update(markerBytes, 'utf8').digest('hex'), 'rehearsal marker');
    removed.push(REHEARSAL_MARKER_NAME);
    return { complete: true, removed, reason: '' };
  } catch (err) {
    return {
      complete: false,
      removed,
      // This product's own closed sentence, or a fixed one. Never a runtime message and never a path.
      reason: err instanceof MaintenanceRefused ? err.message : 'an artifact could not be removed.',
    };
  }
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
  seen: RehearsalObservations,
  recordVersion: (role: RehearsalImageRole, verdict: VersionVerdict) => void,
): string | null {
  if (action.kind === 'prepare-workspace') {
    try {
      // IMMEDIATELY BEFORE THE CLAIM, which is the last moment before this command creates anything: the
      // definition, the snapshot and the set are read again and must still be what the confirmed plan bound.
      reverifyRehearsalInputs(resolved);
      claimDisposableRoot(resolved);
      seen.workspace = prepareRestoreWorkspace(resolved);
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
  // ONE BOUND, BEFORE ANY OF THE PARSERS BELOW SEE IT. A container that printed more than this decides nothing
  // about how much memory this process uses or how long a pattern takes to match.
  if (outcome.stdout.length > MAX_ASSERTION_STDOUT_BYTES) {
    return 'the step printed more output than this command will read as evidence';
  }
  // EVERY SUCCESSFUL ASSERTION REQUIRES A ZERO STATUS, AND NO ASSERTION EVER PASSES ON A BODY ALONE.
  //
  // THE DEFECT THIS CLOSES. `doctor-no-fail` and `schema-version` used to accept a MATCHING BODY behind a
  // NON-ZERO exit — they refused only when a failed process had ALSO printed nothing. A process that failed
  // and printed a healthy-looking report is precisely the case those two checks exist for, and both passed it.
  //
  // The two of them read the body even on a failure, because "the doctor reported FAIL" and "the database is
  // at another schema version" are the closed sentences an operator can act on and the shipped commands exit
  // non-zero when they are true. What they may never do is CONCLUDE SUCCESS with a non-zero status: a healthy
  // body behind a failed process is a disagreement, and a disagreement is a failure of its own.
  if (outcome.status !== 0 && action.assertion.kind !== 'doctor-no-fail' && action.assertion.kind !== 'schema-version') {
    return statusFailure(action.assertion);
  }

  switch (action.assertion.kind) {
    case 'exit-zero':
      return null;
    case 'compose-model': {
      try {
        const model = parseResolvedComposeModel(outcome.stdout, 'resolved disposable stack');
        const workspace = seen.workspace === null ? null : seen.workspace.path;
        const role = action.assertion.role;
        validateResolvedCompose(model, {
          projectName: resolved.projectName,
          disposableRoot: resolved.disposableRoot,
          workspace,
          // THE BASE DEFINITION IS NOT PINNED, because nothing has pinned it yet: it is checked for being
          // disposable at all. Each override is then checked for having pinned EVERY product service.
          pinnedImages: role === null ? null : pinnedImagesFor(resolved, role),
          wiring: requiredRehearsalWiring(),
          requirePostgresHealthcheck: true,
        });
        seen.composeModel[role === null ? 'base' : role] = resolvedComposeDigest(model);
        return null;
      } catch (err) {
        return err instanceof MaintenanceRefused ? err.message : 'the disposable stack could not be resolved';
      }
    }
    case 'import-report': {
      const report = readImportReport(outcome.stdout);
      if (report === null) return 'the import did not answer in the shape this build understands';
      if (!report.ok) return 'the import reported that it did not complete';
      if (report.failed !== 0 || report.notAttempted !== 0) return 'the import left records unwritten';
      if (action.assertion.phase === 'preview') {
        // A PREVIEW MUST BE A PREVIEW. `mode` is the shipped report's own word for it, and a run that wrote
        // while claiming to preview would say `apply` here.
        return report.mode === 'preview' ? null : 'the import preview reported that it had applied';
      }
      if (report.mode !== 'apply') return 'the import apply reported that it had only previewed';
      const mutations = report.created + report.updated;
      if (action.assertion.phase === 'apply') {
        if (report.total < 1) return 'the representative import snapshot holds no records, so it proves nothing';
        seen.importApplyMutations = mutations;
        return null;
      }
      seen.importReplayMutations = mutations;
      // THE WHOLE OF IDEMPOTENCE, AND THE DEFECT THIS CLOSES. Two exit-zero applies prove an import ran twice.
      // A second run that created every record again would exit zero, and would have doubled the catalog.
      return mutations === 0 ? null : 'the replayed import wrote records a second time, so it is not idempotent';
    }
    case 'doctor-no-fail': {
      const parsed = parseDoctorJson(outcome.stdout);
      if (parsed === null) {
        return outcome.status === 0
          ? 'the doctor did not answer in the shape this build understands'
          : 'the doctor did not succeed, whatever it printed';
      }
      const state = classifyDoctor(parsed);
      // THE STATE, WHICH IS ONE OF FOUR WORDS. Never a `detail`: a doctor detail is written for a person at a
      // terminal and can name a path, a uid or a connection.
      if (state === 'FAIL' || state === 'INVALID') return `the doctor reported ${state}`;
      // A HEALTHY BODY BEHIND A FAILED PROCESS. The shipped doctor exits zero exactly when it reports itself
      // ok, so this is a contradiction — and a rehearsal that accepted it would be accepting a report from a
      // command that did not finish.
      return outcome.status === 0
        ? null
        : 'the doctor printed a healthy report and did not succeed, which do not agree';
    }
    case 'product-version': {
      const { role } = action.assertion;
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
      const read = readSchemaVersions(outcome.stdout);
      if (read === null) return 'the schema version could not be read';
      if (read.build !== action.assertion.expectedBuild) return 'the running build expects another schema version';
      if (read.database !== action.assertion.expectedDatabase) return 'the database is at another schema version';
      // The two numbers are the ones the plan declared AND the command that printed them failed. `ops:version`
      // exits non-zero when the build and the database disagree, so a matching line behind a failure is a
      // contradiction — and the whole point of this check is that it is never satisfied by a body alone.
      return outcome.status === 0
        ? null
        : 'the schema versions printed are the declared ones and the command did not succeed, which do not agree';
    }
    default:
      return 'the step could not be run';
  }
}

/** The closed sentence for "this step's process did not succeed", named for what the step was asking. */
function statusFailure(assertion: RehearsalAssertion): string {
  switch (assertion.kind) {
    case 'doctor-no-fail': return 'the doctor did not succeed, whatever it printed';
    case 'product-version': return 'the product version could not be read';
    case 'schema-version': return 'the schema version could not be read';
    case 'compose-model': return 'the disposable stack could not be resolved';
    case 'import-report': return 'the representative import did not succeed, whatever it printed';
    default: return 'the command did not succeed';
  }
}

/** Which reference each product service must be running on this leg. A closed list, never a probe. */
export function pinnedImagesFor(resolved: ResolvedRehearsal, role: RehearsalImageRole): Readonly<Record<string, string>> {
  const image = role === 'current' ? resolved.currentImage : resolved.candidateImage;
  const pinned: Record<string, string> = {};
  for (const service of REHEARSAL_PRODUCT_SERVICES) pinned[service] = image;
  return pinned;
}

/**
 * The shipped import report, read as the closed set of numbers this command needs.
 *
 * IT IS THE PRODUCT'S OWN CONTRACT, checked by name and shape rather than trusted: the report identifier and
 * the mode are compared exactly, and every count must be a non-negative whole number. A body that is JSON and
 * is not that report answers `null`, which is a failure and not a default.
 */
export function readImportReport(stdout: string): {
  readonly ok: boolean; readonly mode: string; readonly total: number;
  readonly created: number; readonly updated: number; readonly failed: number; readonly notAttempted: number;
} | null {
  if (stdout.length > MAX_ASSERTION_STDOUT_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const doc = parsed as Record<string, unknown>;
  if (doc.report !== 'phase-259-catalog-import') return null;
  if (typeof doc.ok !== 'boolean' || (doc.mode !== 'preview' && doc.mode !== 'apply')) return null;
  const counts: Record<string, number> = {};
  for (const key of ['total', 'created', 'updated', 'failed', 'notAttempted']) {
    const value = doc[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
    counts[key] = value;
  }
  return {
    ok: doc.ok,
    mode: doc.mode,
    total: counts.total!,
    created: counts.created!,
    updated: counts.updated!,
    failed: counts.failed!,
    notAttempted: counts.notAttempted!,
  };
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
  lines.push('  resolved stack digests:');
  for (const [what, digest] of Object.entries(report.composeModel)) {
    lines.push(`    ${what.padEnd(20)} ${digest === null ? 'not reached' : digest.slice(0, 16)}`);
  }
  lines.push(`  import idempotence ${report.importIdempotence}`);
  lines.push(`  touched production ${report.touchedProduction}`);
  lines.push(`  network            ${report.network}`);
  lines.push(`  media operations   ${report.mediaOperations}`);
  lines.push('  steps:');
  for (const entry of report.steps) {
    lines.push(`    ${entry.ok ? 'HELD' : 'FAIL'}  ${entry.leg.padEnd(8)} ${entry.id.padEnd(22)} ${entry.proves}`);
    if (!entry.ok) lines.push(`          -> ${entry.detail}`);
  }
  lines.push(`  cleanup            ${report.cleanup.performed ? 'removed' : 'not performed'} (${report.cleanup.by})`);
  lines.push(`  own artifacts      ${report.cleanup.artifacts}`
    + `${report.cleanup.removed.length === 0 ? '' : ` (${report.cleanup.removed.join(', ')})`}`);
  for (const command of report.cleanup.plan) lines.push(`    plan: ${command}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push(`  RESULT: ${report.ok ? 'OK' : 'INCOMPLETE'}`);
  return lines.join('\n');
}
