# Projection Phase 7 — the operator-usable alpha

**Status: OPEN — this document is the contract, and it was committed before the first measured run.**
Every arm, threshold, repetition rule, cleanup requirement and exclusion in §2 to §10 is predeclared. §11 is
the run record and is empty until a run has been taken. **No threshold in §4 may move after the first
measured run**; a clause that measures FALSE is recorded as **superseded**, with what it said kept whole,
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
- **this tranche does not write `endpoint.json`.** Refreshing the allowlist is the operator's decision and
  Phase 3 §11.2's reasoning is unchanged. If the current origin is disallowed the gate emits a **digest and a
  count only** and asks.

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

**EMPTY. Nothing has been run.** Every figure below this line will name the frozen commit, tree and image it
came from, and the two source digests that make a stale record impossible.

## 12. The readiness decision

**NOT TAKEN.** It is taken in §12 after §11 carries a complete record, and §4.2 is what forbids it in advance.
