# Phase 75 - Sanitized Packet Endpoint Readiness Preflight

Phase 75 adds a static readiness preflight for a future sanitized local packet endpoint. It is
preflight-only and reports `not-ready`: no endpoint, auth implementation, route handler, API
framework, DB/env/fs read, fetch/network call, provider integration, browser JS/framework,
cookie/session/token mechanism, packet ingestion, playback, download, scraping, or media-server
runtime behavior is added.

## Fixed Preflight

The fixed no-input preflight is exposed by:

- `src/ops/operator-ui-packet-endpoint-readiness.ts`
- `ops:operator-ui-packet-endpoint-readiness`
- `test:operator-ui-packet-endpoint-readiness`

The exact JSON command is:

```sh
npm run --silent ops:operator-ui-packet-endpoint-readiness -- -- --json
```

The report name is `operator-ui-packet-endpoint-readiness`, the version is `phase-75.v1`, the code
is `OPERATOR_UI_PACKET_ENDPOINT_READINESS_REPORTED`, and the status is `not-ready` /
`preflight-only`.

## Dependency Checks

The preflight makes these fixed gates explicit:

- Phase 69 packet source contract exists but endpoint is not implemented
- Phase 74 auth/access contract exists but auth is not implemented
- static runtime route surface remains only `GET /`, `GET /healthz`, and `GET /manifest.json`
- sanitized local packet endpoint remains blocked
- direct UI DB reads remain forbidden
- provider availability remains packet/count/advisory only
- O4/O5 remain open/deferred unless separately proven
- `FileCustodian` remains reference harness only

## Future Prerequisites

Before any sanitized packet endpoint route can be added, a future phase requires explicit Clint
authorization and reviewer GO, an auth/access implementation phase completed and reviewed, and an
endpoint source that consumes only sanitized redaction-safe operator packets.

The endpoint must not expose real titles, external IDs, provider names/logos, raw refs, infohashes,
magnets, credentials, paths, artwork, user library data, or raw event payloads. It must not add
provider calls, playback/download/scraping/media-server logic, direct DB access, or live packet
ingestion. Route/method/body/raw-target hardening must be retained, size/rate bounds must be defined
before the endpoint exists, and evidence/redaction tests must pass before any endpoint route is
exposed.

## Forbidden Now

These routes remain forbidden now: `/api/*`, `/packets`, `/packet`, `/operator-packets`, `/data`,
`/events`, `/catalog`, `/items`, `/auth`, `/login`, `/session`, `/token`, `/callback`, `/logout`,
`/oauth`, `/sso`, and `/admin`.

Forbidden runtime additions now include route handlers, API framework, DB/env/fs reads,
fetch/network calls, provider integration, browser JS/framework, cookies/sessions/tokens, provider
calls, playback/download/scraping/media-server logic, direct DB access, and live packet ingestion.

The static runtime still serves only `GET /`, `GET /healthz`, and `GET /manifest.json`. Blocked
packet/data/auth paths remain fixed `404`; unsupported methods on known routes remain fixed `405`.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains packet/count/advisory only.

## Verification

```sh
npm run typecheck
npm run test:operator-ui-packet-endpoint-readiness
npm run test:operator-ui-auth-access-contract
npm run test:operator-ui-static-runtime-access-boundary
npm run test:operator-ui-static-runtime-manifest
npm run test:operator-ui-static-runtime-hardening
npm run test:operator-ui-static-runtime
npm run test:operator-ui-packet-source-contract
npm run test:deploy
```
