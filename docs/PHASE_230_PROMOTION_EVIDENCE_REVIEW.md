# Phase 230: Promotion Evidence Review (local, non-live)

Report id: `phase-230-promotion-evidence-review`

Status: `PHASE_230_PROMOTION_EVIDENCE_REVIEW_READY`

A local, non-live reviewer for a `phase-230-real-library-promotion` evidence report — the document
`runRealLibraryPromotion` emits. It is the mechanical pre-acceptance gate an operator or reviewer runs
on a produced evidence file **before** accepting or sharing it, mirroring the repository's existing
`*-evidence-review` discipline.

It reads a parsed JSON object only. It never promotes, never touches `/mnt/user/media/Movies`, never
contacts Jellyfin, and grants no authorization (Phase 231 and live promotion remain separate gates it
cannot set).

## What it checks

| Check | Rejects when |
|-------|--------------|
| `reportTypeValid` | `report` is not `phase-230-real-library-promotion`, or `version` ≠ 1 |
| `redactionSafeFlagged` | `redactionSafe` ≠ true, or any of `titleEchoed` / `sourcePathEchoed` / `destinationPathEchoed` ≠ false |
| `digestsPresent` | `runDigest`, `itemDigest`, `evidenceDigest`, or `realLibrary.beforeDigest` is not a 64-hex SHA-256 |
| `forbiddenListComplete` | `forbidden` is not the exact canonical 11-entry boundary list |
| `lifecycleWellFormed` | `lifecycle.logsRetrievable` ≠ true, no transitions, or an unknown `currentState` |
| `stateStatusConsistent` | `status` / `ok` / terminal `currentState` disagree (VISIBLE⇒ok+`VISIBLE_IN_REAL_LIBRARY`, WITHDRAWN⇒ok+`PROMOTION_WITHDRAWN`, FAILED⇒!ok+`PROMOTION_FAILED`) |
| `evidenceDigestVerified` | the report's own `evidenceDigest` does not recompute as `sha256("phase-230-report:" + JSON.stringify(report-without-evidenceDigest))` |
| `noRawPathLeak` | any string value (other than the `targetRoot` enum and `file.extension`) looks like an absolute/drive path, contains `/mnt/` or a test-library fragment, or ends in a media extension |

The review record it emits is itself redaction-safe: only enums, booleans, digests, and the subject's
(enum) status / (digest) `evidenceDigest`.

### Limits

`evidenceDigestVerified` assumes the evidence is the verbatim service output (as its CLI writes it); a
re-serialized or key-reordered copy will not verify — intended strictness. The raw-path scan catches
leaked *paths*; a leaked raw *title* that is not path-shaped cannot be detected without the title, so
`titleEchoed: false` remains an attestation the producer is responsible for (and the promotion service
already guarantees).

## Files

- `src/ops/promotion-evidence-review.ts` — `reviewPromotionEvidence(candidate)`.
- `src/ops/promotion-evidence-review-cli.ts` — CLI wrapper.
- `test/promotion-evidence-review.ts` — 10 tests, driven by genuine reports produced via `runRealLibraryPromotion` in a temp sandbox with a mock read-only observer (no Jellyfin, no real Movies), plus per-check tamper cases.

## Usage

```
npm run ops:promotion-evidence-review -- --evidence promotion-evidence.json --out review.json
```

Exit `0` = accepted, `1` = rejected, `2` = usage / unreadable JSON. Problems are generic, value-free
codes (e.g. `EVIDENCE_DIGEST_MISMATCH`, `RAW_PATH_LEAK_SUSPECTED`) safe to record.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no merge/tag/master change, and no Phase 231
or live-promotion authorization is implied by this reviewer.
