import type { JellyfinRef } from './client.js';

/**
 * Phase 11 — PROVISIONAL Jellyfin request mapping (ISOLATED so it can be corrected after a real-server
 * Swagger check WITHOUT touching the client, gate, or tests).
 *
 * ⚠️ NOT PROVEN. Jellyfin's server-side provider-id filters (e.g. `anyProviderIdEquals`) are
 * unreliable/absent across versions, so `findItems` uses the SAFER strategy: fetch candidate items
 * WITH their `ProviderIds` and match LOCALLY. These request shapes are pinned by fake-fetch tests but
 * are validated against a real server ONLY by the opt-in `smoke:jellyfin` manual gate — do not claim
 * real Jellyfin publishing works until that passes.
 */
export interface HttpRequestSpec {
  method: string;
  path: string;
  query?: Record<string, string>;
}

/** GET candidate items with their ProviderIds, for LOCAL matching (avoids unreliable server filters). */
export function buildFindCandidatesRequest(): HttpRequestSpec {
  return { method: 'GET', path: '/Items', query: { Recursive: 'true', Fields: 'ProviderIds', IncludeItemTypes: 'Movie,Series' } };
}

/** Parse a `/Items` response and return the OPAQUE item ids whose ProviderIds match ANY given ref. */
export function matchItems(refs: readonly JellyfinRef[], body: unknown): string[] {
  const want = new Set(refs.map((r) => `${r.type.toLowerCase()}:${r.value}`));
  if (want.size === 0) return [];
  const items = (body as { Items?: unknown })?.Items;
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const raw of items) {
    const it = raw as { Id?: unknown; ProviderIds?: unknown };
    if (typeof it.Id !== 'string') continue;
    const pids = (it.ProviderIds ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(pids)) {
      if (typeof v === 'string' && want.has(`${k.toLowerCase()}:${v}`)) { out.push(it.Id); break; }
    }
  }
  return out;
}

/** POST a new collection named `name` over `itemIds`. */
export function buildCreateCollectionRequest(name: string, itemIds: readonly string[]): HttpRequestSpec {
  return { method: 'POST', path: '/Collections', query: { Name: name, Ids: [...itemIds].join(',') } };
}

/** Parse the create-collection response to the OPAQUE collection id (the handle). */
export function parseCreateCollectionResponse(body: unknown): string {
  const id = (body as { Id?: unknown })?.Id;
  if (typeof id !== 'string' || id.length === 0) throw new Error('jellyfin: create collection returned no id');
  return id;
}

/** DELETE a collection (a BoxSet item) by its opaque id. Requires a deletion-capable API key. */
export function buildDeleteCollectionRequest(collectionId: string): HttpRequestSpec {
  return { method: 'DELETE', path: `/Items/${encodeURIComponent(collectionId)}` };
}
