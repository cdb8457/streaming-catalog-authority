# Phase 230: Gate Dependency DAG (local, non-live)

Report id: `phase-230-promotion-gate-dag`

Status: `PHASE_230_PROMOTION_GATE_DAG_READY`

Declares the Phase 230 verification pipeline as a dependency DAG — each gate with its dependencies, its
test, and its representative blockers — and verifies the graph is **acyclic** and every dependency
resolves, emitting a topological order. It is a pure declaration + check; it performs no promotion,
never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live.

## Nodes

approval → promotion → rehearsal → evidence-review → readiness → acceptance-seal → rehearsal-matrix →
artifact-integrity / artifact-schema → handoff → dashboard → fixture-bundle → { bundle-replay,
bundle-diff, tamper-corpus, provenance-ledger } → evidence-packet; review-transcript is independent.
Each node carries `{ id, test, dependsOn, blockers }`.

`verifyGateDag` runs Kahn's algorithm: `acyclic` is true only when the topological order covers every
node; `problems` reports `CYCLE_DETECTED` or `UNKNOWN_DEPENDENCY:<id>`. The report is redaction-safe
(ids, test paths, blocker codes, digests) and carries a `dagDigest`.

## Files

- `src/ops/promotion-gate-dag.ts` — `buildGateDag()`, `verifyGateDag(nodes?)`.
- `src/ops/promotion-gate-dag-cli.ts` — CLI wrapper.
- `test/promotion-gate-dag.ts` — 5 tests: acyclic + full topo order, deps precede + real test files,
  a manually-introduced cycle, an unknown dependency, and a spawned CLI run.

## Usage

```
npm run ops:promotion-gate-dag -- [--out dag.json]
```

Exit `0` = acyclic and valid, `1` = a cycle or an unknown dependency.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
