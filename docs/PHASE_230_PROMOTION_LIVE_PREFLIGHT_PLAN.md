# Phase 230: Live Execution Preflight Plan Validator (local, non-live)

Report id: `phase-230-promotion-live-preflight-plan`

Status: `PHASE_230_PROMOTION_LIVE_PREFLIGHT_PLAN_READY`

Validates a **proposed future live run plan as DATA ONLY**. It never executes, schedules, approves, or
authorizes anything: `authorization` is the constant `NONE` and `status` is the constant `PENDING`.
`PREFLIGHT_PLAN_VALID` means only that the plan is well-formed and safe to hand to a human.

## What it requires (fail closed)

- **Per-item PENDING approval** — every item carries an `approvalId` + an `approvalStatus` that is still
  `PENDING` (`ITEM_APPROVAL_FIELD_MISSING` / `ITEM_NOT_PENDING`) — a plan may not pre-approve.
- **Exact source/destination digest bindings** — each item binds a sha256 `sourceDigest` **and**
  `destinationDigest` (`SOURCE_DIGEST_MISSING` / `DESTINATION_DIGEST_MISSING`).
- **No-clobber + same-checksum policy** — `noClobber: true` and `sameChecksum: true`
  (`NO_CLOBBER_POLICY_MISSING` / `SAME_CHECKSUM_POLICY_MISSING`).
- **Observed-state requirement** — `observedStateRequired: true` (`OBSERVED_STATE_NOT_REQUIRED`).
- **Rollback + withdrawal constraints** — non-empty `rollback` and `withdrawal` objects
  (`ROLLBACK_CONSTRAINT_MISSING` / `WITHDRAWAL_CONSTRAINT_MISSING`).
- **No live surface** — any string anywhere in the plan that names a raw path, `/mnt/`, a Jellyfin/Emby/library
  surface, an http(s)/ws(s) URL, or a media extension fails closed (`LIVE_SURFACE_IN_PLAN`).
- **A non-empty plan** with items (`PLAN_MISSING` / `NO_ITEMS`).

It reads parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts
Jellyfin/network, and echoes only item counts, per-item booleans, and fixed codes — never a raw path. **VALID
is not an approval and does not authorize Phase 231 or any run.**

## Files

- `src/ops/promotion-live-preflight-plan.ts` — `buildLivePreflightPlan(input)`.
- `src/ops/promotion-live-preflight-plan-cli.ts` — CLI wrapper.
- `test/promotion-live-preflight-plan.ts` — 6 tests: valid pending plan; pre-approved/missing-digest item;
  missing policy; live-surface fail-closed; missing plan / no items; and a spawned CLI run.

## Usage

```
npm run ops:promotion-live-preflight-plan -- --plan plan.json [--out report.json]
```

Exit `0` = `PREFLIGHT_PLAN_VALID`, `1` = `PREFLIGHT_PLAN_INVALID`.

## Boundary

No live promotion, no Jellyfin call, no network call, no real Movies write, no deploy-launcher run, no
merge/tag/master, and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does
not authorize Phase 231.
