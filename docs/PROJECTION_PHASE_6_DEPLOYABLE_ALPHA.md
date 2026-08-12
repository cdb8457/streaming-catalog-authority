# Projection Phase 6 — the deployable alpha

**Status: PREDECLARED.** Every threshold, arm and acceptance rule below was committed **before** the first
measured Tower run of this tranche. §11 is the run record and is the only section that may be written after a
measurement. §12 is the operator-facing readiness decision and holds **NO-GO** until §11 says otherwise.

**What this tranche is, in one sentence.** An Unraid operator can install, start, check, recover and roll back
a TorBox-first projection appliance from a documented set of commands, and the daemon will — bounded, budgeted
and refusing anything that is not its own — repair the mount faults Phase 5 taught it to report.

**What it is not.** It is not a beta, not a release, not a marketplace package, and not a claim of
Real-Debrid or Usenet support. It adds no provider. It does not make `rclone` the architecture. §10 is the
full list of what it refuses to claim, and it is deliberately longer than §12.

---

## 1. What the four closed tranches actually left, and why this is the honest next step

Phases 1–5 closed a vertical slice, hardened its mount lifecycle, ran it against three real media servers over
a real provider, made the daemon observe its own mount, and made readiness answer from that observation
through a bounded policy. What none of them produced is **a thing an operator can install**.

The gap is precise, and naming it precisely is what keeps this tranche from becoming the thirty-phase
scaffolding the roadmap's anti-detour rule exists to prevent:

| What exists | What is missing |
|---|---|
| `docker-compose.projectiond.operator.yml`, which says in its own first line that it **is not a release stack** | one canonical profile with pinned identity, healthcheck, dependency ordering and a documented environment contract |
| Twenty-odd gate scripts that each build their own world | install / preflight / start / status / stop / upgrade / rollback, idempotent, that an operator runs |
| `/readyz` answering `readyReason` since Phase 5 | a status surface an operator reads without knowing what a `readyReason` is |
| A daemon that **reports** a broken mount | a daemon that **repairs** the ones it is entitled to repair, and refuses the rest **loudly** |

**AND THE FOURTH ROW IS THE ONE PHASE 5 EXPLICITLY DEFERRED.** Its §5.1: *"Wiring health to an action is
deliberately not in this tranche, and it is named here so it is a decision somebody takes rather than a thing
that drifts in."* This is that decision, taken, and §3 is the whole of it.

## 2. The subphases, predeclared

| | Subphase | What closes it |
|---|---|---|
| **6A** | **Consolidate the record.** Phase 5 CLOSED in the roadmap with its exact frozen identity; this document | the roadmap row states the frozen commit, tree, image and counts, and claims nothing beyond them |
| **6B** | **Unraid alpha packaging.** One canonical profile, one operator command, one environment contract | `deploy/projection-alpha.sh` and `docker-compose.projection-alpha.yml`, pinned by `test/projection-alpha-packaging.ts` |
| **6C** | **Bounded automatic recovery.** `--auto-recover`, reason-aware, budgeted, durable | `deploy/projection-recovery-gate.sh`, thirteen arms, three consecutive fresh Tower runs |
| **6D** | **FUSE and rclone confidence.** The affected closed gates re-run against the changed image | §7's matrix, zero failures, zero skips |
| **6E** | **Tower alpha acceptance.** Provider-free matrix first, then the already-approved real-provider scope | §8 |
| **6F** | **Quality loop.** TypeScript, Go, the offline inventory, custody, evidence consistency | §11.3 |

## 3. Bounded automatic recovery, and the entire design is about refusing

**AN APPLIANCE THAT REMOUNTS ITSELF IS ONE FAILURE AWAY FROM AN APPLIANCE THAT REMOUNTS ITSELF FOREVER**, and
a remount loop with no floor is strictly **worse** than a mount that stays broken and says so: the broken
mount is visible, and the loop looks like activity. That sentence is the whole reason this is a tranche rather
than an `if`.

So four bounds stand between a fault and an action, and each has a failure it exists to prevent:

| Bound | Prevents |
|---|---|
| **Only a fault readiness already believed** | acting on a sampling artefact, which is what Phase 5's fault hold exists to filter out |
| **Only a fault that then sustains a second whole hold** | acting on a fault the daemon's *own* serve-death remount or recovery confirmation was about to clear |
| **Only a mount that is ours** | the `--auto-remount` defect: unmounting the operator's bind and recovering for the daemon and for nobody else |
| **Only a bounded number of attempts, recorded before they are spent** | the infinite remount loop, including across a crash and a container restart |

### 3.1 The first bound is free, and that is the nicest thing about this design

The loop reads **`readyReason` and the observation and nothing else**. Every code it treats as actionable is a
code readiness is being *withheld* for — and inside the fault hold, and inside the bootstrap grace, Phase 5's
policy publishes `ok`, which is inert here. So *"never act on a fault readiness did not already believe"* is
not a check this code performs. It is a **property of reading that field**, and it cannot be lost by an edit
to this tranche without an edit to Phase 5's precedence.

### 3.2 The classification, which is exhaustive on the readiness reason

`classifyRecovery` is a table rather than a chain of conditions, so a reason code added later shows up as an
unrecognised state — which **refuses** — rather than falling through into whatever the last branch was.

| `readyReason` | observation | class | act? |
|---|---|---|---|
| `ok` | any | `no-action-healthy` | no |
| `mount-recovering` | any | `no-action-confirming` | no — acting would abort a recovery to start one |
| `no-generation-admitted` | any | `no-action-nothing-to-serve` | no — no remount produces a generation |
| `not-mounted` | any | `no-action-not-mounted` | no — the first mount is not this loop's to make |
| `serve-loop-dead` | any | `no-action-serve-supervisor-owns` | **no** |
| `mount-observed-not-live` | `stale-projectiond` | `recover-stale-mount` | **yes** |
| `mount-observed-not-live` | `empty` | `recover-mount-empty` | **yes** |
| `mount-observed-not-live` | `foreign` | `refuse-foreign-mount` | **REFUSED** |
| `mount-observed-not-live` | anything else | `refuse-unknown-state` | **REFUSED** |
| `mount-observation-stale` | — | `recover-observation-stale` | **yes** |
| `mount-observation-unavailable` | — | `recover-observation-unavailable` | **yes** |
| anything else | — | `refuse-unknown-state` | **REFUSED** |

**`serve-loop-dead` IS DECLINED, AND IT IS THE ROW MOST LIKELY TO LOOK LIKE AN OVERSIGHT.** A death is
**direct evidence**, already owned by the supervisor that watched the serve loop exit — the path that has
handled it since Phase 2 and that Phase 3's nineteen gate defects hardened. The observation is a **late sample
of the same event**. Two supervisors reacting to one fault is two remounts racing on one mount point, which is
the worst blast radius in this product. The recovery loop therefore watches the serve-death path work and does
nothing, and `RC6` asserts exactly that.

**THE FOREIGN REFUSAL IS THE MOST IMPORTANT ROW.** In every containerised topology this daemon ships in, the
likeliest foreign mount at the mount point is **the operator's own bind** — the one mount that must survive
for any recovery to be visible to anybody. `--auto-remount` unmounted it once already, logged success, and
recovered for the daemon and for nobody else. A supervisor that cannot tell those apart does nothing, and says
which.

### 3.3 The thresholds

Every one is in `PROJECTIOND_MOUNT_RECOVERY` in `src/core/projection/runtime-contract.ts` and mirrored in
`projectiond/internal/daemon/recovery.go`. This document restates none of them from memory:
`test/projection-bounded-recovery.ts` fails if the three disagree.

| Name | Value | Where it comes from |
|---|---|---|
| `RECOVERY_TICK_MS` | **1,000** | **DERIVED:** `SAMPLE_INTERVAL_MS`. The decision is a pure function of the readiness verdict, and that verdict cannot change faster than the sampler feeding it. Evaluating more often is polling a constant |
| `RECOVERY_SUSTAIN_MS` | **6,000** | **DERIVED:** `MOUNT_FAULT_HOLD_MS`. The second hold, deliberately the same length as the first. Phase 5's hold proves the fault is not a sampling artefact; this one proves it is not one the daemon's own paths were about to clear. **Time-to-act is therefore the sum — twelve seconds of a fault nobody else fixed — and it is supposed to be.** An appliance that remounts faster than that is one that remounts on transients |
| `RECOVERY_ATTEMPT_DEADLINE_MS` | **20,000** | **CHOSEN, both bounds named.** *Above:* the shipped remount spends up to six seconds of linear backoff across its three attempts plus the mount calls, so a deadline that could fire during a remount that was going to succeed would turn a recovery into a lockout. *Below:* an attempt that has not returned may be parked in an uninterruptible `statfs`, and this is how long the supervisor waits before it counts the attempt and **stops for good** |
| `RECOVERY_COOLDOWN_MS` | **20,000** | **DERIVED:** `RECOVERY_ATTEMPT_DEADLINE_MS`. An attempt may be *abandoned* rather than finished, so the only cooldown that keeps two attempts from overlapping in wall-clock is one that outlasts the whole deadline of the previous one. Anything shorter is a cooldown that is correct only when nothing went wrong |
| `RECOVERY_MAX_ATTEMPTS` | **3** | **CHOSEN.** The same budget the serve-death remount has spent since Phase 2, and the symmetry is deliberate: an operator who knows one bound knows both. A fourth attempt at an action that has failed three times across a minute is a loop, not a recovery |
| `RECOVERY_CONFIRM_MS` | **4,000** | **DERIVED:** `MOUNT_RECOVERY_CONFIRM_MS + SAMPLE_MAX_AGE_MS`. `ok` already required a confirmed live run, but it can be granted by a sample taken up to a whole worst-case window ago. One such window on top is the smallest addition that guarantees the `ok` refunding the budget was re-derived from an observation taken **after** the attempt |

**The derived relations, which are checks rather than comments**, in the shape Phase 5's already use:

| Name | Says |
|---|---|
| `RECOVERY_NEVER_ACTS_ON_A_FAULT_READINESS_DID_NOT_BELIEVE` | the sustain is at least a whole fault hold, the tick is no slower than the sampler, and the sustain strictly outlasts the anti-flap transient |
| `RECOVERY_ATTEMPTS_CANNOT_OVERLAP` | the cooldown is at least the whole attempt deadline |
| `RECOVERY_CANNOT_LOOP_FOREVER` | the budget is finite, durable and cleared only by a human, and no restart policy changed |
| `RECOVERY_REFUND_REQUIRES_A_FRESH_OBSERVATION` | the confirmation window strictly outlasts one whole worst-case sampling window |

### 3.4 Single-flight is a property of the shape, not a discipline

**EVERY MUTATION OF THE MOUNT STAYS IN ONE GOROUTINE.** The recovery loop decides and **requests** over a
channel; the goroutine that already owns the mount — `main`'s supervisor select, the one that has handled
serve-loop deaths since Phase 2 — is the only thing that ever calls `remountLoop`.

That is not tidiness. A second goroutine calling `remountLoop` would race the serve-death path on one mount
point, **and** it would leave the supervisor's `select` waiting on the `Done()` channel of a mount that had
already been replaced. The channel handoff makes both impossible without a lock, and makes *"exactly one
recovery at a time"* a fact about the program's shape.

The handoff is **bounded**: if the owner is busy — servicing a serve-loop death, most likely — the request is
abandoned after one tick with **nothing spent**, because the fault will still be there next tick if nobody
fixed it and will not be if somebody did.

### 3.5 The budget is spent before the attempt, and that order is the whole guarantee

An attempt whose spend is recorded **afterwards** is an attempt a crash refunds, and a budget a crash refunds
is not a bound. So:

1. The owner calls `RecoveryBeginAttempt`, which **re-checks the class** — between the decision and this call
   the serve-death supervisor may have fixed the very fault it was for — and then writes the ledger.
2. **A ledger that cannot be written refuses the attempt and locks out.** The alternative is acting with no
   record, which is the unbounded case wearing the clothes of the bounded one.
3. Only then does the remount run.

**THE LEDGER IS ON DISK AND THAT IS THE POINT.** `restart: unless-stopped` restarts a daemon that exits, so an
in-memory budget of three would authorise three attempts *per restart* and therefore an unbounded number of
them. The ledger lives in the daemon's **durable** cache directory, is written atomically — a torn ledger is
an unreadable one and an unreadable one locks out — and a lockout in it survives a crash, a restart, an
upgrade and a host reboot.

**AN ABSENT LEDGER IS A FIRST RUN; AN UNREADABLE ONE IS A LOCKOUT.** That difference is the whole of failing
closed here.

### 3.6 What clears a lockout: a human, and nothing else

`projectiond --reset-recovery` clears the ledger and exits. It constructs no daemon, opens no cache and cannot
mount.

**EVERY AUTOMATIC CLEARING RULE THAT WAS CONSIDERED WAS REJECTED FOR THE SAME REASON.** A timer, an uptime
threshold, a quiet period — each is a rule under which a flapping appliance eventually resumes flapping
without anybody having looked at it. The cost of the choice is real and is **named as a rough edge in §9**: an
operator who fixes the underlying fault and restarts still has a daemon that will not act until they reset it.
The status surface is what makes that cost payable, and §3.7 is why.

### 3.7 The operator status surface

`/readyz` gains six fields. **Strictly additive**: `ready`, `mounted`, `readyReason` and every Phase 4 and
Phase 5 field keep the exact meanings the closed gates were measured against.

| Field | Closed set |
|---|---|
| `recoveryState` | `disabled`, `idle`, `observing`, `acting`, `cooling-down`, `locked-out` |
| `recoveryReason` | the 23 decision codes in `PROJECTIOND_MOUNT_RECOVERY.DECISION_CODES` |
| `recoveryAttempts` | a count — the budget spent since the last refund or reset |
| `recoveryGeneration` | a count — every attempt ever, **never refunded**, so *"recovered once, an hour ago"* and *"recovering right now"* are distinguishable |
| `recoveryLastOutcome` | `none`, `succeeded`, `failed`, `refused` |
| `recoveryRemediation` | `none`, `inspect-mount-owner`, `reset-recovery-ledger`, `check-cache-directory` |

**WHY THIS IS ON THE READINESS DOCUMENT AND NOT A THIRD ENDPOINT.** An operator looking at a 503 needs three
answers in one place: what is wrong (`readyReason`), what is actually at the mount (`mountObserved`), and
whether anything is being done about it (`recoveryState`). Splitting the third onto its own surface makes the
answer to *"is this fixing itself?"* a second request whose reply describes a different instant.

**EVERY FIELD IS A CLOSED-SET CODE OR A NUMBER.** No path, no URL, no origin, no provider reference, no object
identity, no OS string, no mount point. `serveError` remains the one free-text field on this document, exactly
as Phase 5 §3.2 recorded, and Phase 6 does not touch it.

### 3.8 What recovery does NOT change

- **No restart policy.** Recovery happens *inside* the living process, so a container that was never going to
  be restarted still is not. `PROJECTIOND_MOUNT_RECOVERY.CHANGES_RESTART_POLICY` is `false` and pinned.
- **No remote surface.** There is no socket, no route and no flag that can trigger a recovery from outside the
  process. Loopback-only was the weaker property that was available; this is the stronger one that was cheaper.
- **No new action.** The remount is the one the serve-death path has used since Phase 2, with the identity
  guards unchanged. Phase 6 contributes a second **reason** to call it and nothing to what it does.
- **Off by default.** `--auto-recover` is off in the daemon. The alpha profile turns it on **explicitly**, and
  §5 says so where an operator will read it.

## 4. The recovery gate

`deploy/projection-recovery-gate.sh`, with `-three` and `-optional` wrappers, run as `npm run go:recovery-gate`.

**Provider-free by construction.** No provider, no endpoint, no credential, no operator corpus, no media
server. The daemon's configuration names no endpoint at all, so there is nothing it could contact. This
tranche must not be blocked by, and must not spend, the operator's metered account.

**ONE subject daemon, ONE mount, ONE unprivileged consumer** bound to the mount point `rslave` **before
anything is ever mounted there**, per §11 of the Phase 0 product contract. The consumer reads **bytes** and
digests them: a dead FUSE mount answers `stat` from a warm attribute cache while every `open` returns
`ENOTCONN`, so a `test -f` here would pass over the exact state this gate exists to detect.

| Id | What it holds |
|---|---|
| `RC1` | **The control.** A healthy mount: `recoveryState=idle`, `recoveryReason=no-action-healthy`, `recoveryAttempts=0`, `recoveryGeneration=0`, and the pre-attached consumer digest-matches bytes recorded outside the mount. Without this arm every arm below is satisfied by a supervisor that never acts |
| `RC2` | **Bootstrap is not a fault.** Through the whole bootstrap grace, zero attempts and zero generations, and `recoveryState` is never `acting` |
| `RC3` | **A transient does not act.** A fault held for `ANTI_FLAP_TRANSIENT_MS`: a non-live observation is **actually reported** — asserted, or the arm proves nothing — readiness never leaves `ok`, and `recoveryGeneration` is **still 0** |
| `RC4` | **A sustained observation failure is recovered.** Our own stale mount stacked above: `recoveryGeneration` goes 0 → **1**, exactly one attempt is spent, and `recoveryReason` was `recover-stale-mount` |
| `RC5` | **A foreign overlay is REFUSED.** A tmpfs stacked above: `recoveryReason=refuse-foreign-mount`, `recoveryRemediation=inspect-mount-owner`, `recoveryAttempts` and `recoveryGeneration` **both still 0**, and the tmpfs is **asserted still mounted** — the overlay must be untouched, which is the assertion this whole arm exists for |
| `RC6` | **A serve death is recovered by the serve supervisor, and only by it.** Across an aborted connection the daemon recovers, and `recoveryGeneration` is **unchanged** — the recovery loop watched and declined |
| `RC7` | **Recovery is confirmed and the budget is refunded.** After `RC4`, `/readyz` returns to `200`/`ok`, `recoveryLastOutcome=succeeded`, and `recoveryAttempts` returns to **0** while `recoveryGeneration` stays **1** |
| `RC8` | **A failed recovery retries and cools down.** With every remount made to fail, attempts go 1 → 2 → 3 with **at least `RECOVERY_COOLDOWN_MS` between consecutive attempt starts**, measured |
| `RC9` | **An exhausted budget locks out.** `recoveryState=locked-out`, `recoveryReason` in `{recovery-budget-exhausted, no-action-locked-out}`, `recoveryRemediation=reset-recovery-ledger`, and across a further observation window of at least `2 × RECOVERY_COOLDOWN_MS` the generation does **not** advance |
| `RC10` | **Concurrent triggers are single-flight.** A fault that satisfies a serve-loop death and an observation fault at once produces **exactly one** recovery action across both supervisors |
| `RC11` | **The lockout survives the supervisor.** The container is restarted while locked out; the daemon comes back with `recoveryState=locked-out` and `recoveryAttempts` preserved, on the **first** reading, and `projectiond --reset-recovery` is what clears it |
| `RC12` | **The same pre-attached unprivileged consumer** reads the identical digest after the `RC4` recovery |
| `RC13` | The host's container, network and volume **sets** are identical before and after, and this run's own mountpoints, overlays, blocker, ledger and directory are **asserted** gone rather than reported |

**`RC8`'s FAULT INJECTOR, PREDECLARED, BECAUSE IT IS THE ONE THING IN THIS GATE THAT IS NOT AN OBVIOUS
FAULT.** Making a remount *fail* deterministically needs the mount syscall itself to fail. The gate binds
`/dev/null` over `/dev/fuse` **inside the subject container's own mount namespace** (`nsenter -t <pid> -m`),
so every `Mount()` is refused; it is removed inside the same arm, and it is confined to a namespace that dies
with the container. If `nsenter` is unavailable on the host, `RC8` and `RC9` **SKIP**, and a skip is a
failure — this gate has no optional arms.

**Closure:** three consecutive fresh runs, exit 0, **zero skips**, on the real Unraid host, from one frozen
commit and one frozen image. A skip is a failure, as it is for every other gate here.

## 5. The alpha packaging

### 5.1 One profile

`docker-compose.projection-alpha.yml` is the canonical deployable profile. It is a **descendant of
`docker-compose.projectiond.operator.yml`, not a replacement for it** — the operator harness stays where it
is, because four closed tranches' worth of documents point at it.

What the alpha profile adds over the operator harness:

- **Pinned image identity.** `PROJECTIOND_ALPHA_IMAGE` is required and has no default: an appliance whose
  image tag floats is an appliance whose evidence describes something else.
- **The shipped healthcheck**, wired to `projectiond --healthcheck` with Phase 5's four predeclared numbers.
- **`--auto-recover`, explicitly**, with the flag visible in the compose file rather than buried in an
  environment variable, because an operator reading the profile must be able to see that the daemon will act.
- **A durable cache bind**, because the recovery ledger lives there and a ledger on a tmpfs is a budget every
  restart refunds.
- **A named project and an explicit network**, so nothing it does can be confused with anything else running.

### 5.2 One command

`deploy/projection-alpha.sh <verb>`, with these verbs and no others:

| Verb | What it does | Idempotent? |
|---|---|---|
| `preflight` | checks every requirement and **changes nothing** | trivially |
| `install` | creates only this appliance's own directories, refusing any that exist and are not empty **unless** they are already this appliance's | yes |
| `start` | brings the profile up and waits for `ready` | yes — an already-ready appliance is a success |
| `status` | prints the operator status surface | yes |
| `stop` | brings the profile down, leaving data | yes |
| `upgrade` | records the current image digest, then starts the new one | yes |
| `rollback` | returns to the digest `upgrade` recorded | yes |
| `reset-recovery` | runs `projectiond --reset-recovery` in the appliance | yes |

**WHAT IT REFUSES, AND EVERY ONE OF THESE IS A REFUSAL RATHER THAN A WARNING:**

- an ambiguous or relative path anywhere in the environment contract;
- a mount point that already carries a mount that is **not** this appliance's;
- a status port already in use;
- a cache, manifest or mount directory that exists, is non-empty, and carries no marker of this appliance;
- an image reference that is a floating tag with no digest recorded;
- **a consumer that is not already attached** — §11 of the Phase 0 contract requires the media server to bind
  the projected path **before** the daemon first mounts there, and `preflight` is where that is checked.

**WHAT IT NEVER DOES:** print a credential value, a provider URL, an origin, a ref, a media path or an
arbitrary provider or OS error; touch an existing media library, a user share, an unrelated container, network
or volume; change a Docker restart policy; or delete anything outside this appliance's own directories.

### 5.3 The environment contract

Every variable is `PROJECTIOND_ALPHA_*`, every one is required, and none has a default that could point at
somebody else's data. The full list, its validation rules and the example file are in
`deploy/projectiond-alpha.env.example` and are pinned by `test/projection-alpha-packaging.ts`.

**THE TOKEN IS A PATH AND NEVER A VALUE**, which is the rule the daemon's configuration has had since Phase 1:
there is no environment variable in this contract that holds a credential, so an environment that leaked could
not leak one.

## 6. What is changed in the product

1. **`projectiond --auto-recover`** — the §3 state machine. Off by default.
2. **`projectiond --reset-recovery`** — clears the durable ledger and exits. Constructs no daemon, opens no
   cache, cannot mount.
3. **`/readyz`** carries §3.7's six additive fields.
4. **Nothing else.** No read path, no mount path, no resolver, no cache, no admission rule and no threshold of
   any earlier tranche is touched.

## 7. The regression matrix

**This changes the daemon's supervisor and the status document, so the gates whose subjects changed are
re-run.**

| Gate | Why it is in scope | Runs |
|---|---|---|
| `go:mount-health-gate:three` | Phase 5. Its whole subject is the readiness document this tranche adds fields to | 3 |
| `go:mount-truth-gate:three` | Phase 4. The observation this tranche now acts on | 3 |
| `go:serve-death-gate:three` | Phase 2. Its subject is the supervisor path Phase 6 adds a second caller to | 3 |
| `go:stale-mount-gate:three` | Phase 2. A cold corpse is the exact state `recover-stale-mount` claims to repair | 3 |
| `go:sustained-outage-gate:three` | Phase 2. The control: a provider outage that never touches the mount must **still** produce no recovery action | 3 |
| `go:publisher-mount-gate` | publishes through a real mount with the changed image | 1 |
| `go:rclone-comparison-gate` | Phase 2's comparison harness, revalidated against the changed image | 1 |

**Phase 3 is NOT in scope, and the audit that says so is the same fact about the same file Phase 5 recorded.**
`deploy/projection-reliability-loop-gate.sh` defines `daemon_status()` and never calls it; its recovery clock
is a sibling reading one byte through the mount. Phase 6 changes no read path and no mount path, and its
supervisor is **off** unless `--auto-recover` is passed, which that gate does not pass.

**Expected affected offline regressions, predeclared before the first run:**

| What | Expected change |
|---|---|
| `projectiond/internal/daemon/daemon.go` | `Status` embeds `RecoverySnapshot`; six new JSON fields, no field removed or renamed |
| `test/projection-operational-mount-health.ts` | unchanged — every Phase 5 field and code keeps its meaning |
| `test/projection-mount-truth.ts` | unchanged |
| Go suites | one new file, `internal/daemon/recovery_test.go`; no existing case altered |

## 8. Tower acceptance

**Exactly this task's own staging roots, ports, container and project names, mounts, networks and volumes.**
Baseline captured before mutation and restored exactly after every sequence. Production mounts, existing media
libraries, user data, unrelated containers, networks, volumes and operator secrets are out of scope and are
not touched.

**8.1 Provider-free first.** `go:recovery-gate:three`, then the §7 matrix, then a cold
install → preflight → start → status → fault → recovery → stop → upgrade → rollback pass of
`deploy/projection-alpha.sh` with a **pre-attached unprivileged consumer reading bytes**, never a metadata
substitute.

**8.2 Then, and only then, the narrow real-provider acceptance**, using **only** the repository's already
established bounded TorBox mechanism and its approved secret-file indirection: `go:torbox-real-gate`, in its
**already-approved existing scope**. No new corpus discovery, no broad provider enumeration, no downloads
outside the approved windows, and no raw endpoint, origin, ref, account or media identity in any output.

**8.3 If the current origin allowlist has rotated** — which it has done once before, and which is the egress
allowlist doing exactly what it exists for — the run emits a **digest and a count only** and **asks**. It does
not weaken an allowlist and does not expose an origin.

**8.4 Closure requires** one frozen source, tree and image; three consecutive fresh runs of the recovery gate
with zero failures and zero skips; the §7 matrix green; independent count reconciliation; and exact host
cleanup asserted rather than reported. **If overnight time is insufficient, this document records an honest
alpha-candidate checkpoint with every remaining blocker precisely named. It does not manufacture closure.**

## 9. Known rough edges, stated before anybody finds them

1. **A lockout outlives its cause.** §3.6. An operator who fixes the fault and restarts still has a daemon that
   will not act until `--reset-recovery`. Deliberate; the status surface is what makes it payable.
2. **A wedged probe can outlive its mount.** The sampler is single-flight, and a probe parked in an
   uninterruptible `statfs` releases only when the connection is torn down. A recovery that remounts *around*
   such a probe can leave the observation permanently unavailable, which spends the budget and locks out. The
   real fix is for recovery to abort the daemon's **own** FUSE connection first, which is a new destructive
   capability and is **the named next-work contract**, not this tranche.
3. **An abandoned attempt holds single-flight for the life of the process.** Deliberate: releasing it would
   let a second remount run against a mount point the first one is still inside.
4. **No alerting, no history, no trend.** The surface is a point-in-time document. Everything an operator
   knows about the past is `recoveryGeneration` and `recoveryLastOutcome`.
5. **One provider.** TorBox, through the adapter Phase 1 closed against. §10 is explicit about what that means.
6. **A recovery usually STACKS OVER the corpse rather than removing it, and the first Tower run is what made
   that concrete.** `ProbeMountpoint` reads the *bottom* entry of a stacked mount point, and in every
   containerised topology this daemon ships in that entry is the operator's own bind — which the supervisor
   correctly declines to touch. So `planRemountCleanup` returns "nothing", the drain does not run, and the
   remount lands on top. It **works**: readiness confirms, and a pre-attached consumer reads the identical
   digest afterwards, which `RC12` measures. What it means is that a mount point which has survived several
   recoveries carries several of this daemon's dead layers, exactly as the startup path has always tolerated.
   Removing them safely needs the probe to answer about the *top* of the stack, which is a change to Phase 3's
   hardest-won code and is **named as next work rather than done here**.

## 10. What this tranche does not claim

- **It adds no provider, and it does not support Real-Debrid or Usenet.** Neither has an adapter, a gate, a
  fixture or a line of code here. §13 is the next-work contract for each, and a contract is not a feature.
- **`rclone` is not the architecture and does not become it.** ADR-002 is untouched. The comparison harness
  remains a **measurement with no pass threshold and no winner**, exactly as Phase 2 closed it, and G22
  remains the comparison control.
- **A recovery is not an availability claim.** The daemon repairs a bounded set of mount faults a bounded
  number of times. It is not highly available, it is not clustered, and a fault outside §3.2's table is a
  fault it reports and does not touch.
- **It closes no G-number** and re-closes nothing in Phases 1–5.
- **It is not a load test and no figure here is a performance claim.**
- **It is an alpha.** Rough edges are in §9 because they are real, not because listing them is a formality.

## 11. Run record

**HELD. Nothing below this line may be written before it is measured.**

### 11.1 Frozen identity

*Pending.*

### 11.2 The recovery gate

*Pending.*

### 11.3 Offline

*Pending.*

### 11.4 The §7 regression matrix

*Pending.*

### 11.5 The alpha install matrix

*Pending.*

### 11.6 The narrow real-provider acceptance

*Pending.*

## 12. The alpha readiness decision

**NO-GO, PENDING §11.** A GO requires demonstrated Tower evidence and this section is not written from an
intention. It is rewritten once, from measurements, and if the measurements do not support GO it says NO-GO
with the shortest path to it.

## 13. The next adapter contracts

Narrow, documented seams, and **each is a contract for work not done rather than a description of work done**.

### 13.1 Real-Debrid

The seam is `source.Resolver` (`projectiond/internal/source/resolver.go`), which Phase 1 closed against
TorBox. A Real-Debrid adapter owes, in this order:

1. a resolver that turns a manifest locator into a time-bounded URL, with **the credential read from a file
   path and never from configuration or an environment value**;
2. an `allowedOrigins` set the operator maintains, with the daemon refusing a resolved URL outside it — the
   property that has already caught a real CDN rotation once;
3. a fake adapter and a boundary suite in the shape of `test/torbox-fake-adapter.ts` and
   `test/torbox-boundary.ts`, before any real account is contacted;
4. a `go:realdebrid-real-gate` in the shape of `go:torbox-real-gate`, bounded to one operator object and one
   approved window;
5. **no change to the read path, the cache or the admission limits.** If an adapter needs one, that is the
   finding, and it belongs in the Phase 0 contract rather than in the adapter.

### 13.2 Usenet

Usenet is **not** a resolver-shaped source and pretending it is would be the mistake. Its contract is
different in kind:

1. an availability model, because an article that has expired is not a 404 the read path can retry;
2. a segment-assembly layer beneath `readpath`, which currently assumes a byte range maps to one HTTP request;
3. an amplification budget of its own — Phase 1's is written against ranged GETs and does not describe an
   NNTP fetch;
4. a decision, taken and recorded before any code, about whether assembly happens in the daemon or in the
   control plane. **This is the seam's real question and this document does not answer it.**

**NEITHER SECTION AUTHORISES ANY WORK.** They exist so that the next tranche starts from a contract instead of
from an argument.
