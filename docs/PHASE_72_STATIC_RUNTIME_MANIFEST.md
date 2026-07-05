# Phase 72 - Local Static Runtime Manifest Endpoint

Phase 72 adds one fixed, redaction-safe runtime metadata route to the hardened local static runtime:
`GET /manifest.json`.

This manifest is not a packet source and not a data API. It is fixed synthetic metadata that tells an
operator what the local runtime is and is not. The runtime still serves only the in-process Phase 65
static artifact at `/` behind the Phase 64 render allowlist, still binds only `127.0.0.1`, and keeps
the Phase 71 raw request-target hardening intact.

## Route

- `GET /manifest.json` returns fixed JSON with `Content-Type: application/json; charset=utf-8`.
- The manifest route uses the same safe headers as the rest of the runtime: `Cache-Control:
  no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options:
  DENY`, and the restrictive static runtime CSP.
- `HEAD /manifest.json` is rejected with `405`, `Allow: GET`, and an empty body.
- Other methods ignore request bodies and return fixed sanitized `405` responses.
- Raw request-target bypass forms around `/manifest.json` stay closed with fixed `404` responses,
  including absolute-form, scheme-relative, multiple leading slash, traversal, backslash, encoded
  dot, encoded slash, and encoded backslash forms.

## Fixed Manifest Fields

The manifest is deterministic and no-input. It contains only fixed metadata:

- `ok: true`
- `code: OPERATOR_UI_STATIC_RUNTIME_MANIFEST`
- `surface: local-static-fixture-preview`
- `routes: GET /`, `GET /healthz`, `GET /manifest.json`
- `dataMode: fixture-only`
- `packetSource: not-implemented`
- `localRuntime: static-preview-only`
- `liveProduct: not-ready`
- boundaries for no DB/provider/API data/playback/download/scraping/media-server/packet source
  behavior
- gates for Phase 64, Phase 65, Phase 68, Phase 69, Phase 71, O4/O5, FileCustodian, and provider
  availability boundaries

It includes no timestamp, host machine data, path, port, environment/config value, package version,
git ref, content title, provider name/logo, raw ref, infohash, magnet, credential, user library data,
poster art, streaming artwork, or raw event payload.

## Boundary

Phase 72 adds no packet source, live data, API data route, DB read, environment/config read,
filesystem scan, artifact-file read, outbound network, provider call/integration, playback,
download, scraping, media-server logic, credential handling, live packet ingestion, sanitized packet
endpoint, frontend framework, or browser JavaScript.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains packet/count/advisory only.

## Verification

```sh
npm run typecheck
npm run test:operator-ui-static-runtime
npm run test:operator-ui-static-runtime-hardening
npm run test:operator-ui-static-runtime-manifest
npm run test:deploy
```
