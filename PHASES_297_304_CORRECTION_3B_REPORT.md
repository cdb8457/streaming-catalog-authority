# Phases 297–304 — correction 3b

Six functional commits from `c4893a6`, worktree clean. **Nothing pushed, no PR opened.** `6b16c9a` and
`c4893a6` are untouched.

| Commit | Item |
| --- | --- |
| `a890a7d` | 5 — path overlap must match the filesystem, not the string |
| `a95e828` | 1 — a safety set is this operation's only if this operation published it |
| `ebdc1a8` | 3 — staging claimed before it is filled, sealed before it is used |
| `fdd2fab` | 4 — the direction of an operation is recorded before its first effect, and is exclusive |
| `1f1323d` | 2 — a component handed to another process is verified after it was read |
| `ea38ce4` | 6 — case-variant overlap and the journal-state matrix |
| `f156b4d` | 1 (corrected) — an unforgeable per-run claim, after the coordinator rejected the derived name |

## Item 1 — safety-set provenance

Recovery adopted **any** set at the operator's chosen name that verified. But `ops:complete-backup` refuses
an existing set name, so "a valid set already sits there" is exactly the condition under which this run's own
backup fails — and dying just before that refusal leaves precisely the state the old check read as success. A
resume adopted a **stranger's backup** as the only thing between the installation and unrecoverable loss.

**My first fix for this was wrong, and the coordinator rejected it correctly.** It published to
`<base>.<twelve hex of the plan digest>` and argued no other operation could produce that name. The argument
fails on its own premise: the plan digest is **deterministic**, so the name is **predictable** — and an
ordinary sequence puts a valid unrelated set at it. Run the restore, abandon it, leave its safety set behind;
run the same restore again and die inside the safety-set step before the backup refuses the existing name.
The set sitting there backs up a **different moment**, and adopting it hands the operator a safety set that
does not describe what is about to be destroyed. "The name matches" can never distinguish "we published it"
from "it was already there and blocked us": those states are identical on disk.

The claim is therefore not a name:

1. A **nonce** from the system CSPRNG, per run — derived from nothing, so unpredictable to anyone who has not
   read this run's journal.
2. A **directory created with `mkdir`**, the one filesystem operation that both creates and refuses
   atomically. Creating it *is* the claim: it succeeds for exactly one party.
3. Recorded in the journal only **after** that call returned — so `created: true` is a fact, not an inference
   — and **before** anything is published into it, which is the correct side of the absence/publication
   boundary.

The set is published *inside* the claimed directory. "It is in a directory this run created, under a name
nobody could guess" is provenance a pre-existing set cannot have, however it is named. An already-existing
claim directory was not created by this run, so the run draws another nonce rather than adopting from it.

Eight tests, including the exact negative the review named: valid sets planted at **both** locations a
name-based scheme would predict (the operator's chosen name and the plan-derived one my first fix used),
death inside the safety-set step before the backup can reject anything, and a resume that publishes its own
set inside its own claim while leaving both strangers byte-for-byte untouched. Plus an occupied claim
directory, and a claim recorded but never created.

## Item 2 — mutation during consumption

`psql` and `compose cp` are handed a **pathname**. Verifying before that proves what was on disk a moment
before the child opened it. Both are now verified **after** consumption; a bound check, not a perfect one,
and it is documented as such — it cannot see what the child read, but it can refuse to carry on when the
bytes are no longer the manifest's, because what landed is then unknown.

`place-inline-keystore` was declared `retry` on the reasoning that re-copying the same bytes leaves the same
tree. False once the source can change mid-copy: the volume holds bytes nobody can account for and a second
copy does not remove them. It rewinds now. **Both rewinds go to `stage-components`**, not the teardown —
repeating the leg without rebuilding the suspect artifact would replay the same bytes again.

Both tests assert the stack was never booted and exactly one replay landed after the rewind.

## Item 3 — mid-copy staging death

The marker was written **last**, so death during the copy left an unmarked tree at a predictable name that
the resume could neither trust nor remove: the project wedged until an operator deleted a directory of
secrets by hand. A **claim** now precedes the first byte; **sealed** follows the last verification. Only a
sealed tree may be consumed; a claimed one may only be rebuilt, and only by the operation that claimed it.

Canonical validation, because this document authorises recursive deletion: known component ids each exactly
once, the canonical artifact name per id, 64-hex lowercase digests, non-negative safe-integer counts, and —
where a manifest is available — the exact component set and values the backup set declares. **Two bars:**
removal needs ownership; consumption needs manifest agreement as well, so a merely inconsistent marker stays
removable and cannot re-wedge the project.

The copier is injected (same idiom as `Renamer`, `JournalWriter`) because a copy is synchronous and no timer,
signal or exception can stop one from outside. Two real child-process deaths mid-copy — database file and
directory component — plus fifteen marker mutations.

## Item 4 — abandon direction persisted and exclusive

An abandon could unwind one target, fail on another, remove staging and leave restore step states — and a
resume then **rebuilt the restore on top of the unwind**. `phase: 'abandoning'` is written before the first
rename; from then a run and a resume refuse with **zero effects**. Staging is not removed while any swap is
unresolved. Every `.abandoned-` copy **on disk** is named, including one an earlier attempt made for a swap
whose `replaced` is non-null — existence decides, not which branch created it.

The required multi-swap test covers all of it, plus a real death at the phase transition.

## Item 5 — filesystem-correct overlap

The comparison was case-sensitive and this product ships on Windows. `--secrets secrets --promotion-records
SECRETS` passed the guard against two components naming one directory; `--secrets BACKUPS` passed the guard
against renaming the backup destination aside with the set inside it. Identity and containment now fold case
on hosts whose filesystems do, with whole-segment prefixing preserved in both modes. Explicit semantics are
unit-tested on every platform and the real behaviour is exercised through the shipped resolver on this host
(**Windows**, so the case-insensitive branch is the one that ran).

## Item 6 — journal version and matrix

Journal version **3 → 4** (`phase`, `safetySetPublishedName`). The reader rejects an unknown or absent phase,
a published name that is a path or not a name, self-contradicting evidence, evidence of an unplanned safety
set, and version 3; and accepts each genuine crash state.

## Item 7 — verification

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | **PASS**, 0 errors |
| `npm run test:complete-restore` | **116 passed, 0 failed** (was 95) |
| `npm run test:complete-backup` | 49 passed, 0 failed |
| `npm run test:custody-proof` | 9 passed, 0 failed |
| `test/test-runner.ts` | 60 passed, 0 failed |
| `npm run test:inventory` | **ok: true**, 322 suites, 6 helpers |
| `npm test -- --group db` | **33/33 PASS** |
| `npm test -- --group offline` | 287 selected, **284 pass, 3 fail** |

**Baseline comparison for the failures.** `kek-correction-gates.ts`, `custody-cutover.ts` (2 checks),
`custody-transition.ts` — the same three that fail identically on `b704935`, before this tranche began,
verified in an earlier dispatch by stashing the whole branch and re-running. Custody/compose-wiring family,
untouched deliberately.

**NOT_RUN, with the exact environment reason.**

- **Docker acceptance group** — no daemon: `failed to connect to the docker API at
  npipe:////./pipe/dockerDesktopLinuxEngine … The system cannot find the file specified.`
- **A live `ops:complete-restore --confirm`** — needs a real daemon, real images, a real installation.
- **A live in-container `ops:custody-proof`** — same; its logic is covered against a real embedded PostgreSQL
  with real key material, only the `compose exec` transport is unexercised.
- **Real `pg_dump` / `psql` binaries** — the embedded PostgreSQL package ships neither (pre-existing skip).

## Remaining risks

1. **The after-consumption check is a bound, not a proof.** It cannot observe what the child process read; it
   observes what is on disk afterwards and refuses to continue on a mismatch. Closing it properly would mean
   handing the child a descriptor it cannot re-open, which `compose cp` does not offer.
2. **Parent-directory fsync is still absent**, so the durability claim stays at process death.
3. **The claim nonce is 96 bits from the system CSPRNG**, and the claim survives only in the journal. A lost
   journal means a lost claim — which is safe (the next run claims afresh and adopts nothing) but leaves the
   orphaned directory for an operator to remove; it is named in the report.
4. **A case-sensitive volume mounted under Windows** is treated as case-insensitive; the cost is refusing two
   targets that could have coexisted.
5. **Journal version 4 is not migrated from 3.** Fails closed, as before.
