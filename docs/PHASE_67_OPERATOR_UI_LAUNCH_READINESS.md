# Phase 67 - Operator UI Launch Readiness Gate

Phase 67 adds a deterministic launch-readiness gate for the operator UI work. It answers the
launch question with fixed synthetic statuses only; it does not inspect local state, live state, or
operator data.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains packet/count/advisory only.

## Readiness Decision

`src/ops/operator-ui-launch-readiness.ts` reports three fixed readiness levels:

- `static-preview`: `ready`
- `local-readonly-ui`: `blocked/deferred`
- `live-product`: `not-ready`

The launch decision is intentionally narrow: the fixture-only static preview can be generated/shared
after the Phase 64 render allowlist and Phase 65 artifact packaging gates pass. Local read-only UI is
blocked/deferred pending explicit future authorization and design. Live product launch is not ready
pending security, runtime, access, custody, and production gates.

## Required Gates And Blockers

The report keeps these blockers visible:

- live UI/API/runtime is not implemented or authorized;
- sanitized local packet source is not implemented;
- auth/access boundary is not implemented;
- O4 production custodian is open/deferred;
- O5 managed KEK custody/scheduling is open/deferred;
- `FileCustodian` is reference harness only;
- Phase 64 render allowlist and Phase 65 artifact packaging are required for static artifact preview;
- provider availability remains packet/count/advisory only.

## CLI

Text output:

```sh
npm run --silent ops:operator-ui-launch-readiness
```

JSON output:

```sh
npm run --silent ops:operator-ui-launch-readiness -- -- --json
```

Both outputs are deterministic and parseable. The CLI has no inputs beyond the `--json` output
selection and does not read environment variables, files, databases, local packets, provider data, or
network resources.

## Boundary

This phase adds no web app, frontend framework, HTTP route, API route, browser JavaScript, live DB
read, local file scan, provider call, provider integration, media-server integration, or live packet
source. It displays no real titles, external IDs, provider names/logos, infohashes, magnets,
credentials, user library data, poster art, or streaming artwork.

The static operator UI remains fixture-only. Phase 64 and Phase 65 remain required before static
artifact preview is treated as shareable evidence. Local read-only and live product launch remain
blocked.
