# Phase 43 - TorBox live smoke CLI

Phase 43 wires the existing `smoke:torbox-readonly` operator command to the Phase 42 reviewed
live transport. This is the first path that may contact TorBox, and only when an operator supplies
all explicit live-smoke gates.

Example operator command:

```bash
npm run smoke:torbox-readonly -- --live-smoke --live-transport --read-only --redacted --operator-authorized --credential-file <token-file> --probe service-status --json
```

Cache smoke requires a scoped ref value for the request, but the value is never emitted:

```bash
npm run smoke:torbox-readonly -- --live-smoke --live-transport --read-only --redacted --operator-authorized --credential-file <token-file> --probe cache-availability --ref-type infohash --scoped-ref <scoped-ref> --json
```

## Scope

- Adds `src/ops/torbox-live-smoke-runner.ts`, an injected-transport runner used by deterministic tests.
- Extends `src/ops/torbox-smoke-cli.ts` so the operator CLI may attach `globalThis.fetch` after all gates pass.
- Keeps `smoke:torbox-readonly` operator-run only and absent from `npm run test` / `npm run ci`.
- Reads credentials only from an explicit `--credential-file <path>` after preflight gates pass.
- Emits only fixed categories, operation names, statuses, and counts.

## Boundaries

Phase 43 does not add provider mode, `ADAPTER_MODE` wiring, adapter-factory TorBox construction,
database writes, event-log writes, request-download links, token query parameters, downloads,
playback, Plex/Jellyfin integration, UI, scraping, or scheduler behavior.

It does not install or import `@torbox/torbox-api`, `node-fetch`, `undici`, `axios`, or other
network SDKs. The reusable runner remains injected-transport only; `globalThis.fetch` is confined to
the operator CLI entrypoint.

## Redaction Rules

Operator evidence must not include:

- credential values;
- credential file paths;
- raw scoped refs;
- TorBox endpoint URLs;
- provider response bodies or parse snippets;
- account labels or identity-bearing media names.

Failures use fixed categories such as `auth`, `quota`, `timeout`, `transport`, `parse`,
`unsupported-ref`, and `empty-ref`.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.
