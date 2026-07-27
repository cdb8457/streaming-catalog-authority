import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ITEM_ID_RE } from '../core/catalog/events.js';
import type { ItemIdentity } from '../core/catalog/authority.js';
import type { CatalogReader } from './operator-ui-catalog-browse.js';

// Phase 267 — deciding what WOULD be done to a Jellyfin library, from state this installation already holds.
//
// THE ONE PROPERTY EVERYTHING ELSE RESTS ON: PLANNING MAKES NO EXTERNAL CALL. Not a probe, not a "just to
// check whether it exists", not a HEAD request. A plan is computed from two local sources — the catalog
// (SELECT + decrypt) and the publish ledger (SELECT) — and that is provable from this module's TYPES: the
// only collaborators it accepts are a `CatalogReader` (three SELECTs) and a `LedgerReader` (one SELECT).
// There is no fetch, no client, no adapter and no outbox in scope, so "a preview contacted nothing" is a fact
// about what the function was given rather than a promise about what it did.
//
// AND PLANNING WRITES NOTHING, FOR THE SAME REASON. No `CatalogAuthority`, no outbox, no history store is a
// parameter of `buildCollectionPlan`. The caller that records a plan in the audit history does so afterwards,
// with a store this function never sees.
//
// WHY THE LEDGER AND NOT JELLYFIN. "Does this collection already exist over there?" is the question a plan
// wants answered, and asking Jellyfin is both a network call and the wrong source: the ledger is what makes an
// external copy REVOCABLE, so an artifact the ledger does not know about is one this product must not adopt
// silently. Planning against the ledger means a plan can only ever propose work this installation can undo.
//
// DETERMINISM IS THE FEATURE. Given the same catalog rows, the same ledger rows and the same name, this
// produces byte-identical output — the same actions, in the same order, with the same digest. That is what
// makes a digest usable as a confirmation: an operator confirms a NUMBER, and the number is only meaningful
// if the same inputs cannot produce a different one. Every ordering here is total (item id is the tie-break),
// every serialisation writes its keys explicitly rather than relying on insertion order, and nothing consults
// a clock or a random source.
//
// STALENESS IS A SEPARATE DIGEST, DELIBERATELY. The PLAN digest covers what would be done. The BASIS digest
// covers what it was decided from — every selected item's identity and every relevant ledger row's state.
// Two different states can imply the same actions (an item whose year changed still just needs creating), and
// executing against a changed catalog on the strength of an unchanged plan digest is exactly the confusion
// this pair prevents. Phase 268 requires BOTH to match.
//
// NOTHING IN A PLAN DISCLOSES A PROVIDER REFERENCE. An action carries the item id and the title the browse
// panel already shows, plus ref TYPES and a COUNT. Values never appear — that boundary is `withProviderRef`'s
// and a planning surface is not it.

export const COLLECTION_PLAN_REPORT = 'phase-267-collection-plan';
export const COLLECTION_PLAN_VERSION = 1;
/** The only target this plane drives. Named, not derived, so a new target cannot appear by accident. */
export const COLLECTION_PLAN_TARGET = 'jellyfin';

/** How many catalog records one plan may cover. A plan somebody cannot read is a plan nobody checks. */
export const COLLECTION_PLAN_MAX_ITEMS = 500;
/** How far a search-driven selection reads before it stops and says it stopped. */
export const COLLECTION_PLAN_MAX_SCAN = 1000;
/** How many identities are decrypted at once. */
export const COLLECTION_PLAN_READ_CONCURRENCY = 8;
export const COLLECTION_NAME_MIN_LENGTH = 1;
export const COLLECTION_NAME_MAX_LENGTH = 64;
export const COLLECTION_PLAN_MAX_SEARCH_LENGTH = 128;

/**
 * What a PLAN may be called.
 *
 * IT NAMES THE PLAN, NOT A JELLYFIN COLLECTION. What actually gets created is one collection per selected
 * record, named after that record and holding the library items its provider references matched — that is the
 * Phase 10/12 model and this phase does not change it. This name is the operator's label for a batch of work:
 * it is what the durable history records, what the confirmation is bound to, and what they read back later.
 *
 * A CLOSED GRAMMAR, NOT AN ESCAPER. The name reaches a durable audit row whose CHECK enforces the same shape,
 * and it is displayed back in a browser. `[` and `]` are excluded because they are the delimiters of this
 * product's own `[cat:<token>]` recovery marker, and a name containing them could forge or hide one — which is
 * how a recovery lookup adopts somebody else's collection. Control characters and leading or trailing space
 * are excluded because a name a person cannot see is a name they cannot confirm.
 */
export const COLLECTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '&,.\-_()+:]{0,63}$/;

export function isUsableCollectionName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length < COLLECTION_NAME_MIN_LENGTH || value.length > COLLECTION_NAME_MAX_LENGTH) return false;
  if (value.trim().length !== value.length) return false;
  return COLLECTION_NAME_RE.test(value);
}

export type CollectionAction = 'create' | 'update' | 'unchanged' | 'revoke' | 'blocked';

export type CollectionActionReason =
  | 'NOT_PUBLISHED'
  | 'INTENT_UNFINISHED'
  | 'ALREADY_PUBLISHED'
  | 'NO_PROVIDER_REFS'
  | 'FORGOTTEN'
  | 'UNREADABLE';

export interface CollectionPlanAction {
  readonly itemId: string;
  /** The action's target state. `blocked` means this plan cannot act on this record at all. */
  readonly action: CollectionAction;
  readonly reason: CollectionActionReason;
  /** The title the catalog panel already shows. Absent when the record could not be read. */
  readonly title: string | null;
  readonly year: number | null;
  /** Provider reference TYPES and a count. A VALUE never appears in a plan. */
  readonly refTypes: readonly string[];
  readonly refCount: number;
  /** The ledger row this action concerns, when there is one. An opaque id, never an external handle. */
  readonly intentId: string | null;
}

export interface CollectionPlanCounts {
  readonly selected: number;
  readonly create: number;
  readonly update: number;
  readonly unchanged: number;
  readonly revoke: number;
  readonly blocked: number;
}

export interface CollectionPlan {
  readonly report: typeof COLLECTION_PLAN_REPORT;
  readonly version: typeof COLLECTION_PLAN_VERSION;
  readonly target: typeof COLLECTION_PLAN_TARGET;
  readonly name: string;
  readonly actions: readonly CollectionPlanAction[];
  readonly counts: CollectionPlanCounts;
  /** True when nothing at all would change. Applying it is safe and does nothing. */
  readonly noop: boolean;
  /** A digest of WHAT WOULD BE DONE. Stable across two identical plans; the thing an operator confirms. */
  readonly planDigest: string;
  /** A digest of WHAT IT WAS DECIDED FROM. Any change to a selected record or a ledger row changes it. */
  readonly basisDigest: string;
  /** True when a search-driven selection stopped at the scan bound. */
  readonly truncated: boolean;
  readonly scanned: number;
  readonly guidance: string;
}

export type CollectionPlanRejection =
  | 'BAD_NAME'
  | 'BAD_SELECTION'
  | 'TOO_MANY_ITEMS'
  | 'EMPTY_SELECTION';

export type CollectionPlanResult =
  | { readonly ok: true; readonly plan: CollectionPlan }
  | { readonly ok: false; readonly rejection: CollectionPlanRejection; readonly message: string };

const REJECTION_MESSAGES: Record<CollectionPlanRejection, string> = {
  BAD_NAME:
    'That collection name is not one this product will use. Use 1-' + COLLECTION_NAME_MAX_LENGTH + ' characters: '
    + 'letters, digits, spaces and . , - _ \' & ( ) + :  — no brackets, which are reserved for the recovery marker '
    + 'that makes a created collection findable again.',
  BAD_SELECTION: 'That selection is not a list of record identifiers this installation could hold.',
  TOO_MANY_ITEMS: 'That selection covers more than ' + COLLECTION_PLAN_MAX_ITEMS + ' records. Narrow it: a plan nobody can read is a plan nobody checks.',
  EMPTY_SELECTION: 'Nothing is selected, so there is nothing to plan. Search the catalog and choose the records you want in this collection.',
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
 * The ledger reader, as one bounded SELECT.
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
  /** Explicit record identifiers. Takes precedence over `search` when present. */
  readonly itemIds?: unknown;
  /** A bounded, deterministic search over the catalog, used when no explicit list is given. */
  readonly search?: unknown;
}

/** Ledger states that mean "an intent exists and has not finished". Queuing again must RESUME, not duplicate. */
const UNFINISHED = new Set(['planned', 'in_flight', 'ambiguous']);
/** Ledger states that mean an external copy exists right now. */
const LIVE = new Set(['published', 'revoke_pending']);

/**
 * Build the plan.
 *
 * READ THE ORDER OF THIS FUNCTION AS THE ORDER OF ITS GUARANTEES: the name and the selection are validated
 * before anything is read; the catalog is read; the ledger is read; the actions are derived from the two; the
 * digests are computed from the derived, sorted result. Nothing later can widen what an earlier step allowed.
 */
export async function buildCollectionPlan(
  reader: CatalogReader,
  ledger: LedgerReader,
  input: CollectionSelectionInput,
): Promise<CollectionPlanResult> {
  if (!isUsableCollectionName(input.name)) return reject('BAD_NAME');

  let selected: readonly string[];
  let truncated = false;
  let scanned = 0;

  if (input.itemIds !== undefined && input.itemIds !== null) {
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
    const found = await selectBySearch(reader, search.trim());
    truncated = found.truncated;
    scanned = found.scanned;
    if (found.itemIds.length === 0) return reject('EMPTY_SELECTION');
    if (found.itemIds.length > COLLECTION_PLAN_MAX_ITEMS) return reject('TOO_MANY_ITEMS');
    selected = found.itemIds;
  }

  const identities = await readIdentities(reader, selected);
  const intents = await ledger.listIntents(COLLECTION_PLAN_TARGET, COLLECTION_PLAN_MAX_LEDGER_ROWS);

  // The LATEST row per item decides the item's external state. Rows arrive oldest-first, so the last write
  // for an item wins — a republished item is not judged by an old revoked row.
  const latest = new Map<string, LedgerIntentState>();
  for (const intent of intents) latest.set(intent.itemId, intent);

  const actions: CollectionPlanAction[] = [];
  const basisParts: string[] = [];

  for (const itemId of selected) {
    const identity = identities.get(itemId) ?? null;
    const intent = latest.get(itemId) ?? null;
    const action = decideAction(identity, intent);
    actions.push({
      itemId,
      action: action.action,
      reason: action.reason,
      title: identity === null ? null : titleOf(identity),
      year: identity === null ? null : yearOf(identity),
      refTypes: identity === null ? [] : refTypesOf(identity),
      refCount: identity === null ? 0 : (identity.providerRefs ?? []).length,
      intentId: intent === null ? null : intent.intentId,
    });
    basisParts.push(basisLine(itemId, identity, intent));
  }

  // REVOKES ARE NOT DRIVEN BY THE SELECTION, AND THAT IS DELIBERATE. A record that is merely not selected is
  // not a record somebody asked to unpublish, and proposing to delete every external copy outside the current
  // search box would be a catastrophic default. The one thing that DOES compel a revoke is erasure: a
  // published item that is no longer readable has a copy outside the crypto-shredding boundary, and that copy
  // has to come back. Those rows are added whether or not they were selected.
  const selectedSet = new Set(selected);
  const orphanIds = intents
    .filter((intent) => LIVE.has(intent.status) && !selectedSet.has(intent.itemId))
    .map((intent) => intent.itemId);
  const orphanIdentities = await readIdentities(reader, [...new Set(orphanIds)].sort());
  for (const itemId of [...new Set(orphanIds)].sort()) {
    if (orphanIdentities.has(itemId)) continue; // still readable and not selected: not this plan's business
    const intent = latest.get(itemId)!;
    actions.push({
      itemId,
      action: 'revoke',
      reason: 'FORGOTTEN',
      title: null,
      year: null,
      refTypes: [],
      refCount: 0,
      intentId: intent.intentId,
    });
    basisParts.push(basisLine(itemId, null, intent));
  }

  // A TOTAL order, so two runs over the same state produce the same document and the same digest.
  actions.sort((a, b) => (a.itemId === b.itemId ? a.action.localeCompare(b.action, 'en') : a.itemId.localeCompare(b.itemId, 'en')));
  basisParts.sort();

  const counts: CollectionPlanCounts = {
    selected: selected.length,
    create: actions.filter((a) => a.action === 'create').length,
    update: actions.filter((a) => a.action === 'update').length,
    unchanged: actions.filter((a) => a.action === 'unchanged').length,
    revoke: actions.filter((a) => a.action === 'revoke').length,
    blocked: actions.filter((a) => a.action === 'blocked').length,
  };
  const noop = counts.create === 0 && counts.update === 0 && counts.revoke === 0;
  const name = input.name as string;

  const planDigest = digest('plan', canonical({
    version: COLLECTION_PLAN_VERSION,
    target: COLLECTION_PLAN_TARGET,
    name,
    actions: actions.map((a) => canonical({ itemId: a.itemId, action: a.action, reason: a.reason })),
  }));
  const basisDigest = digest('basis', canonical({
    version: COLLECTION_PLAN_VERSION,
    target: COLLECTION_PLAN_TARGET,
    basis: basisParts,
  }));

  return {
    ok: true,
    plan: {
      report: COLLECTION_PLAN_REPORT,
      version: COLLECTION_PLAN_VERSION,
      target: COLLECTION_PLAN_TARGET,
      name,
      actions,
      counts,
      noop,
      planDigest,
      basisDigest,
      truncated,
      scanned,
      guidance: guidanceFor(counts, noop, truncated),
    },
  };
}

function guidanceFor(counts: CollectionPlanCounts, noop: boolean, truncated: boolean): string {
  const parts: string[] = [];
  if (noop) {
    parts.push('Nothing would change: every selected record is already published, or cannot be published at all. '
      + 'Confirming this plan would queue no work.');
  } else {
    parts.push(`This plan would queue ${counts.create} create(s), resume ${counts.update} unfinished intent(s) `
      + `and revoke ${counts.revoke} external copy/copies. Nothing has been queued yet and no media server has `
      + 'been contacted.');
  }
  if (counts.blocked > 0) {
    parts.push(`${counts.blocked} selected record(s) cannot be acted on: they hold no provider reference to match `
      + 'a library item with, or they have been forgotten. An erasure is never undone by a plan.');
  }
  if (truncated) {
    parts.push(`The search stopped after ${COLLECTION_PLAN_MAX_SCAN} records, so it may not have seen everything `
      + 'that matches. Narrow it before confirming.');
  }
  return parts.join(' ');
}

/**
 * The action for one record, from its identity and its latest ledger row.
 *
 * FAIL-CLOSED IN BOTH DIRECTIONS. A record that cannot be read is `blocked`, never quietly skipped — a plan
 * that silently drops what it could not read is a plan whose counts lie. A record with no provider reference
 * is `blocked` too: the Jellyfin target matches library items BY reference, so an item with none would
 * produce a create that fails at the boundary, and predicting that here is better than discovering it in the
 * outbox.
 */
function decideAction(identity: ItemIdentity | null, intent: LedgerIntentState | null): { action: CollectionAction; reason: CollectionActionReason } {
  if (identity === null) {
    // Not readable. If an external copy exists it must come back; otherwise there is nothing to do.
    if (intent !== null && LIVE.has(intent.status)) return { action: 'revoke', reason: 'FORGOTTEN' };
    return { action: 'blocked', reason: 'UNREADABLE' };
  }
  if ((identity.providerRefs ?? []).length === 0) return { action: 'blocked', reason: 'NO_PROVIDER_REFS' };
  if (intent !== null && UNFINISHED.has(intent.status)) return { action: 'update', reason: 'INTENT_UNFINISHED' };
  if (intent !== null && LIVE.has(intent.status)) return { action: 'unchanged', reason: 'ALREADY_PUBLISHED' };
  return { action: 'create', reason: 'NOT_PUBLISHED' };
}

/**
 * One line of the basis, for one record.
 *
 * It covers everything the decision above looked at, PLUS the identity fields a create would disclose — so a
 * title corrected between the preview and the confirmation invalidates the plan even though the ACTION is
 * unchanged. The reference VALUES are hashed rather than listed: the basis must change when they do, and a
 * basis is a string this process holds, digests, and never returns.
 */
function basisLine(itemId: string, identity: ItemIdentity | null, intent: LedgerIntentState | null): string {
  const identityPart = identity === null
    ? 'absent'
    : digest('identity', canonical({
      title: titleOf(identity),
      year: yearOf(identity),
      refs: (identity.providerRefs ?? [])
        .map((ref) => `${ref.type}=${digest('ref', ref.value)}`)
        .sort(),
    }));
  const intentPart = intent === null ? 'none' : `${intent.status}:${intent.settled ? 'settled' : 'open'}`;
  return `${itemId}|${identityPart}|${intentPart}`;
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

/** Domain-separated sha256. Two digests of the same bytes for different purposes are different digests. */
export function digest(domain: string, value: string): string {
  return createHash('sha256').update(`phase-267-collection/${domain}\u0000${value}`, 'utf8').digest('hex');
}

function reject(rejection: CollectionPlanRejection): CollectionPlanResult {
  return { ok: false, rejection, message: REJECTION_MESSAGES[rejection] };
}
