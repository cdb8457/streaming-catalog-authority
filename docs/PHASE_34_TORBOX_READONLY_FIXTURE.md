# Phase 34 - TorBox Read-Only Injected Transport Fixture

Phase 34 makes the Phase 33 injected transport contract executable against an in-memory fixture
transport in tests. It is still not a live TorBox client.

Phase 35 follows this with operator-run smoke evidence design and future UI-readiness examples only:
`docs/PHASE_35_TORBOX_SMOKE_EVIDENCE.md`, `docs/templates/TORBOX_SMOKE_EVIDENCE.md`, and
`docs/UI_OPERATOR_DASHBOARD_EXAMPLES.md`. Phase 35 adds no live transport, SDK, provider mode, or UI
runtime.

Phase 36 follows with `docs/PHASE_36_TORBOX_LIVE_SMOKE_CONTRACT.md`, a non-live acceptance contract
for the future opt-in live smoke command. It adds no transport, operator CLI, SDK dependency, or
provider mode.

Phase 37 follows with `docs/PHASE_37_TORBOX_SMOKE_CLI_SHELL.md` and a refused-by-default
`smoke:torbox-readonly` shell. It still adds no live TorBox transport, SDK dependency, provider mode,
or proof that real TorBox works.

The production module is `src/core/adapters/torbox-readonly-client.ts`. It accepts an explicit
config object with an injected `TorBoxTransport`, maps a single scoped `AdapterRefView` to fixed
Phase 33 read-only operation ids, and returns advisory `AdapterResult` statuses only:
`available`, `unavailable`, or `unknown`.

## Scope

Included:

- injected fake transport in tests only;
- no transport implementation in production source;
- no SDK dependency or import;
- no live TorBox calls;
- deterministic mapping from scoped refs to read-only operation and route ids;
- strict fixture availability parsing for clear hit, miss, and unknown responses only;
- fail-closed behavior for non-2xx, auth, quota, timeout, transport, parse, ambiguous payload,
  unsupported ref, and empty ref cases;
- redaction-safe unknown results and optional Phase 33 sanitized gate errors.

Not included:

- no real TorBox transport;
- no proof that real TorBox works;
- no credentials, environment reads, secret-file reads, SDK installation, global fetch, Node network
  modules, browser automation, Docker invocation, HTTP service, UI, DB writes, event-log writes, or
  provider payload persistence;
- no ADAPTER_MODE wiring and no adapter-factory mode for TorBox.

## Ref Mapping

The executable fixture client supports only one scoped ref per call:

| Ref type | Operation | Route id |
|---|---|---|
| `infohash` | `torrent-cache-check` | `torrents.cache-availability` |
| `hash-digest` | `torrent-cache-check` | `torrents.cache-availability` |
| `link-derived-digest` | `webdl-cache-check` | `web-downloads.cache-availability` |
| `nzb-derived-digest` | `usenet-cache-check` | `usenet.cache-availability` |

`hash-digest` maps to `torrent-cache-check` as a digest cache lookup alias. It does not introduce
raw metadata, provider payload persistence, or any create/download behavior.

The client also exposes service status and hoster metadata checks using fixed read-only operation
names only: `status-check` and `hoster-list`.

## Fixture Payload Contract

The fixture parser accepts only:

- `{ availability: 'available' }`
- `{ availability: 'unavailable' }`
- `{ availability: 'unknown' }`

Any other response body shape is ambiguous and fails closed to `unknown`. This intentionally does
not model or validate real TorBox response shapes.

## Future Gates

Real transport and live smoke remain separately authorized and operator-run outside CI. A future
phase must review endpoint mapping, credential handling, timeout and retry behavior, rate limits,
redaction, and fail-closed semantics before live enablement.
Phase 35 provides the redaction-safe evidence template for that future operator-run smoke, without
authorizing or implementing live smoke.

Request-download-link, token-query, permalink, CDN, create, user, control, delete, and export flows remain future-gated.
They are not callable through this fixture client.

O4 remains open/deferred. O5 remains open/deferred. FileCustodian remains a hardened reference
harness, not production KMS.
