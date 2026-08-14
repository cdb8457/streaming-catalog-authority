# Projection Phase 7 — the operator-usable alpha

**Status: NO-GO — the contract in §2 to §10 was committed before the first measured run; §11 is what has been measured and §12 is the decision.**
Every arm, threshold, repetition rule, cleanup requirement and exclusion in §2 to §10 is predeclared and
**none has moved**. §11 is the run record. **No threshold in §4 may move after the first measured run**; a clause that measures FALSE is recorded as **superseded**, with what it said kept whole,
exactly as Phase 4 §4.1 and Phase 5 §3.3 did — never edited into agreement with a result.

**What Phase 7 is, in one sentence.** Phase 6's bounded automatic recovery, done to a mount that **three
real, digest-pinned media servers** are attached to and **playing real TorBox bytes through** — and then
asked to keep playing.

**Why that is a tranche and not a paragraph in Phase 6.** Phase 6 closed saying so itself, in §12.6: *"A
media server in a Phase 6 run. Every recovery arm here used an unprivileged byte-reading consumer. The three
servers are Phase 1 and Phase 3 evidence and have not been run against this supervisor."* Phase 2's worst
defect was `--auto-remount` recovering the namespace **for the daemon and for nobody else** — the daemon
logged success, `/readyz` said ready, and no consumer could see a file. A supervisor that calls that same
remount for a **second reason** inherits the whole of that risk, and the only instrument that has ever been
able to see it is a real consumer reading through its own bind afterwards.

**What it is not.** It is not a beta, not a release, not a marketplace package, not a second host, not a
second provider and not a performance claim. §10 is the full list and it is deliberately longer than §12.

---

## 1. What Phase 6 left, exactly

| What Phase 6 closed | What it left open, in its own words |
|---|---|
| bounded automatic recovery: reason-aware, budgeted, durable, refusing anything that is not its own | §12.6.2 — **no media server was in any Phase 6 run** |
| a mount point that survives a recovery | §9.7 — **a recovery usually STACKS OVER the corpse rather than removing it**, so a mount point that has survived several recoveries carries several dead layers. *Named as next work rather than done* |
| a probe that reports what is at the mount | §9.2 — **a wedged probe can outlive its mount**, which spends the budget and locks out. *Named as the next-work contract* |
| an operator command that installs, starts, checks and rolls back | §12.6.6 — **a rollback that survives losing the cache**, since the rollback target is recorded there |

Phase 7 takes the first two of those, measures the third rather than fixing it, and takes an explicit,
justified decision about the fourth in §8.

## 2. The topology, and it is two closed tranches' topologies with nothing new

**ONE** PostgreSQL, **ONE** publisher, **ONE** production `projectiond`, **ONE** FUSE mount, **ONE**
loopback-only TorBox resolver sharing the daemon's network namespace, and **THREE** real, digest-pinned media
servers — Plex, Jellyfin and Emby — each holding the **same** mount directory as the **same** Movies library
root, for the whole run.

It is **Phase 3's topology**, unchanged, with **Phase 6's daemon flags**: `--auto-remount --auto-recover`,
which is exactly what `docker-compose.projection-alpha.yml` ships.

| Piece | Where it comes from | Why not something new |
|---|---|---|
| the three media servers, their bootstraps, libraries, scans, catalogues, paced play, seeks and forced transcode | `src/ops/projection-{jellyfin,plex,emby}-dataplane-cli.ts`, **unchanged** | six of the Jellyfin gate's behavioural conclusions are false for Emby; a unified driver would inherit every one |
| the three-way scan observation | `src/ops/projection-three-server-concurrency-cli.ts`, `concurrent-scan` + `verify-overlap`, unchanged | whether three scans overlapped is a property of one clock watching three servers |
| the resolver, its loopback-only arrangement and the operator input contract | `deploy/projection-torbox-real-gate.sh` and `src/ops/torbox-resolver-cli.ts`, unchanged | it is the only arrangement that has ever contacted TorBox and survived a review |
| the recovery fault injectors and the status-surface reads | `deploy/projection-recovery-gate.sh`, in the same shapes | `RC4`'s stacked stale mount and `RC8`'s `/dev/fuse` mask are the two fault injectors this repository has ever got to work on this host |
| unmount propagation, run-directory removal, the cleanliness report | `deploy/projection-gate-cleanup.sh`, unchanged | `rm -rf` over a dead FUSE mount does not do what it looks like it does |
| every budget in §4 | `src/core/projection/phase7.ts`, imported | the budgets are code; this document restates none of them |

**THE NAMESPACE IS TWO ENTRIES AND BOTH ARE LOAD-BEARING**, exactly as Phase 3 §1 describes: the operator's
real object published under a path **this gate chooses**, so the operator's own label never reaches a media
server's database; and a local synthetic seed, which is the control — a fault aimed at the remote path must
not stop the local one, and a fault aimed at the mount must stop both.

**CONSUMER ATTACHMENT IS §11 OF THE PHASE 0 CONTRACT AND IT IS NOT NEGOTIABLE HERE.** All three media servers
bind the projected path **before the daemon has ever mounted there**, and `P7-A-consumers-pre-attached` is
the assertion. A gate that quietly attached them later would be tuning the experiment until it passed.

## 3. The stages and the arms, predeclared

A run is **six stages in a fixed order**. Stage D is six arms, also in a fixed order.

| Stage | What happens | What it exists to prove |
|---|---|---|
| **A — healthy baseline** | all three servers pre-attached, one daemon, one manifest generation, one real TorBox source; each independently discovers the admitted media and reads the operator's approved windows through the projected path, as its own uid, inside its own container | without this every arm below is satisfied by a supervisor that never acts and by three servers that never saw anything |
| **B — useful playback** | per server: a real scan/import, a **five-minute paced direct play**, **ten distinct media-time seeks** including backwards ones and one beyond 90 % of duration, and a **five-minute forced transcode** | "the operator can use it" is a claim about playback, and thirty decoded seconds does not support it |
| **C — concurrency** | all three servers active on the **same** mount and the **same** generation, with the three-way scan overlap observed on one clock and the three direct plays **overlapping in wall clock**, followed by catalogue and byte correctness | three servers taking turns is not three servers concurrent |
| **D — recovery** | the six arms below, **with the same three servers attached throughout**, each followed by a full byte, catalogue, churn, mount-topology and playback verification | this is the tranche |
| **E — mount topology** | the layer count at the projected mount point, **above the startup floor**, inspected before and after **every** arm and once at the end | Phase 6 §9.7. An appliance that grows a dead layer per fault eventually meets §9.6 with no operator involved |
| **F — operator workflow** | `preflight`/`status`/`upgrade`/`rollback`/`reset-recovery`/`stop` driven through the **shipped** `deploy/projection-alpha.sh`, with media consumers attached | an operator command that is only idempotent when nothing is using it is not idempotent |

### 3.1 The six arms

| Id | The failure | How it is caused | What is asserted beyond the shared per-arm verification |
|---|---|---|---|
| **R1** | **the mount is lost beneath a living daemon** | the daemon's own mount is unmounted from the host, leaving the mount point with no projectiond mount on it while the process keeps running | the observation goes non-live, readiness withholds, the recovery supervisor classifies it as **its own to repair**, spends **exactly one** attempt inside `RECOVERY_ACTION_BUDGET_MS`, and the namespace is readable by a sibling again inside `RECOVERY_READY_BUDGET_MS`. `recoveryReason` and `recoveryRemediation` are read from the shipped status surface, not inferred |
| **R2** | **a stale / corpse FUSE connection** | a second, short-lived `projectiond` mounts the same path and is SIGKILLed, leaving **its** corpse stacked above the subject's live mount — `RC4`'s own injector | the same six assertions as R1, plus that the corpse was **verified stale** (`statfs` answering ENOTCONN from a sibling while mountinfo still names `fuse.projectiond`) before anything was asserted about recovering from it |
| **R3** | **a provider outage past the hold and the breaker's budget, then restoration** | the resolver's own copy of the provider credential is made unreadable, so it answers 503 **without contacting TorBox at all**; restored mid-cooldown — Phase 3 `A4`'s injector | **THE CONTROL, AND ITS WHOLE ASSERTION IS AN ABSENCE**: reads fail inside the product's own deadline, the breaker opens, **zero** requests reach a live logging resolver during the hold, the first read after release digest-matches inside the outage budget — **and `recoveryGeneration` does not advance by even one**, because a provider outage never touches the mount |
| **R4** | **a serve-loop death, with exactly one supervisor acting** | the daemon's own FUSE connection is aborted through the kernel's teardown — Phase 3 `A3`'s injector, which is the only one that works with three media servers holding the mount | the serve-death supervisor remounts **in place**; the entry's inode, size and mtime are unchanged; **`recoveryGeneration` is unchanged**, because Phase 6 §3.2 declines `serve-loop-dead` on purpose; and **exactly one** remount is counted across both supervisors |
| **R5** | **a foreign overlay, refused** | a tmpfs is stacked above the live mount — `RC5`'s own injector | `recoveryReason=refuse-foreign-mount`, `recoveryRemediation=inspect-mount-owner`, `recoveryAttempts` and `recoveryGeneration` **both unchanged**, and the tmpfs is **asserted still mounted and byte-unmodified** afterwards. This is Phase 6's most important row and it is the one an operator's own bind depends on |
| **R6** | **an unrecoverable fault spending exactly the bounded budget** | `/dev/null` is bound over `/dev/fuse` **inside the subject container's own mount namespace** so every `Mount()` is refused, and then R1's fault is injected — `RC8`'s own injector | attempts go to exactly `RECOVERY_MAX_ATTEMPTS` with at least `RECOVERY_COOLDOWN_MS` between consecutive attempt starts; `recoveryState=locked-out` with `recoveryRemediation=reset-recovery-ledger`; the generation **does not advance** across `LOCKOUT_QUIET_WINDOW_MS`; the lockout **survives a container restart** on the first reading; and `--reset-recovery`, run after the cause is repaired, clears it and the appliance returns to ready |

### 3.2 What every arm carries, whatever it was

**THIS IS THE LIST THE TRANCHE EXISTS FOR**, and an arm that recovered without all of it has shown a daemon
recovering for itself:

1. the operator's **four approved windows**, digest-compared through the mount against values recorded
   **outside** it before any run;
2. an `lstat` saying an ordinary regular file at exactly the published size;
3. the local seed control still reading;
4. **each of the three servers reading the same four windows inside its own container as its own uid**;
5. **each of the three servers' catalogues** unchanged, with **zero** item churn;
6. the **mount-layer count above the startup floor**, at or under `MOUNT_LAYERS_ABOVE_FLOOR_MAX`;
7. the three servers' **binds unchanged** — same container ids, same mount source and target, never restarted,
   re-bound or re-created by the gate;
8. and, once per run after the last arm, **each of the three servers playing the object again** through the
   bind it has held since before the first mount.

## 4. The predeclared thresholds

**Every one is in `src/core/projection/phase7.ts` and this document restates none of them.**
`test/projection-phase7.ts` fails if the module, this table's derivations and the shipped gate disagree.

| Name | Value | Where it comes from |
|---|---|---|
| `ARMS_PER_RUN` | **6** | one per fault in §3.1. The arm list IS the stage list |
| `CONSECUTIVE_FRESH_RUNS` | **3** | **IMPORTED** from Phase 3. The repository's closure convention; one green run is a coincidence |
| `READY_BUDGET_MS` | **22,000** | **IMPORTED** from Phase 3, which derives it as the pointer poll plus one read deadline |
| `READ_FAIL_BUDGET_MS` | **20,000** | **IMPORTED** from Phase 3 (`READ_DEADLINE_MS`, straight) |
| `BREAKER_REFUSAL_BUDGET_MS` | **5,000** | **IMPORTED** from Phase 3 (`MAX_QUEUE_WAIT_MS`) |
| `OUTAGE_RECOVERY_BUDGET_MS` | **80,000** | **IMPORTED** from Phase 3 |
| `HOLD_RESOLVER_REQUESTS_MAX` | **0** | **IMPORTED** from Phase 3 |
| `HOLD_WINDOW_MS` | **30,000** | **IMPORTED** from Phase 3, which derives it as half the breaker cooldown so the half-open probe cannot land inside the window being measured |
| `HALF_OPEN_PROBES` | **1** | **IMPORTED** from Phase 3 |
| `LIBRARY_CHURN_MAX` | **0** | `PROJECTION_PHASE_1_BUDGETS.MAX_LIBRARY_CHURN_ITEMS` |
| `OPERATOR_WINDOWS_REQUIRED` | **4** | the operator's own `probeDigests`, recorded outside the mount |
| `PLAY_START_BUDGET_MS` | **10,000** | `MEDIA_SERVER_SOAK.MAX_STARTUP_SECONDS` — **G8's own ten seconds** |
| `PLAY_DECODED_SECONDS_MIN` | **300** | `MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS` — **G8's own five minutes of DECODED MEDIA TIME.** This is where Phase 7 differs from Phase 3, which chose thirty seconds and named both bounds for it. Phase 7's claim is that an operator can *use* this, and thirty decoded seconds does not support it |
| `TRANSCODE_DECODED_SECONDS_MIN` | **300** | `MEDIA_SERVER_SOAK.MIN_TRANSCODE_SECONDS` — **G10's own five minutes** |
| `SEEK_COUNT` | **10** | `MEDIA_SERVER_SOAK.SEEK_COUNT` — **G9's own ten positions**, with G9's own backward and deep-seek rules applied by G9's own verifier |
| `RECOVERY_ACTION_BUDGET_MS` | **33,000** | **DERIVED**, and the derivation is Phase 6 §3.3's own arithmetic: `MOUNT_FAULT_HOLD_MS` 6,000 (readiness must believe the fault) + `RECOVERY_SUSTAIN_MS` 6,000 (it must then sustain a second whole hold) + `RECOVERY_TICK_MS` 1,000 (the decision is taken on a tick) + `RECOVERY_ATTEMPT_DEADLINE_MS` 20,000 (the attempt may run to its deadline before it is counted) |
| `RECOVERY_READY_BUDGET_MS` | **59,000** | **DERIVED:** the whole action budget, plus `RECOVERY_CONFIRM_MS` 4,000 (before `ok` can be re-derived from an observation taken *after* the attempt), plus `READY_BUDGET_MS` 22,000 |
| `RECOVERY_MAX_ATTEMPTS` | **3** | `PROJECTIOND_MOUNT_RECOVERY.RECOVERY_MAX_ATTEMPTS`, straight |
| `RECOVERY_COOLDOWN_MS` | **20,000** | `PROJECTIOND_MOUNT_RECOVERY.RECOVERY_COOLDOWN_MS`, straight |
| `LOCKOUT_QUIET_WINDOW_MS` | **40,000** | **DERIVED:** two whole cooldowns, which is `RC9`'s own rule. One would be satisfied by a supervisor merely between attempts |
| `SINGLE_FLIGHT_ACTIONS_MAX` | **1** | Phase 6 §3.4's shape property, measured from outside with three media servers holding the mount |
| `MOUNT_LAYERS_ABOVE_FLOOR_MAX` | **1** | **THE ONE THRESHOLD PHASE 7 ADDS, AND IT IS EXPECTED TO BITE.** There is one namespace being served, so there is one live layer; every other layer is a dead one nobody can read through. Counted **above the floor of whatever was already mounted at the mount point before the daemon started**, never absolutely — in a container the mount point IS the operator's bind. Phase 6 §9.7 measured the opposite on this host and named removing them as next work |
| `MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END` | **1** | the same number at the end of the run, deliberately: a bound that grew with the arm count would be a bound on nothing |

**No threshold in this table may be weakened by a run.**

### 4.1 The closure rule

**Phase 7 closes when, and only when:**

1. `npm run go:phase7-gate:three` completes **three consecutive fresh runs, exit 0, zero failures, zero
   skips**, on the real Unraid host, **from one frozen commit, tree and image** whose `deploy/`,
   `projectiond/`, `src/` and compose bytes do not move afterwards — and if any of them do, **every affected
   gate is re-frozen and re-run**;
2. every one of the **6 arms** runs in each run, in the order §3.1 names, each with the full §3.2
   verification;
3. every stage-A, per-arm and stage-C byte check matches **all four** operator digests exactly;
4. all three frontends are **proven subjects throughout every run** — their own catalogue, their own
   in-container read, their own playback — and **their binds and container identities are unchanged from
   before the first mount to after the last arm**;
5. every recovery lands inside the budget §4 names for it, and every refusal spends **nothing**;
6. the mount-layer count is inside `MOUNT_LAYERS_ABOVE_FLOOR_MAX` after **every** arm and at the end;
7. the host's containers, networks, volumes and `fuse.projectiond` mountpoints are **the same sets** — not
   merely the same counts — before and after every run, and the gate root holds only bounded evidence;
8. no secret, stable reference, CDN host or operator label appears in anything the run preserves;
9. Phase 6's `go:recovery-gate:three`, the alpha install matrix and the seven-gate regression matrix are
   **re-run from the final frozen candidate** and are green with zero skips;
10. TypeScript, `gofmt`, `go vet`, every Go package, the focused Phase 4–7 suites, the evidence
    consistency and custody suites and the **full offline inventory** pass with zero failures, and every
    skip is enumerated.

**A skip is a failure for the `:three` wrapper**, as it is for every other gate here.

### 4.2 What makes this tranche a NO-GO

Predeclared, so that no result can be argued into a GO afterwards:

- **any required real-server behaviour simulated** — a `wget`, `curl` or `ffmpeg` standing in for a media
  server's own scan, play, seek or transcode, anywhere the contract asks for the server's behaviour;
- **evidence spanning changed shipped source** — the Phase 6 defect, and it costs a re-freeze and a re-run,
  not a rewording;
- **any run that skips anything**;
- **cleanup that differs from the pre-run sets**, in either direction;
- **fewer than three fresh complete passing sequences**;
- **a media server that had to be restarted, re-bound or re-created for a recovery to be visible to it** —
  that is Phase 2's worst defect wearing a workaround;
- **a mount-layer count outside `MOUNT_LAYERS_ABOVE_FLOOR_MAX` that is then argued to be acceptable** rather
  than fixed or recorded as a NO-GO.

**IF FULL CLOSURE CANNOT BE REACHED HONESTLY, THIS DOCUMENT RECORDS A NO-GO** naming the blocking arm
precisely, keeping every fix and every measurement. It does not manufacture closure.

## 5. Repetition, freshness and what a run may not inherit

**THREE CONSECUTIVE FRESH RUNS OF THE COMPLETE SEQUENCE, FROM THE SAME FROZEN CANDIDATE.**

**Fresh** means: a new run root, a new PostgreSQL with throwaway storage, a new manifest, a new cache
directory, new media-server configuration directories, new containers with new names, and a mount point that
has never been mounted. **It does not mean destroying provider evidence or unrelated state**: the operator's
input directory is read-only to this gate, the preserved evidence directory accumulates, and nothing outside
this task's own roots is touched.

**Why three runs of six arms and not one run of eighteen.** The question is whether the appliance survives a
fault *from a clean start*; a long single run answers whether it survives a fault while already degraded by
the last one. Three fresh runs also means three independent sets of media-server containers, so a single
unlucky container cannot take the whole record.

## 6. Evidence, secrets and the host

**What is preserved is bounded and redaction-checked.** `.projection-phase7-gate/evidence/` at mode 0700
holds one verdict log and one arm log per run, at 0600, carrying gate ids, gate-chosen labels, window
geometry, byte counts, elapsed times and verdicts. It **structurally cannot** hold a secret, a reference, a
URL or a provider filename — which is what makes it safe to preserve from a **failing** run, where the leak
scan has not run yet. A failing arm may additionally preserve the daemon's own log, which Phase 1 asserts
carries zero references, at 0600.

**The four operator inputs are read from `PROJECTION_TORBOX_INPUT_DIR`** (default
`/mnt/user/appdata/catalog/secrets/real-provider/torbox`), copied into a 0700 run directory at 0600, never
moved, never widened and **never written back**. With any of them missing the gate **exits 77 before an image
is built, a database is started or a packet is sent**, and a skip closes nothing.

**The leak search** runs over the manifest directory, the probe cache, all three media servers' library state
and the preserved evidence, for the API key, the gate secret, the stable reference, the operator's label and
the CDN host, in the shared `leakcheck.sh` shape: needles arrive as a **file path** rather than in argv, a
non-match and a failure-to-look are different outcomes, and a hit names the needle by index and never prints
it. The manifest is searched for everything except the one field it carries by contract, and that exception
is **paid for** by a placement assertion rather than waived.

**The CDN origin is in the daemon's own configuration file by construction**, inside the 0700 run directory,
because the daemon cannot enforce an egress allowlist it has not been told.

**The host is left as it was found, and that is asserted rather than reported.** Container, network, volume
and mountpoint **sets** are captured before and after; the success path cleans up explicitly and asserts the
result; the EXIT trap is the failure path's cleanup and can only report.

**NOTHING OUTSIDE THIS TASK'S OWN ROOTS IS TOUCHED.** No production mount, no existing media library, no user
share, no unrelated container, network or volume, and no operator secret is modified. The TorBox corpus is
read and never written.

## 7. The provider-origin blocker, named before it happens

Phase 3 §11 spent seven attempts on this and Phase 1 §6.16 met it first: **TorBox serves its CDN from a pool
and moves between members**, and the daemon refuses a resolved URL whose origin the operator has not
allowlisted. That is the egress allowlist doing the one job it exists for and it is **never a product
defect**.

**PHASE 7 IS MORE EXPOSED TO IT THAN PHASE 3 WAS**, and saying so before a run is the point: a Phase 7 run is
longer than a Phase 3 run, so a three-run sequence spends more wall clock inside a rotation window whose
observed stretches ran from about forty minutes to at least eighty-four.

**What this tranche does about it, predeclared:**

- `deploy/projection-provider-origin-recheck.sh` is run **immediately before** each sequence and its verdict
  is recorded, digests only, in the run record;
- a run that dies on the allowlist is recorded as **BLOCKED, not failed**, with the recheck's own verdict
  beside it, and **does not count** toward the three consecutive fresh runs in either direction;
- **no automated part of this tranche writes `endpoint.json` on its own initiative.** Refreshing the allowlist
  is the operator's decision and Phase 3 §11.2's reasoning is unchanged. If the current origin is disallowed
  the gate emits a **digest and a count only** and asks. **It asked, and §11.13 is the answer it got** — the
  operator authorised one origin to be added, and the paragraph below is what that changes about this rule and
  what it deliberately does not.

**THE UNCONDITIONAL FORM OF THAT BULLET IS RETIRED, AND IT IS QUOTED HERE RATHER THAN DELETED**, because a
record that edits away the sentence it turned out to overreach on is a record nobody can audit. As written
before any run, this document said:

> **this tranche does not write `endpoint.json`.** Refreshing the allowlist is the operator's decision and
> Phase 3 §11.2's reasoning is unchanged. If the current origin is disallowed the gate emits a **digest and a
> count only** and asks.

**TWO OF ITS THREE CLAUSES ARE UNTOUCHED AND ONE IS NOW FALSE AS PHRASED.** Refreshing the allowlist is still
the operator's decision — that is precisely why §11.13 records an operator authorisation and not a gate
deciding for itself — and the gate still emits a digest and a count and asks. What is false is the flat
denial: on 2026-08-13 the file *was* written, once, **on explicit operator instruction naming this exact
change**, by a purpose-built operator action that is not part of any gate and that no gate can invoke. **The
distinction being kept here is the one that matters: a tranche that widens its own allowlist to make its own
gate pass has marked its own homework.** §11.13 is written so that a reader can tell which of the two
happened, and the allowlist was **widened by exactly one origin and nothing else was relaxed** — no
`allowInsecureHttp`, no `allowPrivateAddresses`, no origin removed, no assertion softened anywhere.

## 8. The two rough edges Phase 6 named, and what Phase 7 does about each

### 8.1 Corpse stacking — **FIXED, and the fix is in the frozen candidate**

Phase 6 §9.7 measured that a recovery stacks over the corpse rather than removing it, and attributed it to
`ProbeMountpoint` answering about the **bottom** of the stack. That attribution is correct and the fix is one
row: `planRemountCleanup` now also reads what is **on top**, and when the top is this daemon's own dead mount
it drains — through the drain that was already written, already floored at the count of mounts taken before
this process mounted anything, already refusing to remove anything whose top type is not ours, already
refusing to act at all on an unmeasured floor or an unreadable mount table, and already capped.

**A FOREIGN MOUNT ON TOP STILL PLANS NOTHING**, which is `--auto-remount`'s own rule, and three Go tests pin
it; the first fails against the previous body with the reason printed.

`MOUNT_LAYERS_ABOVE_FLOOR_MAX` in §4 is what turns that from a claim into a measurement, on a real host, with
three media servers attached.

### 8.2 A wedged probe — **INVESTIGATED, NOT FIXED, AND §11 RECORDS WHAT WAS LOOKED FOR**

Phase 6 §9.2: a probe parked in an uninterruptible `statfs` releases only when the connection is torn down,
the sampler is single-flight by construction, and a recovery that remounts *around* such a probe can leave
the observation permanently unavailable — which spends the budget and locks out. The named fix is for
recovery to abort the daemon's **own** FUSE connection first, which is a **new destructive capability**.

**PHASE 7 DOES NOT SHIP THAT CAPABILITY UNLESS A MEASURED RUN REQUIRES IT**, and that is a bounded decision
rather than a deferral: none of the six arms in §3.1 produces a wedge by construction — R1's mount is gone,
R2's and R6's corpses answer `statfs` with ENOTCONN immediately, R3 never touches the mount, R4's connection
is torn down by the injector itself, and R5's overlay is a live tmpfs. If a run nonetheless wedges, the
smallest safe owner-verified abort-first fix is implemented, pinned offline, **re-frozen, and every affected
gate re-run**. §11 records which of those happened.

### 8.3 Rollback and cache loss — **AN EXPLICIT ALPHA LIMITATION, WITH THE DECISION TAKEN HERE**

Phase 6 §12.6.6 names it: the rollback target is recorded in the cache directory, so an operator who loses
the cache loses the ability to roll back to the digest `upgrade` recorded.

**THE PHASE 7 DECISION IS TO LEAVE IT AND SAY SO, AND THE REASONING IS NOT CONVENIENCE.** The rollback target
is an **image digest**, and every place it could be moved to is worse:

- a second copy outside the cache is a second source of truth for the one fact that must not be ambiguous
  during an incident;
- the manifest directory is the control plane's and the appliance deliberately does not claim it (Phase 6
  `AA3` is a defect fixed in exactly that direction);
- recording it in the compose file makes the operator's own file mutable by the appliance.

**What Phase 7 does instead is make the failure legible rather than silent**: `P7-F-upgrade-recorded-rollback-target`
asserts the target is recorded **before** anything changes, `P7-F-rollback-returned` asserts it is honoured,
and §12 carries the limitation with the operator instruction that pays for it — **an operator who has lost
the cache rolls back by naming the previous digest in `PROJECTIOND_ALPHA_IMAGE` and running `start`**, which
is the same action `rollback` performs and needs nothing durable at all.

## 8.4 THE CLASSIFICATION DECISION — TAKEN HERE, AND THIS SECTION IS ITS CONTRACT

**THIS SECTION WAS WRITTEN AND COMMITTED BEFORE THE FIRST RERUN THAT MEASURES IT.** It is a contract in the
same sense §2 to §10 are: everything below is predeclared, and §11 will say what happened.

**WHAT §11.3.2 FOUND, RESTATED IN ONE PARAGRAPH SO THIS SECTION STANDS ALONE.** When the projectiond mount is
removed from beneath a living daemon, what remains at the mount point **inside the container** is the
operator's own bind, whose file-system type on an Unraid host is the host's `fuse.shfs`. `ObserveMountpoint`
answers **foreign**, Phase 6 §3.2's only row for `mount-observed-not-live` + `foreign` is a **refusal**, and
`recover-mount-empty` — the row that table has for exactly this fault — **was unreachable in the topology the
alpha ships in.** The refusal was correct as written. The appliance did not repair the single most likely
operator-side accident there is, and §12 recorded that as the first blocker.

**§11.3.2 NAMED THIS AS THE DECISION PHASE 8 OWED AND GAVE THREE REASONS FOR NOT TAKING IT THEN**, all three
of which were about that session rather than about the design: a third edit to the mount lifecycle in one
sitting, a closed tranche's published table, and no unblocked instrument. **THE DECISION IS TAKEN NOW**, and
the reasoning §11.3.2 wrote down is the reasoning it is taken on: the recovery action here is a **stack**, not
an unmount, and stacking over the operator's bind is what this daemon does at startup, over that same bind,
every single time it starts.

### 8.4.1 The question the daemon now asks, and it is not the one §11.3.2 sketched

§11.3.2 proposed the **count**: if the number of mounts at the mount point is at or below `mountsAtStartup`,
nothing of ours is there and nothing has been stacked on us. **THAT IS NOT ENOUGH AND THIS TRANCHE'S OWN
DEFECT #5 IS WHY.** A count cannot tell an attachment from a different attachment of the same shape: an
operator who detached and reattached their own share leaves the same count of the same type at the same path,
and a daemon that mounted over it on the strength of a count would be mounting over something nobody had
identified. Defect #5 was exactly this class — "above the floor and of our type" describing two different
mounts — and it destroyed the thing it was protecting.

**SO THE QUESTION IS IDENTITY, AND IT IS ASKED OF THE WHOLE STACK:**

> **IS THE MOUNT POINT, RIGHT NOW, IN EXACTLY THE STATE THAT WAS FINGERPRINTED BEFORE THIS PROCESS MOUNTED
> ANYTHING?**

The fingerprint is the **ordered list of every mount row at that one path**, each row identified by its
**mount id, parent mount id, device, subtree root, mount point, propagation relationship, file-system type and
source**. It is taken **once**, at startup, **before the first `Mount()`** — beside the `mountsAtStartup` count
and from the same mount table — so it is a measurement of what the **operator** attached, taken before this
daemon could have contributed anything to it.

**IT IS HELD IN MEMORY FOR THE LIFE OF ONE PROCESS AND IS NEVER WRITTEN DOWN.** A durable copy would be wrong
on its face: mount ids are assigned by the running kernel, so a fingerprint that survived a reboot would
authorise a comparison against numbers that had stopped meaning anything.

### 8.4.2 The four verdicts, and exactly one of them admits anything

`recoveryUnderlay` is a new closed set on the shipped status surface, predeclared in
`PROJECTIOND_MOUNT_RECOVERY.UNDERLAY_VERDICTS`:

| Verdict | What it means | What it authorises |
|---|---|---|
| **`underlay-exposed`** | the same rows, in the same order, each the same attachment, and **nothing above them** — the projectiond mount that covered them is gone | **THE ONLY ADMITTING VALUE.** The recovery `recover-mount-underlay` |
| `underlay-covered` | the fingerprinted rows are all still there and unchanged, and **something is on top of them** | **nothing.** It is what a healthy serving daemon reports every second of its life, and equally what a stacked tmpfs, a foreign overlay or a second daemon's corpse reports — the verdict cannot separate those, which is why it authorises nothing |
| `underlay-changed` | a fingerprinted row was **removed from underneath**, or is a **different attachment** | **nothing.** A re-mounted bind of the same share gets a new mount id, so an operator who detached and reattached their own storage is refused |
| `underlay-unknown` | the mount table could not be read — at startup, or now — or the two startup measurements disagreed with each other | **nothing.** Failing closed: a supervisor that cannot see what is under it does not mount over it |

**THE SAFETY CONTRACT, CLAUSE BY CLAUSE, AND EACH ONE IS PINNED BY A TEST THAT FAILS AGAINST ITS ABSENCE:**

1. **`fuse.shfs` IS NOT TRUSTED AND NEITHER IS ANY OTHER TYPE.** The file-system type is **not consulted** by
   this decision at all. A tmpfs is not refused for being a tmpfs and a bind is not admitted for being a bind.
2. **THE VERDICT IS READ ON EXACTLY ONE ROW OF THE CLASSIFICATION TABLE** —
   `mount-observed-not-live` + `foreign` — and there it can only ever turn a refusal into an action. No other
   row reads it, and no value of it can turn an action into a refusal or one refusal into another.
3. **R5 IS UNTOUCHED AND IS STILL THE MOST IMPORTANT ROW.** A tmpfs stacked above the live mount answers
   `underlay-covered` on the row count, before any identity is compared, so it still produces
   `refuse-foreign-mount` / `inspect-mount-owner`, still spends nothing, and is still asserted **mounted and
   byte-unmodified** afterwards. Phase 6 `AA6` and `RC5` assert the same thing and are re-run.
4. **NOTHING IS EVER UNMOUNTED ON THIS PATH.** The cleanup plan for a foreign observation is `nothing` and
   stays `nothing`; the corpse drain is not reached; the operator's bind is never touched, lazily or otherwise.
   The action is a `Mount()` over it, which is the startup path.
5. **THE EVIDENCE IS RE-TAKEN AT THE MOMENT THE BUDGET IS SPENT**, not only when the decision is made. If
   something is stacked on the mount point in between, the re-classification answers `refuse-foreign-mount`,
   which is not the class the attempt was authorised for, and **nothing is spent and nothing is done**.
6. **THE VERDICT CANNOT BLOCK.** It is derived from `/proc/self/mountinfo` alone — procfs is not served by a
   FUSE connection — which is why it is taken **fresh** on the decision path instead of read from a sampler.
   The `statfs`-bearing observation is sampled on its own cadence exactly as before.
7. **AN UNWIRED VERIFIER REFUSES.** A daemon with nothing wired answers `underlay-unknown` for ever.

### 8.4.3 What this adds to the published surface, and it is deliberately small

- **ONE additive decision code**, `recover-mount-underlay`. It is additive rather than a reuse of
  `recover-mount-empty` because the two are **different observations**: `empty` means the mount point had
  nothing on it, and this means the operator's own bind is there and uncovered. An operator told `empty` about
  a mount point that is not empty has been told something false.
- **TWO additive status fields**, `recoveryUnderlay` (the closed-set verdict) and `recoveryUnderlayDigest` (a
  twelve-character sha256 prefix over the fingerprinted identity). The digest is the **only** field on that
  surface that is not a code or a number, and it is admitted for one reason: it lets a gate assert **from
  outside the process** that the attachment the daemon mounted over after a recovery is the one it
  fingerprinted before the first mount. It is not reversible and cannot match a leak-scan needle.
- **NOTHING IS RENAMED, REMOVED OR REDEFINED.** Every code, state, remediation and field every closed gate was
  measured against means what it meant.

### 8.4.4 THE SUPERSEDED R1 CLAUSE IS REINSTATED, WORD FOR WORD, AND THAT IS NOT A THRESHOLD MOVING

§11.3.2 recorded §3.1's R1 clause as **SUPERSEDED** because it asked for a state a daemon obeying Phase 6
§3.2's table could not produce in a container. **THE CLAUSE IS NOW REINSTATED UNCHANGED**, and the direction
matters: the clause was not edited to fit a result, the **product** was changed so that the clause is
answerable. §11.3.2's blockquote stays exactly where it is, as the history of what was measured against the
daemon that could not distinguish.

**A REINSTATEMENT IS ONLY HONEST IF IT IS HARDER THAN THE ORIGINAL, SO R1 NOW ASSERTS MORE THAN IT DID:** in
addition to every clause it already had, the arm asserts that before the fault the daemon reports
`underlay-covered` with a **non-empty** fingerprint, that the action it takes is named
**`recover-mount-underlay`** and not any other recovery, and that the fingerprint is **identical** before the
fault and after the recovery.

### 8.4.5 THE VERDICT IS PAIRED WITH THE OBSERVATION IT IS CLASSIFIED AGAINST — CORRECTED AFTER A MEASURED RUN

**THIS CLAUSE REPLACES A SENTENCE §8.4.2 GOT WRONG, AND THE RUN THAT FOUND IT IS §11.12.** §8.4.2 clause 6
said the verdict is taken **fresh** on the decision path, and gave a good reason: it reads
`/proc/self/mountinfo` and cannot block. What it did not consider is what the verdict is paired **with**.

**WHAT A FRESH VERDICT PAIRED WITH A SAMPLED OBSERVATION PRODUCED.** The instant a recovery's remount lands,
the fresh verdict becomes `underlay-covered` — this daemon's own new mount is on top of the operator's bind —
while the last **completed** observation is still the `foreign` one that authorised the recovery a moment
earlier. That pair is a refusal, so the surface published `refuse-foreign-mount` with remediation
`inspect-mount-owner` **about a mount point the daemon had just repaired**. Nothing was spent and nothing was
done, so it is a **reporting** defect — and this surface's whole value is that an operator can read it at any
instant, which a transient false refusal destroys. `P7-R1-remediation` measured it on the first run of the arm
that had never previously got far enough to reach it.

**THE CORRECTION IS THE ONE THE REST OF THIS DAEMON ALREADY MAKES.** `readinessInputs` and `recoveryInputs` are
both gathered once, because a verdict assembled from three instants is a verdict about an instant that never
existed. So the underlay verdict is now taken **by the sampler, beside the observation, in the same call** —
it adds nothing that can block, because the `statfs` was always the only thing that could — and the
classification reads the pair.

**AND THE FRESHNESS IS NOT LOST, IT MOVED TO WHERE IT PAYS FOR SOMETHING.** The sampled pair may name a class
and publish a state; a **live** read is what may authorise an **act**. `RecoveryBeginAttempt` re-verifies the
verdict live, in the same place it re-checks the class, and refuses with `refuse-foreign-mount` if the mount
point has changed under it — so nothing is ever mounted over on evidence up to a tick old. **The safety
property is strictly stronger than §8.4.2 clause 6 described and the reporting defect is gone.**

## 8.5 THE MOUNT-LAYER RESIDUAL ON THE DRAIN PATH — FIXED THERE, AND `MOUNT_LAYERS_ABOVE_FLOOR_MAX` DOES NOT MOVE

**READ §8.5.1 BEFORE READING THIS SECTION AS A CLOSED SUBJECT.** What follows was written before attempt 7,
and attempt 7 measured a **second** live layer arriving on a path this fix cannot reach. The heading of this
section used to say **FIXED** without qualification; the unqualified form is retired and quoted at §8.5.1
rather than deleted. Everything below is still true about the path it names.

§11.4.2 measured the layer count going `now 3` → `now 4` across successive faults once the corpse drain became
reachable. The dead layers go; what accumulated was a **live** one — when the fault was **somebody else's**
corpse, this daemon's own mount was never broken, so the drain removed the corpse and the remount then stacked
a second live layer over a first that was still connected. `MOUNT_LAYERS_ABOVE_FLOOR_MAX` is **1** and that
would measure **2**.

**THE FIX IS THE ONE §11.4.2 NAMED AND IT IS FIVE CONDITIONS, ALL NECESSARY.** After a drain that removed
something, the supervisor skips the mount syscall when — and only when — the drain **removed** something, the
**serve loop did not die** (a fact about which supervisor called, not a claim about the mount), the mount point
**observes as our own live mount**, the row count is a **measurement**, and that count is at or under **one**
layer above the measured startup floor.

**SKIPPING A MOUNT CANNOT DESTROY ANYTHING**, which is what makes this the safe direction to be wrong in: if
the observation were wrong, readiness withholds on the very next sample, the fault has not been cleared, and
the supervisor comes back for it with its budget intact. **The threshold is unchanged and it is still expected
to bite.**

### 8.5.1 AND IT BIT, ON A PATH THIS FIX DOES NOT COVER — MEASURED IN ATTEMPT 7

**THE UNQUALIFIED HEADING IS RETIRED AND KEPT, BECAUSE A SECTION THAT QUIETLY LOSES THE WORD IT WAS WRONG
ABOUT IS A SECTION NOBODY CAN AUDIT.** As written before attempt 7 this section was headed:

> **8.5 THE MOUNT-LAYER RESIDUAL — FIXED, AND `MOUNT_LAYERS_ABOVE_FLOOR_MAX` DOES NOT MOVE**

**THE SECOND HALF IS UNTOUCHED AND THE FIRST HALF WAS TOO BROAD.** `MOUNT_LAYERS_ABOVE_FLOOR_MAX` is still
**1**, has never moved, and is not going to be moved to accommodate this; §4.2 forbids exactly that and §12
records the consequence as a NO-GO instead. What the heading over-claimed is the scope of the repair: the five
conditions above are reached **only after a drain that removed something**, and attempt 7 measured a second
live layer arriving during arm **R3 — a provider outage, which drains nothing and in which the recovery
supervisor demonstrably did nothing at all.**

**THE NUMBERS ARE IN §11.3.5 AND THE DEFECT ROW IS §11.4 #16**, together with the one hypothesis the evidence
supports and the one diagnostic that would settle it. **What must not happen next is the thing this section
already did once**: declaring the residual fixed on the strength of arms that never exhibited it. R1 and R2
measured `1/1` before the fix and `1/1` after it, and neither reading was ever evidence about R3.

## 8.6 `RC8`'S PREMISE, AND WHY REPAIRING THE INJECTOR IS NOT LOOSENING THE ASSERTION

§11.4.1 measured Phase 6's `RC8`/`RC9`/`RC11` failing with `no-action-healthy` from the Phase 7 candidate,
because the corpse drain now repairs their fault **without any mount syscall succeeding** — the gate asserts a
state its own injector can no longer produce. §11.4.1 also says what may not be done about it: *"Loosening
`RC8` to accept the new behaviour would be editing a closed tranche's assertion to fit a result."*

**SO THE ASSERTIONS ARE UNTOUCHED AND THE INJECTOR IS REPAIRED.** `RC8`'s fault becomes the one fault on this
appliance whose repair genuinely requires a successful mount: the subject's **own** mount lazily detached under
a masked `/dev/fuse`, leaving the operator's bind and nothing else — no corpse to drain, nothing of ours to
unmount, and `Mount()` the whole of the repair. §8.4 is what makes that state actionable at all; before it the
supervisor refused it as foreign.

**THE ONE THING THAT HAD TO BE ARRANGED IS THE SERVE LOOP SURVIVING**, which is why Phase 6 §4 avoided the
subject's own death in the first place. `umount -l` leaves the FUSE superblock alive for as long as anything
references it, so the gate's pre-attached consumer holds an **open descriptor** on a file inside the mount
first — which is what the three media servers do by accident in the Phase 7 topology, where R1 measured this
fault twice leaving the daemon `Up` throughout. If the connection went down anyway the serve supervisor would
own the fault, and both arms **say so and fail** rather than reporting a budget nobody spent.

**PHASE 7'S OWN R6 CHANGES THE SAME WAY, AND IN ITS CASE THE CHANGE MAKES THE GATE MATCH THE CONTRACT.** §3.1's
R6 row has said *"and then R1's fault is injected"* since before the first measured run; the gate stacked a
corpse instead. The gate now does what §3.1 predeclared.

## 8.7 THE LAYER THAT ARRIVES WHEN THE DAEMON IS REPLACED — THE CONTRACT, WRITTEN BEFORE THE RUN THAT MEASURES IT

**THIS SECTION WAS WRITTEN AND COMMITTED BEFORE THE FIRST RERUN THAT MEASURES IT**, exactly as §8.4 was, and
for the same reason: §8.5 called a residual FIXED on the strength of arms that had never exhibited it, and
§8.5.1 is the retraction. **Nothing below is a claim that #16 is fixed.** It is what the product now does, what
the instrument now asserts, and what a run would have to show before anybody may say the word.

### 8.7.1 What #16 actually is, and it is one operation rather than an arm

**THE MEASUREMENT IS §11.3.5's AND IT IS NOT IN DISPUTE.** `P7-arm-layers` read **1** before R3 and **2**
after it, in **both** namespaces, and stayed 2 through R4 and R5 — while `recoveryGeneration` never left 2,
`P7-R3-no-recovery-action` measured **0/0** and `P7-R3-mount-untouched` passed. The same three arms measured
the same two numbers in attempt 5. §11.3.5 recorded one hypothesis and one diagnostic and refused to go
further, which was right.

**THE HYPOTHESIS IT NAMED IS NOT WHAT THIS IS.** §11.3.5 supposed a serve-loop death repaired by the
serve-death supervisor, which every assertion R3 makes is blind to. That is a real blind spot and §8.7.3
closes it — but it is not the mechanism, and the mechanism is simpler and is visible in committed source
rather than in a log nobody kept:

1. **ARM R3 REPLACES THE DAEMON, AND IT IS THE ONLY ARM THAT DOES.** The provider lease is memory-only by
   contract, so the only way to make an outage visible to a source that already holds one is to restart the
   process. The arm says so in its own comment and has since it was written.
2. **THE GATE REPLACED IT WITH `docker rm -f`, WHICH IS A `SIGKILL`.** The daemon got no instant in which to
   remove its own mount.
3. **AT A MOUNT POINT WHOSE PROPAGATION IS `rshared`, THAT MOUNT SURVIVES.** Destroying a mount namespace is
   not an unmount and does not propagate one, so the row stays in the host's table with its FUSE transport
   dead. This is not a new discovery: it is precisely how `deploy/projection-stale-mount-gate.sh` MANUFACTURES
   a corpse — `docker kill -s 9`, and the corpse is still there afterwards — and Phase 2 closed on it.
4. **AND THE REPLACEMENT DAEMON STACKS OVER IT, BY DESIGN, AND SAYS SO.** `stale projectiond mount detected at
   <mount point>` / `stacking over the stale mount (default); clear it with: umount -l <mount point>`. Two of
   ours at one mount point, and the new daemon's own `mountsAtStartup` floor is now **1**, so its drain may
   never remove the corpse: it is beneath the floor it measured, which is the rule that keeps the operator's
   bind safe.

**SO THE RESIDUAL IS NOT PRODUCED BY A FAULT, BY A SUPERVISOR OR BY AN ARM. IT IS PRODUCED BY STOPPING THE
DAEMON.** R6 restarts it twice more, which is why `P7-layers-at-end` is exposed to the same thing; #14's repair
already had to work around it with `projection_gate_unmount_run`, and nobody asked why that was necessary.

**AND STEP 3 IS THE ONE THIS SECTION IS NOT ALLOWED TO ASSERT WITHOUT A MEASUREMENT, SO IT IS A PROGRAM.**
`deploy/projection-mount-propagation-probe.sh` (`npm run go:mount-propagation-probe`) measures both halves of
it inside one throwaway privileged container, on a `tmpfs` of its own, touching nothing: a mount made in a
child mount namespace over an `rshared` mount point, whose namespace is then destroyed, and the same mount
removed by the process that made it with `MNT_DETACH` before it exits. **It asserts BOTH directions and it
FAILS if its control does not reproduce the defect** — a probe that only measured the repair would pass on a
kernel where the residual cannot happen at all, which is exactly the shape of evidence #13 was wrongly
resolved by. It uses `tmpfs` and not FUSE on purpose: the claim is about propagation, and a transport, a serve
loop and a corpse would be three things the measurement does not need. §11.15 records what it said.

### 8.7.2 The product change, and the ownership proof is an identity rather than a shape

**THE REPAIR IS AT THE ONE END WHERE OWNERSHIP IS NOT A JUDGEMENT: THE PROCESS THAT MADE THE MOUNT REMOVES
IT.** On `SIGTERM` the daemon has always tried an ordinary unmount and, when that was refused — which is the
ORDINARY case in this topology, because three media servers hold descriptors inside the namespace — left the
mount standing and waited for a request loop that could not end. It now removes its own.

**WHAT AUTHORISES THE REMOVAL IS THE ROW, NOT THE SHAPE.** Immediately after each of this process's own
`Mount()` calls returns, the daemon records the mountinfo row that call created: mount id, parent mount id,
device, subtree root, mount point, propagation, file-system type and source. At shutdown it removes the top of
the stack **only if that row is byte-for-byte the one it recorded**. A mount id is unique among live mounts, so
nothing else can match — not a re-mounted bind of the same share, not a second projectiond mount of the same
namespace, not a tmpfs, and not the operator's own bind.

**THE IDENTITY IS "KNOWN" ONLY UNDER §8.4's OWN EVIDENCE**, and every other state answers UNKNOWN, which
authorises nothing: the startup fingerprint must exist, the mount table must read, the stack must be the
predeclared underlay with **exactly one** row above it (`underlay-covered` on identity and not on a count), and
that row must be of our own type — which is the weakest of the four and is checked last on purpose, because
`IsOurMountType` is necessary and has never been sufficient.

**THE SAFETY CONTRACT, CLAUSE BY CLAUSE, AND EACH IS PINNED BY A TEST THAT FAILS AGAINST ITS ABSENCE:**

1. **THE POLITE FORM IS TRIED FIRST, ALWAYS.** The detach is reached only when an ordinary unmount has been
   **refused**. On every path where the ordinary form works, this decision changes nothing at all.
2. **AT MOST ONE ROW IS EVER REMOVED, AND ONLY THE ONE THIS PROCESS MADE.** There is no loop, no cap to reach
   and no floor to argue about, because the decision is not about a count.
3. **THE FILE-SYSTEM TYPE IS NEVER THE EVIDENCE.** A second `fuse.projectiond` mount of a different attachment
   is refused by the same comparison that refuses a tmpfs.
4. **R5 IS UNTOUCHED.** With a foreign overlay on top, the row on top is not ours and the answer is no.
5. **NOTHING IS EVER ABORTED.** §8.2's abort-first capability is still not shipped and its absence is pinned:
   a lazy detach removes a mount from the namespace and leaves every open descriptor working, which is the
   opposite of tearing the transport out from under a consumer.
6. **AN UNPROVED IDENTITY REMOVES NOTHING.** A daemon that starts INTO the defect — two of ours already at its
   mount point — cannot prove which row is its own and therefore removes nothing on the way out either. It
   fails closed rather than guessing.
7. **THE WAIT IS BOUNDED AND THE CLEANUP IS NOT.** A lazily detached FUSE mount keeps its super-block while a
   consumer holds a descriptor inside it, so the request loop may outlive the shutdown by design. The row is
   already gone by then, which is the only part the next daemon or an operator can see.

**AND THE HALF THIS DOES NOT FIX IS SAID HERE RATHER THAN LEFT TO BE DISCOVERED.** A daemon that is **killed
outright** still leaves its mount behind: nothing inside a process can clean up after a `SIGKILL`, and the two
places that could — a drain at startup, or the shipped operator command — are both refused, the first because
inside a container the row Docker binds after a hard kill **is** the corpse (detaching it strands the mount
point in the container's own root with no host peer, which is Phase 2's worst defect reached from the other
direction) and the second because `deploy/projection-alpha.sh` already decided, in writing and before this
tranche, that *"unmounting something at the operator's mount point is the one action this whole tranche refuses
to take automatically"*. Its `preflight` names the state and prints `clear-stale-mount`. **That is an alpha
limitation, it is in §12, and it is not a threshold moving.**

### 8.7.3 The instrument change, and it removes an undeclared fault and adds four assertions

**`docker rm -f` IS NOT A RESTART, IT IS A CRASH, AND §3.1 DECLARES NO SUCH FAULT.** R3's fault is a provider
outage; R6's is a masked `/dev/fuse`. In both arms replacing the process is **setup**. The gate now stops the
daemon the way `deploy/projection-alpha.sh stop` does — `SIGTERM`, bounded — so what R3 measures is the
product and not an injection the contract never named. **§8.6 repaired `RC8`'s injector on exactly this
reasoning**, and the rule it stated applies here unchanged: the assertions are untouched and the injector is
what changes.

**AND IT LOOSENS NOTHING, BECAUSE THE ARM NOW ASSERTS FOUR THINGS IT NEVER HAS:**

| New assertion | What it measures | Why R3 did not have it |
|---|---|---|
| `P7-R3-restart-left-no-layer` | **zero** of ours at the mount point after the daemon stopped and **before** its replacement started | the residual was produced between two daemons and every existing assertion was taken during one of them |
| `P7-R3-no-serve-death` | the daemon's own log records **no** serve-loop death across the outage | §11.3.5's hypothesis, asserted instead of supposed |
| `P7-R3-single-flight` | remount starts across **BOTH** supervisors during the outage: **0** | `recoveryGeneration` and the `recovery:` log line are both blind to the serve-death path, so eight passing assertions could sit beside a remount nobody counted |
| the daemon's own log, kept on R3's failing path | what §11.3.5 said it needed and did not have | §11.4 #6 bought this for R1 and nothing bought it for R3 |

All three are in `PHASE7_ARM_DETAIL_GATE_IDS.R3`, so an absent one is a failed run and not a quiet omission.

### 8.7.4 What would have to be true before anybody says this is fixed

**THE STANDARD IS §8.5.1's, APPLIED TO ITSELF.** R1 and R2 measuring `1/1` is not evidence about this: they
never exhibited it. What settles it is **one complete sequence in which R3, R4, R5 and R6 all run and
`P7-arm-layers` reads at or under 1 at every one of them**, `P7-R3-restart-left-no-layer` passes, and
`P7-layers-at-end` passes after R6's two further restarts. **Until a run says that, #16 is a measurement with a
proposed fix and this section says so.** And a GO needs three of them, from one frozen candidate, which §4.1
clause 1 has always required and no run has ever produced.

## 9. The regression matrix

**Phase 7 changes `projectiond` — one row of `planRemountCleanup` — so every gate whose subject is the
daemon's mount lifecycle is re-run from the final frozen candidate.**

| Gate | Why it is in scope | Runs |
|---|---|---|
| `go:recovery-gate:three` | Phase 6. Its whole subject is the supervisor Phase 7 measures, and `RC4`/`RC5` are the two arms the drain change can reach | 3 |
| `go:stale-mount-gate:three` | Phase 2. A cold corpse is exactly what the changed row now drains | 3 |
| `go:serve-death-gate:three` | Phase 2. The remount path the change lives on | 3 |
| `go:mount-truth-gate:three` | Phase 4. `ObserveMountpoint` is now read by a second caller | 3 |
| `go:mount-health-gate:three` | Phase 5. The readiness policy the recovery loop reads | 3 |
| `go:sustained-outage-gate:three` | Phase 2. The control: a provider outage must still produce no recovery action and no drain | 3 |
| `go:publisher-mount-gate` | publishes through a real mount with the changed image | 1 |
| `go:rclone-comparison-gate` | Phase 2's comparison harness, revalidated against the changed image | 1 |
| `deploy/projection-alpha-acceptance.sh` | Phase 6's install matrix, driving the **shipped** operator command | 1 |

**Phase 3's reliability loop is in scope by the same test and is named rather than assumed:** its `A3` is a
serve-loop death, and the changed row is on that path. It is re-run **once** rather than three times, and
§11 says so plainly, because it spends the operator's metered account for a subject Phase 7's own `R4`
measures three times over with the same injector.

## 10. What this tranche does not claim

- **It adds no provider.** TorBox only, through the resolver Phase 1 closed against. Real-Debrid and Usenet
  have named contracts in Phase 6 §13 and a contract is not a feature.
- **It is one host.** Three green runs on a host that is not this one close nothing at all.
- **It closes no G-number** and re-closes nothing in Phases 1–6. The ~50-entry corpus is not here.
- **Per-server provider attribution is impossible with one shared daemon and is not claimed.** Three servers
  read one mount through one cache.
- **It is not a load test and no figure here is a performance claim.**
- **The forced transcode does not claim five minutes of encoder work.** Phase 1 measured the encoder
  finishing a short source in about 1.6 seconds and recorded it under that description; what is asserted is
  five minutes of paced, continuously consumed, decoded transcoded output.
- **A recovery is not an availability claim.** A bounded set of mount faults, a bounded number of times.
- **`rclone` is not the architecture.** ADR-002 is untouched.
- **It is an alpha.** §12's rough edges are real, not a formality.

## 11. Run record

**INCOMPLETE. THE TRANCHE HAS NOT CLOSED AND §12 IS A NO-GO.** What follows is what was measured, from
which frozen source, and what stopped each attempt. Every figure names the tree it came from.

### 11.1 The frozen candidates, and which measurement came from which

**THE CANDIDATE HAS MOVED SIX TIMES AND EACH MOVE IS RECORDED RATHER THAN GLOSSED**, because Phase 6's whole
correction was about a record that named one commit and published figures from three trees. **FIVE OF THE
SIX PRODUCED MEASUREMENTS, AND NO FIGURE IN §11 IS ATTRIBUTED TO A CANDIDATE THAT DID NOT PRODUCE IT.**

| # | Commit | Staged manifest | Image | What ran from it |
|---|---|---|---|---|
| 1 | `c35fee0f7922f5339245e6065a41078542e3e843` | `a762e4e6…` over **1,657** files, byte-identical in **both** directions | `sha256:83b529f04fc472fb91338adb4b29a53a06803c128a13ec9d4ee164bb07499707` | **NOTHING.** Superseded before any measured run, by the two closed-suite corrections of §11.6 |
| 2 | `79fc79d2db89737f4f79a18b75ce927895c28a79` | `d86db06c…` over **1,658** files, byte-identical in **both** directions | **the same** `sha256:83b529f0…`, rebuilt from the re-frozen tree | **attempt 1** (§11.2), **attempt 2** (§11.3, BLOCKED), and the **first** `go:recovery-gate:three`, which is where §11.4 #5 was found |
| 3 | `7cb02d5a3909a283ea2851275933ace2160184c7` | `0930f951…` over **1,658** files, byte-identical in **both** directions | `sha256:911df075be6fd8ce72f6a81d003645e019217a4893d3515ea04a728fb9c003e2` | the **second** `go:recovery-gate:three`, the **whole §11.7 regression matrix including the alpha install matrix**, and **attempt 3** (§11.3.1) |
| 4 | `2697ddeddb7eae51f8021714039bf49165200009` | `fe2e606c…`, byte-identical in **both** directions | **the same** `sha256:911df075…`, rebuilt from the re-frozen tree | **attempt 4** only (§11.3.2) |
| 5 | `d38e45a22b699c9f64d33dfc7fa3fbe2c26d957a` | `504a6c26…` over **1,660** files, byte-identical in **both** directions | `sha256:0ccb21304d5fb8338ce79bc96e6493d2b26e10b794e7d8cf5a65bdf6ed262037` | **attempt 5** (§11.3.3) — the first run that reached all six arms |
| 6 | `566d2afbd599f8b3c1f619be15614a6b343dc5dc` | `db1709d4…` over **1,660** files, byte-identical in **both** directions | `sha256:b7f80288aa882503754bc665cfa3bd51a288de21d951016fa7a9bcbf05c6f30f` | **attempt 6** (§11.3.4) |
| 7 | `eafe1720a29aa4ea3f88344eb88dbc8e7a2dfeb8` | `fdce811c…` over **1,660** files, byte-identical in **both** directions | **the same** `sha256:b7f80288…`, rebuilt from the re-frozen tree | the **whole §9 regression matrix, nine of nine** (§11.7.1) and the offline inventory of §11.5. **NO sequence attempt** — the provider served a disallowed origin for the whole of its life |
| **8** | **`f512b5656c26aa3f6bfe97d334f5d6367e0c5336`**, tree `61cf1b6c5443bf5e0358062d2fbf44877dd9ca40` | `fc64a0f7…` over **1,660** files, byte-identical in **both** directions | **the same** `sha256:b7f80288…`, rebuilt from the re-frozen tree | **attempt 7** (§11.3.5) — the first sequence attempt with the provider allowed, and the run that found §11.4 #16 |
| 9 | `3f3446f19bfce0c9c124de1edd6bf32384e10b88`, tree `6014753b1b99097810df3d20f4f97ce0c4334b34` | `0b509fcb…` over **1,661** files, byte-identical in **both** directions | **`sha256:d534ae139300a3bd731d1998be4d7e444078c405b17fe9e103757d2a91a7e4ac`** | the **first** §9 regression matrix carrying §8.7's daemon — **nine of nine** (§11.15). **NO sequence attempt**: the provider served a disallowed origin for the whole of its life |
| **10** | **`842b8f2c5d2dc36d6d955e367788f2d5a95ea1f5`**, tree `030a205559f2880545fd7233db38cf05c2f3a28e` | `62be988d…` over **1,662** files, byte-identical in **both** directions | **the same** `sha256:d534ae13…`, rebuilt from the re-frozen tree | the §9 matrix again, the mount-propagation probe on the Unraid kernel, and the offline inventory — §11.15 |

**THE STAGING PROOF IS THE ONE PHASE 6 DID NOT HAVE, AND IT IS SYMMETRIC.** `/mnt/user/appdata/catalog-p7`
was removed and recreated **empty**, `git archive <commit>` was extracted into it, and a sorted per-file
sha256 manifest was computed **independently on each side** — from the archive on the development host and
from the extracted tree on Tower. The two manifests hash to the same value, which is a stronger statement
than an empty diff in one direction.

**THE IMAGE HAS MOVED THREE TIMES, AND EACH MOVE IS A MEASUREMENT RATHER THAN AN ASSUMPTION.** Candidates 1 and 2
both rebuilt to `sha256:83b529f0…` and candidates 3 and 4 both rebuilt to `sha256:911df075…`. The single move
is between candidate 2 and candidate 3, which is the drain-liveness fix of §11.4 #5 — the only commit in this
tranche after the first freeze that touches `projectiond/`. Candidates 5 and 6 move it twice more —
`sha256:0ccb2130…` and `sha256:b7f80288…` — because each of them changes `projectiond/`, which is what §8.4, §8.4.5
and §8.5 are. Every one of the four digests differs from Phase 6's `sha256:a5f12b92…`, and they are supposed
to: this tranche changes the daemon.

### 11.1.1 The source digests, per candidate, because two of the three moved

**A SINGLE ROW OF DIGESTS WOULD BE THE PHASE 6 DEFECT AGAIN.** The operator source never moved; the gate
source moved twice and the daemon source once, so each is given against the candidate it belongs to.

| Candidate | OPERATOR SOURCE | GATE SOURCE (Phase 7) | `projectiond/` tree | image |
|---|---|---|---|---|
| 2 — `79fc79d` | `33005b52c9896455` | `87b7238355d25e89` | `4e4771110608b037` | `sha256:83b529f0…` |
| 3 — `7cb02d5` | `33005b52c9896455` | `87b7238355d25e89` | **`6a8a371f04ff113d`** | `sha256:911df075…` |
| 4 — `2697dde` | `33005b52c9896455` | **`23cb90f0b1d0f193`** | `6a8a371f04ff113d` | `sha256:911df075…` |
| 5 — `d38e45a` | **`6dbb238d51f6415f`** | **`98a7491602c200ca`** | **`0d7c371dc059c1cb`** | `sha256:0ccb2130…` |
| 6 — `566d2af` | `6dbb238d51f6415f` | **`96c12f0c1d116288`** | **`08d9e9af01203b34`** | `sha256:b7f80288…` |
| 7 — `eafe172` | `6dbb238d51f6415f` | **`ae419db2714d8616`** | `08d9e9af01203b34` | `sha256:b7f80288…` |
| **8 — `f512b56`** | `6dbb238d51f6415f` | `ae419db2714d8616` | `08d9e9af01203b34` | `sha256:b7f80288…` |
| 9 — `3f3446f` | `6dbb238d51f6415f` | **`2d5cef3f68c50455`** | **`93c515dd397e361a`** | **`sha256:d534ae13…`** |
| **10 — `842b8f2`** | `6dbb238d51f6415f` | **`76f2fe0d2bf5031f`** | `93c515dd397e361a` | `sha256:d534ae13…` |

**THE OPERATOR DIGEST COLUMN CHANGES SPELLING AT CANDIDATE 5 AND THE SOURCE IT COVERS DOES NOT.** Candidates 2
to 4 quote `33005b52c9896455`, computed by hand in the session that produced them and not reproducible from
anything committed. Candidates 5 and 6 quote `6dbb238d51f6415f`, which is the **same five files** under the
recipe `sourceDigest` in `test/projection-bounded-recovery.ts` implements — path, then LF-normalised content,
sorted, one sha256 — so a reader can re-derive it rather than take it. The two numbers are not comparable and
saying so is the point; what is checkable is that the operator source has not moved between candidates 5 and 6
and that the offline pin agrees with the number printed here.

**AND THE DAEMON MOVED ONCE MORE, AT CANDIDATE 9, WHICH IS §8.7.** `projectiond/` goes from `08d9e9af01203b34`
to `93c515dd397e361a` and the image from `sha256:b7f80288…` to `sha256:d534ae13…`. Candidate 10 rebuilds to the
**same image digest** from its own frozen tree and holds the same `projectiond/` tree, which is the check that
the daemon did **not** move between them: candidate 10 differs from candidate 9 in `deploy/` (a new probe and
the gate's settle loop), `test/`, `package.json` and `docs/`, and in nothing the daemon is.

**THE OPERATOR SOURCE DIGEST IS THE SAME AT EVERY CANDIDATE**, which is what makes §11.7's alpha install
matrix attributable: the shipped operator command an operator runs did not move at any point in this tranche.
The full digest is `33005b52c989645586c0fbe35fdf4572489b7a74ec97785f22b20e89435cf2f3`; the abbreviations above
are its first sixteen characters and the same convention is used for the other two columns.

**THE GATE SOURCE MOVED BETWEEN CANDIDATE 3 AND 4**, which is why attempt 3 and attempt 4 are recorded as two
attempts and not as one repeated: `2697dde` added the R1 diagnostic preservation of §11.4 #6. It changes what
the gate KEEPS on a failing path and nothing it asserts, and §11.3.2 is what that change bought.

| What | Value |
|---|---|
| host | Unraid `tower` |
| host baseline before anything | **42** containers, **26** running, **17** networks, **45** volumes, **0** `fuse.projectiond` mounts |

The operator digest covers the same five files Phase 6 named; the gate digest covers the six that are Phase
7's gate — the gate, its two wrappers, its compose file, its contract module and its CLI.

### 11.2 Attempt 1 — what it measured before it died at arm 1

`bash deploy/projection-phase7-gate.sh`, from candidate 2, image `sha256:83b529f0…`, on Unraid `tower`.
**It died at arm 1 of 6 on a gate defect** (§11.4 #3). Everything before that is a measurement and is
recorded here, naming the run it came from, exactly as Phase 3 §8 records observations from runs that did not
close.

| What | Measured |
|---|---|
| **stage A — the healthy baseline** | **14 verdicts, all pass.** Three real digest-pinned media servers bound the projected path before anything was mounted there; one manifest generation; the operator's real TorBox object admitted and mounted; the resolver refused at the transport from the gate network |
| `P7-A-recovery-idle` | `recoveryState=idle`, `recoveryReason=no-action-healthy`, `recoveryAttempts=0`, `recoveryGeneration=0` on a healthy appliance with three media servers reading through it |
| `P7-A-windows` / `P7-A-stat` | **4 of 4** operator windows digest-matched through the mount against values recorded outside it; an ordinary regular file at exactly the published size by `lstat` |
| `P7-A-inread` × 3 | all three servers read the **same four windows inside their own containers as their own uid** |
| `P7-A-catalogue` × 3 | all three catalogued both published identities at the published size as ordinary files, through each server's **own** predicate |
| **`P7-A-layers`** | **1 above a floor of 0** — the first time this repository has ever counted the layers at a projection mount point |
| **stage C — concurrency** | `P7-C-overlap-three-way-observed` **pass**: all three observed scanning one real-provider namespace on one clock, with a fully attributed three-way sample |
| **stage B — five minutes of paced direct play, ALL THREE AT ONCE** | **emby 306 s, jellyfin 300 s, plex 300 s of DECODED MEDIA TIME**, against a 300 s floor, with startups of **1,500 / 1,600 / 1,480 ms** against a 10,000 ms budget — *while the other two were also in flight* |
| **`P7-C-concurrent-play-overlapped`** | **pass** — an instant existed at which all three servers' consumers were decoding the same object through the same mount, measured from the three progress traces rather than inferred from three launches |
| **stage B — the forced transcode** | **plex: 300 s of decoded h264** against a 300 s floor. Emby and Jellyfin produced **324 decoded seconds each, 108 distinct segments, every one decoded, longest arrival gap 3 s** — and were then failed by a shipped assertion that was wrong (§11.4 #2) |
| **stage C — after the whole playback window** | all three catalogues unchanged; `P7-C-windows-after` **4 of 4**, slowest read 630 ms |
| host afterwards | container, network and volume **sets identical** to the baseline; **0** `fuse.projectiond` mounts; no run directory left |

**WHAT THAT IS AND IS NOT.** It is the first time three real media servers have played a real provider's
object through this appliance **for five minutes each, simultaneously** — Phase 3's window was thirty seconds
per server and its plays were serial. It closes nothing: attempt 1 exited non-zero, and a run that did not
finish proves nothing about the six arms it never reached.

**AND IT IS NOT THE FURTHEST ANY RUN REACHED — ATTEMPTS 3 AND 4 WENT PAST IT**, so nothing in this section
should be read as the tranche's best figures. Attempt 1's seeks and two of its three transcodes were failed by
the two instrument defects §11.4 #1 and #2 name, and §11.3.1 is the same stages with both of those fixed.

### 11.3 Attempt 2 — BLOCKED, not failed, on the operator's egress allowlist

`bash deploy/projection-phase7-gate.sh`, from candidate 2. It died in setup on
`P7-A-entry-is-decodable-video`, with the decoder saying `Input/output error`.

**THAT IS §7's PREDECLARED BLOCKER AND IT IS NOT A PRODUCT DEFECT.** The redaction-safe recheck, run
immediately afterwards and unchanged in shape since Phase 3:

```
allowedOriginCount=5    resolvedOriginDigest=d4064d307d25
resolvedOriginInAllowlist=NO    verdict=disallowed    observedAt 2026-08-12T16:32:17Z
```

`d4064d307d25` is one of the two origins Phase 3 §11.7 already recorded as **observed and not allowlisted**.
The same recheck had answered `allowed` on `3cfc7340a785` twenty-eight minutes earlier, which is the provider
moving between pool members inside a single working session — the arithmetic §11.7 measured.

**PER §7 THIS RUN IS RECORDED AS BLOCKED AND COUNTS TOWARD NOTHING IN EITHER DIRECTION**, and nothing here
wrote `endpoint.json`. The blocker was escalated to the operator with a digest and a count and nothing else.
**It stayed unwritten through every attempt this document records** — §11.13 is the single later operator
action, on a different origin digest, and it does not reach back and un-BLOCK this run.

### 11.3.1 Attempt 3 — the provider rotated BACK, stages A, B and C went fully green, and arm R1 measured FALSE

The recheck answered `allowed` again on `09e2a517af25` — the origin Phase 3 §11.5 watched for fifty-four
minutes — so the run was launched inside that stretch. **Everything before stage D passed**, including the
three things attempt 1 could not:

| What | Measured |
|---|---|
| `P7-B-seeks` × 3 | **10 / 10 on every server**, each verified by that server's own verifier — ten distinct media-time positions, backwards transitions and one beyond 90 % of duration, every segment decoded |
| `P7-B-play-decoded-seconds` × 3 | **306 / 300 / 300** against a 300 s floor, **all three at once**, startups **1,500 / 1,600 / 1,510 ms** against 10,000 ms |
| `P7-C-concurrent-play-overlapped` | pass |
| `P7-B-transcode-decoded-seconds` × 3 | **324 / 324 / 300** against a 300 s floor — the hevc source now correctly accepted, and every one of the three servers transcoded a real provider's object for five minutes |
| `P7-C-catalogue` × 3, `P7-C-windows-after` | pass, **4 / 4** |

**AND THEN ARM R1 MEASURED FALSE, WHICH IS THE MOST IMPORTANT SINGLE RESULT IN THIS DOCUMENT.**

```
before R1: 1 mount(s) of ours and 1 row(s) of any kind at the mount point, against a floor of 0
PASS  P7-R1-fault-took-the-mount
FAIL  P7-R1-action-ms 34304/33000
FAIL  P7-R1-reason        reason='none' observation='none' lastAction=''
FAIL  P7-R1-remediation   'absent'
PASS  P7-R1-attempts 0/1
PASS  P7-R1-single-flight 0/1
FAIL  P7-R1-generation    advanced from 0 to ?
FAIL  P7-R1-ready-ms      [no measurement was taken]
FAIL  P7-arm-windows:R1 0/4
```

**WHAT THAT SAYS, STATED AS WHAT WAS OBSERVED RATHER THAN AS A DIAGNOSIS.** The projectiond mount was
removed from beneath a living daemon — the fault landed, and `P7-R1-fault-took-the-mount` is the assertion
that it did. For the whole thirty-four-second budget afterwards **the daemon's status surface answered
nothing at all**: not a refusal, not a fault code, not a remediation. No recovery attempt was spent, the
generation never moved, the namespace never came back, and the operator's four approved windows read **0 of
4** afterwards.

**WHAT IS NOT DETERMINED BY THIS RUN, AND IT IS NAMED RATHER THAN GUESSED.** `reason='none'` has two
readings — a daemon that had exited, and a daemon that was alive and no longer reachable — and nothing else
this run recorded separates them. **That is a gate defect and it is fixed**: R1 now preserves the daemon's own
log, its container status and exit code, and the host mount survey, on the failing path.

**AND ATTEMPT 4 ANSWERED IT, AND THE ANSWER RETIRES HALF OF THE PARAGRAPH ABOVE.** The arm reproduced
identically — `P7-R1-action-ms 34,085 / 33,000`, the same five failures, the same two passes — and this time
the daemon container was inspected while it was still there:

```
projection-p7-mount-435263   Up 26 minutes (unhealthy)
```

**THE DAEMON HAD NOT EXITED. IT WAS ALIVE, AND UNHEALTHY, WHICH IS A DAEMON SAYING SOMETHING QUITE SPECIFIC.**
And the gate could not hear it: `daemon_status` was inherited from Phase 3, where Phase 6 §7 records it as
**defined and never called**, and it was `wget -q -O -` — which exits non-zero and writes **nothing** for any
status outside 2xx. **Readiness answers 503 for every fault this tranche injects.** So `reason='none'` was the
instrument's claim about the product, made with an instrument that could not read the product's answer.

**WHAT STANDS AND WHAT DOES NOT, SEPARATED RATHER THAN BLENDED.** What stands is measured through the mount
and not through the status surface: the fault landed, **no recovery attempt was spent**, **the generation
never advanced**, the namespace never came back, and the operator's four windows read **0 of 4** afterwards.
What does **not** stand is *"and did not report it"* — that sentence was the reader's, it has been withdrawn
here rather than quietly deleted, and the reader is now the recovery gate's own: a raw HTTP/1.0 request that
reads a 503 as the answer it is, while still leaving an unreachable daemon distinguishable from a refusing
one.

### 11.3.2 AND THEN THE DAEMON SAID IT IN ONE LINE, WHICH IS THE FINDING THE WHOLE TRANCHE PAID FOR

The same attempt's preserved daemon log, on the failing path, in full:

```
projectiond: automatic recovery is ENABLED: bounded, budgeted, and it will never unmount
             anything that is not this daemon's own
projectiond: recovery refused: refuse-foreign-mount (inspect-mount-owner)

daemon container: running exit=0
--- mount survey (after the R1 fault) ---
host rows at the mount point or beneath it: 0
```

**THE APPLIANCE DID NOT FAIL TO NOTICE, AND IT DID NOT FAIL TO REPORT. IT REFUSED, DELIBERATELY, BY THE
CLOSED-SET RULE PHASE 6 CALLS ITS MOST IMPORTANT ROW.** `refuse-foreign-mount`, remediation
`inspect-mount-owner`, no budget spent, no generation advanced, the process alive — every one of those is the
designed behaviour and every one of them is correct against Phase 6 §3.2 as written.

**WHY IT FIRES HERE, AND IT IS A PROPERTY OF THE TOPOLOGY RATHER THAN OF THE FAULT.** When the projectiond
mount is removed from beneath the daemon, what remains at the mount point **inside the container** is the
operator's own bind — and on an Unraid host that bind's file-system type is the host's `fuse.shfs`. So
`ObserveMountpoint` answers **foreign**, the classification table's only row for
`mount-observed-not-live` + `foreign` is a refusal, and `recover-mount-empty` — the row that exists in that
table for exactly this fault — **is unreachable in the topology the alpha ships in.**

**SO THE PREDECLARED CLAUSE IS RECORDED AS SUPERSEDED, IN THE SHAPE PHASE 4 §4.1 AND PHASE 5 §3.3 USED.**

> **HISTORICALLY — SUPERSEDED.** §3.1's R1 row: *"the recovery supervisor classifies it as **its own to
> repair**, spends **exactly one** attempt inside `RECOVERY_ACTION_BUDGET_MS`, and the namespace is readable
> by a sibling again inside `RECOVERY_READY_BUDGET_MS`."*

**IT WAS MEASURED FALSE AND IT IS NOT A THRESHOLD.** What it asked for is a state a daemon obeying Phase 6's
own table cannot produce in a container, and the correction is not to weaken the clause — it is to decide
whether the table is right.

**THE DECISION PHASE 8 OWES, STATED SO IT IS TAKEN BY SOMEBODY RATHER THAN DRIFTING IN.** The refusal's whole
justification is that *unmounting* something that is not ours is the `--auto-remount` defect. But the
recovery action here is a **stack**, not an unmount: `planRemountCleanup` returns `nothing` for a foreign
mount and the remount lands on top — **which is exactly what this daemon does at startup, over this same
bind, every single time it starts.** The daemon already has the fact that separates the two cases:
`mountsAtStartup`, the count taken before it mounted anything. If the count at the mount point is at or below
that floor, **nothing of ours is there and nothing has been stacked on us** — the mount is simply gone, and
mounting is the startup path, not a new destructive capability.

> **HISTORICALLY — SUPERSEDED.** *"THIS TRANCHE DOES NOT MAKE THAT CHANGE, and the reason is the same one
> §11.4.2 gives: it would be a third edit to the daemon's mount lifecycle in one sitting, it changes a closed
> tranche's published classification table, and the only instrument that could validate it end to end is the
> matrix that is still blocked at this very arm. It is written down here as the next decision rather than taken
> quietly."*

**THE DECISION HAS SINCE BEEN TAKEN, IN THIS TRANCHE, AND §8.4 IS ITS CONTRACT** — written and committed
before the rerun that measures it. It is **not** the count §11.3.2 sketched above: a count cannot tell an
attachment from a different attachment of the same shape, which is this tranche's own defect #5 exactly. It is
the **identity of the whole stack**, fingerprinted before the first `Mount()`, and `underlay-exposed` is the
only one of four verdicts that admits anything. §8.4.2 is the safety contract clause by clause and §8.4.4 is
why reinstating the R1 clause word for word is not a threshold moving.

**WHY IT MATTERS MORE THAN ANY OTHER ARM.** An external `umount` of the projected path is the single most
likely operator-side accident on this whole appliance, and it is the fault `recover-mount-empty` exists in
Phase 6 §3.2's table for. On the evidence of this run, in the topology the alpha actually ships in, **the
appliance did not repair it and did not report it**. §12 is a NO-GO and this is the first reason.

### 11.3.3 ATTEMPT 5 — THE FIRST RUN THAT REACHED ALL SIX ARMS, AND R1 RECOVERED

**FROM CANDIDATE 5**, commit `d38e45a22b699c9f64d33dfc7fa3fbe2c26d957a`, tree
`7a33dd191c8e47b149101426a3995159d32c00fa`, staged into an emptied
`/mnt/user/appdata/catalog-p7` from `git archive` and proved byte-identical **in both directions** — two sorted
per-file sha256 manifests computed independently on each side over **1,660** files, both hashing to
`504a6c2667369453313307168adc1585bec5522791f1ee4311a62e9c4fe2b181`. Image
`sha256:0ccb21304d5fb8338ce79bc96e6493d2b26e10b794e7d8cf5a65bdf6ed262037`, rebuilt by the gate from the frozen
tree to the same digest. The §7 recheck answered `allowed` on `b16331429dc1` immediately before the sequence.

**IT FAILED, AND IT IS THE MOST INFORMATIVE RUN THIS TRANCHE HAS HAD: 347 verdicts pass, 13 fail, all six arms
executed.**

**THE ARM THIS WHOLE TRANCHE WAS BLOCKED ON RECOVERED, AND EVERY PART OF §3.2 HELD FOR IT:**

```
before R1: 1 mount(s) of ours and 1 row(s) of any kind at the mount point, against a floor of 0
PASS  P7-R1-underlay-covered-before        PASS  P7-R1-underlay-fingerprinted
PASS  P7-R1-fault-took-the-mount           PASS  P7-R1-action-ms 14603/33000
PASS  P7-R1-reason                         PASS  P7-R1-action-is-the-underlay-row
PASS  P7-R1-underlay-digest-unchanged      PASS  P7-R1-attempts 1/1
PASS  P7-R1-single-flight 1/1              PASS  P7-R1-generation
PASS  P7-R1-ready-ms 17153/59000           PASS  P7-R1
PASS  P7-arm-windows:R1 4/4                PASS  P7-arm-stat:R1     PASS  P7-arm-seed:R1
PASS  P7-arm-inread:emby:R1  PASS  P7-arm-inread:jellyfin:R1  PASS  P7-arm-inread:plex:R1
PASS  P7-arm-layers:R1 1/1
```

**WHAT THAT SAYS, AS A MEASUREMENT.** The projectiond mount was removed from beneath a living daemon. The daemon
proved the mount point was the exact attachment it had fingerprinted before its first mount, took **one**
bounded action named `recover-mount-underlay`, and the namespace was readable by a sibling again **17.2 s** after
the fault against a 59 s budget — with **all four** operator windows digest-matching, **all three** media
servers reading them inside their own containers as their own uid, and **one** layer above the floor. The same
run's R2 recovered the same way from a second daemon's corpse: `action-ms 11,510/33,000`, `ready-ms
13,811/59,000`, one action, one layer. **R3, R4 and R5 each passed every assertion of their own arm** —
including R5's refusal, with `recoveryUnderlay=underlay-covered` beside it, the tmpfs still mounted and
byte-unmodified and nothing spent.

**AND FOUR DEFECTS STOPPED IT, ALL FOUR NEW, AND THREE OF THE FOUR ARE IN THE INSTRUMENT.** They are §11.4 #11
to #14 and each is recorded there with its fix: the transient false refusal the pairing produced (**the
product**, §8.4.5); a bind-fingerprint baseline that had **never** been able to pass; a dead layer accumulating
in the **host** namespace that the daemon's own namespace did not have, still undiagnosed; and R6's injector
relying on a superblock reference it did not hold, which killed the serve loop, exited the daemon, and left a
dead mount that made Docker refuse the restart with status 125.

**NO CLAIM IS MADE HERE ABOUT A SEQUENCE.** One run of three, and it failed. §11.9 is the arm ledger.

### 11.3.4 ATTEMPT 6 — THE PRODUCT FIX HELD, AND THE PROVIDER BLOCKED IT AT ARM R3

**FROM CANDIDATE 6**, commit `566d2afbd599f8b3c1f619be15614a6b343dc5dc`, tree
`776296343429948d71d935a1ac4a46f07a9856f4`, staged into an emptied `/mnt/user/appdata/catalog-p7` from
`git archive` and proved byte-identical **in both directions** — two sorted per-file sha256 manifests computed
independently on each side over **1,660** files, both hashing to
`db1709d4eca06793b2e8dcb24907d9661d4db29d0de899f2c7dced17771c270f`. Image
`sha256:b7f80288aa882503754bc665cfa3bd51a288de21d951016fa7a9bcbf05c6f30f`. The §7 recheck answered `allowed`
on `b16331429dc1` fourteen minutes before the sequence started.

**RECORDED AS BLOCKED, NOT FAILED, PER §7, AND IT COUNTS TOWARD NOTHING IN EITHER DIRECTION.**

**WHAT IT PROVED FIRST, AND IT IS THE POINT OF THE CANDIDATE.** §8.4.5’s pairing correction held on the real
host: `P7-R1-remediation` — the assertion attempt 5 failed — **passed**, and with it every other assertion of
both recovering arms:

```
before R1: 1 mount(s) of ours and 1 row(s) of any kind at the mount point, against a floor of 0
PASS  P7-R1-action-ms 13109/33000     PASS  P7-R1-ready-ms 15615/59000
PASS  P7-R1-remediation               PASS  P7-R1-action-is-the-underlay-row
PASS  P7-R1-underlay-digest-unchanged PASS  P7-R1-attempts 1/1   PASS  P7-R1-single-flight 1/1
PASS  P7-arm-layers:R1 1/1
before R2: 1 mount(s) of ours and 1 row(s) of any kind at the mount point, against a floor of 0
PASS  P7-R2-action-ms 13096/33000     PASS  P7-R2-ready-ms 15367/59000
PASS  P7-arm-layers:R2 1/1
before R3: 1 mount(s) of ours and 1 row(s) of any kind at the mount point, against a floor of 0
```

**AND THE LAYER RESIDUAL OF §11.4 #13 DID NOT RECUR, WHICH IS WHY IT IS RESOLVED RATHER THAN STILL OPEN.**
Attempt 5 measured 2/1 from R3 onward; attempt 6 measured **1/1 after every arm it reached, with `before Rn`
reading 1 every time.** The only thing that changed between the two candidates on that path is #11 — and #11 is
exactly the mechanism: a transient refusal changes the sustained class, and a class that changes and comes back
is a second actionable window, so the supervisor took a **second** action for one fault and the second one
stacked a live layer. The count was a symptom of the pairing defect and not a second defect of its own.

**WHAT BLOCKED IT IS §7, AT THE WORST POSSIBLE MOMENT IN THE RUN.** Arm R3 restores the provider mid-cooldown
and measures the first read after release. The recheck run immediately after the failure:

```
allowedOriginCount=5    resolvedOriginDigest=4fea5e1bdeaa
resolvedOriginInAllowlist=NO    verdict=disallowed    resolverStatus=200
```

So the reads after release were refused by the daemon’s **egress allowlist**, which is the one job it exists
for: `P7-R3-recovery-ms` measured **122,922 ms against 80,000**, `P7-R3-half-open-probes` **4 against 1**, and
`P7-arm-windows:R3` **1 of 4**. Every other R3 assertion passed — the read failed inside the deadline (610 ms
against 20,000), the breaker opened, the refusal was 3 ms against 5,000, **zero** requests reached a live
resolver during the hold, no recovery action was taken and the mount was untouched.

**THE BLOCKER WAS ESCALATED WITH A DIGEST AND A COUNT AND NOTHING ELSE, AND `endpoint.json` WAS NOT WRITTEN.**
§7. The one remaining instrument defect the run exposed is §11.4 #15, and every provider-free obligation
continued while the allowlist was blocked.

### 11.3.5 ATTEMPT 7 — THE PROVIDER WAS ALLOWED, ALL SIX ARMS RAN, AND THE LAYER RESIDUAL CAME BACK AT R3

**THIS IS THE FIRST SEQUENCE ATTEMPT SINCE THE OPERATOR ACTION OF §11.13**, and it is the run this tranche
had been waiting on: nothing was blocked, nothing was skipped, every media stage went green, and the gate
**failed on an arm** rather than on a rotation. It ran from **candidate 8** — §11.1 has the identity — with
`PROJECTIOND_IMAGE=projectiond:phase7c8-frozen`, and the recheck **immediately before it** answered
`allowedOriginCount=6`, `resolvedOriginDigest=4fea5e1bdeaa`, `verdict=allowed`, exit 0, as §7 requires.

**IT IS THE `go:phase7-gate` SINGLE RUN, DELIBERATELY, AND NOT A STANDALONE R6 EXPERIMENT.** §11.4 #14's
repaired R6 injector had never executed, and the only honest way to execute it is the one the contract
predeclares: **inside the actual full gate, after the five arms that precede it.** A bespoke harness that
reached R6 directly would have measured a state no sequence produces. That decision is what surfaced #16.

**THE MEDIA STAGES, ALL GREEN, FROM A REAL TORBOX OBJECT THROUGH THREE PRE-ATTACHED DIGEST-PINNED SERVERS:**

| | emby | jellyfin | plex |
|---|---|---|---|
| ten media-time seeks, each server's own driver and verifier | **10/10** | **10/10** | **10/10** |
| direct play, decoded media seconds against a 300 s floor | **306** | **300** | **300** |
| forced transcode, decoded h264 media seconds against 300 s | **324** | **324** | **300** |

`P7-C-concurrent-play-overlapped` passed: an instant existed at which all three servers' consumers were
decoding the same object through the same mount, measured from the three progress traces rather than inferred
from three launches.

**THE ARMS, AND THIS IS THE SECOND SEQUENCE IN THIS TRANCHE TO REACH ALL SIX:**

| Arm | Its own assertions | `P7-arm-layers` | `P7-arm-binds-unchanged` |
|---|---|---|---|
| **R1** | **ALL PASSED.** `action-ms` **14,490**/33,000, `ready-ms` **16,913**/59,000, one attempt, one supervisor, generation 0 to 1, `recover-mount-underlay`, remediation `none`, and the underlay fingerprint `fccf4ba8c5c2` **identical before the fault and after the recovery** | **PASS 1/1** | **PASS** |
| **R2** | **ALL PASSED.** The corpse verified stale by a `statfs`/mountinfo disagreement, `action-ms` **12,974**/33,000, `ready-ms` **15,209**/59,000, one attempt, generation 1 to 2 | **PASS 1/1** | **PASS** |
| **R3** | **ALL PASSED.** `read-fail-ms` **611**/20,000, breaker opened, `refusal-ms` **2**/5,000, **0** requests reached the live resolver during the hold, `recovery-ms` **1,341**/80,000, **1/1** half-open probe, `no-recovery-action` **0/0**, mount untouched with `recoveryGeneration` still 2. Windows **4/4**, all three servers reading inside their own containers, catalogue churn **0/0** | **FAIL 2/1** | **PASS** |
| **R4** | **ALL PASSED.** The daemon's own log named a serve-loop death, the namespace came back at the same mountpoint without the process exiting, `ready-ms` **1,572**/22,000, inode/size/mtime unchanged, the recovery loop **declined** (0/0), and `single-flight` **1/1** *across BOTH supervisors* | **FAIL 2/1** | **PASS** |
| **R5** | **ALL PASSED.** `refuse-foreign-mount` / `inspect-mount-owner` beside `underlay-covered`, `recoveryAttempts` still **0**, generation still **2**, and the tmpfs the gate stacked **still the top of the stack and byte-unmodified** | **FAIL 2/1** | **PASS** |
| **R6** | **THE ARM DID NOT REACH ITS SUBJECT.** `P7-R6-connection-held` passed — a sibling held an open descriptor inside the mount, which is #14's repair working — and then the injector's **premise assertion refused to proceed**: after the lazy detach, **1 mount of ours remained at the mount point**, so *"this fault does not need a mount to repair"*. The gate stopped there | — | — |

**R6's REFUSAL IS THE INSTRUMENT WORKING AND IT IS IMPORTANT NOT TO READ IT AS #14 REGRESSING.** §8.6's whole
argument is that `RC8`/R6's fault must be the one fault whose repair genuinely **requires** a mount syscall.
The repaired injector asserts that premise instead of assuming it, and on this run the premise was false —
because two of our layers were stacked, so detaching the top one left a live mount behind. **#14's repair is
still unmeasured**, and it is unmeasured for a reason that has nothing to do with #14.

**WHERE THE SECOND LAYER CAME FROM, STATED AS WHAT WAS MEASURED AND THEN AS WHAT IS ONLY A HYPOTHESIS.**

Measured, and nothing in this paragraph is inference: after R1 and R2 the count was **1**; the reading taken
*before* R3 was **1**; the reading taken *after* R3 was **2**, in **both** namespaces —

```
host row:   id=3723 parent=54   dev=0:392 fstype=fuse.projectiond at=<mountpoint>
host row:   id=3724 parent=3723 dev=0:388 fstype=fuse.projectiond at=<mountpoint>
daemon row: id=3833 parent=3824 dev=0:392 fstype=fuse.projectiond at=<mountpoint>
daemon row: id=3722 parent=3833 dev=0:388 fstype=fuse.projectiond at=<mountpoint>
```

— and it stayed 2 through R4 and R5. Across the whole of R3 the **recovery** supervisor demonstrably did
nothing: `recoveryGeneration` never left 2, `P7-R3-no-recovery-action` measured 0/0, and
`P7-R3-mount-untouched` passed. **So a live layer appeared while the only supervisor R3 watches was idle.**

**THE HYPOTHESIS, AND IT IS LABELLED AS ONE BECAUSE THE DAEMON'S LOG DID NOT SURVIVE THE RUN.** There are two
things in this daemon that mount, not one — R4's own `single-flight` assertion says so in its note, *"remounts
started across BOTH supervisors"* — and the **serve-death** supervisor's remount neither advances
`recoveryGeneration` nor counts as a "recovery action". A provider outage that killed the serve loop would
therefore be repaired by a path that **every assertion R3 makes is blind to**, and §8.5's skip could not help,
because those five conditions are gated on *a drain that removed something* and R3 drains nothing. That fits
every number above and is proved by none of them.

**THE ONE DIAGNOSTIC THAT WOULD SETTLE IT, NAMED SO THE NEXT RUN DOES NOT HAVE TO REDISCOVER IT:** R3 needs
the assertion R4 already has — a serve-death observation and a `single-flight` count **across both
supervisors** — plus the daemon's own log preserved on the failing path, which is what §11.4 #6 bought for R1
and what this arm still does not have. Attempt 7's log was removed by the gate's own cleanup contract, which
is correct behaviour and is exactly why the paragraph above stops where it does.

**AND THE RUN CLEANED UP EXACTLY.** Containers, running containers, networks and volumes all came back as the
**same sets** as the snapshot taken before anything was staged — 44 / 28 / 18 / 46 — with **0**
`fuse.projectiond` mounts and no run directory under the gate root. §11.14 is the full statement.

### 11.4 The defects the runs found, in the order the runs found them

**THIS TABLE IS THE CANONICAL LEDGER. EVERY DEFECT COUNT ANYWHERE ELSE IN THIS REPOSITORY IS DERIVED FROM
IT AND IS PINNED TO IT** by `test/projection-evidence-consistency.ts`, which counts the rows and the
product-fix rows and fails if this document's headline or the roadmap row states anything else. It said
**FIVE, TWO IN THE PRODUCT** for the interval between the run that found #5 and the run that found #7, which
is exactly the class of stale summary that pin now exists to catch.

**16 DEFECTS. SEVEN ARE IN SHIPPED PRODUCT CODE, AND ONE OF THOSE SEVEN WAS INTRODUCED BY THIS TRANCHE
AND CAUGHT BY ITS OWN REGRESSION MATRIX** — which is the most useful thing in this section.

**WHAT COUNTS AS A ROW HERE, STATED SO THE NUMBER IS CHECKABLE RATHER THAN A JUDGEMENT.** A row is a defect a
**measured run on the real host** found. Two corrections this tranche also made are deliberately **not** rows
and are recorded elsewhere, because counting them here would make the number mean something different every
time somebody re-derived it:

- the quoted `awk` program split over five lines, which `test/custody-runtime-closure.ts` refused on the
  development host **before the first measured run** (`c35fee0`);
- the two **closed suites** that went red on this tranche's product changes, which are §11.6.

| # | Found by | What it was | Where the fix went |
|---|---|---|---|
| 1 | attempt 1, stage B | the gate's seek counter asked the driver's output for `positionSeconds`; every shipped driver writes `requestedSeconds`. It counted zero distinct positions **beside a verifier that had just passed all ten of its own assertions**, and recorded `0/10` three times over a product that had done the whole thing correctly | the gate — and an unreadable count now fails as an ABSENT measurement rather than as ten seeks that did not happen |
| 2 | attempt 1, stage B | **THREE SHIPPED DRIVERS WROTE THE PROPERTY AND THEN ASSERTED THE FIXTURE.** Each says *"a transcode to h264 from a source that was already h264 would prove nothing about an encoder"* and then compares the source against `TRANSCODE_SOURCE_VIDEO_CODEC` — the codec this repository's own **synthetic** corpus uses. The operator's object is **hevc**; all three transcoded it correctly for five minutes and two of them were then failed for it. Against Phase 1's mpeg4 corpus the two questions have the same answer, which is why five closed tranches never told them apart | **the product** — one shared decision, `transcodeSourceIsWorthTranscoding`, at all five call sites. Every input that passed before still passes, so no closed result is retired; an absent or blank codec is now a failure rather than a pass |
| 3 | attempt 1, arm 1 | the gate is generated, and the generator rendered a backslash-n into a **real newline inside a quoted JavaScript string**. The arm log would not parse, and node said so at the first line of arm 1 of 6 — **after** everything in §11.2 had been measured and thrown away | the gate — and an offline assertion now EXTRACTS every program the gate embeds and runs `node --check` over it, so it fails in milliseconds on the development host instead of two hours into a metered run |
| 4 | the regression matrix | **THE CORPSE DRAIN WAS NEVER REACHED IN A CONTAINER**, which is Phase 6 §9.7 measured from the inside. `planRemountCleanup` classified from `ProbeMountpoint`, which reads the BOTTOM of the stack, and in every containerised topology the bottom entry is the operator's bind — `fuse.shfs` on Unraid. After a serve-loop death the pair is ENOTCONN over somebody else's type, and `classify` has exactly one answer for that: FOREIGN | **the product** — the plan now also reads what is on TOP, and drains when the top is our own dead mount. A foreign mount on top still plans nothing |
| 5 | **the regression matrix, on the fix for #4** | **AND THEN THE DRAIN TOOK THIS DAEMON'S OWN LIVE MOUNT.** Phase 6's own `RC8`, run from the Phase 7 candidate: the mount point held the operator's bind, **this daemon's live mount**, and a second daemon's corpse above it. The drain removed the corpse — correct — and then removed the live one, because "above the floor and of our type" describes both. Its own log: `detaching one of ours … floor 1, now 3` / `floor 1, now 2` / `serve loop died` / `remount attempts exhausted` / `exiting`. Reproduced identically on all three runs of the three-runner | **the product** — a third condition now stands between a mount and a detach: its transport must be **confirmed gone**. FUSE caches nothing for `statfs`, so a corpse answers ENOTCONN instantly while a live mount is answered by this daemon's own serve loop |

| 6 | attempt 3, arm R1 | **THE ARM FAILED HOLDING ITS OWN DIAGNOSIS AND THE CLEANUP WAS ABOUT TO DELETE IT.** R1 recorded `reason='none' observation='none'` for its whole budget, and nothing else the run kept separated *"the daemon exited"* from *"the daemon is alive and unreachable"*. Two readings, one measurement | the gate — R1 now keeps the daemon's own log, the container's status and exit code, and the host mount survey, on the failing path only, which is exactly what Phase 3's `A3` does |
| 7 | attempts 3 and 4, arm R1 | **THE GATE COULD NOT READ A 503, WHICH IS THE ANSWER EVERY FAULT IT INJECTS PRODUCES.** `daemon_status` came from Phase 3, where Phase 6 §7 records it as **defined and never called**; its first real use was this arm and it was `wget -q -O -`, which exits non-zero and writes **nothing** for any status outside 2xx. So the instrument reported the product as silent about the one question it was built to ask, while the daemon was `Up (unhealthy)` throughout | the gate — the recovery gate's own reader, ported: a raw HTTP/1.0 request with the status line and the body kept apart, 200 and 503 both read, and anything else still leaving the caller with nothing so an unreachable daemon stays distinguishable from a refusing one |
| 8 | attempts 3 and 4, arm R1 | **THE APPLIANCE COULD NOT REPAIR AN EXTERNAL `umount` OF THE PROJECTED PATH, IN THE TOPOLOGY IT SHIPS IN.** With the projectiond mount gone, what remains at the mount point inside a container is the operator's own bind — `fuse.shfs` on Unraid — so the observation reads FOREIGN and Phase 6 §3.2's only row for that is a refusal. The refusal is correct as written and `recover-mount-empty`, the row that table has for exactly this fault, was **unreachable**. Measured twice, identically: no attempt spent, no generation advanced, the namespace never back, the operator's four windows **0 of 4** afterwards | **the product** — §8.4. The daemon now fingerprints the whole ordered stack at its mount point BEFORE its first `Mount()` and admits exactly one further state: that same stack, unchanged, uncovered. Three other verdicts refuse, the file-system type is never consulted, nothing is ever unmounted on the path, and the evidence is re-taken when the budget is spent |
| 9 | the regression matrix, on the fix for #4 | **AND THEN THE LAYER COUNT GREW A LIVE LAYER PER FAULT.** `now 3` → `now 4` across successive faults: the dead layers were drained, but when the fault was somebody ELSE'S corpse this daemon's own mount was never broken, so the drain removed the corpse and the remount stacked a **second live** layer over a first that was still connected. `MOUNT_LAYERS_ABOVE_FLOOR_MAX` is 1 and that measures 2 | **the product** — §8.5. After a drain that removed something, the supervisor re-observes and skips the mount syscall when the mount point is already serving through our own live mount at or under one layer above the measured floor. Five conditions, all necessary; skipping a mount can destroy nothing |
| 10 | the regression matrix | **`RC8`/`RC9`/`RC11` ASSERTED A STATE THEIR OWN INJECTOR COULD NO LONGER PRODUCE.** Phase 6 §4's premise — that the mount syscall is the only thing that can repair a stacked corpse — stopped being true when the fix for #4 made the drain reachable: the corpse is drained, readiness confirms, the budget is refunded, and `no-action-healthy` is what the arm reads. Identically on all three runs | the gate — §8.6. The **assertions are untouched**; the injector becomes the one fault whose repair genuinely requires a mount, which is the subject's own mount detached under a masked `/dev/fuse`. The consumer holds an open descriptor first so the connection survives, and both arms fail loudly if it does not |
| 11 | **attempt 5, arm R1** | **A FRESH VERDICT PAIRED WITH A SAMPLED OBSERVATION PUBLISHED A REFUSAL ABOUT A MOUNT POINT THE DAEMON HAD JUST REPAIRED.** The instant the recovery's remount landed the live verdict became `underlay-covered` while the last completed observation was still the `foreign` one that authorised it — and that pair is a refusal. `refuse-foreign-mount` / `inspect-mount-owner`, on a healthy appliance, for about a second. Nothing was spent and nothing was done: a REPORTING defect on the one surface whose value is that it can be read at any instant | **the product** — §8.4.5. The verdict is now taken by the sampler beside the observation, so the classification reads one measurement of one moment; and the freshness moved to `RecoveryBeginAttempt`, which re-verifies live before it spends anything. Strictly stronger, and the transient is gone |
| 12 | **attempt 5, arms R1–R5** | **`P7-arm-binds-unchanged` COULD NOT PASS AND HAD NEVER PASSED.** The baseline bind fingerprint is taken before the first mount, and `container_for` — the helper that turns a server id into a container name — was defined **two hundred lines below that call site**. A shell function does not exist until its definition has run, so the baseline ran `docker inspect ""` three times and wrote `UNREADABLE` three times; every arm then compared against a baseline that had recorded nothing. This is the assertion that pays for *"no consumer was restarted or re-bound to make a recovery visible"* — Phase 2's worst defect wearing a workaround — and it had never once been in a position to say so | the gate — the helper moved to its only early caller, and an unreadable container is now **fatal** rather than a placeholder written into a file that is then compared |
| 13 | **attempt 5, arms R3–R5** | **A DEAD LAYER ACCUMULATED IN THE HOST NAMESPACE THAT THE DAEMON'S OWN NAMESPACE DID NOT HAVE.** `P7-arm-layers` measured **2/1** from R3 onward while the daemon's own drain log said `floor 1, now 2` — one of ours in its namespace, two in the host's — and the run kept nothing that could say which row the host had, or where it came from. It also broke R6 (#14). **DIAGNOSED BY THE NEXT RUN AND RESOLVED BY #11’S FIX**: attempt 6 measured 1/1 after every arm it reached. A transient refusal changes the sustained class, and a class that changes and comes back is a second actionable window — so the supervisor took a SECOND action for one fault and that one stacked a live layer. The count was a symptom of #11 | the gate — a layer count outside the bound now prints the mount-id-and-type survey in **both** namespaces, which is exactly what defect #6 bought for R1 and what this arm did not have |
| 14 | **attempt 5, arm R6** | **THE INJECTOR RELIED ON A REFERENCE IT DID NOT HOLD, AND THE RUN DIED ON DOCKER'S OWN BIND REFUSAL.** `umount -l` leaves the FUSE superblock alive only while something references it. R1 measured the connection surviving after twenty minutes of playback; R6, with nothing reading, measured the opposite — the serve loop died, the SERVE supervisor took the fault, its three remounts failed under the masked `/dev/fuse`, and the process exited with the recovery loop having spent nothing. The dead mount it left made `restart_daemon` fail with `error while creating mount source path … file exists`, status 125 | the gate — R6 now holds an **open descriptor** on the projected entry from a sibling first (what a media server holds while playing), asserts it, asserts that **none** of our mounts remain after the detach, and clears its own dead layers with the shared helper before the restart |
| 15 | **attempt 6, arms R1 and R2** | **`P7-arm-binds-unchanged` COMPARED AN UNORDERED COLLECTION AS A STRING.** With #12 fixed the baseline was readable for the first time, and the comparison still failed — on the ORDER of `docker inspect`’s `.Mounts` array. Measured inside one run: `mnt=>/media/projection:rslave` came back FIRST in the baseline and LAST after arm R1, with the same container id, the same start instant and the same four mounts with the same modes. Docker does not promise that order and it is not a property of the container | the gate — the mount list is emitted one entry per line and sorted with `LC_ALL=C sort` before comparison, so what is asserted is the SET: same container, same start instant, same sources at the same destinations with the same modes. A mount added, removed, re-pointed or re-moded still fails, which is what *never re-bound* means |
| 16 | **attempt 7, arms R3–R6** | **#13 WAS RECORDED AS RESOLVED ON EVIDENCE THAT COULD NOT HAVE SHOWN IT, AND IT IS NOT RESOLVED.** #13's own row says the residual appeared *from R3 onward*; the run it cites as having resolved it — attempt 6 — was BLOCKED by the provider at arm R3 and reached only R1 and R2, the two arms that measured `1/1` in attempt 5 as well. So *"attempt 6 measured 1/1 after every arm it reached"* is true and proves nothing about this defect. **Attempt 7 is the first run since the fix to reach R3, and it measured `P7-arm-layers` at 2/1 at R3, R4 and R5 — the same three arms, the same numbers, as attempt 5.** It differs from #13 in one respect that matters: **both namespaces now agree**, 2 rows in the host's and 2 in the daemon's, where #13 measured 1 and 2 — so this is a second **live** layer and not the host-only ghost #13 described. And it is not reachable by §8.5's skip, which is gated on a **drain that removed something**: across the whole of R3 `recoveryGeneration` never left 2, `P7-R3-no-recovery-action` measured **0/0** and `P7-R3-mount-untouched` passed, so the recovery supervisor did nothing at all while a layer appeared. **It also broke R6 again, exactly as #13 did** (see below) | **the product** — §8.7, and the mechanism is not the hypothesis §11.3.5 named. R3 is the only arm that REPLACES the daemon, the gate replaced it with `docker rm -f` — a `SIGKILL` — and at an `rshared` mount point a mount whose namespace is destroyed SURVIVES with its transport dead, which is the same recipe `projection-stale-mount-gate.sh` uses to manufacture a corpse on purpose. The replacement daemon then stacks over it and says so in its own log, and its floor is now 1, so its drain may never remove it. The daemon now removes ITS OWN mount on a shutdown whose ordinary unmount was refused, authorised by the mountinfo row it recorded when its own `Mount()` returned rather than by a type or a count; and the gate stops it the way the shipped operator command does instead of injecting a crash §3.1 never declared. §8.7.4 is what would have to be measured before this may be called fixed |

**#5 IS THE ARGUMENT FOR THE WHOLE REGRESSION MATRIX, STATED PLAINLY.** The fix for #4 passed every offline
test, including three new ones written specifically for it, and was byte-identical in both directions on the
host. It took a **real recovery gate on a real host** to find that it destroyed the thing it was protecting,
one layer above where the floor could see it.

**#6 AND #7 ARE BOTH INSTRUMENT DEFECTS ON THE SAME ARM, AND #7 IS THE MORE SERIOUS OF THE TWO** — it caused
this document to publish, for one revision, the sentence *"the appliance did not repair it **and did not
report it**"* about an appliance that was reporting a precise closed-set refusal the whole time. §11.3.2
withdraws that half in place rather than deleting it, and §11.4 #7 is why it was ever written.

**NINE OF THE SIXTEEN ARE IN THE INSTRUMENT AND SEVEN ARE IN THE PRODUCT**, and the split is worth stating
because it is the same split every closed tranche here has reported: the gates find product defects by being
wrong first.

**#16 MOVED INTO THE PRODUCT COLUMN AND THAT IS A CLAIM ABOUT WHERE THE FIX WENT, NOT ABOUT WHETHER IT WORKS.**
An earlier revision of this paragraph said *"#16 IS IN NEITHER COLUMN YET, because nothing has been fixed for
it"*, and that was true when it was written. What has changed is that a repair exists, is committed, is
contracted at §8.7 and is pinned; what has **not** changed is that no run has measured it. The two are
different sentences and §8.7.4 is the one that says what would settle it. Putting a row in a column it has not
earned is how #13 came to be recorded as resolved, and the column here records the fix's ADDRESS — the shipped
daemon, not the gate — which is a fact about the diff and checkable from it. **#16 is also the only row in this
table whose repair is in both places at once**: the product removes its own mount, and the instrument stops
injecting a `SIGKILL` the contract never declared.

**#16 IS THE MOST UNCOMFORTABLE ROW IN THIS TABLE AND IT IS ABOUT THIS DOCUMENT RATHER THAN THE PRODUCT.**
#13 was marked *"DIAGNOSED BY THE NEXT RUN AND RESOLVED BY #11'S FIX"* on the strength of a run that never
reached the arms the defect lives in. Nothing was falsified — attempt 6 really did measure `1/1` after every
arm it reached — but the inference from *"the two arms that never showed it are clean"* to *"it is resolved"*
is exactly the shape of reasoning the rest of this record refuses everywhere else, and no check caught it
because no check knows which arms an attempt reached. **§11.9's arm ledger is the only place that could have
said so and it is the place a reader should now start.**

**#8, #9 AND #10 ARE THE THREE THIS TRANCHE'S SECOND SITTING FIXED, AND THEY ARE ONE CHAIN RATHER THAN THREE
COINCIDENCES.** #8 is the appliance not repairing an external `umount` — the finding the whole tranche paid for,
recorded at §11.3.2 and named there as a decision somebody would have to take. Taking it (§8.4) is what made
#10's repair possible, because `RC8` needs a fault whose repair requires a mount and #8's fault is the only one
there is. And #9 is the residual the same drain fix produced, which had to go before
`MOUNT_LAYERS_ABOVE_FLOOR_MAX` could be met without moving it. **All three were found by measured runs on the
real host and none of them by an offline test**, which is the fifth time in this document that sentence is
true.

### 11.4.1 And then the fix worked, and PHASE 6's OWN GATE STOPPED BEING ABLE TO ASSERT ITS ARM

**THE DRAIN NOW DOES EXACTLY WHAT IT WAS MADE REACHABLE TO DO, IN THE DAEMON'S OWN WORDS:**

```
projectiond: recovery: recover-stale-mount
projectiond: detaching one of ours at /mnt/projection: floor 1, now 3, on top fuse.projectiond
projectiond: detached 1 stale mount(s) of ours at /mnt/projection before remounting
             (now on top: fuse.projectiond (live-projectiond), which is not a corpse and is not ours to remove)
```

The corpse goes, the live mount stays, and the subject daemon that used to exit inside a minute stayed
`Up (healthy)` throughout. **And `RC8`, `RC9` and `RC11` still fail — for a completely different reason, and
it is the interesting one.**

```
FAIL  RC8 attempts=0 (budget 3)
FAIL  RC9 lockedOut=0 heldThroughout=0 reason=no-action-healthy generation=2->2
```

**`no-action-healthy` IS THE WHOLE FINDING.** `RC8` produces an unrecoverable fault by masking `/dev/fuse`
so that every `Mount()` is refused, and then stacking a second daemon's corpse above the subject. Its premise
— stated in Phase 6 §4 and true when it was written — is that **the mount syscall is the only thing that can
repair that fault**, so a mount that cannot succeed drives the budget to exhaustion and a lockout.

**THAT PREMISE IS NO LONGER TRUE, BECAUSE THE PRODUCT GOT BETTER.** The drain removes the corpse, the mount
point becomes healthy again, readiness confirms it, and the budget is refunded — **without any mount syscall
succeeding**. The gate is asserting a state its own injector can no longer produce.

**WHAT THIS IS AND IS NOT.** It is **not** a regression in the daemon: every arm of Phase 6's gate that is
about repairing a fault passes, including `RC4` (`recover-stale-mount`, generation 0 → 1), `RC7` (confirmed
and refunded), `RC12` (the same pre-attached consumer read the same digest afterwards), `RC5` (the foreign
refusal), `RC6` and `RC10` (exactly one supervisor acting) and `RC13` (host cleanliness). It **is** a real
blocker for the §9 matrix, and repairing it means giving `RC8` a fault whose repair genuinely requires a
successful mount — which Phase 6 §11.2.1 #2 already records as hard, because aborting the subject's own
connection under a masked `/dev/fuse` kills the process instead.

**IT IS RECORDED AND NOT WORKED AROUND.** Loosening `RC8` to accept the new behaviour would be editing a
closed tranche's assertion to fit a result, which is the one thing this repository's evidence discipline
exists to prevent.

### 11.4.2 A SECOND RESIDUAL, MEASURED, AND THE PREDECLARED THRESHOLD IS WHAT NAMES IT

The same daemon log shows the layer count going `now 3` → `now 4` across successive faults. The dead layers
are drained; what accumulates now is a **live** one, because when the fault was *somebody else's* corpse the
subject's own mount was never broken — and the recovery remounts anyway, stacking a second live layer over a
first that is still connected.

**`MOUNT_LAYERS_ABOVE_FLOOR_MAX` IS 1 AND THIS WOULD MEASURE 2**, which is exactly what a predeclared
threshold is for. §4.2 says a layer count outside the bound that is *"then argued to be acceptable rather
than fixed or recorded as a NO-GO"* is a NO-GO, and §12 records it as one.

**WHY IT WAS NOT FIXED IN THIS SESSION, AS A DECISION RATHER THAN AN OMISSION.** The repair is small — after
a drain that removed something, re-observe, and skip the remount if the mount point is already live — but it
would be a **third** change to the daemon's mount lifecycle in one sitting, and the only instrument that can
validate it end to end is the Phase 7 matrix, which is blocked on §11.3. Shipping an unvalidated third change
to Phase 3's hardest-won code is the churn this repository's discipline exists to prevent.

### 11.5 Offline, at candidate 7

Taken on the Windows development host at candidate 7, which §11.12 distinguishes from what has run on a host.
**They are not gate evidence**; they are what makes a run worth attempting, and running them here proves
nothing about Unraid.

| What | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run go:fmt` / `go:vet` / `go test ./...` | clean / clean / **every package `ok`**, through the Docker toolchain |
| `npx tsx test/projection-phase7.ts` | **43 passed, 0 failed** — 35 before this tranche’s second sitting, with eight added for §8.4, §8.4.5, §8.5 and §8.6 |
| `npx tsx test/projection-bounded-recovery.ts` | **52 passed, 0 failed** — Phase 6’s pins, plus ten for the expected underlay and the pairing, and both source digests |
| `npx tsx test/projection-mount-hardening.ts` | 32/0 — Phase 2’s pins, with the drain conditions |
| `npx tsx test/projection-reliability-loop.ts` | 69/0, 1 block skipped and named (`win32` carries no POSIX mode) |
| `npx tsx test/projection-mount-truth.ts` | 13/0 — Phase 4 |
| `npx tsx test/projection-operational-mount-health.ts` | 29/0 — Phase 5 |
| `npx tsx test/custody-runtime-closure.ts` | 39/0 — every shipped `.sh` parses under LF and CRLF |
| `npx tsx test/projection-evidence-consistency.ts` | **8/0** |
| **full `npm run test:offline`** | **314 selected, 314 passed, 0 failed, 0 required-but-skipped, 673 s.** It was **313/1** at candidates 5 and 6, and the one failure was the Phase 6 gate-source digest pin refusing to certify a run of source that no longer existed — cleared by the re-run Phase 6 §11.9 records, which is the only thing that may clear it |

**THE GO TESTS ADDED FOR THIS TRANCHE ARE TABLES AND THEY WERE PROVED TO BITE**, not merely written: §11.11.1
is the ten-tamper record, and the Go half of it failed three tests by name against a one-character widening of
the admitting condition.

**THE FIGURES ABOVE WERE TAKEN BEFORE THIS SECTION WAS WRITTEN, WHICH IS THE ONLY ORDER AVAILABLE**, so the
three suites that READ this document — `projection-phase7`, `projection-bounded-recovery` and
`projection-evidence-consistency` — were re-run after every edit to it and are green at the commit this record
ends with.
### 11.5.1 OFFLINE AT CANDIDATE 8 — AND THE FULL INVENTORY RUN ON UNRAID FOR THE FIRST TIME

**EVERYTHING IN §11.5 WAS TAKEN ON THE WINDOWS DEVELOPMENT HOST AND THAT SECTION SAYS SO.** This one adds the
same measurements taken **on Tower, from the frozen candidate-8 tree**, which nothing in this tranche had done
before — and the first thing it produced was a number that looks like a regression and is not.

| What, at candidate 8 on the Unraid host | Result |
|---|---|
| `npm run typecheck` | **clean** |
| `npm run go:fmt` | **clean** |
| `npm run go:vet` | **clean** |
| `npm run go:test` | **every one of the 11 packages `ok`** |
| **full `npm run test:offline`** | **314 selected, 305 passed, 9 failed, 0 required-but-skipped, 897 s** |

**THE NINE ARE ENVIRONMENTAL AND THE CONTROL IS WHAT SAYS SO, NOT AN ARGUMENT.** Every one of the nine was
re-run **from candidate 7's staged tree on the same host** — `eafe172`, the tree §11.7.1's whole matrix ran
from — and **all nine failed there too, with the same messages.** So they are a property of this host and this
suite, not of anything candidate 8 changed, and candidate 8's only difference from candidate 7 is `docs/`.

| Suite | Why it fails on Unraid and cannot on Windows |
|---|---|
| `projection-gate-embedded-programs`, `projection-mount-hardening`, `projection-multi-frontend` | each extracts a **shipped** `.sh` and executes the copy directly. Every shipped script here is **mode 644 in git** — they are always invoked as `bash script.sh` — so on Linux the exec fails with **status 126, `Permission denied`**. On Windows every file is effectively executable, so the same three assertions cannot fail there and never have |
| `custodian-contract`, `sidecar-runtime-prototype`, `sidecar-durable-state-evidence`, `kek-correction-gates`, `custodian-storage-ipc-gates`, `custody-transition` | each requires a state or socket directory to be **owner-only**, or to be able to create and detect a **symlink**. `/mnt/user` is `shfs`, a FUSE union that does not honour restrictive modes and does not present links the way these checks require, so the suites refuse — *"readable or writable by somebody else"*, *"a custodian state path is not a directory"* — which is them **failing closed on a host they cannot certify**, which is what they are for |

**WHAT THIS CORRECTS IN THIS DOCUMENT, STATED PLAINLY.** §11.5's *"314 selected, 314 passed"* is the
**development host's** number and that section already labels it as such; nothing there is withdrawn. What was
never true — and was never claimed, but is easy to read in — is that the full inventory had ever been green
**on Unraid**. It had never been run there at all. **It has now, and 9 of 314 refuse to certify that host**,
for two reasons that are both about the host and one of which (`shfs` modes) this repository has recorded
before.

**AND THE ONE THING THAT WOULD MAKE THIS A REGRESSION IS ABSENT.** No suite that passes on Windows and fails
on Unraid touches `projectiond`, the Phase 7 gate, or the operator command; the Go toolchain, the type
checker and all 11 Go packages are clean on **both** hosts; and the nine are identical between candidates 7
and 8.

**ON THE DEVELOPMENT HOST, AT THE TREE THIS RECORD ENDS WITH: `314 selected, 314 passed, 0 failed, 0
required-but-skipped, 653 s`.** That includes `test/projection-evidence-consistency.ts`, which reads the two
documents this commit rewrites, and `test/projection-phase7.ts` at **43/0** and
`test/projection-bounded-recovery.ts` at **52/0**, which read this record's own claims about the shipped
source. **It also failed twice on the way there and both failures were real**: once because the roadmap still
carried the old defect count while §11.4 had grown a row, and once because §11.11.2 reproduced a retired
universal denial in a table cell. §11.11.2 records the second one against itself.

### 11.6 The two closed suites that went red, and why both were right to

**NEITHER IS A THRESHOLD AND NEITHER PRODUCT BEHAVIOUR CHANGED.**

- `test/projection-mount-hardening.ts` pinned `planRemountCleanup`'s exact signature, and this tranche added
  a parameter. Its own comment already recorded Phase 3 widening the same function's RETURN and the pin's
  claim being unchanged; this is that, one tranche later. It now also pins the two conditions the widening
  exists for.
- `test/projection-reliability-loop.ts` asserted `--no-barrier` reaches no gate in `deploy/` except Phase 3's.
  Phase 7 is the second gate that faces a real provider, which has no control surface to rendezvous three
  scanners at. The allowed set is now **two, named**, and the test additionally requires that **both** allowed
  callers use the flag, so an exemption cannot outlive the caller it was made for.

### 11.7 HISTORICALLY — the §9 matrix from candidate 3, EIGHT OF NINE GREEN. §11.7.1 supersedes it

Every gate below ran on the real Unraid host from **candidate 3** — tree manifest `0930f951…`, commit
`7cb02d5` — with `PROJECTIOND_IMAGE=projectiond:phase7-frozen`
(`sha256:911df075be6fd8ce72f6a81d003645e019217a4893d3515ea04a728fb9c003e2`), serialised one after another.
**Candidate 4 changed the Phase 7 gate and nothing else** (§11.1.1), so none of these gates has a subject
that moved after this matrix ran; that is a check a reader can make rather than a reassurance.

| Gate | Runs | Result |
|---|---|---|
| `go:stale-mount-gate:three` | 3 | **exit 0** |
| `go:serve-death-gate:three` | 3 | **exit 0** |
| `go:mount-truth-gate:three` | 3 | **exit 0** |
| `go:mount-health-gate:three` | 3 | **exit 0** |
| `go:sustained-outage-gate:three` | 3 | **exit 0** |
| `go:publisher-mount-gate` | 1 | **exit 0** |
| `go:rclone-comparison-gate` | 1 | **exit 0** |
| `deploy/projection-alpha-acceptance.sh` | 1 | **exit 0 — 11 of 11 arms**, driving the shipped operator command |
| `go:recovery-gate:three` | 3 | **FAILED, 0 pass / 3 fail** — `RC8`, `RC9`, `RC11`, identically in every run, for the reason §11.4.1 gives |

**THE FOUR MOST EXPOSED GATES ARE AMONG THE GREEN ONES, AND THAT IS THE POINT OF NAMING THEM.**
`stale-mount`'s whole subject is a cold corpse, which is exactly what the changed drain now removes;
`serve-death`'s is the remount path the change lives on; `mount-truth`'s is the `ObserveMountpoint` the change
adds a second caller to; and `sustained-outage` is the control that fails if the supervisor ever became
trigger-happy. All four passed three times each.

**AND THE ALPHA INSTALL MATRIX PASSED ALL ELEVEN ARMS AGAINST THE CHANGED DAEMON**, including `AA6` — the
foreign overlay left exactly where it was — and `AA7`, the same pre-attached consumer reading the same digest
after the fault. That is the shipped operator command, driven end to end, on the candidate that carries both
product changes.

**THE ONE FAILURE IS `RC8`/`RC9`/`RC11` AND IT IS NOT A REGRESSION IN THE DAEMON.** §11.4.1 is what it is:
those three arms need a fault the product can no longer be prevented from repairing. Every arm of that same
gate which is about **repairing** a fault passed in all three runs — `RC1` through `RC7`, `RC10`, `RC12` and
`RC13`.

### 11.7.1 THE §9 MATRIX RE-RUN FROM CANDIDATE 7 — NINE OF NINE, AND `RC8`/`RC9`/`RC11` ASSERT THEIR ARM AGAIN

**§11.7 IS SUPERSEDED AS A DESCRIPTION OF THIS DAEMON AND KEPT AS HISTORY.** It ran from candidate 3, whose
`projectiond/` tree is not the one at `HEAD`: §8.4 and §8.4.5 both changed the daemon after it. This is the
matrix re-run against the daemon this record ends with.

**EVERY GATE BELOW RAN ON THE REAL UNRAID HOST FROM CANDIDATE 7** — commit
`eafe1720a29aa4ea3f88344eb88dbc8e7a2dfeb8`, tree `887cbf91be54b81e15b14d399db71983593dd4e5`, staged into an
emptied `/mnt/user/appdata/catalog-p7` and proved byte-identical **in both directions** by two independently
computed sorted manifests over **1,660** files, both hashing to
`fdce811c60148ae279cd72369eb3ef6e494e9131c5e7c2b75b2df583aeeb7f7c` — with
`PROJECTIOND_IMAGE=projectiond:phase7-frozen`
(`sha256:b7f80288aa882503754bc665cfa3bd51a288de21d951016fa7a9bcbf05c6f30f`), **serialised one after another**,
because two gates on this host bind the same loopback ports and the second dies on an allocated port.

**THE IMAGE DIGEST IS ITSELF THE CHECK THAT THE DAEMON DID NOT MOVE BETWEEN CANDIDATES 6 AND 7.** Both rebuild
to `sha256:b7f80288…` from their own frozen trees, and `git rev-parse HEAD:projectiond` is `08d9e9af01203b34`
at both — so candidate 7 differs from candidate 6 in the Phase 7 gate and this record, and in nothing the
matrix below has as a subject.

| Gate | Runs | Result |
|---|---|---|
| `go:recovery-gate:three` | 3 | **exit 0 — 3 pass / 0 fail**, cold starts of 264.9 s, 267.9 s, 265.9 s. **All thirteen arms in every run**, including `RC8` (exactly 3 attempts, closest pair **20,999 ms** against a 20,000 ms cooldown, corroborated against Docker’s own timestamps to within one tick), `RC9` (locked out, held for two further cooldowns), `RC11` (survived a container restart on the first reading, cleared only by `--reset-recovery`) and `RC5` (the foreign overlay refused, still mounted, nothing spent) |
| `go:stale-mount-gate:three` | 3 | **exit 0 — 3 pass / 0 fail**, 91.2 s, 90.9 s, 90.8 s |
| `go:serve-death-gate:three` | 3 | **exit 0 — 3 pass / 0 fail**, 17.9 s, 17.8 s, 19.5 s |
| `go:mount-truth-gate:three` | 3 | **exit 0 — 3 pass / 0 fail**, 20.7 s, 20.7 s, 20.8 s |
| `go:mount-health-gate:three` | 3 | **exit 0 — 3 pass / 0 fail**, 89.6 s, 91.3 s, 91.6 s |
| `go:sustained-outage-gate:three` | 3 | **exit 0 — 3 pass / 0 fail**, 90.0 s, 89.5 s, 88.8 s |
| `go:publisher-mount-gate` | 1 | **exit 0** |
| `go:rclone-comparison-gate` | 1 | **exit 0** |
| `deploy/projection-alpha-acceptance.sh` | 1 | **exit 0 — 11 of 11 arms**, driving the shipped operator command |

**NINE OF NINE, WHERE §11.7 MANAGED EIGHT.** The one that could not pass then is the one this tranche repaired
the injector for, and Phase 6 §11.9 is the record of that change with every assertion of the three arms
unchanged. **`RC5` PASSING IS THE MOST LOAD-BEARING ROW HERE**: Phase 7 §8.4 gives the foreign row its first
admitting case in this product’s history, and `RC5` is the arm that proves the admitting case did not become
the general case. It refused, spent nothing, and left the overlay exactly where it was, three times.

**AND `RC12` PASSING MATTERS FOR THE SAME REASON PHASE 2 EXISTS**: the same pre-attached unprivileged consumer
read the same digest after the recovery, in all three runs, without being restarted or re-bound.

### 11.8 Host cleanliness, asserted against a baseline captured before any Phase 7 container existed

**THE BASELINE IS THIS SESSION’S OWN, TAKEN BEFORE ANYTHING WAS STAGED**, because the one §11.1.1 records was
taken on a host that has since gained containers of its own: **44** containers, **28** running, **18** networks,
**46** volumes, **0** `fuse.projectiond` mounts. It is preserved beside the run transcripts.

| What | Result after everything above |
|---|---|
| container set | **IDENTICAL** — 44 entries, compared as a SET and not a count |
| running-container set | **IDENTICAL** — 28 entries |
| network set | **IDENTICAL** — 18 entries |
| volume set | **IDENTICAL** — 46 entries |
| `fuse.projectiond` mounts on the host | **0** |
| run directories anywhere under the frozen tree | **0** |
| empty gate roots left by the matrix | removed with `rmdir`, which refuses a non-empty directory and therefore could not have taken anything with it |
| gate roots remaining | **one** — `.projection-reliability-loop-gate`, holding the redaction-safe origin-recheck observations §7 requires to be recorded |
| kept evidence | every run transcript and arm log from attempts 1–6, the nine matrix logs, the matrix summary and the host baseline, at 0600 in a 0700 directory OUTSIDE the frozen tree — moved there deliberately, because a freeze empties the tree and the evidence of previous attempts may not be what a re-freeze deletes |
| operator data | **untouched.** No production mount, no existing media library, no user share, no unrelated container, network or volume, and no operator secret was modified. `endpoint.json` was **read and never written**, which §7 requires and which is what makes the blocker in §12 an operator decision rather than this tranche’s |

**AND THE UNRELATED PRODUCTION CONTAINERS WERE NEVER TOUCHED, WHICH THE SET COMPARISON IS WHAT PROVES.** 28
containers were running before and the same 28 by name are running after; a count would have allowed one to be
replaced by another.
### 11.9 THE ARM LEDGER — exactly which of the six ran, and how often

**THIS TABLE IS THE ONLY PLACE AN ARM COUNT MAY BE READ FROM**, and it exists because the roadmap row denied
a run that the same row recorded further down. What it said is kept verbatim, as a quotation and marked as
retired:

> **HISTORICALLY — SUPERSEDED.** *"NOT ONE OF THE SIX RECOVERY ARMS HAS EVER RUN, so every sentence in §3.1
> is a contract rather than a measurement, and three consecutive fresh sequences were never attempted."*

**IT WAS FALSE WHEN IT WAS WRITTEN AND THE SAME PARAGRAPH PROVED IT**, later in the same row, by recording R1
measuring FALSE twice. Both halves were written from the same two runs; only one of them was true. **TWO OF
ITS THREE CLAUSES SURVIVE** — §3.1 **is** a contract for R2 to R6, and three consecutive fresh sequences
**were** never attempted — and it is the first clause that the ledger below is what should always have stood
in place of.

**THE QUOTATION ABOVE IS INSIDE A BLOCKQUOTE AND THAT IS LOAD-BEARING RATHER THAN TYPOGRAPHY.**
`test/projection-evidence-consistency.ts` treats a universal denial as a live claim **unless** it is quoted:
an asserted denial beside a record of the thing happening is the contradiction it fails on, and a denial in a
`>` block is history. So a future writer cannot retire a false sentence by indenting it, and cannot smuggle a
live one in either — the marker has to be a quotation of something that is no longer claimed.

| Arm | Times executed | Outcome | Where |
|---|---|---|---|
| **R1** | **5** — attempts 3, 4, 5, 6 and 7 | **FAILED twice, identically, then RECOVERED.** Attempts 3 and 4: `P7-R1-action-ms` 34,304 and 34,085 against 33,000, no attempt spent, the generation never advanced, the namespace never came back, the operator’s four windows **0 of 4**. Attempt 5, from the candidate that carries §8.4: **every assertion of the arm passed** — 14,603 ms to one bounded `recover-mount-underlay`, 17,153 ms to a sibling reading a byte again, **4 of 4** windows, all three servers reading inside their own containers, one layer above the floor. Attempt 6 reproduced all of that from the candidate that carries §8.4.5 — 13,109 ms and 15,615 ms — and additionally passed `P7-R1-remediation`, the one assertion attempt 5 failed **Attempt 7 reproduced it a third time from candidate 8** — 14,490 ms and 16,913 ms, one layer, the underlay fingerprint `fccf4ba8c5c2` identical across the fault, and `P7-arm-binds-unchanged` passing for the first time in this arm’s history (§11.4 #15 is why it never could before) | §11.3.1, §11.3.2, §11.3.3, §11.3.4 |
| **R2** | **3** — attempts 5, 6 and 7 | **PASSED every assertion of the arm.** The corpse was verified stale, `action-ms` 11,510/33,000, `ready-ms` 13,811/59,000, one action, one layer, 4 of 4 windows, all three servers reading. Attempt 6 reproduced it: 13,096 ms and 15,367 ms, one layer **Attempt 7 reproduced it again**: 12,974 ms and 15,209 ms, one layer, binds unchanged | §11.3.3, §11.3.4 |
| **R3** | **3** — attempts 5, 6 and 7 | **PASSED in attempt 5; BLOCKED in attempt 6** by the provider rotating to an origin the operator has not allowlisted, which §7 predeclares as BLOCKED rather than failed. In attempt 5: reads failed inside the deadline, the breaker held, nothing reached the live resolver during the hold, the first read after release digest-matched, and `recoveryGeneration` did not advance **Attempt 7 is the first run to complete this arm since §8.5, and every assertion of the arm passed again** — `read-fail-ms` 611/20,000, 0 requests through the hold, `recovery-ms` 1,341/80,000, `no-recovery-action` 0/0, the mount untouched — **while `P7-arm-layers` measured 2/1. That is §11.4 #16 and it is the blocker this tranche now ends on** | §11.3.3 |
| **R4** | **2** — attempts 5 and 7 | **PASSED its own assertions.** The serve-death supervisor remounted in place, draining one corpse of its own first, and the entry was unchanged **Attempt 7 reproduced it**: `ready-ms` 1,572/22,000, identity unchanged, the recovery loop declining, `single-flight` 1/1 across both supervisors — **with `P7-arm-layers` still 2/1, inherited from R3** | §11.3.3 |
| **R5** | **2** — attempts 5 and 7 | **PASSED.** `refuse-foreign-mount` / `inspect-mount-owner` beside `recoveryUnderlay=underlay-covered`, nothing spent, and the tmpfs asserted still mounted and byte-unmodified afterwards **Attempt 7 reproduced it**, with `recoveryAttempts` still 0 and the tmpfs still on top and byte-unmodified — **and `P7-arm-layers` still 2/1, inherited from R3** | §11.3.3 |
| **R6** | **2** — attempts 5 and 7 | **FAILED, AND THE INJECTOR IS WHY.** `umount -l` with nothing holding the connection killed the serve loop, so the SERVE supervisor took the fault, its three remounts failed under the masked `/dev/fuse`, and the daemon exited with the recovery loop having spent nothing — §11.4 #14 **Attempt 7 ran the REPAIRED injector for the first time and the arm still did not reach its subject.** `P7-R6-connection-held` passed — the open descriptor #14 added is held — and then the injector’s own premise assertion refused: one of our mounts remained after the lazy detach, because R3 had left two stacked. **#14 remains unmeasured, for a reason that is not #14** — §11.4 #16 | §11.3.3 |

**THE PER-ARM VERIFICATION OF §3.2 IS NOT THE SAME THING AS AN ARM PASSING, AND ATTEMPT 5 IS WHERE THAT
DISTINCTION HAS TO BE MADE.** R1 to R5 each passed their own arm’s assertions, and R1 to R5 each **failed**
`P7-arm-binds-unchanged` — because the baseline that comparison is made against had never once been readable
(§11.4 #12) — while R3 to R5 also failed `P7-arm-layers` at 2/1 (§11.4 #13). **SO NO ARM IN THAT RUN IS
RECORDED AS HAVING PASSED THE WHOLE OF §3.2**, and the table above says what each arm’s own assertions did and
deliberately nothing more.
**SO: ALL SIX ARMS HAVE NOW RUN, TWICE, IN TWO SEQUENCES THAT BOTH FAILED. NO SEQUENCE HAS EVER PASSED, AND
THEREFORE NO SEQUENCE HAS EVER BEEN REPEATED IN THE SENSE §4.1 MEANS** — the three-consecutive-fresh-runs rule
has now been reached twice and satisfied neither time.

**AND EVERY ARM NOW HAS A REPEAT, WHICH IS NEW AND IS NOT THE SAME THING AS A PASS.** R1 to R5 met their own
arms' assertions in attempt 7 as they did in attempt 5, and four of the five figures moved by less than three
seconds against budgets between 20 and 80 times larger — which is the only stability claim this ledger makes.
**R6 has still never reached its subject**, and the reason changed: in attempt 5 it was #14's injector, in
attempt 7 it was #16's residual defeating the premise the repaired injector now asserts rather than assumes.

**AND ATTEMPT 7 IS THE FIRST RUN IN WHICH `P7-arm-binds-unchanged` PASSED ANYWHERE.** It failed on every arm of
attempt 5 against a baseline that had never been readable (#12) and on both arms of attempt 6 on array order
(#15); it passed on all five arms that reached it in attempt 7. **That assertion is the one that pays for
*"no consumer was restarted or re-bound to make a recovery visible"*, and this is the first time in this
tranche that sentence has been backed by a measurement rather than by an instrument that could not speak.**

### 11.10 WHICH CANDIDATE EVERY FIGURE CAME FROM, AND WHERE `HEAD` STANDS

**DOCUMENTATION-ONLY CLOSURE COMMITS MAY NOT PRETEND TO BE MEASURED SOURCE**, which is the Phase 6 defect in
its most tempting form: a record that ends at a commit nothing was run from. This section is where that is
said, and it is rewritten rather than appended to every time the candidate moves.

| | Commit | Phase 7 gate source | `projectiond/` | Ran on a host? |
|---|---|---|---|---|
| the candidate §11.3.3 measured | `d38e45a22b699c9f64d33dfc7fa3fbe2c26d957a` | `98a7491602c200ca` | `0d7c371dc059c1cb` | **yes** — attempt 5, all six arms |
| the candidate §11.3.4 measured | `566d2afbd599f8b3c1f619be15614a6b343dc5dc` | `96c12f0c1d116288` | `08d9e9af01203b34` | **yes** — attempt 6 |
| the candidate §11.7's matrix ran from | `7cb02d5a3909a283ea2851275933ace2160184c7` | `87b7238355d25e89` | `6a8a371f04ff113d` | **yes** |
| the candidate §11.7.1's matrix ran from | `eafe1720a29aa4ea3f88344eb88dbc8e7a2dfeb8` | `ae419db2714d8616` | `08d9e9af01203b34` | **yes** — the nine-gate matrix, no sequence attempt |
| **the candidate §11.3.5 measured** | **`f512b5656c26aa3f6bfe97d334f5d6367e0c5336`** | `ae419db2714d8616` | `08d9e9af01203b34` | **yes** — attempt 7, all six arms |
| **current `HEAD`** | this commit | see §11.14 | see §11.14 | **see §11.14** |

**WHAT THIS COSTS, STATED AS A DEPENDENCY RATHER THAN A DISCLAIMER:**

- **§11.7's regression matrix ran from candidate 3, whose `projectiond/` tree is NOT the one at `HEAD`.** The
  daemon changed twice after it — §8.4 and §8.4.5 — so **that matrix does not describe the daemon this record
  ends with**, and §11.12 says what has and has not been re-run against the current one. That is the strongest
statement this section has ever had to make, and it is the honest one.
- **§11.3.1's attempt 3 and §11.3.2's attempt 4 describe a daemon that could not tell the operator's own bind
  from a stranger.** Their R1 results stand as history and are superseded as behaviour: §8.4 is the change and
  §11.3.3 is the measurement.
- **The operator source has not moved since candidate 5** — `6dbb238d51f6415f` at candidate 5, at candidate 6
  and at `HEAD` — so anything §11.7 says about the shipped operator command still describes the command that
ships today.
- **THE PHASE 7 GATE SOURCE DIGEST FOR CANDIDATES 7 AND 8 IS `ae419db2714d8616`, AND IT IS THE FIRST TIME
  EITHER HAS BEEN GIVEN AS A NUMBER.** §11.12 recorded candidate 7's as *"`96c12f0c1d116288` plus the §11.4
  #15 fix"*, which is a description of a change rather than a digest of a tree and is not something a reader
  can check. It is now computed under the same recipe `test/projection-bounded-recovery.ts` uses — path, then
  LF-normalised content, sorted, one sha256 — over the six Phase 7 gate files, and the recipe is confirmed by
  re-deriving the two figures the record already carries: `98a7491602c200ca` at candidate 5 and
  `96c12f0c1d116288` at candidate 6, exactly.
- **Anything the current `HEAD` has not run is named in §11.14 and is claimed nowhere else in this document.**
### 11.11 The pins that make this record check itself, and the tamper that proves they bite

**A COORDINATOR AUDIT FOUND TWO CONTRADICTIONS IN THIS RECORD AND NO TEST HAD NOTICED EITHER.** The roadmap
row denied a run it recorded three sentences later, and both documents went on stating **five** defects and
**two** in the product while the ledger at §11.4 had grown to **seven** and **three**. Neither is a threshold
and neither is a measurement error — they are the record disagreeing with itself, which is the exact failure
`test/projection-evidence-consistency.ts` was built for and did not cover.

**FOUR ASSERTIONS NOW COVER IT, AND EACH WAS PROVED TO BITE BY A TEMPORARY TAMPER THAT WAS THEN REVERTED:**

| Assertion | Tamper | What it said |
|---|---|---|
| `PHASE7-RECOVERY-ARM-RUN-EXISTENCE` (a new axis) | re-assert the retired arm denial §11.9 quotes, unquoted, in the roadmap row | **FAILED** — *"docs/PROJECTION_ROADMAP.md deny that it ever happened while …PHASE_7… records that it did"* |
| the roadmap's defect counts against the ledger | roadmap says **five / two** | **FAILED** — *"does not state 'seven defects', which is what §11.4's table holds. It said FIVE for the whole interval in which the ledger held seven"* |
| this document's headline against its own table | headline says **two** in the product | **FAILED** — *"§11.4 lists 7 defect row(s), 3 of them fixed in the product, but no headline in the document states…"* |
| the arm ledger against the roadmap | — | passes; it requires the roadmap to NAME every arm the ledger records as having executed, so silence is not a way out either |

**THE COUNTS ARE DERIVED, NOT RESTATED.** The check parses §11.4's table, counts the rows, counts the rows
whose fix cell says **the product**, and requires both documents to state those two numbers. A row added
without updating either prose summary fails immediately — which is precisely what would have happened when
defects #6 and #7 landed.

**AND THE HISTORY RULE IS NARROW ON PURPOSE.** A universal denial counts as **asserted** unless it is inside
a markdown blockquote, so this record can keep the false sentence it retired — as every closed tranche here
does — without the check either passing over a live claim or forcing the history to be deleted to go green.
Italics and bold do not exempt anything; only a `>` quotation does.

**AND THE FIRST THING THAT RULE CAUGHT WAS THIS SECTION.** The table above originally reproduced the retired
sentence verbatim, in a table cell, to describe the tamper — and the axis failed the document immediately,
because a table cell is an assertion. The cell now points at §11.9's blockquote instead of repeating it. That
is the pin working on the writer who wrote it, within a minute of it existing, which is the most that can
honestly be said for any check of this kind.

### 11.11.1 THE TEN TAMPERS THAT PROVE THE NEW PINS BITE, AND THE TREE THEY WERE REVERTED INTO

**A PIN NOBODY HAS SEEN FAIL IS A PIN NOBODY HAS TESTED**, which is the rule §11.11 already applies to the
four evidence-consistency axes. Every assertion §8.4, §8.4.5, §8.5 and §8.6 rest on was driven the same way:
edit ONE shipped or documented fact, run the suite that is supposed to notice, record what it said, revert with
`git checkout --`. **All ten failed the intended assertion and the working tree was clean after every revert**,
which is the second half of the claim: a tamper that was not reverted is a tamper that shipped.

| Tamper | What was changed | What failed |
|---|---|---|
| 1 | a safety clause removed from §8.4 | *the contract predeclares the classification decision, its four verdicts and its safety clauses* |
| 2 | §3.1’s R1 clause SOFTENED rather than reinstated | *the reinstated R1 clause is reinstated WORD FOR WORD, and the history of it being false is kept* |
| 3 | R6 put back to stacking a corpse | *R6 injects R1’s fault, which is what §3.1 predeclared for it* |
| 4 | `RC8` loses the descriptor holder | *Phase 6’s RC8 injector is repaired the same way, and its assertions are untouched* |
| 5 | R1 stops asserting the fingerprint is unchanged | *the gate reads the two new surface fields and asserts them on BOTH sides* |
| 6 | R5 stops comparing the published verdict | *the gate reads the two new surface fields and asserts them on BOTH sides* |
| 7 | the drain-alone repair stops being a named decision | *the layer residual fix is a named decision with a table* |
| 8 | a FIFTH underlay verdict declared in Go only | *the Go source publishes no code the contract does not name* |
| 9 | the two startup measurements stop being cross-checked | *a fingerprint that disagrees with the startup count is discarded rather than trusted* |
| 10 | the fingerprint moved to AFTER the first mount | *the underlay fingerprint is taken BEFORE the first mount and is never re-taken* |

**AND FIVE MORE PINS WERE PROVED IN THE GO PACKAGE THE SAME WAY.** Widening the admitting condition from
`underlay == UnderlayExposed` to `underlay != ""` failed three tests by name — the classification table, the
read-only-on-the-foreign-row table and the unwired-verifier branch. **The read-only table failed only after it
was strengthened**, and that is worth recording: as first written it compared every verdict against a BASELINE
computed from `underlay-unknown`, and the tamper moved the baseline too, so an invariance check alone passed a
change that had made every foreign mount actionable. The foreign row is now asserted absolutely on both sides.

### 11.11.2 THE FIVE TAMPERS THAT PROVE THE PINS STILL BITE AFTER ATTEMPT 7, AND THE TREE THEY WERE REVERTED INTO

**THIS TRANCHE'S RECORD GREW A DEFECT ROW, A COUNT, A RETIRED HEADING AND A NEW SECTION, AND EVERY ONE OF
THOSE IS A PLACE A STALE SUMMARY CAN HIDE.** So the same discipline §11.11.1 applied to the product pins was
applied to the record's own: edit ONE fact, run the suite that is supposed to notice, record what it said,
revert with `git checkout --`. **All five failed the intended assertion and `git status` was empty after every
revert**, which is the second half of the claim.

| Tamper | What was changed | What failed, in its own words |
|---|---|---|
| 1 | the roadmap keeps the **old** defect count while §11.4 holds sixteen rows | *"the Phase 7 roadmap row does not state '16 defects', which is what §11.4's table holds"* |
| 2 | defect row **#16 deleted** from the §11.4 ledger, leaving the headline claiming sixteen | *"§11.4 lists 15 defect row(s), 6 of them fixed in the product, but no headline in the document states…"* |
| 3 | §8.5 stops stating that the predeclared layer threshold did not move | *"§8.5 no longer states that the predeclared layer threshold did not move"* — `test/projection-phase7.ts`, 42 passed, 1 failed |
| 4 | the universal denial §11.9 keeps in a blockquote re-asserted, **unquoted**, in the roadmap | *"PHASE7-RECOVERY-ARM-RUN-EXISTENCE: docs/PROJECTION_ROADMAP.md deny that it ever happened while docs/…PHASE_7… records that it did"* |
| 5 | one line appended to the **shipped** operator command `deploy/projection-alpha.sh` | *"the closure record's SHIPPED SOURCE digests still describe the working tree"* — the Phase 6 pin refusing to certify a run of source that no longer exists |

**AND TAMPER 4 CAUGHT THE WRITER OF THIS SECTION, WITHIN A MINUTE, EXACTLY AS §11.11 SAYS IT CAUGHT THE
WRITER OF THAT ONE.** The row above originally described the tamper by **reproducing** the retired sentence in
the table cell, and the axis failed the document immediately — a table cell is an assertion, and italics do
not exempt it; only a `>` quotation does. The cell now points at §11.9's blockquote. **This is the second time
in this document that this specific pin has failed the person adding a section about it**, which is the most
that can honestly be said for any check of this kind, and it is worth twice the paragraph it costs.

**TAMPER 2 IS THE ONE WORTH DWELLING ON, BECAUSE IT IS THE DEFECT THIS SECTION EXISTS FOR IN MINIATURE.**
Deleting the row for #16 does not make the document say something false about #16 — it makes the document say
nothing about it, while a headline three paragraphs up still counts it. **That is exactly the shape of what
#16 itself is**: a claim about a defect, supported by a run that could not have observed it, with no check
that knew the difference. The count pin catches the arithmetic version. **Nothing yet catches the reasoning
version**, and §11.4's closing paragraph says so rather than implying the pins are complete.

### 11.11.3 THE SIX TAMPERS THAT PROVE §8.7's PINS BITE, AND THE TREE THEY WERE REVERTED INTO

**A PIN NOBODY HAS SEEN FAIL IS A PIN NOBODY HAS TESTED**, which is the rule §11.11.1 and §11.11.2 already
apply. §8.7 adds a product decision, an ownership proof, a gate change and three required assertions, and every
one of them was driven the same way: edit ONE shipped or documented fact, run the suite that is supposed to
notice, record what it said, revert with `git checkout --`. **All six failed the intended assertion and
`git status` was empty after every revert.**

| Tamper | What was changed | What failed, in its own words |
|---|---|---|
| 1 | a safety clause removed from §8.7's contract | *"§8.7's safety contract no longer states: AT MOST ONE ROW IS EVER REMOVED"* |
| 2 | the ownership proof widened from the recorded IDENTITY back to a file-system type | **BOTH HALVES FAILED, AND THE GO ONE IS THE INTERESTING ONE.** `TestPlanShutdownDetachRemovesOnlyTheRowThisProcessMade` failed on the row *"ANOTHER MOUNT OF OURS is on top — same type, same shape, different attachment"*: *"want detach=false, got true (the row on top is byte-for-byte the attachment this process created)"* — a reason string that had stopped being true of the code printing it. And `test/projection-phase7.ts`: *"the shutdown no longer compares the row on top against the identity this process recorded, so it is deciding on a shape again — which is defect #5 exactly"* |
| 3 | `restart_daemon` put back to `docker rm -f` | *"restart_daemon force-removes the daemon again, which is the SIGKILL that produced #16"* |
| 4 | `P7-R3-restart-left-no-layer` removed from the contract module's required set, leaving the gate still recording it | *"P7-R3-restart-left-no-layer is not required by the contract module, so a run that omitted it would still be a passing run"* |
| 5 | the sequential regression collapsed to ONE generation — a cold start, which is what every previous table was | *"the sequential regression is no longer a loop over generations"* |
| 6 | the roadmap keeps the old product-fix count while the §11.4 ledger has moved | *"the Phase 7 roadmap row does not state that seven of them are in shipped product code"* |

**TAMPER 2 IS THE ONE WORTH DWELLING ON AND IT IS THE WHOLE ARGUMENT OF §8.7.2 IN ONE FAILURE.** The widened
condition is the one every previous version of this decision in this repository has used, and it passes eight of
the nine rows in the table. The row it fails is a `fuse.projectiond` mount, above the floor, at the right path,
that this process did not make — which is not a hypothetical: §11.4 #5 is the run where exactly that description
matched two different mounts and the drain removed the live one. **A shape test cannot tell them apart and an
identity can.**

**AND TAMPER 5 IS THE ONE THIS TRANCHE'S OWN HISTORY DEMANDS.** #13 was recorded as resolved on a run that
reached only the arms the defect has never appeared in, and #16 is the correction. A regression that measured
one generation would repeat that mistake in miniature: **every generation in isolation measures one layer above
its OWN floor**, and the whole defect is that the floor moves. The control arm inside that same test asserts the
defect still reproduces with the fix disabled, so a green result is evidence that the fix is what removes the
layer rather than that the scenario stopped being modelled.

### 11.12 HISTORICALLY — WHAT CANDIDATE 7 HAD RUN, AND WHAT IT HAD NOT. §11.14 SUPERSEDES IT

**THIS SECTION IS KEPT AS IT STOOD AND IS NO LONGER THE ANSWER TO ITS OWN QUESTION.** The candidate has moved
to **8** and the blocker it ends on has been cleared by the operator action of §11.13; §11.14 is what the
current candidate has and has not run, and it is the section a reader should use. Two things below are known
to be superseded rather than wrong: the gate source is given as a description rather than a digest (§11.10
now gives the number, `ae419db2714d8616`), and the last row's *"NOT ONCE"* is still true and now has company —
attempt 7 ran the single gate and §11.14 says what that does and does not settle.

**CANDIDATE 7 IS `eafe1720a29aa4ea3f88344eb88dbc8e7a2dfeb8`**, tree `887cbf91be54b81e15b14d399db71983593dd4e5`,
`projectiond/` tree `08d9e9af01203b348d99d9020754ede038808487`, Phase 7 gate source `96c12f0c1d116288` plus the
§11.4 #15 fix, operator source `6dbb238d51f6415f`, staged byte-identically in both directions over **1,660**
files (`fdce811c60148ae279cd72369eb3ef6e494e9131c5e7c2b75b2df583aeeb7f7c` on each side independently), image
`sha256:b7f80288aa882503754bc665cfa3bd51a288de21d951016fa7a9bcbf05c6f30f`.

**AND THE COMMITS AFTER THE FREEZE MOVE `docs/` AND NOTHING ELSE, WHICH IS A CHECK RATHER THAN A REASSURANCE.**
`git diff eafe172..HEAD -- deploy/ projectiond/ src/ docker-compose.projection-phase7.yml
docker-compose.projection-recovery.yml docker-compose.projection-alpha.yml` is **empty**, so every subject the
matrix in §11.7.1 measured is byte-identical at the commit this record ends with. That is the claim Phase 6’s
first closure row made falsely, stated here as something a reader can run.

| | From candidate 7? |
|---|---|
| the whole §9 regression matrix, nine of nine | **YES** — §11.7.1 |
| Phase 6 `go:recovery-gate:three`, three cold starts, thirteen arms each | **YES** — §11.7.1, and Phase 6 §11.9 |
| the alpha install matrix, 11 of 11 arms, shipped operator command | **YES** — §11.7.1 |
| TypeScript, `gofmt`, `go vet`, every Go package | **YES** — §11.5 |
| the focused Phase 2–7, evidence-consistency and custody suites | **YES** — §11.5 |
| the full offline inventory | **YES** — §11.5 |
| the ten-tamper proof that the new pins bite | **YES** — §11.11.1 |
| **`npm run go:phase7-gate:three` — the sequence this tranche closes on** | **NO. NOT ONCE.** |

**THAT LAST ROW IS THE TRANCHE.** Candidate 7 exists because candidate 6 exposed §11.4 #15, and the Phase 7
gate source therefore moved after the last sequence attempt. **NO FIGURE IN §11.3.3 OR §11.3.4 WAS TAKEN WITH
THE GATE AS IT STANDS**, and the two arms those attempts each passed — R1 and R2 — are attributed to candidates
5 and 6 in §11.9 and nowhere else.

**WHY THE SEQUENCE HAS NOT RUN FROM IT, STATED AS A FACT RATHER THAN AS A PLAN.** From the moment candidate 7
was frozen the provider has been serving a CDN origin the operator has not allowlisted — `4fea5e1bdeaa`,
against an `allowedOriginCount` of 5, verdict `disallowed`, re-observed after the whole matrix had run. §7
predeclares that a run into that is **BLOCKED rather than failed** and that **no automated part of this
tranche writes `endpoint.json` on its own initiative**, so the sequence was not launched into a state in which
every read fails at the egress allowlist. The blocker was escalated with a **digest and a count and nothing
else**, and every provider-free obligation in §4.1 was completed while it stood — which is the whole of
§11.7.1. **The operator then answered that escalation; §11.13 is the answer and what it changed.**

**WHAT WOULD CLOSE IT, EXACTLY.** One operator action or one rotation back to an allowlisted pool member, and
then `npm run go:phase7-gate:three` from candidate 7 with nothing else touched. Everything else §4.1 asks for
is done and recorded above.

### 11.13 THE OPERATOR ACTION THAT CLEARED THE BLOCKER, AND EVERY NUMBER IT IS ALLOWED TO STATE

**THIS IS THE ONE THING IN THIS DOCUMENT THAT CHANGED SOMETHING OUTSIDE THE REPOSITORY**, so it is recorded
with more care than anything else here and less detail than anything else here — the two are the same
requirement. On **2026-08-13** the operator, having been given §11.12's digest and count and nothing else,
**explicitly instructed that the currently served TorBox CDN origin be added to the existing
`allowedOrigins`, preserving every existing entry.** That instruction is the whole authority for what
follows; §7 now says what it does and does not license.

**HOW IT WAS DONE, AND WHY EACH CHOICE IS THE NARROW ONE.** A single-purpose program ran inside the same
pinned `node:22-alpine` container, against the same official resolver started the same loopback-only,
unpublished way `deploy/projection-provider-origin-recheck.sh` starts it, from the staged candidate-7 tree.
It resolved **one** reference — one resolution, no ranged GET, no byte of media — took `URL.origin`, and
appended it. **The plaintext origin never left that process except into `endpoint.json` itself**, which is the
only place it belongs; nothing was printed, logged, echoed, committed or messaged but digests, counts and
verdicts. **It is not a gate step and no gate can call it.**

- **The normal form written is `URL.origin` verbatim**, which is already the daemon's own: `ParseOrigin` in
  `projectiond/internal/source/egress.go` lower-cases the host and fills the default port, and `OriginOf`
  derives the same tuple from a URL about to be dialled. An explicit `:443` or a trailing slash would have
  been accepted by the daemon and **rejected by the recheck's string compare** — two instruments disagreeing
  about the same file is the confusion this had to avoid, not a formatting preference.
- **Existing entries were carried through byte-for-byte and in order.** "Deduplicate" was read as *do not add
  a second copy*, never as *tidy the operator's list*; rewriting an origin authorised at some other time is
  not what was authorised now.
- **A plaintext origin would have been refused outright** rather than bought with `allowInsecureHttp`, because
  `endpointProblems` in `src/core/projection/real-provider.ts` refuses a non-`https` allowlist entry for a
  real endpoint and this action will not write a file the product's own validator would reject.
- **Restrictive backup first, then an atomic same-directory rename.** The temporary file was created `0600` by
  an explicit mode at `open` — not chmodded after the fact, so no instant existed at which a wider mode did —
  `fsync`ed before the rename so a crash could not leave a truncated allowlist behind a valid name, and
  `chown`ed and `chmod`ed to the original's own uid, gid and mode. The backup is the operator's recovery path
  and it is the third one this directory holds.
- **The result was re-read from disk before anything was claimed about it.** What was intended is not
  evidence; the table below is what the file said afterwards.

| | Before | After |
|---|---|---|
| `allowedOriginCount` | **5** | **6** |
| allowlisted origin digests | `256c61b89300`, `b16331429dc1`, `09e2a517af25`, `3cfc7340a785`, `768788145621` | the same five, **in the same order**, plus `4fea5e1bdeaa` |
| top-level fields | `allowInsecureHttp`, `allowPrivateAddresses`, `allowedOrigins`, `id` | **identical set, and identical values outside `allowedOrigins`** |
| mode / ownership | `0600`, `root:root` | **`0600`, `root:root` — preserved, and asserted preserved** |

**THE MEASUREMENT ON EITHER SIDE, TAKEN BY THE INSTRUMENT THAT IS NOT THE ONE THAT WROTE THE FILE.**

| Observation | `allowedOriginCount` | resolved origin digest | verdict |
|---|---|---|---|
| recheck, immediately **before** (`origin-recheck-20260813T210000Z`) | 5 | `4fea5e1bdeaa`, scheme `https` | **`disallowed`**, exit 70 |
| the write itself | 5 → 6, `alreadyPresent=no`, `action=appended` | `4fea5e1bdeaa` — **matched the escalated digest §11.12 named** | `written` |
| recheck, immediately **after** (`origin-recheck-20260813T210019Z`) | 6 | `4fea5e1bdeaa`, scheme `https` | **`allowed`**, exit 0 |

**THE ORIGIN THAT WAS ADDED IS THE ONE THAT WAS ESCALATED.** The digest the operator was given in §11.12 and
the digest of the origin written are the same twelve hex characters, checked by the program before it wrote
anything and re-checked by the recheck afterwards. The provider had **not** rotated again in the interval, so
no substitution question arises.

**THE BACKUP, WHICH IS THE ONLY PATH THIS SECTION PRINTS:**
`/mnt/user/appdata/catalog/secrets/real-provider/torbox/endpoint.json.backup-20260813T210006Z`, `0600`,
`root:root`, 316 bytes — the pre-write file exactly.

**WHAT THIS DOES NOT DO, BECAUSE THE TEMPTATION IS OBVIOUS AND IT IS THE WHOLE RISK OF THE SECTION.** It does
not weaken allowlisting: the allowlist is one entry wider and every other lever is where it was. It does not
make any arm easier to pass, does not touch a threshold, a budget, an assertion or a digest check, and it
does not retroactively un-BLOCK attempt 2 or attempt 6 — **those remain BLOCKED and count toward nothing**,
exactly as §7 predeclared. And it does not promise the blocker is gone for good: the pool rotates on nobody's
schedule, the recheck is still run immediately before every sequence, and a rotation mid-run is still
**BLOCKED rather than failed**.

### 11.14 WHAT CANDIDATE 8 HAS RUN, AND WHAT IT HAS NOT

**CANDIDATE 8 IS `f512b5656c26aa3f6bfe97d334f5d6367e0c5336`**, tree
`61cf1b6c5443bf5e0358062d2fbf44877dd9ca40`, `projectiond/` tree
`08d9e9af01203b348d99d9020754ede038808487`, Phase 7 gate source `ae419db2714d8616`, operator source
`6dbb238d51f6415f`, staged into an **emptied** `/mnt/user/appdata/catalog-p7c8` and proved byte-identical **in
both directions** by two independently computed sorted manifests over **1,660** files, both hashing to
`fc64a0f72f5d2502c97a0bbea49d2d376aa7d0e893ead4e876531b65ca5e338e`, image
`sha256:b7f80288aa882503754bc665cfa3bd51a288de21d951016fa7a9bcbf05c6f30f`.

**THE IMAGE DIGEST IS ITSELF THE CHECK THAT THE DAEMON DID NOT MOVE BETWEEN CANDIDATES 6, 7 AND 8.** All three
rebuild to `sha256:b7f80288…` from their own frozen trees and `git rev-parse HEAD:projectiond` is
`08d9e9af01203b34` at all three. Candidate 8 differs from candidate 7 in `docs/` and in nothing else:
`git diff eafe172..f512b56 -- deploy/ projectiond/ src/ test/ docker-compose.projection-phase7.yml
docker-compose.projection-recovery.yml docker-compose.projection-alpha.yml` is **empty**.

| | From candidate 8? |
|---|---|
| **attempt 7 — the full Phase 7 gate, one run, all six arms** | **YES** — §11.3.5. **IT FAILED**, at R6, on §11.4 #16 |
| the whole §9 regression matrix, **nine of nine** | **YES** — the table below |
| Phase 6 `go:recovery-gate:three`, three cold starts | **YES** — **14 of 14 arms in every run** |
| the alpha install matrix, **11 of 11 arms**, shipped operator command | **YES** |
| TypeScript, `gofmt`, `go vet`, all 11 Go packages — **on Unraid**, not only on the development host | **YES** — §11.5.1 |
| the full offline inventory, on **both** hosts | **YES** — §11.5.1, and 9 of 314 refuse to certify Unraid for host reasons proved pre-existing at candidate 7 |
| **`npm run go:phase7-gate:three` — the sequence this tranche closes on** | **NO. STILL NOT ONCE.** |

**THE §9 MATRIX, RE-RUN FROM CANDIDATE 8, SERIALISED, WITH `PROJECTIOND_IMAGE=projectiond:phase7c8-frozen`:**

| Gate | Runs | Result |
|---|---|---|
| `go:recovery-gate:three` | 3 | **exit 0**, 797 s for the sequence, **14 of 14 arms in every run** — including `RC8` (three attempts, the closest pair 20,999 ms against a 20,000 ms cooldown, corroborated against Docker's own timestamps to within one tick), `RC9`, `RC11`, `RC5` and `RC12` |
| `go:stale-mount-gate:three` | 3 | **exit 0**, 271 s |
| `go:serve-death-gate:three` | 3 | **exit 0**, 54 s |
| `go:mount-truth-gate:three` | 3 | **exit 0**, 62 s |
| `go:mount-health-gate:three` | 3 | **exit 0**, 274 s |
| `go:sustained-outage-gate:three` | 3 | **exit 0**, 268 s |
| `go:publisher-mount-gate` | 1 | **exit 0**, 101 s |
| `go:rclone-comparison-gate` | 1 | **exit 0**, 128 s |
| `deploy/projection-alpha-acceptance.sh` | 1 | **exit 0 — 11 of 11 arms**, driving the shipped operator command |

**NINE OF NINE AGAIN, FROM THE CANDIDATE THE SEQUENCE ATTEMPT ALSO RAN FROM**, which is the first time in this
tranche that the matrix and a six-arm sequence attempt have come from the **same** frozen tree and image. It
is worth being precise about what that buys and what it does not: it removes the caveat §11.10 had to carry
about §11.7's matrix describing a different daemon, and it removes nothing at all from §11.4 #16.

**WHY `go:phase7-gate:three` WAS NOT RUN, AS A DECISION RATHER THAN AN OMISSION.** The single gate that
precedes it **failed on an arm**. Launching three consecutive fresh sequences from a candidate whose first
sequence fails deterministically at R3 would spend three more hours and the operator's metered account to
produce three copies of the same failure — and §4.2's *"any run that skips anything"* and
*"fewer than three fresh complete passing sequences"* are not reachable from here by repetition. **The
sequence is owed from the candidate that fixes #16, and from no other.**

**AND THE HOST CAME BACK EXACTLY AS IT WAS.** The baseline was captured **before anything was staged**, from
the same host §11.8's was: **44** containers, **28** running, **18** networks, **46** volumes, **0**
`fuse.projectiond` mounts. After attempt 7 and after the whole matrix, all four are the **same sets** — not
merely the same counts — with **0** `fuse.projectiond` mounts and no run directory under any gate root.
**The unrelated `hindsight` and `hindsight-db` services were up before and are up now, on the same start
instants, and nothing in this tranche touched them or any operator data.**

**ONE DIFFERENCE WAS FOUND AND IT IS RECORDED RATHER THAN QUIETLY TIDIED.** Running the Go toolchain on the
host — `go:fmt`, `go:vet`, `go:test`, which go through `docker-compose.projectiond.yml` — left **one network
and two volumes** behind: `catalog-p7c8_default`, `catalog-p7c8_projectiond-gomod`,
`catalog-p7c8_projectiond-gocache`. They are Compose's own scaffolding for the toolchain, not a gate's, and
**no gate left anything**; they were removed and the four sets then matched the pre-run snapshot exactly. It
is stated here because §4.1 clause 7 asks for the same **sets**, and a difference discovered and cleaned is a
different fact from no difference at all.

### 11.15 WHAT CANDIDATES 9 AND 10 HAVE RUN, AND WHAT THEY HAVE NOT

**CANDIDATE 9 IS `3f3446f19bfce0c9c124de1edd6bf32384e10b88`**, tree `6014753b1b99097810df3d20f4f97ce0c4334b34`,
`projectiond/` tree `93c515dd397e361acd08aef7f01f6937ac320d8d`, Phase 7 gate source `2d5cef3f68c50455`, operator
source `6dbb238d51f6415f`, staged into an **emptied** `/mnt/user/appdata/catalog-p7c9` and proved byte-identical
**in both directions** by two independently computed sorted manifests over **1,661** files, both hashing to
`0b509fcbfeac41eafd1a713e2ffbd9ac3257ce7266ee83658bc3684a30302a1e`. Image
`sha256:d534ae139300a3bd731d1998be4d7e444078c405b17fe9e103757d2a91a7e4ac`.

**CANDIDATE 10 IS `842b8f2c5d2dc36d6d955e367788f2d5a95ea1f5`**, tree `030a205559f2880545fd7233db38cf05c2f3a28e`,
the **same** `projectiond/` tree, Phase 7 gate source `76f2fe0d2bf5031f`, the same operator source, staged into
an **emptied** `/mnt/user/appdata/catalog-p7c10` and proved byte-identical **in both directions** over **1,662**
files, both manifests hashing to `62be988d38da323ab114dc880195d00a151c443bb3ae6b5597b0d66efb5a1f17`. It rebuilds
from its own frozen tree to the **same image digest**, which is the check that the daemon did not move between
them.

**WHY THERE ARE TWO CANDIDATES AND NOT ONE, STATED AS A RULE BEING KEPT RATHER THAN AN ACCIDENT.** Candidate 9
was frozen, staged and measured first; candidate 10 adds `deploy/projection-mount-propagation-probe.sh`, the
gate's settle loop for the post-stop count, the operator-runbook paragraph and their pins. That moves `deploy/`,
so §4.1 clause 1 requires a re-freeze and a re-run of every affected gate, and the matrix below was run **twice,
once from each**, rather than argued about.

| | From candidate 9? | From candidate 10? |
|---|---|---|
| the whole §9 regression matrix, **nine of nine** | **YES** | **YES** — the table below |
| Phase 6 `go:recovery-gate:three`, three cold starts, **13 of 13 arms in every run**, 0 fail | **YES** — 799 s | **YES** — 796 s |
| the alpha install matrix, **11 of 11 arms**, shipped operator command | **YES** | **YES** |
| the mount-propagation probe on the **Unraid** kernel (§8.7.1) | not run | **YES** — passed, control and repair both |
| TypeScript, `gofmt`, `go vet`, every Go package, and the full offline inventory on the development host | **YES** | **YES** — 314 selected, 314 passed, 0 failed, 0 required-but-skipped, 656 s |
| the same, **on Unraid** | not run | **YES** — §11.15.1, and the same **9 of 314** refuse to certify that host, proved pre-existing at candidate 8 |
| **one full `npm run go:phase7-gate` — a six-arm sequence** | **NO** | **NO** |
| **`npm run go:phase7-gate:three` — the sequence this tranche closes on** | **NO** | **NO. STILL NOT ONCE.** |

**THE §9 MATRIX, FROM CANDIDATE 10, SERIALISED, WITH `PROJECTIOND_IMAGE=projectiond:phase7c10-frozen`:**

| Gate | Runs | Result | Candidate 9 |
|---|---|---|---|
| `go:recovery-gate:three` | 3 | **exit 0**, 796 s — **RC1 to RC13 in every run, 39 passes, 0 failures**, including `RC8` (exactly 3 attempts, closest pair 20,000 ms against a 20,000 ms cooldown, corroborated against Docker's own timestamps to within one tick), `RC9`, `RC11`, `RC5` and `RC12` | exit 0, 799 s, the same 39 |
| `go:stale-mount-gate:three` | 3 | **exit 0**, 273 s | exit 0, 272 s |
| `go:serve-death-gate:three` | 3 | **exit 0**, 52 s | exit 0, 54 s |
| `go:mount-truth-gate:three` | 3 | **exit 0**, 63 s | exit 0, 63 s |
| `go:mount-health-gate:three` | 3 | **exit 0**, 273 s | exit 0, 273 s |
| `go:sustained-outage-gate:three` | 3 | **exit 0**, 269 s | exit 0, 270 s |
| `go:publisher-mount-gate` | 1 | **exit 0**, 100 s | exit 0, 101 s |
| `go:rclone-comparison-gate` | 1 | **exit 0**, 128 s | exit 0, 121 s |
| `deploy/projection-alpha-acceptance.sh` | 1 | **exit 0 — 11 of 11 arms**, driving the shipped operator command | exit 0 — 11 of 11 |

**THE MOST LOAD-BEARING ROW IS `go:recovery-gate:three` AND THE REASON IS §11.4 #5.** The last time this
tranche changed the daemon's mount lifecycle, the change passed every offline test — including three written
specifically for it — and was byte-identical in both directions on the host, and it took **this gate on this
host** to show that it destroyed the thing it was protecting. §8.7 changes the mount lifecycle again, at the
shutdown end this time, and this is the instrument that has earned the right to be believed about it: thirteen
arms, three cold starts, twice, from two frozen trees, with `RC5`'s foreign refusal and `RC12`'s pre-attached
consumer among them.

**AND THE PROPAGATION PROBE RAN ON THE UNRAID KERNEL ITSELF**, which is the one that matters for §8.7.1:
`floor=1`, `afterNamespaceDestroyed=2`, `afterSelfDetach=2` — a mount made inside a child mount namespace over
an `rshared` mount point **survived** the destruction of that namespace, and a mount its own process removed
with `MNT_DETACH` before exiting **was removed from the host too**. The control reproduced the defect, which is
what makes the second half evidence rather than a tautology.

**WHAT NONE OF THAT IS.** It is not a sequence attempt, it does not touch a single Phase 7 arm, and it says
nothing whatever about whether `P7-arm-layers` reads 1 at R3, R4, R5 and R6. **§8.7.4 predeclares what would,
and no run has produced it.**

### 11.15.1 OFFLINE AT CANDIDATE 10, ON BOTH HOSTS, AND THE NINE ARE THE SAME NINE

| What, at candidate 10 | development host | Unraid `tower` |
|---|---|---|
| `npm run typecheck` | **clean** | **clean** |
| `npm run go:fmt` / `go:vet` | **clean** / **clean** | **clean** / **clean** |
| `npm run go:test` | every package `ok` | **all 11 packages `ok`** |
| `npx tsx test/projection-phase7.ts` | **47 passed, 0 failed** — 43 before §8.7, with four added for it | — |
| `npx tsx test/projection-bounded-recovery.ts` | 52/0 | — |
| `npx tsx test/projection-evidence-consistency.ts` | 8/0 | — |
| `npx tsx test/custody-runtime-closure.ts` | 39/0 — every shipped `.sh` parses under LF and CRLF, the new probe included | — |
| **full `npm run test:offline`** | **314 selected, 314 passed, 0 failed, 0 required-but-skipped, 656 s** | **314 selected, 305 passed, 9 failed, 0 required-but-skipped, 905 s** |

**THE NINE ARE THE SAME NINE §11.5.1 NAMED AND THEY WERE PROVED PRE-EXISTING AGAIN RATHER THAN ASSUMED TO BE.**
`custodian-contract`, `custodian-storage-ipc-gates`, `custody-transition`, `kek-correction-gates`,
`projection-gate-embedded-programs`, `projection-mount-hardening`, `projection-multi-frontend`,
`sidecar-durable-state-evidence` and `sidecar-runtime-prototype` — **no more and no fewer** — and every one of
them was re-run **from candidate 8's staged tree on the same host** and **failed there too**, one at a time,
with the same exit status. So they are a property of this host and this suite and not of anything §8.7 changed.
§11.5.1 has the two causes: `shfs` will not honour restrictive modes or present links as six of them require,
and three of them copy a **shipped** `.sh` — mode 644 in git, always invoked as `bash script.sh` — to a temp
directory and exec it directly, which is status 126 on Linux and cannot fail on Windows.

**AND NOTHING §8.7 ADDED IS AMONG THEM.** `test/projection-phase7.ts` at **47/0**,
`test/projection-bounded-recovery.ts` at 52/0, `test/projection-evidence-consistency.ts` at 8/0 and
`test/custody-runtime-closure.ts` at 39/0 — the last of which parses the new propagation probe under both line
endings, and refused an earlier draft of it for a quoted program split across lines, which is §11.4 #3's own
defect caught before it could cost a run.

### 11.15.2 THE PROVIDER BLOCKED IT AGAIN, BEFORE A SINGLE SEQUENCE ATTEMPT

**THE RECHECK WAS RUN IMMEDIATELY BEFORE THE FIRST INTENDED SEQUENCE, AS §7 REQUIRES, AND IT SAID NO.**

| Observation | `allowedOriginCount` | resolved origin digest | verdict |
|---|---|---|---|
| immediately before the first intended attempt from candidate 9 | 6 | `f446a32964bf`, scheme `https`, `resolverStatus=200` | **`disallowed`**, exit 70 |
| again, after the candidate-9 matrix and the candidate-10 freeze | 6 | `f446a32964bf` | **`disallowed`**, exit 70 |
| again, after the candidate-10 matrix | 6 | **`d24a544ecef3`** | **`disallowed`**, exit 70 |

**NEITHER IS ONE THE OPERATOR HAS AUTHORISED, AND THERE ARE NOW TWO OF THEM.** The six in the allowlist are the
five §11.13 records plus the one it added; `f446a32964bf` is none of them and `d24a544ecef3` is none of them
either. **THE POOL IS CYCLING THROUGH AT LEAST TWO MEMBERS OUTSIDE THE ALLOWLIST**, which is a stronger version
of the arithmetic §7 predeclared and Phase 3 §11.7 measured: a rotation back into the allowlist is not something
this tranche can wait for on any schedule it controls. **NOTHING WAS WRITTEN TO
`endpoint.json` AND NOTHING WILL BE** without an explicit operator instruction naming that exact change — §7,
unchanged, and §11.13 is the only time in this tranche's history that instruction has been given. The blocker
was escalated with **a digest, a count and a verdict and nothing else**.

**SO NO SEQUENCE ATTEMPT WAS LAUNCHED, AND THAT IS §7's PREDECLARED RULE RATHER THAN A CHOICE.** A run into a
disallowed origin fails at the egress allowlist on its first read, is recorded as **BLOCKED rather than
failed**, and counts toward nothing in either direction. Every provider-free obligation in §4.1 was completed
while the blocker stood, which is the whole of §11.15, and a recheck-and-launch harness was left waiting so
that the first rotation back into the allowlist is spent on the sequence rather than on noticing.

## 12. The readiness decision

# **NO-GO.**

**§4.1 CLAUSE 1 IS UNSATISFIED AND NOTHING ELSE MATTERS UNTIL IT IS.** `npm run go:phase7-gate:three` has
**never completed one run**, let alone three consecutive fresh ones, from any candidate. §4.2 forbids a GO on
fewer than three complete passing sequences and this document does not manufacture one.

**AND THE REASON HAS CHANGED AGAIN, WHICH IS THE ONLY THING WORTH READING THIS SECTION FOR.** #16 — the
blocker this document ended on last time — turned out not to be a supervisor, a fault or an arm: it is what
happens when the daemon is REPLACED, and §8.7 is the contract for the repair, written and committed before any
run measured it. **AND NOT ONE RUN HAS MEASURED IT, BECAUSE THE PROVIDER ROTATED OUT OF THE OPERATOR'S
ALLOWLIST AGAIN BEFORE THE FIRST ATTEMPT COULD BE LAUNCHED.** Everything that could be proved without the
provider was proved twice, from two frozen candidates; the one thing §4.1 closes on could not be attempted at
all.

**WHAT IS BLOCKING IT, IN ORDER, AND EACH ONE IS A DIFFERENT KIND OF THING:**

1. **THE MOUNT-LAYER RESIDUAL HAS A FIX AND THE FIX IS UNMEASURED, WHICH IS NOT THE SAME AS FIXED.** §11.4 #16
   and §8.7. The mechanism is now known from committed source rather than hypothesised — R3 is the only arm
   that replaces the daemon, the gate replaced it with a `SIGKILL`, and at an `rshared` mount point that leaves
   a corpse the replacement stacks over — and both halves of it are measured by a program on this very kernel
   (§8.7.1, §11.15). The daemon now removes its own mount, proven by the mountinfo row it recorded creating.
   **NONE OF THAT IS A MEASUREMENT OF `P7-arm-layers` AT R3.** §8.7.4 predeclares what would be, §4.2 still
   names a layer count outside `MOUNT_LAYERS_ABOVE_FLOOR_MAX` as a NO-GO, and **the threshold has not moved
   and is not going to.**
2. **NO SEQUENCE HAS PASSED, AND NO SEQUENCE HAS BEEN ATTEMPTED SINCE THE FIX.** Attempt 5 reached all six arms
   and failed on four defects; attempt 6 fixed the product one and was BLOCKED at arm R3 by the provider;
   attempt 7 reached all six arms and failed on #16; and **candidates 9 and 10 have not attempted one at all**
   — §11.15.2 is why. §11.9 is the arm ledger and §11.15 is what the current candidates have and have not run.
3. **THE PROVIDER IS SERVING AN ORIGIN OUTSIDE THE OPERATOR'S ALLOWLIST RIGHT NOW, AGAIN, AND IT IS A SEVENTH
   DIGEST.** `f446a32964bf` against an `allowedOriginCount` of 6, `resolverStatus=200`, verdict `disallowed`,
   twice, forty minutes apart — §11.15.2. **THIS IS NOT A PRODUCT DEFECT AND THE ALLOWLIST IS DOING THE ONE
   JOB IT EXISTS FOR.** §7 predeclares a run into it as **BLOCKED rather than failed**, nothing automated here
   writes `endpoint.json`, and the blocker was escalated with a digest, a count and a verdict and nothing else.
   §11.13's operator action cleared a different digest at a different time and does not reach forward to this
   one; that §11.13 exists is exactly why this paragraph names an escalation rather than a write.
   ~~**THE PROVIDER BLOCKER OF §11.12 IS WHAT THIS ROW USED TO BE.**~~ It was cleared by the operator action
   §11.13 records — `4fea5e1bdeaa`, count 5 to 6, nothing else relaxed — and the pool has since moved on. The
   old row is struck through rather than deleted because a reader has to be able to see that this blocker has
   now been met twice, cleared once, and is not the same origin either time.
4. **R6 HAS NEVER PASSED, AND ITS REPAIRED INJECTOR HAS NOW RUN WITHOUT REACHING ITS SUBJECT.** §11.4 #14.
   The repair's own first assertion — the open descriptor that keeps the connection alive — **passed**; the
   arm then stopped on the injector's **premise**, because #16 had left two of our layers stacked and
   detaching the top one did not leave the mount point empty. **The repair is still unmeasured, and it is
   unmeasured for a reason that is not the repair.**
5. **`npm run go:phase7-gate:three` HAS STILL NEVER RUN, FROM ANY CANDIDATE, AND NEITHER HAS A SINGLE
   `go:phase7-gate` FROM THE CANDIDATE THAT CARRIES THE FIX.** §11.14 says why it was not launched from
   candidate 8 — the single gate that precedes it failed deterministically at R3, and three copies of one
   failure is not a sequence — and §11.15.2 says why it has not been launched from candidate 9 or 10, which is
   a different reason entirely and is not this tranche's to fix. **The sequence is owed from the candidate that
   fixes #16, and candidate 10 is that candidate the moment the provider serves an origin the operator has
   allowlisted.**

**WHAT IS NO LONGER BLOCKING IT, AND THIS IS THE EXPENSIVE HALF THAT WAS BOUGHT:**

- **ARM R1 RECOVERS.** The mount removed from beneath a living daemon — the most likely operator-side accident
  on this appliance, and the fault Phase 6 §3.2 had a row for and could not reach — is repaired, twice, from two
  candidates: one bounded `recover-mount-underlay` at **14,603 ms** and **13,109 ms** against a 33,000 ms budget,
  a sibling reading a byte again at **17,153 ms** and **15,615 ms** against 59,000, **4 of 4** operator windows,
  **all three** media servers reading them inside their own containers as their own uid, **one** layer above the
  floor, and the underlay fingerprint identical before the fault and after the recovery. §8.4 is the contract
  for it, written before the run, and §8.4.4 is why reinstating the predeclared clause word for word is not a
  threshold moving.
  **AND ATTEMPT 7 REPRODUCED IT A THIRD TIME** from a third candidate: 14,490 ms and 16,913 ms, one layer,
  the fingerprint `fccf4ba8c5c2` identical across the fault.
- **ARM R2 RECOVERS**, three times now, the same way, from a second daemon’s corpse: 11,510 ms, 13,096 ms and
  12,974 ms.
- **R3, R4 AND R5 EACH PASSED EVERY ASSERTION OF THEIR OWN ARM, TWICE** — in attempt 5 and again in attempt 7,
  including R5, the refusal, with `underlay-covered` beside it and the tmpfs asserted still mounted and
  byte-unmodified. **What R3, R4 and R5 do not pass is `P7-arm-layers`, which is blocker 1 and belongs to the
  run rather than to the arm.**
- **`P7-arm-binds-unchanged` PASSED, ON EVERY ARM THAT REACHED IT, FOR THE FIRST TIME IN THIS TRANCHE.** It had
  never once been in a position to say anything (#12, then #15). It is the assertion that pays for *"no
  consumer was restarted or re-bound to make a recovery visible"*, and it is now a measurement.
- **THE §9 MATRIX IS NINE OF NINE FROM CANDIDATE 7 AND NINE OF NINE AGAIN FROM CANDIDATE 8**, where §11.7
  managed eight, and `RC8`/`RC9`/`RC11` assert their arm again **with every assertion unchanged** — Phase 6
  §11.9 is the record of the injector repair. **Candidate 8 is the first candidate from which the matrix and a
  six-arm sequence attempt were both taken**, so §11.10 no longer has to caveat that the matrix describes a
  different daemon than the record ends with.
- ~~**THE PROVIDER BLOCKER IS CLEARED.**~~ **IT WAS, ONCE, AND IT IS BACK.** One operator action cleared
  `4fea5e1bdeaa` — §11.13 — and the pool has since moved to `f446a32964bf`, which nobody has authorised. The
  sentence is struck rather than deleted because "cleared" was true of one origin at one time and was never a
  claim about the pool. Blocker 3 above is where it now lives.
- **#16's MECHANISM IS KNOWN, AND IT IS KNOWN FROM COMMITTED SOURCE AND A PROGRAM RATHER THAN FROM A
  HYPOTHESIS.** §11.3.5 could name only one hypothesis and one diagnostic; §8.7.1 names the operation, and
  `npm run go:mount-propagation-probe` measures both halves of it **on the Unraid kernel itself**, with a
  control that has to reproduce the defect or the probe fails. That is the first time in this tranche a
  mount-topology claim has been checkable without a three-hour provider-facing run.
- **THE FIX IS THE SMALLEST ONE THAT CAN BE PROVED SAFE, AND WHAT AUTHORISES IT IS AN IDENTITY.** The process
  that made the mount removes it, and only if the row on top is byte-for-byte the one it recorded creating —
  not a file-system type, not a count, not a transport answer, each of which this repository has already
  watched describe two different mounts at once. Seven tampers pin it (§11.11.3) and the second of them caught
  the widened, shape-based form passing eight of nine table rows.
- **THE §9 MATRIX IS NINE OF NINE FROM BOTH CANDIDATES THAT CARRY THAT DAEMON**, with Phase 6's own
  `go:recovery-gate:three` green at thirteen arms in each of three cold starts, twice — the gate that caught
  §11.4 #5, which is the one previous change to this same lifecycle that every offline test passed and a real
  host refused.
- **THE SAFETY CONTRACT HELD EVERYWHERE IT WAS MEASURED.** No file-system type became trusted; the verdict is
  read on one row of one table; nothing was ever unmounted on the new path; a re-mounted bind of the same share
  is refused; an unreadable mount table refuses; an unwired verifier refuses; and the act is re-verified live
  before a budget is spent.
- **THE MOUNT-LAYER THRESHOLD DID NOT MOVE.** It measured `1/1` after every arm attempt 6 reached, and `1/1`
  after R1 and R2 in attempt 7. **It is in the blocking list above and not this one**, because attempt 7 is the
  first run since §8.5 to reach R3 and it measured **2/1** there. A sentence in an earlier revision of this
  list said the threshold *"stopped biting"*; it did not stop biting, it stopped being asked.
- **AND THE STAGES THAT MAKE THIS TRANCHE WHAT IT IS PASSED IN ALL THREE ATTEMPTS THAT REACHED THEM**: three
  real digest-pinned media servers attached before the first mount, catalogued a real TorBox object through
  their own predicates, read four approved windows inside their own containers, were observed scanning on one
  clock, seeked ten verified media-time positions each — **10/10, 10/10, 10/10** in attempt 7 —
  **direct-played five minutes each simultaneously** (306 / 300 / 300 decoded media seconds, with an instant
  measured at which all three were decoding) and **transcoded five minutes each** (324 / 324 / 300).

**SO THE HONEST SUMMARY IS THIS, AND THE SHAPE OF IT IS DIFFERENT FROM LAST TIME.** The blocker this document
ended on has stopped being a mystery: its mechanism is named in committed source, measured by a program on
this host's own kernel with a control that has to fail, repaired at the one end where ownership is an identity
rather than a judgement, contracted at §8.7 before any run, pinned by a table whose sequential case a
cold-start table could not have caught, tamper-proved seven times, and carried through Phase 6's own recovery
gate — thirteen arms, three cold starts — twice, from two independently frozen and byte-proved candidates,
alongside the whole nine-gate matrix and both offline inventories.

**AND THE TRANCHE IS A NO-GO BECAUSE NONE OF THAT IS THE MEASUREMENT §4.1 ASKS FOR.** `P7-arm-layers` at R3
has not been read since the fix, R6 has still never reached its subject, `npm run go:phase7-gate:three` has
still never completed a single run from any candidate — and this time the reason is one nobody here controls:
the provider is serving a CDN origin the operator has not allowlisted, so §7 records a run into it as BLOCKED
rather than failed and no attempt was launched. **A fix that has not been measured is a proposal, and this
record does not promote one.**

**WHAT THIS IS NOT, RESTATED BECAUSE IT IS EASY TO READ THE PARAGRAPH ABOVE AS MORE THAN IT SAYS.** This is a
rough-edged **one-host TorBox alpha**. It is not a beta, not a release, not a marketplace package, not a second
host and not a second provider: **there is no Real-Debrid support and no Usenet support** — Phase 6 §13 has
contracts for them and a contract is not a feature. §10 is the full list of what is not claimed, it is longer
than this section, and every line of it still stands.
