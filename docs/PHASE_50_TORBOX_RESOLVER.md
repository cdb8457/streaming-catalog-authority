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

## 7. Two review findings, and what they changed

**THE DOCUMENTED REAL PROCEDURE COULD NOT WORK, AND IS NOW EXECUTABLE.** It told an operator to start the
resolver on the Unraid HOST at `127.0.0.1:8140` and then start `projectiond` in a Docker bridge
network — where `127.0.0.1` is the CONTAINER. The daemon would have dialled its own loopback and found
nothing. The offline gate only worked because its resolver joins the daemon's network namespace, and that
arrangement was never written down for a real run.

`deploy/projection-torbox-real-gate.sh` now does it, executably: the daemon container starts first, the
resolver container joins it with `--network container:<daemon>`, and the gate ASSERTS at run time that
the resolver is unreachable from the gate network. There is no host-port spelling to get wrong, and the
resolver is never published — a resolver anything on the network could reach is a credential oracle.

**REACHING A LOOPBACK RESOLVER NO LONGER REQUIRES THE TEST-ONLY PRIVATE-ADDRESS SWITCH.** The template set
`allowPrivateAddresses: false` while the egress policy refused a literal loopback address unless it was
true — so the documented configuration could not have resolved anything, and the only workaround would have
authorised every RFC1918 destination for CDN reads as well.

`EndpointConfig.LoopbackResolver` is a separate, narrow PRODUCTION authority. It permits the RESOLVER
REQUEST ONLY to dial a **literal** `127.0.0.0/8` or `::1` address. It does not reach RFC1918,
link-local, `169.254.169.254`, the unspecified address, multicast, a DNS name that merely RESOLVES to
loopback, a resolved CDN URL, or `directBaseUrl`. It is carried on a SEPARATE http client from the data
plane, so no permission granted for reaching a resolver can apply to a URL a provider hands back. It defaults
to off.

`projectiond/internal/source/loopback_resolver_test.go` asserts each of those refusals with the switch
ON — a permission is defined by what it refuses, and a test that only proved `127.0.0.1` became
reachable would pass against an implementation that had simply re-enabled everything — plus a regression that
`AllowPrivateAddresses` still means exactly what it meant.

**THE API-ORIGIN OVERRIDE IS NOW FIXTURE-ONLY.** It previously accepted any origin from a file, which made
the production pin advisory — and the request it governs carries the API key as a query parameter, so
pointing it elsewhere hands that key to whoever runs the other end. Every fixture relaxation now requires one
explicit `--fixture-mode` switch and fails closed without it.

## 8. What an operator must supply

Under a `0700` directory (default `/mnt/user/appdata/catalog/secrets/real-provider/torbox/`, overridable with
`PROJECTION_TORBOX_INPUT_DIR`):

| File | Mode | Contents |
|---|---|---|
| `torbox-credential` | `0600` | the TorBox API key, and nothing else |
| `credential` | `0600` | **the gate secret — note the name.** Any high-entropy string; the daemon presents it to the resolver. It must not equal the TorBox key, and the gate fails if it does |
| `objects.json` | `0600` | 1–3 entries, `ref` being `torbox:<kind>:<id>:<fileId>`, with sizes and externally-recorded digests |
| `endpoint.json` | `0600` | **`id` and `allowedOrigins`, and nothing else** (the two fixture switches may appear if false). The CDN origins are the only part an operator knows |

**THE ENDPOINT FILE MUST NOT NAME A `resolverUrl`, AND THIS TABLE USED TO SAY IT MUST.** That was the one
sentence in this document an operator could not act on: `operatorEndpointProblems` refuses `resolverUrl`,
`directBaseUrl`, `loopbackResolver`, `tokenFile` and every transport knob **by name**, because the resolver's
address depends on a network namespace the gate creates and an operator cannot predict it. The gate builds
the effective endpoint from the two fields above and hands *that* to both the preflight and the daemon. The
same paragraph named the gate secret `gate-secret` while the gate has only ever read `credential`, so a
corpus assembled from this table would have skipped with 77 for ever while looking complete.

**IT IS NOT THE GENERIC GATE'S DIRECTORY, EITHER.** `deploy/projection-real-provider-gate.sh` reads
`credential`, `objects.json` and `endpoint.json` from the parent directory, and §6.10 of the acceptance plan
requires its `endpoint.json` to carry **exactly one** of `resolverUrl` or `directBaseUrl` — precisely what
this gate refuses. While both gates shared one directory, preparing either one turned the other's honest
`SKIPPED (77)` into a hard failure, and neither could be prepared without breaking the other.

Templates carrying **no real values**: `deploy/torbox-resolver.template.json`, which carries the
single accurate command sequence, and `deploy/real-provider-objects.template.json`.

**THE REAL-ACCOUNT RUN REMAINS UNPROVEN.** No TorBox account has ever been contacted by this repository. The
path is executable and its offline equivalent has run 3/3 on a real Unraid host; until an operator places the
four files and `npm run go:torbox-real-gate:three` passes, nothing here is evidence about TorBox.
