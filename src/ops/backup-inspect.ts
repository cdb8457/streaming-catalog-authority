import { closeSync, constants as fsConstants, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { MIGRATION_VERSION } from '../db/schema-version.js';
import {
  BACKUP_COMPONENT_IDS,
  REQUIRED_SECRET_FILES,
  ROOT_KEY_SECRET_NAME,
  backupSetHasRing,
  requiredSecretFilesFor,
  type BackupComponentId,
} from './backup-components.js';

// Phase 257 — is the backup you have still a rollback point?
//
// THE GAP. Rolling back to a previous release means restoring a dump taken BEFORE the migration that moved
// the schema forward. There are no down-migrations, so "restore the pre-upgrade backup" is the whole rollback
// story — and there was no way to look at a dump and find out which schema it holds. An operator with three
// files in a folder had to remember which one predated an upgrade, and remembering is not a rollback plan.
//
// SO THIS READS THE DUMP. Offline: no database is contacted, nothing is fetched, nothing is resolved over
// DNS, no process is spawned. A backup you can only check by restoring it is a backup you check once, in the
// worst hour of the week.
//
// EVERY UNCERTAINTY IS A REFUSAL, NOT AN ASSUMPTION.
//   * a custom-format dump is compressed and this cannot read the version out of it — INDETERMINATE, said in
//     as many words, with the plain-format command that would let it;
//   * a dump with no `schema_meta` at all is INDETERMINATE — a partial dump is not a rollback point;
//   * two `schema_meta` rows that disagree is AMBIGUOUS, which blocks. A dump that contains two answers has
//     been edited or concatenated, and picking one of them is how you restore the wrong thing;
//   * a version NEWER than this build is AHEAD and blocks. A newer backup under an older build is the exact
//     shape of quiet corruption the no-down-migration rule exists to prevent.
//
// IT NEVER OPENS A SECRET. The secrets component is recognised by FILE NAMES and sizes, never by content. A
// tool that reads your KEK to tell you it is there has told you something you already knew at a cost you did
// not agree to. It reports present / absent / empty and nothing else.
//
// AND IT DOES NOT FOLLOW SYMLINKS. Every entry is `lstat`ed. A symlink in a backup directory is reported and
// skipped: following one would let a link decide what gets read, and "what does this backup contain" must be
// answered by the backup.
//
// WHAT IT PRINTS. Basenames — which the operator chose and already knows — plus verdicts. Never a file's
// contents, never a secret value, never the directory it was pointed at.

export const BACKUP_INSPECT_REPORT = 'phase-257-backup-inspect';

/** How much of one file is held in memory while scanning. The file itself is streamed; this is the window. */
export const BACKUP_INSPECT_CHUNK_BYTES = 1 << 20;

/**
 * How far into a plain dump the scan will look for `schema_meta`.
 *
 * A bound is necessary — this is a CLI a person waits on — and an unbounded read of a very large dump on
 * spinning storage is indistinguishable from a hang. Exceeding it is INDETERMINATE with the reason stated, so
 * the bound can never be mistaken for a finding.
 */
export const BACKUP_INSPECT_SCAN_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The largest partial line the scan will hold between read windows.
 *
 * It bounds the CARRY, which is the only thing that grows: a line that fits inside one read window costs
 * nothing extra and is simply parsed, however long it is. A line that outlasts a window is what accumulates,
 * and that is what this stops.
 *
 * Without this the memory bound is not a bound at all: a file with no newline in it, or one enormous line,
 * grows the carry to the size of the file. This tool exists to inspect an artifact it does not trust, so the
 * artifact must not get to choose how much memory the tool uses.
 *
 * Generous on purpose. A `schema_meta` row is a handful of bytes and the longest line in an ordinary plain
 * dump is one `COPY` row; 8 MiB is far past anything this schema produces, so reaching it means the file is
 * not the shape a plain dump has — which is worth reporting rather than absorbing.
 */
export const BACKUP_INSPECT_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** The signature of a plain-format `pg_dump`, which the dump writes in its own header comment. */
const PLAIN_DUMP_MARKER = 'PostgreSQL database dump';
/** The first five bytes of every custom-format and directory-format archive. */
const CUSTOM_DUMP_MAGIC = 'PGDMP';

/** Subdirectories a `FileCustodian` root always has. Content, not a name somebody chose. */
const KEYSTORE_SUBDIRS = ['keys', 'tombstones'] as const;

// The secret file names come from `backup-components.ts`, where a test pins them to what the shipped Compose
// stacks actually declare. They are used to RECOGNISE a directory and to decide whether it is COMPLETE;
// nothing in one is ever opened.

export type ArtifactKind =
  | 'PG_PLAIN_DUMP'
  | 'PG_ARCHIVE_DUMP'
  | 'KEYSTORE_COPY'
  | 'SECRETS_COPY'
  | 'RECORDS_COPY'
  | 'SYMLINK_SKIPPED'
  | 'UNRECOGNISED';

export type SchemaVersionFinding =
  | { readonly state: 'FOUND'; readonly version: number }
  /** More than one `schema_meta` row, disagreeing. Blocks; never resolved by picking one. */
  | { readonly state: 'AMBIGUOUS'; readonly versions: readonly number[] }
  /** The file was read to the end and contains no `schema_meta` row. */
  | { readonly state: 'ABSENT' }
  /** Not knowable from here: a compressed archive, or a scan bound reached. */
  | { readonly state: 'UNREADABLE'; readonly reason: string };

export interface InspectedArtifact {
  /** The entry's own name. The directory it lives in is never carried. */
  readonly name: string;
  readonly kind: ArtifactKind;
  /** Which backup component this entry satisfies, if any. */
  readonly component: BackupComponentId | null;
  /** Only for a dump. */
  readonly schemaVersion: SchemaVersionFinding | null;
  /** One sentence a person can act on. Never a path, never a value. */
  readonly detail: string;
}

export type BackupVerdict =
  /** A required component is not there. */
  | 'INCOMPLETE'
  /** Everything required is present and the dump matches the schema this build expects. */
  | 'CURRENT'
  /** Everything required is present and the dump predates this build's schema. A rollback point. */
  | 'ROLLBACK_POINT'
  /** The dump is from a NEWER build than this one. Blocks. */
  | 'AHEAD'
  /** Everything required is present and the schema version could not be established. Blocks. */
  | 'INDETERMINATE';

export interface BackupInspection {
  readonly report: typeof BACKUP_INSPECT_REPORT;
  readonly ok: boolean;
  readonly verdict: BackupVerdict;
  /** What this build's schema is, so a reader never has to look it up to interpret the verdict. */
  readonly buildSchemaVersion: number;
  readonly artifacts: readonly InspectedArtifact[];
  readonly present: readonly BackupComponentId[];
  readonly missing: readonly BackupComponentId[];
  /** The headline, said as a consequence rather than as a state name. */
  readonly headline: string;
  /** Everything true that the verdict does not say. Never a reassurance. */
  readonly limits: readonly string[];
  readonly liveCallsMade: 'none';
}

export class BackupInspectError extends Error {
  readonly code = 'BACKUP_INSPECT_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'BackupInspectError';
  }
}

/**
 * The promotion records are advisory, not required.
 *
 * An installation with an empty records folder is a correct, complete, permanent state — that is Phase 253's
 * `READY_NO_RECORDS`. Treating their absence as an incomplete backup would report a fault on the majority of
 * installs, which is exactly the false alarm this project keeps having to remove.
 */
export const REQUIRED_COMPONENTS: readonly BackupComponentId[] = ['database', 'keystore', 'secrets'];

export function inspectBackupDirectory(dir: string): BackupInspection {
  let entries: readonly string[];
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory()) throw new BackupInspectError('the backup location is not a directory');
    entries = readdirSync(dir).slice().sort();
  } catch (err) {
    if (err instanceof BackupInspectError) throw err;
    throw new BackupInspectError('the backup directory could not be read');
  }

  // WHAT THIS SET MUST HOLD DEPENDS ON WHAT IT HOLDS. A keystore carrying a KEK ring needs the root wrapping
  // key that seals it; a static-custody set from before the ring existed does not, and demanding one would
  // report every pre-migration rollback set as incomplete. See `backupSetHasRing`.
  const ringPresent = backupSetHasRing(dir);
  const artifacts = entries.map((name) => inspectEntry(dir, name, ringPresent));
  const present = BACKUP_COMPONENT_IDS.filter((id) => artifacts.some((a) => a.component === id));
  const missing = REQUIRED_COMPONENTS.filter((id) => !present.includes(id));

  const dumps = artifacts.filter((a) => a.component === 'database');
  const verdict = deriveVerdict(missing, dumps);
  return {
    report: BACKUP_INSPECT_REPORT,
    ok: verdict === 'CURRENT' || verdict === 'ROLLBACK_POINT',
    verdict,
    buildSchemaVersion: MIGRATION_VERSION,
    artifacts,
    present,
    missing,
    headline: HEADLINE[verdict],
    limits: limitsFor(artifacts, present),
    liveCallsMade: 'none',
  };
}

const HEADLINE: Record<BackupVerdict, string> = {
  INCOMPLETE: 'This is not a complete backup. Restoring it would leave you without something that cannot be '
    + 'obtained again from anywhere.',
  CURRENT: 'Complete, and the dump holds the schema this build expects. It can be restored under this '
    + 'version.',
  ROLLBACK_POINT: 'Complete, and the dump predates this build\'s schema. That makes it a valid rollback '
    + 'point for the older version it came from — and it CANNOT be restored under this build, which is the '
    + 'same fact said the other way round.',
  AHEAD: 'The dump holds a NEWER schema than this build understands. Restoring it here would put an older '
    + 'build in front of a schema it does not know, which is how data gets quietly corrupted. Refused.',
  INDETERMINATE: 'Everything required is present, and which schema the dump holds could not be established. '
    + 'That is not evidence the backup is fine and not evidence it is broken — it is an unanswered question, '
    + 'and a rollback plan cannot rest on one.',
};

function deriveVerdict(missing: readonly BackupComponentId[], dumps: readonly InspectedArtifact[]): BackupVerdict {
  if (missing.length > 0) return 'INCOMPLETE';
  // More than one dump in the folder: only a unanimous, unambiguous answer is an answer.
  const findings = dumps.map((dump) => dump.schemaVersion).filter((f): f is SchemaVersionFinding => f !== null);
  if (findings.some((f) => f.state !== 'FOUND')) return 'INDETERMINATE';
  const versions = new Set(findings.map((f) => (f.state === 'FOUND' ? f.version : -1)));
  if (versions.size !== 1) return 'INDETERMINATE';
  const version = [...versions][0]!;
  if (version > MIGRATION_VERSION) return 'AHEAD';
  return version === MIGRATION_VERSION ? 'CURRENT' : 'ROLLBACK_POINT';
}

function limitsFor(artifacts: readonly InspectedArtifact[], present: readonly BackupComponentId[]): readonly string[] {
  const limits: string[] = [
    'Nothing here was restored, and a file that looks like a dump is not proof that it replays. This checks '
    + 'what a backup CONTAINS, not that it works.',
    'The keystore and the dump are only useful together and this cannot tell whether they came from the same '
    + 'backup. Two components from different moments will restore into an installation that cannot read '
    + 'itself.',
  ];
  if (!present.includes('promotion-records')) {
    limits.push('No promotion record artifacts were found. That is not a fault — an empty records folder is a '
      + 'correct and permanent state for many installations — so it does not make this backup incomplete.');
  }
  if (artifacts.some((a) => a.kind === 'SYMLINK_SKIPPED')) {
    limits.push('One or more entries are symbolic links and were not followed. Whatever they point at has not '
      + 'been inspected and is not counted as present.');
  }
  if (artifacts.some((a) => a.kind === 'UNRECOGNISED')) {
    limits.push('One or more entries were not recognised. They are reported by name and counted as nothing.');
  }
  return limits;
}

// -----------------------------------------------------------------------------------------------------------
// One entry
// -----------------------------------------------------------------------------------------------------------

function inspectEntry(dir: string, name: string, ringPresent: boolean): InspectedArtifact {
  const path = join(dir, name);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return artifact(name, 'UNRECOGNISED', null, null, 'This entry could not be read and is counted as nothing.');
  }

  if (stat.isSymbolicLink()) {
    return artifact(name, 'SYMLINK_SKIPPED', null, null,
      'A symbolic link. It was not followed, and what it points at is not counted as present.');
  }

  if (stat.isDirectory()) return inspectDirectoryEntry(path, name, ringPresent);
  if (!stat.isFile()) {
    return artifact(name, 'UNRECOGNISED', null, null, 'Not a regular file or directory. Counted as nothing.');
  }
  return inspectFileEntry(path, name, stat.size);
}

function inspectDirectoryEntry(path: string, name: string, ringPresent: boolean): InspectedArtifact {
  let children: readonly string[];
  try {
    children = readdirSync(path);
  } catch {
    return artifact(name, 'UNRECOGNISED', null, null, 'This directory could not be listed and is counted as nothing.');
  }
  const set = new Set(children);

  // A FileCustodian root, recognised by the subdirectories it always creates rather than by its name.
  //
  // Each one must be a REAL directory, not merely a name in the listing. `lstat().isDirectory()` is false for
  // a symbolic link, so a `keys` that points somewhere else fails the test and the entry is not claimed as a
  // keystore — rather than being claimed on the strength of a link whose target was never inspected.
  if (KEYSTORE_SUBDIRS.every((sub) => set.has(sub) && isRealDirectory(join(path, sub)))) {
    const keys = countEntries(join(path, 'keys'));
    return artifact(name, 'KEYSTORE_COPY', 'keystore', null,
      keys === 0
        ? 'A custodian keystore with no key files in it. That is what a keystore looks like before anything '
          + 'has been encrypted — and also what a half-finished copy looks like. Check it against the '
          + 'installation it came from.'
        : 'A custodian keystore. Its key files were counted and never opened.');
  }

  // A secrets copy, recognised by file names only. Nothing in it is opened.
  //
  // RECOGNISING ONE AND ACCEPTING ONE ARE DIFFERENT QUESTIONS, and conflating them was a defect exactly like
  // the one Phase 256 exists to fix. This used to claim the `secrets` component on the strength of any TWO
  // recognised names, so a folder holding two of the six files a restore needs made the whole backup report
  // CURRENT — a verdict of "complete" over a set of secrets that cannot start the stack. The count was even
  // printed in the detail, and the verdict ignored it.
  //
  // So: any required NAME present makes it a secrets copy, and only all of them — each an actual regular
  // file with something in it — satisfies the component.
  //
  // "PRESENT" IS NOT A NAME IN A LISTING. Testing membership of the directory listing and then taking a size
  // accepted things that are not secrets at all, and which of them slipped through depended on the platform —
  // measured, not assumed:
  //
  //   * on Linux a DIRECTORY named `operator_ui_token` lstats at 4096, so it read as present and non-empty;
  //   * on Windows a directory lstats at 0 and would have been called EMPTY, but a JUNCTION lstats at 48 (the
  //     length of its target path), so the LINK is the one that slipped through there.
  //
  // Either way a backup reported CURRENT while containing no such secret, on every platform, by one route or
  // the other. Each required name is now `lstat`ed and has to be `isFile()` with a size above zero, which is
  // a property neither a directory nor a link has anywhere.
  //
  // `lstat`, NOT `stat`, deliberately: a symbolic link named like a secret is not the secret, even when it
  // points at a real one. Following it would let a link outside the backup decide whether the backup counts,
  // which is the same boundary every other entry here is held to.
  const required = requiredSecretFilesFor(ringPresent);
  const secretStates = required.map((secret) => [secret, requiredSecretState(join(path, secret))] as const);
  // A ROOT KEY THAT IS PRESENT IS STILL CHECKED WHEN IT IS NOT REQUIRED. It restores to the path the whole
  // ring is sealed under, so a directory or an empty file at that name is a fault in the set either way.
  const optionalRoot: (readonly [string, RequiredSecretState])[] =
    !ringPresent && requiredSecretState(join(path, ROOT_KEY_SECRET_NAME)) !== 'MISSING'
      ? [[ROOT_KEY_SECRET_NAME, requiredSecretState(join(path, ROOT_KEY_SECRET_NAME))]]
      : [];
  if (secretStates.some(([, state]) => state !== 'MISSING')) {
    const named = (want: RequiredSecretState): readonly string[] =>
      secretStates.filter(([, state]) => state === want).map(([secret]) => secret);
    const missing = named('MISSING');
    const notFile = named('NOT_A_FILE');
    const empty = named('EMPTY');
    if (missing.length === 0 && notFile.length === 0 && empty.length === 0) {
      return artifact(name, 'SECRETS_COPY', 'secrets', null,
        `A complete secrets copy: all ${required.length} files a restore needs are present, are `
        + 'regular files, and are not empty. None of them was opened.');
    }
    const faults = [
      ...(missing.length === 0 ? [] : [`missing ${missing.join(', ')}`]),
      ...(notFile.length === 0 ? [] : [`NOT A REGULAR FILE ${notFile.join(', ')}`]),
      ...(empty.length === 0 ? [] : [`EMPTY ${empty.join(', ')}`]),
    ].join('; ');
    return artifact(name, 'SECRETS_COPY', null, null,
      `An INCOMPLETE secrets copy — ${faults}. A restore needs every one of the `
      + `${required.length} required files as a real, non-empty file: a directory or a link with `
      + 'one of those names is not the secret, and an empty file restores as no secret at all. This does NOT '
      + 'count as the secrets component. None of them was opened.');
  }

  const jsonCount = children.filter((child) => child.toLowerCase().endsWith('.json')).length;
  if (jsonCount > 0 && jsonCount === children.length) {
    return artifact(name, 'RECORDS_COPY', 'promotion-records', null,
      `A folder of ${jsonCount} JSON file(s), which is the shape of a promotion records copy. Their contents `
      + 'were not read and nothing about the chain is claimed here.');
  }

  return artifact(name, 'UNRECOGNISED', null, null,
    'A directory that matches no known backup component. It is counted as nothing rather than guessed at.');
}

function inspectFileEntry(path: string, name: string, size: number): InspectedArtifact {
  const head = readHead(path, 512);
  if (head === null) {
    return artifact(name, 'UNRECOGNISED', null, null, 'This file could not be read and is counted as nothing.');
  }
  if (head.toString('latin1').startsWith(CUSTOM_DUMP_MAGIC)) {
    return artifact(name, 'PG_ARCHIVE_DUMP', 'database',
      { state: 'UNREADABLE', reason: 'a custom-format archive is compressed, and this reads plain text only' },
      'A pg_dump archive (custom or directory format). Which schema it holds cannot be read from here. Take '
      + 'the backup in plain format as well — the Backup & restore panel shows the command — or restore it '
      + 'into a throwaway database and read the version there.');
  }
  // `pg_dump … | gzip` is common enough that treating it as an unrecognised file would report a backup as
  // INCOMPLETE while its dump was sitting there. It is a dump, and its version is unknowable from here —
  // which is INDETERMINATE, a different verdict and a different instruction.
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    return artifact(name, 'PG_ARCHIVE_DUMP', 'database',
      { state: 'UNREADABLE', reason: 'the file is gzip-compressed, and this reads plain text only' },
      'A gzip-compressed file, which is what piping a plain dump through gzip produces. It counts as the '
      + 'database component and its schema version cannot be read from here. Decompress it and inspect '
      + 'again, or keep an uncompressed copy alongside it.');
  }
  if (size === 0) {
    return artifact(name, 'UNRECOGNISED', null, null, 'An empty file. It is counted as nothing.');
  }
  if (!head.toString('utf8').includes(PLAIN_DUMP_MARKER)) {
    return artifact(name, 'UNRECOGNISED', null, null,
      'A file that is not a PostgreSQL dump as far as its first bytes say. Counted as nothing.');
  }
  const finding = scanForSchemaVersion(path);
  return artifact(name, 'PG_PLAIN_DUMP', 'database', finding, describeFinding(finding));
}

function describeFinding(finding: SchemaVersionFinding): string {
  switch (finding.state) {
    case 'FOUND':
      return `A plain-format PostgreSQL dump holding schema version ${finding.version}. This build expects `
        + `${MIGRATION_VERSION}.`;
    case 'AMBIGUOUS':
      return `A plain-format dump containing more than one schema version (${finding.versions.join(', ')}). A `
        + 'dump with two answers has been edited or concatenated; nothing here will pick one of them.';
    case 'ABSENT':
      return 'A plain-format dump with no schema_meta row in it. Either it is a partial dump or it predates '
        + 'the version table. It cannot be used as evidence of which schema it holds.';
    case 'UNREADABLE':
      return `A dump whose schema version could not be established: ${finding.reason}.`;
  }
}

function artifact(
  name: string,
  kind: ArtifactKind,
  component: BackupComponentId | null,
  schemaVersion: SchemaVersionFinding | null,
  detail: string,
): InspectedArtifact {
  return { name: basename(name), kind, component, schemaVersion, detail };
}

/** What one required secret file actually is on disk. Anything that is not a real, non-empty file is a fault. */
type RequiredSecretState = 'OK' | 'MISSING' | 'NOT_A_FILE' | 'EMPTY';

/**
 * Inspect one required secret WITHOUT opening it.
 *
 * `lstat` rather than `stat`, so a symbolic link is reported as what it is rather than as whatever it points
 * at. `isFile()` is the check that matters: a size test alone accepted a directory on Linux (4096) and a link
 * on Windows (48 — the length of its target path), so on every platform something that is not a secret got
 * through by one route or the other.
 */
function requiredSecretState(path: string): RequiredSecretState {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return 'MISSING';
  }
  if (!stat.isFile()) return 'NOT_A_FILE';
  return stat.size === 0 ? 'EMPTY' : 'OK';
}

/** A directory in its own right. False for a symbolic link to one, which is the point. */
function isRealDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function countEntries(path: string): number {
  // Only ever called for a path `isRealDirectory` has just confirmed, so this listing cannot be redirected.
  try { return readdirSync(path).length; } catch { return -1; }
}

function overLongLine(maxLineBytes: number): SchemaVersionFinding {
  return {
    state: 'UNREADABLE',
    reason: `the file contains a single line longer than the ${maxLineBytes} bytes this check will hold, so `
      + 'it was not read to the end. Nothing was parsed from a fragment of it',
  };
}

/**
 * Open for reading and refuse a symbolic link at the moment of opening, where the platform allows it.
 *
 * Every entry is already `lstat`ed before it gets here, so this is not the primary defence — it closes the
 * gap between that check and this open, and it makes the refusal the kernel's rather than ours. `O_NOFOLLOW`
 * does not exist on Windows; there the `lstat` remains the whole of it, and the limitation is written down in
 * `docs/PHASE_257_BACKUP_INSPECT.md` rather than glossed.
 */
function openReadOnlyNoFollow(path: string): number {
  const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
  return openSync(path, noFollow === undefined ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | noFollow);
}

function readHead(path: string, bytes: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openReadOnlyNoFollow(path);
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// -----------------------------------------------------------------------------------------------------------
// Reading the version out of a plain dump
// -----------------------------------------------------------------------------------------------------------

/**
 * `schema_meta` is `(id INTEGER PRIMARY KEY, version INTEGER)`, so a plain dump writes either
 *
 *     COPY public.schema_meta (id, version) FROM stdin;
 *     1\t4
 *     \.
 *
 * or, with `--inserts`, `INSERT INTO public.schema_meta (id, version) VALUES (1, 4);` — and with
 * `--column-inserts` off and no column list, `INSERT INTO public.schema_meta VALUES (1, 4);`.
 *
 * The COPY column list is READ rather than assumed, so a future column added before `version` cannot make
 * this silently report the wrong integer. A columnless INSERT is the one form where position must be assumed;
 * it is assumed to match the table's declared order, and the live test in this phase's suite asserts that
 * order against a real migrated database.
 */
/**
 * A line-at-a-time scanner, so that a `COPY` block split across a read boundary is still read.
 *
 * The first version of this parsed each streamed chunk independently, which lost a block whose header ended
 * one chunk and whose data row began the next: the chunk with the header saw no rows, the chunk with the row
 * saw no header, and a perfectly good dump reported ABSENT. It failed closed, which is the right direction —
 * and it was still a tool that would occasionally tell an operator it could not read a file it could.
 *
 * Carrying the open-block state across chunks removes the whole class rather than widening a carry-over
 * window and hoping. The same scanner backs {@link extractSchemaVersions}, so the streamed and whole-string
 * paths cannot behave differently.
 */
export class SchemaVersionScanner {
  private readonly found: number[] = [];
  /** Index of the `version` column inside the currently open COPY block, or `null` when none is open. */
  private copyVersionIndex: number | null = null;
  private inCopy = false;

  pushLine(line: string): void {
    if (this.inCopy) {
      if (line === '\\.') { this.inCopy = false; this.copyVersionIndex = null; return; }
      if (line === '') return;
      const cells = line.split('\t');
      const cell = this.copyVersionIndex === null ? undefined : cells[this.copyVersionIndex];
      if (cell !== undefined && /^\d+$/.test(cell)) this.found.push(Number(cell));
      return;
    }

    const copy = /^COPY\s+(?:public\.)?schema_meta\s*\(([^)]*)\)\s+FROM\s+stdin;/i.exec(line);
    if (copy !== null) {
      const index = columnIndex(copy[1]!);
      this.inCopy = true;
      this.copyVersionIndex = index;
      return;
    }

    const withColumns = /^INSERT\s+INTO\s+(?:public\.)?schema_meta\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(line);
    if (withColumns !== null) {
      const index = columnIndex(withColumns[1]!);
      const values = withColumns[2]!.split(',').map((value) => value.trim());
      const cell = index === null ? undefined : values[index];
      if (cell !== undefined && /^\d+$/.test(cell)) this.found.push(Number(cell));
      return;
    }

    const positional = /^INSERT\s+INTO\s+(?:public\.)?schema_meta\s+VALUES\s*\(([^)]*)\)/i.exec(line);
    if (positional !== null) {
      const values = positional[1]!.split(',').map((value) => value.trim());
      const cell = values[1];
      if (cell !== undefined && /^\d+$/.test(cell)) this.found.push(Number(cell));
    }
  }

  push(text: string): void {
    for (const line of text.split(/\r?\n/)) this.pushLine(line);
  }

  versions(): readonly number[] {
    return this.found;
  }
}

/** `null` rather than `-1`, so "no version column" cannot be used as an index by accident. */
function columnIndex(list: string): number | null {
  const columns = list.split(',').map((column) => column.trim().replace(/^"|"$/g, '').toLowerCase());
  const index = columns.indexOf('version');
  return index === -1 ? null : index;
}

export function extractSchemaVersions(text: string): readonly number[] {
  const scanner = new SchemaVersionScanner();
  scanner.push(text);
  return scanner.versions();
}

/**
 * Stream the file and read every `schema_meta` version out of it.
 *
 * Streamed with a fixed window rather than read whole: a dump is arbitrarily large and this is a command a
 * person waits on.
 *
 * THREE BOUNDS, and every one of them refuses rather than guesses when it is reached.
 *
 *   * the read window is {@link BACKUP_INSPECT_CHUNK_BYTES};
 *   * the number of bytes visited is bounded by {@link BACKUP_INSPECT_SCAN_MAX_BYTES};
 *   * the CARRY — the partial trailing line held between windows — is bounded by
 *     {@link BACKUP_INSPECT_MAX_LINE_BYTES}.
 *
 * The third one was missing, and its absence made the memory bound a claim rather than a fact: a file with no
 * newline in it at all, or one enormous logical line, grew the carry to the size of the file. A tool whose
 * whole job is to inspect an untrusted artifact must not have a memory profile chosen by that artifact.
 *
 * Exceeding the carry bound is UNREADABLE, not a truncated parse. Cutting an over-long line in half and
 * carrying on would risk reading a fragment as a row; discarding it and continuing would mean claiming a
 * complete scan of a file part of which was never looked at. Neither is a thing this module says.
 */
export function scanForSchemaVersion(
  path: string,
  maxBytes = BACKUP_INSPECT_SCAN_MAX_BYTES,
  maxLineBytes = BACKUP_INSPECT_MAX_LINE_BYTES,
): SchemaVersionFinding {
  let fd: number | null = null;
  const scanner = new SchemaVersionScanner();
  let found: readonly number[] = [];
  try {
    fd = openReadOnlyNoFollow(path);
    const buffer = Buffer.alloc(BACKUP_INSPECT_CHUNK_BYTES);
    // A multi-byte character can straddle a read boundary. Decoding each window in isolation would turn one
    // into a replacement character; the decoder holds the incomplete sequence instead.
    const decoder = new StringDecoder('utf8');
    let carry = '';
    let visited = 0;
    let truncated = false;
    for (;;) {
      // Never read PAST the bound. Reading a whole chunk and then noticing would make the bound a suggestion
      // whose effect depended on where a chunk boundary happened to fall — and a run that reported
      // UNREADABLE having actually found the answer would be the worst of both.
      const want = Math.min(buffer.length, maxBytes - visited);
      if (want <= 0) { truncated = true; break; }
      const read = readSync(fd, buffer, 0, want, null);
      if (read === 0) break;
      visited += read;
      // A chunk boundary can fall inside a line, so the tail is carried into the next window.
      const text = carry + decoder.write(buffer.subarray(0, read));
      const lastBreak = text.lastIndexOf('\n');
      const complete = lastBreak === -1 ? '' : text.slice(0, lastBreak);
      carry = lastBreak === -1 ? text : text.slice(lastBreak + 1);
      // The scanner keeps any open COPY block across the boundary, so only the partial LINE has to be carried.
      if (complete !== '') scanner.push(complete);
      if (Buffer.byteLength(carry, 'utf8') > maxLineBytes) return overLongLine(maxLineBytes);
    }
    const tail = carry + decoder.end();
    if (Buffer.byteLength(tail, 'utf8') > maxLineBytes) return overLongLine(maxLineBytes);
    if (tail !== '') scanner.pushLine(tail);
    found = scanner.versions();
    if (found.length === 0) {
      return truncated
        ? { state: 'UNREADABLE', reason: 'the dump is larger than this check will read and no schema version appeared in the part it did read' }
        : { state: 'ABSENT' };
    }
  } catch {
    return { state: 'UNREADABLE', reason: 'the file could not be read to the end' };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
  const distinct = [...new Set(found)].sort((a, b) => a - b);
  return distinct.length === 1
    ? { state: 'FOUND', version: distinct[0]! }
    : { state: 'AMBIGUOUS', versions: distinct };
}

// -----------------------------------------------------------------------------------------------------------
// Resolving what to inspect
// -----------------------------------------------------------------------------------------------------------
//
// Phase 254 established, by observing three different behaviours on three different npm versions, that
// `npm run x -- --flag value` is not a portable way to pass an argument: the flags may arrive intact, may
// arrive as one token, or may be eaten entirely with only their values forwarded. All three converge on the
// same failure — the flag is not seen and a default is used silently.
//
// There is no default here, which removes the failure rather than mitigating it: a run that cannot resolve a
// directory inspects nothing and says so. An unrecognised argument is a hard error rather than a discarded
// one, and two channels that disagree are a refusal rather than a precedence puzzle.

export const BACKUP_DIR_ENV = 'CATALOG_AUTHORITY_BACKUP_DIR';

export type BackupInspectRequest =
  | { readonly ok: true; readonly dir: string; readonly json: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string };

export function resolveBackupInspectRequest(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): BackupInspectRequest {
  let flagDir: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') { json = true; continue; }
    if (arg === '--dir') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, code: 'BACKUP_INSPECT_FLAG_WITHOUT_VALUE', message: '--dir was given with no directory after it.' };
      }
      if (flagDir !== undefined && flagDir !== value) {
        return { ok: false, code: 'BACKUP_INSPECT_ARGUMENTS_DISAGREE', message: '--dir was given twice with different values.' };
      }
      flagDir = value;
      i++;
      continue;
    }
    // Deliberately NOT ignored. A bare value here is the shape npm produces when it forwards a flag's value
    // without its name, and treating it as "probably the directory" is how a check inspects the wrong thing.
    return {
      ok: false,
      code: 'BACKUP_INSPECT_UNRECOGNISED_ARGUMENT',
      message: `An argument was passed that this command does not recognise. Nothing was inspected. If you `
        + `invoked it through npm, set ${BACKUP_DIR_ENV} instead: npm may forward a flag's value without its name.`,
    };
  }

  const envDir = env[BACKUP_DIR_ENV]?.trim();
  const fromEnv = envDir === undefined || envDir === '' ? undefined : envDir;
  if (fromEnv !== undefined && flagDir !== undefined && fromEnv !== flagDir) {
    return {
      ok: false,
      code: 'BACKUP_INSPECT_CHANNELS_DISAGREE',
      message: `${BACKUP_DIR_ENV} and --dir name different directories. Nothing was inspected; pick one.`,
    };
  }
  const dir = flagDir ?? fromEnv;
  if (dir === undefined) {
    return {
      ok: false,
      code: 'BACKUP_INSPECT_NO_DIRECTORY',
      message: `No backup directory was given, and there is no default. Set ${BACKUP_DIR_ENV}, or pass `
        + '--dir <directory>. Nothing was inspected.',
    };
  }
  return { ok: true, dir, json };
}

// -----------------------------------------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------------------------------------

/** Plain text. Basenames and verdicts; never a directory, never a file's contents. */
export function renderBackupInspection(inspection: BackupInspection): string {
  const lines: string[] = [
    'Catalog Authority — backup inspection',
    `report:        ${inspection.report}`,
    `verdict:       ${inspection.verdict}`,
    `build schema:  ${inspection.buildSchemaVersion}`,
    `live calls:    ${inspection.liveCallsMade}`,
    '',
    inspection.headline,
    '',
    'Components',
    ...BACKUP_COMPONENT_IDS.map((id) => {
      const state = inspection.present.includes(id)
        ? 'present'
        : REQUIRED_COMPONENTS.includes(id) ? 'MISSING' : 'not present (not required)';
      return `  ${id.padEnd(20)} ${state}`;
    }),
    '',
    'Entries',
    ...(inspection.artifacts.length === 0
      ? ['  (the directory is empty)']
      : inspection.artifacts.flatMap((entry) => [`  ${entry.name}`, `    ${entry.kind}: ${entry.detail}`])),
    '',
    'What this does not tell you',
    ...inspection.limits.map((limit) => `  - ${limit}`),
    '',
  ];
  return lines.join('\n');
}
