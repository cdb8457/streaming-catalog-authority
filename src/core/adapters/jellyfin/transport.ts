/**
 * Phase 11 — injected HTTP transport seam.
 *
 * The real Jellyfin client calls ONLY through a {@link FetchLike} handed to its constructor, so unit
 * tests inject a fake transport and CI never touches the network. `FetchLike` is a minimal STRUCTURAL
 * subset of the platform fetch API, with no new dependency; the gated real factory supplies the
 * platform transport cast to this type. The client uses only `this.fetchImpl`, never a bare fetch.
 */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /**
   * Phase 266 — what to do about a redirect. The platform default is `follow`, which would let a server
   * that passed the private-network policy move this request to an address that never did: one 302 to
   * `http://169.254.169.254/` and the policy has been walked past by the thing it was protecting. The
   * discovery client sets `'error'` so a redirect is a failed request rather than a silent second one.
   * Optional, so nothing that already implements this interface has to change.
   */
  redirect?: 'error' | 'manual' | 'follow';
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponseLike>;
