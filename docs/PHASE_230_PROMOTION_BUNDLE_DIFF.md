# Phase 230: Bundle Diff / Audit (local, non-live)

Report id: `phase-230-promotion-bundle-diff`

Status: `PHASE_230_PROMOTION_BUNDLE_DIFF_READY`

Compares two fixture evidence bundles by their per-artifact and per-report **digests only**, producing a
redaction-safe diff. It reads parsed JSON only; it performs no promotion, never touches
`/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live.

## What it compares

Twelve components, each by its own self-digest: `bundle`, `manifest`, `approvalEvidence`,
`promotionEvidence`, `evidenceReview`, `readiness`, `acceptancePacket`, `integrity`, `schema`, `matrix`,
`handoff`, `dashboard`. Each entry reports `{ component, aDigest?, bDigest?, equal }`. `identical` is true
only when both inputs are valid bundles and every component is equal; `differingComponents` lists the
rest. The report carries only component names, booleans, and SHA-256 digests — no raw paths or titles —
and a `diffDigest`.

Because bundles are deterministic, two runs with identical fixed inputs diff as `identical`; a single
tampered component is pinpointed while the rest stay equal.

## Files

- `src/ops/promotion-bundle-diff.ts` — `diffFixtureBundles(a, b)`.
- `src/ops/promotion-bundle-diff-cli.ts` — CLI wrapper.
- `test/promotion-bundle-diff.ts` — 5 tests: identical inputs, different inputs, single-component
  pinpoint, invalid-bundle handling, and a spawned CLI run.

## Usage

```
npm run ops:promotion-bundle-diff -- --a bundleA.json --b bundleB.json [--out diff.json]
```

Exit `0` = identical, `1` = differences (or an invalid bundle).

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
