# Phase 77 - Packet Endpoint Evidence Gate

Phase 77 adds a fixed Packet Endpoint Evidence Gate for the future sanitized local packet endpoint.
It is contract-only evidence policy and reports `blocked` / `evidence-required`: no endpoint, route
handler, runtime enforcement, auth, rate limiter, counters, API framework, frontend/browser
JavaScript, DB/env/fs read, network call, provider integration, packet ingestion, playback,
download, scraping, or media-server behavior is implemented.

no endpoint route handler, no runtime auth implementation, no API framework, no DB/env/fs reads, no
network calls, no provider integration, no frontend or browser JavaScript, no packet ingestion, and
no playback/download/scraping/media-server behavior are added.

## Fixed Contract

The fixed no-input contract is exposed by:

- `src/ops/operator-ui-packet-endpoint-evidence-gate.ts`
- `ops:operator-ui-packet-endpoint-evidence-gate`
- `test:operator-ui-packet-endpoint-evidence-gate`

The exact JSON command is:

```sh
npm run --silent ops:operator-ui-packet-endpoint-evidence-gate -- -- --json
```

The report name is `operator-ui-packet-endpoint-evidence-gate`, the version is `phase-77.v1`, the
code is `OPERATOR_UI_PACKET_ENDPOINT_EVIDENCE_GATE_REPORTED`, and the status is `blocked` /
`evidence-required`.

`endpointExposure` remains `blocked` / `not-implemented` for `sanitized-local-packet-endpoint`.
Phase 75 readiness remains not-ready. Phase 76 limits remain contract-only and not-implemented.

## Required Evidence Gates

Endpoint exposure remains blocked until all immutable prerequisites have reviewed evidence:

- static runtime route-surface regression evidence proves only `GET /`, `GET /healthz`, and
  `GET /manifest.json` exist before implementation
- reviewed local operator auth boundary exists before any packet endpoint
- request target, header, body, response, packet, string, and array limits from Phase 76 are enforced
  and tested in the future implementation
- GET-only initial endpoint; HEAD rejected unless explicitly reviewed; POST, PUT, PATCH, DELETE,
  OPTIONS, and OTHER receive fixed sanitized rejections
- fixed 404, 405, 413, and 429 failures with no echo of paths, query strings, headers, bodies,
  credentials, raw refs, packet contents, provider details, or DB errors
- only a sanitized future packet producer may feed the endpoint; no direct DB, provider, or raw-ref
  source is allowed
- logs, evidence, and errors use synthetic labels only
- fixtures and synthetic packets only until an explicit later phase authorizes live packet ingestion
- focused endpoint tests exist before route exposure, including oversized target, header, body,
  response, method rejection, blocked route, raw-target bypass, and redaction sentinel tests
- independent reviewer GO is required before endpoint exposure
- a redaction-safe operator packet and review record are required before endpoint exposure

## Evidence Artifact Labels

Allowed future evidence artifact labels are labels only, not paths and not content:

- `static-route-surface-regression-report`
- `local-operator-auth-boundary-review`
- `phase-76-limits-enforcement-test-report`
- `method-rejection-matrix-report`
- `failure-redaction-sentinel-report`
- `sanitized-packet-source-boundary-review`
- `synthetic-fixture-only-attestation`
- `endpoint-redaction-sentinel-test-report`
- `independent-reviewer-go-record`
- `operator-acceptance-record`

Forbidden evidence fields include titles, external IDs, provider names/logos, raw refs, infohashes,
magnets, URLs, credentials, tokens, cookies, DB URLs, DB errors, request paths, query strings,
headers, bodies, packet contents, and artifact contents.

## Future Test Matrix Labels

The future endpoint test matrix must include at least:

- `oversized-request-target`
- `oversized-header-count`
- `request-body-rejected`
- `oversized-response-blocked`
- `packet-count-limit-enforced`
- `string-field-limit-enforced`
- `array-field-limit-enforced`
- `get-only-success-path`
- `head-rejected-unless-reviewed`
- `method-rejection`
- `unsafe-method-fixed-rejection`
- `blocked-route-fixed-404`
- `raw-target-bypass-fixed-404`
- `redaction-sentinel-no-echo`
- `rate-limit-fixed-429`

## Retained Boundaries

The static runtime route surface remains only `GET /`, `GET /healthz`, and `GET /manifest.json`.
Blocked packet/data/auth paths remain fixed `404`; unsupported methods on known routes remain fixed
`405`.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains packet/count/advisory only.

## Verification

```sh
npm run typecheck
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
```
