# Phase 230: Artifact Chain Bundle Packer (local, non-live)

Report id: `phase-230-promotion-artifact-chain-bundle`

Status: `PHASE_230_PROMOTION_CHAIN_BUNDLE_READY`

Packs the closing Phase 230 records — the **coordinator final summary**, the **release checklist**, the
**merge-readiness dry-run manifest**, the **negative-evidence adversarial corpus**, the **provenance diff**,
and the **gate coverage report** — into one redaction-safe coordinator-handoff manifest. It reads parsed
JSON only; it performs no promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and
authorizes nothing live (`authorization` is the constant `NONE`). It carries **no raw paths or titles**.

## Components & criteria

| Component | Green when |
|-----------|-----------|
| `final-summary` | `FINAL_SUMMARY_READY` |
| `release-checklist` | `RELEASE_CHECKLIST_CLEARED` |
| `merge-readiness` | `MERGE_DRY_RUN_READY` |
| `negative-evidence-corpus` | `CORPUS_HELD` |
| `provenance-diff` | `PROVENANCE_ALIGNED` |
| `gate-coverage` | `GATE_COVERAGE_COMPLETE` |

Every present component must also carry a valid sha256 in its digest field — else `COMPONENT_DIGEST_MISSING`
/ `COMPONENT_DIGEST_INVALID` (fail closed). The bundle binds the chain: the release checklist's
`boundDigests['final-summary']` must equal the packed final summary's `summaryDigest`, else
`FINAL_SUMMARY_BINDING_MISMATCH`.

`overall` is `CHAIN_BUNDLE_READY` iff every component is present, valid, green, digest-bound, and the
binding holds; otherwise `CHAIN_BUNDLE_BLOCKED` with generic blockers (`*_MISSING`, `*_INVALID`,
`FINAL_SUMMARY_NOT_READY`, `RELEASE_CHECKLIST_NOT_CLEARED`, `MERGE_READINESS_NOT_READY`,
`NEGATIVE_CORPUS_BREACHED`, `PROVENANCE_DIFF_MISALIGNED`, `GATE_COVERAGE_INCOMPLETE`,
`COMPONENT_DIGEST_MISSING/INVALID`, `FINAL_SUMMARY_BINDING_MISMATCH`). Each component carries
name/present/ok/digest; the whole is sealed with a `chainDigest`.

## Files

- `src/ops/promotion-chain-bundle.ts` — `buildChainBundle(input)`.
- `src/ops/promotion-chain-bundle-cli.ts` — CLI wrapper.
- `test/promotion-chain-bundle.ts` — 6 tests: all-ready, a missing/not-ready component, a digestless
  component, a binding mismatch, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-chain-bundle -- --finalsummary f --releasechecklist f --mergereadiness f --negativecorpus f --provenancediff f --gatecoverage f [--out bundle.json]
```

Exit `0` = `CHAIN_BUNDLE_READY`, `1` = `CHAIN_BUNDLE_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
