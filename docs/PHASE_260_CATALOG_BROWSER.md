# Phase 260 — the authenticated, read-only catalog browser

## User-visible outcome

What Phase 259 imported is now visible and useful. The operator UI gains a **Catalog** panel with a record
count, a search box, deterministic sorting, bounded paging, filters, and a record detail view — plus an
**Import a catalog** panel that documents the file format and the exact commands, so a fresh install can go
from "empty" to "browsing my library" without leaving the page.

The navigation reads in the order somebody actually needs it:

> Setup &amp; Diagnostics → Catalog → Import a catalog

Setup &amp; Diagnostics ends with a line pointing at the catalog and, if it is empty, at the import
instructions. The last import step points back at the Catalog panel.

## The endpoints

| route | what it answers |
| --- | --- |
| `GET /api/catalog` | one page of records: `total`, `matched`, `page`, `pageCount`, `truncated`, `items[]`, `guidance` |
| `GET /api/catalog/item?id=<uuid>` | one record in full |

Both are behind the **same operator token** as every other operational route, both are GET-only (405 with
`Allow: GET` for anything else, including HEAD), and both carry the same hardened headers — `no-store`,
`nosniff`, `DENY`, and the Phase 247 CSP.

Query parameters, all optional: `q`, `sort` (`id` · `title` · `year`), `order` (`asc` · `desc`), `page`,
`pageSize`, `refType`, `source`, `yearFrom`, `yearTo`.

## The decisions that shaped it

**Identity is encrypted, so the browser decrypts.** There is no plaintext title column to index or sort on,
and adding one would mean a forgotten item's title outlived its key — defeating the crypto-shredding design
this project is built around. So the browser reads through `CatalogAuthority.readIdentity`, which is
fail-closed at every step and re-checks the lineage at its linearization point.

**That is expensive, so it is bounded — and honest about the bound.** Two paths:

- *No search, no filter, sorted by id.* The database paginates (`ORDER BY id LIMIT/OFFSET`) and **only the
  requested page is ever decrypted**. Exact, cheap, never truncated. Asserted: a 2-record page performs 2
  decryptions.
- *Anything else.* A window of at most `CATALOG_BROWSE_MAX_SCAN` (1000) records is read in id order and
  matched in-process. When the catalog is larger, the response sets `truncated: true`, reports `scanned` and
  `scanLimit`, and the guidance says results came from the first 1000 records by id. It never implies it saw
  everything.

**The order is total.** Every comparison falls back to the item id, which is unique. Two records with the
same title and year therefore have one fixed order, so paging cannot show a record twice or skip one at a
page boundary — the defect an unstable sort produces exactly where it is hardest to notice. A record with no
year sorts last in *both* directions, because "unknown" is not smaller than 1900.

**A malformed query never rejects a browser.** `page=1e999`, `pageSize=-4`, `sort=; DROP TABLE`, a hundred
junk parameters, a repeated parameter, an inverted year range: each falls back to the default and is named in
an `ignored` array the panel displays. A 400 on a stale bookmark helps nobody — and more importantly, every
value that reaches SQL is an integer this code produced or a member of a closed set, never a caller's string.

**Provider ref values are never disclosed.** A ref value is what the adapter boundary exists to guard:
`withProviderRef` discloses exactly one, to one adapter, under redaction, re-checking that it is still
current. A browser panel is not that. List and detail show the ref **type** and a 12-hex non-reversible
fingerprint — enough to tell two records apart and to see that a ref is present. What *is* shown is the
operator's own `externalId` and `metadata`: their identifiers and their notes, shown back to them.

**An empty catalog is a healthy 200.** `state: EMPTY`, `total: 0`, and guidance that says so and points at
the import instructions. A fresh install is not a broken one.

**A forgotten record is indistinguishable from one that never existed.** `readIdentity` fails closed, so a
forgotten item, a destroyed key, an unreachable custodian and an unknown id all produce the same 404 — the
response cannot be used to probe which.

**A read that fails closed mid-page drops that record, not the page.** A lineage that stopped being active,
or a custodian that is briefly unreachable, removes one row from the page. The item is not invented, and the
rest of the catalog stays browsable.

**Everything on the page is `textContent`.** The client never assigns markup; the query is assembled with
`URLSearchParams` so a search term containing `&` or `#` is encoded rather than becoming another parameter;
the record id travels in a `data-` attribute and is `encodeURIComponent`-ed into the detail URL. The Phase 247
asset validator already refuses any non-empty `innerHTML` assignment in the shipped script.

**Nothing here touches promotion evidence.** The catalog panel and the promotion chain panel share a page and
nothing else: no route reads a record artifact, and no browse produces evidence of any kind.

## Proof

`npm run test:phase260-local` — 64 assertions, all passing.

Query parsing: hostile `sort`/`order`/`refType`/`source` values, `1e999`, `Infinity`, `0x10`, `NaN`, `-1`,
` 3 `, page and pageSize ceilings, a 128-character search bound, a NUL-bearing search, an inverted year range,
repeated parameters, and 100 junk parameters — each producing a working default and a named `ignored` entry.

Ordering and paging: identical titles totally ordered by id; undated records last in both directions; a
deterministic repeated sort; paging forward covering 5 records across 3 pages exactly once each; descending
paging as the exact reverse of ascending; a page past the end empty rather than wrapping; a no-match search
reported as `NO_MATCH` with the total intact; a 1025-record catalog reporting `truncated` with the bound
named; the cheap path decrypting only the page.

Disclosure: no ref value in a list or detail response; a stable, type-scoped, non-reversible fingerprint; a
nested or over-long metadata value dropped rather than shipped; a hostile title carried unchanged as data.

Against a real `http.Server`: 401 with no token, 401 with a same-length wrong token (exercising the
constant-time compare) and with a short one, 405 for POST/PUT/PATCH/DELETE/HEAD with `Allow: GET`, the full
header set, 503 `OPERATOR_UI_CATALOG_UNAVAILABLE` with no configuration in the body when there is no
database, 404 for `/api/catalog/../logs` and its encoded variants, the token absent from every log line, and
catalog log lines carrying a verdict and no content.

**End to end, against a real embedded PostgreSQL 16:** a 3-record snapshot is imported through the Phase 259
path, then served over HTTP by the real server — search finds the record, a year filter and a descending
title sort work over encrypted data, the hostile title arrives as JSON data while the provider ref value does
not arrive at all, the detail route shows the operator's own id and a fingerprint, forgetting a record removes
it from the count and makes its detail 404 immediately, and three page loads append **zero** events to the
log.

**The shipped script, executed.** `operator-ui-app.js` is run in a `node:vm` context against a small DOM whose
every node throws on any non-empty `innerHTML` assignment. The Search handler fetches `/api/catalog` with the
token header, a row is rendered as a `<button>` carrying the record id, its `textContent` contains
`<img src=x onerror=alert(1)>` verbatim, clicking it fetches the encoded detail URL, and the detail view
renders a metadata value of `</dd><script>x</script>` as text and the ref fingerprint rather than a value.
Reaching the end of that test is the proof that nothing went through `innerHTML`.

CI: `npm run test:phase260-local` in the existing `suites` job, plus the Phase 258 inventory gate.

## Limitations

- **Search and non-id sorts are bounded at 1000 records.** Above that the response is explicitly `truncated`
  and says so; it does not silently show a subset. Removing the bound would need a searchable projection,
  which would need plaintext at rest, which the erasure design forbids.
- **Search is a case-insensitive substring** over title and the operator's own external ids. No fuzzy
  matching, no ranking, no per-word scoring.
- **`localeCompare` with the `en` locale** orders titles. A catalog in another script sorts consistently but
  not idiomatically for that language.
- **The `source` filter is typed, not chosen from a list.** The available sources are not enumerated, because
  enumerating them means decrypting the whole catalog — the exact cost the scan bound exists to avoid.
- **`/api/status` closes the shared connection pool** when its self-check finishes. A catalog request racing
  that close fails closed to 503. The page loads the catalog after status for that reason, so the common path
  never hits it; a hand-made concurrent request still can.
- **No browser screenshot in this phase.** The DOM harness executes the real shipped script and the
  end-to-end test drives the real server, but the repository's real-Chromium gate remains the existing
  Phase 248 release-candidate acceptance job, which was not extended to the catalog panel here.
- **The detail view shows metadata values.** They are the operator's own imported notes, behind their own
  token; provider ref values, which are not, are masked.

## Next work

Extend the Phase 248 release-candidate acceptance (real Chromium, real Compose, extracted bundle) to import a
snapshot and drive the Catalog panel, so the browser gate covers the product workflow and not only the
diagnostics page. After that, a catalog **export** in the Phase 259 snapshot format would make the round trip
complete and a catalog portable between installations.
