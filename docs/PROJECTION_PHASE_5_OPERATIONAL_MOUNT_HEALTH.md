# Projection Phase 5 — the observation becomes operationally authoritative

**Status: NOT RUN.** Every threshold in §4 was committed before the first measured run. This document says
nothing about a Tower run until §9 records one.

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
| 2 | `not-mounted` | the daemon does not believe it is mounted | — | — |
| 3 | `serve-loop-dead` | the supervisor observed the serve loop exit | — | — |
| 4 | `mount-observed-not-live` | the last completed observation is `stale-projectiond`, `foreign` or `empty` | **never** | yes |
| 5 | `mount-observation-stale` | the last completed observation says live but is older than `SAMPLE_MAX_AGE_MS` | **never** | yes |
| 6 | `mount-observation-unavailable` | no observation has completed, or the sampler gave up on one | yes | yes |
| 7 | `mount-recovering` | live and fresh, but the live run is shorter than `MOUNT_RECOVERY_CONFIRM_MS` | yes | — |
| 8 | `ok` | everything above was checked and none of it fired | — | — |

**Rules 1–3 are the pre-existing readiness rules, unchanged in meaning, and they are deliberately ahead of
everything Phase 5 added.** A daemon with nothing to serve, one that never mounted, and one whose serve loop
the supervisor *watched* exit are not mount-observation questions. The supervisor's own knowledge is **direct
evidence**; the observation is a **late sample of the same event**. Reporting the sample first would name the
symptom and bury the cause.

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

**NOT RUN.** No measured Tower run has been taken at the time of writing.

| Run | Arms | Failed | Skipped | Elapsed |
|---|---|---|---|---|
| 1/3 | NOT RUN | — | — | — |
| 2/3 | NOT RUN | — | — | — |
| 3/3 | NOT RUN | — | — | — |

### 9.1 Regression re-runs

**NOT RUN.**

### 9.2 What each arm measured

**NOT RUN.**

### 9.3 Offline

**NOT RUN.**

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
