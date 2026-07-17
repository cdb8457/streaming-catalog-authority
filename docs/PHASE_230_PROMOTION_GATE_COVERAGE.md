# Phase 230: Gate Coverage Completeness (local, non-live)

Report id: `phase-230-promotion-gate-coverage`

Status: `PHASE_230_PROMOTION_GATE_COVERAGE_READY`

Proves the Phase 230 toolchain is fully covered: every registered op, gate, blocker, and doc has test
wiring, and any new AP-AV blockers are in the taxonomy / gate mapping. It reads files + the shared
registries only; it performs no promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin,
and authorizes nothing live (`authorization` is the constant `NONE`). It fails closed on any coverage gap.

## Dimensions

- `ops-fully-wired` — every `LOCAL_OPS_REGISTRY` op has a module, CLI, test, doc, `ops:`/`test:` scripts,
  and is in `test:phase230-local` (else `MISSING_WIRING`).
- `gates-in-local-suite` — every gate-DAG node points at a real test that the local suite runs (else
  `GATE_NOT_IN_LOCAL_SUITE`).
- `blockers-catalogued` — every gate-DAG node blocker code is in `BLOCKER_CODES` (else
  `UNCATALOGUED_BLOCKER`).
- `taxonomy-ops-are-gates` — every taxonomy op maps to a real gate-DAG node id (else `UNKNOWN_TAXONOMY_OP`).

`overall` is `GATE_COVERAGE_COMPLETE` when no gap fires, else `GATE_COVERAGE_INCOMPLETE`. Output carries only
dimension names, booleans, counts, and generic gap codes (no raw digests/paths/titles) plus a
`coverageDigest`.

## Files

- `src/ops/promotion-gate-coverage.ts` — `buildGateCoverage(projectRoot)`.
- `src/ops/promotion-gate-coverage-cli.ts` — CLI wrapper.
- `test/promotion-gate-coverage.ts` — 3 tests: the live toolchain is complete, an empty root is incomplete,
  and a spawned CLI run.

## Usage

```
npm run ops:promotion-gate-coverage -- [--out coverage.json]
```

Exit `0` = `GATE_COVERAGE_COMPLETE`, `1` = `GATE_COVERAGE_INCOMPLETE`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
