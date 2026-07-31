# Phases 321-328 — the shared backup-destination lock: builder's report

## What this tranche is

The Phase 313-320 report's **first remaining review risk**, closed:

> **The shared-destination boundary is documented, not closed.** Another project's complete backup or restore
> can publish into a destination while retention or safety-set lifecycle holds its destination lock.

All four destructive/irrecoverable backup-family commands now coordinate on **one lock, taken in the physical
backup destination**, in **one order**, with **one refusal vocabulary**:

- `ops:complete-backup`
- `ops:complete-restore`
- `ops:backup-retention`
- `ops:safety-set-lifecycle`

Nothing was scheduled, no flag was added, no journal schema was versioned, and no existing refusal wording
changed except the destination-lock sentence itself, which had to.

---

## Key files

**New**
- `docs/PHASES_321_328_SHARED_DESTINATION_LOCK.md` — the design, the lock table, the crash boundaries, the
  limits
- `test/shared-destination-lock.ts` — **31 checks**, the Phase 321-328 suite
- `test/helpers/shared-destination-kit.ts` — the two-projects-one-destination fixture and the snapshot
- `test/helpers/destination-lock-holder.mts` — a real command held at a real post-lock boundary
- `test/helpers/destination-lock-contender.mts` — a real command run against a destination somebody holds
- `PHASES_321_328_REPORT.md` — this file

**Changed**
- `src/ops/maintenance-safety.ts` — `DESTINATION_LOCK_DIRNAME`, `LEGACY_DESTINATION_LOCK_DIRNAMES`,
  `DESTINATION_LOCK_CONTENTION`, `provePhysicalDestination`, `resolveBackupDestination`,
  `acquireDestinationLock`, and the `MaintenanceLocks` stack that makes the order structural
- `src/ops/backup-retention.ts` — `RETENTION_LOCK_DIRNAME` and its private `lockDestination` deleted;
  `resolveRetentionDestination` delegates to the shared resolver; both run paths use the stack.
  **No behaviour change** except the one refusal sentence
- `src/ops/safety-set-lifecycle.ts` — same, and it no longer imports a lock name from retention
- `src/ops/complete-backup.ts` — re-resolves under the project lock, ensures the destination exists, takes
  the destination lock **before** staging and **before** the first command, and (Correction 1) holds both
  through the **verification**; refuses a claim-namespace destination; validates the nested capability
- `src/ops/complete-restore.ts` — takes the destination lock immediately after the journal is re-read and
  proved unchanged, from the **journal's** destination, and holds it across the whole destructive protocol;
  `--abandon` takes it too, and proceeds without it rather than stranding a recovery when the destination
  has gone
- `src/ops/complete-backup-cli.ts`, `complete-restore-cli.ts`, `backup-retention-cli.ts`,
  `safety-set-lifecycle-cli.ts` — one usage paragraph each: serialised per destination, across projects
- `src/ops/release-readiness.ts`, `.github/workflows/runtime-image.yml` — `test:phase321-local` is required
- `README.md`, `docs/PHASES_313_320_SAFETY_SET_LIFECYCLE.md` (its lock section and its limit #1 are marked
  superseded/closed and point here)
- `package.json`, `test/suite-inventory.json`
- `test/backup-retention.ts`, `test/safety-set-lifecycle.ts` — the lock name import, and one refusal
  sentence; `test/complete-restore.ts` — the crash helper now clears **both** locks, as a real operator
  would, and three source-scan assertions follow the renamed symbols

---

## Closed invariants

1. **One primitive, one name, one vocabulary.** `.catalog-retention.lock` — the name every shipped build
   already uses — is a literal in exactly one module, `DESTINATION_LOCK_DIRNAMES` has exactly one entry, and
   acquiring it is one `mkdir` with nothing inspected first. `acquireDestinationLock` is **not exported**,
   so no command module can reach it.
2. **The order is structural, not conventional.** The only way to reach the destination lock is through a
   `MaintenanceLocks` obtained by taking the project lock; `release()` releases destination-then-project
   regardless of what a call site remembers, and does so in a `finally` so a destination lock that would not
   release cannot strand the project lock. Asking twice is a refusal.
3. **Two projects sharing one physical destination contend.** The lock is a directory inside the destination,
   so two different relative addresses `mkdir` the same inode. Proved with two distinct project roots.
4. **No deadlock is expressible.** Both domains are always taken in one order, and nothing waits — `mkdir`
   refuses rather than blocks, so the worst case is a refusal an operator can read.
5. **A contender refuses before its first effect.** No staging directory, no claim, no rename, no delete, no
   journal, no child command, no network — asserted against the argv ledger and a byte-level snapshot of the
   destination taken either side of five real contender processes.
6. **`ops:complete-backup` does not start `pg_dump` before the lock**, and does not release it until the
   VERIFICATION VERDICT EXISTS. The lock precedes the staging directory, the first `docker compose stop` and
   the dump, and outlives the publication and the read-back.
7. **`ops:complete-restore` creates no claim and stops nothing before the lock.** The lock precedes the
   under-lock re-verification of the set, the claim `mkdir`, the safety set and `compose down -v`.
8. **A resume and an abandon lock the destination the JOURNAL names**, never a caller flag.
9. **A crash leaves both locks, no false success, and nothing removes them.** The stale-lock recovery is
   manual, deterministic and documented, and the suite performs it.
10. **An older build and this one contend on ONE atomic name**, in both directions, with no window — and
    release only ever removes the lock the calling run created.
11. **A plan takes no lock.** Reading one is never refused by another project's run, and the plan-only Unraid
    and operator-UI surfaces are unchanged and still non-destructive.
12. **Retention and safety-set lifecycle lost nothing.** Their authority, quarantine, journal,
    `deleting`-state and replacement protections are untouched; their suites pass at **114** and **98**.

---

## The exact lock table

| Command | Path | Project lock taken | Destination lock taken | Released |
| --- | --- | --- | --- | --- |
| `ops:complete-backup` | `--confirm` (a run) | before anything is created | after re-resolving under the project lock and ensuring the destination exists — before staging, before `compose stop`, before `pg_dump` | destination, then project, in `finally`, **after the verification verdict** |
| `ops:complete-backup` | `--plan` | none | none | — |
| `ops:complete-backup` | nested safety set (`HeldDestination`) | none: the caller's | none: the caller's | nothing — a nested failure releases none of the caller's locks |
| `ops:complete-restore` | `--confirm` (a run) | before the journal is re-read | immediately after the journal is re-read and proved identical — before the set is re-verified, before the claim, before the safety set, before `down -v` | destination, then project, in `finally`, after the verdict, the staging cleanup and the journal clear |
| `ops:complete-restore` | `--resume` | as above | as above, from the **journal's** destination | as above |
| `ops:complete-restore` | `--abandon` | after a pre-lock journal read | from the **journal's** destination, after the journal is re-read under the lock; **skipped with a note** if that destination no longer resolves | destination, then project, in `finally` |
| `ops:complete-restore` | `--plan` | none | none | — |
| `ops:backup-retention` | `--confirm` | after the cheap pre-lock refusals | after the destination is resolved (request for a run, **journal** for a resume) — before the re-inventory, the journal write and the quarantine | destination, then project, in `finally` |
| `ops:backup-retention` | `--resume` / `--abandon` | as above | from the **journal's** destination | as above |
| `ops:backup-retention` | `--plan` | none | none | — |
| `ops:safety-set-lifecycle` | `--confirm` / `--resume` / `--abandon` | after the cheap pre-lock refusals | same as retention, same order, same stack | destination, then project, in `finally` |
| `ops:safety-set-lifecycle` | `--plan` | none | none | — |

---

## Crash boundaries

| A process dies… | On disk | Recovery |
| --- | --- | --- |
| between `mkdir` of a fresh destination and the lock | an empty destination | nothing to do |
| holding both locks, before its first write | both lock directories, no journal, nothing moved | remove both directories once nothing is running |
| holding both locks, after the journal | both lock directories, a journal | remove both, then `--resume` or `--abandon`; the recovery reads the destination **from the journal** |
| holding both locks, mid-quarantine | both, a journal, a quarantine directory | as above; nothing was deleted in place, so `--abandon` puts back everything only renamed |
| a restore, mid-protocol | both, a journal, a claim, a staging tree | as above; `--abandon` runs even if the destination has gone |

A crash cannot produce a **false success** — every verdict is built inside the locked region — and cannot
produce a **silently removed lock**: nothing in this product removes a lock it did not take.

---

## What the suite actually drives

`test/shared-destination-lock.ts` — **31 checks**, no Docker daemon, no images, no network, no `pg_dump`, no
sleep, no polling and no timeout that could pass by accident.

- **The fixture.** Two real projects, one physical destination, built by nesting one project directory inside
  another — the one alias that needs no privilege, no mount and no platform-specific call. A **symlinked**
  destination is refused outright by this product, before any lock, and that is asserted too, so the pair of
  facts is complete rather than convenient. The case-variant alias is asserted as *exclusion*, not as string
  equality, because Node's `realpathSync` does not canonicalise case on Windows — and it does not need to.
- **The adversarial matrix, with real child processes.** A holder process runs a real command and is stopped
  inside one of its own injected primitives — `suffix()` for the two lifecycle commands (post-lock,
  **pre-journal, pre-quarantine, pre-rename**), the first `docker compose stop` for the backup (post-lock,
  its own staging tree present) and for the restore (post-lock, **claim published, volumes not yet
  destroyed** — the most dangerous instant this product has). From inside that boundary it spawns five real
  contender processes from the *other* project against the same physical directory: `ops:complete-backup`,
  `ops:complete-restore`, `ops:backup-retention`, `ops:safety-set-lifecycle`, and `ops:backup-retention`
  again through its real CLI with `--json`. Run in **both directions**.
- **What each contender has to prove.** It refused; it refused with the shared vocabulary; it issued no
  `stop`, `start`, `down`, `up`, `cp`, `exec`, `run`, `kill` or `create`, no `pg_dump`, no `psql` and nothing
  carrying `://`; the destination is byte-identical before and after; and it left no journal and no project
  lock behind in its own project.
- **The operator surface.** The CLI contender exits `3`, puts **nothing** on stdout under `--json` (a refusal
  before any effect has no report to emit, and a machine reading stdout must read zero documents rather than
  one document of prose), and puts the sentence on stderr.
- **The crash.** A holder killed at the boundary: both locks on disk, no journal, no false success; every
  command still refuses from either project; nothing removes the stale lock; then the documented manual
  recovery is performed and a prune from the other project completes.
- **Recovery contention, for real.** A genuine interrupted prune — stopped at its own `after-journal`
  failpoint, so the journal is on disk and the locks were released — then `--resume` and `--abandon` are both
  refused while another project holds the destination, both leave the journal untouched, and both become
  available the moment it is free.
- **`ops:complete-restore --abandon` with the destination GONE** runs anyway, clears the journal, and says in
  its notes that it ran without the destination lock. With the destination present but **held**, it refuses:
  the two failures are told apart by which step threw, not by reading a message.

### Tests and results

| Gate | Result |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | **PASS**, 0 errors |
| `npm run test:inventory` (Phase 258 audit) | **PASS**, `ok: true`, 325 suites |
| `npm run test:shared-destination-lock` (new) | **31 passed, 0 failed** |
| `npm run test:complete-backup` | 49 passed, 0 failed |
| `npm run test:complete-restore` | 136 passed, 0 failed |
| `npm run test:backup-retention` | 114 passed, 0 failed |
| `npm run test:safety-set-lifecycle` | 98 passed, 0 failed |
| `npm run test:backup-components` | 41 passed, 0 failed |
| `npx tsx test/release-readiness.ts` | 44 passed, 0 failed |
| `npx tsx test/deploy.ts` | 210 passed, 0 failed |
| `npx tsx test/upgrade-rehearsal.ts` | 49 passed, 0 failed |
| `npx tsx test/doctor-monitor.ts` | 19 passed, 0 failed |
| `npx tsx test/backup-inspect.ts` | 60 passed, 0 failed, 1 skipped |
| `npx tsx test/backup-verify.ts` | 17 passed, 0 failed |
| `npx tsx test/backup-ops.ts` | 8 passed, 0 failed |
| `npx tsx test/operator-ui-service.ts` | 5 passed, 0 failed |
| `npx tsx test/kek-rotation.ts` | 12 passed, 0 failed |
| `npx tsx test/managed-custody-lifecycle.ts` | 16 passed, 0 failed |

### Commands issued, in full

```
npx tsc -p tsconfig.json --noEmit
npm run test:inventory
npm run test:shared-destination-lock
npm run test:complete-backup
npm run test:complete-restore
npm run test:backup-retention
npm run test:safety-set-lifecycle
npx tsx test/backup-components.ts
npx tsx test/backup-inspect.ts
npx tsx test/backup-verify.ts
npx tsx test/backup-ops.ts
npx tsx test/backup.ts
npx tsx test/upgrade-rehearsal.ts
npx tsx test/doctor-monitor.ts
npx tsx test/kek-rotation.ts
npx tsx test/kek-correction-gates.ts
npx tsx test/custody-cutover.ts
npx tsx test/custody-transition.ts
npx tsx test/managed-custody-lifecycle.ts
npx tsx test/release-readiness.ts
npx tsx test/deploy.ts
npx tsx test/operator-ui-service.ts
git log / git status / git diff / git stash (baseline comparison only)
```

Nothing was pushed, no PR was opened, no tag was created, nothing was published, no live credential was used
and no real installation was touched.

### NOT_RUN, deliberately, with exact reasons

- **The full aggregate suite (`npm run test:runner`, 325 suites)** — the coordinator reserves the broad
  offline/db/Docker gates. The suites this tranche can affect were selected by grepping every file under
  `test/` that imports `complete-backup`, `complete-restore`, `backup-retention`, `safety-set-lifecycle` or
  `maintenance-safety`, and every one of them was run.
- **Anything needing PostgreSQL, Docker or a browser** — reserved by the coordinator, and nothing here
  touches those layers.

### Pre-existing failures, untouched

Three suites fail identically on merged `origin/master` and on this branch, and none of them is in this
tranche's blast radius — all three are static gates over `deploy/local-runtime-setup.sh`:

| Suite | Baseline | This branch |
| --- | --- | --- |
| `test/custody-cutover.ts` | 22 passed, **2 failed** | 22 passed, **2 failed** |
| `test/custody-transition.ts` | 14 passed, **1 failed** | 14 passed, **1 failed** |
| `test/kek-correction-gates.ts` | 37 passed, **1 failed** | 37 passed, **1 failed** |

Verified by `git stash -u`, running all three on the clean tree, and `git stash pop`. They look like
line-ending sensitivity on this Windows worktree; they are **not** investigated or fixed here, because doing
so is a different tranche and would put unrelated changes in this diff.

---

## Hostile self-review — what I found in my own work, and fixed

1. **`MaintenanceLocks.release()` could strand the project lock.** The first cut released the destination lock
   and then the project lock as a bare sequence. `acquireLockDirectory`'s release swallows its own failures
   today, so nothing could actually throw — but if it ever did, the project lock would never be released and
   the project would be permanently locked by a process that had finished, which is strictly worse than the
   stale destination lock that caused it. The second release is now in a `finally`.
2. **`ops:complete-backup` could refuse a legitimate destination in a two-project race.** It creates the
   destination when it is absent, and `createPrivateDirectory` refuses an existing name — correct for its
   other callers, which are *claiming* a name, and wrong here, where two projects legitimately share a
   directory. An `EEXIST` that turns out to be a plain directory is now the race being lost rather than an
   error; a file, a link or an unwritable parent still refuses.
3. **I asserted something about `realpath` that is false on Windows.** The first version of the case-alias
   test asserted that two case spellings resolve to one string. Node's `realpathSync` does not canonicalise
   case on Windows, and the test failed — correctly. The claim was wrong, not the code: exclusion comes from
   the filesystem, because the lock is a directory in the destination. The test now asserts contention and
   the design document says so instead of the convenient thing.
4. **Two source-scan assertions would have passed for the wrong reason.** "No `--force`" tripped over
   comments that say *there is no `--force`*, and "the plan-only surfaces never confirm" tripped over prose
   explaining what `--confirm` is. Both now ask the behaviour: each CLI is really run with each flag and must
   answer with a usage error, and only lines that actually invoke a command are scanned for `--confirm`.
5. **A renamed lock would have made an older build's crashed run invisible**, so the first cut kept the old
   name working with a pre-check. **Correction 1 found that the pre-check was itself the bug** and the rename
   was abandoned — see below.
6. **The restore's abandon could have been wedged by the lock I was adding.** A destination that has been
   unmounted, renamed or removed since the crash would have made the one command that puts an installation
   back refuse forever, on the strength of a directory it does not need. Resolution failure is a note;
   acquisition failure is still a refusal; the two are told apart by which step threw.
7. **A dead code path I inherited and did not keep.** Both `lockDestination` helpers began with
   `if (destinationDir === projectRoot) return null` — unreachable, because both resolvers already refuse
   that. The shared resolver keeps the refusal; the unreachable branch is gone.

## Hostile review checklist, item by item

| Item | Where it is answered |
| --- | --- |
| Windows/POSIX path alias and `lstat`/no-follow behaviour | the alias, link and case tests; `provePhysicalDestination` documented as a narrowing rather than the guarantee |
| destination-equals-project-root / outside-root refusals remain exact | a test asserting all four sentences directly |
| no project/destination deadlock, including two projects sharing one destination | the order is structural; a test drives the shape that would deadlock and gets an immediate refusal |
| lock directory creation/publish races and release failures | the destination-creation race (finding 2); the release `finally` (finding 1); `publishDirectory` unchanged |
| crash leaves no false success; stale lock never silently removed | the crash test: both locks, no journal, every command still refuses, manual recovery works |
| `ops:complete-backup` does not start `pg_dump` before the destination lock | the contender's argv ledger is empty |
| `ops:complete-restore` does not create a claim or stop Docker before the destination lock | the destination snapshot is byte-identical and the ledger carries no `stop`/`down` |
| resume/abandon use the journal destination and remain available | the structural test, plus a real interrupted prune refused and then completed, plus the abandon-with-no-destination test |
| no new TOCTOU authority regression in retention/lifecycle | their logic is untouched; 114 and 98 checks pass; the lock is taken at the same point in the same order |
| JSON output remains exactly one document where promised | the CLI contender: exit 3, nothing on stdout, sentence on stderr |
| all focused suites, typecheck, inventory pass | the table above |

---

## Remaining risks

1. **`ops:complete-backup` resolves its request twice** — once before the project lock for the cheap
   refusals, once under it because a check made before a lock is about a moment that has passed. That doubles
   an `assertPlainTree` walk bounded at 5000 entries over the secrets and promotion-records directories.
   Cheap in practice; nobody has measured it against a large promotion-records tree.
2. **The lock is exactly as strong as the destination's filesystem.** Two hosts sharing a destination over a
   network filesystem without correct atomic directory creation are not covered. This is a property of
   `mkdir`, is stated in the design document, and cannot be closed from inside this product.
3. **The contender matrix drives a fresh `--confirm` for every command, not a `--resume`.** Resume and
   abandon contention is covered behaviourally for `ops:backup-retention` (a real interrupted journal) and
   for `ops:complete-restore --abandon`, and structurally for the rest. A restore `--resume` under
   contention is not driven end to end, because reaching its lock requires a real interrupted restore in the
   contender project; the code path is the same one the fresh run takes, three lines earlier.
4. **`ops:complete-restore` runs one read-only `docker compose ps` before the lock**, as part of classifying
   the target state its plan digest binds. It starts nothing and changes nothing, and it is stated rather
   than papered over — but it means "no command at all before the lock" is true of the backup and not,
   strictly, of the restore.
5. **A shared destination is now safe, not sensible.** Two installations' backups in one directory still
   share free space, a blast radius, and one operator's `--keep-last` deciding about another's sets. The
   product no longer corrupts that configuration; it still does not recommend it, and a reviewer may decide
   it should refuse one outright.
6. **Three pre-existing suite failures remain** (table above). They are unrelated and untouched, and a
   reviewer running the full gate on a clean checkout will see the same three.

---

# Correction 1 — five defects found by independent review, all reachable, all fixed

Independent review returned four release-blocking findings; two more came out of the fixes themselves, one
of them found by a test written for a different bug. Every one is behavioural, and every one now has a
behavioural test rather than a source assertion.

## 1. RELEASE-BLOCKER — the ordinary command dropped both locks before it verified

`runVerifiedCompleteBackup` called `takeCompleteBackupWithoutVerifying`, which releases both locks in its
own `finally`, and only then read every byte of the set back to decide the verdict. **The documented,
operator-facing command therefore held nothing at all between publishing its set and verifying it.** Inside
that window another project could quarantine the set, delete it, or move something else into its name — and
this command would report `ok: true` about a set that had gone, "does not verify" about a set somebody else
removed, or a verdict about a directory it had not taken.

**Fixed** by moving lock ownership up. `runVerifiedCompleteBackup` opens the stack, an internal
`performBackup` does the taking, `verifyWhatWasTaken` runs **inside the same locked region**, and the
release happens after the verdict exists or after a throw. The verified command no longer calls the
unverified entry point at all — that one keeps its own locks because it is the step a suite drives directly.

**Proved** by a real `ops:complete-backup` child stopped at a new `before-verify` boundary — set published,
verdict not yet computed — with five real contender processes started from another project against the same
physical destination from inside that instant. All five refuse; the published set is byte-identical either
side; the command then finishes and releases both locks.

## 2. RELEASE-BLOCKER — `holdingLock: true` was an unbound no-lock bypass

A boolean names no project, no destination and no holder. Any caller could set it and suppress **both**
locks for **any** project and **any** destination, and the only thing standing between that and an unlocked
backup was a suite grepping `src/` for the word. A source allowlist is a lint rule, not an authority.

**Fixed** with a `HeldDestination` capability. `MaintenanceLocks.inherited()` — the public no-lock factory —
is deleted. A capability can only be minted by a stack that is really holding both locks; its identity is
membership of a module-private `WeakSet`, so the one forgery TypeScript cannot stop (a cast) is refused at
runtime; it is bound to the canonical project root; and it is invalidated when its owner releases.
`acquireDestinationLock` is no longer exported, so the acquisition order cannot be expressed backwards.

## 3. RELEASE-BLOCKER — the legacy-lock migration was check-then-create

`acquireDestinationLock` `lstat`ed `.catalog-retention.lock` and then `mkdir`ed `.catalog-destination.lock`.
**A check of one name followed by a create of another is not a lock**: an older `ops:backup-retention` could
take the old name inside that window and both processes would believe they held the destination — so the
rename returned *less* exclusion than the two commands already had.

**Fixed** by keeping `.catalog-retention.lock` as the canonical filename. One name, one `mkdir`, one atomic
operation; the vocabulary around it moved to "destination" and the name on disk did not. The docs now scope
cross-version protection honestly: **older `ops:complete-backup` and `ops:complete-restore` took no
destination lock at all**, so a mixed-build fleet is covered for the two commands that always took it and
not for the two that did not — no filename can fix that.

**Proved** in both directions, with the old-style acquisition spelled as a literal `mkdir` rather than
imported, so the test cannot pass by construction if the name ever changes again.

## 4. TEST/DOC ACCURACY — a test titled for a document it did not assert

The CLI test was called "one JSON document on lock refusal" and asserted an **empty stdout** plus a prose
stderr sentence. Both cannot be true. The assertions were the honest half: a refusal before any effect has
no report to serialise, so `--json` emits no document, stdout stays empty, the sentence goes to stderr and
the exit code is `3`. The test and the report now say that, and neither claims a document was produced. The
one-document contract belongs to the report paths and is unchanged, still asserted in
`test/backup-retention.ts`.

## 5. The capability authorised too much, and proved containment from the wrong things

Two defects in the fix for #2, both raised in review:

* **It authorised every descendant** of the held destination, and a test asserted that as if it were the
  requirement. The legitimate caller publishes into exactly one directory, so the permitted set is now
  closed: the held destination itself, or **one already-existing** `.pre-restore-claim-<nonce>` directory
  **directly** inside it. An ordinary subdirectory, a deeper path, a claim two levels down, and a claim that
  does not exist are all refused.
* **It folded case whenever `process.platform` was `win32` or `darwin`.** That is a guess about a host when
  the question is about a directory — macOS ships case-sensitive APFS volumes, Windows supports
  per-directory case sensitivity — and on a case-sensitive volume it would have treated two different
  directories as one. Containment is now an exact comparison of canonical paths, corroborated by the
  filesystem's own `ino`/`dev`, which can only ever reject.

The same review closed the candidate's **remaining risk #1**: a standalone `ops:complete-backup` pointed
into a claim namespace would lock *inside* the claim while retention and lifecycle lock the destination
*above* it. Both entry points now refuse any destination with a claim-shaped component, before the project
lock and before anything is created; only a capability authorises that namespace.

## 6. A capability bound to a path is not bound to a directory — and release was not ownership-bound

Two more, the second found by the test written for the first:

* **`HeldDestination` compared the directory currently at a path with the directory currently at that same
  path** — a tautology. Rename the held destination away, build a new directory at the original path, and
  the check passed while the lock that was actually taken sat in the inode that moved. The capability now
  carries the `ino`/`dev` of the destination **and of the lock directory inside it**, captured when
  `lockDestination` acquired, and fails closed when the filesystem reports no usable inode.
* **`acquireLockDirectory(...).release()` stored only a path.** In exactly that renamed-and-replaced state,
  the `finally` would `unlink` and `rmdir` the **foreign** replacement lock and leave this run's real lock
  stale inside the directory that moved — one command tidying up would silently unlock a destination another
  command was working in. Release is now bound to the directory identity captured at acquisition **and** to
  an unguessable token written inside the lock; on missing, mismatched or replaced state it does nothing.
  This covers the **project** lock and every other user of the primitive, not only the destination lock, and
  the reverse release order is unchanged.

**Proved** by renaming a held destination away, rebuilding it at the same path complete with a same-named
claim and a lock directory of its own, and asserting that the old capability refuses before any effect, that
the replacement is byte-identical afterwards, that `release()` leaves the replacement lock untouched, and
that the moved original stays stale — with explicit cleanup, because the fixture deliberately leaves two
locks nothing owns.

## Correction 1 gates

| Gate | Result |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | **PASS**, 0 errors |
| `npm run test:shared-destination-lock` | **47 passed, 0 failed** (was 31) |
| `npm run test:complete-backup` | 49 passed, 0 failed |
| `npm run test:complete-restore` | 136 passed, 0 failed |
| `npm run test:backup-retention` | 114 passed, 0 failed |
| `npm run test:safety-set-lifecycle` | 98 passed, 0 failed |
| `npm run test:inventory` | **PASS**, `ok: true` |
| `npx tsx test/release-readiness.ts` | 44 passed, 0 failed |
| `npx tsx test/doctor-monitor.ts` | 19 passed, 0 failed |
| `npx tsx test/kek-rotation.ts` | 12 passed, 0 failed |
| `npx tsx test/upgrade-rehearsal.ts` | 49 passed, 0 failed |
| `npx tsx test/backup-components.ts` | 41 passed, 0 failed |
| `npx tsx test/custody-cutover.ts` | 22 passed, 2 failed — **pre-existing**, identical on merged `origin/master` |
| `npx tsx test/custody-transition.ts` | 14 passed, 1 failed — **pre-existing**, identical on merged `origin/master` |

The three suites that touch the lock primitive without belonging to this family — `doctor-monitor`,
`kek-rotation`, `custody-*` — were re-run specifically because Correction 1 changed
`acquireLockDirectory`, which every one of them uses.

## What Correction 1 did NOT change

- **No lock filename changed**, so no operator's interrupted run became invisible.
- **No journal schema was versioned**; still no persisted field or semantic has changed.
- **No refusal wording changed** except the destination-lock sentence, which was already this tranche's.
- **No scheduler, no `--force`, no `--break-lock`.** A plan still takes no lock.
- **Retention and safety-set lifecycle kept every protection**: 114 and 98 checks, unchanged in substance.

## Remaining risks after Correction 1

1. **The nested capability is checked, but the claim it authorises is only checked for shape and existence.**
   `ops:safety-set-lifecycle` proves a claim's ownership from the marker inside it; the capability check does
   not re-prove that, because at the moment a restore publishes, the marker is the restore's own and the
   directory is one it just created. A reviewer may want the two ownership proofs unified.
2. **A filesystem that reports no usable inode refuses the nested safety-set backup outright.** That is the
   fail-closed choice and it means a restore on such a filesystem cannot take a safety set at all, rather
   than taking one unprotected. Nobody has found a filesystem this build runs on where that happens.
3. **`releaseOwnedLock` leaves a stale lock when it cannot prove ownership.** That is deliberate — the
   alternative deletes somebody else's — but it means a renamed-and-replaced destination accumulates a lock
   an operator has to remove by hand, and nothing reports it until the next run.
4. Risks 1-6 from the candidate report above stand as written, minus the claim-namespace risk, which is
   closed.
