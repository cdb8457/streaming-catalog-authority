import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';

import { startEmbedded } from './embedded-pg.js';
import { installCompletionSecret, testKek } from './crypto-setup.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { adminUrl, closePool, getPool, migrate, MIGRATED_TABLES } from '../src/db/pool.js';
import { MIGRATION_VERSION } from '../src/db/schema-version.js';
import {
  deriveProjectedEntryId, deriveProjectedVersionId, manifestDigestOfBytes, probeOffsetsFor,
  validateManifestV1, type ProjectionManifestV1,
} from '../src/core/projection/manifest-v1.js';
import { readPointer, POINTER_FILE_NAME } from '../src/core/projection/artifact-store.js';
import {
  publishGeneration, publishStatus, PublishFaultInjected, type PublishReport,
} from '../src/core/projection/publish-service.js';
import {
  degradeEntry, registerEntry, registerRoot, registerVersion, restoreEntry, retireEntry, RegistrationError,
  withRegistry,
} from '../src/core/projection/source-registry.js';

// Projection Phase 1 — the publisher against a real, migrated PostgreSQL.
//
// WHAT THIS PROVES THAT THE OFFLINE SUITE CANNOT. That the registry is a schema a real server accepts, that
// the publisher's transactions are real transactions, that the advisory lock actually excludes a second
// publisher, and — the part that matters most — that a run interrupted at ANY of its three boundaries leaves
// a state the next run recognises and finishes, with the SAME bytes, without ever making half a generation
// current.
//
// THE CATALOG RECORDS ARE REAL. `logicalMediaId` names a record created through `CatalogAuthority`, the same
// write path the product uses, so the manifest's first identity layer is not a fabricated uuid.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}
async function assertThrows(fn: () => Promise<unknown>, msg: string, match?: RegExp): Promise<void> {
  try { await fn(); } catch (error) {
    if (match && !match.test((error as Error).message)) {
      throw new Error(`threw ${JSON.stringify((error as Error).message)}, expected ${match} (${msg})`);
    }
    return;
  }
  throw new Error(`expected to throw: ${msg}`);
}

const tmpDirs: string[] = [];
const freshDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};

const hex64 = (seed: string): string => createHash('sha256').update(seed).digest('hex');

const LOCAL_PATH = 'Movies/Local One/Local One.bin';
const REMOTE_PATH = 'Movies/Remote Two/Remote Two.bin';
const EXTRA_PATH = 'Movies/Local Three/Local Three.bin';
const MTIME = '2026-06-01T10:00:00.000Z';
const REMOTE_SIZE = 4 * 1024 * 1024;

function probesFor(key: string, size: number): Array<{ position: string; offset: number; length: number; sha256: string }> {
  return probeOffsetsFor(size).map((slot) => ({
    position: slot.position, offset: slot.offset, length: slot.length, sha256: hex64(`${key}:${slot.position}`),
  }));
}

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const secret = await installCompletionSecret(admin);
  const auth = new CatalogAuthority(pool, new FileCustodian(freshDir('projection-keystore-'), secret, testKek()));

  const manifestDir = freshDir('projection-manifest-');
  mkdirSync(manifestDir, { recursive: true });

  const localItem = mintItemId();
  const remoteItem = mintItemId();
  const extraItem = mintItemId();

  console.log('Running projection publisher database suite:\n');

  // -------------------------------------------------------------------------------------------------------
  // The schema
  // -------------------------------------------------------------------------------------------------------

  await test('the migration deploys the projection registry and records its version', async () => {
    const version = Number((await admin.query('SELECT version FROM public.schema_meta WHERE id = 1')).rows[0].version);
    assertEq(version, MIGRATION_VERSION, 'the recorded schema version');
    for (const table of ['projection_source_roots', 'projection_versions', 'projection_entries',
      'projection_entry_sources', 'projection_generations', 'projection_pointer']) {
      assert(MIGRATED_TABLES.includes(table), `${table} is verified by migrate()`);
      const present = (await admin.query(`SELECT to_regclass('public.${table}') AS t`)).rows[0].t;
      assert(present !== null, `${table} exists`);
    }
  });

  await test('the runtime role can read the registry and can mutate it only through the commands', async () => {
    await pool.query('SELECT count(*) FROM public.projection_entries');
    await assertThrows(() => pool.query(
      `INSERT INTO public.projection_source_roots (root_id, kind) VALUES ('sneaky', 'local')`),
    'the app role cannot write the registry directly', /permission denied/i);
    await assertThrows(() => pool.query(`UPDATE public.projection_pointer SET sequence = 99 WHERE id = 1`),
      'the app role cannot move the pointer directly', /permission denied/i);
  });

  await test('an empty control plane agrees with an empty directory, and not with a pointer file', async () => {
    // TWO EMPTIES AGREE -- that is a fresh installation. A POINTER FILE with no generation behind it does not:
    // the daemon does not see "nothing", it sees a file, reads it and refuses it. And the test has to be the
    // FILE rather than a successful read, because `readPointer` answers null for an absent pointer and for a
    // malformed one alike; reporting a directory the daemon is actively rejecting as clean is the defect.
    const emptyDir = freshDir('projection-empty-');
    const fresh = await publishStatus({ manifestDir: emptyDir });
    assertEq(fresh.dbSequence, null, 'nothing is published');
    assertEq(fresh.pointerPresent, false, 'and there is no pointer file');
    assertEq(fresh.agrees, true, 'so the two agree');

    writeFileSync(path.join(emptyDir, POINTER_FILE_NAME), '{ "generationId": ');
    const malformed = await publishStatus({ manifestDir: emptyDir });
    assertEq(malformed.pointerPresent, true, 'a pointer file is there');
    assertEq(malformed.pointerReadable, false, 'and it does not parse');
    assertEq(malformed.agrees, false, 'which is a disagreement, not an empty installation');

    writeFileSync(path.join(emptyDir, POINTER_FILE_NAME), JSON.stringify({
      generationId: `gen_${hex64('stale').slice(0, 32)}`, sequence: 7, artifactName: 'generation-7-x.json',
      artifactBytes: 10, manifestDigest: `sha256:${hex64('stale')}`,
    }));
    const stale = await publishStatus({ manifestDir: emptyDir });
    assertEq(stale.pointerReadable, true, 'a well-formed but stale pointer');
    assertEq(stale.agrees, false, 'is still a disagreement');
  });

  // -------------------------------------------------------------------------------------------------------
  // Seeding through the production write path
  // -------------------------------------------------------------------------------------------------------

  await test('a small catalog is seeded with one local and one HTTP Range stable source', async () => {
    await auth.addItem(localItem, { title: 'PROJECTION-LOCAL-TITLE-DO-NOT-LEAK', year: 2026 });
    await auth.addItem(remoteItem, { title: 'PROJECTION-REMOTE-TITLE-DO-NOT-LEAK', year: 2026 });

    await withRegistry(async (db) => {
      await registerRoot(db, 'media', 'local');
      await registerRoot(db, 'vault', 'http-range');

      await registerVersion(db, { versionKey: 'local-one', sizeBytes: 3 * 1024 * 1024, mtime: MTIME });
      await registerVersion(db, {
        versionKey: 'remote-two', sizeBytes: REMOTE_SIZE, mtime: MTIME,
        probes: probesFor('remote-two', REMOTE_SIZE),
      });

      const localEntry = await registerEntry(db, {
        itemId: localItem, versionKey: 'local-one', path: LOCAL_PATH,
        sources: [{ kind: 'local', rootId: 'media', objectRef: 'local-one.bin' }],
      });
      const remoteEntry = await registerEntry(db, {
        itemId: remoteItem, versionKey: 'remote-two', path: REMOTE_PATH,
        sources: [{ kind: 'http-range', rootId: 'vault', objectRef: 'obj-remote-two' }],
      });
      assertEq(localEntry, deriveProjectedEntryId(LOCAL_PATH), 'the local entry id is derived from its path');
      assertEq(remoteEntry, deriveProjectedEntryId(REMOTE_PATH), 'and so is the remote one');
    });

    const rows = Number((await pool.query('SELECT count(*) AS c FROM public.projection_entries')).rows[0].c);
    assertEq(rows, 2, 'two projected entries');
  });

  await test('the registration boundary refuses ephemeral access material and URL shapes', async () => {
    await withRegistry(async (db) => {
      for (const objectRef of [
        'https://cdn.example.com/object', 'obj?token=abc', 'user@host/object', 'obj\\backslash',
        'obj-with-bearer-header', 'signature-9f',
      ]) {
        await assertThrows(() => registerEntry(db, {
          itemId: remoteItem, versionKey: 'remote-two', path: 'Movies/Bad/Bad.bin',
          sources: [{ kind: 'http-range', rootId: 'vault', objectRef }],
        }), `a locator may not be ${objectRef.slice(0, 8)}…`, /opaque reference|not normalized/);
      }
    });
    const rows = Number((await pool.query('SELECT count(*) AS c FROM public.projection_entries')).rows[0].c);
    assertEq(rows, 2, 'and none of them was stored');
  });

  await test('a probe set that is not the plan the size implies is refused', async () => {
    await withRegistry(async (db) => {
      await assertThrows(() => registerVersion(db, {
        versionKey: 'bogus-probes', sizeBytes: REMOTE_SIZE, mtime: MTIME,
        probes: [{ position: 'head', offset: 7, length: 1048576, sha256: hex64('x') }],
      }), 'an invented offset', /probe/i);
    });
  });

  await test('a registered version cannot be silently re-asserted with different bytes', async () => {
    await withRegistry(async (db) => {
      await assertThrows(() => registerVersion(db, {
        versionKey: 'local-one', sizeBytes: 999, mtime: MTIME,
      }), 'the size of a projected version is immutable', /different bytes/);
    });
  });

  // -------------------------------------------------------------------------------------------------------
  // The first publish
  // -------------------------------------------------------------------------------------------------------

  let first: PublishReport;

  await test('the first publish writes an artifact and a pointer that agree exactly', async () => {
    first = await publishGeneration({ manifestDir, now: () => new Date('2026-07-01T12:00:00.000Z') });
    assertEq(first.outcome, 'published', `outcome (problems: ${first.problems.map((p) => p.code).join(', ')})`);
    assertEq(first.sequence, 1, 'the first sequence');
    assertEq(first.entryCount, 2, 'both entries');

    const pointer = readPointer(manifestDir);
    assert(pointer !== null, 'the pointer file is published');
    assertEq(pointer?.generationId, first.generationId, 'the pointer names the generation');
    assertEq(pointer?.sequence, 1, 'and its sequence');
    assertEq(pointer?.artifactName, first.artifactName, 'and its artifact');
    assertEq(pointer?.manifestDigest, first.manifestDigest, 'and its digest');

    const bytes = readFileSync(path.join(manifestDir, first.artifactName as string));
    assertEq(bytes.length, pointer?.artifactBytes, 'the artifact is exactly the length the pointer claims');
    assertEq(manifestDigestOfBytes(bytes), pointer?.manifestDigest, 'and digests to what it claims');
    assert(validateManifestV1(JSON.parse(bytes.toString('utf8'))).ok, 'and it admits under the contract');
  });

  await test('the database holds the exact bytes that were published', async () => {
    const row = (await pool.query(
      `SELECT artifact, artifact_bytes, manifest_digest, state FROM public.projection_generations WHERE sequence = 1`)).rows[0];
    const onDisk = readFileSync(path.join(manifestDir, first.artifactName as string));
    assert(Buffer.compare(row.artifact as Buffer, onDisk) === 0, 'byte for byte, the database and the disk agree');
    assertEq(Number(row.artifact_bytes), onDisk.length, 'the recorded length');
    assertEq(row.manifest_digest, manifestDigestOfBytes(onDisk), 'the recorded digest');
    assertEq(row.state, 'current', 'and it is the current generation');
  });

  await test('nothing anywhere in the registry or the ledger looks like access material', async () => {
    const columns = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name LIKE 'projection_%'
          AND data_type IN ('text', 'character varying')`);
    for (const { table_name, column_name } of columns.rows as Array<{ table_name: string; column_name: string }>) {
      const hits = await pool.query(
        `SELECT count(*) AS c FROM public.${table_name}
          WHERE ${column_name} IS NOT NULL AND (${column_name} ILIKE '%://%' OR ${column_name} ILIKE '%token%'
             OR ${column_name} ILIKE '%bearer%' OR ${column_name} ILIKE '%expires%' OR ${column_name} ILIKE '%signature%')`);
      assertEq(Number(hits.rows[0].c), 0, `${table_name}.${column_name} holds no access-shaped value`);
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // Idempotence and exclusion
  // -------------------------------------------------------------------------------------------------------

  await test('publishing again over an unmoved catalog mints nothing', async () => {
    const before = readFileSync(path.join(manifestDir, POINTER_FILE_NAME), 'utf8');
    const again = await publishGeneration({ manifestDir, now: () => new Date('2026-07-01T13:00:00.000Z') });
    assertEq(again.outcome, 'unchanged', 'the outcome');
    assertEq(again.sequence, 1, 'the sequence did not advance');
    assertEq(readFileSync(path.join(manifestDir, POINTER_FILE_NAME), 'utf8'), before, 'the pointer file is untouched');
    const count = Number((await pool.query('SELECT count(*) AS c FROM public.projection_generations')).rows[0].c);
    assertEq(count, 1, 'and no second generation row exists');
  });

  await test('a second publisher is refused while the first holds the lock', async () => {
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      const held = (await holder.query('SELECT cat_projection_publish_lock() AS ok')).rows[0].ok;
      assertEq(held, true, 'the lock was taken');
      const refused = await publishGeneration({ manifestDir });
      assertEq(refused.outcome, 'concurrent-publisher', 'the second publisher is refused, not queued');
      assertEq(refused.problems.length, 0, 'and it is not an error');
    } finally {
      await holder.query('SELECT cat_projection_publish_unlock()').catch(() => undefined);
      await holder.end();
    }
  });

  await test('two publishers racing produce at most one generation', async () => {
    const results = await Promise.all([
      publishGeneration({ manifestDir, now: () => new Date('2026-07-01T14:00:00.000Z') }),
      publishGeneration({ manifestDir, now: () => new Date('2026-07-01T14:00:00.000Z') }),
    ]);
    const outcomes = results.map((result) => result.outcome).sort();
    assert(outcomes.every((outcome) => outcome === 'unchanged' || outcome === 'concurrent-publisher'),
      `an unmoved catalog produces no generation under a race, got ${outcomes.join(', ')}`);
    const count = Number((await pool.query('SELECT count(*) AS c FROM public.projection_generations')).rows[0].c);
    assertEq(count, 1, 'still exactly one generation');
  });

  // -------------------------------------------------------------------------------------------------------
  // Succession
  // -------------------------------------------------------------------------------------------------------

  await test('adding an entry produces a deterministic successor that chains to its predecessor', async () => {
    await auth.addItem(extraItem, { title: 'PROJECTION-EXTRA-TITLE-DO-NOT-LEAK', year: 2026 });
    await withRegistry(async (db) => {
      await registerVersion(db, { versionKey: 'local-three', sizeBytes: 2 * 1024 * 1024, mtime: MTIME });
      await registerEntry(db, {
        itemId: extraItem, versionKey: 'local-three', path: EXTRA_PATH,
        sources: [{ kind: 'local', rootId: 'media', objectRef: 'local-three.bin' }],
      });
    });
    const second = await publishGeneration({ manifestDir, now: () => new Date('2026-07-02T12:00:00.000Z') });
    assertEq(second.outcome, 'published', 'published');
    assertEq(second.sequence, 2, 'the sequence advanced by exactly one');
    assertEq(second.additions, 1, 'one addition');
    assertEq(second.deletions, 0, 'no deletion');

    const artifact = readFileSync(path.join(manifestDir, second.artifactName as string), 'utf8');
    const manifest = JSON.parse(artifact) as ProjectionManifestV1;
    assertEq(manifest.generation.predecessor?.sequence, 1, 'the predecessor sequence');
    assertEq(manifest.generation.predecessor?.manifestDigest, first.manifestDigest,
      'the predecessor digest is over generation 1\'s exact bytes');
    assertEq(readPointer(manifestDir)?.sequence, 2, 'the pointer names the successor');

    const superseded = (await pool.query(
      `SELECT state FROM public.projection_generations WHERE sequence = 1`)).rows[0].state;
    assertEq(superseded, 'superseded', 'and the predecessor is superseded, not deleted');
  });

  await test('an entry cannot be moved: a corrected path is a different entry entirely', async () => {
    const sources = JSON.stringify([{
      sourceId: 'src_' + hex64('x').slice(0, 32), kind: 'local', preference: 0, sourceGeneration: 1,
      rootId: 'media', objectRef: 'local-one.bin',
    }]);
    await withRegistry(async (db) => {
      // Nothing in the registry can rename an entry. The closest a caller can get is registering the SAME id
      // at another path, which is refused outright.
      await assertThrows(() => db.query('SELECT cat_projection_entry_register($1, $2, $3, $4, $5)',
        [deriveProjectedEntryId(LOCAL_PATH), localItem, deriveProjectedVersionId('local-one'),
          'Movies/Renamed.bin', sources]),
      'a registered entry cannot change its path', /different path/);
    });
    const status = await publishStatus({ manifestDir });
    assertEq(status.dbSequence, 2, 'and nothing was published as a result');
  });

  await test('a LIVE entry cannot be re-registered against a different catalog record', async () => {
    // logicalMediaId is immutable for a carried entry (admission check 11). Letting a registration change it
    // would poison the registry: every subsequent publish would be refused with LOGICAL_MEDIA_ID_CHANGED, by
    // a row that looks perfectly reasonable. It is refused at the point of the change instead.
    await withRegistry(async (db) => {
      await assertThrows(() => registerEntry(db, {
        itemId: remoteItem, versionKey: 'local-one', path: LOCAL_PATH,
        sources: [{ kind: 'local', rootId: 'media', objectRef: 'local-one.bin' }],
      }), 'a live entry keeps its catalog record', /different catalog record/);
    });
    const owner = (await pool.query(
      'SELECT item_id FROM public.projection_entries WHERE projected_entry_id = $1',
      [deriveProjectedEntryId(LOCAL_PATH)])).rows[0].item_id;
    assertEq(owner, localItem, 'and the row is unchanged');
    const after = await publishGeneration({ manifestDir, now: () => new Date('2026-07-02T18:00:00.000Z') });
    assertEq(after.outcome, 'unchanged', 'so publishing still works');
  });

  await test('re-registering a live entry does not disturb its lifecycle state', async () => {
    const entryId = deriveProjectedEntryId(REMOTE_PATH);
    await withRegistry(async (db) => {
      await degradeEntry(db, entryId, 'operator-hold', '2026-07-02T00:00:00.000Z');
      // The SAME registration again. An operator re-running their seeding script has not un-degraded anything.
      await registerEntry(db, {
        itemId: remoteItem, versionKey: 'remote-two', path: REMOTE_PATH,
        sources: [{ kind: 'http-range', rootId: 'vault', objectRef: 'obj-remote-two' }],
      });
    });
    const row = (await pool.query(
      'SELECT visibility, degraded_reason FROM public.projection_entries WHERE projected_entry_id = $1',
      [entryId])).rows[0];
    assertEq(row.visibility, 'degraded', 'still degraded');
    assertEq(row.degraded_reason, 'operator-hold', 'for the same reason');
    await withRegistry(async (db) => { await restoreEntry(db, entryId); });
  });

  await test('an entry and its sources are registered atomically, or not at all', async () => {
    // The failure mode this closes: the entry row lands, the source set fails, and the caller is told it
    // failed while a SOURCE-LESS entry stays behind refusing every later publish with
    // PRODUCER_ENTRY_HAS_NO_SOURCE. An unregistered root is the easiest way to make the second half fail.
    const orphanPath = 'Movies/Never Registered/Never Registered.bin';
    await withRegistry(async (db) => {
      await registerVersion(db, { versionKey: 'orphan', sizeBytes: 4096, mtime: MTIME });
      await assertThrows(() => registerEntry(db, {
        itemId: extraItem, versionKey: 'orphan', path: orphanPath,
        sources: [{ kind: 'local', rootId: 'nosuchroot', objectRef: 'orphan.bin' }],
      }), 'an unregistered root fails the registration', /./);
    });
    const rows = Number((await pool.query(
      'SELECT count(*) AS c FROM public.projection_entries WHERE path = $1', [orphanPath])).rows[0].c);
    assertEq(rows, 0, 'no source-less entry was left behind');
    const after = await publishGeneration({ manifestDir, now: () => new Date('2026-07-02T19:00:00.000Z') });
    assertEq(after.outcome, 'unchanged', 'and publishing is not poisoned');
  });

  await test('un-retiring an entry that does not exist fails closed, like degrade and retire', async () => {
    await withRegistry(async (db) => {
      const ghost = deriveProjectedEntryId('Movies/Ghost/Ghost.bin');
      // A silent success here reads as "the mistaken retirement is undone" when nothing was undone, and the
      // entry goes on marching toward a deletion generation.
      await assertThrows(() => restoreEntry(db, ghost), 'set-available on an unknown id', /no such projected entry/);
      await assertThrows(() => degradeEntry(db, ghost, 'operator-hold', MTIME), 'degrade', /no such projected entry/);
      await assertThrows(() => retireEntry(db, ghost, {
        intentKey: 'ghost', declaredAt: MTIME, graceDeadline: '2026-09-01T00:00:00.000Z',
      }), 'retire', /no such projected entry/);
    });
  });

  // -------------------------------------------------------------------------------------------------------
  // Crash recovery, at each boundary
  // -------------------------------------------------------------------------------------------------------

  async function moveTheCatalog(key: string, projectedPath: string): Promise<void> {
    await withRegistry(async (db) => {
      await registerVersion(db, { versionKey: key, sizeBytes: 1024 * 1024, mtime: MTIME });
      await registerEntry(db, {
        itemId: extraItem, versionKey: key, path: projectedPath,
        sources: [{ kind: 'local', rootId: 'media', objectRef: `${key}.bin` }],
      });
    });
  }

  await test('a crash after the bytes are committed is resumed from those exact bytes', async () => {
    await moveTheCatalog('crash-a', 'Movies/Crash A/Crash A.bin');
    await assertThrows(() => publishGeneration({
      manifestDir, now: () => new Date('2026-07-03T12:00:00.000Z'), fault: 'after-prepare',
    }), 'the run stops at the prepare boundary', /after-prepare/);

    const prepared = (await pool.query(
      `SELECT sequence, artifact, manifest_digest FROM public.projection_generations WHERE state = 'prepared'`)).rows;
    assertEq(prepared.length, 1, 'a prepared generation is durable');
    assertEq(readPointer(manifestDir)?.sequence, 2, 'and the pointer still names the last good generation');
    assertEq((await publishStatus({ manifestDir })).dbSequence, 2, 'which is what the database says too');

    const resumed = await publishGeneration({ manifestDir, now: () => new Date('2026-07-03T13:00:00.000Z') });
    assertEq(resumed.outcome, 'resumed', 'the next run finishes it');
    assertEq(resumed.sequence, 3, 'at the sequence it prepared');
    const onDisk = readFileSync(path.join(manifestDir, resumed.artifactName as string));
    assert(Buffer.compare(prepared[0].artifact as Buffer, onDisk) === 0,
      'and the artifact is the committed bytes, not an equivalent rebuild');
    assertEq(readPointer(manifestDir)?.sequence, 3, 'the pointer caught up');
  });

  await test('a crash after the artifact is on disk but before it is current is resumed', async () => {
    await moveTheCatalog('crash-b', 'Movies/Crash B/Crash B.bin');
    await assertThrows(() => publishGeneration({
      manifestDir, now: () => new Date('2026-07-04T12:00:00.000Z'), fault: 'after-artifact',
    }), 'the run stops after the artifact', /after-artifact/);
    assertEq(readPointer(manifestDir)?.sequence, 3, 'the pointer has not moved');

    const resumed = await publishGeneration({ manifestDir, now: () => new Date('2026-07-04T13:00:00.000Z') });
    assertEq(resumed.outcome, 'resumed', 'the next run finishes it');
    assertEq(resumed.sequence, 4, 'at the prepared sequence');
    assertEq(readPointer(manifestDir)?.sequence, 4, 'and the pointer names it');
  });

  await test('a crash after the database moved but before the pointer file did is repaired, one step at a time', async () => {
    await moveTheCatalog('crash-c', 'Movies/Crash C/Crash C.bin');
    await assertThrows(() => publishGeneration({
      manifestDir, now: () => new Date('2026-07-05T12:00:00.000Z'), fault: 'after-db-pointer',
    }), 'the run stops after the commit point', /after-db-pointer/);

    const stale = await publishStatus({ manifestDir });
    assertEq(stale.dbSequence, 5, 'the database is ahead');
    assertEq(stale.pointerSequence, 4, 'and the pointer file is behind');
    assertEq(stale.agrees, false, 'which is exactly the disagreement recovery exists for');

    const recovered = await publishGeneration({ manifestDir, now: () => new Date('2026-07-05T13:00:00.000Z') });
    assertEq(recovered.outcome, 'recovered', 'the next run repairs the file');
    assert(recovered.repaired.includes('pointer'), 'and says what it repaired');
    assertEq(readPointer(manifestDir)?.sequence, 5, 'the pointer now names what the database says');
    // AND IT STOPPED THERE. A daemon admits a successor only one step past what it is serving, so a repair
    // must not also mint the next generation in the same run.
    assertEq((await publishStatus({ manifestDir })).dbSequence, 5, 'no successor was built in the repair run');
  });

  await test('a deleted pointer file and a corrupted artifact are both repaired from the database', async () => {
    unlinkSync(path.join(manifestDir, POINTER_FILE_NAME));
    const repairedPointer = await publishGeneration({ manifestDir });
    assertEq(repairedPointer.outcome, 'recovered', 'a missing pointer is recovered');
    assertEq(readPointer(manifestDir)?.sequence, 5, 'from the database');

    const current = (await pool.query(
      `SELECT artifact_name, artifact, manifest_digest FROM public.projection_generations WHERE state = 'current'`)).rows[0];
    writeFileSync(path.join(manifestDir, current.artifact_name as string), 'not the artifact\n');
    const repairedArtifact = await publishGeneration({ manifestDir });
    assertEq(repairedArtifact.outcome, 'recovered', 'a corrupted artifact is recovered');
    assert(repairedArtifact.repaired.includes('artifact'), 'and named');
    const rewritten = readFileSync(path.join(manifestDir, current.artifact_name as string));
    assert(Buffer.compare(rewritten, current.artifact as Buffer) === 0, 'with the committed bytes');
    assertEq(manifestDigestOfBytes(rewritten), current.manifest_digest, 'digesting to what was recorded');
  });

  await test('a pointer with the right generation but a stale artifact claim is a disagreement', async () => {
    // The daemon checks the artifact NAME, its exact BYTE LENGTH and its DIGEST before it parses anything.
    // A status surface that compared only the generation id and the sequence would call a pointer healthy
    // that projectiond refuses -- a status check that disagrees with the thing it reports on.
    const good = readFileSync(path.join(manifestDir, POINTER_FILE_NAME), 'utf8');
    const pointer = JSON.parse(good) as Record<string, unknown>;
    for (const [field, value] of [
      ['artifactBytes', (pointer.artifactBytes as number) + 1],
      ['manifestDigest', `sha256:${'0'.repeat(64)}`],
      ['artifactName', 'generation-9-ffffffffffffffffffffffffffffffff.json'],
    ] as Array<[string, unknown]>) {
      writeFileSync(path.join(manifestDir, POINTER_FILE_NAME),
        JSON.stringify({ ...pointer, [field]: value }, null, 2));
      const status = await publishStatus({ manifestDir });
      assertEq(status.pointerSequence, pointer.sequence, `the ${field} case still names the right sequence`);
      assertEq(status.agrees, false, `a stale ${field} is a disagreement`);
    }
    writeFileSync(path.join(manifestDir, POINTER_FILE_NAME), good);
    assertEq((await publishStatus({ manifestDir })).agrees, true, 'and the good pointer agrees again');
  });

  await test('a healthy directory needs no repair, and says so', async () => {
    const status = await publishStatus({ manifestDir });
    assertEq(status.agrees, true, 'the database and the directory agree');
    assertEq(status.preparedSequences.length, 0, 'nothing is half-published');
    const steady = await publishGeneration({ manifestDir });
    assertEq(steady.outcome, 'unchanged', 'and a run over an unmoved catalog is a no-op');
  });

  // -------------------------------------------------------------------------------------------------------
  // Lifecycle: degrade, retire, delete
  // -------------------------------------------------------------------------------------------------------

  await test('degrading an entry keeps it in the namespace with identical inode, size and mtime', async () => {
    const beforeArtifact = JSON.parse(readFileSync(
      path.join(manifestDir, (await publishStatus({ manifestDir })).dbSequence === null ? '' :
        (await pool.query(`SELECT artifact_name FROM public.projection_generations WHERE state='current'`)).rows[0].artifact_name as string),
      'utf8')) as ProjectionManifestV1;
    const before = beforeArtifact.entries.find((entry) => entry.path === REMOTE_PATH);

    await withRegistry(async (db) => {
      await degradeEntry(db, deriveProjectedEntryId(REMOTE_PATH), 'source-unreachable', '2026-07-06T00:00:00.000Z');
    });
    const report = await publishGeneration({ manifestDir, now: () => new Date('2026-07-06T12:00:00.000Z') });
    assertEq(report.outcome, 'published', 'a degraded transition is publishable');
    assertEq(report.additions, 0, 'and it is not an addition');
    assertEq(report.deletions, 0, 'and it is not a deletion');

    const after = (JSON.parse(readFileSync(path.join(manifestDir, report.artifactName as string), 'utf8')) as ProjectionManifestV1)
      .entries.find((entry) => entry.path === REMOTE_PATH);
    assertEq(after?.visibility, 'degraded', 'it is degraded');
    assertEq(after?.inode, before?.inode, 'inode unchanged');
    assertEq(after?.sizeBytes, before?.sizeBytes, 'size unchanged');
    assertEq(after?.mtime, before?.mtime, 'mtime unchanged');
  });

  await test('a retiring entry stays readable, and its grace deadline passing removes nothing', async () => {
    await withRegistry(async (db) => {
      await retireEntry(db, deriveProjectedEntryId(EXTRA_PATH), {
        intentKey: 'drop-extra',
        declaredAt: '2026-07-07T00:00:00.000Z',
        graceDeadline: '2026-07-08T00:00:00.000Z',
      });
    });
    const retired = await publishGeneration({ manifestDir, now: () => new Date('2026-07-07T12:00:00.000Z') });
    assertEq(retired.outcome, 'published', 'the retirement is published');
    assertEq(retired.deletions, 0, 'and it removes nothing');
    const manifest = JSON.parse(readFileSync(path.join(manifestDir, retired.artifactName as string), 'utf8')) as ProjectionManifestV1;
    assertEq(manifest.entries.find((entry) => entry.path === EXTRA_PATH)?.visibility, 'retiring', 'still present');

    // Long past the deadline, an ordinary publish still changes nothing.
    const afterGrace = await publishGeneration({ manifestDir, now: () => new Date('2026-08-01T00:00:00.000Z') });
    assertEq(afterGrace.outcome, 'unchanged', 'an elapsed deadline is not a removal');
  });

  await test('a deletion before the grace deadline is refused and leaves the last good generation serving', async () => {
    const before = readFileSync(path.join(manifestDir, POINTER_FILE_NAME), 'utf8');
    const refused = await publishGeneration({
      manifestDir, intent: 'deletion', deletions: [deriveProjectedEntryId(EXTRA_PATH)],
      now: () => new Date('2026-07-07T13:00:00.000Z'),
    });
    assertEq(refused.outcome, 'refused', 'refused');
    assert(refused.problems.some((problem) => problem.code === 'PRODUCER_DELETION_GRACE_NOT_ELAPSED'), 'and named');
    assertEq(readFileSync(path.join(manifestDir, POINTER_FILE_NAME), 'utf8'), before, 'the pointer is untouched');
  });

  await test('deleting an entry that was never retiring is refused', async () => {
    const refused = await publishGeneration({
      manifestDir, intent: 'deletion', deletions: [deriveProjectedEntryId(LOCAL_PATH)],
      now: () => new Date('2026-08-02T00:00:00.000Z'),
    });
    assertEq(refused.outcome, 'refused', 'refused');
    assert(refused.problems.some((problem) => problem.code === 'PRODUCER_DELETION_ENTRY_NOT_RETIRING'), 'and named');
  });

  await test('an explicit deletion after the grace deadline removes exactly the named entry', async () => {
    const target = deriveProjectedEntryId(EXTRA_PATH);
    const deleted = await publishGeneration({
      manifestDir, intent: 'deletion', deletions: [target], now: () => new Date('2026-08-02T00:00:00.000Z'),
    });
    assertEq(deleted.outcome, 'published', `published (${deleted.problems.map((p) => p.code).join(', ')})`);
    assertEq(deleted.deletions, 1, 'one deletion');
    assertEq(deleted.additions, 0, 'and no addition');

    const manifest = JSON.parse(readFileSync(path.join(manifestDir, deleted.artifactName as string), 'utf8')) as ProjectionManifestV1;
    assertEq(manifest.entries.some((entry) => entry.path === EXTRA_PATH), false, 'the entry is gone');
    assertEq(manifest.generation.admission.intent, 'deletion', 'and the generation declares why');
    assertEq(canonicalDeletions(manifest), target, 'naming exactly it');

    const tombstone = (await pool.query(
      `SELECT deleted_in_sequence FROM public.projection_entries WHERE projected_entry_id = $1`, [target])).rows[0];
    assertEq(Number(tombstone.deleted_in_sequence), deleted.sequence, 'and the row is tombstoned, not removed');
  });

  await test('re-registering the deleted path brings it back as an addition, and brings it back CLEAN', async () => {
    await withRegistry(async (db) => {
      await registerEntry(db, {
        itemId: extraItem, versionKey: 'local-three', path: EXTRA_PATH,
        sources: [{ kind: 'local', rootId: 'media', objectRef: 'local-three.bin' }],
      });
    });

    // THE LIFECYCLE EVIDENCE IT DIED WITH MUST BE GONE. Clearing only the tombstone would resurrect the path
    // still `retiring`, against a deletion intent nobody re-declared and a grace deadline that elapsed long
    // ago -- which is to say, immediately deletable again by a generation that would look well formed.
    const revived = (await pool.query(
      `SELECT visibility, degraded_reason, degraded_since, deletion_intent_id, retiring_declared_at,
              grace_deadline, deleted_in_sequence
         FROM public.projection_entries WHERE projected_entry_id = $1`,
      [deriveProjectedEntryId(EXTRA_PATH)])).rows[0];
    assertEq(revived.visibility, 'available', 'a re-added entry is available');
    assertEq(revived.deleted_in_sequence, null, 'the tombstone is cleared');
    for (const column of ['degraded_reason', 'degraded_since', 'deletion_intent_id', 'retiring_declared_at',
      'grace_deadline']) {
      assertEq(revived[column], null, `${column} carries nothing from the entry that was deleted`);
    }

    const report = await publishGeneration({ manifestDir, now: () => new Date('2026-08-03T00:00:00.000Z') });
    assertEq(report.outcome, 'published', 'published');
    assertEq(report.additions, 1, 'as an addition a media server is told about');
    assertEq(report.deletions, 0, 'and nothing else');
    const manifest = JSON.parse(readFileSync(path.join(manifestDir, report.artifactName as string), 'utf8')) as ProjectionManifestV1;
    assertEq(manifest.entries.find((entry) => entry.path === EXTRA_PATH)?.visibility, 'available',
      'and it is available in the published generation, not retiring');

    // ...so it is NOT immediately deletable: the re-added entry was never retired.
    const refused = await publishGeneration({
      manifestDir, intent: 'deletion', deletions: [deriveProjectedEntryId(EXTRA_PATH)],
      now: () => new Date('2026-08-04T00:00:00.000Z'),
    });
    assertEq(refused.outcome, 'refused', 'a re-added entry cannot be deleted without a new retirement');
    assert(refused.problems.some((p) => p.code === 'PRODUCER_DELETION_ENTRY_NOT_RETIRING'), 'and named');
  });

  await test('every published generation in the ledger is admissible, and the chain is unbroken', async () => {
    const rows = (await pool.query(
      `SELECT sequence, artifact, manifest_digest, predecessor_manifest_digest, state
         FROM public.projection_generations ORDER BY sequence`)).rows;
    assert(rows.length >= 5, 'several generations were published');
    let previousDigest: string | null = null;
    for (const row of rows) {
      const bytes = row.artifact as Buffer;
      assertEq(manifestDigestOfBytes(bytes), row.manifest_digest, `generation ${row.sequence} digest`);
      const parsed = validateManifestV1(JSON.parse(bytes.toString('utf8')));
      assert(parsed.ok, `generation ${row.sequence} admits: ${parsed.problems.map((p) => p.code).join(', ')}`);
      assertEq(row.predecessor_manifest_digest, previousDigest, `generation ${row.sequence} chains`);
      previousDigest = row.manifest_digest as string;
    }
    const current = rows.filter((row) => row.state === 'current');
    assertEq(current.length, 1, 'exactly one generation is current');
    assertEq(Number(current[0].sequence), Number(rows[rows.length - 1].sequence), 'and it is the newest');
  });

  await test('the publisher never wrote anything a media server could read as a credential', async () => {
    const rows = (await pool.query(`SELECT artifact FROM public.projection_generations`)).rows;
    for (const row of rows) {
      const text = (row.artifact as Buffer).toString('utf8').toLowerCase();
      for (const forbidden of ['://', 'token', 'bearer', 'expiresat', 'authorization', 'signature', 'lease']) {
        assert(!text.includes(forbidden), `a published artifact contains ${forbidden}`);
      }
    }
  });

  await admin.end();
  await closePool();
  if (server) await server.stop();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

function canonicalDeletions(manifest: ProjectionManifestV1): string {
  return manifest.generation.admission.deletions.join(',');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
