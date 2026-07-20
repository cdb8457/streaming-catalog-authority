# Phase 230: Coordinator Review Checklist V2 (local, non-live)

Report id: `phase-230-promotion-coordinator-review-checklist-v2`

Status: `PHASE_230_PROMOTION_REVIEW_CHECKLIST_V2_READY`

Aggregates the machine-side closing evidence into ONE redaction-safe checklist for a human coordinator:
the closure summary v3 status, the closure-input bundle audit status, the live-boundary guard suite presence,
the full local test command labels, and the human-only remaining steps. `authorization` is the constant
`NONE` and `status` is the constant `PENDING`.

## What it checks (fail closed)

- **Closure summary v3** present, right id, self-digest recomputes, `CLOSURE_SUMMARY_READY`
  (`CLOSURE_SUMMARY_MISSING` / `CLOSURE_SUMMARY_INVALID` / `COMPONENT_DIGEST_UNVERIFIED` /
  `CLOSURE_SUMMARY_NOT_READY`).
- **Closure-input bundle audit** present, right id, self-digest recomputes, `CLOSURE_BUNDLE_VERIFIED`
  (`BUNDLE_AUDIT_MISSING` / `BUNDLE_AUDIT_INVALID` / `BUNDLE_AUDIT_NOT_VERIFIED`).
- **Local test command labels** — the suite labels are read from the repo's `test:phase230-local` gate; the
  list must be non-empty (`NO_TEST_COMMANDS`) and must contain the live-boundary guard
  (`LIVE_BOUNDARY_SUITE_MISSING`).

`overall` is `CHECKLIST_READY` only when every machine check is green. It reads parsed JSON + the repo's
`package.json` only; it performs no promotion, never touches the real Movies root, never contacts Jellyfin,
and echoes only path-free suite labels, booleans, counts, and fixed-language human steps. **CHECKLIST_READY
means the machine-side evidence is assembled for human review — it is NOT an approval and does not authorize
Phase 231.**

## Files

- `src/ops/promotion-review-checklist-v2.ts` — `buildReviewChecklistV2(projectRoot, input)`.
- `src/ops/promotion-review-checklist-v2-cli.ts` — CLI wrapper.
- `test/promotion-review-checklist-v2.ts` — 3 tests: ready checklist aggregating the closure summary + bundle
  audit + live-boundary + test labels; blocked when the closure summary / bundle audit is missing or not
  green; and a spawned CLI run.

## Usage

```
npm run ops:promotion-review-checklist-v2 -- --closuresummary cs.json --bundleaudit ba.json [--out checklist.json]
```

Exit `0` = `CHECKLIST_READY`, `1` = `CHECKLIST_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
