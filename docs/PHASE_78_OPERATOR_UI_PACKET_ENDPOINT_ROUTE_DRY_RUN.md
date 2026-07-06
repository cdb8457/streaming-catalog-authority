# Phase 78 - Packet Endpoint Route Dry-Run Plan

Phase 78 adds a fixed Packet Endpoint Route Dry-Run Plan for the future sanitized local packet
endpoint. It is contract-only and reports `blocked` / `dry-run-plan-only`: no packet endpoint,
route handler, runtime enforcement, auth implementation, rate limiter/counters, API framework,
frontend/browser JavaScript, UI framework, DB/env/fs read, network/fetch, provider integration,
packet ingestion, playback, download, scraping, media-server behavior, cookies/sessions/tokens, or
live data access is implemented.

no endpoint/runtime/auth/provider/UI/data expansion is added.

## Fixed Contract

The fixed no-input contract is exposed by:

- `src/ops/operator-ui-packet-endpoint-route-dry-run.ts`
- `ops:operator-ui-packet-endpoint-route-dry-run`
- `test:operator-ui-packet-endpoint-route-dry-run`

The exact JSON command is:

```sh
npm run --silent ops:operator-ui-packet-endpoint-route-dry-run -- -- --json
```

The report name is `operator-ui-packet-endpoint-route-dry-run`, the version is `phase-78.v1`, the
code is `OPERATOR_UI_PACKET_ENDPOINT_ROUTE_DRY_RUN_REPORTED`, and the status is `blocked` /
`dry-run-plan-only`.

`routeExposure` remains `blocked` / `not-implemented`. The `candidateEndpointId` is
`sanitized-local-packet-endpoint`. The `candidateRoute` is the synthetic label
`future-local-packet-snapshot-route`; it is not an implemented route path.

Phase 75 readiness remains not-ready. Phase 76 limits remain contract-only and not-implemented.
Phase 77 evidence gate remains blocked and evidence-required.

## Dry-Run Plan

The planned route is local loopback only in a future phase and remains blocked now.

- first implementation method: GET only
- HEAD remains rejected unless explicitly reviewed
- POST, PUT, PATCH, DELETE, OPTIONS, and OTHER rejected with fixed sanitized responses
- request body byte limit remains 0
- request target max 2048 bytes
- max header count 64
- max response 262144 bytes
- max packet count 64
- max string field bytes 256
- max array length 64
- future rate preview: 60 requests/min per operator runtime process, burst 10, loopback preview
  only, no remote/IP trust, no counters implemented now
- future failure behavior: fixed 404, fixed 405 with Allow GET only after endpoint exists, fixed
  413, fixed 429
- no echo categories: paths, query strings, headers, bodies, credentials, raw refs, packet
  contents, provider details, and DB errors

Route exposure prerequisite: Phase 77 evidence gate must be satisfied and independently reviewed
before implementation.

## Dry-Run Steps

Every dry-run step is either `planned-only` or `blocked`:

- route exposure prerequisite
- future loopback route shape
- method matrix
- size limits
- rate preview
- failure behavior
- redaction boundary
- source boundary
- operator acceptance
- independent reviewer GO

## Acceptance Matrix

The acceptance matrix labels are fixed:

- method matrix
- size matrix
- rate preview
- redaction sentinel
- raw target bypass
- blocked route
- auth boundary
- packet source boundary
- operator acceptance
- independent reviewer GO

## Runtime Route Boundary

Current static runtime routes remain fixed as `GET /`, `GET /healthz`, GET /manifest.json.

Forbidden current routes remain fixed:

- `/api/packets`
- `/packets`
- `/packet`
- `/operator-packets`
- `/data`
- `/events`
- `/catalog`
- `/items`
- `/auth`
- `/login`
- `/session`
- `/token`

The static runtime route surface remains only `GET /`, `GET /healthz`, and `GET /manifest.json`.
Blocked packet/data/auth paths remain fixed `404`; unsupported methods on known routes remain fixed
`405`.

## Retained Boundaries

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains packet/count/advisory only.

Forbidden implementation this phase includes packet endpoint, new static runtime route, route
handlers, runtime enforcement, auth implementation, rate limiter or counters, API framework,
frontend/browser JavaScript, UI framework, DB reads, env/config reads, fs reads in the pure
implementation, network/fetch, provider integration, packet ingestion,
playback/download/scraping/media-server behavior, cookies/sessions/tokens, and live data access.

## Verification

```sh
npm run typecheck
npm run test:operator-ui-packet-endpoint-route-dry-run
npm run test:operator-ui-packet-endpoint-evidence-gate
npm run test:operator-ui-packet-endpoint-limits
npm run test:operator-ui-packet-endpoint-readiness
npm run test:operator-ui-auth-access-contract
npm run test:operator-ui-static-runtime-access-boundary
npm run test:operator-ui-static-runtime-manifest
npm run test:operator-ui-static-runtime-hardening
npm run test:operator-ui-static-runtime
npm run test:operator-ui-packet-source-contract
npm run test:deploy
npm run ci
```
