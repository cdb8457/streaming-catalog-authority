# Phase 241: Final Audit / Closure Packet for Phases 231–240 (local, non-live)

Report id: `phase-241-promotion-audit-closure-packet`

Status: `PHASE_241_PROMOTION_AUDIT_CLOSURE_PACKET_READY`

The capstone of the promotion record chain. It takes the ten chain reports — Phases 231 through 240 — and
independently re-derives **every digest, every inter-phase link, the single-operation identity, and every
phase's own semantic success state** in one pass. Then it says plainly what all of that does and does not
prove.

It **creates nothing**: no approval, no execution, no observation, no custody, no archive, and no judgment
about whether the promotion should have happened. `approvalCreatedByThisTool`,
`executionPerformedByThisTool`, `observationCapturedByThisTool`, `custodyHeldByThisTool`,
`archivedByThisTool`, `judgmentFormedByThisTool` and `selfAuthorized` are all the constant `false`. There is
no skeleton, no decision field and no human record in this phase at all — it is a pure read-only audit.

## Why this phase exists

Every phase below validates its immediate parent, and since Phase 236 the operation identity running through
the chain. Nothing until now took the chain **as a whole** and asked the two questions an auditor actually
asks:

1. Is every artifact genuine, internally sound, and mutually consistent?
2. What does that actually let anyone conclude?

This packet answers the first by re-derivation, and the second with a fixed **proof-limit matrix** carried
inside the report itself.

## Outcomes

| `overall` | Meaning | Exit |
| --- | --- | --- |
| `AUDIT_CLOSED` | all ten present, contiguous, genuine, semantically sound, cross-bound, and each in its own terminal success state | `0` |
| `AUDIT_INVALID` | fail closed — a report does not recompute, a link does not re-derive, identity drifts, a hole in the chain, or a report failed its own internal checks | `1` |
| (input read error) | a supplied file is missing or not valid JSON | `2` |
| `AUDIT_OPEN` | every supplied report is genuine, sound and cross-bound, but the chain has not reached a closed terminal state | `3` |
| `NOT_ELIGIBLE` | no genuine Phase 231 anchor, so there is no operation identity to audit anything against | `5` |

`NOT_ELIGIBLE` takes precedence over everything. **`AUDIT_OPEN` is a normal state, not a defect** — the chain
legitimately stops partway, and a clean prefix reports zero blockers.

## What it checks

1. **Recomputation** — every supplied report must be the right report id for its slot and reproduce its own
   self-digest (`AUDIT_PHASE_<n>_REPORT_INVALID`, `AUDIT_PHASE_<n>_DIGEST_MISMATCH`).
2. **Anchor** — the Phase 231 gate must be present and genuine (`AUDIT_ANCHOR_MISSING`,
   `AUDIT_NO_REPORTS_SUPPLIED`, `AUDIT_PHASE_231_OPERATION_IDENTITY_UNAVAILABLE`).
3. **Contiguity** — the supplied set must be a prefix from Phase 231; a hole is invalid
   (`AUDIT_PHASE_<n>_PREDECESSOR_MISSING`).
4. **Semantic soundness on the whole body** — this is the core. A self-digest is not a signature, so any
   report can carry a green `overall` over a body that failed its own checks and still recompute cleanly.
   Every phase is therefore checked against its **own** success booleans, its **own** did-nothing constants,
   and an empty blocker list — plus an empty `mismatches` list for Phase 238, which deliberately keeps failed
   comparisons separate from blockers (`AUDIT_PHASE_<n>_CONSTANT_INVALID`, `AUDIT_PHASE_<n>_ACTION_CLAIMED`,
   `AUDIT_PHASE_<n>_FINDINGS_PRESENT`). No two phases name these alike; each set is taken from its producer
   module.
5. **Linkage** — every adjacent link re-derived against the parent's own recomputed self-digest. Phase 236 has
   no single parent: it names Phases 231–235 in `chainDigests`, and is linked only when every one matches
   (`AUDIT_PHASE_<n>_LINK_NOT_REDERIVED`).
6. **Single-operation identity** — anchored to the Phase 231 template and checked at every phase,
   independently of linkage, so a forgery that keeps a correct parent link while carrying another operation's
   digests still fails (`AUDIT_PHASE_<n>_OPERATION_IDENTITY_MISMATCH`). The phases publish operation digests
   in three different shapes — Phase 231 in its template, 232–235 under kebab-case `operation-*` keys,
   Phase 236 in `operationDigests`, 237–240 under plain field names — each taken from its producer module.
7. **Redaction, defence in depth** — every supplied report must declare itself redaction-safe and no raw path
   may appear anywhere in the bundle (`AUDIT_REDACTION_UNSAFE`). These are *generated* reports whose own
   boundary prose legitimately names the live surfaces they avoid, so the raw-path-marker scanner applies
   rather than the strict hand-written-record predicate — the Phase 236 precedent, for the same reason.

**A genuine but non-terminal report is not a defect.** A Phase 232 `PENDING` record, a Phase 239 ledger that is
intact but whose custody has not been released, or a Phase 240 `INVENTORY_STRUCTURAL_ONLY` are all sound
states that simply cap the verdict at `AUDIT_OPEN`.

## The proof-limit matrix

`AUDIT_CLOSED` is the strongest verdict this stack can reach, and it is much weaker than it sounds. The matrix
travels **inside** the report so the caveat cannot be separated from the artifact.

| Phase | Green state | Establishes | Does **not** establish |
| --- | --- | --- | --- |
| 231 | `EXECUTION_AUTHORIZATION_TEMPLATE_READY` | The prepared non-live evidence is valid, cross-bound, and describes exactly one operation. | It is **not** an authorization. Authorization is the constant `NONE`; the run remains a separate human step. |
| 232 | `EXECUTION_AUTHORIZATION_RECORD_APPROVED` | A well-formed human decision record exists, digest-bound to that one operation. | It records a **decision**, never an execution. It does not show the run occurred, nor who really decided. |
| 233 | `POST_RUN_OBSERVATION_RECORDED` | A human reported an outcome coherently, with a withdrawal proven only by a restored before-state. | A human **report**, not evidence the run occurred or that any observed state was real. |
| 234 | `POST_RUN_DISPOSITION_ACCEPTED` | A human reviewed the outcome and accepted it; a FAILED run only once its withdrawal was proven. | A review **record**. Not that the review was competent, the outcome sound, or who performed it. |
| 235 | `OPERATION_CLOSURE_CLOSED` | A human closed the operation out, affirming archival with no outstanding remediation. Closure is archival, never erasure. | Not that the evidence was archived, is retrievable, or still exists. |
| 236 | `CHAIN_REPLAY_VERIFIED_CLOSED` | Every report re-derives from its source record, links to its parent, and the chain describes one operation. | **Not authorship.** It does not pin *which* source records: identities, timestamps and the observed after-state are swappable. |
| 237 | `PROVENANCE_COMMITTED` | A human committed, at a point in time, to the exact content digests of the four source records. | The digests are never recomputed against real records here; it only makes a **later** substitution detectable. |
| 238 | `SOURCE_RECORDS_VERIFIED` | The supplied bytes canonically digest to what was committed and re-derive their reports. | Not authorship, and not that these were the records historically used. |
| 239 | `CUSTODY_LEDGER_INTACT` + `CUSTODY_RELEASED` | A hash-linked custody narrative where editing any event **with successors** is detectable. | Append-only-**evident**, never **enforced**. Resealing or rebuilding the tail is undetectable. |
| 240 | `INVENTORY_COMPLETE` | All nine artifacts accounted for, claimed retained, pinned to this chain instance. | An **accounting**, not an existence. Cannot detect one destroyed then honestly re-listed as `PENDING`. |
| 241 | `AUDIT_CLOSED` | All ten reports present, genuine, sound by their own criteria, mutually linked, describing one operation. | **Self-digests are not signatures.** A party controlling every artifact can fabricate a chain audited as `CLOSED`. It means the **records are mutually consistent** — not that the promotion happened, was correct, or was authorized by anyone in particular. |

## Usage

```
npm run ops:promotion-audit-closure-packet -- \
  --phase231 gate.json --phase232 authorization.json --phase233 observation.json \
  --phase234 disposition.json --phase235 closure.json --phase236 replay.json \
  --phase237 commitment.json --phase238 verification.json --phase239 ledger.json \
  --phase240 inventory.json [--out audit.json]
```

Any subset may be omitted; a chain that stops partway is `AUDIT_OPEN`, not an error.

## Current state of the prepared P227-A run

**`AUDIT_OPEN`, terminating at Phase 232, with zero blockers.** The real chain consists of exactly two genuine
reports: a Phase 231 gate that is `TEMPLATE_READY`, and a Phase 232 authorization record that is `PENDING`
because no human ever approved the run. Phases 233–240 are **absent because they cannot exist**.

The audit reports `chainComplete: false`, `auditClosed: false`, `terminalPhase: 232`, and — importantly — **no
blockers at all**: stopping there is the honest state of an unapproved operation, not a defect. The Phase 232
record is reported as genuinely `semanticallySound` but not `terminal`.

Both states are locked as offline fixtures, along with the graft case: bolting a synthetic finished-looking
tail onto the real head yields `AUDIT_INVALID` on operation-identity mismatch and broken linkage. No approved
authorization, recorded observation, accepted disposition, closed closure, verified replay, committed
manifest, verified submission, intact ledger or complete inventory is constructed for the real bundle
anywhere in this repository.

## Tests

`test/promotion-audit-closure-packet.ts` (also `npm run test:phase241-local`), 19 tests: a complete synthetic
chain auditing `AUDIT_CLOSED` while creating nothing; `NOT_ELIGIBLE` with no reports, with the anchor
withheld, with a non-recomputing anchor and with a wrong report in the anchor slot; every clean prefix as
`AUDIT_OPEN` with zero blockers; a hole at each position; each inter-phase link broken in turn including
Phase 236's `chainDigests`; identity drift at every phase; **the semantic case** — a forged green headline
over a failed body at every phase, and findings recorded under a green headline at every phase, each proving
the digest check does *not* fire; a Phase 238 report with non-empty `mismatches`; a report claiming it acted
at each phase that disclaims action; genuine non-terminal reports capping at `AUDIT_OPEN` (Phase 232
`PENDING`, Phase 239 unreleased, Phase 240 structural-only); a wrong report kind in any slot; a tampered
report at any layer; the proof-limit matrix emitted, complete and fixed; determinism and self-verification; a
smuggled raw path never echoed; a redaction-safe CLI across all five exit paths; and the locked real P227-A
fixtures.

## What this phase deliberately does NOT do

It does not authorize, schedule, or perform the P227-A promotion; it creates no approval, execution,
observation, custody, archive or judgment; it does not run the promotion launcher, read or write the real
Movies library, or contact Jellyfin; it does not read the secret approval file; and it does not merge, tag, or
push. It reads reports and reports what it found.
