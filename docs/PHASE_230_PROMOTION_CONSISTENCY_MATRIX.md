# Phase 230: Cross-Report Consistency Matrix (local, non-live)

Report id: `phase-230-promotion-cross-report-consistency-matrix`

Status: `PHASE_230_PROMOTION_CONSISTENCY_MATRIX_READY`

Takes the six top-level offline records — the **evidence packet**, **review transcript**, **provenance
ledger**, **gate DAG**, **archive manifest**, and **review bundle** — and verifies that every digest
which appears in more than one report agrees across all of them. It reads parsed JSON only; it performs
no promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing
live (`authorization` is the constant `NONE`).

## Edges

Each cross-report edge asserts two independently-recorded copies of the same digest are equal, e.g.:

- `ledger.evidence-entry = evidence.self` and `ledger.transcript-entry = transcript.self`
- `archive.{evidence,transcript,ledger,dag} = <that report>.self`
- `review.{evidence,transcript,ledger,dag,archive} = <that report>.self`

Each edge is `consistent`, `inconsistent` (both sides resolved but differ), or `incomplete` (a side could
not be resolved because a report was absent). `overall` is `MATRIX_INCONSISTENT` if any edge is
inconsistent, else `MATRIX_INCOMPLETE` if any edge is incomplete, else `MATRIX_CONSISTENT`. Output carries
only the fixed relation labels and status enums (no raw digests, paths, or titles) and a `matrixDigest`.

## Files

- `src/ops/promotion-consistency-matrix.ts` — `buildConsistencyMatrix(input)`.
- `src/ops/promotion-consistency-matrix-cli.ts` — CLI wrapper.
- `test/promotion-consistency-matrix.ts` — 5 tests: all-consistent, a swapped-run inconsistency, a
  missing report (incomplete), empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-consistency-matrix -- --evidence f --transcript f --ledger f --dag f --archive f --reviewbundle f [--out matrix.json]
```

Exit `0` = `MATRIX_CONSISTENT`, `1` = `MATRIX_INCONSISTENT` / `MATRIX_INCOMPLETE`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
