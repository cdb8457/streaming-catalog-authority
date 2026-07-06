# Phase 82 - Operator UI Auth Packet Acceptance Evidence

Phase 82 adds a local acceptance evidence harness for the Phase 81 operator UI
auth packet runtime. It proves the guarded packet endpoint behavior with a
temporary generated local secret file and emits only redaction-safe evidence.

## Command

Text report:

```bash
npm run ops:operator-ui-auth-packet-acceptance
```

JSON report:

```bash
npm run --silent ops:operator-ui-auth-packet-acceptance -- -- --json
```

The harness does not accept user secret values or user secret paths. It creates
its own temporary local secret file for loopback probing, starts local in-process
fixture runtimes, and removes the temporary file before returning.

## Evidence Shape

The report is named `operator-ui-auth-packet-acceptance`, uses
`phase-82.v1`, and emits `OPERATOR_UI_AUTH_PACKET_ACCEPTANCE_REPORTED`.
The report status is `accepted` only when every probe succeeds; otherwise the
status is `blocked` with fixed redaction-safe check details.

The report includes:

- `runtimeMode: local-loopback-fixture-only`
- `auth: local-secret-file-enabled`
- `packetEndpoint: /operator-ui/packets.json`
- `packetSource: synthetic-fixture-only`
- `packetCount` and `screenCount` counts only
- stable check IDs with status and status code
- forbidden evidence classes
- explicit boundaries and non-goals

The report never includes secret values, secret file paths, auth headers,
request bodies, query strings, database URLs, credentials, real titles,
external IDs, provider names or logos, raw refs, hashes, magnet links, user
library data, artwork, artifact contents, raw packet contents, or HTML
contents.

## Acceptance Probes

The harness proves:

- Static-only mode keeps `/operator-ui/packets.json` disabled with fixed 404.
- With an explicit generated local secret file, the manifest reports
  `local-secret-file-enabled` and `sanitized-local-packet-endpoint` without any
  secret path.
- Missing, wrong, and multiple local secret headers return fixed 401 without
  challenge or packet data.
- The correct local secret returns only the synthetic fixture packet snapshot;
  evidence records counts only.
- Query-bearing packet targets, including secret query attempts, return fixed
  404 before auth and do not echo query values.
- HEAD returns fixed 405 with `Allow: GET` and an empty body.
- Non-GET methods return fixed 405 with `Allow: GET` and no body echo.
- Raw target bypass attempts return fixed 404.
- Root HTML keeps a hash-pinned inline script CSP and same-origin connect.
- No browser-side persistence or standardized web auth flow is introduced.

## Boundaries

- No DB reads.
- No provider or debrid integrations.
- no live source, scraping, download, playback, or media-server behavior.
- No frontend framework or API framework.
- No browser persistence, cookie/session behavior, or standardized web auth
  flow.
- No user-provided secret values or user-provided secret paths.
- Packet evidence is counts only from synthetic fixtures.
- O4 and O5 remain open/deferred.
- FileCustodian remains a hardened reference harness only, not production KMS.

## Verification

- `npm run test:operator-ui-auth-packet-acceptance`
- `npm run test:operator-ui-auth-packet-runtime`
- `npm run test:operator-ui-static-runtime`
- `npm run test:operator-ui-static-runtime-hardening`
- `npm run test:operator-ui-static-runtime-access-boundary`
- `npm run test:deploy`
