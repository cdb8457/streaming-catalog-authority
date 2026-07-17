# Phase 230: Coordinator Review Index (local, non-live)

Report id: `phase-230-review-index`

Status: `PHASE_230_REVIEW_INDEX_READY`

The consolidated reading order for a coordinator reviewing the Phase 230 local-only promotion-safety
toolchain. Everything indexed here is offline and redaction-safe: fixture runs, parsed-JSON aggregation,
and static repo scans. **Nothing here runs the deploy launcher, touches `/mnt/user/media/Movies`, calls
live Jellyfin, performs any merge/tag/push, or authorizes Phase 231 / live promotion.**

## Reading order (evidence chain)

1. **Run evidence** — [fixture bundle](PHASE_230_PROMOTION_FIXTURE_BUNDLE.md) →
   [bundle replay](PHASE_230_PROMOTION_BUNDLE_REPLAY.md) →
   [evidence packet](PHASE_230_PROMOTION_EVIDENCE_PACKET.md) →
   [review transcript](PHASE_230_PROMOTION_REVIEW_TRANSCRIPT.md).
2. **Cross-verification** — [provenance ledger](PHASE_230_PROMOTION_PROVENANCE_LEDGER.md),
   [gate DAG](PHASE_230_PROMOTION_GATE_DAG.md),
   [archive manifest](PHASE_230_PROMOTION_ARCHIVE_MANIFEST.md),
   [review bundle](PHASE_230_PROMOTION_REVIEW_BUNDLE.md),
   [consistency matrix](PHASE_230_PROMOTION_CONSISTENCY_MATRIX.md),
   [self-digest verifier](PHASE_230_PROMOTION_SELF_DIGEST_VERIFIER.md).
3. **Adversarial + regression proofs** — [negative-evidence corpus](PHASE_230_PROMOTION_NEGATIVE_EVIDENCE_CORPUS.md),
   [redaction corpus](PHASE_230_PROMOTION_REDACTION_CORPUS.md),
   [injection corpus](PHASE_230_PROMOTION_INJECTION_CORPUS.md),
   [tamper corpus](PHASE_230_PROMOTION_TAMPER_CORPUS.md),
   [determinism stress](PHASE_230_PROMOTION_DETERMINISM.md),
   [failure-mode matrix](PHASE_230_PROMOTION_FAILURE_MATRIX.md).
4. **Structural guards** — [closure hygiene](PHASE_230_PROMOTION_CLOSURE_HYGIENE.md),
   [gate coverage](PHASE_230_PROMOTION_GATE_COVERAGE.md),
   [CLI contract](PHASE_230_PROMOTION_CLI_CONTRACT.md),
   [CLI ergonomics](PHASE_230_PROMOTION_CLI_ERGONOMICS.md),
   [report schema strictness](PHASE_230_PROMOTION_REPORT_SCHEMA.md),
   [boundary policy](PHASE_230_PROMOTION_BOUNDARY_POLICY.md),
   [final boundary audit](PHASE_230_PROMOTION_BOUNDARY_AUDIT.md).
5. **Closing chain** — [final summary](PHASE_230_PROMOTION_FINAL_SUMMARY.md) →
   [release checklist](PHASE_230_PROMOTION_RELEASE_CHECKLIST.md) →
   [merge-readiness dry run](PHASE_230_PROMOTION_MERGE_READINESS.md) →
   [provenance diff](PHASE_230_PROMOTION_PROVENANCE_DIFF.md) →
   [chain bundle](PHASE_230_PROMOTION_CHAIN_BUNDLE.md) →
   [review automation](PHASE_230_PROMOTION_REVIEW_AUTOMATION.md) →
   [reviewer pack](PHASE_230_PROMOTION_REVIEWER_PACK.md) →
   [acceptance preflight](PHASE_230_PROMOTION_ACCEPTANCE_PREFLIGHT.md).

Every record in the closing chain is digest-bound to the exact upstream records it consumed, so a set
stitched from different runs fails closed at every layer.

## How to verify locally

```
npm run test:phase230-local   # every local suite, exit 0 required
npm run typecheck             # tsc --noEmit
```

The runbook of individual tools lives in the [tooling index](PHASE_230_LOCAL_TOOLING_INDEX.md); the
closure map in the [closure index](PHASE_230_LOCAL_CLOSURE_INDEX.md); the gate composition in the
[safety suite](PHASE_230_LOCAL_SAFETY_SUITE.md).

## Human gates (never automated)

1. Human review of the commit range and diff.
2. Optionally the full `npm test` aggregate (legacy/live/CRLF/DB suites — not in the local gate).
3. Explicit coordinator ACCEPT recorded via the acceptance seal.
4. Any merge/tag/push — a human operator step, not performed or authorized by this toolchain.
5. Phase 231 authorization — **not** granted by any tool, doc, or artifact here.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization is implied or performed by anything in this index. This
toolchain never contacts Jellyfin and does not authorize Phase 231.
