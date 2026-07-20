# Phase 230: Final Coordinator Readiness Bundle (local, non-live)

Report id: `phase-230-promotion-final-coordinator-readiness-bundle`

Status: `PHASE_230_PROMOTION_FINAL_COORDINATOR_READINESS_BUNDLE_READY`

One compact, redaction-safe coordinator-facing artifact assembled from the whole launch-proofing chain: the
operator acceptance trace, the no-live authorization guard, the live-execution preflight plan, the
approval-request packet, the coordinator review checklist v2, and the self-digest verification output.

## What it produces

When every component re-verifies (self-digest recompute + green status), the bundle reports:

- the reviewed commit, the component report ids / digests / counts;
- open blockers and the required human decisions;
- an explicit live boundary status of **CLOSED**;
- Phase 231 authorization **NONE**;
- a next action limited to a human, item-specific approval later (`AWAIT_HUMAN_ITEM_SPECIFIC_APPROVAL`) —
  **never** live execution.

`FINAL_READINESS_BUNDLE_READY` means the machine-side evidence is assembled for human review. `status` is
`PENDING` and `authorization` is `NONE`. It is **not** an approval and does not authorize Phase 231 or any
live promotion.

## Fail-closed conditions

It fails closed if any input is missing / invalid / not green, if any input claims an
approval / live-ready / execution / Phase 231 authorization (`LIVE_AUTHORIZATION_CLAIMED`), if redaction
safety is not proven for every component (`REDACTION_NOT_PROVEN`), or if the observed-state requirement is
missing from the preflight plan (`OBSERVED_STATE_REQUIREMENT_MISSING`). When blocked, the next action is
`REMEDIATE_BLOCKERS` — still never live execution.

### Coordinator binding

Individually-green components are not enough — they must be the **same** evidence. The bundle cross-binds:

- `ACCEPTANCE_TRACE_COMPONENT_MISMATCH` — the acceptance trace is **re-derived** from the directly-supplied
  components (approval / preflight / no-live / checklist) and its recompute must be READY with a self-digest
  that **exactly** equals the supplied trace's. The trace's own self-reported digests are never trusted (a
  self-sealed artifact proves integrity, not authenticity), so neither a mismatched-but-green component set nor
  a forged/tampered-but-self-consistent trace can pass;
- `REVIEWED_COMMIT_MISMATCH` — the reviewed commit the trace carries must equal the approval packet's;
- `SELF_DIGEST_BINDING_MISMATCH` — the supplied self-digest verification must cover **exactly** the supplied
  guard components (recomputed over them in canonical order), not an unrelated ALL_VERIFIED set.

## Files

- `src/ops/promotion-final-coordinator-readiness-bundle.ts` — `buildFinalCoordinatorReadinessBundle(input)`.
- `src/ops/promotion-final-coordinator-readiness-bundle-cli.ts` — CLI wrapper.
- `test/promotion-final-coordinator-readiness-bundle.ts` — READY bundle; blocked on forged/claiming/redaction-unsafe inputs; CLI run.

## Usage

```
npm run ops:promotion-final-coordinator-readiness-bundle -- --acceptancetrace at.json --noliveguard ng.json --livepreflight lp.json --approvalrequest ar.json --checklistv2 cv.json --selfdigest sd.json [--out bundle.json]
```

Exit `0` = `FINAL_READINESS_BUNDLE_READY`, `1` = `FINAL_READINESS_BUNDLE_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and no
Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize Phase 231.
