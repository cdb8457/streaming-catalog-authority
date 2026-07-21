# Phase 232: Human Execution-Authorization Record for the Prepared P227-A Promotion (local, non-live)

Report id: `phase-232-promotion-execution-authorization-record`

Status: `PHASE_232_PROMOTION_EXECUTION_AUTHORIZATION_RECORD_READY`

A **fail-closed** local validator for the **human decision record** that would authorize the single
prepared **P227-A** real-library promotion. It consumes the Phase 231 digest-bound execution-authorization
template (`phase-231-promotion-execution-authorization`) and validates a **separately supplied** operator
decision record for exactly one `promote → observe → withdraw` operation.

**Building this mechanism is not granting authorization.** This phase adds the ability to *check* a record
a human wrote; it creates none. No `APPROVED` record exists or is inferred for the real P227-A run, the
prepared run is **not** marked authorized, and the actual captured artifacts stay `PENDING` / `NONE`.

Even the strongest outcome, `EXECUTION_AUTHORIZATION_RECORD_APPROVED`, means only that a well-formed,
digest-bound human decision record exists for that one operation. The report's `execution` field is the
constant `NOT_PERFORMED` and `capturedArtifacts` is the constant `NONE`: the run itself and its evidence
capture remain separate human operator steps this validator neither performs nor authorizes.

## Boundary (what it never does)

- It **never creates, infers, completes, or upgrades a decision.** `--skeletonout` emits only an
  all-`PENDING` blank record for a human to fill in; it can never produce a decided — let alone approved —
  record.
- It **never runs** `deploy/unraid-real-library-promotion.sh` or any promotion launcher.
- It **never reads or writes** the real Movies library (`/mnt/user/media/Movies`).
- It **never contacts** live Jellyfin (no HTTP, no scan, no network).
- It **never reads the secret approval file** (`p227-a.approval.json`).
- It **never self-authorizes**, merges, tags, or pushes.

It reads parsed JSON only and is deterministic. The emitted report is **redaction-safe**: digests, fixed
codes, fixed enum states, and per-check booleans only — never a raw path, raw item id, raw approval id, or
operator identity (not even the operator digest is echoed back).

## Inputs

| CLI flag | Value |
| --- | --- |
| `--gate` | the Phase 231 report (`phase-231-promotion-execution-authorization`) |
| `--record` | the operator's decision record (`phase-232-promotion-execution-authorization-record-input`) |
| `--out` | optional path for the full validation report |
| `--skeletonout` | optional path to write a blank, all-`PENDING` record for a human to complete |

## The record a human completes

Digest-only — it names no path, no id, and no operator identity. Strictly allowlisted: any key outside this
set fails closed.

```json
{
  "record": "phase-232-promotion-execution-authorization-record-input",
  "version": 1,
  "operation": "promote-observe-withdraw",
  "sourceGate": "phase-231-promotion-execution-authorization",
  "authorizationDigest": "<the gate's own authorizationDigest>",
  "approvalIdDigest": "<from the gate template>",
  "itemDigest": "<from the gate template>",
  "sourceDigest": "<from the gate template>",
  "destinationDigest": "<from the gate template>",
  "planDigest": "<from the gate template>",
  "decision": "PENDING",
  "operatorDigest": "PENDING",
  "decidedAtUtc": "PENDING",
  "fields": {
    "operatorAuthorized": "PENDING",
    "observedStateWitnessedBefore": "PENDING",
    "withdrawalPathRehearsed": "PENDING",
    "observedStateWitnessedAfter": "PENDING",
    "runExecutedByHuman": "PENDING"
  }
}
```

`decision` ∈ `APPROVED | DECLINED | PENDING`; every `fields` value ∈ `PENDING | AFFIRMED | REFUSED`.

## What it checks (all must hold before any decision is recorded)

1. **Gate validity** (`gateValid`) — the gate is present, is
   `phase-231-promotion-execution-authorization`, its self-digest recomputes (`GATE_DIGEST_MISMATCH`), it is
   `EXECUTION_AUTHORIZATION_TEMPLATE_READY` (`GATE_NOT_TEMPLATE_READY`), it authorized nothing
   (`authorization: "NONE"`, `status: "PENDING"` — `GATE_AUTHORIZATION_NOT_NONE` / `GATE_STATUS_NOT_PENDING`),
   and it carries a template for `promote-observe-withdraw`, on the approved root, with all five fields still
   `PENDING` and five well-formed digests (`GATE_TEMPLATE_MISSING` / `_OPERATION_MISMATCH` / `_NOT_PENDING` /
   `_ROOT_NOT_APPROVED` / `_FIELDS_NOT_PENDING` / `_DIGEST_INVALID`). **A record can only be bound to a gate
   that itself authorized nothing.**
2. **Record shape** (`recordWellFormed`) — exactly one object (`RECORD_MISSING` / `RECORD_NOT_SINGLE` /
   `RECORD_INVALID`), only allowlisted keys (`RECORD_UNKNOWN_FIELD`), correct fixed literals
   (`RECORD_VERSION_UNSUPPORTED` / `RECORD_OPERATION_MISMATCH` / `RECORD_SOURCE_GATE_MISMATCH`), a decision
   from the closed enum (`RECORD_DECISION_INVALID`), and exactly the five fields with enum values
   (`RECORD_FIELDS_INVALID` / `RECORD_FIELD_STATE_INVALID`).
3. **Redaction safety** (`recordRedactionSafe`) — the **whole supplied value** is deep-scanned (iteratively,
   cycle-safe) for any string naming a live/network/media surface or a raw path (`RECORD_LIVE_SURFACE`). A
   human writes this record by hand, so it is the likeliest place for a real path to leak in; a smuggled path
   fails closed and is never echoed back.
4. **Digest binding** (`recordBound`) — the record names the gate by the gate's own `authorizationDigest`
   (`RECORD_NOT_BOUND_TO_GATE`) **and** carries each of the five operation digests from the gate's template
   (`RECORD_APPROVAL_ID_DIGEST_MISMATCH` / `_ITEM_DIGEST_` / `_SOURCE_DIGEST_` / `_DESTINATION_DIGEST_` /
   `_PLAN_DIGEST_MISMATCH`). **This is the record-transplantation defence**: a genuine approval of one
   operation cannot be replayed against a different gate, a different item, or a re-planned run.
5. **Decision coherence** (`decisionCoherent`) —
   - the post-run fields `observedStateWitnessedAfter` and `runExecutedByHuman` must be `PENDING` **in every
     valid record regardless of decision** (`RECORD_POST_RUN_FIELD_NOT_PENDING`): this mechanism records an
     authorization decision, **never an execution**;
   - `APPROVED` requires all three pre-run fields (`operatorAuthorized`, `observedStateWitnessedBefore`,
     `withdrawalPathRehearsed`) to be `AFFIRMED` (`RECORD_APPROVED_WITHOUT_PRE_RUN_AFFIRMATION`);
   - `DECLINED` requires `operatorAuthorized: "REFUSED"` (`RECORD_DECLINED_WITHOUT_REFUSED_AUTHORIZATION`);
   - `PENDING` requires `operatorAuthorized: "PENDING"` (`RECORD_PENDING_WITH_DECIDED_AUTHORIZATION`) — an
     authorization is never inferred from a field;
   - a decided record must name **who** (a sha256 operator digest) and **when** (a strict
     `YYYY-MM-DDTHH:MM:SSZ` timestamp) — `RECORD_OPERATOR_DIGEST_REQUIRED` / `RECORD_DECIDED_AT_REQUIRED`;
     an undecided one must claim neither (`RECORD_OPERATOR_DIGEST_NOT_PENDING` /
     `RECORD_DECIDED_AT_NOT_PENDING`).

Any failure yields `EXECUTION_AUTHORIZATION_RECORD_INVALID`, the specific value-free blocker codes,
`recordedDecision: "NONE"`, and `authorizationRecorded: false` (fail closed — no decision is recorded unless
every check is green).

## Outcomes

| `overall` | Meaning | Exit |
| --- | --- | --- |
| `EXECUTION_AUTHORIZATION_RECORD_APPROVED` | a valid, digest-bound human approval record exists for this one operation | `0` |
| `EXECUTION_AUTHORIZATION_RECORD_INVALID` | fail closed — nothing recorded | `1` |
| (input read error) | a supplied file is missing or not valid JSON | `2` |
| `EXECUTION_AUTHORIZATION_RECORD_PENDING` | valid record, no authorization recorded | `3` |
| `EXECUTION_AUTHORIZATION_RECORD_DECLINED` | valid record, the operator refused | `4` |

Only exit `0` means an authorization record exists; every other exit means it does not. In **all** cases
`execution: "NOT_PERFORMED"`, `capturedArtifacts: "NONE"`, and `selfAuthorized: false`.

## Usage

```
npm run ops:promotion-execution-authorization-record -- \
  --gate   execution-authorization.json \
  [--record p227-a.execution-authorization-record.json] \
  [--out    execution-authorization-record-report.json] \
  [--skeletonout p227-a.execution-authorization-record.blank.json]
```

## Current state of the prepared P227-A run

**Not authorized.** No operator decision record exists for it. Run against the real prepared gate with no
record, the validator returns `EXECUTION_AUTHORIZATION_RECORD_INVALID` / `RECORD_MISSING`; run against a
blank skeleton it returns `EXECUTION_AUTHORIZATION_RECORD_PENDING`. Both are locked as offline fixtures in
the test suite, and `authorizationRecorded` is `false` in both. No `APPROVED` record is constructed for the
real bundle anywhere in this repository.

## Tests

`test/promotion-execution-authorization-record.ts` (also `npm run test:phase232-local`): a valid approval
over a **synthetic** gate that still performs no run; fail-closed-by-default; the blank skeleton validating
as `PENDING`; **the security case** — a genuine approval transplanted onto a different operation is
rejected; a green-bodied but tampered gate → digest mismatch; a record claiming the run already executed →
rejected; `APPROVED` without every pre-run affirmation → rejected; a valid `DECLINED` record and a
contradictory one; an undecided record that quietly affirms authorization → rejected; operator-digest and
timestamp discipline; a smuggled raw path → fails closed and is never echoed; no record can bind to a
`BLOCKED` gate and no skeleton is emitted for one; a redaction-safe CLI check across all four exit paths;
and two locked offline fixtures over the **actual** captured P227-A evidence asserting the real run is
`INVALID`/`RECORD_MISSING` without a record and `PENDING` with a blank one — never `APPROVED`.

## What this phase deliberately does NOT do

It does not authorize, schedule, or perform the P227-A promotion; it does not create or infer an `APPROVED`
record; it does not mark the prepared run authorized; it does not run the promotion launcher, read or write
the real Movies library, or contact Jellyfin; it does not read the secret approval file; and it does not
merge, tag, or push. Those remain separate human steps, preserved behind the live boundary.
