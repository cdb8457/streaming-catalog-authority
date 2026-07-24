# Phase 238: Supplied-Source-Record Verification (local, non-live)

Report id: `phase-238-promotion-supplied-source-record-verification`

Status: `PHASE_238_PROMOTION_SUPPLIED_SOURCE_RECORD_VERIFICATION_READY`

A **fail-closed** local validator that checks supplied human source records against the Phase 237 provenance
commitment. Phase 237 records a human commitment to four content digests but **never recomputes them** — it is
handed digests, not records, and says so plainly. This phase is where the bytes are actually checked.

Given the four supplied human source records and the Phase 232–235 reports they produced, it canonically
digests each record, compares it to the digest committed for that phase, requires each supplied report to be
the one committed, and re-runs each phase's **own** validator to prove the report is the honest output of that
record.

## Why this phase exists

The Phase 237 commitment is only as good as its checkability. Until now nothing in the stack could tell the
difference between a commitment to the digests of the records actually used and a commitment to the digests of
records invented afterwards — because nothing ever hashed a record. Phase 238 makes the commitment testable
against bytes.

## Inputs

| CLI flag | Value |
| --- | --- |
| `--commitment` | the Phase 237 report (`phase-237-promotion-source-record-provenance-commitment`) |
| `--manifest` | the Phase 237 provenance manifest that commitment was made over — **required** |
| `--gate`, `--authorization`, `--observation`, `--disposition`, `--closure` | the Phase 231–235 reports |
| `--sourceauthorization`, `--sourceobservation`, `--sourcedisposition`, `--sourceclosure` | the four supplied human source records |
| `--verification` | the human verification decision record |
| `--out`, `--skeletonout` | optional report / blank decision record |

The manifest is required because the Phase 237 report deliberately does **not** echo the committed content
digests — it publishes only `sourceCommitmentDigest`, a hash over the ordered `(phase, reportDigest,
contentDigest)` triples. Phase 238 recomputes that digest from the supplied manifest, using **Phase 237's own
exported function**, and requires equality. A substituted manifest cannot survive it.

The Phase 231 gate is required because Phase 232's re-derivation consumes it.

## The canonical content digest rule

Defined and exported here as `canonicalSourceRecordDigest`: **recursively key-sorted JSON** (arrays keep their
order), digested under a fixed scope. A record that is semantically identical but serialized with a different
key order digests **identically**; a record whose array order or values differ does not. It is cycle-safe — a
self-referential record terminates rather than overflowing.

A Phase 237 commitment **must** have used this rule. Phase 237 accepted whatever digest the human supplied,
because it holds no records and cannot check; a commitment computed under any other convention simply will not
match here, and that is reported as a mismatch rather than silently tolerated.

## No second ruleset

This module states no rule of its own that already exists elsewhere:

- the commitment digest comes from Phase 237's exported `computeSourceCommitmentDigest`;
- semantic re-derivation re-runs the phases' own exported validators, exactly as Phase 236 does.

Each phase is re-run against the **supplied** parent report — so a doctored parent fails at its own level and
cannot be laundered by a clean child.

## What it checks

1. **Eligibility** (`commitmentEligible`; failure ⇒ `NOT_ELIGIBLE`, precedence over everything, no skeleton) —
   the Phase 237 report is present, correct id, self-digest recomputes, and `PROVENANCE_COMMITTED`. Per the
   standing rule since the Phase 234/235 hardening, the **whole body** is checked, not the headline: its own
   success booleans (`redactionSafe`, `provenanceCommitted`, `replayEligible`, `manifestWellFormed`,
   `manifestRedactionSafe`, `manifestBound`, `manifestCoherent`), `recordedCommitment === "COMMITTED"`, the
   did-nothing constants, an empty blocker list, a non-null `sourceCommitmentDigest`, and
   `sourceRecordCount === 4`.
2. **Manifest binding** (`manifestBoundToCommitment`) — the recomputed commitment digest equals the report's.
   Entries are parsed strictly: exactly four, ascending, no duplicates, exactly phases 232–235.
3. **Ordered one-to-one pairing** — each supplied report self-verifies and its own digest equals the
   `reportDigest` committed for that phase.
4. **Content** (`allContentDigestsMatched`) — `canonicalSourceRecordDigest(record)` equals the committed
   `contentDigest`, per phase.
5. **Semantic re-derivation** (`allReportsRederived`) — each report is the honest output of its phase's
   validator over its supplied record and the supplied parent.
6. **Redaction** — the supplied source records and the verification record are hand-written, so they get the
   strict live-surface predicate; the supplied reports are generated and get raw-path markers only (the
   two-scanner precedent from Phase 236, followed in Phase 237).
7. **The human verification record** — strict allowlist, closed enums, `verifierDigest` sha256 + strict
   `YYYY-MM-DDTHH:MM:SSZ` when decided and both `PENDING` when not, bound to the commitment by both its
   `provenanceDigest` and its `sourceCommitmentDigest`.

## A mismatch is a finding, not an input error

This is a verification layer, so a content digest that does not match, a report that does not re-derive, or a
report that is not the one committed are reported in **`mismatches`**, separate from `blockers`. They make
`SOURCE_RECORDS_VERIFIED` impossible but do **not** by themselves make the submission `INVALID` — because the
honest response to a failed verification is for a human to **decline** it, and that must stay available.

Only a malformed, unbound or incoherent submission is `INVALID` — **as is a human affirming verification while
mismatches stand** (`VERIFICATION_AFFIRMED_WITH_MISMATCHED_RECORDS`). That is the one place a mismatch becomes
a hard error: not because the records are wrong, but because the claim about them is.

`allReportsRederived` is never false with nothing in `mismatches` to explain it: a phase that *cannot* be
re-derived reports the same finding as one that re-derives wrong, with a separate blocker saying why.

## Outcomes

| `overall` | Meaning | Exit |
| --- | --- | --- |
| `SOURCE_RECORDS_VERIFIED` | every check green **and** a human affirmed the verification | `0` |
| `SOURCE_RECORDS_INVALID` | fail closed — malformed, unbound, incoherent, or verification affirmed over mismatches | `1` |
| (input read error) | a supplied file is missing or not valid JSON | `2` |
| `SOURCE_RECORDS_PENDING` | valid submission, no decision recorded | `3` |
| `SOURCE_RECORDS_DECLINED` | valid submission, the human refused | `4` |
| `NOT_ELIGIBLE` | no sound commitment to verify against; no submission can override it | `5` |

The computational checks never self-affirm: `VERIFIED` additionally requires the human decision. Constants:
`verifiedByThisTool: true` — it genuinely does compute the comparison — alongside `retrievedByThisTool: false`,
`identityVerifiedByThisTool: false`, `selfAuthorized: false`.

## What this does and does not prove

Verification proves **only** that the supplied bytes match the committed digests and re-derive their reports. A
report body cannot have been edited after the fact, and a record cannot have been swapped for a different one
after the commitment was made.

It does **not** establish **authorship** — nothing here is a signature.

It does **not** establish that these records are the ones **historically used**. A party who controls both the
records and the commitment can satisfy every check in this file by committing to the digests of whatever
records they later intend to present. What Phase 238 converts is narrower and worth stating exactly: the
Phase 237 commitment stops being an unverifiable claim and becomes one that is **checkable against bytes**.
Nothing more.

## Current state of the prepared P227-A run

**`NOT_ELIGIBLE`.** The real chain terminates at Phase 232 `PENDING` because no human ever approved the run, so
its Phase 236 replay is `VERIFIED_OPEN` and its Phase 237 result is `NOT_ELIGIBLE` — there is no
`PROVENANCE_COMMITTED` commitment to verify anything against. `buildSuppliedSourceVerificationSkeleton` returns
`null`, `recordedVerification` is `NONE`, and `sourceRecordsVerified` is `false`.

Both states are locked as offline fixtures, including that the chain **stays** `NOT_ELIGIBLE` when handed a
fully-formed `VERIFIED`-shaped submission. No committed manifest, verified submission, approved authorization,
recorded observation, accepted disposition or closed closure is constructed for the real bundle anywhere in
this repository.

## Usage

```
npm run ops:promotion-supplied-source-record-verification -- \
  --commitment phase-237-report.json --manifest provenance-manifest.json \
  --gate 231.json --authorization 232.json --observation 233.json \
  --disposition 234.json --closure 235.json \
  --sourceauthorization a.json --sourceobservation b.json \
  --sourcedisposition c.json --sourceclosure d.json \
  [--verification decision.json] [--out report.json] [--skeletonout blank.json]
```

## Tests

`test/promotion-supplied-source-record-verification.ts` (also `npm run test:phase238-local`), 20 tests over a
**synthetic** chain plus the real-bundle locks: a genuine end-to-end verification; canonicality (key order
ignored, array order and values not, cycles terminate); fail-closed default; the blank skeleton validating as
`PENDING` and affirming nothing; a valid `DECLINED`; **the substitution case** — a swapped record fails its
committed digest, and declining it stays available; a record that matches its committed digest but does **not**
re-derive its report; a doctored parent that a clean child cannot launder; a substituted or edited manifest;
omission, duplication and reordering; a foreign report and a tampered report; `NOT_ELIGIBLE` over a
non-`COMMITTED` commitment and its precedence over a broken submission; an 11-case recomputed-self-digest
forgery of the Phase 237 report proving each eligibility check is reachable while the digest check stays
silent; missing records and reports; malformed enums, digests and timestamps; unknown field; a smuggled raw
path never echoed; a redaction-safe CLI across all six exit paths; and the real P227-A locks.

## What this phase deliberately does NOT do

It retrieves no record, verifies no identity, and decides nothing on a human's behalf. It does not run the
promotion launcher, read or write the real Movies library, contact Jellyfin, or read the secret approval file;
it does not authorize Phase 231; and it does not merge, tag or push.
