# Phase 230: Coordinator Review-Authorization Scaffold (local, non-live)

Report id: `phase-230-promotion-review-authorization`

Status: `PHASE_230_PROMOTION_REVIEW_AUTHORIZATION_READY`

A **fail-closed** local scaffold: it is `LOCAL_REVIEW_NOT_AUTHORIZED` by default and becomes
`LOCAL_REVIEW_AUTHORIZED` **only when valid offline evidence is supplied AND the review matrix binds to the
authoritative context behind readiness**. The authoritative context is derived from evidence that is
cryptographically **chained** to the readiness record — not from any self-echoed field — so a stale or
forged/resealed matrix cannot ride through.

**`authorized` here is strictly LOCAL** — it means only that the offline evidence is valid, chained, and the
matrix binds to the authoritative context. **`LOCAL_REVIEW_AUTHORIZED` does NOT authorize Phase 231, live
promotion, or any merge/tag/master action** — those remain separate human steps not performed or authorized
here. The report's live `authorization` field is the constant `NONE`.

## What it checks

Every consumed report's self-digest is recomputed (`COMPONENT_DIGEST_MISSING/INVALID/MISMATCH`).

- **Readiness** present/valid/`CONFIRMED` (`READINESS_MISSING/INVALID/NOT_CONFIRMED`).
- **Digest chain** — the terminal closure is `CONFIRMED` and bound inside readiness
  (`readiness.boundDigests['terminal-closure'] == terminalClosure.terminalDigest`, else
  `TERMINAL_CLOSURE_NOT_BOUND`); the commit-range closure is `RANGE_CLOSED` and bound inside terminal closure
  (`COMMIT_RANGE_NOT_BOUND`); the transcript verification is `TRANSCRIPT_VERIFIED` and bound inside terminal
  closure (`TRANSCRIPT_VERIFICATION_NOT_BOUND`). This makes the context **authoritative**: it is fixed by the
  evidence that readiness was actually built over.
- **Authoritative context** — the commit range (`base` / `head` / ordered commit shas) comes from the
  commit-range closure and the required **test set** from the transcript verification's `commandResults`.
- **Exact matrix binding** — the review matrix (present/valid/`READY`) must match the authoritative context
  exactly: `base` (`CONTEXT_BASE_MISMATCH`), `head` (`CONTEXT_HEAD_MISMATCH`), the **ordered** commit shas
  (`CONTEXT_COMMITS_MISMATCH`), and the test set (`CONTEXT_REQUIRED_TESTS_MISMATCH`). The context is compared
  only when the whole chain is intact, so a stitched matrix cannot pass on an unbound chain.
- **Included placeholders** — the matrix rows are re-emitted through a sanitizer that keeps only a sha40 id,
  path-free test labels, and the fixed `PENDING` placeholder; a completed outcome or raw path can never be
  echoed.

Only genuinely-verified evidence digests are recorded in `boundDigests`. It reads parsed JSON only; it
performs no promotion, never touches the real Movies root, never contacts Jellyfin, and authorizes nothing
live. It restates the remaining human gates and the closed live boundary and is sealed with an
`authorizationDigest`.

## Files

- `src/ops/promotion-review-authorization.ts` — `buildReviewAuthorization(input)` + gates/boundary/disclaimers.
- `src/ops/promotion-review-authorization-cli.ts` — CLI wrapper.
- `test/promotion-review-authorization.ts` — 6 tests: authorized only with valid chained evidence + a matrix
  bound to the authoritative context; not-authorized by default; the green-body tamper (digest recompute)
  case; the adversarial stale-head / reordered-commits / altered-tests cases; a genuine-but-unrelated
  (forged/resealed) context caught by the chain; and a spawned CLI run.

## Usage

```
npm run ops:promotion-review-authorization -- --readiness readiness.json --terminalclosure tc.json \
    --commitrangeclosure cr.json --transcriptverification tv.json --reviewmatrix matrix.json [--out report.json]
```

Exit `0` = `LOCAL_REVIEW_AUTHORIZED`, `1` = `LOCAL_REVIEW_NOT_AUTHORIZED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
