# Phase 76 - Packet Endpoint Limits Contract

Phase 76 adds a fixed Packet Endpoint Limits Contract for the future sanitized local packet endpoint.
It is contract-only and reports `not-implemented`: no endpoint, route handler, runtime enforcement,
auth, DB read, provider behavior, packet ingestion, UI/framework code, rate limiter, or counters are
implemented.

no packet endpoint/runtime enforcement/auth/data/provider/UI expansion is added.

## Fixed Contract

The fixed no-input contract is exposed by:

- `src/ops/operator-ui-packet-endpoint-limits.ts`
- `ops:operator-ui-packet-endpoint-limits`
- `test:operator-ui-packet-endpoint-limits`

The exact JSON command is:

```sh
npm run --silent ops:operator-ui-packet-endpoint-limits -- -- --json
```

The report name is `operator-ui-packet-endpoint-limits`, the version is `phase-76.v1`, the code is
`OPERATOR_UI_PACKET_ENDPOINT_LIMITS_REPORTED`, and the status is `not-implemented` /
`contract-only`.

The endpoint remains blocked: `sanitized-local-packet-endpoint` is `not-implemented`.

## Method Rules

Only GET may ever serve packet snapshots in the first implementation. HEAD remains rejected unless
explicitly reviewed. POST, PUT, PATCH, DELETE, OPTIONS, and other methods rejected with fixed
sanitized responses.

Request bodies ignored/rejected and never echoed.

## Size Limits

- max request target bytes: 2048
- max header count: 64
- max request body bytes: 0
- max response bytes: 262144
- max packet count: 64
- max string field bytes: 256
- max array length per field: 64

These are fixed numeric constants. They are not runtime enforcement in this phase.

## Rate Limits

- loopback preview only
- max requests per minute per operator/runtime process: 60
- burst size: 10
- no remote/IP-based trust yet
- no persistence/counters implemented in this phase

These are fixed data only. Phase 76 does not add persistence, counters, a rate limiter, remote trust,
or IP-based policy.

## Future Failure Behavior

Future failure behavior is fixed as contract data:

- fixed 404 for unknown or blocked routes
- fixed 405 for unsupported known-route methods with `Allow: GET` only after endpoint exists
- fixed 413 for oversized request/response cases when endpoint is later implemented
- fixed 429 for future rate-limit trips

Responses must keep no echoing paths, query strings, headers, body snippets, credentials, raw refs,
packet contents, provider details, or DB errors.

## Retained Hardening

The contract retains these hardening requirements:

- raw target bypass closed
- query strings cannot create behavior
- safe headers retained
- no browser JS/framework requirement
- no direct DB read
- no provider calls
- no playback/download/scraping/media-server behavior
- no live packet ingestion

The static runtime route surface remains only `GET /`, `GET /healthz`, and `GET /manifest.json`.
Blocked packet/data/auth paths remain fixed `404`; unsupported methods on known routes remain fixed
`405`.

Phase 75 readiness remains not-ready until endpoint/auth implementation and evidence tests exist.
O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains packet/count/advisory only.

## Verification

```sh
npm run typecheck
npm run test:operator-ui-packet-endpoint-limits
npm run test:operator-ui-packet-endpoint-readiness
npm run test:operator-ui-auth-access-contract
npm run test:operator-ui-static-runtime-access-boundary
npm run test:operator-ui-static-runtime-manifest
npm run test:operator-ui-static-runtime-hardening
npm run test:operator-ui-static-runtime
npm run test:operator-ui-packet-source-contract
npm run test:deploy
```
