# Phase 230: Negative-Evidence Adversarial Corpus (local, non-live)

Report id: `phase-230-promotion-negative-evidence-corpus`

Status: `PHASE_230_PROMOTION_NEGATIVE_EVIDENCE_CORPUS_READY`

A corpus of deliberately malformed / adversarial evidence artifacts, each fed through the matching Phase
230 validator to confirm it is **rejected** — proving the validators fail closed and no adversarial input
is ever accepted as green. It is a pure self-test over synthetic inputs; it performs no promotion, never
touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live (`authorization` is
the constant `NONE`).

## Samples

Each sample carries a fixed `id` and `category` and asserts its validator rejects it — e.g. a tampered
self-digest (`DIGEST_MISMATCH`), an unknown report id (`UNRECOGNIZED_REPORT`), an empty archive / review
bundle (`*_BLOCKED`), a cross-report digest mismatch (`MATRIX_INCONSISTENT`), an unsubstantiated review
(`REVIEWED_COMMIT_INVALID` / `TEST_RESULTS_INVALID`), a redaction leak (`RAW_PATH_LEAK`), and a malformed
capture (`NOT_AN_OBJECT`). `overall` is `CORPUS_HELD` only when **every** sample is rejected, else
`CORPUS_BREACHED` with the breaching sample ids. The report carries only fixed sample ids, categories,
counts, and booleans — **never the payloads themselves** — plus a `corpusDigest`.

## Files

- `src/ops/promotion-negative-evidence-corpus.ts` — `buildNegativeEvidenceCorpus()`, `NEGATIVE_SAMPLE_COUNT`.
- `src/ops/promotion-negative-evidence-corpus-cli.ts` — CLI wrapper.
- `test/promotion-negative-evidence-corpus.ts` — 4 tests: all-held, discriminating predicates (green input
  is not rejected), a self-verifiable + leak-free report, and a spawned CLI run.

## Usage

```
npm run ops:promotion-negative-evidence-corpus -- [--out corpus.json]
```

Exit `0` = `CORPUS_HELD`, `1` = `CORPUS_BREACHED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
