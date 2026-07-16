# Phase 230: Coordinator Final Summary Generator (local, non-live)

Report id: `phase-230-promotion-coordinator-final-summary`

Status: `PHASE_230_PROMOTION_FINAL_SUMMARY_READY`

Produces the redaction-safe one-page coordinator summary from the **review bundle** and the **review
transcript** (both required) and, optionally, the **cross-report consistency matrix**, the **self-digest
verification**, and the **blocker taxonomy**. It reads parsed JSON only; it performs no promotion, never
touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live (`authorization` is
the constant `NONE`).

## Green criteria

`FINAL_SUMMARY_READY` requires the review bundle to be present, valid, and `REVIEW_BUNDLE_READY`; the
review transcript to be present, valid, and `REVIEW_CLEAN`; and every *supplied* optional check to be green
(`MATRIX_CONSISTENT`, `ALL_VERIFIED`, `TAXONOMY_CONSISTENT`). An optional check that is simply absent does
not block. Otherwise the summary is `FINAL_SUMMARY_BLOCKED` with generic blockers
(`REVIEW_BUNDLE_MISSING/INVALID/NOT_READY`, `TRANSCRIPT_MISSING/INVALID/NOT_CLEAN`,
`MATRIX_NOT_CONSISTENT`, `SELF_DIGEST_NOT_VERIFIED`, `TAXONOMY_NOT_CONSISTENT`, and the `*_INVALID`
variants).

The summary pins the **exact reviewed commit** (`reviewedCommit`, a 40-hex sha) and the **test results**
(`testResults`, each a fixed command label with non-negative `passed`/`failed` counts, plus `testsPassed`
/`testsFailed` totals) taken from the transcript. Command labels are re-validated as path-free before
being carried, so the summary stays redaction-safe.

Every summary — ready or blocked — restates the four remaining **human gates** (approval authoring; the
Phase 229-defined live promotion, out of scope; coordinator ACCEPT; and Phase 231 authorization, not
granted here) and the fixed non-live disclaimers, and is sealed with a `summaryDigest`. Output carries only
check enums/booleans and fixed-language strings (no raw digests/paths/titles).

## Files

- `src/ops/promotion-final-summary.ts` — `buildFinalSummary(input)`, `FINAL_SUMMARY_HUMAN_GATES`,
  `FINAL_SUMMARY_DISCLAIMERS`.
- `src/ops/promotion-final-summary-cli.ts` — CLI wrapper.
- `test/promotion-final-summary.ts` — 7 tests: all-green READY, exact commit/results surfaced, a missing
  transcript, a not-ready review bundle, a failing optional check, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-final-summary -- --reviewbundle f --transcript f [--matrix f] [--selfdigest f] [--taxonomy f] [--out summary.json]
```

Exit `0` = `FINAL_SUMMARY_READY`, `1` = `FINAL_SUMMARY_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
