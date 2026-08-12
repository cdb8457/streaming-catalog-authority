# Projection Phase 6 — the deployable alpha

**Status: CLOSED — the alpha is a GO on one measured combination, from one frozen source.** Every threshold,
arm and acceptance rule in §3 to §10 was committed **before** the first measured Tower run and **none has
moved**.

**A COORDINATOR AUDIT FOUND THE FIRST CLOSURE RECORD'S IDENTITY FALSE AND IT COST A FULL RE-MEASUREMENT.**
§11.1 had named a frozen commit and called the changes after it "gate-only", when four of them modified
`deploy/projection-alpha.sh` — the shipped operator command — and the figures it published had come from
**three different trees**, none of them the one it named. §11.1.1 keeps the false wording and what it cost.
The fix was a re-freeze and a re-run of every provider-free acceptance, not a rewording: `go:recovery-gate:three`
**42 arm verdicts, 0 fail, 0 skip**, the install matrix **11 of 11**, and all seven regression gates green —
every one of them from tree `5f6a8276…`. §11.6, the real-provider gate, is the one piece of evidence not
re-run, and its heading says so.

**IT TOOK SEVEN ATTEMPTS AT THE GATE AND SIX AT THE INSTALL MATRIX, AND FINDING THINGS IS WHAT THEY WERE FOR.**
Nineteen defects: eleven in the gates and **eight in the product**, including one that made the durable
recovery budget not durable at all. §11.2.1 and §11.4 record every one in the order the runs found them.
**No threshold moved.**

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
| **6B** | **Unraid alpha packaging.** One canonical profile, one operator command, one environment contract | `deploy/projection-alpha.sh` and `docker-compose.projection-alpha.yml`, pinned by `test/projection-bounded-recovery.ts` and measured by `deploy/projection-alpha-acceptance.sh` |
| **6C** | **Bounded automatic recovery.** `--auto-recover`, reason-aware, budgeted, durable | `deploy/projection-recovery-gate.sh`, thirteen arms and a closed-set sweep, three consecutive fresh Tower runs |
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
`deploy/projectiond-alpha.env.example` and are pinned by `test/projection-bounded-recovery.ts`.

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
6. **A daemon that exhausts its budget leaves a mount point NOTHING CAN BIND, and only a human clears it.**
   Found on the fourth Tower run. A dead FUSE mount answers `stat` with `ENOTCONN`, and Docker's bind setup
   reads that as *"file exists"* and refuses to start the next container at all — with a message that tells an
   operator nothing about what is wrong. `preflight` now **refuses** with the closed-set remediation
   `clear-stale-mount` and the exact command (`umount -l`). **The appliance deliberately does not clear it
   itself**: unmounting something at the operator's mount point is the one action this whole tranche refuses
   to take automatically, and a preflight that quietly did it would be a worse version of the `--auto-remount`
   defect.
7. **A recovery usually STACKS OVER the corpse rather than removing it, and the first Tower run is what made
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

### 11.1 Frozen identity

> **THIS SECTION WAS FALSE AND WAS REWRITTEN AFTER A COORDINATOR AUDIT. §11.1.1 KEEPS WHAT IT SAID AND WHY IT
> WAS WRONG.** The correction cost a full re-freeze and a re-run of every provider-free acceptance in this
> record; no threshold moved and no number below is carried over from the runs the false identity described.

| What | Value |
|---|---|
| frozen commit | `c70ecb05843ce22128613e78adc676b1c8ec5110` |
| frozen tree | `5f6a82763ecdd207dd06e308b1e55e0d6d558341` |
| tracked manifest | `36e971ea74090cff` over **1,649** files, byte-identical in both directions vs `/mnt/user/appdata/catalog-p6` |
| image | `sha256:a5f12b92d80464a6e3e280498f22a3bd86e732718cee554b549c6ef58e53aef9` |
| host | Unraid `tower` |
| OPERATOR SOURCE DIGEST | `6dbb238d51f6415f0b323b95ddee7cc642b1690bcad147524eec4f5710791f73` |
| GATE SOURCE DIGEST | `afc38f3da63ad2edb45eae0ee5c3f82c0f640a0f96793b8f95e9c094bb7cbfab` |

**THE COMMIT AND TREE WERE HELD WHILE THIS WAS A CANDIDATE, BECAUSE A DOCUMENT CANNOT NAME THE COMMIT THAT
CONTAINS IT.** The source frozen and staged to the host is `c70ecb0` — the commit this file was committed as
before any of the runs below — and its identity is recorded here, in the commit that follows them.
`test/projection-bounded-recovery.ts` permits the held state **only** while §12 does not claim GO: a record
that claimed a closure while holding its own identity would be a closure nobody could check, which is the
defect this whole section exists to make impossible.

**HOW THE TREE WAS STAGED, AND WHAT WAS COMPARED.** `/mnt/user/appdata/catalog-p6` was moved aside and
recreated **empty**, `git archive c70ecb0` was extracted into it, and a sorted per-file sha256 manifest of
the host was diffed against the same manifest taken from `git archive` — **1,649 files, empty diff, both
directions**. The comparison is against the archive rather than against the Windows checkout, because
`.gitattributes` marks some files `eol=crlf` and comparing the checkout would show drift that is only line
endings. `node_modules` and the preserved real-provider evidence directory are excluded from the manifest
and are the only things carried across.

**THE TWO SOURCE DIGESTS ARE WHAT STOPS THIS SECTION GOING STALE AGAIN, AND THEY ARE NOT DECORATION.** A
record that merely NAMES a commit can be falsified by the next commit without anything noticing — which is
exactly what happened. `OPERATOR SOURCE DIGEST` covers the five files an operator actually runs
(`deploy/projection-alpha.sh`, its two helper programs, the environment contract example and
`docker-compose.projection-alpha.yml`); `GATE SOURCE DIGEST` covers the six that measure them. Both are
recomputed from the working tree by `test/projection-bounded-recovery.ts` on every run and compared against
these values. **Edit the shipped operator command after closure and this record stops matching**, which is
the defect caught at the moment it is introduced rather than by an audit afterwards.

### 11.1.1 What this section used to say, and why it was wrong

**HISTORICALLY — SUPERSEDED.** *"frozen commit `57200c8455c8bb276d23a06fd2b27175e986bd92` (gate-only changes
after it)"*, and *"It then did NOT move across the last three commits, which are gate-only."*

**BOTH SENTENCES WERE FALSE, AND THE SECOND WAS FALSE TWICE OVER.** Between `57200c8` and the commit the
evidence actually came from, **four** commits modified `deploy/projection-alpha.sh` — the shipped operator
product, not a gate — and **two** modified `deploy/projection-alpha-acceptance.sh`:

| Commit | Path it changed |
|---|---|
| `49df828` | `deploy/projection-alpha.sh` — the silent-preflight fix |
| `16c45b5` | `deploy/projection-alpha.sh`, `deploy/projection-alpha-acceptance.sh` — the manifest-ownership fix |
| `1f07092` | `deploy/projection-alpha.sh` — the non-idempotent `start` fix |
| `89d8e4c` | `deploy/projection-alpha.sh`, `deploy/projection-alpha-acceptance.sh` — the eaten-marker fix |
| `a02730d` | `deploy/projection-alpha-acceptance.sh` — the `findmnt --target` fix |

**AND THE RECORD WAS NOT EVEN DESCRIBING ONE TREE.** Three different trees produced the figures it published,
and `57200c8` was **none of them**:

| Evidence | Tree it actually ran from |
|---|---|
| the recovery-gate closure sequence | `541313c0252977b3de3b91b09dec2c8111bc5f7b` (commit `83191eb`) |
| the alpha install matrix, the seven regressions, the real-provider gate | `1e3f4cd7a3cae2e25864c56263ea3a904de2db44` (commit `a02730d`) |
| `57200c8` | a single green run of the recovery gate **before** the closure sequence, and nothing else in §11 |

**THE USER CONTRACT REQUIRED ONE FROZEN SOURCE, TREE AND IMAGE FOR CANDIDATE CLOSURE, AND THAT CONDITION WAS
NOT MET.** It is met now by re-freezing and **re-running**, not by rewording: §11.2, §11.4 and §11.5 below are
measurements taken from the single frozen tree named in §11.1, and the figures the false record carried have
been discarded rather than relabelled.

**THE ONE PIECE OF EVIDENCE THAT WAS NOT RE-RUN IS THE REAL-PROVIDER GATE**, and §11.6 says exactly why and
what that costs.

### 11.1.2 Which evidence depends on the image, and which on the source

**THESE ARE DIFFERENT QUESTIONS AND CONFLATING THEM IS HOW THE FALSE RECORD SURVIVED.** The daemon image and
the source scripts are frozen separately and can legitimately move at different times.

| Evidence | Subject is the DAEMON IMAGE | Subject is the SOURCE SCRIPTS |
|---|---|---|
| recovery-gate arms `RC1`–`RC13` | **yes** — every behaviour asserted is the daemon's | yes — the gate that injects the faults and reads the surface |
| the seven regression gates | **yes** — their whole subject is daemon behaviour | their own gate scripts only; none changed in this correction |
| the alpha install matrix `AA1`–`AA11` | partly — `AA4`/`AA7` read bytes through the daemon | **primarily** — `AA1`, `AA2`, `AA3`, `AA5`, `AA8`, `AA9`, `AA10` measure the shipped command itself |
| the real-provider acceptance | **yes** — the read path, the resolver and the egress allowlist are all in the image | its own gate script only |

**THE IMAGE DIGEST IS UNCHANGED AT `sha256:a5f12b92…` AND THAT IS A MEASUREMENT, NOT AN ASSUMPTION.** It was
rebuilt from the re-frozen tree on the host and produced the same digest, which is what says **no daemon byte
moved in this correction**. Every commit in it touches `deploy/`, `docs/` or `test/` and none touches
`projectiond/`.

**THE IMAGE DIGEST MOVED FROM PHASE 5'S AND IT IS SUPPOSED TO HAVE.** This tranche changes `projectiond` —
a recovery supervisor, two flags, six status fields and a fix to the probe cache — so a digest that had *not*
moved would mean the change was not in the image being tested.

### 11.2 The recovery gate — CLOSED, from the frozen source in §11.1

`npm run go:recovery-gate:three`, staged from frozen tree `5f6a8276…` (commit `c70ecb0`), completed
**three consecutive fresh runs, exit 0, zero skips** on the real Unraid host: **42 arm verdicts, 42 pass,
0 fail, 0 skip**, fourteen arms in every run.

| Run | Arms | Failed | Skipped | Elapsed |
|---|---|---|---|---|
| 1/3 | `RC1 … RC13` + the closed-set sweep | **0** | **0** | 261,891 ms |
| 2/3 | the same | **0** | **0** | 263,182 ms |
| 3/3 | the same | **0** | **0** | 262,219 ms |

The runner printed `RESULT: PASSED three consecutive cold-start runs`. **No `FAIL`, `GATE FAILED` or `SKIP`
line occurs anywhere in the transcript.** Reconciled independently: 42 `PASS` lines, **13 distinct `RC` ids
appearing three times each** = 39, plus the closed-set sweep three times = 42.

### 11.2.1 What the seven attempts before it cost, kept rather than glossed

**IT TOOK SEVEN RUNS TO GET ONE GREEN ONE, AND FIVE OF THE NINE DEFECTS WERE IN THE GATE.** Every one is
recorded here in the order the runs found them, because the sequence of what was believed when is the record.

| # | Found by | What it was | Where the fix went |
|---|---|---|---|
| 1 | run 1 | `RC6` required exactly one of our mounts, a precondition copied from an arm that runs **before** any recovery. By then `RC4`'s recovery had happened and the namespace legitimately held three | the gate — the guard is now on the **identity** of what will be aborted |
| 2 | reading, after run 1 | `RC8` masked `/dev/fuse` and then aborted the **subject's** connection, which kills its serve loop — so the serve supervisor's three remounts would all fail against the mask and the process would exit, leaving nothing alive to spend a recovery budget | the gate — the fault is now produced the way `RC4` produces it |
| 3 | run 2 | `RC4` asked the gate to **catch a one-second state**: the action code is on `/readyz` only while the attempt is in flight, and every reading costs a container start. Measured `generation 0 → 1` with `sawAction=0` | the gate — the action is read from the daemon's log, which is durable |
| 4 | run 2 | `RC10` counted **one remount as three**: `remount attempt 1/3` occurs on three lines of one attempt | the gate — anchored to end-of-line |
| 5 | run 2 | The `RC8` injector **could not run at all**, and the reason is the image being right: `nsenter -m` resolves its command in the target's filesystem, and the runtime stage is distroless. The kernel said so plainly — `failed to execute mount: No such file or directory` | the gate — a digest-pinned static busybox is copied in first |
| 6 | run 4 | `RC8`'s landing check read its own baseline **after** starting the blocker | the gate |
| 7 | **run 4** | **A daemon that exhausts its budget leaves a mount point NOTHING CAN BIND.** A dead FUSE mount answers `stat` with `ENOTCONN`; Docker's bind setup reads that as *"file exists"* and refuses to start the next container, with a message that tells an operator nothing | **the product** — `preflight` now refuses with the closed-set remediation `clear-stale-mount` |
| 8 | **run 5** | **THE PROBE CACHE WAS DELETING THE RECOVERY LEDGER ON EVERY STARTUP.** §11.2.2 |  **the product** |
| 9 | **run 6** | `--reset-recovery` said only that it had failed. The image's default user is `nonroot` while every shipped profile runs the daemon as root, so the ledger is root-owned and a reset that did not say who to be was refused by the filesystem | **the product** — the daemon now names the remediation, and both callers pass `--user 0:0` |
| 10 | the closure sequence | `RC8` was measuring a **proxy** for the cooldown, biased low by construction — the gate's own observation time by a whole poll (18,955 ms), then Docker's log timestamp by the gap between granting the attempt and writing the line (19,999 ms) | the gate — it now reads the stamps the cooldown is compared against, **corroborated** by Docker's independent ones |
| 11 | the closure sequence | `RC8` counted `RC4`'s attempt stamp as one of its own, because `lastAttemptUnixNano` is deliberately not cleared by a refund. **The corroboration is what caught it** — the arm refused because the two clocks disagreed on how many attempts there had been | the gate |

**No threshold moved.** §3.3 is byte-for-byte what was committed before the first run.

### 11.2.2 The most serious thing this tranche produced, and it was in code the tranche did not write

`RC11` — the one arm whose whole subject is the property that makes the budget a bound — failed on run 5 with
`stateAfterRestart=idle attempts=0`. A daemon that had just exhausted its budget and locked itself out came
back from a container restart with a clean slate, **cheerfully ready**.

`NewProbeCache` sweeps its directory at startup and removes every entry whose name is not a record name. That
is right for the `.tmp` leftovers of an interrupted write, which is what it was written for. But that
directory is also **the one place the operator contract requires to be durable and writable**, so it is
exactly where anything else durable naturally goes — and Phase 6 put the recovery ledger there. The sweep
deleted it on every single startup.

**So the whole argument for `restart: unless-stopped` being safe was false.** An in-memory budget of three
authorises three attempts *per restart*, which is unbounded, and that is precisely why the ledger was made
durable. It was durable in every respect except surviving the thing it existed to survive.

**The fix is in the cache, not in the tranche that found it.** A directory was never that cache's to remove:
`os.Remove` on one succeeds only when it is **empty**, so anything with a file in it survived *by accident* —
right up until the first startup after somebody cleared it. The sweep now skips directories outright, and the
ledger has moved into one of its own. Both halves are pinned: `TestNewProbeCacheLeavesDirectoriesAlone` drives
the real constructor and **fails against the previous cache** (verified: it deleted the empty directory), and
`TestTheProbeCacheDoesNotEatTheLedger` builds a whole daemon against a ledger's own directory, which is what a
container restart is.

### 11.3 Offline

Taken on the Windows development host. **They are not gate evidence**; they are what makes a run worth
attempting.

| What | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run go:fmt` / `go:vet` / the whole Go suite | clean / clean / every package `ok` |
| `npx tsx test/projection-bounded-recovery.ts` | **37 passed, 0 failed, ZERO SKIPS** |
| `npx tsx test/projection-operational-mount-health.ts` | 29/0 — Phase 5's pins, undisturbed |
| `npx tsx test/projection-mount-truth.ts` | 13/0 — Phase 4's pins, undisturbed |
| `npx tsx test/custody-runtime-closure.ts` | 39/0 |
| `npx tsx test/projection-evidence-consistency.ts` | 4/0 |
| full `npm run test:offline` | **313 selected, 313 passed, 0 failed** |

**THE FULL OFFLINE INVENTORY IS CLEAN, AND THAT IS BETTER THAN THE BASELINE THIS TRANCHE INHERITED.** Phase 5
recorded ten pre-existing failures on this host under `npm test`. `test:offline` at this commit selects 313
suites and every one of them passes.

### 11.4 The alpha install matrix — PASSED, from the frozen source in §11.1

`bash deploy/projection-alpha-acceptance.sh`, staged from frozen tree `5f6a8276…` (commit `c70ecb0`), on
the real Unraid host: **11 of 11 arms, 0 failed**, in 30,000 ms on a warm host.

**THIS IS THE ONE THE AUDIT WAS ABOUT.** It drives the **shipped** operator command, and the shipped operator
command is what the false record had mis-attributed — so of everything in §11 this is the measurement that
most needed to come from a source somebody can check. It now does, and the `OPERATOR SOURCE DIGEST` in §11.1
is what keeps it that way.

| Id | Measured |
|---|---|
| `AA1` | `preflight` refused with no consumer attached, exit 1, and **created nothing** |
| `AA2` | a relative path, a `..` segment, a host root directory and a floating image tag were each **refused rather than resolved** |
| `AA3` | `install` and `start` are both idempotent; the appliance is `healthy`; it claims the cache it writes to, holds its mount point with its own file system, and **left the control plane's manifest directory unclaimed** |
| `AA4` | the pre-attached unprivileged consumer digest-matched bytes recorded outside the mount |
| `AA5` | the status surface names the recovery state, reason, generation and remediation, and carries **no URL, media identity or free-text error** |
| `AA6` | a foreign overlay showed as `inspect-mount-owner`, was **left exactly where it was**, and the appliance returned to `healthy` once a human removed it |
| `AA7` | the **same** consumer read the **same** digest after the fault |
| `AA8` | `upgrade` recorded a rollback target **before** changing anything, and `rollback` returned to it |
| `AA9` | `reset-recovery` cleared the durable budget, and a second run of it is still a success |
| `AA10` | `stop` is idempotent, the appliance is gone, and the media, manifest and cache are untouched |
| `AA11` | the host's container, network and volume **sets** are identical; this run's mountpoints and directory are gone |

**IT TOOK SIX ATTEMPTS TO GET HERE AND FOUND FOUR PRODUCT DEFECTS, ALL IN THE OPERATOR COMMAND.**

| Found by | What it was |
|---|---|
| `AA1` | **`preflight` exited 1 with NO MESSAGE in the exact condition every first-run operator is in.** Under `set -euo pipefail` the consumer scan's loop body ends in a `grep` that fails when nothing matches; `pipefail` carried that through `wc -l` and `set -e` killed the whole preflight before it could say a word |
| `AA3` | **The appliance was claiming the control plane's manifest directory**, so `install` refused a perfectly correct installation the moment a generation existed |
| `AA3` | **`start` was not idempotent**, because the ownership marker is written into the mount point and the namespace is then mounted **over** it |
| `AA3` | **The probe cache ate the ownership marker too** — the same sweep that ate the recovery ledger, found one arm later, on a second victim |

Two further defects were the gate's own: four `pass` messages whose second line had no continuation (the
shell ran it as a command and each lost half its report), and `AA6` asking `findmnt --target` what *contains*
the path — which on a stacked mount point answers with the **bottom** of the stack, so an untouched overlay
was reported as touched.

### 11.5 The §7 regression matrix — DONE, from the frozen source in §11.1

Every gate below ran on the real Unraid host from frozen tree `5f6a8276…` (commit `c70ecb0`) with
`PROJECTIOND_IMAGE=projectiond:phase6-frozen` (`sha256:a5f12b92…`), serialised one after another in the same
sequence as the two above.

| Gate | Runs | Result |
|---|---|---|
| `go:mount-health-gate:three` | 3 | **exit 0** — 269 s |
| `go:mount-truth-gate:three` | 3 | **exit 0** — 63 s |
| `go:serve-death-gate:three` | 3 | **exit 0** — 53 s |
| `go:stale-mount-gate:three` | 3 | **exit 0** — 271 s |
| `go:sustained-outage-gate:three` | 3 | **exit 0** — 269 s |
| `go:publisher-mount-gate` | 1 | **exit 0** — 100 s |
| `go:rclone-comparison-gate` | 1 | **exit 0** — 135 s |

Zero failures, zero skips, in any of them.

**THE SUSTAINED-OUTAGE GATE IS THE CONTROL FOR THIS TRANCHE.** Its subject is a provider outage that never
touches the mount, and it asserts `ready` is **still true** afterwards. A recovery supervisor that had become
trigger-happy would fail it. It passed three times, so the supervisor is still deaf to everything except the
mount.

**AND THE SERVE-DEATH GATE IS THE ONE MOST LIKELY TO HAVE BROKEN**, because Phase 6 adds a second caller to
the exact supervisor path it measures. It passed three times unchanged.

**ONE OBSERVATION THAT IS NOT THIS TRANCHE'S TO ACT ON.** `go:rclone-comparison-gate`'s own nonclaim list
still ends with *"no run of this gate has ever happened on a real Linux or Unraid host"*. These runs are two
more. Correcting that sentence belongs to the phase that owns the gate, and it is recorded here rather than
quietly edited.

### 11.6 The narrow real-provider acceptance — PASSED, and NOT re-run

`bash deploy/projection-torbox-real-gate.sh`, once, in its **already-approved existing scope**, on the real
Unraid host against a real TorBox account and a real CDN.

**IT RAN FROM TREE `1e3f4cd7a3cae2e25864c56263ea3a904de2db44` (commit `a02730d`), NOT FROM THE FROZEN TREE
IN §11.1, AND IT WAS DELIBERATELY NOT RE-RUN.** Saying so is the point of this paragraph.

**WHY THAT IS DEFENSIBLE, STATED AS A CHECK RATHER THAN AN OPINION.** Its two subjects are the daemon image
and its own gate script, and **neither moved**: the image digest is byte-identical
(`sha256:a5f12b92…`, rebuilt from the re-frozen tree and unchanged), and
`git diff a02730d..<frozen> -- deploy/projection-torbox-real-gate.sh deploy/projection-torbox-real-gate-three.sh`
is empty. Nothing this correction touched is on the path this gate measures.

**WHY IT WAS NOT RE-RUN ANYWAY.** It spends the operator's metered account against a real CDN. The rule this
tranche has held to throughout is that provider traffic is spent only when a changed subject requires it, and
no subject of this gate changed. **That is a cost decision, not a claim that re-running would have been
redundant** — it would have been a stronger record, and it is not what was chosen.

`TORBOX REAL-PROVIDER GATE PASSED.` The operator's own objects were read as **ordinary read-only files
through a FUSE mount**: **7 reads, 0 problems**, across the corpus's **6 declared windows**, with **6 allowed
origins** (the loopback resolver plus five operator CDN origins), a subsequent read **reusing the lease**
rather than minting a fresh signed URL, and write attempts **refused for both uids**.

**WHAT IT DID NOT DO.** No new corpus discovery, no broad provider enumeration, no download outside the
approved windows, and no raw endpoint, origin, ref, account or media identity in any output — the figures
above are counts, and the one path named is this run's own evidence file. The origin allowlist was **not
touched**: it did not need maintenance on this run, and if it had, this tranche's rule was to emit a digest
and a count and **ask**.

### 11.7 Host cleanup — asserted, against the pre-Phase-6 baseline

Before and after **everything** — the seven recovery-gate attempts, the discarded closure sequences, the six
install-matrix attempts, the real-provider gate, and then the whole re-acceptance from the frozen source:

| What | Result |
|---|---|
| container set | **identical** to the baseline captured before any Phase 6 container existed |
| network set | **identical** |
| volume set | **identical** |
| `fuse.projectiond` mounts on the host | **0** |
| mountpoints under this task's staging root | **0** |

**THE BASELINE IS THE ORIGINAL ONE, NOT A FRESH ONE.** Comparing against a snapshot taken after the work
began would have made a leak invisible, so the comparison is against the container, network and volume sets
captured before the first Phase 6 container was ever created — 42 containers, 17 networks, 45 volumes.

**THREE EMPTY GATE ROOTS WERE LEFT AND ONE FULL ONE IS KEPT.**
`.projection-alpha-acceptance`, `.projection-publisher-gate` and `.projection-rclone-gate` were each
verified to hold **0 entries** and removed with `rmdir`, which refuses a non-empty directory and therefore
could not have taken anything with it. `.projection-torbox-real-gate` is **deliberately kept**: it holds the
real-provider evidence file, and deleting it would delete the evidence. The frozen tree at
`/mnt/user/appdata/catalog-p6` and the image `projectiond:phase6-frozen` are kept for the same reason.

**THE SUPERSEDED STAGING COPY WAS REMOVED.** Re-freezing moved the old tree aside to
`/mnt/user/appdata/catalog-p6-old` so the new one could be extracted into an empty directory rather than
over the top of it; that copy has been removed. Only `node_modules` and the real-provider evidence were
carried across, and neither is in the manifest §11.1 compares.

**NOTHING OUTSIDE THIS TASK'S OWN ROOTS WAS TOUCHED.** No production mount, no existing media library, no
user share, no unrelated container, network or volume, and no operator secret was modified. The TorBox
corpus was read and never written.

## 12. The alpha readiness decision

# **GO — for a rough-edged alpha, on exactly one supported combination.**

**AND THIS TIME IT RESTS ON ONE FROZEN SOURCE, WHICH IS WHAT THE PREVIOUS GO DID NOT.** Every provider-free
measurement in §11 — the recovery gate's 42 verdicts, the install matrix's 11 arms and all seven regression
gates — was taken from tree `5f6a8276…` (commit `c70ecb0`), staged byte-identically to the host in both
directions, against image `sha256:a5f12b92…` rebuilt from that same tree. The one exception is §11.6, whose
heading says so.

**WHAT THE AUDIT CHANGED ABOUT THE VERDICT: NOTHING, AND THAT IS WORTH STATING PLAINLY RATHER THAN QUIETLY.**
Every re-run reproduced its result — 42/42, 11/11, seven gates green, zero skips — so the previous figures
were not wrong, they were *unverifiable*. A GO that cannot be traced to one source is not a weaker GO, it is
a different kind of claim, and the correction was worth a full re-measurement precisely because that
distinction is the whole point of this repository's evidence discipline.

### 12.1 What can be installed today

**A TorBox-first projection appliance on an Unraid host**, from the profile and the command in §5, with
bounded automatic recovery on. It mounts a namespace an unprivileged consumer reads **real bytes** through,
it repairs the mount faults it is entitled to repair, it refuses the ones it is not, and it stops rather than
looping.

### 12.2 The exact supported combination

| | |
|---|---|
| **Host** | Unraid, with `/dev/fuse` reachable from a container. **One host has been measured**: three green runs on a host that is not Linux or Unraid close nothing at all |
| **Provider** | **TorBox only**, through the resolver Phase 1 closed against, with the credential as a **file path** and an operator-maintained `allowedOrigins` set |
| **Frontend** | any consumer that can bind a host path. **The media servers are Phase 1's evidence, not this tranche's**: Plex, Jellyfin and Emby have each scanned and played through this mount, but no media server was in any Phase 6 run |
| **Mount** | one `projectiond` FUSE mount, `rshared`, with the consumer bound **before** the daemon first mounts there |
| **Image** | pinned. `sha256:a5f12b92d80464a6e3e280498f22a3bd86e732718cee554b549c6ef58e53aef9` is what every figure in §11 was measured against |

### 12.3 The commands

```
deploy/projection-alpha.sh preflight        # checks everything, changes nothing
deploy/projection-alpha.sh install          # creates only this appliance's own directories
deploy/projection-alpha.sh start            # brings it up and waits for readiness
deploy/projection-alpha.sh status           # what is wrong, what is at the mount, what is being done
deploy/projection-alpha.sh stop             # down, leaving every byte of data
deploy/projection-alpha.sh upgrade          # records the running digest, then starts the new one
deploy/projection-alpha.sh rollback         # returns to the digest upgrade recorded
deploy/projection-alpha.sh reset-recovery   # clears a recovery lockout, after fixing the fault
```

Set the environment from `deploy/projectiond-alpha.env.example` first. **Attach your media server to the
mount point before you run `install`** — `preflight` refuses without it, and §5.2 says why.

### 12.4 The security boundaries

- **A credential is a path, never a value.** No variable in the environment contract holds one, and
  `preflight` refuses a configuration that appears to carry one.
- **Egress is allowlisted.** The daemon refuses a resolved URL whose origin is not in the operator's set — a
  property that has already caught a real CDN rotation.
- **The status and recovery surfaces are closed-set codes and numbers.** No path, no URL, no origin, no
  provider reference, no object identity, no OS string. `serveError` is the one free-text field on the
  readiness document, predates Phase 5, and is **not printed by the operator surface**.
- **There is no remote control surface for recovery.** It is a goroutine reading this process's own readiness
  verdict; nothing outside the process can trigger one.
- **Nothing that is not ours is ever unmounted**, and the appliance will not clear a foreign or dead mount
  for you — it names it and stops.
- **No restart policy changed.** `restart: unless-stopped` restarts on a crash and on nothing else.

### 12.5 Known rough edges

§9, in full, and all six are real. The two an operator will meet first: **a lockout outlives its cause** and
needs `reset-recovery` by hand, and **a failed recovery leaves a mount point nothing can bind** until a human
runs `umount -l` — `preflight` refuses with `clear-stale-mount` rather than letting Docker produce a sentence
about `file exists`.

### 12.6 What remains before beta

1. **A second host.** One Unraid host is one Unraid host.
2. **A media server in a Phase 6 run.** Every recovery arm here used an unprivileged byte-reading consumer.
   The three servers are Phase 1 and Phase 3 evidence and have not been run against this supervisor.
3. **Unwedging a wedged probe.** §9.2: a probe parked in an uninterruptible `statfs` can leave the observation
   permanently unavailable, which spends the budget and locks out. The real fix is for recovery to abort the
   daemon's **own** FUSE connection first, which is a new destructive capability.
4. **Draining the corpses.** §9.7: recovery stacks over the dead layer rather than removing it, because the
   probe answers about the bottom of the stack. Fixing that touches Phase 3's hardest-won code.
5. **An operator UI for the status surface.** Today it is a shell command.
6. **A rollback that survives losing the cache**, since the rollback target is recorded there.

### 12.7 What this GO is not

It is **not** a beta, a release, a marketplace package, or a production cutover. It is **not** support for
Real-Debrid or Usenet — §13 is a contract for work not done. It does **not** make `rclone` the architecture:
ADR-002 is untouched, and the comparison harness remains a measurement with no pass threshold and **no
winner**. And it closes **no G-number**.

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
