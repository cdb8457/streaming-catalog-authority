import type { JellyfinClient, JellyfinRef } from './client.js';

export interface FakeCollection {
  id: string;
  name: string;
  itemIds: string[];
}

/**
 * Phase 10 — deterministic, LOCAL fake Jellyfin client (no network, no credentials, no I/O).
 *
 * Its "library" maps `"${type}:${value}"` provider refs to opaque item ids; `findItemsByRefs`
 * returns the ids of matched refs (unmatched dropped). Collections are stored in-memory with a
 * DETERMINISTIC id (`jf-col-<n>` from a counter — no Date/random). It records the refs it was asked
 * to resolve in `seenRefs` so privacy tests can prove only provider refs (never identity) cross.
 */
export class FakeJellyfinClient implements JellyfinClient {
  private readonly library: Map<string, string>;
  private readonly collections = new Map<string, FakeCollection>();
  private counter = 0;
  /** Every ref set passed to findItemsByRefs (for privacy assertions). */
  readonly seenRefs: JellyfinRef[][] = [];

  /** `library`: `{ "tmdb:603": "item-1", ... }` — the refs this fake server "has". */
  constructor(library: Record<string, string> = {}) {
    this.library = new Map(Object.entries(library));
  }

  async findItemsByRefs(refs: readonly JellyfinRef[]): Promise<string[]> {
    this.seenRefs.push(refs.map((r) => ({ type: r.type, value: r.value })));
    const ids: string[] = [];
    for (const r of refs) {
      const id = this.library.get(`${r.type}:${r.value}`);
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }

  async createCollection(name: string, itemIds: readonly string[]): Promise<string> {
    const id = `jf-col-${++this.counter}`;
    this.collections.set(id, { id, name, itemIds: [...itemIds] });
    return id;
  }

  async deleteCollection(collectionId: string): Promise<'deleted' | 'not_found'> {
    return this.collections.delete(collectionId) ? 'deleted' : 'not_found';
  }

  // --- test helpers ---
  hasCollection(id: string): boolean { return this.collections.has(id); }
  getCollection(id: string): FakeCollection | undefined { return this.collections.get(id); }
  collectionCount(): number { return this.collections.size; }
}
