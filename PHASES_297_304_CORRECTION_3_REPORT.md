# Phases 297–304 — correction 3

Functional commit `6b16c9a`, from `752c8c6`. Worktree clean. **Nothing pushed, no PR opened**, no live system
touched.

## Every defect was executed against `2dbe3b3` before it was fixed

Written as a throwaway harness driving the shipped code, run, and the output recorded verbatim:

```
DEFECT CONFIRMED  a returned nonzero replay is re-run without rewinding the database leg
                  journal recorded replay-database=failed; the resume performed 0 teardown(s);
                  ["stop-and-destroy=skipped","replay-database=failed"]
DEFECT CONFIRMED  a swap whose rename #2 fails cannot be resumed
                  journal place-secrets=failed; staged source moved out: true;
                  resume threw: the staged secrets directory is not there, so this step has nothing
                  verified to place. Re-run the staging step.
DEFECT CONFIRMED  a swap whose rename #3 fails cannot be resumed   (same shape)
DEFECT CONFIRMED  a landed swap onto an ABSENT target leaves target present, no .restoring-, no .replaced-
                  the recovery reads this as "nothing moved" and re-runs the step, whose staged source is gone
```

A fifth surfaced while writing the third regression and is fixed here too: **a resume could never match its
own plan digest** once the operation had placed anything into a target it had classified `UNKNOWN`.
`targetState` is bound into the digest, and the resume re-derived it from the installation *as it is now* —
after this operation's own placements had made it `OCCUPIED`.

## Item 1 — a failed non-idempotent effect is not retried as though nothing happened

Recovery is now dispatched on whether a step's effect is **ambiguous**, not on which of two words the journal
holds. A `failed` step whose declared policy is not a plain `retry` is recovered exactly as a `running` one:

| Step | Policy | What a returned failure now does |
| --- | --- | --- |
| `replay-database` | `rewind` | destroys the volumes and runs the whole database leg again before replaying |
| `place-secrets` / `place-promotion-records` / `place-sidecar-keystore` | `repair-swap` | finishes the interrupted renames against the re-verified in-flight component |
| `safety-set` | `confirm-or-retry` | looks for a published set and verifies it rather than retaking into a name that would refuse |
| everything else | `retry` | repeats, which is idempotent by declaration |

The state machine proves it: `STEP_RECOVERY` is a total map over `RestoreStepId`, and a test asserts the
non-`retry` set is exactly those five.

**The resumed replay test proves teardown and database-up happen again before the next replay** — asserting
`teardowns() === 1` on the resume's world, `stop-and-destroy` and `database-up` both `held` rather than
skipped, and exactly one replay landing in that fresh database.

## Item 2 — landed-but-unrecorded, for both target shapes, verified before accepting

"Landed" is decided by **what is at the target**, compared against the component the backup manifest declares
— not by whether a `.replaced-` directory happens to exist:

- **originally present** → target holds the component, `.replaced-` exists → complete, recorded `replaced: <name>`
- **originally absent** → target holds the component, no `.replaced-` → complete, recorded `replaced: null`, so
  an abandon restores the absence
- **target holds something else** → refused, not accepted as landed
- **nothing landed and no staged source** → refused rather than retried into empty staging

## Carried in from the correction-2 spec tail (which reached me only during this task)

- The design doc claimed the staging tree is removed **"by digest-checked ownership"**. It never was:
  `removeOwnTreeNoFollow` refuses links and special files and checks no digest at all. Ownership is
  established by the **marker**; integrity is a separate comparison against the **backup manifest**. The
  claim is removed and both mechanisms are named.
- README and the design doc now say **process death** in as many words, and state why power-loss durability
  is not claimed: files are `fsync`ed and published by rename, but the containing **directory** is not
  `fsync`ed after those renames, so a power cut can leave a rename that never reached the disk on a
  filesystem that does not order metadata that way. Claiming otherwise would require parent-directory fsync
  and a named set of supported filesystems; neither exists here, and no test has cut power to a machine.

## Test results

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | **PASS**, 0 errors |
| `npm run test:complete-restore` | **95 passed, 0 failed** (was 89) |
| `npm run test:complete-backup` | 49 passed, 0 failed |
| `npm run test:custody-proof` | 9 passed, 0 failed |
| `test/test-runner.ts` | 60 passed, 0 failed |
| `npm run test:inventory` | **ok: true**, 322 suites, 6 helpers |
| `npm test -- --group db` | **33/33 PASS** |
| `npm test -- --group offline` | 287 selected, **284 pass, 3 fail** |

### Baseline-only failures

`kek-correction-gates.ts`, `custody-cutover.ts` (2 checks), `custody-transition.ts` — all in the
custody/compose-wiring family, all failing identically on `b704935` before this tranche began, verified in an
earlier dispatch by stashing the whole branch. Untouched deliberately: fixing them would broaden into
unrelated phases.

### Not run, and why

- **Docker acceptance group** — no daemon: `failed to connect to the docker API at
  npipe:////./pipe/dockerDesktopLinuxEngine … The system cannot find the file specified.`
- **A live `ops:complete-restore --confirm`** — needs a real daemon, real images and a real installation.
- **A live in-container `ops:custody-proof`** — same; its logic is fully covered against a real embedded
  PostgreSQL with real key material, only the `compose exec` transport is unexercised.
- **Real `pg_dump` / `psql` binaries** — the embedded PostgreSQL package ships neither (pre-existing skip,
  already recorded in `test/backup-inspect.ts`).

## Remaining risks

1. **Parent-directory fsync is still absent**, so the durability claim stays narrowed to process death. Adding
   it — and naming the filesystems on which the resulting ordering holds — is the work that would let the
   stronger claim be made.
2. **`repair-swap` accepts a target that matches the manifest** as proof the placement landed. A target that
   coincidentally holds identical bytes would be accepted; for a secrets or keystore component that is the
   same content, so the outcome is the same, but it is an assumption worth naming.
3. **A resumed run's world state is still modelled** in the suite (`startDestroyed`), not observed from a real
   daemon.
4. **Journal version 3 is still not migrated from 2** (carried, fails closed).
5. **`--no-safety-set` changed the plan digest** in correction 2; any runbook holding an older digest will
   mismatch. Fails closed.
