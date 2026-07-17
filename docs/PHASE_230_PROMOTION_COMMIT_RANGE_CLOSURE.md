# Phase 230: Commit-Range Closure Verifier (local, non-live)

Report id: `phase-230-promotion-commit-range-closure`

Status: `PHASE_230_PROMOTION_COMMIT_RANGE_CLOSURE_READY`

Given the base/head and the commit list since base, categorizes **every** commit by its subject — a
`phase-op`, a `remediation`, a `docs` change, or a `chore` — and confirms the range is **closed**. It reads
parsed JSON only; it **invokes no git**, performs no promotion, never touches `/mnt/user/media/Movies`,
never contacts Jellyfin, and authorizes nothing live (`authorization` is the constant `NONE`). It echoes
only shas and category enums — **never the raw subjects**.

## What it verifies (fail closed)

- `base` and `head` are present and 40-hex (`BASE_MISSING`, `HEAD_MISSING`); the commit list is non-empty
  (`NO_COMMITS`).
- Every commit `sha` is 40-hex (`COMMIT_SHA_MALFORMED`) and every `subject` is path/title-free
  (`COMMIT_SUBJECT_LEAK`).
- Every commit is categorized — a phase op (`(phase XX)`), a remediation, a docs/index change, or a chore;
  anything else leaves the range open (`COMMIT_UNCATEGORIZED`).

`overall` is `RANGE_CLOSED` iff no blocker fires, else `RANGE_OPEN`. The report records the `base`, `head`,
`commitCount`, per-category counts, and per-commit `{ sha, category }`, plus a `closureDigest`.

## Files

- `src/ops/promotion-commit-range-closure.ts` — `buildCommitRangeClosure(input)`.
- `src/ops/promotion-commit-range-closure-cli.ts` — CLI wrapper (`--in range.json`).
- `test/promotion-commit-range-closure.ts` — 5 tests: closed, an uncategorized commit, a malformed sha /
  subject leak, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-commit-range-closure -- --in range.json [--out closure.json]
```

Exit `0` = `RANGE_CLOSED`, `1` = `RANGE_OPEN`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
