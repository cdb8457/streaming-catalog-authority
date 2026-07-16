# Phase 230: Coordinator Review Transcript / Checklist (local, non-live)

Report id: `phase-230-promotion-review-transcript`

Status: `PHASE_230_PROMOTION_REVIEW_TRANSCRIPT_READY`

Records a coordinator review: the reviewed commit, the local test commands and their results, any
blockers and their remediations, the remaining human gates, and explicit no-live / no-Phase-231
language. It is **deterministic** (a pure function of its inputs) and **redaction-safe**. It performs no
promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and **never authorizes Phase
231 or live promotion** (`authorization` is the constant `NONE`).

## Contents

- `verdict`: `REVIEW_CLEAN` iff the reviewed commit is a valid hex SHA, every supplied test result has
  `failed === 0`, and there are no blockers; otherwise `REVIEW_BLOCKED` with generic `problems`
  (`REVIEWED_COMMIT_INVALID`, `TEST_RESULT_MALFORMED`, `TEST_FAILED`, `RAW_PATH_IN_TRANSCRIPT`).
- `reviewedCommit`: the reviewed commit SHA (validated `[0-9a-f]{7,64}`; an invalid value is not echoed).
- `testResults`: `{ command, passed, failed }` per command (the coordinator's inputs).
- `blockers` / `remediations`: caller-provided; scanned so a raw path in either sets
  `RAW_PATH_IN_TRANSCRIPT` and blocks.
- `humanGates` / `disclaimers`: fixed language present in **every** transcript.
- `transcriptDigest`: `sha256("phase-230-review-transcript:" + body)`; recomputes deterministically.

## Files

- `src/ops/promotion-review-transcript.ts` — `buildReviewTranscript(input)` + the fixed constants.
- `src/ops/promotion-review-transcript-cli.ts` — CLI wrapper.
- `test/promotion-review-transcript.ts` — 7 tests: clean review, blocked on a failed test / a blocker /
  an invalid commit / a raw-path remediation, redaction-safe + deterministic digest, and a spawned CLI run.

## Usage

```
npm run ops:promotion-review-transcript -- --reviewed-commit <sha> [--input review.json] [--out transcript.json]
```

The input JSON may carry `{ testResults: [{command,passed,failed}], blockers: [], remediations: [] }`.
Exit `0` = `REVIEW_CLEAN`, `1` = `REVIEW_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization — stated explicitly in the transcript itself.
