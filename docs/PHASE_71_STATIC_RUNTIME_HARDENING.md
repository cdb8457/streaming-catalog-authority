# Phase 71 - Local Static Runtime Hardening

Phase 71 hardens the Phase 70 local-only static runtime shell before any manifest or packet source
exists. It is a security/runtime hardening phase only.

Still serves only the in-process Phase 65 static artifact behind the Phase 64 allowlist. The runtime
does not read a generated artifact file from disk, does not read config or environment, and does not
add any API/data route, packet source, provider integration, playback, download, scraping, or
media-server behavior.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains packet/count/advisory only. Phase 68/69 boundaries remain visible
and are not bypassed.

## Runtime Hardening

- A pre-listen self-check builds the Phase 65 artifact and verifies the resulting HTML through the
  Phase 64 allowlist inspection before `server.listen`.
- The checked artifact is retained in memory and reused for `/` responses, avoiding per-request
  artifact rebuilds.
- Safe headers are fixed on every runtime response path: `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and the
  restrictive CSP from Phase 70.
- `HEAD` is rejected consistently with `405`, `Allow: GET`, and an empty body for known routes.
- Query strings do not create new route behavior: `/?x=1` remains `/`, and `/healthz?x=1` remains
  health.
- Encoded or traversal-ish paths stay closed with fixed safe `404` responses.
- Disallowed methods ignore request bodies and never echo request data.
- The server applies conservative request, header, keep-alive, and max-header-count limits.

## CLI Lifecycle

The exact local runtime command remains:

```sh
npm run ops:operator-ui-static-runtime -- --serve --host 127.0.0.1 --port 8787
```

The CLI still starts only with `--serve`; without it, no listener starts. When serving, `SIGINT` and
`SIGTERM` close the server before process exit. Error output remains fixed and sanitized.

## Boundary

Phase 71 adds no frontend framework, browser JavaScript, API/data route, manifest endpoint, packet
source, DB read, environment/config read, filesystem scan, artifact-file read, outbound network,
provider call/integration, playback, download, scraping, media-server logic, credentials, live packet
ingestion, or sanitized packet endpoint implementation.

In short: no API/data route, packet source, DB/provider/playback/download/scraping/media-server behavior.

## Verification

```sh
npm run typecheck
npm run test:operator-ui-static-runtime
npm run test:operator-ui-static-runtime-hardening
npm run test:operator-ui-static-artifact
npm run test:operator-ui-render-allowlist
npm run test:deploy
```
