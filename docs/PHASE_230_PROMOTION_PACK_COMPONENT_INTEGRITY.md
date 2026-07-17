# Phase 230: Pack Component-Integrity Verifier (local, non-live)

Report id: `phase-230-promotion-pack-component-integrity`

Status: `PHASE_230_PROMOTION_PACK_COMPONENT_INTEGRITY_READY`

## Why this exists

The merge-review evidence pack (AW, `promotion-reviewer-pack`) carries only the **redacted** sha256
self-digest of each of its seven packed records, and sets a per-component `ok` flag from a presence + format
+ status + pair-binding check. The acceptance preflight (AX, `promotion-acceptance-preflight`) recomputes the
**pack's own** self-digest and trusts those component `ok` flags and the pack's binding mesh. So nowhere in
the `AW → AX → readiness → terminal-closure` acceptance chain is the self-digest of an *individual packed
report* ever recomputed against its body. A component with a green status and a well-formed-but-wrong
self-digest — or a pack that states a forged digest for a component — is not caught by that chain on its own.

This verifier is the missing recompute-and-bind layer.

## What it checks

Given the pack **and** the seven authoritative source reports (final-summary, release-checklist,
merge-readiness, chain-bundle, review-automation, redaction-corpus, boundary-policy), it reports
`PACK_INTEGRITY_VERIFIED` only when **all** hold, else `PACK_INTEGRITY_BROKEN`:

- **Pack** present, valid id, self-digest recomputes, and `REVIEWER_PACK_READY`
  (`PACK_MISSING` / `PACK_INVALID` / `PACK_DIGEST_MISMATCH` / `PACK_NOT_READY`). The pack's redacted
  component digests are trusted only when the pack's own digest recomputes.
- **Each component** present with the expected report id (`COMPONENT_REPORT_MISSING` /
  `COMPONENT_REPORT_INVALID`).
- **Each component's self-digest recomputes** against its body — delegated to the authoritative self-digest
  verifier, so a green status paired with a tampered body fails (`COMPONENT_DIGEST_MISMATCH`).
- **Each component is green** in its expected state (`COMPONENT_NOT_GREEN`).
- **The pack's redacted digest binds** to the recomputed authoritative digest: the pack must carry a digest
  for the component (`PACK_DIGEST_UNBOUND`) and it must equal the authoritative recomputed value
  (`PACK_COMPONENT_DIGEST_MISMATCH`).

Only fully-verified components (recompute + green + bound) are recorded in `boundDigests`. The report reads
parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts Jellyfin, and
authorizes nothing live (`authorization` is the constant `NONE`). It echoes only component-name enums,
booleans, counts, hex digests, and fixed-language strings — no raw paths or titles — and is sealed with an
`integrityDigest`.

**`PACK_INTEGRITY_VERIFIED` means the packed component digests are bound to authoritative, recomputed
records — it is NOT an approval, a merge, or a Phase 231 / live-promotion authorization.** This verifier does
not authorize Phase 231 and never contacts Jellyfin.

## Files

- `src/ops/promotion-pack-component-integrity.ts` — `buildPackComponentIntegrity(input)`,
  `PACK_INTEGRITY_DISCLAIMERS`, `COVERS_EXPECTED_PACK_COMPONENTS`.
- `src/ops/promotion-pack-component-integrity-cli.ts` — CLI wrapper.
- `test/promotion-pack-component-integrity.ts` — 8 tests: verified over the full authoritative chain;
  missing/forged/not-ready pack; missing/wrong-id component; the green-body tamper case; a pack that states a
  forged digest for a genuine component; empty input; and a spawned CLI run.

## Usage

```
npm run ops:promotion-pack-component-integrity -- --reviewerpack rp.json --finalsummary fs.json --releasechecklist rc.json --mergereadiness mr.json --chainbundle cb.json --reviewautomation ra.json --redactioncorpus rd.json --boundarypolicy bp.json [--out integrity.json]
```

Exit `0` = `PACK_INTEGRITY_VERIFIED`, `1` = `PACK_INTEGRITY_BROKEN`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
