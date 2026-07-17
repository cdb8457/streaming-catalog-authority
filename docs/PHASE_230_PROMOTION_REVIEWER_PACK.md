# Phase 230: Merge-Review Evidence Pack (local, non-live)

Report id: `phase-230-promotion-merge-review-evidence-pack`

Status: `PHASE_230_PROMOTION_REVIEWER_PACK_READY`

Assembles the seven closing records — the **coordinator final summary**, the **release checklist**, the
**merge-readiness dry-run manifest**, the **artifact chain bundle**, the **review automation checklist**,
the **redaction regression corpus**, and the **static boundary policy** — into ONE offline reviewer pack.
It reads parsed JSON only; it performs no promotion, never touches `/mnt/user/media/Movies`, never contacts
Jellyfin, and authorizes nothing live (`authorization` is the constant `NONE`). It carries **no raw paths
or titles**.

## Components & criteria

Every component must be present, valid, green (`FINAL_SUMMARY_READY`, `RELEASE_CHECKLIST_CLEARED`,
`MERGE_DRY_RUN_READY`, `CHAIN_BUNDLE_READY`, `REVIEW_AUTOMATION_PASSED`, `REDACTION_CORPUS_HELD`,
`BOUNDARY_POLICY_ENFORCED`) **and carry a valid sha256 self-digest** (else `COMPONENT_DIGEST_MISSING` /
`COMPONENT_DIGEST_INVALID`).

## Binding mesh (fail closed)

The pack cross-binds the whole chain to one run — `release-checklist=final-summary`,
`chain-bundle={final-summary, release-checklist, merge-readiness}`, and
`review-automation={chain-bundle, redaction-corpus, boundary-policy}` — each by exact digest equality. Any
divergence blocks with `PACK_BINDING_MISMATCH`, so a pack stitched from different runs (each individually
green) is caught.

`overall` is `REVIEWER_PACK_READY` iff every component is green, digest-bound, and every binding holds;
otherwise `REVIEWER_PACK_BLOCKED` with generic blockers (`*_MISSING`, `*_INVALID`, the not-green codes,
`COMPONENT_DIGEST_MISSING/INVALID`, `PACK_BINDING_MISMATCH`). Sealed with a `packDigest`; the fixed
non-live / no-merge disclaimers are always present.

## Files

- `src/ops/promotion-reviewer-pack.ts` — `buildReviewerPack(input)`, `REVIEWER_PACK_DISCLAIMERS`.
- `src/ops/promotion-reviewer-pack-cli.ts` — CLI wrapper.
- `test/promotion-reviewer-pack.ts` — 5 tests: all-ready with the full mesh, a missing component + a
  stripped digest, a stitched final summary (binding mismatch), empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-reviewer-pack -- --finalsummary f --releasechecklist f --mergereadiness f --chainbundle f --reviewautomation f --redactioncorpus f --boundarypolicy f [--out pack.json]
```

Exit `0` = `REVIEWER_PACK_READY`, `1` = `REVIEWER_PACK_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
