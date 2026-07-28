import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { CatalogAuthority } from '../core/catalog/authority.js';
import type { PublishableField } from '../core/adapters/publisher.js';
import { loadPublishConsent } from '../core/publish/consent.js';
import { latestRecoveryProof, reconcileForgotten as reconcileForgottenLedger } from '../core/publish/ledger.js';
import { OutboxService, type ReconcileResult } from '../core/publish/outbox.js';
import { runRevocation, type RevocationRunResult } from '../core/publish/reconcile.js';
import {
  COLLECTION_DISCLOSED_FIELDS as GROUPED_DISCLOSED_FIELDS,
  CollectionOutboxService,
  type CollectionReconcileResult,
  type CollectionRevocationResult,
  type CollectionTarget,
} from '../core/publish/collection-outbox.js';
import {
  createManagedCollectionReader,
  latestManagedRecoveryProof,
  lockManagedCollection,
  markManagedRevokePending,
  readManagedCounts,
  reconcileForgottenMembers,
  setManagedMembers,
  upsertManagedCollection,
  type ManagedCollectionSummary,
} from '../core/publish/collection-model.js';
import type { RevocationAdapter } from '../core/adapters/revoke.js';
import { JellyfinHttpClient } from '../core/adapters/jellyfin/http-client.js';
import { JellyfinOutboxTarget } from '../core/adapters/jellyfin/outbox-target.js';
import { JellyfinCollectionTarget } from '../core/adapters/jellyfin/collection-target.js';
import { JellyfinRevoker } from '../core/adapters/jellyfin/revoker.js';
import { guardedJellyfinFetch } from '../core/adapters/jellyfin/guarded-fetch.js';
import { isJellyfinLivePublishAllowed } from '../core/adapters/jellyfin/real-factory.js';
import type { FetchLike } from '../core/adapters/jellyfin/transport.js';
import {
  isJellyfinCollectionWriteEnabled,
  isJellyfinControlNetworkEnabled,
  loadJellyfinControlConfig,
} from './jellyfin-control-config.js';
import { COLLECTION_PLAN_TARGET, type CollectionPlan } from './collection-plan.js';

// Phase 268 (execution), extended by Phase 270 (grouped execution).
//
// THE SHAPE OF THIS SURFACE, AND WHY IT IS STILL TWO STEPS AND NOT ONE.
//
//   EXECUTE = QUEUE. `queueCollectionPlan` writes the durable managed-collection row and its membership and
//   RETURNS. It contacts nothing. That is not a limitation to be fixed later — it is the property the rest
//   rests on: the durable record exists before any side effect, so a container that dies between the two
//   leaves rows a later pass can act on rather than a side effect nobody recorded.
//
//   RECONCILE = DO. `runCollectionReconcile` is what actually talks to Jellyfin. Recovery is BY TOKEN: the
//   durable correlation token, not the possibly-lost create response, decides whether an artifact exists.
//   Found -> adopt. Provably not found -> create, within a bounded budget. Lookup failed -> do nothing.
//
// WHAT PHASE 270 CHANGED. The durable unit is now the MANAGED COLLECTION, not the per-item ledger row, so one
// confirmed plan produces one external collection holding the selected records. Membership is reconciled by
// set difference against a resolution that fails closed on forgotten records, which is what makes partial
// removal and erasure work without ever storing a library item id.
//
// WHAT PHASE 270 DID NOT CHANGE, AND WILL NOT.
//   * THE FOUR SWITCHES, each independent, each fail-closed, none implying another.
//   * THE V8 PER-ITEM ROWS. They are still reconciled and still revoked by the Phase 12 engine, unchanged and
//     unwrapped. An operator who queued per-item work before this upgrade still gets it finished and still
//     gets a forgotten record's copies revoked. Nothing here reinterprets, adopts or rewrites one.
//   * THE BOUNDARIES THAT WERE ALREADY THERE. Creates run inside `CatalogAuthority.withPublishableIdentity`,
//     which fails closed on a forgotten or shredded record; the consent gate is asserted by both engines; and
//     a revoke that fails leaves its row queued and retryable rather than marked done.

/** What a grouped collection create is allowed to see of a record. Narrower than Phase 268's — see the target. */
export const COLLECTION_DISCLOSED_FIELDS: readonly PublishableField[] = GROUPED_DISCLOSED_FIELDS;

/** What the LEGACY per-item engine discloses. Unchanged: those collections are named after their record. */
export const LEGACY_DISCLOSED_FIELDS: readonly PublishableField[] = ['title', 'providerRefs'];

export type CollectionExecutionRefusal =
  | 'NETWORK_DISABLED'
  | 'WRITES_DISABLED'
  | 'LIVE_PUBLISH_DISABLED'
  | 'CONSENT_DENIED'
  | 'NOT_CONFIGURED';

export const COLLECTION_EXECUTION_REFUSAL_MESSAGES: Record<CollectionExecutionRefusal, string> = {
  NETWORK_DISABLED:
    'Jellyfin networking is switched off, which is the default. Nothing was queued and no media server was '
    + 'contacted. Set JELLYFIN_ENABLE_NETWORK=true and restart.',
  WRITES_DISABLED:
    'Collection writes are switched off, which is the default and is a SEPARATE decision from turning '
    + 'networking on. Nothing was queued. Set JELLYFIN_ALLOW_COLLECTION_WRITES=true and restart once you have '
    + 'read a plan you are willing to run.',
  LIVE_PUBLISH_DISABLED:
    'Live Jellyfin publishing is switched off. Nothing was queued. Set JELLYFIN_ALLOW_LIVE_PUBLISH=true and '
    + 'restart, after validating create and delete against your server.',
  CONSENT_DENIED:
    'Publishing identity outside this catalog is not permitted on this installation. Nothing was queued. '
    + 'Set PUBLISH_EXTERNAL_IDENTITY=allow and restart if that is what you intend: it is what lets record '
    + 'identity leave the boundary that crypto-shredding erases within.',
  NOT_CONFIGURED:
    'This installation has no usable Jellyfin configuration, so there is nothing to queue work against. '
    + 'Check the Jellyfin panel for exactly which setting is missing.',
};

export type CollectionWriteGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: CollectionExecutionRefusal; readonly message: string };

/**
 * Every switch, checked in the order an operator would fix them, before anything is written or sent.
 *
 * IT IS CALLED BY THE QUEUE, THE RECONCILE, THE REVOKE AND THE REPAIR. Queuing writes local rows and sends
 * nothing, so it could arguably be allowed with networking off — it is not, deliberately: work queued against
 * a stack that can never act on it is a row that looks like pending work forever, and "nothing happened and
 * nothing said why" is the failure this whole plane exists to avoid.
 */
export function checkCollectionWriteGates(env: NodeJS.ProcessEnv = process.env): CollectionWriteGateResult {
  if (!isJellyfinControlNetworkEnabled(env)) return gate('NETWORK_DISABLED');
  if (!isJellyfinCollectionWriteEnabled(env)) return gate('WRITES_DISABLED');
  if (!isJellyfinLivePublishAllowed(env)) return gate('LIVE_PUBLISH_DISABLED');
  if (loadPublishConsent(env) !== 'allow') return gate('CONSENT_DENIED');
  if (!loadJellyfinControlConfig(env).ok) return gate('NOT_CONFIGURED');
  return { ok: true };
}

function gate(refusal: CollectionExecutionRefusal): CollectionWriteGateResult {
  return { ok: false, refusal, message: COLLECTION_EXECUTION_REFUSAL_MESSAGES[refusal] };
}

export interface CollectionQueueResult {
  /** The durable identity this execution addressed. */
  readonly collectionKey: string;
  /** The managed collection row, once it exists. Null only when nothing was queued. */
  readonly collectionId: string | null;
  /** What was queued against the collection as a whole. */
  readonly action: 'created' | 'updated' | 'unchanged' | 'revoke-queued' | 'nothing';
  /** Records the collection is now recorded as holding. */
  readonly members: number;
  readonly added: number;
  readonly kept: number;
  /** Records queued to come OUT of the collection. */
  readonly removing: number;
  /** Records the plan could not act on. Never silently dropped. */
  readonly blocked: number;
  /** Member rows the erasure sweep queued for removal, derived independently of the plan. */
  readonly forgottenQueued: number;
  /** Legacy per-item ledger rows the erasure sweep queued for revocation. */
  readonly legacyForgottenQueued: number;
  /** Work this call meant to make durable and could not. A failure is reported, never rounded down. */
  readonly failed: number;
}

export interface CollectionQueueDeps {
  readonly pool: Pool;
  /** Test seam for the LEDGER's own forgotten-row sweep. The running service passes the real one. */
  readonly reconcileForgotten?: (pool: Pool) => Promise<number>;
  readonly newToken?: () => string;
}

/**
 * Write the plan into the durable model. This function sends nothing, anywhere.
 *
 * IDEMPOTENCY IS ENFORCED HERE AS WELL AS ABOVE. The confirmation is single-use and the plan is refused once
 * its basis moves, so a replayed execute cannot reach this function — but "cannot reach it" is a property of
 * two other modules, and a duplicate external collection is the failure this whole design exists to prevent.
 * So the write is `cat_collection_upsert`, ONE statement backed by the partial unique index over every active
 * (target, key) pair: two independently confirmed executions racing the same plan cannot both insert. Exactly
 * one owns the collection and the other adopts it — and neither can change the correlation token, because a
 * changed token is an orphaned external artifact.
 *
 * IT RUNS UNDER THE SAME PER-COLLECTION LOCK THE RECONCILER TAKES. A membership rewrite landing halfway
 * through a reconcile pass is how a collection gets synced against a set that no longer exists; serialising
 * the two is one line and removes the whole class.
 */
export async function queueCollectionPlan(deps: CollectionQueueDeps, plan: CollectionPlan): Promise<CollectionQueueResult> {
  const newToken = deps.newToken ?? randomUUID;
  const legacySweep = deps.reconcileForgotten ?? reconcileForgottenLedger;
  const intended = plan.members.filter((m) => m.action === 'add' || m.action === 'keep').map((m) => m.itemId);
  const added = plan.members.filter((m) => m.action === 'add').length;
  const kept = plan.members.filter((m) => m.action === 'keep').length;
  const blocked = plan.members.filter((m) => m.action === 'blocked').length;
  const base = {
    collectionKey: plan.collectionKey, added, kept, blocked,
    removing: plan.members.filter((m) => m.action === 'remove').length,
  };

  // AN ERASURE IS SWEPT WHETHER OR NOT THE PLAN NOTICED IT. The plan derives removals from the membership it
  // read; these two functions derive them from `items.forgotten` directly. Two independent derivations
  // agreeing is worth more than one derivation trusted, and the sweep also catches collections this plan does
  // not address at all.
  let forgottenQueued = 0;
  let legacyForgottenQueued = 0;
  let failed = 0;
  const needsSweep = plan.members.some((m) => m.action === 'remove' && m.reason === 'FORGOTTEN');
  if (needsSweep) {
    try { forgottenQueued = await reconcileForgottenMembers(deps.pool); } catch { failed += 1; }
    try { legacyForgottenQueued = await legacySweep(deps.pool); } catch { failed += 1; }
  }

  if (plan.collection.action === 'blocked') {
    return { ...base, collectionId: null, action: 'nothing', members: 0, forgottenQueued, legacyForgottenQueued, failed };
  }

  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');

    if (plan.mode === 'revoke') {
      const existing = await createManagedCollectionReader(client).findActive(plan.target, plan.collectionKey);
      if (existing === null) {
        await client.query('COMMIT');
        return { ...base, collectionId: null, action: 'nothing', members: 0, forgottenQueued, legacyForgottenQueued, failed };
      }
      await lockManagedCollection(client, existing.id);
      // The membership is emptied FIRST and the collection queued second. If the process dies between the
      // COMMIT and anything else, the durable state says "this collection holds nothing and must go", which is
      // exactly the state the revoke pass acts on. The reverse order would leave a queued deletion whose
      // membership still claimed members.
      await setManagedMembers(client, existing.id, []);
      await markManagedRevokePending(client, existing.id);
      await client.query('COMMIT');
      return {
        ...base, collectionId: existing.id, action: 'revoke-queued', members: 0,
        forgottenQueued, legacyForgottenQueued, failed,
      };
    }

    const collectionId = await upsertManagedCollection(client, {
      target: plan.target,
      collectionKey: plan.collectionKey,
      name: plan.name,
      token: newToken(),
      planDigest: plan.planDigest,
      basisDigest: plan.basisDigest,
    });
    await lockManagedCollection(client, collectionId);
    await setManagedMembers(client, collectionId, intended);
    await client.query('COMMIT');

    const action = plan.collection.action === 'create' ? 'created'
      : plan.collection.action === 'revoke' ? 'revoke-queued'
        : plan.collection.action === 'unchanged' ? 'unchanged' : 'updated';
    return { ...base, collectionId, action, members: intended.length, forgottenQueued, legacyForgottenQueued, failed };
  } catch {
    try { await client.query('ROLLBACK'); } catch { /* reported below */ }
    return { ...base, collectionId: null, action: 'nothing', members: 0, forgottenQueued, legacyForgottenQueued, failed: failed + 1 };
  } finally {
    client.release();
  }
}

/** One managed collection, as a status surface may describe it. No token, no handle — see the model. */
export type CollectionStatusEntry = ManagedCollectionSummary;

export interface CollectionStatus {
  readonly target: typeof COLLECTION_PLAN_TARGET;
  /** Managed collection counts by state. The complete picture, including the boring ones. */
  readonly counts: Readonly<Record<string, number>>;
  /** Collections whose external artifact is not settled, or whose membership may not match. */
  readonly outstanding: number;
  /** Collections whose external copy is queued for deletion and is still out there. */
  readonly unrevoked: number;
  /** The active collections themselves, bounded and ordered. */
  readonly collections: readonly CollectionStatusEntry[];
  /** The v8 per-item rows: still tracked, still revocable, never adopted into a group. */
  readonly legacy: {
    readonly counts: Readonly<Record<string, number>>;
    readonly outstanding: number;
    readonly unrevoked: number;
  };
  /** What the last create PROVED about recovery-by-token on this target, or null if none was recorded. */
  readonly recoveryProof: string | null;
  readonly guidance: string;
}

/**
 * What the durable model currently holds for this target.
 *
 * A READ. SELECTs only, no authority, no transport. It answers with EVERY state including the boring ones, so
 * a caller cannot mistake "no failures reported" for "nothing outstanding" — and it reports the legacy per-item
 * rows separately rather than folding them into one number, because they are a different kind of thing with a
 * different remedy.
 */
export async function readCollectionStatus(pool: Pool): Promise<CollectionStatus> {
  const counts = await readManagedCounts(pool, COLLECTION_PLAN_TARGET);
  const collections = await createManagedCollectionReader(pool).listActive(COLLECTION_PLAN_TARGET, 200);
  // OUTSTANDING = work a RECONCILE pass would act on. A row queued for deletion is not that — it is the
  // revoke pass's, and it is reported separately as `unrevoked`. Stating the predicate directly is clearer,
  // and cheaper to be right about, than counting everything and subtracting a subset.
  const outstanding = collections.filter(
    (row) => row.status !== 'revoke_pending' && (row.status !== 'published' || row.needsSync)).length;
  const unrevoked = counts.revoke_pending ?? 0;

  const { rows } = await pool.query(
    'SELECT status, count(*)::int AS n FROM publish_ledger WHERE target = $1 GROUP BY status',
    [COLLECTION_PLAN_TARGET],
  );
  const legacyCounts: Record<string, number> = {
    planned: 0, in_flight: 0, ambiguous: 0, published: 0, revoke_pending: 0, revoked: 0, failed: 0,
  };
  for (const row of rows) legacyCounts[String(row.status)] = Number(row.n);
  const legacyOutstanding = legacyCounts.planned! + legacyCounts.in_flight! + legacyCounts.ambiguous!;

  const recoveryProof = await latestManagedRecoveryProof(pool, COLLECTION_PLAN_TARGET)
    .catch(() => latestRecoveryProof(pool, COLLECTION_PLAN_TARGET).catch(() => null));

  const parts: string[] = [];
  if (outstanding === 0 && unrevoked === 0 && legacyOutstanding === 0 && legacyCounts.revoke_pending === 0) {
    parts.push('Nothing is outstanding: every managed collection matches its plan and no external copy is waiting to be revoked.');
  } else {
    if (outstanding > 0) parts.push(`${outstanding} managed collection(s) are not yet in agreement with their plan. Run a reconcile pass.`);
    if (unrevoked > 0) parts.push(`${unrevoked} managed collection(s) are queued for deletion and are still out there. Run a revoke pass.`);
    if (legacyOutstanding > 0) parts.push(`${legacyOutstanding} per-item intent(s) from the older one-collection-per-record workflow have not settled. A reconcile pass finishes them by their own durable token.`);
    if ((legacyCounts.revoke_pending ?? 0) > 0) parts.push(`${legacyCounts.revoke_pending} per-item external copy/copies are queued for revocation. A revoke pass removes them.`);
  }
  if (recoveryProof !== null && recoveryProof !== 'verified') {
    parts.push('A create on this target could not be found again by its own token, so "not found" no longer proves '
      + 'absence. Reconcile will refuse to create anything further rather than risk duplicating a copy it can no '
      + 'longer see.');
  }
  return {
    target: COLLECTION_PLAN_TARGET,
    counts,
    outstanding,
    unrevoked,
    collections,
    legacy: { counts: legacyCounts, outstanding: legacyOutstanding, unrevoked: legacyCounts.revoke_pending ?? 0 },
    recoveryProof,
    guidance: parts.join(' '),
  };
}

export interface CollectionRuntime {
  /** The grouped engine: one plan, one collection. */
  readonly collections: CollectionOutboxService;
  /** The Phase 12 per-item engine, kept so v8 rows are still finished and still revoked. */
  readonly legacyOutbox: OutboxService;
  readonly legacyRevoker: RevocationAdapter;
  readonly target: JellyfinCollectionTarget;
}

export interface CollectionRuntimeDeps {
  readonly pool: Pool;
  readonly authority: CatalogAuthority;
  /** INJECTED. There is no default: this module cannot reach the network on its own, ever. */
  readonly fetch: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
}

export type CollectionRuntimeResult =
  | { readonly ok: true; readonly runtime: CollectionRuntime }
  | Extract<CollectionWriteGateResult, { ok: false }>;

/**
 * Build the live runtime, behind every gate, over a transport that cannot leave the validated origin.
 *
 * `fetch` IS A REQUIRED PARAMETER AND HAS NO DEFAULT. That is the same discipline `createRealJellyfinClient`
 * uses and for the same reason: a module that can reach the platform transport by itself is a module that can
 * contact a server because of a bug, and no gate protects against that. Only an entrypoint that both passed
 * the gates AND handed in a real transport can cause a packet to exist.
 */
export function createCollectionRuntime(deps: CollectionRuntimeDeps): CollectionRuntimeResult {
  const env = deps.env ?? process.env;
  const gates = checkCollectionWriteGates(env);
  if (!gates.ok) return gates;
  const loaded = loadJellyfinControlConfig(env);
  /* c8 ignore next */ if (!loaded.ok) return gate('NOT_CONFIGURED') as Extract<CollectionWriteGateResult, { ok: false }>;
  const config = loaded.config;

  const client = new JellyfinHttpClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    // WRAPPED, always. The client builds its own URLs from the base; the wrapper is what makes "and they
    // cannot leave the origin the policy approved" true of every one of them, including future ones.
    fetch: guardedJellyfinFetch(config.origin, deps.fetch),
    timeoutMs: config.timeoutMs,
  });
  const consent = loadPublishConsent(env);
  const target = new JellyfinCollectionTarget(client);
  return {
    ok: true,
    runtime: {
      collections: new CollectionOutboxService(deps.pool, deps.authority, consent, target, COLLECTION_DISCLOSED_FIELDS),
      legacyOutbox: new OutboxService(deps.pool, deps.authority, consent, new JellyfinOutboxTarget(client), LEGACY_DISCLOSED_FIELDS),
      legacyRevoker: new JellyfinRevoker(client),
      target,
    },
  };
}

export interface CollectionReconcilePassResult {
  readonly grouped: CollectionReconcileResult;
  /** The v8 per-item engine's own result. Reported separately; the two are different kinds of work. */
  readonly legacy: ReconcileResult;
}

/**
 * One reconcile pass: settle the managed collections, then finish any per-item intent left from before v9.
 *
 * IDEMPOTENT BY CONSTRUCTION. Running it twice over a settled, synced model does nothing at all; running it
 * after a crash resumes exactly the work that did not finish; running it when the lookup is failing performs no
 * create and no removal whatsoever.
 *
 * THE LEGACY PASS RUNS SECOND AND ITS FAILURE CANNOT HIDE THE FIRST. Both results are returned; neither is
 * folded into the other.
 */
export async function runCollectionReconcile(runtime: CollectionRuntime): Promise<CollectionReconcilePassResult> {
  const grouped = await runtime.collections.reconcile();
  const legacy = await runtime.legacyOutbox.reconcile();
  return { grouped, legacy };
}

export interface CollectionRevokePassResult {
  readonly grouped: CollectionRevocationResult;
  /** The v8 per-item revocation. A forgotten record's older per-record copies still come back. */
  readonly legacy: RevocationRunResult;
}

/**
 * One revoke pass: take the forgotten out of every managed collection, delete the collections that must go,
 * and then run the per-item revocation for the v8 rows.
 *
 * A REVOKE THAT FAILS LEAVES ITS ROW QUEUED AND RETRYABLE, never silently dropped — an unrevoked external copy
 * of a forgotten record is the single worst state this product can be in, so it stays visible.
 */
export async function runCollectionRevocation(pool: Pool, runtime: CollectionRuntime): Promise<CollectionRevokePassResult> {
  const grouped = await runtime.collections.revoke();
  const legacy = await runRevocation(pool, runtime.legacyRevoker);
  return { grouped, legacy };
}

export type CollectionAuditRefusal = Extract<CollectionExecutionRefusal, 'NETWORK_DISABLED' | 'NOT_CONFIGURED'>;

export interface CollectionAuditRuntime {
  readonly pool: Pool;
  readonly authority: CatalogAuthority;
  /** A target whose every WRITE method throws. See {@link readOnlyCollectionTarget}. */
  readonly target: CollectionTarget;
  readonly requires: readonly PublishableField[];
}

export type CollectionAuditRuntimeResult =
  | { readonly ok: true; readonly runtime: CollectionAuditRuntime }
  | { readonly ok: false; readonly refusal: CollectionAuditRefusal; readonly message: string };

/**
 * Build the runtime a DRIFT AUDIT runs on.
 *
 * IT REQUIRES ONLY THE NETWORK SWITCH, AND THAT IS DELIBERATE RATHER THAN LENIENT. An audit reads a media
 * server and changes nothing, which is exactly what Phase 266's read-only discovery already does on the same
 * one switch. Demanding the three write switches for a read would mean an operator has to turn writing ON to
 * find out whether something is wrong — which is the opposite of what a fail-closed product should ask of
 * somebody investigating.
 *
 * WHAT MAKES THAT SAFE IS THE TARGET IT HANDS BACK. `readOnlyCollectionTarget` wraps the Jellyfin target so
 * `create`, `addMembers`, `removeMembers` and `remove` THROW. The auditor never calls them; if a future change
 * did, it would fail loudly rather than write to somebody's media server from a route that promised not to.
 * A repair, which IS a write, goes through `checkCollectionWriteGates` like everything else.
 */
export function createCollectionAuditRuntime(deps: CollectionRuntimeDeps): CollectionAuditRuntimeResult {
  const env = deps.env ?? process.env;
  if (!isJellyfinControlNetworkEnabled(env)) {
    return { ok: false, refusal: 'NETWORK_DISABLED', message: COLLECTION_EXECUTION_REFUSAL_MESSAGES.NETWORK_DISABLED };
  }
  const loaded = loadJellyfinControlConfig(env);
  if (!loaded.ok) {
    return { ok: false, refusal: 'NOT_CONFIGURED', message: COLLECTION_EXECUTION_REFUSAL_MESSAGES.NOT_CONFIGURED };
  }
  const config = loaded.config;
  const client = new JellyfinHttpClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: guardedJellyfinFetch(config.origin, deps.fetch),
    timeoutMs: config.timeoutMs,
  });
  return {
    ok: true,
    runtime: {
      pool: deps.pool,
      authority: deps.authority,
      target: readOnlyCollectionTarget(new JellyfinCollectionTarget(client)),
      requires: COLLECTION_DISCLOSED_FIELDS,
    },
  };
}

/**
 * The same target with every mutating method replaced by a throw.
 *
 * A comment saying "the audit only reads" is a promise. This is the same statement as a type-checked object
 * whose write methods cannot succeed, which is what a boundary should be.
 */
export function readOnlyCollectionTarget(target: CollectionTarget): CollectionTarget {
  const refuse = (operation: string): never => {
    throw new Error(`collection audit: ${operation} is not available to a read-only drift audit`);
  };
  return {
    name: target.name,
    // Forwarded: an audit is a pass too, and it must not resolve five hundred members against a snapshot the
    // previous pass took. Optional on the interface, so this is a conditional call rather than a hard one.
    beginPass: () => target.beginPass?.(),
    resolve: (refs) => target.resolve(refs),
    findByToken: (token) => target.findByToken(token),
    listMembers: (handle) => target.listMembers(handle),
    create: async () => refuse('create'),
    addMembers: async () => refuse('addMembers'),
    removeMembers: async () => refuse('removeMembers'),
    remove: async () => refuse('remove'),
  };
}
