# Phase 230: Negative Live-Boundary Guard (local, non-live)

Report id: `phase-230-promotion-live-boundary-guard`

Status: `PHASE_230_PROMOTION_LIVE_BOUNDARY_GUARD_READY`

A static negative harness that guards the Phase 230 **local-only tooling** and its docs against live
hooks. It is a test, not a runtime tool; it reads the source and docs and fails if any local tool could
reach a live surface.

## What it asserts

For every local-only tooling source (approval, evidence-review, readiness, acceptance-seal, rehearsal,
rehearsal-matrix, artifact-integrity, handoff — modules and CLIs):

- contains **none** of the forbidden live hooks: `fetch(`, `Library/Refresh`, `X-Emby-Token`, the live
  Jellyfin env vars (`JELLYFIN_ENABLE_NETWORK`, `JELLYFIN_ALLOW_LIVE_PUBLISH`, `JELLYFIN_API_KEY`,
  `JELLYFIN_BASE_URL`, `JELLYFIN_TRIGGER_LIBRARY_SCAN`), the deploy launcher
  `unraid-real-library-promotion.sh`, `node:child_process`, and the live `real-library-promotion-cli`.
- any call to the promotion service (`runRealLibraryPromotion(`) is **sandboxed** — it must sit
  alongside `allowCustomTargetRootForTests` and `assertSandboxSafe`.
- the rehearsal is the **only** local tool that runs the promotion service at all.

For every local-tool doc: it references the `Phase 231` boundary and states its non-live boundary
(no Phase 231 / no live promotion / no live Jellyfin).

This complements the guarded real-library-promotion service (which legitimately holds the read-only
Jellyfin client and the target-root enforcement): the guard ensures the *derived* local tooling never
grows a live dependency.

## Files

- `test/promotion-live-boundary-guard.ts` — the guard suite (26 checks).

## Usage

```
npm run test:promotion-live-boundary-guard
```

## Boundary

The guard itself performs no promotion, no Jellyfin call, no real Movies write, no deploy-launcher run,
and asserts — rather than grants — the no-Phase-231 / no-live boundary.
