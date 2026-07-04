# Phase 47 - TorBox Catalog Bridge Acceptance

Phase 47 proves the Phase 46 `torbox-readonly` adapter through the catalog privacy bridge.

The test path is real catalog infrastructure plus deterministic TorBox fixtures:

- real migration and PostgreSQL test database;
- `FileCustodian` reference harness and encrypted provider refs;
- `CatalogAuthority.withProviderRef()`;
- `createAdapter({ mode: 'torbox-readonly', transport })`;
- `resolveProviderAvailability(adapter, view)` for Phase 55 policy classification;
- local in-memory `TorBoxTransport` fixture only.

## Scope

Included:

- persisted `infohash` provider refs only;
- one scoped ref crossing into the TorBox adapter;
- advisory `available` / `unavailable` results;
- fixed policy decisions: `candidate`, `skip`, or `hold`;
- sanitized bridge reports that do not echo provider locator/detail payloads;
- redaction of the scoped ref while the bridge is active;
- assertions that the bridge writes no events and no provider ref rows;
- assertions that unsupported or missing refs fail closed before transport.

Not included:

- no live TorBox calls;
- no SDK dependency;
- no env secret reads;
- no credential-file reads;
- no live transport construction in core;
- no provider writes;
- no DB writes from the advisory adapter path;
- no event-log writes from the advisory adapter path;
- no download, request-download-link, permalink, CDN URL, playback, scheduler, UI, or provider payload
  persistence.

## Boundary Note

Phase 47 intentionally keeps catalog-persisted TorBox bridge coverage to `infohash`. The adapter
contract still supports derived digest ref types, but the catalog encryption AAD currently accepts
the existing persisted ref-type shape. Widening persisted ref-type validation for derived digest
names is a separate schema/security decision.

Live validation remains operator-run through the existing smoke path. O4 and O5 remain open/deferred,
and `FileCustodian` remains a hardened reference harness rather than production KMS.
