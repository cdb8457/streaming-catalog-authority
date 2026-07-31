# Phases 305-312 — builder's report

## Design: `ops:backup-retention` — the half of the backup lifecycle that only ever printed a plan

Phase 256 said what a complete backup IS. Phase 277 made taking one a command. Phase 278 verified it in the
same run and gave it a schedule. Phases 279-280 rehearsed the restore in a throwaway project. Phases 297-304
performed it against the real installation — and made **every restore take a safety set first**.

So this product now creates backup sets nightly and creates another one every time somebody restores. It had
never removed one, and both halves of the repository said so in words:

> **Retention removes nothing, ever.** There is deliberately no flag that does.
> — `docs/PHASES_277_280_MAINTENANCE_AUTOMATION.md`, *Limitations*

> The digest below is over the ENUMERATED SET LIST. It exists so that **a future destructive step, if one is
> ever added**, can require the exact list the operator was shown.
> — `deploy/unraid-catalog-maintenance.sh`, `retention-plan`

That is a design note for a command nobody wrote. What an operator actually had was a shell loop over `ls`
sorting names **lexically**, a `sha256sum` of that listing, and the instruction to go and recursively delete a
directory by hand — which cannot tell a set that verifies from one truncated last Tuesday, cannot tell the
**only** set this build could restore from one of ten, cannot tell the pre-upgrade rollback point from a
routine nightly, takes no lock, and leaves **half a set under a name an operator trusts** if it is
interrupted. It is the most dangerous instruction this product gives.

Full design: `docs/PHASES_305_312_BACKUP_RETENTION.md`.

| Phase | What it adds |
| --- | --- |
| 305 | The inventory — every entry in a destination classified from evidence, opening no secret |
| 306 | The policy — `keep-last`, `min-age-days`, `include-unverified`, `keep-minimum-restorable`, evaluated purely |
| 307 | The protection boundary — what no policy may remove, and when the whole run refuses |
| 308 | The plan, and a digest over the **whole inventory it was computed from** |
| 309 | Execution — two lock domains, a re-proof under them, and **quarantine before delete**, oldest first |
| 310 | The journal, `--resume`, `--abandon`, and the retained-artifact report |
| 311 | The CLI, the operator surfaces, and a scheduled job that still removes nothing |
| 312 | The acceptance suite, the docs, and the suite inventory |

## Why this slice and not another

Chosen from repository evidence, not preference. After 297-304 the backup family had take → verify → rehearse
→ restore and no remove; the gap was **named in two shipped files** as future work, with the exact mechanism
(a digest over the list the operator was shown) already specified and unbuilt. It is the only remaining
lifecycle verb, it is destructive — which is the shape the tranche's own discipline is written for — and it
is the one where the current operator instruction is the dangerous one. Jellyfin and TorBox work is blocked on
live systems this run must not touch; catalog import/browse was closed by 259-265.

## Commits

| SHA | Subject |
| --- | --- |
| `463245c` | Phases 305-312: retention, the half of the backup lifecycle that only ever printed a plan |
| `9adf1fe` | fix(305-312): the scheduled example's own suite still described the shell loop it no longer runs |
| `caffb06` | feat(305-312): the two commands that destroy irrecoverable state are required suites in CI |
| `77696b6` | fix(305-312): a confirmation refused because the CLOCK moved said a set had changed |

Branch `cdb8457/phases-305-312-product-maturity-loop`, from `242b87a` (the merge of PR #40 / Phases 297-304).
Worktree clean. Nothing pushed, no PR, no release, no image, no tag, no live system touched, no history
rewritten.

## Key files

**New**
- `src/ops/retention-model.ts` — the six classes, the policy, the closed reason vocabulary, the pure evaluator
- `src/ops/backup-retention.ts` — inventory, plan, digest, two locks, quarantine/delete, journal, abandon
- `src/ops/backup-retention-cli.ts` — `ops:backup-retention`
- `test/backup-retention.ts` — 78 checks
- `test/helpers/retention-crash-child.mts` — a real prune, killed at a named boundary
- `docs/PHASES_305_312_BACKUP_RETENTION.md`

**Changed**
- `src/ops/backup-components.ts` — `BACKUP_RETENTION_NOTE` / `BACKUP_RETENTION_COMMANDS`
- `src/ops/operator-ui-service.ts` — "Remove old ones" in the Backup & restore panel
- `src/ops/release-readiness.ts`, `.github/workflows/runtime-image.yml` — both destructive commands' suites
  are required
- `deploy/unraid-catalog-maintenance.sh` — `retention-plan` runs the shipped command; still removes nothing
- `test/doctor-monitor.ts` — held the script to two strings the change removed
- `README.md`, `docs/LIFECYCLE_MIGRATION_BACKUP_UPGRADE_ROLLBACK.md`,
  `docs/PHASES_277_280_MAINTENANCE_AUTOMATION.md` (its "removes nothing, ever" limitation is now false)
- `package.json`, `test/suite-inventory.json`

## What the acceptance suite actually proves

It drives the **real** inventory, the **real** `verifyBackupSet`, the **real** filesystem work and real child
processes, against sets taken by the shipped `runVerifiedCompleteBackup`:

- **The headline protection.** A destination whose newest verified set is a **rollback point** and whose only
  restorable set is 100 days old and outside `--keep-last 1`: both are protected, and nothing is removed.
  "Keep the newest one that works" would have deleted the one that can bring the installation back.
- **Nothing is half-deleted.** A run killed between the rename and the journal write is read off disk: the set
  name in the destination is **absent** and the set is in quarantine **byte for byte whole**.
- **The digest binds the list.** A set taken between plan and confirm, a set whose bytes changed, a different
  policy, a different project, and ten days of clock across `--min-age-days` each refuse the confirmation with
  the destination proved byte-identical afterwards.
- **A forged journal.** Both the removal list and the decisions edited *and the digest recomputed over them* —
  the one edit a digest cannot catch — is refused by the second, independent check.
- **A reparse point** swapped in for a quarantined set is refused rather than deleted through, and the
  directory it pointed at is untouched. Exercised on Windows via a junction rather than skipped.
- **The command ledger is empty**: a source scan proves no `spawnSync`, `exec`, `child_process`, `fetch` or
  `CommandRunner` anywhere in the three modules.

## Hostile self-review — 5 defects found in my own tranche, all fixed with regression tests

1. **A failure after sets had moved left through the pre-effect refusal path.** The CLI exits `3` for those —
   the code it documents as "refused before anything was moved". Anything reading it would be told nothing
   happened by a run that had already deleted backups. This is Phases 297-304's `CompleteRestoreFailed`
   correction one level up. Fixed: `RetentionFailed`, carrying the report, exit `1`.
2. **That failure carried a runtime error's own words**, which routinely carry the absolute path they failed
   on, into a report an operator pastes into an issue. Fixed: `safeReason` keeps only this product's own
   sentences plus an errno code.
3. **`kept` counted directory entries**, so an operator's own folders inflated the number they check to see
   how many backups they still have. Fixed: it counts backup sets.
4. **`bytesRemoved` was about the process, not the operation** — a resumed prune under-reported what it freed.
5. **The destination lock would have made every confirmation impossible.** `--plan` takes no lock, `--confirm`
   takes one and re-inventories under it; counting this command's own lock directory as destination content
   changes the inventory every time. Fixed: it is excluded, and a test asserts the plan and the re-plan agree.

Also checked and found sound: the both-places state (in destination *and* in quarantine) refused rather than
guessed; the quarantine directory refusing to accept anything this operation did not put there; the removal
bound taken from the set's own manifest; ordering by the manifest's instant rather than `mtime`; `--abandon`
distinguishing "deleted without being recorded" (gone forever, named) from "never renamed" (unresolved); a
journal moved into another project; every journal field validated because every field is acted on; and both
locks released through a `finally` on every path.

## Tests and results

| Gate | Result |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | **PASS**, 0 errors |
| `test/backup-retention.ts` | **78 passed, 0 failed** |
| `test/doctor-monitor.ts` | 19 passed, 0 failed |
| `test/backup-components.ts` | 41 passed, 0 failed |
| `test/complete-backup.ts` | 49 passed, 0 failed |
| `test/complete-restore.ts` | 136 passed, 0 failed |
| `test/backup-inspect.ts` | 60 passed, 0 failed, 1 skipped (no `pg_dump` binary — pre-existing) |
| `test/backup-verify.ts` | 17 passed, 0 failed |
| `test/release-readiness.ts` | 44 passed, 0 failed |
| `test/deploy.ts` | 210 passed, 0 failed |
| `npm run test:inventory` | **ok: true**, 323 suites, 6 helpers, no drift |
| `npm test -- --group db` | **33/33 PASS** |
| `npm test -- --group offline` | 288 selected, **285 pass, 3 fail — all 3 pre-existing at baseline** |
| `npm test -- --group docker --require-capabilities` | **NOT_RUN** |
| Live operator UI, `GET /` on 127.0.0.1 | **HTTP 200**, "Remove old ones" rendered, both command forms present, no `--confirm` on the page |

### Baseline comparison — the 3 offline failures are inherited, not mine

Verified by checking out `242b87a` in this worktree and running the same group at the same concurrency:
**287 selected, 284 passed, 3 failed**, the same three suites and the same checks.

| Suite | Failing check |
| --- | --- |
| `custody-transition.ts` | "the custody secret helper never takes key material on a command line" — `deploy/local-runtime-setup.sh` passes no value for the root key |
| `kek-correction-gates.ts` | "the root key is delivered by a bind mount" — `local-runtime-setup.sh` performs no path-based mode/owner/stat operation |
| `custody-cutover.ts` | (2) "the steady-state stack has no static KEK anywhere"; "no compose run can fetch an image, and the mode marker is never written by a predictable temp" |

They belong to the custody/compose-wiring family. Left untouched deliberately: fixing them would scatter this
tranche across an unrelated feature family.

**One intermittent, reported rather than hidden.** The first branch run of the offline group also failed
`o4-o5-evidence-packet-review.ts`. It passed 3/3 individually and passed in the two subsequent full-group
runs, and it did not fail at baseline. That suite spawns real child processes; the failure is consistent with
contention at `--concurrency 4` rather than with this tranche, which touches nothing it reads. Recorded as an
observed flake, not as a clean result.

### NOT_RUN, with exact reasons

- **Docker acceptance group** — no daemon. `docker info`: `failed to connect to the docker API at
  npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open
  //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.` Both suites in the group
  (`release-candidate-acceptance.ts`, `release-lifecycle-acceptance.ts`) reported
  `this host does not provide: docker [REQUIRED]`.
- **A browser gate** — the repository defines no browser suite group (`db`, `docker`, `offline` only). The
  operator surface was instead checked live: the shipped `ops:operator-ui-server` was started on
  `127.0.0.1:5492` with a local token file and `GET /` returned HTTP 200 carrying the rendered panel. Local
  only; nothing external was contacted.
- **A real `--confirm` against a destination holding an operator's actual backups** — out of scope by
  construction; no live system was touched. The whole command, including `--confirm`, `--resume` and
  `--abandon`, is exercised end to end against real sets in temporary project roots.
- **A real `pg_dump` binary** — the embedded PostgreSQL package ships none (pre-existing skip in
  `test/backup-inspect.ts`).

## Remaining review risks

1. **Safety sets are invisible to retention.** A restore publishes its safety set *inside* a dot-prefixed
   claim directory (`.pre-restore-claim-<nonce>/pre-restore-<set>`), which classifies `RESERVED` and is never
   touched. Those accumulate one per restore and this command will not remove them. Reported honestly as a
   non-goal rather than solved by descending into a namespace another command owns; the top-level nightly sets
   are the pile that actually grows.
2. **A destination that has been deleted wedges an interrupted prune.** `readRetentionJournal` re-resolves the
   destination and refuses if it is gone, so a project whose backups directory was removed after a crash can
   neither `--resume` nor `--abandon` and the operator must delete the journal by hand. Fail-closed and the
   refusal names the action, but nobody has walked that shape.
3. **`takenAt` is not covered by the verification digest.** Ordering trusts the manifest's date, and an
   operator who can edit it can already delete the set — so it is not an escalation — but it is stated in the
   threat model rather than closed, and the plan prints every date beside its decision for that reason.
4. **The destination lock covers less than it looks like it covers.** It stops two retention runs on one
   destination; it does not stop another *project's* `ops:complete-backup`, which holds only its own project
   lock. Documented; a shared destination remains a limitation.
5. **`--plan` reads every byte of every set, twice** (once for the plan, once under the lock). On a
   destination of many large sets that is real time. It is why this is a human operation rather than a cron
   job, and it is stated — but nobody has run it against a hundred gigabytes.
6. **This tranche added `test:phase297-local` to the required-suite list**, which is a change on behalf of the
   previous tranche. It is the same list, family and argument, and the workflow step that runs it was added in
   the same commit — but a reviewer should confirm they are happy with the CI obligation.
7. **The whole tranche is proved against a real filesystem and no Docker daemon**, which is correct here
   because this command issues no command at all — but the operator UI check above is the only thing in it
   that ran as a live process.
