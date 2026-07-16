# Phase 230: Determinism Stress Suite (local, non-live)

Report id: `phase-230-promotion-determinism-stress`

Status: `PHASE_230_PROMOTION_DETERMINISM_READY`

Confirms the Phase 230 builders are deterministic: given repeated digests of the same builder — produced
from identical inputs, or from inputs that must not affect the result (e.g. reordered object keys) — every
sample of a subject must be identical. It is a pure aggregation of digests; it performs no promotion, never
touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live (`authorization` is
the constant `NONE`).

## What it checks

Each subject carries its repeated `digests`. A subject is `deterministic` only when it has at least two
samples that are all identical (`distinct === 1`). `overall` is `NON_DETERMINISTIC` if any subject varies,
else `INSUFFICIENT_SAMPLES` if any subject has fewer than two samples, else `NO_SUBJECTS` for empty input,
else `DETERMINISTIC`. Output carries only fixed subject labels, sample/distinct counts, and booleans (no
raw digests, paths, or titles) plus a `determinismDigest`.

The suite exercises real builders (gate DAG, archive manifest, review bundle) repeated three times, and
proves input-order independence for the consistency matrix by rebuilding it with reordered input keys.

## Files

- `src/ops/promotion-determinism.ts` — `assessDeterminism(subjects)`.
- `src/ops/promotion-determinism-cli.ts` — CLI wrapper (`--in subjects.json`).
- `test/promotion-determinism.ts` — 5 tests: a real repeated/reordered stress pass, a varying subject,
  an under-sampled subject, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-determinism -- --in subjects.json [--out report.json]
```

Exit `0` = `DETERMINISTIC`, `1` = otherwise.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
