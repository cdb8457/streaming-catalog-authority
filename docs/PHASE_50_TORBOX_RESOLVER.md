# Phase 50 — the TorBox read-only resolver

**THIS IS THE "LATER EXPLICIT PHASE" PHASE 41 ASKED FOR.**
`docs/PHASE_41_TORBOX_ENDPOINT_MAPPING.md` future-gated `/v1/api/torrents/requestdl`,
`/v1/api/webdl/requestdl` and `/v1/api/usenet/requestdl` — "because they require token query parameters and
can expose CDN/permalink URLs" — and said they "require a later explicit phase". This is that phase. It authorises exactly
those three GET endpoints and nothing else.

**IT DOES NOT UNGATE THE PHASE 33 SMOKE CLIENT, AND THAT IS DELIBERATE.**
`request-download-link` REMAINS in `TORBOX_REAL_CLIENT_FUTURE_GATED_OPERATIONS`, and
`src/ops/torbox-live-transport.ts` remains status-and-cache-only. Widening that gate would have relaxed a
contract several hundred existing assertions depend on, in order to give a capability the smoke client has no
use for. Instead the resolver is its own surface: a separate module, a separate service, a separate
credential, and its own tests. The smoke client cannot request a download link after this phase any more than
it could before it. A test pins that.

## 1. What was already true, and what was not

`src/ops/torbox-live-transport.ts` (Phase 42) is **status and cache probing only**. Its own header says it is
"operator-smoke plumbing", not wired into any provider factory. It cannot resolve a download link, has never
produced a playable URL, and is not a data path. **Nothing in this repository could turn a TorBox item into
readable bytes before this phase.**

The generic projection real-provider gate (`deploy/projection-real-provider-gate.sh`, acceptance plan §6.10)
was built and offline-green, but its `endpoint.json` `resolverUrl` names *a resolver service contract*. **No
service implementing that contract for TorBox existed.** This phase writes it.

## 2. The official contract, and where each fact came from

Taken from TorBox's **own published SDK source and documentation**, not from prose or third parties.

| Family | Method | Path | Item parameter | File parameter |
|---|---|---|---|---|
| torrent | `GET` | `/v1/api/torrents/requestdl` | `torrent_id` | `file_id` |
| web download | `GET` | `/v1/api/webdl/requestdl` | `web_id` | `file_id` |
| usenet | `GET` | `/v1/api/usenet/requestdl` | `usenet_id` | `file_id` |

Origin `https://api.torbox.app`. Authentication is a **`token` query parameter**, not a header. Response:

```json
{ "success": true, "detail": "...", "error": null, "data": "<the CDN URL>" }
```

with **every field optional** in the published schema — which is why §4 fails closed on all of them.

**Sources.**

- Method, path and parameter list, all three families:
  [`TorrentsService.md`](https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/services/TorrentsService.md),
  [`WebDownloadsDebridService.md`](https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/services/WebDownloadsDebridService.md),
  [`UsenetService.md`](https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/services/UsenetService.md)
- **Wire parameter spellings** (`web_id`, `usenet_id`, `file_id`) from the SDK's own request construction in
  `src/services/usenet/usenet.ts` and `src/services/web-downloads-debrid/web-downloads-debrid.ts`. **This
  distinction is load-bearing**: the SDK's *method arguments* are camelCase (`webId`, `usenetId`) while the
  *query keys* are snake_case. A resolver that sent the camelCase spelling would be silently ignored.
- Response fields from
  [`RequestDownloadLinkOkResponse.md`](https://github.com/TorBox-App/torbox-sdk-js/blob/main/documentation/models/RequestDownloadLinkOkResponse.md).
- Link lifetime and the permalink guidance from TorBox's own API documentation: the endpoint "opens the link
  for 3 hours"; the docs recommend permalinks over repeatedly minting CDN URLs.

**One thing the documentation does not give**, recorded here rather than guessed: **the response carries no
expiry field.** The three-hour figure is documentation prose, so this adapter treats a link as good for
**two** hours (`TORBOX_ASSUMED_LIFETIME_MS`) — strictly shorter than the documented window, so the first read
after 2h59m refreshes instead of racing an expiry it cannot observe.

## 3. The stable reference

```
torbox:<kind>:<providerId>:<fileId>          e.g.  torbox:torrent:1234:0
```

Exactly the minimum TorBox's own endpoints need: a family, an item id, a file id. **No name, hash, size or
category** — each would be one more field to keep out of logs forever, and none is needed to fetch bytes.

Parsed strictly: four colon-separated fields, a known scheme, a known kind, and two integers with no
whitespace, sign, decimal point, exponent or leading zero. **It is never logged and never quoted back in a
failure message** — the pair (item id, file id) identifies something in the operator's account.

## 4. What the adapter refuses

- **Anything but `GET` on those three paths.** No create, control, edit, delete, permalink, user-data or
  export. A test greps the shipped source for those paths.
- **`redirect=true` is never sent.** It would answer 3xx toward a CDN host; this contract needs the JSON body,
  and the data plane refuses redirects in any case.
- **Any ambiguous body.** `success` not exactly `true` (including absent, including under HTTP 200); `data`
  absent, empty or not a string; `data` not a URL; `data` not `https`. Guessing here hands the data plane
  something that is not a URL and turns a clean provider error into an obscure read failure three layers down.
- **The provider's own `detail` and `error` strings are never repeated outward.** They routinely carry the
  item name, and on some errors the request URL.
- **`401`/`403` are terminal for the resolver**, never retried: a rotated key gives the same answer however
  many times it is asked, and each ask spends the operator's rate limit. The one-refresh-per-read rule lives
  above, in the data plane.
- **`429` is retried, bounded** — three attempts, 250/500 ms backoff. TorBox meters this endpoint; an
  unbounded retry against a rate limit is how a correctness gate becomes a denial of service on the
  operator's own account.

## 5. Why the resolver is a separate process

Two secrets exist and they must not meet.

| Secret | Held by | Mode |
|---|---|---|
| TorBox API key | the **resolver service** | `0600` |
| gate secret | the **projection daemon**, presented as a bearer to the resolver | `0600` |

Putting the API key in the daemon's configuration would mean the data-plane binary — the one that talks to
arbitrary provider-supplied CDN hosts — also held the credential that can enumerate and manage the operator's
entire TorBox account. It has no need of it. With the split, the worst a compromised daemon yields is the
ability to ask for links it was already going to be given.

The resolver **binds loopback only and re-checks the peer address per request**; it re-reads both secret files
per request, so rotating or revoking either takes effect without a restart.

## 6. What is proven, and what is not

**Proven offline** (`npm run test:torbox-resolver`): all three families resolve end to end through the real
service against a faithful fixture; the minted link serves the right bytes by range, backward and past 90 %;
an expired link is recovered by exactly one fresh resolution; a wrong credential is refused and never retried;
a bad gate secret reaches no provider; a malformed reference costs the provider nothing; nine resolver-side
misbehaviours fail closed; a metered 429 is retried exactly three times and then gives up; a hanging provider
hits a finite deadline; and no log line, response or error carries a reference, a token or a request URL.

**Not proven, and only an operator can prove it:** that TorBox honours its own published contract. No test
here contacts a real account, reads a real credential, or searches for one. The real gate stays **skipped
with exit 77** until the operator supplies inputs.

## 7. What an operator must supply

Under a `0700` directory (default `/mnt/user/appdata/catalog/secrets/real-provider/`):

| File | Mode | Contents |
|---|---|---|
| `torbox-credential` | `0600` | the TorBox API key, and nothing else |
| `gate-secret` | `0600` | any high-entropy string; the daemon presents it to the resolver |
| `objects.json` | `0600` | 1–3 entries, `ref` being `torbox:<kind>:<id>:<fileId>`, with sizes and externally-recorded digests |
| `endpoint.json` | `0600` | `resolverUrl` pointing at the loopback resolver, and an `allowedOrigins` naming the TorBox CDN origins |

Templates carrying **no real values**: `deploy/torbox-resolver.template.json`,
`deploy/real-provider-objects.template.json`, `deploy/real-provider-endpoint.template.json`.
