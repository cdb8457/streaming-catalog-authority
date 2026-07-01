/**
 * Phase 9 — revocation (unpublish) adapter boundary.
 *
 * A revoker undoes a previous external publish, operating on the OPAQUE external handle ONLY — no
 * identity is needed or provided. It is a SEPARATE family from `PublisherAdapter` (single
 * responsibility). Phase 9 ships only a local fake; a real revoker is a future, reviewed integration.
 */
export type RevokeStatus = 'revoked' | 'not_found' | 'failed';

/** Advisory revoke result. `not_found` = the external copy is already gone (treated as success). */
export interface RevokeResult {
  readonly status: RevokeStatus;
  readonly detail?: string;
}

export interface RevocationAdapter {
  describe(): { name: string; kind: 'revoker' };
  /** Unpublish by OPAQUE external handle only. MUST NOT require or receive catalog identity. */
  revoke(externalHandle: string): Promise<RevokeResult>;
}
