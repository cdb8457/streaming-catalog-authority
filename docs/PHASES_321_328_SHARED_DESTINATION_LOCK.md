# Phases 321-328 — the shared backup-destination lock

The Phase 313-320 report's **first** remaining review risk, verbatim:

> **The shared-destination boundary is documented, not closed.** Another project's restore publishing into a
> destination this project prunes is outside the lock. Mitigated by `OWNED_IN_FLIGHT` and by
> `--min-age-days 14`; not eliminated.

This tranche closes it. All four commands that read, write, move or destroy state in a backup destination now
coordinate on **one lock, taken in the destination itself**:

- `ops:complete-backup`
- `ops:complete-restore`
- `ops:backup-retention`
- `ops:safety-set-lifecycle`

---

## What was actually open

Two of the four already shared a lock. `ops:backup-retention` defined `.catalog-retention.lock` and
`ops:safety-set-lifecycle` imported it — correct, and already a misnamed lock by the second command. The other
two held **only their own project's maintenance lock**, which excludes nothing in another project. So with two
Compose projects pointed at one physical directory — a bind mount, an Unraid share, one project inside another
— every one of these was reachable:

| Holder | Contender | What could happen |
| --- | --- | --- |
| `ops:backup-retention` mid-quarantine | another project's `ops:complete-backup` | a set published into a destination whose inventory the prune had already committed to; the prune's protected-set re-verification counts a destination that did not exist when it was planned |
| `ops:safety-set-lifecycle` counting the floor | another project's `ops:complete-restore` | a claim published after the floor was counted, or a claim removed between a restore verifying its safety set and relying on it |
| `ops:complete-restore` between its safety set and `down -v` | another project's `ops:backup-retention` | the only record of the installation about to be destroyed quarantined and deleted while the destruction runs |
| `ops:complete-backup` publishing | another project's `ops:complete-backup` | two staging trees and two publications in one directory, and two `pg_dump`s from two installations racing one destination's free space |

Three things narrowed it and none of them closed it: an in-flight claim is protected, `--min-age-days`
protects anything a running restore has just created, and the marker proves *a* restore of this build made a
claim. Every one of those is a property of what is **already on disk**. None of them is exclusion.

---

## The lock

**One primitive, one name, one refusal vocabulary**, all defined in `src/ops/maintenance-safety.ts`:

| Thing | Value |
| --- | --- |
| Lock directory | **`.catalog-retention.lock`**, created inside the destination. The filename is frozen — see below |
| Mechanism | one `mkdir`, which creates and refuses atomically. Nothing is inspected first, nothing waits, nothing polls, nothing blocks |
| Acquire | `MaintenanceLocks.lockDestination(dir)` — the **only** route. `acquireDestinationLock` is not exported from `maintenance-safety.ts` at all, so no command module can reach it |
| Refusal | `DESTINATION_LOCK_CONTENTION` — one sentence, naming all four commands **and the cross-project case** |
| Names | exactly **one**. `DESTINATION_LOCK_DIRNAMES` has a single entry, and a suite asserts that, because a second name would mean a second `mkdir` or a pre-check |
| Inventory | the lock name is excluded from both the retention inventory and the claim inventory, so a plan and the re-plan under the lock agree |

### Why the filename still says "retention" — CORRECTION 1

The first cut of this tranche renamed the lock to `.catalog-destination.lock`, because the old name was
`ops:backup-retention`'s and the lock is not retention's any more. It then had to keep an older build's lock
visible, so it `lstat`ed `.catalog-retention.lock` first and `mkdir`ed `.catalog-destination.lock` afterwards.

**That is a check followed by a create on a different name, which is not a lock.** An `ops:backup-retention`
or `ops:safety-set-lifecycle` from a build before this tranche could `mkdir` the old name in the window
between the two operations, and both processes would then believe they held the destination — so the rename
bought a tidier word and gave back *less* exclusion than the two commands already had.

So the **filename is the compatibility contract and it is frozen**. One name, one `mkdir`, one atomic
operation, and an old build and a new build contend on exactly the same directory entry with no window
between them at all. What changed is the **vocabulary**: the constant is `DESTINATION_LOCK_DIRNAME`, the
refusal sentence names all four commands, and every document calls it the destination lock. A name on disk
that two versions must agree on is a different kind of thing from a name in source that only this version
reads, and only the second one was free to change.

### What cross-version protection actually covers, exactly

Being honest about this matters more than the guarantee sounding complete:

- **An older `ops:backup-retention` or `ops:safety-set-lifecycle` and any command of this build** contend
  correctly, in both directions, because both take `.catalog-retention.lock` with one `mkdir`.
- **An older `ops:complete-backup` or `ops:complete-restore` participates in nothing**, because those two
  commands took *no* destination lock before this tranche. A mixed-build fleet is protected for the two
  commands that always took the lock and is **not** protected against the two that did not — there is no
  filename that can fix that, because the old binaries never look at one. The only remedy is to upgrade every
  project that shares a destination.
- **A stale lock is never removed automatically**, whichever build left it.

### Why the lock is physical

**The lock is a directory inside the destination**, so any two processes that can reach the destination
contend on it whatever they call it. There is no registry, no daemon, no port and no shared file, and nothing
has to agree on a string: `inner/backups` from one project and `backups` from another `mkdir` the same inode.

`provePhysicalDestination` resolves every destination through `realpath` before a lock is taken, which
collapses a symlinked *ancestor* and normalises separators. It is a narrowing, not the guarantee — Node's
`realpathSync` does **not** canonicalise case on Windows, so two case-spellings of one directory can still
resolve to two different strings. That changes nothing, and the suite asserts the property that matters
rather than the one that would have been convenient: on a case-insensitive filesystem the two spellings name
one directory, so the second `mkdir` finds the first one's lock. Exclusion comes from the filesystem, not
from string equality.

**Nothing infers filesystem behaviour from `process.platform`** — Correction 1. An earlier cut folded case
whenever the host was `win32` or `darwin`, which is a guess about a machine when the question is about a
directory: macOS ships case-sensitive APFS volumes, Windows supports per-directory case sensitivity, and a
Linux host can mount a case-insensitive filesystem. On a case-sensitive volume that fold would have treated
two genuinely different directories as one. Capability containment is therefore an **exact** comparison of
canonical paths — every legitimate caller hands back the string its capability was minted from —
corroborated by the filesystem's own `ino`/`dev`, which can only ever reject.

**A destination reached through a symbolic link or a Windows junction is refused outright**, before any lock,
by `resolveInsideRoot`, which `lstat`s every component of the path. That has not changed and is not weakened
here. It also means the alias this lock exists for is a bind mount, a share, or one project directory inside
another — never a link.

---

## The exact lock order

```
  1. project maintenance lock      .catalog-maintenance.lock   in the PROJECT ROOT
  2. destination lock              .catalog-retention.lock     in the DESTINATION
  ...
  3. release destination lock
  4. release project lock
```

**No path can express the other order.** `MaintenanceLocks.open(projectRoot)` takes the project lock and is
the only way to obtain the object that can take the destination lock; `release()` releases what it holds
innermost-first regardless of what a call site remembers. Asking twice for a destination lock is a refusal,
not a no-op.

### Why the destination is locked second and late

Three of the four commands do not know which destination they are acting on until they have read a journal,
and a journal read **before** the project lock describes a moment that has passed. So the destination is
locked after the journal has been re-read under the project lock and proved unchanged — which also means a
`--resume` and an `--abandon` lock the destination **the journal names**, never one a command-line default
would supply.

### Where each command takes it

| Command | Project lock | Destination lock | Everything after it |
| --- | --- | --- | --- |
| `ops:complete-backup` | before anything is created | after the request is re-resolved under the project lock and the destination is known to exist — **before** the staging directory, **before** the first `docker compose stop`, **before** `pg_dump` | staging, quiesce, dump, keystore, secrets, manifest, publish, **and the verification** |
| `ops:complete-restore` | before the journal is re-read | immediately after the journal is re-read and proved identical — **before** the set is re-verified, **before** a claim directory is created, **before** the safety set is taken, **before** `compose down -v` | the whole destructive protocol, held throughout |
| `ops:backup-retention` | before the journal is read | after the destination is resolved from the journal (resume/abandon) or the request (run) — before the re-inventory, the journal write and the quarantine | inventory, journal, quarantine, renames, deletions |
| `ops:safety-set-lifecycle` | before the journal is read | same as retention | claim inventory, journal, quarantine, floor re-proof, deletions |

### The window is closed at the VERDICT, not at the publication — CORRECTION 1

`runVerifiedCompleteBackup` used to call `takeCompleteBackupWithoutVerifying`, which releases both locks in
its own `finally`, and only then read every byte of the set back to decide what to tell the operator. So the
ordinary, documented command dropped the shared destination lock **at the instant its set was published** and
reacquired nothing before verifying it. Inside that window another project could quarantine the set, delete
it, or move something else into its name — and this command would then report `ok: true` about a set that had
gone, report "does not verify" about a set somebody else removed, or return a verdict about a directory it
had not taken.

The ownership therefore sits one level up:

```
  runVerifiedCompleteBackup
    project lock ─────────────────────────────────────────────────────────────────────┐
      re-resolve · ensure destination · destination lock ───────────────────────────┐  │
        staging · quiesce · pg_dump · keystore · secrets · manifest · PUBLISH       │  │
        verifyBackupSet(<the set just published>)          <- still inside both ────┘  │
    release destination, then project ─────────────────────────────────────────────────┘
```

`takeCompleteBackupWithoutVerifying` keeps its own locks and its own release, because it is the *unverified*
entry point a suite drives directly — and the verified command does **not** call it, which is asserted both
structurally and behaviourally.

### The one nested case

`ops:complete-restore` publishes its safety set through `ops:complete-backup`, into a claim directory
**inside** the destination it is already holding, and the nested backup takes neither lock. It has to:

- `mkdir` as a lock is not reentrant, so a second project lock would self-deadlock; and
- a destination lock taken at the **claim directory** would be a lock on a different directory, excluding
  nothing that matters, and would leave a lock directory inside a claim whose entries are later proved one by
  one by `ops:safety-set-lifecycle`.

Exactly one project lock and one destination lock exist while a safety set is being taken. A suite observes
that from disk, at the instant the safety set's own `docker compose stop` runs.

#### The authority is a capability, not a flag — CORRECTION 1

That call used to pass `holdingLock: true`. **A boolean names no project, no destination and no holder**, so
any caller could set it and suppress *both* locks for *any* project and *any* destination; the only thing
between that flag and an unlocked backup was a suite grepping `src/` for the word, and a source allowlist is
a lint rule rather than an authority. A future route, a future scheduler, or a copy-paste into a new module
would have passed the grep and skipped the locks.

It is now a `HeldDestination` capability:

| Property | How |
| --- | --- |
| Only a real holder can mint one | `MaintenanceLocks.heldDestination()` refuses unless the project lock **and** the destination lock are actually held. There is no exported constructor and no exported factory |
| A cast cannot forge one | identity is membership of a module-private `WeakSet`, checked at runtime. `{...} as HeldDestination` satisfies TypeScript and is refused by the check |
| It is bound to a project | the **canonical** root `MaintenanceLocks.open()` resolved, compared exactly. A capability from another project authorises nothing here |
| It is bound to a **closed set of two targets** | the held destination itself, or **one already-existing** `.pre-restore-claim-<nonce>` directory **directly** inside it. Not every descendant: an ordinary subdirectory, a deeper path, a claim two levels down, a sibling, a parent, and a claim that does not exist are all refused |
| It is bound to a **directory, not a path** | the `ino`/`dev` of the destination **and of the lock directory inside it** are captured when `lockDestination` acquires. A destination renamed away and rebuilt at the same path is a different directory and is refused — path reuse does not satisfy "physical" |
| It fails closed when identity is unprovable | if the filesystem will not report a usable inode, **no capability is minted at all** and the nested operation refuses, rather than falling back to comparing paths |
| It dies with its owner | `release()` removes it from the live set, so a capability that outlived its locks authorises nothing |
| It is checked before the first effect | before the destination `mkdir`, before staging, before a claim or journal is touched, and before a child command runs |

`MaintenanceLocks.inherited()` — the public "take nothing" factory the first cut shipped — is gone.

#### And a standalone backup may not enter the claim namespace at all

The destination lock is taken in the directory a command publishes into, so a hand-run
`ops:complete-backup --destination backups/.pre-restore-claim-<nonce>` would lock *inside* the claim while
`ops:backup-retention` and `ops:safety-set-lifecycle` lock the destination *above* it — two commands in one
destination, each holding a lock the other never looks at. Both entry points refuse any destination with a
claim-shaped component, before the project lock and before anything is created.

**Every component is checked**, not just the leaf, and each one against **what the filesystem does with case
in that particular directory** — never against a guess about the host. A literal `.pre-restore-claim-<nonce>`
always refuses. A shouted `.PRE-RESTORE-CLAIM-<NONCE>` refuses only where that spelling and the lower-case
one reach **one** directory: proved by `ino`/`dev` where the filesystem reports them, and by the parent's
**listing** where it does not — a directory entry exists under exactly the spelling the filesystem stores, so
a listing containing the requested spelling means a genuinely distinct directory, and one containing only the
lower-case claim while the requested spelling still resolves means an alias. A parent that cannot be listed
refuses if the requested spelling resolves at all. On a case-sensitive volume the shouted name is the
operator's own directory and is allowed, and the suite asserts that half with the same shouted claim-shaped
name rather than with an unrelated upper-case directory.

#### The holder note

It is read the way every other file here is read — once, without following a link, bounded at 4 KiB — and
the probe never throws: it is called from a `finally`, so an escaping filesystem error would replace whatever
result the command was carrying. Absent is a legitimate state, because writing the note is best-effort at
acquisition. A link, an oversized file, a directory at the note's name, bytes that are not a note, and a
foreign token all mean **release removes nothing**.

---

## Crash boundaries

Nothing is ever broken automatically. Automatic staleness detection means guessing whether another process is
alive, and the commands behind this lock stop stacks, destroy volumes and delete the only copy of things
nobody can produce again.

| A process dies… | What is left | What an operator does |
| --- | --- | --- |
| holding both locks, before the first write | both lock directories, no journal, nothing moved | remove both directories once nothing is running; the destination works again |
| holding both locks, after a journal | both lock directories and a journal | remove both directories, then `--resume` or `--abandon` — the recovery reads the destination **from the journal** |
| holding both locks, mid-quarantine | both lock directories, a journal, a quarantine directory | as above; nothing was deleted in place, so `--abandon` puts back everything that was only renamed |
| between `mkdir` of the destination and `mkdir` of the lock | a destination directory and nothing else | nothing to do — an empty destination is a destination nothing is half way through |

Two facts a crash cannot produce: a **false success** (every command's verdict is built inside the locked
region and the report is only thrown or returned after it), and a **silently removed lock**. The suite kills a
real child process at a real post-lock boundary and asserts both lock directories on disk, then performs the
documented manual recovery and proves the destination works again.

### The one thing that necessarily happens outside the lock

`ops:complete-backup` may **create** the destination directory, and it cannot lock a directory that does not
exist. `mkdir` is atomic, so a second project racing this one either loses and finds a directory or wins and
the other one does — and both then contend for the lock inside it. A destination that does not exist is a
destination nothing else can be half way through. An `EEXIST` that turns out to be a plain directory is
therefore not a collision; anything else — a file, a link, an unwritable parent — still refuses.

`ops:complete-restore` runs one read-only `docker compose ps` **before** the lock, as part of classifying the
target state that its plan digest binds. It starts nothing, stops nothing and changes nothing. It is stated
here rather than described as "no command before the lock", which would not be true.

---

## What did NOT change

- **No journal schema was versioned.** No persisted field and no persisted semantic changed: the destination
  was already recorded relative to the project, on every journal, and a resume already re-derived it from
  there. Bumping a version that nothing needs would refuse operators' interrupted runs for nothing.
- **No refusal wording changed except the destination-lock sentence itself**, which had to: it used to claim
  the holder was "another retention run", which was never something the command could know and is now
  routinely false.
- **No lock filename changed**, so no operator's interrupted run and no older build's lock became invisible.
- **`--json` refusal output is exactly what it was.** A refusal that happens before any effect has no report
  to serialise, so `--json` emits **no document at all**: stdout stays empty, the sentence goes to stderr and
  the exit code is `3`. The one-document contract belongs to the report paths, and those are unchanged and
  still asserted, one document each, in `test/backup-retention.ts`.
- **No authority, quarantine, journal, `deleting`-state or replacement protection in `ops:backup-retention` or
  `ops:safety-set-lifecycle` was weakened.** Both suites pass unmodified except for the import of the lock
  name and the one refusal sentence.
- **No scheduler, no `--force`, no `--break-lock`, no `--yes`.** A plan still takes no lock at all, so reading
  one can never be refused by another project's run, and the plan-only Unraid and operator-UI surfaces are
  unchanged and still non-destructive.
- **The symlinked-destination refusal, the destination-equals-project-root refusal and the outside-root
  refusals are exactly what they were**, and are asserted directly.

---

## Limits, stated

1. **A destination on a filesystem where `mkdir` is not atomic between the contending hosts is not covered.**
   That is any network filesystem without proper `O_EXCL`/directory-create semantics. The lock is exactly as
   strong as the destination's filesystem — and a filesystem that reports no usable inode also refuses the
   nested safety-set backup outright, because a capability that cannot name a directory is not minted.
2. **A destination unreachable at abandon time is unlocked, deliberately.** `ops:complete-restore --abandon`
   is the one command that puts an installation back; refusing it because a directory it does not need has
   gone would strand a recovery. It runs without the destination lock and says so in its notes. A lock
   somebody **holds** is still a refusal — the two failures are told apart by which step threw, not by
   reading a message.
3. **A mixed-build fleet is only half covered**, as set out above: older `ops:complete-backup` and
   `ops:complete-restore` binaries take no destination lock at all, and no choice of filename can make them.
4. **This lock does not make a shared destination a good idea.** It makes concurrent use *safe* rather than
   *sensible*: two installations' backups in one directory still share free space, still share a blast
   radius, and still let one operator's `--keep-last` decide about another's sets. The product no longer
   corrupts that configuration; it still does not recommend it.

---

## What the suite proves

`test/shared-destination-lock.ts`, with `test/helpers/destination-lock-holder.mts` and
`test/helpers/destination-lock-contender.mts`.

- **Two distinct project roots, one physical destination**, built without any privilege: one project
  directory inside another, giving two different relative spellings of one directory. A symlinked destination
  is refused outright, and that is asserted too, so the pair of facts is complete.
- **The adversarial matrix.** A real child process runs a real command and is stopped at a real post-lock
  boundary — inside an injected primitive, so there is no sleep, no polling and no timeout anywhere. From
  inside that boundary it spawns real child processes running each of the other three commands, plus
  `ops:backup-retention` through its real CLI with `--json`, from the *other* project against the same
  physical directory. Every one refuses, with the shared vocabulary, having issued no `stop`, `start`, `down`,
  `up`, `cp`, `exec`, `run`, `kill` or `create`, no `pg_dump`, no `psql` and nothing carrying a URL. The
  destination is hashed before and after and is byte-identical, and no contender left a journal or a lock in
  its own project.
- **Both directions**, so the exclusion is not an artefact of which project is nested.
- **The publish-to-verify window** — CORRECTION 1. A real `ops:complete-backup` is stopped at `before-verify`:
  its set is published at its final name and the verdict does not exist yet. Five real contenders run from
  another project against the same physical destination from inside that instant; every one refuses, the
  published set is byte-identical either side, and the command then finishes and releases both locks.
- **The capability, behaviourally.** The legitimate nested backup runs and takes no second lock. A forged
  (cast) capability, one from another project, one for a sibling destination, one for an ordinary
  subdirectory, one for a claim two levels down, one for a destination that does not exist yet, one for a
  claim that does not exist, and one whose owner has already released are each refused — with no child
  command issued and, where the directory did not exist, without it being created.
- **Path reuse does not satisfy the capability.** A destination is locked, a capability minted, the
  destination renamed away and a *new* directory built at the same path — complete with a claim of the same
  name and a lock directory of its own — and the old capability refuses, issues no child command, and leaves
  the replacement byte-identical.
- **A standalone backup cannot enter the claim namespace.** An existing claim, a claim that does not exist,
  and a directory inside a claim are each refused for both entry points, with no lock taken and nothing
  changed — while an ordinary destination in the same project still works.
- **Release and partial failure.** Both locks are released after a verified success, after a failure inside
  the quiesced window, and after a verification that could not read the set; and a nested failure under a
  capability releases **nothing** of the caller's, leaving its locks held and its capability still valid.
- **The crash**: a killed holder leaves both locks, no journal, no false success; every command still refuses;
  nothing removes the stale lock; and the documented manual recovery works.
- **Cross-version compatibility, in both directions.** An old-style acquisition — a literal
  `mkdir .catalog-retention.lock`, spelled out rather than imported, so the test cannot pass by construction
  — excludes all four of this build's commands, changes nothing in the destination, and is never removed;
  and a real holder of this build makes that same old-style `mkdir` fail, with exactly one lock directory in
  the destination rather than one per version.
- **The order, structurally**: observed from disk, and asserted against every module under `src/ops/` — none
  of them calls `acquireDestinationLock` or spells a lock name.
