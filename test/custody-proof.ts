import { Client } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEmbedded } from './embedded-pg.js';
import { CatalogAuthority } from '../src/core/catalog/authority.js';
import { mintItemId } from '../src/core/catalog/events.js';
import { InMemoryCustodian } from '../src/core/crypto/custodian.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { getPool, migrate, adminUrl, closePool } from '../src/db/pool.js';
import { installCompletionSecret, testKek } from './crypto-setup.js';
import {
  DEFAULT_PROOF_SAMPLE,
  MAX_PROOF_SAMPLE,
  PROOF_OUTCOMES,
  proveCustody,
  readCustodyProof,
  renderCustodyProof,
} from '../src/ops/custody-proof.js';
import { parseSample, usage } from '../src/ops/custody-proof-cli.js';

// Phase 302 (corrected) — the proof that actually decrypts, proved against a real database and real keys.
//
// -----------------------------------------------------------------------------------------------------
// WHY THIS SUITE IS IN THE DATABASE GROUP AND NOT THE OFFLINE ONE.
// -----------------------------------------------------------------------------------------------------
//
// The claim is "this installation can decrypt its own catalog". Every part of that claim lives in the
// interaction between rows written by the real authority and key material held by a real custodian: the
// envelope, the AAD binding item and epoch, the custodian's key lookup, the lineage re-check at the
// linearization point. A suite that stubbed either half would prove that a stub agrees with itself.
//
// So this boots a real PostgreSQL, writes real encrypted items through `CatalogAuthority`, and then asks the
// shipped proof to decrypt them — first through the custodian that holds their keys, and then through a
// DIFFERENT custodian, which is what a restored keystore from another moment IS.
//
// THE PREVIOUS "PROOF" WOULD HAVE PASSED BOTH. It ran `ops:collections status`, which counts rows in the
// collection tables and never opens a key.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const WORK = mkdtempSync(join(tmpdir(), 'ca-custody-proof-'));
const TITLE = 'A Title That Must Never Appear In A Custody Proof';
const REF_VALUE = 'a-provider-reference-value-that-must-never-appear';

async function main(): Promise<void> {
  let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
  if (!process.env.DATABASE_URL) {
    console.log('Booting embedded PostgreSQL 16 ...');
    server = await startEmbedded();
  }
  await migrate();
  const pool = getPool();
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const secret = await installCompletionSecret(admin);

  async function reset(): Promise<void> {
    await admin.query("SET session_replication_role = 'replica'");
    await admin.query('TRUNCATE events, provider_refs, items, item_key_control RESTART IDENTITY CASCADE');
    await admin.query("SET session_replication_role = 'origin'");
  }

  console.log('Running Phase 302 custody proof suite:\n');

  // -------------------------------------------------------------------------------------------------
  // The proof, against the keys that actually encrypted the catalog
  // -------------------------------------------------------------------------------------------------

  await test('an installation holding its own keys DECRYPTS its catalog, and the proof says PROVEN', async () => {
    await reset();
    const custodian = new InMemoryCustodian(secret);
    const authority = new CatalogAuthority(pool, custodian);
    for (let i = 0; i < 3; i += 1) {
      await authority.addItem(mintItemId(), {
        title: `${TITLE} ${i}`, year: 1999 + i, providerRefs: [{ type: 'tmdb', value: `${REF_VALUE}-${i}` }],
      });
    }

    const report = await proveCustody(pool, custodian);
    assertEq(report.verdict, 'PROVEN', 'the verdict is PROVEN');
    assertEq(report.proven, true, 'and `proven` agrees with it');
    assertEq(report.encryptedRecords, 3, 'it found the three encrypted records');
    assertEq(report.attempted, 3, 'and attempted all three');
    assertEq(report.outcomes.decrypted, 3, 'and decrypted all three');
    for (const outcome of PROOF_OUTCOMES) {
      if (outcome !== 'decrypted') assertEq(report.outcomes[outcome], 0, `nothing was ${outcome}`);
    }
    assertEq(report.wrote, 'nothing', 'and it wrote nothing');
  });

  // -------------------------------------------------------------------------------------------------
  // THE CASE THE WHOLE TRANCHE EXISTS FOR
  // -------------------------------------------------------------------------------------------------

  await test('a keystore from ANOTHER moment fails the proof — which is what a wrong restore leaves', async () => {
    await reset();
    const real = new InMemoryCustodian(secret);
    const authority = new CatalogAuthority(pool, real);
    for (let i = 0; i < 2; i += 1) {
      await authority.addItem(mintItemId(), { title: `${TITLE} ${i}`, year: 2001 });
    }

    // A DIFFERENT CUSTODIAN, holding no key for any of these items. That is precisely the state of an
    // installation restored with a keystore that did not come from the same moment as its database — and it
    // is a state in which the doctor, the schema version and the whole web UI still report themselves fine.
    const foreign = new InMemoryCustodian(secret);
    const report = await proveCustody(pool, foreign);
    assertEq(report.verdict, 'NOT_PROVEN', 'the verdict is NOT_PROVEN');
    assertEq(report.proven, false, 'and it does not claim custody');
    assertEq(report.encryptedRecords, 2, 'the records are there');
    assertEq(report.attempted, 2, 'and both were attempted');
    assertEq(report.outcomes.decrypted, 0, 'and NEITHER decrypted');
    assertEq(report.outcomes['key-not-found'], 2, 'because this keystore never held their keys');
  });

  await test('a real FileCustodian keystore proves custody, and a second empty one does not', async () => {
    await reset();
    const kek = testKek();
    const mine = join(WORK, 'keystore-mine');
    const theirs = join(WORK, 'keystore-theirs');
    const custodian = new FileCustodian(mine, secret, kek);
    const authority = new CatalogAuthority(pool, custodian);
    await authority.addItem(mintItemId(), { title: TITLE, year: 1999 });

    const good = await proveCustody(pool, custodian);
    assertEq(good.verdict, 'PROVEN', 'the keystore that wrapped the key opens it');

    // THE SAME KEK, A DIFFERENT KEYSTORE DIRECTORY. Restoring a database beside an empty keystore is the
    // silent failure the whole backup component model exists to prevent, and this is what it looks like.
    const empty = new FileCustodian(theirs, secret, kek);
    const bad = await proveCustody(pool, empty);
    assertEq(bad.verdict, 'NOT_PROVEN', 'an empty keystore proves nothing');
    assertEq(bad.outcomes.decrypted, 0, 'and decrypts nothing');
  });

  // -------------------------------------------------------------------------------------------------
  // The honest empty case
  // -------------------------------------------------------------------------------------------------

  await test('an empty catalog reports NO_ENCRYPTED_RECORDS and does NOT claim custody was proven', async () => {
    await reset();
    const report = await proveCustody(pool, new InMemoryCustodian(secret));
    assertEq(report.verdict, 'NO_ENCRYPTED_RECORDS', 'the verdict names the state');
    assertEq(report.proven, false, 'AND IT IS NOT A PASS — there was nothing to prove custody with');
    assertEq(report.encryptedRecords, 0, 'there are no encrypted records');
    assertEq(report.attempted, 0, 'so nothing was attempted');
    assert(report.notes.some((note) => note.includes('CUSTODY WAS NOT PROVEN')),
      'and the report says so in words, not only in a flag');
  });

  await test('a forgotten record is not counted as an encrypted one it failed to read', async () => {
    await reset();
    const custodian = new InMemoryCustodian(secret);
    const authority = new CatalogAuthority(pool, custodian);
    const kept = mintItemId();
    const gone = mintItemId();
    await authority.addItem(kept, { title: TITLE });
    await authority.addItem(gone, { title: `${TITLE} 2` });
    await authority.forget(gone);

    const report = await proveCustody(pool, custodian);
    // A CORRECTLY ERASED RECORD IS NOT A CUSTODY FAILURE. Counting it as one would make every installation
    // that has ever used `forget` fail its own restore proof.
    assertEq(report.encryptedRecords, 1, 'only the surviving record is in the population');
    assertEq(report.verdict, 'PROVEN', 'and the proof holds');
    assertEq(report.outcomes.decrypted, 1, 'having decrypted the one that is there');
  });

  // -------------------------------------------------------------------------------------------------
  // The bound
  // -------------------------------------------------------------------------------------------------

  await test('the sample is bounded, deterministic, and the report says what it did not attempt', async () => {
    await reset();
    const custodian = new InMemoryCustodian(secret);
    const authority = new CatalogAuthority(pool, custodian);
    for (let i = 0; i < 5; i += 1) await authority.addItem(mintItemId(), { title: `${TITLE} ${i}` });

    const report = await proveCustody(pool, custodian, { sample: 2 });
    assertEq(report.encryptedRecords, 5, 'it says how many exist');
    assertEq(report.attempted, 2, 'and how many it tried');
    assertEq(report.sampleBound, 2, 'and what the bound was');
    assertEq(report.verdict, 'PROVEN', 'a bounded proof over a sample still proves that sample');
    assert(report.notes.some((note) => note.includes('proof over a sample is a proof about that sample')),
      'and it says so rather than implying it covered everything');

    // DETERMINISTIC: the same two records, in the same order, on a second run against an unchanged catalog.
    const again = await proveCustody(pool, custodian, { sample: 2 });
    assertEq(again.attempted, report.attempted, 'the second run attempted the same number');
    assertEq(again.outcomes.decrypted, report.outcomes.decrypted, 'with the same result');

    assertEq(DEFAULT_PROOF_SAMPLE > 0 && DEFAULT_PROOF_SAMPLE <= MAX_PROOF_SAMPLE, true, 'the default is inside the bound');
    for (const bad of [0, -1, 1.5, MAX_PROOF_SAMPLE + 1]) {
      let refused = false;
      try { await proveCustody(pool, custodian, { sample: bad }); } catch { refused = true; }
      assertEq(refused, true, `a sample of ${bad} is refused`);
    }
  });

  // -------------------------------------------------------------------------------------------------
  // Redaction
  // -------------------------------------------------------------------------------------------------

  await test('no title, provider reference, item id or key id reaches any surface of this proof', async () => {
    await reset();
    const custodian = new InMemoryCustodian(secret);
    const authority = new CatalogAuthority(pool, custodian);
    const id = mintItemId();
    await authority.addItem(id, { title: TITLE, year: 1999, providerRefs: [{ type: 'tmdb', value: REF_VALUE }] });

    for (const report of [await proveCustody(pool, custodian), await proveCustody(pool, new InMemoryCustodian(secret))]) {
      for (const surface of [JSON.stringify(report), renderCustodyProof(report)]) {
        assertEq(surface.includes(TITLE), false, 'no title reaches a surface');
        assertEq(surface.includes(REF_VALUE), false, 'no provider reference value reaches a surface');
        assertEq(surface.includes(id), false, 'no item id reaches a surface');
        assertEq(surface.includes(WORK), false, 'no host path reaches a surface');
        assertEq(/1999/.test(surface), false, 'not even the year');
      }
    }
  });

  // -------------------------------------------------------------------------------------------------
  // The wire contract the restore consumes
  // -------------------------------------------------------------------------------------------------

  await test('the report survives its own reader, and a body that is not this contract is refused', async () => {
    await reset();
    const custodian = new InMemoryCustodian(secret);
    await new CatalogAuthority(pool, custodian).addItem(mintItemId(), { title: TITLE });
    const real = await proveCustody(pool, custodian);
    const round = readCustodyProof(JSON.stringify(real));
    assert(round !== null, 'a real report reads back');
    assertEq(round!.verdict, 'PROVEN', 'with its verdict intact');

    // EVERY WAY A BODY CAN LIE, refused. These are the shapes a hostile or truncated answer takes, and the
    // restore acts on this verdict — so a reader that accepted any of them would be the whole proof's hole.
    const base = JSON.parse(JSON.stringify(real)) as Record<string, unknown>;
    const mutations: Array<[string, Record<string, unknown>]> = [
      ['a claimed pass with proven false', { ...base, proven: false }],
      ['proven true under a NOT_PROVEN verdict', { ...base, verdict: 'NOT_PROVEN' }],
      ['a verdict this build does not know', { ...base, verdict: 'MAYBE', proven: false }],
      ['another report entirely', { ...base, report: 'phase-278-backup-verification' }],
      ['a version this build does not write', { ...base, version: 99 }],
      ['counts that do not add up to the attempt', { ...base, attempted: 9 }],
      ['PROVEN with nothing attempted', { ...base, attempted: 0, outcomes: { ...(base.outcomes as object), decrypted: 0 } }],
      ['NO_ENCRYPTED_RECORDS over a populated catalog', { ...base, verdict: 'NO_ENCRYPTED_RECORDS', proven: false }],
      ['a negative count', { ...base, outcomes: { ...(base.outcomes as object), 'key-not-found': -1 } }],
    ];
    for (const [why, body] of mutations) {
      assertEq(readCustodyProof(JSON.stringify(body)), null, `refused: ${why}`);
    }
    assertEq(readCustodyProof('not json'), null, 'a body that is not JSON is refused');
    assertEq(readCustodyProof(JSON.stringify([1, 2, 3])), null, 'an array is refused');
    assertEq(readCustodyProof('x'.repeat(70 * 1024)), null, 'an unbounded body is refused before it is parsed');
  });

  await test('the CLI states its bound, refuses a sample outside it, and documents its exit codes', () => {
    const text = usage();
    assert(text.includes('--sample'), 'the bound is an option');
    assert(text.includes('exit codes'), 'and the exit codes are documented');
    assert(text.includes('4 nothing encrypted to prove'), 'including the one that is not a pass');
    assertEq(parseSample(['--json']), undefined, 'no sample means the default');
    assertEq(parseSample(['--sample', '5']), 5, 'a sample parses');
    for (const bad of ['0', '-3', 'x', String(MAX_PROOF_SAMPLE + 1)]) {
      let refused = false;
      try { parseSample(['--sample', bad]); } catch { refused = true; }
      assertEq(refused, true, `--sample ${bad} is refused`);
    }
  });

  await admin.end();
  await closePool();
  if (server) await server.stop();

  console.log('');
  if (failed > 0) {
    console.log('Failures:');
    for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? String(err)}`);
  }
  console.log(`${passed} passed, ${failed} failed`);
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* a temp directory that will not go is not a failure */ }
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
