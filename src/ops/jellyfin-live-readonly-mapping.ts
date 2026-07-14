import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { CatalogAuthority } from '../core/catalog/authority.js';
import { loadJellyfinConfig } from '../core/adapters/jellyfin/config.js';
import { runJellyfinReadOnlyMapping, type JellyfinReadOnlyMappingReport } from '../core/adapters/jellyfin/read-only-mapping.js';
import { createRealJellyfinClient } from '../core/adapters/jellyfin/real-factory.js';
import type { JellyfinClient } from '../core/adapters/jellyfin/client.js';
import type { FetchLike } from '../core/adapters/jellyfin/transport.js';
import { createCustodian, loadCustodianConfig } from '../core/crypto/custodian-factory.js';
import type { Env } from '../config/env.js';
import { getPool } from '../db/pool.js';

export type JellyfinLiveReadOnlyMappingStatus =
  | 'JELLYFIN_LIVE_READONLY_MAPPING_MATCHED'
  | 'JELLYFIN_LIVE_READONLY_MAPPING_PASS'
  | 'JELLYFIN_LIVE_READONLY_MAPPING_NO_ELIGIBLE_ITEMS'
  | 'JELLYFIN_LIVE_READONLY_MAPPING_FAIL';

export interface JellyfinLiveReadOnlyMappingReport {
  readonly report: 'phase-219-jellyfin-live-readonly-mapping';
  readonly version: 1;
  readonly ok: boolean;
  readonly redactionSafe: true;
  readonly timestamp: string;
  readonly status: JellyfinLiveReadOnlyMappingStatus;
  readonly sourceAcceptance: 'phase-218-jellyfin-live-readonly-evidence-acceptance';
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
  readonly operationBoundary: {
    readonly networkGate: 'JELLYFIN_ENABLE_NETWORK=true';
    readonly writeMode: false;
    readonly allowedMethods: readonly ['GET'];
    readonly allowedEndpointShapes: readonly ['GET /Items'];
    readonly forbidden: readonly string[];
  };
  readonly selection: {
    readonly mode: 'auto-active-provider-ref-items' | 'explicit-item-ids';
    readonly limit: number;
    readonly selectedCount: number;
    readonly itemIdsEchoed: false;
  };
  readonly mapping: JellyfinReadOnlyMappingReport;
  readonly dataPositiveMappingEvidence: boolean;
  readonly evidenceDigest: string;
}

export interface RunJellyfinLiveReadOnlyMappingOptions {
  readonly env?: Env;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  readonly limit?: number;
  readonly itemIds?: readonly string[];
  readonly pool?: Pool;
  readonly authority?: CatalogAuthority;
  readonly client?: Pick<JellyfinClient, 'findItemsByRefs'>;
}

const FORBIDDEN = [
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'playback',
  'downloads',
  'providers',
  'scraping',
  'catalog mutation',
  'jellyfin write',
  'raw provider refs',
  'raw Jellyfin item ids',
  'raw media titles',
  'api key',
  'database url',
] as const;

function assertLiveReadOnlyMappingEnv(env: Env): void {
  const problems: string[] = [];
  if (env.JELLYFIN_ENABLE_NETWORK !== 'true') problems.push('JELLYFIN_ENABLE_NETWORK must be true');
  if (!env.JELLYFIN_API_KEY_FILE) problems.push('JELLYFIN_API_KEY_FILE is required');
  if (env.JELLYFIN_API_KEY !== undefined) problems.push('JELLYFIN_API_KEY must not be set for Phase 219; use JELLYFIN_API_KEY_FILE');
  if (env.JELLYFIN_ALLOW_LIVE_PUBLISH === 'true') problems.push('JELLYFIN_ALLOW_LIVE_PUBLISH must not be true for read-only mapping');
  if (problems.length > 0) throw new Error(`invalid Phase 219 Jellyfin live read-only environment: ${problems.join('; ')}`);
}

function parseTarget(baseUrl: string): { scheme: 'http' | 'https'; port: number } {
  const url = new URL(baseUrl);
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  return { scheme, port: url.port.length > 0 ? Number(url.port) : scheme === 'https' ? 443 : 80 };
}

function digestReport(report: Omit<JellyfinLiveReadOnlyMappingReport, 'evidenceDigest'>): string {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

export async function selectEligibleCatalogItemIds(pool: Pool, limit: number): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT i.id
       FROM items i
       JOIN item_key_control k ON k.item_id = i.id
       JOIN provider_refs pr ON pr.item_id = i.id
      WHERE i.present
        AND NOT i.forgotten
        AND i.identity_ct IS NOT NULL
        AND k.shred_state = 'active'
        AND pr.present
        AND pr.ref_value_ct IS NOT NULL
      GROUP BY i.id
      ORDER BY max(i.updated_at) DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => row.id);
}

export async function runJellyfinLiveReadOnlyMapping(opts: RunJellyfinLiveReadOnlyMappingOptions = {}): Promise<JellyfinLiveReadOnlyMappingReport> {
  const env = opts.env ?? process.env;
  const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
  assertLiveReadOnlyMappingEnv(env);
  const config = loadJellyfinConfig(env);
  if (config === null) throw new Error('invalid Phase 219 Jellyfin live read-only environment: Jellyfin is not configured');

  let pool = opts.pool;
  const itemIds = opts.itemIds ? [...opts.itemIds] : await selectEligibleCatalogItemIds(pool ??= getPool(), limit);
  const authority = opts.authority ?? new CatalogAuthority(pool ?? getPool(), createCustodian(loadCustodianConfig(env)));
  if (!opts.client && !opts.fetch) throw new Error('Phase 219 live read-only mapping requires an injected fetch transport');
  const client = opts.client ?? createRealJellyfinClient(opts.fetch!, env);
  const mapping = await runJellyfinReadOnlyMapping(authority, client, itemIds);
  const status: JellyfinLiveReadOnlyMappingStatus =
    itemIds.length === 0
      ? 'JELLYFIN_LIVE_READONLY_MAPPING_NO_ELIGIBLE_ITEMS'
      : mapping.ok && mapping.totals.mapped > 0
        ? 'JELLYFIN_LIVE_READONLY_MAPPING_MATCHED'
      : mapping.ok
        ? 'JELLYFIN_LIVE_READONLY_MAPPING_PASS'
        : 'JELLYFIN_LIVE_READONLY_MAPPING_FAIL';
  const target = parseTarget(config.baseUrl);
  const reportWithoutDigest: Omit<JellyfinLiveReadOnlyMappingReport, 'evidenceDigest'> = {
    report: 'phase-219-jellyfin-live-readonly-mapping',
    version: 1,
    ok: status !== 'JELLYFIN_LIVE_READONLY_MAPPING_FAIL',
    redactionSafe: true,
    timestamp: (opts.now ?? (() => new Date()))().toISOString(),
    status,
    sourceAcceptance: 'phase-218-jellyfin-live-readonly-evidence-acceptance',
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
    operationBoundary: {
      networkGate: 'JELLYFIN_ENABLE_NETWORK=true',
      writeMode: false,
      allowedMethods: ['GET'],
      allowedEndpointShapes: ['GET /Items'],
      forbidden: FORBIDDEN,
    },
    selection: {
      mode: opts.itemIds ? 'explicit-item-ids' : 'auto-active-provider-ref-items',
      limit,
      selectedCount: itemIds.length,
      itemIdsEchoed: false,
    },
    mapping,
    dataPositiveMappingEvidence: itemIds.length > 0 && mapping.totals.requested > 0,
  };
  return { ...reportWithoutDigest, evidenceDigest: digestReport(reportWithoutDigest) };
}
