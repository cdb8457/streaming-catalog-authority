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
| Acceptance dashboard | `ops:promotion-dashboard` | [dashboard](PHASE_230_PROMOTION_DASHBOARD.md) | matrix + integrity + handoff → READY only if all green |
| Live-boundary guard | `test:promotion-live-boundary-guard` | [guard](PHASE_230_PROMOTION_LIVE_BOUNDARY_GUARD.md) | Static guard that the local tools/docs hold no live hooks |
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
is ever considered.

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
