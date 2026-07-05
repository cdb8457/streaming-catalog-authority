# Phase 70 - Local Static Operator UI Runtime Shell

Phase 70 adds a minimal local-only HTTP runtime shell for the existing fixture-only static operator
UI artifact. It serves only the in-process Phase 65 artifact that already passes the Phase 64 render
allowlist. It does not read a generated artifact file from disk.

This is a local static preview shell only. It adds no live DB/provider/packet-source/API/playback/download/scraping/media-server behavior.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains packet/count/advisory only.

## Routes

- `GET /` serves the Phase 65 fixture-only static HTML artifact after the Phase 64 render allowlist.
- `GET /healthz` returns fixed JSON: fixture/static/local-only.
- Other routes and methods return safe `404` or `405` responses.

The runtime sends `Content-Type: text/html; charset=utf-8` for `/`, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, and a restrictive Content Security Policy:

```text
default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

## CLI

The listener starts only with the explicit `--serve` flag:

```sh
npm run ops:operator-ui-static-runtime -- -- --serve --host 127.0.0.1 --port 8787
```

Without `--serve`, the CLI prints usage and boundary text and exits without starting a listener.

Host is restricted to `127.0.0.1`. CLI ports are bounded to `1024-65535`; port `0` is supported only
by tests and the in-process start helper. The CLI reads no environment variables and no config files.

## Boundary

Phase 64 render allowlist and Phase 65 artifact packaging remain in front of the HTML body served.
Phase 68/69 boundaries remain visible and are not bypassed: no sanitized packet endpoint is
implemented, no packet source is implemented, and local read-only product behavior remains outside
this slice.

This phase adds no frontend framework, browser JavaScript, API routes for data, live DB read,
environment secret read, filesystem scan, outbound network call, provider call/integration,
playback, download, scraping, media-server logic, credentials, live packet ingestion, or sanitized
packet endpoint implementation.

## Verification

```sh
npm run test:operator-ui-static-runtime
npm run test:operator-ui-static-artifact
npm run test:operator-ui-render-allowlist
npm run test:operator-ui-runtime-boundary
npm run test:operator-ui-packet-source-contract
npm run test:deploy
```
