import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { migrateWith } from '../src/db/pool.js';
import { MIGRATION_VERSION } from '../src/db/schema-version.js';
import {
  BACKUP_DIR_ENV,
  BACKUP_INSPECT_CHUNK_BYTES,
  BACKUP_INSPECT_MAX_LINE_BYTES,
  BACKUP_INSPECT_SCAN_MAX_BYTES,
  BackupInspectError,
  extractSchemaVersions,
  inspectBackupDirectory,
  REQUIRED_COMPONENTS,
  renderBackupInspection,
  resolveBackupInspectRequest,
  scanForSchemaVersion,
  SchemaVersionScanner,
} from '../src/ops/backup-inspect.js';
import { BACKUP_INSPECT_COMMANDS, OPTIONAL_SECRET_FILES, REQUIRED_SECRET_FILES } from '../src/ops/backup-components.js';
import { removeQuietly } from '../src/ops/usable-shell.js';

// Phase 257 — is the backup you have still a rollback point?
//
// THE GAP. There are no down-migrations, so the entire rollback story is "restore the dump you took before
// the upgrade". Nothing could look at a dump and say which schema it holds, so which of the three files in a
// folder is the right one was a question answered from memory.
//
// Everything here is offline by construction: no database is contacted to inspect a backup, nothing is
// fetched, no process is spawned by the module under test. The only live PostgreSQL in this file is used for
// the opposite purpose — to check that the OFFLINE parser's assumption about `schema_meta` matches the real
// migrated schema, so the two cannot drift.
//
// WHAT IS DELIBERATELY NOT PROVED HERE. A real `pg_dump` is not run: the embedded PostgreSQL package ships
// `initdb`, `pg_ctl` and `postgres` and no `pg_dump` binary, and there is no Docker daemon in this
// environment. The dumps below are fixtures written to the format pg_dump emits. The live check pins the one
// assumption a fixture could get wrong — the shape and contents of `schema_meta` — and the gap is stated in
// docs/PHASE_257_BACKUP_INSPECT.md rather than papered over.

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: Array<[string, unknown]> = [];
const skips: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function skip(name: string, why: string): void {
  skipped++; skips.push(`${name} — ${why}`); console.log(`  SKIP  ${name}: ${why}`);
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const workspaces: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'phase257-'));
  workspaces.push(dir);
  return dir;
}

console.log('Running Phase 257 offline backup inspection suite:\n');

// ---------------------------------------------------------------------------------------------------------
// Fixtures, written to the format pg_dump emits
// ---------------------------------------------------------------------------------------------------------

const DUMP_HEADER = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  "SET statement_timeout = 0;",
  "SET client_encoding = 'UTF8';",
  '',
].join('\n');

function copyBlock(version: number, columns = 'id, version'): string {
  const cells = columns.split(',').map((column) => column.trim());
  const row = cells.map((column) => (column === 'version' ? String(version) : '1')).join('\t');
  return `COPY public.schema_meta (${columns}) FROM stdin;\n${row}\n\\.\n`;
}

function plainDump(version: number, options: { columns?: string; eol?: '\n' | '\r\n' } = {}): string {
  const text = `${DUMP_HEADER}${copyBlock(version, options.columns)}\n-- PostgreSQL database dump complete\n`;
  return options.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

interface BackupShape {
  readonly dump?: string;
  readonly dumpName?: string;
  readonly keystore?: boolean;
  readonly emptyKeystore?: boolean;
  readonly secrets?: boolean;
  /** Two of the six required files: what an incomplete copy looks like. */
  readonly partialSecrets?: boolean;
  readonly emptySecret?: boolean;
  readonly records?: number;
}

function makeBackup(shape: BackupShape): string {
  const dir = workspace();
  if (shape.dump !== undefined) writeFileSync(join(dir, shape.dumpName ?? 'catalog-backup.sql'), shape.dump);
  if (shape.keystore === true || shape.emptyKeystore === true) {
    const root = join(dir, 'keystore-backup');
    for (const sub of ['keys', 'tombstones', 'ops', 'journal']) mkdirSync(join(root, sub), { recursive: true });
    if (shape.keystore === true) writeFileSync(join(root, 'keys', 'key_abc.json'), '{"keyId":"key_abc"}');
  }
  if (shape.secrets === true || shape.partialSecrets === true) {
    const root = join(dir, 'secrets-backup');
    mkdirSync(root, { recursive: true });
    // Two of the six, which is what an incomplete copy looks like — and what used to be accepted as complete.
    const names = shape.partialSecrets === true
      ? ['custodian_kek', 'operator_ui_token']
      : [...REQUIRED_SECRET_FILES];
    for (const secret of names) {
      // A distinctive value per file, so a test can prove the inspector never reads one.
      const empty = shape.emptySecret === true && secret === 'operator_ui_token';
      writeFileSync(join(root, secret), empty ? '' : `NEVER-READ-THIS-${secret.toUpperCase()}\n`);
    }
  }
  if (shape.records !== undefined && shape.records > 0) {
    const root = join(dir, 'promotion-records-backup');
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < shape.records; i++) writeFileSync(join(root, `phase-23${i}.json`), '{}');
  }
  return dir;
}

const COMPLETE = { keystore: true, secrets: true, records: 2 } as const;

// ---------------------------------------------------------------------------------------------------------
// The verdicts
// ---------------------------------------------------------------------------------------------------------

await test('a complete backup at this build\'s schema is CURRENT', () => {
  const result = inspectBackupDirectory(makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION) }));
  assertEq(result.verdict, 'CURRENT', 'the verdict');
  assertEq(result.ok, true, 'and it passes');
  assertEq(result.missing.length, 0, 'nothing is missing');
  assertEq(result.buildSchemaVersion, MIGRATION_VERSION, 'the build version is reported so the verdict reads on its own');
  assertEq(result.liveCallsMade, 'none', 'and nothing was contacted');
});

await test('a complete backup at an older schema is a ROLLBACK_POINT, and says it cannot be restored here', () => {
  const result = inspectBackupDirectory(makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION - 1) }));
  assertEq(result.verdict, 'ROLLBACK_POINT', 'the verdict');
  assertEq(result.ok, true, 'it is a usable backup');
  // Both halves of the same fact. A verdict that only said "valid rollback point" would be read as "restorable".
  assert(/rollback point/i.test(result.headline), 'the headline says it is a rollback point');
  assert(/CANNOT be restored under this build/i.test(result.headline), 'and that it cannot be restored here');
});

await test('a dump from a NEWER build is AHEAD and blocks', () => {
  const result = inspectBackupDirectory(makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION + 1) }));
  assertEq(result.verdict, 'AHEAD', 'the verdict');
  assertEq(result.ok, false, 'and it blocks');
  assert(/quietly corrupted/i.test(result.headline), 'and says why an older build must not be pointed at it');
});

await test('a backup missing the keystore is INCOMPLETE — the Phase 256 omission, caught', () => {
  const result = inspectBackupDirectory(makeBackup({ secrets: true, records: 1, dump: plainDump(MIGRATION_VERSION) }));
  assertEq(result.verdict, 'INCOMPLETE', 'the verdict');
  assertEq(result.ok, false, 'and it blocks');
  assertEq(result.missing.join(','), 'keystore', 'the keystore is named as the missing one');
  assert(/cannot be obtained again/i.test(result.headline), 'and the headline says what that means');
});

await test('a backup missing the dump or the secrets is INCOMPLETE too', () => {
  const noDump = inspectBackupDirectory(makeBackup({ keystore: true, secrets: true }));
  assertEq(noDump.missing.join(','), 'database', 'a missing dump is reported');
  const noSecrets = inspectBackupDirectory(makeBackup({ keystore: true, dump: plainDump(MIGRATION_VERSION) }));
  assertEq(noSecrets.missing.join(','), 'secrets', 'and so are missing secrets');
});

// An empty promotion-records folder is a correct, permanent state for many installs — Phase 253's
// READY_NO_RECORDS. Treating its absence as an incomplete backup would report a fault on most installations.
await test('missing promotion records do NOT make a backup incomplete, and the absence is stated', () => {
  const result = inspectBackupDirectory(makeBackup({ keystore: true, secrets: true, dump: plainDump(MIGRATION_VERSION) }));
  assertEq(result.verdict, 'CURRENT', 'it is still a complete backup');
  assert(!REQUIRED_COMPONENTS.includes('promotion-records'), 'records are not a required component');
  assert(result.limits.some((limit) => /No promotion record artifacts were found/.test(limit)),
    'and the absence is stated rather than passed over');
  assert(result.limits.some((limit) => /not a fault/.test(limit)), 'with the reason it is not a fault');
});

await test('an empty directory is INCOMPLETE and says the directory is empty', () => {
  const result = inspectBackupDirectory(workspace());
  assertEq(result.verdict, 'INCOMPLETE', 'the verdict');
  assertEq(result.artifacts.length, 0, 'there is nothing in it');
  assert(renderBackupInspection(result).includes('the directory is empty'), 'and the rendering says so');
});

// ---------------------------------------------------------------------------------------------------------
// Everything it cannot establish blocks
// ---------------------------------------------------------------------------------------------------------

await test('a custom-format archive is INDETERMINATE, not assumed fine', () => {
  const dir = makeBackup({ ...COMPLETE });
  writeFileSync(join(dir, 'catalog-backup.dump'), Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64)]));
  const result = inspectBackupDirectory(dir);
  assertEq(result.verdict, 'INDETERMINATE', 'the verdict');
  assertEq(result.ok, false, 'and it blocks');
  const archive = result.artifacts.find((entry) => entry.kind === 'PG_ARCHIVE_DUMP');
  assert(archive !== undefined, 'the archive was recognised as a dump');
  assertEq(archive!.component, 'database', 'and it does satisfy the database component');
  assertEq(archive!.schemaVersion?.state, 'UNREADABLE', 'but its version is not knowable from here');
  assert(/plain format/i.test(archive!.detail), 'and the operator is told how to get an answer');
  assert(/not evidence the backup is fine/i.test(result.headline), 'the headline refuses to be read either way');
});

// `pg_dump … | gzip` is common. Counting it as an unrecognised file would report a backup as INCOMPLETE with
// its dump sitting right there — a different verdict, and a different and wrong instruction.
await test('a gzip-compressed dump counts as the database and is INDETERMINATE, not missing', () => {
  const dir = makeBackup({ keystore: true, secrets: true });
  writeFileSync(join(dir, 'catalog-backup.sql.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 3]));
  const result = inspectBackupDirectory(dir);
  assertEq(result.verdict, 'INDETERMINATE', 'not INCOMPLETE — the dump is there');
  assertEq(result.missing.length, 0, 'so nothing is reported as missing');
  const gz = result.artifacts.find((entry) => entry.name.endsWith('.gz'))!;
  assertEq(gz.component, 'database', 'it satisfies the database component');
  assert(/gzip/i.test(gz.detail), 'and the operator is told what it is');
  assert(/Decompress/i.test(gz.detail), 'and what to do about it');
});

// THE DEFECT THIS CLOSES. The component was claimed on the strength of any TWO recognised file names, so a
// folder holding two of the six files a restore needs made the whole backup report CURRENT -- "complete" over
// a set of secrets that cannot start the stack. The count was even printed in the detail and the verdict
// ignored it. That is precisely the Phase 256 failure mode, reproduced inside the checker built to catch it.
await test('a partial secrets copy does NOT satisfy the component, and the backup is INCOMPLETE', () => {
  const dir = makeBackup({ keystore: true, partialSecrets: true, records: 1, dump: plainDump(MIGRATION_VERSION) });
  const result = inspectBackupDirectory(dir);
  assertEq(result.verdict, 'INCOMPLETE', 'two of six is not a secrets backup');
  assertEq(result.ok, false, 'so it blocks');
  assertEq(result.missing.join(','), 'secrets', 'and the secrets component is named as missing');
  const partial = result.artifacts.find((entry) => entry.name === 'secrets-backup')!;
  assertEq(partial.kind, 'SECRETS_COPY', 'it is still recognised as a secrets copy');
  assertEq(partial.component, null, 'but it satisfies nothing');
  assert(/INCOMPLETE/.test(partial.detail), 'the detail says so in as many words');
  for (const absent of ['completion_secret', 'database_url', 'admin_database_url', 'postgres_password']) {
    assert(partial.detail.includes(absent), `and names ${absent} as missing`);
  }
  assert(/None of them was opened/.test(partial.detail), 'and it was still not opened');
  for (const value of REQUIRED_SECRET_FILES.map((s) => `NEVER-READ-THIS-${s.toUpperCase()}`)) {
    assert(!JSON.stringify(result).includes(value), 'and no content escaped');
  }
});

await test('one required file present is recognised but never accepted', () => {
  const dir = makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION) });
  mkdirSync(join(dir, 'half-a-copy'), { recursive: true });
  writeFileSync(join(dir, 'half-a-copy', 'custodian_kek'), 'NEVER-READ-THIS-CUSTODIAN_KEK');
  const result = inspectBackupDirectory(dir);
  const partial = result.artifacts.find((entry) => entry.name === 'half-a-copy')!;
  assertEq(partial.kind, 'SECRETS_COPY', 'a lone recognised name still identifies the folder');
  assertEq(partial.component, null, 'and satisfies nothing');
  // The complete copy elsewhere in the directory is what carries the component.
  assertEq(result.verdict, 'CURRENT', 'the real secrets copy beside it still counts');
});

await test('a complete secrets copy says so, and counts', () => {
  const result = inspectBackupDirectory(makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION) }));
  const secrets = result.artifacts.find((entry) => entry.component === 'secrets')!;
  assertEq(secrets.kind, 'SECRETS_COPY', 'it is a secrets copy');
  assert(secrets.detail.includes(String(REQUIRED_SECRET_FILES.length)), 'and says how many a restore needs');
  assert(/complete secrets copy/i.test(secrets.detail), 'in as many words');
});

await test('the optional runtime credential is not required, and its presence changes nothing', () => {
  const dir = makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION) });
  assertEq(inspectBackupDirectory(dir).verdict, 'CURRENT', 'a copy without app_password is complete');
  for (const optional of OPTIONAL_SECRET_FILES) writeFileSync(join(dir, 'secrets-backup', optional), 'x');
  assertEq(inspectBackupDirectory(dir).verdict, 'CURRENT', 'and adding it does not change the verdict');
});

await test('a dump with no schema_meta is INDETERMINATE', () => {
  const dir = makeBackup({ ...COMPLETE });
  writeFileSync(join(dir, 'catalog-backup.sql'), `${DUMP_HEADER}COPY public.items (id) FROM stdin;\n\\.\n`);
  const result = inspectBackupDirectory(dir);
  assertEq(result.verdict, 'INDETERMINATE', 'the verdict');
  const dump = result.artifacts.find((entry) => entry.kind === 'PG_PLAIN_DUMP');
  assertEq(dump?.schemaVersion?.state, 'ABSENT', 'the row is absent rather than unreadable');
  assert(/partial dump/i.test(dump!.detail), 'and the likely reason is named');
});

await test('a dump containing two disagreeing schema versions is AMBIGUOUS and blocks', () => {
  const dir = makeBackup({ ...COMPLETE });
  // What concatenating two dumps into one file produces.
  writeFileSync(join(dir, 'catalog-backup.sql'), plainDump(3) + plainDump(4));
  const result = inspectBackupDirectory(dir);
  assertEq(result.verdict, 'INDETERMINATE', 'a dump with two answers cannot answer');
  const dump = result.artifacts.find((entry) => entry.kind === 'PG_PLAIN_DUMP')!;
  assertEq(dump.schemaVersion?.state, 'AMBIGUOUS', 'the finding is ambiguity, named as such');
  assert(/nothing here will pick one/i.test(dump.detail), 'and nothing picks one of them');
});

await test('two dumps in one folder that disagree also block', () => {
  const dir = makeBackup({ ...COMPLETE, dump: plainDump(3) });
  writeFileSync(join(dir, 'catalog-backup-2.sql'), plainDump(4));
  assertEq(inspectBackupDirectory(dir).verdict, 'INDETERMINATE', 'two dumps, two answers, no verdict');
});

// A deliberate decision rather than a side effect: a folder holding one readable dump and one whose version
// cannot be read contains a dump nobody can place, and restoring the wrong one is the failure this command
// exists to prevent. The readable one's version is still reported on its own entry.
await test('a readable dump beside an unreadable one still blocks, and says what it did read', () => {
  const dir = makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION) });
  writeFileSync(join(dir, 'catalog-backup.dump'), Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(32)]));
  const result = inspectBackupDirectory(dir);
  assertEq(result.verdict, 'INDETERMINATE', 'an unplaceable dump in the folder blocks');
  const plain = result.artifacts.find((entry) => entry.kind === 'PG_PLAIN_DUMP')!;
  assertEq(plain.schemaVersion?.state, 'FOUND', 'the readable one was still read');
  assert(plain.detail.includes(String(MIGRATION_VERSION)), 'and its version is reported on its own entry');
});

await test('two dumps that agree are an answer', () => {
  const dir = makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION) });
  writeFileSync(join(dir, 'catalog-backup-copy.sql'), plainDump(MIGRATION_VERSION));
  assertEq(inspectBackupDirectory(dir).verdict, 'CURRENT', 'agreeing copies are not ambiguity');
});

await test('the scan bound is reported as an unanswered question, never as an absence', () => {
  const dir = workspace();
  const path = join(dir, 'big.sql');
  writeFileSync(path, `${DUMP_HEADER}${'-- filler\n'.repeat(20000)}${copyBlock(4)}`);
  const bounded = scanForSchemaVersion(path, 1024);
  assertEq(bounded.state, 'UNREADABLE', 'reaching the bound is not an answer');
  assert(/larger than this check will read/i.test(bounded.state === 'UNREADABLE' ? bounded.reason : ''),
    'and the reason says the bound was the problem');
  assertEq(scanForSchemaVersion(path).state, 'FOUND', 'the same file, unbounded, is readable');
});

// ---------------------------------------------------------------------------------------------------------
// Reading the version out of the text
// ---------------------------------------------------------------------------------------------------------

await test('the COPY column list is read, not assumed', () => {
  assertEq(extractSchemaVersions(plainDump(7)).join(','), '7', 'the ordinary column order');
  assertEq(extractSchemaVersions(plainDump(7, { columns: 'version, id' })).join(','), '7', 'reversed columns');
  // The failure this protects against: a column added before `version` shifting the value that gets read.
  assertEq(extractSchemaVersions(plainDump(7, { columns: 'id, applied_at, version' })).join(','), '7',
    'a column inserted before version does not shift the answer');
});

await test('a dump written on Windows parses identically', () => {
  assertEq(extractSchemaVersions(plainDump(4, { eol: '\r\n' })).join(','), '4', 'CRLF line endings are handled');
});

await test('both INSERT forms are read, with and without a column list', () => {
  assertEq(extractSchemaVersions('INSERT INTO public.schema_meta (id, version) VALUES (1, 5);').join(','), '5',
    'the --inserts form');
  assertEq(extractSchemaVersions('INSERT INTO schema_meta (version, id) VALUES (6, 1);').join(','), '6',
    'unqualified and reordered');
  assertEq(extractSchemaVersions('INSERT INTO public.schema_meta VALUES (1, 9);').join(','), '9',
    'and the columnless positional form');
});

await test('a COPY block for a different table is not mistaken for this one', () => {
  const text = 'COPY public.other_schema_meta (id, version) FROM stdin;\n1\t99\n\\.\n';
  assertEq(extractSchemaVersions(text).length, 0, 'a similarly-named table contributes nothing');
});

await test('a COPY block with no version column contributes nothing rather than a guess', () => {
  assertEq(extractSchemaVersions('COPY public.schema_meta (id) FROM stdin;\n1\n\\.\n').length, 0,
    'no version column, no answer');
});

// A chunk boundary can fall inside the COPY block. The carry-over is what makes the streaming read equal a
// whole-file read, and a bug there would silently lose the one row this whole command depends on.
await test('a version found past a streaming chunk boundary is still found', () => {
  const dir = workspace();
  const path = join(dir, 'straddle.sql');
  // Comfortably past the 1 MiB window, with the block starting at a deliberately awkward offset.
  writeFileSync(path, `${DUMP_HEADER}${'-- filler\n'.repeat(150000)}${copyBlock(3)}`);
  const finding = scanForSchemaVersion(path);
  assertEq(finding.state, 'FOUND', 'the block past the window boundary was read');
  assertEq(finding.state === 'FOUND' ? finding.version : -1, 3, 'and the right version came out of it');
});

// The defect this covers: a first implementation parsed each chunk independently, so a COPY block whose
// HEADER ended one chunk and whose DATA ROW began the next was seen by neither — a readable dump reported as
// having no schema version at all. Every offset in a window around the boundary is exercised, because the bug
// only appeared at the handful of offsets where the split lands between the two lines.
await test('a COPY block split ACROSS a chunk boundary is read, at every offset', () => {
  const dir = workspace();
  const header = 'COPY public.schema_meta (id, version) FROM stdin;';
  for (let pad = 0; pad < 8; pad++) {
    const path = join(dir, `split-${pad}.sql`);
    // Fill so that the block's first line ends within a few bytes of the 1 MiB read boundary.
    const filler = 'x'.repeat(BACKUP_INSPECT_CHUNK_BYTES - header.length - 2 + pad);
    writeFileSync(path, `${DUMP_HEADER}-- ${filler}\n${header}\n1\t3\n\\.\n`);
    const finding = scanForSchemaVersion(path);
    assertEq(finding.state, 'FOUND', `offset ${pad}: the split block was read`);
    assertEq(finding.state === 'FOUND' ? finding.version : -1, 3, `offset ${pad}: with the right version`);
  }
});

// The carry bound. Without it the memory bound was a claim rather than a fact: the partial trailing line held
// between read windows grew to the size of the file whenever the file had no newline in it, which is a memory
// profile chosen by the untrusted artifact rather than by this tool.
await test('a single line longer than the carry bound is UNREADABLE, not a truncated parse', () => {
  const dir = workspace();
  const path = join(dir, 'one-huge-line.sql');
  // The carry is what grows, so the line has to outlast a read window before any bound can apply — a long
  // line that fits inside one window costs nothing and is simply parsed. This one is half a window longer,
  // and the answer sits beyond it.
  const line = 'x'.repeat(BACKUP_INSPECT_CHUNK_BYTES + (BACKUP_INSPECT_CHUNK_BYTES >> 1));
  writeFileSync(path, `${DUMP_HEADER}-- ${line}\n${copyBlock(3)}`);
  const finding = scanForSchemaVersion(path, BACKUP_INSPECT_SCAN_MAX_BYTES, BACKUP_INSPECT_CHUNK_BYTES >> 1);
  assertEq(finding.state, 'UNREADABLE', 'it refuses');
  assert(/single line longer than/i.test(finding.state === 'UNREADABLE' ? finding.reason : ''),
    'and the reason names the line bound');
  assert(/not read to the end/i.test(finding.state === 'UNREADABLE' ? finding.reason : ''),
    'and says the file was not finished');
  // The version really was in there, past the over-long line. Reporting FOUND would mean the bound had been
  // silently ignored; reporting ABSENT would be a claim about a file that was never read.
  assertEq(scanForSchemaVersion(path).state, 'FOUND', 'the same file under the real bound reads fine');
});

await test('a file with no newline at all is bounded rather than read whole into memory', () => {
  const dir = workspace();
  const path = join(dir, 'no-newline.sql');
  writeFileSync(path, `-- PostgreSQL database dump ${'y'.repeat(300_000)}`);
  const finding = scanForSchemaVersion(path, BACKUP_INSPECT_SCAN_MAX_BYTES, 8192);
  assertEq(finding.state, 'UNREADABLE', 'a file that is one endless line is refused');
  assert(/single line longer than/i.test(finding.state === 'UNREADABLE' ? finding.reason : ''), 'for that reason');
});

await test('a line that crosses a read window but stays inside the bound is still read', () => {
  const dir = workspace();
  const path = join(dir, 'straddling-line.sql');
  // One comment line that starts before and ends after the 1 MiB read boundary, then the block.
  writeFileSync(path, `${DUMP_HEADER}-- ${'z'.repeat(BACKUP_INSPECT_CHUNK_BYTES + 4096)}\n${copyBlock(3)}`);
  const finding = scanForSchemaVersion(path);
  assertEq(finding.state, 'FOUND', 'a long-but-bounded line does not stop the scan');
  assertEq(finding.state === 'FOUND' ? finding.version : -1, 3, 'and the version past it is read');
});

await test('the carry bound is a named, generous constant rather than an accident', () => {
  assert(BACKUP_INSPECT_MAX_LINE_BYTES >= 1024 * 1024,
    'the bound is far past any line this schema produces, so it cannot misfire on an ordinary dump');
  assert(BACKUP_INSPECT_MAX_LINE_BYTES < BACKUP_INSPECT_SCAN_MAX_BYTES,
    'and it is a tighter bound than the whole-file one, or it would never be the thing that fires');
});

// A multi-byte character can straddle a read window. Decoding each window in isolation turns one into a
// replacement character; the decoder holds the incomplete sequence instead.
await test('a multi-byte character split across a read window does not corrupt the scan', () => {
  const dir = workspace();
  const path = join(dir, 'multibyte.sql');
  // Pad so that a 3-byte character lands across the window boundary, then put the answer after it.
  const pad = 'a'.repeat(BACKUP_INSPECT_CHUNK_BYTES - 2);
  writeFileSync(path, `${DUMP_HEADER}-- ${pad}é中ü\n${copyBlock(4)}`, 'utf8');
  const finding = scanForSchemaVersion(path);
  assertEq(finding.state, 'FOUND', 'the scan completed');
  assertEq(finding.state === 'FOUND' ? finding.version : -1, 4, 'and read the version after the split character');
});

await test('the streaming scanner and the whole-string parser cannot disagree', () => {
  const dir = workspace();
  const text = plainDump(3);
  const path = join(dir, 'agree.sql');
  writeFileSync(path, text);
  const streamed = scanForSchemaVersion(path);
  assertEq(streamed.state === 'FOUND' ? String(streamed.version) : streamed.state,
    extractSchemaVersions(text).join(','), 'both paths read the same version');
  // They are the same scanner, so a divergence would have to be introduced deliberately.
  const scanner = new SchemaVersionScanner();
  for (const line of text.split('\n')) scanner.pushLine(line);
  assertEq(scanner.versions().join(','), '3', 'and the line-at-a-time interface agrees too');
});

await test('a COPY block that never terminates does not swallow a later INSERT silently', () => {
  // An open block consumes rows until `\.`; a truncated dump leaves it open. What must NOT happen is a later
  // line being misread as a data row and contributing a wrong number.
  const truncated = 'COPY public.schema_meta (id, version) FROM stdin;\n1\t3\n';
  assertEq(extractSchemaVersions(truncated).join(','), '3', 'the row before the truncation is still read');
  const withNoise = `${truncated}some trailing text with no tabs\n`;
  assertEq(extractSchemaVersions(withNoise).join(','), '3', 'and trailing non-numeric text adds nothing');
});

// ---------------------------------------------------------------------------------------------------------
// What it refuses to touch
// ---------------------------------------------------------------------------------------------------------

await test('no secret file is ever opened, and no secret value reaches the output', () => {
  const dir = makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION) });
  const result = inspectBackupDirectory(dir);
  const rendered = `${renderBackupInspection(result)}${JSON.stringify(result)}`;
  for (const value of REQUIRED_SECRET_FILES.map((secret) => `NEVER-READ-THIS-${secret.toUpperCase()}`)) {
    assert(!rendered.includes(value), `the value in the secret file (${value.slice(0, 12)}…) is not in the output`);
  }
  const secrets = result.artifacts.find((entry) => entry.kind === 'SECRETS_COPY');
  assert(secrets !== undefined, 'the secrets copy was recognised');
  assert(/None of them was opened/.test(secrets!.detail), 'and it says so');
});

await test('an empty secret file is reported by name, because it restores as no secret at all', () => {
  const dir = makeBackup({ ...COMPLETE, emptySecret: true, dump: plainDump(MIGRATION_VERSION) });
  const secrets = inspectBackupDirectory(dir).artifacts.find((entry) => entry.kind === 'SECRETS_COPY')!;
  assert(/EMPTY/.test(secrets.detail), 'the emptiness is reported');
  assert(/operator_ui_token/.test(secrets.detail), 'and the file is named');
});

await test('a keystore with no key files is recognised and flagged rather than passed silently', () => {
  const dir = makeBackup({ emptyKeystore: true, secrets: true, dump: plainDump(MIGRATION_VERSION) });
  const result = inspectBackupDirectory(dir);
  assertEq(result.verdict, 'CURRENT', 'it is a keystore, so the component is satisfied');
  const keystore = result.artifacts.find((entry) => entry.kind === 'KEYSTORE_COPY')!;
  assert(/no key files/i.test(keystore.detail), 'and the emptiness is called out');
  assert(/half-finished copy/i.test(keystore.detail), 'with the reading that actually worries an operator');
});

await test('the output carries no absolute path and never echoes the directory it was given', () => {
  const dir = makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION) });
  const rendered = `${renderBackupInspection(inspectBackupDirectory(dir))}${JSON.stringify(inspectBackupDirectory(dir))}`;
  assert(!rendered.includes(dir), 'the backup directory is not echoed');
  assert(!/[A-Za-z]:\\/.test(rendered), 'no Windows path appears');
  assert(!/(?:^|[^\w.])\/(?:home|root|Users|var|tmp|mnt)\//.test(rendered), 'no absolute POSIX path appears');
  // Basenames the operator chose ARE printed: they are how a person knows which file was judged.
  assert(rendered.includes('catalog-backup.sql'), 'the entry names are printed');
});

// ---------------------------------------------------------------------------------------------------------
// Links, and reporting honestly when the platform will not make one
// ---------------------------------------------------------------------------------------------------------
//
// A Windows junction is the fallback: it needs no elevation, it is a reparse point, and `lstat` reports it as
// a symbolic link — which is the property under test. An unprivileged Windows run therefore still exercises
// the boundary rather than skipping it.
//
// WHEN NEITHER IS POSSIBLE, EVERY AFFECTED TEST IS REPORTED AS SKIPPED, BY NAME. An earlier version guarded
// both tests on one flag and recorded a skip for only the first, so the second simply vanished — not run, not
// skipped, not counted. And its inner fallback `return`ed, which this harness records as a PASS for a test
// that asserted nothing. A test that disappears and a test that passes vacuously are the two ways a suite
// lies about its own coverage, and the whole point of this suite is not doing that.

/**
 * Which kind of link this platform will actually create, decided once by trying.
 *
 * `PHASE257_FORCE_NO_LINKS=1` forces the no-link path so the SKIP branch can be exercised on a machine where
 * links do work. A branch that only ever runs on hardware nobody has is a branch nobody has seen run.
 */
const LINK_KIND: 'dir' | 'junction' | null = process.env.PHASE257_FORCE_NO_LINKS === '1' ? null : (() => {
  const probe = workspace();
  const target = join(probe, 'target');
  mkdirSync(target, { recursive: true });
  for (const kind of ['dir', 'junction'] as const) {
    try {
      symlinkSync(target, join(probe, `link-${kind}`), kind);
      return kind;
    } catch { /* try the next kind */ }
  }
  return null;
})();

const NO_LINK_REASON = 'this platform refused to create both a symbolic link and a junction, so the '
  + 'no-follow boundary could not be exercised here';

/** Run a test that needs a link, or record a skip naming THAT test. Never silently omit one. */
async function linkTest(name: string, fn: () => void): Promise<void> {
  if (LINK_KIND === null) { skip(name, NO_LINK_REASON); return; }
  await test(name, fn);
}

/** Create the link, or fail the test. A creation failure here is a real failure, not a reason to pass. */
function makeLink(target: string, linkPath: string): void {
  if (LINK_KIND === null) throw new Error('makeLink called with no usable link kind');
  symlinkSync(target, linkPath, LINK_KIND);
}

const SYMLINK_NAME = 'a symbolic link is reported and not followed';

await linkTest(SYMLINK_NAME, () => {
  const dir = makeBackup({ secrets: true, dump: plainDump(MIGRATION_VERSION) });
  const symlinkTarget = workspace();
  for (const sub of ['keys', 'tombstones']) mkdirSync(join(symlinkTarget, sub), { recursive: true });
  makeLink(symlinkTarget, join(dir, 'keystore-link'));
  const result = inspectBackupDirectory(dir);
  const link = result.artifacts.find((entry) => entry.name === 'keystore-link');
  assertEq(link?.kind, 'SYMLINK_SKIPPED', 'the link is reported as a link');
  assertEq(link?.component, null, 'and satisfies no component');
  // The link points at something shaped exactly like a keystore. Following it would have made this COMPLETE.
  assertEq(result.verdict, 'INCOMPLETE', 'so the backup is still missing its keystore');
  assert(result.limits.some((limit) => /symbolic links and were not followed/.test(limit)),
    'and the report says what was skipped');
});

// The symlink refusal has to hold one level down as well. A directory whose `keys` is a link to somewhere
// else was previously accepted as a keystore on the strength of the NAME, and its entries were then counted
// by following the link — so the "no symlink is followed" claim was true of top-level entries only.
await linkTest('a keystore whose keys subdirectory is a link is not claimed as a keystore', () => {
  const dir = makeBackup({ secrets: true, dump: plainDump(MIGRATION_VERSION) });
  const fake = join(dir, 'keystore-backup');
  for (const sub of ['tombstones', 'ops', 'journal']) mkdirSync(join(fake, sub), { recursive: true });
  const elsewhere = workspace();
  writeFileSync(join(elsewhere, 'key_abc.json'), '{}');
  makeLink(elsewhere, join(fake, 'keys'));
  const result = inspectBackupDirectory(dir);
  const entry = result.artifacts.find((a) => a.name === 'keystore-backup')!;
  assert(entry.kind !== 'KEYSTORE_COPY', 'a linked keys directory does not make this a keystore');
  assertEq(entry.component, null, 'so it satisfies no component');
  assertEq(result.verdict, 'INCOMPLETE', 'and the backup is still missing its keystore');
});

await test('an unrecognised entry is counted as nothing and reported', () => {
  const dir = makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION) });
  writeFileSync(join(dir, 'notes.txt'), 'a file the operator left here');
  writeFileSync(join(dir, 'empty.sql'), '');
  const result = inspectBackupDirectory(dir);
  const notes = result.artifacts.find((entry) => entry.name === 'notes.txt')!;
  assertEq(notes.kind, 'UNRECOGNISED', 'a stray file is unrecognised');
  assertEq(notes.component, null, 'and satisfies nothing');
  assertEq(result.artifacts.find((entry) => entry.name === 'empty.sql')?.kind, 'UNRECOGNISED',
    'an empty file is not a dump');
  assertEq(result.verdict, 'CURRENT', 'and neither changes the verdict');
  assert(result.limits.some((limit) => /not recognised/.test(limit)), 'the report says something was ignored');
});

await test('a missing or non-directory target is a typed refusal', () => {
  const dir = workspace();
  writeFileSync(join(dir, 'a-file'), 'x');
  for (const target of [join(dir, 'does-not-exist'), join(dir, 'a-file')]) {
    try {
      inspectBackupDirectory(target);
      throw new Error('did not throw');
    } catch (err) {
      assert(err instanceof BackupInspectError, 'it is the module\'s own error type');
      assertEq((err as BackupInspectError).code, 'BACKUP_INSPECT_REJECTED', 'with a stable code');
    }
  }
});

await test('the limits are stated even when everything passed', () => {
  const result = inspectBackupDirectory(makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION) }));
  assertEq(result.ok, true, 'this backup passes');
  assert(result.limits.some((limit) => /not proof that it replays/.test(limit)),
    'and it still says that nothing was restored');
  assert(result.limits.some((limit) => /same backup/.test(limit)),
    'and that it cannot tell whether the dump and the keystore came from the same one');
});

// ---------------------------------------------------------------------------------------------------------
// Arguments: no default, no guessing
// ---------------------------------------------------------------------------------------------------------

await test('the directory can come from the environment or from a flag, and they must agree', () => {
  const fromEnv = resolveBackupInspectRequest([], { [BACKUP_DIR_ENV]: '/backup' });
  assertEq(fromEnv.ok ? fromEnv.dir : '', '/backup', 'the environment channel works');
  const fromFlag = resolveBackupInspectRequest(['--dir', '/backup'], {});
  assertEq(fromFlag.ok ? fromFlag.dir : '', '/backup', 'the flag channel works');
  const agreeing = resolveBackupInspectRequest(['--dir', '/backup'], { [BACKUP_DIR_ENV]: '/backup' });
  assertEq(agreeing.ok, true, 'agreeing channels are fine');
  const disagreeing = resolveBackupInspectRequest(['--dir', '/a'], { [BACKUP_DIR_ENV]: '/b' });
  assertEq(disagreeing.ok, false, 'disagreeing channels are a refusal');
  assertEq(disagreeing.ok ? '' : disagreeing.code, 'BACKUP_INSPECT_CHANNELS_DISAGREE', 'named as such');
});

await test('there is no default directory, so a run that resolves nothing inspects nothing', () => {
  const none = resolveBackupInspectRequest([], {});
  assertEq(none.ok, false, 'it refuses');
  assertEq(none.ok ? '' : none.code, 'BACKUP_INSPECT_NO_DIRECTORY', 'with its own code');
  assert(!none.ok && /no default/.test(none.message), 'and says outright that there is no default');
});

// The npm forwarding failure Phase 254 documented: the flag NAME is eaten and only its value arrives. A
// parser that treats a bare value as "probably the directory" inspects somewhere nobody asked about.
await test('a bare argument is a hard error, not a directory', () => {
  const bare = resolveBackupInspectRequest(['/some/backup'], {});
  assertEq(bare.ok, false, 'a leftover value is refused');
  assertEq(bare.ok ? '' : bare.code, 'BACKUP_INSPECT_UNRECOGNISED_ARGUMENT', 'named as such');
  assert(!bare.ok && bare.message.includes(BACKUP_DIR_ENV), 'and the reliable channel is named');
  const noValue = resolveBackupInspectRequest(['--dir'], {});
  assertEq(noValue.ok ? '' : noValue.code, 'BACKUP_INSPECT_FLAG_WITHOUT_VALUE', 'a flag with no value is refused');
  const flagAsValue = resolveBackupInspectRequest(['--dir', '--json'], {});
  assertEq(flagAsValue.ok ? '' : flagAsValue.code, 'BACKUP_INSPECT_FLAG_WITHOUT_VALUE',
    'and a following flag is never consumed as the value');
});

// ---------------------------------------------------------------------------------------------------------
// The command, end to end
// ---------------------------------------------------------------------------------------------------------

const root = fileURLToPath(new URL('..', import.meta.url));

function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'),
    join(root, 'src/ops/backup-inspect-cli.ts'), ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

await test('the CLI exits zero on a usable backup and non-zero on everything else', () => {
  const current = makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION) });
  const ok = runCli(['--dir', current]);
  assertEq(ok.status, 0, `a complete current backup exits zero (stderr: ${ok.stderr.slice(0, 200)})`);
  assert(ok.stdout.includes('CURRENT'), 'and prints the verdict');

  const rollback = makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION - 1) });
  assertEq(runCli(['--dir', rollback]).status, 0, 'a rollback point is a usable backup');

  const incomplete = makeBackup({ secrets: true, dump: plainDump(MIGRATION_VERSION) });
  assertEq(runCli(['--dir', incomplete]).status, 1, 'an incomplete backup exits one');

  const ahead = makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION + 1) });
  assertEq(runCli(['--dir', ahead]).status, 1, 'a newer dump exits one');
});

await test('the CLI refuses unresolvable arguments with its own exit code and inspects nothing', () => {
  const bare = runCli(['/somewhere']);
  assertEq(bare.status, 2, 'an unrecognised argument exits two');
  assert(bare.stdout === '', 'and prints no report at all');
  assert(bare.stderr.includes('BACKUP_INSPECT_UNRECOGNISED_ARGUMENT'), 'naming the refusal');
  assertEq(runCli([]).status, 2, 'no directory at all also exits two');
});

await test('the CLI reads the environment channel and refuses an unreadable directory separately', () => {
  const dir = makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION) });
  const viaEnv = runCli([], { [BACKUP_DIR_ENV]: dir });
  assertEq(viaEnv.status, 0, 'the environment channel drives the run');
  const missing = runCli([], { [BACKUP_DIR_ENV]: join(dir, 'nope') });
  assertEq(missing.status, 3, 'an unreadable directory has its own exit code');
  assert(!missing.stderr.includes(join(dir, 'nope')), 'and the rejected path is not echoed back');
});

await test('--json is machine-readable and carries the same verdict', () => {
  const dir = makeBackup({ ...COMPLETE, dump: plainDump(MIGRATION_VERSION) });
  const result = runCli(['--dir', dir, '--json']);
  assertEq(result.status, 0, 'it ran');
  const parsed = JSON.parse(result.stdout) as { verdict: string; liveCallsMade: string };
  assertEq(parsed.verdict, 'CURRENT', 'the verdict survives the encoding');
  assertEq(parsed.liveCallsMade, 'none', 'and so does the no-live-calls claim');
});

await test('--help explains itself and exits zero without inspecting anything', () => {
  const help = runCli(['--help']);
  assertEq(help.status, 0, 'help exits zero');
  assert(help.stdout.includes(BACKUP_DIR_ENV), 'and names the reliable channel');
  assert(help.stdout.includes('Exit codes'), 'and documents its exit codes');
});

// ---------------------------------------------------------------------------------------------------------
// Reachable from a bundle, and reachable from the page
// ---------------------------------------------------------------------------------------------------------

await test('the panel command needs no toolchain and no database', () => {
  for (const command of [BACKUP_INSPECT_COMMANDS.posix, BACKUP_INSPECT_COMMANDS.windows]) {
    // --no-deps is the load-bearing part: without it Compose starts PostgreSQL and the migration first, which
    // would make a check whose entire claim is "this needs no database" quietly need one.
    assert(command.includes('--no-deps'), `the command does not start the database: ${command}`);
    assert(command.includes(':ro'), 'the backup is mounted read-only');
    assert(command.includes(BACKUP_DIR_ENV), 'and the directory arrives through the reliable channel');
    assert(!/\bnpm run\b/.test(command), 'the host needs no Node toolchain');
    assert(!/\/mnt\/user|\/home\/|\/Users\//.test(command), 'and no particular machine is named');
  }
});

await test('the operator page carries the command, rendered from the same constant', () => {
  const service = readFileSync(join(root, 'src/ops/operator-ui-service.ts'), 'utf8');
  assert(service.includes('BACKUP_INSPECT_COMMANDS'), 'the page renders the exported command');
  assert(service.includes('BACKUP_INSPECT_NOTE'), 'and the exported explanation');
  assert(!service.includes('ops:backup-inspect'), 'and does not carry its own copy of the command text');
});

await test('package.json exposes the command and this suite', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['ops:backup-inspect'], 'tsx src/ops/backup-inspect-cli.ts', 'the command is wired up');
  assertEq(pkg.scripts['test:backup-inspect'], 'tsx test/backup-inspect.ts', 'and so is this suite');
  assert(pkg.scripts.test?.includes('tsx test/backup-inspect.ts'), 'which runs in the aggregate suite');
});

// A suite nothing runs is a suite that stops being true. CI runs named per-phase scripts rather than the
// aggregate `test` script, so a new suite that is not wired in is ungated however green it is locally.
await test('this suite is a required CI gate, not only a local script', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:phase257-local'], 'tsx test/backup-inspect.ts 5452', 'the phase has its own CI script');
  // In the `suites` job — the one that gates on typecheck and the phase suites — not somewhere optional.
  const workflow = readFileSync(join(root, '.github/workflows/runtime-image.yml'), 'utf8');
  const suites = workflow.split('name: Build and smoke')[0] ?? '';
  assert(suites.includes('npm run test:phase257-local'), 'and the suites job runs it');
});

await test('the module contacts nothing and spawns nothing', () => {
  const source = readFileSync(join(root, 'src/ops/backup-inspect.ts'), 'utf8');
  // Matched against code shapes rather than words, so a comment SAYING it spawns nothing does not read as
  // spawning something.
  for (const [pattern, what] of [
    [/\bfetch\s*\(|from 'node:http|createConnection\s*\(/, 'a network call'],
    [/from 'node:child_process|\bspawnSync?\s*\(|\bexecS(?:ync)?\s*\(/, 'a child process'],
    [/from 'pg'|\bDATABASE_URL\b|new Client\s*\(/, 'a database'],
    [/writeFileSync\s*\(|rmSync\s*\(|unlinkSync\s*\(|renameSync\s*\(|writeSync\s*\(/, 'a filesystem write'],
  ] as const) {
    assert(!pattern.test(source), `the inspector uses ${what}`);
  }
  // It never follows a link: `lstat` only, and `statSync` would be the mistake.
  assert(!/\bstatSync\b/.test(source), 'it never uses statSync, which follows symlinks');
  assert(/lstatSync/.test(source), 'it uses lstatSync');
});

// ---------------------------------------------------------------------------------------------------------
// Live: the one assumption a fixture could get wrong
// ---------------------------------------------------------------------------------------------------------
//
// Every dump above is a fixture. The thing a fixture could be confidently wrong about is the shape of
// `schema_meta` itself — its columns, their order, and what is in it after a migration. So that is checked
// against a real migrated PostgreSQL, which makes the offline parser's assumption an asserted fact rather
// than a belief.

const external = process.env.DATABASE_URL !== undefined;
let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
if (!external) {
  console.log('\n  Booting embedded PostgreSQL 16 to pin the schema_meta assumption ...\n');
  server = await startEmbedded();
}
const adminUrl = process.env.ADMIN_DATABASE_URL!;

await test('a really migrated database has schema_meta as (id, version) holding this build\'s version', async () => {
  await migrateWith(adminUrl);
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const columns = (await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'schema_meta' ORDER BY ordinal_position`)).rows
      .map((row) => row.column_name);
    // The columnless `INSERT INTO schema_meta VALUES (1, 4)` form has to assume a position. This is that
    // assumption, asserted against the real table rather than against the fixture that models it.
    assertEq(columns.join(','), 'id,version', 'the declared column order is what the positional parser assumes');
    const version = (await client.query<{ version: number }>(
      'SELECT version FROM public.schema_meta WHERE id = 1')).rows[0]?.version;
    assertEq(version, MIGRATION_VERSION, 'and a migrated database holds this build\'s version');
    // The parser, run over a COPY block built from the real column order and the real value.
    const synthesised = `COPY public.schema_meta (${columns.join(', ')}) FROM stdin;\n1\t${version}\n\\.\n`;
    assertEq(extractSchemaVersions(synthesised).join(','), String(MIGRATION_VERSION),
      'and the offline parser reads that version back out of the block a dump would write');
  } finally {
    await client.end().catch(() => undefined);
  }
});

// A real `pg_dump` is not run: the embedded PostgreSQL package ships initdb/pg_ctl/postgres and no pg_dump,
// and there is no Docker daemon here. Reported rather than quietly omitted.
skip('a dump produced by a real pg_dump binary is parsed',
  'the embedded PostgreSQL package ships no pg_dump binary and this environment has no Docker daemon; '
  + 'the schema_meta shape it would exercise is pinned by the live test above');

if (server !== null) await server.stop();
for (const dir of workspaces) removeQuietly(dir);

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
for (const note of skips) console.log(`  SKIPPED: ${note}`);
for (const [name, err] of failures) console.log(`\nFAILED: ${name}\n${(err as Error).stack ?? String(err)}`);
process.exit(failed === 0 ? 0 : 1);
