import type { Pool } from 'pg';
import type { CatalogAuthority } from '../catalog/authority.js';
import type { PublisherAdapter, PublishResult } from '../adapters/publisher.js';
import { assertPublishAllowed, type PublishConsent } from './consent.js';
import { recordPublish } from './ledger.js';

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

    // Record ONLY a successful LIVE publish (an external copy now exists). Identity-free: the ledger
    // gets the declared field NAMES, never values. A dry-run creates no row.
    if (!result.dryRun && result.status === 'published' && result.handle) {
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
