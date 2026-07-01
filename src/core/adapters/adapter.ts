/**
 * Phase 7 — provider adapter boundary (ref-resolver class).
 *
 * The isolation layer for FUTURE provider/debrid adapters. It is deliberately minimal and
 * privacy-preserving:
 *  - an adapter receives ONLY an {@link AdapterRefView}: the opaque item id + exactly ONE scoped
 *    `{ refType, refValue }`. It NEVER receives decrypted catalog identity (title, year,
 *    externalIds, metadata).
 *  - an adapter returns an ADVISORY {@link AdapterResult}. Results are non-authoritative and are
 *    NEVER written to the event log by the core; the DB authority remains the single source of
 *    truth.
 *  - an adapter is given NO database handle and cannot mutate catalog state.
 *
 * The interface is transport-agnostic, but Phase 7 ships only LOCAL fakes — no real providers, no
 * network, no HTTP. Identity-consuming publisher adapters (e.g. media servers) are a SEPARATE,
 * deferred design gate (they would require identity to cross the boundary) and are NOT modelled here.
 */

/** The ONLY data that crosses into an adapter: opaque item id + exactly one scoped provider ref. */
export interface AdapterRefView {
  /** Opaque item id (UUID). No catalog content leaks through the id channel. */
  readonly itemId: string;
  /** The provider ref type (e.g. 'infohash', 'tmdb'). */
  readonly refType: string;
  /** The single scoped ref value for this lookup. NOT catalog identity. */
  readonly refValue: string;
}

/** Advisory, non-authoritative resolution status. */
export type AdapterStatus = 'available' | 'unavailable' | 'unknown';

/** Advisory adapter output. Never persisted to the event log by the core. */
export interface AdapterResult {
  readonly status: AdapterStatus;
  /** Optional opaque locator/handle from the provider — NOT catalog identity. */
  readonly locator?: string;
  /** Optional non-identifying diagnostic detail. */
  readonly detail?: string;
}

/**
 * Ambient context an adapter may use. It deliberately exposes NO database handle and NO identity
 * access — only a redaction-safe logger scoped to the call (so anything an adapter logs is masked
 * by the same SecretStore that guards the scoped ref value).
 */
export interface AdapterContext {
  readonly log?: (message: string) => void;
}

/**
 * A ref-resolver provider adapter (Phase 7). Implementations must be pure with respect to catalog
 * state: `resolveRef` MUST NOT mutate the DB or the event log; it returns an advisory result only.
 */
export interface ProviderAdapter {
  /** Non-secret adapter identity, for diagnostics. */
  describe(): { name: string; kind: 'ref-resolver' };
  /** Resolve exactly one scoped ref to an advisory result. */
  resolveRef(view: AdapterRefView, ctx?: AdapterContext): Promise<AdapterResult>;
}
