# Phase 231: One-Shot Execution-Authorization Gate for the Prepared P227-A Promotion (local, non-live)

Report id: `phase-231-promotion-execution-authorization`

Status: `PHASE_231_PROMOTION_EXECUTION_AUTHORIZATION_READY`

A **fail-closed** local gate for the single prepared **P227-A** real-library promotion. It validates and
**cross-binds** the prepared non-live evidence and, only when every piece is valid and binds to the **same
one item**, emits a **NOT-authorized, human-completable execution template** bound by digest to exactly one
`promote → observe → withdraw` operation.

It authorizes **nothing**. The report's live `authorization` field is the constant `NONE` and its `status`
is `PENDING`; every emitted template field stays `PENDING`. `EXECUTION_AUTHORIZATION_TEMPLATE_READY` means
only that the prepared non-live evidence is valid, cross-bound, and safe to hand to a human — **not** that
the promotion is approved or may run. The `promote-observe-withdraw` run itself remains a separate human
operator step that is **not performed or authorized here**.

## Boundary (what it never does)

- It **never runs** `deploy/unraid-real-library-promotion.sh` or any promotion launcher.
- It **never reads or writes** the real Movies library (`/mnt/user/media/Movies`).
- It **never contacts** live Jellyfin (no HTTP, no scan, no network).
- It **never reads the secret approval file** (`p227-a.approval.json`). It operates purely on the
  redaction-safe evidence artifacts, so it needs no secret and exposes none.
- It **never self-authorizes** or performs the promotion, merge, tag, or any live action.

It reads parsed JSON only and is deterministic. The emitted report is **redaction-safe**: it echoes only
digests, fixed codes, per-check booleans, and counts — never a raw path, raw item id, raw approval id, or
checksum-bearing source string.

## Inputs (the prepared P227-A artifacts)

Prepared, non-live, under `/mnt/user/appdata/catalog/evidence/phase-231/` on the server (SSH alias
`tower`). The gate consumes the redaction-safe / non-secret files only:

| CLI flag | File | Report |
| --- | --- | --- |
| `--approvalevidence` | `p227-a.approval-evidence.json` | `phase-230-promotion-approval-attestation` (mode `build`) |
| `--approvalvalidation` | `p227-a.approval-validation-final.json` | `phase-230-promotion-approval-attestation` (mode `validate`) |
| `--preflightplan` | `p227-a.preflight-plan.json` | raw live-preflight plan |
| `--preflightreport` | `p227-a.preflight-report.json` | `phase-230-promotion-live-preflight-plan` |
| `--preflightselfdigest` | `p227-a.preflight-self-digest.json` | `phase-230-promotion-self-digest-verification` |

The secret `p227-a.approval.json` is **not** an input and is never read.

## What it checks (all must hold for `TEMPLATE_READY`)

1. **Approval build evidence** (`approvalEvidenceValid`) — present, report id
   `phase-230-promotion-approval-attestation`, `mode: "build"`, self-digest recomputes
   (`APPROVAL_EVIDENCE_DIGEST_MISMATCH`), `status: "APPROVAL_ATTESTATION_READY"`
   (`APPROVAL_EVIDENCE_NOT_READY`), and `targetRoot` is the one approved real Movies root
   (`TARGET_ROOT_NOT_APPROVED`).
2. **Approval validate evidence** (`approvalValidationBound`) — present, `mode: "validate"`, self-digest
   recomputes, `READY`, **and** carries the same binding digests as the build evidence
   (`approvalIdDigest`, `itemDigest`, `sourceRealPathDigest`, `sourceSha256`, `destinationPathDigest`), so
   the same secret approval was both built and independently re-validated against the real source
   (`APPROVAL_VALIDATION_NOT_BOUND`).
3. **Live-preflight report** (`preflightValid`) — present, report id
   `phase-230-promotion-live-preflight-plan`, self-digest recomputes
   (`PREFLIGHT_REPORT_DIGEST_MISMATCH`), `overall: "PREFLIGHT_PLAN_VALID"`, `status: "PENDING"`, and
   `authorization: "NONE"` (`PREFLIGHT_REPORT_NOT_VALID` / `_NOT_PENDING` / `_AUTHORIZATION_NOT_NONE`).
4. **Plan re-derivation** (`preflightRederived`) — re-running `buildLivePreflightPlan(plan)` yields
   `PREFLIGHT_PLAN_VALID` and a `planDigest` equal to the report's (`PREFLIGHT_PLAN_NOT_VALID` /
   `PREFLIGHT_PLAN_NOT_REDERIVED`), so the report is the honest verification of **this** plan.
5. **Preflight self-digest** (`selfDigestBound`) — present, report id
   `phase-230-promotion-self-digest-verification`, `ALL_VERIFIED`, self-verifies, and equals the genuine
   self-digest verification of **exactly this one** preflight report — not a bundle that merely includes it
   (`PREFLIGHT_SELF_DIGEST_NOT_ALL_VERIFIED` / `_DIGEST_MISMATCH` / `_NOT_BOUND`).
6. **One-shot exact-operation binding** (`operationBound`) — the plan describes **exactly one** item
   (`ITEM_COUNT_NOT_ONE`) whose `approvalId` / `itemId` / `sourceDigest` / `destinationDigest`, hashed under
   the approval-attestation scopes, equal the approval evidence's bindings
   (`OPERATION_APPROVAL_ID_MISMATCH` / `_ITEM_ID_MISMATCH` / `_SOURCE_DIGEST_MISMATCH` /
   `_DESTINATION_DIGEST_MISMATCH`). **This is what makes the promotion the operator would run provably the
   same one item the approval authorizes**, by digest, not by any self-echoed field.

Any failure yields `EXECUTION_AUTHORIZATION_BLOCKED`, the specific value-free blocker codes, and
`template: null` (fail closed — no template is emitted unless every gate is green).

### Why the report and self-digest do not carry item identity

The live-preflight report is redaction-safe: it carries only per-item booleans, never the item digests.
Two valid single-item plans therefore produce byte-identical reports (and self-digests). Item identity is
**not** established by the report; it is pinned by the operation-binding step (6), which compares the raw
plan's item digests to the approval evidence. Steps 3–5 attest that the plan is a structurally valid,
`PENDING`, no-clobber / same-checksum / observed-state / rollback / withdrawal plan; step 6 attests it is
**the approved item**. Together they bind one exact `promote-observe-withdraw` operation.

## The emitted template (the authorization mechanism)

When ready, the report includes a `template` — a NOT-authorized skeleton a human later completes to
authorize the one operation. It is digest-only:

- `operation: "promote-observe-withdraw"`, `authorization: "NONE"`, `status: "PENDING"`,
  `targetRootApproved: true`;
- `approvalIdDigest`, `itemDigest`, `sourceDigest`, `destinationDigest`, `planDigest`;
- `fields`: `operatorAuthorized`, `observedStateWitnessedBefore`, `withdrawalPathRehearsed`,
  `observedStateWitnessedAfter`, `runExecutedByHuman` — all `PENDING` placeholders.

The template does not embed the run command or any path. The actual run — completing these fields, the
operator sign-off, and executing `promote → observe → withdraw` on the server — is a **separate human step**
that this gate neither performs nor authorizes.

## Usage

```
npm run ops:promotion-execution-authorization -- \
  --approvalevidence   p227-a.approval-evidence.json \
  --approvalvalidation p227-a.approval-validation-final.json \
  --preflightplan      p227-a.preflight-plan.json \
  --preflightreport    p227-a.preflight-report.json \
  --preflightselfdigest p227-a.preflight-self-digest.json \
  [--out execution-authorization.json]
```

Exit `0` = `EXECUTION_AUTHORIZATION_TEMPLATE_READY`, `1` = `EXECUTION_AUTHORIZATION_BLOCKED`, `2` = input
read error. Against the actual prepared P227-A artifacts the gate returns
`EXECUTION_AUTHORIZATION_TEMPLATE_READY` with all six checks green and `authorization: "NONE"`.

## Tests

`test/promotion-execution-authorization.ts` (also `npm run test:phase231-local`): happy path + bound
template, fail-closed-by-default, green-body tamper → digest mismatch, foreign approval-validation → not
bound, wrong source digest / more than one item → operation not bound, over-broad or non-re-deriving
preflight self-digest/report → not bound, a redaction-safe CLI check, and a locked offline fixture that
asserts the gate is `TEMPLATE_READY` for the **actual** captured P227-A evidence.

## What this phase deliberately does NOT do

It does not authorize, schedule, or perform the P227-A promotion; it does not run the promotion launcher,
read or write the real Movies library, or contact Jellyfin; it does not read the secret approval file; and
it does not merge, tag, or push. Those remain separate human steps, preserved behind the live boundary.
