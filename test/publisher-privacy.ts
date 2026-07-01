import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import type { KeyCustodian, ProvisionResult, DestructionReceipt, KeyStatus, StaleProvisioning } from '../src/core/crypto/custodian.js';
import { FakePublisherAdapter } from '../src/core/adapters/fake-publisher.js';
import { getPool, migrate, adminUrl, closePool } from '../src/db/pool.js';
import { installCompletionSecret, testKek } from './crypto-setup.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }
const tmpDirs: string[] = [];
const freshKeystore = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'publisher-')); tmpDirs.push(d); return d; };

const TITLE = 'SECRET-PUB-TITLE';
const EXTID = 'tt-pub-secret';
const META = 'META-SECRET-note';
const REF = 'PUB-REF-99';

/** Wraps a custodian and runs a hook once, on the SECOND status() call — injects a concurrent
 * forget into the bridge's recheck window (TOCTOU regression). Guarded against re-entry. */
class HookOnRecheckCustodian implements KeyCustodian {
  statusCalls = 0;
  private fired = false;
  constructor(private readonly inner: KeyCustodian, private readonly onSecondStatus: () => Promise<void>) {}
  provision(op: string, item: string, epoch: number): Promise<ProvisionResult> { return this.inner.provision(op, item, epoch); }
  commitProvision(op: string): Promise<void> { return this.inner.commitProvision(op); }
  get(keyId: string, epoch: number): Promise<Buffer> { return this.inner.get(keyId, epoch); }
  destroy(op: string, keyId: string): Promise<DestructionReceipt> { return this.inner.destroy(op, keyId); }
  listStaleProvisioning(): Promise<StaleProvisioning[]> { return this.inner.listStaleProvisioning(); }
  async status(keyId: string): Promise<KeyStatus> {
    this.statusCalls++;
    if (this.statusCalls === 2 && !this.fired) { this.fired = true; await this.onSecondStatus(); }
    return this.inner.status(keyId);
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
  const kek = testKek();
  const auth = new CatalogAuthority(pool, new FileCustodian(freshKeystore(), secret, kek));
  const count = async (sql: string): Promise<number> => Number((await pool.query(sql)).rows[0].c);

  const id = mintItemId();
  await auth.addItem(id, { title: TITLE, year: 2024, externalIds: { imdb: EXTID }, metadata: { note: META }, providerRefs: [{ type: 'tmdb', value: REF }] });

  console.log('Running Phase 8 publisher privacy suite (Stage 8.4):\n');

  // 1. minimized disclosure — only declared fields; NEVER externalIds/metadata --
  await test('withPublishableIdentity — discloses only declared fields; no externalIds/metadata', async () => {
    const pi = await auth.withPublishableIdentity(id, ['title', 'year', 'providerRefs'], (x) => x);
    assert(pi !== null, 'identity disclosed');
    assertEq(Object.keys(pi!).sort().join(','), 'itemId,providerRefs,title,year', 'exactly the declared keys + itemId');
    assertEq(pi!.title, TITLE, 'title'); assertEq(pi!.year, 2024, 'year');
    assertEq(pi!.providerRefs?.[0]?.value, REF, 'provider ref value');
    const blob = JSON.stringify(pi);
    assert(!blob.includes(EXTID), 'no externalIds leaked'); assert(!blob.includes(META), 'no metadata leaked');
    assert(!blob.includes('externalIds') && !blob.includes('metadata'), 'no externalIds/metadata keys at all');
  });

  // 2. field minimization by `requires` --------------------------------------
  await test('withPublishableIdentity — requires:[title] yields only { itemId, title }', async () => {
    const pi = await auth.withPublishableIdentity(id, ['title'], (x) => x);
    assertEq(Object.keys(pi!).sort().join(','), 'itemId,title', 'only itemId + title');
  });
  await test('withPublishableIdentity — requires:[year] yields only { itemId, year }', async () => {
    const pi = await auth.withPublishableIdentity(id, ['year'], (x) => x);
    assertEq(Object.keys(pi!).sort().join(','), 'itemId,year', 'only itemId + year');
  });

  // 3. SecretStore registration during scope + cleared after -------------------
  await test('withPublishableIdentity — disclosed strings registered during scope + cleared', async () => {
    assertEq(auth.secrets.size(), 0, 'no registrations before');
    let inside = -1;
    await auth.withPublishableIdentity(id, ['title', 'providerRefs'], () => { inside = auth.secrets.size(); });
    assert(inside >= 1, 'disclosed strings registered during the scope');
    assertEq(auth.secrets.size(), 0, 'registrations cleared after the scope');
  });

  // 4. disclosed identity redacted in logs ------------------------------------
  await test('withPublishableIdentity — disclosed title/ref are redacted in logs', async () => {
    await auth.withPublishableIdentity(id, ['title', 'providerRefs'], (pi) => {
      const lines: string[] = [];
      const log = auth.createLogger((l) => lines.push(l));
      log.info(`publishing ${pi.title} ref ${pi.providerRefs?.[0]?.value}`);
      const blob = lines.join('\n');
      assert(!blob.includes(TITLE) && !blob.includes(REF), 'title + ref masked in logs');
    });
  });

  // 5. curious publisher sees only declared fields; dry-run advisory; no DB write
  await test('withPublishableIdentity — publisher sees only declared fields; dry-run advisory; no DB write', async () => {
    const pub = new FakePublisherAdapter(['title', 'year', 'providerRefs']);
    const evBefore = await count('SELECT count(*) AS c FROM events');
    const refBefore = await count('SELECT count(*) AS c FROM provider_refs');
    const result = await auth.withPublishableIdentity(id, pub.requires, (pi) => pub.publish({ identity: pi, dryRun: true }));
    assert(result !== null && result.status === 'skipped' && result.dryRun === true, 'advisory dry-run result');
    assertEq(pub.seen.length, 1, 'publisher invoked once');
    assertEq(Object.keys(pub.seen[0]!).sort().join(','), 'itemId,providerRefs,title,year', 'publisher saw only declared fields');
    assert(!JSON.stringify(pub.seen).includes(EXTID) && !JSON.stringify(pub.seen).includes(META), 'publisher never saw externalIds/metadata');
    assertEq(pub.published.length, 0, 'dry-run wrote nothing to the sink');
    assertEq(await count('SELECT count(*) AS c FROM events'), evBefore, 'no events written (advisory)');
    assertEq(await count('SELECT count(*) AS c FROM provider_refs'), refBefore, 'no provider_refs written');
  });

  // 6. a live publish writes only to the local sink (still no DB write) --------
  await test('withPublishableIdentity — live publish hits the local sink only; still no DB write', async () => {
    const pub = new FakePublisherAdapter(['title']);
    const evBefore = await count('SELECT count(*) AS c FROM events');
    const result = await auth.withPublishableIdentity(id, pub.requires, (pi) => pub.publish({ identity: pi, dryRun: false }));
    assert(result !== null && result.status === 'published' && typeof result.handle === 'string', 'published + handle');
    assertEq(pub.published.length, 1, 'recorded to the local in-memory sink');
    assertEq(await count('SELECT count(*) AS c FROM events'), evBefore, 'no events written by the publish path');
  });

  // 7. fail-closed on a forgotten item ----------------------------------------
  await test('withPublishableIdentity — fail-closed on a forgotten item', async () => {
    const gone = mintItemId();
    await auth.addItem(gone, { title: 'gone', providerRefs: [{ type: 'tmdb', value: 'x' }] });
    await auth.forget(gone);
    assertEq(await auth.withPublishableIdentity(gone, ['title'], () => 'called'), null, 'forgotten -> null');
    assertEq(auth.secrets.size(), 0, 'no lingering registrations');
  });

  // 8. TOCTOU: forget landing DURING the bridge must fail closed ---------------
  await test('withPublishableIdentity — fail-closed if the item is forgotten during the bridge (TOCTOU)', async () => {
    const id2 = mintItemId();
    const inner = new FileCustodian(freshKeystore(), secret, kek);
    let auth2!: CatalogAuthority;
    const custodian2 = new HookOnRecheckCustodian(inner, async () => { await auth2.forget(id2); });
    auth2 = new CatalogAuthority(pool, custodian2);
    await auth2.addItem(id2, { title: 'Forget Me', metadata: { note: META }, providerRefs: [{ type: 'tmdb', value: 'TR' }] });

    const pub = new FakePublisherAdapter(['title']);
    const result = await auth2.withPublishableIdentity(id2, pub.requires, (pi) => pub.publish({ identity: pi, dryRun: false }));
    assertEq(result, null, 'forgotten mid-bridge -> fail closed (null)');
    assertEq(pub.seen.length, 0, 'publisher NEVER received the identity');
    assertEq(auth2.secrets.size(), 0, 'no lingering registrations');
    assert((await pool.query('SELECT forgotten FROM items WHERE id=$1', [id2])).rows[0].forgotten === true, 'sanity: item was forgotten mid-bridge');
  });

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  await admin.end();
  await closePool();
  if (server) await server.stop();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
