# Phase 230: Blocker Taxonomy Index (local, non-live)

Report id: `phase-230-promotion-blocker-taxonomy`

Status: `PHASE_230_PROMOTION_BLOCKER_TAXONOMY_READY`

A declared catalogue of every blocker / problem code the Phase 230 local tooling can emit, attributed to
the op that raises it and grouped by a derived category. It verifies the catalogue is internally
consistent. It is a pure declaration + check; it performs no promotion, never touches
`/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live (`authorization` is the
constant `NONE`).

## What it checks

Every entry is `{ code, op, category }`. `categoryOf` buckets a code by suffix/keyword into `missing`,
`invalid`, `mismatch`, `incomplete`, `leak`, `not-ready`, or `other`. The build flags `MALFORMED_CODE`
(not UPPER_SNAKE), `MISSING_OP`, or `DUPLICATE_ENTRY`; `overall` is `TAXONOMY_INCONSISTENT` if any problem
is found, else `TAXONOMY_CONSISTENT`. `BLOCKER_CODES` exports every distinct code (sorted) so the
closure-hygiene gate can confirm the gate DAG raises nothing uncatalogued. Output carries only codes, op
labels, categories, counts, and generic problem codes (no raw digests/paths/titles) plus a
`taxonomyDigest`.

## Files

- `src/ops/promotion-blocker-taxonomy.ts` — `buildBlockerTaxonomy()`, `categoryOf(code)`, `BLOCKER_CODES`.
- `src/ops/promotion-blocker-taxonomy-cli.ts` — CLI wrapper.
- `test/promotion-blocker-taxonomy.ts` — 5 tests: internal consistency, category derivation, full
  gate-DAG blocker coverage, no duplicate code+op pair, and a spawned CLI run.

## Usage

```
npm run ops:promotion-blocker-taxonomy -- [--out taxonomy.json]
```

Exit `0` = `TAXONOMY_CONSISTENT`, `1` = `TAXONOMY_INCONSISTENT`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
