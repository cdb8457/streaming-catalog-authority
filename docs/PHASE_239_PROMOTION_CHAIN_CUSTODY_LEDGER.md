# Phase 239: Append-Only Promotion-Chain Custody Ledger (local, non-live)

Report id: `phase-239-promotion-chain-custody-ledger`

Status: `PHASE_239_PROMOTION_CHAIN_CUSTODY_LEDGER_READY`

A **fail-closed** local validator for an **append-only custody ledger** over a Phase 238
`SOURCE_RECORDS_VERIFIED` result. It consumes a separately supplied array of human custody events and checks
them as a hash-linked chain: contiguous sequence from a genesis, each event naming the recomputed digest of
the one before it, a fixed transition enum, a custodian digest, a strict UTC time, and every chain binding
tied to this one operation.

It **never infers custody**. This module creates no event, completes no event and upgrades no ledger. The
genesis it can emit is blank — custodian and time `PENDING` — and a blank genesis is exactly the un-started
state, `CUSTODY_LEDGER_PENDING`.

## Why this phase exists

Phase 238 proves the supplied records match what was committed. It says nothing about **who has held those
records since, or in what order custody moved**. This phase records that narrative and checks it for internal
consistency.

## Boundary (what it never does)

- It **never runs** `deploy/unraid-real-library-promotion.sh` or any promotion launcher.
- It **never reads or writes** the real Movies library (`/mnt/user/media/Movies`).
- It **never contacts** live Jellyfin, and never reads the secret approval file.
- It **holds no custody, creates no events, and verifies no identity**: `custodyHeldByThisTool`,
  `eventsCreatedByThisTool` and `selfAuthorized` are the constants `false`.

## Eligibility

`NOT_ELIGIBLE` takes **precedence over everything** and emits no genesis skeleton. The Phase 238 report must be
present, be `phase-238-promotion-supplied-source-record-verification`, recompute its self-digest, and be
`SOURCE_RECORDS_VERIFIED`.

**Eligibility is checked on the whole body, not the headline** — standing practice in this stack since the
Phase 234/235 hardening. A self-digest is not a signature, so a forged verification can carry a green
`overall` over a body that failed Phase 238's own checks and still recompute cleanly. Phase 239 therefore also
requires `recordedVerification === "VERIFIED"`, `sourceRecordsVerified`, `redactionSafe`, `commitmentEligible`,
`manifestBoundToCommitment`, `verificationWellFormed`, `verificationRedactionSafe`, `verificationBound`,
`verificationCoherent`, `sourcesRedactionSafe`, `allContentDigestsMatched`, `allReportsRederived`, the
did-nothing constants, an **empty `blockers` array**, an **empty `mismatches` array**, a source-record count of
four, and complete operation-digest bindings.

## The event schema

Strict top-level allowlist; digests only. Anything else fails closed.

```json
{
  "record": "phase-239-promotion-chain-custody-event",
  "version": 1,
  "operation": "promote-observe-withdraw",
  "sourceVerificationReport": "phase-238-promotion-supplied-source-record-verification",
  "verificationDigest": "<the Phase 238 report's own digest>",
  "approvalIdDigest": "<from the Phase 238 bindings>",
  "itemDigest": "…", "sourceDigest": "…", "destinationDigest": "…", "planDigest": "…",
  "sequence": 0,
  "previousEventDigest": "GENESIS",
  "transition": "GENESIS",
  "custodianDigest": "PENDING",
  "occurredAtUtc": "PENDING",
  "eventDigest": "<computed over every key except this one>"
}
```

`sequence` must form exactly `0..n-1`. `previousEventDigest` is the literal `GENESIS` sentinel at sequence 0
and the preceding event's **recomputed** digest thereafter. `occurredAtUtc` must be non-decreasing with
sequence. `custodianDigest` and `occurredAtUtc` may be `PENDING` **only** in a blank genesis.

`eventDigest` is computed by `computeCustodyEventDigest`, which reuses **Phase 238's exported canonicalization**
(`canonicalJson`) under this phase's own scope — recursively key-sorted JSON, so a hand-written event whose
keys are in a different order digests identically. One serialization rule for the stack, no second copy.

## Transition matrix

| From | Allowed next |
| --- | --- |
| `GENESIS` (sequence 0 only, once) | `CUSTODY_ACCEPTED` |
| `CUSTODY_ACCEPTED` | `CUSTODY_RETAINED`, `CUSTODY_TRANSFERRED`, `CUSTODY_RELEASED` |
| `CUSTODY_RETAINED` | `CUSTODY_RETAINED`, `CUSTODY_TRANSFERRED`, `CUSTODY_RELEASED` |
| `CUSTODY_TRANSFERRED` | `CUSTODY_ACCEPTED` only |
| `CUSTODY_RELEASED` | **terminal — nothing may follow** |

A `CUSTODY_TRANSFERRED` followed by `CUSTODY_ACCEPTED` must name a **different** custodian
(`LEDGER_TRANSFER_TO_SAME_CUSTODIAN`). A transfer to yourself is not a transfer, and allowing it would let a
ledger grow arbitrarily long while recording no change of hands at all.

## Detections

Each has its own fixed, value-free code so they stay distinguishable.

| Code | Meaning |
| --- | --- |
| `LEDGER_FORK_DETECTED` | two or more events name the same parent (the `GENESIS` sentinel counts as a parent) |
| `LEDGER_TRUNCATION_DETECTED` | the sequence set is not contiguous from 0 |
| `LEDGER_GENESIS_MISSING` | the ledger does not begin at sequence 0 |
| `LEDGER_GENESIS_MISPLACED` | a `GENESIS` transition anywhere but the front, or a front event that is not `GENESIS` |
| `LEDGER_REORDER_DETECTED` | the supplied array is not in ascending sequence order |
| `LEDGER_DUPLICATE_SEQUENCE` / `LEDGER_DUPLICATE_EVENT_DIGEST` | a repeated sequence, or a repeated event digest |
| `LEDGER_SPLICE_DETECTED` | an event's `previousEventDigest` is not the preceding event's recomputed digest |
| `LEDGER_RESEAL_DETECTED` | an event's stated `eventDigest` does not recompute from its own body |
| `LEDGER_INVALID_TRANSITION` / `LEDGER_TERMINAL_CONTINUED` | the matrix is violated, or something follows a release |
| `LEDGER_TIME_NOT_MONOTONIC` | time runs backwards along the sequence |
| `LEDGER_EVENT_NOT_CUSTODIED` | an event outside a blank genesis names no custodian or no time |
| `LEDGER_GENESIS_HAS_PREDECESSOR` | the first event claims a parent |
| `LEDGER_EVENTS_MISSING` / `_INVALID` / `_EMPTY` / `_LIVE_SURFACE` | no array supplied, not an array, empty, or a raw path / live surface inside it |
| `EVENT_*` | per-event shape: `INVALID`, `UNKNOWN_FIELD`, `VERSION_UNSUPPORTED`, `OPERATION_MISMATCH`, `SOURCE_REPORT_MISMATCH`, `SEQUENCE_INVALID`, `TRANSITION_INVALID`, `PREVIOUS_DIGEST_INVALID`, `DIGEST_INVALID`, `CUSTODIAN_DIGEST_INVALID`, `OCCURRED_AT_INVALID`, `OPERATION_DIGEST_INVALID`, `NOT_BOUND_TO_VERIFICATION`, and `EVENT_<FIELD>_MISMATCH` per operation digest |
| `VERIFICATION_RECORD_*` | eligibility, all yielding `NOT_ELIGIBLE` |

**Reorder is judged on the supplied order alone**, and every structural check then runs over a
sequence-sorted copy. That isolation is deliberate: a merely-shuffled ledger reports exactly that, instead of
an avalanche of link failures that would hide the real finding.

Custody events are **hand-written**, so they are scanned with the strict live-surface predicate. The supplied
Phase 238 report is a **generated** report whose own boundary prose names the surfaces it avoids, so it gets
the raw-path-marker scanner — the precedent set in Phase 236 and followed since.

## Outcomes

| `overall` | Meaning | Exit |
| --- | --- | --- |
| `CUSTODY_LEDGER_INTACT` | every link intact, every transition valid, every event bound and custodied | `0` |
| `CUSTODY_LEDGER_INVALID` | fail closed — any detection above fired | `1` |
| (input read error) | a supplied file is missing or not valid JSON | `2` |
| `CUSTODY_LEDGER_PENDING` | exactly a blank genesis: the un-started state, claiming nothing | `3` |
| `NOT_ELIGIBLE` | no sound Phase 238 verification for custody to be *of* | `5` |

The report publishes `eventCount`, `terminalTransition`, `headEventDigest` (null unless `INTACT`), and a
per-event state of sequence / transition / `digestRecomputed` / `linkedToPrevious` / `boundToOperation` /
`custodied`. It is redaction-safe: fixed codes, closed enums, counts, booleans and the already-public chain
digests only — never a custodian identity, a timestamp, a raw path or a live identifier.

## Usage

```
npm run ops:promotion-chain-custody-ledger -- \
  --verification phase-238-report.json \
  [--events custody-events.json] \
  [--out ledger-report.json] [--skeletonout genesis-event.json]
```

`--events` takes a JSON **array**. `--skeletonout` writes a blank genesis that claims nothing; completing it
changes the body, so the custodian must recompute `eventDigest` with `computeCustodyEventDigest` before
appending.

## Current state of the prepared P227-A run

**`NOT_ELIGIBLE`, and structurally so.** The real chain stops at Phase 232 `PENDING` because no human ever
approved the run, so its replay is `VERIFIED_OPEN`, its Phase 237 commitment is `NOT_ELIGIBLE`, and its Phase
238 verification is `NOT_ELIGIBLE` in turn. There is no verified source-record set for custody to be *of*.

Locked offline fixtures assert `NOT_ELIGIBLE`, a `null` genesis skeleton, `eventCount: 0`,
`headEventDigest: null` — and that it **stays** `NOT_ELIGIBLE` when handed a fully-formed `INTACT`-shaped
ledger built for the real operation. No custody ledger, verified submission, committed manifest, approved
authorization, recorded observation, accepted disposition or closed closure is constructed for the real bundle
anywhere in this repository.

## What this does and does not prove

**Event digests are NOT signatures.**

It proves **internal consistency of the supplied ledger**: the sequence is contiguous from a genesis, each
event names the recomputed digest of the one before it, the transitions are legal, time does not run
backwards, and every event binds to this one operation and this one verification. An edit to any event **that
has successors** is detectable, because every following link breaks — and re-sealing the edited event does not
help, since the successors still point at the old digest.

It does **not** protect the **tail**. Re-sealing the last event, appending to it, or rebuilding the entire
ledger from genesis is undetectable here, because anyone can recompute every digest. Truncating the **tail**
is likewise undetectable — only a **gap** or a **missing genesis** is caught.

So this ledger is **append-only-*evident*** to a party who retained an earlier copy to compare against, not
append-only-*enforced*. It records a custody narrative; it does not establish custody, authorship, or that any
event described in it ever occurred. Binding a custodian to a person would require out-of-band signing, which
this stack deliberately does not attempt: `custodianDigest` is an opaque reference to an identity established
elsewhere, not proof of one.

## Tests

`test/promotion-chain-custody-ledger.ts` (also `npm run test:phase239-local`), 24 tests over a **synthetic**
chain plus the real-bundle locks: a genuine six-event `INTACT` narrative; the blank genesis validating as
`PENDING`; fail-closed-by-default; **the mid-ledger edit**, proving a carefully re-sealed event still breaks
every later link while `RESEAL` itself stays silent; each of `RESEAL`, `SPLICE`, `FORK` (including two genesis
events), `TRUNCATION` (gap and headless), `REORDER` (asserting reordering is the *only* finding), `DUPLICATE`,
`INVALID_TRANSITION`, terminal-continued and misplaced-genesis; transfer-to-self; non-monotonic time;
uncustodied events; `NOT_ELIGIBLE` over a non-verified Phase 238 result and its precedence over a broken
ledger; a tampered Phase 238 report failing on digest recompute; a **ten-case forged** Phase 238 report that
recomputes cleanly, each asserting the digest check does *not* fire while the specific eligibility blocker
does; malformed sequences/enums/digests/timestamps and foreign bindings; unknown field and smuggled raw path
never echoed; canonical key-order equivalence; a redaction-safe CLI across all five exit paths; and the actual
P227-A locks.

## What this phase deliberately does NOT do

It does not create, complete or infer a custody event; it does not authorize, schedule or perform the P227-A
promotion; it does not run the promotion launcher, read or write the real Movies library, or contact Jellyfin;
it does not read the secret approval file; and it does not merge, tag or push. Those remain separate human
steps, preserved behind the live boundary.
