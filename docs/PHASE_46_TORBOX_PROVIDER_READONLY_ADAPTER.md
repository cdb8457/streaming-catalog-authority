# Phase 46 - TorBox Read-Only Provider Adapter

Phase 46 wires the reviewed TorBox read-only path into the provider adapter boundary.

This is the first TorBox provider-mode implementation, but it is deliberately narrow:

- advisory `ProviderAdapter` only;
- read-only cache availability lookups only;
- one scoped provider ref per call;
- explicit injected `TorBoxTransport` only;
- no SDK dependency;
- no `globalThis.fetch` construction in core;
- no env reads or credential-file reads in core;
- no database handle, DB writes, event-log writes, scheduling, downloads, playback, UI, or provider
  payload persistence.

## Runtime Shape

`src/core/adapters/torbox-provider-adapter.ts` wraps `TorBoxReadOnlyClient` and implements the
Phase 7 `ProviderAdapter` contract:

- `describe()` returns `{ name: 'torbox-readonly', kind: 'ref-resolver' }`;
- `resolveRef()` accepts only `AdapterRefView`;
- output remains an advisory `AdapterResult`;
- unsupported or empty refs fail closed before transport is called.

`src/core/adapters/adapter-factory.ts` now accepts:

- `mode: 'none'`;
- `mode: 'fake'`;
- `mode: 'torbox-readonly'` with an explicit injected `transport`.

`ADAPTER_MODE=torbox-readonly` by itself fails closed. The factory does not construct a live
transport and does not know how to read credentials. Operator live smoke remains separate.

## Allowed Refs

The adapter inherits the Phase 34 mapping:

| Ref type | Operation |
|---|---|
| `infohash` | `torrent-cache-check` |
| `hash-digest` | `torrent-cache-check` |
| `link-derived-digest` | `webdl-cache-check` |
| `nzb-derived-digest` | `usenet-cache-check` |

## Security Review Points

Still forbidden:

- TorBox SDK imports or dependencies;
- tokens in URLs, logs, evidence, or adapter output;
- raw provider response bodies in adapter output;
- request-download-link, permalink, CDN URL, create-download, control, delete, or user-data calls;
- provider writes, catalog writes, event-log writes, media-server publishing, UI, and playback.

Live validation is still operator-run because it requires a real TorBox credential and scoped ref.
The deterministic test suite proves the adapter path, factory gating, redaction-safe outputs, and
absence of live construction in core.

O4 and O5 remain open/deferred, and `FileCustodian` remains a hardened reference harness rather than
production KMS.
