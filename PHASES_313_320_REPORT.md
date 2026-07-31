# Phases 313-320 — builder's report

## Design: `ops:safety-set-lifecycle` — the pile the previous tranche could see and could not touch

Phases 297-304 made every `ops:complete-restore` take a **verified backup of the installation it is about to
destroy**, and publish it inside a directory that run claims exclusively —
`<destination>/.pre-restore-claim-<nonce>/pre-restore-<set>`. Phases 305-312 shipped `ops:backup-retention`,
whose inventory classifies **every dot-prefixed name** as `RESERVED` and never descends into one.

Both are right, and together they mean safety sets accumulate **one per restore, forever**. The 305-312
report named it as the first remaining review risk:

> **Safety sets are invisible to retention.** … Those accumulate one per restore and this command will not
> remove them. Reported honestly as a non-goal rather than solved by descending into a namespace another
> command owns.

This tranche closes it **the way that report said it should be closed**: not by teaching retention to descend
— that one rule is what keeps it away from a backup staging tree, a restore in progress, a lock directory and
its own quarantine, and it covers every namespace a later phase adds without any of them being enumerated —
but with a separate command that has a separate ownership proof.

Full design: `docs/PHASES_313_320_SAFETY_SET_LIFECYCLE.md`.

| Phase | What it adds |
| --- | --- |
| 313 | The claim inventory — nine classes from evidence, never from a name; and `maintenance-identity.ts`, the read-only ownership primitives both destroying commands now share |
| 314 | The policy — `keep-last 3`, `min-age-days 14`, `include-unverified`, `include-empty-claims`, `keep-minimum-restorable`, evaluated purely |
| 315 | The protection boundary and the plan, with a digest over the claims **and** the ordinary sets beside them |
| 316 | The journal, the quarantine marker and the per-claim commitments |
| 317 | Execution — the same two lock domains in the same order, quarantine before delete, and a **live floor re-proof before the first irreversible act** |
| 318 | `--abandon`, the retained-artifact report and three honest end states |
| 319 | The CLI, the operator surfaces, and a scheduled example that prints a plan and removes nothing |
| 320 | The acceptance suite, the required CI gate, the docs and the suite inventory |

## Why this slice and not another

It is the tranche the previous tranche's own report asked for, by name, as its **first** remaining risk. It is
the last unclosed hole in the backup lifecycle (take → verify → rehearse → restore → prune → **and now the
restore's own residue**), it is destructive — the shape this repository's discipline is written for — and the
material it removes is the single snapshot of a moment nobody can reproduce: the state of an installation
immediately before somebody destroyed it on purpose. Jellyfin and TorBox work remains blocked on live systems
this run must not touch.

## Key files

**New**
- `src/ops/maintenance-identity.ts` — the shared, effect-free ownership primitives: the claim marker id and
  file name (one definition), `readRestoreClaimMarker`, `proveBackupSetIdentity`, `manifestShape`
- `src/ops/safety-set-model.ts` — nine classes, fourteen evidence values, the policy, the closed reason
  vocabulary, the pure evaluator
- `src/ops/safety-set-lifecycle.ts` — inventory, plan, digest, journal, quarantine, execute, floor re-proof,
  abandon, render
- `src/ops/safety-set-lifecycle-cli.ts` — `ops:safety-set-lifecycle`
- `test/safety-set-lifecycle.ts` — 81 checks at first cut, **98 after Correction 1**
- `test/helpers/safety-set-crash-child.mts` — a real run, killed at a named boundary (nine of them
  after Correction 1 added `after-consuming-marker`)
- `docs/PHASES_313_320_SAFETY_SET_LIFECYCLE.md`

**Changed**
- `src/ops/complete-restore.ts` — imports the marker id and file name from the shared module instead of
  holding literals; **no behaviour change**, and its 136 checks still pass unmodified
- `src/ops/backup-retention.ts` — `proveSetIsPlanned` delegates to `proveBackupSetIdentity` (moved verbatim,
  refusal wording included); `shapeOfManifest` is the shared `manifestShape`; `validateInventoryEntry`
  exported so one validator covers both journals. **No behaviour change**; its 114 checks still pass
- `src/ops/backup-components.ts` — `SAFETY_SET_LIFECYCLE_NOTE` / `SAFETY_SET_LIFECYCLE_COMMANDS`
- `src/ops/operator-ui-service.ts` — "Remove the ones a restore left behind" in the Backup & restore panel
- `src/ops/release-readiness.ts`, `.github/workflows/runtime-image.yml` — all **three** destructive commands'
  suites are required
- `deploy/unraid-catalog-maintenance.sh` — a `safety-set-plan` mode that prints a plan and removes nothing
- `README.md`, `docs/LIFECYCLE_MIGRATION_BACKUP_UPGRADE_ROLLBACK.md`,
  `docs/PHASES_305_312_BACKUP_RETENTION.md` (its non-goal now names the command that took the job)
- `package.json`, `test/suite-inventory.json`

## Threat model

**Who this defends against.** An operator's own mistake, a half-finished run, a crash, a concurrent command,
a directory that is not what its name says, and a **document** edited to point the operation somewhere it
should not go.

**Who it explicitly does not.** A user who can rewrite all local state. Every proof here — the claim marker,
the journal, the quarantine marker — is an unauthenticated file in a directory that user owns. Nothing here is
a cryptographic authority against them and nothing claims to be. What the proofs give is that **no ordinary or
foreign directory is removed** (removal needs a marker of this build's shape *and* a set whose bytes still
hash to the recorded identity — and a forger who can produce both can already delete the directory
themselves), that an **accident cannot reach past ownership**, and that a **document alone authorises
nothing**, because the authority is the evaluator re-run plus an on-disk identity proof rather than a re-hash.

## Non-goals

* It does **not** make `ops:backup-retention` descend into a claim. A test asserts that rule still holds
  against the same fixtures.
* It does **not** schedule anything. No `--force`, no `--yes`, no timer that confirms or deletes.
* It does **not** touch an ordinary backup set, a database, a keystore or a running container.
* It does **not** repair a claim. A moved one, one from another build, one holding something unexpected is
  reported and left alone.
* It does **not** issue a command of any kind — no docker, child process, network, provider, download,
  playback or live system contact. Asserted by a source scan over all four modules.

## What the acceptance suite actually proves

It drives the **real** inventory, the **real** `verifyBackupSet`, the shipped `writeClaimMarker`, the shipped
`runVerifiedCompleteBackup`, real filesystem work and real child processes.

- **The headline protection.** A destination whose ordinary top-level sets are all from *before* this build's
  schema and whose only restorable set is a **safety set inside a claim**: it is protected, and it is the
  whole floor. `--keep-last 1` does not reach it.
- **The name decides nothing, in either direction.** A claim-shaped directory with no marker is `MALFORMED`
  and is still *inventoried*; a valid claim renamed to `backups-old` is still **found** (it carries a marker)
  and refused for `MARKER_NAME_DISAGREES`.
- **Ten ways a marker can fail** each map to their own closed evidence value, and none is removable —
  including a marker at another journal schema (`OTHER_BUILD`), and one whose suffix does not derive from its
  own plan digest.
- **Nothing is half-deleted.** A run killed between the rename and the journal write is read off disk: the
  claim name in the destination is **absent** and the claim is in quarantine **byte for byte whole**.
- **A self-consistent forgery with a recomputed digest, pointing at a stranger's directory**, passes every
  document-level check *including the evaluator re-run* — and dies on disk, with the stranger's file
  byte-identical and **nothing after it touched**.
- **All twenty (state × in-destination × in-quarantine) combinations** are enumerated against the exported
  table *and driven through the shipped executor* in twenty real projects, each with a **witness** claim
  proving that a stop really stopped and a completing run really continued.
- **A partial delete** — a real component unlinked, then a throw — leaves the journal saying `deleting`, and a
  second resume finishes it and cleans up.
- **The live floor re-proof**: a resume whose destination lost its restorable sets in between halts **before
  its first deletion**, destroys nothing, and `--abandon` puts everything back byte for byte.
- **The shared primitives cannot drift**: a marker written by the shipped writer is accepted by both readers,
  mutating any of its six fields makes both refuse, and `complete-restore.ts` is asserted to hold **no literal
  copy** of the marker id or file name.
- **`--json` is exactly one document** on stdout for plan / success / abandon and on **stderr** for a
  post-effect failure, with stdout carrying nothing at all.
- **The command ledger is empty**: a source scan proves no `spawnSync`, `exec`, `child_process`, `fetch` or
  `CommandRunner` anywhere in the four modules.

## Hostile self-review — 1 real defect found in my own tranche, fixed with regression tests

**A claim with no recorded identity could be planned for a removal that could never be performed.** A claim
whose safety set cannot be examined at all — an unreadable manifest, a verification that throws — carries no
`setDigest`, and `proveBackupSetIdentity` refuses to act on a commitment with nothing in it. With
`--include-unverified`, the evaluator would name that claim in the plan, an operator could confirm it, and
the run would then **stop on it at the first proof** — leaving every later candidate untouched and the
operation unable to finish without an `--abandon`. A candidate a run can never perform is not a candidate; it
is a plan that lies.

Fixed with a new **unconditional** protection, `PROTECTED_NO_IDENTITY`, evaluated before `--include-unverified`
is consulted. Two regression tests: the pure evaluator under all three flag combinations, and an end-to-end run
with `--include-unverified` that removes the claim it *can* and leaves the unreadable one byte-identical.

**A second, smaller one the suite caught while being written.** `classifyClaim` set `restorable` from
`restorableUnderThisBuild`, which is about the **schema version alone** — so a claim holding a truncated set
counted toward the floor and could be chosen as the protected newest. It is now `report.ok &&
report.restorableUnderThisBuild`, which is also the invariant the journal validator enforces on a persisted
row; the two would otherwise have disagreed.

Also checked and found sound: the both-places state refused rather than guessed; the quarantine refusing
anything this operation did not put there; `deleting` surviving a failure so a partial tree can still be
finished; `--abandon` distinguishing "deleted without being recorded" from "never renamed"; the removal bound
taken from the claim's own manifest; ordering by the manifest's instant with mtime used *only* for empty
claims and stated as weaker; both locks released through a `finally` on every path; and `--abandon`
deliberately **not** taking the mid-prune refusal, so the pair can never wedge each other.

## Cross-command coordination, exactly

* **The same two lock domains, in the same order**: the project lock (`acquireMaintenanceLock`), then
  `ops:backup-retention`'s destination lock `.catalog-retention.lock`. Sharing the second is what makes "two
  commands cannot be half way through one destination at once" true rather than hoped for. **No new lock
  order, no new deadlock.**
* **A project part way through a restore refuses this command entirely** — which is how "anything referenced
  by a live restore journal is protected" is implemented, and it is strictly stronger than classifying one
  entry. A claim being written into *right now* also classifies `OWNED_IN_FLIGHT` on its own evidence.
* **A project part way through a prune refuses it too**, because this command's floor is counted over sets a
  prune has temporarily renamed aside.
* **The refusal is one-way on purpose.** Retention is *not* taught to refuse when this journal is present:
  two commands that each refuse while the other is interrupted is a pair neither can ever be resumed.
* **The shared-destination boundary, stated exactly.** The destination lock does **not** cover another
  *project's* `ops:complete-backup` or `ops:complete-restore`, which hold only their own project locks. Three
  things narrow it — an in-flight claim is protected, `--min-age-days 14` protects anything a running restore
  just created, and the marker proves *a* restore of this build made the claim. **A destination shared between
  projects is not a configuration this command can make safe on its own**, and the document says so.

## Tests and results

| Gate | Result |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | **PASS**, 0 errors |
| `npm run test:safety-set-lifecycle` (new) | **81 passed, 0 failed** — see *Correction 1* for the current count |
| `npm run test:complete-restore` | 136 passed, 0 failed |
| `npm run test:backup-retention` | 114 passed, 0 failed |
| `npm run test:complete-backup` | 49 passed, 0 failed |
| `npm run test:backup-components` | 41 passed, 0 failed |
| `npm run test:release-readiness` | 44 passed, 0 failed |
| `npm run test:deploy` | 210 passed, 0 failed |
| `npm run test:operator-ui-service` | 5 passed, 0 failed |
| `npm run test:operator-ui-render-allowlist` | 7 passed, 0 failed |
| `npm run test:operator-ui-static-layout` | 7 passed, 0 failed |
| `npm run test:operator-ui-csp-assets` | 20 passed, 0 failed |
| `npm run test:operator-ui-runtime-boundary` | 10 passed, 0 failed |
| `npm run test:operator-ui-packet-contract` | 8 passed, 0 failed |
| `npm run test:doctor-monitor` | 19 passed, 0 failed |
| `npm run test:backup-verify` | 17 passed, 0 failed |
| `npm run test:backup-inspect` | 60 passed, 0 failed, 1 skipped (no `pg_dump` binary — pre-existing) |
| `npm run test:inventory` | **ok: true**, 324 suites, 6 helpers, no drift |
| Shipped CLI, live | `--help` exits 0; a refusal exits **3**; a usage error exits **2** |

### NOT_RUN, deliberately, with exact reasons

- **The broad `offline`, `db` and `docker` aggregates** — left for Codex after review, as instructed. The
  `offline` group carries three inherited failures at this baseline (`custody-transition.ts`,
  `kek-correction-gates.ts`, `custody-cutover.ts`), documented in the 305-312 report and untouched here.
- **A live operator UI process** — the panel change is a static server-side render and is covered by the six
  operator-UI suites above. No server was started this run.
- **A real `--confirm` against an operator's actual backups** — out of scope by construction; no live system
  was touched. The whole command, including `--confirm`, `--resume` and `--abandon`, is exercised end to end
  against real claims and real sets in temporary project roots.

## Correction 1 — six defects found by independent review, all reachable, all fixed

Every finding was correct. Three of them were exploitable, and the first is the one that mattered: a
directory that was not ours could be recursively deleted. What follows is what each one was and what
replaced it.

### 1. CRITICAL — `deleting` authorised removing a NAME, not a TREE

Once an entry was persisted as `deleting`, a resume proved the **outer** quarantine marker — which says the
quarantine directory is this operation's and carries the list of names this operation put in it — and then
recursively removed whatever directory now occupied the planned child name. It did not re-prove the child,
deliberately, because a partially consumed tree cannot satisfy its commitment. **A list of names is not a
tree.** Anything moved to that name after the record was persisted — a stranger's directory, an operator's
folder, a fresh claim — was recursively deleted. The predictable name and the outer allowlist were being used
as live child ownership, and neither is.

The authority now lives **inside the child**, is bound to an unpredictable `consumeNonce` drawn per
consumption and persisted in the journal entry, and — the part that makes it work at all — **it is the last
thing removed**. One invariant answers every question a recovery asks:

> **The first `unlink` inside a claim is always preceded by a valid consumption marker inside it.**

So the marker's absence is not ambiguity. Absent and non-empty means nothing has been unlinked, and the tree
must still prove to be the planned claim exactly as an intact one does — which a replacement fails. Present
and ours means finishing is authorised whatever state the tree is in. Present and not ours is refused.
The ordering is prove → **persist the nonce** → write the marker → remove; a marker written before the
journal recorded the nonce would be an authority nothing could check.

**Journal schema 2**, and version 1 is refused at the boundary: a version-1 `deleting` entry describes a
consumption whose live child can never be identified, and there is nothing correct to fill the field in with.

**A window I found while reviewing my own fix**, and closed in the same change: the consumption marker is
unlinked immediately before the directory itself, so a removal that got everything out and then could not
`rmdir` left an **empty** directory with no authority in it. Requiring the marker there would have stranded
the operation — nothing can prove an empty directory is the planned claim, and an abandon will not put an
empty tree back either. An empty directory holds nothing that can be lost and sits inside a quarantine
already proved to be ours, so it is removed; one stray byte in it and the tree has to prove itself again.

### 2. Inventory admission traversed links to decide admission

`inventoryClaims` asked "does this entry carry a marker" by `lstat`ing `<entry>/catalog-restore-claim.json` —
a path that **resolves `<entry>`**. For a symbolic link or a Windows junction the probe therefore traversed
the link, out of the destination and into whatever it pointed at, purely to answer a question about whether
to look at it. The entry itself is now `lstat`ed first and a child of it is named only once it is known to be
a real directory. A link at a claim-**shaped** name is still admitted by its name alone and classified
`NOT_A_DIRECTORY` without being opened; a link at any other name is not this command's business and is not
touched, opened or followed to find out.

### 3. `--abandon` did not take the live-restore refusal

The usage, the operator note and the design all state that a project part way through a restore refuses this
command entirely. `--abandon` did not check, so an abandon could run beside a live restore and rename claim
directories back into the destination that restore is publishing into. It is checked now before the lock and
again under it, **before `phase: 'abandoning'` is written or anything is moved**, so a refused abandon leaves
the journal byte-identical. The deliberate exception for an interrupted **prune** is preserved and is the
only one: two commands that can each only be unwound after the other is a wedge with no way out.

**And presence is now asked without following a link.** `existsSync` follows a symbolic link, so it answered
*false* for a dangling one — exactly the state a half-tidied project is in — and answered about the target
rather than the name for every link that resolved. `lstat` answers about the name itself: a file, a
directory, a link, a dangling link or a device all block, on `--plan`, `--confirm`, `--resume` and
`--abandon` alike. A journal this build cannot read is still a journal.

### 4. An abandon could report a destroyed safety set as a clean unwind

For a journal entry persisted as `deleting`, "source absent, target present" was read by a branch whose
comment said *never quarantined, or already put back by an interrupted abandon* — a sentence that is **false**
for `deleting`. Such an entry was definitely quarantined and its tree may already have been destroyed, so an
unrelated directory that had since taken its name was read as a clean put-back: the entry was marked
`pending`, counted as neither put back nor lost, and an abandon that had lost a safety set could render
`RESULT: ABANDONED` and exit zero.

`deleting` is now answered **first**, because only it knows what an absence means. A `deleting` entry whose
tree is gone is loss, named as such; whatever occupies its old name is reported as *not* the claim this
operation destroyed and is never touched. And where the distinction genuinely exists — a `quarantined` entry
with something at its own name — the two readings are separated by **proving the target against the
commitment**: a genuine interrupted rename is reported as *put back*, a replacement is named unresolved and
left alone. For `pending` and `failed` there is nothing to distinguish, because this operation never moved
them.

### 5. `--json` emitted prose on the two paths a machine meets first

The usage text and this suite's own title both promised exactly one JSON document on every path, and two
paths emitted plain text: a pre-effect refusal (exit 3) and a usage error (exit 2, followed by the entire
usage text). A refusal is the ordinary outcome of a scheduled `--plan` against a busy project, so anything
automating this had to sniff whether the bytes were JSON before parsing them. Both now emit a
`SafetySetRefusalDocument` — same `report`/`version` header as every other document, plus `state`
(`REFUSED`/`USAGE`), `exitCode` and this product's own redacted words — on **stderr**, with stdout carrying
nothing. `--help` is the one documented exception and stays human text even beside `--json`.

### 6. A post-remove journal failure reported that nothing was removed

If the recursive removal succeeded and the following journal write failed, the state publication came before
the claim was added to the report — so the post-effect report an operator reads said **nothing was removed**
about a safety set that no longer exists. The report now names the claim and its bytes before the publication
is attempted; the durable state stays `deleting`, which is what lets a resume close it out. `mark` was also
changed to commit its in-memory update **only after the write lands**, so this process can never believe a
state the disk does not record.

### Correction 1 gates

| Gate | Result |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | **PASS**, 0 errors |
| `npm run test:safety-set-lifecycle` | **98 passed, 0 failed** (was 81) |
| `npm run test:complete-restore` | 136 passed, 0 failed |
| `npm run test:backup-retention` | 114 passed, 0 failed |
| `npm run test:complete-backup` | 49 passed, 0 failed |
| `npm run test:backup-components` | 41 passed, 0 failed |
| `npm run test:release-readiness` | 44 passed, 0 failed |
| `npm run test:deploy` | 210 passed, 0 failed |
| `npm run test:operator-ui-service` | 5 passed, 0 failed |
| `npm run test:doctor-monitor` | 19 passed, 0 failed |
| `npm run test:inventory` | **ok: true**, 324 suites, no drift |

Broad `offline`/`db`/`docker` aggregates were **not** run for this correction, as instructed.

### What the 17 new checks drive

A real child-process kill after `deleting` is persisted, the child then **replaced with a stranger tree**,
resumed, and the stranger proved **byte-identical** with nothing after it destroyed — and the same fixture
without the replacement proved to still finish. A kill at the new `after-consuming-marker` boundary, with the
marker's nonce asserted equal to the journal's and the safety set inside it byte-identical. A **real partial
removal** (a component genuinely unlinked, then a throw) proved to leave its authority behind, then replaced
and refused, then — in a second fixture — resumed to completion. Five ways a consumption marker can be wrong.
A member appearing inside a tree mid-consumption. The emptied-tail case and its one-stray-byte counterexample.
A version-1 journal, a `deleting` entry with no nonce, a nonce that is not one, and a nonce on a state that
never carries one. Shaped, unshaped and dangling junctions with an **external marker target** asserted
untouched. An abandon refused mid-restore with the journal proved byte-identical and no lock left behind, and
a dangling link, a directory and an empty file at the restore journal's name each blocking all four modes. A
`deleting` claim whose name was taken by a stranger, proved to be reported as loss with the stranger
untouched. A genuine interrupted abandon rename reported as *put back*, beside a replacement in the same
journal state reported as unresolved. `JSON.parse` over the refusal and usage streams with the opposite
stream asserted empty, the usage prose asserted absent, and both human paths asserted unchanged. And a
writer failpoint aimed at the `removed` publication, asserting the report names the gone claim and its bytes,
the disk still says `deleting`, the tree is really gone, a resume closes it out and an abandon calls it loss.

## Remaining review risks

1. **The shared-destination boundary is documented, not closed.** Another project's restore publishing into a
   destination this project prunes is outside the lock. Mitigated by `OWNED_IN_FLIGHT` and by
   `--min-age-days 14`; not eliminated. A reviewer should decide whether the product should refuse a shared
   destination outright.
2. **Three full reads of the destination on a `--confirm`** — plan, re-plan under the lock, and the live floor
   proof. The third is redundant on `--confirm` and load-bearing on `--resume`; it is not skipped because a
   rename that went wrong without throwing would otherwise reach the delete phase unchallenged. Nobody has run
   this against a hundred gigabytes.
3. **An empty claim's age is filesystem metadata.** Off by default, stated in the plan, and the only place a
   timestamp that did not come out of a manifest is used — but a `touch` moves it.
4. **A kill in the two-instruction window before the quarantine is published leaves an orphan** of a few
   hundred bytes (`.catalog-safety-set.claiming-<hex>` holding one marker). It is named rather than swept,
   because a sweep is a delete and this command has exactly one delete path. `ops:backup-retention` behaves
   identically.
5. **`--resume` refuses while a retention prune is interrupted.** `--abandon` is always available, so it is
   not a wedge — but an operator who crashed both commands must deal with the prune first or abandon this one.
6. **Correction 1 bumped the journal schema to 2 and changed the removal protocol.** A `deleting` entry now
   carries a consumption nonce and the tree being consumed carries a marker that is removed last. An
   operator holding an interrupted run written by the pre-correction build will have it refused at the
   version boundary and must `--abandon` it with that build, or remove the journal by hand. Nothing shipped,
   so no real installation is in that state — but it is the kind of thing a reviewer should see stated.
7. **This tranche changed two shipped modules to share primitives.** `complete-restore.ts` (marker id and file
   name) and `backup-retention.ts` (the set-identity proof, the manifest shape, the inventory-row validator).
   Both keep their exact refusal wording and both suites pass unmodified — but a reviewer should confirm they
   are happy with the coupling, because it is the one change in this tranche that touches code the previous
   two tranches own.
8. **This tranche added `test:phase313-local` to the required-suite list and the workflow.** Same list, same
   family, same argument as the two entries beside it — a reviewer should confirm they are happy with the CI
   obligation.
9. **The whole tranche is proved against a real filesystem and no Docker daemon**, which is correct here
   because this command issues no command at all — but nothing in it ran as a live long-running process.
