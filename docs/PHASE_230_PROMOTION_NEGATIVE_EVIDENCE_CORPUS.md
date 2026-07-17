# Phase 230: Negative-Evidence Adversarial Corpus (local, non-live)

Report id: `phase-230-promotion-negative-evidence-corpus`

Status: `PHASE_230_PROMOTION_NEGATIVE_EVIDENCE_CORPUS_READY`

A corpus of deliberately malformed / adversarial evidence artifacts, each fed through the matching Phase
230 validator to confirm it is **rejected** — proving the validators fail closed and no adversarial input
is ever accepted as green. It is a pure self-test over synthetic inputs; it performs no promotion, never
touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live (`authorization` is
the constant `NONE`).

## Samples

Each sample carries a fixed `id` and `category` and asserts its validator rejects it. Coverage includes:

- **Tampered digests** — a stale ledger or review-bundle self-digest (`DIGEST_MISMATCH`).
- **Unknown / malformed** — an unknown report id (`UNRECOGNIZED_REPORT`), a non-object capture
  (`NOT_AN_OBJECT`), a redaction leak (`RAW_PATH_LEAK`).
- **Missing components** — an empty archive / review bundle (`*_BLOCKED`).
- **Cross-report mismatch (green-looking, stale)** — a ledger recording the wrong evidence digest
  (`EVIDENCE_LEDGER_MISMATCH`), a review bundle whose archive component doesn't match
  (`ARCHIVE_EVIDENCE_MISMATCH`), and a consistency-matrix review/archive divergence (`MATRIX_INCONSISTENT`).
- **Unsubstantiated review** — a clean transcript with a bogus commit or no tests (`REVIEWED_COMMIT_INVALID`
  / `TEST_RESULTS_INVALID`).
- **Stale binding** — a release checklist whose final summary is bound to a different reviewed commit
  (`COMMIT_BINDING_MISMATCH`) or whose review bundle doesn't bind the transcript
  (`TRANSCRIPT_BUNDLE_MISMATCH`), and a merge-readiness manifest whose final summary is unbound from the
  cleared checklist (`FINAL_SUMMARY_BINDING_MISMATCH`).
- **Incomplete / not-ready upstream** — a merge-readiness manifest with a missing context
  (`MERGE_CONTEXT_MISSING`) or a not-cleared release checklist (`RELEASE_CHECKLIST_NOT_CLEARED`); a
  coordinator-readiness input where a green-required component is not ready (`BOUNDARY_AUDIT_FAILED`).
- **AP-AZ green-looking artifacts** — an AP-AZ report with a wrong-but-well-formed self-digest
  (`REPORT_DIGEST_MISMATCH`), a malformed digest (`REPORT_DIGEST_INVALID`), an unknown key (`UNKNOWN_KEY`),
  an unknown report id (`REPORT_UNRECOGNIZED`), and a readiness component missing its digest
  (`COMPONENT_DIGEST_MISSING`) — covering the schema strictness dimensions plus wrong binding and payload
  leak (shared with the other samples).
- **Forged-but-green components (final evidence chain)** — a component with the correct report id, a green
  status, and a well-formed **but non-recomputing** self-digest, fed to the terminal-closure manifest, the
  reviewer pack, the pack-component-integrity verifier, and the closure aggregators (chain-bundle,
  coordinator-readiness). Each must fail closed on a real recompute (`COMPONENT_DIGEST_MISMATCH`), plus a
  green-looking pack whose own self-digest does not recompute (`PACK_DIGEST_MISMATCH`). Presence/format
  checks alone would accept these — only recompute rejects them.

`overall` is `CORPUS_HELD` only when **every** sample is rejected, else `CORPUS_BREACHED` with the breaching
sample ids. The report carries only fixed sample ids, categories, counts, and booleans — **never the
payloads themselves** — plus a `corpusDigest`.

## Files

- `src/ops/promotion-negative-evidence-corpus.ts` — `buildNegativeEvidenceCorpus()`, `NEGATIVE_SAMPLE_COUNT`.
- `src/ops/promotion-negative-evidence-corpus-cli.ts` — CLI wrapper.
- `test/promotion-negative-evidence-corpus.ts` — 4 tests: all-held (asserting the forged-green-component
  coverage), discriminating predicates (green input is not rejected), a self-verifiable + leak-free report,
  and a spawned CLI run.

## Usage

```
npm run ops:promotion-negative-evidence-corpus -- [--out corpus.json]
```

Exit `0` = `CORPUS_HELD`, `1` = `CORPUS_BREACHED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
