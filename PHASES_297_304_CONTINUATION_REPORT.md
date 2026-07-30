# Phases 297–304 — continuation of the second review (items 1–7)

Commit `2dbe3b3`, from `240a957`. Worktree clean. Nothing pushed, no live system touched.

**The previous dispatch sent `worker_done` with items 2–7 unimplemented.** That was my error, not a
disagreement about scope. This commit is those items.

## Item by item

| # | What was wrong | What it is now |
| --- | --- | --- |
| **1** | Ownership of the staging tree was `removeOwnTreeNoFollow` — which refuses links and special files and would reuse *or remove* any plain directory at a predictable name. Verification ran once, at staging time. `swapComponent` made an unchecked second copy and installed that | A marker binds the tree to journal version + plan digest + suffix + each component's digest/entries/bytes, written **last**. Unowned ⇒ refused, never reused, never removed. Every component re-verified against the backup manifest **immediately before each consumption** (placement, replay, container read). Placement **moves** the verified artifact instead of copying it. Cleanup on success *and* on abandon removes only a verified-owned tree; when it cannot, the journal is kept and the name reported |
| **2** | `lock.release()` ran before the verdict, the cleanup and the journal clear. `abandonRestore` took no lock at all. The pre-lock journal snapshot drove every effect | Finalization moved inside the lock; the journal is re-read under it and must equal the pre-lock read; abandon serialises all of its renames, staging removal and journal writes under the same lock |
| **3** | Only equality among the three targets was rejected | Equality **and** containment either way, plus the destination, the set, the journal, the lock and the `.replaced-`/`.restoring-`/`.abandoned-`/staging namespaces — refused before a command, a lock or a journal exists |
| **4** | `replaced: null` marked the swap undone and left the *restored* copy at the target — restoring nothing. No crash recovery. No cross-validation | Absence is restored, the copy moved to a deterministic `.abandoned-` name and **reported**; both halves crash-recoverable; a finished-but-unrecorded swap recognised rather than undone twice; every swap cross-validated against the journal's request/topology/step/leaf/suffix; journal cleared only when every original state is back, every retained copy named and staging resolved |
| **5** | `--accept-data-loss` needed the digest of the no-safety plan, so getting it meant `--plan --accept-data-loss <anything>` — the value was **ignored** | `--no-safety-set` is a value-free switch that changes the plan and makes `--plan` print its digest loudly; `--accept-data-loss <digest>` is execution-only and **refused** at plan time; each half without the other is a usage error |
| **6** | Six boundaries covered; three named ones were not | Added: after `stage-components`' effect before its record; after the **final** step's record before cleanup/clear; **both halves of an abandon**. Plus a foreign staging tree, a staged component mutated between invocations, and two concurrency cases where a resume and an abandon each arrive inside another run's finalization window |
| **7** | README and the design doc claimed the model covers "a kill, a power loss or an OOM" | Narrowed to what is proved. A kill is proved (real child processes, real `process.exit`). A power loss is **not** — this command `fsync`s and publishes by rename, but whether those bytes reached the platter is the filesystem's promise and no test here has cut power. Both documents now say exactly that |

## Test results

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | **PASS**, 0 errors |
| `npm run test:complete-restore` | **89 passed, 0 failed** (was 72) |
| `npm run test:complete-backup` | 49 passed, 0 failed |
| `npm run test:custody-proof` | 9 passed, 0 failed |
| `test/test-runner.ts` | 60 passed, 0 failed |
| `test/backup-inspect.ts` | 60 passed, 0 failed, 1 skipped (pre-existing) |
| `npm run test:inventory` | **ok: true**, 322 suites, 6 helpers |
| `npm test -- --group db` | **33/33 PASS** |
| `npm test -- --group offline` | 287 selected, **284 pass, 3 fail — the same pre-existing custody/compose failures** |
| `npm test -- --group docker` | **NOT_RUN** — no daemon |

## Two things the reviewer should know

1. **Item 7 arrived truncated and there was no item 8.** The task text ends mid-sentence at
   *"README now claims the model covers 'a kill, a power loss or an OOM.'"*, and items "3–8" are referenced
   while only seven are listed. I read item 7 as *make that claim exact* and did so in README, the design doc
   and `restore-model.ts`. `orca orchestration check` returned no further message. If item 8 exists, it is
   not implemented and I do not know what it was.
2. **One assertion is structural rather than behavioural.** "No stale pre-lock snapshot may drive an effect"
   is proved by asserting the re-read happens under the lock before any step and before any write, and that
   the mismatch refusal exists — because the seam between the two reads *is* the lock, and there is no
   injection point between them. The two locked-window tests beside it are fully behavioural.

## Remaining risks

1. **The in-flight `.restoring-` directory is now the only copy** of a component outside the set. That is the
   point (no unverified second copy), but it means a failure to rename it into place leaves the component
   only there; the recovery re-verifies it against the manifest before installing and refuses otherwise.
2. **The staging marker is not itself digest-protected.** An attacker who can write the marker can write the
   components. It binds ownership, not integrity — integrity comes from re-verifying against the *backup
   manifest*, which lives in the set.
3. **`--no-safety-set` changes the plan digest**, so any operator runbook holding a digest from before this
   change will now mismatch. Fails closed.
4. **Journal version 3 is still not migrated from 2** (carried over, fails closed).
5. **A resumed run's world state is still modelled** in the suite (`startDestroyed`), not observed from a
   real daemon.
