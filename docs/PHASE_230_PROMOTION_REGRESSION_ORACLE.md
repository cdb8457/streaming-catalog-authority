# Phase 230: Regression Oracle Index (local, non-live)

Report id: `phase-230-promotion-regression-oracle`

Status: `PHASE_230_PROMOTION_REGRESSION_ORACLE_READY`

Maps every coordinator-discovered regression finding to the blocker code that now guards it and the test
that reproduces it, and confirms each mapping is live. It reads files + the shared registry only; it
performs no promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes
nothing live (`authorization` is the constant `NONE`). It fails closed on any broken mapping.

## What it verifies (fail closed)

For each finding `{ finding, blocker, test }`: the finding carries a slug (`FINDING_WITHOUT_REPRO`), the
blocker is catalogued in `BLOCKER_CODES` (`BLOCKER_UNCATALOGUED`), and the repro test exists under `test/`
(`REPRO_MISSING_TEST`). The indexed regressions include the fail-open release-checklist digest
(`REQUIRED_DIGEST_MISSING`), the AN/AO mixed-run binding (`COMMIT_BINDING_MISMATCH`), the unsubstantiated
final summary (`REVIEWED_COMMIT_INVALID` / `TEST_RESULTS_INVALID`), the BA wrong-but-valid digest
(`REPORT_DIGEST_MISMATCH`), the reviewer-pack/preflight forgeries (`REVIEWER_PACK_DIGEST_MISMATCH`,
`PACK_COMPONENT_INCOMPLETE`, `PACK_BINDING_FAILED`), the context/commit-range binding
(`CONTEXT_HEAD_MISMATCH`, `CONTEXT_COMMITS_MISMATCH`), and the archive/review-bundle cross-checks
(`EVIDENCE_LEDGER_MISMATCH`, `ARCHIVE_EVIDENCE_MISMATCH`).

`overall` is `ORACLE_COMPLETE` when every mapping holds, else `ORACLE_INCOMPLETE`. Output carries only
kebab-case finding slugs, UPPER_SNAKE blocker codes, repo-relative test paths, and booleans plus an
`oracleDigest`.

## Files

- `src/ops/promotion-regression-oracle.ts` — `buildRegressionOracle(projectRoot, extra?)`,
  `REGRESSION_FINDING_COUNT`.
- `src/ops/promotion-regression-oracle-cli.ts` — CLI wrapper.
- `test/promotion-regression-oracle.ts` — 4 tests: complete over the live repo, an injected
  uncatalogued-blocker / no-repro finding, an empty root (missing repro test), and a spawned CLI run.

## Usage

```
npm run ops:promotion-regression-oracle -- [--out oracle.json]
```

Exit `0` = `ORACLE_COMPLETE`, `1` = `ORACLE_INCOMPLETE`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
