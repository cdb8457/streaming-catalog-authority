import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';

import { startEmbedded } from './embedded-pg.js';
import { installCompletionSecret, testKek } from './crypto-setup.js';
import { createFakeClock, createFakeFileSystem, mediaBytes, SMALL_MEDIA_BYTES, type FakeNode } from './usenet-kit.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { adminUrl, closePool, getPool, migrate } from '../src/db/pool.js';
import {
  degradeEntry, registerEntry, registerRoot, registerVersion, restoreEntry, withRegistry, type Queryable,
} from '../src/core/projection/source-registry.js';
import { deriveProjectedEntryId } from '../src/core/projection/manifest-v1.js';
import { readNamespaceSnapshot } from '../src/core/projection/namespace-snapshot.js';
import { isProviderBackedEntry } from '../src/core/usenet/manifest-bridge.js';
import { createRegistryPublisher } from '../src/ops/usenet-command.js';
import { UsenetAdmissionService, type AdmissionPublisher } from '../src/core/usenet/admission.js';
import { UsenetJobLedger, createMemoryLedgerStorage } from '../src/core/usenet/job-ledger.js';
import { SabClient } from '../src/core/usenet/sab-client.js';
import { createSabHttpTransport } from '../src/core/usenet/sab-http-transport.js';
import { startFakeSabnzbd } from '../src/core/usenet/sab-fake-service.js';
import { seal } from '../src/core/usenet/sealed.js';
import { USENET_DEDICATED_CATEGORY } from '../src/core/usenet/sab-contract.js';

// Projection Phase 10 §5, P10-3 — THE DRIFT GUARD, AGAINST A REAL MIGRATED POSTGRESQL.
//
// WHY THIS SUITE HAD TO EXIST BEFORE PHASE 10 COULD CLAIM ANYTHING. Phase 10 §2.1's finding is not a bug in a
// function; it is a bug in a WIRING. `torBoxDrift` was correct, `admission.ts` called it correctly, and the
// unit-test fake presented a namespace faithfully — and none of that ran on an operator's appliance, because
// the one publisher `openService` builds returned `{ publish }` and nothing else. Every offline assertion in
// the tree was green while every real admission was recorded `admittedWithoutDriftCheck: true`.
//
// A REPAIR TO THAT CANNOT BE PROVED BY ANOTHER FAKE. So this suite uses the SHIPPED `createRegistryPublisher`,
// against a real migrated schema, with real catalog records, real `registerVersion`/`registerEntry` writes and
// the real `readNamespaceSnapshot` opening its own connection — and asserts the two halves of P10-3:
//
//   * a clean admission through that publisher records NO `admittedWithoutDriftCheck`; and
//   * a TorBox entry moved around that same publish is refused `torbox-namespace-drifted`, PERMANENTLY, with
//     the admission not recorded.
//
// THE SECOND HALF IS DRIVEN, NOT SIMULATED. The move is performed by a real `degradeEntry` against the real
// registry, in the real database, between the publisher's two reads — which is what a defect would look like.
//
// NO PROVIDER IS CONTACTED. The worker is the product's own in-process fake SABnzbd on an ephemeral loopback
// port; the media bytes are synthesised; there is no TorBox account, no CDN origin, no NNTP server and no
// `endpoint.json`.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(a: T, b: T, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}

const tmpDirs: string[] = [];
const freshDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};

const MTIME = '2026-06-01T10:00:00.000Z';
const TORBOX_PATH = 'Movies/Remote One/Remote One.bin';
const TORBOX_ENTRY_ID = deriveProjectedEntryId(TORBOX_PATH);
const TORBOX_OBJECT_REF = 'opaque-object-a';
const COMPLETED_ROOT = '/downloads/complete/projection';
const API_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const MEDIA = mediaBytes(SMALL_MEDIA_BYTES);

const dir = (): FakeNode => ({ kind: 'directory' });

/** The completed-download tree the admission path proves, shaped exactly as the offline admission suite's. */
function baseTree(jobName: string): Record<string, FakeNode> {
  return {
    '/downloads': dir(),
    '/downloads/complete': dir(),
    [COMPLETED_ROOT]: dir(),
    [`${COMPLETED_ROOT}/${jobName}`]: dir(),
    [`${COMPLETED_ROOT}/${jobName}/feature.mkv`]: { kind: 'file', bytes: MEDIA },
  };
}

/**
 * One admission through the SHIPPED publisher, with an optional forgery run between its two namespace reads.
 *
 * `forge` is what a defect looks like from the guard's point of view: something that ran during a Usenet
 * publish and left a provider-backed entry different from how it found it. It is a REAL write through the
 * REAL registration boundary, in the real database — not a mutated in-memory array.
 */
async function admitOnce(input: {
  readonly jobName: string;
  readonly nzb: string;
  readonly itemId: string;
  readonly forge?: (db: Queryable) => Promise<void>;
}): Promise<{ readonly outcome: Awaited<ReturnType<UsenetAdmissionService['reconcileAll']>>[number] | undefined;
  readonly ledger: UsenetJobLedger; readonly key: string }> {
  const worker = await startFakeSabnzbd({ apiKey: API_KEY });
  try {
    const ledger = UsenetJobLedger.open(createMemoryLedgerStorage());
    return await withRegistry(async (db: Queryable) => {
      const shipped = createRegistryPublisher(db, process.env.DATABASE_URL);
      const publisher: AdmissionPublisher = input.forge === undefined ? shipped : {
        namespaceSnapshot: () => (shipped.namespaceSnapshot as () => Promise<never>)(),
        async publish(plan, itemId) {
          const published = await shipped.publish(plan, itemId);
          await (input.forge as (db: Queryable) => Promise<void>)(db);
          return published;
        },
      };
      const service = new UsenetAdmissionService({
        client: new SabClient({
          endpoint: worker.endpoint, apiKey: seal('sab-api-key', API_KEY),
          transport: createSabHttpTransport(), sleep: async () => undefined,
        }),
        ledger,
        fs: createFakeFileSystem(baseTree(input.jobName)),
        clock: createFakeClock(),
        publisher,
        completedRoot: COMPLETED_ROOT,
        rootId: 'media',
        completedRootUnderMediaRoot: ['usenet-complete'],
        category: USENET_DEDICATED_CATEGORY,
      });
      const submitted = await service.submit(seal('nzb-source', input.nzb), input.itemId);
      worker.complete(submitted.marker, { storagePath: `${COMPLETED_ROOT}/${input.jobName}`, bytes: SMALL_MEDIA_BYTES });
      return { outcome: (await service.reconcileAll())[0], ledger, key: submitted.key };
    });
  } finally {
    await worker.close();
  }
}

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const secret = await installCompletionSecret(admin);
  const auth = new CatalogAuthority(pool, new FileCustodian(freshDir('drift-keystore-'), secret, testKek()));

  const torboxItem = mintItemId();
  const usenetItem = mintItemId();

  console.log('Running Projection Phase 10 D10.1 drift-guard database suite:\n');

  // -------------------------------------------------------------------------------------------------------
  // A namespace with a TorBox half in it, written through the real registration boundary.
  // -------------------------------------------------------------------------------------------------------

  await test('a TorBox entry is registered through the real boundary, and the snapshot sees it', async () => {
    await auth.addItem(torboxItem, { title: 'DRIFT-TORBOX-TITLE-DO-NOT-LEAK', year: 2026 });
    await auth.addItem(usenetItem, { title: 'DRIFT-USENET-TITLE-DO-NOT-LEAK', year: 2026 });

    await withRegistry(async (db: Queryable) => {
      await registerRoot(db, 'vault', 'http-range');
      await registerRoot(db, 'media', 'local');
      await registerVersion(db, { versionKey: 'remote-one', sizeBytes: 4 * 1024 * 1024, mtime: MTIME });
      await registerEntry(db, {
        itemId: torboxItem,
        versionKey: 'remote-one',
        path: TORBOX_PATH,
        sources: [{ kind: 'http-range', rootId: 'vault', objectRef: TORBOX_OBJECT_REF }],
      });
    });

    const entries = await readNamespaceSnapshot();
    const torbox = entries.filter(isProviderBackedEntry);
    assertEq(torbox.length, 1, 'the snapshot did not find the registered TorBox entry');
    assertEq(torbox[0]?.path, TORBOX_PATH, 'the entry the snapshot found');
    assertEq(torbox[0]?.projectedEntryId, TORBOX_ENTRY_ID, 'the derived entry id');
  });

  await test('the snapshot takes no publish lock, so a held lock does not block it', async () => {
    // THE ASSERTION PHASE 10 SS7 R1 IS ABOUT, DRIVEN RATHER THAN READ FROM THE SOURCE. If the snapshot took
    // `cat_projection_publish_lock()` this call would block while another session holds it, and every Usenet
    // admission would then be serialised behind every publish.
    const holder = new Client({ connectionString: adminUrl() });
    await holder.connect();
    try {
      const held = (await holder.query('SELECT cat_projection_publish_lock() AS ok')).rows[0]?.['ok'];
      assertEq(held, true, 'the test could not take the publish lock, so it proves nothing');
      const entries = await readNamespaceSnapshot();
      assert(entries.length >= 1, 'the snapshot returned nothing while the publish lock was held');
    } finally {
      await holder.end().catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // P10-3, first half - a clean admission through the SHIPPED publisher.
  // -------------------------------------------------------------------------------------------------------

  await test('P10-3a - an admission through the REAL publisher records NO admittedWithoutDriftCheck', async () => {
    const run = await admitOnce({
      jobName: 'Clean.Job', nzb: 'https://indexer.invalid/fetch?id=CLEAN', itemId: usenetItem,
    });
    assertEq(run.outcome?.state, 'admitted',
      `the admission was refused: ${run.outcome?.reason ?? ''} ${run.outcome?.detail ?? ''}`);
    // THE ONE ASSERTION THIS WHOLE SUITE EXISTS FOR. Before Phase 10 D10.1 this field was `true` on every real
    // admission this repository has ever been able to make.
    assertEq(run.outcome?.admittedWithoutDriftCheck, undefined,
      'the shipped publisher still cannot present the namespace, so the TorBox guard did not run, which is '
      + 'Phase 10 SS2.1 unrepaired');
  });

  await test('the admitted entry really is in the registry, so the clean pass was not a no-op', async () => {
    const entries = await readNamespaceSnapshot();
    const usenet = entries.filter((entry) => entry.path.startsWith('usenet/'));
    assertEq(usenet.length, 1, 'the admitted Usenet entry is not in the namespace');
    const torbox = entries.filter(isProviderBackedEntry);
    assertEq(torbox.length, 1, 'the TorBox half changed across a clean admission');
    assertEq(torbox[0]?.visibility, 'available', 'the TorBox entry was degraded by a clean Usenet admission');
  });

  // -------------------------------------------------------------------------------------------------------
  // P10-3, second half - a TorBox entry moved AROUND the publish, in the real database.
  // -------------------------------------------------------------------------------------------------------

  await test('P10-3b - a TorBox entry moved around the publish is refused PERMANENTLY, and not admitted', async () => {
    // THE FORGERY IS A REAL WRITE, THROUGH THE REAL BOUNDARY, BETWEEN THE PUBLISHER'S TWO READS. Degrading the
    // TorBox entry is the politest form of the defect Phase 9 SS4's sixth refusal names - "the Usenet worker
    // was unreachable so we marked the provider entry degraded" - and `torBoxDrift` counts visibility for
    // exactly that reason. Everything else in the path is the shipped code.
    const run = await admitOnce({
      jobName: 'Drift.Job', nzb: 'https://indexer.invalid/fetch?id=DRIFT', itemId: usenetItem,
      forge: (db) => degradeEntry(db, TORBOX_ENTRY_ID, 'source-unreachable', MTIME),
    });

    assertEq(run.outcome?.state, 'refused', 'a publish that moved the TorBox half was admitted');
    assertEq(run.outcome?.reason, 'torbox-namespace-drifted', 'the reason');
    assertEq(run.ledger.get(run.key)?.admitted, null, 'the admission was recorded despite the drift');
    assertEq(run.ledger.get(run.key)?.refusal?.transient, false,
      'a namespace that moved is not something looking again fixes, and a transient refusal would republish it');
    assert(/TORBOX_ENTRY_VISIBILITY_CHANGED/.test(run.outcome?.detail ?? ''),
      `the refusal did not name what moved: ${run.outcome?.detail ?? ''}`);
  });

  await test('the refusal detail names no path, no locator, no media identity and no URL', async () => {
    // Phase 10 SS4's ninth refusal, checked where it is easiest to break: a diagnostic written under pressure.
    // The forgery here RESTORES the entry the previous test degraded, so the visibility genuinely moves again
    // rather than this test passing on a state that was already wrong.
    const run = await admitOnce({
      jobName: 'Redact.Job', nzb: 'https://indexer.invalid/fetch?id=REDACT', itemId: usenetItem,
      forge: (db) => restoreEntry(db, TORBOX_ENTRY_ID),
    });
    assertEq(run.outcome?.reason, 'torbox-namespace-drifted', 'the restore was not seen as a move');

    const detail = run.outcome?.detail ?? '';
    assert(!detail.includes(TORBOX_PATH), 'the refusal detail names the projected path of a TorBox entry');
    assert(!detail.includes(TORBOX_OBJECT_REF), 'the refusal detail names a provider object reference');
    assert(!detail.includes(torboxItem) && !detail.includes(usenetItem),
      'the refusal detail names a media identity');
    assert(!/https?:\/\//.test(detail), 'the refusal detail carries a URL');
    assert(!detail.includes(COMPLETED_ROOT), 'the refusal detail names a completed source path');
  });

  await admin.end();
  await closePool();
  if (server) await server.stop();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
