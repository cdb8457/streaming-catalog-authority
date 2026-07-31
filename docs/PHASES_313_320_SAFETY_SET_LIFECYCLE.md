# Phases 313–320 — the lifecycle of the safety sets a restore creates

`npm run ops:safety-set-lifecycle`

## The gap, named by the previous tranche's own report

Phases 297–304 made every `ops:complete-restore` take a **verified backup of the installation it is about to
destroy**, and publish it inside a directory that run claims exclusively:

```
<destination>/.pre-restore-claim-<24 hex nonce>/
    catalog-restore-claim.json        the ownership marker, written before the journal records the claim
    pre-restore-<set>/                the safety set, taken by the shipped ops:complete-backup
```

Phases 305–312 then shipped `ops:backup-retention`, whose inventory classifies **every dot-prefixed name** as
`RESERVED` and never descends into one. That rule is correct and it is load-bearing: one rule keeps retention
away from a backup staging tree (`.<set>.staging-<hex>`), a restore in progress, a lock directory and its own
quarantine, and it covers every namespace a later phase adds **without any of them having to be enumerated**.

Together they mean safety sets accumulate **one per restore, forever**. The 305–312 report says so:

> **Safety sets are invisible to retention.** … Those accumulate one per restore and this command will not
> remove them. Reported honestly as a non-goal rather than solved by descending into a namespace another
> command owns.
> — `PHASES_305_312_REPORT.md`, *Remaining review risks*, item 1

This tranche closes it **the way that report said it should be closed**: not by teaching retention to descend,
but with a separate command that has a separate ownership proof.

| Phase | What it adds |
| --- | --- |
| 313 | The claim inventory — every top-level entry that is, or is shaped like, a claim, classified from evidence; and `maintenance-identity.ts`, the read-only ownership primitives both commands now share |
| 314 | The policy — `keep-last`, `min-age-days`, `include-unverified`, `include-empty-claims`, `keep-minimum-restorable`, evaluated purely |
| 315 | The protection boundary and the plan, with a digest over the claims **and** the ordinary sets beside them |
| 316 | The journal, the quarantine marker and the per-claim commitments |
| 317 | Execution — the same two lock domains in the same order, a re-proof under them, quarantine before delete, and a **live floor re-proof before the first irreversible act** |
| 318 | `--abandon`, the retained-artifact report and the three honest end states |
| 319 | The CLI, the operator surfaces, and a scheduled example that prints a plan and removes nothing |
| 320 | The acceptance suite, the required CI gate, the docs and the suite inventory |

## What this command is, and what it is not

* It removes **claim directories**, which is the unit `ops:complete-restore` owns. A claim without its safety
  set is an orphan; a safety set without its claim is not something this build ever produces.
* It removes one **only** when the marker **inside** it proves a restore of *this build* created it, **and**
  the directory's own name is the one this build derives from the nonce in that marker.
* It **never touches an ordinary backup set.** Those are `ops:backup-retention`'s, and no decision this
  command makes can name one. They are inventoried — the floor is counted over them — and never acted on.
* It **issues no command of any kind**: no `docker`, no child process, no network, no registry, no media path,
  no media server. It is host-side filesystem work under a lock.
* It is **never scheduled**. There is no `--force`, no `--yes`, no confirm-by-typing-yes. A human reads a plan
  and types back a digest bound to the whole thing.

### What it reads, exactly

Deciding whether a safety set is good means hashing every byte of it, and one of its four components is the
secrets directory — so this **does open and read secret files**, through descriptors, without following links,
for the sole purpose of hashing. It never interprets, parses, prints, digests-into-a-report or otherwise
surfaces a byte of them; it accepts no credential on a command line; and no path and no component content
reaches any report. The comfortable claim — "it never touches a secret file" — would be false, so it is not
made.

## Threat and failure model

**Who this defends against.** An operator's own mistake, a half-finished run, a crash, a concurrent command,
a directory that is not what its name says, and a *document* that has been edited to point the operation
somewhere it should not go.

**Who it explicitly does not defend against.** A user who can rewrite all local state. Every proof here —
the claim marker, the journal, the quarantine marker — is an unauthenticated file in a directory that user
owns. Nothing here is a cryptographic authority against them and nothing claims to be. What the proofs give
is:

* an **ordinary or foreign directory is never removed**, because removal requires a marker of this build's
  shape *and* a set whose bytes still hash to the recorded identity — and a forger who can produce both can
  already delete the directory themselves;
* an **accident cannot reach past ownership**, because every gate is evidence-based rather than name-based;
* a **document alone can authorise nothing**, because the authority is the evaluator re-run and an on-disk
  identity proof, not a re-hash of the document.

**Failure modes it is built for.** A process that stops existing at any point; a rename that lands with no
record; a removal that unlinks some children and then throws; a journal that cannot be written; a destination
that changed under an interrupted run; a claim replaced, moved, mutated or swapped for a different valid claim
of ours; a quarantine directory replaced by an ordinary one.

## Phase 313 — the inventory, and why the name decides nothing

An entry enters the claim inventory when **either** is true:

1. it is a **real directory** — `lstat`ed as itself, never through a link — and carries a file at the claim
   marker's name, whatever that file turns out to be. So a claim somebody **renamed** is still found, and
   reported as moved rather than silently ignored; or
2. its own name has the shape a claim directory's name has — so a claim-shaped directory carrying **no**
   marker is reported rather than invisible.

**The entry is examined before any child of it is named** *(Correction 1)*. The first cut asked rule 1 first,
by `lstat`ing `<entry>/catalog-restore-claim.json` — a path that **resolves `<entry>`**, so for a symbolic
link or a Windows junction the probe traversed the link, out of the destination and into whatever it pointed
at, purely to answer a question about admission. A directory this command has been told to inventory must
never be a reason to read somewhere it was not told to look. A link at a claim-**shaped** name is still
admitted, by its name alone, and classified `NOT_A_DIRECTORY` without being opened; a link at any other name
is not this command's business and is not touched, opened or followed to find out.

Neither is trusted alone. Nine classes, closed and total:

| Class | What it is | Removable? |
| --- | --- | --- |
| `OWNED_SET` | Marker proved; holds exactly one safety set that **verifies** | yes, subject to policy |
| `OWNED_UNVERIFIED` | Marker proved; the set does not verify, or its manifest cannot be read | only with `--include-unverified` |
| `OWNED_EMPTY` | Marker proved; nothing inside but the marker | only with `--include-empty-claims` |
| `OWNED_IN_FLIGHT` | Marker proved; holds a dot-prefixed in-flight artifact — a backup is, or was, being taken into it | **never** |
| `OWNED_UNEXPECTED` | Marker proved; holds something this build does not publish into a claim | **never** |
| `OTHER_BUILD` | A claim marker of this product at a persisted schema this build does not implement | **never** |
| `MALFORMED` | No marker, an unreadable one, a foreign one, one whose fields disagree, or one whose nonce does not name the directory it is in | **never** |
| `UNREADABLE` | It could not be examined or listed | **never** |
| `NOT_A_DIRECTORY` | A link, a reparse point or a file at a claim-shaped name | **never** |

Every row also carries a closed **evidence** value (`MARKER_PROVED`, `NO_MARKER`, `MARKER_UNREADABLE`,
`MARKER_NOT_OURS`, `MARKER_OTHER_SCHEMA`, `MARKER_MALFORMED`, `MARKER_NAME_DISAGREES`, `NOT_A_DIRECTORY`,
`UNLISTABLE`, `SET_UNREADABLE`, `SET_DOES_NOT_VERIFY`, `EMPTY`, `IN_FLIGHT_ARTIFACT`, `UNEXPECTED_MEMBERS`),
printed beside the decision — because "MALFORMED" alone does not tell an operator whether to be worried.

**Active claims.** A claim referenced by a live restore journal is protected by **refusing the entire
operation** before the destination is even listed, which is strictly stronger than classifying one entry. A
claim that is being written into *right now* also classifies `OWNED_IN_FLIGHT` on its own evidence, so the
two protections are independent.

**Nothing is ever followed.** `lstat` at every step; the marker is opened without following a link; a link at
the marker's name is `MARKER_NOT_OURS` rather than read through. It descends exactly one level, into a
directory that has already proved it is ours.

### The shared primitives, and why exactly these

`src/ops/maintenance-identity.ts` holds the read-only answers both destroying commands need:

* `SAFETY_CLAIM_MARKER_ID` / `SAFETY_CLAIM_MARKER_FILE` — **one definition** of what a claim is.
  `complete-restore.ts` imports both; it holds no literal copy, and a test asserts that.
* `readRestoreClaimMarker(dir, name, expectation)` — the marker reader. The build-specific values (journal
  version, nonce shape, directory naming, suffix derivation) are **passed in**, so the dependency points one
  way and there is no import cycle between the module that defines them and the module that validates them.
* `proveBackupSetIdentity(path, commitment)` — the four-layer set-identity proof, moved out of
  `backup-retention.ts` **unchanged, refusal wording included**. `proveSetIsPlanned` now delegates to it.
* `manifestShape` — what a set declares itself to be.

Nothing in that module performs an effect. A shared primitive that could act would be a shared primitive that
could act on the wrong tree.

## Phase 314 — the policy

| Flag | Default | What it does |
| --- | --- | --- |
| `--keep-last <n>` | 3 | Keep the newest *n* **complete** safety sets. Ranks `OWNED_SET` only. |
| `--min-age-days <n>` | 14 | Nothing younger is removable, whatever the window says. |
| `--include-unverified` | off | Make `OWNED_UNVERIFIED` claims candidates. |
| `--include-empty-claims` | off | Make `OWNED_EMPTY` claims candidates. |
| `--keep-minimum-restorable <n>` | 1 | Refuse the whole run if it would leave fewer restorable sets **across the whole destination** than this. |

The defaults are more conservative than retention's (7/7) on purpose. A nightly set is one of many taken from
a healthy installation; a safety set is the single snapshot of a moment nobody can reproduce — the state
immediately before somebody destroyed it on purpose — and the pile grows one per restore rather than one per
night.

**An empty claim's age comes from the directory's modification time**, because it has no manifest. That is
weaker evidence than a date inside a set, it is stated as such in the plan beside every decision that rests on
it, and it is the only place any filesystem timestamp is used. A claim with no mtime at all is
`PROTECTED_UNDATED`.

## Phase 315 — the protection boundary

Evaluation order, and it is the whole safety argument:

1. not proved ours — nothing else is even asked
2. the newest restorable safety set — **unconditional**
3. the newest rollback point (verified, not restorable here) — **unconditional**
4. in flight
5. unexpected contents
6. **no recorded identity** — unconditional
7. unverified, not included
8. empty, not included
9. undated
10. younger than `--min-age-days`
11. inside `--keep-last`
12. otherwise: remove

**Why "no recorded identity" is unconditional and not part of `--include-unverified`.** A claim whose safety
set could not be examined at all — an unreadable manifest, a verification that threw — carries no set digest,
and the identity proof refuses to act on a commitment with nothing in it. Without this branch,
`--include-unverified` would produce a plan naming that claim, an operator could confirm it, and the run would
then **stop on it at the first proof**, leaving every later candidate untouched and the operation unable to
finish. A candidate a run can never perform is not a candidate; it is a plan that lies. (Found in this
tranche's own hostile self-review — see the builder's report.)

Two whole-run refusals, and neither prints a digest — a plan that showed a confirmable digest beside "this
would leave you with nothing" would be a plan somebody could confirm:

* `NO_RESTORABLE_SET` — nothing in this destination could restore this installation, at the top level or
  inside a claim.
* `FLOOR_NOT_MET` — the policy would leave fewer restorable sets than `--keep-minimum-restorable`.

### The floor is counted over the WHOLE destination

This is the protection that makes this command different from retention. The headline case:

> A destination whose ordinary top-level sets are all from **before** this build's schema — the shape a
> destination has after an upgrade — and whose only restorable set is a **safety set inside a claim**. That
> safety set is protected, whatever `--keep-last` says, because the count of "things this build could restore
> from" includes it and it is the whole count.

### What the digest binds

The project and the destination (hashed, never rendered); **every claim's marker identity** — its nonce and
the plan digest of the restore that created it; every claim's class, evidence, safety-set identity, date,
sizes and findings; **the destination's ordinary inventory**, so a nightly backup taken since the plan was
read refuses; the policy; the ordered removals; both protected claims; and both counts.

A plan becomes stale when any of that moves. The suite drives: a new claim, a new top-level set, a safety
set's bytes changed, a claim's marker rewritten, a different policy, a different project, and ten days of
clock across `--min-age-days`.

## Phases 316–317 — execution

```
1. resolve, and refuse a project part way through a restore OR a prune
2. take the PROJECT lock, then the DESTINATION lock — the same two domains, in the same order,
   ops:backup-retention takes, so no new lock order exists
3. re-inventory and re-verify from scratch UNDER THE LOCK; require the confirmed digest
4. journal the whole committed decision list before the first effect
5. publish an OWNED quarantine directory; rename every removal into it, oldest first  <- reversible
6. RE-PROVE THE FLOOR FROM LIVE DISK                                                   <- last gate
7. for each: prove the claim is the planned one, record `deleting`, then remove it     <- irreversible
8. re-verify, from disk, the safety set this run promised to protect
9. release both locks in a `finally`, innermost first
```

### The destination lock is shared — SUPERSEDED BY PHASES 321-328

**As shipped in 313-320** the destination lock was retention's, named `.catalog-retention.lock`, taken in the
destination after the project lock, and shared by these two commands only. Both rename directories inside one
destination and both count what it holds, so sharing it made "two commands cannot be half way through one
destination at once" true rather than hoped for. Same domains, same order, **no new deadlock**.

**Phases 321-328 replaced it.** The lock is now `.catalog-destination.lock`, defined once in
`maintenance-safety.ts`, and taken by **all four** backup-family commands — `ops:complete-backup` and
`ops:complete-restore` included — so the shared-destination boundary this document describes below as a
documented limit is closed. The old name is still refused by name so a lock left by a build before that
change cannot become invisible. See
[PHASES_321_328_SHARED_DESTINATION_LOCK.md](PHASES_321_328_SHARED_DESTINATION_LOCK.md).

### The refusal is one-way, on purpose

This command refuses when `ops:backup-retention`'s journal is present. Retention is **not** taught to refuse
when this command's journal is present, and that is deliberate: two commands that each refuse while the other
is interrupted is a pair neither of which can ever be resumed. Retention never descends into a claim
namespace, so an interrupted lifecycle run cannot make a prune wrong — while the reverse is not true, because
this command's floor is counted over sets a prune can legitimately remove.

### A live RESTORE refuses every mode, `--abandon` included

*(Correction 1.)* The prune exception above is for an interrupted **prune**, and only that. `--abandon` did
not take the restore check at all, so an abandon could run beside a live restore and rename claim directories
back into the destination that restore is publishing into. It is checked now **before the lock, and again
under it, before `phase: 'abandoning'` is written or anything is moved** — so a refused abandon leaves the
journal byte-identical.

**Presence, not readability, and asked without following a link.** `existsSync` FOLLOWS a symbolic link, so
it answers *false* for a dangling one — and a dangling link at a journal's name is exactly the state a
half-tidied project is in. It also answers about the target rather than about the name. The question is "has
another command left its mark here", and the safe answer to "there is something at that name and this build
cannot say what" is **yes**. `lstat` answers about the name itself: a file, a directory, a link, a dangling
link or a device all block. This applies to `--plan`, `--confirm`, `--resume` and `--abandon` alike.

### The live floor re-proof

A `--confirm` re-proves the plan under the lock. A `--resume` does **not** — it continues the operation the
journal recorded, and between the crash and the resume anything can have happened, most obviously a retention
prune that held the same destination lock this run is holding *now* but was not holding *then*.

So immediately before the first irreversible act, and after the reversible phase has completed, the count is
taken again from what is actually on disk. If it does not hold, the run stops with **nothing destroyed**:
every claim it set aside is whole in the quarantine directory and `--abandon` puts all of them back. The
report carries it in its own field, `haltedBeforeDeleting`, because it is not about one claim — it stops every
deletion rather than one.

### Nothing is deleted in place

Every claim is **renamed** into a private quarantine directory in the same destination — same filesystem,
atomic — and only then removed. At every instant an observer can look, a claim name in the destination holds a
whole claim or nothing at all.

The quarantine directory is published **already marked**, in one atomic step: built under an unpredictable
name (`.catalog-safety-set.claiming-<18 hex>`), the marker written inside while it is still invisible, and
only then renamed onto the predictable path (`.catalog-safety-set.removing-<12 hex>`). The predictable path is
never observable in a state a reader has to guess about.

**An unpredictable name is not ownership.** The suffix is written down in the journal, in a directory the
operator owns, so after a crash it is *published*, not unguessable — and an allowlist of child names is not
ownership either, for the same reason. The marker is bound to the journal version, the plan digest, the
suffix, the ordered removal list and **every claim's exact commitment**, compared **whole**, and verified
before every rename into it, every deletion out of it, every abandon and every cleanup.

### The commitment, proved immediately before every effect

`proveClaimIsPlanned` is two proofs, and both are needed:

* the **claim's own marker**, read at the name the claim has right now, must still name the same nonce and the
  same restore plan digest;
* the **safety set inside it** must satisfy `proveBackupSetIdentity` against the identity recorded when the
  plan was made — digest, verdict, exact finding set, `takenAt`, sizes and schema version.

A claim recorded as **empty** is proved empty: "it held nothing when we looked" is a commitment like any other,
and a claim that has since had a set published into it is not the claim that was planned.

It is checked **before the rename**, not only before the delete. A rename is reversible and it is still an
effect on a directory in somebody's backup folder — and a journal whose claim row *fabricates* a marker for a
stranger's directory passes every document-level check.

### The consumption marker — live ownership of the one child being destroyed

*Added by Correction 1. The quarantine marker proves the **container**; this proves the **child**.*

A quarantine marker says "this directory is this operation's" and carries the list of names this operation
put in it. That is a list of **names**, and a name is not a tree. Once an entry is recorded `deleting` its
tree may be partial, so it cannot be re-proved against its commitment — and the first cut concluded from that
that it could be removed on the strength of the outer marker alone. **Anything that took the child's name
after the record was persisted was then recursively deleted.**

So the authority for consuming a child lives **inside the child**, is bound to an unpredictable
`consumeNonce` drawn per consumption and persisted in the journal entry, and — the part that makes it work —
**it is the last thing removed**. That gives one invariant, and every question a recovery asks is answered
by it:

> **The first `unlink` inside a claim is always preceded by a valid consumption marker inside it.**

| What the recovery finds | What it means | What it does |
| --- | --- | --- |
| Marker **absent**, tree non-empty | Nothing has been unlinked yet | Prove it is the planned claim, exactly as an intact one. A replacement fails here |
| Marker **present** and this consumption's | This operation began consuming it; it may be partial | Finish it |
| Marker **present**, not this consumption's | Something else | Refuse; nothing removed, nothing after it touched |
| Marker **absent**, directory **empty** | The tail: everything went, including the authority, and the `rmdir` did not | Remove the empty directory. Nothing can be lost |

The ordering is: prove the intact tree → **persist the nonce** → write the marker → remove. A marker written
before the journal recorded the nonce would be an authority nothing could check.

**What it is not.** Proof against somebody who can rewrite the journal, because the value it binds is written
down there. That is the same boundary every other proof in this command has and it is not restated as a
stronger claim.

**Journal schema 2.** `consumeNonce` could not be a compatible addition: a version-1 `deleting` entry
describes a consumption whose live child can never be identified, and there is nothing correct to fill the
field in with. A version-1 document is refused **at the version boundary**.

### Per-claim states, and why `deleting` had to exist

`pending → quarantined → deleting → removed`, plus `failed`.

A process that stops existing inside a recursive removal leaves a **half-consumed** tree. `quarantined` beside
an intact tree and `quarantined` beside a half-consumed one are indistinguishable, and a resume has to both
re-prove an intact tree before destroying it *and* finish a legitimately partial one. `deleting` is written
before the first `unlink` and is the only state under which a tree that does not match its commitment may
still be removed. It also makes `quarantined` + gone **impossible by construction**.

**A failure never moves an entry out of `deleting`.** After the first `unlink` the tree may be partial, and
`deleting` is the only thing that authorises finishing it; rewriting it to `failed` would strand the operation
— a resume would try to prove a half-deleted tree against a commitment it can never satisfy, and an abandon
will not put a truncated tree back either. The reason travels in the report, which is where an operator reads
it.

### The precondition table

`safetyPreconditionRefusal(state, inDestination, inQuarantine)` is an **exported total function**. Five states
× two presences × two presences = twenty combinations; **eight are legal, twelve are not**, and both-places is
illegal in every state. The executor calls it and the suite enumerates it, so the two cannot drift — and the
suite then arranges the real filesystem and the real journal into **all twenty** and requires the shipped
executor's answer to be the table's, with a **witness** claim proving that a stop really stopped and a
completing run really continued.

**One impossible state stops every later destructive effect.** The sweep runs before this process performs a
single effect; a stop keeps the journal, leaves every untouched candidate exactly where it was and **named in
the report**, and leaves everything already renamed recoverable with `--abandon`.

## Phase 318 — abandon

Three states, and only one of them is `ok`:

| State | Meaning | Exit |
| --- | --- | --- |
| `ABANDONED` | Everything put back, nothing gone, nothing retained | 0 |
| `ABANDONED_WITH_LOSS` | Everything recoverable put back; something had already been deleted, and it is **named** | 1 |
| `PARTIAL` | Something is still out of place, or the quarantine directory survives | 1 |

A `deleting` tree is **not** put back — it may be truncated, and a partial safety set under a name an operator
trusts is worse than none. Clearing the journal when no reversible work remains never converts loss into
success.

**`deleting` is answered first, because only it knows what an absence means** *(Correction 1)*. The
target-present branch used to come first and read as "never quarantined, or already put back by an
interrupted abandon" — a sentence that is **false** for a `deleting` entry. Such an entry was definitely
quarantined and its tree may already have been destroyed, so an unrelated directory that had since taken its
name was read as a clean put-back: the entry was marked `pending`, counted as neither put back nor lost, and
an abandon that had lost a safety set could render `RESULT: ABANDONED` and exit zero. A `deleting` entry
whose tree is gone is now **loss**, named as such, and whatever occupies its old name is reported as *not*
the claim this operation destroyed and is never touched.

**An interrupted abandon rename is told apart from a replacement, where the distinction exists.** For a
`quarantined` entry with something at its own name, the two readings — a previous abandon really did rename
it back and die before recording it, or something unrelated took the name — are distinguished by **proving
the target against the commitment**. A genuine put-back is reported as one; a replacement is named unresolved
and left alone. For `pending` and `failed` there is nothing to distinguish: this operation never moved them.

## Phase 319 — the surfaces

* **`ops:safety-set-lifecycle`** with four modes: `--plan`, `--confirm <digest>`, `--resume <digest>`,
  `--abandon`. Each accepts only its own flags — a flag this command would ignore is refused, because a flag
  that does nothing is a flag somebody believes did something. `--resume` and `--abandon` take **only**
  `--project`: the operation comes from the journal, not from a command line typed later.
* **`--json` is exactly one document, on one stream, on EVERY path.** stdout for plan, run, resume, abandon
  and an incomplete run; stderr for a post-effect failure, a **pre-effect refusal** and a **usage error** —
  the same stream ownership `ops:complete-restore` and `ops:backup-retention` use, so all three automate the
  same way. Every remediation sentence dropped from JSON mode is already inside the report's `notes`; a
  refusal or a usage error becomes a `SafetySetRefusalDocument` carrying `state`, `exitCode` and this
  product's own redacted words, rather than prose. *(Correction 1: the refusal and usage paths emitted plain
  text, which is what a scheduled `--plan` against a busy project meets first.)* **`--help` is the one
  documented exception and stays human text even beside `--json`.**
* **Exit codes**: `0` completed and the protected safety set still verifies · `1` a removal did not complete,
  or the protected set could not be verified afterwards, or an abandon was not clean · `2` bad usage · `3`
  refused before anything was moved. A failure that arrives after claims have moved never exits `3`.
* **The operator panel** renders `SAFETY_SET_LIFECYCLE_NOTE` and `SAFETY_SET_LIFECYCLE_COMMANDS` from
  `backup-components.ts` — one model, so the panel, this document and the command cannot disagree. The
  rendered command is the **plan**; no `--confirm` appears on the page.
* **`deploy/unraid-catalog-maintenance.sh safety-set-plan`** runs the shipped command in `--plan` mode and
  prints the result. **There is no mode of that script that removes anything**, and no line it executes
  carries `--confirm`.

## Non-goals, stated rather than implied

* **It does not make `ops:backup-retention` descend into a claim.** That rule is unchanged and a test asserts
  it still holds against the same fixtures.
* **It does not schedule anything.** No timer confirms; no timer deletes.
* **It does not defend against a user who can rewrite all local state.** See the threat model.
* **It does not repair a claim.** A claim holding something unexpected, one that has been moved, or one from
  another build is reported and left alone. Repair is a decision, and this command makes exactly one.
* **It does not touch an ordinary backup set**, a database, a keystore or a running container.

## Limits, stated rather than discovered

1. ~~**A shared destination is a limit, and here is the exact boundary.**~~ **CLOSED BY PHASES 321-328.** As
   shipped in this tranche, the destination lock stopped two *destination-maintenance* runs — this command and
   `ops:backup-retention` — from overlapping, and did **not** stop another **project's** `ops:complete-backup`
   or `ops:complete-restore`, which held only their own project locks. Three things narrowed it and none of
   them closed it: a claim being written into is `OWNED_IN_FLIGHT` and protected; the default
   `--min-age-days 14` protects anything a running restore just created; and the marker proves only that *a*
   restore of this build made the claim, not which project's. **All four commands now take one shared lock in
   the destination**, so a second project pointed at the same physical directory is refused before it stages,
   claims, renames, deletes or runs anything. The three narrowings above are unchanged and still hold; they
   are no longer the only thing holding. See
   [PHASES_321_328_SHARED_DESTINATION_LOCK.md](PHASES_321_328_SHARED_DESTINATION_LOCK.md).
2. **It reads every byte of every set in the destination — three times over a whole `--confirm`.** Once for
   the plan, once for the re-plan under the lock, and once for the live floor re-proof before the first
   deletion; plus each claim it is about to *act on* twice more, immediately before the rename and immediately
   before the deletion, because a commitment checked at any earlier moment is a commitment about a moment that
   has passed. On a destination of many large sets that is real time, and it is why this is a human operation
   and not a job. The third read is redundant on a `--confirm` and is **not** redundant on a `--resume`, which
   is the path it exists for; it is not skipped on `--confirm` because a rename that went wrong without
   throwing would otherwise reach the delete phase unchallenged.
3. **`takenAt` is not covered by the verification digest.** Ordering trusts the manifest's date. An operator
   who can edit it can already delete the claim, so it is not an escalation, but it is stated rather than
   closed — and the plan prints every date beside its decision for that reason.
4. **An empty claim's age is filesystem metadata.** A copy, a restore of the backups folder itself or a
   `touch` moves it. It is off by default, it is stated in the plan, and it is the only place a timestamp
   that did not come out of a manifest is used.
5. **A destination that has been deleted wedges an interrupted run**, the same way it wedges an interrupted
   prune: the journal re-resolves the destination and refuses if it is gone, so neither `--resume` nor
   `--abandon` will proceed and the operator must remove the journal by hand. Fail-closed, and the refusal
   names the action.
6. **A kill in the two-instruction window between creating the quarantine claim tree and publishing it
   leaves an orphan.** `.catalog-safety-set.claiming-<18 hex>` holds one JSON marker and nothing else; the
   resume publishes a fresh one and never adopts it, because adopting a directory at an unpredictable path is
   the reasoning this whole design rejects. It is litter — a few hundred bytes, one per crash at exactly that
   point — and it is named here rather than swept, because a sweep is a delete and this command has exactly
   one delete path. `ops:backup-retention` behaves identically with its own claim prefix.
7. **`--resume` refuses while a retention prune is interrupted; `--abandon` does not.** So an operator who
   has crashed both commands must finish or unwind the prune before resuming this one — or simply abandon
   this one, which is always available. That asymmetry is deliberate: two commands that each refuse while the
   other is interrupted is a pair neither of which can ever be resumed.
