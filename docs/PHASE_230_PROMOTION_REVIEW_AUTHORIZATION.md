# Phase 230: Coordinator Review-Authorization Scaffold (local, non-live)

Report id: `phase-230-promotion-review-authorization`

Status: `PHASE_230_PROMOTION_REVIEW_AUTHORIZATION_READY`

A **fail-closed** local scaffold: it is `LOCAL_REVIEW_NOT_AUTHORIZED` by default and becomes
`LOCAL_REVIEW_AUTHORIZED` **only when valid offline evidence is supplied** — the terminal readiness v2 record
(present, valid id, `TERMINAL_READINESS_V2_CONFIRMED`, self-digest recomputes) **and** the coordinator review
matrix (present, valid id, `REVIEW_MATRIX_READY`, self-digest recomputes). It then **includes the exact
reviewed commit/test matrix placeholders** (all `PENDING`) for the human to complete.

**`authorized` here is strictly LOCAL** — it means only that the offline evidence is valid and the review
scaffold is ready for a human. **`LOCAL_REVIEW_AUTHORIZED` does NOT authorize Phase 231, live promotion, or
any merge/tag/master action** — those remain separate human steps not performed or authorized here. The
report's live `authorization` field is the constant `NONE`.

## What it checks

- **Valid offline evidence** — readiness present (`READINESS_MISSING`), right report id (`READINESS_INVALID`),
  self-digest recomputes (`COMPONENT_DIGEST_MISSING` / `COMPONENT_DIGEST_INVALID` / `COMPONENT_DIGEST_MISMATCH`),
  and `CONFIRMED` (`READINESS_NOT_CONFIRMED`).
- **Valid review matrix** — matrix present (`REVIEW_MATRIX_MISSING`), right report id (`REVIEW_MATRIX_INVALID`),
  self-digest recomputes (shared `COMPONENT_DIGEST_*`), and `READY` (`REVIEW_MATRIX_NOT_READY`).
- **Included placeholders** — the matrix rows are re-emitted through a sanitizer that keeps only a sha40 id,
  path-free test labels, and the fixed `PENDING` placeholder; a completed outcome or raw path can never be
  echoed regardless of the matrix contents.

Only genuinely-verified evidence digests are recorded in `boundDigests`. It reads parsed JSON only; it
performs no promotion, never touches the real Movies root, never contacts Jellyfin, and authorizes nothing
live. It restates the remaining human gates and the closed live boundary and is sealed with an
`authorizationDigest`.

## Files

- `src/ops/promotion-review-authorization.ts` — `buildReviewAuthorization(input)` + gates/boundary/disclaimers.
- `src/ops/promotion-review-authorization-cli.ts` — CLI wrapper.
- `test/promotion-review-authorization.ts` — 5 tests: authorized only with valid readiness + matrix (exact
  PENDING placeholders included); not-authorized by default (no evidence); not-authorized on unconfirmed
  evidence; the green-body tamper (digest recompute) case; and a spawned CLI run.

## Usage

```
npm run ops:promotion-review-authorization -- --readiness readiness.json --reviewmatrix matrix.json [--out report.json]
```

Exit `0` = `LOCAL_REVIEW_AUTHORIZED`, `1` = `LOCAL_REVIEW_NOT_AUTHORIZED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
