# Phase 230: Acceptance Meta-Check (local, non-live)

Report id: `phase-230-promotion-acceptance-meta`

Status: `PHASE_230_PROMOTION_ACCEPTANCE_META_READY`

For every Phase 230 local op it confirms the presence of a module, a CLI, a test, a doc, `ops:` +
`test:` package scripts, `test:phase230-local` gate inclusion, and non-live boundary language in the
doc — emitting a machine-readable meta-check report. `LOCAL_OPS_REGISTRY` is the single source of truth
for the local op set and is also consumed by the closure guard. It reads files + package.json only; it
performs no promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes
nothing live.

## Contents

- `ops`: per op `{ base, hasModule, hasCli, hasTest, hasDoc, hasScripts, inGate, hasBoundary, ok }`.
- `ok`: true only when every op is complete on every facet; `incomplete` lists any op missing a facet.
- `metaDigest`: `sha256("phase-230-acceptance-meta:" + body)`.

The report carries only op names, booleans, and digests — no raw paths or titles.

## Files

- `src/ops/promotion-acceptance-meta.ts` — `LOCAL_OPS_REGISTRY`, `buildAcceptanceMetaCheck(projectRoot)`.
- `src/ops/promotion-acceptance-meta-cli.ts` — CLI wrapper.
- `test/promotion-acceptance-meta.ts` — 4 tests: every op complete, gaps against a bare root,
  redaction-safety, and a spawned CLI run.

## Usage

```
npm run ops:promotion-acceptance-meta -- [--out meta.json]
```

Exit `0` = every op complete, `1` = a gap.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
