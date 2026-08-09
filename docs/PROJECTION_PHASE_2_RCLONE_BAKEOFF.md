# Projection Phase 2b/2c — the multi-frontend comparison

**Status: the harness has been executed on the real Unraid host and NO ARM HAS COMPLETED.** Every run record on this page is empty and says so; §4.1 records exactly how far it got and the one thing blocking it. Nothing
below is a measurement; the figures are still a description of what it would measure, written so that a completing run
has something to fill in and so that nobody can mistake the description for the result.

**Files:** `deploy/projection-multi-frontend-comparison-gate.sh`, `-optional.sh`;
`docker-compose.projection-multi-frontend.yml` (committed, and named by the harness rather than generated);
offline pins in `test/projection-multi-frontend.ts`. The mount-hardening half of this tranche is
`docs/PROJECTION_PHASE_2_MOUNT_HARDENING.md`; the two are independent and neither closes the other.

**One file was deliberately NOT brought across.** A second script,
`deploy/projection-multi-frontend-gate.sh`, exists as an untracked draft in the sibling worktree
`projection-phase1-heredoc-audit-2`. It is **truncated**: 214 lines that stop after the Postgres compose
heredoc at a literal `# ===PART02===` marker, with no arms, no rounds and no comparison. It is an earlier,
abandoned pass at the same harness, superseded by the file above, and porting a half-written script because
it was found next to a finished one is how a repository acquires a second implementation of its own gate.

---

## 1. What this is, and the one word it is not

It is a **harness**, not an acceptance gate. It has **no pass threshold**, it closes **no** G-number, and its
output is a table of figures. The existing gates' own assertions still run inside each arm — window,
telemetry, cold-window where it applies, verify-corpus, the leak searches — and this file adds only the three
manufactured failures and the comparison that reads them.

**There is deliberately no `:three` wrapper.** Every acceptance gate in Phase 1 and Phase 2 has one, because
three consecutive fresh runs is what closes a gate. A `:three` here would announce a closure this thing has no
threshold to support, and a wrapper that implies more than its subject can deliver is the exact failure Phase 1
spent four dispatches removing from documents and from wrappers that printed them. Reproducibility is
established by recording each run in §4 below, not by a wrapper counting to three.
`test/projection-multi-frontend.ts` fails if a `:three` script ever appears.

## 2. The three arms

The design named `mount` and `mount2` as two of the arms. **`mount2` does not exist as a separate client**: in
the pinned rclone v1.71.1
(`rclone/rclone@sha256:d5971950c2b370fb04dd3292541b5bda6d9103143fd7e345aeb435a399388afc`) it is a hidden alias
of `mount`, so that comparison would have measured the same client twice and reported the difference as
signal. The arms are the two rclone **cache policies** that actually differ in a media-read workload.

| Arm | Frontend | Endpoint | Topology |
|---|---|---|---|
| **A** | `projectiond` FUSE, with a bearer credential on the resolver | `fakerange` in resolver mode | G18's, plus a token file so a credential rotation is measurable |
| **B** | rclone `mount`, `--vfs-cache-mode off` | `fakewebdav` | G22's, unchanged |
| **C** | rclone `mount`, `--vfs-cache-mode full` | the same WebDAV endpoint | B, with a persistent read-ahead cache |

**One frontend per arm, not one per server.** The design asked for per-server frontend instances; nine
frontends would multiply the failure-injection state ninefold for attribution the observer already provides.
The G18/G22 observer attributes per server through each server's own scan and its own catalogue document, and
the harness reports from those three documents.

All three arms serve **the same generated corpus**, under **the same three digest-pinned media servers**, read
by **the same observer** — so a difference between arms is a difference between frontends and never between
corpora or observers.

## 3. The three rounds

| Round | What is done to the provider | What is recorded |
|---|---|---|
| **R1 provider stall** | the endpoint holds the 94 MiB barrier object's ranged reads (`POST /control/hold`, bounded at 4,500 ms) | whether a full read through the frontend failed or was served from a cache that should not have had it, and how long it took. **Recorded, not assumed** |
| **R2 credential rotation** | the endpoint is minted a new bearer token and restarted while the frontend still holds the old one | which read converges. rclone re-reads its token per request; the daemon reloads only when a resolution is refused, so it converges on a following read. The attempt number is recorded |
| **R3 frontend restart** | the frontend container is restarted over the same mountpoint | time-to-ready, and whether a warm re-scan settles on the same identities across all three servers |

**Why each failure read must reach the wire.** R1 reads the 94 MiB barrier — the daemon's probe cache is
bounded well below it, and arm B has no cache at all. R2 reads a **newly published** object on arm A (nothing
can have cached a byte the daemon has never served) and the canary on arms B/C (outside the library root,
never read through the mount, and the credential-guarded `/dav` path refuses an unauthenticated request by
construction).

Resource accounting samples **the frontend container only** — the daemon on arm A, the mount client on B and C
— once a second, and reports averages and peaks.

## 3.1 Measurement mode, and exactly what it relaxes

The concurrency observation is shared with Phase 1: both `verify-overlap` implementations call G18's own
`analyseOverlap` and `overlapProblems`. Two of its checks are **floors on the longest unbroken three-way
run** — at least 3 samples and at least 2 credited seconds — and in an acceptance gate that is right: three
scattered simultaneous samples are not three servers scanning together.

**In this harness that same quantity is the thing being compared.** `projectiond` serves the scan window from
its probe cache, so its three scans do not queue behind the provider and finish closer together than an
rclone arm's do. Measured on Unraid, arm A's longest unbroken run was **1 sample**, and the run said why:
*"the barrier was released after 0s of a provider read actually being blocked."* A harness that aborts on the
figure it exists to report cannot report it.

So `verify-overlap` takes **`--overlap-mode`**, and it is the only thing that changes:

| | `strict` (the default) | `measurement` |
|---|---|---|
| the two continuous-run floors | **enforced** — this is the acceptance interpretation | **recorded** under the two `:measured` gate ids (the sample count, and the credited duration), held against no floor |
| the scan having run at all | required | required |
| all three servers observed scanning | required | required |
| full three-way attribution seen at least once | required | required |
| readable telemetry | required | required |
| a zero, absent, negative, fractional or non-finite figure | fails | **fails** — `measurementClosureProblems` |
| scan failures, corpus, telemetry, leak searches, every other gate | unchanged | unchanged |

**Containment is the point, and it is enforced rather than promised:**

- **The default is `strict`.** Every Phase 1 gate — G18, G22, the three data-plane gates, G27 — passes no
  `--overlap-mode` and is bit-for-bit unaffected. `test/projection-overlap-measurement-mode.ts` asserts that
  no gate in `deploy/` except this harness contains the flag.
- **An unrecognised value is refused**, never defaulted in either direction, so a typo cannot pick a mode.
- **The floors themselves did not move.** `MIN_SIMULTANEOUS_SAMPLES` is still 3 and
  `MIN_SIMULTANEOUS_SPAN_SECONDS` still 2, pinned by test, so **no historical Phase 1 result means anything
  different than it did before this change**.
- **The relaxed figures carry a different gate id and the nonclaim**, so a results file cannot be read as an
  acceptance pass:

  > *MEASUREMENT MODE CLOSES NO GATE: the continuous three-way overlap is RECORDED as a comparison figure and
  > is held against no floor. It is not an acceptance result, it closes no G-number, and it says nothing about
  > whether this frontend would pass the strict interpretation every Phase 1 gate applies.*

**Both floors are relaxed together, and that is deliberate.** They are two views of one observation — the
same unbroken run counted in samples and credited in seconds. Relaxing only the count would leave the
duration floor failing for the identical reason at the identical place: a distinction with no behaviour
behind it.

## 4. Run record

**NOT RUN.** No arm has completed, so no arm has a row. A row is filled only by a run that completed, and a
partial run is not a partial result — R1, R2, R3 and the resource accounting all come after the point where
this stops, so there is nothing to put in these columns.

| Arm | Host | R1 | R2 | R3 | CPU / RAM | Evidence |
|---|---|---|---|---|---|---|
| A | — | — | — | — | — | — |
| B | — | — | — | — | — | — |
| C | — | — | — | — | — | — |

### 4.1 How far it got, and the one thing blocking it

**It was executed on the real Unraid host `tower` six times**, each attempt going further than the last as the
defects in §7 were found and fixed. The furthest run reached **step 14 of arm A** — through the corpus,
Postgres, the credential checks, generation 1, the daemon mount, **all three real media servers started and
their libraries created**, the ~50-entry corpus published, and **three real simultaneous library scans over
the same projected mount**. Two of the three concurrency assertions passed on their budgets:

| Assertion | measured | budget | |
|---|---|---|---|
| `TS1-servers-observed-scanning` | 3 | 3 | **pass** |
| `TS1-max-servers-in-flight-at-once` | 3 | 3 | **pass** |
| `TS1-continuous-simultaneous-samples` | **1** | 3 | **fail** |

**THE BLOCKER IS A SCOPE DECISION, NOT A BUG I CAN CORRECT.** The third assertion wants the longest *unbroken*
run of samples with all three servers scanning to be at least 3 — roughly 1.5 s of continuous three-way
overlap at the sampler's tick. The harness got one sample, and the run says why: *"the barrier was released
after **0s** of a provider read actually being blocked"*. The barrier object exists to make the scanners queue
behind one slow provider read so the overlap is long enough to sample; on arm A nothing ever blocked on it,
the three scans went through at full speed, and they finished too close together to overlap for 1.5 s.

That is **arguably the comparison working**: `projectiond` serves scan-window reads from its probe cache, so a
scan that would queue behind the provider on the rclone arms does not queue at all here. The difference in
overlap is a *figure this harness exists to report*. But `TS1-continuous-simultaneous-samples` is a **Phase 1
acceptance threshold**, inherited through the shared `concurrent-scan` driver, and inside a harness it is
applied as a pass/fail to a quantity that is supposed to be a measurement.

Closing it means one of:

1. **Give the harness a measurement-mode concurrency observation** — same instrument, figures reported and
   nothing failed — which changes the semantics of a driver Phase 1 gates depend on; or
2. **Make arm A's barrier actually block**, by holding an object the daemon cannot serve from its probe cache
   during the scan window, which changes what the scan measures and therefore its comparability with G18/G22;
   or
3. **Retune the budget**, which is moving a Phase 1 threshold to make a Phase 2 harness green — the one option
   that should not be taken quietly, and is recorded here so it is not.

**None of these was chosen.** Each trades away something belonging to Phase 1, and the harness closes no gate,
so the tranche does not depend on the answer. Evidence for the six attempts is in
`phase2-evidence/multi-frontend-run1.log` and `/tmp/mf{1..6}.log` on the host.

## 5. What a run of this will and will not establish

- It will **not declare a winner.** The naive path is here to be measured, not to be proved worse.
- It does **not** claim a real WebDAV service, a real network FUSE, or a real provider. Both endpoints are
  this harness's own in-repository fixtures.
- It claims **no latency, throughput or time-to-first-byte figure.** The only wall-clock numbers are R1's
  stall bound and R3's readiness, and both are round outcomes rather than transport measurements.
- A **Docker Desktop pass is not Linux closure** and closes none of G7–G13, G18 or G22.
- Per-server attribution comes from the three catalogue documents, not from three frontends.

## 6. Reproduction

```sh
# On a host where /dev/fuse is reachable from a container. Propagates 77 as a skip.
npm run go:multi-frontend-comparison

# For a CI runner where the harness is optional: maps 77 to 0 and says NOTHING WAS MEASURED.
npm run go:multi-frontend-comparison:optional

# The offline pins, which run everywhere in seconds and execute the harness's embedded programs.
npx tsx test/projection-multi-frontend.ts
```

The harness needs the production image `projectiond:phase1-local` present, and it binds host ports
**8170–8175, 32550–32551 and 5576** plus Postgres on **5515** — a block no other gate in `deploy/` claims, so
it can run beside `go:rclone-comparison-gate` rather than colliding with it.

---

## 7. Twelve defects, nine found by reading and three by running it

**Defects 1–9 were found by reading** the harness
against the claims it makes, and each is pinned by a test in `test/projection-multi-frontend.ts` that fails
against the harness as it arrived and passes after — **14 of that suite's 16 tests fail against the file as
it was inherited**, and the two that do not are about documents rather than about the harness.

**THREE OF THE TWELVE MEAN IT COULD NEVER HAVE RUN AT ALL**, on any host, for reasons that have nothing to do
with FUSE or with a provider: a directory that was never created, a program run before it was written, and a
configuration file that was created as a directory. They are #5–#7 below, and each aborts the harness under
`set -e` before an endpoint starts. They are recorded first because they change what the previous
coordinator's handoff meant: this was not a finished harness awaiting a host, it was a harness that had never
been executed once.

| # | What was wrong | What it cost |
|---|---|---|
| 1 | **`$GATE_SKIP_STATUS` was referenced twice and assigned nowhere.** Under `set -u` that is not a wrong exit code, it is an abort: on a host with no `/dev/fuse` the harness died with `GATE_SKIP_STATUS: unbound variable` and **exit 1** — the status this repository reserves for a gate that RAN AND FAILED — having printed nothing about why. The one contract a skip has, 77 and never anything else, was inverted on exactly the hosts the skip is for | the variable is defined with the same `${GATE_SKIP_STATUS:-77}` idiom every other gate uses, and the pin requires the assignment to precede the first read |
| 2 | **Teardown removed containers and left mounts.** `cleanup` removed the containers, the compose project and the network, and did not source `deploy/projection-gate-cleanup.sh` at all — so no unmount, no run-directory removal, and no cleanliness report. Three arms × three media servers holding handles on a FUSE mount is nine chances to leave one attached to the host, and `rm -rf` over a dead FUSE mount does not do what it looks like it does | teardown routes through `projection_gate_cleanup_run` and then `projection_gate_report_cleanliness`, which reports rather than asserts because it runs inside an EXIT trap where a non-zero return would overwrite the harness's own status |
| 3 | **The port block belonged to the gate this harness extends.** The defaults were 8130/8131/8132/32530/5573 — five ports held by `deploy/projection-rclone-comparison-gate.sh`, and 8130 also by `deploy/projection-real-provider-gate.sh` — under a comment claiming that **no other gate can collide**. G22 is precisely the gate an operator runs beside this one | moved to 8170–8175 / 32550–32551 / 5576, and the pin cross-checks the block against every other gate in `deploy/` so the comment stays true |
| 4 | **Both teardown assertions passed on docker's own refusal.** `if ! docker run … test -d /mnt/Movies; then gone=1` cannot fail for the reason it states: `docker run` reports its own refusals as 125/126/127 before `test` executes an instruction, and the leading `!` scores every one of them as "the namespace is gone". The step whose entire subject is whether a FUSE mount was left behind passed hardest when nothing had been looked at | one `namespace_gone` helper for both arms: the probe prints `ns:present` / `ns:absent`, the loop reads the token, and a run that produced **neither** is a third outcome that **dies** rather than being counted as either |
| 5 | **`$WORK/out` was never created.** Every shared program is written into it — `jq.cjs`, `sha.cjs`, `corpus.cjs`, `probe.sh`, `leakcheck.sh`, the lot — and no `mkdir` in the harness made the directory. Under `set -e` the **first** `cat >` aborted the run, before an endpoint started or an arm existed | one `mkdir -p "$WORK/secret" "$WORK/out"`, and a pin that checks **every** `cat >` target in the file has a parent some earlier `mkdir -p` creates — counting the ancestors `-p` makes implicitly |
| 6 | **`sha.cjs` was written two hundred lines below the first thing that runs it.** The corpus step calls `digest`, and `digest` is `node "$REL/out/sha.cjs"`, so the step died with `MODULE_NOT_FOUND` | the program is written beside the `mkdir` that makes its directory, above the corpus step. The pin resolves each helper to the program its body runs and compares the write against the helper's first **call** — a definition that names a program is fine, a call before the write is not |
| 7 | **`mkdir -p "$WORK/arm-a/config.json"` made the daemon's configuration file a DIRECTORY**, so the `cat > "$WORK/arm-a/config.json"` below it could not write and **arm A could not start** | the path is out of the `mkdir` list, and a pin refuses any path that is made a directory and later written as a file. That pin has to join backslash continuations to work: the `mkdir` listed nine paths over three lines and `config.json` was on the third, so a per-line scan reads `mkdir -p`, sees the first argument, and never looks at the one that caused the bug |
| 8 | **The harness generated its own compose file into the repository root on every run and never removed it**, so a run left an untracked `docker-compose.projection-multi-frontend.yml` in the working tree — and the only description of the shared Postgres lived inside an 1,800-line script, where no reviewer reads a compose file and no diff shows it change. The gate root was **not gitignored** either, though it holds two throwaway endpoint credentials and three arms' caches, so an interrupted run left them where `git add -A` reaches | the compose file is committed and merely named, like every other `docker-compose.projection-*.yml` here, and the harness dies if it is missing rather than silently writing one; `.projection-multi-frontend-comparison-gate/` joins the other gate roots in `.gitignore`. `${...:-5515}` is resolved by docker compose itself, so nothing about the behaviour changed |
| 9 | **Six call sites handed `node` the absolute spelling of the run directory**, against the rule the harness's own header states — docker gets `$WORK`, node and tsx get `$REL`, "because an MSYS absolute path is not something a Windows node binary can open". A Windows node resolved `/c/Users/…` against the current drive and opened `C:\c\Users\…` | the six use `$REL`/`$ARM_REL`, and the pin allows a shell **redirection** of an absolute path (the shell opens that, not node) while refusing an absolute path as a node **argument**. Linux was never affected; the repository is developed on Windows, so this was the difference between iterating on the harness and not |

### Found by running it on the real host

Defects 1–9 were found by reading. These were not — each one needed the harness to actually execute on
Unraid, and each was invisible until the one before it was fixed.

| # | What was wrong | What it cost |
|---|---|---|
| 10 | **The credential assertion probed the one path that enforces no credential.** Arm A checked `/direct/<ref>` with a deliberately wrong bearer token and expected a refusal. `handleDirect` calls `serveRange` with **no auth check at all** — in direct mode the URL is the capability, and only `handleResolve` compares the Authorization header. The endpoint answered 206 exactly as designed and the harness died with "the endpoint served a ranged request with the wrong credential", an accusation aimed at a path that never made the promise. The R2 rotation checks had the same defect | a `resolveprobe.sh` against `/resolve` — the path the credential guards **and** the path the daemon calls in resolver mode, so it is what R2 actually rotates. It prints `resolve:<status>`, the gate demands 200 or 401, and a run that produced neither is refused. The status is extracted **by pattern**, because busybox prints its own `wget: server returned error: HTTP/1.1 401 …` line and taking `$2` of any HTTP-matching line yielded `resolve:server`. Arms B/C keep probing `/dav`, which does enforce on every request |
| 11 | **The daemon was started before generation 1 was published.** `start_daemon` ran thirty lines above the publish step, so the daemon came up against an empty manifest directory and exited 1 with `no generation could be admitted, so there is nothing to serve: pointer-unreadable`. The harness then waited out its full 120-second `await_path` budget for a namespace no live process was serving and reported **"the mount never became visible"** — true, and silent about why | publish first, then start the daemon, which is the order every gate that works uses |
| 12 | **It never migrated the database.** Compose brings up an empty Postgres owned by `postgres`; the `app` role the control plane connects as, and every table it writes, are created by `src/ops/migrate-cli.ts`. Without it the first `register` died with `password authentication failed for user "app"` — a message that points at credentials when the role had simply never been created | the migration runs immediately after Postgres reports healthy, as it does in every other gate here |

**AND ONE THAT WAS NOT A DEFECT IN THE HARNESS BUT IN WHAT COULD BE CHECKED ABOUT IT.** Both
operational-round writers were multi-line `node -e '…'` arguments. `parseShellSource` — the reader
`test/custody-runtime-closure.ts` runs over every shipped script under all three line endings — stops at the
unterminated quote, so **the whole file was unparseable and every test in this repository skipped over it**.
The program is now one quoted-heredoc `rounds.cjs` called from both sites, and the pin **runs it** rather than
grepping it: Phase 1 spent four dispatches on embedded programs that were only ever regexed, and every
dispatch found defects a regex could not see.

**#1, #2 and #4 are one defect wearing three hats** — a step that reports a result the product was never
consulted for, or a teardown that reports a cleanliness it never checked. It is the class Phase 1 found four
times in the TorBox gate's read-only refusals and Phase 2's mount-hardening tranche found four more times in
its own three gates. The answer is the same each time: **an assertion must fail when the product misbehaves
AND when the measurement does not happen.**

**#5, #6 AND #7 ARE A DIFFERENT AND PLAINER LESSON, AND IT IS THE MORE UNCOMFORTABLE ONE.** They are not
subtle reasoning errors about evidence; they are a missing `mkdir`, a statement in the wrong order, and a
file created as a directory. No amount of care in the prose finds them and no reviewer reading for
correctness-of-argument catches them, because the argument is fine — the code just never ran. **Every one of
them would have been found by executing the script once.** That is why all three are now pinned as
*classes* over the whole file rather than as three fixed lines, and why the suite executes the harness's
embedded programs instead of describing them.

**AND FIXING THESE MEASURES NOTHING.** §4 still reads NOT RUN. What changed is that the harness can now get
past its own first fifty lines, skip correctly, clean up after itself, run beside G22, and fail for the
reasons it names — which is the precondition for a first run, not a substitute for one.
