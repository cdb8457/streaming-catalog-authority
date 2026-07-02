# Phase 13 — Jellyfin Endpoint-Mapping Validation & Smoke

The Phase 11/12 Jellyfin mapping is **PROVISIONAL** — pinned by fake-transport tests but not proven
against a real server. Phase 13 adds a **structured, opt-in smoke** to validate it, plus a targeted
mapping-robustness correction. **CI stays fake-transport only; real validation is manual/opt-in.**

> **Do not claim real Jellyfin publishing works until the `--write` smoke passes on your server.**

## The endpoints the smoke exercises (provisional)

| operation | request | matching |
|---|---|---|
| find items | `GET /Items?Recursive=true&Fields=ProviderIds&IncludeItemTypes=Movie,Series` | ProviderIds matched **locally** |
| create | `POST /Collections?Name=<title> [cat:<token>]&Ids=<matched ids>` | atomic; token in the name |
| find by token | `GET /Items?Recursive=true&IncludeItemTypes=BoxSet&Fields=Name` | name-contains-`[cat:<token>]` matched **locally** (NOT `SearchTerm`) |
| revoke | `DELETE /Items/<opaque collection id>` | — |

### Why the `[cat:<token>]` name marker (not a Jellyfin Tag)

The correlation token is embedded in the collection **name** so a **single atomic** `POST /Collections`
is immediately findable. A Jellyfin **Tag** would require a *second* call (`POST /Items/{id}` to set
Tags) that could fail *after* create — reopening the orphan gap the outbox eliminates. The marker is
opaque (a uuid); it is visible in the collection name but leaks no identity beyond the title (which is
the collection name anyway). This is the safer trade for atomicity; a future phase may revisit if the
smoke shows `POST /Collections` can carry a tag atomically.

### Why find-by-token filters locally (not `SearchTerm`)

Jellyfin `SearchTerm` tokenizes/normalizes and does not reliably match the bracketed marker, so trusting
it risks a false "not found" → a duplicate create during outbox recovery. Phase 13 fetches BoxSets (with
names) and filters locally by `name.includes([cat:<token>])`, exactly as `findItemsByRefs` matches
ProviderIds locally.

## Running the smoke (manual, opt-in)

**Read-only** (safe — find only):
```bash
JELLYFIN_ENABLE_NETWORK=true npm run smoke:jellyfin -- tmdb 603
```
Validates auth + base URL + the find mapping. Reports the matched count.

**Write round-trip** (DESTRUCTIVE, self-cleaning — needs BOTH the flag and the gate):
```bash
JELLYFIN_ENABLE_NETWORK=true JELLYFIN_ALLOW_LIVE_PUBLISH=true \
  npm run smoke:jellyfin -- --write tmdb 603
```
Runs `find → create token-tagged collection → find-by-token → delete → verify-gone`. It **self-cleans**
(deletes the collection it created) and the final `verify-gone` step both confirms cleanup **and** proves
**no duplicate** (a second same-token collection would still be found after deleting our handle). If
cleanup **cannot be confirmed**, the report says so **loudly** — delete the collection manually.

## Interpreting the report

Each step prints `OK`/`FAIL` + a redaction-safe detail (opaque ids/counts/statuses only — **no** api key,
title, ref value, or raw identity). A failing step names the operation whose mapping needs fixing
(`find` / `create` / `find-by-token` / `revoke` / `verify-gone`). Only when the whole write smoke is `OK`
should an operator trust real publishing on that server.

## Credential safety

The api key is delivered via `JELLYFIN_API_KEY_FILE`, sent only as the `X-Emby-Token` header, and is
**never** in the URL, a log, the ledger, an error, or the smoke report. `globalThis.fetch` is used only
by the operator entrypoints (`src/ops/jellyfin-smoke-cli.ts`, `src/ops/publish-reconcile-cli.ts`).

## Out of scope (unchanged)

No Plex, no provider/debrid adapters, no scraping/downloading/playback, no HTTP daemon/UI, **no live
network calls in CI**, no new runtime dependencies, no O4/O5. Jellyfin-only.
