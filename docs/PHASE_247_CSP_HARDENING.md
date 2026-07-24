# Phase 247 — operator UI CSP hardening and browser-level acceptance

Phase 246 left one material piece of security debt: the operator UI served its JavaScript and its CSS
**inline**, which forced the page's Content-Security-Policy to allow `script-src 'unsafe-inline'` and
`style-src 'unsafe-inline'`. With those two allowances, a browser will execute any `<script>` that reaches
the DOM — so the page's careful habit of only ever writing untrusted values through `textContent` was the
*only* thing standing between an injected string and code execution, with no backstop if it ever slipped.

Phase 247 removes both allowances. The behaviour and the presentation are now fixed, same-origin static
assets, and the policy is:

```
default-src 'none';
script-src 'self';
style-src 'self';
connect-src 'self';
img-src 'none';
font-src 'none';
object-src 'none';
frame-ancestors 'none';
base-uri 'none';
form-action 'none'
```

Now the browser refuses to execute or apply anything the page did not load from this origin. An injected
`<script>`, an inline `onerror=` handler, an external `<link>`, a `data:`/`blob:` URL, a plugin, an iframe
embedding: every one is refused by the policy — *on top of* the existing textContent discipline, which is
unchanged. Belt and braces, where before there was only the braces.

## What moved, and what did not

| | Before (Phase 246) | After (Phase 247) |
| --- | --- | --- |
| Script | inline `<script>…</script>` | `GET /assets/app.js`, `<script src defer>` |
| Styles | inline `<style>…</style>` | `GET /assets/app.css`, `<link rel=stylesheet>` |
| `script-src` | `'unsafe-inline'` | `'self'` |
| `style-src` | `'unsafe-inline'` | `'self'` |
| Token model | input + memory, bearer header | **unchanged** |
| Endpoints, auth, redaction | — | **unchanged** |

The assets are **plain files** — `src/ops/operator-ui-app.js` and `src/ops/operator-ui-app.css` — the actual
bytes served. There is no framework, no bundler, no transpile step, no build toolchain: the separation of
presentation and behaviour from server code is a file boundary, nothing more. They ship inside the image via
the Dockerfile's existing `COPY src ./src`, and the consumer release bundle (which ships Compose, setup
scripts and docs, never `src/`) is untouched — its file set and reproducibility contract are exactly as
Phase 245/246 left them.

## Serving the assets safely

`src/ops/operator-ui-assets.ts` reads the two files **once, at startup**, into memory and validates them.
Every request thereafter is served from that in-memory copy:

* **no filesystem read at request time.** The route table is an exact-match map of two strings. A request
  contributes a key and nothing else — there is no filename joined to a directory, so there is no traversal
  to defend against beyond the target normalisation the service already does, and no way for a crafted target
  to reach a file the module did not choose.
* **exact targets only.** `/assets/app.js` and `/assets/app.css` and nothing else. `/assets/`, `/assets`,
  `/assets/app.js.map`, `/assets/nope.js`, and every traversal spelling (`..`, `%2e%2e`, backslash,
  protocol-relative) are a plain `404`. A query string cannot change which asset is served.
* **GET only.** `HEAD` and every other method are `405` with `Allow: GET`, identical to the rest of the
  service.
* **correct type, and `nosniff`.** `text/javascript` and `text/css`, fixed by the asset table and never
  guessed from the request, with `X-Content-Type-Options: nosniff` so the browser cannot second-guess them.
* **bounded.** Each asset is length-checked at load against a ceiling; the `Content-Length` is set from the
  buffer.
* **no source map, no remote reference, no operational data.** The loader rejects, at startup, any asset that
  carries a `sourceMappingURL` directive, an absolute or protocol-relative URL, a `data:`/`blob:` URI, an
  `@import`, `eval`/`Function`/`importScripts`, a service worker, browser storage, or a non-empty `innerHTML`
  assignment — and it asserts the script sends exactly the `X-Operator-UI-Secret` header the server verifies,
  so the two cannot drift. A violation throws rather than serves.

## Caching

Every response — shell, assets, and API — carries `Cache-Control: no-store`. For a loopback ops UI reloaded
rarely, re-fetching a few kilobytes costs nothing, and a stale script or stylesheet surviving an image
upgrade is a worse failure than the re-fetch. Sensitive API responses were already `no-store`; the assets
join them rather than being cached, which is the conservative, explicit choice.

## Token model (unchanged, and now behind a stronger wall)

The operator token still lives in exactly one place: the value of the password input. It is never assigned to
a variable, a global, a cookie, `localStorage`, `sessionStorage`, `IndexedDB`, a URL or the page's HTML. It
is read at the moment a request is made and sent as the `X-Operator-UI-Secret` header, nowhere else.
`app.js` is wrapped in an IIFE in strict mode, so not even the element handles leak onto `window` — there is
nothing on the global object a bookmarklet or an extension could read a token off.

**Clear** now zeroes the input **and** resets every rendered panel to its unloaded placeholder — an operator
who clears the token should not still be looking at the component list, logs or chain a previous token
loaded.

## Browser-level acceptance, without a browser in the toolchain

This project's runtime dependency closure is pinned to `pg` and `tsx`, and the render-allowlist suite forbids
`jsdom`/`cheerio`; no browser engine is a dependency. So browser-level acceptance is done two honest ways:

1. **A deterministic DOM harness** (`test/operator-ui-csp-assets.ts`) builds a small fake DOM and executes
   the **real shipped `app.js`** against the **real running server**. It enters a token, clicks *Load
   everything*, and asserts the panels populate from the real `/api/installation`, `/api/status`,
   `/api/logs`, `/api/promotion-chain` and `/api/version` endpoints; a wrong token shows an actionable error
   and correcting it recovers with no reload; Clear zeroes the input and the rendered state; the token never
   reaches a DOM serialization, a request URL, the server log or storage; and no console error is produced.
   The fake element **throws on any non-empty `innerHTML` assignment**, so a full refresh completing at all
   proves no markup-parsing path was taken — the same property a browser's `script-src 'self'` would enforce.

2. **The daemon-backed container smoke** (`deploy/ci/runtime-image-smoke.sh`) issues a real browser-shaped
   request set against the **built image** and asserts the CSP header the real server sends (script/style are
   `'self'`, no `unsafe-inline`), that the shell carries no inline script or style and references only the
   external assets, and that `/assets/app.js` and `/assets/app.css` are served with the right type and no
   token.

A real headless-engine CSP-**violation observer** (e.g. Playwright reading the Reporting API) is the next
rung above this. It is deliberately **not** added — that would put a browser engine in the toolchain the
whole project avoids — and is called out in the smoke script as an explicit future CI extension rather than
faked. Everything a browser's CSP engine acts on is asserted against the real image today.

## Security troubleshooting

**A panel is blank and the browser console shows a CSP error like "Refused to execute inline script" or
"Refused to load the stylesheet".** The page is working as designed and something in front of it is not.
Almost always a reverse proxy (nginx, Traefik, Caddy, a corporate gateway) is **replacing or appending to**
the `Content-Security-Policy` header. Fix it at the proxy by letting this service's header through unchanged,
not by weakening the policy:

* do **not** add `'unsafe-inline'` to `script-src` or `style-src` to make the error disappear — that
  re-opens exactly the hole this phase closed;
* if the proxy injects its own CSP, configure it to **pass through** the upstream header for this route, or
  to set an identical policy, rather than a laxer union of the two (a browser enforces the *intersection* of
  multiple CSP headers, so a second, laxer header does not help and a second, stricter one can break the
  assets);
* the assets are same-origin under the **same** host and port as the page. If you serve the UI under a
  subpath or a different host via the proxy, ensure `/assets/app.js` and `/assets/app.css` resolve to this
  service and are not rewritten, stripped, or served from a cache that predates an upgrade.

**The assets 404 through a proxy but work on `127.0.0.1:8099` directly.** The proxy is not forwarding
`/assets/*` to the service, or is rewriting the path. Route `/assets/` to the operator UI unchanged. Do not
work around it by inlining the script again.

**`docker compose` reports the container unhealthy after an upgrade and the logs mention an asset.** The
image self-checks its assets at startup: if `app.js` or `app.css` fails validation (a bad edit, a truncated
copy), the process refuses to start rather than serve a broken or unsafe page. Rebuild from a clean checkout;
the validation message names which asset and why.

## Boundaries

No image is published, no tag created, no branch merged, nothing deployed. No promotion, approval, execution,
archival or deletion; no Movies library, Jellyfin or provider call; no Phase 231 authorization. The records
mount stays read-only, the database stays unpublished, `/healthz` stays the only unauthenticated operational
route (and reveals no config), every operational route stays authenticated, and the UI still offers no form,
no `POST` and no mutation of any kind.
