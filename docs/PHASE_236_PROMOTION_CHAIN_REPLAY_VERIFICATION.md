# Phase 236: End-to-End Promotion Chain Replay Verification (local, non-live)

Report id: `phase-236-promotion-chain-replay-verification`

Status: `PHASE_236_PROMOTION_CHAIN_REPLAY_VERIFICATION_READY`

A **fail-closed** local verifier that replays the whole promotion record chain — Phase 231 gate, 232
authorization, 233 observation, 234 disposition, 235 closure — in **one pass**, re-deriving every link instead
of trusting any report's own word for it.

## Why this phase exists

Each phase only ever checks its **immediate parent**. Phase 235 confirms it binds to a Phase 234 report; Phase
234 confirms it binds to a Phase 233 report; and so on. Nothing until now verified **transitively** that the
operation Phase 235 closed out is the same one operation Phase 231's template named.

That leaves a real gap: a **spliced chain**, assembled from two different operations, where every report is
individually valid and self-verifying and every adjacent link binds correctly. No single phase can see it,
because no single phase looks further than one step. This verifier is the only thing that does.

## The headline invariant: cross-phase operation identity

The five operation digests — `approvalIdDigest`, `itemDigest`, `sourceDigest`, `destinationDigest`,
`planDigest` — must be **identical in every supplied report**, anchored to the Phase 231 template and
re-derived downward. Downstream phases carry them under their `boundDigests` keys (`operation-approval-id`,
`operation-item`, `operation-source`, `operation-destination`, `operation-plan`).

Identity is checked **independently of linkage**, which matters: a forged report that keeps a correct parent
link *and* recomputes its own self-digest cleanly, but carries another operation's digests, is caught by the
identity check alone. The test suite proves exactly that — asserting the digest check and the link check do
**not** fire while the identity blocker does.

## Absence is normal, not an error

The chain legitimately stops partway. The prepared P227-A operation stops at Phase 232, because no human ever
approved it, so a Phase 233/234/235 record **cannot exist**. That is `CHAIN_REPLAY_VERIFIED_OPEN` with zero
blockers — consistent as far as it goes — never a defect. Only an internally inconsistent chain, a skipped
link, or drifting operation identity is `CHAIN_NOT_REPLAYABLE`.

## Structure is not enough: the non-resealable semantic path

Every structural check here is **resealable**. A party holding the bundle can rewrite any report body,
recompute its self-digest, and fix up the links and identity digests; the result is structurally perfect. So a
structural pass alone is reported as `CHAIN_REPLAY_STRUCTURAL_ONLY` and **never** as `VERIFIED_CLOSED` or
`VERIFIED_OPEN`.

A `VERIFIED_*` verdict additionally requires the **semantic path**: for every supplied phase the caller also
supplies the `sources` record that phase consumed, and this verifier **re-runs that phase's own exported
validator** over it, requiring the result to reproduce the supplied report's self-digest exactly. That is not
resealable — the validators are deterministic functions of their inputs, so a doctored report would need
source records a fail-closed validator would have had to accept in the first place (no source makes Phase 233
emit `RECORDED` over an unapproved Phase 232 authorization).

One unproven phase caps the whole verdict. Unproven is **not** disproven: a phase with no source supplied
reports `rederivedFromSource: null` and contributes no blocker — it simply withholds the `VERIFIED_*` verdict.
A source that is supplied and *fails* to re-derive is `CHAIN_PHASE_<n>_NOT_REDERIVED_FROM_SOURCE` and is
`NOT_REPLAYABLE`.

**No second ruleset.** This file states no phase semantics of its own; it re-runs the phases' exported
validators, so there is nothing here that can drift from them. It reports the terminal state it finds; it does
not decide it.

## What it checks

1. **Recomputation** — every supplied report is present, carries the right report id
   (`CHAIN_PHASE_<n>_REPORT_INVALID`), and reproduces its own self-digest via the shared verifier
   (`CHAIN_PHASE_<n>_DIGEST_MISMATCH`).
2. **Contiguity** — the supplied set must be a **prefix** of the chain starting at Phase 231. A report whose
   parent is absent is a skipped link (`CHAIN_PHASE_<n>_PARENT_MISSING`), and a chain with a hole in it cannot
   be replayed.
3. **Identity anchor** — Phase 231's template names the one operation. A gate that never emitted a template
   anchors nothing (`CHAIN_PHASE_231_OPERATION_IDENTITY_UNAVAILABLE`).
4. **Link re-derivation** — each report's recorded parent digest must equal the parent's **own recomputed**
   self-digest (`CHAIN_PHASE_<n>_LINK_NOT_REDERIVED`):
   `232.boundDigests['gate-authorization'] === 231.authorizationDigest`,
   `233.boundDigests['authorization-record'] === 232.recordDigest`,
   `234.boundDigests['observation-record'] === 233.observationDigest`,
   `235.boundDigests['disposition-record'] === 234.dispositionDigest`.
5. **Operation identity** — the five digests identical across every supplied report
   (`CHAIN_PHASE_<n>_OPERATION_IDENTITY_MISMATCH`), checked independently of (4).
6. **Redaction** — every supplied report must declare `redactionSafe: true` and no raw path may appear
   anywhere in the bundle, keys included (`CHAIN_REDACTION_UNSAFE`).

### A deliberate difference in the redaction scan

The per-phase validators scan a **human-supplied record** for any live-surface *word* — `jellyfin`, a url
scheme, a media extension — because a human writing a record has no business naming those at all. This phase's
inputs are **generated reports** whose boundary and disclaimer prose names the live surfaces it promises to
avoid ("no live Jellyfin call", "no real Movies library read"). A word scan would flag every honest boundary
statement in the chain. What must never appear is a **raw path**, so that is exactly what is scanned for —
matching the Phase 230 final-bundle replay verifier's marker set.

## Outcomes

| `overall` | Meaning | Exit |
| --- | --- | --- |
| `CHAIN_REPLAY_VERIFIED_CLOSED` | every supplied phase re-derived from its source, over one operation, terminating in a `CLOSED` Phase 235 | `0` |
| `CHAIN_NOT_REPLAYABLE` | fail closed — a report does not recompute, a link does not re-derive, identity drifts, a link is skipped, or a supplied source does not re-derive its report | `1` |
| (input read error) | a supplied file is missing or not valid JSON | `2` |
| `CHAIN_REPLAY_VERIFIED_OPEN` | every supplied phase re-derived, but the operation is not closed out | `3` |
| `CHAIN_REPLAY_NO_INPUT` | nothing supplied | `4` |
| `CHAIN_REPLAY_STRUCTURAL_ONLY` | self-consistent but **unverified** — source records were not supplied, so nothing is proven beyond resealable structure | `5` |

The report also states `terminalPhase`, per-phase `present`/`reportIdOk`/`verified`/`linkedToParent`/
`identityMatched`/`rederivedFromSource`, `chainComplete`, `operationClosed`, `semanticallyRederived`,
`identityAnchored`, the shared `operationDigests` (only
once identity holds across everything supplied), and each phase's own `chainDigests`. Constants:
`replayedByThisTool: true` — it genuinely does replay — alongside `performedByThisTool: false`,
`capturedByThisTool: false`, `selfAuthorized: false`.

An absent phase reports `linkedToParent: null`, `identityMatched: null` and `rederivedFromSource: null`, never
`false`: absence must never read as a defect, and neither must an unproven phase.

## Usage

```
npm run ops:promotion-chain-replay -- \
  [--gate          execution-authorization.json] \
  [--authorization execution-authorization-record.json] \
  [--observation   post-run-observation.json] \
  [--disposition   post-run-disposition.json] \
  [--closure       operation-closure.json] \
  [--out chain-replay.json]
```

## Current state of the prepared P227-A run

**Consistent, and locked open at Phase 232.** The real chain terminates at Phase 232, because no human ever
approved the run — so no observation, disposition or closure exists to supply. `chainComplete: false`,
`operationClosed: false`, `terminalPhase: 232`.

Its two reports alone are `STRUCTURAL_ONLY`; supplied together with the real source records (the Phase 231
evidence bundle and the blank, undecided authorization skeleton — the only authorization record that exists
for this operation) they genuinely re-derive, giving `VERIFIED_OPEN` at Phase 232 with zero blockers. Neither
state is ever `VERIFIED_CLOSED`.

Both are locked as offline fixtures, along with the real chain
**staying** un-closed when handed a synthetic downstream tail — the graft is caught as
`CHAIN_PHASE_233_OPERATION_IDENTITY_MISMATCH` and `CHAIN_PHASE_233_LINK_NOT_REDERIVED`. No approved
authorization, recorded observation, accepted disposition, or closed closure is constructed for the real
bundle anywhere in this repository.

## What the chain does and does not prove

It proves **internal consistency, non-transplantation, and now single-operation identity end to end**: every
record recomputes, every link re-derives against its parent's own digest, the supplied set is contiguous, and
all five phases describe one operation. A spliced chain — the threat no individual phase could see — fails
here.

It proves, wherever sources are supplied, that **each report is the genuine output of its own phase's
validator over a record that validator accepted** — a report body cannot have been edited after the fact. That
is what a reseal cannot fake, and why a bundle without sources is capped at `STRUCTURAL_ONLY` rather than
called verified.

It does **not** pin *which* record. The phase reports are deliberately redaction-minimal, so several source
records map to a byte-identical report and the semantic path cannot tell them apart. Verified by test, the
following can all be swapped in the sources while every report digest — and the `VERIFIED_CLOSED` verdict —
stays identical:

- `operatorDigest` / `observerDigest` / `reviewerDigest` / `closerDigest` — **a wholly different cast of
  people still verifies**;
- `decidedAtUtc` / `observedAtUtc` / `reviewedAtUtc` / `closedAtUtc` — any timestamps;
- Phase 233's `observedStateBeforeDigest` and `observedStateAfterDigest` — the observed states themselves are
  carried in the report only as `PRESENT`/`PENDING`, never as values;
- arbitrary extra keys in the Phase 231 `gateEvidence` bundle, which its validator ignores.

So `VERIFIED_CLOSED` must **not** be read as "these people did these things at these times over this observed
state". It says the reports are honest outputs of the validators over *some* accepted record set — no more.

It does **not** prove **authorship or authenticity**. These are self-digests, not signatures. A party who
controls the whole chain — reports *and* source records — can fabricate a self-consistent bundle that
re-derives cleanly, because the source records are themselves unsigned. **This phase raises the cost of
forging a chain from resealing one report to fabricating a coherent record set that every fail-closed
validator accepts; it does not establish who wrote anything.** Binding a record to a real human would require out-of-band signing, which this stack
deliberately does not attempt; the `operatorDigest` / `observerDigest` / `reviewerDigest` / `closerDigest`
fields are opaque references to an identity established elsewhere, not proof of it.

## Tests

`test/promotion-chain-replay.ts` (also `npm run test:phase236-local`), 17 tests: a complete synthetic chain
replaying end to end; an empty bundle as `NO_INPUT` with zero blockers; **the splice** — two complete chains
over different items grafted together, caught here while every report remains individually valid and each
chain replays cleanly alone; a forged report with a valid parent link but another operation's digests, caught
by identity alone; every inter-phase link broken in turn; a skipped link and a headless chain; a tampered
report at each of the five layers; a wrong-kind report in a slot; a gate that anchors nothing; a chain whose
closure is `HELD_OPEN` or `PENDING` (verified but open); every partial prefix as `VERIFIED_OPEN`;
operation-identity drift caught at every phase in turn; replay determinism; a smuggled raw path never echoed;
a redaction-safe CLI across all five exit paths; and the two locked P227-A fixtures.

## What this phase deliberately does NOT do

It does not run the promotion launcher, access `/mnt/user/media/Movies`, contact live Jellyfin, or read secret
approval material. It performs no run, captures no state, closes and archives nothing, and authorizes nothing —
it does not authorize Phase 231. It does not re-decide any phase's internal verdict, and it does not merge,
tag, or push.
