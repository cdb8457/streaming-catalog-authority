# Phase 230: Evidence Provenance Diff / Branch-to-Artifact Alignment (local, non-live)

Report id: `phase-230-promotion-provenance-diff`

Status: `PHASE_230_PROMOTION_PROVENANCE_DIFF_READY`

Compares a dry-run context (branch / base / head / commits) against the generated evidence artifacts — the
review transcript and, optionally, the coordinator final summary and review bundle — and confirms they
describe the same branch state. It reads parsed JSON only; it **invokes no git**, performs no promotion,
never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live
(`authorization` is the constant `NONE`).

## Alignment checks (fail closed)

- `branch` / `base` / `head` must be present and well-formed (`BRANCH_MISSING`, `BASE_MISSING`,
  `HEAD_MISSING`; base/head are 40-hex, the branch is re-validated path-free).
- Every commit `sha` must be 40-hex and every `subject` path/title-free (`COMMIT_SHA_MALFORMED`,
  `RAW_PATH_LEAK`).
- The transcript's `reviewedCommit` must equal the context `head` (`HEAD_REVIEWED_COMMIT_MISMATCH`) and lie
  within the commit range (`REVIEWED_COMMIT_NOT_IN_RANGE`).
- A supplied final summary must share that reviewed commit; a supplied review bundle must bind the
  transcript (`STALE_ARTIFACT`).

`overall` is `PROVENANCE_ALIGNED` iff no blocker fires, else `PROVENANCE_MISALIGNED`. The report echoes only
hex shas and counts — **never the branch name or commit subjects** — plus a `diffDigest`.

## Files

- `src/ops/promotion-provenance-diff.ts` — `buildProvenanceDiff(input)`.
- `src/ops/promotion-provenance-diff-cli.ts` — CLI wrapper (`--context`, `--transcript`, `--finalsummary`,
  `--reviewbundle`).
- `test/promotion-provenance-diff.ts` — 6 tests: aligned, a head/reviewed-commit mismatch, missing refs +
  malformed shas, a stale artifact + path/title leak, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-provenance-diff -- --context f --transcript f [--finalsummary f] [--reviewbundle f] [--out diff.json]
```

Exit `0` = `PROVENANCE_ALIGNED`, `1` = `PROVENANCE_MISALIGNED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
