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
  the destination lock **before** staging and **before** the first command; `holdingLock` widened to cover
  both locks
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

1. **One primitive, one name, one vocabulary.** `.catalog-destination.lock` is a literal in exactly one
   module. No command module spells it, and none calls `acquireDestinationLock` — a suite scans every file
   under `src/ops/` for both.
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
6. **`ops:complete-backup` does not start `pg_dump` before the lock.** The lock precedes the staging
   directory, the first `docker compose stop` and the dump.
7. **`ops:complete-restore` creates no claim and stops nothing before the lock.** The lock precedes the
   under-lock re-verification of the set, the claim `mkdir`, the safety set and `compose down -v`.
8. **A resume and an abandon lock the destination the JOURNAL names**, never a caller flag.
9. **A crash leaves both locks, no false success, and nothing removes them.** The stale-lock recovery is
   manual, deterministic and documented, and the suite performs it.
10. **A lock left by an EARLIER build is refused by name.** `.catalog-retention.lock` still stops all four
    commands, is never removed, and never has a new lock taken beside it.
11. **A plan takes no lock.** Reading one is never refused by another project's run, and the plan-only Unraid
    and operator-UI surfaces are unchanged and still non-destructive.
12. **Retention and safety-set lifecycle lost nothing.** Their authority, quarantine, journal,
    `deleting`-state and replacement protections are untouched; their suites pass at **114** and **98**.

---

## The exact lock table

| Command | Path | Project lock taken | Destination lock taken | Released |
| --- | --- | --- | --- | --- |
| `ops:complete-backup` | `--confirm` (a run) | before anything is created | after re-resolving under the project lock and ensuring the destination exists — before staging, before `compose stop`, before `pg_dump` | destination, then project, in `finally` |
| `ops:complete-backup` | `--plan` | none | none | — |
| `ops:complete-backup` | nested safety set (`holdingLock`) | inherited, none taken | inherited, none taken | inherited |
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
5. **A renamed lock would have made an older build's crashed run invisible.** Renaming
   `.catalog-retention.lock` to `.catalog-destination.lock` is right — the old name was a lie from the second
   command onward — but an operator upgrading with an interrupted prune on disk would have had the new
   commands walk straight past a directory the old ones refused for. The old name is refused by name, loudly,
   and is still never removed.
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

1. **The lock is the directory a command was told to publish into.** An operator who points
   `ops:complete-backup --destination` at a *claim namespace inside* a destination by hand locks that
   directory rather than the destination above it. No shipped flow and no documented operator action does
   that — the restore's nested backup inherits the enclosing lock — but the product does not refuse it
   either, and a reviewer should decide whether a dot-prefixed destination leaf should be refused outright.
2. **`ops:complete-backup` resolves its request twice** — once before the project lock for the cheap
   refusals, once under it because a check made before a lock is about a moment that has passed. That doubles
   an `assertPlainTree` walk bounded at 5000 entries over the secrets and promotion-records directories.
   Cheap in practice; nobody has measured it against a large promotion-records tree.
3. **The lock is exactly as strong as the destination's filesystem.** Two hosts sharing a destination over a
   network filesystem without correct atomic directory creation are not covered. This is a property of
   `mkdir`, is stated in the design document, and cannot be closed from inside this product.
4. **The contender matrix drives a fresh `--confirm` for every command, not a `--resume`.** Resume and
   abandon contention is covered behaviourally for `ops:backup-retention` (a real interrupted journal) and
   for `ops:complete-restore --abandon`, and structurally for the rest. A restore `--resume` under
   contention is not driven end to end, because reaching its lock requires a real interrupted restore in the
   contender project; the code path is the same one the fresh run takes, three lines earlier.
5. **`ops:complete-restore` runs one read-only `docker compose ps` before the lock**, as part of classifying
   the target state its plan digest binds. It starts nothing and changes nothing, and it is stated rather
   than papered over — but it means "no command at all before the lock" is true of the backup and not,
   strictly, of the restore.
6. **A shared destination is now safe, not sensible.** Two installations' backups in one directory still
   share free space, a blast radius, and one operator's `--keep-last` deciding about another's sets. The
   product no longer corrupts that configuration; it still does not recommend it, and a reviewer may decide
   it should refuse one outright.
7. **Three pre-existing suite failures remain** (table above). They are unrelated and untouched, and a
   reviewer running the full gate on a clean checkout will see the same three.
