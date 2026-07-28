import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ITEM_ID_RE } from '../core/catalog/events.js';
import type { ItemIdentity } from '../core/catalog/authority.js';
import type { CatalogReader } from './operator-ui-catalog-browse.js';
import {
  MANAGED_COLLECTION_MAX_MEMBERS,
  collectionKeyFor,
  type ManagedCollectionMember,
  type ManagedCollectionReader,
  type ManagedCollectionSummary,
} from '../core/publish/collection-model.js';

// Phase 267 (planning), rewritten by Phase 269 (plan-level semantics).
//
// WHAT CHANGED, AND WHY IT HAD TO. Phase 267 named the PLAN and created one collection PER RECORD — so a plan
// of thirty records produced thirty Jellyfin collections, each named after its own record, and the field
// labelled "collection name" named none of them. That was documented honestly and it was still the wrong
// product: an operator who types a name and ticks thirty records has described ONE collection with thirty
// things in it. A plan now addresses exactly one managed collection, identified by
// `collectionKeyFor(target, name)`, and its actions are MEMBERSHIP actions.
//
// THE PROPERTIES THAT DID NOT CHANGE, BECAUSE THEY ARE WHY ANY OF THIS IS SAFE:
//
//   PLANNING MAKES NO EXTERNAL CALL, AND THAT IS PROVABLE FROM THE TYPES. The collaborators are a
//   `CatalogReader` (three SELECTs), a `LedgerReader` (one SELECT) and a `ManagedCollectionReader` (SELECTs
//   only, by construction of that interface). There is no fetch, no client, no adapter, no outbox and no
//   authority in this module's scope, so "a preview contacted nothing" is a fact about what the function was
//   given rather than a promise about what it did.
//
//   PLANNING WRITES NOTHING, FOR THE SAME REASON. No writer of any table is a parameter of
//   `buildCollectionPlan`. The caller that records a preview in the audit history does so afterwards, with a
//   store this function never sees.
//
//   DETERMINISM IS THE FEATURE. Same catalog, same ledger, same managed state, same name, same mode ->
//   byte-identical output and the same two digests. Every ordering is total (item id is the tie-break), the
//   canonical serialiser writes keys in sorted order explicitly, and nothing consults a clock or a random
//   source. An operator confirms a NUMBER, and a number is only meaningful if the same inputs cannot produce
//   a different one.
//
//   TWO DIGESTS, MEANING DIFFERENT THINGS. The PLAN digest covers what would be done. The BASIS digest covers
//   what it was decided from — every selected record's identity (references hashed, never listed), the
//   managed collection's durable state, and its recorded membership. Two different states can imply the same
//   actions, so the pair is what makes "the world moved" detectable, and execution requires BOTH to still
//   match.
//
//   NOTHING IN A PLAN DISCLOSES A PROVIDER REFERENCE, A JELLYFIN ID, AN EXTERNAL HANDLE OR A RECOVERY TOKEN.
//   An action carries the record id and the title the catalog panel already shows to the same authenticated
//   operator, plus reference TYPES and a count.
//
// THE V8 PER-ITEM ROWS ARE REPORTED, NEVER REINTERPRETED. Collections created before this phase live in
// `publish_ledger`, one row per record. This planner does not read them as membership, does not adopt them
// into a group, and does not propose acting on them — it COUNTS them, so an operator can see that they exist.
// They are deliberately outside both digests: no action in this plan is decided from them, so a legacy row
// settling between a preview and an execute must not invalidate a plan it had no part in.

export const COLLECTION_PLAN_REPORT = 'phase-269-collection-plan';
export const COLLECTION_PLAN_VERSION = 2;
/**
 * The only target this plane drives. Named, not derived, so a new target cannot appear by accident.
 *
 * IT IS DECLARED HERE AND NOWHERE IN `src/core/publish`. That module is the target-agnostic machinery and
 * `test/deploy.ts` has enforced since Phase 9 that nothing in it names a provider; every function there takes
 * `target` as a parameter, and this is the one place that answers it for this installation.
 */
export const COLLECTION_PLAN_TARGET = 'jellyfin';

/** How many catalog records one collection may hold. A plan somebody cannot read is a plan nobody checks. */
export const COLLECTION_PLAN_MAX_ITEMS = MANAGED_COLLECTION_MAX_MEMBERS;
/** How far a search-driven selection reads before it stops and says it stopped. */
export const COLLECTION_PLAN_MAX_SCAN = 1000;
/** How many identities are decrypted at once. */
export const COLLECTION_PLAN_READ_CONCURRENCY = 8;
export const COLLECTION_NAME_MIN_LENGTH = 1;
export const COLLECTION_NAME_MAX_LENGTH = 64;
export const COLLECTION_PLAN_MAX_SEARCH_LENGTH = 128;

/**
 * What a COLLECTION may be called.
 *
 * IT NOW NAMES THE COLLECTION, AND THAT REMOVES A DISCLOSURE RATHER THAN ADDING ONE. Through Phase 268 the
 * external collection was named after the record it held — a catalog title, decrypted and sent to a media
 * server. A grouped collection is named after a string the operator typed into this product's own form, so a
 * title no longer has to leave the boundary to name anything.
 *
 * A CLOSED GRAMMAR, NOT AN ESCAPER. The name reaches a durable audit row and a durable collection row whose
 * CHECKs enforce the same shape, it is displayed back in a browser, and it is sent to a media server. `[` and
 * `]` are excluded because they delimit this product's own `[cat:<token>]` recovery marker, and a name
 * containing them could forge or hide one — which is how a recovery lookup adopts somebody else's collection.
 * Control characters and leading or trailing space are excluded because a name a person cannot see is a name
 * they cannot confirm.
 */
export const COLLECTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '&,.\-_()+:]{0,63}$/;

export function isUsableCollectionName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length < COLLECTION_NAME_MIN_LENGTH || value.length > COLLECTION_NAME_MAX_LENGTH) return false;
  if (value.trim().length !== value.length) return false;
  return COLLECTION_NAME_RE.test(value);
}

/** What a plan does to the collection as a whole. */
export type CollectionAction = 'create' | 'update' | 'unchanged' | 'revoke' | 'blocked';

export type CollectionReason =
  | 'ABSENT'
  | 'MEMBERSHIP_DIFFERS'
  | 'UNSETTLED'
  | 'IN_SYNC'
  | 'NO_MEMBERS'
  | 'EMPTIED'
  | 'OPERATOR_REVOKE';

/** What a plan does to one record's place in the collection. */
export type MemberAction = 'add' | 'keep' | 'remove' | 'blocked';

export type MemberReason =
  | 'NOT_A_MEMBER'
  | 'ALREADY_MEMBER'
  /** Selected again after being dropped, before any pass acted on the drop. See `decideMember`. */
  | 'RESTORED'
  | 'DESELECTED'
  | 'PENDING_REMOVAL'
  | 'FORGOTTEN'
  | 'NO_PROVIDER_REFS'
  | 'UNREADABLE'
  | 'REVOKING';

export interface CollectionPlanMember {
  readonly itemId: string;
  readonly action: MemberAction;
  readonly reason: MemberReason;
  /** The title the catalog panel already shows. Absent when the record could not be read. */
  readonly title: string | null;
  readonly year: number | null;
  /** Provider reference TYPES and a count. A VALUE never appears in a plan. */
  readonly refTypes: readonly string[];
  readonly refCount: number;
  /** Whether this record is already a recorded member of the managed collection. */
  readonly member: boolean;
}

export interface CollectionPlanCounts {
  readonly selected: number;
  readonly add: number;
  readonly keep: number;
  readonly remove: number;
  readonly blocked: number;
  /** How many records the collection would hold once this plan has been carried out. */
  readonly resulting: number;
}

/** Advisory context about the v8 per-item collections. NOT part of either digest — see the header. */
export interface CollectionPlanLegacy {
  /** Per-item ledger rows for this target with a live external copy. */
  readonly perItemLive: number;
  /** Of those, how many concern a record this plan selected. */
  readonly perItemLiveSelected: number;
  /** Per-item rows already queued for revocation. */
  readonly perItemRevokePending: number;
}

export interface CollectionPlanCollection {
  readonly action: CollectionAction;
  readonly reason: CollectionReason;
  /** The durable state of the managed collection right now, or `absent` when there is none. */
  readonly state: ManagedCollectionSummary['status'] | 'absent';
  /** Whether an external handle has been captured. The HANDLE ITSELF never reaches a plan. */
  readonly settled: boolean;
  /** How many records the collection holds right now. */
  readonly members: number;
}

export type CollectionPlanMode = 'sync' | 'revoke';

export interface CollectionPlan {
  readonly report: typeof COLLECTION_PLAN_REPORT;
  readonly version: typeof COLLECTION_PLAN_VERSION;
  readonly target: typeof COLLECTION_PLAN_TARGET;
  readonly name: string;
  /** The durable identity this plan addresses. Derived from the target and the name, never random. */
  readonly collectionKey: string;
  readonly mode: CollectionPlanMode;
  readonly collection: CollectionPlanCollection;
  readonly members: readonly CollectionPlanMember[];
  readonly counts: CollectionPlanCounts;
  readonly legacy: CollectionPlanLegacy;
  /** True when nothing at all would change. Applying it is safe and does nothing. */
  readonly noop: boolean;
  /** A digest of WHAT WOULD BE DONE. Stable across two identical plans; the thing an operator confirms. */
  readonly planDigest: string;
  /** A digest of WHAT IT WAS DECIDED FROM. Any change to a selected record or the managed state changes it. */
  readonly basisDigest: string;
  /** True when a search-driven selection stopped at the scan bound. */
  readonly truncated: boolean;
  readonly scanned: number;
  readonly guidance: string;
}

export type CollectionPlanRejection =
  | 'BAD_NAME'
  | 'BAD_MODE'
  | 'BAD_SELECTION'
  | 'TOO_MANY_ITEMS'
  | 'EMPTY_SELECTION'
  | 'NOTHING_TO_REVOKE';

export type CollectionPlanResult =
  | { readonly ok: true; readonly plan: CollectionPlan }
  | { readonly ok: false; readonly rejection: CollectionPlanRejection; readonly message: string };

const REJECTION_MESSAGES: Record<CollectionPlanRejection, string> = {
  BAD_NAME:
    'That collection name is not one this product will use. Use 1-' + COLLECTION_NAME_MAX_LENGTH + ' characters: '
    + 'letters, digits, spaces and . , - _ \' & ( ) + :  — no brackets, which are reserved for the recovery marker '
    + 'that makes a created collection findable again.',
  BAD_MODE: 'That is not a mode this planner has. Use "sync" to define what the collection holds, or "revoke" to remove it.',
  BAD_SELECTION: 'That selection is not a list of record identifiers this installation could hold.',
  TOO_MANY_ITEMS: 'That selection covers more than ' + COLLECTION_PLAN_MAX_ITEMS + ' records. Narrow it: a collection nobody can read is a collection nobody checks.',
  EMPTY_SELECTION: 'Nothing is selected, so there is nothing to put in this collection. Search the catalog and choose the records you want in it.',
  NOTHING_TO_REVOKE: 'There is no managed collection by that name on this installation, so there is nothing to revoke. Check the name against the collection status.',
};

/** One publish-ledger row, as much of it as planning is allowed to see. Identity-free by construction. */
export interface LedgerIntentState {
  readonly intentId: string;
  readonly itemId: string;
  readonly status: string;
  /** Whether a handle has been settled. The HANDLE ITSELF never reaches a plan. */
  readonly settled: boolean;
}

export interface LedgerReader {
  /** Every ledger row for this target, oldest first, bounded. A SELECT and nothing else. */
  listIntents(target: string, limit: number): Promise<readonly LedgerIntentState[]>;
}

/** How many ledger rows one plan considers. Beyond this a plan reports truncation rather than guessing. */
export const COLLECTION_PLAN_MAX_LEDGER_ROWS = 5000;

/**
 * The legacy per-item ledger reader, as one bounded SELECT.
 *
 * The external handle is deliberately NOT selected. A handle is what makes an external copy revocable, it is
 * meaningless outside the revoker, and a column that is never read cannot be leaked by a panel that renders
 * whatever it is given.
 */
export function createLedgerReader(pool: Pool): LedgerReader {
  return {
    listIntents: async (target, limit) => {
      const bounded = Math.max(1, Math.min(Math.trunc(limit), COLLECTION_PLAN_MAX_LEDGER_ROWS));
      const { rows } = await pool.query(
        `SELECT id, item_id, status, (external_handle IS NOT NULL) AS settled
           FROM publish_ledger WHERE target = $1 ORDER BY id ASC LIMIT $2`,
        [target, bounded],
      );
      return rows.map((row) => ({
        intentId: String(row.id),
        itemId: String(row.item_id),
        status: String(row.status),
        settled: row.settled === true,
      }));
    },
  };
}

export interface CollectionSelectionInput {
  readonly name: unknown;
  /** `sync` (default) defines what the collection holds; `revoke` removes the collection entirely. */
  readonly mode?: unknown;
  /** Explicit record identifiers. Takes precedence over `search` when present. */
  readonly itemIds?: unknown;
  /** A bounded, deterministic search over the catalog, used when no explicit list is given. */
  readonly search?: unknown;
}

/** Legacy per-item ledger states that mean an external copy exists right now. */
const LEGACY_LIVE = new Set(['published', 'revoke_pending']);

export interface CollectionPlanDeps {
  readonly reader: CatalogReader;
  readonly ledger: LedgerReader;
  readonly managed: ManagedCollectionReader;
}

/**
 * Build the plan.
 *
 * READ THE ORDER OF THIS FUNCTION AS THE ORDER OF ITS GUARANTEES: the name, the mode and the selection are
 * validated before anything is read; the managed collection is read; the catalog is read; the actions are
 * derived from the two; the digests are computed from the derived, sorted result. Nothing later can widen what
 * an earlier step allowed.
 */
export async function buildCollectionPlan(
  deps: CollectionPlanDeps,
  input: CollectionSelectionInput,
): Promise<CollectionPlanResult> {
  if (!isUsableCollectionName(input.name)) return reject('BAD_NAME');
  const name = input.name;

  const mode = parseMode(input.mode);
  if (mode === null) return reject('BAD_MODE');

  const collectionKey = collectionKeyFor(COLLECTION_PLAN_TARGET, name);
  const existing = await deps.managed.findActive(COLLECTION_PLAN_TARGET, collectionKey);
  const recorded: readonly ManagedCollectionMember[] = existing === null
    ? []
    : await deps.managed.listMembers(existing.id);
  const recordedById = new Map(recorded.map((row) => [row.itemId, row]));

  let selected: readonly string[];
  let truncated = false;
  let scanned = 0;

  if (mode === 'revoke') {
    // A REVOKE IS NOT DRIVEN BY A SELECTION. It removes the collection; which records it happened to hold is
    // an output, not an input. Refusing a selection here is deliberate: a caller who sends one has misread
    // what this mode does, and quietly ignoring it would let them believe they revoked something narrower.
    if (input.itemIds !== undefined && input.itemIds !== null) return reject('BAD_SELECTION');
    if (input.search !== undefined && input.search !== null) return reject('BAD_SELECTION');
    if (existing === null) return reject('NOTHING_TO_REVOKE');
    selected = [];
  } else if (input.itemIds !== undefined && input.itemIds !== null) {
    const parsed = parseItemIds(input.itemIds);
    if (parsed === null) return reject('BAD_SELECTION');
    if (parsed.length > COLLECTION_PLAN_MAX_ITEMS) return reject('TOO_MANY_ITEMS');
    if (parsed.length === 0) return reject('EMPTY_SELECTION');
    selected = parsed;
    scanned = parsed.length;
  } else {
    const search = input.search;
    if (typeof search !== 'string' || search.trim() === '' || search.length > COLLECTION_PLAN_MAX_SEARCH_LENGTH) {
      return reject('BAD_SELECTION');
    }
    const found = await selectBySearch(deps.reader, search.trim());
    truncated = found.truncated;
    scanned = found.scanned;
    if (found.itemIds.length === 0) return reject('EMPTY_SELECTION');
    if (found.itemIds.length > COLLECTION_PLAN_MAX_ITEMS) return reject('TOO_MANY_ITEMS');
    selected = found.itemIds;
  }

  // The union of what was selected and what is already recorded: a plan has to say something about every
  // record whose membership it would change, and a record being dropped is exactly such a change.
  const considered = [...new Set([...selected, ...recorded.map((row) => row.itemId)])].sort((a, b) => a.localeCompare(b, 'en'));
  const identities = await readIdentities(deps.reader, considered);
  const selectedSet = new Set(selected);

  const members: CollectionPlanMember[] = [];
  const basisParts: string[] = [];
  for (const itemId of considered) {
    const identity = identities.get(itemId) ?? null;
    const row = recordedById.get(itemId) ?? null;
    const decided = decideMember(mode, selectedSet.has(itemId), identity, row);
    members.push({
      itemId,
      action: decided.action,
      reason: decided.reason,
      title: identity === null ? null : titleOf(identity),
      year: identity === null ? null : yearOf(identity),
      refTypes: identity === null ? [] : refTypesOf(identity),
      refCount: identity === null ? 0 : (identity.providerRefs ?? []).length,
      member: row !== null && row.state === 'intended',
    });
    basisParts.push(basisLine(itemId, identity, row));
  }

  // A TOTAL order, so two runs over the same state produce the same document and the same digest.
  members.sort((a, b) => (a.itemId === b.itemId ? a.action.localeCompare(b.action, 'en') : a.itemId.localeCompare(b.itemId, 'en')));
  basisParts.sort();

  const add = members.filter((m) => m.action === 'add').length;
  const keep = members.filter((m) => m.action === 'keep').length;
  const remove = members.filter((m) => m.action === 'remove').length;
  const blocked = members.filter((m) => m.action === 'blocked').length;
  const counts: CollectionPlanCounts = {
    selected: selected.length,
    add, keep, remove, blocked,
    resulting: add + keep,
  };

  const collection = decideCollection(mode, existing, counts);
  const noop = collection.action === 'unchanged' || collection.action === 'blocked';

  const legacyRows = await deps.ledger.listIntents(COLLECTION_PLAN_TARGET, COLLECTION_PLAN_MAX_LEDGER_ROWS);
  const legacy: CollectionPlanLegacy = {
    perItemLive: legacyRows.filter((row) => LEGACY_LIVE.has(row.status)).length,
    perItemLiveSelected: legacyRows.filter((row) => LEGACY_LIVE.has(row.status) && selectedSet.has(row.itemId)).length,
    perItemRevokePending: legacyRows.filter((row) => row.status === 'revoke_pending').length,
  };

  const planDigest = digest('plan', canonical({
    version: COLLECTION_PLAN_VERSION,
    target: COLLECTION_PLAN_TARGET,
    name,
    mode,
    collectionKey,
    collection: canonical({ action: collection.action, reason: collection.reason }),
    members: members.map((m) => canonical({ itemId: m.itemId, action: m.action, reason: m.reason })),
  }));
  const basisDigest = digest('basis', canonical({
    version: COLLECTION_PLAN_VERSION,
    target: COLLECTION_PLAN_TARGET,
    collectionKey,
    // The managed collection's own durable state. A settle, a failed attempt, another operator's execute or a
    // reconcile that synced membership all move this without moving any ACTION — which is exactly the class of
    // change that must invalidate a confirmation.
    state: existing === null
      ? 'absent'
      : canonical({
        status: existing.status,
        settled: existing.settled,
        needsSync: existing.needsSync,
        attemptCount: existing.attemptCount,
      }),
    basis: basisParts,
  }));

  return {
    ok: true,
    plan: {
      report: COLLECTION_PLAN_REPORT,
      version: COLLECTION_PLAN_VERSION,
      target: COLLECTION_PLAN_TARGET,
      name,
      collectionKey,
      mode,
      collection,
      members,
      counts,
      legacy,
      noop,
      planDigest,
      basisDigest,
      truncated,
      scanned,
      guidance: guidanceFor(mode, collection, counts, legacy, truncated),
    },
  };
}

function parseMode(raw: unknown): CollectionPlanMode | null {
  if (raw === undefined || raw === null || raw === 'sync') return 'sync';
  if (raw === 'revoke') return 'revoke';
  return null;
}

/**
 * The action for one record's membership.
 *
 * FAIL-CLOSED IN BOTH DIRECTIONS, AND THE ERASURE CASE OUTRANKS EVERYTHING. A record that cannot be read is
 * never quietly skipped: if it is already a member its library items have to come back OUT (`remove`), and if
 * it is not, it cannot go in (`blocked`). A record with no provider reference is the same shape of problem —
 * the target matches library items BY reference, so a record with none contributes nothing and a member that
 * has lost its last reference is a member whose items nothing can justify keeping.
 *
 * A QUEUED REMOVAL IS A DECISION, NOT A VERDICT, AND THE ORDER OF THESE TESTS IS WHAT MAKES THAT TRUE. Queuing
 * is not doing: a member in `removing` has been dropped from the plan but its library items are still out
 * there until a pass takes them out. An operator who drops a record and changes their mind before that pass
 * runs must be able to say so — and until this ordering was corrected they could not, because `removing` was
 * tested FIRST and returned `remove` whatever else was true. Re-selecting the record produced a plan that
 * still removed it; if it was the last member, the collection was revoked out from under them.
 *
 * So `removing` is no longer a test of its own. A row in that state is judged by the same three questions as
 * any other: can this record still be read, does it still have a reference, and is it selected NOW. Selected,
 * readable and referenced means it belongs — `RESTORED` rather than `NOT_A_MEMBER`, because the row exists and
 * is being put back rather than created. Not selected means it stays queued, and says `PENDING_REMOVAL` so the
 * plan distinguishes "you dropped this a moment ago" from "you dropped this just now".
 *
 * WHAT A RE-SELECTION CANNOT DO IS OVERRIDE AN ERASURE. The unreadable and no-reference tests come first, so a
 * forgotten record that somebody ticks again is still `remove`/`FORGOTTEN`. That is the one direction this
 * must never be persuadable in.
 */
function decideMember(
  mode: CollectionPlanMode,
  isSelected: boolean,
  identity: ItemIdentity | null,
  row: ManagedCollectionMember | null,
): { action: MemberAction; reason: MemberReason } {
  const isMember = row !== null;
  if (mode === 'revoke') {
    return isMember ? { action: 'remove', reason: 'REVOKING' } : { action: 'blocked', reason: 'REVOKING' };
  }
  if (identity === null) {
    return isMember
      ? { action: 'remove', reason: 'FORGOTTEN' }
      : { action: 'blocked', reason: 'UNREADABLE' };
  }
  if ((identity.providerRefs ?? []).length === 0) {
    return isMember
      ? { action: 'remove', reason: 'NO_PROVIDER_REFS' }
      : { action: 'blocked', reason: 'NO_PROVIDER_REFS' };
  }
  const pendingRemoval = row !== null && row.state === 'removing';
  if (!isSelected) {
    return { action: 'remove', reason: pendingRemoval ? 'PENDING_REMOVAL' : 'DESELECTED' };
  }
  // Selected, readable, and matchable: it belongs in the collection. A row that was on its way out is put
  // BACK — `setManagedMembers` returns it to `intended` and clears `synced`, so the next pass re-checks it
  // rather than trusting an observation made before the operator changed their mind.
  if (pendingRemoval) return { action: 'add', reason: 'RESTORED' };
  return isMember ? { action: 'keep', reason: 'ALREADY_MEMBER' } : { action: 'add', reason: 'NOT_A_MEMBER' };
}

/**
 * The action for the collection as a whole.
 *
 * AN EMPTY RESULT IS A REVOKE, NOT AN EMPTY COLLECTION. A managed collection that would hold nothing is not a
 * collection anybody asked for: leaving it out there is drift that the next drift audit has to explain, and
 * silently keeping it would mean a plan that removed every member reported success while an external artifact
 * survived. Where there is nothing out there yet, an empty result is simply `blocked` — this product does not
 * create an empty collection to then delete it.
 */
function decideCollection(
  mode: CollectionPlanMode,
  existing: ManagedCollectionSummary | null,
  counts: CollectionPlanCounts,
): CollectionPlanCollection {
  const state = existing === null ? 'absent' as const : existing.status;
  const settled = existing !== null && existing.settled;
  const members = existing === null ? 0 : existing.members;

  if (mode === 'revoke') {
    return { action: 'revoke', reason: 'OPERATOR_REVOKE', state, settled, members };
  }
  if (existing === null) {
    return counts.resulting === 0
      ? { action: 'blocked', reason: 'NO_MEMBERS', state, settled, members }
      : { action: 'create', reason: 'ABSENT', state, settled, members };
  }
  if (counts.resulting === 0) {
    return { action: 'revoke', reason: 'EMPTIED', state, settled, members };
  }
  if (existing.status !== 'published') {
    return { action: 'update', reason: 'UNSETTLED', state, settled, members };
  }
  if (counts.add > 0 || counts.remove > 0 || existing.needsSync) {
    return { action: 'update', reason: 'MEMBERSHIP_DIFFERS', state, settled, members };
  }
  return { action: 'unchanged', reason: 'IN_SYNC', state, settled, members };
}

function guidanceFor(
  mode: CollectionPlanMode,
  collection: CollectionPlanCollection,
  counts: CollectionPlanCounts,
  legacy: CollectionPlanLegacy,
  truncated: boolean,
): string {
  const parts: string[] = [];
  if (mode === 'revoke') {
    parts.push(`This plan would remove the whole collection and the ${collection.members} record(s) it holds from `
      + 'your media server. Nothing has been queued yet and no media server has been contacted.');
  } else if (collection.action === 'unchanged') {
    parts.push(`Nothing would change: the collection already holds exactly these ${counts.keep} record(s). `
      + 'Confirming this plan would queue no work.');
  } else if (collection.action === 'blocked') {
    parts.push('None of the selected records can go into a collection: they hold no provider reference to match a '
      + 'library item with, or they have been forgotten. Nothing would be created.');
  } else if (collection.action === 'revoke') {
    parts.push('Every record would leave this collection, so the collection itself would be removed rather than '
      + 'left empty on your media server. Nothing has been queued yet.');
  } else {
    const verb = collection.action === 'create' ? 'create one collection' : 'update one collection';
    parts.push(`This plan would ${verb} holding ${counts.resulting} record(s): ${counts.add} to add, `
      + `${counts.keep} already in it, ${counts.remove} to take out. Nothing has been queued yet and no media `
      + 'server has been contacted.');
  }
  if (counts.blocked > 0) {
    parts.push(`${counts.blocked} selected record(s) cannot be put in: they hold no provider reference to match a `
      + 'library item with, or they have been forgotten. An erasure is never undone by a plan.');
  }
  if (legacy.perItemLive > 0) {
    parts.push(`${legacy.perItemLive} collection(s) created by the older one-per-record workflow are still tracked `
      + 'separately. This plan does not read, adopt or change them; they are still revocable on their own terms.');
  }
  if (truncated) {
    parts.push(`The search stopped after ${COLLECTION_PLAN_MAX_SCAN} records, so it may not have seen everything `
      + 'that matches. Narrow it before confirming.');
  }
  return parts.join(' ');
}

/**
 * One line of the basis, for one record.
 *
 * It covers everything the decision above looked at, PLUS the identity fields a create would disclose — so a
 * reference corrected between the preview and the confirmation invalidates the plan even though the ACTION is
 * unchanged. The reference VALUES are hashed rather than listed: the basis must change when they do, and a
 * basis is a string this process holds, digests, and never returns.
 */
function basisLine(itemId: string, identity: ItemIdentity | null, row: ManagedCollectionMember | null): string {
  const identityPart = identity === null
    ? 'absent'
    : digest('identity', canonical({
      title: titleOf(identity),
      year: yearOf(identity),
      refs: (identity.providerRefs ?? [])
        .map((ref) => `${ref.type}=${digest('ref', ref.value)}`)
        .sort(),
    }));
  const memberPart = row === null ? 'none' : `${row.state}:${row.synced ? 'synced' : 'unsynced'}`;
  return `${itemId}|${identityPart}|${memberPart}`;
}

function titleOf(identity: ItemIdentity): string | null {
  return typeof identity.title === 'string' ? identity.title : null;
}

function yearOf(identity: ItemIdentity): number | null {
  return typeof identity.year === 'number' ? identity.year : null;
}

function refTypesOf(identity: ItemIdentity): readonly string[] {
  return [...new Set((identity.providerRefs ?? []).map((ref) => ref.type))].sort();
}

/**
 * A bounded, deterministic search-driven selection.
 *
 * The same matching rule the catalog panel uses (title or the operator's own record id), over the same
 * bounded window in id order, so what somebody searched for in the browser is what they select here.
 */
async function selectBySearch(
  reader: CatalogReader,
  search: string,
): Promise<{ itemIds: readonly string[]; truncated: boolean; scanned: number }> {
  const total = await reader.countActive();
  const scanLimit = Math.min(total, COLLECTION_PLAN_MAX_SCAN);
  const ids = await reader.listActiveIds(scanLimit, 0);
  const identities = await readIdentities(reader, ids);
  const needle = search.toLocaleLowerCase();
  const matched: string[] = [];
  for (const itemId of ids) {
    const identity = identities.get(itemId);
    if (identity === undefined) continue;
    const title = (titleOf(identity) ?? '').toLocaleLowerCase();
    const externalIds = identity.externalIds ?? {};
    const inExternal = Object.values(externalIds).some(
      (value) => typeof value === 'string' && value.toLocaleLowerCase().includes(needle),
    );
    if (title.includes(needle) || inExternal) matched.push(itemId);
  }
  matched.sort((a, b) => a.localeCompare(b, 'en'));
  return { itemIds: matched, truncated: total > scanLimit, scanned: ids.length };
}

/** Decrypt a bounded set of identities. A read that fails closed simply is not in the map. */
async function readIdentities(reader: CatalogReader, itemIds: readonly string[]): Promise<Map<string, ItemIdentity>> {
  const out = new Map<string, ItemIdentity>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= itemIds.length) return;
      next += 1;
      const itemId = itemIds[index]!;
      const identity = await reader.readIdentity(itemId).catch(() => null);
      if (identity !== null) out.set(itemId, identity);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(COLLECTION_PLAN_READ_CONCURRENCY, Math.max(itemIds.length, 1)) },
    worker,
  ));
  return out;
}

/**
 * Parse an explicit selection.
 *
 * Refuses rather than filters. A caller that sends one malformed id among fifty has sent a selection this
 * function cannot reproduce, and quietly planning the other forty-nine would produce a digest for a plan
 * nobody asked for. Duplicates ARE collapsed — the same record twice is the same selection — and the result
 * is sorted, so two orderings of one selection produce one plan.
 */
export function parseItemIds(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > COLLECTION_PLAN_MAX_ITEMS * 2) return null; // bounded before anything is iterated fully
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string' || !ITEM_ID_RE.test(value)) return null;
    seen.add(value);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * Canonical JSON.
 *
 * Keys are written in SORTED order, explicitly, rather than left to object insertion order — a digest that
 * depends on the order a literal happened to be written in is a digest that changes when somebody tidies the
 * code. Only the shapes this module produces are supported; anything else throws rather than being silently
 * serialised as `null`.
 */
export function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('collection plan: a non-finite number cannot be canonicalised');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  throw new Error('collection plan: a value of this type cannot be canonicalised');
}

/**
 * Domain-separated sha256. Two digests of the same bytes for different purposes are different digests.
 *
 * The separator is a NUL written as an ESCAPE, not as a literal byte — a literal one survives no diff, no
 * patch and no editor reliably, and a digest input a copy of this file can silently change is a digest input
 * that will one day be changed. It is also the one byte a domain can never contain, so `digest('a', 'bc')` and
 * `digest('ab', 'c')` cannot collide.
 */
export function digest(domain: string, value: string): string {
  return createHash('sha256').update(`phase-269-collection/${domain}\u0000${value}`, 'utf8').digest('hex');
}

function reject(rejection: CollectionPlanRejection): CollectionPlanResult {
  return { ok: false, rejection, message: REJECTION_MESSAGES[rejection] };
}
