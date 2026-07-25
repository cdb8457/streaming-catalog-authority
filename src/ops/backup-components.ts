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
    backup: {
      posix: 'docker compose exec -T postgres pg_dump -U postgres catalog > ./catalog-backup.sql',
      windows: 'docker compose exec -T postgres pg_dump -U postgres catalog > .\\catalog-backup.sql',
    },
    restore: {
      posix: 'docker compose exec -T postgres psql -U postgres -d catalog < ./catalog-backup.sql',
      windows: 'docker compose exec -T postgres psql -U postgres -d catalog < .\\catalog-backup.sql',
    },
    caveat: 'Restore into an EMPTY database. Replaying a dump over a database that already has this schema '
      + 'produces conflicts, not a rollback. The supported sequence is to stop the stack, remove the database '
      + 'volume, start only PostgreSQL, and replay into the fresh one.',
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
    restore: {
      posix: 'docker compose cp ./keystore-backup/. app:/var/lib/catalog/keystore',
      windows: 'docker compose cp .\\keystore-backup\\. app:/var/lib/catalog/keystore',
    },
    caveat: 'It is key material: treat the copy the way you would treat a key. It is deliberately NOT in the '
      + 'database dump, so a dump is never also a key backup. On the Unraid launcher stack the keystore is a '
      + 'directory under your appdata folder and you copy it directly, with the stack stopped.',
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

export type BackupExclusionId = 'runtime-socket' | 'backup-destination';

/** Why a persistent mount is deliberately NOT part of a backup. Each one is a claim a reviewer can check. */
export const BACKUP_EXCLUSIONS: Readonly<Record<BackupExclusionId, string>> = {
  'runtime-socket': 'A socket directory, recreated when the service starts. Copying it restores nothing and '
    + 'restoring a stale socket into a running stack is worse than not having one.',
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
    if (typeof entry === 'string') { targets.push(parseMount(entry).target); continue; }
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
