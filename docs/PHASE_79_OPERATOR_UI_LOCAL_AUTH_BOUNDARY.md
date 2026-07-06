# Phase 79 - Operator UI Local Auth Boundary Selection

Phase 79 adds the `operator-ui-local-auth-boundary` report as a Local Auth Boundary Selection for the operator UI. It is contract-only and not implemented: no auth, runtime route, provider, UI, packet, data, file, environment, network, or credential parsing behavior is added.

Run the fixed report:

```bash
npm run --silent ops:operator-ui-local-auth-boundary -- -- --json
```

The report name is `operator-ui-local-auth-boundary`, version `phase-79.v1`, code `OPERATOR_UI_LOCAL_AUTH_BOUNDARY_REPORTED`, and status `blocked / auth-boundary-selection-only` with auth implementation `not-implemented`. `currentRuntimeExposure` remains `127.0.0.1 fixture preview only`, `remoteExposure` remains `blocked`, and the current static runtime routes remain `GET /, GET /healthz, GET /manifest.json`.

Phase 79 selects `local-operator-secret-file-with-explicit-path-and-redacted-evidence` as `selected-for-future-review/not-implemented`. The first future implementation must require an explicit operator-provided file path only in a later reviewed phase, no default secret path, no environment variable secret value, no CLI argument secret value, bounded file size in future implementation, e.g. <= 4096 bytes, trim one trailing newline only, reject empty or whitespace-only values, reject values below minimum entropy or length, use constant-time comparison, never log, echo, persist, hash-output, or include the secret value in evidence, return redaction-safe errors only, stay loopback-only unless a later reviewed remote access model exists, and avoid browser storage, cookie/session token, bearer/basic auth, or OAuth/Sso in the first implementation.

Rejected first-implementation boundary options are `reverse-proxy-forward-auth-attestation`, `mTLS-or-local-network-attestation`, `browser-cookie-session`, and `bearer-token-api`; each is `rejected-for-first-implementation`. Future implementation gates remain blocked or required-before-auth-implementation until an explicit operator file path review, redaction-safe evidence review, file size bound review, secret value validation review, constant-time comparison review, loopback-only runtime review, static route regression review, independent reviewer GO, and operator acceptance record exist.

Forbidden current routes remain `/login`, `/auth`, `/session`, `/token`, `/callback`, `/logout`, `/oauth`, `/sso`, `/admin`, `/api/packets`, `/packets`, `/packet`, and `/operator-packets`. Retained fail-closed behavior keeps blocked auth, packet, and data paths on fixed 404 responses, known routes on fixed 405 responses for unsupported methods, ignored and non-echoed request bodies, raw request-target bypass forms as fixed 404, and remote exposure blocked.

Forbidden implementation this phase includes auth implementation, cookies, sessions, tokens, bearer/basic parsing, password parsing, credential validation, secret-file reads, environment/config reads, reverse-proxy headers, TLS/mTLS, public bind, route handlers, API framework, frontend/browser JavaScript, UI framework, DB reads, fs reads in the pure implementation, network/fetch, provider integration, packet ingestion, playback/download/scraping/media-server behavior, and live data access.

Forbidden evidence fields include secret value, secret path, environment variable secret value, CLI argument secret value, credentials, tokens, cookies, authorization headers, request paths, query strings, headers, bodies, DB URLs, provider names, real titles, external IDs, infohashes, magnets, raw refs, packet contents, artifact contents, and user library data.

Phase 74 auth contract remains contract-only and not-implemented. Phase 75 readiness remains not-ready. Phase 76 limits remain contract-only and not-implemented. Phase 77 evidence gate remains blocked and evidence-required. Phase 78 route dry-run remains blocked and dry-run-plan-only. O4/O5 remain open/deferred, FileCustodian remains a hardened reference harness only, and Provider availability remains packet/count/advisory only.
