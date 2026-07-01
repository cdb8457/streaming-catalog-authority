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
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponseLike>;
