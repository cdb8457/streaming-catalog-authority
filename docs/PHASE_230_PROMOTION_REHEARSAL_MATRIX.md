# Phase 230: Rehearsal Scenario Matrix (local, non-live)

Report id: `phase-230-promotion-rehearsal-matrix`

Status: `PHASE_230_PROMOTION_REHEARSAL_MATRIX_READY`

Runs the whole offline rehearsal **scenario matrix** — every fixture scenario in one pass — and checks
each produces its **expected** outcome (`success` → `REHEARSAL_PASS`, every injected fault →
`REHEARSAL_FAIL`). It is a self-test of the rehearsal harness across all modes, and emits a
redaction-safe matrix manifest.

It never runs the deploy launcher, never touches the real Movies root, never contacts Jellyfin, and
authorizes nothing live (no Phase 231, no live promotion).

## Manifest

`runRehearsalMatrix` returns:

- `outcome`: `MATRIX_PASS` iff every scenario matched its expected outcome, else `MATRIX_FAIL`.
- `entries[]`: `{ scenario, expected, outcome, matches, manifestDigest }` per scenario (each an enum /
  digest — no raw paths).
- `matrixDigest`: `sha256("phase-230-rehearsal-matrix:" + body)`.

Given identical fixed inputs, the matrix is fully deterministic (each scenario runs with a derived
`runId` and a fixed fixture identity), so `matrixDigest` recomputes exactly and two runs are identical.

## Files

- `src/ops/promotion-rehearsal-matrix.ts` — `runRehearsalMatrix(input)`, `expectedOutcome(scenario)`.
- `src/ops/promotion-rehearsal-matrix-cli.ts` — CLI wrapper.
- `test/promotion-rehearsal-matrix.ts` — 5 tests: full MATRIX_PASS, redaction-safety, matrix-digest
  recomputation, cross-run determinism, and a spawned CLI run.

## Usage

```
npm run ops:promotion-rehearsal-matrix -- [--work-dir <dir>] [--run-id <id>] [--acceptor-id <id>] [--keep-sandbox] [--out matrix.json]
```

Exit `0` = `MATRIX_PASS`, `1` = `MATRIX_FAIL`. The CLI reports `matrixWritten` and never echoes the raw
`--out` path.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
