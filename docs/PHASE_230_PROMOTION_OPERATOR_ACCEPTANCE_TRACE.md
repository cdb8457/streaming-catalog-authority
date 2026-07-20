# Phase 230: Operator Acceptance Trace (local, non-live)

Report id: `phase-230-promotion-operator-acceptance-trace`

Status: `PHASE_230_PROMOTION_OPERATOR_ACCEPTANCE_TRACE_READY`

A single redaction-safe trace that aggregates the four launch-proofing guard artifacts for a human
coordinator: the approval-request packet, the live-execution preflight plan, the no-live authorization guard,
and the coordinator review checklist v2.

## What it does

For each component it re-verifies the report id, recomputes the self-digest, and confirms the green status
(`APPROVAL_REQUEST_READY` / `PREFLIGHT_PLAN_VALID` / `NO_LIVE_AUTHORIZATION_CLEAN` / `CHECKLIST_READY`). It then:

- confirms every live-preflight item is still `PENDING` (never pre-approved) — else `LIVE_PREFLIGHT_ITEM_NOT_PENDING`;
- re-runs the no-live authorization guard over **every** component as defence in depth — any smuggled live
  authorization claim fails closed with `LIVE_AUTHORIZATION_CLAIMED`;
- records the aggregate self-digest verification result.

It emits only report ids, component digests, counts, fixed statuses/labels, blockers, and a readiness
**decision**. It never echoes raw real paths, item/source/destination paths, or sensitive evidence strings.

`ACCEPTANCE_TRACE_READY` (decision `AWAITING_HUMAN_ITEM_APPROVAL`) means the machine-side evidence is assembled
for human review. `status` is `PENDING` and `authorization` is `NONE`. It is **not** an approval and does not
authorize Phase 231 or any live promotion.

## Fail-closed blockers

`APPROVAL_REQUEST_MISSING/INVALID/NOT_READY`, `LIVE_PREFLIGHT_MISSING/INVALID/NOT_VALID`,
`LIVE_PREFLIGHT_ITEM_NOT_PENDING`, `NO_LIVE_GUARD_MISSING/INVALID/VIOLATED`,
`CHECKLIST_MISSING/INVALID/NOT_READY`, `COMPONENT_DIGEST_UNVERIFIED`, `LIVE_AUTHORIZATION_CLAIMED`.

## Files

- `src/ops/promotion-operator-acceptance-trace.ts` — `buildOperatorAcceptanceTrace(input)`.
- `src/ops/promotion-operator-acceptance-trace-cli.ts` — CLI wrapper.
- `test/promotion-operator-acceptance-trace.ts` — READY aggregation; blocked on forged/claiming components; CLI run.

## Usage

```
npm run ops:promotion-operator-acceptance-trace -- --approvalrequest ar.json --livepreflight lp.json --noliveguard ng.json --checklistv2 cv.json [--out trace.json]
```

Exit `0` = `ACCEPTANCE_TRACE_READY`, `1` = `ACCEPTANCE_TRACE_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and no
Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize Phase 231.
