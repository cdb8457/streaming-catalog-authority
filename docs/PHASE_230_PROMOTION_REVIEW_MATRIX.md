# Phase 230: Coordinator Review Matrix (local, non-live)

Report id: `phase-230-promotion-review-matrix`

Status: `PHASE_230_PROMOTION_REVIEW_MATRIX_READY`

An **empty review scaffold** for the coordinator. Given the commit range and the required test suites, it
emits a matrix of every commit crossed with every test, plus per-commit human-review and sign-off slots —
**all left as `PENDING` placeholders** for a human to complete out-of-band. The tool never records an
outcome itself.

## What it emits

Given `{ base, head, commits: [{ sha, subject? }], requiredTests: [label] }`, `REVIEW_MATRIX_READY` when the
axes are well-formed, else `REVIEW_MATRIX_BLOCKED`:

- **Range** — `base`/`head` are sha40 (`BASE_MISSING` / `HEAD_MISSING`), commits are present with sha40 ids
  (`NO_COMMITS` / `COMMIT_SHA_MALFORMED`), and `head` is the terminal commit (`HEAD_NOT_TERMINAL_COMMIT`).
- **Tests** — a non-empty list of path-free labels (`NO_TESTS` / `TEST_NAME_LEAK`).
- **Redaction** — commit **subjects are inspected for leaks but NEVER echoed** (`COMMIT_SUBJECT_LEAK`); the
  matrix records only commit shas (hex), path-free test labels, counts, and the fixed `PENDING` placeholder.

Each row is `{ sha, humanReviewed: PENDING, signedOff: PENDING, tests: [{ test, result: PENDING }] }`. The
report reads parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts
Jellyfin, and authorizes nothing (`authorization` is the constant `NONE`). It restates the remaining human
gates and the closed live boundary and is sealed with a `reviewMatrixDigest`.

**A completed matrix — even one a human fills entirely with approvals — does NOT authorize Phase 231 or any
live promotion.** That remains a separate human step; this tool never contacts Jellyfin and does not
authorize Phase 231.

## Files

- `src/ops/promotion-review-matrix.ts` — `buildReviewMatrix(input)`, `REVIEW_PLACEHOLDER`,
  `HUMAN_REVIEW_OUTCOMES`, `REVIEW_MATRIX_HUMAN_GATES`, `REVIEW_MATRIX_BOUNDARY`, `REVIEW_MATRIX_DISCLAIMERS`.
- `src/ops/promotion-review-matrix-cli.ts` — CLI wrapper.
- `test/promotion-review-matrix.ts` — 5 tests: ready scaffold with all-PENDING placeholders; malformed range
  fail-closed; path-bearing subject/test rejected + never echoed; empty input; and a spawned CLI run.

## Usage

```
npm run ops:promotion-review-matrix -- --range range.json [--out matrix.json]
```

Exit `0` = `REVIEW_MATRIX_READY`, `1` = `REVIEW_MATRIX_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
