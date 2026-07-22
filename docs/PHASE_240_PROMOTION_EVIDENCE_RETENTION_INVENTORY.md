# Phase 240: Evidence Retention and Archival Inventory (local, non-live)

Report id: `phase-240-promotion-evidence-retention-inventory`

Status: `PHASE_240_PROMOTION_EVIDENCE_RETENTION_INVENTORY_READY`

A **redaction-safe**, fail-closed validator for a **digest-only inventory** of the promotion record chain. It
consumes a genuine Phase 239 custody ledger whose custody has been **released**, and a separately supplied
human inventory that must account for all **nine** chain artifacts — Phases 231 through 239, one entry each —
and must claim only that they are **retained**.

It **archives nothing and deletes nothing**. `archivedByThisTool`, `deletedByThisTool`, `retrievedByThisTool`
and `selfAuthorized` are the constants `false`. It moves no evidence, fetches no evidence, and destroys no
evidence; it only checks a record a human produced out-of-band.

## Why this phase exists

Phase 239 says who held the evidence and in what order custody moved, ending in a release. It says nothing
about whether every artifact in the chain is still **accounted for**. A chain whose custody closed cleanly can
still be missing its Phase 236 replay report, and nothing below this phase would notice.

## The headline invariant: an inventory may never record a destruction

`retention` is a **retention-only** closed enum — `RETAINED` and `PENDING`, and nothing else. There is
deliberately no value in this schema that can express destruction. In addition the **whole** supplied
inventory is scanned, values **and** keys, at any depth, for purge/deletion vocabulary: `purge`, `purged`,
`delete`, `deleted`, `destroy`, `destroyed`, `shred`, `shredded`, `erase`, `erased`, `wipe`, `wiped`,
`remove`, `removed`, `discard`, `discarded`. Any hit is `INVENTORY_DESTRUCTION_CLAIMED` and fails closed.

**An evidence inventory that can express deletion is a deletion instrument.** It turns the act of accounting
for evidence into the place where destroying it gets recorded as routine, and it makes the destruction look
like part of the process rather than a departure from it. This mirrors the Phase 235 rule that `evidencePurged`
may never be anything but `PENDING`, raised one layer up and applied across the whole chain.

## The second invariant: no path, location or network data

An inventory is the **single highest-risk leak point in this entire stack**. It is exactly the record where a
human naturally writes where the evidence went — "archived at `/mnt/backup/...`", "on the NAS at `10.0.0.5`",
"`s3://evidence-archive/`". So the **strict** hand-written-record predicate applies (this is not a generated
report), extended to reject anything shaped like a location or a network endpoint:

- IPv4 literals and IPv6 literals (including compressed `::` forms)
- any URL scheme — `https://`, `s3://`, `smb://`, `nfs://`
- UNC paths (`\\server\share`) and drive letters (`D:\`)
- dotted `host:port`
- `hostname.tld` forms
- bucket / object-store naming

Any hit is `INVENTORY_LOCATION_DISCLOSED` and fails closed, and **the offending value is never echoed back**.
The host and hostname patterns deliberately require a dotted name, so a UTC timestamp — which contains colons —
can never be mistaken for an endpoint.

## Eligibility (`NOT_ELIGIBLE`, and it takes precedence over everything)

The Phase 239 ledger must be present, be `phase-239-promotion-chain-custody-ledger`, recompute its self-digest,
be `CUSTODY_LEDGER_INTACT`, **and be closed** — `terminalTransition: "CUSTODY_RELEASED"`. An inventory of
evidence still in **open custody** is premature: the holder may still append events, so a ledger that is intact
but not released is deliberately **not** eligible either (`LEDGER_RECORD_CUSTODY_NOT_RELEASED`).

**Eligibility is checked on the whole body, not the headline** — standing practice since the Phase 234/235
hardening. A self-digest is not a signature, so a forged ledger can carry a green `overall` over a body that
failed Phase 239's own checks and still recompute cleanly. So this phase additionally requires the ledger's own
success booleans (`ledgerIntact`, `redactionSafe`, `verificationEligible`, `eventsWellFormed`,
`eventsRedactionSafe`, `chainLinked`, `transitionsValid`), the did-nothing constants, an **empty** blockers
array, a non-null `headEventDigest` consistent with its bound head, and complete bindings.

When the ledger is not eligible, **no blank inventory is emitted** and no inventory can override the verdict.

## Coverage, binding and transplantation

`entries` is an **array** of exactly nine `{ phase, artifactDigest, retention }` — an array on purpose, so that
**omission**, **duplication** and **reordering** are three distinct, separately-reported failures that a keyed
object could not express, plus a wrong phase set:

| Failure | Code |
| --- | --- |
| wrong number of entries | `INVENTORY_ENTRY_COUNT_INVALID` |
| a repeated phase | `INVENTORY_ENTRY_DUPLICATED` |
| not in ascending phase order | `INVENTORY_ENTRY_OUT_OF_ORDER` |
| a phase outside 231–239 | `INVENTORY_ENTRY_PHASE_INVALID` |

Transplantation is refused by binding the inventory to **this** ledger: its own `ledgerDigest`, its
`headEventDigest`, and the five operation digests (`INVENTORY_NOT_BOUND_TO_LEDGER`,
`INVENTORY_HEAD_EVENT_MISMATCH`, `INVENTORY_<OPERATION>_DIGEST_MISMATCH`).

## `COMPLETE` requires the artifacts; otherwise `STRUCTURAL_ONLY`

Supply `reports` — a bundle keyed `"231"`..`"239"` carrying the real artifacts — and each claimed
`artifactDigest` is **bound** by recomputing that artifact's own self-digest. A claimed digest that does not
match is `INVENTORY_ENTRY_DIGEST_MISMATCH`; an artifact that does not itself verify binds nothing.

Without that bundle the claimed digests were checked against **nothing**, and the verdict is capped at
`INVENTORY_STRUCTURAL_ONLY` — never `COMPLETE`. This is the Phase 236 / Phase 238 precedent: this module never
pretends to bind what it cannot reach. The ledger alone reaches exactly **two** of the nine unaided — Phase 239
(itself) and Phase 238 (the verification it was built over) — and the report says so per entry via
`boundVia: REPORT | LEDGER | UNBOUND`.

## Outcomes

| `overall` | Meaning | Exit |
| --- | --- | --- |
| `INVENTORY_COMPLETE` | all nine accounted for, all retained, all bound against real artifacts, custodian affirmed | `0` |
| `INVENTORY_INVALID` | fail closed — nothing accounted for | `1` |
| (input read error) | a supplied file is missing or not valid JSON | `2` |
| `INVENTORY_PENDING` | valid, but nothing inventoried (blank, in progress, or refused) | `3` |
| `INVENTORY_STRUCTURAL_ONLY` | accounted for and bound to the ledger, but the artifacts were not supplied | `4` |
| `NOT_ELIGIBLE` | no closed custody ledger — nothing to inventory | `5` |

The decision is carried solely by `inventoryAffirmed` (one source of truth, as in Phases 234/235/237/238/239).
`AFFIRMED` additionally requires complete coverage, every entry `RETAINED`, and all three work affirmations —
`INVENTORY_AFFIRMED_WITHOUT_FULL_COVERAGE` / `_WITHOUT_FULL_RETENTION` / `_WITHOUT_FULL_AFFIRMATION`.

Phase 240 has no `DECLINED` outcome, so a `REFUSED` decision is reported as `INVENTORY_PENDING` with
`recordedInventory: "REFUSED"` — a refusal and a blank both inventory nothing, and the refusal stays visible.

## The blank inventory

`buildRetentionInventorySkeleton` returns `null` unless the ledger is eligible. Otherwise it emits nine entries
with **every** `artifactDigest` and **every** `retention` set to `PENDING`, all fields `PENDING`, and no
custodian or time. It pre-fills only derived bindings. It never invents an artifact digest and can never
produce a `COMPLETE` inventory — the string `RETAINED` does not appear in it at all.

## Usage

```
npm run ops:promotion-evidence-retention-inventory -- \
  --ledger    phase-239-report.json \
  [--inventory retention-inventory.json] \
  [--reports   artifacts-by-phase.json] \
  [--out       inventory-report.json] \
  [--skeletonout blank-inventory.json]
```

## Current state of the prepared P227-A run

**`NOT_ELIGIBLE`, and structurally so.** The real chain stops at Phase 232 `PENDING` — no human ever approved
the run — so its replay never closed, its provenance was never committed, its source records were never
verified, and its custody ledger is itself `NOT_ELIGIBLE`. There is no closed custody for an inventory to be
**of**.

Locked offline fixtures assert `NOT_ELIGIBLE`, a `null` blank inventory, `recordedInventory: "NONE"`,
`entryCount: 0`, and `inventoryComplete: false` — and that it **stays** `NOT_ELIGIBLE` when handed a
fully-formed `COMPLETE` inventory shaped for the real operation. No completed inventory, intact ledger,
verified submission, committed manifest, `APPROVED` authorization, `RECORDED` observation, `ACCEPTED`
disposition or `CLOSED` closure is constructed for the real bundle anywhere in this repository.

## What this does and does not prove

It proves an **accounting**: a human enumerated every artifact in the chain, claimed each is retained, bound
the inventory to one released custody ledger, and — where the artifacts were supplied — each claimed digest
matched the real one. A later substitution of any listed artifact is detectable against this record.

It does **not** prove the artifacts **exist**, are readable, are stored anywhere in particular, or will
continue to exist. An inventory is a claim about the world, and no digest can confirm a claim about the world.

Most importantly, it **cannot detect an artifact that was destroyed and then honestly re-listed as `PENDING`**:
from here, a missing artifact and an unfinished inventory are indistinguishable. The invariant this phase
enforces is that destruction can never be *recorded* as routine — not that destruction cannot *happen*.

## Tests

`test/promotion-evidence-retention-inventory.ts` (also `npm run test:phase240-local`), 22 tests: a genuine
`COMPLETE` inventory; `STRUCTURAL_ONLY` without the artifacts; the blank skeleton as `PENDING`; **the
destruction rule** across all sixteen vocabulary forms, in a value *and* in a key, never echoed; a retention
state outside the closed enum; **the location rule** across eleven leak shapes, never echoed, with a
no-false-positive check on a genuine inventory; omission / duplication / reordering / wrong phase set;
transplantation onto a different ledger; a claimed digest that is not the real artifact; a supplied artifact
that does not itself verify; `NOT_ELIGIBLE` over a non-intact ledger **and** over an intact-but-open custody;
`NOT_ELIGIBLE` precedence over a broken inventory; a fourteen-case recomputed-self-digest ledger forgery
proving each eligibility check is reachable while the digest check stays silent; affirmation and
custodian/timestamp discipline; an impossible calendar time; malformed literals and structures; a
redaction-safe CLI across all six exit paths; and the real P227-A locks.

## What this phase deliberately does NOT do

It does not archive, retrieve, move or delete any evidence; it does not confirm that any artifact exists; it
does not run the promotion launcher, read or write the real Movies library, or contact Jellyfin; it does not
read the secret approval file; and it does not merge, tag or push. Those remain separate human steps, preserved
behind the live boundary.
