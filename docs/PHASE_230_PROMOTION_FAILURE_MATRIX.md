# Phase 230: Failure-Mode Matrix (local, non-live)

Report id: `phase-230-promotion-failure-mode-matrix`

Status: `PHASE_230_PROMOTION_FAILURE_MATRIX_READY`

Maps **every** catalogued blocker code — the original set and the AP-AX additions — to (a) the test suite
that exercises its raising op (positive/negative cases), (b) a doc reference, and (c) a gate reference
(the op's gate-DAG node), and classifies the evidence kind: `asserted` (the code literally appears in a
test or corpus module), `emitted` (it appears in a module that raises it), or `suite` (covered by the op's
suite). It reads files + the shared registries only; it performs no promotion, never touches
`/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live (`authorization` is the
constant `NONE`).

## Fail-closed gaps

- `UNMAPPED_BLOCKER` — a code whose op has no gate-DAG node or no resolvable/existing doc reference.
- `STALE_TAXONOMY` — the taxonomy is internally inconsistent, a gate-DAG blocker is uncatalogued, or the
  map carries a code no longer in the taxonomy.
- `MISSING_TEST_PATH` — a mapped test file does not exist.
- `BLOCKER_WITHOUT_EVIDENCE` — a code with no assertion, no emitter, and no existing suite.

`overall` is `FAILURE_MATRIX_COMPLETE` when no gap fires, else `FAILURE_MATRIX_INCOMPLETE`. Entries carry
only codes, op ids, repo-relative test paths, doc names, and enums (no raw digests/paths/titles) plus a
`failureMatrixDigest`.

## Files

- `src/ops/promotion-failure-matrix.ts` — `buildFailureMatrix(projectRoot, extraEntries?)`.
- `src/ops/promotion-failure-matrix-cli.ts` — CLI wrapper.
- `test/promotion-failure-matrix.ts` — 5 tests: complete over the full catalogue, AP-AX blockers mapped,
  stale/unmapped drift detection, an empty root (missing test path / no evidence), and a spawned CLI run.

## Usage

```
npm run ops:promotion-failure-matrix -- [--out matrix.json]
```

Exit `0` = `FAILURE_MATRIX_COMPLETE`, `1` = `FAILURE_MATRIX_INCOMPLETE`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
