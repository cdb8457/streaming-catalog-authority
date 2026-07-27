import type { JellyfinRef } from './client.js';
import { matchItems } from './mapping.js';
import type { BoundedIds, CollectionTarget } from '../../publish/collection-outbox.js';

/**
 * The Jellyfin operations a MANAGED collection needs — satisfied by `JellyfinHttpClient`.
 *
 * It is a narrow structural interface rather than the whole client for the usual reason: what this port can
 * express is what the grouped outbox can do to somebody's media server, and it can express exactly seven
 * things. There is no "list every collection", no "read an item", no "search", and nothing that names a
 * library path.
 */
export interface JellyfinCollectionPort {
  listCandidateItems(): Promise<{ rows: unknown[]; truncated: boolean }>;
  createTaggedCollection(name: string, itemIds: readonly string[], token: string): Promise<string>;
  findCollectionByToken(token: string): Promise<string | null>;
  listCollectionItemIdsChecked(collectionId: string): Promise<{ ids: string[]; truncated: boolean }>;
  addItemsToCollection(collectionId: string, itemIds: readonly string[]): Promise<void>;
  removeItemsFromCollection(collectionId: string, itemIds: readonly string[]): Promise<void>;
  deleteCollection(collectionId: string): Promise<'deleted' | 'not_found'>;
}

/**
 * Phase 270 — the Jellyfin {@link CollectionTarget}: ONE plan, ONE collection, the intended records inside it.
 *
 * WHAT IT SENDS, AND WHAT IT REFUSES TO INVENT. `create` sends the operator's own collection name plus the
 * `[cat:<token>]` recovery marker, and the opaque library item ids the references matched. It does NOT send a
 * catalog title, a year, a provider reference value, or anything else: the grouped model declares
 * `providerRefs` alone as its disclosure, so a title never leaves the crypto-shredding boundary to name a
 * collection any more.
 *
 * EVERY READ THAT COULD DRIVE A REMOVAL REPORTS ITS OWN COMPLETENESS. `resolve` and `listMembers` return
 * `truncated` from the paging walk rather than an ordinary array, because the caller computes removals by set
 * difference and a silently short read would take an operator's items out of their collection.
 *
 * A CREATE WITH NOTHING TO PUT IN IT THROWS RATHER THAN CREATING AN EMPTY COLLECTION. The caller already
 * refuses to reach here in that case; this is the second, local reason it cannot happen.
 */
export class JellyfinCollectionTarget implements CollectionTarget {
  readonly name = 'jellyfin';

  /**
   * The candidate scan for THIS pass, shared by every member resolved during it.
   *
   * WHY IT IS CACHED. Matching is LOCAL — Jellyfin's server-side provider-id filters are unreliable across
   * versions, so `findItemsByRefs` fetches candidates and matches here. Without a per-pass snapshot, resolving
   * a five-hundred-record collection would walk the whole library five hundred times. It is also the more
   * correct behaviour: every member is then resolved against the SAME view, so a library scan finishing
   * mid-pass cannot make one member's items intended and another's not.
   *
   * IT HOLDS NO CATALOG IDENTITY. What is cached is the opaque rows the server returned. The references a
   * member is matched by arrive per call, inside a `withPublishableIdentity` scope, and are matched against
   * this snapshot without being retained.
   *
   * A REJECTED SCAN IS DELIBERATELY KEPT. A media server that could not be listed will not answer differently
   * five hundred times in the same pass, and every caller reads the failure identically — as an INCOMPLETE
   * resolution, which suppresses every removal. `beginPass` is what clears it.
   */
  private candidates: Promise<{ rows: unknown[]; truncated: boolean }> | null = null;

  constructor(private readonly client: JellyfinCollectionPort) {}

  beginPass(): void {
    this.candidates = null;
  }

  async resolve(refs: ReadonlyArray<{ type: string; value: string }>): Promise<BoundedIds> {
    if (refs.length === 0) return { ids: [], truncated: false };
    if (this.candidates === null) this.candidates = this.client.listCandidateItems();
    const page = await this.candidates;
    return { ids: matchItems(refs as readonly JellyfinRef[], page.rows), truncated: page.truncated };
  }

  async create(name: string, itemIds: readonly string[], token: string): Promise<string> {
    if (itemIds.length === 0) throw new Error('jellyfin collection: refusing to create a collection with no members');
    return this.client.createTaggedCollection(name, itemIds, token);
  }

  async findByToken(token: string): Promise<string | null> {
    return this.client.findCollectionByToken(token);
  }

  async listMembers(handle: string): Promise<BoundedIds> {
    const found = await this.client.listCollectionItemIdsChecked(handle);
    return { ids: found.ids, truncated: found.truncated };
  }

  async addMembers(handle: string, itemIds: readonly string[]): Promise<void> {
    if (itemIds.length === 0) return;
    await this.client.addItemsToCollection(handle, itemIds);
  }

  async removeMembers(handle: string, itemIds: readonly string[]): Promise<void> {
    if (itemIds.length === 0) return;
    await this.client.removeItemsFromCollection(handle, itemIds);
  }

  async remove(handle: string): Promise<'deleted' | 'not_found'> {
    return this.client.deleteCollection(handle);
  }
}
