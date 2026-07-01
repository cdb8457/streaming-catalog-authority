import type { Pool } from 'pg';
import type { CatalogAuthority } from '../catalog/authority.js';
import type { PublisherAdapter, PublishResult } from '../adapters/publisher.js';
import { assertPublishAllowed, type PublishConsent } from './consent.js';
import { recordPublish } from './ledger.js';

/** Raised when a LIVE publish cannot be recorded as a revocable, identity-free ledger tombstone. */
export class PublishLedgerError extends Error {
  constructor(message: string) { super(message); this.name = 'PublishLedgerError'; }
}

/**
 * Phase 9 — consent-gated publish orchestration.
 *
 * Enforces the consent gate, discloses the MINIMIZED identity through Phase 8's
 * `withPublishableIdentity` (unchanged), invokes the publisher, and — for a successful LIVE publish
 * ONLY — records an IDENTITY-FREE ledger row (opaque item id + target + opaque handle + disclosed
 * field NAMES). Returns the advisory `PublishResult`, or `null` if the item is not disclosable
 * (forgotten/absent/inactive — the bridge fails closed). A dry-run never writes the ledger.
 */
export class PublishService {
  constructor(
    private readonly pool: Pool,
    private readonly auth: CatalogAuthority,
    private readonly consent: PublishConsent,
  ) {}

  async publish(itemId: string, publisher: PublisherAdapter, opts: { dryRun?: boolean } = {}): Promise<PublishResult | null> {
    const dryRun = opts.dryRun ?? true; // dry-run is the DEFAULT
    assertPublishAllowed(this.consent, dryRun); // throws PublishConsentError on a denied live publish

    const target = publisher.describe().name;
    const result = await this.auth.withPublishableIdentity(itemId, publisher.requires, (identity) =>
      publisher.publish({ identity, dryRun }),
    );
    if (result === null) return null; // not disclosable — fail closed

    // A successful LIVE publish means an external copy now exists — it MUST be recorded as a
    // revocable, identity-free tombstone (declared field NAMES only, never values). If the publisher
    // reports 'published' without an external handle we cannot record a revocation target, so we
    // FAIL CLOSED rather than leave an untracked external copy. A dry-run records nothing.
    if (!result.dryRun && result.status === 'published') {
      if (!result.handle) {
        throw new PublishLedgerError(
          'publisher reported a live publish with no external handle; refusing (cannot record a revocable ledger tombstone)',
        );
      }
      await recordPublish(this.pool, {
        itemId,
        target,
        externalHandle: result.handle,
        disclosedFields: publisher.requires,
      });
    }
    return result;
  }
}
