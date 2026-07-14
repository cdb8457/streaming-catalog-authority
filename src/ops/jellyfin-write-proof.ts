import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { CatalogAuthority } from '../core/catalog/authority.js';
import type { JellyfinRef } from '../core/adapters/jellyfin/client.js';
import { loadJellyfinConfig } from '../core/adapters/jellyfin/config.js';
import { digestCatalogItemId, digestJellyfinItemId } from '../core/adapters/jellyfin/read-only-mapping.js';
import { createRealJellyfinClient } from '../core/adapters/jellyfin/real-factory.js';
import { JellyfinHttpError } from '../core/adapters/jellyfin/http-client.js';
import type { FetchLike } from '../core/adapters/jellyfin/transport.js';
import { createCustodian, loadCustodianConfig } from '../core/crypto/custodian-factory.js';
import type { Env } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { selectEligibleCatalogItemIds } from './jellyfin-live-readonly-mapping.js';

export const PHASE_221_COLLECTION_PREFIX = 'Catalog Authority disposable write proof';

export type JellyfinWriteProofStatus =
  | 'JELLYFIN_WRITE_PROOF_CLEANED_UP'
  | 'JELLYFIN_WRITE_PROOF_REFUSED_PRIOR_RESIDUE'
  | 'JELLYFIN_WRITE_PROOF_NO_MAPPED_ITEMS'
  | 'JELLYFIN_WRITE_PROOF_FAILED'
  | 'JELLYFIN_WRITE_PROOF_CLEANUP_FAILED';

export interface JellyfinWriteProofClient {
  findItemsByRefs(refs: readonly JellyfinRef[]): Promise<string[]>;
  createTaggedCollection(name: string, itemIds: readonly string[], token: string): Promise<string>;
  addItemsToCollection(collectionId: string, itemIds: readonly string[]): Promise<void>;
  listCollectionItemIds(collectionId: string): Promise<string[]>;
  listItemCollectionIds(itemId: string): Promise<string[]>;
  removeItemsFromCollection(collectionId: string, itemIds: readonly string[]): Promise<void>;
  deleteCollection(collectionId: string): Promise<'deleted' | 'not_found'>;
  findCollectionByToken(token: string): Promise<string | null>;
  findCollectionsByNamePrefix(prefix: string): Promise<string[]>;
}

export interface JellyfinWriteProofStep {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface JellyfinWriteProofReport {
  readonly report: 'phase-221-jellyfin-write-proof';
  readonly version: 1;
  readonly ok: boolean;
  readonly redactionSafe: true;
  readonly timestamp: string;
  readonly status: JellyfinWriteProofStatus;
  readonly operatorAuthorization: {
    readonly rung: 3;
    readonly authorizedDate: '2026-07-14';
    readonly scope: 'disposable-test-owned-collection-only';
  };
  readonly sourceEvidence: {
    readonly phase220Status: 'JELLYFIN_DATA_POSITIVE_READONLY_MAPPING_ACCEPTED';
    readonly phase220FileSha256: '7b8cb31e703f20b87a7f262cc376f956c26ed14827ec3c2349db22d183ea3055';
    readonly phase220ReportDigest: 'ac423af0f96afcb2fff905c228cdc3dd43e29ee866340b3b96c89f9a8e3e9b71';
  };
  readonly operationBoundary: {
    readonly networkGate: 'JELLYFIN_ENABLE_NETWORK=true';
    readonly writeGate: 'JELLYFIN_ALLOW_LIVE_PUBLISH=true';
    readonly writeMode: 'disposable-collection-only';
    readonly allowedOperations: readonly [
      'POST /Collections',
      'POST /Collections/{collectionId}/Items',
      'GET /Items/{itemId}/Collections',
      'DELETE /Collections/{collectionId}/Items',
      'DELETE /Items/{collectionId}',
    ];
    readonly forbidden: readonly string[];
  };
  readonly target: {
    readonly scheme: 'http' | 'https';
    readonly port: number;
    readonly hostEchoed: false;
    readonly existingServerOnly: true;
    readonly installAttempted: false;
    readonly newPortBindingAttempted: false;
  };
  readonly credentialBoundary: {
    readonly apiKeySource: 'JELLYFIN_API_KEY_FILE';
    readonly apiKeyEchoed: false;
  };
  readonly selection: {
    readonly mode: 'auto-active-provider-ref-items' | 'explicit-item-ids';
    readonly selectedCatalogItems: number;
    readonly mappedCatalogItemDigest?: string;
    readonly mappedJellyfinItemDigests: readonly string[];
    readonly rawIdsEchoed: false;
  };
  readonly collection: {
    readonly namePrefix: typeof PHASE_221_COLLECTION_PREFIX;
    readonly runTokenDigest: string;
    readonly collectionDigest?: string;
    readonly priorResidueCount: number;
    readonly priorResidueDigests: readonly string[];
    readonly finalResidueCount: number;
  };
  readonly libraryState: {
    readonly beforeDigest?: string;
    readonly beforeCount?: number;
    readonly afterDigest?: string;
    readonly afterCount?: number;
    readonly unchanged: boolean;
  };
  readonly cleanup: {
    readonly attempted: boolean;
    readonly removeAttempted: boolean;
    readonly deleteAttempted: boolean;
    readonly success: boolean;
    readonly orphanedCollectionDigest?: string;
  };
  readonly steps: readonly JellyfinWriteProofStep[];
  readonly evidenceDigest: string;
}

export interface RunJellyfinWriteProofOptions {
  readonly env?: Env;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  readonly consistencyTimeoutMs?: number;
  readonly consistencyPollMs?: number;
  readonly token?: string;
  readonly itemIds?: readonly string[];
  readonly limit?: number;
  readonly pool?: Pool;
  readonly authority?: CatalogAuthority;
  readonly client?: JellyfinWriteProofClient;
}

const FORBIDDEN = [
  'item metadata writes',
  'library item deletes',
  'playlist endpoints',
  'user/settings endpoints',
  'provider mode',
  'playback',
  'downloads',
  'scraping',
  'raw provider refs',
  'raw Jellyfin IDs',
  'raw media titles',
  'api key',
  'database url',
] as const;

const DEFAULT_CONSISTENCY_TIMEOUT_MS = 30_000;
const DEFAULT_CONSISTENCY_POLL_MS = 500;

function assertPhase221Env(env: Env): void {
  const problems: string[] = [];
  if (env.JELLYFIN_ENABLE_NETWORK !== 'true') problems.push('JELLYFIN_ENABLE_NETWORK must be true');
  if (env.JELLYFIN_ALLOW_LIVE_PUBLISH !== 'true') problems.push('JELLYFIN_ALLOW_LIVE_PUBLISH must be true for Phase 221');
  if (!env.JELLYFIN_API_KEY_FILE) problems.push('JELLYFIN_API_KEY_FILE is required');
  if (env.JELLYFIN_API_KEY !== undefined) problems.push('JELLYFIN_API_KEY must not be set for Phase 221; use JELLYFIN_API_KEY_FILE');
  if (problems.length > 0) throw new Error(`invalid Phase 221 Jellyfin write-proof environment: ${problems.join('; ')}`);
}

function parseTarget(baseUrl: string): { scheme: 'http' | 'https'; port: number } {
  const url = new URL(baseUrl);
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  return { scheme, port: url.port.length > 0 ? Number(url.port) : scheme === 'https' ? 443 : 80 };
}

function digest(value: string, prefix = 'phase-221'): string {
  return createHash('sha256').update(`${prefix}:${value}`).digest('hex').slice(0, 16);
}

function digestIds(ids: readonly string[]): { count: number; digest: string } {
  const sorted = [...ids].sort();
  return {
    count: sorted.length,
    digest: createHash('sha256').update(JSON.stringify(sorted.map((id) => digest(id, 'phase-221-library')))).digest('hex'),
  };
}

function digestReport(report: Omit<JellyfinWriteProofReport, 'evidenceDigest'>): string {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

function redactedError(e: unknown): string {
  if (e instanceof JellyfinHttpError) return `${e.operation} ${e.status === null ? 'transport-error' : `HTTP ${e.status}`}`;
  return (e as { name?: string })?.name ?? 'error';
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  timeoutMs: number,
  pollMs: number,
  read: () => Promise<T>,
  ok: (value: T) => boolean,
): Promise<{ value: T; attempts: number }> {
  const started = Date.now();
  let attempts = 0;
  for (;;) {
    attempts++;
    const value = await read();
    if (ok(value) || Date.now() - started >= timeoutMs) return { value, attempts };
    await sleep(pollMs);
  }
}

async function itemCollectionsContain(
  client: Pick<JellyfinWriteProofClient, 'listItemCollectionIds'>,
  collectionId: string,
  itemIds: readonly string[],
): Promise<boolean> {
  for (const itemId of itemIds) {
    const collectionIds = await client.listItemCollectionIds(itemId);
    if (!collectionIds.includes(collectionId)) return false;
  }
  return true;
}

async function itemCollectionsExclude(
  client: Pick<JellyfinWriteProofClient, 'listItemCollectionIds'>,
  collectionId: string,
  itemIds: readonly string[],
): Promise<boolean> {
  for (const itemId of itemIds) {
    const collectionIds = await client.listItemCollectionIds(itemId);
    if (collectionIds.includes(collectionId)) return false;
  }
  return true;
}

async function selectMappedTarget(
  authority: CatalogAuthority,
  client: Pick<JellyfinWriteProofClient, 'findItemsByRefs'>,
  itemIds: readonly string[],
): Promise<{
  readonly catalogItemId: string;
  readonly catalogItemDigest: string;
  readonly refs: readonly JellyfinRef[];
  readonly jellyfinItemIds: readonly string[];
} | null> {
  for (const itemId of itemIds) {
    const result = await authority.withPublishableIdentity(itemId, ['providerRefs'], async (identity) => {
      const refs = identity.providerRefs ?? [];
      if (refs.length === 0) return null;
      const jellyfinItemIds = await client.findItemsByRefs(refs);
      return jellyfinItemIds.length === 0 ? null : {
        catalogItemId: itemId,
        catalogItemDigest: digestCatalogItemId(itemId),
        refs,
        jellyfinItemIds,
      };
    });
    if (result !== null && result !== undefined) return result;
  }
  return null;
}

export async function runJellyfinWriteProof(opts: RunJellyfinWriteProofOptions = {}): Promise<JellyfinWriteProofReport> {
  const env = opts.env ?? process.env;
  assertPhase221Env(env);
  const config = loadJellyfinConfig(env);
  if (config === null) throw new Error('invalid Phase 221 Jellyfin write-proof environment: Jellyfin is not configured');
  if (!opts.client && !opts.fetch) throw new Error('Phase 221 Jellyfin write proof requires an injected fetch transport');

  const now = opts.now ?? (() => new Date());
  const timestamp = now().toISOString();
  const target = parseTarget(config.baseUrl);
  const client = opts.client ?? createRealJellyfinClient(opts.fetch!, env);
  const consistencyTimeoutMs = Math.max(0, opts.consistencyTimeoutMs ?? DEFAULT_CONSISTENCY_TIMEOUT_MS);
  const consistencyPollMs = Math.max(0, opts.consistencyPollMs ?? DEFAULT_CONSISTENCY_POLL_MS);
  const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
  let pool = opts.pool;
  const itemIds = opts.itemIds ? [...opts.itemIds] : await selectEligibleCatalogItemIds(pool ??= getPool(), limit);
  const authority = opts.authority ?? new CatalogAuthority(pool ?? getPool(), createCustodian(loadCustodianConfig(env)));
  const token = opts.token ?? `phase221-${randomUUID()}`;
  const collectionName = `${PHASE_221_COLLECTION_PREFIX} ${timestamp}`;
  const steps: JellyfinWriteProofStep[] = [];

  let status: JellyfinWriteProofStatus = 'JELLYFIN_WRITE_PROOF_FAILED';
  let collectionId: string | null = null;
  let targetItemIds: readonly string[] = [];
  let targetRefs: readonly JellyfinRef[] = [];
  let mappedCatalogItemDigest: string | undefined;
  let beforeState: { count: number; digest: string } | undefined;
  let afterState: { count: number; digest: string } | undefined;
  let priorResidue: string[] = [];
  let finalResidue: string[] = [];
  let cleanupAttempted = false;
  let removeAttempted = false;
  let deleteAttempted = false;
  let cleanupSuccess = false;
  let orphanedCollectionDigest: string | undefined;
  let skipRemaining = false;

  try {
    const priorPoll = await pollUntil(
      consistencyTimeoutMs,
      consistencyPollMs,
      () => client.findCollectionsByNamePrefix(PHASE_221_COLLECTION_PREFIX),
      (ids) => ids.length === 0,
    );
    priorResidue = priorPoll.value;
    steps.push({ step: 'preflight-residue', ok: priorResidue.length === 0, detail: `${priorResidue.length} prior test-owned collection(s) found after ${priorPoll.attempts} poll(s)` });
    if (priorResidue.length > 0) {
      status = 'JELLYFIN_WRITE_PROOF_REFUSED_PRIOR_RESIDUE';
      skipRemaining = true;
    }

    if (!skipRemaining) {
      const mapped = await selectMappedTarget(authority, client, itemIds);
      if (mapped === null) {
        steps.push({ step: 'select-target', ok: false, detail: 'no mapped Phase 220 eligible item found' });
        status = 'JELLYFIN_WRITE_PROOF_NO_MAPPED_ITEMS';
        skipRemaining = true;
      } else {
        mappedCatalogItemDigest = mapped.catalogItemDigest;
        targetItemIds = mapped.jellyfinItemIds;
        targetRefs = mapped.refs;
        steps.push({ step: 'select-target', ok: true, detail: `${targetItemIds.length} mapped library item(s) selected by digest only` });

        beforeState = digestIds(await client.findItemsByRefs(targetRefs));
        steps.push({ step: 'snapshot-before', ok: beforeState.count === targetItemIds.length, detail: `${beforeState.count} mapped library item(s) in preflight snapshot` });

        collectionId = await client.createTaggedCollection(collectionName, [], token);
        steps.push({ step: 'create-collection', ok: collectionId.length > 0, detail: 'created one token-marked disposable collection' });

        await client.addItemsToCollection(collectionId, targetItemIds);
        steps.push({ step: 'add-items', ok: true, detail: `${targetItemIds.length} existing library item reference(s) added` });

        const membershipPoll = await pollUntil(
          consistencyTimeoutMs,
          consistencyPollMs,
          () => itemCollectionsContain(client, collectionId!, targetItemIds),
          (contained) => contained,
        );
        const membershipOk = membershipPoll.value;
        steps.push({ step: 'verify-membership', ok: membershipOk, detail: `${membershipOk ? targetItemIds.length : 0} item collection reference(s) confirmed after ${membershipPoll.attempts} poll(s)` });
        if (!membershipOk) status = 'JELLYFIN_WRITE_PROOF_FAILED';

        await client.removeItemsFromCollection(collectionId, targetItemIds);
        removeAttempted = true;
        const afterRemovePoll = await pollUntil(
          consistencyTimeoutMs,
          consistencyPollMs,
          () => itemCollectionsExclude(client, collectionId!, targetItemIds),
          (removed) => removed,
        );
        const removed = afterRemovePoll.value;
        steps.push({ step: 'remove-items', ok: removed, detail: `${removed ? 0 : targetItemIds.length} item collection reference(s) remain after removal after ${afterRemovePoll.attempts} poll(s)` });
        if (!removed) status = 'JELLYFIN_WRITE_PROOF_FAILED';

        const deleted = await client.deleteCollection(collectionId);
        deleteAttempted = true;
        steps.push({ step: 'delete-collection', ok: deleted === 'deleted' || deleted === 'not_found', detail: `delete returned ${deleted}` });

        const absencePoll = await pollUntil(
          consistencyTimeoutMs,
          consistencyPollMs,
          async () => ({
            tokenLookup: await client.findCollectionByToken(token),
            residue: await client.findCollectionsByNamePrefix(PHASE_221_COLLECTION_PREFIX),
          }),
          (state) => state.tokenLookup === null && state.residue.length === 0,
        );
        finalResidue = absencePoll.value.residue;
        cleanupSuccess = absencePoll.value.tokenLookup === null && finalResidue.length === 0;
        steps.push({ step: 'verify-absence', ok: cleanupSuccess, detail: `${finalResidue.length} test-owned collection(s) remain after ${absencePoll.attempts} poll(s)` });

        afterState = digestIds(await client.findItemsByRefs(targetRefs));
        const libraryUnchanged = beforeState.digest === afterState.digest && beforeState.count === afterState.count;
        steps.push({ step: 'snapshot-after', ok: libraryUnchanged, detail: `${afterState.count} mapped library item(s) in post-cleanup snapshot` });

        status = steps.every((step) => step.ok) && cleanupSuccess && libraryUnchanged
          ? 'JELLYFIN_WRITE_PROOF_CLEANED_UP'
          : cleanupSuccess
            ? 'JELLYFIN_WRITE_PROOF_FAILED'
            : 'JELLYFIN_WRITE_PROOF_CLEANUP_FAILED';
      }
    }
  } catch (e) {
    steps.push({ step: 'proof-error', ok: false, detail: redactedError(e) });
    status = 'JELLYFIN_WRITE_PROOF_FAILED';
  } finally {
    if (collectionId !== null && !cleanupSuccess) {
      cleanupAttempted = true;
      try {
        if (targetItemIds.length > 0) {
          await client.removeItemsFromCollection(collectionId, targetItemIds);
          removeAttempted = true;
        }
        await client.deleteCollection(collectionId);
        deleteAttempted = true;
        const absencePoll = await pollUntil(
          consistencyTimeoutMs,
          consistencyPollMs,
          async () => ({
            tokenLookup: await client.findCollectionByToken(token),
            residue: await client.findCollectionsByNamePrefix(PHASE_221_COLLECTION_PREFIX),
          }),
          (state) => state.tokenLookup === null && state.residue.length === 0,
        );
        finalResidue = absencePoll.value.residue;
        cleanupSuccess = absencePoll.value.tokenLookup === null && finalResidue.length === 0;
        if (cleanupSuccess && status === 'JELLYFIN_WRITE_PROOF_CLEANUP_FAILED') status = 'JELLYFIN_WRITE_PROOF_FAILED';
      } catch {
        orphanedCollectionDigest = digest(collectionId, 'phase-221-collection');
        status = 'JELLYFIN_WRITE_PROOF_CLEANUP_FAILED';
      }
    }
  }
  return buildReport();

  function buildReport(): JellyfinWriteProofReport {
    const reportWithoutDigest: Omit<JellyfinWriteProofReport, 'evidenceDigest'> = {
      report: 'phase-221-jellyfin-write-proof',
      version: 1,
      ok: status === 'JELLYFIN_WRITE_PROOF_CLEANED_UP',
      redactionSafe: true,
      timestamp,
      status,
      operatorAuthorization: {
        rung: 3,
        authorizedDate: '2026-07-14',
        scope: 'disposable-test-owned-collection-only',
      },
      sourceEvidence: {
        phase220Status: 'JELLYFIN_DATA_POSITIVE_READONLY_MAPPING_ACCEPTED',
        phase220FileSha256: '7b8cb31e703f20b87a7f262cc376f956c26ed14827ec3c2349db22d183ea3055',
        phase220ReportDigest: 'ac423af0f96afcb2fff905c228cdc3dd43e29ee866340b3b96c89f9a8e3e9b71',
      },
      operationBoundary: {
        networkGate: 'JELLYFIN_ENABLE_NETWORK=true',
        writeGate: 'JELLYFIN_ALLOW_LIVE_PUBLISH=true',
        writeMode: 'disposable-collection-only',
        allowedOperations: [
          'POST /Collections',
          'POST /Collections/{collectionId}/Items',
          'GET /Items/{itemId}/Collections',
          'DELETE /Collections/{collectionId}/Items',
          'DELETE /Items/{collectionId}',
        ],
        forbidden: FORBIDDEN,
      },
      target: {
        scheme: target.scheme,
        port: target.port,
        hostEchoed: false,
        existingServerOnly: true,
        installAttempted: false,
        newPortBindingAttempted: false,
      },
      credentialBoundary: {
        apiKeySource: 'JELLYFIN_API_KEY_FILE',
        apiKeyEchoed: false,
      },
      selection: {
        mode: opts.itemIds ? 'explicit-item-ids' : 'auto-active-provider-ref-items',
        selectedCatalogItems: itemIds.length,
        ...(mappedCatalogItemDigest !== undefined ? { mappedCatalogItemDigest } : {}),
        mappedJellyfinItemDigests: targetItemIds.map(digestJellyfinItemId),
        rawIdsEchoed: false,
      },
      collection: {
        namePrefix: PHASE_221_COLLECTION_PREFIX,
        runTokenDigest: digest(token, 'phase-221-token'),
        ...(collectionId !== null ? { collectionDigest: digest(collectionId, 'phase-221-collection') } : {}),
        priorResidueCount: priorResidue.length,
        priorResidueDigests: priorResidue.map((id) => digest(id, 'phase-221-collection')),
        finalResidueCount: finalResidue.length,
      },
      libraryState: {
        ...(beforeState !== undefined ? { beforeDigest: beforeState.digest, beforeCount: beforeState.count } : {}),
        ...(afterState !== undefined ? { afterDigest: afterState.digest, afterCount: afterState.count } : {}),
        unchanged: beforeState !== undefined && afterState !== undefined && beforeState.digest === afterState.digest && beforeState.count === afterState.count,
      },
      cleanup: {
        attempted: cleanupAttempted || deleteAttempted,
        removeAttempted,
        deleteAttempted,
        success: cleanupSuccess,
        ...(orphanedCollectionDigest !== undefined ? { orphanedCollectionDigest } : {}),
      },
      steps,
    };
    return { ...reportWithoutDigest, evidenceDigest: digestReport(reportWithoutDigest) };
  }
}
