/**
 * Phase 8 — identity-consuming PUBLISHER adapter boundary (fake/local only).
 *
 * A publisher adapter may need *some* decrypted identity to sync metadata into an external system
 * later (e.g. a media-server library). This boundary keeps that disclosure minimal and privacy-safe:
 *  - a publisher DECLARES the fields it needs (`requires`), and the bridge yields a
 *    {@link PublishableIdentity} containing ONLY those — never the raw identity blob, never
 *    `externalIds` or internal `metadata`, never ciphertext.
 *  - disclosure is fail-closed for forgotten/shredded items and TOCTOU-hardened (see
 *    `CatalogAuthority.withPublishableIdentity`).
 *  - output is an ADVISORY {@link PublishResult}; the core never persists it. DRY-RUN is the default.
 *
 * Phase 8 ships only LOCAL fakes — no real media servers, no network, no credentials. Real external
 * publishing conflicts with crypto-shredding (a copy escapes the erasure boundary) and is a
 * SEPARATE, deferred policy gate — see docs/PHASE_8_PUBLISHER_BOUNDARY.md.
 */

/** The only identity fields a publisher may ever declare a need for (data minimization). */
export type PublishableField = 'title' | 'year' | 'providerRefs';

/** The minimized identity a publisher receives — declared fields only, plus the opaque id. */
export interface PublishableIdentity {
  readonly itemId: string;
  readonly title?: string;
  readonly year?: number | null;
  readonly providerRefs?: ReadonlyArray<{ type: string; value: string }>;
}

/** One publish request. `dryRun` defaults to true at every call site (report, don't act). */
export interface PublishRequest {
  readonly identity: PublishableIdentity;
  readonly dryRun: boolean;
}

export type PublishStatus = 'published' | 'skipped' | 'failed';

/** Advisory, non-authoritative publish result. Never written to the event log by the core. */
export interface PublishResult {
  readonly status: PublishStatus;
  readonly dryRun: boolean;
  /** Opaque external handle (e.g. a library key) — NOT catalog identity. */
  readonly handle?: string;
  readonly detail?: string;
}

/** Ambient context — NO database handle, NO identity access beyond the request; redaction-safe log. */
export interface PublisherContext {
  readonly log?: (message: string) => void;
}

/**
 * A publisher adapter (Phase 8). Implementations must be pure with respect to catalog state:
 * `publish` MUST NOT mutate the DB or the event log; it returns an advisory result only.
 */
export interface PublisherAdapter {
  describe(): { name: string; kind: 'publisher' };
  /** The identity fields this adapter needs; the bridge discloses ONLY these. */
  readonly requires: ReadonlyArray<PublishableField>;
  publish(req: PublishRequest, ctx?: PublisherContext): Promise<PublishResult>;
}
