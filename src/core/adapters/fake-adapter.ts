import type { AdapterRefView, AdapterResult, AdapterContext, ProviderAdapter } from './adapter.js';

/**
 * Phase 7 — deterministic, LOCAL fake ref-resolver adapter (no network, no real provider).
 *
 * `available` is a set of ref VALUES it reports as available; everything else is 'unavailable'.
 * It records exactly what it was handed in {@link seen} so privacy tests can prove the boundary
 * only ever passes an opaque item id + one scoped `{ refType, refValue }` (never identity).
 */
export class FakeProviderAdapter implements ProviderAdapter {
  /** Every view this adapter received (for privacy assertions). */
  readonly seen: AdapterRefView[] = [];
  /** JSON snapshots of everything the adapter could observe (view keys + ctx keys) per call. */
  readonly observed: string[] = [];

  constructor(private readonly available: ReadonlySet<string> = new Set()) {}

  describe(): { name: string; kind: 'ref-resolver' } {
    return { name: 'fake', kind: 'ref-resolver' };
  }

  async resolveRef(view: AdapterRefView, ctx?: AdapterContext): Promise<AdapterResult> {
    this.seen.push({ itemId: view.itemId, refType: view.refType, refValue: view.refValue });
    this.observed.push(JSON.stringify({ viewKeys: Object.keys(view).sort(), ctxKeys: Object.keys(ctx ?? {}).sort() }));
    ctx?.log?.(`fake: resolving a ${view.refType} ref`); // never logs identity (it has none)
    const status = this.available.has(view.refValue) ? 'available' : 'unavailable';
    // locator is derived non-reversibly (length only) — carries NO identity or the raw ref value.
    return status === 'available'
      ? { status, locator: `fake:${view.refType}:${view.refValue.length}` }
      : { status };
  }
}
