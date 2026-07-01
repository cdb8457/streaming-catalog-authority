/**
 * Phase 10 — Jellyfin client boundary (fake/local only).
 *
 * The catalog authority does NOT inject items into Jellyfin; Jellyfin owns its library. The coherent
 * operation is COLLECTION CURATION keyed on provider refs: resolve which Jellyfin library items match
 * our provider refs, then create a named collection over the matches. Revocation deletes that
 * collection by its opaque id.
 *
 * This interface is the seam between the adapter and Jellyfin. Phase 10 ships ONLY a local, in-memory
 * fake implementation — no network, no credentials, no I/O. The real HTTP client (platform `fetch`,
 * no new deps) is DEFERRED to Phase 11 behind an explicit env gate.
 */

/** A provider ref used to match a Jellyfin library item (e.g. { type: 'tmdb', value: '603' }). */
export interface JellyfinRef {
  readonly type: string;
  readonly value: string;
}

export interface JellyfinClient {
  /** Resolve the OPAQUE Jellyfin item ids that match the given provider refs (unmatched refs are dropped). */
  findItemsByRefs(refs: readonly JellyfinRef[]): Promise<string[]>;
  /** Create a collection named `name` over `itemIds`. Returns the OPAQUE collection id (the handle). */
  createCollection(name: string, itemIds: readonly string[]): Promise<string>;
  /** Delete a collection by its OPAQUE id. `not_found` = already gone (treated as success upstream). */
  deleteCollection(collectionId: string): Promise<'deleted' | 'not_found'>;
}
