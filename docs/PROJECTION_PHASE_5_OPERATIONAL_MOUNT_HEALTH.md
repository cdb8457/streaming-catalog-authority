# Projection Phase 5 — the observation becomes operationally authoritative

**Status: CLOSED.** Every threshold in §4 was committed before the first measured run and **none has moved**.
`npm run go:mount-health-gate:three` completed **three consecutive fresh runs, exit 0, zero skips** on the
real Unraid host: 36 arm verdicts, 36 pass, 0 fail, 0 skip. **§3.3 records three clauses that were
predeclared, measured false on the first real run, and superseded** — an unconditional recovery confirmation
that made the anti-flap policy contradict itself, a precedence that made `serve-loop-dead` unreportable, and
an arm that passed vacuously. None of the three was a threshold.

**What this tranche is, in one sentence.** `/readyz` stops answering from what the daemon *remembers* and
starts answering from what is *observed* at its mount point — through a bounded policy, not a bare comparison
— while a separate loopback liveness endpoint keeps answering the different question of whether the process
is alive.

**What it is not.** It is not a recovery improvement, it closes no G-number, it changes no restart policy, it
adds no alerting, and it is not a performance claim. §10 is the full list.

---

## 1. What Phase 4 left on the table, on purpose

Phase 4 put an **observation** beside the daemon's **belief** and changed neither `ready` nor `mounted`. Its
§5 named the remaining half explicitly:

> *"Folding the observation into `ready` is explicitly NOT in this tranche. It is a behaviour change to an
> endpoint three closed phases were measured against, and it is deferred, named here so it is a decision
> somebody takes rather than a thing that drifts in."*

**This is that decision, taken.** Until it is taken, the field is decoration: an operator's health check, a
container's healthcheck and a monitoring rule all key off `ready`, and `ready` still cannot distinguish a live
mount from a remembered one. Both of the worst failures in this product's recorded history presented as a
healthy daemon for exactly that reason — the `--auto-remount` defect that remounted into a namespace with no
host peer, and the cold corpse that refused every remount while the process stayed alive.

**And taking it forces a second change, which is why this tranche is larger than Phase 4.** The moment `ready`
can be false on a perfectly healthy process, a supervisor keying on the only endpoint there is cannot tell
*"restart me"* from *"do not send me traffic yet"* — and restarting a daemon whose mount is merely being
confirmed turns a transient into an outage. Readiness and liveness have to become two questions with two
answers, or making readiness honest makes the deployment worse.

## 2. Why the policy is not `observed == live`

**The observation is a SAMPLE, and a sample is late by construction.** The probe runs on its own cadence
(§2 of Phase 4 records why it can never run on the request path); a probe that overruns leaves the previous
sample in place to age; and a successful remount restores the mount up to a full interval before anything
sees it.

Wiring `ready` straight to the latest sample would therefore make a **healthy** daemon flap: not-ready for a
second whenever a probe was slow, and not-ready for a second after every recovery. Every gate that waits for
`ready` would inherit that as flake, and an operator would learn to ignore the field — which is a worse
outcome than the one this tranche is fixing.

So three bounded rules stand between the sample and the verdict, and each has a failure it exists to prevent:

| Rule | Prevents |
|---|---|
| **Bootstrap grace** — an *absent* observation does not make readiness false for a bounded window after the first mount | a cold start on a loaded host answering not-ready for a reason that is about the host |
| **Fault hold** — a fault must persist, measured from the last live observation, before it is believed | one late or one non-live sample taking an appliance out of service |
| **Recovery confirmation** — the mount must be *continuously* observed live for a bounded run before readiness returns | one lucky sample putting a broken appliance back in service, which is the same defect pointing the other way |

**AND NEITHER THE GRACE NOR THE HOLD SURVIVES A KNOWN DEATH.** Both exist to stop a *sampling artefact* being
read as a fault. A serve-loop exit the supervisor observed is not an artefact — it *is* the fault. So once a
serve death has been recorded, the grace is gone for the life of the process and a non-live observation is
believed at once. Without that clause, a remount could coast back to `ready` on a stale live observation
inside the hold, and the recovery arm would be satisfiable without the mount ever being seen.

## 3. The state machine, and the precedence is the interesting part

`readyReason` is present in **every** response, including when it is `ok`. First match wins.

| # | Reason code | Fires when | Graced? | Held? |
|---|---|---|---|---|
| 1 | `no-generation-admitted` | nothing has ever been admitted | — | — |
| 2 | `serve-loop-dead` | the supervisor observed the serve loop exit | — | — |
| 3 | `not-mounted` | the daemon does not believe it is mounted | — | — |
| 4 | `mount-observed-not-live` | the last completed observation is `stale-projectiond`, `foreign` or `empty` | **never** | yes |
| 5 | `mount-observation-stale` | the last completed observation says live but is older than `SAMPLE_MAX_AGE_MS` | **never** | yes |
| 6 | `mount-observation-unavailable` | no observation has completed, or the sampler gave up on one | yes | yes |
| 7 | `mount-recovering` | live and fresh, but the live run is shorter than `MOUNT_RECOVERY_CONFIRM_MS` **and the fault it is recovering from was one readiness was actually withheld for** | yes | — |
| 8 | `ok` | everything above was checked and none of it fired | — | — |

**Rules 1–3 are the pre-existing readiness rules, unchanged in meaning, and they are deliberately ahead of
everything Phase 5 added.** A daemon with nothing to serve, one whose serve loop the supervisor *watched*
exit, and one that never mounted are not mount-observation questions. The supervisor's own knowledge is
**direct evidence**; the observation is a **late sample of the same event**. Reporting the sample first would
name the symptom and bury the cause.

> **THREE CLAUSES IN THIS TABLE WERE PREDECLARED DIFFERENTLY, MEASURED FALSE ON THE FIRST REAL TOWER RUN, AND
> CORRECTED. NO NUMBER MOVED.** §3.3 keeps the original wording of each, what it measured, and why the
> replacement is not a threshold being loosened to obtain green.

**Rules 4 and 5 are never covered by the grace, at any age of the process.** The grace covers *"we have not
been able to look yet"*. It never covers *"we looked and it is not live"* — that distinction is the same one
Phase 4 drew between `timeout` and a negative result, and it is the whole reason this policy is not simply a
timer.

**Rule 5 is the wedged-mount signature.** A probe that cannot answer leaves the previous sample in place to
age, so a mount nobody can read presents as a verdict that has *stopped advancing* rather than as a negative
one. Without rule 5, the single most dangerous failure — a mount that hangs every consumer — would read as
`ready`.

### 3.1 Liveness is a different question, and it says so in its own document

`/healthz` answers **only** whether this process and its status server are alive. It reads a clock and two
constants. It never touches the mount observation, the store or the serve loop, so it cannot be made slow or
false by a broken mount.

```json
{"alive": true, "uptimeSeconds": 120, "surface": "liveness", "claimsMountUsable": false}
```

`claimsMountUsable` is a constant `false`. **A nonclaim that has to be inferred from an absent field is one a
later edit adds a field beside without noticing**; one that is written down is one a reader and a test can
both hold the surface to. It is loopback-only on the **route** as well as on the bind, and read-only.

### 3.2 What is redaction-safe here, and what was already not

Everything Phase 5 adds is a **closed-set code or a number**: no path, no URL, no origin, no credential, no
provider reference, no object identity, no OS or provider string.

**`serveError` is the one free-text field on the readiness document and Phase 5 did not add it.** It predates
this tranche, it is unchanged, and it is named here so that *"the readiness reasons are closed-set"* is never
read as a claim about the whole document. Changing it is not in this tranche.

### 3.3 What was predeclared, measured false, and superseded — kept, not deleted

The first measured Tower run of the gate returned **10 of 12 arms passing**. Both failures were the gate
catching **product** defects in the policy as predeclared, and one of the passes was passing **vacuously**.
All three are recorded here, in the order the run found them, with the original wording kept.

**(a) `MH6` — THE RECOVERY CONFIRMATION WAS UNCONDITIONAL, AND THAT MADE THE ANTI-FLAP POLICY CONTRADICT
ITSELF.** *Predeclared, in its own words:* rule 7 fires when *"live and fresh, but the live run is shorter
than `MOUNT_RECOVERY_CONFIRM_MS`"*, with no further condition. Measured: `MH6 sawNonLiveObservation=1
lostReady=1 (code 503)` on a two-second fault.

*It is not flaky and it was not a threshold problem.* Any transient long enough to produce **one** non-live
sample necessarily restarts the live run — that is what a run *is*. So an unconditional confirmation takes
the appliance out of service for a whole second at the **tail** of every transient whose **front** the fault
hold had just protected. The two rules were arguing with each other, and the fault hold was losing. **The arm
was not changed; the rule was.** Hysteresis confirms on the way back only if it actually left, so the
confirmation now applies only when the preceding gap outlasted the hold, or contained a recorded death, or
there was no earlier live observation at all. `MOUNT_RECOVERY_CONFIRM_MS` is **still 1,000**.

**(b) `MH3` — `serve-loop-dead` WAS PREDECLARED BEHIND `not-mounted`, WHICH MADE IT UNREPORTABLE.**
*Predeclared:* precedence `1 no-generation-admitted, 2 not-mounted, 3 serve-loop-dead`. Measured: `MH3
code=200 reason=ok`, having polled for fifty seconds and never once seen the code it was waiting for.

*It cannot happen, for the same reason Phase 4's original MT2 could not.* On a serve-loop death the
supervisor runs `SetMounted(false)` and **then** `RecordServeDeath(...)`; on recovery it runs
`ClearServeDeath()` and **then** `SetMounted(true)`. `mounted` is therefore false for the **entire** window in
which a death is recorded, so a `not-mounted` that outranked it would be the only thing `/readyz` ever said.
A reason code that cannot occur is worse than no reason code: it reads as coverage. It is also the worse of
the two answers — a death is *why* the daemon is not mounted, and reporting the state instead of the cause is
the same mistake as reporting the sample instead of the supervisor. **The readiness boolean is identical
either way**, so this changes which code is published and no behaviour any closed gate was measured against.

**(c) `MH8` PASSED VACUOUSLY, AND THAT IS THE MOST SERIOUS OF THE THREE.** It reported *"a confirmed live run
of 72,305 ms"* — a run that had begun **seventy-two seconds before the abort it claimed to be a recovery
from**. The supervisor remounts after a one-second backoff and the sampler probes once a second, so the whole
death and recovery passed **between two samples**: no observation ever went non-live, the run continued
unbroken across the fault, and readiness never dropped at all.

*An observation taken before a death says nothing about what is on the other side of it.* That is precisely
Phase 2's worst defect — the remount that succeeded for the daemon and for nobody else — reached through this
tranche's new field. **A recorded serve death now ends the live run**, so the next live sample starts a new
one and readiness returns only after a live observation taken *after* the death and confirmed. As a
by-product the not-ready window is now bounded **below** by the supervisor's own one-second backoff plus the
confirmation, which is what makes `MH3` and `MH8` measurements rather than races. `MH8` additionally now
requires that readiness was observed to have **dropped** — a recovery arm that never saw an outage is an arm
that proves nothing.

**None of the three is a threshold moved after measurement.** §4 is byte-for-byte what was committed before
the first run. What moved is the *shape* of two rules that were self-contradictory and one arm that could
pass without measuring anything, and each replacement is pinned by a Go case that fails against the original.

## 4. The predeclared thresholds

Every one of these is in `PROJECTIOND_MOUNT_HEALTH` in `src/core/projection/runtime-contract.ts`, and this
document restates none of them from memory — `test/projection-operational-mount-health.ts` fails if the two
disagree.

| Name | Value | Where it comes from |
|---|---|---|
| `MOUNT_BOOTSTRAP_GRACE_MS` | **15,000** | **CHOSEN, both bounds named.** *Below:* it must comfortably exceed `SAMPLE_MAX_AGE_MS` plus the time a cold container takes to reach its first completed probe, or a healthy daemon on a loaded host answers not-ready for a reason about the host — and every gate that waits for `ready` inherits that flake. *Above:* this is the **only** window in which readiness can be true with the mount never observed, so it is the window in which the failures this tranche exists to catch could still hide; it is held strictly under the healthcheck's start period so the first probe Docker counts is one the grace can no longer answer |
| `MOUNT_FAULT_HOLD_MS` | **6,000** | **DERIVED:** `2 × SAMPLE_MAX_AGE_MS`. One window is the longest a healthy daemon can legitimately go without a fresh verdict, so a hold of one window fires on the ordinary worst case. Two is the smallest multiple that requires a fault to survive a complete observation opportunity it could not have slept through |
| `MOUNT_RECOVERY_CONFIRM_MS` | **1,000** | **DERIVED:** `SAMPLE_INTERVAL_MS`. A live run spanning a full interval cannot consist of one sample, so this is the shortest bound that guarantees **two** distinct completed live observations |
| `LIVEZ_LATENCY_BUDGET_MS` | **1,000** | **CHOSEN**, and as with readiness the number matters far less than the property beside it: it is **strictly under `PROBE_TIMEOUT_MS`**, so a liveness endpoint somehow put on the probe's path could not pass it. `LIVEZ_CANNOT_HAVE_WAITED_FOR_A_PROBE` is that as code |
| `HEALTHCHECK_INTERVAL_S` | **10** | the shipped container healthcheck's interval |
| `HEALTHCHECK_TIMEOUT_S` | **5** | held strictly **above** `READYZ_LATENCY_BUDGET_MS`, so an endpoint answering inside its contract can never be recorded as a healthcheck timeout |
| `HEALTHCHECK_START_PERIOD_S` | **20** | held strictly **above** `MOUNT_BOOTSTRAP_GRACE_MS`, so a container cannot report `healthy` on a probe the grace answered |
| `HEALTHCHECK_RETRIES` | **3** | with the interval, `retries × interval` = 30,000 ms is held strictly **above** `MOUNT_FAULT_HOLD_MS`, so the **daemon** decides what is broken and Docker only repeats it |
| `HEALTHCHECK_UNHEALTHY_BOUND_MS` | **41,000** | **DERIVED:** fault hold + every retry + one whole probe timeout for the last of them. It is the gate's upper bound and nothing else — not a target |
| `ANTI_FLAP_TRANSIENT_MS` | **2,000** | **DERIVED, both bounds named.** *Above `SAMPLE_INTERVAL_MS`:* shorter and the fault could pass between two probes, so the arm would assert that readiness survived a fault the daemon never saw. *Below `MOUNT_FAULT_HOLD_MS − SAMPLE_MAX_AGE_MS`:* longer and readiness would be **entitled** to go false, so a run in which it did would be the product behaving correctly and the arm would be wrong to fail it |

**Phase 4's four numbers are reused unchanged and are not restated here.** `SAMPLE_INTERVAL_MS` (1,000),
`PROBE_TIMEOUT_MS` (2,000), `SAMPLE_MAX_AGE_MS` (3,000) and `READYZ_LATENCY_BUDGET_MS` (1,000) keep the values
and the derivations Phase 4 closed against. **No Phase 4 threshold moves in this tranche.**

### 4.1 The derived relations, which are checks rather than comments

Each is exported and asserted, in the shape `ROTATION_REFUSAL_BELOW_BREAKER` already uses. Any one of them
failing would leave an arm passing while measuring something else.

| Name | Says |
|---|---|
| `LIVEZ_CANNOT_HAVE_WAITED_FOR_A_PROBE` | the liveness budget is strictly under the probe timeout |
| `HEALTHCHECK_START_PERIOD_CLEARS_BOOTSTRAP_GRACE` | Docker never counts a probe the grace answered |
| `HEALTHCHECK_TIMEOUT_CLEARS_READINESS_BUDGET` | an in-contract answer is never recorded as a timeout |
| `DAEMON_DECIDES_UNHEALTHY_NOT_DOCKER` | Docker's retry budget outlasts the daemon's fault hold, so the anti-flap policy lives in one place |
| `MOUNT_HEALTH_POLICY_IS_BOUNDED_BY_ITS_SAMPLER` | the hold and the grace both outlast one whole worst-case sampling window, the confirmation spans at least two samples, and the transient fits strictly inside the hold |

## 5. What is changed in the product

1. **`/readyz`** answers from the §3 policy and carries `readyReason`, `mountLiveRunMs`, `mountSinceLiveMs`,
   `mountBootstrapGrace` and `mountGraceRemainingMs` beside Phase 4's `mountObserved` / `mountObservedAgeMs`.
   It is `no-store`. **It still takes no probe on the request path** — Phase 5 makes that property
   load-bearing rather than merely tidy, because an inline probe would now make an appliance with a wedged
   mount unable to report that it has one.
2. **`/healthz`** becomes the formal liveness surface: §3.1's document, loopback-only on the route, read-only.
3. **`projectiond --healthcheck`** reads its own `/readyz` over loopback and exits 0 only if it is ready. It
   constructs no daemon, opens no cache and cannot mount. It **fails closed** on every uncertainty — no status
   address, unreachable endpoint, unreadable body, any status but 200. It prints the closed-set reason code
   and nothing else, because Docker keeps healthcheck output in the container's health log and that is the one
   place the reason reaches an operator without them reading `/readyz` themselves.
4. **The image gains a `HEALTHCHECK`** wired to that flag. The runtime stage is distroless — no shell, no
   curl, no wget — so the daemon's own binary is the only thing in the image that can make the request.

### 5.1 It reports; it does not act

**Docker's `restart:` policies do not react to health status.** `restart: unless-stopped` in
`docker-compose.projectiond.operator.yml` restarts on *exit*, and a container whose healthcheck fails does not
exit. So this tranche changes what a container **reports** and nothing whatever about what is done to it.

**Wiring health to an action is deliberately not in this tranche**, and it is named here so it is a decision
somebody takes rather than a thing that drifts in — the same way Phase 4 named this one.

## 6. The gate

`deploy/projection-operational-mount-health-gate.sh`, with `-three` and `-optional` wrappers, run as
`npm run go:mount-health-gate`.

**Provider-free by construction.** No provider, no endpoint, no credential, no operator corpus, no media
server. The daemon's configuration names no endpoint at all, so there is nothing it could contact. This
tranche must not be blocked by, and must not spend, the operator's metered account.

**ONE subject daemon, ONE mount, ONE unprivileged consumer** bound to the mount point `rslave` **before
anything is ever mounted there**, per §11 of the Phase 0 product contract. The consumer reads **bytes** and
digests them: a dead FUSE mount answers `stat` from a warm attribute cache while every `open` returns
`ENOTCONN`, so a `test -f` here would pass over the exact state this gate exists to detect.

**A second projectiond container appears, and it is a FAULT INJECTOR rather than a second subject.** `MH4`
needs a mount whose `statfs` **blocks** — the wedged case, which is the one failure a removal cannot produce
and the one rule 5 exists for. Freezing a FUSE server is the only way to produce it on a real host, and the
only FUSE server this repository can freeze without adding an external image is its own. It is stacked above
the subject's mount, frozen, and removed inside the same arm.

| Id | What it holds |
|---|---|
| `MH1` | **The control.** A live mount: `ready` true, `readyReason=ok`, `mountObserved=live-projectiond`, the container's healthcheck reports `healthy`, and the pre-attached unprivileged consumer digest-matches bytes recorded outside the mount. Without this arm every arm below is satisfied by a daemon that answers not-ready unconditionally |
| `MH2` | **A foreign overlay, sustained.** A tmpfs stacked **above** the live mount: readiness becomes **false** with `readyReason=mount-observed-not-live` and HTTP **503**, while `mounted` stays true and the serve loop never dies. Removing only the overlay restores `ok` |
| `MH3` | **A dead connection.** This run's own FUSE connection is aborted: readiness false, and the reason is `serve-loop-dead` — **precedence rule 3 beating rule 4**, asserted as such, because the supervisor's knowledge is direct and the observation is a late sample of the same event |
| `MH4` | **A blocked observation.** A second projectiond mount is stacked above and **frozen**, so the subject's probe cannot complete: the sample stops advancing, and past the hold readiness is false with `readyReason=mount-observation-stale` while `mounted` is still true and **zero** serve deaths have occurred |
| `MH5` | **The bootstrap grace is bounded and does not carry the run.** `mountBootstrapGrace` is observed **true** early and **false** later; readiness in the steady state rests on `mountObserved=live-projectiond`, not on the grace; and during `MH4`'s fault the grace is false, so it did not extend the fault |
| `MH6` | **A transient does not flap health.** A fault held for `ANTI_FLAP_TRANSIENT_MS`: a non-live observation is **actually reported** — asserted, or the arm proves nothing — and **every** `/readyz` reading through the transient is `ready` with `ok` |
| `MH7` | **A sustained fault becomes an unhealthy container.** While `MH2`'s overlay is held, `docker inspect` health goes `healthy` → `unhealthy` within `HEALTHCHECK_UNHEALTHY_BOUND_MS`, and returns to `healthy` after the overlay is removed |
| `MH8` | **Recovery requires the predeclared healthy condition.** Through `--auto-remount`, the **first** reading in which `ready` is true has `mountObserved=live-projectiond` **and** `mountLiveRunMs ≥ MOUNT_RECOVERY_CONFIRM_MS` **and** `mountBootstrapGrace=false`. Readiness does not return on a cleared serve death, and it is not granted by a grace a death forfeited |
| `MH9` | The **same pre-attached** unprivileged consumer reads the identical digest after recovery |
| `MH10` | `/healthz` answers **200** with `alive:true` and `claimsMountUsable:false` in **every** arm, including every arm in which `/readyz` answered 503, and carries no readiness or mount field |
| `MH11` | Both budgets, as measured worst cases across every arm: `/readyz` within `READYZ_LATENCY_BUDGET_MS` and `/healthz` within `LIVEZ_LATENCY_BUDGET_MS` |
| `MH12` | The host's container, network and volume **sets** are identical before and after, and this run's own mountpoints, overlays, blocker and directory are **asserted** gone rather than reported |

**Closure:** three consecutive fresh runs, exit 0, **zero skips**, on the real Unraid host, from one frozen
commit and one frozen image. A skip is a failure, as it is for every other gate here.

## 7. The regression matrix

**This changes readiness semantics and production bytes, so the gates whose subjects changed are re-run.**

| Gate | Why it is in scope | Runs |
|---|---|---|
| `go:stale-mount-gate:three` | Phase 2. Waits for `ready` at startup and again after a remount over a cold corpse — both paths the policy now governs | 3 |
| `go:serve-death-gate:three` | Phase 2. Its phase-B poller requires the **order** ready → not-ready → ready across a serve-loop death, which is exactly the transition Phase 5 redefines | 3 |
| `go:sustained-outage-gate:three` | Phase 2. Asserts `ready` is still true after a provider outage that never touches the mount — the case that must **not** change | 3 |
| `go:publisher-mount-gate` | publishes through a real mount with the changed image | 1 |
| `go:mount-truth-gate:three` | Phase 4. Its whole subject is the observation this tranche now reads | 3 |

**Phase 3 is NOT in scope, and the audit that says so is a fact about the file rather than an opinion.**
`deploy/projection-reliability-loop-gate.sh` defines `daemon_status()` — a `/readyz` reader — and **never
calls it**. Its recovery clock, `RL-R-ready-ms`, is a *sibling reading one byte through the mount*, chosen
deliberately over `/readyz`, and the gate says why in its own comment: *"`/readyz` answering ready is the
claim Phase 2 found to be insufficient."* Phase 5 changes no read path, no mount path and no supervisor code,
so nothing Phase 3 measures moved. `test/projection-operational-mount-health.ts` pins that finding, so it
stays true rather than staying written down.

**Expected affected offline regressions, predeclared before the first run:**

| What | Expected change |
|---|---|
| `PROJECTIOND_MOUNT_OBSERVATION.DOES_NOT_CHANGE` | `['ready','mounted']` → `['mounted']`, by the route Phase 4 §5 wrote down |
| `test/projection-mount-truth.ts` | its additive-rule pin narrows to `mounted` and gains an assertion that `ready` is the policy |
| `TestServeDeathMakesReadyFalseUntilCleared` | a cleared death alone no longer restores `ready`; a confirmed live observation does |
| `TestReadyzReportsServeDeathReason` | the same, at the HTTP layer |
| Phase 4's document | §3, §5 and §7 gain supersession notes; **no measured result is withdrawn** |

**No other suite is claimed to have been revalidated by compiling.** §9.3 records what was actually run.

## 8. Host and security posture

Exactly this task's own directories, containers, networks, volumes, ports and mounts. Ports are rechecked
before use. Every fault is guarded to this run's own container name, pid and mount point — the host serves its
array over shfs, which is also FUSE, so an unguarded abort would take the array offline. The gate fails closed
on uncertain PID or mount identity. `MH12` asserts the host's sets are identical rather than reporting them.

## 9. Run record

**CLOSED.** `npm run go:mount-health-gate:three` completed **three consecutive fresh runs, exit 0, zero
skips**, on the real Unraid host, from one frozen commit, tree and image: **36 arm verdicts, 36 pass, 0 fail,
0 skip**, twelve arms in every run.

| What | Value |
|---|---|
| frozen commit | `57b4a3646332fe7b1335da18d7c15d5807090b63` |
| frozen tree | `5eeaca7befff4e94ac7a91a981d49c0a1341c9fb` |
| tracked manifest | `4c7c44f619d81706` over **1,634** files, byte-identical in both directions vs `/mnt/user/appdata/catalog-p5` |
| image | `sha256:73996926dafa3078609b2ab9534032ff7032b30322fa9bcbac31643efdf82786` |
| host | Unraid `tower` |

**THE IMAGE DIGEST MOVED FROM PHASE 4'S, AND IT IS SUPPOSED TO HAVE.** This tranche changes `projectiond` —
the readiness policy, the liveness document, a new flag and a `HEALTHCHECK` — so a digest that had *not* moved
would mean the change was not in the image being tested. §9.1 is what stands in for the constancy that digest
used to provide.

| Run | Arms | Failed | Skipped | Elapsed |
|---|---|---|---|---|
| 1/3 | `MH1 … MH12` | **0** | **0** | 90,343 ms |
| 2/3 | `MH1 … MH12` | **0** | **0** | 90,194 ms |
| 3/3 | `MH1 … MH12` | **0** | **0** | 90,444 ms |

Each run printed `OPERATIONAL MOUNT HEALTH GATE PASSED: 12 of 12 arms`; the runner printed `RESULT: PASSED
three consecutive cold-start runs`. **No `FAIL`, `GATE FAILED` or `SKIP` line occurs anywhere in the
transcript**, and each arm id appears exactly three times as a pass.

### 9.1 Regression re-runs — DONE, from the same frozen commit, tree and image

Every gate below ran on the real Unraid host at commit `57b4a36`, against image
`sha256:73996926…`, with `PROJECTIOND_IMAGE=projectiond:phase5-frozen`, serialised one after another.

| Gate | Runs | Result |
|---|---|---|
| `go:stale-mount-gate:three` | 3 | **exit 0** — `RESULT: PASSED three consecutive cold-start runs`; PHASE 1, PHASE 2 and PHASE 3 COMPLETE in each, including the cold-corpse phase. 90,827 / 90,506 / 90,517 ms |
| `go:serve-death-gate:three` | 3 | **exit 0** — `RESULT: PASSED three consecutive cold-start runs`; PHASE A and PHASE B COMPLETE in each. 17,399 / 17,167 / 17,302 ms |
| `go:sustained-outage-gate:three` | 3 | **exit 0** — `RESULT: PASSED three consecutive cold-start runs`. 89,509 / 88,674 / 89,415 ms |
| `go:publisher-mount-gate` | 1 | **exit 0** — `publisher-to-mount gate PASSED` |
| `go:mount-truth-gate:three` | 3 | **exit 0** — `RESULT: PASSED three consecutive cold-start runs`; 18 arm verdicts, `MT1`–`MT6` three times each, 0 fail. 20,787 / 20,806 / 21,997 ms |

Zero `GATE FAILED`, zero skips, in any of them. Host before and after the whole sequence: **42 containers / 26
running, 17 networks, 45 volumes, 0 `fuse.projectiond`**.

**THE SERVE-DEATH GATE IS THE ONE THAT MATTERS MOST HERE, AND IT IS THE ONE MOST LIKELY TO HAVE BROKEN.** Its
phase-B poller requires an **order** — ready → not-ready → ready across a serve-loop death — and Phase 5
redefines both ends of that transition: readiness now goes false for a different reason and comes back only
after a confirmed post-death observation. It passed three times unchanged, which is what says the widened
not-ready window is still a window that closes.

**AND THE SUSTAINED-OUTAGE GATE IS THE CONTROL FOR THE WHOLE TRANCHE.** Its subject is a provider outage that
never touches the mount, and it asserts `ready` is **still true** afterwards. A readiness policy that had
become trigger-happy — one that keyed on the provider, or on any fault at all rather than on the mount —
would fail it. It passed three times, so the new policy is still deaf to everything except the mount.

### 9.2 What each arm measured

| Id | Measured, across all three runs |
|---|---|
| `MH1` | `200`/`ok`, `mountObserved=live-projectiond`, container `healthy`, and the pre-attached unprivileged consumer digest-matched the value recorded outside the mount |
| `MH2` | `503`/`mount-observed-not-live` with `mounted` still **true**, **zero** serve-loop deaths and the daemon still running; `mountSinceLiveMs` **7,546 / 7,600 / 6,501** against a 6,000 ms hold. Unmounting **only** the tmpfs restored `200`/`ok` |
| `MH3` | `503`/**`serve-loop-dead`** over a torn-down connection — the supervisor's knowledge outranking both the lagging observation and the `mounted` boolean it had already cleared |
| `MH4` | a **frozen** second projectiond mount aged the observation to **6,429 / 6,408 / 6,535 ms** while the verdict still read `live-projectiond`: `503`/`mount-observation-stale`, `mounted` true, **zero** serve deaths. Releasing the block restored `200`/`ok` |
| `MH5` | `mountBootstrapGrace` **true** early (**14,669 / 14,680 / 14,659 ms** remaining) and **false** later, with steady-state readiness resting on a live run of **16,009 / 15,988 / 16,097 ms** rather than on the grace |
| `MH6` | a two-second fault **was reported** as a non-live observation and readiness never left `200`/`ok` |
| `MH7` | container health `healthy` → **`unhealthy`** → `healthy` across the sustained fault, inside the 41,000 ms derived bound. Docker's own health log carried the closed-set code: `healthcheck: not ready: mount-observed-not-live` |
| `MH8` | readiness was observed to **drop**, and the **first** ready reading after the recovery carried `live-projectiond` with a confirmed live run of **1,116 / 1,032 / 1,337 ms** against a 1,000 ms confirmation, with the grace forfeited by the death |
| `MH9` | the **same pre-attached** unprivileged consumer read the **same digest** after the recovery |
| `MH10` | **25 / 25 / 23** liveness readings, every one `200`/`alive` with `claimsMountUsable=false` and no readiness or mount field — including every arm in which readiness answered `503` |
| `MH11` | slowest `/readyz` **214 / 210 / 212 ms** and slowest `/healthz` **192 / 195 / 228 ms**, both against 1,000 ms |
| `MH12` | container, network and volume **sets** identical; this run's mountpoints, overlays, blocker and directory asserted gone |

Host before and after the sequence: **42 containers / 26 running, 17 networks, 45 volumes, 0
`fuse.projectiond`**, 0 gate run directories, 0 leftover containers, and no `mh-overlay-` tmpfs or
`projection-mount-health-blocker-` container anywhere — the last two are the ones this tranche's own faults
could have leaked, and they are asserted rather than assumed.

### 9.3 Offline

Taken on the Windows development host at the frozen commit. **They are not gate evidence**; they are what
makes a run worth attempting.

| What | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run go:fmt` / `go:vet` / the whole Go suite | clean / clean / every package `ok` |
| `npx tsx test/projection-operational-mount-health.ts` | **29 passed, 0 failed, ZERO SKIPS** |
| `npx tsx test/projection-mount-truth.ts` | 13/0 — Phase 4's pins, with the additive rule narrowed to `mounted` |
| `npx tsx test/projection-mount-hardening.ts` | 32/0 |
| `npx tsx test/projection-reliability-loop.ts` | 69/0 — Phase 3 undisturbed |
| `npx tsx test/custody-runtime-closure.ts` | 39/0 |
| `npx tsx test/projection-evidence-consistency.ts` | 4/0 |
| `npx tsx test/aggregate-suite.ts` | exit 0 |
| full `npm test` | 346 selected, **336 passed, 10 failed** — see below |

**THE TEN FAILURES ARE PRE-EXISTING ON THIS HOST AND THAT IS VERIFIED, NOT ASSUMED.** They are the nine
`torbox-*` suites and `operator-ui-import-endpoint.ts`. Two facts establish it, and the second is the one that
actually settles it:

1. Neither failure names anything this tranche touched. `torbox-boundary` fails on
   `src/ops/projection-three-server-concurrency-cli.ts`, and `operator-ui-import-endpoint` fails on a literal
   control byte in `test/projection-multi-frontend.ts` — `git diff fe6fb88..57b4a36` touches neither file.
2. **All ten were re-run at the base commit `fe6fb88` in a clean throwaway worktree, and all ten failed
   there identically.** A failure that reproduces on the tree this tranche started from is not this tranche's.

They are recorded rather than waved past, and **no claim is made that they are fine** — only that they are not
Phase 5's, and that Phase 5 did not make them worse.

## 10. What this tranche does not claim

- **It closes only itself.** It re-closes none of G7–G13, G18 or G22, and it does not reopen, weaken or
  re-measure Phase 3.
- **A policy is not a recovery.** The daemon survives exactly what it survived before this tranche; what
  changes is what it says and when. No new failure is handled and none is claimed to be.
- **It reports; it does not act.** No restart policy changes, and Docker's restart policies do not react to
  health status at all. Wiring health to an action is a separate decision, named in §5.1 and not taken here.
- **It is not a monitoring product.** There is no alerting, no history, no trend and no threshold on any
  field beyond the ones §4 predeclares.
- **`mounted` still means what it meant.** It is still the remembered boolean, still never re-checked, and
  every gate closed in Phases 1–3 was measured against it. Only `ready` moved.
- **It is not a load test and no figure here is a performance claim.** Both latency budgets are upper bounds
  asserted against a broken mount, including a container start, not measurements of how fast an endpoint is.
- **One host.** Three green runs on a host that is not Linux or Unraid close nothing at all.
