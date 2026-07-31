# Phases 297–304 — correction 4

Six commits from `6099cb0`, worktree clean. **Nothing pushed, no PR opened, no release or image published,
nothing deployed, no live service touched.**

| Commit | Item |
| --- | --- |
| `f10ab84` | 4 — the abandon direction is refused before anything is read, probed or planned |
| `919ad3c` | 1 — staging ownership is crash-safe at both transitions |
| `a48aef5` | 2 — an exact manifest commitment guards every staging deletion |
| `070256a` | 3 — the safety-set claim is revalidated against the live filesystem |
| `16b3a01` | 5 — the journal consistency audit, over combinations |
| `1857a4f` | docs for items 1, 2, 3 and 5 |

The report itself is a separate commit, as asked.

## Item 1 — the ownership-state transitions

`stageComponents` created the predictable staging path with `mkdir` and **then** wrote the claimed marker
into it. A process that stopped existing between those two calls left the predictable path holding an
**unmarked** directory: refused by every reader afterwards, removable by nothing, and requiring an operator
to delete a secret-bearing tree by hand. That is the exact wedge the marker exists to prevent, reintroduced
two lines below the comment explaining it. Sealing had the same shape in reverse — it **removed** the claimed
marker and then wrote the sealed one, a two-call window in which a populated, secret-bearing tree carried no
marker at all.

Both transitions are now atomic renames:

* **absent → claimed.** A directory named `.catalog-restore.claiming-<18 hex>` is created, its claimed marker
  is written inside it while it is still invisible, and only then is it renamed onto the predictable path.
  Not a byte of any component is copied until after that rename, so the claim is built secret-free.
* **claimed → sealed.** The complete sealed marker is written to a private temporary file inside the tree and
  renamed over the top. A reader sees the old valid marker or the new valid one, never neither.

**The guarantee, stated exactly.** Against a process that stops existing, the guarantee about the
**predictable path** is complete: every observable state of it is absent, or a fully claimed/sealed directory
of ours, and a resume proceeds with no manual deletion.

> **Corrected in correction 5.** This paragraph originally added that the leftover build directory always
> carries the same operation-bound marker. It does not: a death between the `mkdir` and the marker write
> leaves `.catalog-restore.claiming-<hex>` empty. The orphan is secret-free (nothing is copied until after
> the publication), unpredictably named and therefore blocks nothing, and is never trusted or recursively
> deleted as an owned tree — an unmarked directory authorises no removal, so it is left for an operator
> exactly like any other directory this command cannot prove is its own.

Against **power loss to the disk** it is not, and the code and the docs say
so: `rename` is atomic with respect to other readers, but the containing directory is not `fsync`ed
afterwards, so the metadata may not have reached stable storage. After a power cut the path may be absent
when the run believed it published, or the marker may read `claimed` when it was sealed — both states the
resume already handles, so a power cut degrades to a redo rather than to a wedge. What is **not** claimed is
that a torn directory entry is impossible on a filesystem that reorders metadata.

**Failpoints, by injection and by real death.** Two injected tests prove the invariants directly: the
predictable path never exists without a valid claimed marker, and a death mid-seal leaves the valid CLAIMED
state on a populated tree. Three more kill a **real child process** with `process.exit(137)` at
`staging-phase:claim-built`, `claim-published` and `sealing` — after the directory exists and before it is
published, after publication and before the first component byte, and during the marker replacement. Each
reads the resulting disk and journal state, requires whatever sits at the predictable path to carry a valid
marker bound to this plan, resumes **in process** to completion with no manual deletion, and proves a foreign
directory in the same project was neither removed nor consumed.

## Item 2 — exact manifest values wherever a marker authorises deletion

`readStagingMarker` took the manifest **optionally**, and the three paths that use the marker to authorise a
**recursive deletion** were exactly the three that omitted it: the rebuild of a partial stage (`stageComponents`),
the cleanup on success, and the cleanup on abandon (`removeOwnedStaging`, called with no manifest at all). A
marker naming the right plan and the right suffix but describing entirely different components therefore
authorised removing a directory holding a copy of every secret in the installation.

The comparison is a **required argument** now, and it is exact: same length, same order, same ids, same
artifact names, same digests, same entry and byte counts. Missing, extra, duplicated, reordered and altered
are one answer.

**The suite asserted the opposite, and that was the licence for the omission.** The marker-guard test
declared two bars — ownership for *removing*, manifest agreement only for *using* — on the reasoning that a
manifest-inconsistent marker is still provably ours and must stay removable or a mid-copy death would wedge
the project. The reasoning is wrong: what authorises a recursive deletion of every secret must describe what
this operation actually staged. Nothing wedges, because the states a death really produces — claimed,
mid-copy, sealed — all carry a marker this operation wrote from this manifest and compare equal. What does
not compare equal is a marker somebody edited. The test now runs every case, including missing, extra,
reordered, altered digest, altered entries and altered bytes, through **both** the reader and
`removeOwnedStaging`, and requires the tree to survive each one.

**Abandon has no set to compare against, so the operation commits before it destroys anything.** The exact
staged-component values are written into the **first** journal of the operation — before the safety set,
before the teardown, before a single copy — validated canonically on every journal read (known ids, no
duplicates, this build's component order, canonical artifact names, lower-case SHA-256, counts that are
counts), and cross-checked against the set now on disk whenever one is available. A journal and a set that
disagree stop the operation with nothing changed, because at that point one of the two has been edited and
neither is safe to act on.

Four end-to-end tests: a failed-stage rebuild, a successful-run cleanup, an abandon cleanup **with the set
deleted**, and an edited journal commitment. All four preserve the staging tree and the journal, and all four
name the unresolved secret-bearing path — `stageComponents`' refusal now carries it, because nothing else
would tell an operator where it is. The abandon test then puts the marker back as the operation wrote it and
requires the same abandon to complete with the set still nowhere to be found, so the bar is exactness rather
than suspicion.

## Item 3 — the claim is revalidated, never assumed

The journal recorded `{ nonce, created: true }` and recovery read that as "the claim is still ours" — a
sentence about the past, applied to the present without looking. Between the record and the resume that
directory can be deleted by an operator tidying the backups folder, by a sync, by a cleanup script; and once
it is gone, anything at all may occupy a path that is by then written down in a file in the project.

The claim is now bound to the **live** directory by a canonical no-follow ownership marker written **inside**
it, before the journal records the claim at all. That ordering is what makes the record meaningful: a journal
naming a claim always names one that carried the proof, so a claim found without the proof is not a crash
state — it is a different directory. `proveClaimOwnership` answers three things, with three different safe
responses:

| The recorded path is | What happens |
| --- | --- |
| Gone | The nonce and the path are **abandoned**, not reused; a fresh claim is drawn and nothing that may since have appeared there is read, adopted or removed. The journal records the discard before the retry runs. |
| Occupied without a valid marker of this operation | Refused. Nothing published into it, nothing removed, a human told to look. |
| Proved ours | The existing behaviour: publish into an empty claim; recognise a set inside it that verifies as this run's. |

It is asked on **every** path into the safety-set step, not only from recovery, because a run reading its own
journal, a resume that recovered a different step and a retry coming back around all arrive with a claim in
hand. And `ops:complete-backup` now refuses to **recreate** a destination the caller claimed by `mkdir`:
creating the directory *is* the claim, so recreating a missing one would publish into a path this project has
written down and nothing owns, behind the back of the recovery that had just abandoned it.

Tests: the recorded claim deleted (→ fresh nonce, old path not recreated, set published into the new claim);
replaced by a foreign **empty** directory (→ refused, contents byte-identical afterwards, nothing published,
journal unchanged); replaced by a foreign **valid, verifying set** at the exact published name (→ refused,
set byte-for-byte untouched, `evidence.safetySetTaken` still false); five marker-tampering variants; and the
backup's refusal to recreate. The owned-published/death-before-step-record success case is retained and still
recognises the set rather than retaking it.

## Item 4 — the abandoning direction is refused first, with zero effects

The refusal sat **after** `resolveCompleteRestoreRequest`, which verifies the backup set, opens its manifest
and runs the occupancy probe against Docker. "Refuses with no effects" was therefore untrue, and an operator
whose set had been moved was told about a missing set instead of the one thing that mattered. It now happens
immediately after the journal is read and before the request is resolved, the set is touched, Docker is
probed, a plan is derived or confirmation is checked, and it names `--abandon` as the only command that may
continue.

The regression drives an abandoning journal **with the set moved away**, runs both `run` and `resume` with
spies on the command runner, the file runners and the renamer, and requires **zero** calls of every kind and
a refusal that names `--abandon` and does not complain about the set. The abandon then continues to
completion from journal-bound targets with the set nowhere to be found.

## Item 5 — the audit is over combinations

Every field was individually well formed, which is not the same as the document describing a state a run of
this program can be **in** — and these fields are acted on together. Refused now, before any effect: the two
records of the safety set disagreeing (`safetySetTaken` vs `evidence.safetySetTaken`); a set recorded as
taken by a step that has not run, or with nowhere claimed to have published it into; a completed safety-set
step that took no set; a safety-set step in an operation that planned none; a claim this command did not
create (`created: false` is not a state any path persists); and a swap recorded as put back by an operation
that is not abandoning. `safetySetVerified ⇒ safetySetTaken` was already enforced and remains.

The other half of a consistency audit is not refusing genuine crashes: rules tight enough to catch an edited
journal are tight enough to refuse a state a kill really produces, and a refused crash state is a project
that can neither resume nor abandon. Every rule is stated over states the executor actually persists, in the
order it persists them, and a companion test kills **eight real boundaries** — the three new staging
transitions, a mid-copy death, a death inside the safety-set step, before and after the safety-set record,
and before the staging record — and requires every resulting journal to read **and** to resume to completion.

## Item 6 — verification

Run on Windows 11, Node 22, from this worktree. Every number below is from a run made after the last commit
of the tranche.

| Check | Command | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | clean |
| Complete restore | `npx tsx test/complete-restore.ts` | **132 passed, 0 failed** |
| Complete backup | `npx tsx test/complete-backup.ts` | 49 passed, 0 failed |
| Custody proof | `npx tsx test/custody-proof.ts` | 9 passed, 0 failed |
| Inventory audit | `npm run test:inventory` | `ok: true`, 322 suites, 6 helpers |
| DB group | `npm run test:db` | 33 selected, **33 passed, 0 failed** |
| Offline group | `npm run test:offline` | 287 selected, 284 passed, **3 failed** — see below |
| Docker group | `npm run test:docker-suites` | **NOT_RUN** |

**The three offline failures are pre-existing and unrelated to this tranche.** `kek-correction-gates.ts`
(37 passed, 1 failed), `custody-cutover.ts` (22 passed, 2 failed) and `custody-transition.ts` (14 passed, 1
failed) fail identically at `6099cb0`, the commit this tranche started from, in a detached baseline worktree
built for the comparison. The failing assertions are about the runtime compose file's KEK overlay and a
compose mode marker; nothing in them touches the restore, the staging protocol, the claim or the journal.
Same suites, same counts, before and after.

**Docker is NOT_RUN for one exact environment reason:** the Docker CLI is installed (client 29.6.1) but the
daemon is not running — `docker info` answers `failed to connect to the docker API at
npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open
//./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`. No container was started, no
image was pulled, and no live service was touched. Nothing in this tranche was verified against a real
Docker daemon, and no claim here rests on one.

**One thing I broke and repaired, stated plainly.** To baseline the three offline failures I added a detached
`git worktree` at `6099cb0` and gave it a Windows **junction** to this worktree's `node_modules`.
`git worktree remove --force` deleted through the junction, emptying this worktree's `node_modules`. I
restored it with `npm ci` from the committed `package-lock.json` (57 packages) and re-ran the type check, the
restore suite, the db group and the offline group afterwards — all the numbers in the table above are from
after that repair. No tracked file was affected; `git status` was clean throughout.

## What is real, what is simulated, what is not run

* **Real:** every filesystem effect in these suites — real directories, real renames, real `mkdir` claims,
  real markers, real digests, real recursive deletions and refusals to perform them. Five tests kill a **real
  child process** with `process.exit(137)` at a named boundary and then resume in process, so what recovers
  is the shipped code and not a re-implementation of it.
* **Simulated:** the Docker daemon, `psql` and the container toolchain, through the injected `CommandRunner`,
  `FileInputRunner` and `FileOutputRunner` seams. The commands are asserted against an allow-list and a
  ledger; whether the real daemon behaves as the fake does is not something these suites can prove.
* **Not run:** everything in the docker group, for the reason quoted above. No Unraid or Tower host, no live
  installation and no external system was contacted at any point in this tranche.

## Remaining risks

* **Power loss is not covered.** No directory `fsync` follows any of the atomic renames, so the guarantees in
  item 1 are against process death, not against a disk that loses buffered metadata. Both the code and the
  docs say so rather than implying otherwise.
* **The claim proof is a TOCTOU window, not a lock.** `proveClaimOwnership` runs immediately before the
  backup publishes, but a sufficiently adversarial local process could still swap the directory in between.
  The project lock excludes other *maintenance commands*; it cannot exclude anything else with write access
  to the backups folder.
* **The three pre-existing offline failures remain.** They are outside the scope of this correction and I did
  not change them; they should be fixed before anyone reads a green offline group as a release gate.
