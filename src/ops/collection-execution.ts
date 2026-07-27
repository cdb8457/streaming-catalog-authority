import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { CatalogAuthority } from '../core/catalog/authority.js';
import type { PublishableField } from '../core/adapters/publisher.js';
import { loadPublishConsent } from '../core/publish/consent.js';
import { planPublishIfAbsent, latestRecoveryProof } from '../core/publish/ledger.js';
import { OutboxService, type OutboxTarget, type ReconcileResult } from '../core/publish/outbox.js';
import { runRevocation, type RevocationRunResult } from '../core/publish/reconcile.js';
import type { RevocationAdapter } from '../core/adapters/revoke.js';
import { JellyfinHttpClient } from '../core/adapters/jellyfin/http-client.js';
import { JellyfinOutboxTarget } from '../core/adapters/jellyfin/outbox-target.js';
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

// Phase 268 — turning a confirmed plan into durable, recoverable, revocable work.
//
// THE SHAPE OF THIS PHASE, AND WHY IT IS TWO STEPS AND NOT ONE.
//
//   EXECUTE = QUEUE. `queueCollectionPlan` writes durable `planned` intents into the publish outbox and
//   RETURNS. It contacts nothing. That is not a limitation to be fixed later — it is the property that makes
//   the rest work: the durable intent exists before any side effect, so a container that dies between the two
//   leaves a row that a later pass can act on, rather than a side effect nobody recorded.
//
//   RECONCILE = DO. `runCollectionReconcile` is what actually talks to Jellyfin, through the Phase 12
//   `OutboxService` unchanged. Recovery is BY TOKEN: the durable correlation token, not the possibly-lost
//   create response, decides whether an artifact exists. Found -> adopt the handle. Not found -> create,
//   within a bounded budget. Lookup failed -> do nothing, because "I could not see it" is not "it is not
//   there", and creating on that would be how one lost response becomes two collections.
//
// WHY IT REUSES THE OUTBOX RATHER THAN REIMPLEMENTING IT. Every hard property this phase is asked for —
// surviving a restart, surviving an ambiguous or lost response, never duplicating, staying revocable — is
// already proved by Phase 12 and hardened by Phase 261's recovery proof. Writing a second execution engine
// beside it would mean two implementations of "do not orphan an external copy", and the new one would have
// none of the evidence. This module's whole job is to decide WHAT goes into that engine and under what
// authority, and then to get out of the way.
//
// THE FOUR SWITCHES, AND WHY EACH ONE IS SEPARATE.
//   JELLYFIN_ENABLE_NETWORK=true          may this process open a socket to a media server at all
//   JELLYFIN_ALLOW_LIVE_PUBLISH=true      may it perform the live CREATE that Phase 11 hard-disabled
//   JELLYFIN_ALLOW_COLLECTION_WRITES=true may the OPERATOR UI drive that, as opposed to a deliberate CLI run
//   PUBLISH_EXTERNAL_IDENTITY=allow       may identity leave the crypto-shredding boundary at all
// They are independent because they answer independent questions, and no one of them implies another. A
// missing switch is a named refusal with nothing queued and nothing sent — never a partial run.
//
// AND NONE OF IT CAN BYPASS THE BOUNDARIES THAT WERE ALREADY THERE. The create runs inside
// `CatalogAuthority.withPublishableIdentity`, which fails closed on a forgotten or shredded item and
// discloses only the declared fields; the consent gate is asserted by the outbox itself on every live call;
// and revocation is driven from the ledger's own `revoke_pending` rows. This module adds gates; it removes
// none.

/** What a Jellyfin collection create is allowed to see of an item. The minimum that can match a library. */
export const COLLECTION_DISCLOSED_FIELDS: readonly PublishableField[] = ['title', 'providerRefs'];

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
 * IT IS CALLED BY BOTH THE QUEUE AND THE RECONCILE. Queuing writes local rows and sends nothing, so it could
 * arguably be allowed with networking off — it is not, deliberately: an intent queued against a stack that
 * can never act on it is a row that looks like pending work forever, and "nothing happened and nothing said
 * why" is the failure this whole plane exists to avoid.
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
  /** Intents newly written as `planned`. These are the creates this execution owns. */
  readonly queued: number;
  /** Selected records that already had an unfinished intent. Reconcile resumes them; nothing was written. */
  readonly resumed: number;
  /** Records the plan could not act on. Never silently dropped. */
  readonly blocked: number;
  /** Published rows moved to `revoke_pending` because their item is no longer readable. */
  readonly revokeQueued: number;
  /** Records that were already present externally and needed nothing. */
  readonly unchanged: number;
  /** Intents this call meant to write and could not. A failure is reported, never rounded down. */
  readonly failed: number;
  readonly intentIds: readonly string[];
}

export interface CollectionQueueDeps {
  readonly pool: Pool;
  /** Queue a revoke for every published row whose item has been forgotten. The ledger's own function. */
  readonly reconcileForgotten: (pool: Pool) => Promise<number>;
  readonly newToken?: () => string;
}

/**
 * Write the plan into the outbox. This function sends nothing, anywhere.
 *
 * IDEMPOTENCY IS ENFORCED HERE AS WELL AS ABOVE. The confirmation is single-use and the plan is refused once
 * its basis moves, so a replayed execute cannot reach this function — but "cannot reach it" is a property of
 * two other modules, and duplicate external collections are the failure this whole design exists to prevent.
 * So the ledger is re-read INSIDE this function, immediately before each write, and an item that already has
 * an unfinished or live intent is counted as resumed rather than queued again. Two independent reasons the
 * same create cannot be queued twice.
 *
 * A FAILED WRITE STOPS NOTHING AND HIDES NOTHING. Each intent is written independently; one that throws is
 * counted in `failed` and the rest still go in. A half-queued plan is a real state, and reporting it as such
 * is what lets an operator re-plan and see exactly what is left.
 */
export async function queueCollectionPlan(deps: CollectionQueueDeps, plan: CollectionPlan): Promise<CollectionQueueResult> {
  const newToken = deps.newToken ?? randomUUID;
  const intentIds: string[] = [];
  let queued = 0;
  let resumed = 0;
  let failed = 0;

  for (const action of plan.actions) {
    if (action.action !== 'create') continue;
    try {
      // One SQL statement, backed by the partial unique index. Two valid confirmations may reach this line
      // concurrently; exactly one inserts and every loser receives NULL and resumes the winner's work.
      const intentId = await planPublishIfAbsent(deps.pool, {
        itemId: action.itemId,
        target: COLLECTION_PLAN_TARGET,
        token: newToken(),
        disclosedFields: COLLECTION_DISCLOSED_FIELDS,
      });
      if (intentId === null) { resumed += 1; continue; }
      intentIds.push(intentId);
      queued += 1;
    } catch {
      failed += 1;
    }
  }

  // An `update` action is an intent that already exists and has not finished. Nothing is written for it: the
  // reconcile pass picks it up by its own durable token, which is the only safe way to resume one.
  resumed += plan.actions.filter((action) => action.action === 'update').length;

  // Revocation is queued through the ledger's own function rather than by naming rows: it moves exactly the
  // published rows whose item is forgotten, which is the same set the plan derived independently. Two
  // derivations agreeing is worth more than one derivation trusted.
  let revokeQueued = 0;
  if (plan.counts.revoke > 0) {
    try {
      revokeQueued = await deps.reconcileForgotten(deps.pool);
    } catch {
      failed += 1;
    }
  }

  return {
    queued,
    resumed,
    blocked: plan.counts.blocked,
    revokeQueued,
    unchanged: plan.counts.unchanged,
    failed,
    intentIds,
  };
}

export interface CollectionStatus {
  readonly target: typeof COLLECTION_PLAN_TARGET;
  /** Ledger row counts by state. The complete picture of outstanding external work. */
  readonly counts: Readonly<Record<string, number>>;
  readonly outstanding: number;
  readonly unrevoked: number;
  /** What the last create PROVED about recovery-by-token, or null if none has ever been recorded. */
  readonly recoveryProof: string | null;
  readonly guidance: string;
}

/**
 * What the outbox currently holds for this target.
 *
 * A READ. Two SELECTs, no authority, no transport. It answers with EVERY state including the boring ones, so
 * a caller cannot mistake "no failures reported" for "nothing outstanding".
 */
export async function readCollectionStatus(pool: Pool): Promise<CollectionStatus> {
  const { rows } = await pool.query(
    'SELECT status, count(*)::int AS n FROM publish_ledger WHERE target = $1 GROUP BY status',
    [COLLECTION_PLAN_TARGET],
  );
  const counts: Record<string, number> = {
    planned: 0, in_flight: 0, ambiguous: 0, published: 0, revoke_pending: 0, revoked: 0, failed: 0,
  };
  for (const row of rows) counts[String(row.status)] = Number(row.n);
  const outstanding = counts.planned! + counts.in_flight! + counts.ambiguous!;
  const unrevoked = counts.revoke_pending!;
  const recoveryProof = await latestRecoveryProof(pool, COLLECTION_PLAN_TARGET).catch(() => null);

  const parts: string[] = [];
  if (outstanding === 0 && unrevoked === 0) {
    parts.push('Nothing is outstanding: every queued intent has settled and no external copy is waiting to be revoked.');
  } else {
    if (outstanding > 0) parts.push(`${outstanding} queued intent(s) have not settled yet. Run a reconcile pass to resume them by their durable token.`);
    if (unrevoked > 0) parts.push(`${unrevoked} external copy/copies are queued for revocation and are still out there. Run a revoke pass.`);
  }
  if (recoveryProof !== null && recoveryProof !== 'verified') {
    parts.push('A create on this target could not be found again by its own token, so "not found" no longer proves '
      + 'absence. Reconcile will refuse to create anything further rather than risk duplicating a copy it can no '
      + 'longer see.');
  }
  return { target: COLLECTION_PLAN_TARGET, counts, outstanding, unrevoked, recoveryProof, guidance: parts.join(' ') };
}

export interface CollectionRuntime {
  readonly outbox: OutboxService;
  readonly revoker: RevocationAdapter;
  readonly target: OutboxTarget;
}

export interface CollectionRuntimeDeps {
  readonly pool: Pool;
  readonly authority: CatalogAuthority;
  /** INJECTED. There is no default: this module cannot reach the network on its own, ever. */
  readonly fetch: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Build the live runtime, behind every gate, over a transport that cannot leave the validated origin.
 *
 * `fetch` IS A REQUIRED PARAMETER AND HAS NO DEFAULT. That is the same discipline `createRealJellyfinClient`
 * uses and for the same reason: a module that can reach the platform transport by itself is a module that
 * can contact a server because of a bug, and no gate protects against that. Only an entrypoint that both
 * passed the gates AND handed in a real transport can cause a packet to exist.
 */
export type CollectionRuntimeResult =
  | { readonly ok: true; readonly runtime: CollectionRuntime }
  | Extract<CollectionWriteGateResult, { ok: false }>;

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
  const target = new JellyfinOutboxTarget(client);
  const outbox = new OutboxService(
    deps.pool,
    deps.authority,
    loadPublishConsent(env),
    target,
    COLLECTION_DISCLOSED_FIELDS,
  );
  return { ok: true, runtime: { outbox, revoker: new JellyfinRevoker(client), target } };
}

/**
 * One reconcile pass: adopt what already exists, create what provably does not, leave the rest alone.
 *
 * IDEMPOTENT BY CONSTRUCTION. Running it twice over a settled ledger does nothing at all; running it after a
 * crash resumes exactly the intents that did not finish; running it when the lookup is failing performs no
 * create whatsoever. All of that is Phase 12/261 behaviour, unchanged and unwrapped.
 */
export async function runCollectionReconcile(runtime: CollectionRuntime): Promise<ReconcileResult> {
  return runtime.outbox.reconcile();
}

/**
 * One revoke pass: queue the forgotten, then delete each queued external copy by its opaque handle.
 *
 * A revoke that fails leaves the row `revoke_pending` and retryable, never silently dropped — an unrevoked
 * external copy of a forgotten record is the single worst state this product can be in, so it stays visible.
 */
export async function runCollectionRevocation(pool: Pool, runtime: CollectionRuntime): Promise<RevocationRunResult> {
  return runRevocation(pool, runtime.revoker);
}
