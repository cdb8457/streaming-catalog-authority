# Phases 297-304 — builder's report

## Design: `ops:complete-restore` — the restore this product had described and never performed

Phase 256 said what a complete backup IS. Phase 277 made taking one a command. Phase 278 verified it in the
same run. Phases 279-280 restored one end to end **in a throwaway project**. The one part of this product's
lifecycle with no command was the part performed by somebody who had just lost something.

Full design: `docs/PHASES_297_304_COMPLETE_RESTORE.md`.

| Phase | What it adds |
| --- | --- |
| 297 | The restore model: three placement kinds, one per component, keyed by `BackupComponentId` |
| 298 | Classification of the set and of the installation, before anything is destroyed |
| 299 | The plan and its digest, re-proved under the lock |
| 300 | The safety set — Phase 277's own verified cycle, taken inside this run's lock |
| 301 | Execution: `down -v`, place, replay from a descriptor, boot |
| 302 | Four proofs, one of them a **decryption** |
| 303 | The journal, `--resume`, `--abandon` |
| 304 | The CLI, the rendered operator surfaces, the acceptance suite |

## Commits

| SHA | Subject |
| --- | --- |
| `8470e9b` | Phases 297-304: the restore, which this product had described and never performed |
| `fabbc76` | fix(297-304): a plan is not a name, three proofs are not one, and a thrown failure still has to say where the safety set is |
| `a9e04c1` | docs(297-304): the honest sequence is now two steps, and one of them is a command |

Branch `cdb8457/phases-297-304-product-maturity-loop`, from `b704935` (released v1.2.6). Worktree clean.
Nothing pushed, no PR, no release, no image, no live system touched.

## Key files

**New**
- `src/ops/restore-model.ts` — placements, ordered step ids, destructive/proof sets
- `src/ops/complete-restore.ts` — resolution, classification, plan+digest, safety set, execution, proofs, journal, abandon
- `src/ops/complete-restore-cli.ts` — `ops:complete-restore`
- `test/complete-restore.ts` — 42 checks
- `test/helpers/fake-restore-stack.ts` — a stack that MODELS a restore
- `docs/PHASES_297_304_COMPLETE_RESTORE.md`

**Changed**
- `src/ops/maintenance-safety.ts` — `FileInputRunner`, `runGuardedFromFile`
- `src/ops/maintenance-cli-shared.ts` — `realFileInputRunner` (stdin bound to a descriptor)
- `src/ops/complete-backup.ts` — `holdingLock` seam; `digestTreeAt` extracted from `describeComponent`
- `src/ops/backup-components.ts` — `COMPLETE_RESTORE_NOTE` / `COMPLETE_RESTORE_COMMANDS`
- `src/ops/operator-ui-service.ts` — "Put one back" in the Backup & restore panel
- `test/complete-backup.ts` — spawn-count invariant updated truthfully (2 -> 3), restore modules added to the no-shell scan
- `README.md`, `docs/LIFECYCLE_MIGRATION_BACKUP_UPGRADE_ROLLBACK.md`
- `package.json`, `test/suite-inventory.json`

## Tests and results

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | **PASS**, 0 errors |
| `test/complete-restore.ts` | **42 passed, 0 failed** |
| `test/complete-backup.ts` | 49 passed, 0 failed |
| `test/upgrade-rehearsal.ts` | 49 passed, 0 failed |
| `test/doctor-monitor.ts` | 19 passed, 0 failed |
| `npm run test:inventory` | **ok: true**, 321 suites, 6 helpers, no drift |
| `npm test -- --group db` | **32/32 PASS** |
| `npm test -- --group offline` | 287 selected, **284 pass, 3 fail — all 3 pre-existing at baseline** |
| `npm test -- --group docker` | **NOT_RUN** |

### The 3 offline failures are pre-existing, not mine

Verified by stashing all my work and re-running at `b704935`: byte-identical failures.

| Suite | Failing check |
| --- | --- |
| `custody-transition.ts` | "the custody secret helper never takes key material on a command line" — `deploy/local-runtime-setup.sh` passes no value for the root key |
| `kek-correction-gates.ts` | "the root key is delivered by a bind mount" — `local-runtime-setup.sh` performs no path-based mode/owner/stat operation |
| `custody-cutover.ts` | (2) "the steady-state stack has no static KEK anywhere"; "no compose run can fetch an image, and the mode marker is never written by a predictable temp" |

They belong to the custody/compose-wiring family, not this tranche. Left untouched deliberately: fixing them
would scatter the tranche across an unrelated feature family, which the scope forbids.

### NOT_RUN, with exact reasons

- **Docker acceptance group** — no daemon: `failed to connect to the docker API at
  npipe:////./pipe/dockerDesktopLinuxEngine ... The system cannot find the file specified.`
- **A real `ops:complete-restore --confirm` against a live stack** — requires a Docker daemon, real images and
  a real installation. Explicitly out of scope (no live-production mutation). The `--plan` leg IS exercised
  end to end through the real `main()` against a real verified set.
- **A real `pg_dump`/`psql` binary** — the embedded PostgreSQL package ships neither (pre-existing skip,
  already recorded in `test/backup-inspect.ts`).

## What the acceptance suite actually proves

It drives the **real** planner, the **real** filesystem work and the **real** `runVerifiedCompleteBackup`
against a stack that models a restore rather than nodding at one:

- `down -v` **destroys** the modelled volumes; a replay into a database that was never emptied fails with
  "relation already exists", the way a real plain dump over an existing schema does.
- A keystore has an **origin**: `compose cp` digests the directory it was actually given, and the decryption
  proof succeeds only when the (dump, keystore) pair is one declared **moment**.
- The headline adversarial case: a keystore from **another moment** starts, passes `ops:version`, passes the
  doctor, and **fails the decryption proof** — the exact failure that makes a restored installation report
  itself healthy while reading nothing.
- The lock check observes the lock directory **at the instant** the safety set's `pg_dump` runs, so
  `holdingLock` is proved to be one lock rather than a bypass.
- The ledger scan is over the commands **actually issued**, not the planned ones.

## Hostile self-review — 3 defects found in my own tranche, all fixed with regression tests (`fabbc76`)

1. **A run that failed AT the safety set was not resumable.** `--resume` inferred "was a safety set planned"
   from `safetySetName`, which is null until one has been *taken*. A run failing at that step re-planned
   without it, produced a different digest, and refused itself — over a run that had destroyed nothing.
   Fixed: `safetySetPlanned` is journaled as a decision.
2. **The first failed proof silenced the other three.** An operator whose version check failed was never told
   whether their installation could **decrypt** — the one thing they most need. Fixed: every proof runs; the
   first failure still decides the state; a non-proof failure still stops the run.
3. **A thrown failure lost the report.** `CompleteRestoreFailed` fires when the installation is left stopped —
   exactly when the safety set's name and the kept `.replaced-` directories matter — and a throw returns no
   report. This is Phase 277's own dual-failure defect one level up. Fixed: the report travels on the failure.

Also checked and found sound: path escape via `--secrets .` or `a/..` (closed by `resolveInsideRoot`, which
refuses `..` segments and the root itself); swap ordering under a kill at each of four points; swap
idempotence by digest on resume; journal write atomicity (staged + renamed); no-follow descriptor discipline
on the new stdin runner including the Windows `O_NOFOLLOW` fallback via `fstat`; redaction of every report
surface; the `finally` that releases the lock; and the plan-digest re-proof under the lock.

## Remaining review risks

1. **The image pin cannot be checked before the teardown.** Reading the pinned image's schema means running
   it, and running it against the old database is the forward migration a restore exists to avoid. So a
   project pinned to the wrong image is caught by the `prove-version` proof **after** the restore, reported as
   `RESTORED_BUT_UNPROVEN`, and recovered from via the safety set. This is why the safety set is mandatory.
   Stated in the design doc under "What it does not do".
2. **Inline custody on a bind-mounted keystore.** `down -v` empties a *volume*; a launcher stack that
   bind-mounts the keystore instead would not be emptied by it, and the `compose cp` would then merge rather
   than place. The sidecar topology covers the shipped launcher stack. Worth a reviewer's eye on whether any
   shipped inline stack bind-mounts `/var/lib/catalog/keystore`.
3. **`complete-restore.ts` imports `readSchemaVersions` from `upgrade-rehearsal.ts`**, pulling a large module
   in for one parser. No cycle, no behavioural risk, but it is the wrong home for that function.
4. **`FORBIDDEN_ARGUMENT_TOKENS` vs operator paths.** A project path containing e.g. `Movies` would make
   `compose cp` refuse. Pre-existing and identical for `ops:complete-backup`; not introduced here.
5. **The safety set requires the secrets directory to exist.** A target that is OCCUPIED only because its
   promotion-records directory is populated, with no secrets directory, refuses at the safety set. Fails
   closed with a clear message and nothing destroyed, but it is a shape nobody has walked through.
6. **The whole tranche is proved against a modelled toolchain**, not a live Docker daemon. That is the same
   standard Phases 277-280 hold themselves to, and it is the ceiling of what this environment allows.
