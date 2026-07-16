# Phase 230: Local Closure Index (local, non-live)

Report id: `phase-230-local-closure-index`

Status: `PHASE_230_LOCAL_CLOSURE_INDEX_READY`

The closure map for the Phase 230 **local-only** toolchain: every tool's module, CLI, test, doc, and
package scripts, and its membership in the `test:phase230-local` gate. A companion guard
(`test/phase230-closure.ts`) asserts this map is complete and that the local gate contains **only** local
suites. Everything here is offline: no deploy launcher, no `/mnt/user/media/Movies` writes, no live
Jellyfin, and **no Phase 231 / live-promotion authorization**.

## Tool closure

Each tool has `src/ops/<base>.ts`, `src/ops/<base>-cli.ts`, `test/<base>.ts`, a doc, and `ops:<base>` +
`test:<base>` scripts, and is in `test:phase230-local`.

| base | doc |
|------|-----|
| `promotion-approval` | PHASE_230_PROMOTION_APPROVAL_ATTESTATION |
| `promotion-evidence-review` | PHASE_230_PROMOTION_EVIDENCE_REVIEW |
| `promotion-readiness` | PHASE_230_PROMOTION_READINESS |
| `promotion-acceptance-seal` | PHASE_230_PROMOTION_ACCEPTANCE_SEAL |
| `promotion-rehearsal` | PHASE_230_PROMOTION_REHEARSAL |
| `promotion-rehearsal-matrix` | PHASE_230_PROMOTION_REHEARSAL_MATRIX |
| `promotion-artifact-integrity` | PHASE_230_PROMOTION_ARTIFACT_INTEGRITY |
| `promotion-artifact-schema` | PHASE_230_PROMOTION_ARTIFACT_SCHEMA |
| `promotion-dashboard` | PHASE_230_PROMOTION_DASHBOARD |
| `promotion-handoff` | PHASE_230_PROMOTION_HANDOFF |
| `promotion-fixture-bundle` | PHASE_230_PROMOTION_FIXTURE_BUNDLE |
| `promotion-bundle-replay` | PHASE_230_PROMOTION_BUNDLE_REPLAY |
| `promotion-evidence-packet` | PHASE_230_PROMOTION_EVIDENCE_PACKET |
| `promotion-bundle-diff` | PHASE_230_PROMOTION_BUNDLE_DIFF |
| `promotion-tamper-corpus` | PHASE_230_PROMOTION_TAMPER_CORPUS |
| `promotion-review-transcript` | PHASE_230_PROMOTION_REVIEW_TRANSCRIPT |
| `promotion-provenance-ledger` | PHASE_230_PROMOTION_PROVENANCE_LEDGER |
| `promotion-gate-dag` | PHASE_230_PROMOTION_GATE_DAG |
| `promotion-changelog` | PHASE_230_PROMOTION_CHANGELOG |
| `promotion-archive-manifest` | PHASE_230_PROMOTION_ARCHIVE_MANIFEST |
| `promotion-acceptance-meta` | PHASE_230_PROMOTION_ACCEPTANCE_META |
| `promotion-injection-corpus` | PHASE_230_PROMOTION_INJECTION_CORPUS |
| `promotion-review-bundle` | PHASE_230_PROMOTION_REVIEW_BUNDLE |
| `promotion-consistency-matrix` | PHASE_230_PROMOTION_CONSISTENCY_MATRIX |
| `promotion-self-digest-verifier` | PHASE_230_PROMOTION_SELF_DIGEST_VERIFIER |

## Test-only local suites

- `promotion-live-boundary-guard` — static live-hook / boundary guard over the tools and docs.
- `phase230-local-suite-manifest` — asserts `test:phase230-local` includes every local suite and excludes legacy/live suites.
- `phase230-closure` — this closure guard.

The one guarded service exercised on fixtures in the gate is `real-library-promotion` (its live launcher
is Phase 229's, out of scope).

## Guarantees checked

`test/phase230-closure.ts` verifies, for every tool above: the module, CLI, test, and doc files exist;
`ops:<base>` and `test:<base>` scripts exist; the test is in `test:phase230-local`; and the doc states
its non-live / no-Phase-231 boundary. It also verifies the local gate references **only** local suites,
so no legacy / live / embedded-PostgreSQL suite can leak into the local safety gate.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization is implied or performed by any local tooling. This
toolchain never contacts Jellyfin and does not authorize Phase 231 or live promotion.
