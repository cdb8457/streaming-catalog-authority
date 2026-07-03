import { createHash } from 'node:crypto';
import type { AdapterContext, AdapterRefView, AdapterResult, ProviderAdapter } from './adapter.js';

/**
 * Phase 32 - deterministic LOCAL fake TorBox ref-resolver adapter.
 *
 * This is a contract harness only: no SDK, no network, no credentials, no provider payloads, and
 * no factory mode. It models the Phase 31 advisory cache-check boundary against the Phase 7
 * ProviderAdapter shape before any separately gated real client exists.
 */

export const TORBOX_FAKE_SUPPORTED_REF_TYPES = [
  'infohash',
  'hash-digest',
  'link-derived-digest',
  'nzb-derived-digest',
] as const;

export type TorBoxFakeSupportedRefType = (typeof TORBOX_FAKE_SUPPORTED_REF_TYPES)[number];

export interface FakeTorBoxAvailableRef {
  readonly refType: TorBoxFakeSupportedRefType;
  readonly refValue: string;
}

const SUPPORTED_REF_TYPES: ReadonlySet<string> = new Set(TORBOX_FAKE_SUPPORTED_REF_TYPES);

function scopedKey(refType: string, refValue: string): string {
  return `${refType}\0${refValue}`;
}

function opaqueLocator(view: Pick<AdapterRefView, 'itemId' | 'refType'>): string {
  const digest = createHash('sha256')
    .update('phase-32-fake-torbox-locator')
    .update('\0')
    .update(view.itemId)
    .update('\0')
    .update(view.refType)
    .digest('hex')
    .slice(0, 16);
  return `tbx-fake:${digest}`;
}

export class FakeTorBoxAdapter implements ProviderAdapter {
  /** Sanitized views received by this adapter; useful for privacy assertions. */
  readonly seen: AdapterRefView[] = [];
  /** Sanitized observation snapshots. Extra runtime object keys are intentionally ignored. */
  readonly observed: string[] = [];

  private readonly available: ReadonlySet<string>;

  constructor(availableRefs: readonly FakeTorBoxAvailableRef[] = []) {
    this.available = new Set(availableRefs.map((ref) => scopedKey(ref.refType, ref.refValue)));
  }

  describe(): { name: string; kind: 'ref-resolver' } {
    return { name: 'fake-torbox', kind: 'ref-resolver' };
  }

  async resolveRef(view: AdapterRefView, ctx?: AdapterContext): Promise<AdapterResult> {
    const sanitized = { itemId: view.itemId, refType: view.refType, refValue: view.refValue };
    this.seen.push(sanitized);
    this.observed.push(JSON.stringify({ viewKeys: ['itemId', 'refType', 'refValue'], ctxKeys: Object.keys(ctx ?? {}).sort() }));
    ctx?.log?.('fake-torbox: resolving local advisory ref');

    if (!SUPPORTED_REF_TYPES.has(sanitized.refType)) {
      return { status: 'unknown', detail: 'unsupported-ref-type' };
    }
    if (sanitized.refValue.length === 0) {
      return { status: 'unknown', detail: 'empty-ref-value' };
    }
    if (!this.available.has(scopedKey(sanitized.refType, sanitized.refValue))) {
      return { status: 'unavailable', detail: 'local-advisory-miss' };
    }
    return { status: 'available', locator: opaqueLocator(sanitized), detail: 'local-advisory-hit' };
  }
}
