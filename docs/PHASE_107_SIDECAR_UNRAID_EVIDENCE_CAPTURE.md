# Phase 107 - Sidecar Unraid Evidence Capture

Phase 107 defines the redacted evidence bundle expected from a future operator-run Unraid sidecar
test. It does not run commands, read logs, inspect Unraid, start services, or contact live services.

The packet reports `commandExecution: false`, `evidenceValuesEchoed: false`, `serviceInstalled:
false`, and `closesO4: false`.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

## Required Evidence Fields

The review gate expects a single redacted JSON file with fixed statuses and booleans:

- setup permissions captured;
- local socket health captured;
- restart persistence captured;
- restore mismatch fail-closed captured;
- log redaction captured;
- no TCP listener observed;
- no HTTP API observed;
- no LAN exposure observed;
- no reverse proxy observed;
- no provider contact observed;
- no service installed by this packet;
- no O4/O5 closure claim.

## Forbidden Evidence Values

The bundle must not contain raw key material, completion secrets, KEK values, database URLs, secret
file paths, provider references, media titles, tokens, live service response bodies, backup archive
contents, or raw log lines.

## Command

```sh
npm run ops:sidecar-unraid-evidence-capture -- -- --json
```
