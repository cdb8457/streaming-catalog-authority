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
| Lock directory | `.catalog-destination.lock`, created inside the destination |
| Mechanism | `mkdir`, which creates and refuses atomically. Nothing waits, nothing polls, nothing blocks |
| Acquire | `MaintenanceLocks.lockDestination(dir)` — the only route; `acquireDestinationLock` is not called by any command module, and a suite asserts that |
| Refusal | `DESTINATION_LOCK_CONTENTION` — one sentence, naming all four commands **and the cross-project case** |
| Historical names | `.catalog-retention.lock` is still **refused by name** so a crashed run from an older build cannot become invisible to a renamed lock |
| Inventory | every lock name, current and historical, is excluded from both the retention inventory and the claim inventory, so a plan and the re-plan under the lock agree |

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

**A destination reached through a symbolic link or a Windows junction is refused outright**, before any lock,
by `resolveInsideRoot`, which `lstat`s every component of the path. That has not changed and is not weakened
here. It also means the alias this lock exists for is a bind mount, a share, or one project directory inside
another — never a link.

---

## The exact lock order

```
  1. project maintenance lock      .catalog-maintenance.lock   in the PROJECT ROOT
  2. destination lock              .catalog-destination.lock   in the DESTINATION
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
| `ops:complete-backup` | before anything is created | after the request is re-resolved under the project lock and the destination is known to exist — **before** the staging directory, **before** the first `docker compose stop`, **before** `pg_dump` | staging, quiesce, dump, keystore, secrets, manifest, publish |
| `ops:complete-restore` | before the journal is re-read | immediately after the journal is re-read and proved identical — **before** the set is re-verified, **before** a claim directory is created, **before** the safety set is taken, **before** `compose down -v` | the whole destructive protocol, held throughout |
| `ops:backup-retention` | before the journal is read | after the destination is resolved from the journal (resume/abandon) or the request (run) — before the re-inventory, the journal write and the quarantine | inventory, journal, quarantine, renames, deletions |
| `ops:safety-set-lifecycle` | before the journal is read | same as retention | claim inventory, journal, quarantine, floor re-proof, deletions |

### The one nested case

`ops:complete-restore` publishes its safety set through `ops:complete-backup`, into a claim directory
**inside** the destination it is already holding. That call passes `holdingLock: true`, which now means *the
caller holds both locks covering this operation*, and the nested backup takes neither. It has to:

- `mkdir` as a lock is not reentrant, so a second project lock would self-deadlock; and
- a destination lock taken at the **claim directory** would be a lock on a different directory, excluding
  nothing that matters, and would leave a lock directory inside a claim whose entries are later proved one by
  one by `ops:safety-set-lifecycle`.

Exactly one project lock and one destination lock exist while a safety set is being taken. A suite observes
that from disk, at the instant the safety set's own `docker compose stop` runs, and asserts that no other
module under `src/` passes the flag.

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

1. **The lock is the directory a command was told to publish into.** An operator who points
   `ops:complete-backup --destination` at a claim namespace *inside* a destination by hand locks that
   directory, not the destination above it. Nothing in the shipped flow does that — the restore's nested
   backup inherits the enclosing lock — and no documented operator action does either.
2. **A destination on a filesystem where `mkdir` is not atomic between the contending hosts is not covered.**
   That is any network filesystem without proper `O_EXCL`/directory-create semantics. The lock is exactly as
   strong as the destination's filesystem.
3. **A destination unreachable at abandon time is unlocked, deliberately.** `ops:complete-restore --abandon`
   is the one command that puts an installation back; refusing it because a directory it does not need has
   gone would strand a recovery. It runs without the destination lock and says so in its notes. A lock
   somebody **holds** is still a refusal — the two failures are told apart by which step threw, not by
   reading a message.
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
- **The crash**: a killed holder leaves both locks, no journal, no false success; every command still refuses;
  nothing removes the stale lock; and the documented manual recovery works.
- **The legacy lock**: `.catalog-retention.lock` refuses every command by name, is never removed, and never
  has a new lock taken beside it.
- **The order, structurally**: observed from disk, and asserted against every module under `src/ops/` — none
  of them calls `acquireDestinationLock` or spells a lock name.
