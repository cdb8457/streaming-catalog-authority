# Phase 234: Post-Run Disposition Review Record for the Prepared P227-A Promotion (local, non-live)

Report id: `phase-234-promotion-post-run-disposition-record`

Status: `PHASE_234_PROMOTION_POST_RUN_DISPOSITION_RECORD_READY`

A **fail-closed** local validator for the **human review** of a post-run observation. It consumes the Phase
233 observation record (`phase-233-promotion-post-run-observation-record`) and validates a **separately
supplied** operator disposition — accept the outcome, reject it, or leave it undecided — for exactly one
`promote → observe → withdraw` operation.

It **reviews nothing itself.** `reviewedByThisTool`, `performedByThisTool`, `capturedByThisTool` and
`selfAuthorized` are the constants false: this validator forms no judgement, runs nothing, captures nothing,
and remediates nothing. It only checks a record a human produced out-of-band, and it creates or infers no
claim of its own.

## `NOT_REVIEWABLE` — the outcome that locks the real chain

`POST_RUN_DISPOSITION_NOT_REVIEWABLE` is deliberately **distinct from** `INVALID`:

- **`NOT_REVIEWABLE`** — the **chain** has nothing to review. The upstream observation is absent, not
  genuine, or not `RECORDED`, so no disposition over it can mean anything.
- **`INVALID`** — the chain *is* reviewable, but the **supplied disposition record** is broken.

`NOT_REVIEWABLE` takes **precedence over everything**. When the observation is not reviewable the verdict is
`NOT_REVIEWABLE` no matter what the disposition claims — a defect in a review of nothing is not the finding;
the emptiness of the chain is. That is what locks the actual prepared P227-A chain, which remains
**unauthorized, unrun and unobserved**: it can never land anywhere else.

## Boundary (what it never does)

- It **never creates, infers, completes, or upgrades a disposition.** `--skeletonout` emits only an
  all-`PENDING` blank for a human to fill in.
- It **never remediates anything** — `remediationPerformed` must stay `PENDING` in every valid record.
- It **never runs** `deploy/unraid-real-library-promotion.sh` or any promotion or withdrawal.
- It **never reads or writes** the real Movies library (`/mnt/user/media/Movies`).
- It **never contacts** live Jellyfin (no HTTP, no scan, no network).
- It **never reads the secret approval file** (`p227-a.approval.json`).
- It **never self-authorizes**, merges, tags, pushes, or authorizes Phase 231.

It reads parsed JSON only and is deterministic. The emitted report is **redaction-safe**: chain digests,
fixed codes, closed enum states and booleans only — never a raw path, raw item id, raw approval id, reviewer
identity, or the upstream observed-state digests.

## Inputs

| CLI flag | Value |
| --- | --- |
| `--observationrecord` | the Phase 233 report (`phase-233-promotion-post-run-observation-record`) |
| `--disposition` | the operator's review record (`phase-234-promotion-post-run-disposition-record-input`) |
| `--out` | optional path for the full validation report |
| `--skeletonout` | optional path for a blank, all-`PENDING` disposition to complete |

## The record a human completes

Digest-only — it names no path, no id, and no reviewer identity. Strictly allowlisted: any key outside this
set fails closed.

```json
{
  "record": "phase-234-promotion-post-run-disposition-record-input",
  "version": 1,
  "operation": "promote-observe-withdraw",
  "sourceObservationRecord": "phase-233-promotion-post-run-observation-record",
  "observationDigest": "<the Phase 233 report's own observationDigest>",
  "approvalIdDigest": "<from the Phase 233 boundDigests>",
  "itemDigest": "<from the Phase 233 boundDigests>",
  "sourceDigest": "<from the Phase 233 boundDigests>",
  "destinationDigest": "<from the Phase 233 boundDigests>",
  "planDigest": "<from the Phase 233 boundDigests>",
  "reviewedOutcome": "COMPLETED",
  "reviewedWithdrawal": "NOT_REQUIRED",
  "fields": {
    "outcomeAccepted": "PENDING",
    "observedOutcomeReviewed": "PENDING",
    "preexistingIntegrityConfirmed": "PENDING",
    "evidenceRetainedOutOfBand": "PENDING",
    "remediationPerformed": "PENDING"
  },
  "reviewerDigest": "PENDING",
  "reviewedAtUtc": "PENDING"
}
```

Every `fields` value ∈ `PENDING | AFFIRMED | REFUSED`. **`outcomeAccepted` carries the decision itself** —
`AFFIRMED` → `ACCEPTED`, `REFUSED` → `REJECTED`, `PENDING` → `PENDING`. One source of truth, so a record can
never state a decision that contradicts its own fields.

Nothing in the skeleton is `true` or `AFFIRMED`; a human who signs it blind asserts nothing. `reviewedOutcome`
and `reviewedWithdrawal` **are** pre-filled, and deliberately so: like the digests, they are derived bindings
copied from the upstream record naming **what** is under review, not a judgement about it. The judgement lives
entirely in the all-`PENDING` `fields`.

## What it checks

**1. Observation reviewability** (`observationReviewable`) — the Phase 233 record is present, is
`phase-233-promotion-post-run-observation-record`, its self-digest recomputes
(`OBSERVATION_RECORD_DIGEST_MISMATCH`), it is `POST_RUN_OBSERVATION_RECORDED`
(`OBSERVATION_RECORD_NOT_RECORDED`) with `observationRecorded: true`
(`OBSERVATION_RECORD_NOT_MARKED_RECORDED`), it still claims to have performed, captured and authorized
nothing (`OBSERVATION_RECORD_PERFORMED_CLAIMED` / `_CAPTURED_CLAIMED` / `_SELF_AUTHORIZED`), its outcome and
withdrawal are closed-enum values with a boolean withdrawal proof (`OBSERVATION_RECORD_OUTCOME_INVALID` /
`_WITHDRAWAL_INVALID` / `_WITHDRAWAL_PROVEN_INVALID`), and it carries all six chain bindings
(`OBSERVATION_RECORD_BINDINGS_INCOMPLETE`). **Every failure here yields `NOT_REVIEWABLE`, never `INVALID`.**

   **Upstream semantic validation.** The headline fields are not enough: a self-digest is not a signature, so a
   forged report can keep a green `overall` over a body that failed Phase 233's own checks and still recompute
   its digest cleanly. Phase 234 therefore also requires the upstream report's own success booleans and an empty
   blocker list — `OBSERVATION_RECORD_NOT_REDACTION_SAFE`, `_NOT_WELL_FORMED`, `_INPUT_NOT_REDACTION_SAFE`,
   `_NOT_BOUND`, `_NOT_COHERENT`, `_BLOCKERS_PRESENT` — plus a withdrawal proof consistent with the withdrawal
   claimed: `withdrawalProven` must equal `recordedWithdrawal === "PERFORMED"`, biconditionally, or
   `OBSERVATION_RECORD_WITHDRAWAL_PROOF_INCONSISTENT` fires. Both directions — `PERFORMED` with an unproven
   withdrawal, and a proof claimed over a withdrawal that never happened — fail closed as `NOT_REVIEWABLE`.

These semantic checks are **not** redundant behind the digest check. A self-digest is **not a signature**, so
anyone can recompute one: a forged observation claiming it had already performed the run passes the digest
check cleanly and is stopped only by these checks — which is why they are tested against an actual forgery
that recomputes its own digest.

**2. Disposition shape** (`dispositionWellFormed`) — exactly one object (`DISPOSITION_MISSING` /
`_NOT_SINGLE` / `_INVALID`), only allowlisted keys (`DISPOSITION_UNKNOWN_FIELD`), correct fixed literals
(`DISPOSITION_VERSION_UNSUPPORTED` / `_OPERATION_MISMATCH` / `_SOURCE_RECORD_MISMATCH` /
`_OBSERVATION_DIGEST_INVALID`), closed echo enums (`DISPOSITION_REVIEWED_OUTCOME_INVALID` /
`_REVIEWED_WITHDRAWAL_INVALID`), and exactly the five fields with enum values (`DISPOSITION_FIELDS_INVALID` /
`_FIELD_STATE_INVALID`).

**3. Redaction safety** (`dispositionRedactionSafe`) — the **whole supplied value** is deep-scanned
(iteratively, cycle-safe) for any string naming a live/network/media surface or raw path
(`DISPOSITION_LIVE_SURFACE`); a smuggled path fails closed and is never echoed back.

**4. Chain binding** (`dispositionBound`) — the disposition names the observation by its own
`observationDigest` (`DISPOSITION_NOT_BOUND_TO_OBSERVATION`) **and** carries each of the five operation
digests that record bound (`DISPOSITION_APPROVAL_ID_DIGEST_MISMATCH` / `_ITEM_DIGEST_` / `_SOURCE_DIGEST_` /
`_DESTINATION_DIGEST_` / `_PLAN_DIGEST_MISMATCH`). Same record-transplantation defence as Phase 232/233: a
review of one operation cannot be replayed against a different observation.

**5. Coherence** (`dispositionCoherent`) —

- **no remediation, ever** — `remediationPerformed` must be `PENDING` in every valid record
  (`DISPOSITION_REMEDIATION_CLAIMED`); this phase reviews records and performs no remediation;
- **`ACCEPTED`** requires all three review fields (`observedOutcomeReviewed`,
  `preexistingIntegrityConfirmed`, `evidenceRetainedOutOfBand`) `AFFIRMED`
  (`DISPOSITION_ACCEPTED_WITHOUT_FULL_REVIEW`);
- **`REJECTED`** requires `observedOutcomeReviewed: "AFFIRMED"` (`DISPOSITION_REJECTED_WITHOUT_REVIEW`) — you
  must have reviewed the outcome to reject it; a blind rejection is not a review;
- **you must review what was observed** — `reviewedOutcome` must equal the observation's `recordedOutcome`
  and `reviewedWithdrawal` its `recordedWithdrawal` (`DISPOSITION_REVIEWED_OUTCOME_MISMATCH` /
  `_REVIEWED_WITHDRAWAL_MISMATCH`);
- **THE UNWITHDRAWN-FAILURE RULE** — a `FAILED` run may only be `ACCEPTED` once its withdrawal is **proven
  upstream** (Phase 233 `withdrawalProven`). Accepting a failed run that was never provably withdrawn would
  bless leftover residue in the real library, so it fails closed with
  `DISPOSITION_ACCEPTS_UNWITHDRAWN_FAILURE`. Rejection stays available for such a run at all times, and once
  the withdrawal *is* proven the same failed run becomes acceptable;
- **who and when** — a decided disposition names its reviewer by sha256 digest and a strict
  `YYYY-MM-DDTHH:MM:SSZ` time (`DISPOSITION_REVIEWER_DIGEST_REQUIRED` / `_REVIEWED_AT_REQUIRED`); an
  undecided one claims neither (`DISPOSITION_REVIEWER_DIGEST_NOT_PENDING` / `_REVIEWED_AT_NOT_PENDING`).

## Outcomes

| `overall` | Meaning | Exit |
| --- | --- | --- |
| `POST_RUN_DISPOSITION_ACCEPTED` | a valid, chain-bound human acceptance exists | `0` |
| `POST_RUN_DISPOSITION_INVALID` | the chain is reviewable but the disposition is broken | `1` |
| (input read error) | a supplied file is missing or not valid JSON | `2` |
| `POST_RUN_DISPOSITION_PENDING` | valid record, no decision yet | `3` |
| `POST_RUN_DISPOSITION_REJECTED` | valid record, the reviewer refused the outcome | `4` |
| `POST_RUN_DISPOSITION_NOT_REVIEWABLE` | the chain has nothing to review; no disposition can override it | `5` |

Only exit `0` means an acceptance exists. In **all** cases `reviewedByThisTool`, `performedByThisTool`,
`capturedByThisTool` and `selfAuthorized` are `false`.

## Usage

```
npm run ops:promotion-post-run-disposition-record -- \
  --observationrecord observation-report.json \
  [--disposition p227-a.post-run-disposition.json] \
  [--out          post-run-disposition-report.json] \
  [--skeletonout  p227-a.post-run-disposition.blank.json]
```

## Current state of the prepared P227-A run

**Locked `NOT_REVIEWABLE` — unauthorized, unrun, unobserved.** The real chain stops two phases earlier: no
human approved the run, so the real Phase 232 record is `EXECUTION_AUTHORIZATION_RECORD_PENDING`; with no
approval and no run there is no observation, so the real Phase 233 record is `POST_RUN_OBSERVATION_INVALID`.
Handed that record, this validator returns `POST_RUN_DISPOSITION_NOT_REVIEWABLE` with
`dispositionAccepted: false`, `recordedDisposition: "NONE"`, and `withdrawalProvenUpstream: false`, and
`buildPostRunDispositionSkeleton` returns `null` — not even a blank disposition can be emitted for it.

The lock cannot be talked out of: handed a **fully-formed, perfectly-shaped `ACCEPTED` disposition** naming
the real operation's digests, the verdict stays `NOT_REVIEWABLE` and nothing binds. Both states are locked as
offline fixtures. No approved authorization, no recorded observation, and no accepted disposition is
constructed for the real bundle anywhere in this repository.

## What the chain does and does not prove

It proves **internal consistency and non-transplantation**: every record recomputes, each is bound by digest
to exactly one operation and to the record above it, and no record can be replayed against a different
operation, item, or re-planned run.

It does **not** prove **authorship or authenticity**. These are self-digests, not signatures — a party who
controls the whole chain can fabricate a self-consistent one, and the semantic checks at each layer are what
limit (not eliminate) that. Binding a record to a real human would require out-of-band signing, which this
stack deliberately does not attempt; the `operatorDigest` / `observerDigest` / `reviewerDigest` fields are
opaque references to an identity established elsewhere, not proof of it.

## Tests

`test/promotion-post-run-disposition-record.ts` (also `npm run test:phase234-local`), 19 tests over a
**synthetic** chain plus the real-bundle locks: a recorded `ACCEPTED` disposition that still reviews nothing;
fail-closed-by-default; the blank skeleton pre-affirming nothing and validating as `PENDING`; a genuine but
`PENDING` observation being `NOT_REVIEWABLE` rather than `INVALID`; **`NOT_REVIEWABLE` precedence** over a
broken, absent or malformed disposition; **the security case** — a disposition transplanted onto a different
observation is rejected; a green-bodied but tampered Phase 233 record → digest mismatch; a **forged** Phase
233 record that recomputes its own digest cleanly and is caught only by the semantic checks (six mutations);
**the unwithdrawn-failure rule** in all four directions (unproven failure unacceptable, still rejectable,
acceptable once proven, and a completed run needing no proof); reviewing a different outcome or withdrawal
than observed; `ACCEPTED` without a full review; a valid `REJECTED` plus a blind one; a claimed remediation;
reviewer/timestamp discipline in both directions; a smuggled raw path never echoed and an off-allowlist field
rejected on its own; malformed enums, short `fields`, non-single records and an unsupported version; a
redaction-safe CLI across **all six** exit paths; and two locked fixtures over the **actual** captured P227-A
evidence proving the chain is `NOT_REVIEWABLE` and stays so.

## What this phase deliberately does NOT do

It does not accept, reject, or review the P227-A run; it does not construct an approved authorization, a
recorded observation, or an accepted disposition for the real bundle; it does not remediate anything; it does
not run the promotion launcher, read or write the real Movies library, or contact Jellyfin; it does not read
the secret approval file; and it does not merge, tag, push, or authorize Phase 231. Those remain separate
human steps, preserved behind the live boundary.
