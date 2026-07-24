# Phase 235: Operation Closure / Archival Record for the Prepared P227-A Promotion (local, non-live)

Report id: `phase-235-promotion-operation-closure-record`

Status: `PHASE_235_PROMOTION_OPERATION_CLOSURE_RECORD_READY`

A **fail-closed** local validator for the **human closure record** that would close out the single prepared
**P227-A** operation. It consumes the Phase 234 disposition record — which must be a genuine `ACCEPTED`
review — and validates a **separately supplied** human closure record for that one
`promote → observe → withdraw` operation: close it out, hold it open, or leave it undecided.

It **closes, archives, purges and reviews nothing itself**. `closedByThisTool`, `archivedByThisTool`,
`purgedByThisTool` and `selfAuthorized` are the constants `false`: this validator moves no evidence, deletes
nothing, forms no judgement, and only checks a record a human produced out-of-band.

## The headline invariant: closure is archival, never erasure

- `evidencePurged` may never be anything but `PENDING` in **any** valid record, whatever the decision
  (`CLOSURE_EVIDENCE_PURGE_CLAIMED`). An operation must never be closed by destroying its own record — and
  even an explicit `REFUSED` is a claim on that field, so it is refused too.
- `CLOSED` additionally requires the evidence archived out-of-band **and** these chain digests recorded
  alongside it (`CLOSURE_CLOSED_WITHOUT_ARCHIVAL`), so what is closed stays findable and re-verifiable
  against the exact digests it was closed under.
- `CLOSED` requires no outstanding remediation (`CLOSURE_CLOSED_WITH_OUTSTANDING_REMEDIATION`): an operation
  with work still owed to it is not finished.
- `HELD_OPEN` is the conservative verdict and is **always available**, in every state and with no
  preconditions. Holding an operation open is never something this validator can refuse.

## `NOT_CLOSEABLE`, and why it is not `INVALID`

- **`NOT_CLOSEABLE`** — the **chain** has nothing to close. The upstream disposition is absent, not genuine,
  or not `ACCEPTED`, so no closure over it can mean anything.
- **`INVALID`** — the chain *is* closeable, but the **supplied closure record** is broken.

`NOT_CLOSEABLE` takes **precedence over everything**: when the disposition is not closeable the overall
verdict is `NOT_CLOSEABLE` no matter what the closure record claims. That is what **locks the actual prepared
P227-A chain**, which terminates at Phase 234 `NOT_REVIEWABLE` — it can never land anywhere else here.

## Boundary (what it never does)

- It **never creates, infers, completes, or upgrades** a closure. `--skeletonout` emits only an all-`PENDING`
  blank record for a human to fill in.
- It **never archives or purges** anything, and it holds no opinion on retention.
- It **never runs** `deploy/unraid-real-library-promotion.sh`, any promotion launcher, or any withdrawal.
- It **never reads or writes** the real Movies library (`/mnt/user/media/Movies`).
- It **never contacts** live Jellyfin, **never reads the secret approval file**, and **never self-authorizes**,
  merges, tags, or pushes.

It reads parsed JSON only and is deterministic. The emitted report is **redaction-safe**: chain digests, fixed
codes, closed enum states and booleans only — never a raw path, raw item id, raw approval id, or closer
identity.

## Inputs

| CLI flag | Value |
| --- | --- |
| `--dispositionrecord` | the Phase 234 report (`phase-234-promotion-post-run-disposition-record`) |
| `--closure` | the human closure record (`phase-235-promotion-operation-closure-record-input`) |
| `--out` | optional path for the full validation report |
| `--skeletonout` | optional path for a blank, all-`PENDING` closure record to complete |

## The record a human completes

```json
{
  "record": "phase-235-promotion-operation-closure-record-input",
  "version": 1,
  "operation": "promote-observe-withdraw",
  "sourceDispositionRecord": "phase-234-promotion-post-run-disposition-record",
  "dispositionDigest": "<the Phase 234 report's own dispositionDigest>",
  "approvalIdDigest": "<from the Phase 234 boundDigests>",
  "itemDigest": "<from the Phase 234 boundDigests>",
  "sourceDigest": "<from the Phase 234 boundDigests>",
  "destinationDigest": "<from the Phase 234 boundDigests>",
  "planDigest": "<from the Phase 234 boundDigests>",
  "closedOutcome": "COMPLETED",
  "fields": {
    "closureAffirmed": "PENDING",
    "evidenceArchivedOutOfBand": "PENDING",
    "chainDigestsRecordedInArchive": "PENDING",
    "noOutstandingRemediation": "PENDING",
    "evidencePurged": "PENDING"
  },
  "closerDigest": "PENDING",
  "closedAtUtc": "PENDING"
}
```

Every `fields` value ∈ `PENDING | AFFIRMED | REFUSED`; `closedOutcome` ∈ `COMPLETED | FAILED`.

`closureAffirmed` **is** the decision (`AFFIRMED` → `CLOSED`, `REFUSED` → `HELD_OPEN`, `PENDING` → `PENDING`).
There is no separate verdict field, so a record can never state a decision that contradicts its own fields.

Nothing in the skeleton is affirmed. The only pre-filled values are **derived bindings** copied from the
upstream record — the five operation digests, the disposition digest, and `closedOutcome` — which name *what*
is being closed, not a judgement about it. The judgement lives entirely in the all-`PENDING` `fields`.

## What it checks

1. **Disposition validity** (`dispositionCloseable`) — the Phase 234 record is present, is
   `phase-234-promotion-post-run-disposition-record`, its self-digest recomputes
   (`DISPOSITION_RECORD_DIGEST_MISMATCH`), it is `POST_RUN_DISPOSITION_ACCEPTED` with
   `dispositionAccepted: true` (`DISPOSITION_RECORD_NOT_ACCEPTED` / `_NOT_MARKED_ACCEPTED`), it still claims
   to have reviewed, performed and captured nothing (`_REVIEWED_CLAIMED` / `_PERFORMED_CLAIMED` /
   `_CAPTURED_CLAIMED` / `_SELF_AUTHORIZED`), its `reviewedOutcome` is a closed-enum value
   (`_OUTCOME_INVALID`), and it carries all six chain bindings (`_BINDINGS_INCOMPLETE`). **Every failure here
   is a `NOT_CLOSEABLE` chain, never an `INVALID` closure record.**
   These semantic checks are not redundant behind the digest check: a self-digest is **not a signature**, so a
   forged disposition that rebuilds its own digest cleanly walks straight into them — which is why they are
   tested against an actual seven-case forgery.

   **Upstream semantic validation.** As in Phase 234, the headline fields alone are not enough: a forged report
   can keep a green `overall` over a body that failed Phase 234's own checks and recompute its digest cleanly.
   Phase 235 therefore also requires every upstream success boolean, a decision consistent with that headline,
   redaction-safety and an empty blocker list — `DISPOSITION_RECORD_NOT_REDACTION_SAFE`,
   `_DECISION_NOT_ACCEPTED`, `_UPSTREAM_NOT_REVIEWABLE`, `_NOT_WELL_FORMED`, `_INPUT_NOT_REDACTION_SAFE`,
   `_NOT_BOUND`, `_NOT_COHERENT`, `_BLOCKERS_PRESENT`. All are `NOT_CLOSEABLE`, never `INVALID`.

2. **Closure shape** (`closureWellFormed`) — exactly one object (`CLOSURE_MISSING` / `CLOSURE_NOT_SINGLE` /
   `CLOSURE_INVALID`), only allowlisted keys (`CLOSURE_UNKNOWN_FIELD`), correct fixed literals
   (`CLOSURE_VERSION_UNSUPPORTED` / `_OPERATION_MISMATCH` / `_SOURCE_RECORD_MISMATCH` /
   `_DISPOSITION_DIGEST_INVALID`), a closed-enum outcome (`CLOSURE_CLOSED_OUTCOME_INVALID`), and exactly the
   five fields with enum values (`CLOSURE_FIELDS_INVALID` / `CLOSURE_FIELD_STATE_INVALID`).
3. **Redaction safety** (`closureRedactionSafe`) — the **whole supplied value** is deep-scanned (iteratively,
   cycle-safe) for any string naming a live/network/media surface or raw path (`CLOSURE_LIVE_SURFACE`). A
   human writes this while archiving the evidence, so it is a likely place for a real path to leak in; a
   smuggled path fails closed and is never echoed back.
4. **Chain binding** (`closureBound`) — the closure names the disposition by its own `dispositionDigest`
   (`CLOSURE_NOT_BOUND_TO_DISPOSITION`) **and** carries each of the five operation digests that record bound
   (`CLOSURE_APPROVAL_ID_DIGEST_MISMATCH` / `_ITEM_DIGEST_` / `_SOURCE_DIGEST_` / `_DESTINATION_DIGEST_` /
   `_PLAN_DIGEST_MISMATCH`). Same transplantation defence as Phases 232–234.
5. **Coherence** (`closureCoherent`) — the archival rule above, plus: the closure must close the outcome that
   was actually dispositioned (`CLOSURE_CLOSED_OUTCOME_MISMATCH`), and a decided closure names its closer by
   sha256 digest and a strict `YYYY-MM-DDTHH:MM:SSZ` time (`CLOSURE_CLOSER_DIGEST_REQUIRED` /
   `CLOSURE_CLOSED_AT_REQUIRED`) while an undecided one claims neither (`_NOT_PENDING` variants). Partial
   affirmation mid-close is legitimate and simply stays `PENDING`.

## Outcomes

| `overall` | Meaning | Exit |
| --- | --- | --- |
| `OPERATION_CLOSURE_CLOSED` | a valid, chain-bound human closure exists for this one operation | `0` |
| `OPERATION_CLOSURE_INVALID` | the chain is closeable but the supplied record is broken | `1` |
| (input read error) | a supplied file is missing or not valid JSON | `2` |
| `OPERATION_CLOSURE_PENDING` | valid record, undecided | `3` |
| `OPERATION_CLOSURE_HELD_OPEN` | valid record, the operation is deliberately held open | `4` |
| `OPERATION_CLOSURE_NOT_CLOSEABLE` | the chain has nothing to close | `5` |

Only exit `0` means the operation is closed out. In **all** cases `closedByThisTool`, `archivedByThisTool`,
`purgedByThisTool` and `selfAuthorized` are `false`. The report deliberately carries **no** `evidencePurged`
field: whether the evidence still exists is a fact about the world this validator never touches and must not
attest to. What the supplied record *claimed* is visible in `fieldStates.evidencePurged`.

## Usage

```
npm run ops:promotion-operation-closure-record -- \
  --dispositionrecord disposition-report.json \
  [--closure  p227-a.operation-closure.json] \
  [--out      operation-closure-report.json] \
  [--skeletonout p227-a.operation-closure.blank.json]
```

## Current state of the prepared P227-A run

**Never run, never observed, never reviewed, and not closeable.** The real chain stops three phases earlier:
no human approved it, so Phase 232 is `PENDING`, Phase 233 is `INVALID`, and Phase 234 is `NOT_REVIEWABLE`.
Run against that record, this validator returns `OPERATION_CLOSURE_NOT_CLOSEABLE` with
`DISPOSITION_RECORD_NOT_ACCEPTED`, `recordedClosure: "NONE"`, `operationClosed: false` — and
`buildOperationClosureSkeleton` returns `null`, so not even a blank closure can be emitted for it. It stays
`NOT_CLOSEABLE` even when handed a fully-formed `CLOSED` record shaped for the real operation. Both states are
locked as offline fixtures in the test suite. No approved authorization, recorded observation, accepted
disposition, or closure is constructed for the real bundle anywhere in this repository.

## What the chain does and does not prove

It proves **internal consistency and non-transplantation**: every record recomputes, each is bound by digest
to exactly one operation and to the record above it, and no record can be replayed against a different
operation, item, or re-planned run.

It does **not** prove **authorship or authenticity**. These are self-digests, not signatures — a party who
controls the whole chain can fabricate a self-consistent one, and the semantic checks at each layer are what
limit (not eliminate) that. Binding a record to a real human would require out-of-band signing, which this
stack deliberately does not attempt; the `operatorDigest` / `observerDigest` / `reviewerDigest` /
`closerDigest` fields are opaque references to an identity established elsewhere, not proof of it.

## Tests

`test/promotion-operation-closure-record.ts` (also `npm run test:phase235-local`), 18 tests over a
**synthetic** chain plus the real-bundle fixtures: a recorded `CLOSED` closure that still archives and purges
nothing; fail-closed-by-default; the blank skeleton validating as `PENDING` and affirming nothing;
`NOT_CLOSEABLE` over a `PENDING` **or** `REJECTED` disposition; `NOT_CLOSEABLE` taking precedence over a
broken closure record and over an absent disposition; **the security case** — a closure transplanted onto a
different disposition is rejected; a green-bodied but tampered Phase 234 record → digest mismatch; a
**forged** Phase 234 record that recomputes its own digest cleanly and is caught only by the semantic checks;
**the archival rule** across all three decisions plus an explicitly `REFUSED` purge field; closing without
archival or with remediation outstanding; `HELD_OPEN` remaining available in a state where `CLOSED` is proven
impossible; closing a different outcome than was dispositioned, including a withdrawn `FAILED` run closed
correctly; closer/timestamp discipline in both directions plus a legitimate part-done close; a smuggled raw
path never echoed and an off-allowlist field rejected on its own merits; malformed enums, a missing field, a
bad version and a non-single record; a redaction-safe CLI across all six exit paths; and two locked fixtures
over the **actual** captured P227-A evidence proving it cannot be closed.

## What this phase deliberately does NOT do

It does not close, archive, purge, remediate, or review anything; it does not create or infer a closure; it
does not run the promotion launcher, read or write the real Movies library, or contact Jellyfin; it does not
read the secret approval file; and it does not merge, tag, push, or authorize Phase 231. Those remain separate
human steps, preserved behind the live boundary.
