import type { PublishableIdentity } from '../publisher.js';
import type { JellyfinRef } from './client.js';
import type { OutboxTarget } from '../../publish/outbox.js';

/** The Jellyfin operations the outbox target needs — satisfied by JellyfinHttpClient (Phase 11/12). */
export interface JellyfinOutboxPort {
  findItemsByRefs(refs: readonly JellyfinRef[]): Promise<string[]>;
  createTaggedCollection(name: string, itemIds: readonly string[], token: string): Promise<string>;
  findCollectionByToken(token: string): Promise<string | null>;
}

/**
 * Phase 12 — Jellyfin {@link OutboxTarget}. The outbox drives create/recovery ONLY through this target
 * (never the disabled bare create). `create` resolves the minimized identity's provider refs to library
 * items and creates a token-tagged collection (runs inside `withPublishableIdentity`, so the title stays
 * redaction-scoped); `findByToken` is the recovery/idempotency lookup. A no-match `create` throws — the
 * outbox marks the intent ambiguous/failed (surfaced) and nothing is created (no orphan).
 */
export class JellyfinOutboxTarget implements OutboxTarget {
  readonly name = 'jellyfin';

  constructor(private readonly client: JellyfinOutboxPort) {}

  async create(identity: PublishableIdentity, token: string): Promise<string> {
    const refs = identity.providerRefs ?? [];
    if (refs.length === 0) throw new Error('jellyfin outbox: no provider refs to match');
    const matched = await this.client.findItemsByRefs(refs);
    if (matched.length === 0) throw new Error('jellyfin outbox: no library items matched the provider refs');
    return this.client.createTaggedCollection(identity.title ?? 'catalog', matched, token);
  }

  async findByToken(token: string): Promise<string | null> {
    return this.client.findCollectionByToken(token);
  }
}
