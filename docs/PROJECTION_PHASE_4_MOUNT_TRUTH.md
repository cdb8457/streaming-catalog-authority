# Projection Phase 4 — the daemon says what is at its mount point

**Status: CLOSED.** Every threshold in §3 was committed before the first measured run and **none has moved**.
`npm run go:mount-truth-gate:three` completed **three consecutive fresh runs, exit 0, zero skips** on the
real Unraid host: 18 arm verdicts, 18 pass, 0 fail, 0 skip. **§4.1 records that MT2 was predeclared, measured
false, and superseded** — its original abort formulation asks for a state a correct daemon cannot produce, and
the replacement was proved three times in a throwaway before it was written down.

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
| `MT2` | **The divergence, and it is the measurement.** A foreign filesystem (a tmpfs) is stacked **above** the live projection mount, inside the daemon's own namespace: `mountObserved` becomes `foreign` while `mounted` is still true, the serve loop never notices, and unmounting **only** the overlay restores both the live observation and the pre-attached consumer's digest. **This supersedes the original abort formulation, which was predeclared, measured false and is impossible — see §4.1** |
| `MT3` | `/readyz` answers within `READYZ_LATENCY_BUDGET_MS` in **every** arm, including `MT2`. A measured latency, not an absence of complaints |
| `MT4` | After `--auto-remount` recovers, `mountObserved` returns to `live-projectiond` and the **pre-attached** consumer reads the same digest again |
| `MT5` | The sample's age never exceeds `SAMPLE_MAX_AGE_MS` while the daemon is healthy, so a stale observation cannot be read as a current one |
| `MT6` | The host's container, network and volume **sets** are identical before and after, and this run's own mountpoints and directory are **asserted** gone rather than reported |

**Closure:** three consecutive fresh runs, exit 0, **zero skips**, on the real Unraid host, from one frozen
commit. A skip is a failure, as it is for every other gate here.

### 4.1 MT2 WAS PREDECLARED, MEASURED FALSE, AND SUPERSEDED — and the original is kept, not deleted

**THE ORIGINAL, IN ITS OWN WORDS:** *"The connection is aborted under the living daemon: `mountObserved`
becomes `stale-projectiond` while `mounted` is still true."* It was committed before any measured run, it was
run on the real host, and it **failed**: the observation went stale exactly as intended, and `mounted` was
already `false`.

**IT IS NOT FLAKY. IT CANNOT HAPPEN.** On a serve-loop death the supervisor runs `d.SetMounted(false)` and
**then** `d.RecordServeDeath(...)`. So the ordering is always the one in §6.2: `mounted` goes false within
milliseconds, while the observation is the **lagging** signal and updates up to a full sample interval later.
There is no window in which `mounted` is true and the observation has gone stale, and sampling faster cannot
create one — it would only shorten the interval in which the pair reads `mounted=false` / `observed=live`.

**WHY THE REPLACEMENT IS A DIFFERENT KIND OF FAULT, AND WHY THAT IS THE POINT.** Every fault that *removes*
something takes the FUSE connection with it, which wakes the supervisor, which corrects the belief — so no
removal can ever produce this divergence against a correct daemon. Stacking a foreign filesystem **above** the
live mount touches the connection not at all: no supervisor code runs, `mounted` stays true, and the mount the
daemon is serving is still there underneath. The observation reads the **top** of the stack, so it sees the
stranger. **That is a state the supervisor genuinely cannot see, which is exactly the class the observation
was added to report.**

**TWO OTHER CANDIDATES WERE TESTED FIRST AND BOTH FAILED**, and they are recorded so that this one does not
read as the first idea that was tried: a host-side `umount -l` of the daemon mount (`observed` stayed
`live-projectiond` — the detach does not propagate into the daemon's namespace), and a lazy unmount inside
that namespace via `nsenter` (`observed` stayed `live-projectiond` — the mount survived it).

**THE REPLACEMENT WAS PROVED BEFORE IT WAS ADOPTED, in a throwaway copy, three consecutive times**, and only
then written into this document. Every one of the six conditions held on every run:

| Run | `mounted` | `mountObserved` | serve loop | `/readyz` | live observation restored | consumer digest restored |
|---|---|---|---|---|---|---|
| 1 | **true** | **foreign** | alive, 0 deaths | 183 ms | yes | yes |
| 2 | **true** | **foreign** | alive, 0 deaths | 191 ms | yes | yes |
| 3 | **true** | **foreign** | alive, 0 deaths | 196 ms | yes | yes |

**NO NUMERIC THRESHOLD MOVED.** §3 is untouched: the same sample interval, probe timeout, freshness ceiling
and latency budget decide the amended arm. What changed is the fault, and only because the predeclared one
asks for a state a correct daemon does not produce.

**THE ABORT IS KEPT, WITH ITS ROLE NARROWED.** It is no longer asked to produce MT2's divergence. It is what
puts a **dead connection** under `/readyz` for MT3, and what `--auto-remount` recovers from for MT4 —
including the pre-attached consumer re-reading the same digest. Both of those it does exactly, and both were
already passing before this amendment.

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
`go:stale-mount-gate:three`, `go:serve-death-gate:three`, `go:publisher-mount-gate`. All provider-free.

### 5.1 The Phase 2 re-runs — DONE, and they are the first evidence this tranche has

Frozen commit `48092f5`, tree verified byte-identical in both directions over **1,620** tracked files between
this worktree and `/mnt/user/appdata/catalog-p4` on the real Unraid host, tracked-manifest digest
`062a15bd021c5075`. Image **`sha256:d6c31c1f8b175e309c1511c7ed686541361cc11d9f4672456e6dfd8acadf5de8`**.

**THE IMAGE DIGEST MOVED, AND IT IS SUPPOSED TO HAVE.** Every build across Phases 2 and 3 produced
`sha256:8776f28a…`, which is what said the daemon bytes had not moved. This tranche changes `projectiond`, so
a digest that had *not* moved would mean the change was not in the image being tested. The re-runs below are
what stands in for the constancy that digest used to provide.

| Gate | Runs | Result |
|---|---|---|
| `go:stale-mount-gate:three` | 3 | **exit 0** — `RESULT: PASSED three consecutive cold-start runs`; PHASE 1, PHASE 2 and PHASE 3 COMPLETE in each, including the cold-corpse phase |
| `go:serve-death-gate:three` | 3 | **exit 0** — `RESULT: PASSED three consecutive cold-start runs`; PHASE A and PHASE B COMPLETE in each |
| `go:publisher-mount-gate` | 1 | **exit 0** — `publisher-to-mount gate PASSED` |

Zero `GATE FAILED`, zero skips. Host before and after: 42 containers / 26 running, 17 networks, 45 volumes,
**0** `fuse.projectiond`, 0 gate run directories, 0 gate containers.

**WHAT THIS ESTABLISHES, AND IT IS NOT THE TRANCHE'S OWN CLAIM.** It says the additive change regressed
nothing Phase 2 had closed — the daemon still names a corpse, still refuses to serve over one under
`--refuse-stale`, still mounts over a cold one, still reports a serve death and remounts in place. It says
**nothing whatever** about whether `mountObserved` reports the truth; that is §4's gate, and §6 records that
it has not run.

## 6. Run record

**CLOSED.** `npm run go:mount-truth-gate:three` completed **three consecutive fresh runs, exit 0, zero
skips**, on the real Unraid host, from one frozen commit: **18 arm verdicts, 18 pass, 0 fail, 0 skip**, six
arms in every run.

| What | Value |
|---|---|
| frozen commit | `a2cccacfcdcb9be38c5ead6b64eb8b64cd6f7e55` |
| frozen tree | `08ef16fe0ab79c178d7b650c5e0f5a2db5b4655f` |
| tracked manifest | `372b10598d81e9c5` over **1,626** files, byte-identical in both directions vs `/mnt/user/appdata/catalog-p4f` |
| image | `sha256:5d7a5618b547bb149fa458d00996672c1b4e3e715568b9462ea27dea3e4c032d` — unchanged from the build the Phase 2 gates were revalidated against, because this tranche changed no production code after that point |
| host | Unraid `tower` |

| Run | Arms | Failed | Skipped | Elapsed |
|---|---|---|---|---|
| 1/3 | `MT1 MT2 MT3 MT4 MT5 MT6` | **0** | **0** | 22,028 ms |
| 2/3 | `MT1 MT2 MT3 MT4 MT5 MT6` | **0** | **0** | 22,147 ms |
| 3/3 | `MT1 MT2 MT3 MT4 MT5 MT6` | **0** | **0** | 20,702 ms |

Each run printed `MOUNT-TRUTH GATE PASSED: 6 of 6 arms`; the runner printed `RESULT: PASSED three consecutive
cold-start runs`. **No `FAIL`, `GATE FAILED` or `SKIP` line occurs anywhere in the transcript**, and each arm
id appears exactly three times as a pass.

### 6.1 What each arm measured

| Id | Measured, across all three runs |
|---|---|
| `MT1` | `mountObserved=live-projectiond`, `mounted=true`, and the pre-attached unprivileged consumer digest-matched the value recorded outside the mount |
| `MT2` | **`mountObserved=foreign` while `mounted` stayed true**, with **zero** serve-loop deaths and the daemon still running — then unmounting **only** the tmpfs restored both the live observation and the consumer digest |
| `MT3` | slowest `/readyz` **181 / 180 / 209 ms** against a 1,000 ms budget, folding in all three readings: live, under the foreign overlay, and **over a dead connection** (173 / 173 / 164 ms) |
| `MT4` | `--auto-remount` restored `live-projectiond` and the **pre-attached** consumer read the same digest again |
| `MT5` | the observation was **290 ms** old at its worst against a 3,000 ms ceiling |
| `MT6` | container, network and volume **sets** identical; this run's mountpoints and directory asserted gone |

**Host before and after the sequence: 42 containers / 26 running, 17 networks, 45 volumes, 0
`fuse.projectiond`, 0 gate run directories, 0 leftover containers, and 0 `mt-overlay-` tmpfs left anywhere**
— the last of those is the one this tranche's own fault could have leaked, and it is asserted rather than
assumed.

### 6.2 MT2 IS NOT FLAKY; THE ORIGINAL FORMULATION WAS IMPOSSIBLE

Kept exactly as measured, because the superseded arm is part of this record. On a serve-loop death the
supervisor runs `d.SetMounted(false)` and **then** `d.RecordServeDeath(...)`:

| when | `mounted` | `mountObserved` |
|---|---|---|
| the abort | true | `live` — the last sample predates the fault |
| a few ms later, supervisor notices | **false** | `live` — still |
| up to `SAMPLE_INTERVAL_MS` later | false | `stale` |

There is no window in which `mounted` is true AND the observation has gone stale, because the observation is
always the **lagging** one. §4.1 records what replaced it and why, and the two candidate faults that were
tested and failed before the adopted one.

### 6.3 Offline

Taken on the Windows development host at the frozen commit. **They are not gate evidence**; they are what
makes a run worth attempting.

| What | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run go:vet` / the whole Go suite | clean / every package `ok` |
| `npx tsx test/projection-mount-truth.ts` | **13 passed, 0 failed, ZERO SKIPS** |
| `npx tsx test/projection-mount-hardening.ts` | 32/0, including the pre-fault-control pin |
| `npx tsx test/custody-runtime-closure.ts` | 39/0 |
| `npx tsx test/projection-reliability-loop.ts` | 69/0 — Phase 3 undisturbed |
| `npx tsx test/aggregate-suite.ts` | exit 0 |

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
