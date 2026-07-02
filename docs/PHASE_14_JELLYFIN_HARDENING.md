# Phase 14 — Jellyfin Mapping Hardening (pagination) & Real-Server Validation Caveats

Phase 13 validates the Jellyfin mapping via an opt-in smoke and filters matches **locally**. Phase 14
hardens the one real-server behavior the fake transport doesn't exercise — **pagination** — and
consolidates the caveats an operator must confirm with the manual `--write` smoke.

## Pagination (the fix)

Jellyfin `GET /Items` **paginates** (a default page size). The Phase 13 local-filter approach fetched a
single page, so on a real library it could **silently miss** an item or collection beyond the first
page → a wrong "not found" (a missed match, or a duplicate create during outbox recovery).

Phase 14 walks pages:
- `buildFindCandidatesRequest(startIndex, limit)` / `buildFindByTokenRequest(startIndex, limit)` carry
  `StartIndex` + `Limit`.
- `JellyfinHttpClient.getAllPages()` requests successive pages, **aggregates** the rows, and stops on
  the first short page — **bounded** by `MAX_PAGES` (200 × 500 = 100k rows scanned) so it never loops
  unbounded. `matchItems` / `matchIdByToken` match over the aggregated rows.
- Isolated to the mapping/client layer; fake-transport regression tests drive multi-page responses
  (a match on a later page must be found, for both `findItemsByRefs` and `findCollectionByToken`).

Still **no live network in CI**; page size is injectable for tests (default 500).

## Remaining real-server validation caveats (the manual `--write` smoke must confirm)

The mapping is still **PROVISIONAL** until the opt-in write smoke passes on your server. Specifically it
confirms:
- **create response shape** — `POST /Collections` returns a body with an `Id` (parsed as the handle);
- **delete permission** — `DELETE /Items/{id}` requires a **deletion-capable** API key (or the write
  smoke's cleanup / real revoke will fail and report `CLEANUP NOT CONFIRMED`);
- **provider-id keys** — Jellyfin `ProviderIds` keys (e.g. `Tmdb`/`Imdb`) match our ref types
  case-insensitively;
- **pagination** — large libraries page as expected (the smoke exercises the walk end-to-end);
- **the `[cat:<token>]` name marker** is preserved verbatim in the collection name and is findable.

> Do not claim real Jellyfin publishing works until `smoke:jellyfin -- --write <ref>` is `OK` on your
> server. See `docs/PHASE_13_JELLYFIN_VALIDATION.md` for how to run it.

## Out of scope (unchanged)

No Plex, no provider/debrid adapters, no scraping/downloading/playback, no HTTP daemon/UI, **no live
network calls in CI**, no new runtime dependencies, no O4/O5. Jellyfin-only, operational/tooling/docs.
