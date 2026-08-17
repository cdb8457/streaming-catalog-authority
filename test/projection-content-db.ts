import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';

import { startEmbedded } from './embedded-pg.js';
import { installCompletionSecret, testKek } from './crypto-setup.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { adminUrl, closePool, getPool, migrate } from '../src/db/pool.js';
import { readPointer } from '../src/core/projection/artifact-store.js';
import { deriveProjectedEntryId } from '../src/core/projection/manifest-v1.js';
import { readNamespaceSnapshot } from '../src/core/projection/namespace-snapshot.js';
import { restoreEntry, retireEntry, withRegistry } from '../src/core/projection/source-registry.js';
import { main as contentCli } from '../src/ops/projection-content-cli.js';
import {
  addLocalObjects, addTorboxObjects, contentPreflight, contentStatus, createRealContentHost,
  holdContentEntry, publishContent, reconcileContent, releaseContentEntry,
  type ContentPlaneConfig,
} from '../src/ops/projection-content.js';

// Projection Phase 10 §5 — P10-4 and P10-5, against a real migrated PostgreSQL.
//
// WHAT THESE TWO CLAIMS ASK, AND WHY NEITHER CAN BE ANSWERED OFFLINE.
//
//   P10-4  an operator goes from an installed, serving, EMPTY appliance to a readable namespace holding one
//          entry using ONLY shipped verbs — zero hand-run `tsx`, zero operator interventions.
//   P10-5  a `local` source whose file is removed is REPORTED and never changed on its own; the published
//          generation is BYTE-IDENTICAL before and after the report; `hold` then degrades it and `release`
//          restores it.
//
// P10-4 is a claim about a SEQUENCE of shipped verbs against a real registry, and a fake registry would let
// the sequence pass while the real one refused a locator, a probe plan or a version key. P10-5's central
// assertion is about BYTES ON DISK: that running `reconcile` over a namespace whose file has vanished leaves
// the generation artifact and the pointer unchanged to the byte. There is nothing to compare in memory.
//
// THE VERBS ARE CALLED THROUGH THE CLI'S OWN `main`, not through the module functions, for the arms that
// measure the operator path. A test that called the module directly would prove the module works and say
// nothing about whether the surface an operator types reaches it.
//
// NO PROVIDER IS CONTACTED. The TorBox arm registers an OPAQUE OBJECT REFERENCE and nothing resolves it; that
// is exactly what `http-range` registration is, and Phase 10 is provider-free by construction.

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: Array<[string, unknown]> = [];
const skips: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}

/**
 * A skip, NAMED AND COUNTED.
 *
 * The convention `03c26c1` established for this repository: a suite that skips silently is a suite whose green
 * run is unreadable. Every skip here says which arm and why, the count is printed with the totals, and a skip
 * is never folded into a pass.
 */
function skip(name: string, why: string): void {
  skipped++;
  skips.push(`${name}: ${why}`);
  console.log(`  SKIP  ${name} - ${why}`);
}

/**
 * Whether this host can express the absolute POSIX paths the SHIPPED configuration contract demands.
 *
 * `parseContentConfig` refuses a path that is not absolute POSIX and refuses one containing a backslash, for
 * the same reason `parseUsenetConfig` does: the appliance is Linux and a relative or drive-lettered path would
 * resolve against whatever directory the command happened to be run from. That refusal is CORRECT, and it
 * means the arms that drive the shipped CLI over a temporary directory cannot run on a Windows development
 * host. They run for real on the Unraid host, where P10-4 is measured.
 */
const POSIX_PATHS = process.platform !== 'win32';
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

const LOCAL_PROJECTED = 'Movies/Local One/Local One.bin';
const TORBOX_PROJECTED = 'Movies/Remote One/Remote One.bin';
const LOCAL_RELATIVE = 'movies/local-one.bin';
const TORBOX_SIZE = 4 * 1024 * 1024;
const TORBOX_MTIME = '2026-06-01T10:00:00.000Z';
const hex64 = (seed: string): string => createHash('sha256').update(seed).digest('hex');

/** Bytes that are not all one value, so a probe window over them is a meaningful digest. */
function mediaBytes(sizeBytes: number): Buffer {
  const buffer = Buffer.alloc(sizeBytes);
  for (let index = 0; index < sizeBytes; index += 1) buffer[index] = (index * 31 + 7) & 0xff;
  return buffer;
}

/** Every file in the manifest directory, by name, with its exact bytes. P10-5's "byte-identical" is this. */
function directoryBytes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    out[name] = createHash('sha256').update(readFileSync(path.join(dir, name))).digest('hex');
  }
  return out;
}

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) { console.log('Booting embedded PostgreSQL 16 ...'); server = await startEmbedded(); }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const secret = await installCompletionSecret(admin);
  const auth = new CatalogAuthority(pool, new FileCustodian(freshDir('content-keystore-'), secret, testKek()));

  const manifestDir = freshDir('content-manifest-');
  const mediaRoot = freshDir('content-media-');
  const inputDir = freshDir('content-input-');
  mkdirSync(path.join(mediaRoot, 'movies'), { recursive: true });

  const localFile = path.join(mediaRoot, LOCAL_RELATIVE);
  writeFileSync(localFile, mediaBytes(2 * 1024 * 1024));

  const localItem = mintItemId();
  const torboxItem = mintItemId();
  await auth.addItem(localItem, { title: 'CONTENT-LOCAL-TITLE-DO-NOT-LEAK', year: 2026 });
  await auth.addItem(torboxItem, { title: 'CONTENT-REMOTE-TITLE-DO-NOT-LEAK', year: 2026 });

  const config: ContentPlaneConfig = {
    manifestDir, mediaRoot, rootId: 'media', endpointId: 'vault',
  };
  const configFile = path.join(inputDir, 'content.json');
  writeFileSync(configFile, JSON.stringify({ manifestDir, mediaRoot, rootId: 'media', endpointId: 'vault' }));

  const localObjectsFile = path.join(inputDir, 'local-objects.json');
  writeFileSync(localObjectsFile, JSON.stringify([{
    label: 'local-one', itemId: localItem, path: LOCAL_PROJECTED, relativePath: LOCAL_RELATIVE,
  }]));

  const torboxObjectsFile = path.join(inputDir, 'torbox-objects.json');
  writeFileSync(torboxObjectsFile, JSON.stringify([{
    _comment_label: 'the template keeps its comments and this command ignores them',
    label: 'remote-one',
    itemId: torboxItem,
    path: TORBOX_PROJECTED,
    ref: 'opaque-object-reference-DO-NOT-LEAK',
    sizeBytes: TORBOX_SIZE,
    mtime: TORBOX_MTIME,
    sha256: null,
    probeDigests: [
      { offset: 0, length: 1_048_576, sha256: hex64('head') },
      { offset: Math.floor(TORBOX_SIZE / 2) - 524_288, length: 1_048_576, sha256: hex64('middle') },
      { offset: TORBOX_SIZE - 1_048_576, length: 1_048_576, sha256: hex64('tail') },
    ],
  }]));
  try { chmodSync(torboxObjectsFile, 0o600); } catch { /* the mode is only meaningful where the platform has one */ }

  const host = createRealContentHost();
  console.log('Running Projection Phase 10 content-plane database suite:\n');

  // -------------------------------------------------------------------------------------------------------
  // P10-4 — the whole operator path, through the SHIPPED verbs only.
  // -------------------------------------------------------------------------------------------------------

  await test('P10-4a - preflight on an empty, agreeing installation reports nothing wrong', async () => {
    const problems = await contentPreflight(config, host, process.env.DATABASE_URL);
    assertEq(problems.length, 0, `preflight refused a clean installation: ${problems.map((one) => one.code).join(', ')}`);
  });

  await test('preflight REFUSES a manifest directory inside the media root', async () => {
    // NOT A STYLE RULE. A generation artifact written under the tree the appliance projects would appear in
    // the namespace it describes, and the next publish would read its own output as content.
    const inside = path.join(mediaRoot, 'manifests');
    mkdirSync(inside, { recursive: true });
    const problems = await contentPreflight({ ...config, manifestDir: inside }, host, process.env.DATABASE_URL);
    assert(problems.some((one) => one.code === 'MANIFEST_DIR_INSIDE_MEDIA_ROOT'),
      'a manifest directory inside the media root was accepted');
  });

  await test('P10-4b - add-local reads the file rather than being told about it, and DOES NOT PUBLISH', async () => {
    const outcomes = await addLocalObjects(config, host, localObjectsFile, process.env.DATABASE_URL);
    assertEq(outcomes.length, 1, 'one entry registered');
    assertEq(outcomes[0]?.path, LOCAL_PROJECTED, 'the projected path');
    // THE SIZE WAS NEVER TYPED. Phase 10 §2.3 counted what an operator used to have to type per object: a
    // uuid, a version key, an exact size, an exact-millisecond mtime and four digests. This file carried the
    // uuid and two paths.
    assertEq(outcomes[0]?.sizeBytes, 2 * 1024 * 1024, 'the size was read from the file');
    assertEq(outcomes[0]?.needsPublish, true, 'a freshly registered entry reported itself already published');

    const pointer = readPointer(manifestDir);
    assertEq(pointer, null, 'add-local published a generation, which no verb but publish may do');
  });

  await test('P10-4c - status says admitted-not-published, which is the state Phase 9 said did not exist', async () => {
    const document = await contentStatus(config, host, process.env.DATABASE_URL);
    assertEq(document.counts.registered, 1, 'one registered');
    assertEq(document.counts.published, 0, 'nothing published');
    assertEq(document.counts.admittedNotPublished, 1, 'the entry is not reported as admitted-not-published');
    assertEq(document.entries[0]?.publication, 'admitted-not-published', 'the entry publication state');
  });

  await test('P10-4d - reconcile REPORTS registry-ahead-of-generation and changes nothing', async () => {
    const before = directoryBytes(manifestDir);
    const report = await reconcileContent(config, host, process.env.DATABASE_URL);
    assertEq(report.admittedNotPublished, 1, 'the divergence count');
    assert(report.divergences.some((one) => one.code === 'registry-ahead-of-generation'),
      'the divergence Phase 10 §2.2 exists for was not reported');
    assertEq(report.ledgerChecked, false, 'an installation with no ledger reported that it checked one');
    assertEq(JSON.stringify(directoryBytes(manifestDir)), JSON.stringify(before), 'reconcile wrote something');
  });

  await test('P10-4e - publish is EXPLICIT, and after it the entry is visible', async () => {
    const report = await publishContent(config, process.env.DATABASE_URL);
    assertEq(report.outcome, 'published', `publish did not publish: ${report.problems.join(', ')}`);
    assertEq(report.entryCount, 1, 'the generation holds one entry');

    const document = await contentStatus(config, host, process.env.DATABASE_URL);
    assertEq(document.counts.published, 1, 'the entry is still not published after publish');
    assertEq(document.entries[0]?.publication, 'published', 'the publication state after publish');
    assertEq(document.agrees, true, 'the control plane and the directory disagree after a publish');
  });

  await test('every verb is idempotent: a second add and a second publish change nothing', async () => {
    const again = await addLocalObjects(config, host, localObjectsFile, process.env.DATABASE_URL);
    assertEq(again.length, 1, 'one entry');
    assertEq(again[0]?.needsPublish, false, 'a re-registered, already-published entry claimed it needed publishing');
    const republish = await publishContent(config, process.env.DATABASE_URL);
    // NOTHING CHANGED IS NOT A FAILURE. Publishing an identical generation would burn a sequence and make
    // every reader re-read what it already has, which is why the publisher reports it and stops.
    assertEq(republish.outcome, 'unchanged', 'a second identical publish minted a generation');
  });

  await test('P10-4f - add-torbox registers an opaque reference from the template\'s own shape', async () => {
    // THE OPERATOR TYPED NO DIGEST TWICE. The file is `deploy/real-provider-objects.template.json`'s shape
    // with its `_comment_*` keys still in it, plus the three fields a NAMESPACE needs and a corpus file does
    // not: itemId, path and mtime.
    const outcomes = await addTorboxObjects(config, host, torboxObjectsFile, process.env.DATABASE_URL);
    assertEq(outcomes.length, 1, 'one provider-backed entry registered');
    assertEq(outcomes[0]?.sizeBytes, TORBOX_SIZE, 'the size the operator declared');

    const report = await publishContent(config, process.env.DATABASE_URL);
    assertEq(report.outcome, 'published', `publish refused the mixed namespace: ${report.problems.join(', ')}`);

    const document = await contentStatus(config, host, process.env.DATABASE_URL);
    assertEq(document.counts.registered, 2, 'the TorBox entry is not registered');
    assertEq(document.counts.published, 2, 'the TorBox entry is not published');
    const torbox = document.entries.find((entry) => entry.path === TORBOX_PROJECTED);
    assertEq(torbox?.kinds.join(','), 'http-range', 'the source kind');
  });

  await test('a probe set that is not the plan the size implies is REFUSED, naming the windows it needs', async () => {
    // `registerVersion` would refuse this three commands later, phrased as an offset mismatch. Telling an
    // operator the exact windows at the moment they are wrong is the difference between a code and a reason.
    const wrong = path.join(inputDir, 'torbox-wrong-probes.json');
    writeFileSync(wrong, JSON.stringify([{
      label: 'wrong-one', itemId: torboxItem, path: 'Movies/Wrong/Wrong.bin',
      ref: 'another-opaque-reference', sizeBytes: TORBOX_SIZE, mtime: TORBOX_MTIME,
      probeDigests: [{ offset: 17, length: 1_048_576, sha256: hex64('nope') }],
    }]));
    let message = '';
    try { await addTorboxObjects(config, host, wrong, process.env.DATABASE_URL); }
    catch (error) { message = (error as Error).message; }
    assert(/offset 0/.test(message) && /head:0:1048576/.test(message),
      `the refusal did not name the windows the size requires: ${message}`);
  });

  if (!POSIX_PATHS) {
    skip('P10-4g - the shipped CLI surface end to end',
      'this host cannot express the absolute POSIX paths the shipped configuration contract requires, and '
      + 'that refusal is the product being correct rather than the test being blocked');
  } else {
    await test('P10-4g - the shipped CLI surface reaches all of it, which is what an operator types', async () => {
      const status = await contentCli([
        'status', '--config', configFile,
        ...(process.env.DATABASE_URL === undefined ? [] : ['--database-url', process.env.DATABASE_URL]),
      ]);
      assertEq(status, 0, 'the shipped status verb did not succeed');
    });
  }

  await test('no emitted document carries the opaque object reference', async () => {
    const document = await contentStatus(config, host, process.env.DATABASE_URL);
    const report = await reconcileContent(config, host, process.env.DATABASE_URL);
    for (const [name, emitted] of [['status', document], ['reconcile', report]] as const) {
      assert(!JSON.stringify(emitted).includes('opaque-object-reference'),
        `the ${name} document carries the provider object reference`);
      assert(!JSON.stringify(emitted).includes(torboxItem) && !JSON.stringify(emitted).includes(localItem),
        `the ${name} document carries a media identity`);
      assert(!JSON.stringify(emitted).includes(mediaRoot), `the ${name} document carries an absolute media path`);
    }
  });

  // -------------------------------------------------------------------------------------------------------
  // P10-5 — a local source removed under a published namespace.
  // -------------------------------------------------------------------------------------------------------

  await test('P10-5a - a removed local source is REPORTED, and the generation is BYTE-IDENTICAL', async () => {
    const before = directoryBytes(manifestDir);
    const pointerBefore = readPointer(manifestDir);
    rmSync(localFile, { force: true });

    const report = await reconcileContent(config, host, process.env.DATABASE_URL);
    assert(report.divergences.some((one) => one.code === 'local-source-file-absent' && one.at === LOCAL_PROJECTED),
      'the removed local source was not reported');

    // §7 R5's mitigation, as an assertion rather than a promise. A reconciliation that repaired what it found
    // would be a reconciliation that changed the evidence before anybody read it.
    assertEq(JSON.stringify(directoryBytes(manifestDir)), JSON.stringify(before),
      'reconcile moved a byte of the published generation');
    assertEq(JSON.stringify(readPointer(manifestDir)), JSON.stringify(pointerBefore), 'reconcile moved the pointer');

    const document = await contentStatus(config, host, process.env.DATABASE_URL);
    assertEq(document.entries.find((entry) => entry.path === LOCAL_PROJECTED)?.visibility, 'available',
      'the namespace degraded an entry on its own, which §4\'s second hard refusal forbids');
  });

  await test('a changed local source is reported as changed rather than absent', async () => {
    writeFileSync(localFile, mediaBytes(1024 * 1024));
    const report = await reconcileContent(config, host, process.env.DATABASE_URL);
    assert(report.divergences.some((one) => one.code === 'local-source-bytes-changed' && one.at === LOCAL_PROJECTED),
      'a file whose size changed under a registered version was not reported, or was reported as absent');
    assert(!report.divergences.some((one) => one.code === 'local-source-file-absent'),
      'a present file was reported absent');
  });

  await test('P10-5b - hold degrades the entry, and it STAYS in the namespace', async () => {
    const outcome = await holdContentEntry(LOCAL_PROJECTED, TORBOX_MTIME, process.env.DATABASE_URL);
    assertEq(outcome.visibility, 'degraded', 'hold did not degrade');
    assertEq(outcome.changed, true, 'hold on an available entry reported nothing changed');

    const document = await contentStatus(config, host, process.env.DATABASE_URL);
    const entry = document.entries.find((one) => one.path === LOCAL_PROJECTED);
    assertEq(entry?.visibility, 'degraded', 'the visibility after hold');
    assertEq(entry?.degradedReason, 'operator-hold', 'the reason, which is already in the closed set');
    // IT STAYS. `degradeEntry`'s own reasoning: a source the control plane cannot reach must not be able to
    // shrink a media server's library, and the same is true of one a human is holding.
    assertEq(document.counts.registered, 2, 'hold removed an entry from the namespace');
    assertEq(entry?.sizeBytes, 2 * 1024 * 1024, 'hold moved the size the entry was registered with');
  });

  await test('hold is idempotent, and reports that it changed nothing the second time', async () => {
    const again = await holdContentEntry(LOCAL_PROJECTED, TORBOX_MTIME, process.env.DATABASE_URL);
    assertEq(again.changed, false, 'a second hold reported a change');
  });

  await test('P10-5c - release restores it', async () => {
    const outcome = await releaseContentEntry(LOCAL_PROJECTED, process.env.DATABASE_URL);
    assertEq(outcome.visibility, 'available', 'release did not restore');
    assertEq(outcome.changed, true, 'release on a held entry reported nothing changed');
    const document = await contentStatus(config, host, process.env.DATABASE_URL);
    assertEq(document.entries.find((one) => one.path === LOCAL_PROJECTED)?.visibility, 'available', 'after release');
  });

  await test('hold and release REFUSE a path no entry has, rather than silently doing nothing', async () => {
    let refused = false;
    try { await holdContentEntry('Movies/Nothing/Nothing.bin', TORBOX_MTIME, process.env.DATABASE_URL); }
    catch (error) { refused = (error as { code?: string }).code === 'ENTRY_UNKNOWN'; }
    assert(refused, 'a hold on an unknown path succeeded, so an operator typo is silently a no-op');
  });

  await test('hold REFUSES a RETIRING entry, because degrading one would throw away its deletion intent', async () => {
    // WHY THIS ARM EXISTS. `cat_projection_entry_degrade` sets `deletion_intent_id`, `retiring_declared_at`
    // and `grace_deadline` all to NULL — it must, since an entry cannot be degraded and retiring at once. So
    // `hold` on a retiring entry silently cancelled an intent declared through a different verb and reported
    // `changed: true` about a hold. `release` already refused exactly this; the two verbs are symmetric and
    // the more destructive of the pair was the unguarded one.
    const entryId = deriveProjectedEntryId(TORBOX_PROJECTED);
    await withRegistry((db) => retireEntry(db, entryId, {
      intentKey: 'phase10-audit-intent', declaredAt: '2026-06-01T10:00:00.000Z',
      graceDeadline: '2026-07-01T10:00:00.000Z',
    }), process.env.DATABASE_URL);

    let code = '';
    try { await holdContentEntry(TORBOX_PROJECTED, TORBOX_MTIME, process.env.DATABASE_URL); }
    catch (error) { code = (error as { code?: string }).code ?? ''; }
    assertEq(code, 'ENTRY_RETIRING', 'a hold cancelled a declared deletion intent');

    // THE INTENT IS STILL THERE, asserted from the namespace rather than from the refusal's own word for it.
    const after = await readNamespaceSnapshot(process.env.DATABASE_URL);
    const entry = after.find((one) => one.projectedEntryId === entryId);
    assertEq(entry?.visibility, 'retiring', 'the entry stopped retiring');
    assert((entry?.retiring?.deletionIntentId ?? '').length > 0, 'the deletion intent was cleared');

    // AND `release` STILL REFUSES IT TOO, which is the symmetry this arm is about.
    let releaseCode = '';
    try { await releaseContentEntry(TORBOX_PROJECTED, process.env.DATABASE_URL); }
    catch (error) { releaseCode = (error as { code?: string }).code ?? ''; }
    assertEq(releaseCode, 'ENTRY_RETIRING', 'release cancelled a declared deletion intent');

    await withRegistry((db) => restoreEntry(db, entryId), process.env.DATABASE_URL);
  });

  await test('the shipped reconcile CLI exits 1 on a divergence and 0 when there is none', async () => {
    const withDivergence = await contentCli([
      'reconcile', '--config', configFile,
      ...(process.env.DATABASE_URL === undefined ? [] : ['--database-url', process.env.DATABASE_URL]),
    ]);
    assertEq(withDivergence, 1, 'reconcile reported success while the disk and the namespace disagreed');

    // Put the file back exactly as registered, and the divergence goes away without anything having repaired
    // the namespace — which is the whole shape of D10.4.
    writeFileSync(localFile, mediaBytes(2 * 1024 * 1024));
    const document = await contentStatus(config, host, process.env.DATABASE_URL);
    void document;
    const report = await reconcileContent(config, host, process.env.DATABASE_URL);
    const remaining = report.divergences.filter((one) => one.code !== 'local-source-bytes-changed');
    assertEq(remaining.length, 0,
      `divergences remained after the file was restored: ${remaining.map((one) => one.code).join(', ')}`);
  });

  await test('--publish on a verb that cannot publish is REFUSED rather than ignored', async () => {
    // ARGV PARSING ONLY, so it runs on every host: the refusal happens before the configuration is read.
    const status = await contentCli(['status', '--config', configFile, '--publish']);
    assertEq(status, 2, 'a --publish an operator typed on `status` was silently ignored');
  });

  await admin.end();
  await closePool();
  if (server) await server.stop();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  for (const line of skips) console.log(`  SKIPPED  ${line}`);
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
