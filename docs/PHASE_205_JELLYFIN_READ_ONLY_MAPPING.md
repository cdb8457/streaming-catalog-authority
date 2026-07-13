# Phase 205: Jellyfin Read-Only Mapping

Report id: `phase-205-jellyfin-readonly-mapping`

Decision date: `2026-07-13`

Phase type: read-only mapping implementation, artifact, and test work. This phase consumes the Phase
204 read-only smoke boundary and adds redaction-safe mapping evidence from Catalog Authority items to
Jellyfin library matches. It does not run live Jellyfin, does not write to Jellyfin, does not persist
Jellyfin identifiers into Catalog Authority, does not change runtime Compose, and does not alter
sidecar custody.

## Source Boundary

Inputs:

- Phase 203 boundary selection: `d5c5b13` / `phase-203`
- Phase 204 read-only smoke gate: `55352a1` / `phase-204`

Phase 205 stays inside Rung 2 from `docs/PHASE_203_MEDIA_PLAYER_BOUNDARY_SELECTION.md`.

## Status

Status: `JELLYFIN_READ_ONLY_MAPPING_READY`

The mapping report proves only:

- Catalog Authority can disclose minimized `providerRefs` through the existing publisher boundary;
- Jellyfin can be queried through the Phase 204 read-only endpoint set;
- the retained evidence can state counts and item digests without raw media identity;
- no writes occur in Catalog Authority or Jellyfin.

It does not prove write-capable publishing, disposable collection cleanup, Plex readiness, Emby
readiness, provider availability, download readiness, playback readiness, or scraping behavior.

## Allowed Data Flow

Allowed:

- `CatalogAuthority.withPublishableIdentity(itemId, ['providerRefs'], ...)`
- `JellyfinClient.findItemsByRefs(refs)`
- redaction-safe output containing:
  - report id;
  - opaque catalog item digest;
  - requested item count;
  - provider-ref count;
  - Jellyfin match count;
  - mapped/unmatched/no-ref/unavailable counts.

Forbidden:

- raw media titles;
- raw provider ref values;
- raw Jellyfin item IDs, collection IDs, or handles;
- API keys, token values, secret paths, DB URLs, KEK/DEK material, or ciphertext;
- `POST`, `PUT`, `PATCH`, or `DELETE` against Jellyfin;
- Catalog Authority event writes or provider-ref projection writes caused by mapping;
- storing Jellyfin item IDs as catalog truth.

## Implementation Record

Implemented code:

- `src/core/adapters/jellyfin/read-only-mapping.ts`
  - `runJellyfinReadOnlyMapping(...)`
  - `buildJellyfinReadOnlyMappingItem(...)`
  - `digestCatalogItemId(...)`
- `test/jellyfin-readonly-mapping.ts`

The helper uses the existing `withPublishableIdentity` privacy boundary with `['providerRefs']` only.
It intentionally returns item digests and counts, not raw IDs. A missing, forgotten, or fail-closed
catalog item becomes `unavailable` rather than leaking why it could not be mapped.

## Operator Evidence Shape

Future retained evidence from a live operator-designated Jellyfin test instance should have this
shape:

```json
{
  "report": "phase-205-jellyfin-readonly-mapping",
  "ok": true,
  "totals": {
    "requested": 3,
    "mapped": 2,
    "unmatched": 1,
    "noRefs": 0,
    "unavailable": 0,
    "refsConsidered": 4,
    "jellyfinMatches": 2
  }
}
```

The evidence may include per-item digests and counts. It must not include raw item IDs, provider refs,
media titles, Jellyfin item IDs, URLs, API keys, or server hostnames.

## Verification Matrix

| Checkpoint | Expected result | Proof |
| --- | --- | --- |
| Phase 204 prerequisite | Satisfied | `55352a1` / `phase-204` added read-only `GET /System/Info` and `GET /Items` smoke. |
| Minimized catalog disclosure | Satisfied | `test:jellyfin-readonly-mapping` uses `withPublishableIdentity(..., ['providerRefs'])`. |
| Read-only Jellyfin access | Satisfied in fixture transport | Mapping calls `findItemsByRefs` only. |
| Redaction-safe evidence | Satisfied | Test asserts no raw title, provider ref, or Jellyfin item ID in public report. |
| No catalog mutation | Satisfied | Test asserts event and provider-ref counts do not change. |
| No Jellyfin write | Satisfied | Test client implements no write call for mapping and asserts only lookup is used. |

No live Jellyfin mapping evidence is committed in this phase because no operator-designated Jellyfin
instance and API key secret file were provided. Live read-only mapping evidence can be captured later
only after Phase 204 live smoke evidence exists.

## Status Boundaries

- O4 remains `O4_CLOSED`.
- O5 remains `O5_DEFERRED_ACCEPTED` with `LAUNCH_WARNING_O5_DEFERRED_ACCEPTED`.
- Phase 205 does not alter sidecar custody or Unraid runtime.
- Phase 206 remains optional and write-capable only for a disposable dedicated collection after
  Phase 204 and Phase 205 evidence are retained and reviewed.
