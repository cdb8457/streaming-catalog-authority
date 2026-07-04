import type { AdapterContext, AdapterRefView, AdapterResult, ProviderAdapter } from './adapter.js';
import { TorBoxReadOnlyClient, type TorBoxReadOnlyClientConfig } from './torbox-readonly-client.js';

/**
 * Phase 46 - production adapter wrapper for the reviewed TorBox read-only path.
 *
 * This is provider-mode wiring, but it remains advisory-only and transport-injected: no global
 * fetch, no env reads, no credential files, no SDK, no DB handle, no downloads, and no playback.
 */
export interface TorBoxProviderAdapterConfig extends TorBoxReadOnlyClientConfig {}

export class TorBoxProviderAdapter implements ProviderAdapter {
  private readonly client: TorBoxReadOnlyClient;

  constructor(config: TorBoxProviderAdapterConfig) {
    this.client = new TorBoxReadOnlyClient(config);
  }

  describe(): { name: string; kind: 'ref-resolver' } {
    return { name: 'torbox-readonly', kind: 'ref-resolver' };
  }

  async resolveRef(view: AdapterRefView, ctx?: AdapterContext): Promise<AdapterResult> {
    ctx?.log?.('torbox-provider-adapter: advisory read-only lookup requested');
    return this.client.resolveRef(view, ctx);
  }
}
