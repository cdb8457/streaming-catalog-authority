# Phase 68 - Local Operator UI Runtime Boundary Plan

Phase 68 adds a fixed, synthetic runtime boundary plan for any future local operator UI. It is a
contract/report phase only. It does not implement a live UI server, HTTP listener, route, runtime UI,
browser JavaScript, DB read, file scan, env read, network call, provider call, packet ingestion, or
provider/media control.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains packet/count/advisory only.

## Runtime Decision

`src/ops/operator-ui-runtime-boundary.ts` reports three fixed surfaces:

- `static-preview`: `ready`
- `local-readonly-runtime`: `blocked/deferred`
- `live-product`: `not-ready`

The static preview remains the only ready surface. Local read-only runtime remains blocked until
Phase 69 plus explicit source, auth, and runtime designs are satisfied. Live product launch remains
not ready.

## Required Future Controls

Before any local read-only runtime can be built, a future phase must define and review:

- local-only bind/access posture; no bind/listener is implemented now;
- operator access/auth boundary;
- read-only packet endpoint/source only, with no direct DB access from UI;
- no provider execution or playback/download controls;
- static preview remains the only ready surface;
- local read-only runtime remains blocked until Phase 69 plus source/auth/runtime designs are
  satisfied.

## CLI

Text output:

```sh
npm run --silent ops:operator-ui-runtime-boundary
```

JSON output:

```sh
npm run --silent ops:operator-ui-runtime-boundary -- -- --json
```

Both outputs are deterministic and parseable. The CLI has no inputs beyond the `--json` output
selection and does not read environment variables, files, databases, local packets, provider data, or
network resources.

## Boundary

This phase adds no web app, frontend framework, API route, HTTP server/listener, browser JavaScript,
live DB read, env read, filesystem scan, network call, provider call/integration, playback, download,
scraping, media-server logic, credentials, or live packet ingestion.

It displays no real titles, external IDs, provider names/logos, infohashes, magnets, credentials,
user library data, poster art, streaming artwork, raw provider refs, or provider availability beyond
packet/count/advisory status.

Phase 64 render allowlist, Phase 65 static artifact packaging, and Phase 67 launch readiness remain
intact.
