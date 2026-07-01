# Phase 11 — Real Jellyfin HTTP Client (gated, injected-fetch)

Phase 11 implements the **real** Jellyfin client that Phase 10 deferred — over an **injected `fetch`**,
behind **two independent default-off gates**, with **no live server in CI** and **no new dependencies**.
It does not weaken the Phase 8 minimization, the Phase 9 erasure ledger/consent, or the Phase 10
adapter behavior — the same shared `JellyfinClient` contract passes for both the fake and the real client.

## ⚠️ The endpoint mapping is PROVISIONAL

`src/core/adapters/jellyfin/mapping.ts` isolates all request-building. It is **not proven** against a
real server. Jellyfin's server-side provider-id filters (e.g. `anyProviderIdEquals`) are unreliable
across versions, so `findItemsByRefs` uses the **safer** strategy: `GET /Items?...&Fields=ProviderIds`
(candidates) and **match locally**. The request shapes are pinned by fake-transport tests but are
validated against a real server ONLY by the **opt-in `smoke:jellyfin`** gate. **Do not claim real
Jellyfin publishing works until that smoke passes** on your deployment (check the server-local Swagger
at `/api-docs/swagger/index.html` if it doesn't).

## Two default-off gates (defense in depth)

A **live real publish** requires BOTH:
1. **`JELLYFIN_ENABLE_NETWORK=true`** — default off; `createRealJellyfinClient` throws
   `JellyfinNetworkDisabledError` otherwise (and needs full `JELLYFIN_*` config, else `ConfigError`);
2. **`PUBLISH_EXTERNAL_IDENTITY=allow`** — the Phase 9 consent gate, unchanged.

`createRealJellyfinClient(fetchImpl, env)` takes the transport as a **required parameter** — there is
**no implicit `globalThis.fetch`** in the adapter, so nothing there can reach the network on its own.
The only place `globalThis.fetch` is referenced is the operator entrypoint `src/ops/jellyfin-smoke-cli.ts`.

## Injected fetch — how CI stays offline

The client calls **only** `this.fetchImpl` (never a bare `fetch`). Every automated test injects a
**fake transport** (a stateful in-memory Jellyfin) and asserts request shapes / responses. There is
**no live network call in CI**; `smoke:jellyfin` is opt-in and out of the CI chain.

## Credentials

API key via `JELLYFIN_API_KEY` / `JELLYFIN_API_KEY_FILE` (Phase 10 parser). It is sent **only** as the
`X-Emby-Token` **header** — never in the URL, an error message, a log, or the publish ledger. Errors
are redaction-safe (`JellyfinHttpError` carries operation + status only). No real keys in committed
fixtures.

## Timeout / retry (fail-closed)

- Per-request **timeout** via `AbortController` (`JELLYFIN_TIMEOUT_MS`, default 10000).
- **Bounded** retry (`maxRetries`, default 2) for **idempotent** ops (search GET, delete) on a
  transport/timeout error or a transient 5xx/429, with a small backoff. **`createCollection` is never
  retried.** No infinite loops.
- **Fail-closed:** any exhausted/failed request throws → a publish records no ledger row; a revoke stays
  `revoke_pending` (retryable, surfaced by `ops:doctor`).

## Revoke limits (unchanged from Phase 10)

Revoke deletes the collection (a BoxSet) by its opaque id via `DELETE /Items/{id}` — which needs a
**deletion-capable API key**. Jellyfin's own logs and any user exports/copies are beyond our reach.

## Unraid / Jellyfin setup (no credential leakage)

1. In Jellyfin: **Dashboard → API Keys → +** to mint a key. Grant deletion rights if you want revoke.
2. Deliver it via a **Docker/Unraid secret file** and point `JELLYFIN_API_KEY_FILE` at it — **never**
   inline the key in compose/env.
3. Set `JELLYFIN_BASE_URL` to the LAN address (e.g. `http://192.168.1.10:8096`).
4. To actually publish: set **both** `JELLYFIN_ENABLE_NETWORK=true` and `PUBLISH_EXTERNAL_IDENTITY=allow`.
5. Validate first: `JELLYFIN_ENABLE_NETWORK=true npm run smoke:jellyfin -- tmdb 603` (read-only).

## Out of scope (unchanged)

No Plex, no Real-Debrid/TorBox, no scraping/downloading/playback, no web/mobile UI, no HTTP daemon, **no
live network calls in automated tests**, and **no new runtime dependencies** (platform `fetch` only).
