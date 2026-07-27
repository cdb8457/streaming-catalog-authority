import { Client } from 'pg';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ItemIdentity } from '../src/core/catalog/authority.js';
import type { CatalogReader } from '../src/ops/operator-ui-catalog-browse.js';
import {
  COLLECTION_NAME_MAX_LENGTH,
  COLLECTION_PLAN_MAX_ITEMS,
  COLLECTION_PLAN_TARGET,
  buildCollectionPlan,
  canonical,
  createLedgerReader,
  digest,
  isUsableCollectionName,
  parseItemIds,
  type CollectionPlan,
  type LedgerIntentState,
  type LedgerReader,
} from '../src/ops/collection-plan.js';
import {
  COLLECTION_CONFIRMATION_MAX_LENGTH,
  COLLECTION_CONFIRMATION_TTL_MS,
  CollectionConfirmations,
} from '../src/ops/collection-confirmation.js';
import {
  COLLECTIONS_PLAN_ROUTE,
  collectionHistoryResponse,
  collectionPlanResponse,
} from '../src/ops/operator-ui-collections-endpoint.js';
import { createCollectionHistoryStore, renderCollectionHistory } from '../src/ops/collection-history.js';
import { MIGRATION_VERSION } from '../src/db/schema-version.js';
import { MIGRATED_TABLES, migrateWith } from '../src/db/pool.js';
import { startEmbedded } from './embedded-pg.js';
import { installCompletionSecret } from './crypto-setup.js';

// Phase 267 — deterministic collection PLANNING, and the preview that writes nothing.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - A PLAN IS DETERMINISTIC. The same catalog, the same ledger and the same name produce the same actions,
//     in the same order, with the same two digests — whatever order the selection arrived in.
//   - THE TWO DIGESTS MEAN DIFFERENT THINGS. The plan digest covers what would be done; the basis digest
//     covers what it was decided from. A title corrected between preview and confirmation moves the basis
//     without moving the plan, and that is exactly the case a single digest would miss.
//   - PLANNING CONTACTS NOTHING AND WRITES NOTHING. Proved structurally (the function is handed two readers)
//     and empirically (row, event and ledger counts across a real PostgreSQL are unchanged by a whole
//     planning session).
//   - REVOKES COME FROM ERASURE, NOT FROM THE SELECTION. A record that is merely not selected is never
//     proposed for revocation.
//   - THE CONFIRMATION IS SINGLE-USE, EXPIRING, PER-PROCESS AND DIGEST-BOUND. Replay, forgery, a confirmation
//     from another process, an expired one, and a mismatched echo are each refused.
//   - THE HISTORY IS DURABLE AND IDENTITY-FREE, and the database itself refuses an unsafe row.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').split('\r\n').join('\n');

const WORK = mkdtempSync(join(tmpdir(), 'ca-collection-plan-'));
const SECRET_REF = 'tt-phase267-ref-value-must-never-be-planned';

// --- an in-memory catalog and ledger, so the plan's cases are exhaustive rather than expensive -------------

function idFor(n: number): string {
  return `00000000-0000-5000-8000-${n.toString(16).padStart(12, '0')}`;
}

interface FakeRecord { itemId: string; identity: ItemIdentity }

function record(n: number, identity: Partial<ItemIdentity> & { title: string }): FakeRecord {
  return {
    itemId: idFor(n),
    identity: {
      title: identity.title,
      year: identity.year ?? null,
      externalIds: identity.externalIds ?? { 'my-library': `x-${n}` },
      metadata: identity.metadata ?? {},
      providerRefs: identity.providerRefs ?? [{ type: 'imdb', value: `${SECRET_REF}-${n}` }],
    },
  };
}

function fakeReader(records: readonly FakeRecord[]): CatalogReader {
  const sorted = [...records].sort((a, b) => a.itemId.localeCompare(b.itemId, 'en'));
  return {
    countActive: () => Promise.resolve(sorted.length),
    listActiveIds: (limit, offset) => Promise.resolve(sorted.slice(offset, offset + limit).map((r) => r.itemId)),
    readIdentity: (itemId) => Promise.resolve(sorted.find((r) => r.itemId === itemId)?.identity ?? null),
  };
}

function fakeLedger(intents: readonly LedgerIntentState[]): LedgerReader {
  return { listIntents: (target) => Promise.resolve(intents.filter((i) => i.status !== '' && target === COLLECTION_PLAN_TARGET)) };
}

const emptyLedger = fakeLedger([]);

async function planOf(
  records: readonly FakeRecord[],
  intents: readonly LedgerIntentState[],
  input: { name: unknown; itemIds?: unknown; search?: unknown },
): Promise<CollectionPlan> {
  const result = await buildCollectionPlan(fakeReader(records), fakeLedger(intents), input);
  assert(result.ok, `the plan was rejected: ${result.ok ? '' : result.rejection}`);
  return result.plan;
}

async function main(): Promise<void> {
  console.log('Running Phase 267 collection planning suite:\n');

  const three = [
    record(1, { title: 'Alpha', year: 1994 }),
    record(2, { title: 'Bravo', year: 2001 }),
    record(3, { title: 'Charlie' }),
  ];
  const allIds = three.map((r) => r.itemId);

  // -------------------------------------------------------------------------------------------------------
  // Determinism and the two digests.
  // -------------------------------------------------------------------------------------------------------

  await test('the same catalog, ledger and name produce the same plan, however the selection was ordered', async () => {
    const first = await planOf(three, [], { name: 'Weekend picks', itemIds: allIds });
    const shuffled = await planOf(three, [], { name: 'Weekend picks', itemIds: [allIds[2], allIds[0], allIds[1], allIds[0]] });
    assertEq(shuffled.planDigest, first.planDigest, 'a reordered, duplicated selection is the same plan');
    assertEq(shuffled.basisDigest, first.basisDigest, 'and the same basis');
    assertEq(JSON.stringify(shuffled.actions), JSON.stringify(first.actions), 'and the same actions, in the same order');
    assertEq(first.counts.selected, 3, 'the duplicate collapsed rather than being counted twice');
    assertEq(first.counts.create, 3, 'three unpublished records are three creates');
    assertEq(first.noop, false, 'a plan with work to do is not a no-op');
    // A digest is a full sha256 — the thing an operator has to type back, and the thing the schema checks.
    assert(/^[0-9a-f]{64}$/.test(first.planDigest), 'the plan digest is 64 hex characters');
    assert(/^[0-9a-f]{64}$/.test(first.basisDigest), 'and so is the basis digest');
    assert(first.planDigest !== first.basisDigest, 'and the two are domain-separated');
  });

  await test('a different name is a different plan; a different catalog is a different basis', async () => {
    const base = await planOf(three, [], { name: 'Weekend picks', itemIds: allIds });
    const renamed = await planOf(three, [], { name: 'Weeknight picks', itemIds: allIds });
    assert(renamed.planDigest !== base.planDigest, 'the name is part of what would be done');

    // A TITLE CHANGE MOVES THE BASIS AND NOT THE PLAN. This is the case a single digest would miss, and the
    // reason there are two.
    const retitled = [record(1, { title: 'Alpha, restored', year: 1994 }), three[1]!, three[2]!];
    const moved = await planOf(retitled, [], { name: 'Weekend picks', itemIds: allIds });
    assertEq(moved.planDigest, base.planDigest, 'the ACTIONS are unchanged by a corrected title');
    assert(moved.basisDigest !== base.basisDigest, 'but the BASIS is not');

    // So does a changed provider reference VALUE, which never appears in a plan at all.
    const rereferenced = [record(1, { title: 'Alpha', year: 1994, providerRefs: [{ type: 'imdb', value: 'tt-different' }] }), three[1]!, three[2]!];
    const movedRef = await planOf(rereferenced, [], { name: 'Weekend picks', itemIds: allIds });
    assertEq(movedRef.planDigest, base.planDigest, 'a changed reference value does not change the actions');
    assert(movedRef.basisDigest !== base.basisDigest, 'but it does change the basis');

    // And so does a ledger row moving under it.
    const settled = await planOf(three, [
      { intentId: '1', itemId: allIds[0]!, status: 'published', settled: true },
    ], { name: 'Weekend picks', itemIds: allIds });
    assert(settled.planDigest !== base.planDigest, 'a published record changes what would be done');
    assert(settled.basisDigest !== base.basisDigest, 'and what it was decided from');
  });

  await test('a plan never carries a provider reference value, only its type and a count', async () => {
    const plan = await planOf(three, [], { name: 'Weekend picks', itemIds: allIds });
    const text = JSON.stringify(plan);
    assert(!text.includes(SECRET_REF), 'a plan disclosed a provider reference value');
    assert(text.includes('imdb'), 'but it does say which TYPE of reference is present');
    assertEq(plan.actions[0]!.refCount, 1, 'and how many there are');
    assertEq(plan.actions[0]!.title, 'Alpha', 'and the title the catalog panel already shows');
  });

  // -------------------------------------------------------------------------------------------------------
  // What each action means.
  // -------------------------------------------------------------------------------------------------------

  await test('every ledger state maps to exactly one action, and an unreadable record is blocked not dropped', async () => {
    const cases: Array<[string, string, string]> = [
      ['planned', 'update', 'INTENT_UNFINISHED'],
      ['in_flight', 'update', 'INTENT_UNFINISHED'],
      ['ambiguous', 'update', 'INTENT_UNFINISHED'],
      ['published', 'unchanged', 'ALREADY_PUBLISHED'],
      ['revoke_pending', 'unchanged', 'ALREADY_PUBLISHED'],
      ['revoked', 'create', 'NOT_PUBLISHED'],
      ['failed', 'create', 'NOT_PUBLISHED'],
    ];
    for (const [status, action, reason] of cases) {
      const plan = await planOf([three[0]!], [{ intentId: '9', itemId: allIds[0]!, status, settled: status === 'published' }],
        { name: 'One', itemIds: [allIds[0]] });
      assertEq(plan.actions.length, 1, `${status} produced one action`);
      assertEq(plan.actions[0]!.action, action as never, `${status} action`);
      assertEq(plan.actions[0]!.reason, reason as never, `${status} reason`);
      assertEq(plan.actions[0]!.intentId, '9', `${status} names the ledger row it concerns`);
    }

    // A record with no provider reference cannot be matched to a library item, so it is BLOCKED and counted.
    const noRefs = await planOf([record(4, { title: 'Delta', providerRefs: [] })], [], { name: 'One', itemIds: [idFor(4)] });
    assertEq(noRefs.actions[0]!.action, 'blocked', 'a record with no reference is blocked');
    assertEq(noRefs.actions[0]!.reason, 'NO_PROVIDER_REFS', 'and it says why');
    assertEq(noRefs.counts.blocked, 1, 'and it is counted rather than dropped');
    assertEq(noRefs.noop, true, 'a plan of only blocked records changes nothing');

    // A record that cannot be read at all — forgotten, shredded, or never present — is also blocked.
    const unreadable = await planOf([], [], { name: 'One', itemIds: [idFor(99)] });
    assertEq(unreadable.actions[0]!.action, 'blocked', 'an unreadable record is blocked');
    assertEq(unreadable.actions[0]!.reason, 'UNREADABLE', 'and it says why');
    assertEq(unreadable.actions[0]!.title, null, 'and it claims no title it could not read');
  });

  await test('a revoke comes from erasure, and never from a record merely not being selected', async () => {
    // Record 1 is published and readable, and NOT selected. It must not be proposed for revocation.
    const notSelected = await planOf(three, [
      { intentId: '1', itemId: allIds[0]!, status: 'published', settled: true },
    ], { name: 'Others', itemIds: [allIds[1], allIds[2]] });
    assertEq(notSelected.counts.revoke, 0, 'a published record outside the selection is left alone');

    // Record 9 is published and NO LONGER READABLE. That is an erasure that has to reach outside, and it is
    // proposed whether or not anybody selected it.
    const forgotten = await planOf(three, [
      { intentId: '7', itemId: idFor(9), status: 'published', settled: true },
    ], { name: 'Others', itemIds: [allIds[1], allIds[2]] });
    assertEq(forgotten.counts.revoke, 1, 'a published copy of a forgotten record is proposed for revocation');
    const revoke = forgotten.actions.find((a) => a.action === 'revoke')!;
    assertEq(revoke.itemId, idFor(9), 'and it names the row it concerns');
    assertEq(revoke.reason, 'FORGOTTEN', 'and it says why');
    assertEq(revoke.title, null, 'and it claims no title for a record it cannot read');

    // A forgotten record that was never published needs nothing: there is no external copy to bring back.
    const neverPublished = await planOf(three, [
      { intentId: '8', itemId: idFor(9), status: 'revoked', settled: true },
    ], { name: 'Others', itemIds: [allIds[1]] });
    assertEq(neverPublished.counts.revoke, 0, 'an already-revoked row is not revoked again');
  });

  await test('the LATEST ledger row for a record decides its state, not the oldest', async () => {
    const plan = await planOf([three[0]!], [
      { intentId: '1', itemId: allIds[0]!, status: 'revoked', settled: true },
      { intentId: '2', itemId: allIds[0]!, status: 'published', settled: true },
    ], { name: 'One', itemIds: [allIds[0]] });
    assertEq(plan.actions[0]!.action, 'unchanged', 'a republished record is judged by its newest row');
    assertEq(plan.actions[0]!.intentId, '2', 'and the newest row is the one it names');
  });

  // -------------------------------------------------------------------------------------------------------
  // Selection and refusals.
  // -------------------------------------------------------------------------------------------------------

  await test('a search-driven selection is deterministic, bounded, and matches what the catalog panel matches', async () => {
    const plan = await planOf(three, [], { name: 'Alphas', search: 'alph' });
    assertEq(plan.counts.selected, 1, 'the search matched exactly one record');
    assertEq(plan.actions[0]!.title, 'Alpha', 'and it is the right one');
    // The operator's own external id is searchable too, exactly as it is in the catalog panel.
    const byExternalId = await planOf(three, [], { name: 'ById', search: 'x-2' });
    assertEq(byExternalId.actions[0]!.title, 'Bravo', 'searching an external id finds the record');
    // Two runs of the same search are the same plan.
    const again = await planOf(three, [], { name: 'Alphas', search: 'alph' });
    assertEq(again.planDigest, plan.planDigest, 'the same search twice is the same plan');
  });

  await test('a name outside the closed grammar is refused, and the marker delimiters are refused by name', async () => {
    for (const good of ['A', 'Weekend picks', "Bob's list", 'Sci-Fi (1980s)', 'A.B_C+D:E', 'a'.repeat(COLLECTION_NAME_MAX_LENGTH)]) {
      assert(isUsableCollectionName(good), `${good} should be a usable name`);
    }
    for (const bad of [
      '', ' ', ' leading', 'trailing ', '-starts-with-punctuation', 'a'.repeat(COLLECTION_NAME_MAX_LENGTH + 1),
      'has [cat:x] marker', 'bracket [', 'bracket ]', 'newline\nname', 'tab\tname', 'null\u0000name',
      'semi;colon', 'quote"name', 'back\\slash', 'slash/name', 'percent%name', 'star*name',
      undefined, null, 42, {}, [],
    ] as unknown[]) {
      assert(!isUsableCollectionName(bad), `${JSON.stringify(bad)} must not be a usable name`);
      const result = await buildCollectionPlan(fakeReader(three), emptyLedger, { name: bad, itemIds: allIds });
      assert(!result.ok && result.rejection === 'BAD_NAME', `${JSON.stringify(bad)} must be refused by the planner`);
    }
  });

  await test('a selection that cannot be reproduced is refused whole, never partially planned', async () => {
    const cases: Array<[unknown, string]> = [
      [['not-a-uuid'], 'BAD_SELECTION'],
      [[allIds[0], 'not-a-uuid'], 'BAD_SELECTION'],
      [[allIds[0], 42], 'BAD_SELECTION'],
      [[allIds[0], null], 'BAD_SELECTION'],
      ['a string', 'BAD_SELECTION'],
      [{ 0: allIds[0] }, 'BAD_SELECTION'],
      [[], 'EMPTY_SELECTION'],
      [Array.from({ length: COLLECTION_PLAN_MAX_ITEMS + 1 }, (_, i) => idFor(1000 + i)), 'TOO_MANY_ITEMS'],
    ];
    for (const [itemIds, rejection] of cases) {
      const result = await buildCollectionPlan(fakeReader(three), emptyLedger, { name: 'Selection', itemIds });
      assert(!result.ok, `${JSON.stringify(itemIds).slice(0, 40)} should be refused`);
      assertEq(result.rejection, rejection as never, `${JSON.stringify(itemIds).slice(0, 40)} rejection`);
    }
    // An enormous array is refused before it is fully walked.
    const enormous = await buildCollectionPlan(fakeReader(three), emptyLedger, {
      name: 'Selection', itemIds: new Array(COLLECTION_PLAN_MAX_ITEMS * 4).fill(allIds[0]),
    });
    assert(!enormous.ok, 'an enormous array is refused');
    // And a search that matches nothing, or is not a usable search, is refused rather than planned as empty.
    for (const search of ['', '   ', 'nothing matches this', 'x'.repeat(200), 42, null]) {
      const result = await buildCollectionPlan(fakeReader(three), emptyLedger, { name: 'Selection', search });
      assert(!result.ok, `search ${JSON.stringify(search)} should be refused`);
    }
  });

  await test('parseItemIds and the canonical serialiser behave the way the digest depends on', () => {
    assertEq(JSON.stringify(parseItemIds([allIds[1], allIds[0], allIds[1]])), JSON.stringify([allIds[0], allIds[1]]),
      'duplicates collapse and the result is sorted');
    assertEq(parseItemIds(['nope']), null, 'a malformed id refuses the whole list');
    assertEq(parseItemIds('x' as unknown), null, 'a non-array refuses');

    // Key ORDER must not change the serialisation, or a tidy-up would change every digest in the history.
    assertEq(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }), 'key order does not change the canonical form');
    assertEq(canonical({ a: undefined, b: 1 }), '{"b":1}', 'an undefined member is omitted, not written as null');
    assertEq(canonical([1, 'two', null, true]), '[1,"two",null,true]', 'arrays keep their order');
    let threw = false;
    try { canonical(Number.NaN); } catch { threw = true; }
    assert(threw, 'a non-finite number refuses rather than serialising as null');
    threw = false;
    try { canonical(() => undefined); } catch { threw = true; }
    assert(threw, 'an unsupported type refuses rather than being dropped');
    // The digest is domain-separated: the same bytes for two purposes are two digests.
    assert(digest('plan', 'x') !== digest('basis', 'x'), 'digests are domain-separated');
  });

  // -------------------------------------------------------------------------------------------------------
  // The confirmation.
  // -------------------------------------------------------------------------------------------------------

  const claimsFor = (plan: CollectionPlan): Parameters<CollectionConfirmations['issue']>[0] => ({
    name: plan.name,
    planDigest: plan.planDigest,
    basisDigest: plan.basisDigest,
    create: plan.counts.create,
    update: plan.counts.update,
    revoke: plan.counts.revoke,
  });

  await test('a confirmation verifies once, against the digest it was issued for, and never again', async () => {
    const plan = await planOf(three, [], { name: 'Weekend picks', itemIds: allIds });
    const issuer = new CollectionConfirmations();
    const token = issuer.issue(claimsFor(plan));
    assert(token.length <= COLLECTION_CONFIRMATION_MAX_LENGTH, 'a confirmation is small');

    const first = issuer.verify(token, plan.planDigest);
    assert(first.ok, `a fresh confirmation verifies (${first.ok ? '' : first.rejection})`);
    assertEq(first.claims.planDigest, plan.planDigest, 'and it carries the plan it named');
    assertEq(first.claims.basisDigest, plan.basisDigest, 'and the basis it named');

    const replay = issuer.verify(token, plan.planDigest);
    assert(!replay.ok && replay.rejection === 'ALREADY_USED', 'a replay is refused');
  });

  await test('a confirmation is refused when the echoed digest is wrong, forged, expired or from another process', async () => {
    const plan = await planOf(three, [], { name: 'Weekend picks', itemIds: allIds });
    const other = await planOf(three, [], { name: 'Other picks', itemIds: allIds });

    // The wrong digest. The nonce is spent anyway, so a caller cannot grind for the right one.
    const issuer = new CollectionConfirmations();
    const token = issuer.issue(claimsFor(plan));
    const wrong = issuer.verify(token, other.planDigest);
    assert(!wrong.ok && wrong.rejection === 'DIGEST_MISMATCH', 'a mismatched echo is refused');
    const retry = issuer.verify(token, plan.planDigest);
    assert(!retry.ok && retry.rejection === 'ALREADY_USED',
      'and the confirmation is already spent, so the mismatch cannot be probed away');

    // A missing or malformed echo is the same refusal, never an accidental success.
    for (const echo of [undefined, null, '', 'not-a-digest', plan.planDigest.toUpperCase(), `${plan.planDigest} `]) {
      const fresh = new CollectionConfirmations();
      const result = fresh.verify(fresh.issue(claimsFor(plan)), echo);
      assert(!result.ok && result.rejection === 'DIGEST_MISMATCH', `echo ${JSON.stringify(echo)} is refused`);
    }

    // A confirmation from ANOTHER process (a restart) has a different key and does not verify.
    const restarted = new CollectionConfirmations();
    const crossed = restarted.verify(new CollectionConfirmations().issue(claimsFor(plan)), plan.planDigest);
    assert(!crossed.ok && crossed.rejection === 'BAD_SIGNATURE', 'a confirmation from another process is refused');

    // A tampered payload does not verify, even with the signature left alone.
    const tampered = new CollectionConfirmations();
    const original = tampered.issue(claimsFor(plan));
    const [body, signature] = original.split('.');
    const decoded = JSON.parse(Buffer.from(body!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    decoded.planDigest = other.planDigest;
    const forgedBody = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const forged = tampered.verify(`${forgedBody}.${signature}`, other.planDigest);
    assert(!forged.ok && forged.rejection === 'BAD_SIGNATURE', 'a tampered payload is refused');

    // Malformed shapes are refused before anything in them is believed.
    const shapes = new CollectionConfirmations();
    for (const bad of ['', '.', 'a.', '.b', 'a.b.c', 'no-dot', 'x'.repeat(COLLECTION_CONFIRMATION_MAX_LENGTH + 1), 42, null, {}]) {
      const result = shapes.verify(bad, plan.planDigest);
      assert(!result.ok && result.rejection === 'MALFORMED', `${JSON.stringify(bad)} is malformed`);
    }

    // An expired confirmation, and one from the future, are both refused.
    let now = 1_000_000;
    const clocked = new CollectionConfirmations(() => now);
    const aged = clocked.issue(claimsFor(plan));
    now += COLLECTION_CONFIRMATION_TTL_MS + 1;
    const expired = clocked.verify(aged, plan.planDigest);
    assert(!expired.ok && expired.rejection === 'EXPIRED', 'an old confirmation is refused');
    const future = clocked.issue(claimsFor(plan));
    now -= COLLECTION_CONFIRMATION_TTL_MS * 4;
    const backwards = clocked.verify(future, plan.planDigest);
    assert(!backwards.ok && backwards.rejection === 'EXPIRED', 'a confirmation from the future is refused');
  });

  await test('the confirmation signing input is pinned, so a copy of the file cannot silently change it', () => {
    const source = readRepo('src/ops/collection-confirmation.ts');
    assert(source.includes('\\u0000'), 'the NUL separator is written as an ESCAPE, never as a literal byte');
    assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source), 'and the file holds no literal control character');
    // The MAC is exactly what this expression says it is, with a fixed key.
    const key = Buffer.alloc(32, 7);
    const issuer = new CollectionConfirmations(() => 1, key);
    const token = issuer.issue({ name: 'X', planDigest: 'a'.repeat(64), basisDigest: 'b'.repeat(64), create: 1, update: 0, revoke: 0 });
    const [body, signature] = token.split('.');
    const expected = createHmac('sha256', key)
      .update(`catalog-authority/collection-confirmation/v1\u0000${body}`, 'utf8')
      .digest().toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assertEq(signature, expected, 'the signature is the documented HMAC over the documented input');
  });

  // -------------------------------------------------------------------------------------------------------
  // The endpoint, with no writer anywhere in its scope.
  // -------------------------------------------------------------------------------------------------------

  await test('the plan endpoint says it wrote nothing and contacted nothing, in success and in refusal', async () => {
    const confirmations = new CollectionConfirmations();
    const reader = fakeReader(three);
    const ok = await collectionPlanResponse({ name: 'Weekend picks', itemIds: allIds }, { reader, ledger: emptyLedger, confirmations });
    assertEq(ok.status, 200, 'a valid plan answers 200');
    assertEq(ok.body.wrote, 'nothing', 'and says it wrote nothing');
    assertEq(ok.body.contacted, 'nothing', 'and says it contacted nothing');
    assertEq(ok.body.recorded, false, 'and reports honestly that no history store was given');
    assert(typeof ok.body.confirmation === 'string', 'and it issues a confirmation');

    const bad = await collectionPlanResponse({ name: 'bad [name]', itemIds: allIds }, { reader, ledger: emptyLedger, confirmations });
    assertEq(bad.status, 400, 'a refused plan answers 400');
    assertEq(bad.body.code, 'OPERATOR_UI_COLLECTION_PLAN_BAD_NAME', 'with the rejection in the code');
    assertEq(bad.body.wrote, 'nothing', 'and still says it wrote nothing');
    assert(!JSON.stringify(bad.body).includes(SECRET_REF), 'and it discloses nothing about the catalog');

    // A reader that throws is a 503 about the installation, not a crash.
    const broken: CatalogReader = {
      countActive: () => { throw new Error('database is down'); },
      listActiveIds: () => { throw new Error('database is down'); },
      readIdentity: () => { throw new Error('database is down'); },
    };
    const down = await collectionPlanResponse({ name: 'Weekend picks', search: 'a' }, { reader: broken, ledger: emptyLedger, confirmations });
    assertEq(down.status, 503, 'a database that is down is a 503');
    assert(!String(down.body.message).includes('database is down'), 'and the underlying message never reaches the response');
  });

  await test('the plan endpoint is handed no writer at all — the guarantee is the signature, not the body', () => {
    const source = readRepo('src/ops/operator-ui-collections-endpoint.ts');
    const planDeps = /export interface CollectionsPlanDeps \{[\s\S]*?\n\}/.exec(source);
    assert(planDeps !== null, 'the plan dependency type exists');
    for (const forbidden of ['CatalogAuthority', 'OutboxService', 'FetchLike', 'fetch', 'Pool']) {
      assert(!planDeps![0].includes(forbidden), `a plan preview must not be given a ${forbidden}`);
    }
    // The planner's IMPORTS, not its prose. The module explains at length why it does not reach an outbox,
    // so a substring scan over the whole file would be scanning the comment rather than the code.
    const planner = readRepo('src/ops/collection-plan.ts');
    const imports = planner.split('\n').filter((line) => line.startsWith('import '));
    for (const forbidden of ['outbox', 'http-client', 'discovery', 'guarded-fetch', 'transport', 'consent', 'node:http']) {
      assert(!imports.some((line) => line.includes(forbidden)), `the planner must not import anything from ${forbidden}`);
    }
    // It imports the authority for its TYPE only, and never constructs one or calls a transport.
    assert(!/\bnew CatalogAuthority\b/.test(planner), 'the planner must not construct a writer');
    assert(!/(^|[^.\w])fetch\s*\(/.test(planner), 'the planner must not call fetch');
  });

  // -------------------------------------------------------------------------------------------------------
  // Against a real PostgreSQL.
  // -------------------------------------------------------------------------------------------------------

  let pg: Awaited<ReturnType<typeof startEmbedded>> | undefined;
  const external = process.env.DATABASE_URL !== undefined;
  if (!external) {
    try { pg = await startEmbedded(); }
    catch (err) { console.log(`  SKIP  embedded PostgreSQL unavailable: ${(err as Error).message}`); }
  }

  if (external || pg !== undefined) {
    await migrateWith(process.env.ADMIN_DATABASE_URL!);
    const admin = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
    await admin.connect();
    const completionSecret = await installCompletionSecret(admin);

    const keystore = join(WORK, 'keystore');
    mkdirSync(keystore, { recursive: true });
    process.env.CUSTODIAN_MODE = 'file';
    process.env.CUSTODIAN_KEYSTORE_DIR = keystore;
    process.env.CUSTODIAN_KEK = Buffer.alloc(32, 23).toString('base64');
    process.env.COMPLETION_SECRET = completionSecret;

    const { getPool, closePool } = await import('../src/db/pool.js');
    const { CatalogAuthority } = await import('../src/core/catalog/authority.js');
    const { createCustodian, loadCustodianConfig } = await import('../src/core/crypto/custodian-factory.js');
    const { createExistingStateLookup } = await import('../src/ops/catalog-import.js');
    const { applyImport } = await import('../src/ops/catalog-import-service.js');
    const { createCatalogReader } = await import('../src/ops/operator-ui-catalog-browse.js');

    const pool = getPool();
    const authority = new CatalogAuthority(pool, createCustodian(loadCustodianConfig()));
    const text = `${JSON.stringify({
      format: 'catalog-authority.snapshot',
      version: 1,
      source: 'plan-library',
      items: [
        { externalId: 'p-1', title: 'Planned Alpha', year: 1994, providerRefs: [{ type: 'imdb', value: SECRET_REF }] },
        { externalId: 'p-2', title: 'Planned Bravo', year: 2001, providerRefs: [{ type: 'tmdb', value: `${SECRET_REF}-2` }] },
        { externalId: 'p-3', title: 'Planned Charlie (no reference)' },
      ],
    }, null, 2)}\n`;
    const applied = await applyImport({
      text, lookup: createExistingStateLookup(pool), authority, actor: 'cli', fileName: 'plan.json',
    });

    const dbReader = createCatalogReader(pool, authority);
    const dbLedger = createLedgerReader(pool);
    const history = createCollectionHistoryStore(pool);

    const counts = async (): Promise<Record<string, number>> => ({
      items: (await admin.query('SELECT count(*)::int AS n FROM items')).rows[0].n as number,
      events: (await admin.query('SELECT count(*)::int AS n FROM events')).rows[0].n as number,
      ledger: (await admin.query('SELECT count(*)::int AS n FROM publish_ledger')).rows[0].n as number,
      importHistory: (await admin.query('SELECT count(*)::int AS n FROM import_history')).rows[0].n as number,
    });

    await test('the migration created the collection history table and this build declares its version', async () => {
      assertEq(applied.result.created, 3, 'the fixture did not import');
      assert(MIGRATED_TABLES.includes('collection_control_history'), 'the table is in the verified set');
      const version = (await admin.query('SELECT version FROM schema_meta WHERE id = 1')).rows[0].version as number;
      assertEq(version, MIGRATION_VERSION, 'the deployed version matches this build');
      const columns = (await admin.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'collection_control_history' ORDER BY column_name`,
      )).rows.map((r) => r.column_name as string);
      for (const forbidden of ['item_id', 'title', 'provider_ref', 'external_id', 'external_handle', 'api_key', 'base_url']) {
        assert(!columns.includes(forbidden), `the history table must have no ${forbidden} column`);
      }
    });

    await test('a plan against a real catalog and a real ledger is correct, and writes nothing at all', async () => {
      const before = await counts();
      const ids = (await dbReader.listActiveIds(10, 0)).slice();
      const result = await buildCollectionPlan(dbReader, dbLedger, { name: 'Real plan', itemIds: ids });
      assert(result.ok, 'the plan was refused');
      assertEq(result.plan.counts.selected, 3, 'all three records were selected');
      assertEq(result.plan.counts.create, 2, 'the two with a reference would be created');
      assertEq(result.plan.counts.blocked, 1, 'and the one without a reference is blocked');
      assert(!JSON.stringify(result.plan).includes(SECRET_REF), 'the plan disclosed a reference value');

      // The same plan twice, over a real database, is the same digest.
      const again = await buildCollectionPlan(dbReader, dbLedger, { name: 'Real plan', itemIds: [...ids].reverse() });
      assert(again.ok, 'the repeat plan was refused');
      assertEq(again.plan.planDigest, result.plan.planDigest, 'the same plan twice is the same digest');
      assertEq(again.plan.basisDigest, result.plan.basisDigest, 'and the same basis');

      const after = await counts();
      assertEq(JSON.stringify(after), JSON.stringify(before), 'planning wrote a row, an event or a ledger entry');
    });

    await test('a whole planning session through the endpoint writes only its own audit rows', async () => {
      const before = await counts();
      const confirmations = new CollectionConfirmations();
      const ids = (await dbReader.listActiveIds(10, 0)).slice();
      for (const body of [
        { name: 'Session one', itemIds: ids },
        { name: 'Session two', search: 'planned' },
        { name: 'bad [name]', itemIds: ids },
        { name: 'Session three', itemIds: ['not-a-uuid'] },
      ]) {
        const result = await collectionPlanResponse(body, { reader: dbReader, ledger: dbLedger, confirmations, history });
        assert(result.status === 200 || result.status === 400, `a plan answered ${result.status}`);
        assertEq(result.body.wrote, 'nothing', 'every plan says it wrote nothing');
      }
      const after = await counts();
      assertEq(after.items, before.items, 'planning created a record');
      assertEq(after.events, before.events, 'planning appended an event');
      assertEq(after.ledger, before.ledger, 'planning wrote a publish ledger row');
      assertEq(after.importHistory, before.importHistory, 'planning wrote an import history row');
      // Only the two SUCCESSFUL previews were recorded. A refusal that never produced a plan has no digest.
      const rows = (await admin.query('SELECT count(*)::int AS n FROM collection_control_history')).rows[0].n as number;
      assertEq(rows, 2, 'exactly the two successful previews were recorded');
    });

    await test('the history is durable, identity-free, and refuses an unsafe row at the database', async () => {
      const entries = await history.list(50);
      assert(entries.length >= 2, 'the history holds the previews');
      assertEq(entries[0]!.action, 'planned', 'a preview is recorded as planned');
      assertEq(entries[0]!.outcome, 'preview', 'with the preview outcome');
      assertEq(entries[0]!.target, 'jellyfin', 'against the named target');
      assert(/^[0-9a-f]{64}$/.test(entries[0]!.planDigest), 'and a real plan digest');
      const text = JSON.stringify(entries) + renderCollectionHistory(entries);
      for (const forbidden of [SECRET_REF, 'Planned Alpha', 'p-1', 'imdb']) {
        assert(!text.includes(forbidden), `the history disclosed ${forbidden}`);
      }

      // EVERY character the PLANNER allows in a name must also survive the schema's CHECK. The two grammars
      // are written in different regex dialects, in different files, and a name a person can type into the
      // form but the database refuses would fail an execute AFTER the work was queued.
      const punctuated = "Bob's Sci-Fi (1980s) & more.,+:_ 9";
      assert(isUsableCollectionName(punctuated), 'the planner accepts the full punctuation set');
      await history.record({
        actor: 'operator-ui', action: 'planned', target: 'jellyfin', name: punctuated,
        planDigest: 'a'.repeat(64), basisDigest: 'b'.repeat(64),
        selected: 0, created: 0, updated: 0, unchanged: 0, revoked: 0, blocked: 0, failed: 0, outcome: 'preview',
      });
      const stored = (await history.list(50)).find((entry) => entry.name === punctuated);
      assert(stored !== undefined, 'and the database stored it');

      // The DATABASE refuses an unsafe row, not merely the caller.
      for (const [args, why] of [
        [['operator-ui', 'planned', 'jellyfin', 'bad [name]', 'a'.repeat(64), 'b'.repeat(64), 0, 0, 0, 0, 0, 0, 0, 'preview'], 'a bracketed name'],
        [['operator-ui', 'planned', 'jellyfin', 'ok', 'not-a-digest', 'b'.repeat(64), 0, 0, 0, 0, 0, 0, 0, 'preview'], 'a malformed digest'],
        [['operator-ui', 'planned', 'plex', 'ok', 'a'.repeat(64), 'b'.repeat(64), 0, 0, 0, 0, 0, 0, 0, 'preview'], 'an unknown target'],
        [['operator-ui', 'exploded', 'jellyfin', 'ok', 'a'.repeat(64), 'b'.repeat(64), 0, 0, 0, 0, 0, 0, 0, 'preview'], 'an unknown action'],
        [['nobody', 'planned', 'jellyfin', 'ok', 'a'.repeat(64), 'b'.repeat(64), 0, 0, 0, 0, 0, 0, 0, 'preview'], 'an unknown actor'],
        [['operator-ui', 'planned', 'jellyfin', 'ok', 'a'.repeat(64), 'b'.repeat(64), -1, 0, 0, 0, 0, 0, 0, 'preview'], 'a negative count'],
        [['operator-ui', 'planned', 'jellyfin', 'ok', 'a'.repeat(64), 'b'.repeat(64), 0, 0, 0, 0, 0, 0, 0, 'invented'], 'an unknown outcome'],
      ] as Array<[unknown[], string]>) {
        let refused = false;
        try {
          await pool.query('SELECT cat_collection_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', args);
        } catch { refused = true; }
        assert(refused, `the database accepted ${why}`);
      }

      // And the app role cannot write the table directly, only through the one function.
      let direct = false;
      try {
        await pool.query("INSERT INTO collection_control_history (actor, action, target, name, plan_digest, basis_digest, selected, created, updated, unchanged, revoked, blocked, failed, outcome) VALUES ('cli','planned','jellyfin','x', repeat('a',64), repeat('b',64), 0,0,0,0,0,0,0,'preview')");
      } catch { direct = true; }
      assert(direct, 'the runtime role can INSERT into the history table directly');
      for (const statement of [
        'UPDATE collection_control_history SET outcome = \'complete\'',
        'DELETE FROM collection_control_history',
      ]) {
        let blocked = false;
        try { await pool.query(statement); } catch { blocked = true; }
        assert(blocked, `the runtime role could run: ${statement}`);
      }
    });

    await test('the history route answers, and answers a state rather than a crash with no database', async () => {
      const served = await collectionHistoryResponse(history);
      assertEq(served.status, 200, 'the history route answers');
      assert(Array.isArray(served.body.entries), 'with entries');
      const none = await collectionHistoryResponse(undefined);
      assertEq(none.status, 503, 'and a missing store is a 503');
      assertEq(none.body.wrote, 'nothing', 'that still says it wrote nothing');
    });

    await admin.end();
    await closePool();
    if (pg !== undefined) await pg.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
}

void main();
