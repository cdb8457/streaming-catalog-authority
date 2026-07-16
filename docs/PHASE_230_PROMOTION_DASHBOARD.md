# Phase 230: Offline Acceptance Dashboard (local, non-live)

Report id: `phase-230-promotion-acceptance-dashboard`

Status: `PHASE_230_PROMOTION_DASHBOARD_READY`

Consumes the four top-level offline artifacts — the **rehearsal-matrix** manifest, the
**artifact-integrity** report, the **artifact-schema** report, and the **coordinator handoff** packet —
and renders one redaction-safe dashboard that is `DASHBOARD_READY` **only when all four are green**. It
reads parsed JSON only; it performs no promotion, never touches `/mnt/user/media/Movies`, never contacts
Jellyfin, and authorizes nothing live (no Phase 231).

## Green criteria

| Panel | Green when |
|-------|-----------|
| `matrix` | report is `phase-230-promotion-rehearsal-matrix` and `outcome === MATRIX_PASS` |
| `integrity` | report is `phase-230-promotion-artifact-integrity` and `ok === true` |
| `schema` | report is `phase-230-promotion-artifact-schema` and `ok === true` (strict successful-state validation) |
| `handoff` | report is `phase-230-promotion-coordinator-handoff`, `handoffState === READY_FOR_COORDINATOR`, and `authorization === NONE` |

`overall` is `DASHBOARD_READY` iff every panel is present and green; otherwise `DASHBOARD_BLOCKED` with
generic blockers (`*_MISSING`, `*_INVALID`, `MATRIX_NOT_PASS`, `INTEGRITY_NOT_OK`, `HANDOFF_NOT_READY`).
Each panel carries only its source, presence, ok, status enum, and digest — no raw paths or titles. The
dashboard's own `authorization` is the constant `NONE`, and it is sealed with a `dashboardDigest`.

## Files

- `src/ops/promotion-dashboard.ts` — `buildAcceptanceDashboard(input)`.
- `src/ops/promotion-dashboard-cli.ts` — CLI wrapper.
- `test/promotion-dashboard.ts` — 9 tests: all-green READY (four panels), each panel
  missing/not-green/invalid (incl. the schema gate), redaction-safety, and a spawned CLI run.

## Usage

```
npm run ops:promotion-dashboard -- [--matrix f] [--integrity f] [--schema f] [--handoff f] [--out dashboard.json]
```

Exit `0` = `DASHBOARD_READY`, `1` = `DASHBOARD_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
