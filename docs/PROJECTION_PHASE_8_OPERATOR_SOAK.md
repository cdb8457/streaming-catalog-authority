# Projection Phase 8 — the operator soak

**Status: OPEN — §2 to §10 are the contract and every one of them was written and committed BEFORE the first
measured run. §11 is the run record and §12 is the decision.** No threshold in §4 may move after the first
measured run; a clause that measures FALSE is recorded as **superseded**, with what it said kept whole, exactly
as Phase 4 §4.1, Phase 5 §3.3 and Phase 7 §8.4.4 did — never edited into agreement with a result.

**What Phase 8 is, in one sentence.** Phase 7 proved the appliance survives **six deliberate faults** with three
real media servers attached; Phase 8 asks whether it survives **being used**, over and over, by an operator who
does nothing unusual.

**Why that is a tranche and not a paragraph in Phase 7.** Every Phase 7 run is a **fresh** run — a new database,
a new manifest, a new cache, new media-server configuration directories, a mount point that has never been
mounted. §5 of that contract says so and gives the reason: *"the question is whether the appliance survives a
fault from a clean start."* **That deliberately does not ask the other question.** An operator does not get a
fresh start; they get the same cache, the same ledger, the same libraries and the same mount point, day after
day, and they run `stop` and `start` and `upgrade` and `rollback` on it. Phase 7's own §12.4 ships **five rough
edges**, and three of them — a killed daemon's mount, a stop under a foreign overlay, a rollback that needs the
cache — are things an operator meets by **repetition** rather than by injection.

**What it is not.** It is not a beta, not a release, not a marketplace package, not a second host, not a second
provider, not a load test and not a claim about uptime. §10 is the full list and it is longer than §12.

---

## 1. What Phase 7 left, exactly

| What Phase 7 closed | What it left open, in its own words |
|---|---|
| six deliberate mount faults survived, three times, with three real media servers attached and playing | §5 — every run is **fresh**, by design. Nothing has ever been asked to run twice against the **same** cache, ledger, libraries and mount point |
| the mount-layer count held at 1 across eighteen arm readings | §12.4 #1 and #2 — a **killed** daemon still leaves its mount, and a stop under a foreign overlay leaves ours. Both are states an operator reaches by repetition |
| `upgrade` records a rollback target before it changes anything, and `rollback` honours it | §8.3 — the target lives in the cache, so an operator who loses the cache loses the rollback. **Decided and left**, with an instruction that pays for it |
| the recovery ledger is durable and survives a restart | nothing has asked whether it is still true after **ten** ordinary stop/start cycles, or whether a `reset-recovery` between them is still honest |
| the operator command is idempotent | Phase 6 `AA1`–`AA11` prove that **once**, against a fresh install, with **one unprivileged consumer** and **no provider** |

**PHASE 8 TAKES THE FIRST FOUR AND MEASURES THEM UNDER REPETITION. IT FIXES NONE OF PHASE 7'S ROUGH EDGES BY
CONTRACT** — if a cycle exposes one as worse than §12.4 described, that is a finding and §11 records it.

## 2. The topology, and it is Phase 7's with one thing removed and nothing added

**ONE** PostgreSQL, **ONE** publisher, **ONE** production `projectiond`, **ONE** FUSE mount, **ONE**
loopback-only TorBox resolver in the daemon's network namespace, and **THREE** real, digest-pinned media
servers — Plex, Jellyfin and Emby — each holding the **same** mount directory as the **same** Movies library
root.

**WHAT IS REMOVED IS THE FRESHNESS, AND IT IS THE WHOLE EXPERIMENT.** After the first cycle, **nothing is
recreated**: the same PostgreSQL, the same manifest directory, the same probe cache, the same three media-server
configuration directories, the same three containers, the same binds, and a mount point that has been mounted
before. A cycle that recreated any of them would be a Phase 7 run wearing a different name.

**THE THREE MEDIA SERVERS ARE STARTED ONCE, BEFORE THE FIRST MOUNT, AND ARE NEVER RESTARTED, RE-BOUND OR
RE-CREATED FOR THE WHOLE SOAK.** That is Phase 0 §11's attachment contract applied across cycles instead of
within one, and `P8-consumers-never-touched` is the assertion. **It is the single most important row in this
document**, because every claim below is about what an operator's own servers can still see.

**EVERYTHING ELSE IS IMPORTED.** The drivers, the resolver, the operator command, the fault injectors, the
cleanup contract and every budget come from Phases 1, 3, 6 and 7 unchanged; this document restates no number.

## 3. The cycle, predeclared

**A CYCLE IS TEN STEPS IN A FIXED ORDER**, and it is deliberately the boring path an operator actually walks.

| Step | What happens | What it exists to prove |
|---|---|---|
| **S1 — preflight** | the shipped `deploy/projection-alpha.sh preflight` | an operator's first command must be honest about a mount point that has been used before, not only about a clean one |
| **S2 — install / start / status, idempotent** | `install`, then `start`, then `start` **again**, then `status` | Phase 6 proves idempotence once against a fresh install. An appliance that is idempotent only when nothing is using it is not idempotent |
| **S3 — three consumers read, concurrently** | all three servers read the operator's **four approved windows** inside their own containers as their own uid, at the same time | the namespace is still theirs after N cycles, and no cycle quietly re-bound anything |
| **S4 — useful playback** | a paced direct play and a forced transcode per server, at the **existing** Phase 1 durations and through each server's **own** driver and verifier | "the operator can use it" is a claim about playback and nothing else |
| **S5 — one safe automatic recovery** | Phase 7 `R1`'s injector — the mount removed from beneath a living daemon — with the consumers still attached | the one fault an operator is most likely to cause themselves, in a namespace that is **not** fresh |
| **S6 — mount topology** | the layer count at the mount point, above the floor measured **before the first cycle's first mount** | §8.1. A soak that grows a layer per cycle is the defect this tranche exists to catch |
| **S7 — stop / start without rebinding** | the shipped `stop`, then `start`, with the three servers untouched | Phase 7 §12.4 #2 is here, in the ordinary path rather than under an overlay |
| **S8 — recovery state and reset truth** | `status` before and after `reset-recovery`, and the durable ledger read from disk | a ledger that drifts across cycles is a lockout an operator cannot reason about |
| **S9 — upgrade and rollback** | `upgrade` to the same digest, then `rollback`, with the target and custody read from the shipped surface | §8.3's limitation is a decision, not a licence for the target to be wrong |
| **S10 — cleanup accounting** | the host's container, network, volume and mountpoint **sets**, and this cycle's own transient resources | a soak that leaks one container per cycle is a soak that ends in an outage |

## 4. The predeclared thresholds

**EVERY ONE IS IMPORTED FROM A CLOSED TRANCHE'S MODULE AND THIS DOCUMENT RESTATES NONE OF THEM**, except the
three §4.1 names as new. `test/projection-phase8.ts` fails if the module, this table's derivations and the
shipped gate disagree.

| Name | Value | Where it comes from |
|---|---|---|
| `CYCLES_PER_SOAK` | **3** | **NEW.** §5 is the reasoning: three is the repetition convention every tranche here closes on, applied to cycles instead of runs |
| `OPERATOR_WINDOWS_REQUIRED` | 4 | **IMPORTED** from Phase 3 |
| `PLAY_DECODED_SECONDS_MIN` / `TRANSCODE_DECODED_SECONDS_MIN` | 300 / 300 | **IMPORTED** from `MEDIA_SERVER_SOAK`, unchanged from Phase 7 |
| `SEEK_COUNT` | 10 | **IMPORTED** from `MEDIA_SERVER_SOAK` |
| `LIBRARY_CHURN_MAX` | 0 | **IMPORTED** from Phase 1 |
| `RECOVERY_ACTION_BUDGET_MS` / `RECOVERY_READY_BUDGET_MS` | 33,000 / 59,000 | **IMPORTED** from Phase 7 §4, which derives both from Phase 6's own constants |
| `SINGLE_FLIGHT_ACTIONS_MAX` | 1 | **IMPORTED** from Phase 7 §4 |
| `MOUNT_LAYERS_ABOVE_FLOOR_MAX` | **1** | **IMPORTED** from Phase 7 §4, and it is the threshold this tranche is most exposed to |
| `MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END` | **1** | **IMPORTED** from Phase 7 §4 — the same number after **all three cycles**, which is the new claim |
| `CONSUMER_RESTARTS_MAX` | **0** | **NEW, AND IT IS THE ONE THIS TRANCHE ADDS.** Counted across the whole soak, not per cycle |
| `OPERATOR_INTERVENTIONS_MAX` | **0** | **NEW.** Anything a human would have to do between two declared cycles for the next one to work. A soak that needs one has not soaked |

**No threshold in this table may be weakened by a run.**

### 4.1 The closure rule

**Phase 8 closes when, and only when:**

1. `npm run go:phase8-gate:three` completes **three consecutive fresh soaks, exit 0, zero failures, zero
   skips**, on the real Unraid host, **from one frozen commit, tree and image** whose `deploy/`, `projectiond/`,
   `src/` and compose bytes do not move afterwards — where **fresh** applies to the SOAK and **never** to the
   cycles inside it (§5);
2. every one of the **3 cycles** in each soak runs all **10 steps** in §3's order;
3. every window check matches **all four** operator digests, in every step that takes one, in every cycle;
4. the three media servers are **proven subjects throughout the whole soak**, with `CONSUMER_RESTARTS_MAX` of
   **0** and their binds and container identities unchanged from before the first mount of cycle 1 to after the
   last step of cycle 3;
5. every recovery lands inside the budget §4 imports for it, and `SINGLE_FLIGHT_ACTIONS_MAX` holds;
6. the mount-layer count is inside `MOUNT_LAYERS_ABOVE_FLOOR_MAX` after **every** cycle and
   `MOUNT_LAYERS_ABOVE_FLOOR_MAX_AT_END` at the end of the soak;
7. `OPERATOR_INTERVENTIONS_MAX` is **0** — nothing between two cycles required a human;
8. the host's containers, networks, volumes and `fuse.projectiond` mountpoints are **the same sets** before and
   after every soak, and the gate root holds only bounded evidence;
9. no secret, stable reference, CDN host or operator label appears in anything the soak preserves;
10. Phase 7's own `go:phase7-gate:three` **and** the ten-gate regression matrix are **re-run from the final
    frozen candidate** if this tranche changes any shipped source they measure, and are green with zero skips;
11. TypeScript, `gofmt`, `go vet`, every Go package, the focused Phase 2–8 suites, the evidence-consistency and
    custody suites and the **full offline inventory** pass with zero failures, and every skip is enumerated.

**A skip is a failure for the `:three` wrapper**, as it is for every other gate here.

### 4.2 What makes this tranche a NO-GO

Predeclared, so that no result can be argued into a GO afterwards:

- **any cycle that recreated what §2 says it must not** — a fresh database, cache, library directory or consumer
  container inside a soak is a Phase 7 run wearing a different name;
- **any media server restarted, re-bound or re-created at any point in a soak**;
- **any operator intervention between two cycles**, however small;
- **a mount-layer count outside the imported threshold that is then argued to be acceptable** rather than fixed
  or recorded as a NO-GO;
- **evidence spanning changed shipped source**;
- **any soak that skips anything**;
- **cleanup that differs from the pre-soak sets**, in either direction;
- **fewer than three consecutive fresh passing soaks**;
- **any required real-server behaviour simulated.**

**IF FULL CLOSURE CANNOT BE REACHED HONESTLY, THIS DOCUMENT RECORDS A NO-GO** naming the blocking step
precisely, keeping every fix and every measurement. It does not manufacture closure.

## 5. Repetition, freshness, and the one place they are inverted

**THREE CONSECUTIVE FRESH SOAKS. THREE CYCLES INSIDE EACH SOAK. THE SOAK IS FRESH AND THE CYCLES ARE NOT, AND
THAT INVERSION IS THE WHOLE TRANCHE.**

**Fresh, for a soak**, means what it means everywhere else here: a new run root, a new PostgreSQL with throwaway
storage, a new manifest, a new cache, new media-server configuration directories, new containers with new names,
and a mount point that has never been mounted.

**NOT fresh, for a cycle**, means the opposite and is asserted rather than merely allowed: cycle 2 gets cycle 1's
cache, ledger, libraries, containers, binds and mount point, and cycle 3 gets cycle 2's. `P8-cycle-inherited`
names the specific things that must be the same object, and a cycle that finds any of them new **fails**.

**Why three of each and not one of nine.** A soak of nine cycles answers whether the appliance degrades; three
soaks of three answer whether it degrades **and** whether that answer reproduces. Only the second is a property
of the product rather than of an afternoon.

## 6. Evidence, secrets and the host

**IDENTICAL TO PHASE 7 §6 AND DELIBERATELY NOT RE-DERIVED.** `.projection-phase8-gate/evidence/` at 0700 holds
one verdict log and one cycle log per soak at 0600, carrying gate ids, gate-chosen labels, window geometry, byte
counts, elapsed times and verdicts, and it **structurally cannot** hold a secret, a reference, a URL or a
provider filename. The four operator inputs are read from `PROJECTION_TORBOX_INPUT_DIR`, copied into a 0700 run
directory at 0600, never moved, never widened and **never written back**. The leak search runs in the shared
`leakcheck.sh` shape over the manifest, the probe cache, all three servers' library state and the preserved
evidence. **NOTHING OUTSIDE THIS TASK'S OWN ROOTS IS TOUCHED**, and no Tower reboot happens for any reason.

## 7. The provider-origin blocker, named before it happens

**PHASE 7 §7 APPLIES UNCHANGED AND IS NOT RESTATED.** `deploy/projection-provider-origin-recheck.sh` runs
**immediately before** each soak and its verdict is recorded, digests only; a soak that dies on the allowlist is
**BLOCKED, not failed**, and counts toward nothing in either direction; and **no automated part of this tranche
writes `endpoint.json` on its own initiative**.

**PHASE 8 IS MORE EXPOSED TO IT THAN PHASE 7 WAS**, and saying so before a run is the point: a soak is three
cycles and a three-soak sequence is nine, so it spends more wall clock inside a rotation window than anything
this repository has attempted. Phase 7 §11.15.2 measured the pool cycling through **three** unallowlisted
members in one session.

## 8. The rough edges Phase 7 shipped, and what Phase 8 does about each

### 8.1 Layer accumulation across cycles — **THE SUBJECT, NOT AN ASIDE**

Phase 7 measured the layer count at **1** after every one of eighteen arm readings, in runs that were each
**fresh**. §12.4 #1 and #2 name two states in which the appliance leaves a mount behind, and both are reached by
an operator doing ordinary things repeatedly. **`MOUNT_LAYERS_ABOVE_FLOOR_MAX` IS IMPORTED AT 1 AND IS EXPECTED
TO BITE**, measured after every cycle against the floor taken before the **first** cycle's first mount — never
against a floor re-measured per cycle, which is the exact reasoning error Phase 7 §11.4 #16 turned on.

### 8.2 A killed daemon's mount — **NOT INJECTED, AND THE REASON IS A DECISION**

Phase 7 §12.4 #1 is honest: nothing inside a process can clean up after a `SIGKILL`. **PHASE 8 DOES NOT INJECT
ONE.** An operator soak measures the ordinary path, and a `SIGKILL` is not one; injecting it would measure a
limitation the product already declares and the shipped `preflight` already names with a remediation.
`deploy/projection-restart-topology-gate.sh` `RT4` already asserts that state and its remediation, provider-free,
and is re-run rather than duplicated here.

### 8.3 Rollback and cache loss — **UNCHANGED, AND MEASURED AS FAR AS THE DECISION ALLOWS**

Phase 7 §8.3's decision stands. S9 asserts that `upgrade` records the target **before** anything changes and
that `rollback` honours it, across three cycles, and asserts **nothing** about surviving cache loss, because the
product does not claim it.

## 9. The regression matrix

**PHASE 8 CHANGES NO SHIPPED PRODUCT SOURCE BY CONTRACT.** If a measured cycle forces one, then Phase 7's
`go:phase7-gate:three` **and** the ten-gate matrix are re-frozen and re-run from the final candidate, and §11
records both. If it does not, the matrix that Phase 7 §11.15.3 records **is** the matrix for this candidate and
§11 says so rather than re-running it to produce the same numbers.

## 10. What this tranche does not claim

- **It adds no provider.** TorBox only. Real-Debrid and Usenet have named contracts and a contract is not a
  feature.
- **It is one host.** Three green soaks on a host that is not this one close nothing at all.
- **It is not an uptime, availability or endurance claim.** Three cycles is three cycles. It is not a week, it
  is not a month, and no figure here is a projection.
- **It is not a load test and no figure here is a performance claim.**
- **It closes no G-number** and re-closes nothing in Phases 1–7. **It does not relabel Phase 7's evidence**:
  every run in Phase 7 §11 stays exactly where it is, attributed to the candidate that produced it.
- **It does not fix Phase 7's rough edges.** §12.4 of that document still ships.
- **It is an alpha soak of a rough-edged one-host alpha**, and that is the whole of the claim.

## 11. Run record

**INCOMPLETE.** See §12.

## 12. The readiness decision

**PENDING.** No measured soak has been recorded.
