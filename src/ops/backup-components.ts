import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { KEK_RING_DIRNAME, KEK_RING_FILENAME } from '../core/crypto/kek-ring.js';
import { parseMount, parseYaml, asMap, asList, type YamlMap, type YamlValue } from './minimal-yaml.js';

// Phase 256 — what a complete backup of this installation actually is.
//
// THE DEFECT. The first-run checklist's `back-up` step — the backup instruction an operator actually reads,
// because it is on the page in front of them — said: dump the database and copy `./secrets/`. That is not a
// complete backup. The custodian **keystore** holds the wrapped data-encryption keys, and it lives on its own
// volume precisely so that a database dump is not also a key backup. Restore the database and the secrets
// without it and you get a database that comes up, passes its checks, and cannot decrypt a single item.
//
// The lifecycle document knew: its Backup section says to back the keystore up separately. Its own Upgrade
// checklist, four paragraphs later, says "Database dump and ./secrets/". Two surfaces, three answers, and the
// one the operator sees was the one that was wrong.
//
// AND IN SIDECAR MODE IT IS SOMEWHERE ELSE. The Unraid launcher stack runs the custodian as a sidecar whose
// `SIDECAR_STATE_DIR` is a FileCustodian keystore under a different path. Same material, same consequence,
// second place to forget.
//
// WHY THIS IS A MODEL AND NOT PROSE. Prose is how the three surfaces disagreed. There is one list here, and
// the checklist step, the operator page, the support report and the lifecycle document all render from it.
//
// AND WHY COVERAGE IS ENFORCED AGAINST THE COMPOSE FILES. The defect was not "somebody wrote the wrong
// sentence". It was "a volume existed that nobody's backup instructions mentioned", and nothing could notice.
// `assertBackupCoverage` walks every mount in a shipped stack and refuses any container path that is neither
// claimed by a backup component nor explicitly excluded with a reason. A stack that gains persistent state
// and does not say what happens to it in a backup fails a test, which is the only way this stays true.
//
// NO HOST IDENTITY. Every command here is bundle-relative or expressed against a Compose service name. There
// is no absolute host path, no address, no library, no particular machine's layout — the same rule the
// checklist has always been held to, and asserted the same way.

export interface BackupCommands {
  /** Linux and macOS. */
  readonly posix: string;
  /** Windows PowerShell. */
  readonly windows: string;
}

export type BackupComponentId = 'database' | 'secrets' | 'keystore' | 'promotion-records';

/** In the order an operator should take them: the two that cannot be regenerated at all come first. */
export const BACKUP_COMPONENT_IDS: readonly BackupComponentId[] = [
  'database', 'keystore', 'secrets', 'promotion-records',
];

export interface BackupComponent {
  readonly id: BackupComponentId;
  readonly title: string;
  /** What the thing is, without naming any particular machine's path. */
  readonly what: string;
  /** What you have lost if this is not in your backup. The reason to bother, stated as a consequence. */
  readonly lostWithout: string;
  /**
   * Whether this can be obtained again from somewhere else if it is lost.
   *
   * Every component here is `false`. That is the finding: there is nothing in a complete backup of this
   * product that can be downloaded again, which is exactly why leaving one out is unrecoverable rather than
   * inconvenient. The field exists so that a component added later has to answer the question.
   */
  readonly regenerable: false;
  readonly backup: BackupCommands;
  readonly restore: BackupCommands;
  /** Anything true that the commands do not say. Never a reassurance. */
  readonly caveat: string;
}

const COMPONENTS: readonly BackupComponent[] = [
  {
    id: 'database',
    title: 'The database',
    what: 'Every item, event, publish record and the applied schema version, in PostgreSQL.',
    lostWithout: 'Everything this installation has ever recorded. There is no other copy of it anywhere.',
    regenerable: false,
    // `exec -T` runs inside the running postgres container and writes to a file next to the Compose project.
    // It connects over the container's local socket, so no password travels on a command line and none is
    // needed here.
    //
    // THE WINDOWS FORM GOES THROUGH `cmd /c`, AND THAT IS NOT DECORATION. Both halves were measured on
    // Windows PowerShell 5.1.26100 rather than recalled:
    //
    //   * `>` is `Out-File`, which RE-ENCODES a native command's output instead of passing bytes through. It
    //     wrote a UTF-8 byte-order mark (EF BB BF) ahead of the first character; other Windows PowerShell
    //     configurations write UTF-16LE instead. Either way the file is not what `pg_dump` emitted, and a
    //     dump that begins with a BOM is one `psql` refuses — silently produced, and not discovered until the
    //     day somebody needs the restore.
    //   * `<` does not exist. It is a RESERVED operator: `psql … < file.sql` fails to parse with "The '<'
    //     operator is reserved for future use." The restore command was not a command that might fail; it was
    //     one that could never run.
    //
    // `cmd /c` redirects byte-faithfully (verified: no BOM, no re-encoding) in one line, on a shell every
    // machine that can run Docker Desktop already has.
    backup: {
      posix: 'docker compose exec -T postgres pg_dump -U postgres catalog > ./catalog-backup.sql',
      windows: 'cmd /c "docker compose exec -T postgres pg_dump -U postgres catalog > catalog-backup.sql"',
    },
    restore: {
      posix: 'docker compose exec -T postgres psql -U postgres -d catalog < ./catalog-backup.sql',
      windows: 'cmd /c "docker compose exec -T postgres psql -U postgres -d catalog < catalog-backup.sql"',
    },
    caveat: 'Restore into an EMPTY database. Replaying a dump over a database that already has this schema '
      + 'produces conflicts, not a rollback. The supported sequence is to stop the stack, remove the database '
      + 'volume, start only PostgreSQL, and replay into the fresh one. On Windows the commands run through '
      + '`cmd /c` on purpose: PowerShell re-encodes `>` output rather than passing bytes through, so it would '
      + 'corrupt the dump without saying so, and it has no `<` operator at all.',
  },
  {
    id: 'keystore',
    title: 'The custodian keystore',
    // Both locations, because there are two and forgetting the second one has the same consequence as
    // forgetting the first.
    what: 'The wrapped data-encryption keys. On an ordinary or Arcane install this is the keystore volume; on '
      + 'the Unraid launcher stack the custodian runs as a sidecar and keeps the same material in its own '
      + 'state directory.',
    lostWithout: 'The database restores and NOTHING IN IT CAN BE DECRYPTED. The service will start, pass its '
      + 'checks and report itself healthy, because an unreadable item is indistinguishable from a correctly '
      + 'fail-closed one. This is the component that used to be missing from the instructions.',
    regenerable: false,
    // `docker compose cp` is identical on every platform and needs no knowledge of the generated volume name.
    backup: {
      posix: 'docker compose cp app:/var/lib/catalog/keystore ./keystore-backup',
      windows: 'docker compose cp app:/var/lib/catalog/keystore .\\keystore-backup',
    },
    // `stop`, NOT `down`. `docker compose down` REMOVES the containers, and `docker compose cp` needs one to
    // copy into — so "down, then cp" fails with "no container found" at the worst possible moment. `stop`
    // leaves the container in place and stopped, which is what a copy into its volume needs.
    restore: {
      posix: 'docker compose stop app && docker compose cp ./keystore-backup/. app:/var/lib/catalog/keystore '
        + '&& docker compose start app',
      windows: 'docker compose stop app; docker compose cp .\\keystore-backup\\. app:/var/lib/catalog/keystore; '
        + 'docker compose start app',
    },
    caveat: 'It is key material: treat the copy the way you would treat a key. It is deliberately NOT in the '
      + 'database dump, so a dump is never also a key backup. Both commands need the app container to EXIST: '
      + 'run `docker compose create app` first on a machine where the stack has never been started, and use '
      + '`docker compose stop app` rather than `docker compose down`, which removes the container the copy '
      + 'needs. On the Unraid launcher stack the keystore is a directory under your appdata folder and you '
      + 'copy it directly, with the stack stopped.',
  },
  {
    id: 'secrets',
    title: 'The secret files',
    what: 'The folder the setup script created: the KEK, the completion secret, the database credentials and '
      + 'your operator token, one file each.',
    lostWithout: 'The KEK unwraps nothing, so a restored keystore is inert; attested shred completion can '
      + 'never verify again; and PostgreSQL refuses the password its volume was initialised with.',
    regenerable: false,
    backup: {
      posix: 'cp -a ./secrets ./secrets-backup',
      windows: 'Copy-Item -Recurse -Force .\\secrets .\\secrets-backup',
    },
    restore: {
      posix: 'cp -a ./secrets-backup/. ./secrets/',
      windows: 'Copy-Item -Recurse -Force .\\secrets-backup\\* .\\secrets\\',
    },
    caveat: 'Re-running the setup script does NOT regenerate a secret that already exists, so it can never '
      + 'produce these again. Keep the copy somewhere you would keep a password.',
  },
  {
    id: 'promotion-records',
    title: 'The promotion record artifacts',
    what: 'Your own chain artifacts, in the folder mounted read-only into the container.',
    lostWithout: 'The evidence you loaded. This product never produced those files and cannot recreate them; '
      + 'it only reads them.',
    regenerable: false,
    backup: {
      posix: 'cp -a ./promotion-records ./promotion-records-backup',
      windows: 'Copy-Item -Recurse -Force .\\promotion-records .\\promotion-records-backup',
    },
    restore: {
      posix: 'cp -a ./promotion-records-backup/. ./promotion-records/',
      windows: 'Copy-Item -Recurse -Force .\\promotion-records-backup\\* .\\promotion-records\\',
    },
    caveat: 'Nothing is lost from this folder by an upgrade — the container cannot write to it. It is in the '
      + 'list because a disk failure does not care about that, and an empty folder is a valid state that '
      + 'looks identical to a lost one.',
  },
];

export function backupComponents(): readonly BackupComponent[] {
  return COMPONENTS;
}

export function backupComponent(id: BackupComponentId): BackupComponent {
  const found = COMPONENTS.find((component) => component.id === id);
  if (found === undefined) throw new BackupCoverageError(`no backup component ${id}`);
  return found;
}

/**
 * The sentence the checklist, the panel and the lifecycle document all lead with.
 *
 * Four things, named. The previous wording — "your secrets and your database" — was not merely incomplete,
 * it was a closed list, which is what stopped anybody looking for a third thing.
 */
// The wording avoids "download" on purpose. The Phase 147 boundary check asserts that word never appears in
// the served page, because this product downloads nothing — and a sentence about obtaining a Compose file
// again is not worth eroding a boundary check for.
export const BACKUP_SUMMARY =
  'A complete backup of this installation is four things: the database, the custodian keystore, the secret '
  + 'files and your promotion record artifacts. None of them can be obtained again from anywhere else. '
  + 'Leaving out the keystore is the one that fails quietly — the database restores and nothing in it can '
  + 'be decrypted.';

/**
 * The secret files a restore actually needs, and the ones it does not.
 *
 * REQUIRED is exactly the set every shipped stack declares as a Compose secret, and a test asserts that
 * equality against the four stacks rather than trusting this list — the same anti-drift rule the mount
 * coverage follows, for the same reason: a stack that starts requiring a seventh secret must not leave a
 * checker quietly approving backups that do not contain it.
 *
 * `app_password` is optional. The setup scripts generate it so a deployment can hold a real credential for
 * the least-privileged runtime role, but no stack mounts it and `ops:bootstrap` teaches the database from
 * `database_url`; a backup without it is not broken.
 *
 * AND "REQUIRED" HERE MEANS CATALOGUED, NOT UNCONDITIONAL. One entry — `custodian_root_key` — is required of
 * a given set only when that set's keystore actually holds a KEK ring. `requiredSecretFilesFor(ringPresent)`
 * is the predicate every caller should use; this array is what it filters.
 */
export const REQUIRED_SECRET_FILES: readonly string[] = [
  'admin_database_url',
  'completion_secret',
  'custodian_kek',
  // PHASE 282. The ROOT WRAPPING KEY that seals the sidecar-managed KEK ring.
  //
  // IT IS ON THIS LIST FOR THE SAME REASON THE KEK IS, AND MORE SO. A backup holding the ring and not the
  // root key is a backup of a sealed box with no key: the ring restores, nothing opens it, and every item
  // reads as unreadable — which is indistinguishable from a correct erasure, so nothing reports it.
  //
  // THIS LIST IS THE CATALOGUE, NOT THE PREDICATE. Read `requiredSecretFilesFor(ringPresent)` below for
  // whether a given set must hold this file: the requirement follows THE EVIDENCE IN THE SET — a keystore
  // carrying a ring — rather than the fact that the stack declares the secret.
  //
  // AN EARLIER VERSION OF THIS COMMENT SAID THE OPPOSITE, and said it for a reason that sounded right: a list
  // that depended on which state an installation was in would be a list nobody could check. What that
  // reasoning missed is that the state IS checkable, from the set itself, without asking the installation
  // anything — and that requiring the file unconditionally refused a complete backup to every released
  // v1.1.4 installation, the one population that most needs a rollback set. The conditional rule replaced it
  // (see `backupSetHasRing`), and the comment here outlived the design it described. Corrected in Phases
  // 329-336, when `deploy/local-runtime-setup.ps1` stopped creating this file on a platform that cannot
  // establish its ownership — which made an already-stale comment an actively misleading one.
  'custodian_root_key',
  'database_url',
  'operator_ui_token',
  'postgres_password',
];

export const OPTIONAL_SECRET_FILES: readonly string[] = ['app_password'];

/** The one secret whose necessity depends on what the keystore in the same set actually holds. */
export const ROOT_KEY_SECRET_NAME = 'custodian_root_key';

/** Where each component lands inside a set. Here rather than in the writer, because the readers need it too. */
export const COMPONENT_ARTIFACT_NAMES: Readonly<Record<BackupComponentId, string>> = Object.freeze({
  database: 'catalog-backup.sql',
  keystore: 'keystore-backup',
  secrets: 'secrets-backup',
  'promotion-records': 'promotion-records-backup',
});

/**
 * Does the keystore in this set hold a KEK ring?
 *
 * -----------------------------------------------------------------------------------------------------
 * WHY THIS QUESTION DECIDES WHETHER A ROOT WRAPPING KEY IS REQUIRED.
 * -----------------------------------------------------------------------------------------------------
 *
 * THE GAP THIS CLOSES, AND IT WAS A REAL ONE. `custodian_root_key` was on the required list from the moment
 * the stack DECLARED the root key, not from the moment an installation migrated onto a ring — deliberately,
 * so that the list did not depend on which state an installation was in. The consequence was not noticed
 * until an upgrade was rehearsed end to end: a released v1.1.4 installation has no ring and no root key, so
 * it could not take a complete backup AT ALL. The one population that most needs a rollback set — the one
 * about to be upgraded — was the one the backup command refused, and the only way past it was to invent a
 * file at that name, which is worse than the absence: a placeholder is not a key, and restoring one puts an
 * unusable artifact where the most sensitive file in the installation belongs.
 *
 * So the requirement follows the EVIDENCE IN THE SET, and the rule has three parts:
 *
 *   * NO RING, AND THE STATIC CUSTODY IS THERE — the root key may be absent. Nothing in that set is sealed
 *     under a root key, and `custodian_kek` (which stays required) is what opens it.
 *   * A RING — a valid root wrapping key IS required. A set holding a ring and no root is a sealed box with
 *     no key: it restores, nothing opens it, and every item reads as unreadable, which is indistinguishable
 *     from a correct erasure.
 *   * A ROOT KEY THAT IS PRESENT IS ALWAYS CARRIED AND ALWAYS CHECKED, ring or not. An installation that has
 *     one before it migrates gets it backed up, and a file at that name that is not a key is refused rather
 *     than counted.
 *
 * The probe is `lstat`, not a read: a link or a directory named `kek-ring.json` is not a ring, and this
 * decides a requirement rather than opening anything.
 */
export function backupSetHasRing(setDir: string): boolean {
  const ring = join(setDir, COMPONENT_ARTIFACT_NAMES.keystore, KEK_RING_DIRNAME, KEK_RING_FILENAME);
  const stats = lstatSync(ring, { throwIfNoEntry: false });
  return stats !== undefined && stats.isFile();
}

/** The secret files a set MUST hold, given whether its keystore carries a ring. */
export function requiredSecretFilesFor(ringPresent: boolean): readonly string[] {
  return ringPresent
    ? REQUIRED_SECRET_FILES
    : REQUIRED_SECRET_FILES.filter((name) => name !== ROOT_KEY_SECRET_NAME);
}

/**
 * Phase 257 — checking a backup before the day you need it.
 *
 * Rendered into the same panel as the components, because "how do I take one" and "is the one I took any
 * good" are the same question asked at two different times.
 *
 * `--no-deps` is load-bearing and is asserted by a test. Without it Compose starts PostgreSQL and the
 * migration first, which would make a check whose entire claim is "this needs no database" quietly need one.
 * `:ro` is deliberate too: a tool that inspects a backup has no business being able to change it.
 */
export const BACKUP_INSPECT_NOTE =
  'Check a backup before you need it. This reads the folder offline — no database, nothing fetched, no '
  + 'secret file opened — and reports which of the four components are there and which schema version the '
  + 'dump holds. A dump from before an upgrade is the only thing that can roll you back to the version '
  + 'before it, and this is how you find out which one you are holding.';

export const BACKUP_INSPECT_COMMANDS: BackupCommands = {
  posix: 'docker compose run --rm --no-deps -v "$PWD/backup:/backup:ro" '
    + '-e CATALOG_AUTHORITY_BACKUP_DIR=/backup app ops:backup-inspect',
  windows: 'docker compose run --rm --no-deps -v "${PWD}\\backup:/backup:ro" '
    + '-e CATALOG_AUTHORITY_BACKUP_DIR=/backup app ops:backup-inspect',
};

/**
 * Phases 297-304 — putting one back.
 *
 * WHY THIS IS HERE RATHER THAN ONLY IN A DOCUMENT. Every component above carries a `restore` command pair,
 * and those are what an operator runs BY HAND. They are correct and they are four separate operations in an
 * order that matters, performed by somebody who has just lost something — which is the same shape of problem
 * the backup side had before Phase 277, and it was solved the same way: one command, from this one model.
 *
 * IT RUNS ON THE HOST, and the commands above run against the stack. That is not an inconsistency: the
 * by-hand forms are what you use when you are working through it yourself, and this is what you use when you
 * want the ordering, the empty database, the cluster role, the safety set and the proof handled for you.
 *
 * NO ABSOLUTE PATH AND NO PARTICULAR MACHINE'S LAYOUT, the same rule every other command here is held to.
 */
export const COMPLETE_RESTORE_NOTE =
  'Put a verified backup set back. It takes a verified safety set of what it is about to destroy first, '
  + 'stages every component out of the set and re-checks it against the manifest, stops the stack and '
  + 'destroys its volumes so the dump replays into an EMPTY database, places all four components, starts '
  + 'everything again, and then proves the result — including that the installation can DECRYPT its own '
  + 'catalog, which is the one failure a restored installation reports as healthy. Start with --plan: it '
  + 'verifies the set, prints every step and a digest, and changes nothing. Running requires that digest '
  + 'back, and the digest is bound to the whole operation — this project, these directories, this set — so '
  + 'one read off another plan will not run this one. It CANNOT prove your Docker volumes are empty, because '
  + 'reading a volume means starting something: every restore needs either a safety set or an explicit '
  + 'acknowledgement that volumes of unknown contents are about to go. THERE ARE NO DOWN-MIGRATIONS, so a '
  + 'set older than the build you are running is refused rather than replayed: this is the rollback, and '
  + 'putting an old image back is not.';

export const COMPLETE_RESTORE_COMMANDS: BackupCommands = {
  posix: 'npm run ops:complete-restore -- --project /path/to/project --set set-name --custodian inline --plan',
  windows: 'npm run ops:complete-restore -- --project C:\\path\\to\\project --set set-name --custodian inline --plan',
};

/**
 * Phases 305-312 — removing one.
 *
 * WHY THIS BELONGS BESIDE THE OTHER TWO. This product takes a set on a schedule and takes another one every
 * time somebody restores, and until now it removed none of them: the operator instruction was to read a shell
 * listing and `rm -rf` a directory by hand. That instruction cannot tell a set that verifies from one that was
 * truncated, cannot tell the only restorable set from one of ten, cannot tell the pre-upgrade rollback point
 * from a routine nightly, takes no lock, and leaves half a set under a trusted name if it is interrupted.
 *
 * IT IS RENDERED FROM THIS MODEL for the same anti-drift reason the other two are: the panel, the lifecycle
 * document and the command cannot disagree about what retention is if there is one place that says it.
 */
export const BACKUP_RETENTION_NOTE =
  'Remove old backup sets. Start with --plan: it lists every directory in the destination, VERIFIES each one, '
  + 'and prints a decision and a reason for each — then a digest. Running requires that digest back, and it is '
  + 'recomputed under the maintenance lock over a fresh inventory, so a backup taken since you read the list '
  + 'refuses the run. Two sets are protected by rules no flag reaches past: the newest set this build could '
  + 'restore, and the newest set from BEFORE this build\'s schema, which is the only thing that can roll this '
  + 'installation back. A destination holding no restorable set at all refuses the whole run. Nothing is '
  + 'deleted in place: each set is renamed into a private quarantine directory and only then removed, so a set '
  + 'name here always holds a whole set or nothing, and an interrupted prune can be put back with --abandon. '
  + 'It issues no command of any kind, contacts nothing, and never removes a directory that is not a set this '
  + 'product took.';

export const BACKUP_RETENTION_COMMANDS: BackupCommands = {
  posix: 'npm run ops:backup-retention -- --project /path/to/project --keep-last 7 --plan',
  windows: 'npm run ops:backup-retention -- --project C:\\path\\to\\project --keep-last 7 --plan',
};

/**
 * Phases 313-320 — removing the ones a RESTORE made.
 *
 * WHY THIS IS A SECOND ENTRY AND NOT A SENTENCE IN THE ONE ABOVE. Retention removes the nightly sets at the
 * top level of a destination. It classifies every dot-prefixed name as an in-flight artifact and never
 * descends into one — which is what keeps it away from a backup staging tree, a restore in progress, a lock
 * directory and its own quarantine. A restore's safety set lives inside exactly such a name, so retention
 * never sees it, and those accumulate one per restore.
 *
 * An operator reading the panel has to be told BOTH: that the other command deliberately leaves these alone,
 * and that this one exists for them and proves ownership before it removes anything.
 */
export const SAFETY_SET_LIFECYCLE_NOTE =
  'Remove the safety sets a RESTORE left behind. Every ops:complete-restore takes a verified backup of the '
  + 'installation it is about to destroy and publishes it inside a directory that run claims exclusively, so '
  + 'these build up one per restore. ops:backup-retention never touches them, and that is deliberate: it '
  + 'treats every in-flight namespace as off limits, which is what keeps it away from a backup that is still '
  + 'being written. This command is the one that owns them. Start with --plan: it lists every claim, checks '
  + 'the ownership marker INSIDE each one, verifies the safety set it holds, and prints a decision and a '
  + 'reason for each — then a digest. Running requires that digest back, recomputed under the same locks over '
  + 'a fresh inventory. Two safety sets are protected by rules no flag reaches past: the newest one this '
  + 'build could restore, and the newest one from BEFORE this build\'s schema. The floor is counted across '
  + 'the WHOLE destination, so a destination whose only restorable set is a safety set keeps it. A claim that '
  + 'cannot prove a restore of this build created it — no marker, a foreign one, one from another schema, one '
  + 'that has been moved, or work still in flight inside it — is reported and never removed. Nothing is '
  + 'deleted in place: each claim is renamed into a private quarantine directory and only then removed, and '
  + 'an interrupted run can be put back with --abandon. It issues no command of any kind and contacts nothing.';

export const SAFETY_SET_LIFECYCLE_COMMANDS: BackupCommands = {
  posix: 'npm run ops:safety-set-lifecycle -- --project /path/to/project --keep-last 3 --plan',
  windows: 'npm run ops:safety-set-lifecycle -- --project C:\\path\\to\\project --keep-last 3 --plan',
};

// -----------------------------------------------------------------------------------------------------------
// Coverage against the shipped stacks
// -----------------------------------------------------------------------------------------------------------

export class BackupCoverageError extends Error {
  readonly code = 'BACKUP_COVERAGE_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'BackupCoverageError';
  }
}

export type BackupExclusionId = 'runtime-socket' | 'backup-destination' | 'operator-supplied-input';

/** Why a persistent mount is deliberately NOT part of a backup. Each one is a claim a reviewer can check. */
export const BACKUP_EXCLUSIONS: Readonly<Record<BackupExclusionId, string>> = {
  'runtime-socket': 'A socket directory, recreated when the service starts. Copying it restores nothing and '
    + 'restoring a stale socket into a running stack is worse than not having one.',
  'operator-supplied-input': 'Your own catalog snapshot files, mounted READ-ONLY so the container cannot change '
    + 'them. They are an INPUT you already hold a copy of, and what they produced is in the database, which the '
    + 'database component backs up. Backing up a folder this stack cannot write would back up your own files to '
    + 'you.',
  'backup-destination': 'This is where backups are written to. It is an output of a backup, not state that a '
    + 'backup has to capture.',
};

export type MountCoverage =
  | { readonly kind: 'component'; readonly component: BackupComponentId }
  | { readonly kind: 'excluded'; readonly exclusion: BackupExclusionId };

/**
 * Container paths this project mounts persistent state at, and what a backup does about each.
 *
 * Keyed by the CONTAINER path, never the host path: the host side is `${VAR:-default}` in three of the four
 * stacks and is a different string on every machine, while the container side is fixed by this project.
 */
const CONTAINER_PATH_COVERAGE: Readonly<Record<string, MountCoverage>> = {
  // The dump is the backup artifact, not a copy of this directory. Copying a live PostgreSQL data directory
  // produces something that may or may not start; the component says so.
  '/var/lib/postgresql/data': { kind: 'component', component: 'database' },
  '/var/lib/catalog/keystore': { kind: 'component', component: 'keystore' },
  // Same material, sidecar mode. Mapped to the same component deliberately: an operator has one thing to
  // remember, and the component text names both places.
  '/var/lib/catalog-sidecar/state': { kind: 'component', component: 'keystore' },
  '/var/lib/catalog/promotion-records': { kind: 'component', component: 'promotion-records' },
  // Phase 259. Read-only, operator-owned, and not state this stack creates — see the exclusion text.
  '/var/lib/catalog/import': { kind: 'excluded', exclusion: 'operator-supplied-input' },
  // Phase 282/284. The root wrapping key is bind-mounted rather than delivered as a Compose secret, because
  // outside Swarm a `file:` secret IS a bind mount and `uid`/`gid`/`mode` are ignored — so the only way to
  // give the sidecar an owner-only file is to mount one. It is the secrets component either way.
  '/run/catalog-custody': { kind: 'component', component: 'secrets' },
  '/run/catalog-sidecar': { kind: 'excluded', exclusion: 'runtime-socket' },
  '/backups': { kind: 'excluded', exclusion: 'backup-destination' },
};

/**
 * What a backup does about one mount target, or `null` if nothing does.
 *
 * `null` is the failure this module exists to produce: a persistent path nobody has decided about. It is
 * never a default of "probably fine".
 */
export function coverageForTarget(target: string): MountCoverage | null {
  for (const candidate of [target, stripHostVariablePrefix(target)]) {
    const exact = CONTAINER_PATH_COVERAGE[candidate];
    if (exact !== undefined) return exact;
    // Docker secrets, and the one stack that bind-mounts a secret file at its own host path. Anything under a
    // `secrets` directory is the secrets component; there is no other kind of thing kept there.
    if (candidate.startsWith('/run/secrets/') || /(?:^|\/)secrets(?:\/|$)/.test(candidate)) {
      return { kind: 'component', component: 'secrets' };
    }
    // Phase 284. The custody directory holds the root wrapping key, bind-mounted rather than delivered as a
    // Compose secret — outside Swarm a `file:` secret IS a bind mount and uid/gid/mode are ignored, so a
    // bind is the only way to give the sidecar a file whose ownership it can rely on. It is the secrets
    // component wherever it is mounted.
    if (candidate === '/run/catalog-custody' || candidate.startsWith('/run/catalog-custody/')) {
      return { kind: 'component', component: 'secrets' };
    }
  }
  return null;
}

/**
 * Two stacks mount a directory at its own HOST path inside the container, so that a person can pass a
 * host-shaped path to a command running in it:
 *
 *     ${CATALOG_AUTHORITY_APPDATA_DIR:-/…}/backups:${CATALOG_AUTHORITY_APPDATA_DIR:-/…}/backups
 *
 * The target is then the same place as the plain `/backups` mount beside it, written with the host variable
 * in front. Stripping one leading `${…}` expansion is what makes the two spellings answer identically —
 * without it, a coverage decision would depend on which of two equivalent notations a stack happened to use.
 *
 * ONE leading expansion only, and only at the start. This is a normalisation, not a search: a target that
 * carries a variable in the middle is a target nobody has decided about, and it should stay that way.
 */
export function stripHostVariablePrefix(target: string): string {
  return target.replace(/^\$\{[^}]*\}/, '');
}

export interface CoverageFinding {
  readonly service: string;
  readonly target: string;
}

export interface CoverageReport {
  readonly stack: string;
  /** Every mount that is covered, with what covers it. */
  readonly covered: readonly { readonly service: string; readonly target: string; readonly coverage: MountCoverage }[];
  /** Mounts nothing has decided about. Non-empty means the stack is not describable as a backup. */
  readonly uncovered: readonly CoverageFinding[];
  /** Which backup components this stack actually needs. */
  readonly components: readonly BackupComponentId[];
}

/**
 * Walk a Compose stack and report what a backup does about every mount in it.
 *
 * `tmpfs` is not examined: it is memory and is gone on stop by definition, which is the one case where "not
 * backed up" needs no argument. Long-syntax mounts are read too — a stack that switched notation must not
 * silently stop being checked.
 */
export function reportBackupCoverage(stackName: string, composeText: string): CoverageReport {
  const doc = parseYaml(composeText);
  const services = asMap(doc.services ?? null, `${stackName} services`);
  const covered: { service: string; target: string; coverage: MountCoverage }[] = [];
  const uncovered: CoverageFinding[] = [];
  const components = new Set<BackupComponentId>();

  for (const [serviceName, raw] of Object.entries(services)) {
    const svc = asMap(raw, `${stackName} service ${serviceName}`);
    for (const target of mountTargets(svc, `${stackName} service ${serviceName}`)) {
      const coverage = coverageForTarget(target);
      if (coverage === null) { uncovered.push({ service: serviceName, target }); continue; }
      covered.push({ service: serviceName, target, coverage });
      if (coverage.kind === 'component') components.add(coverage.component);
    }
    // Declared Compose secrets arrive at /run/secrets/<name>; the mount list does not mention them.
    if (svc.secrets !== undefined) {
      for (const name of secretNames(svc.secrets, `${stackName} service ${serviceName}`)) {
        covered.push({ service: serviceName, target: `/run/secrets/${name}`, coverage: { kind: 'component', component: 'secrets' } });
        components.add('secrets');
      }
    }
  }

  return { stack: stackName, covered, uncovered, components: [...components] };
}

/** The gate. Throws naming every path nobody decided about, so one run reports all of them. */
export function assertBackupCoverage(stackName: string, composeText: string): CoverageReport {
  const report = reportBackupCoverage(stackName, composeText);
  if (report.uncovered.length > 0) {
    const list = report.uncovered.map((finding) => `${finding.service} -> ${finding.target}`).join(', ');
    throw new BackupCoverageError(
      `${stackName} mounts persistent state that no backup component claims and no exclusion explains: ${list}. `
      + 'Add it to CONTAINER_PATH_COVERAGE with a component, or exclude it with a stated reason.',
    );
  }
  return report;
}

function mountTargets(svc: YamlMap, what: string): readonly string[] {
  if (svc.volumes === undefined) return [];
  const targets: string[] = [];
  for (const entry of asList(svc.volumes, `${what} volumes`)) {
    if (typeof entry === 'string') {
      // `- /var/lib/x` with no colon is an ANONYMOUS volume: the whole string is the container path, and
      // there is no host side. It is still persistent state, so it has to reach the coverage decision — and
      // letting the mount parser throw here would replace a guided refusal with a parse error.
      targets.push(entry.includes(':') ? parseMount(entry).target : entry);
      continue;
    }
    // Long syntax: { type, source, target, read_only }.
    const map = asMap(entry, `${what} volume entry`);
    const target = map.target;
    if (typeof target !== 'string') throw new BackupCoverageError(`${what} has a mount with no string target`);
    targets.push(target);
  }
  return targets;
}

function secretNames(value: YamlValue, what: string): readonly string[] {
  return asList(value, `${what} secrets`).map((entry) => {
    if (typeof entry === 'string') return entry;
    const map = asMap(entry, `${what} secret entry`);
    const source = map.source;
    if (typeof source !== 'string') throw new BackupCoverageError(`${what} has a secret with no source`);
    return source;
  });
}
