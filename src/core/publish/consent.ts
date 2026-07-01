import { resolveVar, type Env } from '../../config/env.js';

/**
 * Phase 9 — operator consent gate for EXTERNAL publishing.
 *
 * Publishing identity to an external system copies it OUTSIDE the crypto-shredding boundary, so a
 * live publish requires an explicit, deployment-level opt-in beyond `PUBLISHER_MODE=fake`:
 *
 *   PUBLISH_EXTERNAL_IDENTITY=allow    -> live publishes permitted
 *   (absent | unknown | anything else) -> DENY  (fail-closed)
 *
 * A DRY-RUN is always allowed — nothing leaves the boundary — so operators can exercise the whole
 * flow safely without consent.
 */
export type PublishConsent = 'allow' | 'deny';

export class PublishConsentError extends Error {
  constructor(message: string) { super(message); this.name = 'PublishConsentError'; }
}

/** Resolve consent. FAIL-CLOSED: only the exact value `allow` permits; everything else denies. */
export function loadPublishConsent(env: Env = process.env): PublishConsent {
  const v = resolveVar(env, 'PUBLISH_EXTERNAL_IDENTITY');
  if (v.problem) return 'deny';          // e.g. an unreadable *_FILE indirection -> deny
  return v.value === 'allow' ? 'allow' : 'deny';
}

/**
 * Gate a publish attempt. A dry-run is always allowed. A LIVE (non-dry-run) publish is REFUSED
 * unless consent is explicitly `allow` — throwing {@link PublishConsentError} so callers fail closed
 * and no identity leaves the boundary without opt-in.
 */
export function assertPublishAllowed(consent: PublishConsent, dryRun: boolean): void {
  if (dryRun) return;
  if (consent !== 'allow') {
    throw new PublishConsentError(
      'live external publish refused: set PUBLISH_EXTERNAL_IDENTITY=allow to permit identity to leave the catalog boundary (a dry-run is always allowed)',
    );
  }
}
