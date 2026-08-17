# Projection Phase 12 — INDEPENDENT AUDIT OF THE PHASE 11 INSTRUMENT, AND PROVIDER-FREE CLOSURE ON THE REAL HOST

**Status: AUTHORIZED, NOT BUILT, NOT RUN.** This document is the contract, and it is committed **before**
anything is built or run against it, for the reason Phase 6 §11.1.1 records: a threshold written down after
the run that measured it is not a threshold, it is a description.

**AND IT CARRIES A ROADMAP FOR THREE MORE PHASES, WHICH IS THE SECOND THING IT IS FOR.** §12 states Phase 13,
Phase 14 and Phase 15 with their entry criteria, their exit criteria, their dependencies, the claims each one
is permitted to close, and the provider or operator window each one needs. It is written now, before Phase 12
runs, so that Phase 12's stopping point is a boundary somebody drew in advance rather than the place the work
happened to stop.

**THE ONE SENTENCE TO TAKE FROM IT BEFORE ANYTHING ELSE.** Phase 11 shipped a mixed-source acceptance
instrument whose own run record says, in its own first line, that **the gate has never reached a single one of
its six arms on any host**. Phase 10 shipped a content plane whose own §11.7.4 says the rehearsal **has never
run end to end on any host**. Phase 12 is the tranche that attacks the first of those instruments
independently and then tries to make both of those sentences false — **provider-free, on the real host, and
without touching one thing an operator owns**.

---

## 1. Product outcome

An operator has an appliance serving one namespace out of a mixed generation. Phases 9, 10 and 11 built every
part of the path from "a provider serves this by range" and "a worker produced this file" to "a media server
reads both". **Not one of those parts has been observed working on the machine the operator actually owns.**

Phase 12's product outcome is therefore modest and precise: **the provider-free half of that path, observed
running on the real appliance host, from one frozen candidate, with the host left exactly as it was found.**

It is not the mixed product. A fake range origin is not TorBox and a fake SABnzbd is not an NNTP provider —
Phase 11 §3.3's table already says so, and Phase 12 imports that table rather than restating it. What Phase 12
can honestly retire is the answer *"it has never run"*, and nothing beyond that.

---

## 2. What this tranche decides, and what it refuses to decide

### 2.1 An instrument nobody has attacked is an instrument nobody has measured

Phase 11 built its own adversarial audit — `test/projection-phase11-gate-audit.ts`, forty-one arms with twelve
tamper controls — and that suite is good. It is also **the instrument grading its own homework**: it was
written by the tranche that wrote the gate, against the model that tranche held of its own defects, and it
therefore cannot see the defects that tranche did not think of. Phase 10 §11.7 made exactly this argument
about the content plane and found **nine** defects by making it.

So Phase 12's first deliverable is the same move one phase later: **read the committed Phase 11 §§1–10 and the
shipped bytes, not the commit messages, and attack them.** Every defect it finds is repaired with a regression
control that FAILS on the unrepaired bytes, and every defect it finds is **recorded whether or not it was
repaired**, including the ones ruled out of scope, because a tranche that lists only what it fixed is a
tranche nobody can audit.

### 2.2 A gate that has never run is a gate whose defects are all still in it

`bash -n` is clean on all three Phase 11 scripts. Forty-one audit arms pass. The gate still exits 77 at its
first precondition on the development host and has reached nothing. **Every defect in the class "only running
finds it" is therefore still present, undisturbed, by construction.** That is not a criticism of Phase 11; it
is the arithmetic of a tranche that correctly refused to fake a run. It is also the reason Phase 12 exists as
a separate tranche rather than as a Phase 11 amendment: the repairs and the run are two different pieces of
work and averaging them is how a repair gets credited with a run it did not survive.

### 2.3 Provider-free is a property of what exists, not of what the run remembers not to call

Phase 12 contacts **no** TorBox endpoint, **no** CDN origin, **no** indexer, **no** operator SABnzbd, **no**
NNTP server, **no** media server and **no** Tower production container. It reads and writes **no** credential,
touches **no** `endpoint.json`, and alters **no** operator content, provider configuration or persistent
production data. §4 is that as refusals and §5's `P12-C1` is that as a claim a run records.

**AND IT DOES NOT DEFER THE PROVIDER WORK BY LOSING IT.** §12 gives Phase 13 the real TorBox acceptance and
Phase 14 the real Usenet and three-media-server acceptance, each with the window it needs named in advance.
"Provider-free" is a stopping point here because §12 says where it stops being one.

### 2.4 The mount point still has exactly one owner, and it is still not this tranche

Phase 8 §13's ownership rule survives unchanged, and Phase 11 §2.3's restatement of it is imported verbatim.
**Phase 12 starts no daemon of its own, writes no Compose service for one, and never mounts, binds, unmounts
or writes inside the projection mount point.** Where a repair to the Phase 11 gate needs an unmount on a
failure path it uses **`deploy/projection-gate-cleanup.sh`** — the shipped helper every other mounting gate in
this repository already sources — rather than growing one of its own.

### 2.5 What Phase 12 may move about Phase 10 and Phase 11, and what it may not

Phase 12 writes no `P10-` or `P11-` verdict of its own. Where a Phase 12 run produces evidence a Phase 10 or
Phase 11 claim asks for, that claim moves **only** through `phase10ClosureProblems` or
`phase11ClosureProblems` — the closure functions those tranches shipped — over **complete** evidence from
**one frozen candidate**, and the verdict is written in **that tranche's own run record**. A partial subset is
not a closure, and §4's fifth refusal forbids Phase 12 from writing one.

---

## 3. Deliverables

### 3.1 Architecture decision — an audit, three repairs' worth of controls, and one staging script

Phase 12 **adds no product source at all.** No new module under `src/core/` that the daemon, the publisher,
the content plane or the admission path imports; no new operator verb; no new CLI; no second daemon; no second
mount owner; no alternate product path. Everything it ships is an **instrument or a repair to one**.

Three reasons, in descending order of force:

1. **The defect list is in instruments, not in the product.** An audit that repaired the product would be an
   audit whose repairs need the product's soak, and §4's seventh refusal and `phase9RequiresSoakRerun` are the
   check.
2. **The staging problem is a procedure, not a program.** The freeze-and-verify procedure that produced
   defensible evidence on this host already exists as a sequence of ordinary commands; what is missing is one
   script that runs it the same way twice, and one script is the minimum.
3. **A second product path is the one thing nothing else is tested against.** Phase 11 §3.1's first reason,
   imported unchanged.

### 3.2 The deliverables

| id | Deliverable |
|---|---|
| **D12.1** | **`docs/PROJECTION_PHASE_12_AUDIT_AND_PROVIDER_FREE_CLOSURE.md`** — this contract, including §12's roadmap for Phases 13, 14 and 15. |
| **D12.2** | **`src/core/projection/phase12.ts`** — the tranche's rules as code: the claim ids of §5 in this document's order, every threshold either IMPORTED from the closed tranche it came from or NEW and named as new, and `phase12ClosureProblems`, which is what decides whether a run closed. Nothing in it imports a gate, touches a filesystem or contacts anything, and **it names no provider**, so no source allowlist has to be widened for it. |
| **D12.3** | **THE PHASE 11 AUDIT REPAIRS.** Every defect §11 records as repaired, applied to the Phase 11 files that carry it, each in its own comprehensible commit, **each with a regression control that fails on the unrepaired bytes**. The controls live in `test/projection-phase11-gate-audit.ts` and `test/projection-phase11.ts` beside the ones already there, because a control in a different suite from the check it guards is a control somebody deletes without noticing. |
| **D12.4** | **`deploy/projection-phase12-stage.sh`** — the staging and preflight command. Read-only capability preflight of the target host first; then a `git archive` of one frozen commit, extracted into a phase-owned directory, with **byte identity verified in both directions** against `git archive` rather than against the working tree. It starts no container, mounts nothing, and touches nothing outside the directory it owns. **`--preflight-only` is a mode, and it is the default**, so the read-only half can be run on its own. |
| **D12.5** | **`test/projection-phase12.ts`** — the tranche's own rules, offline: that the claim ids are this document's in this document's order; that a skip is not a pass; that a run cannot supply its own budget; that this tranche does not re-open the Phase 8 soak, asserted by RUNNING `phase9RequiresSoakRerun` over its own declared path list; that the staging script is read-only in its default mode; and that the ownership boundary of §2.4 held. |
| **D12.6** | **`package.json` and `test/suite-inventory.json`** — new scripts and one new offline suite only. No existing script's meaning changes. |
| **D12.7** | **NOT PHASE 12 SCOPE, RECORDED SO NOBODY CONCLUDES IT WAS FORGOTTEN.** Everything in §12. Real TorBox acceptance is Phase 13; real Usenet and three-media-server acceptance is Phase 14; release-candidate packaging, cleanup/rollback proof, operator smoke, soak and independent review are Phase 15. Real-Debrid is deferred past all of them and is named in no phase of this roadmap. |

---

## 4. Hard refusals

Phase 12 shall not:

1. contact a real TorBox endpoint, a real CDN origin, an indexer, an operator's SABnzbd, an NNTP server, a
   media server or any Tower production container — **it is provider-free by construction**, and
   `endpoint.json` is not read, not written and not touched;
2. alter, restart, stop, reconfigure, upgrade or delete any Tower production container, media server,
   operator share, operator content, provider configuration, credential, allowlist entry outside an audited
   source need, or persistent production data;
3. **start a second daemon, write a Compose service for one, build an alternate product path, or mount, bind,
   unmount or write inside the projection mount point** — where an appliance is needed the gate invokes
   `deploy/projection-alpha.sh`, and one mount point keeps exactly one owner;
4. record a verdict for a claim it did not run, fold a skip into a pass, or report exit 77 as success —
   **77 is a SKIP and a SKIP is not a PASS**, and `phase12ClosureProblems` refuses it;
5. write a `P9-`, `P10-` or `P11-` verdict of its own, re-word, re-label, partially satisfy or narrow any
   claim of those tranches, or move a Phase 10 or Phase 11 status by any route other than that tranche's own
   closure function over complete evidence from one frozen candidate;
6. weaken a threshold, delete a suite that is required, relax a required-but-skipped count, or rewrite a prior
   run record — a superseded sentence is kept whole and marked superseded, which is Phase 10 §11.7's own rule;
7. modify any path on `PHASE9_SOAK_TRIGGERING_SOURCE`, so `phase9RequiresSoakRerun` over this tranche's own
   changed-path set is FALSE and **the Phase 8 soak is not re-run**;
8. modify `deploy/projection-alpha.sh`, its two helper programs, `deploy/projectiond-alpha.env.example` or
   `docker-compose.projection-alpha.yml` — the OPERATOR SOURCE DIGEST is unmoved and
   `test/projection-bounded-recovery.ts` is what checks it;
9. add a source kind, a manifest field, a schema version, a degraded reason, a divergence code, a job state,
   an operator verb or a claim id to a closed tranche;
10. place a credential, an NZB or indexer URL, an article id, a completed source path, a provider object
    reference, a media identity, an operator share path or an arbitrary OS error string in any emitted
    document — `SealedValue` and `assertSealedSafe` are **reused** rather than re-implemented;
11. **ask a human for a secret value, print one, or write one into evidence** — a blocker is recorded as the
    shape of what is missing, never as the thing itself;
12. push, merge, tag, open a pull request, change a default branch, deploy to production, mutate a credential,
    induce a provider outage, or do any Real-Debrid work of any kind.

---

## 5. Closure rule — eleven claims, and every one is provider-free

Phase 12 is **GO** only when **one frozen candidate** demonstrates all eleven claims below, **with zero
skips**. `phase12ClosureProblems` is the rule as a function; a claim with no verdict, a claim whose verdict is
`skip`, a claim measured against a budget this document did not set, and a claim reporting a measurement it
was given no budget for are each refused.

### 5.1 The audit tier — what an independent read of Phase 11 found and what was done about it

| id | Claim | Kind |
|---|---|---|
| **P12-A1** | every defect the independent audit found in the Phase 11 instrument and ruled IN SCOPE is repaired, and **each repair carries a regression control that FAILS on the unrepaired bytes** | pass/fail — measured against `REPAIRS_WITHOUT_A_CONTROL_MAX` |
| **P12-A2** | every defect the audit found is RECORDED in §11, including the ones ruled out of scope and the ones the audit was wrong about, with the reason beside each | pass/fail |
| **P12-A3** | the repairs move **no** Phase 11 threshold, **no** Phase 11 refusal, **no** claim id and **no** claim wording, and the Phase 11 contract document is edited only in its §10 run record and its §11 audit section | pass/fail — measured against `CONTRACT_TERMS_MOVED_MAX` |

### 5.2 The host tier — the runs that make "it has never run" false

| id | Claim | Kind |
|---|---|---|
| **P12-P1** | a **read-only** capability preflight of the real host is recorded **before anything is created**, and it names every declared precondition with the answer this host gives it | pass/fail |
| **P12-P2** | one frozen candidate is staged to the host and proved **byte-identical in both directions** against `git archive` of that commit | pass/fail — measured against `STAGED_FILES_DIFFERING_MAX` |
| **P12-R1** | `deploy/projection-phase10-rehearsal.sh` runs end to end on the real host, **exit 0, zero skips** | arm — provider-free |
| **P12-R2** | `deploy/projection-phase11-mixed-gate.sh` **reaches all six of its predeclared arms** on the real host and exits 0 | arm — provider-free |
| **P12-R3** | `go:phase10-rehearsal:three` and `go:phase11-mixed-gate:three` each complete, **exit 0, zero skips** | sequence-level — measured against `CONSECUTIVE_FRESH_RUNS` |
| **P12-R4** | the provider-free regression subset is green from that one candidate: `alpha-acceptance`, `real-provider-gate --fake`, `publisher-mount`, `restart-topology` | sequence-level |
| **P12-C1** | the host is left as it was found — container, network and volume sets identical; no production container altered; `endpoint.json` unmoved; no provider, media server or credential contacted | pass/fail — measured against `HOST_RESIDUE_MAX` |

### 5.3 The development-host tier — the candidate the host tier ran from

| id | Claim | Kind |
|---|---|---|
| **P12-S1** | `npx tsc --noEmit` is clean and the **full offline inventory** passes from **Git Bash** and from **an ordinary PowerShell**, from that one frozen candidate, with **zero failed and zero required-but-skipped** | sequence-level |

### 5.4 Thresholds

Every imported threshold names the tranche it came from and is READ FROM THAT MODULE rather than restated.
Every NEW one is new because no earlier tranche could have measured it.

| name | value | source |
|---|---|---|
| `CONSECUTIVE_FRESH_RUNS` | 3 | IMPORTED — `PHASE11_RULES.CONSECUTIVE_FRESH_RUNS`, itself Phase 10 ← Phase 9 ← Phase 8 ← Phase 3 |
| `RESIDUE_MAX` | 0 | IMPORTED — `PHASE11_RULES.RESIDUE_MAX` |
| `HOST_RESIDUE_MAX` | 0 | IMPORTED — the same number, named for the thing it is counted over: containers, networks and volumes on the real host |
| `REPAIRS_WITHOUT_A_CONTROL_MAX` | **0** | **NEW.** Phase 10 §11.7's own lesson as a number. A repair nobody can regress is a repair somebody will undo, and this is what makes "each repair carries a control" checkable rather than promised. |
| `CONTRACT_TERMS_MOVED_MAX` | **0** | **NEW.** Phase 11 §8's last paragraph as a number a run records: no threshold and no refusal may move except by a commit that changes that document first. An auditing tranche is exactly where they get moved by accident. |
| `STAGED_FILES_DIFFERING_MAX` | **0** | **NEW.** No earlier tranche staged a candidate under a checked procedure; a run on a tree that is not the candidate is a run whose figures belong to no commit. |
| `SKIPPED_CLAIMS_MAX` | **0** | **NEW.** §4's fourth refusal as a number. Exit 77 is a SKIP, and a GO with a skip in it is the sentence this whole roadmap exists to stop being writable. |

**A CLAIM WITH NO BUDGET IN THIS TABLE HAS NOTHING TO MEASURE**, and a run that supplies a measurement for one
has invented a budget. `phase12ClosureProblems` refuses both directions.

---

## 6. File ownership, so two dispatches cannot collide

### 6.1 Phase 12 owns, new

`docs/PROJECTION_PHASE_12_AUDIT_AND_PROVIDER_FREE_CLOSURE.md`, `src/core/projection/phase12.ts`,
`deploy/projection-phase12-stage.sh`, `test/projection-phase12.ts`.

### 6.2 Phase 12 modifies, bounded

| File | Change |
|---|---|
| `deploy/projection-phase11-mixed-gate.sh` | the §11 audit repairs, and nothing else. |
| `docker-compose.projection-phase11.yml` | the §11 audit repairs, and nothing else. |
| `test/projection-phase11-gate-audit.ts` | the regression control for each repair, added beside the twelve already there. |
| `test/projection-phase11.ts` | the same, for repairs whose subject is the tranche's rules rather than the gate's bytes. |
| `docs/PROJECTION_PHASE_11_MIXED_SOURCE_ACCEPTANCE.md` | **§10 and a new §11 ONLY.** No §1–§9 sentence, threshold, refusal, claim id or claim wording is edited, which is `P12-A3`. |
| `docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md` | **its own run record ONLY**, and only where Phase 10's own closure function permits it. |
| `docker-compose.projection-phase10.yml` | **one line**: the host interface the throwaway database publishes on. §11 records the reason; it is a safety property of running on the real host and it changes no port, no image, no credential and no threshold. |
| `package.json` | new scripts only. No existing script's meaning changes. |
| `test/suite-inventory.json` | one new offline suite only. |

**AND NOTHING ELSE. THIS TRANCHE SHIPS NO PRODUCT SOURCE.** §3.1 is the reason; this table is the check.

### 6.3 Phase 12 must not touch

`deploy/projection-alpha.sh` and its two helper programs; `deploy/projectiond-alpha.env.example`;
`docker-compose.projection-alpha.yml`; `deploy/projection-content.sh`; `src/ops/projection-content.ts`;
`src/ops/projection-content-cli.ts`; `deploy/projection-gate-cleanup.sh`; anything on
`PHASE9_SOAK_TRIGGERING_SOURCE`; `projectiond/`; any Phase 7, 8 or 9 gate script or run record;
`docs/PROJECTION_PHASE_9_TORBOX_USENET.md`; `src/core/projection/phase7.ts`, `phase8.ts`, `phase9.ts`,
`phase10.ts`, `phase11.ts`.

**`src/core/projection/phase11.ts` IS ON THAT LIST ON PURPOSE.** Phase 11's rules are the thing Phase 12 is
auditing the gate AGAINST. A tranche that could edit both sides of that comparison is a tranche whose audit
concludes whatever it needs to.

---

## 7. Risks, named here rather than discovered later

| id | Risk | Mitigation, decided now |
|---|---|---|
| **R1** | Phase 12 repairs the Phase 11 gate until the gate passes, which is fitting the instrument to the answer. | Every repair is a defect stated as a FAILURE MODE first, with a control that fails on the unrepaired bytes. A repair whose only justification is "the run went red" is refused, and §11 records it as refused. |
| **R2** | A green run on the real host gets quoted as "mixed source works". | Every Phase 11 verdict is still stamped `fake=true`; `phase11ClosureProblems` still refuses a tier-two verdict carrying it; §8 is the sentence a roadmap row may write and may not exceed; and §12 names the phase each remaining claim belongs to. |
| **R3** | The staging run alters the operator's host. | §4's second refusal; the staging script creates one phase-owned directory and starts nothing; the gates assert the host's container, network and volume sets are identical; and `P12-C1` is that as a claim. |
| **R4** | The Unraid host cannot host a gate for an environmental reason, and the run goes RED about the machine. | Phase 10 §11.5's seventh defect, imported as a design rule and applied to the audit itself: **every host condition is a precondition checked before anything is created, and failing one is a 77 SKIP.** An environmental red is itself a Phase 12 defect and §11 records it as one. |
| **R5** | A 77 gets folded and reported as a pass. | `SKIPPED_CLAIMS_MAX = 0`; `phase12ClosureProblems` refuses a `skip` verdict; the `-optional` entry points are not used for any Phase 12 claim and §5 says so. |
| **R6** | The candidate on the host is not the candidate the development-host figures came from. | `P12-P2`: `git archive` of one commit, byte identity verified **in both directions**, sorted with `LC_ALL=C` on both sides, compared against the archive rather than against the working tree. |
| **R7** | Two gates run concurrently on the host and one dies on an allocated port, which reads as a gate defect. | Serialised by the procedure, guarded by counting containers rather than processes, and the appliance-name precondition already refuses a second run. |
| **R8** | The audit finds a defect in a file §6.3 forbids Phase 12 to touch. | It is recorded in §11 as **found and not repaired**, with the phase that owns the repair named. An audit that edited a protected file to fix what it found would be an audit that moved the thing it was measuring against. |
| **R9** | Phase 12 becomes the tranche where "provider-free" quietly becomes the definition of done. | §12 exists. Every claim Phase 12 cannot close is assigned to Phase 13, 14 or 15 with the window it needs, in this commit, before Phase 12 runs. |

---

## 8. What Phase 12 does NOT close, and the sentence a roadmap row may not exceed

**It closes no Phase 9 claim.** `P9-2`, `P9-3`, `P9-5` and `P9-11` are exactly as open as Phase 11 left them,
and Phase 10 §8's prerequisite — that they be run from a Phase 10-or-later candidate — is inherited unchanged
and discharged by none of this.

**It closes nothing about the mixed PRODUCT.** Phase 11 §5.2's four `P11-R*` claims need real operator inputs
and three real pre-attached media servers, and a Phase 12 run supplies none of them. Phase 11 §8's ceiling
sentence is inherited verbatim:

> *what is missing is a run rather than a gate.*

**A Phase 12 GO says: the instrument was attacked independently, its in-scope defects were repaired with
controls, and the provider-free half of the path was observed running on the operator's own machine, three
times, leaving nothing behind.** That is the whole of it.

It is **one host**. It is not a soak, a load test, an uptime claim, an availability claim, a second host, high
availability or a production release. It provides no Real-Debrid, no instant Usenet streaming, no automatic
source failover, no indexer search and no download-selection policy.

**No threshold in §5.4 and no refusal in §4 may move after this commit** except by a commit that changes this
document **first**, states what moved and why, and re-runs everything already measured against the old value.

---

## 9. Exact inputs

| Input | Value |
|---|---|
| Host | the real Unraid host, via the existing gate-run procedure |
| Candidate | one frozen commit, staged by `deploy/projection-phase12-stage.sh` and verified byte-identical both ways |
| Database | the throwaway PostgreSQL each gate already owns, on the port that gate already declares, `tmpfs` data directory |
| Range origin | `projectiond/cmd/fakerange`, `go run` inside the pinned Go image — a FAKE |
| Worker | `startFakeSabnzbd`, ephemeral loopback port — a FAKE |
| Corpus | synthesised by each gate in its own run directory. **No operator content.** |
| Credentials | **none** |
| `endpoint.json` | **not read, not written, not touched** |
| Media servers | **none**, and none simulated |
| Provider window needed | **none** |
| Operator window needed | **none** |

---

## 10. Run record

**EMPTY UNTIL A RUN HAS HAPPENED.** §10 is filled in by the tranche that runs this, and a reader who finds it
empty is reading a contract that has not been answered. Nothing in §§1–9 is evidence.

---

## 11. The independent audit of Phase 11

**EMPTY UNTIL THE AUDIT HAS HAPPENED.** Every defect it finds is recorded here — repaired, out of scope, or
found-and-wrong — with the reason beside each and the phase that owns the repair named for the ones Phase 12
may not make.

---

## 12. THE ROADMAP — Phases 13, 14 and 15

Written **now**, before Phase 12 runs, so that Phase 12's stopping point is a boundary drawn in advance. Each
row states what the phase may close, what it needs that no earlier phase has, and the window it cannot proceed
without. **No phase below may be entered while its named entry criteria are unmet, and no phase below may
close a claim assigned to another.**

### 12.1 Phase 13 — REAL TORBOX ACCEPTANCE

**Subject.** The provider half of the mixed path, against the operator's **already-served TorBox CDN origin**
— the one the appliance is already configured to reach — with **no credential change and no induced provider
outage**.

**Entry criteria.**
1. Phase 12 is GO with zero skips, and the frozen candidate is recorded.
2. `endpoint.json` exists on the host, is already serving, and its origin allowlist already admits the pool
   the operator's objects are served from. **A run that has to widen it is a Phase 13 blocker, not a Phase 13
   step** — the allowlist is perishable and the CDN pool rotates mid-run, so a widening is escalated as a
   digest and never edited to make a run go green.
3. The operator has confirmed at least one object they are entitled to, supplied as a reference **only**, and
   the reference never enters an emitted document.

**Exit criteria.**
1. The real-provider gate and its three-run wrapper complete on the real host, exit 0, zero skips, from one
   frozen candidate.
2. Phase 11 `P11-R1`'s provider half is observed: a real provider-backed entry sits in a published generation
   on the appliance and reads back through the mount.
3. No credential is read, printed, written to evidence, rotated or changed. No provider outage is induced.
4. The origin allowlist is unmoved, and its state is recorded before and after.
5. The host is left as it was found.

**Claims it may close.** The provider-facing arms of the existing real-provider gate, and **the provider half
only** of `P11-R1`. **It may not close `P11-R2`, `P11-R3` or `P11-R4`**, and it may not close `P9-2`, `P9-3`,
`P9-5` or `P9-11`.

**Windows required.** A provider window in which the operator's TorBox account is in good standing and the
CDN origin is serving. **No outage window** — `P11-R3` is deliberately not Phase 13's, precisely because it
would need one.

**Dependencies.** Phase 12's staging script and its byte-identity procedure; Phase 11's gate as repaired.

---

### 12.2 Phase 14 — REAL USENET AND MIXED-SOURCE THREE-SERVER ACCEPTANCE

**Subject.** The other half of the mixed path and the readers of both: a real SABnzbd with a real NNTP
provider behind it, an entitled NZB, and **Plex, Jellyfin and Emby** scanning and reading both entries through
their existing pre-attached binds.

**Entry criteria.**
1. Phase 13 is GO with zero skips.
2. Every input of Phase 11 §9.2 exists and is confirmed by the operator: a running SABnzbd they control with
   an NNTP provider **already configured in the worker**; a dedicated category with its own incomplete and
   complete directories; at least one NZB or indexer URL for content they are legally entitled to; one they
   expect to fail or arrive incomplete; the complete directory placed under the media root the appliance
   already serves; and three real, already-attached media servers.
3. **IF ANY OF THOSE IS MISSING, PHASE 14 DOES NOT RUN AND DOES NOT PARTIALLY RUN.** Its deliverable in that
   case is a **precise, redaction-safe operator preflight**: a document naming the SHAPE of each missing
   input, what it is for, which claim it unblocks, and how the operator can confirm it exists — **and it never
   asks for, prints, transports or records a secret value.** An invented success is the one output this phase
   is forbidden to produce.

**Exit criteria.**
1. `P9-2`, `P9-3` and `P9-5` are answered from a Phase 10-or-later candidate, which is Phase 10 §8's inherited
   prerequisite finally discharged.
2. Phase 11 `P11-R1` closes in full, `P11-R2` closes, and `P11-R3` closes **only if a real outage occurs or can
   be waited for without inducing one on the operator's account**; otherwise `P11-R3` stays NOT RUN and says
   what it is waiting for.
3. `P9-11` and `P11-R4` — three consecutive fresh real sequences — close only after the above hold three
   times.
4. No operator content is deleted, no worker history is deleted, no media server configuration is changed.

**Claims it may close.** `P9-2`, `P9-3`, `P9-5`, `P9-11`, `P11-R1`, `P11-R2`, `P11-R4`, and `P11-R3`
conditionally as above.

**Windows required.** An operator window with the worker, the NZBs and the three media servers available; a
Usenet retention window for the entitled content; and, for `P11-R3` only, a real outage that happens rather
than one that is caused.

**Dependencies.** Phase 13; the operator inputs above; nothing this repository can build, fake or infer.

---

### 12.3 Phase 15 — RELEASE CANDIDATE, ROLLBACK PROOF, OPERATOR SMOKE, SOAK AND INDEPENDENT REVIEW

**Subject.** Turning a set of green gates into something an operator can install, run, and back out of.

**Entry criteria.**
1. Phase 14 is GO, or Phase 14's operator preflight is issued and the claims it could not close are recorded
   as open with the window each needs.
2. Every earlier phase's run record names its frozen candidate.

**Exit criteria.**
1. **Packaging.** One release candidate built from one frozen commit, pinned by digest, with the image digest
   recorded and reproducible.
2. **Cleanup and rollback proof.** An install, an upgrade and a **rollback** on the real host, each leaving
   the container, network and volume sets identical to the state before it, with the namespace readable after
   the rollback and the bytes identical to before the upgrade.
3. **Operator smoke.** The shipped operator runbook, executed by following it literally, with zero hand-run
   commands outside it and zero interventions.
4. **Soak and sequence closure.** The Phase 8 soak re-run if and only if `phase9RequiresSoakRerun` says so
   over the real changed-path set, and the complete tier-one and tier-two sequences three consecutive fresh
   times.
5. **Independent review.** A review of Phase 15 by a reader who did not build it, following Phase 10 §11.7's
   model, with its findings recorded whether or not they were repaired.

**Claims it may close.** The remaining sequence-level claims of Phases 10, 11 and 15's own; the release
disposition.

**Windows required.** An operator maintenance window for the install/upgrade/rollback sequence; the soak
window if the trigger fires.

**Dependencies.** Everything above.

---

### 12.4 What is NOT on this roadmap, and will not be added to it by implication

**Real-Debrid.** Deferred past Phase 15, named in no phase above, and not a dependency of any claim in any of
them. A phase that needed it would be a phase that changed this document first.

A second host, high availability, an uptime figure, a load figure, automatic source failover, indexer search,
a download-selection policy, and instant Usenet streaming. Phase 11 §8's non-claims, inherited by every phase
on this roadmap.
