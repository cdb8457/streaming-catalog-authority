# Phase 74 - Operator UI Auth/Access Contract Gate

Phase 74 defines the future operator auth/access contract before any packet or data route can be
implemented. It is contract-only: no login, auth, session, cookie, token, bearer, basic, TLS,
reverse-proxy, secret, public-bind, DB, provider, playback, download, scraping, media-server, packet
source, frontend framework, or browser JavaScript runtime behavior is added.

The current allowed runtime exposure remains `127.0.0.1` fixture preview only. Remote exposure is
blocked until an explicit future phase.

## Fixed Contract

The fixed no-input contract is exposed by:

- `src/ops/operator-ui-auth-access-contract.ts`
- `ops:operator-ui-auth-access-contract`
- `test:operator-ui-auth-access-contract`

The exact JSON command is:

```sh
npm run --silent ops:operator-ui-auth-access-contract -- -- --json
```

The contract name is `operator-ui-auth-access-contract`, the version is `phase-74.v1`, and current
status is `not-implemented` / `contract-only`.

## Future Review Categories

The only future auth mechanism categories named for later review are:

- `operator-local-secret-file`
- `reverse-proxy-forward-auth-attestation`
- `mTLS-or-local-network-attestation`

These are labels only. Phase 74 adds no parsing, environment reads, file reads, TLS code, proxy
support, network attestation, credentials, cookies, sessions, or runtime validation.

## Gate Requirements

Before any packet or data route may be added, a future phase must satisfy all of these gates:

- explicit Clint authorization and independent reviewer GO
- no public bind without a reviewed deployment/auth model
- no direct DB reads from UI runtime
- sanitized packet source only after Phase 69 contract and auth/access review
- all operator-facing outputs are redaction-safe
- no credentials/tokens/cookies/session values in logs, docs, or evidence
- rate, size, method, and raw-target fail-closed behavior retained
- O4 and O5 remain open unless separately proven
- `FileCustodian` remains a hardened reference harness only

## Forbidden Until Later Phase

These routes remain forbidden: `/api/*`, `/packets`, `/login`, `/session`, `/auth`, `/token`,
`/callback`, `/logout`, `/oauth`, `/sso`, and `/admin`.

Forbidden runtime behavior includes cookie/session/token/bearer/basic parsing, env/config/file
secret reads, TLS/reverse-proxy/public-bind implementation, frontend framework/browser JavaScript,
direct DB reads, provider calls, packet source implementation, playback, download, scraping, and
media-server logic.

The static runtime still serves only `GET /`, `GET /healthz`, and `GET /manifest.json`. Blocked
auth/data paths remain fixed `404`; unsupported methods on known routes remain fixed `405`.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains packet/count/advisory only.

## Verification

```sh
npm run typecheck
npm run test:operator-ui-auth-access-contract
npm run test:operator-ui-static-runtime-access-boundary
npm run test:operator-ui-static-runtime-manifest
npm run test:operator-ui-static-runtime-hardening
npm run test:operator-ui-static-runtime
npm run test:deploy
```
