import type { Pool } from 'pg';
import type { CatalogAuthority } from '../core/catalog/authority.js';
import type { PublishableField } from '../core/adapters/publisher.js';
import type { CollectionTarget } from '../core/publish/collection-outbox.js';
import {
  createManagedCollectionReader,
  latestManagedRecoveryProof,
  lockManagedCollection,
  markManagedRevokePending,
  rearmManagedCollection,
  readManagedCollectionRecord,
  touchManagedCollection,
  type ManagedCollectionSummary,
} from '../core/publish/collection-model.js';
import { COLLECTION_PLAN_TARGET, canonical, digest } from './collection-plan.js';

// Phase 271 — telling the truth about the difference between what this installation believes and what is
// actually on the media server, and making a repair something an operator authorises rather than something a
// background pass decides.
//
// THE AUDIT IS READ-ONLY, AND THAT IS ENFORCED BY WHAT IT IS GIVEN. `auditCollectionDrift` receives a
// `ManagedCollectionReader` (SELECTs, by construction of that interface), a `CatalogAuthority` used only
// through `withPublishableIdentity`, and a `CollectionTarget` — of which it calls exactly three methods:
// `resolve`, `findByToken` and `listMembers`. It never calls `create`, `addMembers`, `removeMembers` or
// `remove`, it writes no row, and it flags nothing for a later pass. An audit that quietly scheduled work
// would be a write surface wearing a read surface's name.
//
// A LOOKUP FAILURE IS NEVER ABSENCE, AND IT IS NEVER "OK" EITHER. This is the rule the whole phase turns on.
// When the token lookup throws, when a member listing throws, when a resolution throws, or when either read
// hits its page bound, the verdict is `unknown` — a third answer, distinct from `ok` and from
// `external-missing`, that is never repairable and always says why. The failure mode this prevents is the
// obvious one: a media server that is down for a minute must not be read as "every collection has been
// deleted", because the repair for that reading is to recreate them all.
//
// A REPAIR PLAN IS DETERMINISTIC AND INSPECTABLE, AND CARRYING IT OUT IS NOT A SHORTCUT PAST ANY GATE. The
// plan is a document with its own digest, computed from the findings in a total order. Applying it writes
// DURABLE STATE ONLY:
//   * `recreate` re-arms the collection to `planned` and drops a handle that names nothing — it does NOT
//     create. The ordinary reconcile pass then looks the token up again, and if the artifact is actually there
//     after all it ADOPTS it. There is no code path in this product that creates an external collection
//     without going through that lookup, and a repair does not add one.
//   * `sync` flags a membership comparison, whose removals are still governed by the reconciler's "never
//     remove on partial knowledge" rule.
//   * `revoke` queues the deletion the revoke pass already performs.
// So a repair still requires: the four switches, the operator token, a digest confirmation, and then a
// separate reconcile or revoke pass to have any external effect at all.
//
// IT DOES NOT WIDEN ANYTHING. The audit reads the collections THIS installation created, by their own tokens
// and handles. It does not enumerate a media server's other collections, does not touch a library path, does
// not read a media file, and cannot be pointed at anything outside the origin the URL policy approved.

export const COLLECTION_DRIFT_REPORT = 'phase-271-collection-drift';
export const COLLECTION_DRIFT_VERSION = 1;
/** How many collections one audit examines. A bound, and a truncated audit says so. */
export const COLLECTION_DRIFT_MAX_COLLECTIONS = 200;

export type DriftVerdict =
  | 'ok'
  | 'unsettled'
  | 'membership-drift'
  | 'external-missing'
  | 'revoke-outstanding'
  | 'unknown';

export type DriftReason =
  | 'IN_AGREEMENT'
  | 'NEVER_SETTLED'
  | 'MEMBERS_MISSING'
  | 'MEMBERS_EXTRA'
  | 'MEMBERS_BOTH'
  | 'DELETED_EXTERNALLY'
  | 'AWAITING_REVOKE'
  | 'LOOKUP_FAILED'
  | 'LISTING_FAILED'
  | 'LISTING_TRUNCATED'
  | 'RESOLUTION_INCOMPLETE'
  | 'RECOVERY_UNTRUSTED';

export type RepairAction = 'none' | 'recreate' | 'sync' | 'revoke';

export interface CollectionDriftFinding {
  readonly collectionKey: string;
  readonly name: string;
  readonly status: ManagedCollectionSummary['status'];
  readonly verdict: DriftVerdict;
  readonly reason: DriftReason;
  /** Library items the readable members resolve to. A COUNT; the ids never leave the audit. */
  readonly expected: number;
  /** Library items actually in the external collection, or null when it could not be read. */
  readonly present: number | null;
  /** Intended but not there. Null when this audit could not see enough to say. */
  readonly missing: number | null;
  /** There but not intended. Null when this audit could not see enough to say. */
  readonly extra: number | null;
  /** Records this collection is recorded as holding, and how many are queued to come out. */
  readonly members: number;
  readonly removing: number;
  /** Whether every read behind this finding was complete. A finding that is not complete is never repairable. */
  readonly complete: boolean;
  /** What a repair would do. `none` when the collection is in agreement, or when nothing may safely be done. */
  readonly repair: RepairAction;
}

export interface CollectionDriftCounts {
  readonly scanned: number;
  readonly ok: number;
  readonly unsettled: number;
  readonly drifted: number;
  readonly missing: number;
  readonly revokeOutstanding: number;
  readonly unknown: number;
  readonly repairable: number;
}

export interface CollectionDriftReport {
  readonly report: typeof COLLECTION_DRIFT_REPORT;
  readonly version: typeof COLLECTION_DRIFT_VERSION;
  readonly target: typeof COLLECTION_PLAN_TARGET;
  readonly findings: readonly CollectionDriftFinding[];
  readonly counts: CollectionDriftCounts;
  /** True when more managed collections exist than this audit examined. */
  readonly truncated: boolean;
  /** What the last create PROVED about recovery-by-token. `recreate` is never proposed while it is broken. */
  readonly recoveryProof: string | null;
  readonly guidance: string;
}

export interface CollectionRepairAction {
  readonly collectionKey: string;
  readonly name: string;
  readonly action: Exclude<RepairAction, 'none'>;
  readonly reason: DriftReason;
}

export interface CollectionRepairPlan {
  readonly report: 'phase-271-collection-repair';
  readonly version: typeof COLLECTION_DRIFT_VERSION;
  readonly target: typeof COLLECTION_PLAN_TARGET;
  readonly actions: readonly CollectionRepairAction[];
  readonly counts: { readonly recreate: number; readonly sync: number; readonly revoke: number };
  readonly noop: boolean;
  /** A digest of WHAT WOULD BE REPAIRED. The thing an operator echoes back to authorise it. */
  readonly planDigest: string;
  /** A digest of WHAT IT WAS DECIDED FROM: every finding, complete, in a total order. */
  readonly basisDigest: string;
  readonly guidance: string;
}

export interface CollectionDriftDeps {
  readonly pool: Pool;
  readonly authority: CatalogAuthority;
  readonly target: CollectionTarget;
  readonly requires: readonly PublishableField[];
}

/**
 * Compare the durable model with the media server, and write nothing.
 *
 * THE ORDER OF THE CHECKS IS THE ORDER OF THEIR CERTAINTY. A collection that never settled is `unsettled` and
 * needs no audit — the reconcile path already owns it. A collection queued for revocation is
 * `revoke-outstanding` for the same reason. Only a settled, published collection is compared, and the
 * comparison stops at the first read it cannot vouch for.
 */
export async function auditCollectionDrift(deps: CollectionDriftDeps): Promise<CollectionDriftReport> {
  // One library snapshot for this whole audit: every collection is then judged against the SAME view, so a
  // library scan finishing mid-audit cannot make one collection look in agreement and the next one drifted.
  deps.target.beginPass?.();
  const reader = createManagedCollectionReader(deps.pool);
  const active = await reader.listActive(COLLECTION_PLAN_TARGET, COLLECTION_DRIFT_MAX_COLLECTIONS + 1);
  const truncated = active.length > COLLECTION_DRIFT_MAX_COLLECTIONS;
  const rows = truncated ? active.slice(0, COLLECTION_DRIFT_MAX_COLLECTIONS) : active;
  const recoveryProof = await latestManagedRecoveryProof(deps.pool, COLLECTION_PLAN_TARGET).catch(() => null);
  const recoveryTrusted = recoveryProof === null || recoveryProof === 'verified';

  const findings: CollectionDriftFinding[] = [];
  for (const row of rows) {
    findings.push(await auditOne(deps, reader, row, recoveryTrusted));
  }
  // A TOTAL order, so two audits over the same state produce the same document and the same digests.
  findings.sort((a, b) => a.collectionKey.localeCompare(b.collectionKey, 'en'));

  const counts: CollectionDriftCounts = {
    scanned: findings.length,
    ok: findings.filter((f) => f.verdict === 'ok').length,
    unsettled: findings.filter((f) => f.verdict === 'unsettled').length,
    drifted: findings.filter((f) => f.verdict === 'membership-drift').length,
    missing: findings.filter((f) => f.verdict === 'external-missing').length,
    revokeOutstanding: findings.filter((f) => f.verdict === 'revoke-outstanding').length,
    unknown: findings.filter((f) => f.verdict === 'unknown').length,
    repairable: findings.filter((f) => f.repair !== 'none').length,
  };

  return {
    report: COLLECTION_DRIFT_REPORT,
    version: COLLECTION_DRIFT_VERSION,
    target: COLLECTION_PLAN_TARGET,
    findings,
    counts,
    truncated,
    recoveryProof,
    guidance: auditGuidance(counts, truncated, recoveryProof),
  };
}

async function auditOne(
  deps: CollectionDriftDeps,
  reader: ReturnType<typeof createManagedCollectionReader>,
  row: ManagedCollectionSummary,
  recoveryTrusted: boolean,
): Promise<CollectionDriftFinding> {
  const base = {
    collectionKey: row.collectionKey, name: row.name, status: row.status,
    members: row.members, removing: row.removing,
  };
  const nothing = (verdict: DriftVerdict, reason: DriftReason, complete: boolean, repair: RepairAction = 'none'):
  CollectionDriftFinding => ({
    ...base, verdict, reason, expected: 0, present: null, missing: null, extra: null, complete, repair,
  });

  if (row.status === 'revoke_pending') {
    // The revoke pass owns this row. Saying anything else about it would invite a repair that races it.
    return nothing('revoke-outstanding', 'AWAITING_REVOKE', true);
  }
  if (row.status !== 'published') {
    return nothing('unsettled', 'NEVER_SETTLED', true);
  }

  // The token and the handle live only on the record read, never on the summary a caller sees.
  const record = await readManagedCollectionRecord(deps.pool, row.id);
  if (record === null) return nothing('unknown', 'LOOKUP_FAILED', false);

  let handle: string | null = record.externalHandle;
  if (handle === null) {
    try { handle = await deps.target.findByToken(record.correlationToken); }
    catch { return nothing('unknown', 'LOOKUP_FAILED', false); }
  } else {
    // A HANDLE THIS PRODUCT HOLDS IS NOT PROOF THE ARTIFACT STILL EXISTS. Somebody can delete a collection in
    // Jellyfin directly, and the row here would still name it. The token lookup is the check that catches
    // exactly that, and it is the reason `external-missing` is a verdict at all.
    let found: string | null;
    try { found = await deps.target.findByToken(record.correlationToken); }
    catch { return nothing('unknown', 'LOOKUP_FAILED', false); }
    if (found === null) handle = null;
    else handle = found;
  }

  if (handle === null) {
    // Provably absent — but only while recovery-by-token is trusted. When it is not, "the token found nothing"
    // says nothing about the world, and proposing a recreate on it is how a duplicate is born.
    if (!recoveryTrusted) return nothing('unknown', 'RECOVERY_UNTRUSTED', false);
    return nothing('external-missing', 'DELETED_EXTERNALLY', true, 'recreate');
  }

  const intended = await resolveIntended(deps, reader, row.id);
  if (intended.incomplete) {
    return { ...nothing('unknown', 'RESOLUTION_INCOMPLETE', false), expected: intended.ids.length };
  }

  let present: { ids: readonly string[]; truncated: boolean };
  try { present = await deps.target.listMembers(handle); }
  catch { return { ...nothing('unknown', 'LISTING_FAILED', false), expected: intended.ids.length }; }
  if (present.truncated) {
    return { ...nothing('unknown', 'LISTING_TRUNCATED', false), expected: intended.ids.length, present: present.ids.length };
  }

  const intendedSet = new Set(intended.ids);
  const presentSet = new Set(present.ids);
  const missing = [...intendedSet].filter((id) => !presentSet.has(id)).length;
  const extra = [...presentSet].filter((id) => !intendedSet.has(id)).length;
  const reason: DriftReason = missing > 0 && extra > 0 ? 'MEMBERS_BOTH'
    : missing > 0 ? 'MEMBERS_MISSING' : extra > 0 ? 'MEMBERS_EXTRA' : 'IN_AGREEMENT';
  const drifted = missing > 0 || extra > 0;
  return {
    ...base,
    verdict: drifted ? 'membership-drift' : 'ok',
    reason,
    expected: intended.ids.length,
    present: present.ids.length,
    missing,
    extra,
    complete: true,
    repair: drifted ? 'sync' : 'none',
  };
}

/**
 * Resolve the intended library items, exactly as the reconciler would.
 *
 * The audit MUST use the same resolution the reconciler uses, or it would report drift the reconciler will not
 * fix and agreement the reconciler would break. A record that is no longer disclosable resolves to nothing —
 * complete knowledge, and precisely what "this record must not be out there" means.
 */
async function resolveIntended(
  deps: CollectionDriftDeps,
  reader: ReturnType<typeof createManagedCollectionReader>,
  collectionId: string,
): Promise<{ ids: readonly string[]; incomplete: boolean }> {
  const members = await reader.listMembers(collectionId);
  const ids = new Set<string>();
  let incomplete = false;
  for (const member of members) {
    if (member.state !== 'intended') continue;
    let outcome: { ids: readonly string[]; truncated: boolean } | null;
    try {
      outcome = await deps.authority.withPublishableIdentity(member.itemId, deps.requires, async (identity) =>
        deps.target.resolve(identity.providerRefs ?? []));
    } catch { incomplete = true; continue; }
    if (outcome === null) continue;           // fail-closed disclosure: the record is gone, and that is complete
    if (outcome.truncated) { incomplete = true; continue; }
    for (const id of outcome.ids) ids.add(id);
  }
  return { ids: [...ids].sort(), incomplete };
}

function auditGuidance(counts: CollectionDriftCounts, truncated: boolean, recoveryProof: string | null): string {
  const parts: string[] = [];
  if (counts.scanned === 0) {
    parts.push('This installation manages no collections on that media server yet, so there is nothing to compare.');
  } else if (counts.repairable === 0 && counts.unknown === 0) {
    parts.push(`All ${counts.scanned} managed collection(s) match what this installation intends. Nothing was changed: an audit is a read.`);
  } else {
    parts.push(`${counts.scanned} managed collection(s) examined: ${counts.ok} in agreement, ${counts.drifted} with `
      + `membership drift, ${counts.missing} deleted on the server, ${counts.unsettled} not settled yet, `
      + `${counts.unknown} that could not be judged. Nothing was changed: an audit is a read.`);
  }
  if (counts.unknown > 0) {
    parts.push('A collection this audit could not judge is reported as unknown and is never repairable. "I could '
      + 'not see it" is not "it is not there", and recreating on that reading is how one unreachable minute '
      + 'becomes a duplicate of everything.');
  }
  if (recoveryProof !== null && recoveryProof !== 'verified') {
    parts.push('Recovery by token is not currently trusted on this target, so no recreate is proposed at all.');
  }
  if (truncated) {
    parts.push(`Only the first ${COLLECTION_DRIFT_MAX_COLLECTIONS} managed collections were examined.`);
  }
  return parts.join(' ');
}

/**
 * Turn an audit into a repair plan.
 *
 * DETERMINISTIC AND DERIVED, NOT CHOSEN. Every repairable finding becomes exactly one action, in collection-key
 * order, and the digests cover the actions and the findings respectively. Two audits of the same world produce
 * the same repair plan and the same digest, which is what makes the digest something an operator can confirm.
 *
 * A FINDING THAT IS NOT COMPLETE NEVER BECOMES AN ACTION. That is asserted here as well as in the audit,
 * because this is the function whose output authorises a write.
 */
export function buildCollectionRepairPlan(report: CollectionDriftReport): CollectionRepairPlan {
  const actions: CollectionRepairAction[] = report.findings
    .filter((finding) => finding.repair !== 'none' && finding.complete)
    .map((finding) => ({
      collectionKey: finding.collectionKey,
      name: finding.name,
      action: finding.repair as Exclude<RepairAction, 'none'>,
      reason: finding.reason,
    }))
    .sort((a, b) => a.collectionKey.localeCompare(b.collectionKey, 'en'));

  const counts = {
    recreate: actions.filter((a) => a.action === 'recreate').length,
    sync: actions.filter((a) => a.action === 'sync').length,
    revoke: actions.filter((a) => a.action === 'revoke').length,
  };
  const planDigest = digest('repair-plan', canonical({
    version: COLLECTION_DRIFT_VERSION,
    target: COLLECTION_PLAN_TARGET,
    actions: actions.map((a) => canonical({ collectionKey: a.collectionKey, action: a.action, reason: a.reason })),
  }));
  const basisDigest = digest('repair-basis', canonical({
    version: COLLECTION_DRIFT_VERSION,
    target: COLLECTION_PLAN_TARGET,
    findings: [...report.findings]
      .map((f) => canonical({
        collectionKey: f.collectionKey, status: f.status, verdict: f.verdict, reason: f.reason,
        expected: f.expected, present: f.present, missing: f.missing, extra: f.extra,
        members: f.members, removing: f.removing, complete: f.complete,
      }))
      .sort(),
  }));

  const parts: string[] = [];
  if (actions.length === 0) {
    parts.push('There is nothing to repair. Confirming this plan would write nothing and send nothing.');
  } else {
    parts.push(`This repair would re-arm ${counts.recreate} collection(s) whose external copy was deleted on the `
      + `server, schedule a membership comparison for ${counts.sync}, and queue ${counts.revoke} for deletion. `
      + 'It writes durable state only: nothing is created, changed or deleted on your media server until a '
      + 'reconcile or revoke pass runs, and those still enforce every switch and every recovery check.');
  }
  if (report.counts.unknown > 0) {
    parts.push(`${report.counts.unknown} collection(s) could not be judged and are deliberately not in this plan.`);
  }
  return {
    report: 'phase-271-collection-repair',
    version: COLLECTION_DRIFT_VERSION,
    target: COLLECTION_PLAN_TARGET,
    actions,
    counts,
    noop: actions.length === 0,
    planDigest,
    basisDigest,
    guidance: parts.join(' '),
  };
}

export interface CollectionRepairResult {
  readonly rearmed: number;
  readonly scheduled: number;
  readonly queuedRevoke: number;
  /** Actions that could not be applied — the row moved, or the write failed. Reported, never rounded down. */
  readonly failed: number;
}

/**
 * Apply a repair plan. IT WRITES DURABLE STATE AND CONTACTS NOTHING.
 *
 * Every action here is a state transition the ordinary passes already know how to act on. There is no create,
 * no delete and no membership call in this function's scope — which is the same argument the queue path makes,
 * and it is what stops "repair" becoming a second, less-examined write path to a media server.
 *
 * EACH ACTION IS APPLIED UNDER THE SAME PER-COLLECTION LOCK EVERY OTHER WRITER TAKES, and re-checks the row it
 * was authorised against. A repair authorised for a collection that has since been revoked applies to nothing.
 */
export async function applyCollectionRepair(pool: Pool, plan: CollectionRepairPlan): Promise<CollectionRepairResult> {
  let rearmed = 0;
  let scheduled = 0;
  let queuedRevoke = 0;
  let failed = 0;

  for (const action of plan.actions) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Read on the TRANSACTION'S OWN connection, not the pool: a repair must act on the row this transaction
      // can see and then lock, not on one another connection observed a moment earlier. The lock is taken
      // second because the id is what identifies the lock, and every `cat_collection_*` writer below carries
      // its own status guard — so a row that moved between the read and the lock refuses rather than misfires.
      const row = await createManagedCollectionReader(client).findActive(COLLECTION_PLAN_TARGET, action.collectionKey);
      if (row === null) { await client.query('COMMIT'); failed += 1; continue; }
      await lockManagedCollection(client, row.id);
      let ok = false;
      if (action.action === 'recreate') { ok = await rearmManagedCollection(client, row.id); if (ok) rearmed += 1; }
      else if (action.action === 'sync') { ok = await touchManagedCollection(client, row.id); if (ok) scheduled += 1; }
      else { ok = await markManagedRevokePending(client, row.id); if (ok) queuedRevoke += 1; }
      if (!ok) failed += 1;
      await client.query('COMMIT');
    } catch {
      try { await client.query('ROLLBACK'); } catch { /* counted as failed */ }
      failed += 1;
    } finally {
      client.release();
    }
  }
  return { rearmed, scheduled, queuedRevoke, failed };
}
