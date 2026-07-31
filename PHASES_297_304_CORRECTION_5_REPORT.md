# Phases 297–304 — correction 5

One functional commit from `295629c`, worktree clean. **Nothing pushed, no PR opened, no release or image
published, nothing deployed, no live service touched.**

| Commit | Item |
| --- | --- |
| `56a4153` | 1 and 2 — journal schema 4 → 5, and the two descriptions that had gone false |

The report is a separate commit, as asked.

## Item 1 — the schema version moves with the persisted field

Correction 4 made `stagingCommitment` a **required** persisted field and left `RESTORE_JOURNAL_VERSION` at 4
— the same number the build before it wrote. The consequence is small on disk and large in a refusal: a
genuine v4 journal, written by a build in which that field could not exist, was rejected with *"it carries no
staged-component commitment"*. That is a malformed-document complaint about a document that was perfectly
well formed for the build that wrote it, and it points an operator at the wrong problem — theirs is not a
corrupt file, it is an older schema. It also broke the standing rule that the version moves whenever a
persisted field or state does.

`RESTORE_JOURNAL_VERSION` is **5**. There is no migration and that is deliberate: a journal decides which
steps a resume skips and which directories an abandon renames, and guessing at an older one is how a
half-understood record destroys something. The version is checked second, immediately after "is this a
restore journal at all" and **before any other field is examined**, so an older journal is refused at the
schema boundary rather than diagnosed as damage.

Nothing else in `src/` or `test/` reads or writes this journal — `RESTORE_JOURNAL_NAME` appears in exactly
two files — and both markers that bind themselves to the schema already embed `RESTORE_JOURNAL_VERSION`
rather than a literal, so the bump propagates to the staging marker and the safety-claim marker by
construction. The tests prove it rather than assuming it.

**Four tests, as the item asks:**

* **A genuine pre-commitment v4 journal** is built by taking a real journal this build wrote, deleting
  `stagingCommitment` and setting `version: 4` — exactly what the previous build produced. It is refused for
  *"version is not one this build writes"*, and the test asserts the refusal does **not** mention the
  commitment. A run, a resume and an abandon all stop on it, and the file is byte-identical afterwards.
* **Every real crash state round-trips at the current version.** Seven boundaries are killed with a real
  child process — the three staging transitions, a mid-copy death, a death inside the safety-set step, and
  the two records around it — and each resulting journal is read **raw** (bypassing the reader that would
  enforce the number) to assert `version` is the current one and `stagingCommitment` is present, then read
  through `readRestoreJournal` to prove it round-trips. A constant that moved while the writer kept emitting
  the old number would refuse this operation's own journals; this is what rules that out.
* **Both markers carry and require it.** The staging marker and the safety-claim marker are read off disk and
  asserted to carry the new `journalVersion`; each is then rewritten with `4` and must stop authorising
  anything — the staging marker no longer proves ownership and `removeOwnedStaging` refuses (the tree
  survives), and `proveClaimOwnership` answers `foreign` so the resume will not publish into the claim and
  the directory is preserved.
* **A lint for stale literals**, and it says in its own comment that it is a lint and proves no behaviour. It
  walks every `.ts` under `src/`, the crash-child helper and the restore document, and fails on a hard-coded
  journal version or on prose naming a stale one. The acceptance suite is excluded on purpose: its
  old-version fixtures are the regressions the constant exists for. The existing version test now refuses
  **both** 3 and 4.

## Item 2 — two descriptions that had gone false

**A test whose name asserted the opposite of its assertions.** `CRASH after staging is verified, before its
completion record: the tree is unmarked and refused, not reused` described the *first* design, in which the
marker was written last and a killed run left an unmarked tree at a predictable name. That design is gone —
the tree is claimed before a byte is copied and sealed once every component is verified — and the test's
assertions had already been updated to the new contract while its name and comment still described the old
one. That is the most misleading state a test can be in: it reads as proof of a guarantee nobody holds any
more. It is now `CRASH after staging is verified, before its completion record: the tree is SEALED, ours, and
rebuilt`, its comment states the actual contract and records why it changed, and it asserts the marker's
`state` is `sealed` and its `planDigest` binds this operation rather than merely asserting a marker file
exists.

**A comment that overstated the orphan guarantee.** The `stageComponents` comment said every leftover build
directory carries the same operation-bound marker. It does not, and the required failpoint proves it: a death
between the `mkdir` and the marker write leaves `.catalog-restore.claiming-<hex>` empty. The comment now
states the exact truth, and why the weaker statement is still safe:

* the orphan is **secret-free** — no component is copied until after the publication, so an orphan from
  before it cannot hold one;
* its name is **unpredictable** and is not the predictable path, so it **blocks nothing**: the next attempt
  draws a fresh name and `createPrivateDirectory` refuses rather than reuses on collision;
* it is **never trusted and never recursively deleted as an owned tree**, because removing a directory of
  secrets is authorised by a marker proving whose it is and what it holds. An unmarked orphan has none, so
  this command leaves it for an operator exactly as it leaves any other directory it cannot prove is its own.

The same sentence appeared in `docs/PHASES_297_304_COMPLETE_RESTORE.md` and in the correction 4 report; both
are corrected, the report with a marked note rather than a silent edit, since it is a record of what was
claimed at the time. No guarantee is weakened anywhere: the statement about **the predictable path** — absent
or fully claimed/sealed, never anything else, resumable with no manual deletion — is unchanged, and so is the
explicit limit that none of it is claimed against power loss, because no directory `fsync` follows the
renames.

The remaining "written LAST" and "unmarked tree" phrases in the code, the suite and the earlier reports are
all past-tense accounts of the defect that was closed. They were checked, not merely left.

## Item 3 — verification

Run on Windows 11, Node 22, from this worktree, after the functional commit.

| Check | Command | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | clean |
| Complete restore | `npx tsx test/complete-restore.ts` | **136 passed, 0 failed** |
| Complete backup | `npx tsx test/complete-backup.ts` | 49 passed, 0 failed |
| Custody proof | `npx tsx test/custody-proof.ts` | 9 passed, 0 failed |
| Inventory audit | `npm run test:inventory` | `ok: true`, 322 suites, 6 helpers |

**The wider DB and offline groups were not re-run, and the item permits that explicitly.** The stated
condition holds here: production behaviour changes only by the schema constant and by comments, `git diff`
touches `src/ops/complete-restore.ts`, `test/complete-restore.ts` and two documents, and nothing outside
`src/ops/complete-restore.ts` and `test/complete-restore.ts` reads or writes the restore journal at all —
`RESTORE_JOURNAL_NAME` appears in exactly those two files. The typecheck is clean and the focused suites,
which are the only ones that exercise the journal, the markers and the crash paths, are green. Those groups
were run in full at correction 4 (db 33/33; offline 284/287 with three pre-existing failures unrelated to
this work, identical at `6099cb0`), and nothing in this tranche touches them.

**No Docker or live check ran**, and none is claimed. The daemon is not running in this environment
(`docker info` → `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine … The
system cannot find the file specified`). No container was started, no image pulled, no external system
contacted, and no Unraid or Tower host touched.

## Remaining risks

* **No migration path for older journals.** A project left mid-restore by a pre-correction-5 build cannot be
  resumed or abandoned by this one: it is refused at the schema boundary and an operator must deal with the
  directories by hand, guided by the journal's own contents. That is the deliberate trade — a wrong guess
  about an older record renames or deletes real directories — but it is a real operational cost and it should
  be stated in release notes if any build in that window ever shipped.
* **Power loss remains uncovered**, unchanged from correction 4: no directory `fsync` follows any atomic
  rename, so the guarantees are against process death only.
* **The three pre-existing offline failures** (`kek-correction-gates`, `custody-cutover`,
  `custody-transition`) are still there. They are outside this correction and were not touched.
