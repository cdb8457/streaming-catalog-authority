# Phase 259 — offline catalog import

## User-visible outcome

An operator can put a file of their own catalog records on disk and load it into their installation. This is
the first thing Catalog Authority lets somebody *do*; everything before it installs the software.

```
$ docker compose exec app npm run ops:catalog-import -- --file my-library.json
Catalog import — PREVIEW (nothing was written)
  source            my-library
  snapshot digest   7f3c1a9e0b2d4c58
  records           412
  create            412
  update            0
  already present   0
  blocked           0
  note: This was a preview. Nothing was written. Re-run with --apply to commit it.
  RESULT: OK

$ docker compose exec app npm run ops:catalog-import -- --file my-library.json --apply
  ... created 412 ...
```

The folder is mounted **read-only** at `/var/lib/catalog/import`; the host side is `./import/` by default and
`CATALOG_IMPORT_HOST_DIR` moves it. The release bundle ships a complete, valid
`example-catalog-snapshot.json` to copy there.

## The format

One JSON file. `docs/templates` is not involved; this is the whole specification.

```json
{
  "format": "catalog-authority.snapshot",
  "version": 1,
  "source": "my-library",
  "items": [
    {
      "externalId": "movie-0001",
      "title": "An Example Film",
      "year": 1994,
      "providerRefs": [{ "type": "imdb", "value": "tt0000001" }],
      "metadata": { "shelf": "a1" }
    }
  ]
}
```

| field | required | rules |
| --- | --- | --- |
| `format` | yes | exactly `catalog-authority.snapshot` |
| `version` | yes | exactly `1` |
| `source` | yes | `[a-z0-9][a-z0-9._-]*`, ≤ 64 chars. It participates in every derived id, so changing it re-imports everything as new records. |
| `items[].externalId` | yes | printable ASCII, single line, ≤ 128 chars, unique within the file |
| `items[].title` | yes | non-empty, ≤ 512 chars, no control characters |
| `items[].year` | no | integer 1800–2200, or absent/null |
| `items[].providerRefs` | no | at most one per type, from the database's own closed set: `infohash`, `tmdb`, `imdb`, `tvdb`, `tvmaze`, `anidb`. Values ≤ 256 chars. |
| `items[].metadata` | no | flat string→string map, ≤ 24 keys, keys `[a-z0-9][a-z0-9._-]*`, values ≤ 512 chars |

Whole-document bounds: 8 MiB, 10,000 items. An unknown key anywhere — top level, item, or provider ref — is
a rejection, not an ignored field.

## The decisions that shaped it

**Identities are derived, not invented.** An item id is `uuidv5(sha256("catalog-authority.snapshot/v1 <source>
<externalId>"))`. Re-importing the same file therefore addresses the same rows, which is what makes the whole
operation idempotent: `cat_add_item_ct` already treats a second write to an existing active item as a no-op,
so a repeat import cannot duplicate anything, and a run that failed half-way can simply be re-run.

**Validation completes before the first write.** `parseCatalogSnapshot` returns a fully normalized document or
throws with every problem it found. The applier never sees a partially valid snapshot, so a malformed file
leaves an empty catalog empty. Proved against a real database: a file whose second record is invalid does not
write the first.

**Every write goes through `CatalogAuthority.addItem`.** There is no second ingestion path. Imported identity
is encrypted in-process with a per-item DEK from the custodian exactly like every other write, and the
database only ever sees ciphertext. The suite reads the raw `items` and `provider_refs` bytes back and asserts
no imported title or ref value is findable in them.

**An import cannot undo an erasure.** A record addressing an item that has been forgotten (or is mid-shred) is
reported `blocked` and skipped. The database would refuse it anyway — `item is forgotten; use restore()` — but
detecting it during planning means an operator sees it in the preview rather than as a failure part-way
through a run. `restore()` remains the deliberate, separate operation.

**Existing records are left alone by default.** An import creates; it does not edit. `--update-existing` opts
into rewriting identity in place, which reuses the active lineage key and epoch (no key rotation, no new
lineage) — asserted in the suite.

**Whole-run atomicity is not claimed, and is not needed.** Per-record atomicity is the database's:
`cat_add_item_ct` is one call that takes the per-item lock and commits everything or nothing, so a failed
record leaves no row and no key lineage behind (asserted). Wrapping every record in one transaction would mean
holding custodian provisioning across the whole file, which is exactly the failure matrix `provisionAndWrite`
exists to avoid. Instead the run is **resumable**, and the report distinguishes `applied`, `failed` and
`not-attempted` so "we stopped before this one" is never blurred into "this one is fine".

**Reports carry no content.** Counts, an action, and a non-reversible 16-hex digest per record. No title, no
provider ref value, no external id, no filesystem path — in the summary, the JSON report, an error message or
a validation problem. A rejected path names the *constraint* (`CATALOG_IMPORT_DIR`), never the path, because a
report gets pasted into issues.

**It reads one file.** No directory is walked, no media path is scanned, no provider or media server is
contacted, no process is spawned, and no network module is imported. With `CATALOG_IMPORT_DIR` set the file
must resolve inside it *after symlinks on both sides*, so a symlink planted in the folder cannot read
something outside it.

## Proof

`npm run test:phase259-local` — 59 assertions passing, 1 honest skip.

- 12 malformed documents rejected (not JSON, wrong format/version, unknown keys, bad `source`, no items).
- Duplicate `externalId` rejected, naming both positions and a digest, with neither value echoed.
- Over-long title / external id / ref value / metadata value; too many items; over-byte-limit document.
- A ref type outside the database's closed set is caught before any write, naming the accepted types.
- Nested metadata, a `__proto__` key delivered as raw JSON (which `JSON.parse` makes an own property),
  metadata key-count overflow.
- Control characters (NUL, ANSI escapes) in title, ref value and metadata value.
- A title containing `<script>alert(1)</script>` round-trips **unchanged** — escaping is the renderer's job,
  and mangling a legitimate title here would prove nothing.
- An external id of `'; DROP TABLE items; --` is data: it derives a plain uuid and reaches SQL as a parameter.
- Path: traversal out of the import directory, an absolute path outside it, a symlink pointing out of it
  (skipped by name on a Windows host that cannot create one; it runs on Linux in CI), a directory instead of a
  file, an oversized file refused before the read.
- Against a real embedded PostgreSQL 16: a preview changes nothing; an apply persists through
  `CatalogAuthority`; the bytes at rest are ciphertext; every field round-trips through `readIdentity`; a
  second import creates nothing and changes no row count; `--update-existing` rewrites in place without
  rotating the key; a forgotten item is blocked and stays unreadable; a mid-run failure leaves no partial row
  or key lineage and reports the rest as not-attempted; re-running completes the import; a rejected snapshot
  changes nothing; a 1,200-record snapshot plans through the batched lookup.
- Source scans (comments stripped) assert no module references `node:http/https/net/dns/tls`, `undici`,
  `fetch(`, `node:child_process`, `jellyfin`, `tmdb`, `torbox`, `readdirSync`, `promotion` or `unraid`; and
  the parser references no filesystem, database or environment facility at all.

The CLI itself was also driven end to end against a throwaway database: preview (exit 0, nothing written),
apply (exit 0, two records created), apply again (exit 0, zero created, "nothing changed"), a file with an
invalid record (exit 3, rejected whole, the database untouched), and `--file ../../etc/passwd` (exit 3,
refused, naming the constraint and not the path). That run is what found the last defect fixed here: a
preview was listing every record it was about to create under "records needing attention", which made an
ordinary first import read like a page of problems.

Wired into CI as `npm run test:phase259-local` in the existing `suites` job, and into the aggregate inventory.

## Limitations

- **One format, one file.** No CSV, no directory of files, no streaming. A 10,000-item bound and an 8 MiB
  bound are generous for a personal library and deliberately not "unlimited".
- **`--update-existing` is all-or-nothing per record.** It replaces the identity with what the file says; it
  does not merge. A field absent from the file becomes absent on the record.
- **Changing `source` re-imports everything.** Identities are derived from it, so a renamed source produces a
  parallel set of records rather than updating the old ones. That is the price of derived ids and is stated
  here rather than hidden.
- **A record blocked by an erasure stays blocked.** There is no `--restore` flag, on purpose: reversing an
  erasure should not be a side effect of an import.
- **Metadata values are strings.** Numbers and nested objects are rejected rather than coerced.
- **No `pg_dump`-level rollback.** The unit of atomicity is the record; the recovery story is "run it again".

## Next work

Phase 260 makes what was imported visible. Beyond that: an export that produces a snapshot in the same format
(so import/export round-trip, and a catalog becomes portable), and a `--prune` mode that reports records
present in the database but absent from the snapshot — reporting only, never deleting, since deletion is
`forget()` and should stay a deliberate act.
