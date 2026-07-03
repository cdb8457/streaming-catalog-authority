# Phase 28 - Production Custodian Adapter Contract

Phase 28 makes the production external/managed custodian adapter boundary machine-checkable without
adding a real adapter. It adds static TypeScript contract metadata and a pure descriptor validator in
`src/core/crypto/production-custodian-contract.ts`.

This phase does not add a cloud SDK, vendor SDK, HTTP service, daemon, scheduler, Docker execution,
production database access, live network call, age execution, operator credential use, provider
adapter, Jellyfin/Plex workflow, playback, scraping, downloading, or UI.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Contract Layer

The contract defines:

- required `KeyCustodian` invariants from Phase 16 and Phase 21;
- required production capabilities for a future external/managed adapter;
- forbidden behaviors, including treating `FileCustodian` as production KMS;
- evidence requirements for live validation, attestation documentation, redaction review, and
  backup/restore fail-closed behavior;
- redaction requirements for descriptor validation output;
- fail-closed semantics and trust-boundary assertions.

The validator accepts only metadata/status fields such as adapter name/version, custody boundary,
attestation documentation status, durable tombstone status, app-non-forgeability status, live
validation evidence label, contract kit command label, and redaction review status.

Descriptor metadata must not include secrets, URLs, key ids, receipt values, raw logs, environment
dumps, operator credentials, database URLs, provider refs, raw identity, media titles, Jellyfin ids,
tokens, handles, secret paths, or artifact contents.

## Validator Semantics

`validateProductionCustodianDescriptor(descriptor)` is pure and deterministic. It does not instantiate
adapters, read environment variables, inspect files, connect to a database, call the network, run
Docker, invoke age, or contact a custodian/cloud/KMS service.

The report is redaction-safe by construction:

- fixed finding codes and field names are emitted;
- descriptor values are never echoed;
- hostile strings are bucketed into generic findings;
- O4 is always reported as `open/deferred` with `closesO4: false`;
- O5 is always reported as `open/deferred`;
- `FileCustodian` is always reported as `reference-harness-not-production-kms`.

Complete metadata can show that an adapter descriptor is ready for separate reviewer/operator
evidence review. It cannot close O4 by itself.

## Required Evidence Before O4 Can Be Reviewed

A future adapter descriptor must declare, and reviewers must separately verify:

- an external custody boundary outside the app process and app database;
- `KeyCustodian` conformance through the shared contract kit or a stricter superset;
- operator-run live validation evidence, explicitly outside CI;
- documented deterministic attestation format and app-non-forgeability;
- durable non-secret tombstones and stable destruction receipts;
- fail-closed read, status, retry, timeout, auth, service, quorum, and integrity behavior;
- redaction review for logs, errors, command output, and evidence bundles;
- backup/restore behavior showing main-DB backups exclude custodian key material and restored systems
  fail closed until external custodian prerequisites are supplied.

## Test and CI Wiring

Run the Phase 28 suite with:

```bash
npm run test:production-custodian-contract
```

The suite is wired into `npm run test` and `npm run ci`. It statically checks that the contract module
has no network, DB, fs, Docker, cloud/vendor, live-service imports, or environment reads.

`test/deploy.ts` also guards the Phase 28 wiring and scope boundary so future changes do not silently
turn this static contract into a runtime integration.
