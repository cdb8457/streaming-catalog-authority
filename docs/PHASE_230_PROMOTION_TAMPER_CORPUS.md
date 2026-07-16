# Phase 230: Offline Tamper Corpus (local, non-live)

Report id: `phase-230-promotion-tamper-corpus`

Status: `PHASE_230_PROMOTION_TAMPER_CORPUS_READY`

From one clean fixture evidence bundle, derives a corpus of deliberately-tampered inputs — each paired
with the generic failure code the appropriate offline verifier (replay / schema / dashboard) must
report — then runs each and confirms the expected failure occurs. It reads parsed JSON only; it performs
no promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing
live.

## Corpus

| Kind | Verifier | Expected failure |
|------|----------|------------------|
| `missing-artifact` | replay | `ACCEPTANCE_PACKET_MISSING` |
| `wrong-report` | replay | `INTEGRITY_REPORT_WRONG` |
| `bundle-self-digest` | replay | `BUNDLE_SELF_DIGEST_MISMATCH` |
| `matrix-self-digest` | replay | `MATRIX_SELF_DIGEST_MISMATCH` |
| `manifest-stage` | replay | `MANIFEST_STAGE_MISMATCH` |
| `schema-failed-state` | schema | `ACCEPTANCE_PACKET_STATUS_INVALID` (a re-self-digested REFUSED acceptance) |
| `dashboard-blocked` | dashboard | `INTEGRITY_NOT_OK` |

`verifyTamperCorpus` is `ok` only when **every** entry produces its expected failure; the report carries
per-entry `{ kind, verifier, expectedCode, matched }` (no raw inputs) and a `corpusDigest`.

## Files

- `src/ops/promotion-tamper-corpus.ts` — `generateTamperCorpus`, `runTamperEntry`, `verifyTamperCorpus`.
- `src/ops/promotion-tamper-corpus-cli.ts` — CLI wrapper.
- `test/promotion-tamper-corpus.ts` — 4 tests: full corpus detected, per-entry match, redaction-safety,
  and a spawned CLI run.

## Usage

```
npm run ops:promotion-tamper-corpus -- --bundle bundle.json [--out corpus.json]
```

Exit `0` = every tamper detected as expected, `1` = a tamper slipped through.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
