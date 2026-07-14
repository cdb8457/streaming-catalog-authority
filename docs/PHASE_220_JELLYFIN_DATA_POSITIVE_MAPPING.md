# Phase 220: Data-Positive Jellyfin Read-Only Mapping Evidence

Report id: `phase-220-jellyfin-data-positive-mapping`

Decision date: `2026-07-14`

Phase type: live read-only data-positive mapping evidence. This phase seeds real Catalog Authority
items through the authority ingestion path, reruns the guarded Phase 219 Jellyfin mapping command,
and records redaction-safe evidence that the mapper can distinguish a matching item from a
nonmatching item. Jellyfin access remains read-only throughout.

## Predecessor Baseline

Phase 219 baseline evidence: `phase-219-jellyfin-live-readonly-mapping.json`

Phase 219 file SHA-256: `46f3945e995651a916fb7fab820ebc69ef8d61bc2a1700cbe0b3a7407bed4c75`

Phase 219 report digest: `5aee02f0cd123c67d71008994c3f200a6460e058b4bfb31341e1c871f6d3c7ba`

Phase 219 status: `JELLYFIN_LIVE_READONLY_MAPPING_NO_ELIGIBLE_ITEMS`

The predecessor proved the command and read-only boundaries, but the live catalog had no eligible
provider-ref items. Phase 220 closes that data gap.

## Ingestion Path

Ingestion command added: `ops:catalog-ingest-item`

Runtime path used: `CatalogAuthority.addItem`

Custody mode during ingestion: sidecar custody.

The ingestion command creates catalog items through the same authority API used by the application
code. It does not hand-insert rows, does not write ciphertext directly, and does not bypass the
custodian. It accepts a provider ref as operator input, encrypts it through `CatalogAuthority.addItem`,
and emits only a redaction-safe item digest plus flags showing that raw item ids, titles, and provider
ref values were not echoed.

Seed set:

| Seed | Expected mapping outcome | Evidence identifier |
| --- | --- | --- |
| Positive item | `mapped` | Catalog item digest `f9d4c92b3665d153`; Jellyfin item digest `5c346baec81c4aea` |
| Negative item | `unmatched` | Catalog item digest `53fc28e719abd1b4` |

The positive seed used a provider ref observed on the existing Jellyfin server. The negative seed
used the same allowed provider namespace with a value selected not to match the live library. Raw
provider ref values are intentionally not recorded.

## Evidence Set

Accepted evidence label: `phase-220-jellyfin-data-positive-mapping.json`

Retained file SHA-256: `7b8cb31e703f20b87a7f262cc376f956c26ed14827ec3c2349db22d183ea3055`

Mapping evidence digest: `ac423af0f96afcb2fff905c228cdc3dd43e29ee866340b3b96c89f9a8e3e9b71`

Retained byte count: `2203`

Evidence timestamp: `2026-07-14T03:24:45.753Z`

Evidence status: `JELLYFIN_LIVE_READONLY_MAPPING_MATCHED`

## Acceptance Review

| Checkpoint | Result | Basis |
| --- | --- | --- |
| Valid JSON | Satisfied | The retained artifact parsed as JSON during review. |
| Data-positive status | Satisfied | `ok: true`; status `JELLYFIN_LIVE_READONLY_MAPPING_MATCHED`; `dataPositiveMappingEvidence: true`. |
| Candidate selection | Satisfied | Selected `2` eligible catalog items. |
| Positive match | Satisfied | Requested `2`; mapped `1`; Jellyfin matches `1`; mapped item records a hashed Jellyfin item digest. |
| Negative discrimination | Satisfied | Unmatched `1`; the mapper did not match every eligible catalog item. |
| Unavailable/no-ref checks | Satisfied | Unavailable `0`; noRefs `0`; refs considered `2`. |
| Existing-server boundary | Satisfied | Target records scheme and port only, `hostEchoed: false`, `existingServerOnly: true`, `installAttempted: false`, `newPortBindingAttempted: false`. |
| Credential boundary | Satisfied | API key source is file-based and `apiKeyEchoed: false`. |
| Operation boundary | Satisfied | `writeMode: false`; allowed methods limited to `GET`; allowed endpoint shapes limited to `GET /Items`. |
| Secret leakage | Satisfied | No API key, private host, raw provider ref value, Jellyfin raw item ID, item title, database URL, raw catalog item ID, or response body is cited in this record. |

## Decision

Decision status: `JELLYFIN_DATA_POSITIVE_READONLY_MAPPING_ACCEPTED`

Rung 2 of the Phase 203 Jellyfin integration ladder is proven with live data. Catalog Authority can
hold encrypted provider refs under sidecar custody and the read-only Jellyfin mapper can resolve at
least one real Jellyfin library item while also leaving a deliberately nonmatching catalog item
unmatched.

This does not approve write-capable Jellyfin behavior. Phase 206 disposable write proof remains
optional and not enabled until a separate decision authorizes it.

## Boundaries

This phase explicitly forbids:

- printing, committing, or logging the Jellyfin API key;
- citing a raw private host address, Jellyfin raw item ID, item title, provider ref value, raw catalog
  item ID, or response body;
- hand-inserting production DB rows or directly writing provider ref ciphertext;
- installing Jellyfin;
- adding Jellyfin to a Catalog Authority Compose file;
- binding or changing Jellyfin ports;
- enabling `JELLYFIN_ALLOW_LIVE_PUBLISH=true`;
- enabling runtime Jellyfin integration;
- writing Jellyfin collections, deleting collections, refreshing metadata, playback control,
  downloads, provider/debrid contact, scraping, or catalog mutation beyond the two deliberate
  Catalog Authority seed items.

## Status Boundaries

- Phase 219 remains the no-eligible-items baseline.
- Phase 220 records `JELLYFIN_DATA_POSITIVE_READONLY_MAPPING_ACCEPTED`.
- Rung 2 of the Phase 203 Jellyfin ladder is satisfied.
- Rung 3 write-capable disposable collection proof remains not enabled and requires a separate
  decision.
- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
- Default Compose files must not enable Jellyfin networking or write mode.
