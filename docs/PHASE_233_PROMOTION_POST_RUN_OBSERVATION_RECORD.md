# Phase 233: Post-Run Observation and Withdrawal Record for the Prepared P227-A Promotion (local, non-live)

Report id: `phase-233-promotion-post-run-observation-record`

Status: `PHASE_233_PROMOTION_POST_RUN_OBSERVATION_RECORD_READY`

A **fail-closed** local validator for the **human observation record** of what actually happened during the
single prepared **P227-A** `promote → observe → withdraw` operation. It consumes the Phase 232 human
execution-authorization record (`phase-232-promotion-execution-authorization-record`) and validates a
**separately supplied**, human-produced post-run observation bound to that one authorization.

**This validator observes nothing.** `performedByThisTool` and `capturedByThisTool` are the constants
`false`: it never runs the promotion, never captures observed state, never performs or triggers a
withdrawal. It only checks a record a human produced out-of-band, and it creates or infers no claim of its
own. `POST_RUN_OBSERVATION_RECORDED` means a coherent human observation *exists* — it is not itself evidence
that the run occurred.

An observation can only exist for a run that was **provably authorized for exactly this one operation**: the
Phase 232 record must be a genuine `EXECUTION_AUTHORIZATION_RECORD_APPROVED` report that itself performed and
captured nothing. No such record exists for the real P227-A run.

## Boundary (what it never does)

- It **never performs, triggers, or schedules** a run or a withdrawal.
- It **never captures** observed state; every observed-state digest it checks was produced by a human.
- It **never creates, infers, completes, or upgrades** an observation, an outcome, or a withdrawal claim.
  `--skeletonout` emits only a `NOT_RUN`, all-`PENDING` blank observation.
- It **never runs** `deploy/unraid-real-library-promotion.sh` or any promotion launcher.
- It **never reads or writes** the real Movies library (`/mnt/user/media/Movies`).
- It **never contacts** live Jellyfin, and **never reads the secret approval file**.

It reads parsed JSON only and is deterministic. The emitted report is **redaction-safe**: authorization-chain
digests, fixed codes, closed enum states, booleans and presence markers only — never a raw path, raw item id,
raw approval id, observer identity, or **the human's own observed-state digests** (only their presence is
echoed).

## Inputs

| CLI flag | Value |
| --- | --- |
| `--authorizationrecord` | the Phase 232 report (`phase-232-promotion-execution-authorization-record`) |
| `--observation` | the human observation (`phase-233-promotion-post-run-observation-record-input`) |
| `--out` | optional path for the full validation report |
| `--skeletonout` | optional path for a blank, `NOT_RUN`/all-`PENDING` observation to complete |

## The record a human completes

Digest-only. Strictly allowlisted: any key outside this set fails closed.

```json
{
  "record": "phase-233-promotion-post-run-observation-record-input",
  "version": 1,
  "operation": "promote-observe-withdraw",
  "sourceAuthorizationRecord": "phase-232-promotion-execution-authorization-record",
  "recordDigest": "<the Phase 232 report's own recordDigest>",
  "approvalIdDigest": "<from the Phase 232 boundDigests>",
  "itemDigest": "<from the Phase 232 boundDigests>",
  "sourceDigest": "<from the Phase 232 boundDigests>",
  "destinationDigest": "<from the Phase 232 boundDigests>",
  "planDigest": "<from the Phase 232 boundDigests>",
  "observedRunOutcome": "NOT_RUN",
  "observedStateBeforeDigest": "PENDING",
  "observedStateAfterDigest": "PENDING",
  "observedStateAfterWithdrawalDigest": "PENDING",
  "withdrawal": "NOT_REQUIRED",
  "preexistingPreserved": "PENDING",
  "withdrewOnlyRunCreatedMaterialization": "PENDING",
  "observerDigest": "PENDING",
  "observedAtUtc": "PENDING"
}
```

`observedRunOutcome` ∈ `NOT_RUN | COMPLETED | FAILED`; `withdrawal` ∈
`NOT_REQUIRED | PENDING | PERFORMED | REFUSED`; every observed state is a sha256 **or** the literal
`PENDING`; each blast-radius assertion is `true`, `false`, **or** `PENDING`.

Note what the skeleton does **not** contain: nothing in it is `true`. The two blast-radius assertions ship
as `PENDING`, because they assert that the real library survived a run intact and only the human who watched
that run may make them. A skeleton that pre-filled them as `true` would be pre-filled consent.

## What it checks (all must hold before any observation is recorded)

1. **Authorization validity** (`authorizationValid`) — the Phase 232 record is present, is
   `phase-232-promotion-execution-authorization-record`, its self-digest recomputes
   (`AUTHORIZATION_RECORD_DIGEST_MISMATCH`), it is `EXECUTION_AUTHORIZATION_RECORD_APPROVED` with
   `recordedDecision: "APPROVED"` (`AUTHORIZATION_RECORD_NOT_APPROVED`) and `authorizationRecorded: true`
   (`AUTHORIZATION_RECORD_NOT_RECORDED`), it still claims to have performed and captured nothing
   (`AUTHORIZATION_RECORD_EXECUTION_CLAIMED` / `_ARTIFACTS_CLAIMED` / `_SELF_AUTHORIZED`), and it carries all
   six chain bindings (`AUTHORIZATION_RECORD_BINDINGS_INCOMPLETE`). **An observation may only exist over an
   approved authorization.** The semantic checks are not redundant behind the digest check: a self-digest is
   **not a signature**, so anyone can recompute one. A forged authorization claiming it had already executed
   passes the digest check cleanly and is stopped only by `_EXECUTION_CLAIMED` / `_ARTIFACTS_CLAIMED` /
   `_SELF_AUTHORIZED` / `_BINDINGS_INCOMPLETE`, which is why they are tested against an actual forgery.
2. **Observation shape** (`observationWellFormed`) — exactly one object (`OBSERVATION_MISSING` /
   `OBSERVATION_NOT_SINGLE` / `OBSERVATION_INVALID`), only allowlisted keys (`OBSERVATION_UNKNOWN_FIELD`),
   correct fixed literals (`OBSERVATION_VERSION_UNSUPPORTED` / `_OPERATION_MISMATCH` /
   `_SOURCE_RECORD_MISMATCH` / `_RECORD_DIGEST_INVALID`), closed enums (`OBSERVATION_OUTCOME_INVALID` /
   `OBSERVATION_WITHDRAWAL_INVALID`), every observed state a sha256 or `PENDING`
   (`OBSERVATION_STATE_DIGEST_INVALID`), each blast-radius assertion boolean or `PENDING`
   (`OBSERVATION_ASSERTION_INVALID`).
3. **Redaction safety** (`observationRedactionSafe`) — the **whole supplied value** is deep-scanned
   (iteratively, cycle-safe) for any string naming a live/network/media surface or raw path
   (`OBSERVATION_LIVE_SURFACE`). A human writes this immediately after standing in front of the real library,
   so it is the likeliest leak of all; a smuggled path fails closed and is never echoed back.
4. **Chain binding** (`observationBound`) — the observation names the authorization by its own `recordDigest`
   (`OBSERVATION_NOT_BOUND_TO_AUTHORIZATION`) **and** carries each of the five operation digests that record
   bound (`OBSERVATION_APPROVAL_ID_DIGEST_MISMATCH` / `_ITEM_DIGEST_` / `_SOURCE_DIGEST_` /
   `_DESTINATION_DIGEST_` / `_PLAN_DIGEST_MISMATCH`). Same record-transplantation defence as Phase 232: an
   observation of one operation cannot be replayed against a different authorization.
5. **Coherence** (`observationCoherent`) —
   - **`NOT_RUN` is total**: no observed-state digest of any kind, `withdrawal: "NOT_REQUIRED"`, and both
     blast-radius assertions still `PENDING` — nothing ran, so there is nothing to assert
     (`OBSERVATION_NOT_RUN_CLAIMS_OBSERVED_STATE` / `OBSERVATION_NOT_RUN_WITHDRAWAL_NOT_NOT_REQUIRED` /
     `OBSERVATION_NOT_RUN_ASSERTION_NOT_PENDING`);
   - **`COMPLETED`** requires both a before and an after digest
     (`OBSERVATION_COMPLETED_WITHOUT_OBSERVED_STATE`) **and** `after !== before`
     (`OBSERVATION_COMPLETED_WITHOUT_OBSERVED_CHANGE`) — a promotion that changed nothing observable is not a
     completed promotion;
   - **`FAILED`** requires both digests too (`OBSERVATION_FAILED_WITHOUT_OBSERVED_STATE`) — what the state
     was, and what the failed run left behind — but imposes no change requirement, since a clean failure
     changes nothing;
   - **the withdrawal proof** — `withdrawal: "PERFORMED"` requires
     `observedStateAfterWithdrawalDigest === observedStateBeforeDigest`
     (`WITHDRAWAL_DID_NOT_RESTORE_OBSERVED_STATE`), and only `PERFORMED` may cite an after-withdrawal state
     at all (`OBSERVATION_WITHDRAWAL_STATE_WITHOUT_PERFORMED_WITHDRAWAL`);
   - **preexisting protection** — for any observed run the human must actively assert
     `preexistingPreserved: true` and `withdrewOnlyRunCreatedMaterialization: true`
     (`OBSERVATION_PREEXISTING_NOT_PRESERVED` / `OBSERVATION_WITHDREW_BEYOND_RUN_CREATED_MATERIALIZATION`);
     these are never pre-affirmed by anything this module emits;
   - **who and when** — an observation of a real run names its observer by sha256 digest and a strict
     `YYYY-MM-DDTHH:MM:SSZ` time (`OBSERVATION_OBSERVER_DIGEST_REQUIRED` / `OBSERVATION_OBSERVED_AT_REQUIRED`);
     a `NOT_RUN` observation claims neither (`OBSERVATION_OBSERVER_DIGEST_NOT_PENDING` /
     `OBSERVATION_OBSERVED_AT_NOT_PENDING`).

Any failure yields `POST_RUN_OBSERVATION_INVALID`, the specific value-free blocker codes,
`recordedOutcome: "NONE"`, `observationRecorded: false`, and `withdrawalProven: false`.

### The withdrawal proof

This is the headline invariant of the phase. A withdrawal is not a claim; it is a **restoration**. The
observed state after withdrawal must equal, digest for digest, the observed state captured before the run.
Anything else — a different state, or no after-withdrawal observation at all — is
`WITHDRAWAL_DID_NOT_RESTORE_OBSERVED_STATE` and fails closed. `withdrawalProven` is `true` only when a valid
record claims `PERFORMED` **and** that equality holds.

## Outcomes

| `overall` | Meaning | Exit |
| --- | --- | --- |
| `POST_RUN_OBSERVATION_RECORDED` | a coherent, chain-bound human observation of a `COMPLETED` or `FAILED` run exists | `0` |
| `POST_RUN_OBSERVATION_INVALID` | fail closed — nothing recorded | `1` |
| (input read error) | a supplied file is missing or not valid JSON | `2` |
| `POST_RUN_OBSERVATION_PENDING` | valid record, but `NOT_RUN`: nothing was run or observed | `3` |

In **all** cases `performedByThisTool: false`, `capturedByThisTool: false`, `selfAuthorized: false`.

## Usage

```
npm run ops:promotion-post-run-observation-record -- \
  --authorizationrecord execution-authorization-record-report.json \
  [--observation  p227-a.post-run-observation.json] \
  [--out          post-run-observation-report.json] \
  [--skeletonout  p227-a.post-run-observation.blank.json]
```

## Current state of the prepared P227-A run

**Never run, never observed, and not observable.** The real chain stops one phase earlier: no human has
approved it, so the real Phase 232 record is `EXECUTION_AUTHORIZATION_RECORD_PENDING`, not `APPROVED`. Run
against that record, this validator returns `POST_RUN_OBSERVATION_INVALID` with
`AUTHORIZATION_RECORD_NOT_APPROVED`, `recordedOutcome: "NONE"`, and `withdrawalProven: false` — and
`buildPostRunObservationSkeleton` returns `null`, so not even a blank observation can be emitted for it. Both
states are locked as offline fixtures in the test suite. No observation record, and no approved authorization,
is constructed for the real bundle anywhere in this repository.

## Tests

`test/promotion-post-run-observation-record.ts` (also `npm run test:phase233-local`), 18 tests over a
**synthetic** chain plus the real-bundle fixtures: a recorded `COMPLETED` observation that still performs and
captures nothing; fail-closed-by-default; the blank skeleton validating as `PENDING` and asserting nothing as
`true`; no observation over a non-`APPROVED` authorization; **the security case** — an observation transplanted
onto a different authorization is rejected; a green-bodied but tampered Phase 232 record → digest mismatch; a
**forged** authorization that recomputes its own digest cleanly and is caught only by the semantic checks;
`COMPLETED` with an
unchanged or unobserved state; **the withdrawal proof** in all four directions (unrestored, unobserved,
restored-and-proven, and an after-withdrawal state cited without a `PERFORMED` withdrawal); a withdrawal that
touched preexisting content or overreached; `NOT_RUN` claiming state or a withdrawal; a recordable clean
`FAILED` run versus an unobserved one; observer/timestamp discipline in both directions; a smuggled raw path
never echoed, and an off-allowlist field rejected on its own merits; malformed enums, non-digest state, and a
non-single record; a redaction-safe CLI across all four exit paths; and two locked fixtures over the **actual**
captured P227-A evidence proving it cannot have an observation.

## What this phase deliberately does NOT do

It does not run, re-run, or withdraw anything; it does not capture observed state; it does not create or infer
an observation, outcome, or withdrawal claim; it does not authorize the P227-A promotion or upgrade the Phase
232 record; it does not read or write the real Movies library, contact Jellyfin, or read the secret approval
file; and it does not merge, tag, or push. Those remain separate human steps, preserved behind the live
boundary.

**Deliberately not expressible:** an "observed the before-state, then chose not to run" record. `NOT_RUN` is
total — nothing run, nothing observed, nobody named. An abort-after-observing disposition would need its own
record type rather than a loosened `NOT_RUN`, which would otherwise become a place to park unattributed
observations.
