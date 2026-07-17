# Phase 230: Coordinator Review Automation Checklist (local, non-live)

Report id: `phase-230-promotion-review-automation`

Status: `PHASE_230_PROMOTION_REVIEW_AUTOMATION_READY`

Composes the automated closing evidence — the **artifact chain bundle**, the **redaction regression
corpus**, and the **static boundary policy report** — into one checklist stating which review steps are
machine-verified and which remain **human** steps. It reads parsed JSON only; it performs no promotion,
never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live
(`authorization` is the constant `NONE`). **Passing automation is not an approval.**

## Automated checks (all required, fail closed)

| Check | Passes when |
|-------|-------------|
| `chain-bundle` | `CHAIN_BUNDLE_READY` |
| `redaction-corpus` | `REDACTION_CORPUS_HELD` |
| `boundary-policy` | `BOUNDARY_POLICY_ENFORCED` |

Every present input must also carry a valid sha256 self-digest (`chainDigest` / `redactionDigest` /
`policyDigest`), recorded in `boundDigests` — else `COMPONENT_DIGEST_MISSING` / `COMPONENT_DIGEST_INVALID`.
`overall` is `REVIEW_AUTOMATION_PASSED` iff every check is present, valid, green, and digest-bound;
otherwise `REVIEW_AUTOMATION_BLOCKED` with generic blockers (`*_MISSING`, `*_INVALID`,
`CHAIN_BUNDLE_NOT_READY`, `REDACTION_CORPUS_BREACHED`, `BOUNDARY_POLICY_VIOLATED`).

## Manual steps (always enumerated, never automated)

Human review of the commit range/diff; optionally the full `npm test` aggregate; the explicit coordinator
ACCEPT via the acceptance seal; and any merge/tag/push and any Phase 231 authorization — human steps NOT
performed or authorized here. The report restates the fixed non-live disclaimers and is sealed with an
`automationDigest`.

## Files

- `src/ops/promotion-review-automation.ts` — `buildReviewAutomation(input)`, `MANUAL_REVIEW_STEPS`,
  `AUTOMATION_DISCLAIMERS`.
- `src/ops/promotion-review-automation-cli.ts` — CLI wrapper.
- `test/promotion-review-automation.ts` — 5 tests: all-passed, missing/not-green inputs, a digestless
  input, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-review-automation -- --chainbundle f --redactioncorpus f --boundarypolicy f [--out automation.json]
```

Exit `0` = `REVIEW_AUTOMATION_PASSED`, `1` = `REVIEW_AUTOMATION_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
