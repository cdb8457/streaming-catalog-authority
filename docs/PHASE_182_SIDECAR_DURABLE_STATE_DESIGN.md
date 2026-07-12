# Phase 182 - Sidecar Durable State Design

Report id: `phase-182-sidecar-durable-state-design`

Phase 182 defines the durable state model for the local sidecar custodian. This is a design document
only. It does not create files, install services, change Compose, start a sidecar, or close O4/O5.

## State Roots

Canonical Launch v1 follow-on paths:

```text
/mnt/user/appdata/catalog/sidecar/state
/mnt/user/appdata/catalog/sidecar/run
/mnt/user/appdata/catalog/sidecar/logs
```

The sidecar state path is outside the app database and outside main DB backups. Directory and socket
permissions must be owner-only.

## Durable Records

| Record | Contents | Secret material allowed |
|---|---|---|
| `wrapped-dek` | encrypted DEK payload, key id, item id, epoch, operation id, state label | wrapped DEK only |
| `tombstone` | key id, item id, epoch, destroy operation id, destroyed timestamp, receipt label | no |
| `operation-index` | idempotency index for provision/commit/destroy operations | no |
| `sidecar-config` | non-secret sidecar version, state format version, socket path label | no |

Plain DEKs, KEKs, completion secrets, app DB URLs, operator UI tokens, provider credentials, media
identity, and raw logs must not be stored in durable state.

## Restart Behavior

On restart, the sidecar must:

- reload active wrapped key records;
- reload tombstones before serving `get`;
- reject ambiguous duplicate records;
- refuse service if state format or integrity checks fail;
- remove stale socket files only after proving no live listener owns them;
- keep destroyed keys terminal.

## Restore Behavior

If the main catalog DB is restored without matching sidecar prerequisites, reads must fail closed.
If sidecar state is restored without the matching app DB state, the sidecar must not expose raw key
material by directory scanning or broad list APIs.

## Review Status

Recommended next status: `ready-for-sidecar-state-design-review`.

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.

