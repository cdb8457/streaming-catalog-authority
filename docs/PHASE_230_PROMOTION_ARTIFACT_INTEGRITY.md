# Phase 230: Offline Artifact Integrity Verifier (local, non-live)

Report id: `phase-230-promotion-artifact-integrity`

Status: `PHASE_230_PROMOTION_ARTIFACT_INTEGRITY_READY`

Verifies a Phase 230 artifact bundle offline: that every supplied artifact's own self-digest recomputes
(tamper detection), that the cross-artifact digest chain is consistent, and that no artifact is missing.
It reads parsed JSON only; it performs no promotion, never touches `/mnt/user/media/Movies`, never
contacts Jellyfin, and authorizes nothing live.

## What it checks

Self-digests (each strip-and-recompute against its own scope):

| Artifact | Digest field | Scope |
|----------|--------------|-------|
| `approvalEvidence` | `evidenceDigest` | `phase-230-approval-evidence` |
| `promotionEvidence` | `evidenceDigest` | `phase-230-report` |
| `evidenceReview` | `reviewDigest` | `phase-230-evidence-review` |
| `readiness` | `checklistDigest` | `phase-230-readiness-checklist` |
| `acceptancePacket` | `sealDigest` | `phase-230-acceptance-seal` |

Cross-artifact chain (checked where both ends are present): review → promotion, readiness → promotion,
and the acceptance packet's bound digests → readiness / promotion / review / approval-evidence.

Every supplied artifact is recorded in `checkedArtifacts`; any absent one yields a `*_MISSING` problem.
`ok` is true only when there are no self-digest mismatches, no chain mismatches, and nothing missing.
Problems are generic codes (e.g. `PROMOTION_EVIDENCE_SELF_DIGEST_MISMATCH`, `REVIEW_TO_PROMOTION_MISMATCH`,
`ACCEPTANCE_PACKET_MISSING`) — no raw paths or titles. The report carries an `integrityDigest`.

## Files

- `src/ops/promotion-artifact-integrity.ts` — `verifyArtifactIntegrity(bundle)`.
- `src/ops/promotion-artifact-integrity-cli.ts` — CLI wrapper.
- `test/promotion-artifact-integrity.ts` — 6 tests: clean bundle, tampered self-digest, broken chain,
  missing artifact, packet bound to the wrong checklist, and empty input.

## Usage

```
npm run ops:promotion-artifact-integrity -- \
  [--approval-evidence f] [--promotion-evidence f] [--evidence-review f] [--readiness f] [--acceptance-packet f] [--out report.json]
```

Exit `0` = ok, `1` = integrity problem(s).

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
