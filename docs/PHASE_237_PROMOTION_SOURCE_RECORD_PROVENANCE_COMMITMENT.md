# Phase 237: Source-Record Provenance Commitment (local, non-live)

Report id: `phase-237-promotion-source-record-provenance-commitment`

Status: `PHASE_237_PROMOTION_SOURCE_RECORD_PROVENANCE_COMMITMENT_READY`

A **fail-closed** local validator for a **human provenance commitment manifest**, layered on the Phase 236
replay result. It binds the exact **content digests** of the four human source records — the Phase 232
authorization decision, the Phase 233 observation, the Phase 234 disposition and the Phase 235 closure — to
one Phase 236 `replayDigest` and the five operation digests.

It commits **nothing** itself and verifies **no identity**: `committedByThisTool`,
`verifiedIdentityByThisTool` and `selfAuthorized` are the constants `false`.

## Why this phase exists

Phase 236 proves the chain is structurally and semantically consistent, but its own locked non-uniqueness test
says plainly that it does **not** pin *which* human source records produced it. The
operator/observer/reviewer/closer digests, every timestamp, and the observed **after** state can all be
swapped between two source-record sets that re-derive byte-identical reports. (The observed **before** state is
the one exception, pinned since the Phase 232↔233 witnessed-state binding.) So `CHAIN_REPLAY_VERIFIED_CLOSED`
never means *"these people did these things at these times"*.

This phase closes that gap the only way an offline validator honestly can: a human states, on the record and
bound to one replay, the content digest of each source record they retained.

## What this does and does not prove

It does **not** prove **authorship or authenticity**. Self-digests and content digests are **not signatures**.
This validator **records a human commitment**. It performs no independent identity verification, and it never
recomputes the content digests against the real source records — it cannot; it is offline and is handed
digests, not records. **A committer who controls the source records can commit to any digests they like, and
nothing here would notice.**

What it **does** buy: it pins, at a point in time, exactly which record contents a human — named only by
digest — claimed to have independently retained, content-digested, reviewed and bound to **this** replay. A
**later substitution** of any of those four records then becomes detectable, because its content digest no
longer matches the one committed. That is a durable anchor against after-the-fact record swapping; it is not
evidence of who wrote anything.

The report publishes a `sourceCommitmentDigest` — a digest over the ordered
`(phase, reportDigest, contentDigest)` triples — so a later verifier can recompute it from the manifest and
detect substitution **without this report ever echoing a committed content digest**.

That "later verifier" now exists: **Phase 238** consumes this report, the manifest it was made over, and the
four supplied source records, and checks the bytes. The digest function is exported as
`computeSourceCommitmentDigest` and imported by Phase 238 rather than reimplemented, so there is a single
triple-hashing rule with no second copy to drift from it. Phase 238 also defines the canonical content-digest
rule (`canonicalSourceRecordDigest`); a commitment recorded here must have used that rule, since this phase
accepts whatever digest the human supplies and cannot check.

## Eligibility, and why it is checked on the whole body

`NOT_ELIGIBLE` means the **chain** has nothing to commit provenance for. It takes **precedence over
everything**: no manifest, however well-formed, can override it.

Eligibility requires a genuine Phase 236 report that recomputes its own digest **and** is sound on its whole
body — not just its headline. This is the lesson of the Phase 234/235 hardening applied one layer up: a
self-digest is not a signature, so a forged replay can carry a green `overall` over a body that failed Phase
236's own checks and recompute cleanly. So it also requires `redactionSafe`, `chainComplete`,
`operationClosed`, `semanticallyRederived`, `identityAnchored`, `replayedByThisTool`, the three did-nothing
constants, an **empty blocker list**, all five `phases[]` entries present/verified/linked/identity-matched and
re-derived from source, a complete `operationDigests` (five) and `chainDigests` (`phase-231`…`phase-235`).

Any failure ⇒ `NOT_ELIGIBLE`, and `buildProvenanceCommitmentSkeleton` returns `null`.

| Blocker | Meaning |
| --- | --- |
| `REPLAY_RECORD_MISSING` / `_INVALID` / `_DIGEST_MISMATCH` | absent, wrong report id, or does not recompute |
| `REPLAY_RECORD_NOT_VERIFIED_CLOSED` | not a fully verified, closed chain |
| `REPLAY_RECORD_NOT_REDACTION_SAFE` / `_RAW_PATH_PRESENT` | the replay is not redaction-safe |
| `REPLAY_RECORD_CHAIN_NOT_COMPLETE` / `_OPERATION_NOT_CLOSED` | incomplete or unclosed |
| `REPLAY_RECORD_NOT_SEMANTICALLY_REDERIVED` | structural only — nothing was re-derived from source |
| `REPLAY_RECORD_IDENTITY_NOT_ANCHORED` / `_NOT_REPLAYED_BY_TOOL` | unanchored, or never actually replayed |
| `REPLAY_RECORD_PERFORMED_CLAIMED` / `_CAPTURED_CLAIMED` / `_SELF_AUTHORIZED` | the replay claims to have acted |
| `REPLAY_RECORD_BLOCKERS_PRESENT` | blockers recorded under a green headline |
| `REPLAY_RECORD_PHASES_INCOMPLETE` | a phase is absent, unverified, unlinked, drifted or unre-derived |
| `REPLAY_RECORD_OPERATION_DIGESTS_INCOMPLETE` / `_CHAIN_DIGESTS_INCOMPLETE` | published digests missing |

## The manifest a human completes

Digest-only — it names no path, no id and no committer identity. Strictly allowlisted: any key outside the set
fails closed.

```json
{
  "record": "phase-237-promotion-source-record-provenance-commitment-input",
  "version": 1,
  "operation": "promote-observe-withdraw",
  "sourceReplayReport": "phase-236-promotion-chain-replay-verification",
  "replayDigest": "<the Phase 236 report's own replayDigest>",
  "approvalIdDigest": "<from the replay's operationDigests>",
  "itemDigest": "...", "sourceDigest": "...", "destinationDigest": "...", "planDigest": "...",
  "sourceRecords": [
    { "phase": 232, "reportDigest": "<the replay's chainDigests['phase-232']>", "contentDigest": "PENDING" },
    { "phase": 233, "reportDigest": "...", "contentDigest": "PENDING" },
    { "phase": 234, "reportDigest": "...", "contentDigest": "PENDING" },
    { "phase": 235, "reportDigest": "...", "contentDigest": "PENDING" }
  ],
  "fields": {
    "commitmentAffirmed": "PENDING",
    "sourceRecordsRetainedIndependently": "PENDING",
    "sourceRecordsContentDigested": "PENDING",
    "sourceRecordsReviewed": "PENDING",
    "sourceRecordsBoundToThisReplay": "PENDING"
  },
  "committerDigest": "PENDING",
  "committedAtUtc": "PENDING"
}
```

`sourceRecords` is an **array** on purpose: omission, duplication and reordering are then three distinct,
separately reported failures rather than one blurred "bad list".

Each `fields` value ∈ `PENDING | AFFIRMED | REFUSED`. `commitmentAffirmed` **carries the decision itself**
(`AFFIRMED`→`COMMITTED`, `REFUSED`→`DECLINED`, `PENDING`→`PENDING`) — one source of truth, as in Phases 234
and 235, so a manifest can never state a decision that contradicts its own fields.

Nothing the skeleton emits pre-affirms anything. It pre-fills **only derived bindings** copied from the
replay: `replayDigest`, the five operation digests, and each entry's `phase` and `reportDigest`.
`contentDigest` ships as `PENDING` — the same *"sha256 or the literal `PENDING`"* discipline already used for
`operatorDigest` / `observerDigest` / `reviewerDigest` / `closerDigest` across Phases 232–235, so no new
representation is introduced and the blank validates as `PROVENANCE_PENDING`. **The skeleton never creates or
infers a `COMMITTED` manifest and never invents a content digest.**

## What it checks

1. **Eligibility** (`replayEligible`) — as above. Precedence over everything.
2. **Manifest shape** (`manifestWellFormed`) — one object (`MANIFEST_MISSING` / `_NOT_SINGLE` / `_INVALID`),
   only allowlisted keys (`_UNKNOWN_FIELD`), correct fixed literals (`_VERSION_UNSUPPORTED` /
   `_OPERATION_MISMATCH` / `_SOURCE_REPORT_MISMATCH` / `_REPLAY_DIGEST_INVALID`), the five closed-enum fields
   (`_FIELDS_INVALID` / `_FIELD_STATE_INVALID`), string committer/time (`_COMMITTER_DIGEST_INVALID` /
   `_COMMITTED_AT_INVALID`), and a well-formed record list: `_SOURCE_RECORDS_INVALID` (not an array),
   `_SOURCE_RECORD_COUNT_INVALID` (**omission**), `_SOURCE_RECORD_ENTRY_INVALID` (malformed entry or report
   digest), `_SOURCE_RECORD_CONTENT_DIGEST_INVALID`, `_SOURCE_RECORD_DUPLICATED` (**duplication**),
   `_SOURCE_RECORD_OUT_OF_ORDER` (**reordering**, distinct from duplication), `_SOURCE_RECORD_PHASE_INVALID`
   (a phase outside 232–235, or one missing).
3. **Redaction safety** (`manifestRedactionSafe`) — the **whole supplied manifest** is deep-scanned
   (iteratively, cycle-safe, keys included) with the **strict** per-phase predicate, because it is hand-written
   like the Phase 232–235 records (`MANIFEST_LIVE_SURFACE`). The replay report is scanned separately with
   **raw-path markers only**, following the Phase 236 precedent: a genuine report's own boundary prose
   legitimately names the live surfaces it avoids, so the strict predicate would reject every real report.
4. **Binding** (`manifestBound`) — the manifest names this replay by its own `replayDigest`
   (`MANIFEST_NOT_BOUND_TO_REPLAY`), carries the same five operation digests
   (`MANIFEST_APPROVAL_ID_DIGEST_MISMATCH` / `_ITEM_DIGEST_` / `_SOURCE_DIGEST_` / `_DESTINATION_DIGEST_` /
   `_PLAN_DIGEST_MISMATCH`), and pairs **each** source record with the report digest that phase actually
   produced in this replay (`MANIFEST_SOURCE_RECORD_REPORT_DIGEST_MISMATCH`). This is the substitution,
   mismatched-pairing and **transplantation** defence: a genuine manifest cannot be replayed against a
   different replay.
5. **Coherence** (`manifestCoherent`) —
   - `COMMITTED` requires all four affirmations `AFFIRMED` (`MANIFEST_COMMITTED_WITHOUT_FULL_AFFIRMATION`) and
     every `contentDigest` to be a real sha256 (`MANIFEST_CONTENT_DIGEST_REQUIRED`) — a commitment to nothing
     commits nothing;
   - `PENDING` requires every `contentDigest` to remain `PENDING` (`MANIFEST_CONTENT_DIGEST_NOT_PENDING`) — an
     undecided manifest pins nothing at all;
   - `DECLINED` is **deliberately ungated**: refusing to commit is never refused, as with Phase 234 `REJECTED`
     and Phase 235 `HELD_OPEN`;
   - a decided manifest names **who** (sha256) and **when** (strict `YYYY-MM-DDTHH:MM:SSZ`) —
     `MANIFEST_COMMITTER_DIGEST_REQUIRED` / `_COMMITTED_AT_REQUIRED`; an undecided one claims neither
     (`_COMMITTER_DIGEST_NOT_PENDING` / `_COMMITTED_AT_NOT_PENDING`).

## Outcomes

| `overall` | Meaning | Exit |
| --- | --- | --- |
| `PROVENANCE_COMMITTED` | a valid, replay-bound human commitment over four content digests exists | `0` |
| `PROVENANCE_INVALID` | the chain is eligible but the supplied manifest is broken | `1` |
| (input read error) | a supplied file is missing or not valid JSON | `2` |
| `PROVENANCE_PENDING` | valid manifest, nothing committed yet | `3` |
| `PROVENANCE_DECLINED` | valid manifest, the committer refused | `4` |
| `NOT_ELIGIBLE` | the chain has nothing to commit provenance for | `5` |

Only exit `0` means a commitment exists. In **all** cases `committedByThisTool: false`,
`verifiedIdentityByThisTool: false`, `selfAuthorized: false`.

The report is redaction-safe: chain digests that were **already public** in the replay, per-record
`present` / `reportDigestMatched` / `contentDigestPresent` booleans, the `sourceCommitmentDigest`, fixed
value-free codes, closed enum states and counts only — never an identity, a timestamp, a raw record, a path, a
live identifier, or a committed content digest value.

## Usage

```
npm run ops:promotion-source-record-provenance -- \
  --replay   chain-replay.json \
  [--manifest provenance-manifest.json] \
  [--out      provenance-report.json] \
  [--skeletonout provenance-manifest.blank.json]
```

## Current state of the prepared P227-A run

**`NOT_ELIGIBLE`, and locked.** The real chain remains unauthorized and open: no human ever approved the run,
so its Phase 236 replay is `CHAIN_REPLAY_VERIFIED_OPEN` terminating at Phase 232, and it never reaches a
closed replay. Run against it, this validator returns `NOT_ELIGIBLE` with
`REPLAY_RECORD_NOT_VERIFIED_CLOSED` and `REPLAY_RECORD_OPERATION_NOT_CLOSED`, `provenanceCommitted: false`,
`sourceRecordCount: 0` and `sourceCommitmentDigest: null` — and `buildProvenanceCommitmentSkeleton` returns
`null`, so not even a blank manifest can be emitted for it.

Both are locked as offline fixtures, including that it **stays** `NOT_ELIGIBLE` when handed a fully-formed
`COMMITTED`-shaped manifest built for the real operation. **No committed manifest — and no approved
authorization, recorded observation, accepted disposition or closed closure — is constructed for the real
bundle anywhere in this repository.**

## Tests

`test/promotion-source-record-provenance.ts` (also `npm run test:phase237-local`), 18 tests over a
**synthetic** chain plus the real-bundle locks: a genuine digest-bound commitment that still commits and
verifies nothing; fail-closed-by-default; the blank skeleton validating as `PENDING` and asserting nothing; a
valid `DECLINED` manifest and the proof that declining is never gated; `COMMITTED` without every affirmation or
content digest; **the substitution case** — swapping any one committed content digest changes the durable
anchor; a record paired with the wrong report digest; **the transplantation case**; omission, duplication and
reordering each failing distinctly; `NOT_ELIGIBLE` over `VERIFIED_OPEN` / `STRUCTURAL_ONLY` /
`NOT_REPLAYABLE`; `NOT_ELIGIBLE` precedence over a broken manifest; a tampered replay → digest mismatch; a
**15-case forged replay** that recomputes its own digest cleanly and is caught only by the eligibility checks;
malformed digests/enums/timestamps; a smuggled raw path never echoed; a redaction-safe CLI across all six exit
paths; and the two real P227-A `NOT_ELIGIBLE` locks.

## What this phase deliberately does NOT do

It does not verify any identity, retain any source record, or compute any content digest. It does not
authorize, schedule or perform the promotion; it does not run the promotion launcher, read or write the real
Movies library, or contact Jellyfin; it does not read the secret approval file; and it does not merge, tag or
push. Those remain separate human steps, preserved behind the live boundary.
