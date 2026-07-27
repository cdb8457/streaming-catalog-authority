import type { FetchLike, HttpRequestInit, HttpResponseLike } from './transport.js';

// Phase 266/268 — the transport wrapper that makes the private-network policy hold for EVERY request, not
// only the ones somebody remembered to check.
//
// THE GAP IT CLOSES. `url-policy.ts` judges the configured base URL once, at startup. Everything after that
// is a request builder concatenating a path onto it. That is fine while every path is a constant in this
// repository — and it stops being fine the moment a path carries a caller-supplied fragment, a query value
// contains an encoded scheme, or a server answers 302. Each of those turns a checked address into an
// unchecked one, and none of them is visible at the call site.
//
// SO THE CHECK MOVES TO THE ONE PLACE EVERY REQUEST PASSES THROUGH. This wrapper is the transport itself. A
// URL that does not begin with the validated origin never reaches the underlying fetch — the wrapper does not
// rewrite it, does not normalise it, does not try to make it safe. It refuses. And every request it does pass
// on carries `redirect: 'error'`, so a redirect is a failed request rather than a silent second request to an
// address that was never judged.
//
// IT IS THE ONLY PLACE A REAL TRANSPORT IS ALLOWED IN. Nothing under `src/` calls a bare `fetch`; a real
// transport is injected by an operator entrypoint that has already passed the gates, and it is wrapped here
// before any client sees it. A test injects a fake and can therefore assert not just what was requested, but
// that nothing was.

/** Refused before anything left this process. Carries no URL — the refusal is about a rule, not an address. */
export class JellyfinTransportRefusedError extends Error {
  readonly code = 'JELLYFIN_TRANSPORT_REFUSED';

  constructor(readonly reason: 'off-origin' | 'not-a-url') {
    super(`jellyfin transport refused a request: ${reason}`);
    this.name = 'JellyfinTransportRefusedError';
  }
}

/**
 * Wrap a transport so it can only ever reach `origin`.
 *
 * `origin` must be the `scheme://host[:port]` that `checkJellyfinBaseUrl` returned. The comparison is against
 * `origin + '/'` rather than `origin` alone, because `http://jellyfin` is a prefix of
 * `http://jellyfin.attacker.example` and a prefix test without the separator is the classic way that check is
 * wrong. The URL is re-parsed and re-serialised first, so a caller cannot pass something that string-matches
 * the origin and parses as another host.
 */
export function guardedJellyfinFetch(origin: string, inner: FetchLike): FetchLike {
  return async (url: string, init?: HttpRequestInit): Promise<HttpResponseLike> => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new JellyfinTransportRefusedError('not-a-url');
    }
    const parsedOrigin = `${parsed.protocol}//${parsed.host}`;
    if (parsedOrigin !== origin) throw new JellyfinTransportRefusedError('off-origin');
    if (!parsed.toString().startsWith(origin + '/')) throw new JellyfinTransportRefusedError('off-origin');
    // The caller's init is preserved except for `redirect`, which this wrapper owns. A caller that wanted to
    // follow a redirect would be asking to leave the origin, which is the thing being prevented.
    return inner(parsed.toString(), { ...(init ?? {}), redirect: 'error' });
  };
}
