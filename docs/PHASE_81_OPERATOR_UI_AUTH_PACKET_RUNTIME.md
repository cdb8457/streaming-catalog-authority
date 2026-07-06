# Phase 81 - Local Auth + Sanitized Packet Endpoint + UI Runtime Connection

Phase 81 is the first guarded runtime connection for the static operator UI.
It keeps the runtime loopback-only and fixture-only while adding an explicit
local operator secret file and an auth-gated sanitized packet endpoint.

## Runtime command

Static-only behavior remains available:

```bash
npm run ops:operator-ui-static-runtime -- --serve --host 127.0.0.1 --port 8787
```

The packet endpoint is enabled only with an explicit secret file:

```bash
npm run ops:operator-ui-static-runtime -- --serve --host 127.0.0.1 --port 8787 --operator-secret-file <path>
```

The runtime reads the explicit file once before listening, bounds it to
`<= 4096` bytes, trims one trailing newline only, rejects empty,
whitespace-only, short, or low-entropy values, and keeps the accepted secret
only in process memory. Errors are fixed and redaction-safe; the secret path
and secret value are never echoed.

## Packet endpoint

When enabled, the only packet route is:

`GET /operator-ui/packets.json`

The request must present `X-Operator-UI-Secret`. The runtime uses no cookies,
sessions, bearer/basic auth, OAuth, localStorage, sessionStorage, persistent
browser secret storage, query-string secrets, or URL secrets. It also does not
use Authorization, body secrets, or persistent browser state. Failed auth
returns a fixed 401 with no challenge and no packet data. HEAD and non-GET
methods return fixed 405 with `Allow: GET`; unsafe raw request-targets remain
fixed 404.

Boundary summary: no cookies, sessions, bearer/basic auth, OAuth, localStorage, sessionStorage, persistent browser secret storage, query-string secrets, or URL secrets.

Responses are `synthetic-fixture-only` snapshots derived from the existing
operator UI fixture packet allowlists. The manifest reports
`operatorAuth: local-secret-file-enabled` and
`packetSource: sanitized-local-packet-endpoint` only when the explicit secret
file is configured.

## UI runtime connection

The root static UI remains public/local fixture-safe. It now includes a minimal
in-memory operator secret control that fetches `/operator-ui/packets.json`
with `X-Operator-UI-Secret`, clears the input after the request starts, and
does not store the secret. CSP allows only the fixed hash-pinned inline script
and same-origin `connect-src`.

## Boundaries

- No DB reads.
- No provider/debrid/Plex/Jellyfin/Hermes calls.
- No scraping, downloading, playback, or media-server behavior.
- No external network calls or outbound fetch from Node.
- No frontend framework, bundler, React, Vite, Next, Express, Fastify, or Koa.
- Existing synthetic packet allowlists remain authoritative.
- O4 and O5 remain open/deferred.
- FileCustodian remains a hardened reference harness, not production KMS.

Boundary summary: no provider/debrid/Plex/Jellyfin/Hermes calls.

## Verification

- `npm run test:operator-ui-auth-packet-runtime`
- `npm run test:operator-ui-static-runtime`
- `npm run test:operator-ui-static-runtime-hardening`
- `npm run test:operator-ui-static-runtime-manifest`
- `npm run test:operator-ui-static-runtime-access-boundary`
- `npm run test:operator-ui-auth-access-contract`
- `npm run test:operator-ui-packet-endpoint-readiness`
- `npm run test:operator-ui-packet-endpoint-limits`
- `npm run test:operator-ui-packet-endpoint-evidence-gate`
- `npm run test:operator-ui-packet-endpoint-route-dry-run`
- `npm run test:operator-ui-local-auth-boundary`
- `npm run test:operator-ui-local-auth-secret-file-preflight`
