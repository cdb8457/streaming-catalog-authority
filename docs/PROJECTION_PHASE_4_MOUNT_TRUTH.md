# Projection Phase 4 — the daemon says what is at its mount point

**Status: PREDECLARED, NOT RUN.** Every threshold in §3 is committed here before the first measured run, and
this document is written before the daemon change it describes. §6 is the run record and it is empty.

**What this tranche is, in one sentence.** `/readyz` stops reporting what the daemon *remembers* about its
mount and starts reporting what is *observed* at it — as an additional field, next to the belief, never
instead of it.

**What it is not.** It is not a recovery improvement, it closes no G-number, it re-opens nothing, and adding
a field is not a claim that the daemon survives anything it did not survive yesterday. §7 is the full list.

---

## 1. The gap, and it is the one this product keeps falling into

`status.mounted` is `d.mounted.Load()` — an in-process boolean set once by `SetMounted` when the daemon
believes it has mounted (`projectiond/internal/daemon/daemon.go`). `ready` is that boolean AND the absence of
an *observed* serve death. **Neither is ever compared against what is actually at the mount point.**

Both of the worst failures in this product's recorded history presented as a healthy daemon:

| What happened | What `/readyz` said |
|---|---|
| Phase 2's `--auto-remount` defect: the supervisor removed the operator's bind and remounted into a namespace with no host peer | **ready** — and all three media servers read nothing |
| The cold corpse of `PROJECTIOND_MOUNT_TARGET`: every remount refused `ENOTCONN` while the process was alive | **ready**, until the supervisor happened to record the serve death |

Phase 3 proved the recovery path works with three real consumers attached. **This is the other half: making
the daemon able to say when it has not recovered.** An operator's health check, a container restart policy
and a monitoring rule all key off this endpoint, and today it cannot distinguish a live mount from a
remembered one.

## 2. Why the observation cannot be taken on the request path

`fusefs.ProbeMountpoint` already answers the question and is already pinned by Go tests. It decides with
`statfs`, and **statfs is the transport check precisely because it reaches the connection** — a live mount
answers it out of the daemon's own serve loop. Its own comment says so, and names the consequence: *"Only a
hung-but-connected mount could block statfs... proving that state dead requires a timeout, and this probe
never waits."*

So a `/readyz` that probed inline would block for exactly as long as the thing it exists to report on is
broken. **A hung health endpoint is a worse answer than a stale one**, because an orchestrator reads a
timeout as "unknown" and a stale sample as data. The probe therefore runs on its own cadence and the endpoint
answers from the last sample that completed.

**AND A BLOCKED PROBE IS NOT CANCELLABLE, WHICH IS WHAT SINGLE-FLIGHT IS FOR.** `syscall.Statfs` cannot be
interrupted; a probe against a wedged connection returns when the connection is torn down and not before. The
timeout bounds **how long the sampler waits**, not how long the syscall runs, and only one probe is ever
outstanding — otherwise a wedged mount would accumulate one stuck goroutine per interval for as long as it
stayed wedged. A probe that overruns leaves the previous sample in place and lets it age, so **a probe that
cannot answer manifests as a stale sample rather than as a hung endpoint.** That is why the age is published
beside the verdict and is worthless without it.

## 3. The predeclared thresholds

Every one of these is in `PROJECTIOND_MOUNT_OBSERVATION` in `src/core/projection/runtime-contract.ts`, and
this document restates none of them from memory — `test/projection-mount-truth.ts` fails if the two disagree.

| Name | Value | Where it comes from |
|---|---|---|
| `SAMPLE_INTERVAL_MS` | **1,000** | **CHOSEN, both bounds named.** *Below:* one statfs a second against a live mount is one extra FUSE operation per second, noise beside a single scan — and a health signal lagging its subject by more than about a second is not actionable. *Above:* it must stay well under the freshness ceiling, or a healthy daemon's sample would routinely present as stale and the freshness assertion would be measuring the sampler's cadence instead of the mount |
| `PROBE_TIMEOUT_MS` | **2,000** | **CHOSEN, both bounds named.** *Below:* a statfs against a healthy mount is a map read in the daemon's own process, well under a millisecond, so any bound in the hundreds already separates answering from not answering. *Above:* it is what the endpoint's latency budget must beat, and a bound approaching `READ_DEADLINE_MS` would let a wedged mount look merely slow for twenty seconds |
| `SAMPLE_MAX_AGE_MS` | **3,000** | **DERIVED:** `SAMPLE_INTERVAL_MS` + `PROBE_TIMEOUT_MS`. A full interval may elapse before a probe starts and that probe may take its whole timeout |
| `READYZ_LATENCY_BUDGET_MS` | **1,000** | **CHOSEN**, and the number matters far less than the property asserted beside it: it is **strictly under `PROBE_TIMEOUT_MS`**, so a handler that had waited for a probe could not pass it. `READYZ_CANNOT_HAVE_WAITED_FOR_A_PROBE` is that check as code, in the shape `ROTATION_REFUSAL_BELOW_BREAKER` already uses |
| `STATES` | `live-projectiond`, `stale-projectiond`, `empty`, `foreign`, `timeout`, `unchecked` | the first four are `fusefs.ProbeResult`'s own states unchanged; the last two are states a **sampler** has and a probe does not |
| `SINGLE_FLIGHT` | **true** | §2. It is what bounds a wedged mount |
| `DOES_NOT_CHANGE` | `ready`, `mounted` | the additive rule, as code |

**No existing threshold is touched by this tranche**, and `test/projection-mount-truth.ts` pins that
directly: `ready` and `mounted` keep the meanings every closed gate was measured against.

## 4. The gate

`deploy/projection-mount-truth-gate.sh`, with `-three` and `-optional` wrappers, run as
`npm run go:mount-truth-gate`.

**Provider-free by construction.** No provider, no endpoint, no credential, no operator corpus, no media
server — the daemon's configuration names no endpoint at all, so there is nothing it could contact. That is
deliberate: this tranche must not be blocked by, and must not spend, the operator's metered account.

**ONE daemon, ONE mount, ONE unprivileged consumer** bound to the mount point `rslave` **before anything is
ever mounted there**, per §11 of the Phase 0 product contract. The consumer reads **bytes**, not metadata: a
dead FUSE mount answers `stat` from a warm attribute cache while every `open` returns `ENOTCONN`, so a
`test -f` here would pass over the exact state this gate exists to detect.

| Id | What it holds |
|---|---|
| `MT1` | **The control.** Daemon serving, consumer reads real bytes: `mountObserved` is `live-projectiond`, `mounted` is true, and the two AGREE. Without this arm every arm below is satisfied by a daemon that always answers "not live" |
| `MT2` | **The divergence, and it is the measurement.** The connection is aborted under the living daemon: `mountObserved` becomes `stale-projectiond` while `mounted` is still true |
| `MT3` | `/readyz` answers within `READYZ_LATENCY_BUDGET_MS` in **every** arm, including `MT2`. A measured latency, not an absence of complaints |
| `MT4` | After `--auto-remount` recovers, `mountObserved` returns to `live-projectiond` and the **pre-attached** consumer reads the same digest again |
| `MT5` | The sample's age never exceeds `SAMPLE_MAX_AGE_MS` while the daemon is healthy, so a stale observation cannot be read as a current one |
| `MT6` | The host's container, network and volume **sets** are identical before and after, and this run's own mountpoints and directory are **asserted** gone rather than reported |

**Closure:** three consecutive fresh runs, exit 0, **zero skips**, on the real Unraid host, from one frozen
commit. A skip is a failure, as it is for every other gate here.

## 5. What is changed, and how the blast radius is bounded

**Additive only.** A new read-only field on the status document and a sampler that fills it. `ready` and
`mounted` are untouched, so **no Phase 1, Phase 2 or Phase 3 evidence can regress and no closed gate can
start failing** — which is the property that makes this the smallest coherent tranche rather than a
re-litigation of `/readyz`.

**The `daemon` package stays portable.** The observer is injected as a function rather than imported, so
nothing linux-only enters that package and the sampler is testable deterministically, without a real FUSE
mount, by a Go unit test that drives it with a fake observer. The linux wiring lives where the rest of it
already does.

**Folding the observation into `ready` is explicitly NOT in this tranche.** It is a behaviour change to an
endpoint three closed phases were measured against, and it is deferred, named here so it is a decision
somebody takes rather than a thing that drifts in.

**This edits `projectiond`, so the affected Phase 2 gates are re-run as part of the tranche:**
`go:stale-mount-gate:three`, `go:serve-death-gate:three`, `go:publisher-mount-gate`. All provider-free. The
image digest is the check that nothing else moved.

## 6. Run record

**NOT RUN.**

| Run | Host | Arms | Failed | Skipped | Evidence |
|---|---|---|---|---|---|
| 1/3 | — | — | — | — | NOT RUN |
| 2/3 | — | — | — | — | NOT RUN |
| 3/3 | — | — | — | — | NOT RUN |

### 6.1 Offline

**NOT TAKEN.**

## 7. What this tranche does not claim

- **It closes only itself.** It re-closes none of G7–G13, G18 or G22, and it does not reopen, weaken or
  re-measure Phase 3.
- **A field is not a recovery.** The daemon survives exactly what it survived before this tranche; what
  changes is what it can say. No new failure is handled and none is claimed to be.
- **It is not a monitoring product.** There is no alerting, no history, no threshold on the field itself —
  one sample, its age, and the states a probe can return.
- **`ready` still means what it meant.** An operator keying on `ready` sees no change, which is the point.
- **It is not a load test and no figure here is a performance claim.** The latency budget is an upper bound
  asserted against a wedged mount, not a measurement of how fast the endpoint is.
- **One host.** Three green runs on a host that is not Linux or Unraid close nothing at all.
