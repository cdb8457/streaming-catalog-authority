import { createHash } from 'node:crypto';
import type { CatalogAuthority } from '../../catalog/authority.js';
import type { PublishableIdentity } from '../publisher.js';
import type { JellyfinClient } from './client.js';

export interface JellyfinReadOnlyMappingItem {
  readonly itemDigest: string;
  readonly status: 'mapped' | 'unmatched' | 'no_refs' | 'unavailable';
  readonly refCount: number;
  readonly matchCount: number;
}

export interface JellyfinReadOnlyMappingReport {
  readonly report: 'phase-205-jellyfin-readonly-mapping';
  readonly ok: boolean;
  readonly items: readonly JellyfinReadOnlyMappingItem[];
  readonly totals: {
    readonly requested: number;
    readonly mapped: number;
    readonly unmatched: number;
    readonly noRefs: number;
    readonly unavailable: number;
    readonly refsConsidered: number;
    readonly jellyfinMatches: number;
  };
  readonly forbidden: readonly string[];
}

const FORBIDDEN_OUTPUT = [
  'raw-provider-ref',
  'raw-jellyfin-item-id',
  'raw-media-title',
  'api-key',
  'database-url',
  'catalog-mutation',
  'jellyfin-write',
] as const;

export function digestCatalogItemId(itemId: string): string {
  return createHash('sha256').update(`phase-205:${itemId}`).digest('hex').slice(0, 16);
}

export async function buildJellyfinReadOnlyMappingItem(
  client: Pick<JellyfinClient, 'findItemsByRefs'>,
  identity: PublishableIdentity,
): Promise<JellyfinReadOnlyMappingItem> {
  const refs = identity.providerRefs ?? [];
  if (refs.length === 0) {
    return { itemDigest: digestCatalogItemId(identity.itemId), status: 'no_refs', refCount: 0, matchCount: 0 };
  }
  const matches = await client.findItemsByRefs(refs);
  return {
    itemDigest: digestCatalogItemId(identity.itemId),
    status: matches.length > 0 ? 'mapped' : 'unmatched',
    refCount: refs.length,
    matchCount: matches.length,
  };
}

export async function runJellyfinReadOnlyMapping(
  authority: CatalogAuthority,
  client: Pick<JellyfinClient, 'findItemsByRefs'>,
  itemIds: readonly string[],
): Promise<JellyfinReadOnlyMappingReport> {
  const items: JellyfinReadOnlyMappingItem[] = [];
  for (const itemId of itemIds) {
    const mapped = await authority.withPublishableIdentity(itemId, ['providerRefs'], (identity) =>
      buildJellyfinReadOnlyMappingItem(client, identity),
    );
    items.push(mapped ?? { itemDigest: digestCatalogItemId(itemId), status: 'unavailable', refCount: 0, matchCount: 0 });
  }

  const totals = {
    requested: itemIds.length,
    mapped: items.filter((item) => item.status === 'mapped').length,
    unmatched: items.filter((item) => item.status === 'unmatched').length,
    noRefs: items.filter((item) => item.status === 'no_refs').length,
    unavailable: items.filter((item) => item.status === 'unavailable').length,
    refsConsidered: items.reduce((sum, item) => sum + item.refCount, 0),
    jellyfinMatches: items.reduce((sum, item) => sum + item.matchCount, 0),
  };
  return {
    report: 'phase-205-jellyfin-readonly-mapping',
    ok: totals.unavailable === 0,
    items,
    totals,
    forbidden: FORBIDDEN_OUTPUT,
  };
}
