# Projection Phase 2 — mount hardening

**What Phase 2 is.** Three failure modes of the daemon's own mount lifecycle, each with a gate, and each
closed only by three consecutive fresh runs on a host that can host it. Serve-loop death is a mount taken
out from under a **living** process. A stale mountpoint is the corpse a **dead** process left behind. A
sustained outage is a provider that keeps failing past the circuit breaker's budget. All three gates run
the production image and no media server: the namespace is a single local entry, and the whole experiment
is the daemon's own mount lifecycle and its transport behaviour.

**What "passing" means.** Each gate holds on **three consecutive fresh runs** via its `:three` wrapper, on
a host with `/dev/fuse` reachable from a container. One green run is a coincidence. A host that cannot host
a gate is a **skip (77)**, and for the evidence command a skip is a **failure**: the `:three` wrapper counts
it as one, and only the `:optional` entry point — which a caller has to choose deliberately — folds 77 to 0,
saying "NOTHING WAS PROVED" when it does.

**The budgets are code.** `readDeadlineMs`, the breaker numbers (`5 failures / 30s window / 60s cooldown /
1 half-open probe`), the probe window size and the probe plan all live in the product or in the gate and are
measured, not restated here.

---

## 1. Gate 1 — `go:serve-death-gate`

**Files:** `deploy/projection-serve-death-gate.sh`, `-three.sh`, `-optional.sh`;
`docker-compose.projection-serve-death.yml`.

**What it proves.** A FUSE mount is a conversation between the kernel and a process, and most of the ways it
stops are on the daemon's side — unmount requested, SIGKILL, crash. Serve-death is the remaining way: the
**mountpoint** is taken out from under a process that is still alive. The kernel aborts the connection, the
serve loop reads an error, and the process is left alive with no namespace to serve. The gate causes that
death the only honest way — an **external `umount` through a shared mount** from a sibling container, the
same propagation path the daemon's own mount travelled — and proves both halves of the daemon's answer in
one run, over the same mountpoint and the same generation:

| Phase | The daemon is asked to prove | What the gate measures |
|---|---|---|
| **A** — no `--auto-remount` | a serve death is distinguished from a requested unmount, reported as a death, and the process **exits 3** rather than parking on `Wait()` | `/readyz` ready before; live read digest verified; external unmount kills the serve loop; exit status **3**; log says `serve loop died`; the status surface is then unreachable |
| **B** — `--auto-remount` | the same death is observed, and the namespace **comes back in place** | the readyz poller sees a not-ready window; `/readyz` returns ready; the process never exits; the entry's **inode, size and mtime are unchanged** across the remount; the log says both `serve loop died` and `remounted; serving generation 1` |

**Why both halves in one run.** A gate that proved one half would let the other rot. A daemon that always
exited 0 on a serve death would be invisible to G7-G9 (which prove the mount survives a **process** death)
and fail this gate.

### Run record

| Run | Host | Assertions | Failed | Skipped | Evidence |
|---|---|---|---|---|---|
| 1/3 | — | — | — | — | — |
| 2/3 | — | — | — | — | — |
| 3/3 | — | — | — | — | — |

> **NOT RUN.** Filled at tranche close on the real Unraid host, `npm run go:serve-death-gate:three`.

---

## 2. Gate 2 — `go:stale-mount-gate`

**Files:** `deploy/projection-stale-mount-gate.sh`, `-three.sh`, `-optional.sh`;
`docker-compose.projection-stale-mount.yml`.

**What it proves.** A FUSE mount keeps its place in the namespace after the conversation is over. A daemon
that dies **without unmounting** leaves a corpse: mountinfo still shows `fuse.projectiond`, but every
`statfs` answers `ENOTCONN`. The gate makes the corpse with the production image — mount with `:rshared`
propagation, **SIGKILL the daemon without letting it unmount** — verifies the corpse is actually stale from
a sibling container (via `statfs`, which FUSE never caches, so a dead connection answers `ENOTCONN`
immediately), and then proves the daemon's startup probe handles exactly this object:

| Phase | The daemon is asked to prove | What the gate measures |
|---|---|---|
| **default** | the probe **names** the corpse (`stale projectiond mount detected`) and says what it is doing (`stacking over the stale mount (default); clear it with: umount -l`), stacks over it, and serves generation 1 | verified through `/readyz` and through the mount, with the same entry identity the corpse carried; a SIGTERM then unmounts the recovery mount cleanly, leaving the corpse for phase 2 |
| **`--refuse-stale`** | the probe faces the **same** corpse and refuses to serve over it | it logs `refusing to start: stale mount at /mnt/projection` and **exits 1**, because serving a namespace whose transport is gone is exactly the state that must not be inherited silently |

**Why the corpse is the subject.** Both halves are one probe, and a probe is only as good as the corpse it
is exercised against. G7-G9 prove the mount **survives** a process death (the new process stacks over the
corpse and keeps serving); this gate's subject is the corpse itself at **startup**, where the probe decides
the stack lands on something it should name rather than something it should guess about.

### Run record

| Run | Host | Assertions | Failed | Skipped | Evidence |
|---|---|---|---|---|---|
| 1/3 | — | — | — | — | — |
| 2/3 | — | — | — | — | — |
| 3/3 | — | — | — | — | — |

> **NOT RUN.** Filled at tranche close on the real Unraid host, `npm run go:stale-mount-gate:three`.

---

## 3. Gate 3 — `go:sustained-outage-gate`

**Files:** `deploy/projection-sustained-outage-gate.sh`, `-three.sh`, `-optional.sh`;
`docker-compose.projection-sustained-outage.yml`.

**What it proves.** A provider outage is not a single failed request; it is every request, for a while. G26
already covers short-lived faults — one bad response, refreshed and retried. This gate covers what the
circuit breaker exists for: an endpoint that is **still down after five counted failures**, where refusing
further requests locally is strictly better than sending them somewhere that is not answering. The outage is
staged the way an outage actually happens:

1. **TRIP** — the endpoint answers every ranged request with **503** for a moment. A 503 is
   `CondSourceUnreachable`, which **is** counted toward the breaker (`CountsTowardEndpointBreaker`,
   `internal/source/source.go:121`), and readpath retries each read up to three times, so a handful of reads
   records five counted failures inside the 30s window and the breaker opens (`NewBreaker(5, 30s, 60s, 1)`,
   `internal/daemon/daemon.go:184`).
2. **HOLD** — the object is held down for the rest of the outage. With the breaker open every further read is
   refused locally in microseconds, before any packet could leave the host, so **zero provider traffic during
   the hold** is measured rather than hoped for.
3. **RELEASE** — after the 60s cooldown has elapsed, the object is released and the first read is admitted as
   the **half-open probe**. It must succeed: that is the breaker closing on real evidence.

**Why nothing reads during the cooldown.** A half-open probe that arrives while the hold is still armed would
block until the read deadline and fail with the **uncounted** `CondReadDeadline`, leaving the breaker stuck
half-open. The gate holds through the whole cooldown, releases only after it has elapsed, and only then reads.

**What the gate asserts.** Reads fail within a bounded deadline (`readDeadlineMs`, with a ceiling the gate
derives from the read-path budgets); the namespace does not churn (list/stat still answer from the snapshot,
no entries vanish, no new generation is published during the outage); the endpoint sees **zero** provider
traffic during the hold; and the first read after release succeeds. **No daemon change** — like G24-G26, the
product behaviour exists; the evidence is what was missing.

### Run record

| Run | Host | Assertions | Failed | Skipped | Evidence |
|---|---|---|---|---|---|
| 1/3 | — | — | — | — | — |
| 2/3 | — | — | — | — | — |
| 3/3 | — | — | — | — | — |

> **NOT RUN.** Filled at tranche close on the real Unraid host, `npm run go:sustained-outage-gate:three`.

---

## 4. The stacking-vs-refusal design note

A stale mountpoint at the daemon's target admits exactly two answers, and the daemon's default and its flag
are the two halves of one decision.

- **Stacking (default) is load-bearing.** G7-G9's SIGKILL/restart/remount recovery mounts fresh over the
  corpse, and Phase 1 evidence depends on that path. Refusing by default would have broken it.
- **Refusal (`--refuse-stale`) is the honest alternative.** When an operator would rather stop than inherit a
  namespace whose transport is gone, the probe gives them a refusal that **names the mountpoint and how to
  clear it** (`umount -l`) — the same fail-fast philosophy as a generation that cannot be admitted.
- **A live mount is never refused.** A hung-but-connected mount is treated as live: it cannot be proved dead
  without a timeout, and refusing it would refuse a healthy daemon. The probe is bounded syscalls only.

The gates exercise both halves against the **same corpse** — made by the production image, verified stale
from a sibling container before either phase runs — so the flag's refusal and the default's stacking are
proved against the same object.

---

## 5. Non-overlap with Phase 1

| Phase 1 already covers | Phase 2 does NOT re-test |
|---|---|
| Graceful SIGTERM shutdown | every data-plane gate's `docker stop -t 30` tail + the runtime-image smoke test |
| SIGKILL/restart/remount recovery, byte-for-byte post-remount reads | **G7-G9** — the process died and the namespace came back with it. Serve-death leaves the process **alive** and proves the serve loop's death is distinguished from a requested unmount; stale-mount faces the **corpse** at startup. A daemon that always exited 0 on a serve death would pass G7-G9 and fail the serve-death gate |
| Short-lived faults — one bad response, refreshed and retried | **G26** — sustained-outage is the breaker: an endpoint that is STILL down after five counted failures, zero provider traffic while it is down, and a half-open probe that must succeed |
| Harness-level stale-mount cleanup | `deploy/projection-gate-cleanup.sh` — the gates clean up through the shared helper; they do not restate it |
| All 27+ Phase 1 gates (G1-G27) | untouched |

Every G-number a Phase 2 gate mentions is in an explicit "WHY IT IS NOT" / "already covers" frame, pinned
by `test/projection-mount-hardening.ts`.

---

## 6. Evidence commands

| Evidence | Command | Skip behaviour |
|---|---|---|
| serve-death, three consecutive fresh runs | `npm run go:serve-death-gate:three` | 77 → **failure** for the runner |
| stale-mount, three consecutive fresh runs | `npm run go:stale-mount-gate:three` | 77 → **failure** for the runner |
| sustained-outage, three consecutive fresh runs | `npm run go:sustained-outage-gate:three` | 77 → **failure** for the runner |
| any one gate, single run | `npm run go:<gate>-gate` | 77 propagates |
| any one gate, on a host where it is optional | `npm run go:<gate>-gate:optional` | 77 → 0, **NOTHING WAS PROVED** |

The offline pins for all of the above live in `test/projection-mount-hardening.ts`: the ship set exists, the
scripts are wired, every heredoc is quoted, the skip contract is 77-and-never-0, the `:three` wrappers
refuse a live prior gate **before** touching its run directory, and cleanup happens through the shared helper
on every exit path. It runs everywhere in seconds; the gates themselves need the host.
