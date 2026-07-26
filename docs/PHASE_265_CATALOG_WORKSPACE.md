# Phase 265 — the catalog as a workspace

Phase 260 made the catalog **browsable**. This phase makes it **usable**: the things a person does with a
library they own, rather than the things a viewer can prove.

## What is there now

| | |
| --- | --- |
| **Search** | title or the operator's own record id, over decrypted values, bounded and honest about the bound |
| **Sort** | identifier, title or year, ascending or descending, always a **total** order |
| **Filter** | provider-reference type, **imported-under source**, year range |
| **Page** | bounded page number, and a chosen **page size** of 25, 50 or 100 |
| **Detail** | one record in full: the operator's own ids, metadata, and reference presence |
| **Import history** | every import applied to this installation, from either surface, surviving restarts |
| **Export** | a sanitized, deterministic, downloadable snapshot |
| **States** | empty, no-match, past-the-end, truncated, unavailable — each says what to do next |

### Provider references: presence and status, never the value

The list shows reference **types**. The detail view shows the type plus a short, non-reversible
**fingerprint** — enough to tell two records apart and to see that a reference is present, and not the value.
A reference value is the thing the adapter boundary exists to guard, and a browser panel is not an adapter.

### The source filter offers what exists, and never invents a label

Two sources of truth are merged, because neither is complete on its own: the **import history** knows every
source ever applied (including ones whose records were later forgotten), and the **current page** knows the
sources of records that may predate the history table. The current selection is always kept across a reload,
so the filter somebody is looking through is never silently dropped.

### Page-size and page-number bounds are honest

An out-of-range page size or page number falls back to the default and is reported in `ignored` — never
honoured, and never a `400` on somebody's bookmark. A page past the end says so specifically, rather than
showing "3 of 3 matched" next to an empty list.

## The export

**What it produces.** A document in the same format the import reads — `catalog-authority.snapshot` v1 — so an
export is a real backup of the part of a catalog this product can give back, and re-importing one is a
supported round trip. The suite proves the round trip: an export re-imported creates nothing and recognises
every record as already present.

**What it deliberately does not contain, and why the round trip is lossy.**

* **Provider reference values.** Never. Not the value, not the type, not the structure. A file an operator
  downloads through a browser is not the one-adapter, under-redaction, re-checked disclosure that
  `withProviderRef` performs, and "it is their own data" does not make a bulk disclosure of every protected
  reference into a different thing. The export **counts** what it omitted and says so in the response and in
  the panel, rather than quietly producing a document that looks complete.
* **Item ids and key material.** Neither appears; neither is content an operator wrote.

**It is a read, structurally.** The only database access is through `CatalogReader`, whose three statements
are SELECTs. There is no authority, no event append and no history write anywhere in the export path — so
"exporting wrote nothing" is a property of what the code can reach, and the suite and the CI acceptance both
count rows, events **and** history entries across an entire browse-and-export session to confirm it.

**It is deterministic.** Records are ordered by the operator's own external id, every object's keys are
written in a fixed order, and the serialisation is explicit rather than left to object key insertion order.
Exporting the same catalog twice produces the same bytes, so two exports can be diffed to see what changed
rather than how they were serialised.

**It is bounded, and refuses rather than truncating.** Over 5000 records it refuses with `TOO_LARGE` and says
no partial file was produced. A truncated file that still says `"format": "catalog-authority.snapshot"` is a
backup that silently is not one, which is worse than no file.

**It is sanitized.** Values are re-checked against the import's own bounds on the way out: a control
character, an over-long value, a metadata key or an external id the import would refuse — each is dropped and
**counted**, never emitted. So an export is always a document the import would accept, and a record written by
some other route cannot smuggle a terminal escape sequence into a file somebody opens.

**A snapshot describes exactly one source.** A catalog holding more than one refuses with `AMBIGUOUS_SOURCE`
and **lists the sources available**; naming one exports it. An unknown source is `UNKNOWN_SOURCE`, also with
the list — so a typo is fixable without guessing. The requested source is matched against the set the database
holds and is never used to build a query, a path or a file name before that match.

**The download name comes from a closed grammar.** `Content-Disposition` is a header where a quote, a
semicolon, a comma or a CR/LF turns a file name into a second parameter — or a second header. The name is only
ever `catalog-export-<source>.json` where `<source>` has already been matched against the database's own set
**and** re-validated against `[a-z0-9][a-z0-9._-]*`, and it is asserted again at the point the header is set;
anything that fails falls back to a constant. It is never escaped, because an escaper has to be right forever.

**The token stays in a header.** A download cannot carry a request header on a plain navigation, so the panel
fetches the bytes with the token in `x-operator-ui-secret`, wraps them in a `Blob`, and hands that to a
download anchor it creates and revokes. The token never reaches a URL, and the file never touches storage.

## What did not change

* **Authentication.** Same operator token, same header, same boundary. Every route above requires it, including
  the export — it is somebody's library, and the fact that it is their own data is a reason to require the
  token, not a reason to skip it.
* **CSP.** `default-src 'none'` with `script-src 'self'` and `style-src 'self'`. No inline script, no inline
  style, no `unsafe-inline`, no `unsafe-eval`. The suite asserts the policy object itself, not the file that
  explains it.
* **Nothing is parsed as markup.** Every dynamic value is written with `textContent`; the only `innerHTML`
  write in the shipped script assigns the empty string, and the suite still checks every one of them.
* **Accessibility.** Every new control has a `<label for>`, every new status is an `aria-live="polite"`
  `role="status"` region, and the focus ring is unchanged.
* **Responsive layout and visual language.** The same panel grid, the same single-column breakpoint at 760px,
  the same type scale and palette. The one addition is a marked border and a warning box on the import panel,
  and colour is never the only signal: the panel says in words that it is the only one that writes, and the
  apply button is disabled until a preview has been read.

## Proof

`npm run test:phase265-local` (`test/operator-ui-catalog-workspace.ts`) — export determinism to the byte,
reference omission, sanitisation of control characters and out-of-bounds values, empty / ambiguous / unknown /
oversized refusals, seven hostile spellings of a source parameter, `Content-Disposition` grammar, a record
failing closed mid-export, auth and method on the export route, fail-closed with no database, the round trip,
paging bounds and totality, the source filter, and — against a real PostgreSQL — that an entire browsing and
exporting session writes **no row, no event and no history entry**.

`deploy/ci/catalog-acceptance.sh` drives the same workspace through a real Chromium against a real Compose
stack.

## Limitations

* **Search and sort over encrypted identity are bounded.** There is no plaintext title column to index, by
  design — that is what makes crypto-shredding an erasure. A search reads a window of the catalog and says so
  when it did not see everything.
* **The export is lossy and says so.** Provider references cannot be exported. An export is not a substitute
  for `ops:backup`, and the refusal message points there for a whole installation.
* **The source filter is best-effort for pre-history records.** It merges the durable history with what the
  current page shows; a source whose records exist but predate the history table appears once a page
  containing one has been loaded.
