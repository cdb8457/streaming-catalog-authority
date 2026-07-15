# Phase 230: Promotion Readiness Checklist (local, non-live)

Report id: `phase-230-promotion-readiness-checklist`

Status: `PHASE_230_PROMOTION_READINESS_READY`

A local, non-live coordinator checklist that ties together the artifacts the other Phase 230 tools
already produce — the **approval attestation**, the **promotion evidence report**, and the **promotion
evidence review** — and cross-checks that they describe *one* consistent, completed, observed, and
accepted promotion. It emits a redaction-safe `READY` / `BLOCKED` verdict.

It reads parsed JSON only. It performs no promotion, never touches `/mnt/user/media/Movies`, never
contacts Jellyfin, and grants no authorization: a `READY` verdict is a paperwork consistency result for
a coordinator, not a live gate, and it does not authorize Phase 231.

## How it ties the artifacts together

The approval attestation binds `itemId`, `targetRoot`, `sourceRealPath`, `sourceSha256`, and
`destinationPath`. The checklist re-derives the same digests the promotion service and approval workflow
emit (`phase-230-item`, `phase-230-approval`, `phase-230-destination-name`, `phase-230-source-real-path`,
`phase-230-destination-path`) and matches them across artifacts — so it can confirm the promotion
evidence and the review all describe the item/source/destination/root the approval authorized, without
ever handling the raw paths.

## Checklist items

| Item | Required | BLOCKED when |
|------|----------|--------------|
| `APPROVAL_WELL_FORMED` | yes | approval attestation is missing/malformed binding fields |
| `APPROVAL_EVIDENCE_MATCHES_APPROVAL` | when supplied (skipped if not supplied) | supplied approval evidence's expected digests are missing, malformed, or diverge from the approval — a missing/malformed field never silently passes |
| `PROMOTION_EVIDENCE_PRESENT` | yes | no promotion evidence report supplied |
| `PROMOTION_MATCHES_APPROVAL` | yes | promotion evidence's item / source sha256 / destination-name / approval / target-root digests do not all match the approval (reported per-field in `mismatches`) |
| `OBSERVED_JELLYFIN_STATE` | yes | promotion evidence does not prove observed read-only visibility by exact path (`ok`, a VISIBLE/WITHDRAWN status, `jellyfin.awaited/visible/matchBasis==='path'`, and `absentAfterWithdrawal` for a withdrawal) |
| `EVIDENCE_REVIEW_ACCEPTED` | yes | no review, review not accepted, or review's `subjectEvidenceDigest` is not the supplied promotion evidence's `evidenceDigest` |
| `NO_LEAK_IN_CHECKLIST` | yes | the assembled checklist would contain a raw filesystem path |

`verdict` is `READY` iff every required item is `PASS`; otherwise `BLOCKED`, with the failing required
item ids in `blockers`. The emitted checklist carries only digests, enums, booleans, and fixed generic
detail strings — no raw title, source path, or destination path — and a `NO_LEAK_IN_CHECKLIST`
self-scan proves it.

### Note on destination granularity

Promotion evidence exposes the destination **basename** digest (`destinationNameDigest`), so the
promotion cross-check verifies the destination file name, not the full folder path. The full
`destinationPath` is separately bound in the approval and enforced fail-closed by the promotion service
at run time; when approval evidence is supplied, its `destinationPathDigest` also cross-checks the full
path.

## Files

- `src/ops/promotion-readiness.ts` — `buildPromotionReadinessChecklist(input)`.
- `src/ops/promotion-readiness-cli.ts` — CLI wrapper.
- `test/promotion-readiness.ts` — 10 tests driven by genuine artifacts from the real tools, plus every mismatch/blocked case.

## Usage

```
npm run ops:promotion-readiness -- \
  --approval approval.json \
  [--approval-evidence approval-evidence.json] \
  [--promotion-evidence promotion-evidence.json] \
  [--evidence-review review.json] \
  [--out checklist.json]
```

Exit `0` = READY, `1` = BLOCKED, `2` = usage / unreadable JSON.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no merge/tag/master change, and no Phase 231
or live-promotion authorization is implied by this checklist.
