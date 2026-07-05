# Phase 73 - Operator Static Runtime Access Boundary

Phase 73 makes the local static operator UI runtime access boundary explicit and testable. It does
not implement login, sessions, cookies, tokens, credentials, TLS, a reverse proxy posture, or public
exposure.

The runtime remains a loopback-only fixture preview over the existing Phase 65 static artifact and
Phase 72 manifest route. It still binds only `127.0.0.1` and still serves only:

- `GET /`
- `GET /healthz`
- `GET /manifest.json`

## Fixed Access Metadata

The manifest now includes fixed no-input metadata:

- `accessBoundary: loopback-only-fixture-preview`
- `operatorAuth: not-implemented`
- `remoteExposure: blocked`
- `futureDataSurfacesRequire: explicit-auth-access-phase`

These strings are constants. They are not derived from host, port, environment, paths, time, git,
package metadata, or operator input.

## Boundary

This is not production auth and does not authorize reverse proxy or public exposure. It is only a
defensive statement of the current local boundary.

Phase 73 adds no auth/session/cookie/token mechanism, no API route, packet endpoint, DB read,
provider integration, playback, download, scraping, media-server logic, TLS, or public bind. Future
packet or data surfaces require an explicit auth/access phase before implementation.

Bad methods, `HEAD`, request bodies, unknown routes, and raw request-target bypass forms remain
fixed and sanitized. `/api/*`, `/packets`, `/login`, `/session`, `/auth`, `/token`, and adjacent
forms remain closed.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains packet/count/advisory only.

## Verification

```sh
npm run typecheck
npm run test:operator-ui-static-runtime
npm run test:operator-ui-static-runtime-hardening
npm run test:operator-ui-static-runtime-manifest
npm run test:operator-ui-static-runtime-access-boundary
npm run test:deploy
```
