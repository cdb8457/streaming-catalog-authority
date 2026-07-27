import type { Pool } from 'pg';
import type { CatalogAuthority } from '../core/catalog/authority.js';
import { reconcileForgotten } from '../core/publish/ledger.js';
import type { FetchLike } from '../core/adapters/jellyfin/transport.js';
import type { CatalogReader } from './operator-ui-catalog-browse.js';
import {
  COLLECTION_PLAN_MAX_ITEMS,
  COLLECTION_PLAN_TARGET,
  buildCollectionPlan,
  type LedgerReader,
} from './collection-plan.js';
import {
  CollectionConfirmations,
  type CollectionConfirmationVerdict,
} from './collection-confirmation.js';
import {
  COLLECTION_HISTORY_MAX_ROWS,
  type CollectionHistoryRecord,
  type CollectionHistoryStore,
} from './collection-history.js';
import {
  checkCollectionWriteGates,
  createCollectionRuntime,
  queueCollectionPlan,
  readCollectionStatus,
  runCollectionReconcile,
  runCollectionRevocation,
} from './collection-execution.js';

// Phase 267/268 — the collection control plane, as HTTP.
//
// SIX ROUTES, AND EXACTLY WHAT EACH ONE CAN DO:
//
//   POST /api/collections/plan       ZERO WRITES, ZERO EXTERNAL CALLS. Given a name and a selection, computes
//                                    what WOULD happen and issues a confirmation. Handed a reader and a
//                                    ledger reader and nothing else, so this is a property of its scope.
//   POST /api/collections/execute    The one route that queues work. Requires the write switches, a valid
//                                    single-use confirmation, the operator's own echo of the plan digest,
//                                    and a RECOMPUTED plan whose two digests still match. Then it writes
//                                    durable intents into the Phase 12 outbox. It contacts nothing.
//   POST /api/collections/reconcile  Drives the outbox: adopt by token, or create within the retry budget.
//                                    This is the route that talks to Jellyfin. Idempotent and restartable.
//   POST /api/collections/revoke     Queues the forgotten and deletes each queued external copy by handle.
//   GET  /api/collections/status     Ledger state by status. A read.
//   GET  /api/collections/history    The durable plan/audit history. A read.
//
// THE ORDER OF CHECKS ON THE WRITE PATH IS THE POINT, AND IT IS FAIL-CLOSED AT EVERY STEP:
//   1. the operator token          (the service, before this module is reached)
//   2. the request shape           (JSON, same-origin, bounded — shared with the import surface)
//   3. the deployment switches     (four of them, each independent, each named in its refusal)
//   4. the confirmation            (signed by THIS process, unexpired, unspent — and SPENT here)
//   5. the digest echo             (constant-time against the confirmation's own claim)
//   6. the RECOMPUTED plan         (both digests must still match: this is the stale-plan refusal)
//   7. only then, durable intents
// A refusal at any step writes nothing and sends nothing, and says which step it was.
//
// WHY RECOMPUTING IS NOT REDUNDANT WITH THE CONFIRMATION. The confirmation proves what was previewed. The
// recomputation proves the world has not moved since. A forgotten record, a competing import, another
// operator's execute, or a reconcile that settled an intent all change the basis without changing anything
// the browser can see — and queuing the previewed plan against the changed world is exactly how a duplicate
// or an unwanted external copy happens.
//
// EVERY RESPONSE STAYS INSIDE THE DISCLOSURE BOUNDARY THIS PRODUCT ALREADY HAS. A plan carries record ids and
// titles — the same two things the catalog panel already shows to the same authenticated operator — plus
// reference TYPES and counts. It never carries a reference VALUE, a Jellyfin id, an external handle, an api
// key, an address, or anything the discovery surface would not have shown.

export const COLLECTIONS_PLAN_ROUTE = '/api/collections/plan';
export const COLLECTIONS_EXECUTE_ROUTE = '/api/collections/execute';
export const COLLECTIONS_RECONCILE_ROUTE = '/api/collections/reconcile';
export const COLLECTIONS_REVOKE_ROUTE = '/api/collections/revoke';
export const COLLECTIONS_STATUS_ROUTE = '/api/collections/status';
export const COLLECTIONS_HISTORY_ROUTE = '/api/collections/history';

/** Every route in this surface. Named explicitly; a prefix match is how a route nobody meant becomes writable. */
export const COLLECTIONS_ROUTES: readonly string[] = [
  COLLECTIONS_PLAN_ROUTE, COLLECTIONS_EXECUTE_ROUTE, COLLECTIONS_RECONCILE_ROUTE,
  COLLECTIONS_REVOKE_ROUTE, COLLECTIONS_STATUS_ROUTE, COLLECTIONS_HISTORY_ROUTE,
];

/** The four routes that accept POST. The other two are GETs and answer 405 to anything else. */
export const COLLECTIONS_WRITE_ROUTES: readonly string[] = [
  COLLECTIONS_PLAN_ROUTE, COLLECTIONS_EXECUTE_ROUTE, COLLECTIONS_RECONCILE_ROUTE, COLLECTIONS_REVOKE_ROUTE,
];

/**
 * The body bound for this surface.
 *
 * A plan may name up to {@link COLLECTION_PLAN_MAX_ITEMS} records, each a 36-character UUID plus JSON
 * punctuation, so the import's 4 KiB would refuse a legitimate request. This is that, with room for the name
 * and the confirmation, and nothing more: it is still a bound, and it is still enforced as bytes arrive.
 */
export const COLLECTIONS_REQUEST_MAX_BYTES = 32 * 1024;

export const COLLECTIONS_REPORT = 'phase-267-268-collection-control-plane';

export interface CollectionsEndpointResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface CollectionsPlanDeps {
  readonly reader: CatalogReader;
  readonly ledger: LedgerReader;
  readonly confirmations: CollectionConfirmations;
  /** Optional. A history write that fails never fails the preview — the preview still wrote nothing. */
  readonly history?: CollectionHistoryStore;
}

/**
 * POST a plan preview.
 *
 * NOTHING HERE CAN WRITE A CATALOG ROW, AN EVENT, A LEDGER ROW OR AN EXTERNAL ARTIFACT. `buildCollectionPlan`
 * is handed a `CatalogReader` (three SELECTs) and a `LedgerReader` (one SELECT). There is no authority, no
 * outbox, no transport and no adapter anywhere in the scope of this function.
 *
 * The history row it appends afterwards is the ONE write, it is to the audit table, and it records that a
 * preview happened. It is deliberately outside the plan computation, and a failure to write it is reported
 * rather than allowed to fail the preview: "I showed you a plan and could not write it down" is honest, and
 * "the preview failed" would not be.
 */
export async function collectionPlanResponse(
  body: Record<string, unknown>,
  deps: CollectionsPlanDeps,
): Promise<CollectionsEndpointResponse> {
  let result: Awaited<ReturnType<typeof buildCollectionPlan>>;
  try {
    result = await buildCollectionPlan(deps.reader, deps.ledger, {
      name: body.name,
      ...(body.itemIds === undefined ? {} : { itemIds: body.itemIds }),
      ...(body.search === undefined ? {} : { search: body.search }),
    });
  } catch {
    return refusal(503, 'PLAN_UNAVAILABLE',
      'The plan could not be computed against this installation. Check Setup & Diagnostics for its state.');
  }
  if (!result.ok) {
    return {
      status: 400,
      body: {
        ok: false,
        code: `OPERATOR_UI_COLLECTION_PLAN_${result.rejection}`,
        report: COLLECTIONS_REPORT,
        wrote: 'nothing',
        contacted: 'nothing',
        message: result.message,
      },
    };
  }

  const plan = result.plan;
  const confirmation = deps.confirmations.issue({
    name: plan.name,
    planDigest: plan.planDigest,
    basisDigest: plan.basisDigest,
    create: plan.counts.create,
    update: plan.counts.update,
    revoke: plan.counts.revoke,
  });
  const recorded = await recordHistory(deps.history, {
    actor: 'operator-ui', action: 'planned', target: COLLECTION_PLAN_TARGET, name: plan.name,
    planDigest: plan.planDigest, basisDigest: plan.basisDigest,
    selected: plan.counts.selected, created: 0, updated: 0, unchanged: plan.counts.unchanged,
    revoked: 0, blocked: plan.counts.blocked, failed: 0, outcome: 'preview',
  });

  return {
    status: 200,
    body: {
      ok: true,
      code: 'OPERATOR_UI_COLLECTION_PLAN',
      report: COLLECTIONS_REPORT,
      // Said in the body as well as proved by the design, because this is the sentence an operator acts on.
      wrote: 'nothing',
      contacted: 'nothing',
      plan,
      confirmation,
      recorded,
      guidance: plan.guidance,
    },
  };
}

export interface CollectionsExecuteDeps extends CollectionsPlanDeps {
  readonly pool: Pool;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam for the ledger's own forgotten-row sweep. The running service passes the real one. */
  readonly reconcileForgotten?: (pool: Pool) => Promise<number>;
}

/**
 * POST an execute.
 *
 * THE CONFIRMATION IS VERIFIED — AND SPENT — BEFORE THE PLAN IS RECOMPUTED. That order is deliberate: a
 * caller must not be able to hold one confirmation and probe the catalog with it until the recomputation
 * happens to agree. One preview, one attempt.
 *
 * THIS FUNCTION CONTACTS NOTHING. It writes durable intents and returns. What talks to a media server is the
 * reconcile route, driven separately, so a crash between the two leaves durable rows rather than an
 * unrecorded side effect.
 */
export async function collectionExecuteResponse(
  body: Record<string, unknown>,
  deps: CollectionsExecuteDeps,
): Promise<CollectionsEndpointResponse> {
  const env = deps.env ?? process.env;

  const gates = checkCollectionWriteGates(env);
  if (!gates.ok) {
    return {
      status: 409,
      body: {
        ok: false,
        code: `OPERATOR_UI_COLLECTION_${gates.refusal}`,
        report: COLLECTIONS_REPORT,
        wrote: 'nothing',
        contacted: 'nothing',
        message: gates.message,
      },
    };
  }

  const verdict: CollectionConfirmationVerdict = deps.confirmations.verify(body.confirmation, body.confirmDigest);
  if (!verdict.ok) {
    return {
      status: verdict.rejection === 'TOO_MANY_OUTSTANDING' ? 503 : 409,
      body: {
        ok: false,
        code: `OPERATOR_UI_COLLECTION_CONFIRMATION_${verdict.rejection}`,
        report: COLLECTIONS_REPORT,
        wrote: 'nothing',
        contacted: 'nothing',
        message: verdict.message,
      },
    };
  }

  let recomputed: Awaited<ReturnType<typeof buildCollectionPlan>>;
  try {
    recomputed = await buildCollectionPlan(deps.reader, deps.ledger, {
      name: verdict.claims.name,
      ...(body.itemIds === undefined ? {} : { itemIds: body.itemIds }),
      ...(body.search === undefined ? {} : { search: body.search }),
    });
  } catch {
    return refusal(503, 'EXECUTE_UNAVAILABLE',
      'The plan could not be re-checked against this installation, so nothing was queued.');
  }
  if (!recomputed.ok) {
    // The selection stopped being plannable between the preview and now — a record was forgotten, or the
    // search no longer matches anything. That is a stale plan, said plainly.
    return staleResponse(deps, verdict.claims.name, verdict.claims.planDigest, verdict.claims.basisDigest, recomputed.message);
  }
  const plan = recomputed.plan;
  if (plan.planDigest !== verdict.claims.planDigest || plan.basisDigest !== verdict.claims.basisDigest) {
    return staleResponse(deps, verdict.claims.name, verdict.claims.planDigest, verdict.claims.basisDigest,
      'The catalog or the publish ledger changed after this plan was previewed, so what would be queued is no '
      + 'longer what you read. Nothing was queued. Preview it again and check the new plan.');
  }

  const queued = await queueCollectionPlan({
    pool: deps.pool,
    reconcileForgotten: deps.reconcileForgotten ?? reconcileForgotten,
  }, plan);

  const outcome = queued.failed === 0 ? 'complete' : 'incomplete';
  const recorded = await recordHistory(deps.history, {
    actor: 'operator-ui', action: 'queued', target: COLLECTION_PLAN_TARGET, name: plan.name,
    planDigest: plan.planDigest, basisDigest: plan.basisDigest,
    selected: plan.counts.selected, created: queued.queued, updated: queued.resumed,
    unchanged: queued.unchanged, revoked: queued.revokeQueued, blocked: queued.blocked,
    failed: queued.failed, outcome,
  });

  return {
    status: queued.failed === 0 ? 200 : 207,
    body: {
      ok: queued.failed === 0,
      code: 'OPERATOR_UI_COLLECTION_QUEUED',
      report: COLLECTIONS_REPORT,
      // The honest word. Work is DURABLE now; it has not HAPPENED yet, and conflating the two is how a
      // person believes a media server was changed when nothing has been sent.
      wrote: 'durable intents only',
      contacted: 'nothing',
      queued,
      plan: { name: plan.name, planDigest: plan.planDigest, basisDigest: plan.basisDigest, counts: plan.counts },
      recorded,
      guidance: queueGuidance(queued),
    },
  };
}

function queueGuidance(queued: Awaited<ReturnType<typeof queueCollectionPlan>>): string {
  const parts: string[] = [];
  parts.push(`Queued ${queued.queued} new intent(s); ${queued.resumed} were already queued and will be resumed `
    + `rather than duplicated; ${queued.revokeQueued} external copy/copies were queued for revocation. `
    + 'Nothing has been sent to a media server yet.');
  parts.push('Run a reconcile pass to act on them. It recovers by each intent\'s own durable token, so running '
    + 'it twice, or after a restart, cannot create the same collection twice.');
  if (queued.blocked > 0) {
    parts.push(`${queued.blocked} selected record(s) were not queued at all: they hold no provider reference to `
      + 'match a library item with, or they have been forgotten.');
  }
  if (queued.failed > 0) {
    parts.push(`${queued.failed} intent(s) could not be written. Re-previewing and executing again queues only `
      + 'what is still missing.');
  }
  return parts.join(' ');
}

async function staleResponse(
  deps: CollectionsExecuteDeps,
  name: string,
  planDigest: string,
  basisDigest: string,
  message: string,
): Promise<CollectionsEndpointResponse> {
  // A refused execute is recorded. "Somebody tried to run a stale plan" is exactly the kind of thing a
  // durable audit history exists to hold, and a refusal that leaves no trace is a refusal nobody can review.
  const recorded = await recordHistory(deps.history, {
    actor: 'operator-ui', action: 'queued', target: COLLECTION_PLAN_TARGET, name,
    planDigest, basisDigest,
    selected: 0, created: 0, updated: 0, unchanged: 0, revoked: 0, blocked: 0, failed: 0, outcome: 'refused',
  });
  return {
    status: 409,
    body: {
      ok: false,
      code: 'OPERATOR_UI_COLLECTION_PLAN_STALE',
      report: COLLECTIONS_REPORT,
      wrote: 'nothing',
      contacted: 'nothing',
      recorded,
      message,
    },
  };
}

export interface CollectionsRuntimeDeps {
  readonly pool: Pool;
  readonly authority: CatalogAuthority;
  /** INJECTED and optional: with no transport there is no way to reach a media server, whatever is set. */
  readonly fetch?: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
  readonly history?: CollectionHistoryStore;
}

/**
 * POST a reconcile.
 *
 * THE ONLY ROUTE IN THIS SERVICE THAT TALKS TO A MEDIA SERVER AND CAN CHANGE IT. It needs no confirmation,
 * and that is correct rather than an omission: it performs no NEW decision. It carries out intents that were
 * already confirmed by digest and made durable, and its behaviour on an empty queue is to do nothing at all.
 * Requiring a fresh confirmation to retry work an operator already confirmed would make the recovery path
 * harder to run than the failure it recovers from.
 */
export async function collectionReconcileResponse(deps: CollectionsRuntimeDeps): Promise<CollectionsEndpointResponse> {
  const env = deps.env ?? process.env;
  const built = createCollectionRuntime({ pool: deps.pool, authority: deps.authority, fetch: deps.fetch ?? unavailableFetch, env });
  if (!built.ok) {
    return {
      status: 409,
      body: {
        ok: false, code: `OPERATOR_UI_COLLECTION_${built.refusal}`, report: COLLECTIONS_REPORT,
        wrote: 'nothing', contacted: 'nothing', message: built.message,
      },
    };
  }
  const runtime = built.runtime;
  let result: Awaited<ReturnType<typeof runCollectionReconcile>>;
  try {
    result = await runCollectionReconcile(runtime);
  } catch {
    return refusal(503, 'RECONCILE_FAILED',
      'The reconcile pass could not complete. Nothing was left in an unrecorded state: every intent is still '
      + 'in the outbox and can be retried.');
  }
  const status = await readCollectionStatus(deps.pool).catch(() => null);
  await recordHistory(deps.history, {
    actor: 'operator-ui', action: 'reconciled', target: COLLECTION_PLAN_TARGET, name: 'reconcile',
    planDigest: ZERO_DIGEST, basisDigest: ZERO_DIGEST,
    selected: result.adopted + result.created + result.failed + result.stuck,
    created: result.created, updated: result.adopted, unchanged: 0, revoked: 0,
    blocked: result.stuck, failed: result.failed,
    outcome: result.failed === 0 && result.stuck === 0 ? 'complete' : 'incomplete',
  });
  return {
    status: 200,
    body: {
      ok: result.failed === 0,
      code: 'OPERATOR_UI_COLLECTION_RECONCILED',
      report: COLLECTIONS_REPORT,
      result,
      status,
      guidance: `Adopted ${result.adopted} intent(s) that already existed, created ${result.created}, `
        + `failed ${result.failed}, and left ${result.stuck} for a later pass. An intent is left alone rather `
        + 'than re-created whenever this product cannot prove the artifact is absent — that is what stops one '
        + 'lost response becoming two collections.',
    },
  };
}

/**
 * POST a revoke.
 *
 * Queues every published row whose item has been forgotten, then deletes each queued external copy by its
 * OPAQUE handle. A delete that fails leaves the row queued and retryable; an unrevoked copy of a forgotten
 * record is the worst state this product can be in, so it stays visible rather than being marked done.
 */
export async function collectionRevokeResponse(deps: CollectionsRuntimeDeps): Promise<CollectionsEndpointResponse> {
  const env = deps.env ?? process.env;
  const built = createCollectionRuntime({ pool: deps.pool, authority: deps.authority, fetch: deps.fetch ?? unavailableFetch, env });
  if (!built.ok) {
    return {
      status: 409,
      body: {
        ok: false, code: `OPERATOR_UI_COLLECTION_${built.refusal}`, report: COLLECTIONS_REPORT,
        wrote: 'nothing', contacted: 'nothing', message: built.message,
      },
    };
  }
  const runtime = built.runtime;
  let result: Awaited<ReturnType<typeof runCollectionRevocation>>;
  try {
    result = await runCollectionRevocation(deps.pool, runtime);
  } catch {
    return refusal(503, 'REVOKE_FAILED',
      'The revoke pass could not complete. Every external copy that was queued is still queued and still '
      + 'retryable — nothing was marked revoked that was not.');
  }
  await recordHistory(deps.history, {
    actor: 'operator-ui', action: 'revoked', target: COLLECTION_PLAN_TARGET, name: 'revoke',
    planDigest: ZERO_DIGEST, basisDigest: ZERO_DIGEST,
    selected: result.queued, created: 0, updated: 0, unchanged: 0, revoked: result.revoked,
    blocked: result.pending, failed: result.failed,
    outcome: result.failed === 0 && result.pending === 0 ? 'complete' : 'incomplete',
  });
  return {
    status: 200,
    body: {
      ok: result.failed === 0,
      code: 'OPERATOR_UI_COLLECTION_REVOKED',
      report: COLLECTIONS_REPORT,
      result,
      guidance: `Queued ${result.queued}, revoked ${result.revoked}, failed ${result.failed}, and ${result.pending} `
        + 'external copy/copies are still out there. Anything that failed stays queued and retryable rather '
        + 'than being marked done.',
    },
  };
}

/** GET the outbox state for this target. Two SELECTs, no authority, no transport. */
export async function collectionStatusResponse(pool: Pool, env: NodeJS.ProcessEnv = process.env): Promise<CollectionsEndpointResponse> {
  let status: Awaited<ReturnType<typeof readCollectionStatus>>;
  try {
    status = await readCollectionStatus(pool);
  } catch {
    return refusal(503, 'STATUS_UNAVAILABLE',
      'The outbox could not be read. Check Setup & Diagnostics for this installation\'s state.');
  }
  const gates = checkCollectionWriteGates(env);
  return {
    status: 200,
    body: {
      ok: true,
      code: 'OPERATOR_UI_COLLECTION_STATUS',
      report: COLLECTIONS_REPORT,
      status,
      // The gate verdict travels with the status so a panel can say "there is outstanding work AND this
      // installation is not allowed to act on it", which is a different situation from either alone.
      writesEnabled: gates.ok,
      writesRefusal: gates.ok ? null : gates.refusal,
      writesMessage: gates.ok ? null : gates.message,
      guidance: status.guidance,
    },
  };
}

/** GET the durable plan/audit history. One bounded, ordered SELECT. */
export async function collectionHistoryResponse(history: CollectionHistoryStore | undefined): Promise<CollectionsEndpointResponse> {
  if (history === undefined) {
    return refusal(503, 'HISTORY_UNAVAILABLE',
      'The collection history could not be read. Check Setup & Diagnostics for this installation\'s state.');
  }
  try {
    const entries = await history.list(COLLECTION_HISTORY_MAX_ROWS);
    return {
      status: 200,
      body: {
        ok: true,
        code: 'OPERATOR_UI_COLLECTION_HISTORY',
        report: COLLECTIONS_REPORT,
        entries,
        limit: COLLECTION_HISTORY_MAX_ROWS,
        guidance: entries.length === 0
          ? 'No collection plan has been previewed or queued on this installation yet.'
          : `The ${entries.length} most recent decision${entries.length === 1 ? '' : 's'}, newest first. Counts, `
            + 'digests and the names you chose — no record content is kept here, and it survives a restart.',
      },
    };
  } catch {
    return refusal(503, 'HISTORY_UNAVAILABLE',
      'The collection history could not be read. Check Setup & Diagnostics for this installation\'s state.');
  }
}

/**
 * A digest-shaped placeholder for the rows that are not about one plan.
 *
 * A reconcile and a revoke are passes over whatever the outbox holds, not executions of a named plan, and the
 * history table's CHECK requires 64 hex characters in both digest columns. Writing zeroes says "this row is
 * not about a plan" in a way that cannot be confused with a real digest, and keeps every row in one table
 * rather than splitting the audit trail across two.
 */
export const ZERO_DIGEST = '0'.repeat(64);

/**
 * A transport that cannot exist.
 *
 * Used when no real transport was injected. It is a FUNCTION rather than an `undefined` because the runtime
 * builder requires one, and it throws rather than returning an error response so that a call reaching it is
 * loud. Nothing in the running service should ever reach it: `resolveJellyfinTransport` returns a real
 * transport exactly when the network switch is on, and the gates refuse before this point when it is off.
 */
const unavailableFetch: FetchLike = () => {
  throw new Error('jellyfin: no network transport is available to this process');
};

async function recordHistory(store: CollectionHistoryStore | undefined, entry: CollectionHistoryRecord): Promise<boolean> {
  if (store === undefined) return false;
  try {
    await store.record(entry);
    return true;
  } catch {
    // A history row that could not be written is reported as `recorded: false`. It never fails the operation
    // it describes: an execute that queued work and could not write its audit row has still queued the work,
    // and saying otherwise would send an operator to re-run something that already happened.
    return false;
  }
}

function refusal(status: number, code: string, message: string): CollectionsEndpointResponse {
  return {
    status,
    body: { ok: false, code: `OPERATOR_UI_COLLECTION_${code}`, report: COLLECTIONS_REPORT, wrote: 'nothing', contacted: 'nothing', message },
  };
}
