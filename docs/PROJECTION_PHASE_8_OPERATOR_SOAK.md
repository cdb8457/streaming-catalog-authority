# Projection Phase 8 — the operator soak

**Status: NO-GO — §2 to §10 are the contract and every one of them was written and committed BEFORE the first
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

**NO SOAK HAS BEEN MEASURED. THE TRANCHE IS A NO-GO AND §12 SAYS SO.** No figure anywhere in this document
comes from a soak, because there has not been one, and no provider was contacted at any point in this
tranche — not once, in either session that wrote it.

**WHAT HAS CHANGED SINCE THE FIRST VERSION OF THIS RECORD IS THE BLOCKER ITSELF.** That version said the gate
"exists, is syntax-clean and is pinned by 26 offline assertions, and **it has never been executed**", and
named a provider-free rehearsal as the work that would let anyone find out what that meant. **The rehearsal
has now been built and run.** It found **thirteen defects in the instrument and one in the shipped product**,
every one of them provider-free, most of them in seconds. So the blocker is no longer "nobody has looked". It
is a specific, named, structural mismatch between §3 of this contract and the gate that is supposed to
measure it, and §12 states it in one paragraph.

### 11.1 What exists, and what it has been checked against

| What | Where | State |
|---|---|---|
| the contract | `docs/PROJECTION_PHASE_8_OPERATOR_SOAK.md` | §2–§10, **committed before anything was built against it**, and **no threshold in §4 has moved** |
| the thresholds as code | `src/core/projection/phase8.ts` | three new, **every other one IMPORTED** from the closed tranche that owns it |
| the closure check | `phase8ClosureProblems` | refuses a short soak, an absent measurement, a duplicated verdict, a skip, and a budget the soak supplied for itself — **all five now exercised as controls rather than asserted** |
| the CLI | `src/ops/projection-phase8-cli.ts` | publishes the budgets as shell assignments the gate evals once, refuses to publish them if the freshness inversion has stopped holding, and now also publishes **the two imported constants the gate reads and it did not** |
| the gate | `deploy/projection-phase8-gate.sh` | **3,514 lines. Ten of its defects are repaired; the eleventh is the blocker and is not repairable here.** Still never executed as a soak |
| the three-runner and the optional wrapper | `deploy/projection-phase8-gate-{three,optional}.sh` | unchanged; a skip propagates as a skip rather than folding into success |
| **the static wiring audit** | `src/core/projection/phase8-gate-audit.ts`, `src/ops/projection-phase8-gate-audit-cli.ts` | **NEW.** Models the ids a soak would actually write and compares THOSE against the closure rule |
| **the provider-free rehearsal** | `deploy/projection-phase8-rehearsal.sh` (`npm run go:phase8-rehearsal`) | **NEW, 749 lines, and it has been RUN on the real Unraid host.** §11.2 |
| the offline suites | `test/projection-phase8.ts`, `test/projection-phase8-gate-audit.ts` | **26 + 17 = 43 assertions, all passing**, both registered in the offline inventory |

**AND THE FULL OFFLINE INVENTORY IS 316 SELECTED, 316 PASSED, 0 FAILED, 0 REQUIRED-BUT-SKIPPED** on the
development host — 316 rather than the 315 the first version of this record names, because this tranche adds
one suite and nothing else. TypeScript is clean. On the Unraid host `gofmt`, `go vet`, `go build` and **all
eleven Go packages** are clean.

**THE SOURCE DIGESTS, UNDER THE SAME RECIPE PHASE 7 §11.1.1 USES** — path, then LF-normalised content, sorted,
one sha256, truncated to sixteen characters:

| | Value |
|---|---|
| commit | `8412a969eeebc9ff6ad368b08be6a45def9b1e95`, tree `76f79bc26f3dbafef0445db5335505949ae95c13` |
| image built from that tree, on Unraid | `sha256:216f1ae6f298781b34b0855f1b5201d5db51eec816b8ccf894876797a7a21a46` |
| PHASE 8 GATE SOURCE | `e799af5bcf6febf4` — **moved**, from `763c58dfa4015981`, and §11.3 is the list of what moved and why |
| PHASE 8 REHEARSAL SOURCE | `33f019d19c6077f1` — new |
| OPERATOR SOURCE | `6dbb238d51f6415f` — **unmoved** |
| PHASE 7 GATE SOURCE | `76f2fe0d2bf5031f` — **unmoved** |

**AND THOSE LAST TWO ROWS ARE THE POINT OF THE TABLE.** §9 says Phase 8 changes no shipped product source, and
the digests are how a reader checks it rather than takes it. They are re-derivable from this tree with the
recipe `sourceDigest` in `test/projection-bounded-recovery.ts` implements. `projectiond/` is untouched — the
image this tree builds on Unraid is `sha256:216f1ae6…`, the **same image Phase 7 §11.1.1 records against its
candidates 12 and 13** — the Phase 7 gate is byte-identical, and the shipped operator command is
byte-identical. **Phase 7's GO is untouched, none of its evidence is relabelled, and the ten-gate matrix
Phase 7 §11.15.3 records is still the matrix for this candidate.**

### 11.2 The rehearsal §11.2 named as the next work — built, run, and what happened

The previous version of this section gave two reasons for not running the gate. **The first was arithmetic** —
six provider-facing attempts authorised, four spent closing Phase 7, and §4.1 needing nine cycles — and it
stands unchanged. **The second was a decision**: that the last two attempts should not be spent on the first
execution of 3,419 lines that had never run once, because Phase 7 §8.7.4's lesson is that an instrument you
cannot run without the provider is one you cannot debug. It named the missing rehearsal as the next work
rather than half-building it.

**THAT DECISION IS NOW MEASURED RATHER THAN ARGUED, AND IT WAS RIGHT BY A MARGIN NOBODY ESTIMATED.** Had those
two attempts been spent, the first would have died in **setup**, on an unbound shell variable, before a single
cycle — and the second would have died in the same place.

`deploy/projection-phase8-rehearsal.sh` is that instrument. It is provider-free by construction: the daemon it
drives is configured with an **empty endpoint list**, the operator's input directory is never read, and no
credential, reference or origin is anywhere in reach. It involves **no media server and simulates none** — its
three consumers are unprivileged `alpine` containers holding the projected path, exactly as the
restart-topology gate's single consumer does, and nothing in it asserts anything whatever about Plex, Jellyfin
or Emby. It records **no `P8-` verdict** and closes nothing.

It has three parts, and the first two need no Docker at all:

- **A — the gate's wiring, read from its bytes.** The three scripts parse; the static audit passes; the same
  audit **refuses a tampered copy**, so a green audit is evidence rather than a command that printed
  something; and A4 compares the environment the shipped operator command **requires**, taken out of that
  command's own source, against what the gate's `alpha()` actually sets.
- **B — the closure, report and redaction plumbing**, exercised against a document **synthesised from the
  gate's own emissions** rather than a fixture, with five controls — an absent id, a duplicated id, a skip, a
  budget the soak supplied for itself, and a two-cycle soak — each of which must be refused for its own
  reason, plus a redaction check that must refuse a log carrying a URL.
- **C — the live half**: the shipped operator command, provider-free, over one local seed entry, with three
  consumers attached **before the first mount** and never touched again, across three cycles that inherit
  everything. It runs the gate's **own** `inherit_fingerprint`, `assert_inherited`, `config_dir_for`,
  `container_for` and layer counters, **lifted out of the gate file by name at run time**, so a repair made to
  the gate is rehearsed without being copied and a rename fails loudly instead of rehearsing nothing.

**IT ALSO REFUSES TO RUN IF AN APPLIANCE IS ALREADY INSTALLED ON THE HOST.** The shipped compose profile fixes
`container_name` at `projection-alpha-projectiond`, because an operator's appliance has one name; stopping,
replacing or adopting somebody else's appliance in order to rehearse a gate is the thing every contract here
forbids, so it names that and stops.

### 11.3 The defect ledger — thirteen in the instrument, one in the product

**THIS IS THE CANONICAL LEDGER FOR THIS TRANCHE.** Every entry was found provider-free. Numbers 1 to 13 are
defects in this tranche's own instrument and are repaired here except #11; number 14 is a finding about the
**shipped product** and is recorded rather than repaired, because §9 changes no shipped product source and a
change there would re-open Phase 7's whole matrix.

| # | Where | What, and what it would have cost |
|---|---|---|
| 1 | gate, closing summary | `P8_ARMS_PER_RUN` read three lines from the end and published by nothing. Under `set -u`, **a soak in which every cycle passed and the closure check itself passed would still have exited non-zero** — on a name belonging to a tranche that has arms. Phase 8 has cycles |
| 2 | CLI | `P8_POLL_INTERVAL_MS` never published, and the gate reads it where it builds the daemon configuration. **This is where the first attempt would have died: in setup, before cycle 1** |
| 3 | CLI | `P8_READ_FAIL_BUDGET_MS` never published, and the gate reads it at every in-container read |
| 4 | gate, `step_S5_recovery` | all thirteen ids recorded **without the cycle suffix**. The closure rule requires `P8-S5-action-ms:C1`, `:C2` and `:C3`; the gate wrote `P8-S5-action-ms` three times. **Fifteen required measurements absent from every soak, and eight ids carrying three verdicts each** — both refused in terms by `phase8ClosureProblems` |
| 5 | gate, S3 | the name `P8-S3-windows` given to the host-side aggregate read and the three per-server in-container reads named something nobody requires. §3's S3 is a claim about what EACH server reads in its OWN container, which is why the module expands that id across the three servers. **All three of S3's required ids absent from every cycle** |
| 6 | gate, `phase_bytes` | those per-server reads recorded as **booleans**, where the closure rule measures them against `OPERATOR_WINDOWS_REQUIRED` and demands a finite measurement and the contract's budget. `bool` writes neither field. `inread.sh` was already printing `matched/total` and the gate discarded it |
| 7 | gate, `inherit_fingerprint` | statted `$WORK/emby`, `$WORK/jellyfin` and `$WORK/plex` — **three paths this gate never creates**. The real directories are `jf-config`, `plex-config` and `emby-config`, so the fingerprint wrote UNREADABLE every time and **`P8-cycle-inherited` was recorded as a FAILURE in all three cycles of every soak.** That assertion is the one thing that makes this a soak rather than three Phase 7 runs with a different name, and it could never once have passed |
| 8 | gate, S9 | the rollback target read from `$WORK/cache/rollback-target`, **a name nothing in the product has ever written**. The shipped command records it at `$PROJECTIOND_ALPHA_CACHE_DIR/.projection-alpha-previous-image`, so the id measured an absent file and failed in every cycle — against a product doing exactly what §8.3 says it does |
| 9 | gate, `step_S5_recovery` | `generation_before` inherited from whatever the previous `sample` had left in the variable, where `await_recovery_action` waits for the generation to become **different** from it. On cycle 1 nothing had sampled; on cycles 2 and 3 it described a daemon S9's upgrade and rollback had already replaced. **The wait therefore returned on its FIRST poll having observed no recovery at all, and `P8-S5-action-ms` would have recorded a couple of hundred milliseconds against a 33-second budget, green, for a supervisor that had not yet done anything.** A green measurement of nothing is worse than a red one |
| 10 | gate, setup | the two preserved logs created at 0600 under **Phase 7's names**, so every soak left an empty `arms-<pid>.jsonl` in the evidence of a tranche with no arms, and the cycle log the closure check reads was left to be created by its first append at whatever the operator's umask allowed rather than at the 0600 §6 requires |
| **11** | **gate ↔ §3** | **THE BLOCKER. Not repaired, and §12 is why.** The gate hands `deploy/projection-alpha.sh` an environment that command refuses outright — `PROJECTIOND_ALPHA_CACHE` and `_MANIFEST` where it requires `_CACHE_DIR` and `_MANIFEST_DIR`, and no `_MEDIA_ROOT`, `_SECRETS_DIR` or `_CONFIG` at all — **and §3 defines five of the ten steps as that command**, so S1, S2, S7, S8 and S9 measure nothing. Correcting the names is **not** sufficient and must not be done alone: the gate simultaneously runs **its own daemon** with an `rshared` bind at the same mount point, so one mount point would have two owners |
| 12 | gate, `inherit_fingerprint` | the mount point fingerprinted with `stat -c %i`, which on a **mounted** path returns the mounted filesystem's root inode rather than the directory's. The rehearsal measured `mountpoint 12103424006462983` on a cycle that fingerprinted the path as a plain directory and `mountpoint 1` — the FUSE root — on the cycles that fingerprinted it while serving. Two different questions compared as one |
| 13 | gate, S2 | §3's S2 is **four verbs and the step ran three**: `install` was never invoked at all, and `P8-S2-install-idempotent` was recorded from the exit status of a **`start`** — an id naming one verb and measuring another |
| **14** | **SHIPPED PRODUCT — `deploy/projection-alpha.sh`** | **`install` succeeds exactly once and fails on every later invocation while the appliance is running.** `OWNED_DIRS` includes the **mount point**, and `install_appliance` writes `.projection-alpha/owned` into each owned directory. On day one the mount point is a plain directory and the marker lands on the host. Once the appliance starts, the FUSE filesystem is mounted **over** that directory, so the marker is invisible, the `[ ! -e ... ]` guard is therefore true, and `mkdir -p .../mnt/.projection-alpha` targets a **read-only** filesystem: `Read-only file system`, `set -e`, exit 1 |

**#14 IS EXACTLY THE QUESTION §3 WROTE S2 TO ASK, AND IT IS WORTH THE PARAGRAPH.** That row says an appliance
that is idempotent only when nothing is using it **is not idempotent**, and §1 says Phase 6 `AA1`–`AA11` prove
idempotence *once, against a fresh install, with one unprivileged consumer and no provider*. The shipped
command's own header states the contract it breaks: *"An operator who is unsure what state they are in should
be able to run the verb they want and get that state, which is the opposite of a script that fails when it has
nothing to do."* It was reproduced on the real Unraid host, in cycles 2 and 3 of the rehearsal, in both of the
rehearsal's runs. **It is a finding, not a repair**: §9 forbids the repair here, and a soak that ran only
`start` — as the gate did before #13 was fixed — could never have found it.

### 11.4 The provider-free verification matrix, on the real Unraid host and the development host

**EVERY ROW BELOW IS FROM THE FROZEN CANDIDATE `8412a96`, tree `76f79bc2…`, staged into an emptied directory
by `git archive` and proved byte-identical in BOTH directions** by independently computed per-file sha256
manifests over **1,677 tracked files**, with an empty diff.

| What | Where | Result |
|---|---|---|
| `bash -n`, gate + three-runner + optional wrapper | Unraid | **clean** |
| the static wiring audit over the gate's bytes | Unraid + dev | **0 problems**, and it **refuses** a tampered copy |
| the closure, report and redaction plumbing + **6 controls** | Unraid + dev | **11 of 11**, every control refused for its own reason |
| `deploy/projection-phase8-rehearsal.sh` part C — three inheriting cycles of the shipped operator command | Unraid | **see below** |
| `npm run go:restart-topology-gate` | Unraid | **8 of 8, exit 0** — RT1 to RT6, including RT4's control |
| `gofmt -l`, `go vet ./...`, `go build ./...` | Unraid | **clean** |
| `go test ./...` | Unraid | **all 11 packages ok** |
| `npm run typecheck` | dev | **clean** |
| `test/projection-phase8.ts` | dev + Unraid | **26 of 26** |
| `test/projection-phase8-gate-audit.ts` | dev + Unraid | **17 of 17**, six of them controls |
| the full offline inventory | dev | **316 selected, 316 passed, 0 failed, 0 required-but-skipped** |
| the full offline inventory | Unraid | **316 selected, 307 passed, 9 failed, 0 required-but-skipped** — and the nine are named below |
| the host's container, network, volume sets and `fuse.projectiond` mountpoints | Unraid | **identical before and after every run**: 44 containers, 28 running, 18 networks, 46 volumes, **0** projection mounts, no run directory left |

**THE REHEARSAL'S OWN RESULT IS 60 PASS, 4 FAIL, OF 64 ASSERTIONS — AND IT IS THE SAME 60/4 FROM THE
PRECEDING CANDIDATE `7c864a9` AS FROM THE FROZEN ONE, WITH THE SAME FOUR FAILURES**, which is the only reason
this section says anything at all about reproducibility. Its **first** execution, from `9698383` before two of
the defects below were repaired, was 58 of 63; that run is what found #12 and #13 and it is not evidence about
anything else. **THE FOUR FAILURES ARE THREE FACTS.**
A4 and A6 are the two halves of defect #11. C3.2 and C3.3 are defect #14, reproduced in each of the two cycles
that can reach it. **Everything else the shipped operator command was asked to do, provider-free, it did**:
`preflight` honest about the mount point in all three cycles; `start` idempotent over a running appliance in
all three; the operator surface agreeing with what a sibling container can actually read in all three; all
three consumers reading identical bytes through the same mount in their own containers as their own uid,
**without one of them being restarted or re-bound at any point**; **one** layer above a floor of **zero** after
every cycle; the shipped `stop` leaving nothing of ours at the mount point in all three; `reset-recovery`
clean in all three; `upgrade` recording a rollback target before it changed anything and `rollback` honouring
it in all three; a **foreign overlay refused at shutdown and left byte-unmodified**; **zero** operator
interventions across the three cycles; and the host as it was found.

**THE NINE UNRAID FAILURES ARE THE NINE THAT HOST ALWAYS HAS, AND THEY ARE ENUMERATED RATHER THAN
SUMMARISED**, exactly as Phase 7 §12.2 enumerates the same nine: `custodian-contract`,
`sidecar-runtime-prototype`, `sidecar-durable-state-evidence`, `kek-correction-gates`,
`custodian-storage-ipc-gates` and `custody-transition` are suites that **fail closed** on a host whose `shfs`
will not honour the restrictive modes or present the links they need to certify it; and
`projection-gate-embedded-programs`, `projection-mount-hardening` and `projection-multi-frontend` copy a
shipped `.sh` to a temp directory and exec it directly, which is status 126 on Linux because every shipped
script is mode 644 in git and is always invoked as `bash script.sh`. **Not one of them is a suite this tranche
touches, not one of them is new, and the count is unchanged from Phase 7's**, which is the check that this
tranche added none. **Both Phase 8 suites PASS on that host** — `projection-phase8.ts` and
`projection-phase8-gate-audit.ts`, 26 and 17 — and **required-but-skipped is 0 on both hosts**, which is the
number §4.1 clause 11 actually turns on.

**AND THE INHERITANCE HELD ONCE #12 AND #7 WERE FIXED**, which is the first time anything in this repository
has asserted it: cycles 2 and 3 found the same cache, the same durable ledger, the same manifest, the same
three consumer configuration directories, the same three container ids and the same mount point as cycle 1,
compared by inode and by container start instant. **That is the freshness inversion working, on real
hardware — and it is a fact about the rehearsal, not about a soak.**

### 11.5 The provider-facing attempt ledger

**ZERO.** No soak has been attempted, `npm run go:phase8-gate` has still never run, `npm run
go:phase8-gate:three` has still never run, and **the provider was not contacted at any point in this
tranche.** `deploy/projection-provider-origin-recheck.sh` was therefore not run either: §7 requires it
immediately before each soak, and there was no soak to run it before. `endpoint.json` was not read, not
written and not touched.

### 11.6 What has NOT been claimed anywhere in this document

**NO FIGURE IN THIS TRANCHE COMES FROM A SOAK, BECAUSE THERE HAS NOT BEEN ONE.** Nothing here reports a cycle
time, a recovery budget, an approved-window match or a per-server playback figure. The layer counts, the
inheritance results and the operator-command results in §11.4 come from a **provider-free rehearsal with three
unprivileged containers standing in for consumers**, and they are labelled that way in every sentence that
carries one. They are evidence about the instrument and about the shipped operator command; **they are not
evidence about the appliance under a soak and no later document may cite them as such.**

**NO MEDIA-SERVER BEHAVIOUR WAS MEASURED OR SIMULATED.** §4.2 makes a simulated real-server behaviour a NO-GO;
this tranche measures none, claims none and simulates none.

**AND PHASE 7's EVIDENCE IS NOT RELABELLED.** Every run in `docs/PROJECTION_PHASE_7_OPERATOR_USABLE_ALPHA.md`
§11 stays exactly where it is, attributed to the candidate that produced it. §10 refuses that relabelling in
terms, §11.1's unmoved operator and Phase 7 gate digests are how a reader checks that nothing it measures has
changed, and this section is where a reader can see that it was kept.

## 12. The readiness decision

# **NO-GO.**

**§4.1 CLAUSE 1 IS UNSATISFIED AND NOTHING ELSE MATTERS UNTIL IT IS.** `npm run go:phase8-gate:three` has
**never run**, and neither has a single `go:phase8-gate`. §4.2 forbids a GO on fewer than three consecutive
fresh passing soaks and this document does not manufacture one. **Not one of §4.1's eleven clauses about a
soak has been satisfied, because there has been no soak.**

**THE BLOCKER, NAMED EXACTLY, AND IT IS DEFECT #11.** §3 of this contract defines five of the ten steps of a
cycle as the **shipped operator command**: S1 is `preflight`, S2 is `install`/`start`/`start`/`status`, S7 is
`stop`/`start`, S8 is `reset-recovery` and S9 is `upgrade`/`rollback`. The gate cannot invoke it. It passes an
environment that command refuses outright, **and the correction is not the variable names**: the gate also
starts its own daemon, with an `rshared` bind at the same mount point that the shipped command's own compose
profile would bring an appliance up at. **One mount point cannot have two owners.** Reconciling them means
either the gate stops running its own daemon — in which case the appliance under test runs with the shipped
profile's hard-coded `--poll=5s` and **without** `--strict-direct-mount`, and so is not the appliance Phase 7
measured — or §3 stops naming the shipped command, **which §4.1 forbids**, because a contract may not be
edited into agreement with its instrument.

**THAT IS A DECISION ABOUT WHAT PHASE 8 MEASURES AND IT IS NOT TAKEN HERE.** Taking it quietly at the end of a
session, and then declaring a GO from the instrument it produced, is precisely the shape §4.2 exists to
refuse. It is named as the next work, in exactly the way §11.2 of the previous version of this record named
the rehearsal, and for the same reason.

**AND ONE HALF OF IT MUST NOT BE FIXED ON ITS OWN, WHICH IS A SAFETY NOTE RATHER THAN A STYLE ONE.** While the
variable names are wrong every verb exits REFUSED and changes nothing. Correct only the names and the shipped
`install` and `start` become live commands aimed at a mount point another daemon is already serving. `A6` of
the rehearsal is the pin that says so and it fails while both owners exist.

**WHAT IS NOT BLOCKING IT, BECAUSE IT WAS DONE:**

- **the contract is predeclared and committed**, before anything was built against it, and **no threshold in
  §4 has moved** — not one, in either direction, and §4.2's NO-GO list was written before any result existed;
- **the rehearsal §11.2 named as the next work exists, has run on the real host, and found fourteen things**,
  **twelve of which are repaired here** — including three unbound shell names, any one of which would have
  ended a provider-facing soak, two of them in setup. The two that are not repaired are #11, which is the
  blocker above, and #14, which is a shipped-product finding §9 forbids repairing in this tranche;
- **the pin that could not bite has been replaced by one that does.** `test/projection-phase8.ts` asserted
  that every required id "is an id the gate actually records" by stripping the cycle and server suffixes and
  looking for the bare string, and it was green against a gate that recorded five of S5's ids with no suffix
  at all. The new audit expands the ids instead, follows the gate's call graph to know what runs three times,
  and **six controls prove it bites**;
- **the freshness inversion has been asserted against real hardware for the first time** — cycles 2 and 3
  inheriting cycle 1's cache, ledger, manifest, consumer configuration directories, container ids and mount
  point, by inode and by container start instant;
- **the gate injects no `SIGKILL`, reboots nothing, touches no unrelated service and never writes the
  operator's endpoint file**, and each of those is still pinned;
- **no provider was contacted, no attempt was spent, and `endpoint.json` was not touched**;
- **and it changes no shipped product source.** The operator source and the Phase 7 gate source are
  byte-identical to what Phase 7 closed on, the image this tree builds is the same `sha256:216f1ae6…` Phase 7
  §11.1.1 records against its last two candidates, **Phase 7's GO is untouched**, and the ten-gate matrix that
  tranche recorded is still the matrix for this candidate.

**WHAT WOULD CLEAR IT, IN ORDER, SO THE NEXT SESSION DOES NOT HAVE TO REDISCOVER IT:**

1. **Take the ownership decision in §12 and write it into the contract before building against it**, the way
   §8.4 and §8.7 of Phase 7 were written before the runs that measured them. Either the gate drives the
   shipped appliance and §2 records that the daemon under test carries the shipped profile's flags, or §3's
   five steps are re-specified — and the second is a change to what this tranche measures, not a fix.
2. **Then re-run the rehearsal**, which will say whether the reconciliation works, in minutes and for nothing.
   `A4` and `A6` are the two assertions that turn green when it does.
3. **Then decide what to do about defect #14**, which the reconciled S2 will meet on cycle 2 of every soak. It
   is a shipped-product defect; repairing it re-opens Phase 7's matrix under §9, and not repairing it means
   §4.1 clause 2 cannot be satisfied, because S2 cannot run all four of its verbs successfully. **Either way
   it is a decision with a cost, and pretending it is not is what §4.2 refuses.**
4. **Then one full soak**, then the three `go:phase8-gate:three` needs.

**WHAT THIS IS NOT.** It is not a partial pass, it is not "nearly there", and it is not evidence about the
appliance under repetition. **A gate that has never run a soak has measured no soak**, every rough edge Phase 7
§12.4 ships is still exactly as rough as that document says it is, and the one new thing this tranche knows
about the product — that `install` fails on the second day — is a finding it has recorded rather than a
problem it has solved.
