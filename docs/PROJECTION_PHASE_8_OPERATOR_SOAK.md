# Projection Phase 8 — the operator soak

**Status: NO-GO — §2 to §10 are the contract and every one of them was written and committed BEFORE the first
measured run. §11 is the run record, §12 is the decision as it stood at commit `f482f31`, §13 is the
superseding design and §14 is the current decision.** No threshold in §4 may move after the first
measured run; a clause that measures FALSE is recorded as **superseded**, with what it said kept whole, exactly
as Phase 4 §4.1, Phase 5 §3.3 and Phase 7 §8.4.4 did — never edited into agreement with a result.

**§13 IS A DESIGN SECTION AND IT WAS COMMITTED BEFORE ANYTHING WAS MEASURED AGAINST IT**, which is the same
rule §2–§10 were written under. It moves no threshold, shortens no cycle and changes no step's meaning; it
takes the ownership decision §12 refused to take without authority, and it records what that costs.

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

**THE TWO WORDS "EXCEPT #11" AND "RECORDED RATHER THAN REPAIRED" ARE THE STATE AT COMMIT `f482f31` AND ARE
KEPT.** **§13 repairs both**, under an authority that did not exist when this paragraph was written: #11 by
making the shipped operator command the sole owner of the daemon and the mount point, and #14 by moving the
ownership record out of the namespace it governs. §13.7 is the re-run obligation that repairing #14 incurs,
and it is honoured rather than waived. **Nothing above this paragraph is edited to agree with that** — the
ledger is what fourteen provider-free findings looked like when they were found.

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


### 11.7 The redesign's own provider-free verification, from the §13 candidate

**EVERYTHING IN THIS SECTION IS PROVIDER-FREE AND NONE OF IT IS EVIDENCE ABOUT A SOAK.** §11.6 applies to it
word for word: no figure here comes from a soak, no media-server behaviour was measured or simulated, and
nothing below may be cited as evidence about the appliance under repetition. It is evidence about **the
instrument and the shipped operator command**, taken after §13 changed both.

**THE FROZEN SOURCE IT COMES FROM**, staged with `git archive` into an emptied `/mnt/user/appdata/catalog-p8g`
and proved byte-identical **in both directions** by independently computed per-file sha256 manifests over
**1,677 tracked files**, with an empty diff:

| | Value |
|---|---|
| commit | `82c96e7`, and the two candidates before it are named per row below |
| image built from that tree, on Unraid | `sha256:216f1ae6f298781b34b0855f1b5201d5db51eec816b8ccf894876797a7a21a46` |
| OPERATOR SOURCE | `9940edfcb50a6a27` — **MOVED**, from `6dbb238d51f6415f`, and §13.4 is the list of what moved and why |
| `projectiond/` image digest | **UNMOVED** — the same `sha256:216f1ae6…` §11.1 records, which is the check that the daemon did not move |

**THE OPERATOR SOURCE MOVING IS THE POINT OF THAT TABLE.** §9 said this tranche changes no shipped product
source; §13.2 supersedes that in terms and §13.7 is the re-run obligation it incurs. Phase 6 §11.10 is where
that re-run is recorded, because Phase 6 is the tranche whose closure the operator source belongs to.

| What | Where | Result |
|---|---|---|
| `bash -n`, gate + three-runner + optional wrapper | Unraid | **clean** |
| the static wiring audit over the gate's bytes | Unraid + dev | **0 problems**, and it still **refuses** a tampered copy |
| `deploy/projection-phase8-rehearsal.sh` — parts A, B and C | Unraid | **86 of 86, exit 0**, from `82c96e7`. Its previous best was 60 of 64 with four failures |
| `npm run go:alpha-acceptance` — the Phase 6 install matrix | Unraid | **14 of 14, exit 0** — `AA1`–`AA11` unchanged and `AA12`–`AA14` new. Phase 6 §11.10 |
| `npm run go:restart-topology-gate` | Unraid | **8 of 8, exit 0** — RT1 to RT6, including RT4's control |
| `gofmt -l`, `go vet ./...`, `go build ./...` | Unraid | **clean** |
| `go test ./...` | Unraid | **all 11 packages ok** |
| `npm run typecheck` | dev | **clean** |
| `test/projection-phase8.ts` | dev + Unraid | **34 of 34** — 26 before, plus the nine §13 pins |
| `test/projection-phase8-gate-audit.ts` | dev + Unraid | **17 of 17**, six of them controls |
| **ten temporary tampers against the §13 pins** | dev | **all ten BIT**, and all ten were reverted |
| the host's container, network, volume sets and `fuse.projectiond` mountpoints | Unraid | **identical before and after every run**: 44 containers, 28 running, 18 networks, 46 volumes, **0** projection mounts, no run directory left |

**THE FOUR FAILURES §11.4 RECORDED ARE GONE, AND THEY WERE THREE FACTS.** `A4` and `A6` were the two halves
of #11 and are now the two assertions that say §13 is implemented rather than described. `C3.2` and `C3.3`
were #14 reproduced, and they are now the two cycles that prove `install` succeeds **over an appliance that
is already serving** — the question §3 wrote S2 to ask, answered the other way.

**WHAT THE REHEARSAL ADDED RATHER THAN WHAT IT STOPPED FAILING**, because a suite that only stopped failing
would be a suite that had been edited into agreement with a result:

- **`A6b`** puts a second-owner bind back and requires the same search to find it;
- **`A7`** reads the shipped profile and the gate together and requires the appliance the gate would drive to
  be configured the way §4's budgets assume;
- **`A8`** reads the shipped command's bytes for the #14 repair;
- **`C1a`** proves a valid environment PASSES `preflight` with three consumers attached, and then refuses
  seven invalid bounded inputs, a foreign ownership record and an unreadable one — with the same record
  naming **this** installation accepted, so the refusals are about whose record it is rather than about there
  being one;
- **every cycle** asserts **sole ownership** — one appliance container serving the mount point, no other
  container on the host projecting at it, exactly one layer of ours above the floor — and the ownership
  record's exact path, mode and directory mode;
- **a v1 marker is left inside the mount point before the first mount**, so all three cycles are a
  **migration** rather than a first install;
- **`C8`** lifts the gate's own reachability probe out of its bytes and proves the appliance resolves by name
  from its own network, **controlled** by a name that does not exist and must return "nothing was measured".

**THREE MORE DEFECTS WERE FOUND BY RUNNING IT, AND ALL THREE WERE IN THE INSTRUMENT.** They are numbered here
as a continuation of §11.3's ledger rather than folded into it, because that ledger is what fourteen findings
looked like when they were found:

| # | Where | What, and what it would have cost |
|---|---|---|
| 15 | rehearsal `A7` | a `$`-anchored `grep` for `--strict-direct-mount` in a compose file `git archive` stages with **CRLF**, because `.gitattributes` forces LF on `*.sh` and `*.go` and nothing else. It reported the flag missing while the flag was there followed by a carriage return — **a pin failing on the one host this tranche closes on, for a line ending** |
| 16 | gate, resolver reachability | the probe still asked from the **gate** network, where the subject's name no longer resolves at all now that the appliance is on the network its own compose profile declares. `probe-reachable.cjs` returns 2 for that and the gate treats 2 as fatal: **a soak would have died in SETUP, on a name lookup, having measured nothing** |
| 17 | gate, `probe-reachable.cjs` | and it could not reliably tell the two apart: it inferred "unresolvable" from an `ENOTFOUND` connect error and mapped everything else — **`EAI_AGAIN` included, which is what Docker's embedded DNS can answer a failed lookup with** — to 1, the PASSING verdict. A subject whose name did not resolve would have been recorded as loopback-only, having measured nothing. It now resolves the name explicitly first |

**#16 AND #17 ARE THE ARGUMENT FOR THE REHEARSAL ALL OVER AGAIN.** Neither is visible to `bash -n`, neither
is visible to the static audit, and both are only reachable by running the thing. #16 would have ended a
provider-facing attempt in setup; #17 would have let a green verdict be recorded for a measurement that never
happened.

### 11.8 The offline inventory, on both hosts, and the one number that moved

**DEV HOST: 316 SELECTED, 316 PASSED, 0 FAILED, 0 REQUIRED-BUT-SKIPPED.** The count is unchanged at 316
because this session adds no suite; the nine §13 pins are new tests inside `test/projection-phase8.ts`, which
goes from 26 assertions to 34.

**UNRAID HOST: THE NINE THAT HOST ALWAYS HAS**, enumerated exactly as §11.4 and Phase 7 §12.2 enumerate them:
`custodian-contract`, `sidecar-runtime-prototype`, `sidecar-durable-state-evidence`, `kek-correction-gates`,
`custodian-storage-ipc-gates` and `custody-transition` fail **closed** on a host whose `shfs` will not honour
the restrictive modes or present the links they need to certify it; and `projection-gate-embedded-programs`,
`projection-mount-hardening` and `projection-multi-frontend` copy a shipped `.sh` to a temp directory and exec
it directly, which is status 126 because every shipped script is mode 644 in git and is always invoked as
`bash script.sh`. **Not one of them is a suite this session touches and not one of them is new.**

**AND ONE MORE APPEARED IN ONE RUN AND IS NOT A TENTH.** `kek-rotation.ts` failed once, under the full
parallel inventory, with *"the rotation is refused: null"* — and **passes on its own in the same staged tree
on the same host**, as it does in two previously staged trees there. It is recorded rather than summarised
because a failure nobody could explain is worse than one that is: it is a flake under parallel load on a
suite this session does not touch, and it is named here so that the next person who sees it knows it has been
seen.

## 12. The readiness decision — **as it stood at commit `f482f31`, and §13 is what changed**

**THIS SECTION IS KEPT WHOLE AND IS NOT EDITED.** It is the decision this tranche took when the blocker was
unresolved, and the thing it refused to do — take the ownership decision quietly, at the end of a session,
and then declare a GO from the instrument it produced — is exactly what §13 does not do either: §13 was
written, reviewed and committed **before a single soak was measured against it**. The verdict below is
superseded by §14; every word of its reasoning stands.

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

## 13. The superseding design — **one owner, and it is the shipped operator command**

**THIS SECTION WAS WRITTEN AND COMMITTED BEFORE ANYTHING WAS MEASURED AGAINST IT**, in exactly the way §2 to
§10 were written before anything was built against them, and for the same reason: §12 refused to take this
decision quietly at the end of a session and then declare a GO from the instrument it produced. **NO
THRESHOLD IN §4 MOVES. NO CYCLE IS SHORTENED. §3's ten steps keep their meanings and their order.** What
changes is who owns the daemon, and three things about the product that had to change for that to be honest.

### 13.1 The decision, in one sentence

**`deploy/projection-alpha.sh` — the shipped operator command §3 already names at S1, S2, S7, S8 and S9 — is
the SOLE owner of the subject `projectiond` daemon and of the mount point it serves.** The gate prepares
isolated inputs, pre-attaches the three consumers, invokes that command, observes it, injects the one
declared fault and verifies the results. **It runs no daemon of its own at that mount point, and it may not.**

### 13.2 What is superseded, kept whole rather than erased

**THE TWO-OWNER DESIGN IS SUPERSEDED AND IS NOT DELETED.** §11.3 #11 states it exactly, §12 states its
consequences exactly, and the rehearsal's `A4` and `A6` are the two assertions that measured it. Read as
history it is correct in every particular: the gate ran its own `projectiond` container with an `rshared`
bind at `$WORK/mnt`, and §3 simultaneously defined five of the ten steps as a command whose own compose
profile would bring an appliance up at the same path. **One mount point cannot have two owners**, and §12's
refusal to fix half of it — to correct the variable names while both owners existed, turning a safe refusal
into a live `install` aimed at a mount point another daemon was serving — was right.

**§9 IS SUPERSEDED BY THIS SECTION AND SAYS SO HERE RATHER THAN BEING REWRITTEN.** That section said *"Phase 8
changes no shipped product source by contract"* and named what must happen if a measured cycle forced one:
Phase 7's `go:phase7-gate:three` **and** the ten-gate matrix are re-frozen and re-run from the final
candidate, and §11 records both. **A measured cycle did force one — three, in fact — and §13.4 is the list
and §13.7 is the re-run obligation being honoured rather than waived.**

### 13.3 What the gate may and may not do, stated as rules rather than as intentions

| The gate MAY | The gate MAY NOT |
|---|---|
| create its own isolated run root, database, manifest, cache, media root and configuration | mount anything at the subject mount point itself |
| pre-attach the three real media servers before the first mount, and never touch them again | start, stop, restart, `docker run`, `docker stop` or `docker rm` the subject daemon by any route other than a shipped verb |
| invoke `preflight`, `install`, `start`, `status`, `stop`, `reset-recovery`, `upgrade` and `rollback` | pass the shipped command an environment it does not define, or configure the daemon by any path the product does not expose |
| observe the daemon's own status surface, log and mount rows from outside the process | adopt, replace or stop an appliance it did not install |
| inject S5's declared fault — the mount removed from beneath a living daemon, at its own mount point | inject any fault §3 does not declare, or `SIGKILL` anything |

**THE SUBJECT'S CONTAINER NAME IS THE OPERATOR'S AND CANNOT CARRY A RUN ID.** `docker-compose.projection-alpha.yml`
fixes `container_name` at `projection-alpha-projectiond` because an operator's appliance has one name. **So a
gate that finds that name taken REFUSES TO RUN** rather than stopping, replacing or adopting what is there —
the same refusal the provider-free rehearsal already makes, for the same reason, and it is a safety rule
before it is a hygiene one.

**AND THE DEAD SECOND OWNER WAS DELETED RATHER THAN LEFT UNREACHABLE.** `corpse_is_stale`, `start_blocker`
and `stop_blocker` were carried over whole from Phase 7 and never called by this gate; `start_blocker` binds
`rshared` at exactly the subject mount point. A rule that holds only because nothing calls the code is a rule
one call undoes, and an audit reading these bytes cannot tell an unreachable second owner from a reachable
one. The injector still exists where it is used and measured, at `deploy/projection-recovery-gate.sh` `RC4`.

### 13.4 The three shipped-product changes, and why each is safe

**THESE ARE PRODUCT CHANGES, NOT INSTRUMENT CHANGES, AND THAT IS WHY §13.7 EXISTS.** Each was forced by the
decision above; each preserves the appliance an operator who sets nothing already had.

**1 — THE POLL INTERVAL BECOMES A BOUNDED, VALIDATED OPERATOR INPUT.** `PROJECTIOND_ALPHA_POLL`, whole
seconds, 1s to 60s, **default `5s` — the value this profile has always hard-coded**. `preflight` validates it
and refuses anything else, so an operator who mistypes it learns from the verb that changes nothing rather
than from a container that restarts forever.

*Why it had to exist.* Every readiness budget this product publishes is derived as **one pointer poll plus one
read deadline**, so the interval is one half of a relationship rather than a free parameter. §4 imports
`RECOVERY_READY_BUDGET_MS` from Phase 7, which derives it from Phase 6's constants at a **2s** poll. An
appliance that could not be told to run at 2s could not be measured against those budgets — which is the
whole reason the gate ever ran a daemon of its own. **The soak runs the appliance at 2s and says so here**;
the number is not new, it is the one Phase 7 measured, and it now reaches the daemon through a shipped,
validated input instead of through a second daemon the operator never gets.

**2 — `--strict-direct-mount` BECOMES PART OF THE SHIPPED PROFILE, UNCONDITIONALLY.** It refuses to fall back
to the `fusermount` suid helper when a direct mount fails.

*Why it is safe, and why it is not an environment switch.* **The runtime stage of the shipped image is
distroless and contains no `fusermount` binary at all**, so the fallback this flag forbids could never have
succeeded in this image: without the flag, a direct mount that failed for any reason would try a helper that
is not there and produce a failure naming the wrong cause. It is also what **every arm of Phase 7 measured**,
and an appliance claimed on Phase 7's evidence has to be the appliance Phase 7 drove. It is not an
environment switch because a Compose `command:` list cannot conditionally omit an element: an empty string is
a positional argument, and Go's flag parser stops at the first one — so a "disabled" spelling would silently
drop every flag after it. A flag that can be turned off by accident is worse than one that cannot be turned
off at all.

**3 — THE OWNERSHIP MARKER LEAVES THE NAMESPACE IT GOVERNS.** This is the repair of §11.3 **#14**, and it is
the one product defect this tranche found rather than caused.

*What was wrong.* `OWNED_DIRS` included the **mount point**, and `install` wrote `.projection-alpha/owned`
into every owned directory. On day one that lands on the host. The moment the appliance starts, the read-only
FUSE namespace is mounted **over** it: the marker is invisible, the `[ ! -e ... ]` guard is therefore true,
and the write is aimed at a filesystem that refuses every mutation syscall. `Read-only file system`, `set
-e`, exit 1 — **for an appliance that was working perfectly.** Reproduced on the real host, in cycles 2 and 3
of both of the rehearsal's runs.

*The repair, and every property of it is there because its absence is a real failure mode.*

| Property | Why |
|---|---|
| a single durable **ownership record** in an operator-state directory, default `<cache>/.projection-alpha-state/`, override `PROJECTIOND_ALPHA_STATE_DIR` | the cache is the one path the contract already requires to be durable and writable, and it is **never mounted over**. It is a DIRECTORY because the probe cache sweeps loose files out of its own root at every daemon startup and skips directories — the same defect that once ate the recovery ledger |
| **refused** if it is inside the mount point, the media root or the manifest directory | a record kept where the appliance mounts is the defect itself, restated as configuration |
| **0700** on the directory, **0600** on the file | it names which host paths this appliance manages: not a secret, and nobody else's business |
| **atomic** — same-directory temp plus rename | a truncated record reads as foreign and would refuse the next install of a perfectly good appliance |
| **exact** ownership: the recorded mount and cache must equal this installation's, byte for byte | read with a `while read` rather than `awk`, because rebuilding a record with `awk` normalises runs of whitespace and would call a path with two spaces in it foreign |
| three answers — **ours**, **absent**, **foreign** — and only `absent` may be adopted | "not ours" and "nobody's" are different states. A command that collapsed them would either refuse a correct reinstall or put its name on another appliance's directories |
| a v1 installation is **migrated**, never refused: its per-directory markers are still accepted, and `install` writes the record every time | an operator who upgrades this script must not have to reinstall |
| the **mount point gets no marker at all**, and nothing is ever written into or unmounted from the projected tree to recover one | the two things this appliance refuses on principle are writing into the read-only namespace and detaching the operator's mount |

**THE MOUNT POINT LOSES NOTHING BY LOSING ITS MARKER.** Ownership of it is established by the ownership
record, by a live `fuse.projectiond` mount at exactly that path — this product's own filesystem answering,
which is a stronger statement than any file — or by the directory being empty. All three already existed.

### 13.5 What this changes in §3, which is nothing

**S1 IS STILL `preflight`. S2 IS STILL `install`, `start`, `start`, `status`. S7 IS STILL `stop` THEN
`start`. S8 IS STILL `reset-recovery`. S9 IS STILL `upgrade` THEN `rollback`.** They are now invocations that
can succeed instead of invocations that exit REFUSED, which is the entire difference. **§4.1's clause 2 —
every cycle runs all ten steps — becomes satisfiable for the first time**, and #14's repair is what makes
S2's four verbs able to succeed on cycle 2 rather than three of them.

**THE SETUP BRINGS THE APPLIANCE UP THROUGH `install` AND `start` BEFORE CYCLE 1, AND THAT IS DECLARED HERE
RATHER THAN NOTICED LATER.** Everything between the consumers attaching and the first cycle — three real
libraries scanned, generation 2 published, the operator's object proved decodable — needs a namespace to
read. So cycle 1's S2 runs the four verbs over an appliance that is **already serving**, which is exactly the
question §3 wrote S2 to ask, and makes cycle 1's S2 the same experiment as cycles 2 and 3's rather than a
weaker one.

**AND THE RESOLVER MOVES WITH THE DAEMON, WHICH IS A CONSEQUENCE NOBODY WOULD PREDICT FROM THE PARAGRAPH
ABOVE.** The loopback-only TorBox resolver runs *inside the daemon's network namespace* — that is what makes
it unreachable from anything else on the host — and a namespace dies with the container that owns it. While
the gate ran a daemon the shipped verbs could not touch, this was invisible; the moment the operator command
became the sole owner, a shipped `stop` became the death of the resolver and a shipped `start` a namespace
the old resolver could never rejoin. So S7's stop and start carry the resolver, and `upgrade` and `rollback`
**ask** whether the daemon container was replaced rather than assuming either answer.

### 13.6 Phase 7's safety properties are preserved, and the regressions that say so

**NOTHING IN §13 RELAXES A SAFETY PROPERTY, AND THE LIST IS EXPLICIT** because "we did not weaken anything" is
a claim and not a measurement. Only the exact recorded `mountinfo` row may be detached; type, count and shape
are never trusted; the expected Unraid underlay and any foreign overlay are never unmounted; there is no
broad or lazy unmount of anything but this run's own mount point; the mount layer maximum stays **1**;
recovery stays bounded and single-flight; the lockout stays durable and is cleared only by a human typing
`reset-recovery`; and `R5`'s refusal is unchanged. **None of them is touched by this section**, which is
itself the point: the redesign moves ownership, not policy.

**THE NEW REGRESSIONS, POSITIVE AND NEGATIVE, AND WHERE EACH LIVES:**

| What | Where | Kind |
|---|---|---|
| sole ownership: exactly one appliance container serves the mount point, no other container projects at it, exactly one layer of ours above the floor | rehearsal part C, every cycle | positive |
| the gate binds the projected path into no container of its own, drives the shipped verbs, and watches the container the shipped profile names | rehearsal `A6` | positive |
| the same search finds a second owner when one is put back | rehearsal `A6b` | **control** |
| the profile expresses the poll interval and the strict flag, and the gate hands over the interval its budgets assume | rehearsal `A7` | positive |
| ownership is recorded outside the namespace it governs and no marker is written into the mount point | rehearsal `A8`, acceptance `AA12` | positive |
| **`install` succeeds over a SERVING appliance** — #14 | rehearsal part C cycles 2 and 3, acceptance `AA12` | positive |
| `stop`/`start` with the consumers untouched; `upgrade`/`rollback` honouring the recorded target | rehearsal part C, every cycle | positive |
| a **v1** marker left inside the mount point before the first mount, so the cycles are a migration | rehearsal part C setup | positive |
| an ownership record naming a **different** installation is refused | rehearsal `C1a`, acceptance `AA13` | **control** |
| an ownership record this version cannot read is refused | rehearsal `C1a` | **control** |
| the same record naming **this** installation is accepted | rehearsal `C1a`, acceptance `AA13` | **control for the controls** |
| seven invalid bounded inputs refused — a non-duration, `0s`, above the ceiling, milliseconds, a relative state directory, one inside the mount point, one inside the media root | rehearsal `C1a`, acceptance `AA14` | **controls** |
| a valid poll interval inside the bound is accepted | rehearsal `C1a`, acceptance `AA14` | **control for the controls** |
| a valid environment with three consumers attached PASSES `preflight`, so every refusal above is attributable | rehearsal `C1a` | **control for the controls** |
| three consumers pre-attached before the first mount, never restarted or re-bound | rehearsal part C, gate `P8-consumers-pre-attached` | positive |

**EVERY CONTROL ABOVE MUST FAIL FOR ITS OWN REASON.** A control that passes because the environment was
broken in some other way proves nothing, which is why `C1a` runs **after** the consumers are attached — before
them, `preflight` refuses everything for a reason that has nothing to do with the input under test, and all
seven refusals would have been vacuous.

### 13.7 What must be re-run, because shipped source moved

**THIS IS §9's OWN INSTRUCTION BEING FOLLOWED, NOT AN EXCEPTION TO IT.**

1. **The Phase 6 alpha install/recovery matrices** (`npm run go:alpha-acceptance`, and the recovery gate),
   because the operator command and its profile are what they measure. Phase 6 §11.1's `OPERATOR SOURCE
   DIGEST` **moves**, and the pin in `test/projection-bounded-recovery.ts` refuses the old value until the
   record is updated **after** the re-run — never before it, and never by editing the digest to match.
2. **Phase 7's `npm run go:phase7-gate:three` and the ten-gate regression matrix**, re-frozen and re-run from
   the **final** candidate, because that tranche's GO rests on the same operator source.
3. **The provider-free rehearsal, the restart-topology gate, and the full offline inventory**, before any
   provider-facing attempt is spent.

**AND THE ORDER MATTERS: EVERY ONE OF THESE COMES BEFORE THE FIRST SOAK.** §11.2's lesson is that an
instrument you cannot run without the provider is one you cannot debug, and it was right by a margin nobody
estimated; the same logic applies to a product change nobody has run.

### 13.8 What §13 does not claim

- **It does not fix Phase 7's rough edges.** §12.4 of that document still ships. #14 was a Phase 8 finding
  about a Phase 6 command, and repairing it repairs exactly that.
- **It does not change what Phase 8 measures.** Every threshold, every step, every cycle count and every
  nonclaim in §2 to §10 is untouched, and §4.2's NO-GO list is unchanged.
- **It is not evidence.** Nothing in this section is a measurement. §11 is where measurements go and §14 is
  where the verdict goes, and neither may cite this section as a result.
