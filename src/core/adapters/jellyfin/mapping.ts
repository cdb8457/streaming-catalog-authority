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

/** DELETE a collection (a BoxSet item) by its opaque id. Requires a deletion-capable API key. */
export function buildDeleteCollectionRequest(collectionId: string): HttpRequestSpec {
  return { method: 'DELETE', path: `/Items/${encodeURIComponent(collectionId)}` };
}

// --- Phase 12 outbox: token-tagged create + find-by-token (PROVISIONAL, smoke-gated) ---
//
// The opaque correlation token is embedded in the collection NAME as `[cat:<token>]` so a single
// ATOMIC create is findable afterwards even if the response is lost (no separate tag call that could
// fail after create). The token is opaque (a uuid), not identity. Reachable ONLY via the outbox.

/** The opaque, findable marker embedded in a collection name for token-based recovery. */
export const tokenMark = (token: string): string => `[cat:${token}]`;

/** POST a collection whose name carries the opaque token marker (atomic + recoverable). */
export function buildCreateTaggedRequest(name: string, itemIds: readonly string[], token: string): HttpRequestSpec {
  return { method: 'POST', path: '/Collections', query: { Name: `${name} ${tokenMark(token)}`, Ids: [...itemIds].join(',') } };
}

/** Parse the create response to the OPAQUE collection id (the handle). */
export function parseCreatedId(body: unknown): string {
  const id = (body as { Id?: unknown })?.Id;
  if (typeof id !== 'string' || id.length === 0) throw new Error('jellyfin: create returned no id');
  return id;
}

/**
 * GET ALL BoxSets (with names) for a LOCAL name-marker filter — deliberately NOT `SearchTerm`.
 * Jellyfin `SearchTerm` tokenizes/normalizes and does not reliably match the bracketed opaque marker
 * `[cat:<token>]`, so relying on it risks a false "not found" → a duplicate create. We fetch names and
 * match locally in {@link matchIdByToken}, exactly as `findItemsByRefs` matches ProviderIds locally.
 */
export function buildFindByTokenRequest(): HttpRequestSpec {
  return { method: 'GET', path: '/Items', query: { Recursive: 'true', IncludeItemTypes: 'BoxSet', Fields: 'Name' } };
}

/** Return the opaque id of the (single) BoxSet whose Name contains the token marker, or null. */
export function matchIdByToken(token: string, body: unknown): string | null {
  const mark = tokenMark(token);
  const items = (body as { Items?: unknown })?.Items;
  if (!Array.isArray(items)) return null;
  for (const raw of items) {
    const it = raw as { Id?: unknown; Name?: unknown };
    if (typeof it.Id === 'string' && typeof it.Name === 'string' && it.Name.includes(mark)) return it.Id;
  }
  return null;
}
