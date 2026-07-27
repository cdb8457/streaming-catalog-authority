import { Client } from 'pg';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  type CollectionPlanDeps,
  type LedgerIntentState,
  type LedgerReader,
} from '../src/ops/collection-plan.js';
import {
  MANAGED_COLLECTION_TARGET,
  collectionKeyFor,
  createManagedCollectionReader,
  setManagedMembers,
  upsertManagedCollection,
  type ManagedCollectionMember,
  type ManagedCollectionReader,
  type ManagedCollectionSummary,
  type ManagedMemberState,
} from '../src/core/publish/collection-model.js';
import {
  COLLECTION_CONFIRMATION_MAX_LENGTH,
  COLLECTION_CONFIRMATION_TTL_MS,
  CollectionConfirmations,
  digestEchoMatches,
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

// Phase 269 — ONE accepted plan is ONE managed collection, and the durable model that makes that true.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - ONE PLAN IS ONE COLLECTION. A plan of N records proposes ONE collection holding N records, addressed by
//     a durable key derived from the operator's own name — not N collections, which is what Phase 267/268 did
//     and what this phase exists to replace.
//   - RE-PLANNING THE SAME NAME UPDATES THE SAME COLLECTION. Dropping a record from the selection removes it
//     from that collection; it never creates a second one.
//   - A PLAN IS DETERMINISTIC. The same catalog, model and name produce the same members, in the same order,
//     with the same two digests — whatever order the selection arrived in.
//   - THE TWO DIGESTS MEAN DIFFERENT THINGS. The plan digest covers what would be done; the basis digest
//     covers what it was decided from. A reference corrected between preview and confirmation, or a collection
//     that settled, moves the basis without moving the plan — the case a single digest would miss.
//   - PLANNING CONTACTS NOTHING AND WRITES NOTHING. Proved structurally (the function is handed three readers)
//     and empirically (row, event, ledger and collection counts across a real PostgreSQL are unchanged).
//   - ERASURE OUTRANKS THE SELECTION. A forgotten member is removed whether or not it was selected.
//   - THE V8 PER-ITEM ROWS ARE REPORTED AND NEVER REINTERPRETED. A pre-upgrade per-record collection is not
//     read as membership, not adopted, and not acted on by a grouped plan.
//   - THE DURABLE MODEL IS IDENTITY-FREE AND THE DATABASE ENFORCES IT. No column can hold a title, a provider
//     reference, a Jellyfin id or a path; the closed name grammar is a CHECK; and one active collection per
//     (target, key) is a unique index rather than a caller-side habit.
//   - THE CONFIRMATION IS SINGLE-USE, EXPIRING, PER-PROCESS AND DIGEST-BOUND.

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
const SECRET_REF = 'tt-phase269-ref-value-must-never-be-planned';

// --- an in-memory catalog, ledger and managed model, so the cases are exhaustive rather than expensive -----

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
  return { listIntents: (target) => Promise.resolve(target === COLLECTION_PLAN_TARGET ? intents : []) };
}

const emptyLedger = fakeLedger([]);

/** An in-memory managed model. SELECT-shaped, exactly like the real reader. */
function fakeManaged(
  collection: (Partial<ManagedCollectionSummary> & { name: string }) | null,
  members: readonly ManagedCollectionMember[] = [],
): ManagedCollectionReader {
  const summary: ManagedCollectionSummary | null = collection === null ? null : {
    id: '1',
    target: MANAGED_COLLECTION_TARGET,
    collectionKey: collectionKeyFor(MANAGED_COLLECTION_TARGET, collection.name),
    name: collection.name,
    status: collection.status ?? 'published',
    settled: collection.settled ?? true,
    needsSync: collection.needsSync ?? false,
    attemptCount: collection.attemptCount ?? 0,
    planDigest: collection.planDigest ?? 'a'.repeat(64),
    basisDigest: collection.basisDigest ?? 'b'.repeat(64),
    recoveryProof: collection.recoveryProof ?? null,
    members: members.filter((m) => m.state === 'intended').length,
    removing: members.filter((m) => m.state === 'removing').length,
    synced: members.filter((m) => m.state === 'intended' && m.synced).length,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    findActive: (target, key) =>
      Promise.resolve(summary !== null && summary.target === target && summary.collectionKey === key ? summary : null),
    listMembers: () => Promise.resolve([...members].sort((a, b) => a.itemId.localeCompare(b.itemId, 'en'))),
    listActive: () => Promise.resolve(summary === null ? [] : [summary]),
    listAll: () => Promise.resolve(summary === null ? [] : [summary]),
  };
}

const noManaged = fakeManaged(null);

const member = (n: number, state: ManagedMemberState = 'intended', synced = true): ManagedCollectionMember =>
  ({ itemId: idFor(n), state, synced });

async function planOf(
  deps: { reader: CatalogReader; ledger?: LedgerReader; managed?: ManagedCollectionReader },
  input: { name: unknown; mode?: unknown; itemIds?: unknown; search?: unknown },
): Promise<CollectionPlan> {
  const result = await buildCollectionPlan(
    { reader: deps.reader, ledger: deps.ledger ?? emptyLedger, managed: deps.managed ?? noManaged },
    input,
  );
  assert(result.ok, `the plan was rejected: ${result.ok ? '' : result.rejection}`);
  return result.plan;
}

async function main(): Promise<void> {
  console.log('Running Phase 269 grouped collection planning suite:\n');

  const three = [
    record(1, { title: 'Alpha', year: 1994 }),
    record(2, { title: 'Bravo', year: 2001 }),
    record(3, { title: 'Charlie' }),
  ];
  const allIds = three.map((r) => r.itemId);

  // -------------------------------------------------------------------------------------------------------
  // ONE PLAN IS ONE COLLECTION. This is the whole reason the phase exists.
  // -------------------------------------------------------------------------------------------------------

  await test('a plan of three records proposes ONE collection holding three records', async () => {
    const plan = await planOf({ reader: fakeReader(three) }, { name: 'Weekend picks', itemIds: allIds });
    assertEq(plan.collection.action, 'create', 'one collection would be created');
    assertEq(plan.collection.reason, 'ABSENT', 'because there is none by that name');
    assertEq(plan.counts.add, 3, 'and all three records go into it');
    assertEq(plan.counts.resulting, 3, 'so it would hold three');
    assertEq(plan.members.length, 3, 'and the plan says something about each');
    assertEq(plan.mode, 'sync', 'the default mode defines what the collection holds');
    assertEq(plan.collectionKey, collectionKeyFor('jellyfin', 'Weekend picks'),
      'the collection is addressed by a key derived from the name, not by anything random');
    assert(/^[0-9a-f]{64}$/.test(plan.planDigest), 'the plan digest is 64 hex characters');
    assert(/^[0-9a-f]{64}$/.test(plan.basisDigest), 'and so is the basis digest');
    assert(plan.planDigest !== plan.basisDigest, 'and the two are domain-separated');
  });

  await test('the durable key is derived from the name and the target, and is stable and domain-separated', () => {
    assertEq(collectionKeyFor('jellyfin', 'Weekend picks'), collectionKeyFor('jellyfin', 'Weekend picks'),
      'the same name is the same collection every time — that is what makes re-planning an update');
    assert(collectionKeyFor('jellyfin', 'Weekend picks') !== collectionKeyFor('jellyfin', 'Weekend Picks'),
      'a different name is a different collection');
    assert(collectionKeyFor('jellyfin', 'a b') !== collectionKeyFor('jellyfina', ' b'),
      'the separator cannot be forged by shifting the boundary between the target and the name');
    assert(/^[0-9a-f]{64}$/.test(collectionKeyFor('jellyfin', 'Weekend picks')), 'and it is a digest, not a label');
  });

  await test('re-planning the same name UPDATES that collection rather than making a second one', async () => {
    const managed = fakeManaged({ name: 'Weekend picks' }, [member(1), member(2)]);
    const plan = await planOf({ reader: fakeReader(three), managed }, { name: 'Weekend picks', itemIds: allIds });
    assertEq(plan.collection.action, 'update', 'the existing collection is updated');
    assertEq(plan.collection.reason, 'MEMBERSHIP_DIFFERS', 'because its membership differs');
    assertEq(plan.counts.add, 1, 'one record goes in');
    assertEq(plan.counts.keep, 2, 'and two are already there');
    assertEq(plan.counts.remove, 0, 'and nothing comes out');
    assertEq(plan.counts.resulting, 3, 'leaving three');
  });

  await test('a record dropped from the selection is REMOVED from that collection, not published elsewhere', async () => {
    const managed = fakeManaged({ name: 'Weekend picks' }, [member(1), member(2), member(3)]);
    const plan = await planOf({ reader: fakeReader(three), managed }, { name: 'Weekend picks', itemIds: [allIds[0]!, allIds[1]!] });
    assertEq(plan.counts.remove, 1, 'the deselected record comes out');
    const dropped = plan.members.find((m) => m.itemId === allIds[2]);
    assertEq(dropped?.action, 'remove', 'and it is named as a removal');
    assertEq(dropped?.reason, 'DESELECTED', 'for the reason an operator would recognise');
    assertEq(plan.counts.resulting, 2, 'leaving two');
    assertEq(plan.collection.action, 'update', 'and still exactly one collection');
  });

  await test('an unchanged selection over a synced collection is a NO-OP', async () => {
    const managed = fakeManaged({ name: 'Weekend picks' }, [member(1), member(2), member(3)]);
    const plan = await planOf({ reader: fakeReader(three), managed }, { name: 'Weekend picks', itemIds: allIds });
    assertEq(plan.collection.action, 'unchanged', 'nothing would change');
    assertEq(plan.collection.reason, 'IN_SYNC', 'because it already agrees');
    assertEq(plan.noop, true, 'and the plan says so');
  });

  await test('a collection that would hold nothing is REVOKED rather than left empty', async () => {
    const managed = fakeManaged({ name: 'Weekend picks' }, [member(1)]);
    // Record 1 has lost every provider reference, so it can no longer match a library item.
    const stripped = [{ ...three[0]!, identity: { ...three[0]!.identity, providerRefs: [] } }];
    const plan = await planOf({ reader: fakeReader(stripped), managed }, { name: 'Weekend picks', itemIds: [allIds[0]!] });
    assertEq(plan.counts.resulting, 0, 'nothing would be left in it');
    assertEq(plan.collection.action, 'revoke', 'so the collection itself goes');
    assertEq(plan.collection.reason, 'EMPTIED', 'and says why');
  });

  await test('a selection that can hold nothing and has no collection yet creates NOTHING', async () => {
    const stripped = [{ ...three[0]!, identity: { ...three[0]!.identity, providerRefs: [] } }];
    const plan = await planOf({ reader: fakeReader(stripped) }, { name: 'Weekend picks', itemIds: [allIds[0]!] });
    assertEq(plan.collection.action, 'blocked', 'this product does not create an empty collection to then delete it');
    assertEq(plan.collection.reason, 'NO_MEMBERS', 'and says why');
    assertEq(plan.noop, true, 'and it is a no-op');
  });

  // -------------------------------------------------------------------------------------------------------
  // Erasure outranks the selection.
  // -------------------------------------------------------------------------------------------------------

  await test('a forgotten MEMBER is removed whether or not it was selected', async () => {
    const readable = [three[0]!, three[1]!]; // record 3 is no longer readable
    const managed = fakeManaged({ name: 'Weekend picks' }, [member(1), member(2), member(3)]);

    const selected = await planOf({ reader: fakeReader(readable), managed }, { name: 'Weekend picks', itemIds: allIds });
    const inSelection = selected.members.find((m) => m.itemId === idFor(3));
    assertEq(inSelection?.action, 'remove', 'a forgotten record that WAS selected still comes out');
    assertEq(inSelection?.reason, 'FORGOTTEN', 'for the erasure reason');

    const notSelected = await planOf({ reader: fakeReader(readable), managed }, { name: 'Weekend picks', itemIds: [allIds[0]!, allIds[1]!] });
    const outside = notSelected.members.find((m) => m.itemId === idFor(3));
    assertEq(outside?.action, 'remove', 'and one that was NOT selected comes out too');
    assertEq(outside?.reason, 'FORGOTTEN', 'still named as an erasure rather than a deselection');
  });

  await test('a forgotten record that is NOT a member is blocked, never silently dropped', async () => {
    const readable = [three[0]!, three[1]!];
    const plan = await planOf({ reader: fakeReader(readable) }, { name: 'Weekend picks', itemIds: allIds });
    const gone = plan.members.find((m) => m.itemId === idFor(3));
    assertEq(gone?.action, 'blocked', 'an unreadable record cannot go in');
    assertEq(gone?.reason, 'UNREADABLE', 'and the plan says which kind of problem it is');
    assertEq(plan.counts.blocked, 1, 'and it is counted rather than vanishing');
    assertEq(plan.counts.add, 2, 'the other two still go in');
  });

  await test('a member already queued for removal stays queued for removal', async () => {
    const managed = fakeManaged({ name: 'Weekend picks' }, [member(1), member(3, 'removing', false)]);
    const plan = await planOf({ reader: fakeReader(three), managed }, { name: 'Weekend picks', itemIds: [allIds[0]!] });
    const pending = plan.members.find((m) => m.itemId === idFor(3));
    assertEq(pending?.action, 'remove', 'a pending removal is not forgotten about');
    assertEq(pending?.reason, 'PENDING_REMOVAL', 'and is reported as one');
  });

  await test('a record with no provider reference cannot go in, and is taken out if it is already in', async () => {
    const stripped = three.map((r) => (r.itemId === idFor(2) ? { ...r, identity: { ...r.identity, providerRefs: [] } } : r));
    const fresh = await planOf({ reader: fakeReader(stripped) }, { name: 'Weekend picks', itemIds: allIds });
    assertEq(fresh.members.find((m) => m.itemId === idFor(2))?.action, 'blocked', 'it cannot be matched to a library item');
    assertEq(fresh.members.find((m) => m.itemId === idFor(2))?.reason, 'NO_PROVIDER_REFS', 'and the reason is exact');

    const managed = fakeManaged({ name: 'Weekend picks' }, [member(1), member(2)]);
    const existing = await planOf({ reader: fakeReader(stripped), managed }, { name: 'Weekend picks', itemIds: allIds });
    assertEq(existing.members.find((m) => m.itemId === idFor(2))?.action, 'remove',
      'a member that has lost its last reference has nothing justifying its library items staying');
  });

  // -------------------------------------------------------------------------------------------------------
  // Revoke mode.
  // -------------------------------------------------------------------------------------------------------

  await test('revoke mode removes the whole collection and refuses a selection', async () => {
    const managed = fakeManaged({ name: 'Weekend picks' }, [member(1), member(2)]);
    const plan = await planOf({ reader: fakeReader(three), managed }, { name: 'Weekend picks', mode: 'revoke' });
    assertEq(plan.collection.action, 'revoke', 'the collection goes');
    assertEq(plan.collection.reason, 'OPERATOR_REVOKE', 'because an operator asked');
    assertEq(plan.counts.remove, 2, 'and every member comes out');
    assertEq(plan.counts.resulting, 0, 'leaving nothing');

    for (const extra of [{ itemIds: [allIds[0]!] }, { search: 'alpha' }]) {
      const refused = await buildCollectionPlan(
        { reader: fakeReader(three), ledger: emptyLedger, managed },
        { name: 'Weekend picks', mode: 'revoke', ...extra },
      );
      assert(!refused.ok, 'a revoke that carried a selection was accepted');
      assertEq(refused.ok ? '' : refused.rejection, 'BAD_SELECTION',
        'a caller who sent a selection has misread what revoke does, and must be told rather than surprised');
    }
  });

  await test('revoking a collection that does not exist is refused, not silently accepted', async () => {
    const result = await buildCollectionPlan(
      { reader: fakeReader(three), ledger: emptyLedger, managed: noManaged },
      { name: 'Never existed', mode: 'revoke' },
    );
    assert(!result.ok, 'a revoke of nothing was accepted');
    assertEq(result.ok ? '' : result.rejection, 'NOTHING_TO_REVOKE', 'with the honest reason');
  });

  await test('an unknown mode is refused rather than defaulted', async () => {
    const result = await buildCollectionPlan(
      { reader: fakeReader(three), ledger: emptyLedger, managed: noManaged },
      { name: 'Weekend picks', mode: 'delete-everything', itemIds: allIds },
    );
    assert(!result.ok, 'an unknown mode was accepted');
    assertEq(result.ok ? '' : result.rejection, 'BAD_MODE', 'and named');
  });

  // -------------------------------------------------------------------------------------------------------
  // Determinism and the two digests.
  // -------------------------------------------------------------------------------------------------------

  await test('the same catalog, model and name produce the same plan, however the selection was ordered', async () => {
    const first = await planOf({ reader: fakeReader(three) }, { name: 'Weekend picks', itemIds: allIds });
    const shuffled = await planOf({ reader: fakeReader(three) }, { name: 'Weekend picks', itemIds: [allIds[2], allIds[0], allIds[1], allIds[0]] });
    assertEq(shuffled.planDigest, first.planDigest, 'a reordered, duplicated selection is the same plan');
    assertEq(shuffled.basisDigest, first.basisDigest, 'and the same basis');
    assertEq(JSON.stringify(shuffled.members), JSON.stringify(first.members), 'and the same members, in the same order');
    assertEq(first.counts.selected, 3, 'the duplicate collapsed rather than being counted twice');
    assertEq(first.noop, false, 'a plan with work to do is not a no-op');
  });

  await test('a different name is a different plan, because it is a different collection', async () => {
    const a = await planOf({ reader: fakeReader(three) }, { name: 'Weekend picks', itemIds: allIds });
    const b = await planOf({ reader: fakeReader(three) }, { name: 'Weeknight picks', itemIds: allIds });
    assert(a.planDigest !== b.planDigest, 'the name is part of what would be done');
    assert(a.collectionKey !== b.collectionKey, 'and it addresses a different collection');
  });

  await test('a reference that changed moves the BASIS without moving the PLAN', async () => {
    const before = await planOf({ reader: fakeReader(three) }, { name: 'Weekend picks', itemIds: allIds });
    const corrected = three.map((r) => (r.itemId === idFor(1)
      ? { ...r, identity: { ...r.identity, providerRefs: [{ type: 'imdb', value: `${SECRET_REF}-corrected` }] } }
      : r));
    const after = await planOf({ reader: fakeReader(corrected) }, { name: 'Weekend picks', itemIds: allIds });
    assertEq(after.planDigest, before.planDigest, 'the same records would still be put in');
    assert(after.basisDigest !== before.basisDigest, 'but it was decided from a different world');
  });

  await test('a collection that settled moves the BASIS without moving the PLAN', async () => {
    const members = [member(1, 'intended', false), member(2, 'intended', false), member(3, 'intended', false)];
    const unsettled = fakeManaged({ name: 'Weekend picks', status: 'planned', settled: false, needsSync: true }, members);
    const settled = fakeManaged({ name: 'Weekend picks', status: 'planned', settled: true, needsSync: true }, members);
    const a = await planOf({ reader: fakeReader(three), managed: unsettled }, { name: 'Weekend picks', itemIds: allIds });
    const b = await planOf({ reader: fakeReader(three), managed: settled }, { name: 'Weekend picks', itemIds: allIds });
    assertEq(b.planDigest, a.planDigest, 'the intended membership is identical');
    assert(b.basisDigest !== a.basisDigest, 'but the durable state it was decided from is not');
  });

  await test('the digests are domain-separated and the canonical form is key-sorted', () => {
    assert(digest('plan', 'x') !== digest('basis', 'x'), 'two purposes over the same bytes are two digests');
    assertEq(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }), 'key order in the source cannot change a digest');
    assertEq(canonical({ a: undefined, b: 1 }), '{"b":1}', 'an absent value is absent, not null');
    let threw = false;
    try { canonical(Number.POSITIVE_INFINITY); } catch { threw = true; }
    assert(threw, 'a non-finite number must not be silently serialised');
  });

  // -------------------------------------------------------------------------------------------------------
  // The closed grammar and the selection parser.
  // -------------------------------------------------------------------------------------------------------

  await test('the collection name grammar is closed, and brackets are refused', () => {
    for (const good of ['A', 'Weekend picks', "Bob's Sci-Fi (1980s) & more.,+:_-", 'a'.repeat(COLLECTION_NAME_MAX_LENGTH)]) {
      assert(isUsableCollectionName(good), `a usable name was refused: ${good}`);
    }
    for (const bad of ['', ' leading', 'trailing ', '[cat:x]', 'a]b', 'a[b', 'a\nb', 'a\tb', 'école',
      'a'.repeat(COLLECTION_NAME_MAX_LENGTH + 1), 42, null]) {
      assert(!isUsableCollectionName(bad as unknown), `an unusable name was accepted: ${String(bad)}`);
    }
  });

  await test('a selection is refused rather than filtered, and duplicates collapse', () => {
    assertEq(parseItemIds([idFor(2), idFor(1), idFor(2)])?.join(','), [idFor(1), idFor(2)].join(','),
      'duplicates collapse and the result is sorted');
    assertEq(parseItemIds([idFor(1), 'not-a-uuid']), null, 'one malformed id refuses the whole selection');
    assertEq(parseItemIds('nope' as unknown), null, 'a non-array is refused');
    assertEq(parseItemIds(Array.from({ length: COLLECTION_PLAN_MAX_ITEMS * 2 + 1 }, () => idFor(1))), null,
      'an oversized array is refused before it is fully iterated');
  });

  await test('an oversized or empty selection is refused with the reason', async () => {
    const many = Array.from({ length: COLLECTION_PLAN_MAX_ITEMS + 1 }, (_unused, i) => idFor(i + 100));
    const tooMany = await buildCollectionPlan({ reader: fakeReader(three), ledger: emptyLedger, managed: noManaged }, { name: 'Big', itemIds: many });
    assertEq(tooMany.ok ? '' : tooMany.rejection, 'TOO_MANY_ITEMS', 'an oversized selection is refused');
    const empty = await buildCollectionPlan({ reader: fakeReader(three), ledger: emptyLedger, managed: noManaged }, { name: 'Empty', itemIds: [] });
    assertEq(empty.ok ? '' : empty.rejection, 'EMPTY_SELECTION', 'an empty one is refused too');
  });

  // -------------------------------------------------------------------------------------------------------
  // The v8 per-item rows: reported, never reinterpreted.
  // -------------------------------------------------------------------------------------------------------

  await test('legacy per-record collections are counted and never read as membership', async () => {
    const legacy = fakeLedger([
      { intentId: '1', itemId: idFor(1), status: 'published', settled: true },
      { intentId: '2', itemId: idFor(9), status: 'published', settled: true },
      { intentId: '3', itemId: idFor(8), status: 'revoke_pending', settled: true },
      { intentId: '4', itemId: idFor(7), status: 'revoked', settled: true },
    ]);
    const plan = await planOf({ reader: fakeReader(three), ledger: legacy }, { name: 'Weekend picks', itemIds: allIds });
    assertEq(plan.legacy.perItemLive, 3, 'the live per-record rows are counted');
    assertEq(plan.legacy.perItemLiveSelected, 1, 'including the one that concerns a selected record');
    assertEq(plan.legacy.perItemRevokePending, 1, 'and the one already queued for revocation');
    // The record with a legacy row is STILL an `add`: a per-record collection is not membership of this one.
    assertEq(plan.members.find((m) => m.itemId === idFor(1))?.action, 'add',
      'a legacy per-record collection must not be read as "already in this collection"');
    assertEq(plan.counts.add, 3, 'so all three still go in');
    assert(!plan.members.some((m) => m.itemId === idFor(9)),
      'and a legacy row for an unselected record does not conjure a member');
  });

  await test('legacy counts are OUTSIDE both digests, so an unrelated legacy row cannot invalidate a plan', async () => {
    const none = await planOf({ reader: fakeReader(three) }, { name: 'Weekend picks', itemIds: allIds });
    const some = await planOf(
      { reader: fakeReader(three), ledger: fakeLedger([{ intentId: '1', itemId: idFor(9), status: 'published', settled: true }]) },
      { name: 'Weekend picks', itemIds: allIds },
    );
    assertEq(some.planDigest, none.planDigest, 'no action here is decided from a legacy row');
    assertEq(some.basisDigest, none.basisDigest, 'so a legacy row settling must not make an unrelated plan stale');
  });

  // -------------------------------------------------------------------------------------------------------
  // The confirmation.
  // -------------------------------------------------------------------------------------------------------

  await test('a confirmation is single-use, expiring, per-process and bound to the digest', async () => {
    let now = 1_000_000;
    const issuer = new CollectionConfirmations(() => now);
    const plan = await planOf({ reader: fakeReader(three) }, { name: 'Weekend picks', itemIds: allIds });
    const claims = { name: plan.name, planDigest: plan.planDigest, basisDigest: plan.basisDigest, create: 3, update: 0, revoke: 0 };

    const token = issuer.issue(claims);
    assertEq(issuer.verify(token, plan.planDigest).ok, true, 'a fresh confirmation with the right echo verifies');
    assertEq(issuer.verify(token, plan.planDigest).ok, false, 'and cannot be used twice');

    const second = issuer.issue(claims);
    const wrongEcho = issuer.verify(second, 'f'.repeat(64));
    assertEq(wrongEcho.ok, false, 'a wrong digest echo is refused');
    assertEq(wrongEcho.ok ? '' : wrongEcho.rejection, 'DIGEST_MISMATCH', 'and named');
    assertEq(issuer.verify(second, plan.planDigest).ok, false,
      'and the nonce was spent BEFORE the comparison, so a caller cannot grind for the digest');

    const third = issuer.issue(claims);
    now += COLLECTION_CONFIRMATION_TTL_MS + 1;
    const expired = issuer.verify(third, plan.planDigest);
    assertEq(expired.ok ? '' : expired.rejection, 'EXPIRED', 'an old preview cannot be executed');

    const other = new CollectionConfirmations();
    const foreign = other.verify(issuer.issue(claims), plan.planDigest);
    assertEq(foreign.ok ? '' : foreign.rejection, 'BAD_SIGNATURE', 'another process cannot confirm this one\'s plan');

    for (const junk of ['', 'nodot', 'a.b.c', `${'a'.repeat(COLLECTION_CONFIRMATION_MAX_LENGTH + 1)}.b`, 42 as unknown]) {
      assertEq(issuer.verify(junk as string, plan.planDigest).ok, false, `a malformed confirmation was accepted: ${String(junk)}`);
    }
  });

  await test('the digest echo comparison is shared, strict and hex-only', async () => {
    const plan = await planOf({ reader: fakeReader(three) }, { name: 'Weekend picks', itemIds: allIds });
    assert(digestEchoMatches(plan.planDigest, plan.planDigest), 'the right digest matches');
    assert(!digestEchoMatches(plan.planDigest.toUpperCase(), plan.planDigest), 'an upper-case spelling is not the digest');
    assert(!digestEchoMatches(plan.planDigest.slice(0, 63), plan.planDigest), 'a truncated one is not either');
    assert(!digestEchoMatches(undefined, plan.planDigest), 'and neither is nothing at all');
  });

  await test('the confirmation signature is the documented HMAC over the documented input', () => {
    const key = randomBytes(32);
    const issuer = new CollectionConfirmations(() => 1_000_000, key);
    const token = issuer.issue({ name: 'X', planDigest: 'a'.repeat(64), basisDigest: 'b'.repeat(64), create: 1, update: 0, revoke: 0 });
    const [body, signature] = token.split('.') as [string, string];
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
    const ok = await collectionPlanResponse({ name: 'Weekend picks', itemIds: allIds }, { reader, ledger: emptyLedger, managed: noManaged, confirmations });
    assertEq(ok.status, 200, 'a valid plan answers 200');
    assertEq(ok.body.wrote, 'nothing', 'and says it wrote nothing');
    assertEq(ok.body.contacted, 'nothing', 'and says it contacted nothing');
    assertEq(ok.body.recorded, false, 'and reports honestly that no history store was given');
    assert(typeof ok.body.confirmation === 'string', 'and it issues a confirmation');

    const bad = await collectionPlanResponse({ name: 'bad [name]', itemIds: allIds }, { reader, ledger: emptyLedger, managed: noManaged, confirmations });
    assertEq(bad.status, 400, 'a refused plan answers 400');
    assertEq(bad.body.code, 'OPERATOR_UI_COLLECTION_PLAN_BAD_NAME', 'with the rejection in the code');
    assertEq(bad.body.wrote, 'nothing', 'and still says it wrote nothing');
    assert(!JSON.stringify(bad.body).includes(SECRET_REF), 'and it discloses nothing about the catalog');

    const broken: CatalogReader = {
      countActive: () => { throw new Error('database is down'); },
      listActiveIds: () => { throw new Error('database is down'); },
      readIdentity: () => { throw new Error('database is down'); },
    };
    const down = await collectionPlanResponse({ name: 'Weekend picks', search: 'a' }, { reader: broken, ledger: emptyLedger, managed: noManaged, confirmations });
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
    // The planner's IMPORTS, not its prose. The module explains at length why it does not reach an outbox, so
    // a substring scan over the whole file would be scanning the comment rather than the code.
    const planner = readRepo('src/ops/collection-plan.ts');
    const imports = planner.split('\n').filter((line) => line.startsWith('import '));
    for (const forbidden of ['outbox', 'http-client', 'discovery', 'guarded-fetch', 'transport', 'consent', 'node:http']) {
      assert(!imports.some((line) => line.includes(forbidden)), `the planner must not import anything from ${forbidden}`);
    }
    assert(!/\bnew CatalogAuthority\b/.test(planner), 'the planner must not construct a writer');
    assert(!/(^|[^.\w])fetch\s*\(/.test(planner), 'the planner must not call fetch');

    // The MODEL's reader interface is the other half of that argument: a planner handed a writer through this
    // interface would be a planner that can write.
    const model = readRepo('src/core/publish/collection-model.ts');
    const readerIface = /export interface ManagedCollectionReader \{[\s\S]*?\n\}/.exec(model);
    assert(readerIface !== null, 'the managed reader interface exists');
    for (const forbidden of ['upsert', 'settle', 'mark', 'drop', 'rearm', 'touch']) {
      assert(!readerIface![0].toLowerCase().includes(forbidden), `the reader interface must expose no ${forbidden} method`);
    }
    // And the token and the handle are not on the summary type a plan can see.
    const summary = /export interface ManagedCollectionSummary \{[\s\S]*?\n\}/.exec(model);
    assert(summary !== null, 'the summary type exists');
    for (const forbidden of ['correlationToken', 'externalHandle']) {
      assert(!summary![0].includes(forbidden), `the summary must not carry ${forbidden}`);
    }
  });

  await test('the routes are named explicitly, never matched by prefix', () => {
    const source = readRepo('src/ops/operator-ui-collections-endpoint.ts');
    assert(source.includes(`export const COLLECTIONS_PLAN_ROUTE = '${COLLECTIONS_PLAN_ROUTE}'`), 'the plan route is a constant');
    assert(!/startsWith\('\/api\/collections/.test(source), 'a prefix match is how a route nobody meant becomes writable');
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
    const dbDeps: CollectionPlanDeps = {
      reader: dbReader,
      ledger: createLedgerReader(pool),
      managed: createManagedCollectionReader(pool),
    };
    const history = createCollectionHistoryStore(pool);

    const counts = async (): Promise<Record<string, number>> => ({
      items: (await admin.query('SELECT count(*)::int AS n FROM items')).rows[0].n as number,
      events: (await admin.query('SELECT count(*)::int AS n FROM events')).rows[0].n as number,
      ledger: (await admin.query('SELECT count(*)::int AS n FROM publish_ledger')).rows[0].n as number,
      importHistory: (await admin.query('SELECT count(*)::int AS n FROM import_history')).rows[0].n as number,
      collections: (await admin.query('SELECT count(*)::int AS n FROM managed_collections')).rows[0].n as number,
      members: (await admin.query('SELECT count(*)::int AS n FROM managed_collection_members')).rows[0].n as number,
    });

    await test('the migration created the v9 model and this build declares its version', async () => {
      assertEq(applied.result.created, 3, 'the fixture did not import');
      for (const table of ['collection_control_history', 'managed_collections', 'managed_collection_members']) {
        assert(MIGRATED_TABLES.includes(table), `${table} is not in the verified set`);
      }
      const version = (await admin.query('SELECT version FROM schema_meta WHERE id = 1')).rows[0].version as number;
      assertEq(version, MIGRATION_VERSION, 'the deployed version matches this build');
      assertEq(MIGRATION_VERSION, 9, 'this phase is schema v9');
    });

    await test('the durable model has no column that could hold identity', async () => {
      for (const table of ['managed_collections', 'managed_collection_members']) {
        const columns = (await admin.query(
          'SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name', [table],
        )).rows.map((r) => r.column_name as string);
        assert(columns.length > 0, `${table} does not exist`);
        for (const forbidden of ['title', 'year', 'provider_ref', 'provider_id', 'external_id', 'jellyfin_id',
          'library_item_id', 'search', 'api_key', 'base_url', 'path', 'url', 'host']) {
          assert(!columns.includes(forbidden), `${table} must have no ${forbidden} column`);
        }
      }
      // The member table stores the OPAQUE catalog id and a state. Nothing else about a record — pinned
      // exactly, so adding a column here is a decision somebody has to make on purpose.
      const memberColumns = (await admin.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'managed_collection_members' ORDER BY column_name`,
      )).rows.map((r) => r.column_name as string);
      assertEq(memberColumns.join(','), 'added_at,collection_id,item_id,state,synced,updated_at',
        'membership is an opaque catalog id and a state, and nothing else');
    });

    await test('the member table has NO foreign key to items, so a tombstone survives forget', async () => {
      const { rows } = await admin.query(
        `SELECT confrelid::regclass::text AS target FROM pg_constraint
          WHERE conrelid = 'public.managed_collection_members'::regclass AND contype = 'f'`);
      const targets = rows.map((r) => r.target as string);
      assert(!targets.includes('items'),
        'a cascade from items would delete the only evidence that an external copy has to be cleaned up');
      assert(targets.includes('managed_collections'), 'but a member of a deleted collection is deleted with it');
    });

    await test('the database refuses an unsafe collection row, not merely the caller', async () => {
      const good = ['jellyfin', 'a'.repeat(64), "Bob's Sci-Fi (1980s) & more.,+:_-", 'tok-1', 'c'.repeat(64), 'd'.repeat(64)];
      const id = (await pool.query('SELECT cat_collection_upsert($1,$2,$3,$4,$5,$6) AS id', good)).rows[0].id as string;
      assert(id !== null, 'a valid collection was refused');

      for (const [args, why] of [
        [['plex', 'a1'.repeat(32), 'ok', 'tok-x', 'c'.repeat(64), 'd'.repeat(64)], 'an unknown target'],
        [['jellyfin', 'not-a-key', 'ok', 'tok-x', 'c'.repeat(64), 'd'.repeat(64)], 'a malformed key'],
        [['jellyfin', 'e'.repeat(64), 'bad [name]', 'tok-x', 'c'.repeat(64), 'd'.repeat(64)], 'a bracketed name'],
        [['jellyfin', 'e'.repeat(64), 'ok', 'tok x', 'c'.repeat(64), 'd'.repeat(64)], 'a token that is not marker-safe'],
        [['jellyfin', 'e'.repeat(64), 'ok', 'tok-x', 'nope', 'd'.repeat(64)], 'a malformed plan digest'],
        [['jellyfin', 'e'.repeat(64), 'ok', '', 'c'.repeat(64), 'd'.repeat(64)], 'an empty token'],
      ] as Array<[unknown[], string]>) {
        let refused = false;
        try { await pool.query('SELECT cat_collection_upsert($1,$2,$3,$4,$5,$6)', args); } catch { refused = true; }
        assert(refused, `the database accepted ${why}`);
      }

      let badMember = false;
      try { await pool.query('SELECT cat_collection_set_members($1, $2)', [id, ['not-a-uuid']]); } catch { badMember = true; }
      assert(badMember, 'the database accepted a member that is not a record identifier');

      // The runtime role cannot touch either table directly, only through the cat_collection_* functions.
      for (const statement of [
        "INSERT INTO managed_collections (target, collection_key, name, correlation_token, plan_digest, basis_digest) VALUES ('jellyfin', repeat('f',64), 'x', 'tok-y', repeat('c',64), repeat('d',64))",
        "UPDATE managed_collections SET status = 'published'",
        'DELETE FROM managed_collections',
        "INSERT INTO managed_collection_members (collection_id, item_id) VALUES (1, '00000000-0000-5000-8000-000000000001')",
        'DELETE FROM managed_collection_members',
      ]) {
        let blocked = false;
        try { await pool.query(statement); } catch { blocked = true; }
        assert(blocked, `the runtime role could run: ${statement}`);
      }
      await admin.query('DELETE FROM managed_collections');
    });

    await test('at most ONE active collection per (target, key) is a database invariant', async () => {
      const key = collectionKeyFor('jellyfin', 'Invariant');
      const first = await upsertManagedCollection(pool, {
        target: 'jellyfin', collectionKey: key, name: 'Invariant', token: 'tok-inv-1',
        planDigest: 'a'.repeat(64), basisDigest: 'b'.repeat(64),
      });
      const second = await upsertManagedCollection(pool, {
        target: 'jellyfin', collectionKey: key, name: 'Invariant', token: 'tok-inv-2',
        planDigest: 'c'.repeat(64), basisDigest: 'd'.repeat(64),
      });
      assertEq(second, first, 'a second confirmed execute adopts the same collection rather than making another');
      const rows = (await admin.query('SELECT correlation_token, plan_digest FROM managed_collections WHERE collection_key = $1', [key])).rows;
      assertEq(rows.length, 1, 'exactly one row exists');
      assertEq(rows[0].correlation_token, 'tok-inv-1',
        'and the ORIGINAL token survives — replacing it would orphan an external artifact beyond recovery');
      assertEq(rows[0].plan_digest, 'c'.repeat(64), 'while the digests record which plan most recently defined it');

      // A terminal row falls out of the invariant, so a name is usable again after a completed revoke.
      await admin.query("UPDATE managed_collections SET status = 'revoked' WHERE id = $1", [first]);
      const third = await upsertManagedCollection(pool, {
        target: 'jellyfin', collectionKey: key, name: 'Invariant', token: 'tok-inv-3',
        planDigest: 'e'.repeat(64), basisDigest: 'f'.repeat(64),
      });
      assert(third !== first, 'after a revoke the name starts a NEW collection with a NEW token');
      await admin.query('DELETE FROM managed_collections');
    });

    await test('setting membership marks what left as removing and never deletes it', async () => {
      const id = await upsertManagedCollection(pool, {
        target: 'jellyfin', collectionKey: collectionKeyFor('jellyfin', 'Members'), name: 'Members', token: 'tok-mem',
        planDigest: 'a'.repeat(64), basisDigest: 'b'.repeat(64),
      });
      const ids = (await dbReader.listActiveIds(10, 0)).slice();
      await setManagedMembers(pool, id, ids);
      const reader = createManagedCollectionReader(pool);
      assertEq((await reader.listMembers(id)).length, 3, 'all three are members');

      await setManagedMembers(pool, id, [ids[0]!]);
      const after = await reader.listMembers(id);
      assertEq(after.length, 3, 'a dropped member is NOT deleted — the row is what drives the external removal');
      assertEq(after.filter((m) => m.state === 'removing').length, 2, 'the two that left are queued for removal');
      assertEq(after.filter((m) => m.state === 'intended').length, 1, 'and one remains intended');

      await setManagedMembers(pool, id, ids);
      const restored = await reader.listMembers(id);
      assertEq(restored.filter((m) => m.state === 'removing').length, 0, 're-selecting a record clears its removal');
      assertEq(restored.filter((m) => m.itemId !== ids[0] && m.synced).length, 0,
        'and a record that came back is no longer considered synced');
      await admin.query('DELETE FROM managed_collections');
    });

    await test('a plan against a real catalog and a real model is correct, and writes nothing at all', async () => {
      const before = await counts();
      const ids = (await dbReader.listActiveIds(10, 0)).slice();
      const result = await buildCollectionPlan(dbDeps, { name: 'Real plan', itemIds: ids });
      assert(result.ok, 'the plan was refused');
      assertEq(result.plan.counts.selected, 3, 'all three records were selected');
      assertEq(result.plan.counts.add, 2, 'the two with a reference go in');
      assertEq(result.plan.counts.blocked, 1, 'and the one without a reference cannot');
      assertEq(result.plan.collection.action, 'create', 'one collection would be created');
      assert(!JSON.stringify(result.plan).includes(SECRET_REF), 'the plan disclosed a reference value');

      const again = await buildCollectionPlan(dbDeps, { name: 'Real plan', itemIds: [...ids].reverse() });
      assert(again.ok, 'the repeat plan was refused');
      assertEq(again.plan.planDigest, result.plan.planDigest, 'the same plan twice is the same digest');
      assertEq(again.plan.basisDigest, result.plan.basisDigest, 'and the same basis');

      const after = await counts();
      assertEq(JSON.stringify(after), JSON.stringify(before), 'planning wrote a row somewhere');
    });

    await test('a v8 per-record row already in the ledger is reported and left completely alone', async () => {
      const before = await counts();
      const ids = (await dbReader.listActiveIds(10, 0)).slice();
      // Exactly what a pre-upgrade installation holds: a settled per-item intent for one of these records.
      const legacyId = (await admin.query(
        'SELECT cat_publish_plan($1, $2, $3, $4) AS id', [ids[0], 'jellyfin', 'legacy-token-1', ['title', 'providerRefs']],
      )).rows[0].id as string;
      await admin.query('SELECT cat_publish_settle($1, $2)', [legacyId, 'jf-legacy-collection-1']);

      const result = await buildCollectionPlan(dbDeps, { name: 'Real plan', itemIds: ids });
      assert(result.ok, 'the plan was refused');
      assertEq(result.plan.legacy.perItemLive, 1, 'the legacy row is reported');
      assertEq(result.plan.legacy.perItemLiveSelected, 1, 'and identified as concerning a selected record');
      assertEq(result.plan.members.find((m) => m.itemId === ids[0])?.action, 'add',
        'and the record is still an ADD: a per-record collection is not membership of this one');

      const after = await counts();
      assertEq(after.ledger, (before.ledger ?? 0) + 1, 'the fixture added exactly the one legacy row');
      assertEq(after.collections, before.collections, 'and planning adopted none of it into the grouped model');
      assertEq(after.members, before.members, 'and created no membership from it');
      const row = (await admin.query('SELECT status, external_handle, correlation_token FROM publish_ledger WHERE id = $1', [legacyId])).rows[0];
      assertEq(row.status, 'published', 'the legacy row is untouched');
      assertEq(row.external_handle, 'jf-legacy-collection-1', 'including its handle, so it stays revocable');
      assertEq(row.correlation_token, 'legacy-token-1', 'and its recovery token');
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
        { name: 'Session four', mode: 'revoke' },
      ]) {
        const result = await collectionPlanResponse(body, { ...dbDeps, confirmations, history });
        assert(result.status === 200 || result.status === 400, `a plan answered ${result.status}`);
        assertEq(result.body.wrote, 'nothing', 'every plan says it wrote nothing');
        assertEq(result.body.contacted, 'nothing', 'and contacted nothing');
      }
      const after = await counts();
      assertEq(after.items, before.items, 'planning created a record');
      assertEq(after.events, before.events, 'planning appended an event');
      assertEq(after.ledger, before.ledger, 'planning wrote a publish ledger row');
      assertEq(after.importHistory, before.importHistory, 'planning wrote an import history row');
      assertEq(after.collections, before.collections, 'planning created a managed collection');
      assertEq(after.members, before.members, 'planning created a membership row');
    });

    await test('the history is durable, identity-free, and refuses an unsafe row at the database', async () => {
      const entries = await history.list(50);
      assert(entries.length >= 2, 'the history holds the previews');
      assertEq(entries[0]!.action, 'planned', 'a preview is recorded as planned');
      assertEq(entries[0]!.outcome, 'preview', 'with the preview outcome');
      assertEq(entries[0]!.target, 'jellyfin', 'against the named target');
      assert(/^[0-9a-f]{64}$/.test(entries[0]!.planDigest), 'and a real plan digest');
      const text = JSON.stringify(entries) + renderCollectionHistory(entries);
      for (const forbidden of [SECRET_REF, 'Planned Alpha', 'p-1', 'imdb', 'jf-legacy-collection-1', 'legacy-token-1']) {
        assert(!text.includes(forbidden), `the history disclosed ${forbidden}`);
      }

      // EVERY character the PLANNER allows in a name must also survive the schema's CHECK, in BOTH tables. The
      // grammars are written in different regex dialects in different files, and a name a person can type into
      // the form but the database refuses would fail an execute AFTER the work was queued.
      const punctuated = "Bob's Sci-Fi (1980s) & more.,+:_ 9";
      assert(isUsableCollectionName(punctuated), 'the planner accepts the full punctuation set');
      await history.record({
        actor: 'operator-ui', action: 'planned', target: 'jellyfin', name: punctuated,
        planDigest: 'a'.repeat(64), basisDigest: 'b'.repeat(64),
        selected: 0, created: 0, updated: 0, unchanged: 0, revoked: 0, blocked: 0, failed: 0, outcome: 'preview',
      });
      assert((await history.list(50)).some((entry) => entry.name === punctuated), 'the history table stored it');
      const collectionId = await upsertManagedCollection(pool, {
        target: 'jellyfin', collectionKey: collectionKeyFor('jellyfin', punctuated), name: punctuated,
        token: 'tok-punct', planDigest: 'a'.repeat(64), basisDigest: 'b'.repeat(64),
      });
      assert(collectionId !== null, 'and the collection table stored it too');
      await admin.query('DELETE FROM managed_collections WHERE id = $1', [collectionId]);

      // Phase 271's two verbs must be storable, including on a database that pre-dates them.
      for (const action of ['audited', 'repaired'] as const) {
        await history.record({
          actor: 'cli', action, target: 'jellyfin', name: 'audit',
          planDigest: 'a'.repeat(64), basisDigest: 'b'.repeat(64),
          selected: 0, created: 0, updated: 0, unchanged: 0, revoked: 0, blocked: 0, failed: 0, outcome: 'preview',
        });
      }

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

      let direct = false;
      try {
        await pool.query("INSERT INTO collection_control_history (actor, action, target, name, plan_digest, basis_digest, selected, created, updated, unchanged, revoked, blocked, failed, outcome) VALUES ('cli','planned','jellyfin','x', repeat('a',64), repeat('b',64), 0,0,0,0,0,0,0,'preview')");
      } catch { direct = true; }
      assert(direct, 'the runtime role can INSERT into the history table directly');
      for (const statement of [
        "UPDATE collection_control_history SET outcome = 'complete'",
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
