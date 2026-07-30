# Phases 297–304 — second correction tranche (crash consistency)

Commit `205b095`, from `b13edab`. Worktree clean. Nothing pushed, no live system touched.

## The two named defects, executed at `b13edab` before anything was changed

```
not reproduced   non-prefix completed list is written   — the reader accepted the list itself
DEFECT CONFIRMED  resume after a failed earlier proof   — "records completed steps that are not this
                                                          operation's steps in this operation's order"
DEFECT CONFIRMED  custodyProven lost across a resume    — resume completed ok=true with prove-decrypt
                                                          skipped and reported custodyProven=false;
                                                          custody WAS proven in the first run
```

The first line is worth stating precisely: the journal *write* succeeded, so a naive check of the writer
passed. The failure was on the **next** run — the project refused a fresh restore (a journal is present) and
refused a resume (the journal it had just written was illegal). A dead end, not a diagnosis.

## What changed

| Area | Correction |
| --- | --- |
| Journal model | Per-step `pending`/`running`/`complete`/`failed` with the reason on the failure, replacing the ordered completed-list. Journal version 2 → 3 |
| Legality | Rules are the executor's shape: non-proof steps `complete`\* then ≤1 `running`/`failed` then `pending`\*; proofs stay `pending` until everything before them is complete; proofs themselves are (`complete`\|`failed`)\* then ≤1 `running` then `pending`\*. Structural validation adds: >1 running refused, a failure with no reason refused, a success carrying a reason refused, empty step list refused, evidence type/consistency checked |
| Evidence | `RestoreEvidence { custodyProven, safetySetTaken, safetySetVerified }` persisted with the step that produced it and restored on resume. A recovered safety set sets its own evidence |
| Recovery | `STEP_RECOVERY` declares a policy per step — `retry`, `confirm-or-retry`, `repair-swap`, `rewind` — with `STEP_REWIND_TO` naming where a rewind goes. Dispatched from the declaration, not from a reader's memory of which steps are idempotent |
| Swap repair | The four states a crash between two renames can leave, each with one answer. A swap that landed unrecorded has its journal entry reconstructed, because `--abandon` walks it |
| Verdict | Read off the operation's final per-step state, not off what the current process observed — so a resumed run reports what the operation established |
| Lock | A killed run leaves the maintenance lock; the refusal now names *both* the lock and the journal and says what to do. Still never broken automatically |

Two new injected effects, in the same idiom as `CommandRunner`/`FileInputRunner`:
`Renamer` (stop between the halves of a swap) and `JournalWriter` (stop at the instant an effect has landed
and its record has not). Production passes `renameSync` and `writeRestoreJournal`.

## The failpoints are real process deaths

An exception **cannot** produce the state under test: `runGuarded` catches a runner that throws — correctly —
and the step machinery catches everything else. A suite that threw would be re-testing the error path under a
new name. So `test/helpers/restore-crash-child.mts` runs the restore in its own process and calls
`process.exit` at a named boundary. Everything here is synchronous, so that is exactly a kill: no `catch`, no
`finally`, no journal update, and the lock left behind as a real crash leaves it.

| Boundary | What it asserts |
| --- | --- |
| `rename:1` | the secrets directory is **GONE**, `.replaced-` and `.restoring-` both present, journal says `running` → resume finishes the rename and the directory is back |
| `rename:2` | the swap landed unrecorded → resume recognises it, does **not** swap twice, and the reconstructed record still lets `--abandon` undo it |
| `complete:safety-set` | the set is on disk → resume verifies and **skips** it instead of retaking into a name that would refuse |
| `complete:safety-set` + damage | present and not verifying → refused, journal still says `running`, nothing changed |
| `complete:replay-database` | the leg is **rewound**: the volumes are destroyed again and the replay re-run |
| `complete:stop-and-destroy` | the boring case, checked anyway |

Every one also asserts the lock is left behind, then clears it the way the refusal tells an operator to.

## Test results

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | **PASS**, 0 errors |
| `npm run test:complete-restore` | **72 passed, 0 failed** (was 65) |
| `npm run test:complete-backup` | 49 passed, 0 failed |
| `npm run test:custody-proof` | 9 passed, 0 failed |
| `test/test-runner.ts` | 60 passed, 0 failed |
| `npm run test:inventory` | **ok: true**, 322 suites, 6 helpers |
| `npm test -- --group db` | **33/33 PASS** |
| `npm test -- --group offline` | 287 selected, **284 pass, 3 fail — the same pre-existing custody/compose failures** |
| `npm test -- --group docker` | **NOT_RUN** — no daemon (`npipe:////./pipe/dockerDesktopLinuxEngine` not found) |

## Remaining risks for the next review

1. **A resumed run's world state is modelled, not observed.** The suite tells the fake stack the volumes were
   already destroyed (`startDestroyed`). Against a real daemon a resume would observe that itself. The
   product does not read volume state at all — it acts on the journal — so this is a fidelity limit of the
   harness, not a behaviour gap, but it is the place a real-Docker acceptance would add the most.
2. **`repair-swap` state 4 reconstructs the journal entry from the plan's own target**, not from anything the
   crashed process wrote. If an operator changed the target between the crash and the resume, the digest
   re-proof refuses first — but the ordering of those two checks is worth a reviewer's eye.
3. **The lock is still not broken automatically**, so an unattended scheduler cannot self-heal after a kill.
   That is the deliberate house rule; whether a restore should carry a pid-stamped lock so a resume could
   prove ownership is a design question this tranche did not open.
4. **A failed proof is re-run on resume** rather than carried forward. That is the right default for a
   read-only diagnosis, but it means a proof that fails intermittently reports the last run's answer.
5. **Journal version 3 is not migrated from 2.** A journal written by the previous build is refused with
   "its version is not one this build writes". For an interrupted restore mid-upgrade that is a refusal an
   operator must resolve by hand; it fails closed, and it is stated rather than silently handled.
