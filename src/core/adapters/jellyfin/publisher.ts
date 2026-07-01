import type { PublisherAdapter, PublishableField, PublishRequest, PublishResult, PublisherContext } from '../publisher.js';
import type { JellyfinClient } from './client.js';

/**
 * Phase 10 — Jellyfin publisher adapter (collection curation), over a {@link JellyfinClient}.
 *
 * Minimized identity: it declares EXACTLY `['title','providerRefs']` — `title` names the collection,
 * `providerRefs` resolve Jellyfin library items. No `year`, no `externalIds`, no `metadata`.
 *
 * Deterministic no-match policy (so the ledger never records a phantom publish):
 *  - no refs / ALL refs unmatched  -> `skipped`, NO handle (PublishService writes no ledger row);
 *  - dry-run                       -> `skipped` with `M/N matched` counts, NO handle (no ledger);
 *  - live with ≥1 match            -> `published`, a collection is created over the MATCHED items,
 *                                     the opaque collection id is returned as the handle (ledgered).
 */
export class JellyfinPublisher implements PublisherAdapter {
  readonly requires: ReadonlyArray<PublishableField> = ['title', 'providerRefs'];

  constructor(private readonly client: JellyfinClient) {}

  describe(): { name: string; kind: 'publisher' } {
    return { name: 'jellyfin', kind: 'publisher' };
  }

  async publish(req: PublishRequest, ctx?: PublisherContext): Promise<PublishResult> {
    const refs = req.identity.providerRefs ?? [];
    if (refs.length === 0) {
      return { status: 'skipped', dryRun: req.dryRun, detail: 'no provider refs to match; nothing to publish' };
    }
    const matched = await this.client.findItemsByRefs(refs);
    ctx?.log?.(`jellyfin: ${matched.length}/${refs.length} ref(s) matched`);

    if (matched.length === 0) {
      // ALL refs unmatched -> skipped, NO handle (deterministic: no ledger row).
      return { status: 'skipped', dryRun: req.dryRun, detail: `0/${refs.length} refs matched a Jellyfin item; nothing to publish` };
    }
    if (req.dryRun) {
      return { status: 'skipped', dryRun: true, detail: `dry-run: would publish ${matched.length}/${refs.length} matched item(s)` };
    }
    // Live, partial-or-full match -> curate a collection over the MATCHED items only.
    const name = req.identity.title ?? 'catalog';
    const handle = await this.client.createCollection(name, matched);
    return { status: 'published', dryRun: false, handle, detail: `published ${matched.length}/${refs.length} matched item(s)` };
  }
}
