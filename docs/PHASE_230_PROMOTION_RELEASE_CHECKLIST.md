# Phase 230: Coordinator Evidence Release Checklist (local, non-live)

Report id: `phase-230-promotion-coordinator-release-checklist`

Status: `PHASE_230_PROMOTION_RELEASE_CHECKLIST_READY`

Directly consumes and **binds** the underlying evidence artifacts — the **review bundle**, the **review
transcript** (with its test results), the **coordinator final summary**, and the **closure / dependency
hygiene** report — plus the **negative-evidence adversarial corpus** (and, optionally, the **self-digest
verification**). It reads parsed JSON only; it performs no promotion, never touches `/mnt/user/media/Movies`,
never contacts Jellyfin, and authorizes nothing live (`authorization` is the constant `NONE`). **Clearing
the checklist is not a merge, a release action, or a Phase 231 authorization** — only a statement that the
local evidence preconditions are met.

## Items

| Item | Required | Passes when |
|------|----------|-------------|
| `review-bundle` | yes | `REVIEW_BUNDLE_READY` |
| `transcript` | yes | `REVIEW_CLEAN` |
| `final-summary` | yes | `FINAL_SUMMARY_READY` |
| `closure-hygiene` | yes | `HYGIENE_OK` |
| `negative-evidence-corpus` | yes | `CORPUS_HELD` |
| `self-digest` | no | `ALL_VERIFIED` (absent does not block) |

## Bindings

Beyond per-item greenness, the checklist cross-checks that the artifacts describe the **same run** and
records the exact input digests in `boundDigests`:

- `review-bundle=transcript` — the review bundle's `transcript` component digest must equal the supplied
  transcript's `transcriptDigest` (else `TRANSCRIPT_BUNDLE_MISMATCH`).
- `final-summary.commit=transcript.commit` — the final summary's `reviewedCommit` must equal the
  transcript's (else `COMMIT_BINDING_MISMATCH`).
- `final-summary.tests=transcript.tests` — the final summary's `testsPassed`/`testsFailed` totals must
  equal the sums over the transcript's `testResults` (else `TEST_RESULTS_BINDING_MISMATCH`).

Binding evidence **fails closed**: every present artifact (each required item, and a supplied optional
`self-digest`) must carry a valid sha256 in its digest field — `reviewBundleDigest`, `transcriptDigest`,
`summaryDigest`, `hygieneDigest`, `corpusDigest`, and `verifierDigest` respectively. A READY/OK artifact
that is missing that digest, or carries a malformed one, blocks with `REQUIRED_DIGEST_MISSING` /
`REQUIRED_DIGEST_INVALID` and is never recorded in `boundDigests` — so the checklist cannot clear with an
unbound artifact.

`overall` is `RELEASE_CHECKLIST_CLEARED` iff every required item is present, valid, passing, and carries a
valid binding digest, every supplied optional item passes with a valid digest, and every binding holds;
otherwise `RELEASE_CHECKLIST_BLOCKED` with generic blockers (`*_MISSING`, `*_INVALID`,
`REQUIRED_DIGEST_MISSING`, `REQUIRED_DIGEST_INVALID`, `REVIEW_BUNDLE_NOT_READY`, `TRANSCRIPT_NOT_CLEAN`,
`FINAL_SUMMARY_NOT_READY`, `NEGATIVE_CORPUS_BREACHED`, `CLOSURE_HYGIENE_NOT_OK`, `SELF_DIGEST_NOT_VERIFIED`,
`TRANSCRIPT_BUNDLE_MISMATCH`, `COMMIT_BINDING_MISMATCH`, `TEST_RESULTS_BINDING_MISMATCH`). Every checklist
restates the remaining human gates and the fixed non-live / no-merge disclaimers and is sealed with a
`checklistDigest`.

## Files

- `src/ops/promotion-release-checklist.ts` — `buildReleaseChecklist(input)`, `RELEASE_CHECKLIST_HUMAN_GATES`,
  `RELEASE_CHECKLIST_DISCLAIMERS`.
- `src/ops/promotion-release-checklist-cli.ts` — CLI wrapper.
- `test/promotion-release-checklist.ts` — 10 tests: all-cleared with bindings, a digestless required
  READY artifact (coordinator repro), a malformed required digest, a malformed supplied optional digest, a
  stale-commit binding mismatch, a review-bundle/transcript binding mismatch, a missing required item, a
  corpus breach, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-release-checklist -- --reviewbundle f --transcript f --finalsummary f --closurehygiene f --negativecorpus f [--selfdigest f] [--out checklist.json]
```

Exit `0` = `RELEASE_CHECKLIST_CLEARED`, `1` = `RELEASE_CHECKLIST_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
