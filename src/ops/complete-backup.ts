import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MIGRATION_VERSION } from '../db/schema-version.js';
import { BACKUP_COMPONENT_IDS, REQUIRED_SECRET_FILES, type BackupComponentId } from './backup-components.js';
import {
  CommandLedger,
  MaintenanceRefused,
  assertPlainTree,
  assertUsableName,
  acquireMaintenanceLock,
  createPrivateDirectory,
  publishDirectory,
  resolveInsideRoot,
  resolveMaintenanceRoot,
  runGuarded,
  stagingSuffix,
  writePrivateFile,
  type CommandRunner,
  type MaintenanceCommand,
} from './maintenance-safety.js';

// Phase 277 — taking the backup the product has always described, without describing it a second time.
//
// WHAT WAS MISSING. Phase 256 established what a complete backup IS — four components, none of them
// obtainable again — and Phase 257 built an offline inspector for one. Between them there was still only
// prose: an operator read four commands off a page and ran them by hand, in an order that matters, with a
// quiescence step that is easy to skip and invisible when you do. `ops:backup` exists and is a DIFFERENT
// thing: the Phase 3 ciphertext-only database artifact, which is one component of four.
//
// SO THIS COMPOSES, IT DOES NOT REDEFINE. The component list is `backup-components.ts`'s. The secret file
// names are its `REQUIRED_SECRET_FILES`. The verification afterwards is Phase 257's `inspectBackupDirectory`,
// run through the shipped offline inspector. There is no second answer to "what is a complete backup" in this
// file, and a component added to the model appears here without being retyped.
//
// -----------------------------------------------------------------------------------------------------
// THE DATABASE AND THE KEYSTORE MUST COME FROM THE SAME MOMENT.
// -----------------------------------------------------------------------------------------------------
//
// This is the property the whole command is built around. A dump taken while the app was writing, and a
// keystore copied a few seconds later, produce a backup that restores into an installation which cannot read
// some of its own rows — and which reports itself healthy, because a fail-closed unreadable item looks
// exactly like a correctly erased one. So every writer is STOPPED first, both components are taken while
// nothing can write, and the writers are started again through a `finally` that runs on every path out,
// including a refusal, a thrown error and a failed step. A backup that leaves the stack down is a backup that
// causes the outage it was insurance against.
//
// PostgreSQL itself stays UP. It is the thing being dumped; stopping it would mean dumping nothing. What is
// stopped is everything that WRITES: the app, and the custodian sidecar when the topology has one.
//
// -----------------------------------------------------------------------------------------------------
// TOPOLOGY IS DECLARED, NEVER GUESSED.
// -----------------------------------------------------------------------------------------------------
//
// The keystore lives in one of two places depending on how the operator deployed: inside the app container
// (inline `FileCustodian`) or in a sidecar's own state directory. Guessing between them is how a backup ends
// up with an empty keystore directory and a green result. `--custodian inline` copies from the app container;
// `--custodian sidecar --sidecar-state <relative path>` copies a directory the operator names, inside the
// project root, checked. There is no default and no probe: an unstated topology is a refusal.
//
// NO MEDIA PATH IS ACCEPTED OR INSPECTED. Nothing here takes a library path, and `maintenance-safety.ts`
// refuses any argument that looks like one. The import folder is deliberately NOT a component — Phase 256
// excludes it as operator-supplied input, and this command honours that exclusion rather than re-deciding it.

export const COMPLETE_BACKUP_REPORT = 'phase-277-complete-backup';
export const COMPLETE_BACKUP_VERSION = 1;

/** The file the set carries describing itself. Structural metadata and digests; never content. */
export const BACKUP_MANIFEST_NAME = 'catalog-backup-manifest.json';
export const BACKUP_MANIFEST_VERSION = 1;

/** What each component is called inside a published set. Fixed, so the inspector and a restore both know. */
export const COMPONENT_ARTIFACT_NAMES: Readonly<Record<BackupComponentId, string>> = Object.freeze({
  database: 'catalog-backup.sql',
  keystore: 'keystore-backup',
  secrets: 'secrets-backup',
  'promotion-records': 'promotion-records-backup',
});

export type CustodianTopology = 'inline' | 'sidecar';

/** Services that must not be writing while the database and the keystore are taken. */
export const QUIESCED_SERVICES: Readonly<Record<CustodianTopology, readonly string[]>> = Object.freeze({
  inline: Object.freeze(['app']),
  sidecar: Object.freeze(['app', 'custodian']),
});

export interface CompleteBackupRequest {
  /** The Compose project directory, absolute. Resolved and proved to be a real, contained, non-broad root. */
  readonly projectRoot: string;
  /** Where sets are written, relative to the project root. Created private if it does not exist. */
  readonly destination: string;
  /** The name of THIS set, inside the destination. Refused if it already exists. */
  readonly setName: string;
  readonly custodian: CustodianTopology;
  /**
   * The sidecar's state directory, relative to the project root. REQUIRED in sidecar mode and refused in
   * inline mode: a path that is ignored is a path somebody will believe was used.
   */
  readonly sidecarState?: string;
  /** The promotion-records directory, relative to the project root. Absent means the installation has none. */
  readonly promotionRecords?: string;
  /** The secrets directory, relative to the project root. */
  readonly secrets: string;
}

export interface BackupComponentResult {
  readonly id: BackupComponentId;
  /** The name inside the set. A base name, never a path. */
  readonly artifact: string;
  readonly present: boolean;
  readonly bytes: number;
  readonly entries: number;
  /** sha256 over the component's bytes, or over a canonical listing for a directory. Names no content. */
  readonly digest: string;
}

export interface CompleteBackupReport {
  readonly report: typeof COMPLETE_BACKUP_REPORT;
  readonly version: typeof COMPLETE_BACKUP_VERSION;
  readonly ok: boolean;
  /** The set's own name. The operator chose it; it is not a path. */
  readonly setName: string;
  readonly custodian: CustodianTopology;
  readonly components: readonly BackupComponentResult[];
  /** Services stopped for the consistent window, and whether they were started again. */
  readonly quiesced: readonly string[];
  readonly restarted: boolean;
  readonly schemaVersion: number;
  /** A digest over the manifest, so two reports of one set are comparable without reading it. */
  readonly manifestDigest: string;
  readonly network: 'none';
  readonly mediaAccess: 'none';
  readonly notes: readonly string[];
}

export interface CompleteBackupDeps {
  readonly runner: CommandRunner;
  readonly ledger: CommandLedger;
  /** Injected so a suite can produce a set with a fixed timestamp. Never used for a name or a decision. */
  readonly now?: () => Date;
}

/**
 * Validate a request into resolved, proved paths.
 *
 * SEPARATE FROM RUNNING IT, so a suite — and `--plan` — can see exactly what would happen without a service
 * being stopped. Every refusal in this function happens before anything is created and before any service is
 * touched.
 */
export interface ResolvedBackupRequest {
  readonly projectRoot: string;
  readonly destinationDir: string;
  readonly setName: string;
  readonly finalDir: string;
  readonly custodian: CustodianTopology;
  readonly sidecarStateDir: string | null;
  readonly secretsDir: string;
  readonly promotionRecordsDir: string | null;
  readonly quiesce: readonly string[];
}

export function resolveCompleteBackupRequest(request: CompleteBackupRequest): ResolvedBackupRequest {
  const projectRoot = resolveMaintenanceRoot(request.projectRoot, 'project root');
  assertUsableName(request.setName, 'backup set name');

  const destinationDir = resolveInsideRoot(projectRoot, request.destination, 'backup destination');
  if (existsSync(destinationDir)) {
    const stats = lstatSync(destinationDir);
    if (stats.isSymbolicLink()) throw new MaintenanceRefused('the backup destination is a symbolic link');
    if (!stats.isDirectory()) throw new MaintenanceRefused('the backup destination is not a directory');
  }
  const finalDir = join(destinationDir, request.setName);

  // TOPOLOGY: stated, and stated exclusively.
  let sidecarStateDir: string | null = null;
  if (request.custodian === 'sidecar') {
    if (request.sidecarState === undefined || request.sidecarState.trim() === '') {
      throw new MaintenanceRefused(
        'sidecar custody was declared but no sidecar state directory was given. This command will not guess where '
        + 'the keystore is: a backup that copied the wrong directory would look complete and restore into an '
        + 'installation that can decrypt nothing.');
    }
    sidecarStateDir = resolveInsideRoot(projectRoot, request.sidecarState, 'sidecar state directory');
    if (!existsSync(sidecarStateDir) || !statSync(sidecarStateDir).isDirectory()) {
      throw new MaintenanceRefused('the sidecar state directory is not there, so the keystore cannot be taken from it');
    }
    assertPlainTree(sidecarStateDir, 'sidecar state directory');
  } else if (request.sidecarState !== undefined) {
    throw new MaintenanceRefused(
      'a sidecar state directory was given with inline custody. One of the two is wrong, and this command will not '
      + 'choose which.');
  }

  const secretsDir = resolveInsideRoot(projectRoot, request.secrets, 'secrets directory');
  if (!existsSync(secretsDir) || !statSync(secretsDir).isDirectory()) {
    throw new MaintenanceRefused('the secrets directory is not there, so a complete backup cannot be taken');
  }
  assertPlainTree(secretsDir, 'secrets directory');

  let promotionRecordsDir: string | null = null;
  if (request.promotionRecords !== undefined && request.promotionRecords.trim() !== '') {
    promotionRecordsDir = resolveInsideRoot(projectRoot, request.promotionRecords, 'promotion records directory');
    if (existsSync(promotionRecordsDir)) assertPlainTree(promotionRecordsDir, 'promotion records directory');
    else promotionRecordsDir = null;
  }

  return {
    projectRoot,
    destinationDir,
    setName: request.setName,
    finalDir,
    custodian: request.custodian,
    sidecarStateDir,
    secretsDir,
    promotionRecordsDir,
    quiesce: QUIESCED_SERVICES[request.custodian],
  };
}

/**
 * The commands a backup would run, in order, as values.
 *
 * `--plan` prints this and stops. It is also what the acceptance harness asserts against: the argument arrays
 * are the product's, not a description of them.
 */
export function planCompleteBackup(resolved: ResolvedBackupRequest, stagingDir: string): readonly MaintenanceCommand[] {
  const cwd = resolved.projectRoot;
  const commands: MaintenanceCommand[] = [];
  for (const service of resolved.quiesce) {
    commands.push({ program: 'docker', args: ['compose', 'stop', service], cwd, purpose: `stop ${service} so nothing writes` });
  }
  commands.push({
    program: 'docker',
    // `exec -T` on the running postgres container, over its local socket: no password on a command line, and
    // no port published to reach it by. The dump is captured from stdout by the runner, never redirected by a
    // shell — there is no shell.
    args: ['compose', 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', 'catalog'],
    cwd,
    purpose: 'dump the database while nothing is writing',
  });
  if (resolved.custodian === 'inline') {
    commands.push({
      program: 'docker',
      args: ['compose', 'cp', 'app:/var/lib/catalog/keystore', join(stagingDir, COMPONENT_ARTIFACT_NAMES.keystore)],
      cwd,
      purpose: 'copy the custodian keystore out of the app container',
    });
  }
  for (const service of [...resolved.quiesce].reverse()) {
    commands.push({ program: 'docker', args: ['compose', 'start', service], cwd, purpose: `start ${service} again` });
  }
  return commands;
}

/**
 * Take a complete backup.
 *
 * THE SHAPE OF THE FUNCTION IS THE GUARANTEE. Everything that can refuse happens before the first service is
 * stopped; the stop/take/start window is a `try`/`finally`, so the start runs on every path out; and the set
 * is built in a staging directory beside its final name and published by a rename, so a killed run leaves a
 * staging directory and no set rather than half a set under the name an operator would trust.
 */
export function runCompleteBackup(
  request: CompleteBackupRequest,
  deps: CompleteBackupDeps,
): CompleteBackupReport {
  const resolved = resolveCompleteBackupRequest(request);
  const now = deps.now ?? (() => new Date());

  if (existsSync(resolved.finalDir)) {
    throw new MaintenanceRefused(
      'a backup set of that name is already there. This command will not write into or replace one: choose a new '
      + 'name. Replacing a set is how the only copy of something irrecoverable gets overwritten by a failed run.');
  }
  if (!existsSync(resolved.destinationDir)) {
    createPrivateDirectory(resolved.destinationDir, 'backup destination');
  }

  const lock = acquireMaintenanceLock(resolved.projectRoot);
  const stagingDir = join(resolved.destinationDir, `.${resolved.setName}.staging-${stagingSuffix()}`);
  const notes: string[] = [];
  let restarted = false;
  try {
    createPrivateDirectory(stagingDir, 'backup staging directory');

    // ---- the consistent window -----------------------------------------------------------------------
    const quiesced: string[] = [];
    try {
      for (const service of resolved.quiesce) {
        const stop = runGuarded(deps.runner, deps.ledger, {
          program: 'docker', args: ['compose', 'stop', service], cwd: resolved.projectRoot,
          purpose: `stop ${service} so nothing writes`,
        });
        if (stop.status !== 0) {
          throw new MaintenanceRefused(
            `the ${service} service could not be stopped, so the database and the keystore could not be taken from `
            + 'the same moment. Nothing was written.');
        }
        quiesced.push(service);
      }

      const dump = runGuarded(deps.runner, deps.ledger, {
        program: 'docker',
        args: ['compose', 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', 'catalog'],
        cwd: resolved.projectRoot,
        purpose: 'dump the database while nothing is writing',
      });
      if (dump.status !== 0 || dump.stdout.length === 0) {
        throw new MaintenanceRefused('the database dump did not run, or produced nothing. Nothing was written.');
      }
      // The runner hands back BYTES AS A STRING and this writes them; nothing is redirected by a shell, so
      // there is no re-encoding step to get wrong. That is the same defect the Phase 256 Windows guidance
      // exists for, closed here by never involving a shell rather than by choosing the right one.
      writePrivateFile(join(stagingDir, COMPONENT_ARTIFACT_NAMES.database), dump.stdout, 'database dump');

      if (resolved.custodian === 'inline') {
        const copy = runGuarded(deps.runner, deps.ledger, {
          program: 'docker',
          args: ['compose', 'cp', 'app:/var/lib/catalog/keystore', join(stagingDir, COMPONENT_ARTIFACT_NAMES.keystore)],
          cwd: resolved.projectRoot,
          purpose: 'copy the custodian keystore out of the app container',
        });
        if (copy.status !== 0) {
          throw new MaintenanceRefused(
            'the custodian keystore could not be copied out of the app container. Nothing was written — a set '
            + 'without it restores into an installation that can decrypt nothing.');
        }
      } else {
        copyTree(resolved.sidecarStateDir!, join(stagingDir, COMPONENT_ARTIFACT_NAMES.keystore), 'sidecar keystore');
      }
    } finally {
      // ALWAYS, on every path out of the window: a refusal, a throw, a failed step, a success.
      //
      // AND IT NEVER THROWS OF ITS OWN. A `finally` that throws REPLACES the error that sent us here, so a
      // failed dump would be reported as a failed restart — losing the one fact an operator needs. Every
      // start is therefore attempted, its failure is recorded as a note, and whatever brought us here is what
      // propagates. Every service that WAS stopped gets an attempt, in reverse order, even if an earlier one
      // could not be started.
      restarted = true;
      for (const service of [...quiesced].reverse()) {
        try {
          const start = runGuarded(deps.runner, deps.ledger, {
            program: 'docker', args: ['compose', 'start', service], cwd: resolved.projectRoot,
            purpose: `start ${service} again`,
          });
          if (start.status !== 0) throw new MaintenanceRefused('non-zero exit');
        } catch {
          restarted = false;
          notes.push(`The ${service} service did not start again. Start it before anything else: this command has `
            + 'finished and the stack is down.');
        }
      }
    }
    // ---- outside the window: copies of things nothing was writing to anyway ---------------------------

    copyTree(resolved.secretsDir, join(stagingDir, COMPONENT_ARTIFACT_NAMES.secrets), 'secrets');
    if (resolved.promotionRecordsDir !== null) {
      copyTree(resolved.promotionRecordsDir, join(stagingDir, COMPONENT_ARTIFACT_NAMES['promotion-records']), 'promotion records');
    }

    const components = BACKUP_COMPONENT_IDS.map((id) => describeComponent(stagingDir, id));
    assertRequiredSecretFiles(join(stagingDir, COMPONENT_ARTIFACT_NAMES.secrets));

    const manifest = buildManifest(resolved, components, now());
    writePrivateFile(join(stagingDir, BACKUP_MANIFEST_NAME), manifest.text, 'backup manifest');

    publishDirectory(stagingDir, resolved.finalDir, 'backup set');

    if (!components.some((component) => component.id === 'promotion-records' && component.present)) {
      notes.push('This installation has no promotion record artifacts. That is a correct and permanent state for '
        + 'many installations, and it does not make the set incomplete.');
    }
    notes.push('Nothing was fetched and no media path was read. Verify the set before you rely on it.');

    return {
      report: COMPLETE_BACKUP_REPORT,
      version: COMPLETE_BACKUP_VERSION,
      ok: true,
      setName: resolved.setName,
      custodian: resolved.custodian,
      components,
      quiesced: resolved.quiesce,
      restarted,
      schemaVersion: MIGRATION_VERSION,
      manifestDigest: manifest.digest,
      network: 'none',
      mediaAccess: 'none',
      notes,
    };
  } finally {
    lock.release();
  }
}

// -----------------------------------------------------------------------------------------------------------
// The manifest
// -----------------------------------------------------------------------------------------------------------

export interface BackupManifest {
  readonly manifest: 'catalog-authority.backup';
  readonly version: typeof BACKUP_MANIFEST_VERSION;
  readonly setName: string;
  readonly takenAt: string;
  readonly schemaVersion: number;
  readonly custodian: CustodianTopology;
  readonly components: readonly BackupComponentResult[];
}

function buildManifest(
  resolved: ResolvedBackupRequest,
  components: readonly BackupComponentResult[],
  takenAt: Date,
): { readonly text: string; readonly digest: string } {
  // STRUCTURAL METADATA AND DIGESTS ONLY. No host path, no secret content, no provider value, and nothing
  // from inside any component — a manifest is the thing most likely to be copied out of a backup and looked
  // at somewhere else.
  const manifest: BackupManifest = {
    manifest: 'catalog-authority.backup',
    version: BACKUP_MANIFEST_VERSION,
    setName: resolved.setName,
    takenAt: takenAt.toISOString(),
    schemaVersion: MIGRATION_VERSION,
    custodian: resolved.custodian,
    components,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  return { text, digest: createHash('sha256').update(text, 'utf8').digest('hex') };
}

export function readBackupManifest(setDir: string): BackupManifest {
  let raw: string;
  try {
    raw = readFileSync(join(setDir, BACKUP_MANIFEST_NAME), 'utf8');
  } catch {
    throw new MaintenanceRefused('this backup set has no manifest, so what it should contain cannot be established');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MaintenanceRefused('this backup set\'s manifest is not readable JSON');
  }
  const doc = parsed as Partial<BackupManifest>;
  if (doc.manifest !== 'catalog-authority.backup' || doc.version !== BACKUP_MANIFEST_VERSION) {
    throw new MaintenanceRefused('this backup set\'s manifest is not one this build understands');
  }
  if (!Array.isArray(doc.components) || typeof doc.schemaVersion !== 'number' || typeof doc.setName !== 'string') {
    throw new MaintenanceRefused('this backup set\'s manifest is missing the fields a verification needs');
  }
  return doc as BackupManifest;
}

// -----------------------------------------------------------------------------------------------------------
// Copying and describing
// -----------------------------------------------------------------------------------------------------------

/**
 * Copy a directory tree, refusing anything that is not a plain file or directory.
 *
 * `cpSync` is deliberately NOT used with `dereference`: the tree was already proved to contain no symbolic
 * link, and this copies the entries it walked rather than following anything it finds later.
 */
function copyTree(source: string, destination: string, what: string): void {
  assertPlainTree(source, what);
  createPrivateDirectory(destination, `${what} copy`);
  const walk = (from: string, to: string): void => {
    for (const entry of readdirSync(from).slice().sort()) {
      const child = join(from, entry);
      const target = join(to, entry);
      const stats = lstatSync(child);
      if (stats.isSymbolicLink()) throw new MaintenanceRefused(`the ${what} gained a symbolic link while it was being copied`);
      if (stats.isDirectory()) { createPrivateDirectory(target, `${what} copy`); walk(child, target); continue; }
      if (!stats.isFile()) throw new MaintenanceRefused(`the ${what} gained a special file while it was being copied`);
      // BYTES, NOT TEXT. A secret file, a wrapped key or an operator's own promotion artifact may hold any
      // byte at all, and a backup that round-tripped it through a string encoding would restore something
      // subtly different from what it copied.
      writePrivateFile(target, readFileSync(child), `${what} copy`);
    }
  };
  walk(source, destination);
}

/** Describe one component of a staged set: present, size, entry count and a digest. Never its content. */
export function describeComponent(setDir: string, id: BackupComponentId): BackupComponentResult {
  const artifact = COMPONENT_ARTIFACT_NAMES[id];
  const path = join(setDir, artifact);
  if (!existsSync(path)) {
    return { id, artifact, present: false, bytes: 0, entries: 0, digest: '' };
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new MaintenanceRefused(`the ${id} component of this set is a symbolic link, which a backup must never be`);
  }
  if (stats.isFile()) {
    const bytes = readFileSync(path);
    return {
      id, artifact, present: true, bytes: bytes.byteLength, entries: 1,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  // A DIRECTORY IS DIGESTED OVER ITS CANONICAL LISTING PLUS EACH FILE'S OWN DIGEST. Names and digests, in a
  // total order — never the bytes concatenated, which would make the digest depend on the walk order.
  const hash = createHash('sha256');
  let entries = 0;
  let bytes = 0;
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current).slice().sort()) {
      const child = join(current, entry);
      const relative = prefix === '' ? entry : `${prefix}/${entry}`;
      const childStats = lstatSync(child);
      if (childStats.isSymbolicLink()) {
        throw new MaintenanceRefused(`the ${id} component of this set holds a symbolic link, which a backup must never do`);
      }
      if (childStats.isDirectory()) { hash.update(`d ${relative}\n`); walk(child, relative); continue; }
      if (!childStats.isFile()) {
        throw new MaintenanceRefused(`the ${id} component of this set holds a special file, which a backup must never do`);
      }
      const content = readFileSync(child);
      entries += 1;
      bytes += content.byteLength;
      hash.update(`f ${relative} ${createHash('sha256').update(content).digest('hex')}\n`);
    }
  };
  walk(path, '');
  return { id, artifact, present: true, bytes, entries, digest: hash.digest('hex') };
}

/**
 * The secrets copy must hold every file a restore needs.
 *
 * By NAME, never by content: this checks that six files exist, and opens none of them. The list is
 * `backup-components.ts`'s, which a Phase 256 test pins to what the shipped stacks actually declare.
 */
export function assertRequiredSecretFiles(secretsCopy: string): void {
  let present: readonly string[];
  try {
    present = readdirSync(secretsCopy);
  } catch {
    throw new MaintenanceRefused('the secrets component could not be listed');
  }
  const missing = REQUIRED_SECRET_FILES.filter((name) => !present.includes(name));
  if (missing.length > 0) {
    throw new MaintenanceRefused(
      `the secrets component is missing ${missing.length} of the ${REQUIRED_SECRET_FILES.length} files a restore `
      + `needs: ${missing.join(', ')}. Nothing was published.`);
  }
}

/** The human summary. Base names, counts, digests and closed-set words. */
export function renderCompleteBackup(report: CompleteBackupReport): string {
  const lines: string[] = [];
  lines.push(`Complete backup — ${report.ok ? 'TAKEN' : 'INCOMPLETE'}`);
  lines.push(`  set               ${report.setName}`);
  lines.push(`  custody           ${report.custodian}`);
  lines.push(`  schema version    ${report.schemaVersion}`);
  lines.push(`  quiesced          ${report.quiesced.join(', ')}`);
  lines.push(`  restarted         ${report.restarted}`);
  lines.push(`  manifest digest   ${report.manifestDigest.slice(0, 16)}`);
  lines.push('  components:');
  for (const component of report.components) {
    lines.push(`    ${component.id.padEnd(18)} ${component.present ? 'present' : 'ABSENT '} `
      + `entries=${component.entries} bytes=${component.bytes} ${component.digest.slice(0, 16)}`);
  }
  lines.push(`  network           ${report.network}`);
  lines.push(`  media access      ${report.mediaAccess}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push(`  RESULT: ${report.ok ? 'OK' : 'INCOMPLETE'}`);
  return lines.join('\n');
}

/** The set's own directory name, for a report that must not carry a path. */
export function setNameOf(setDir: string): string {
  return basename(setDir);
}
