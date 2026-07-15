# Phase 230: Promotion Acceptance Packet / Seal (local, non-live)

Report id: `phase-230-promotion-acceptance-packet`

Status: `PHASE_230_PROMOTION_ACCEPTANCE_SEAL_READY`

The final coordinator sign-off layer for a Phase 230 promotion. It takes a **READY** promotion
readiness checklist (and, optionally, the evidence review and approval evidence), re-verifies the
checklist is untampered and READY, requires an explicit human **ACCEPT** decision, and emits a
redaction-safe, tamper-evident **sealed acceptance packet**. A companion `verify` recomputes the seal.

It reads parsed JSON only. It performs no promotion, never touches `/mnt/user/media/Movies`, never
contacts Jellyfin, and authorizes nothing live: a sealed packet records a coordinator's paperwork
acceptance — it is not a live gate and does not authorize Phase 231.

## Where it sits

```
approval attestation → promotion evidence → evidence review → readiness checklist (READY)
                                                                      → acceptance seal (human ACCEPT) → sealed packet
```

## Seal rules

`sealPromotionAcceptance` refuses (status `ACCEPTANCE_REFUSED`, `accepted: false`) unless **all** hold,
each recorded as a generic refusal code:

| Refusal | Cause |
|---------|-------|
| `READINESS_INVALID` | the readiness input is not a `phase-230-promotion-readiness-checklist` v1 |
| `READINESS_DIGEST_MISMATCH` | the checklist's own `checklistDigest` does not recompute (tampered) |
| `READINESS_NOT_READY` | the (verified) checklist verdict is not `READY` |
| `ACCEPTOR_MISSING` | no `acceptorId` supplied |
| `ACCEPTANCE_REJECTED` | the decision is `REJECT` |
| `ACCEPTANCE_NOT_GIVEN` | the decision is not an affirmative `ACCEPT` |
| `EVIDENCE_REVIEW_INCONSISTENT` | a supplied review is not an accepted review tied (by `subjectEvidenceDigest`) to the checklist's promotion evidence |
| `RAW_PATH_IN_PACKET` | belt-and-suspenders: a raw filesystem path was found in the assembled packet |

When none apply, the packet is `ACCEPTED_SEALED` (`accepted: true`). Either way the packet is sealed
with `sealDigest = sha256("phase-230-acceptance-seal:" + body)`, so a refused packet is itself
tamper-evident.

The packet binds the constituent artifact digests it can prove — `checklistDigest`, `itemDigest`,
`destinationNameDigest`, `subjectEvidenceDigest` (promotion evidence), and, when supplied,
`evidenceReviewDigest` and `approvalEvidenceDigest` — plus an `acceptorDigest` (the acceptor id is
digested, never echoed). It carries only digests, enums, and booleans — no raw title, source path, or
destination path.

## Verify

`verifyAcceptanceSeal(packet)` recomputes `sealDigest` and checks `status`/`accepted`/`refusals`
consistency, so a packet whose bound digests were altered (or whose status was flipped even after a
re-seal) is rejected.

## Files

- `src/ops/promotion-acceptance-seal.ts` — `sealPromotionAcceptance` / `verifyAcceptanceSeal`.
- `src/ops/promotion-acceptance-seal-cli.ts` — `seal` and `verify` subcommands.
- `test/promotion-acceptance-seal.ts` — 11 tests over genuine artifacts, every refusal path, seal-tamper detection, and a spawned CLI seal→verify roundtrip.

## Usage

```
# Seal a READY checklist with a human decision
npm run ops:promotion-acceptance-seal -- seal \
  --readiness checklist.json --acceptor-id <id> --decision ACCEPT \
  [--evidence-review review.json] [--approval-evidence approval-evidence.json] [--out packet.json]

# Verify a sealed packet
npm run ops:promotion-acceptance-seal -- verify --packet packet.json
```

`seal` exits `0` = `ACCEPTED_SEALED`, `1` = `ACCEPTANCE_REFUSED`. `verify` exits `0` = valid, `1` =
invalid. Neither echoes the raw `--out` path to stdout (only `outputWritten: true`).

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no merge/tag/master change, and no Phase 231
or live-promotion authorization is implied by this seal.
