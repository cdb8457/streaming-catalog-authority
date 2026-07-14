# Phase 219: Jellyfin Live Read-Only Mapping

Report id: `phase-219-jellyfin-live-readonly-mapping`

Decision date: `2026-07-14`

Phase type: guarded live read-only mapping command plus redaction-safe evidence acceptance. This
phase consumes the Phase 218 accepted live Jellyfin read-only smoke boundary and runs the mapping
ladder against the real Unraid runtime and the existing Jellyfin server. It does not install
Jellyfin, does not add a Jellyfin container, does not bind ports, does not change Compose, does not
change sidecar custody, does not enable writes, and does not launch runtime Jellyfin integration.

In short: Phase 219 runs the guarded mapping command, but it remains read-only.

## Command Added

Operator command:

```sh
npm run ops:jellyfin-live-readonly-mapping -- --out /mnt/user/appdata/catalog/evidence/phase-219-jellyfin-live-readonly-mapping.json
```

Unraid launcher:

```sh
deploy/unraid-jellyfin-live-mapping-capture.sh [limit] [output-file]
```

The command auto-selects active Catalog Authority items that have encrypted provider refs. Selection
uses internal item ids only; evidence emits only digests and counts. The command refuses direct API
key environment variables and refuses `JELLYFIN_ALLOW_LIVE_PUBLISH=true`.

## Evidence Set

Accepted evidence label: `phase-219-jellyfin-live-readonly-mapping.json`

Retained file SHA-256: `46f3945e995651a916fb7fab820ebc69ef8d61bc2a1700cbe0b3a7407bed4c75`

Mapping evidence digest: `5aee02f0cd123c67d71008994c3f200a6460e058b4bfb31341e1c871f6d3c7ba`

Retained byte count: `1866`

Evidence timestamp: `2026-07-14T02:45:10.063Z`

Evidence status: `JELLYFIN_LIVE_READONLY_MAPPING_NO_ELIGIBLE_ITEMS`

The retained file hash identifies the saved evidence artifact. The mapping evidence digest is the
Phase 219 digest embedded in the redaction-safe report body. The evidence is accepted for command,
boundary, and redaction behavior, but it is not data-positive mapping evidence because the live
Catalog Authority database currently has no eligible active items with encrypted provider refs.

## Acceptance Review

| Checkpoint | Result | Basis |
| --- | --- | --- |
| Valid JSON | Satisfied | The retained artifact parsed as JSON during review. |
| Phase 219 report id | Satisfied | Report id `phase-219-jellyfin-live-readonly-mapping`. |
| Passing boundary status | Satisfied | `ok: true`; status `JELLYFIN_LIVE_READONLY_MAPPING_NO_ELIGIBLE_ITEMS`. |
| Redaction-safe marker | Satisfied | `redactionSafe: true`. |
| Existing-server boundary | Satisfied | Target records scheme and port only, `hostEchoed: false`, `existingServerOnly: true`, `installAttempted: false`, `newPortBindingAttempted: false`. |
| Credential boundary | Satisfied | API key source is file-based and `apiKeyEchoed: false`. |
| Operation boundary | Satisfied | Network gate explicitly enabled for the operator-run command; `writeMode: false`; allowed methods limited to `GET`; allowed endpoint shapes limited to `GET /Items`. |
| Catalog mutation boundary | Satisfied | The command selects existing eligible rows and does not create, update, or delete Catalog Authority items. |
| Mapping totals | Satisfied with caveat | Selected `0`; requested `0`; mapped `0`; unmatched `0`; unavailable `0`; refs considered `0`; Jellyfin matches `0`. |
| Data-positive evidence | Not satisfied | `dataPositiveMappingEvidence: false` because the live catalog has no eligible provider-ref items yet. |
| Secret leakage | Satisfied | No API key, private host, raw provider ref value, Jellyfin item ID, item title, database URL, raw item ID, or raw response body is cited in this acceptance record. |

## Decision

Decision status: `JELLYFIN_LIVE_READONLY_MAPPING_BOUNDARY_ACCEPTED_NO_ELIGIBLE_ITEMS`

The Phase 219 retained evidence is accepted as proof that the live mapping command can run against
the real runtime without writes, without new Jellyfin ports, without installing Jellyfin, without
exposing secrets, and without mutating the catalog. This satisfies the command and boundary portion
of the live read-only mapping rung.

This does not prove an actual Catalog Authority item maps to a Jellyfin library item yet. The live
database needs at least one active catalog item with encrypted provider refs before data-positive
mapping evidence can be captured. Runtime Jellyfin integration remains deferred.

## Boundaries

This phase explicitly forbids:

- printing, committing, or logging the Jellyfin API key;
- citing a raw private host address, Jellyfin item ID, item title, provider ref value, raw item ID,
  or response body;
- installing Jellyfin;
- adding Jellyfin to a Catalog Authority Compose file;
- binding or changing Jellyfin ports;
- enabling `JELLYFIN_ALLOW_LIVE_PUBLISH=true`;
- enabling runtime Jellyfin integration;
- writing Jellyfin collections, deleting collections, refreshing metadata, playback control,
  downloads, provider/debrid contact, scraping, or catalog mutation;
- changing Catalog Authority runtime mode or sidecar custody.

## Status Boundaries

- Phase 218 remains `JELLYFIN_LIVE_READONLY_SMOKE_ACCEPTED`.
- Phase 219 records `JELLYFIN_LIVE_READONLY_MAPPING_BOUNDARY_ACCEPTED_NO_ELIGIBLE_ITEMS`.
- Data-positive read-only mapping evidence remains pending until the catalog contains eligible
  provider-ref items.
- Phase 206 disposable write proof remains optional and not enabled.
- Phase 207 remains `JELLYFIN_INTEGRATION_DEFERRED_PENDING_LIVE_EVIDENCE` until a later decision
  phase updates it with the full live evidence ladder.
- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
- Default Compose files must not enable Jellyfin networking or write mode.

## Next Evidence Gap

The next Jellyfin step is to get at least one real Catalog Authority item into the live catalog with
an encrypted provider ref, then rerun the same Phase 219 command to capture data-positive read-only
mapping evidence. No write-capable rung should run until the read-only mapping evidence is
data-positive and reviewed.
