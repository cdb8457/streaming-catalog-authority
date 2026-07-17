# Phase 230: Redaction Regression Corpus (local, non-live)

Report id: `phase-230-promotion-redaction-corpus`

Status: `PHASE_230_PROMOTION_REDACTION_CORPUS_READY`

A regression corpus for the Phase 230 redaction detectors. Every leak-shaped payload — absolute unix
paths, Windows drive paths, `/mnt/`-style live-library paths, backslash variants, bare media filenames
(any case), and the fixture-library marker — is driven through **every** redaction detector: the
CLI-contract capture scanner, the final-summary test-result command validator, the merge-readiness context
validator, and the provenance-diff subject validator. Each detector must flag each payload. A companion
set of safe values (command labels, hex digests, status enums, report ids, relative branch names) must NOT
be flagged, proving the detectors discriminate. It is a pure self-test over synthetic inputs; it performs
no promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live
(`authorization` is the constant `NONE`).

`overall` is `REDACTION_CORPUS_HELD` only when every leak is flagged by every detector
(else `LEAK_NOT_DETECTED`) and no safe value is flagged (else `SAFE_VALUE_FLAGGED`); otherwise
`REDACTION_CORPUS_BREACHED` with the breaching sample ids. The report carries only fixed sample ids,
categories, and counts — **never the payloads themselves** — plus a `redactionDigest`. Payload strings
are assembled from fragments so even the module source carries no literal media path.

## Files

- `src/ops/promotion-redaction-corpus.ts` — `buildRedactionCorpus()`, `REDACTION_LEAK_COUNT`,
  `REDACTION_SAFE_COUNT`, `REDACTION_DETECTOR_COUNT`.
- `src/ops/promotion-redaction-corpus-cli.ts` — CLI wrapper.
- `test/promotion-redaction-corpus.ts` — 4 tests: all-held across every detector, a payload-free +
  self-verifiable report, category coverage, and a spawned CLI run.

## Usage

```
npm run ops:promotion-redaction-corpus -- [--out corpus.json]
```

Exit `0` = `REDACTION_CORPUS_HELD`, `1` = `REDACTION_CORPUS_BREACHED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
