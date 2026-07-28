import type { Pool } from 'pg';
import type { CatalogAuthority } from '../core/catalog/authority.js';
import type { FetchLike } from '../core/adapters/jellyfin/transport.js';
import type { CatalogReader } from './operator-ui-catalog-browse.js';
import type { ManagedCollectionReader } from '../core/publish/collection-model.js';
import {
  COLLECTION_PLAN_MAX_ITEMS,
  COLLECTION_PLAN_TARGET,
  buildCollectionPlan,
  type CollectionPlan,
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
  createCollectionAuditRuntime,
  createCollectionRuntime,
  queueCollectionPlan,
  readCollectionStatus,
  runCollectionReconcile,
  runCollectionRevocation,
} from './collection-execution.js';
import {
  applyCollectionRepair,
  auditCollectionDrift,
  buildCollectionRepairPlan,
  type CollectionRepairPlan,
} from './collection-drift.js';

// Phases 267-271 — the collection control plane, as HTTP.
//
// EIGHT ROUTES, AND EXACTLY WHAT EACH ONE CAN DO:
//
//   POST /api/collections/plan       ZERO WRITES, ZERO EXTERNAL CALLS. Given a name, a mode and a selection,
//                                    computes what WOULD happen to ONE managed collection and issues a
//                                    confirmation. Handed three readers and nothing else, so this is a
//                                    property of its scope.
//   POST /api/collections/execute    The one route that queues collection work. Requires the write switches, a
//                                    valid single-use confirmation, the operator's own echo of the plan
//                                    digest, and a RECOMPUTED plan whose two digests still match. Then it
//                                    writes the durable managed collection and its membership. It contacts
//                                    nothing.
//   POST /api/collections/reconcile  Creates or adopts by token, then makes membership match. This is a route
//                                    that talks to Jellyfin. Idempotent and restartable.
//   POST /api/collections/revoke     Takes the forgotten out and deletes what must go, per-item rows included.
//   POST /api/collections/audit      READ-ONLY drift comparison. It needs the network switch because it reads
//                                    a media server; it needs nothing else because it changes nothing. It
//                                    issues a repair confirmation from a SEPARATE issuer.
//   POST /api/collections/repair     Applies a digest-confirmed repair. Same four switches as an execute, its
//                                    own confirmation, its own digest echo — and it still writes durable state
//                                    only. Nothing is created or deleted on a media server until a reconcile
//                                    or revoke pass runs.
//   GET  /api/collections/status     Managed and legacy state. A read.
//   GET  /api/collections/history    The durable plan/audit history. A read.
//
// THE ORDER OF CHECKS ON A WRITE PATH IS THE POINT, AND IT IS FAIL-CLOSED AT EVERY STEP:
//   1. the operator token          (the service, before this module is reached)
//   2. the request shape           (JSON, same-origin, bounded — shared with the import surface)
//   3. the deployment switches     (four of them, each independent, each named in its refusal)
//   4. the confirmation            (signed by THIS process, unexpired, unspent — and SPENT here)
//   5. the digest echo             (constant-time against the confirmation's own claim)
//   6. the RECOMPUTED plan         (both digests must still match: this is the stale-plan refusal)
//   7. only then, durable state
// A refusal at any step writes nothing and sends nothing, and says which step it was.
//
// THE PLAN AND REPAIR CONFIRMATIONS COME FROM DIFFERENT ISSUERS WITH DIFFERENT KEYS. A confirmation for a plan
// must not verify as a confirmation for a repair: they authorise different writes, and one signing key for
// both would make "I previewed a plan" enough to apply a repair somebody else audited.
//
// EVERY RESPONSE STAYS INSIDE THE DISCLOSURE BOUNDARY THIS PRODUCT ALREADY HAS. A plan carries record ids and
// titles — the same two things the catalog panel already shows to the same authenticated operator — plus
// reference TYPES and counts. A drift finding carries counts. Neither ever carries a reference VALUE, a
// Jellyfin id, an external handle, a correlation token, an api key or an address.

export const COLLECTIONS_PLAN_ROUTE = '/api/collections/plan';
export const COLLECTIONS_EXECUTE_ROUTE = '/api/collections/execute';
export const COLLECTIONS_RECONCILE_ROUTE = '/api/collections/reconcile';
export const COLLECTIONS_REVOKE_ROUTE = '/api/collections/revoke';
export const COLLECTIONS_AUDIT_ROUTE = '/api/collections/audit';
export const COLLECTIONS_REPAIR_ROUTE = '/api/collections/repair';
export const COLLECTIONS_STATUS_ROUTE = '/api/collections/status';
export const COLLECTIONS_HISTORY_ROUTE = '/api/collections/history';

/** Every route in this surface. Named explicitly; a prefix match is how a route nobody meant becomes writable. */
export const COLLECTIONS_ROUTES: readonly string[] = [
  COLLECTIONS_PLAN_ROUTE, COLLECTIONS_EXECUTE_ROUTE, COLLECTIONS_RECONCILE_ROUTE, COLLECTIONS_REVOKE_ROUTE,
  COLLECTIONS_AUDIT_ROUTE, COLLECTIONS_REPAIR_ROUTE, COLLECTIONS_STATUS_ROUTE, COLLECTIONS_HISTORY_ROUTE,
];

/** The six routes that accept POST. The other two are GETs and answer 405 to anything else. */
export const COLLECTIONS_WRITE_ROUTES: readonly string[] = [
  COLLECTIONS_PLAN_ROUTE, COLLECTIONS_EXECUTE_ROUTE, COLLECTIONS_RECONCILE_ROUTE, COLLECTIONS_REVOKE_ROUTE,
  COLLECTIONS_AUDIT_ROUTE, COLLECTIONS_REPAIR_ROUTE,
];

/**
 * The body bound for this surface.
 *
 * A plan may name up to {@link COLLECTION_PLAN_MAX_ITEMS} records, each a 36-character UUID plus JSON
 * punctuation, so the import's 4 KiB would refuse a legitimate request. This is that, with room for the name
 * and the confirmation, and nothing more: it is still a bound, and it is still enforced as bytes arrive.
 */
export const COLLECTIONS_REQUEST_MAX_BYTES = 32 * 1024;

export const COLLECTIONS_REPORT = 'phase-269-272-collection-control-plane';

export interface CollectionsEndpointResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface CollectionsPlanDeps {
  readonly reader: CatalogReader;
  readonly ledger: LedgerReader;
  readonly managed: ManagedCollectionReader;
  readonly confirmations: CollectionConfirmations;
  /** Optional. A history write that fails never fails the preview — the preview still wrote nothing. */
  readonly history?: CollectionHistoryStore;
}

/**
 * POST a plan preview.
 *
 * NOTHING HERE CAN WRITE A CATALOG ROW, AN EVENT, A COLLECTION ROW OR AN EXTERNAL ARTIFACT.
 * `buildCollectionPlan` is handed a `CatalogReader` (three SELECTs), a `LedgerReader` (one SELECT) and a
 * `ManagedCollectionReader` (SELECTs only, by construction). There is no authority, no outbox, no transport
 * and no adapter anywhere in the scope of this function.
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
    result = await buildCollectionPlan(
      { reader: deps.reader, ledger: deps.ledger, managed: deps.managed },
      {
        name: body.name,
        ...(body.mode === undefined ? {} : { mode: body.mode }),
        ...(body.itemIds === undefined ? {} : { itemIds: body.itemIds }),
        ...(body.search === undefined ? {} : { search: body.search }),
      },
    );
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
  const confirmation = deps.confirmations.issue(claimsFor(plan));
  const recorded = await recordHistory(deps.history, historyFor('operator-ui', 'planned', plan, {
    selected: plan.counts.selected, created: 0, updated: 0, unchanged: plan.counts.keep,
    revoked: 0, blocked: plan.counts.blocked, failed: 0, outcome: 'preview',
  }));

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

/**
 * The claims a confirmation binds.
 *
 * `create`/`update`/`revoke` are the confirmation type's existing three counters, and they are filled with the
 * grouped meanings: how many records go IN, how many stay, how many come OUT. Keeping the shape means the
 * confirmation module — whose replay, expiry, forgery and cross-issuer behaviour is already proved — did not
 * have to be reopened for this phase.
 */
function claimsFor(plan: CollectionPlan): {
  name: string; planDigest: string; basisDigest: string; create: number; update: number; revoke: number;
} {
  return {
    name: plan.name,
    planDigest: plan.planDigest,
    basisDigest: plan.basisDigest,
    create: plan.counts.add,
    update: plan.counts.keep,
    revoke: plan.counts.remove,
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
 * THE CONFIRMATION IS VERIFIED — AND SPENT — BEFORE THE PLAN IS RECOMPUTED. That order is deliberate: a caller
 * must not be able to hold one confirmation and probe the catalog with it until the recomputation happens to
 * agree. One preview, one attempt.
 *
 * THIS FUNCTION CONTACTS NOTHING. It writes the durable managed collection and its membership and returns.
 * What talks to a media server is the reconcile route, driven separately, so a crash between the two leaves
 * durable rows rather than an unrecorded side effect.
 */
export async function collectionExecuteResponse(
  body: Record<string, unknown>,
  deps: CollectionsExecuteDeps,
): Promise<CollectionsEndpointResponse> {
  const env = deps.env ?? process.env;

  const gates = checkCollectionWriteGates(env);
  if (!gates.ok) return gateRefusal(gates.refusal, gates.message);

  const verdict: CollectionConfirmationVerdict = deps.confirmations.verify(body.confirmation, body.confirmDigest);
  if (!verdict.ok) return confirmationRefusal(verdict);

  let recomputed: Awaited<ReturnType<typeof buildCollectionPlan>>;
  try {
    recomputed = await buildCollectionPlan(
      { reader: deps.reader, ledger: deps.ledger, managed: deps.managed },
      {
        name: verdict.claims.name,
        ...(body.mode === undefined ? {} : { mode: body.mode }),
        ...(body.itemIds === undefined ? {} : { itemIds: body.itemIds }),
        ...(body.search === undefined ? {} : { search: body.search }),
      },
    );
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
      'The catalog or this collection\'s durable state changed after the plan was previewed, so what would be '
      + 'queued is no longer what you read. Nothing was queued. Preview it again and check the new plan.');
  }

  const queued = await queueCollectionPlan({
    pool: deps.pool,
    ...(deps.reconcileForgotten === undefined ? {} : { reconcileForgotten: deps.reconcileForgotten }),
  }, plan);

  const outcome = queued.failed === 0 ? 'complete' : 'incomplete';
  const recorded = await recordHistory(deps.history, historyFor('operator-ui', 'queued', plan, {
    selected: plan.counts.selected, created: queued.added, updated: queued.kept,
    unchanged: plan.counts.keep, revoked: queued.removing, blocked: queued.blocked,
    failed: queued.failed, outcome,
  }));

  return {
    status: queued.failed === 0 ? 200 : 207,
    body: {
      ok: queued.failed === 0,
      code: 'OPERATOR_UI_COLLECTION_QUEUED',
      report: COLLECTIONS_REPORT,
      // The honest word. Work is DURABLE now; it has not HAPPENED yet, and conflating the two is how a person
      // believes a media server was changed when nothing has been sent.
      wrote: 'durable collection state only',
      contacted: 'nothing',
      queued,
      plan: {
        name: plan.name, collectionKey: plan.collectionKey, mode: plan.mode,
        planDigest: plan.planDigest, basisDigest: plan.basisDigest,
        collection: plan.collection, counts: plan.counts,
      },
      recorded,
      guidance: queueGuidance(queued),
    },
  };
}

function queueGuidance(queued: Awaited<ReturnType<typeof queueCollectionPlan>>): string {
  const parts: string[] = [];
  if (queued.action === 'nothing') {
    parts.push('Nothing was queued: there was no collection to act on, or none of the selected records could go '
      + 'into one. Nothing has been sent to a media server.');
  } else if (queued.action === 'revoke-queued') {
    parts.push('This collection is now queued for removal from your media server. Nothing has been sent yet.');
  } else {
    parts.push(`One collection is now recorded as holding ${queued.members} record(s): ${queued.added} newly added, `
      + `${queued.kept} already in it, ${queued.removing} queued to come out. Nothing has been sent to a media `
      + 'server yet.');
  }
  parts.push('Run a reconcile pass to act on it. It recovers by the collection\'s own durable token, so running '
    + 'it twice, or after a restart, cannot create the same collection twice.');
  if (queued.blocked > 0) {
    parts.push(`${queued.blocked} selected record(s) were not put in at all: they hold no provider reference to `
      + 'match a library item with, or they have been forgotten.');
  }
  if (queued.forgottenQueued > 0 || queued.legacyForgottenQueued > 0) {
    parts.push(`${queued.forgottenQueued} membership row(s) and ${queued.legacyForgottenQueued} older per-record `
      + 'copy/copies were queued for removal because their record has been forgotten. Run a revoke pass.');
  }
  if (queued.failed > 0) {
    parts.push(`${queued.failed} durable write(s) did not land. Re-previewing and executing again queues only what `
      + 'is still missing.');
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
  // A refused execute is recorded. "Somebody tried to run a stale plan" is exactly the kind of thing a durable
  // audit history exists to hold, and a refusal that leaves no trace is a refusal nobody can review.
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
 * A ROUTE THAT TALKS TO A MEDIA SERVER AND CAN CHANGE IT. It needs no confirmation, and that is correct rather
 * than an omission: it performs no NEW decision. It carries out membership that was already confirmed by
 * digest and made durable, and its behaviour on a settled, synced model is to do nothing at all. Requiring a
 * fresh confirmation to retry work an operator already confirmed would make the recovery path harder to run
 * than the failure it recovers from.
 */
export async function collectionReconcileResponse(deps: CollectionsRuntimeDeps): Promise<CollectionsEndpointResponse> {
  const env = deps.env ?? process.env;
  const built = createCollectionRuntime({ pool: deps.pool, authority: deps.authority, fetch: deps.fetch ?? unavailableFetch, env });
  if (!built.ok) return gateRefusal(built.refusal, built.message);

  let result: Awaited<ReturnType<typeof runCollectionReconcile>>;
  try {
    result = await runCollectionReconcile(built.runtime);
  } catch {
    return refusal(503, 'RECONCILE_FAILED',
      'The reconcile pass could not complete. Nothing was left in an unrecorded state: every collection is still '
      + 'in the durable model and can be retried.');
  }
  const status = await readCollectionStatus(deps.pool).catch(() => null);
  const g = result.grouped;
  await recordHistory(deps.history, {
    actor: 'operator-ui', action: 'reconciled', target: COLLECTION_PLAN_TARGET, name: 'reconcile',
    planDigest: ZERO_DIGEST, basisDigest: ZERO_DIGEST,
    selected: g.created + g.adopted + g.updated + g.unchanged + g.deferred + g.unresolved + g.failed + g.queuedRevoke,
    created: g.created, updated: g.adopted + g.updated, unchanged: g.unchanged, revoked: g.queuedRevoke,
    blocked: g.deferred + g.unresolved, failed: g.failed,
    outcome: g.failed === 0 && g.deferred === 0 ? 'complete' : 'incomplete',
  });
  return {
    status: 200,
    body: {
      ok: g.failed === 0 && result.legacy.failed === 0,
      code: 'OPERATOR_UI_COLLECTION_RECONCILED',
      report: COLLECTIONS_REPORT,
      result,
      status,
      guidance: `Created ${g.created} collection(s), adopted ${g.adopted} that already existed, updated `
        + `${g.updated}, left ${g.unchanged} alone, deferred ${g.deferred} and failed ${g.failed}. `
        + `${g.added} library item(s) went in and ${g.removed} came out. A collection is left alone rather than `
        + 're-created whenever this product cannot prove the artifact is absent — that is what stops one lost '
        + 'response becoming two collections — and nothing is ever removed on the strength of a read that did '
        + 'not see everything.',
    },
  };
}

/**
 * POST a revoke.
 *
 * Takes every forgotten record's library items back out of the collections that hold them, deletes the
 * collections that must go, and then runs the per-item revocation for the rows created before v9. A delete
 * that fails leaves its row queued and retryable; an unrevoked external copy of a forgotten record is the
 * worst state this product can be in, so it stays visible rather than being marked done.
 */
export async function collectionRevokeResponse(deps: CollectionsRuntimeDeps): Promise<CollectionsEndpointResponse> {
  const env = deps.env ?? process.env;
  const built = createCollectionRuntime({ pool: deps.pool, authority: deps.authority, fetch: deps.fetch ?? unavailableFetch, env });
  if (!built.ok) return gateRefusal(built.refusal, built.message);

  let result: Awaited<ReturnType<typeof runCollectionRevocation>>;
  try {
    result = await runCollectionRevocation(deps.pool, built.runtime);
  } catch {
    return refusal(503, 'REVOKE_FAILED',
      'The revoke pass could not complete. Every external copy that was queued is still queued and still '
      + 'retryable — nothing was marked revoked that was not.');
  }
  const g = result.grouped;
  await recordHistory(deps.history, {
    actor: 'operator-ui', action: 'revoked', target: COLLECTION_PLAN_TARGET, name: 'revoke',
    planDigest: ZERO_DIGEST, basisDigest: ZERO_DIGEST,
    selected: g.queued + result.legacy.queued, created: 0, updated: 0, unchanged: 0,
    revoked: g.revoked + result.legacy.revoked, blocked: g.pending + result.legacy.pending,
    failed: g.failed + result.legacy.failed,
    outcome: g.failed === 0 && g.pending === 0 && result.legacy.failed === 0 && result.legacy.pending === 0
      ? 'complete' : 'incomplete',
  });
  return {
    status: 200,
    body: {
      ok: g.failed === 0 && result.legacy.failed === 0,
      code: 'OPERATOR_UI_COLLECTION_REVOKED',
      report: COLLECTIONS_REPORT,
      result,
      guidance: `Queued ${g.forgotten} membership row(s) for removal because their record was forgotten, took `
        + `${g.removed} library item(s) back out, deleted ${g.revoked} collection(s) and left ${g.pending} still `
        + `out there. The older per-record workflow revoked ${result.legacy.revoked} and has `
        + `${result.legacy.pending} outstanding. Anything that failed stays queued and retryable rather than `
        + 'being marked done.',
    },
  };
}

export interface CollectionsAuditDeps extends CollectionsRuntimeDeps {
  /** The repair confirmation issuer. A DIFFERENT instance, with a different key, from the plan issuer. */
  readonly repairConfirmations: CollectionConfirmations;
}

/**
 * POST an audit.
 *
 * IT IS A READ, AND THE RUNTIME IT IS GIVEN CANNOT WRITE. `createCollectionAuditRuntime` requires only the
 * NETWORK switch — because reading a media server is what needs a socket, and this route changes nothing — and
 * it hands the auditor a target whose create, add, remove and delete methods throw. So "an audit cannot change
 * your media server" is a property of the object graph rather than a claim about the code path.
 *
 * IT ISSUES A REPAIR CONFIRMATION, FROM ITS OWN ISSUER. The repair plan derived here is the only thing that can
 * be applied, and the confirmation binds its digest — so a repair is always something an operator read first.
 */
export async function collectionAuditResponse(deps: CollectionsAuditDeps): Promise<CollectionsEndpointResponse> {
  const env = deps.env ?? process.env;
  const built = createCollectionAuditRuntime({ pool: deps.pool, authority: deps.authority, fetch: deps.fetch ?? unavailableFetch, env });
  if (!built.ok) return gateRefusal(built.refusal, built.message);

  let report: Awaited<ReturnType<typeof auditCollectionDrift>>;
  try {
    report = await auditCollectionDrift(built.runtime);
  } catch {
    return refusal(503, 'AUDIT_FAILED',
      'The drift audit could not complete. Nothing was changed — an audit only reads — and nothing may be '
      + 'concluded from a comparison that did not finish.');
  }
  const repair = buildCollectionRepairPlan(report);
  const confirmation = deps.repairConfirmations.issue({
    name: 'repair',
    planDigest: repair.planDigest,
    basisDigest: repair.basisDigest,
    create: repair.counts.recreate,
    update: repair.counts.sync,
    revoke: repair.counts.revoke,
  });
  const recorded = await recordHistory(deps.history, {
    actor: 'operator-ui', action: 'audited', target: COLLECTION_PLAN_TARGET, name: 'audit',
    planDigest: repair.planDigest, basisDigest: repair.basisDigest,
    selected: report.counts.scanned, created: 0, updated: report.counts.drifted, unchanged: report.counts.ok,
    revoked: 0, blocked: report.counts.unknown, failed: 0, outcome: 'preview',
  });

  return {
    status: 200,
    body: {
      ok: true,
      code: 'OPERATOR_UI_COLLECTION_AUDITED',
      report: COLLECTIONS_REPORT,
      wrote: 'nothing',
      contacted: 'the configured media server, read-only',
      drift: report,
      repair,
      confirmation,
      recorded,
      guidance: `${report.guidance} ${repair.guidance}`,
    },
  };
}

export interface CollectionsRepairDeps extends CollectionsAuditDeps {}

/**
 * POST a repair.
 *
 * EVERY GATE AN EXECUTE HAS, PLUS A RE-AUDIT. The four switches, a single-use confirmation issued by an audit,
 * the operator's own echo of the repair digest — and then the audit is RE-RUN and both digests must still
 * match. A media server that changed between the audit and the confirmation invalidates the repair, exactly as
 * a moved catalog invalidates a plan.
 *
 * AND IT STILL WRITES DURABLE STATE ONLY. `applyCollectionRepair` re-arms, flags and queues; it creates
 * nothing and deletes nothing. Anything external happens on the next reconcile or revoke pass, under those
 * passes' own recovery rules.
 */
export async function collectionRepairResponse(
  body: Record<string, unknown>,
  deps: CollectionsRepairDeps,
): Promise<CollectionsEndpointResponse> {
  const env = deps.env ?? process.env;

  // A repair is a WRITE, so it needs the write switches — not the audit's narrower network-only gate.
  const gates = checkCollectionWriteGates(env);
  if (!gates.ok) return gateRefusal(gates.refusal, gates.message);

  const verdict = deps.repairConfirmations.verify(body.confirmation, body.confirmDigest);
  if (!verdict.ok) return confirmationRefusal(verdict);

  const built = createCollectionAuditRuntime({ pool: deps.pool, authority: deps.authority, fetch: deps.fetch ?? unavailableFetch, env });
  if (!built.ok) return gateRefusal(built.refusal, built.message);

  let repair: CollectionRepairPlan;
  try {
    repair = buildCollectionRepairPlan(await auditCollectionDrift(built.runtime));
  } catch {
    return refusal(503, 'REPAIR_UNAVAILABLE',
      'The repair could not be re-checked against your media server, so nothing was changed.');
  }
  if (repair.planDigest !== verdict.claims.planDigest || repair.basisDigest !== verdict.claims.basisDigest) {
    return {
      status: 409,
      body: {
        ok: false,
        code: 'OPERATOR_UI_COLLECTION_REPAIR_STALE',
        report: COLLECTIONS_REPORT,
        wrote: 'nothing',
        contacted: 'the configured media server, read-only',
        message: 'What is on your media server changed after this repair was audited, so what would be repaired is '
          + 'no longer what you read. Nothing was changed. Audit again and check the new plan.',
      },
    };
  }

  const result = await applyCollectionRepair(deps.pool, repair);
  await recordHistory(deps.history, {
    actor: 'operator-ui', action: 'repaired', target: COLLECTION_PLAN_TARGET, name: 'repair',
    planDigest: repair.planDigest, basisDigest: repair.basisDigest,
    selected: repair.actions.length, created: result.rearmed, updated: result.scheduled, unchanged: 0,
    revoked: result.queuedRevoke, blocked: 0, failed: result.failed,
    outcome: result.failed === 0 ? 'complete' : 'incomplete',
  });

  return {
    status: result.failed === 0 ? 200 : 207,
    body: {
      ok: result.failed === 0,
      code: 'OPERATOR_UI_COLLECTION_REPAIRED',
      report: COLLECTIONS_REPORT,
      wrote: 'durable collection state only',
      contacted: 'the configured media server, read-only',
      result,
      repair: { planDigest: repair.planDigest, basisDigest: repair.basisDigest, counts: repair.counts },
      guidance: `Re-armed ${result.rearmed} collection(s) whose external copy was gone, scheduled ${result.scheduled} `
        + `membership comparison(s) and queued ${result.queuedRevoke} for deletion. Nothing was created, changed or `
        + 'deleted on your media server: run a reconcile pass and then a revoke pass, which enforce the same '
        + 'switches and the same recovery rules as any other write.',
    },
  };
}

/** GET the durable model's state for this target. SELECTs only, no authority, no transport. */
export async function collectionStatusResponse(pool: Pool, env: NodeJS.ProcessEnv = process.env): Promise<CollectionsEndpointResponse> {
  let status: Awaited<ReturnType<typeof readCollectionStatus>>;
  try {
    status = await readCollectionStatus(pool);
  } catch {
    return refusal(503, 'STATUS_UNAVAILABLE',
      'The collection state could not be read. Check Setup & Diagnostics for this installation\'s state.');
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
 * A reconcile and a revoke are passes over whatever the model holds, not executions of a named plan, and the
 * history table's CHECK requires 64 hex characters in both digest columns. Writing zeroes says "this row is not
 * about a plan" in a way that cannot be confused with a real digest, and keeps every row in one table rather
 * than splitting the audit trail across two.
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

function historyFor(
  actor: CollectionHistoryRecord['actor'],
  action: CollectionHistoryRecord['action'],
  plan: CollectionPlan,
  counts: Omit<CollectionHistoryRecord, 'actor' | 'action' | 'target' | 'name' | 'planDigest' | 'basisDigest'>,
): CollectionHistoryRecord {
  return {
    actor, action, target: COLLECTION_PLAN_TARGET, name: plan.name,
    planDigest: plan.planDigest, basisDigest: plan.basisDigest,
    ...counts,
  };
}

async function recordHistory(store: CollectionHistoryStore | undefined, entry: CollectionHistoryRecord): Promise<boolean> {
  if (store === undefined) return false;
  try {
    await store.record(entry);
    return true;
  } catch {
    // A history row that could not be written is reported as `recorded: false`. It never fails the operation it
    // describes: an execute that queued work and could not write its audit row has still queued the work, and
    // saying otherwise would send an operator to re-run something that already happened.
    return false;
  }
}

function gateRefusal(refusalCode: string, message: string): CollectionsEndpointResponse {
  return {
    status: 409,
    body: {
      ok: false,
      code: `OPERATOR_UI_COLLECTION_${refusalCode}`,
      report: COLLECTIONS_REPORT,
      wrote: 'nothing',
      contacted: 'nothing',
      message,
    },
  };
}

function confirmationRefusal(verdict: Extract<CollectionConfirmationVerdict, { ok: false }>): CollectionsEndpointResponse {
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

function refusal(status: number, code: string, message: string): CollectionsEndpointResponse {
  return {
    status,
    body: { ok: false, code: `OPERATOR_UI_COLLECTION_${code}`, report: COLLECTIONS_REPORT, wrote: 'nothing', contacted: 'nothing', message },
  };
}
