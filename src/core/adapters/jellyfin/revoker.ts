import type { RevocationAdapter, RevokeResult } from '../revoke.js';
import type { JellyfinClient } from './client.js';

/**
 * Phase 10 — Jellyfin revoker: deletes a curated collection by its OPAQUE id (the ledger handle).
 *
 * It receives ONLY the opaque collection id — never catalog identity. `not_found` (the collection is
 * already gone) is reported as success upstream. What it CANNOT undo is documented in
 * docs/PHASE_10_JELLYFIN_ADAPTER.md (Jellyfin's own logs/telemetry/exports of the refs we sent are
 * beyond our reach — deleting the collection does not scrub them).
 */
export class JellyfinRevoker implements RevocationAdapter {
  constructor(private readonly client: JellyfinClient) {}

  describe(): { name: string; kind: 'revoker' } {
    return { name: 'jellyfin', kind: 'revoker' };
  }

  async revoke(externalHandle: string): Promise<RevokeResult> {
    const outcome = await this.client.deleteCollection(externalHandle);
    return outcome === 'deleted' ? { status: 'revoked' } : { status: 'not_found' };
  }
}
