# Phases 305–312 — retention, the half of the backup lifecycle that only ever printed a plan

Phase 256 said what a complete backup **is**. Phase 277 made taking one a command. Phase 278 verified it in
the same run and gave it a schedule. Phases 279–280 rehearsed the restore in a throwaway project. Phases
297–304 performed it, for real, against the installation — and made every restore take a **safety set** of
what it was about to destroy first.

So this product now *creates* backup sets on a schedule, and creates another one every time an operator
restores. It has never removed one, and it says so:

> **Retention removes nothing, ever.** There is deliberately no flag that does. Removing a set is a decision
> with a name attached, taken by a person who has just read what they are removing.
> — `docs/PHASES_277_280_MAINTENANCE_AUTOMATION.md`, *Limitations*

`deploy/unraid-catalog-maintenance.sh` carries the other half of the same sentence, in the `retention-plan`
mode it ships:

> The digest below is over the ENUMERATED SET LIST. It exists so that a future destructive step, if one is
> ever added, can require the exact list the operator was shown: a cleanup authorised against a list that has
> since changed is a cleanup of something nobody looked at.

That is a design note for a command that was never written. What an operator actually has today is a shell
loop that prints `WOULD REMOVE` beside names sorted **lexically**, a `sha256sum` of that listing, and the
instruction to go and `rm -rf` one directory themselves. `rm -rf` on a backup directory cannot tell a set
that verifies from one that was truncated last Tuesday; cannot tell the **only** set this build could restore
from one of ten; cannot tell the pre-upgrade rollback point from a routine nightly; does not take the
maintenance lock, so it can race a `ops:complete-backup` publishing into the same folder or a
`ops:complete-restore` reading out of it; and, being a recursive delete, leaves a **half-removed set under a
name an operator trusts** if it is interrupted.

That is the gap. It is not a documentation gap. The instruction to do it by hand is the most dangerous
instruction this product gives.

| Phase | What it adds | What it changes |
| --- | --- | --- |
| **305** | The inventory: every entry in a backup destination, classified from evidence | A backup folder stops being a listing |
| **306** | The policy: a declarative retention rule evaluated deterministically into one decision per set, each with a closed reason | "Which ones would go" is computed, not eyeballed |
| **307** | The protection boundary: what no policy may remove, and the refusal when nothing good can be proved to remain | Retention cannot delete the backup you would need |
| **308** | The plan, and a digest over the **whole operation including the inventory it was computed from** | An authorisation covers the exact list that was read |
| **309** | Execution: two locks, a re-proof, and **quarantine before delete**, oldest first | A destroyed set is a set somebody read about |
| **310** | The journal, `--resume`, `--abandon`, and the retained-artifact report | An interrupted prune is a named, reversible state |
| **311** | `ops:backup-retention`, the operator surfaces, and the scheduled job that still removes nothing | The document, the panel and the command agree |
| **312** | The acceptance suite, the docs and the suite inventory | Every claim above is driven against the shipped code |

## What this command is, and what it is not

It is the **third** command in the `backup-components.ts` family, and it composes rather than re-deciding
anything: the component list is that model's, the artifact names are `COMPONENT_ARTIFACT_NAMES`, a set is
"good" exactly when Phase 278's `verifyBackupSet` says `ok`, and "restorable here" is that report's own
`restorableUnderThisBuild`. There is no second opinion about what a backup set is.

It **issues no command at all.** No `docker`, no `compose`, no child process, no network, no registry, no
media path, no media server. Its command ledger is empty and a suite asserts that it is. It is pure host-side
filesystem work under a lock, and that is why it can run while the stack is up.

It is **not a scheduler**, and this is deliberate rather than unfinished — see *Non-goals*.

It is **not `--force`-able**. There is no flag that removes a protected set. The protections are not defaults.

## Threat and failure model

What this command is trusted with is the irreversible destruction of the only copies of things that cannot be
obtained again from anywhere. The failures it is built against, in the order they matter:

| Failure | How it is closed |
| --- | --- |
| Removing the last set that could actually restore this installation | The newest verified, restorable-under-this-build set is protected unconditionally, and the run **refuses entirely** if there is no such set to protect |
| Removing the last pre-upgrade rollback point | The newest verified set older than this build's schema is protected unconditionally: it is the only thing that can roll this installation back, and it is by definition not restorable *here* |
| Deleting on the strength of a **name** | Every candidate is verified — manifest, every component digest, entry and byte counts, the offline inspector's verdict — immediately before the plan, **again under the lock**, and **again against the recorded commitment immediately before it is renamed and immediately before it is deleted** |
| A durable document that agrees with itself | The journal records the evaluation instant, and the decisions it claims are **recomputed** from its own inventory and policy; a forgery has to be a decision the evaluator itself produces |
| A quarantine directory that is not ours | An ownership marker bound to the journal version, plan digest, suffix, ordered removals and every set's commitment, published atomically and verified before every rename, deletion, abandon and cleanup |
| Authorising a list, then destroying a different one | The plan digest binds the whole inventory: every entry's name, class, date, schema version, set digest, decision and reason, plus the policy and the ordered removal list. A set taken, added or changed between plan and confirm changes the digest and the confirmation is refused |
| Racing a backup being published, or a restore reading a set | The project maintenance lock — the same lock `ops:complete-backup` and `ops:complete-restore` take — plus a second lock in the destination for the case where the destination is shared |
| Deleting out from under an in-flight restore | A restore journal in the project refuses the whole operation, before anything is read |
| An interrupted recursive delete leaving a **half a set** under a trusted name | Nothing is ever deleted in place. Every set is first **renamed** into a private quarantine directory; only then is it removed. At every observable instant a set name in the destination holds a whole set or nothing |
| A destination path escape, a symlinked set, a special file | `resolveMaintenanceRoot`, `lstat` on every top-level entry, `removeOwnTreeNoFollow` (which refuses a tree holding a link, device, socket or pipe **before** unlinking anything), and a removal entry bound to what the set's own manifest declares |
| Removing something that is not ours | Only a directory carrying **this product's manifest** is ever a candidate. A foreign directory, a file, a link and this product's own in-flight artifacts are reported and never touched |
| Leaking what is in a backup | No path, no secret, no component content in any report. The plan names sets, classes, dates, schema versions, digests, counts and closed reasons |

**What it is not built against, stated rather than implied.** An operator with write access to the
destination can edit a manifest's `takenAt` and change this command's ordering. That is not a privilege
escalation — the same access deletes the set directly — but it is why the plan **prints every set's date**
beside its decision: a wrong date is visible in the thing you authorise. And a set's `takenAt` is not covered
by the verification digest, which is a property of Phase 277's manifest and is not changed here.

## Phase 305 — the inventory

`inventoryDestination` lists the destination and classifies **every** entry. It is a total function: there is
no "other".

| Class | What it is | Removable |
| --- | --- | --- |
| `VERIFIED` | A directory carrying this product's manifest, which `verifyBackupSet` reports `ok` | candidate |
| `UNVERIFIED` | Manifest readable; the verification found problems (a component changed, missing, added, a schema disagreement, an indeterminate dump) | candidate **only** with `--include-unverified` |
| `UNREADABLE` | The manifest is there and cannot be read, parsed, or is not a version this build writes | never |
| `FOREIGN` | A directory with no manifest of ours — a set taken by hand following the documented commands, or somebody's own folder — **or any name this command could not have created**, whatever is inside it | never |
| `RESERVED` | Any dot-prefixed name. Deliberately broader than "this product's in-flight artifacts": a published set is created under `assertUsableName`, which cannot produce a leading dot, so one rule covers a backup staging tree, a restore safety-set claim, a lock directory, this command's own quarantine and anything a future namespace adds | never |
| `NOT_A_DIRECTORY` | A file, a symbolic link, a device, a socket, a pipe | never |

Three things follow from the table being closed.

**A hand-made backup is safe.** The documented by-hand procedure in `backup-components.ts` produces a folder
with no manifest. It classifies `FOREIGN`, it is reported so the operator can see it, and nothing removes it.
The command owns what it took.

**Emptiness is never inferred from a name.** An entry is `VERIFIED` because a verification said so, not
because it matched a pattern. `set-2026-07-30` and `my-holiday-photos` are told apart by reading a manifest,
not by looking at them.

**A set with no date has no position.** The order retention reasons about is the manifest's `takenAt`, not
`mtime` — an `mtime` is reset by a copy, a sync or a `chown -R`, and ordering irreversible destruction by a
timestamp any file operation rewrites is not an ordering. A set whose `takenAt` is absent or is not an
ISO instant is `PROTECTED_UNDATED`: a policy about "the newest seven" has nothing to say about a set that
cannot be placed among them. Ties are broken by set name, so the order is total and deterministic.

**What it reads, exactly.** Deciding whether a set is good means hashing every byte of it, and one of its
four components is the secrets directory — so this **does open and read secret files**, through descriptors,
without following links, for the sole purpose of hashing. It never interprets, parses, prints or otherwise
surfaces a byte of them; it accepts **no credential on a command line**; and no path and no component content
reaches any report. What leaves the inventory is a class, a date, a schema version, a digest and two counts.

A claim that this command never touches a secret file at all would be comfortable and false, and an
earlier version of this document made it. The boundary above is the one that holds.

## Phase 306 — the policy

Four values, all of them explicit, none of them clever:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--keep-last <n>` | 7 | Keep the newest *n* **verified** sets. The window counts verified sets only: a corrupt set protects nobody, so it must not occupy a slot that would otherwise hold a good one |
| `--min-age-days <n>` | 7 | Nothing taken within this many days is removable, whatever the window says. A run of nightly backups that all failed to verify must not be able to age the good ones out in an afternoon |
| `--include-unverified` | off | Make sets that do not verify candidates too. Off by default: a set that failed to verify may have failed for a transient reason, and it is also the evidence of whatever went wrong |
| `--keep-minimum-restorable <n>` | 1 | The floor. Refuse the whole plan if executing it would leave fewer than *n* verified, restorable-under-this-build sets |

Evaluation is a pure function of the inventory and the policy, in one pass, producing exactly one
`RetentionDecision` per entry — `keep` or `remove`, with a closed reason from a fixed vocabulary. There is no
second place that decides anything.

`--min-age-days` is measured against an injected clock, so the suite drives it rather than waiting for
Tuesday.

## Phase 307 — the protection boundary

Protection is evaluated **before** the window, and it wins. The reasons, all closed words:

| Reason | Why it can never be a policy default |
| --- | --- |
| `PROTECTED_NEWEST_RESTORABLE` | The newest verified set this build could actually restore. If this goes, the installation has no recovery for the state it is in now |
| `PROTECTED_NEWEST_ROLLBACK_POINT` | The newest verified set from **before** this build's schema. There are no down-migrations, so this is the only thing that can roll this installation back — and it is by definition *not* restorable here, which is exactly why a naive "keep the newest that works" would delete it |
| `PROTECTED_KEEP_WINDOW` | Inside `--keep-last` |
| `PROTECTED_MIN_AGE` | Younger than `--min-age-days` |
| `PROTECTED_UNDATED` | No orderable `takenAt` |
| `PROTECTED_UNVERIFIED` | Does not verify, and `--include-unverified` was not given |
| `PROTECTED_NOT_OURS` | `FOREIGN`, `UNREADABLE`, `RESERVED` or `NOT_A_DIRECTORY` |

And two whole-operation refusals, computed over the **resulting** state rather than over the per-set
decisions, so a defect in the evaluator is caught by an independent check rather than agreeing with itself:

* **`NO_RESTORABLE_SET`** — the destination holds no verified, restorable-under-this-build set at all. Nothing
  is removed. You do not delete backups on a day when you cannot prove you are holding a good one, and the
  right response is to take one.
* **`FLOOR_NOT_MET`** — the plan would leave fewer than `--keep-minimum-restorable` restorable sets.

`ops:complete-restore` leaving a journal in the project is a third refusal, `RESTORE_IN_PROGRESS`, taken
before the destination is even read: an installation half-way through a restore is the worst possible moment
to be deleting the sets it might have to fall back to. The journal names the set it is restoring and the
safety set it took; both may be in this destination, and this command does not attempt to reason about which.

## Phase 308 — the plan, and what the digest binds

`--plan` inventories, verifies, evaluates and prints. It takes no lock, creates nothing, writes nothing and
removes nothing.

The canonical operation binds, exhaustively:

* the report id and version, and the **journal version**, so a build that writes a different durable format
  cannot have its plan confirmed by one that reads an older one;
* the resolved project root and the resolved destination directory;
* the policy — every one of the four values;
* **every inventory entry**, in canonical order: name, class, `takenAt`, schema version, `setDigest`, byte
  count, entry count, the decision and its reason;
* the ordered list of names to be removed.

So a set published into the destination between the plan and the confirmation changes the digest, and the
confirmation is refused — which is the property the shell script's comment asked for, and which its
`sha256sum` of `ls` output could not give, because it hashed **names**. A set whose bytes were altered after
the plan changes its `setDigest` and therefore the plan digest too.

**Paths go into the digest and never into the output.** The rendered plan shows set names, dates, classes,
sizes and reasons. It does not show where the destination is.

## Phase 309 — execution

`--confirm <digest>` runs it, and the order is the guarantee.

1. **Take the project maintenance lock**, then the **destination lock** — always in that order, so two runs
   cannot deadlock. What each one covers is different and is stated rather than blurred: the *project* lock
   is what `ops:complete-backup` and `ops:complete-restore` take, so holding it is what stops this command
   racing a set being published or read **in this project**. The *destination* lock is a second domain, and
   it exists for the case a project's destination is shared — two projects, one backups folder. It does not
   make a backup taken by *another* project atomic against this prune, because that project's backup holds
   only its own project lock; what it does guarantee is that two retention runs cannot both be pruning one
   destination. That limit is real and is documented rather than papered over.
   If the destination lock resolves to the same directory as the project lock, it is not taken twice.
2. **Re-inventory and re-verify, under the lock, from scratch** — every set read again, every component
   digested again — and require the recomputed plan digest to equal the confirmed one. A destination that
   changed between the plan and the lock stops here, with nothing renamed.
3. **Write the journal**, in the project root, with the whole committed decision list, before the first
   effect.
4. **Publish an OWNED quarantine directory, then quarantine oldest first.** The tree is built under an
   unpredictable name with its ownership marker inside it and renamed onto the predictable path in one
   atomic publication. Each set is then proved to be the one that was planned and `rename`d into it — same
   directory, therefore same filesystem, therefore an atomic rename rather than a copy. Nothing is deleted in
   this phase, and the whole phase is reversible by `--abandon`.
5. **Delete, oldest first.** Each tree is proved against its commitment again, `deleting` is recorded, and
   only then is it removed with `removeOwnTreeNoFollow`, which walks and
   refuses the whole tree before unlinking anything if it holds a symbolic link, a device, a socket or a
   pipe, and whose entry bound comes from **the set's own manifest**: the declared entry counts of its
   components, doubled with a fixed margin for the directories the counts do not include. A set larger than
   what it declared itself to be is not a set this command will recursively delete.
6. **Remove the quarantine directory** once its marker is the last thing in it, under that marker's own proof.
7. **Prove what is left.** The set that was protected as `PROTECTED_NEWEST_RESTORABLE` is verified **again**,
   from disk, after the removals. It should be untouched — that is the point — and a run that removed four
   sets and can no longer verify the one it promised to keep reports `REMOVED_BUT_UNPROVEN` and exits
   non-zero. A retention run that leaves you with nothing provable has not succeeded, whatever it deleted.
8. **Release both locks in a `finally`**, innermost first.

**Why quarantine-then-delete, and not delete in place.** A recursive removal of a multi-gigabyte set is long
and interruptible. Interrupted in place, it leaves a directory that still carries the set's name, still
carries a manifest, and no longer carries the bytes — a set that verifies as `COMPONENT_CHANGED` if you are
lucky and as a truncated dump if you are not. A rename is atomic with respect to other readers: the name is
either there with everything under it, or gone. So the destination is only ever observed in states where
every set name means a whole set.

## Phase 310 — an interrupted prune is a named state

The journal is `.catalog-retention.journal.json` in the project root — the same home, the same
staged-and-renamed publication and the same privacy as the restore's. It is versioned
(`RETENTION_JOURNAL_VERSION = 2`), and a version this build does not write is refused **at the version
boundary, before any later field is read**, so an old document is refused for *being* one rather than for
whichever field it happens to be missing.

### Why re-hashing was not authority

The first implementation validated the removal names and states, then recomputed the plan digest over the
journal's **own** recorded inventory and decisions. That proves a document agrees with itself. It does not
prove the document describes a decision this program would ever make — so somebody who understood the format
could change the protected set's decision to `remove`, append it to the removal list, **recompute the digest
over the edited content**, and be obeyed. Every check passed, because every check was asking the document
about itself. The one extra check it had ("the removal list equals the decisions marked remove") was
consistent with that forgery too, and the test that claimed to cover it edited only one of the two lists, so
it never met the actual counterexample.

The authority is now the **evaluator**, in four layers:

1. **Every member is validated before anything reads it.** Each inventory row and each decision is checked
   field by field — name, class, date/moment agreement, schema version, digest shape, restorable flag, byte
   and entry counts, findings — before any `map`, `filter` or cast touches the list. A `null`, a scalar, a
   missing field or a class this build does not write is a closed refusal, never a `TypeError` thrown out of
   something later. Names must be unique, in this command's canonical listing order, and the decisions must
   cover the inventory one-for-one and in order.
2. **The evaluation instant is recorded**, so `evaluateRetention(inventory, policy, evaluatedAt)` can be
   **run again**. Its decisions, its ordered removals, its protected set and its remaining count must equal
   the journal's exactly. A forged decision therefore has to be one the evaluator itself produces — and the
   two unconditional protections and the not-ours rule are properties of an inventory row's **class**, which
   no instant and no policy can talk past.
3. **The removal list is class-gated before the evaluator is even asked.** Every name must refer to a
   `VERIFIED` row, or an `UNVERIFIED` one when the policy admitted those. A document pointing this operation
   at a `FOREIGN`, `RESERVED`, `UNREADABLE` or `NOT_A_DIRECTORY` row is refused for what it names.
4. **And the fabricated-inventory forgery dies on disk.** Claiming a stranger's directory is a `VERIFIED` set
   with a plausible digest survives every check a document can answer about itself — the evaluator can only
   reason about what the inventory says. What kills it is that nothing is moved or removed until the tree at
   that name has been proved to be the set that was planned.

The evaluation instant is deliberately **not** in the plan digest. The journal needs it to re-run the
evaluation; a digest that moved every millisecond could never be typed back.

### The commitment, proved immediately before every effect

`proveSetIsPlanned` is run **before the quarantine rename** and again **before the deletion**, against the
inventory row the journal records. It compares the verification's `setDigest`, the verdict, the exact finding
set, and the manifest's own `takenAt`, byte count, entry count and schema version.

Each of those is load-bearing. `setDigest` is over what the manifest *declares*, so a component whose bytes
were changed afterwards does not move it — the verdict and the findings do. And `setDigest` does not cover
`takenAt`, so two sets taken from an unchanged installation minutes apart hash identically; the date is what
tells one of this operation's own sets from another.

A rename is reversible, which is why the first implementation gated only the deletion. It is still an effect
on a directory in somebody's backup folder, and a forged inventory row would have had this command pick a
stranger's directory up and carry it into a quarantine tree before anything noticed.

### The quarantine directory has to prove it is ours

An unpredictable name is not ownership. The first implementation argued that a directory at
`.catalog-retention.removing-<12 random hex>` must be this operation's because nobody could guess the suffix,
and checked only that its children were names the operation planned. After a crash the suffix is **written
down in the journal**, in a directory the operator owns — so it is not unguessable, it is published.
Replacing that directory with an ordinary one containing a directory named after a planned set was enough to
have this command recursively delete somebody else's files. And the check was not run before the delete loop
at all for an entry already recorded `quarantined`.

The quarantine now carries a **marker**, bound to the journal version, the plan digest, the suffix, the
ordered removal list and every set's exact planned commitment, and compared **whole** rather than field by
field. It is verified before every rename into the tree, every deletion out of it, every abandon and every
cleanup. A directory at the predictable path that cannot prove it is ours is never written into, never read
from and never removed: the operation stops instead.

**It is published atomically.** The tree is built under an unpredictable, secret-free
`.catalog-retention.claiming-<18 hex>` name, the marker is written inside it while it is still invisible, and
only then is it renamed onto the predictable path — so that path goes from *absent* straight to *a directory
holding a valid marker of this operation's*, with nothing in between and not one byte of any set inside it. A
death before the publication leaves an unmarked orphan under an unpredictable name, which blocks nothing, is
secret-free, and is left alone: this command removes no directory it cannot prove is its own.

**Cleanup is ownership-checked too.** The marker is unlinked and the directory removed only under that proof
and only when the marker is the last thing in it; a tree still holding a set is never removed as a container.
If either cannot be completed, the directory is **reported as retained**, by name, with what it holds.

### Per-entry states, and why `deleting` had to exist

| State | What it means | Recovery |
| --- | --- | --- |
| `pending` | Nothing has happened to it | Prove it, then quarantine it |
| `quarantined` | Renamed aside, **intact**, not yet consumed | Prove it against the commitment, record `deleting`, remove it |
| `deleting` | The removal has started; the tree may be partial | Finish it, authorised by the ownership marker and this entry's own record |
| `removed` | It is gone | Nothing |
| `failed` | The operation stopped here | Re-examined from the disk, and reported as having stopped before |

The first implementation recorded `quarantined` and then recursively removed. A process that stopped existing
inside that removal left `quarantined` beside a **half-consumed** tree, indistinguishable from `quarantined`
beside an intact one — so a resume could not both re-verify an intact tree before destroying it *and* finish a
legitimately partial one. It has to do both, and it cannot without knowing which it is looking at. `deleting`
is written before the first `unlink`, and it is the only state under which a tree that does not match its
commitment may still be removed.

It also makes one more state impossible-by-construction: a `quarantined` set that is **gone** was removed by
something that is not this command, because this command never removes without first recording that it is
about to.

### Every action is cross-validated first, and one impossible state stops everything

Before this process performs a single effect, every entry's (recorded state, in the destination?, in
quarantine?) triple is checked against the table of states a run can actually produce:

| State | In destination | In quarantine | What happens |
| --- | --- | --- | --- |
| `pending` | yes | no | prove it, then quarantine it |
| `pending` | no | yes | an interrupted rename: prove it, then adopt it |
| `pending` | yes | yes | **STOP** — one run cannot produce this |
| `pending` | no | no | **STOP** — something outside this command removed it |
| `quarantined` | no | yes | prove it, record `deleting`, remove it |
| `quarantined` | no | no | **STOP** — a removal is always preceded by its record |
| `quarantined` | yes | — | **STOP** — one run cannot produce this |
| `deleting` | no | yes | finish the removal under the ownership marker |
| `deleting` | no | no | the removal landed without its record |
| `deleting` | yes | — | **STOP** — one run cannot produce this |
| `removed` | — | — | nothing |

**A stop is a stop.** The first implementation marked one entry failed and carried on quarantining and
deleting the others; the tests that claimed it "stopped the run" never asserted that the remaining candidates
survived. Once the filesystem or the ownership evidence says something one run cannot have produced, this
does not continue destroying anything: it records the entry, keeps the journal, leaves every untouched
candidate exactly where it is, **names them in the report**, and returns the partial result. Everything that
was only ever renamed is still recoverable with `--abandon`.

* **`--resume <digest>`** takes only `--project`. The destination, the suffix, the policy and every decision
  come from the journal; the digest is the plan digest the journal records, so a resume cannot be pointed at
  a different operation. It is refused outright once an abandon has been committed.
* **`--abandon`** takes only `--project`. It renames every still-quarantined set back to its original name —
  under the same ownership and commitment proofs a deletion needs, because renaming a stranger's directory
  *into* a backup destination under a set name is its own kind of damage. A set recorded `deleting` is **not**
  put back: it may be truncated, and a partial set under a trusted name is worse than none.

### An abandon that lost a set is not a success

The first implementation set `ok` from the unresolved list alone, so a run that put one set back and reported
another as **gone forever** rendered `RESULT: ABANDONED` and exited zero — contradicting its own comment,
this document, and the plain meaning of the word to whoever reads the exit code.

`ok` is now a clean unwind and nothing else. There are three states: `ABANDONED` (everything back, nothing
lost, nothing retained), `ABANDONED_WITH_LOSS` (everything that *could* come back did, and some sets were
already deleted), and `PARTIAL` (something is still out of place or retained). The CLI exits non-zero for
both of the latter. The journal may be cleared when no reversible work remains — clearing it never turns loss
into success, and the report names every set that is gone.

**Every failure after a rename carries a report.** A journal write or the final clear that fails once a set
has moved raises `RetentionAbandonFailed`, carrying what was put back, what is gone, what is still out of
place and what the retained directory holds — so the CLI exits `1` rather than the code that means "refused
before anything was moved". The same rule covers the prune: `RetentionFailed` is raised whenever **the
operation** has already moved or removed something, seeded from the journal and the filesystem rather than
from what this particular process has done, so a resume of an interrupted run never loses its report merely
because it has not made a new effect yet.

**Retained artifacts are always named.** A failed or abandoned run reports the quarantine directory's name,
the sets inside it, and the fact that it holds backup sets — which means it holds a copy of every secret file
and the custodian keystore of the moments those sets were taken. Nothing else would ever mention it. The
quarantine directory is created `0700`.

**What "crash" means here.** The recovery is proved against a process that is *killed* — the suite runs real
prunes and real abandons in child processes and stops them at named boundaries with `process.exit`: the
marker being built, the marker being published, the rename, its record, the `deleting` transition, the
removal, and an abandon's rename. That covers a kill, a runtime crash and a Ctrl-C. It does **not** claim
power-loss durability, for the same reason and with the same honesty as Phases 297–304: the journal is
`fsync`ed and published by rename, but the containing directory is not `fsync`ed after those renames. A power
cut degrades to a redo — a rename that did not reach the disk leaves the set at its original name, which the
`pending` recovery handles — not to a wedge.

## Phase 311 — the surfaces

`ops:backup-retention` is the CLI, with the family's flag discipline: long flags only, no credential on a
command line, `--json` for the machine-readable report, refusals that name a rule and never a path, and modes
that accept only their own flags — a flag this command would ignore is a usage error, because a flag that
does nothing is a flag somebody believes did something.

`backup-components.ts` gains `BACKUP_RETENTION_NOTE` and `BACKUP_RETENTION_COMMANDS` from the same model, so
the operator UI's *Backup & restore* panel, the lifecycle document and the command cannot disagree about what
retention is.

`deploy/unraid-catalog-maintenance.sh`'s `retention-plan` mode now runs **the shipped command with
`--plan`** instead of a shell loop over `ls`. It still removes nothing, and it still has no flag that would:
the digest it prints is the one a human types into `--confirm`, on purpose, at a keyboard.

## Non-goals, stated rather than implied

* **It is never scheduled, and there is no `--yes`.** Automatic deletion of backups on a timer is how the
  copy you needed goes away on the night the thing you needed it for happened. The scheduled job prints a
  plan; a person reads it and confirms it. This is the same sentence Phase 277 wrote as a limitation, now
  implemented instead of merely observed.
* **It removes nothing it did not take.** Foreign directories, hand-made backups and this product's own
  in-flight artifacts are reported and left alone.
* **It does not archive, compress, move or copy anything.** There is no `--move-to`. A retention command that
  also transferred sets would be a transfer command whose failures look like retention successes.
* **It does not decide your policy.** The defaults are conservative; the values are yours.
* **It does not prove your Docker volumes hold anything.** It never starts a container. It reasons only about
  files in a backup destination.
* **It reads every byte of every set it inventories**, at plan time and again under the lock — and every byte
  of each set it is about to *act on* twice more, immediately before the rename and immediately before the
  deletion, because a commitment checked at any earlier moment is a commitment about a moment that has
  passed. A retention decision made on a listing is a decision about names. On a destination holding many
  large sets that takes real time, and that cost is a reason this is a human operation rather than a cron job.
* **A shared destination is only half covered.** The destination lock stops two retention runs; it does not
  stop another project's `ops:complete-backup`, which holds only its own project lock. Give each project its
  own destination.
* **It takes no credential on a command line**, and it never surfaces the bytes it reads. It DOES read them:
  verifying a set hashes every component, including the secrets one, through descriptors opened without
  following a link. Nothing is parsed, printed or carried into a report.
