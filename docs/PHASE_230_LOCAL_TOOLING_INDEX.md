# Phase 230: Local Tooling Index & Runbook (local, non-live)

Report id: `phase-230-local-tooling-index`

Status: `PHASE_230_LOCAL_TOOLING_INDEX_READY`

This is the index and runbook for the Phase 230 **local-only** promotion tooling. Everything listed
here is offline: it reads/writes local JSON, runs on fixtures, and emits redaction-safe evidence. **None
of it runs the deploy launcher, touches `/mnt/user/media/Movies`, calls live Jellyfin, or authorizes
Phase 231 / live promotion.** The one genuinely live step — the operator-approved real-library
promotion itself — is defined by Phase 229, gated by `PROMOTION_APPROVED=true`, and is **out of scope**
for all of this tooling and **not authorized** by any of it.

## Tools

| Tool | ops script | doc | Purpose |
|------|-----------|-----|---------|
| Approval attestation | `ops:promotion-approval` (`build` / `validate`) | [approval](PHASE_230_PROMOTION_APPROVAL_ATTESTATION.md) | Produce / validate the bound approval JSON (itemId, targetRoot, sourceRealPath, sourceSha256, destinationPath) |
| Guarded promotion service | — (driven only by the rehearsal on fixtures; live run is Phase 229's `deploy/unraid-real-library-promotion.sh`, out of scope) | — | Bound-approval, atomic no-clobber, mandatory observed-visibility, symlink-safe promotion |
| Evidence review | `ops:promotion-evidence-review` | [review](PHASE_230_PROMOTION_EVIDENCE_REVIEW.md) | Validate a promotion evidence report (redaction-safe, complete, digest-verified) |
| Readiness checklist | `ops:promotion-readiness` | [readiness](PHASE_230_PROMOTION_READINESS.md) | Cross-check approval + promotion + review; READY/BLOCKED |
| Acceptance seal | `ops:promotion-acceptance-seal` (`seal` / `verify`) | [seal](PHASE_230_PROMOTION_ACCEPTANCE_SEAL.md) | Human ACCEPT over a READY checklist → tamper-evident sealed packet |
| Rehearsal | `ops:promotion-rehearsal` (`--scenario`) | [rehearsal](PHASE_230_PROMOTION_REHEARSAL.md) | Fixture end-to-end run of the whole pipeline + failure scenarios |
| Rehearsal matrix | `ops:promotion-rehearsal-matrix` | [matrix](PHASE_230_PROMOTION_REHEARSAL_MATRIX.md) | Run every scenario; each must match its expected outcome |
| Artifact integrity | `ops:promotion-artifact-integrity` | [integrity](PHASE_230_PROMOTION_ARTIFACT_INTEGRITY.md) | Self-digest + cross-artifact chain + missing checks |
| Artifact schema | `ops:promotion-artifact-schema` | [schema](PHASE_230_PROMOTION_ARTIFACT_SCHEMA.md) | Strict shape/status validation (catches malformed-but-self-digested) |
| Coordinator handoff | `ops:promotion-handoff` | [handoff](PHASE_230_PROMOTION_HANDOFF.md) | Redaction-safe summary with explicit no-Phase-231/no-live language |
| Acceptance dashboard | `ops:promotion-dashboard` | [dashboard](PHASE_230_PROMOTION_DASHBOARD.md) | matrix + integrity + schema + handoff → READY only if all green |
| Fixture evidence bundle | `ops:promotion-fixture-bundle` | [bundle](PHASE_230_PROMOTION_FIXTURE_BUNDLE.md) | One successful rehearsal → deterministic redaction-safe bundle of every artifact + report |
| Bundle replay verifier | `ops:promotion-bundle-replay` | [replay](PHASE_230_PROMOTION_BUNDLE_REPLAY.md) | Re-derive/re-verify a bundle's reports; fail closed on any tamper/mismatch |
| Coordinator evidence packet | `ops:promotion-evidence-packet` | [packet](PHASE_230_PROMOTION_EVIDENCE_PACKET.md) | Digests + test commands + human gates + no-Phase-231 language |
| Provenance ledger | `ops:promotion-provenance-ledger` | [ledger](PHASE_230_PROMOTION_PROVENANCE_LEDGER.md) | id + digest + producer + consumers + status per artifact/report |
| Gate dependency DAG | `ops:promotion-gate-dag` | [dag](PHASE_230_PROMOTION_GATE_DAG.md) | Declares the gate graph; verifies acyclic + topological order |
| Changelog generator | `ops:promotion-changelog` | [changelog](PHASE_230_PROMOTION_CHANGELOG.md) | Redaction-safe release notes from a commit list + no-live footer |
| Evidence archive manifest | `ops:promotion-archive-manifest` | [archive](PHASE_230_PROMOTION_ARCHIVE_MANIFEST.md) | ledger + dag + evidence + transcript → READY only if all green |
| Acceptance meta-check | `ops:promotion-acceptance-meta` | [meta](PHASE_230_PROMOTION_ACCEPTANCE_META.md) | Every op has module/CLI/test/doc/scripts/gate/boundary |
| Injection corpus | `ops:promotion-injection-corpus` | [injection](PHASE_230_PROMOTION_INJECTION_CORPUS.md) | Untrusted text treated as data; no execution/live calls |
| Coordinator review bundle | `ops:promotion-review-bundle` | [review-bundle](PHASE_230_PROMOTION_REVIEW_BUNDLE.md) | evidence + transcript + ledger + dag + archive → READY only if all green |
| Cross-report consistency matrix | `ops:promotion-consistency-matrix` | [matrix](PHASE_230_PROMOTION_CONSISTENCY_MATRIX.md) | Every shared digest agrees across all six top-level reports |
| Self-digest verifier | `ops:promotion-self-digest-verifier` | [self-digest](PHASE_230_PROMOTION_SELF_DIGEST_VERIFIER.md) | Recomputes and confirms each report's own self-digest |
| CLI contract snapshot guard | `ops:promotion-cli-contract` | [cli-contract](PHASE_230_PROMOTION_CLI_CONTRACT.md) | Universal CLI stdout contract + stable key signature |
| Determinism stress suite | `ops:promotion-determinism` | [determinism](PHASE_230_PROMOTION_DETERMINISM.md) | Repeated / reordered builder digests must be identical |
| Blocker taxonomy index | `ops:promotion-blocker-taxonomy` | [taxonomy](PHASE_230_PROMOTION_BLOCKER_TAXONOMY.md) | Catalogue of every blocker code, attributed and categorized |
| Coordinator final summary | `ops:promotion-final-summary` | [summary](PHASE_230_PROMOTION_FINAL_SUMMARY.md) | One-page verdict over review bundle + optional cross-checks |
| Closure / dependency hygiene | `ops:promotion-closure-hygiene` | [hygiene](PHASE_230_PROMOTION_CLOSURE_HYGIENE.md) | DAG + taxonomy + registry + wiring are mutually consistent |
| Negative-evidence adversarial corpus | `ops:promotion-negative-evidence-corpus` | [neg-corpus](PHASE_230_PROMOTION_NEGATIVE_EVIDENCE_CORPUS.md) | Every adversarial/malformed sample is rejected by its validator |
| Evidence release checklist | `ops:promotion-release-checklist` | [release](PHASE_230_PROMOTION_RELEASE_CHECKLIST.md) | Binds bundle/transcript/summary/hygiene/corpus to one run → go/no-go |
| Merge-readiness dry run | `ops:promotion-merge-readiness` | [merge-dry-run](PHASE_230_PROMOTION_MERGE_READINESS.md) | Advisory dry run: branch/base/head + no merge performed or authorized |
| Provenance diff / alignment | `ops:promotion-provenance-diff` | [prov-diff](PHASE_230_PROMOTION_PROVENANCE_DIFF.md) | head = reviewed commit, in range, artifacts fresh, no leaks |
| Gate coverage completeness | `ops:promotion-gate-coverage` | [coverage](PHASE_230_PROMOTION_GATE_COVERAGE.md) | Every op/gate/blocker/doc has test + taxonomy coverage |
| Artifact chain bundle | `ops:promotion-chain-bundle` | [chain](PHASE_230_PROMOTION_CHAIN_BUNDLE.md) | Packs the closing records into one digest-bound handoff manifest |
| Redaction regression corpus | `ops:promotion-redaction-corpus` | [redaction](PHASE_230_PROMOTION_REDACTION_CORPUS.md) | Every leak payload flagged by every detector; safe values pass |
| Boundary policy compiler | `ops:promotion-boundary-policy` | [policy](PHASE_230_PROMOTION_BOUNDARY_POLICY.md) | The closed-live-boundary policy, compiled + statically enforced |
| Review automation checklist | `ops:promotion-review-automation` | [automation](PHASE_230_PROMOTION_REVIEW_AUTOMATION.md) | Machine-verified review steps vs the human steps that remain |
| Live-boundary guard | `test:promotion-live-boundary-guard` | [guard](PHASE_230_PROMOTION_LIVE_BOUNDARY_GUARD.md) | Static guard that the local tools/docs hold no live hooks |
| Local closure guard | `test:phase230-closure` | [closure](PHASE_230_LOCAL_CLOSURE_INDEX.md) | Every op fully mapped; gate holds only local suites |
| Local safety suite | `test:phase230-local` | [suite](PHASE_230_LOCAL_SAFETY_SUITE.md) | Fast regression gate over only the local safety suites |

## Artifact flow

```
ops:promotion-approval build  ──►  approval.json (+ approval-evidence.json)
        │  (operator-authored, independently attested)
        ▼
[LIVE, Phase 229, out of scope]  guarded promotion  ──►  promotion-evidence.json
        ▼
ops:promotion-evidence-review  ──►  review.json
        ▼
ops:promotion-readiness  ──►  checklist.json  (READY / BLOCKED)
        ▼
ops:promotion-acceptance-seal seal  ──►  acceptance-packet.json  (coordinator ACCEPT)
        │
        ├── ops:promotion-artifact-integrity  ──►  integrity.json
        ├── ops:promotion-artifact-schema     ──►  schema.json
        ├── ops:promotion-rehearsal-matrix    ──►  matrix.json   (fixture proof of mechanics)
        ▼
ops:promotion-handoff  ──►  handoff.json
        ▼
ops:promotion-dashboard  ──►  dashboard.json  (DASHBOARD_READY only if all green)
```

The rehearsal / matrix run the whole chain on fixtures (approval → promotion → review → readiness →
acceptance) with a local file-state observer, so the mechanics can be proven offline before any live run
is ever considered. `ops:promotion-fixture-bundle` packages a full successful run (artifacts + integrity
+ schema + matrix + handoff + dashboard) into one deterministic bundle; `ops:promotion-bundle-replay`
re-verifies that bundle end-to-end; and `ops:promotion-evidence-packet` distills it to a coordinator
packet of digests, reproduction commands, and the remaining human gates.

## Test commands

```
npm run test:phase230-local                 # fast gate: only the local safety suites
npm run test:promotion-approval             # any individual suite
npm run test:promotion-live-boundary-guard  # static live-hook / boundary guard
npx tsc -p tsconfig.json --noEmit           # typecheck
```

The full `npm test` aggregate also runs these, but it additionally includes legacy / live / CRLF-
sensitive / embedded-PostgreSQL suites that are not part of this local gate.

## Remaining human gates (not automatable, not granted here)

1. **Approval authoring** — a human operator authors and independently attests the approval file; the
   tooling validates it but does not issue it.
2. **The live promotion** — running `deploy/unraid-real-library-promotion.sh` with
   `PROMOTION_APPROVED=true` against `/mnt/user/media/Movies` is a Phase 229-defined, human-authorized
   step. It is **out of scope** for this tooling and is **not** performed or authorized by it.
3. **Coordinator acceptance** — the explicit ACCEPT decision recorded by the acceptance seal.
4. **Phase 231 authorization** — explicitly **not** granted by any tool, doc, or artifact here.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization is implied or performed by any local tooling in this
index.
