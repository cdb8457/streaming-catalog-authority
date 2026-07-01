import type {
  PublisherAdapter, PublishableIdentity, PublishableField, PublishRequest, PublishResult, PublisherContext,
} from './publisher.js';

/**
 * Phase 8 — deterministic, LOCAL fake publisher (no network, no real media server, no credentials).
 *
 * DRY-RUN (the default at the call site) reports what it WOULD publish with zero side effects. A
 * non-dry-run call records to an in-memory {@link published} sink ONLY — there is no external target.
 * It records exactly what identity it received in {@link seen}/{@link observed} so privacy tests can
 * prove the bridge disclosed only the declared minimized fields (never externalIds/metadata/raw).
 */
export class FakePublisherAdapter implements PublisherAdapter {
  readonly requires: ReadonlyArray<PublishableField>;
  /** Every identity this adapter received (for minimization assertions). */
  readonly seen: PublishableIdentity[] = [];
  /** JSON snapshots of what the adapter could observe (identity keys + ctx keys + dryRun) per call. */
  readonly observed: string[] = [];
  /** Local in-memory "live" sink — the only place a non-dry-run publish lands. No network. */
  readonly published: PublishableIdentity[] = [];

  constructor(requires: ReadonlyArray<PublishableField> = ['title', 'year', 'providerRefs']) {
    this.requires = requires;
  }

  describe(): { name: string; kind: 'publisher' } {
    return { name: 'fake', kind: 'publisher' };
  }

  async publish(req: PublishRequest, ctx?: PublisherContext): Promise<PublishResult> {
    this.seen.push(req.identity);
    this.observed.push(JSON.stringify({ idKeys: Object.keys(req.identity).sort(), ctxKeys: Object.keys(ctx ?? {}).sort(), dryRun: req.dryRun }));
    ctx?.log?.(`fake: ${req.dryRun ? 'dry-run for' : 'publishing'} item ${req.identity.itemId}`);
    if (req.dryRun) return { status: 'skipped', dryRun: true, detail: 'dry-run: would publish' };
    this.published.push(req.identity); // local sink only — no external side effect
    return { status: 'published', dryRun: false, handle: `fake:lib:${this.published.length}` };
  }
}
