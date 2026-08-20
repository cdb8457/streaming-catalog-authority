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
| `deploy/projection-phase10-rehearsal.sh` | **the registry reset between `P10-3` and the operator path, and the assertion that the operator path begins at zero.** §11's D7 records what was found; this row was **added to this table after the contract's first commit**, by the amendment recorded immediately below, because the defect is one only a run could find and the run is what Phase 12 is for. |
| `test/projection-phase10.ts` | **the regression control for that repair, and nothing else.** It belongs beside Phase 10's other assertions about its own rehearsal, which is where somebody looking for it will look. |

**AMENDMENT, RECORDED RATHER THAN MADE QUIETLY — §8's own procedure.** The two rows above were not in this
table when this document was first committed. They were added by a commit that changed **this document
first**, states what moved and why, and re-runs everything already measured. What moved: two files joined
§6.2's bounded-modification list. What did **not** move: no §5.4 threshold, no §4 refusal, no claim id, no
claim wording, and nothing on §6.3's untouchable list — §8 freezes those and this amendment does not reach
them. **Why:** `P12-R1` asks the Phase 10 rehearsal to run end to end on the real host, and the first run that
ever tried found that it cannot: `P10-3` seeds the shared throwaway database and `P10-4` then counts as though
the registry were empty. A tranche that recorded that and stopped would be a tranche that let a two-line
defect close the claim it exists to answer; a tranche that repaired it without amending this table first would
be a tranche whose file list means nothing.
| `package.json` | new scripts only. No existing script's meaning changes. |
| `test/suite-inventory.json` | one new offline suite only. |

**AND NOTHING ELSE. THIS TRANCHE SHIPS NO PRODUCT SOURCE.** §3.1 is the reason; this table is the check.

### 6.3 Phase 12 must not touch

`deploy/projection-alpha.sh` and its two helper programs; `deploy/projectiond-alpha.env.example`;
`docker-compose.projection-alpha.yml`; `deploy/projection-content.sh`; `src/ops/projection-content.ts`;
`src/ops/projection-content-cli.ts`; `deploy/projection-gate-cleanup.sh`; anything on
`PHASE9_SOAK_TRIGGERING_SOURCE`; `projectiond/`; any Phase 7, 8 or 9 gate script or run record;
`docs/PROJECTION_PHASE_9_TORBOX_USENET.md`; `src/core/projection/phase7.ts`;
`src/core/projection/phase8.ts`; `src/core/projection/phase9.ts`; `src/core/projection/phase10.ts`;
`src/core/projection/phase11.ts`.

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

### 10.1 STATUS: RUN ON THE REAL HOST. **NO-GO — `phase12ClosureProblems` refuses this run, and §11.4 says why.**

Every one of §5's **eleven claims has a pass verdict**, and the shipped closure function **still refuses**,
because it asks for three fresh sequences and this campaign ran the complete sequence **once**. That
discrepancy is between this document's §5 and this tranche's own code; it is recorded in §11.4 and **not**
resolved by editing the function after the run it would have failed. **Phase 12 is NO-GO.**

**AND TWO SENTENCES THAT WERE TRUE BEFORE THIS CAMPAIGN ARE NOT TRUE AFTER IT.** Phase 11 §10.1 said the mixed
gate *"EXITS 77 AT ITS FIRST PRECONDITION and has never reached a single one of its six arms on any host"*.
Phase 10 §11.7.4 said *"the rehearsal has still never run end to end on any host"*. Both have now happened, on
the real Unraid host, three consecutive fresh times each, with zero skips. Those sentences are **superseded
rather than rewritten**, in their own documents, and each supersession says what replaced it.

**NO PROVIDER WAS CONTACTED AT ANY POINT.** No TorBox endpoint, no CDN origin, no indexer, no operator
SABnzbd, no NNTP server, no media server, no Tower production container, no operator content and no
credential. `endpoint.json` was absent before and absent after, recorded by the gate itself. No production
container was started, stopped, restarted, reconfigured or deleted, and the host's container, network and
volume sets are identical to how they were found.

### 10.2 The candidate, and where each figure comes from

**Candidate `8be98c2`.** Staged onto the real host by `deploy/projection-phase12-stage.sh stage`, and proved
**byte-identical in both directions** against an archive of that commit taken with the working-tree conversion
disabled: **0 files differing, 0 text files carrying a CR on either side.**

The daemon image built from that tree is `sha256:216f1ae6f298781b34b0855f1b5201d5db51eec816b8ccf894876797a7a21a46`,
and it is **the same digest** the tree built before D6's repair — which is what says the line-ending defect
moved no daemon byte, because `.gitattributes` already forced every Go source to LF.

**THIS COMMIT IS THE FIRST TREE THAT DIFFERS FROM THE CANDIDATE**, and it differs only in documentation:
this file's §10 and §11, Phase 11's new §10.7, and Phase 10's new §11.8. §10.7 records the confirmation run
from a candidate that contains them.

### 10.3 What was measured on the REAL UNRAID HOST

| | |
|---|---|
| Host | Unraid 7.2.3, kernel 6.12.54, Docker 27.5.1, Compose 2.40.3, Node v22.18.0 |
| Read-only preflight | recorded **before anything was created**: `/dev/fuse` reachable from a container; no appliance container; no `projection-alpha` network; 5670, 5680 and 8300 all free; the staging directory on a **`shared`** subtree — which is the one property D1 turned out to depend on |
| `deploy/projection-phase10-rehearsal.sh` | **6 arms, 6 passed, 0 failed, exit 0.** The first end-to-end run on any host |
| `go:phase10-rehearsal:three` | **3 of 3 consecutive fresh runs, none skipped, exit 0** |
| `deploy/projection-phase11-mixed-gate.sh` | **all six predeclared arms REACHED, 6 passed, 0 failed, exit 0.** The first arm verdicts in this project's history |
| `go:phase11-mixed-gate:three` | **3 of 3 consecutive fresh runs, none skipped, exit 0** |
| `deploy/projection-alpha-acceptance.sh` | **14 of 14 arms**, exit 0 |
| `deploy/projection-publisher-mount-gate.sh` | PASSED, exit 0 |
| `deploy/projection-restart-topology-gate.sh` | PASSED, exit 0 |
| `deploy/projection-real-provider-gate.sh --fake` | exit 0, **with three arms SKIPPED by that gate's own design** — see §11.3 #4 |
| Host container / network / volume sets | **45 / 18 / 47 before, 45 / 18 / 47 after, 0 differing in each.** Zero mountpoints left under the staging directory |
| `endpoint.json` | **absent before, absent after** — asserted by the gate, not promised |

### 10.4 What was measured on the DEVELOPMENT HOST

| | |
|---|---|
| `npx tsc --noEmit` | clean |
| Full offline inventory, **Git Bash** | **336 selected / 336 passed / 0 failed / 0 required-but-skipped**, 686 s |
| Full offline inventory, **an ordinary PowerShell** | **336 selected / 336 passed / 0 failed / 0 required-but-skipped**, 684 s |
| `test/projection-phase12.ts` | 29 / 29 — and **two of its arms failed on their first execution**, which §11's D-list records |
| `test/projection-phase11.ts` | 37 / 37, was 34 |
| `test/projection-phase11-gate-audit.ts` | 55 / 55, was 41 — fourteen new arms, five of them controls |
| `test/projection-phase10.ts` | 31 / 31, was 30 |
| `test/custody-runtime-closure.ts` | 39 / 39, with the new staging script in its corpus |
| `test/projection-bounded-recovery.ts` | 52 / 52 — the **OPERATOR SOURCE DIGEST is unmoved** |
| The eight provider source allowlists | 7 / 11 / 7 / 10 / 12 / 6 / 10 / 7 — **none widened**, because `src/core/projection/phase12.ts` names no provider |
| `phase9RequiresSoakRerun` over this tranche's own path list | **FALSE.** Zero `PHASE9_SOAK_TRIGGERING_SOURCE` entries touched, so **the Phase 8 soak is not re-run** |

**336 IS 335 PLUS ONE.** This tranche adds one offline suite and nothing else, and the arithmetic is stated so
nobody has to take the count on trust.

### 10.5 THE CLOSURE FUNCTIONS, RUN RATHER THAN SUMMARISED

The shipped functions were given this campaign's verdicts and their problem lists are reproduced verbatim.
This is what the product says, not what the author concluded.

`phase10ClosureProblems` — **2 problems, both the same shape:**

> - the run reports 1 fresh sequences; §5 requires 3, and a shorter run closes nothing
> - P10-10-three-consecutive-fresh-sequences was skipped or is NOT RUN; a skip proves nothing and is never folded into a pass

**Eight of Phase 10's ten claims now carry a pass verdict**, and the two that do not are the same claim at two
levels. Phase 10 is **NO-GO**, and one sequence-level claim away.

`phase11ClosureProblems`, tier one — **2 problems, the same shape again:**

> - the run reports 1 fresh sequences; §5 requires 3, and a shorter run closes nothing
> - P11-S4-three-consecutive-fresh-sequences was skipped or is NOT RUN; a skip proves nothing and is never folded into a pass

**Nine of Phase 11's ten tier-one claims now carry a pass verdict, every one of them stamped `fake=true`.**
Tier one is **NO-GO** and one sequence-level claim away. **Tier two is untouched** and stays exactly as open
as Phase 11 left it.

`phase12ClosureProblems` — **1 problem:**

> - the run reports 1 fresh sequences; §5 requires 3, and a shorter run closes nothing

### 10.6 What this record does NOT contain

**No tier-two verdict of any kind.** `P11-R1`, `P11-R2`, `P11-R3` and `P11-R4` are NOT RUN and no fake run may
record one. **No `P9-` verdict**: `P9-2`, `P9-3`, `P9-5` and `P9-11` are exactly as open as Phase 11 left them,
and Phase 10 §8's prerequisite is inherited and discharged by none of this. **Nothing about the mixed
PRODUCT** — a fake range origin is not a provider and a fake worker is not an NNTP feed. **No complete
tier-one sequence run three times**, which is the one claim standing between Phase 10, Phase 11 tier one and
Phase 12 and their respective GOs. **No soak, no load figure, no uptime figure, no release.**

**AND ONE PROCESS DEFECT OF THIS CAMPAIGN'S OWN.** The Git Bash inventory arm was started against candidate
`8be98c2` and this file's §11 was written **while it was running**, so the tree moved under it by one
documentation file. `test/projection-phase12.ts` reads that file, which makes that arm's figure — by Phase 6
§11.1.1's own rule, the one this repository applies to everybody else — **UNVERIFIABLE rather than wrong.**
The PowerShell arm ran entirely after the edit and is clean. §10.7 re-measures both from a frozen tree.

### 10.7 THE CONFIRMATION RUN, FROM CANDIDATE `61445f2` — THE COMMIT THAT CARRIES §10 AND §11

**THE WHOLE CAMPAIGN WAS RUN AGAIN, from the commit containing this record, so that no figure in this document
depends on a tree that moved and so that §10.6's process defect is answered by a measurement rather than by an
apology.** `61445f2` differs from `8be98c2` in three documentation files and nothing else — this file's §10
and §11, Phase 11's §10.7 and Phase 10's §11.8 — and all three are read by suites, which is why re-running was
the honest answer rather than an argument about whether documentation counts.

| | |
|---|---|
| Staging | **0 files differing, 0 text files carrying a CR on either side** — byte identity in both directions against an archive of `61445f2` |
| Daemon image | `sha256:216f1ae6f298781b34b0855f1b5201d5db51eec816b8ccf894876797a7a21a46` — **the same digest as `8be98c2`**, which is what says no daemon byte moved across the entire campaign |
| `go:phase10-rehearsal:three` | **3 of 3, none skipped, exit 0** — 6/6 arms in every run |
| `go:phase11-mixed-gate:three` | **3 of 3, none skipped, exit 0** — all six arms REACHED and 6/6 passed in every run |
| `alpha-acceptance` / `publisher-mount` / `restart-topology` / `real-provider-gate --fake` | exit 0, exit 0, exit 0, exit 0 — 14 of 14 arms on the first |
| Host container / network / volume sets | **45 / 18 / 47 before, 45 / 18 / 47 after, 0 differing in each**, zero mountpoints under the staging directory, no `projection-*` container left |
| Full offline inventory, **Git Bash** | **336 / 336 / 0 failed / 0 required-but-skipped**, 679 s |
| Full offline inventory, **an ordinary PowerShell** | **336 / 336 / 0 failed / 0 required-but-skipped**, 687 s |

**NOTHING MOVED.** Every figure in §10.3 and §10.4 reproduced from a frozen tree, so §10.6's unverifiable
Git Bash arm is superseded by a verifiable one and the two arms of `P12-S1` are now from **one candidate**.

**AND THE STATUS DOES NOT MOVE EITHER.** §10.1 is still a NO-GO for the reason §11.4 gives: the shipped
`phase12ClosureProblems` asks for three fresh sequences of the complete campaign and this is the second, not
the third. Two consecutive fresh complete sequences is a better answer than one and it is not the answer §5.4
asks for, and a tranche that rounded it up would be doing the thing this whole document exists to refuse.

### 10.8 EXACTLY WHAT IS LEFT ON THE HOST, INCLUDING WHAT `P12-C1` DOES NOT COUNT

`P12-C1` is a claim about **containers, networks and volumes**, and those are identical. Three other things
are on the host because of this campaign, and naming them is the difference between "the host is unchanged"
and "the sets `P12-C1` names are unchanged". They are named here so nobody reads the second as the first.

1. **`/mnt/user/appdata/catalog-phase12-closure`**, 125 MB — the staged candidate, its `node_modules`, and
   four empty gate-root directories the shipped gates leave behind plus the real-provider gate's own preserved
   evidence (§11.3 #3). It is **phase-owned, outside every operator share this project serves**, and it is the
   thing Phase 13 re-stages over rather than re-creates. **Deliberately not deleted:** a candidate nobody can
   re-verify is a candidate whose figures cannot be checked.
2. **`projectiond:phase12-frozen`, 10.3 MB** — the daemon image built from the candidate, pinned by the digest
   §10.7 records. **Deliberately not deleted**, for the same reason, and it does not touch the
   `projectiond:phase1-local` tag another tranche's tree owns.
3. **`golang:1.26`, 874 MB** — the pinned Go toolchain image the fake range origin runs in, **pulled by the
   gate on first use** and left in the host's image cache. The preflight reported it as NOT PRESENT before the
   campaign, which is what makes this an addition rather than a discovery.

**No operator content, no share, no media server, no provider configuration, no credential, no
`endpoint.json` and no persistent production data was created, read, altered or removed at any point.**


### 10.9 THE COMPLETE SEQUENCE, THREE CONSECUTIVE FRESH TIMES, FROM ONE FROZEN CANDIDATE — **STATUS: GO**

**§10.1's NO-GO WAS TRUE OF THE CAMPAIGN IT DESCRIBES AND IS KEPT WHOLE ABOVE.** It said
`phase12ClosureProblems` refuses a campaign that ran the complete sequence once; §10.7 recorded a second
complete sequence and refused to round two up to three. This section records a **new campaign of three
consecutive fresh complete sequences from one frozen candidate**, and it **supersedes §10.1's status rather
than rewriting it** — a run record edited to agree with a later run is not a record.

**NEITHER EARLIER CAMPAIGN IS COUNTED IN THIS SERIES, AND THAT IS NOT A COURTESY.** §10.3's ran from
`8be98c2` and §10.7's from `61445f2`. The tree has moved three commits since — `9b6e7a4`, `aaa450c` and
`a8d7232`, every one of them test-only — and §5 asks for **one** frozen candidate to demonstrate all eleven
claims. Two sequences from two superseded candidates are not two thirds of that, so the required series
**restarted at one** on the current candidate. Everything below is three sequences of that candidate and
nothing else.

**THE CANDIDATE IS `a8d7232`**, the head of the pushed integration branch. It was staged **three separate
times**, once at the head of each sequence, and each staging proved **0 files differing and 0 text files
carrying a CR on either side** against `git archive` of that commit with the working-tree conversion
disabled. The daemon image built from the staged tree is
`sha256:216f1ae6f298781b34b0855f1b5201d5db51eec816b8ccf894876797a7a21a46` in all three — **the same digest as
`8be98c2` and `61445f2`**, which is what says no daemon byte moved across any of this.

#### What one complete sequence is, defined before it was run

The definition is the same in all three, in this order, and **no arm was skipped, folded or omitted in any
of them**.

| # | Arm | Claims it answers |
|---|---|---|
| 1 | `projection-phase12-stage.sh preflight --full` — read-only, **before anything is created** | `P12-P1` |
| 2 | `projection-phase12-stage.sh stage --commit a8d7232`, then `npm ci` and `docker build` on the host | `P12-P2` |
| 3 | `deploy/projection-phase10-rehearsal.sh` on the real host | `P12-R1`, and `P10-3` `P10-4` `P10-5` `P10-6` `P10-8` `P10-9` stamped `rehearsal=true` |
| 4 | `deploy/projection-phase11-mixed-gate.sh` on the real host | `P12-R2`, and `P11-M1`…`P11-M6` stamped `fake=true` |
| 5 | `go:phase10-rehearsal:three` | `P12-R3` first half, `P10-2` |
| 6 | `go:phase11-mixed-gate:three` | `P12-R3` second half, `P11-S2` |
| 7 | `go:alpha-acceptance`, `go:real-provider-gate:fake`, `go:publisher-mount-gate`, `go:restart-topology-gate` | `P12-R4`, `P10-7`, `P11-S3` |
| 8 | the host's container, network and volume sets, its full `docker ps -a` rows, the mountpoints under the staging directory and `endpoint.json`, observed **independently of the gates** before arm 3 and after arm 7 | `P12-C1` |
| 9 | `npx tsc --noEmit`, then the **full offline inventory from Git Bash and from an ordinary PowerShell** | `P12-S1`, `P10-1`, `P11-S1` |
| 10 | `projection-phase10.ts`, `projection-phase11.ts`, `projection-phase11-gate-audit.ts`, `projection-phase12.ts`, and the §11.1 / §11.3 / Phase-11-contract measurements taken from the tree | `P12-A1`, `P12-A2`, `P12-A3` |

**Arms 3 and 5 are not the same arm counted twice.** §5.2 names the single run and the wrapper as separate
claims, so each sequence ran the Phase 10 rehearsal **four** times and the Phase 11 mixed gate **four** times.

#### What the three sequences measured

| | sequence 1 | sequence 2 | sequence 3 |
|---|---|---|---|
| staged files differing / text files with a CR | 0 / 0 | 0 / 0 | 0 / 0 |
| daemon image digest | `216f1ae6…` | `216f1ae6…` | `216f1ae6…` |
| `projection-phase10-rehearsal.sh` | 6 passed, 0 failed, exit 0, 31 s | 6 / 0, exit 0, 31 s | 6 / 0, exit 0, 31 s |
| `projection-phase11-mixed-gate.sh` | six arms REACHED, 6 / 0, exit 0, 63 s | 6 / 0, exit 0, 62 s | 6 / 0, exit 0, 62 s |
| `go:phase10-rehearsal:three` | 3 of 3, none skipped, exit 0, 92 s | 3 of 3, exit 0, 93 s | 3 of 3, exit 0, 93 s |
| `go:phase11-mixed-gate:three` | 3 of 3, none skipped, exit 0, 188 s | 3 of 3, exit 0, 188 s | 3 of 3, exit 0, 187 s |
| `alpha-acceptance` / `real-provider --fake` / `publisher-mount` / `restart-topology` | exit 0 × 4 | exit 0 × 4 | exit 0 × 4 |
| host containers / networks / volumes, before → after | 46 / 18 / 47 → 46 / 18 / 47, **0 differing in each** | same, 0 differing | same, 0 differing |
| full `docker ps -a` rows differing (id, name, state, created) | 0 | 0 | 0 |
| mountpoints under the staging directory, after | 0 | 0 | 0 |
| `endpoint.json` | absent before, absent after | absent before, absent after | absent before, absent after |
| `npx tsc --noEmit` | clean | clean | clean |
| offline inventory, **Git Bash** | 336 / 336 / 0 failed / 0 required-but-skipped, 771 s | 336 / 336 / 0 / 0, 739 s | 336 / 336 / 0 / 0, 749 s |
| offline inventory, **an ordinary PowerShell** | 336 / 336 / 0 / 0, 769 s | 336 / 336 / 0 / 0, 740 s | 336 / 336 / 0 / 0, 743 s |
| §11.1 defects recorded / repairs without a control | 8 / **0** | 8 / **0** | 8 / **0** |
| §11.3 findings recorded as NOT repaired | 6 | 6 | 6 |
| Phase 11 rules module lines changed since `dd315a7` | **0** | **0** | **0** |
| Phase 11 contract lines changed above its own §10 since `dd315a7` | **0** | **0** | **0** |
| claims answered in the sequence, and how many did not pass | 29, **0 not passing** | 29, **0 not passing** | 29, **0 not passing** |

**THE PREFLIGHT SAID THE SAME THING THREE TIMES, BEFORE ANYTHING WAS CREATED:** no appliance container, no
`projection-alpha` network, ports 5670 / 5680 / 8300 all free, `/dev/fuse` reachable from a container, and the
staging directory on `/mnt/user`, `fuse.shfs`, propagation **`shared`** — which is the property D1 turned out
to depend on.

#### The closure functions, run rather than summarised

The three shipped functions were given this campaign's verdicts. Their problem lists are reproduced verbatim.

`phase10ClosureProblems` — **0 problems.**
`phase11ClosureProblems`, tier one — **0 problems.**
`phase12ClosureProblems` — **0 problems.**

**AND THE GREEN IS NOT VACUOUS, WHICH IS A CONTROL RATHER THAN AN ASSURANCE.** The same evidence with **one
byte changed** — sequence 2's Phase 10 rehearsal exit status set to 1 — was re-run through the same three
functions, which then returned **7, 1 and 2 problems** naming `P12-R1`, `P10-10` and `P11-S4` among them. A
campaign that could not fail is a campaign that measured nothing, and this one fails on a single flipped exit
code. The intermediate states are the other control: at one complete sequence the three functions returned
2, 2 and 1 problems, and at two complete sequences 2, 2 and 1 again — the count refusing to round up is the
behaviour §10.7 recorded and it is still the behaviour.

#### The orchestration this campaign used, and why it is not in the candidate

The three sequences were driven by a bounded wrapper that **orders shipped commands, records their exit codes
and output, observes the host independently of them, and then runs the three shipped closure functions over
the result**. It decides no claim: every verdict in the table above starts at `skip` and is moved only by a
line read out of a log a shipped command wrote.

**IT IS DELIBERATELY NOT A FILE IN THIS REPOSITORY.** Adding one would have moved the tree the campaign
exists to measure, restarted the series, and — because this tranche's own suites read this tranche's own
files — required an amendment to §6.1 for a harness rather than for a product. Everything it did is
reproducible from shipped commands alone: arms 1 and 2 are `npm run go:phase12-stage`, arms 3 to 7 are the
`go:` scripts named in the table, arm 9 is `npx tsc --noEmit` and `npm run test:offline` launched from each
shell, and arm 10 is four `npx tsx test/…` invocations. **The cost of that choice is stated rather than
hidden:** the wrapper is not itself under review, and a future campaign that wants one under review has to
add it to §6.1 first, by §8's procedure, and then restart its own series.

#### What this record's own commit is, and what it is not

**THE COMMIT CARRYING THIS SECTION IS NOT THE CANDIDATE, AND CANNOT BE.** This tranche's suites read this
tranche's documents, so a record describing a campaign cannot be inside the tree that campaign ran from —
§10.6 hit exactly this and §10.7 answered it by re-running everything, which produced a second sequence
rather than a third and no way out of the regress.

**SO THE BOUNDARY IS DRAWN INSTEAD OF CHASED.** Every host-tier figure above belongs to `a8d7232`, pinned by
`P12-P2`'s byte identity and by the image digest. This commit differs from `a8d7232` in **documentation
only** — this section, Phase 11's new §10.8 and Phase 10's new §11.9 — and the development-host tier
(`npx tsc --noEmit`, the full offline inventory from both shells, and the four control suites) was
**re-measured on this commit** so that no suite is left broken by the edit. That re-measurement is recorded
in §10.10; **it is not a fourth sequence and is not counted as one.**

#### What is still NOT closed by this

**No tier-two verdict of any kind.** `P11-R1`, `P11-R2`, `P11-R3` and `P11-R4` are NOT RUN, and no fake run
may record one. **No `P9-` verdict**: `P9-2`, `P9-3`, `P9-5` and `P9-11` are exactly as open as Phase 11 left
them, and Phase 10 §8's prerequisite is inherited and discharged by none of this. **Nothing about the mixed
PRODUCT** — a fake range origin is not a provider and a fake worker is not an NNTP feed. **No soak, no load
figure, no uptime figure, no second host, no release.** §8's ceiling sentence still holds: what is missing is
a run rather than a gate.

**NO PROVIDER WAS CONTACTED AT ANY POINT IN ANY OF THE THREE SEQUENCES.** No TorBox endpoint, no CDN origin,
no indexer, no operator SABnzbd, no NNTP server, no media server, no Tower production container, no operator
content and no credential. `endpoint.json` was absent before and absent after every sequence, asserted by the
gates rather than promised. No production container was started, stopped, restarted, reconfigured or deleted:
the full `docker ps -a` rows are identical, not merely the counts.

#### What is left on the host after this campaign

**§10.8's three items and nothing else.** The staging directory `/mnt/user/appdata/catalog-phase12-closure`
(125 MB) holds the candidate, its `node_modules`, four empty gate-root directories and the real-provider
gate's own preserved evidence; `projectiond:phase12-frozen` (10.3 MB) is the image the digest above pins;
`golang:1.26` (874 MB) was already in the host's image cache from the campaign §10.7 records and this one
added no image. The wrapper's own transcripts were written under `/tmp`, copied off the host, and
**deleted**. Container, network and volume sets: **46 / 18 / 47, identical to how the campaign found them.**

### 10.10 THE RE-MEASUREMENT ON THE RECORD COMMIT, WHICH IS NOT A FOURTH SEQUENCE

Recorded so that "the record commit is documentation-only" is a measurement rather than an assertion.

**MEASURED ON COMMIT `034ba2e`**, the commit that carries §10.9, Phase 11's §10.8 and Phase 10's §11.9, and
which differs from candidate `a8d7232` in those three documentation files and in nothing else.

| | |
|---|---|
| `npx tsc --noEmit` | clean |
| Full offline inventory, **Git Bash** | **336 selected / 336 passed / 0 failed / 0 required-but-skipped**, 745 s |
| Full offline inventory, **an ordinary PowerShell** | **336 / 336 / 0 / 0**, 746 s |
| `projection-phase10.ts` / `projection-phase11.ts` / `projection-phase12.ts` | 31 / 31, 39 / 39, 29 / 29 |
| `projection-phase10-gate-audit.ts` / `projection-phase11-gate-audit.ts` | 29 / 29, 56 / 56 |
| `projection-bounded-recovery.ts` — the OPERATOR SOURCE DIGEST | 52 / 52, **unmoved** |
| `custody-runtime-closure.ts` | 39 / 39 |

**WHY IT IS IN THE COMMIT AFTER THE ONE IT MEASURES, AND THIS IS THE REGRESS ENDING RATHER THAN CONTINUING.**
The tree carrying §10.9 cannot also carry the figures produced by running against §10.9; §10.6 and §10.7
chased that and it produced a second sequence rather than a third. So the run record commit is measured, and
its figures land in the next commit, which names the tree they belong to and stops there. **A third commit
measuring the second is not taken, and would prove nothing the second does not.**

**IT CLOSES NOTHING AND IS COUNTED IN NOTHING.** The host tier was not re-run on the record commit and no
figure in §10.9 depends on it; its only job is to show that the three documentation edits carrying this
campaign's record leave every suite that reads them green. `P12-S1`'s verdict in §10.9 is from the
candidate, three times, and is not this measurement.

---

## 11. The independent audit of Phase 11, and the eight defects it found

§§1–9 of the Phase 11 contract and the shipped bytes were read against each other, and then the instrument was
**run**. This section records **every** defect the audit found — repaired, out of scope, or found-and-wrong —
with the reason beside each. It **withdraws no figure** from Phase 11 §10: every number there was true about
the tree it was measured on, and eight defects later that tree is not this one.

**FOUR OF THE EIGHT WERE FOUND BY READING AND FOUR BY RUNNING, AND THE SPLIT IS THE POINT OF THE TRANCHE.**
Phase 11's own audit is forty-one arms with twelve tamper controls and it is good; it could not see any of
these, because it was written by the tranche that wrote the gate and because the gate had never got past its
first precondition. Every defect in the class "only running finds it" was still in it, undisturbed, by
construction.

**EVERY REPAIR CARRIES A REGRESSION CONTROL THAT FAILS ON THE UNREPAIRED BYTES**, which is `P12-A1`, and every
control lives in the suite that already owns the thing it guards.

### 11.1 The eight, in the order they were found

| id | Defect | Found by | Repair | Control |
|---|---|---|---|---|
| **D1** | The gate took its run directory from `mktemp -d`. On the host §9.1 names as the closing host that resolves to `/`, propagation **`private`** — and the shipped appliance profile binds its mount point `:rshared`, which Docker refuses when the source is not on a shared subtree. `alpha start` would have failed, `P11-M2` would have gone red, and the colour would have been about which directory the run was in. Phase 10 §11.5's seventh defect and Phase 11 §7 R5's own imported design rule, inside the tranche that imported it. | reading, confirmed by measuring the host's mount table | the run directory is rooted under the checkout, the way every other mounting gate here roots its own; **and** the propagation is PROBED before anything is created, so a host that still cannot host it SKIPs with 77 | 4 arms in `projection-phase11-gate-audit.ts`, one of them a tamper that returns the gate to `mktemp -d` and strips the probe |
| **D2** | Three byte comparisons in `P11-M3` and `P11-M4` compared two possibly-**empty** strings with a bare `=`. `consumer_sha` sends its errors to `/dev/null`, so a mount that is not there returns the empty string, and `[ "" = "" ]` is true. **And `M4_MOVED=$((M4_A + M4_B))` evaluates an empty operand as ZERO, which is the budget.** | reading | `same_bytes` refuses an empty digest on either side and all five comparisons go through it; `numeric` asserts every derived number is a number before it is compared or added | 4 arms, two of which **execute** the two shell functions out of the shipped bytes, one of which asserts the arithmetic model on the host running the suite, and one of which strips the guard off a call site |
| **D3** | `P11-M1` — the arm the tranche is **named for** — answered "is this generation mixed" with `grep -q 'http-range'` and `grep -q '"local"'` over the whole status document. Neither says which entry carried which kind or whether it was published, and `"local"` is a substring of any field that spells it. A generation of two provider-backed entries beside the word "local" would have passed. `phase11MixedGenerationProblems` was exported, documented and tested, and the gate never called it or anything like it. | reading | `minimums.mts` reads both minimums out of the contract's own module before the operator path begins, and `kinds.cjs` counts **published** entries per kind | 3 arms, one driving `kinds.cjs` over four documents including the exact shape the defect passed on, one a tamper restoring the greps |
| **D4** | The throwaway PostgreSQL published `postgres`/`postgres` on **every interface** of the host, while the compose header claimed a loopback bind and the gate connected at `127.0.0.1`. **And `docker compose up -d --wait` has no timeout**, on a gate whose every other wait is bounded by an attempt count. | reading | `- "127.0.0.1:${…}:5432"`, and `--wait-timeout` behind an overridable named value | 2 arms in `projection-phase11.ts`, which also pin that the gate still connects on loopback and that the two already-bounded loops stay bounded |
| **D5** | Three smaller ones, each the mirror of something the tranche got right beside it. The cleanup destroys the `projection-alpha` network **unconditionally**, including one it did not create — while a comment three lines above refuses the appliance's own *name* for exactly that reason. `P11-M2` quiesced the origin before the LOCAL read and not before the REMOTE one, so "the counters moved" was satisfiable by any traffic at all — the false-**pass** direction of §7 R8's own argument. And `worker.json`, an **output**, sat on the exclusion list whose own comment says it holds "the inputs this run wrote for the shipped commands to read". | reading | a network precondition in the same shape as the appliance one; a second quiescence; `worker.json` scanned by both halves | 3 arms, one of which **counts** the quiescence call sites rather than asserting one exists |
| **D6** | **`deploy/projection-phase12-stage.sh`'s own.** `git archive` applies `core.autocrlf`, which on this development host is `true`, so the staging command carried a CRLF tree onto the Linux host — not the commit. The same file is `1d95779c…` in the commit and was `47a8da60…` on the host. `test/projection-content-command.ts` slices a function body with `indexOf('\n}\n')`, finds nothing in a CRLF file, and reported that a shipped verb **writes outside a transaction** — a false sentence about the product produced by a line ending. **And `P12-P2` agreed**, because it compared the host against the same converted archive. | running | `-c core.autocrlf=false -c core.eol=lf` on every archive invocation, **and** a CR scan of both trees, because this repository's commit contains no CR in any text file — measured, not assumed | 2 arms in `projection-phase12.ts`, one extracting **every** archive invocation from the shipped bytes so a repair applied to `stage` and not to `verify` fails |
| **D7** | `test/projection-drift-guard-db.ts` inherits the Phase 10 rehearsal's exported `DATABASE_URL` — deliberately, since `P10-3`'s subject is the shipped publisher against a **real** database — and leaves its roots, versions and entries in the registry `P10-4` then counts. `P10-4` read **five** registered entries after adding one, its `add-torbox` collided with the suite's own `remote-one` version and returned a bare SQLSTATE `P0001`, and `P10-5` inherited the same five. **Two arms red, one cause, both steps individually correct.** This is why the Phase 10 rehearsal had never run end to end on any host. | running | the throwaway database is destroyed, re-created and migrated between `P10-3` and the operator inputs, **and the zero is asserted from the shipped status surface** rather than assumed from the reset | 1 arm in `projection-phase10.ts`, which **failed on its own first execution** by finding the EXIT trap's copy of `down -v` instead of the reset's |
| **D8** | The gate handed the appliance a configuration with **no `statusAddr`**, which `projection-alpha.sh preflight` counts as a failed check — "status and the healthcheck cannot work". Preflight, install and start all refused, the appliance never came up, the `projection-alpha` network was never created, the fake origin could not join it, and `P11-M2`, `P11-M3` and `P11-M4` failed on reads of a namespace that had never existed. The refusal is the shipped script being right. | running | `"statusAddr": "127.0.0.1:9010"`, cross-checked against every other deploy script and compose file | 1 arm in `projection-phase11.ts` that parses the heredoc as JSON and re-derives the port from the parsed value |

### 11.2 D2 WAS VINDICATED BY D8, WHICH IS THE ONE RESULT IN THIS SECTION WORTH READING TWICE

D2 was found by reading and repaired four commits before the gate ever reached the real host. When it did, D8
meant no appliance started at all — and the run reported:

> `the provider-backed half before and after a publish of the other: a digest is EMPTY, so nothing was read and no comparison can be made`

on an arm that also reported `fields of the provider-backed entry moved by a publish of the other half: 0`.

**Without D2's repair, `P11-M3` and `P11-M4` would have PASSED**, on an appliance that had never started, on
the first run in the project's history that could have produced them — and a green tier-one instrument verdict
would have been recorded for a namespace that did not exist. That is the entire argument for auditing an
instrument nobody has attacked, stated by the instrument itself.

### 11.3 What the audit found and did NOT repair, with the phase that owns each

Recorded because a tranche that lists only what it fixed is a tranche nobody can audit.

1. **A database password reaches the process table on every content invocation.** `deploy/projection-content.sh`
   is driven as `--database-url "postgresql://app:app@…"`, so the credential is visible to any user on the host
   through `ps`. **NOT REPAIRED:** the shipped verb's interface is `src/ops/projection-content-cli.ts`, which
   §6.3 forbids this tranche to edit, and changing how a gate calls it without changing what it accepts would
   be a workaround rather than a repair. **Owner: Phase 15**, whose independent review is where an operator
   interface is the subject.
2. **Both of the Phase 10 rehearsal's `docker compose up -d --wait` invocations are unbounded**, including the
   one this tranche added in the same shape as the one already there. **NOT REPAIRED:** §6.2 authorises the
   registry reset and its assertion in that file and nothing else, and widening a bounded-modification row to
   carry an unrelated repair is how a bounded change stops being one. **Owner: Phase 15.**
3. **Four shipped gates leave an empty gate-root directory under the checkout**, and the real-provider gate
   leaves its own preserved evidence in one. **NOT A DEFECT AND NOT REPAIRED:** none of them is a container, a
   network or a volume, `P12-C1`'s sets are identical, zero mountpoints remain under the staging directory, and
   the evidence directory is that gate doing what it says it does. Recorded so nobody reads §10's residue
   figure as "the staging directory is empty".
4. **`real-provider-gate --fake` reports three arms SKIPPED**, by its own design: real TLS, the egress
   allowlist and per-read refresh are assertable only against a real endpoint. **NOT A PHASE 12 SKIP** — those
   three are `P12-R4`'s member gate's internal arms and they belong to **Phase 13**. §10.3 names all three
   rather than reporting the subset as uniformly green.
5. **`phase11MixedGenerationProblems` is still not executed by the gate.** D3's repair applies the same two
   minimums, read from the same module, but it does not run the function — because the count happens inside
   the hand-run range and reaching the module there needs `npx tsx`, which is exactly what `P11-M5` counts.
   **KNOWINGLY PARTIAL:** narrowing `P11-M5`'s pattern to let the invocation through was available and refused,
   because a measurement loosened to accommodate a repair no longer means what §5 says it means. **Owner: a
   Phase 11 amendment** that either justifies the narrower pattern in that document first, or moves the check
   outside the range.
6. **This tranche's own closure function is stricter than its own §5.** See §11.4.

### 11.4 THE DEFECT THIS TRANCHE FOUND IN ITSELF, AND IT IS WHY §10 IS A NO-GO

§5's prose says Phase 12 is GO when **one frozen candidate** demonstrates all eleven claims with zero skips.
`phase12ClosureProblems` — shipped in D12.2, and the thing that actually decides — additionally requires
**three fresh sequences**, modelled on `phase11ClosureProblems` without the prose to match.

**The two disagree, the function is the stricter, and the function is what decides.** This campaign ran the
complete Phase 12 sequence **once**. So `phase12ClosureProblems` refuses, and §10.1 is a NO-GO.

**IT IS RECORDED RATHER THAN RESOLVED BY EDITING THE FUNCTION.** A closure rule relaxed after the run it would
have failed is not a closure rule; it is a description of that run. Either the prose rises to the function —
by a commit that changes §5 first and then runs the complete sequence three times — or the function comes down
to the prose, by a commit that changes §5 first and re-runs everything already measured against the old value.
§8's procedure applies to this tranche exactly as it applies to the ones it audits.

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

---

---

## 13. AMENDMENT — §12.1's two wrong sentences, and the candidate its GO is recorded from

**THIS SECTION CHANGES NO EVIDENCE AND REWRITES NO RUN RECORD.** §10 is kept whole, including §10.1's NO-GO
and §10.9's GO. §5's eleven claims, §5.4's thresholds and §4's refusals are untouched, and §8 freezes them:
nothing here moves one. What this section does is **supersede two sentences of the roadmap** and **record a
fact about the candidate that the tree has made true since**. Both were named as operator prerequisites by
the Phase 13 pre-entry tranche (§7 #2 and §7 #3 of
`docs/PROJECTION_PHASE_13_PRE_ENTRY_INSTRUMENT_REPAIR.md`), and neither was that tranche's to enact.

**IT IS WRITTEN BEFORE ANYTHING IS MEASURED AGAINST IT**, which is §8's own procedure: the document changes
first, states what moved and why, and everything already measured against the old value is re-run.

### 13.1 Superseded — *"the provider half only of `P11-R1`"*

§12.1's **Claims it may close** row stands above, unedited, and is wrong.

**There is no provider half of `P11-R1`.** The claim is a conjunction about **co-residency**: a real
provider-backed entry **and** a real Usenet-admitted file sitting in **one published generation**. One
entitled object alone in a generation demonstrates nothing about co-residency, so "the provider half" names
no observable and has no denominator. Calling it a half is precisely the averaging Phase 11 §5.2 and this
document's §2.5 forbid.

**The code has always agreed and has always been stricter than this prose.** `phase11ClosureProblems` has no
partial verdict, no half verdict and no per-claim close; a tier-one closure refuses to carry a tier-two
verdict at all; and `PHASE13_PREENTRY_FORBIDDEN_EMITTABLE_IDS` refuses `P11-R1` by id as well as by prefix.
So the supersession is a correction to a sentence, not a change to a rule.

**What Phase 13 may do instead: mint a claim id of its own for what it actually observed.** `P11-R1` stays
**NOT RUN** and is closed by Phase 14 at the earliest — it needs a real Usenet-admitted file, which is
§12.2's subject and not §12.1's.

### 13.2 Superseded — the instrument §12.1 names

§12.1's **Exit criteria** row 1 names *"the real-provider gate and its three-run wrapper"*, and §12.1's
**Dependencies** row names Phase 11's gate as repaired. The gate that sentence points at is
`deploy/projection-real-provider-gate.sh`, and it stands above unedited.

**A LATER PHASE 13 CONTRACT MUST NAME `deploy/projection-torbox-real-gate.sh` INSTEAD.** Two independent
reasons, and either alone would be enough:

1. **The generic gate's real mode had never run anywhere and, before the pre-entry tranche, could not** — it
   died at a hardcoded fake-mode input path twelve steps into a twenty-step program. It is repaired now, and
   the repair is regressed offline, but **a gate you are not running is a gate no repair has survived**.
   Treat it as repaired rather than as proven.
2. **It now REFUSES a real run outright**, and that is the honest answer rather than a defect. Three of its
   five decision-bearing observations have no counter surface on the real path; the daemon exposes none and
   adding one is a product change. So a real run carrying UNTAKEN fields is refused rather than reported —
   which means the gate this roadmap row names **cannot produce complete real evidence at all**.

The provider-specific gate is the mature instrument: it resolves in the daemon's own network namespace, never
mounts the provider key into the daemon, bounds its read step with a corpus-derived ceiling, captures and
asserts both container logs, scans byte-exactly for both secrets, and probes read-only refusals as both an
unprivileged uid **and** uid 0.

### 13.3 THE CANDIDATE — §10.9's GO IS RECORDED FROM `a8d7232`, AND THE TREE HAS MOVED SINCE

**§10.9 IS NOT DISTURBED AND IS NOT RE-OPENED.** Three consecutive fresh complete sequences ran from
`a8d7232`; §10.10 measures the record commit `034ba2e`; the daemon image digest was identical in all three
and identical to `8be98c2` and `61445f2`. **That record stands exactly as written, and Phase 12 is GO.** It
is a statement about `a8d7232`, and it remains true of `a8d7232` whatever else lands.

**AND THAT IS PRECISELY WHY IT DOES NOT TRANSFER.** §7 #3 of the pre-entry document states the rule this
document's own §5.3 implies: a Phase 13 run must use `a8d7232`, or a descendant whose only differences are
documents Phase 12's suites do not read.

**`fe4c1fd` IS NOT SUCH A DESCENDANT, AND THE DIFFERENCE IS NOT COSMETIC.** Between `a8d7232` and `fe4c1fd`
the pre-entry tranche moved **bytes of the instruments a provider-free sequence exercises and bytes the
sequence's own suites read**:

| what moved | why a sequence has to be re-run for it |
|---|---|
| `deploy/projection-real-provider-gate.sh` | arm 7 of §10.9's sequence runs `go:real-provider-gate:fake`. Its real-mode input path, its bounded waits, its ownership-aware cleanup and its derived observations all changed |
| `deploy/projection-torbox-real-gate.sh`, four `-optional` wrappers | four wrappers ran a gate other than the one their filenames name; all four now run their own |
| `deploy/projection-phase12-stage.sh` | **arms 1 and 2 of every sequence.** A second staging marker was admitted |
| `docker-compose.projection-real-provider.yml`, `docker-compose.projection-torbox.yml` | the network name became an env-var default, so the network belongs to a run rather than to the file |
| `src/core/projection/real-provider.ts` | the verdict layer reads provenance and skips rather than passing. This is `src/` |
| `test/projection-real-provider.ts`, `test/torbox-resolver.ts`, `test/suite-inventory.json`, `package.json` | **arm 9**, the full offline inventory, which is two of its selected suites and its own selection list |

A Phase 13 candidate that includes this work therefore **needs Phase 12's complete sequence run again from
it**, and the series **restarts at one** — exactly as §10.9's own campaign restarted when three test-only
commits landed on top of `8be98c2` and `61445f2`. **Two sequences from two superseded candidates are not two
thirds of three**, and that sentence is this document's, not an import.

**WHAT THIS AMENDMENT DOES NOT DO.** It does not declare Phase 12 NO-GO, and it does not weaken §10.9. Phase
12's GO is a closed record about a named commit. What it says is narrower and harder: **a later candidate has
no Phase 12 GO of its own until the complete sequence has been run from it three consecutive fresh times with
zero skips**, and until then that candidate is not admissible as a Phase 13 entry criterion 1.

### 13.4 What moved, and what did not

**Moved:** two roadmap sentences in §12.1, superseded here with the originals kept whole; and the addition of
this section, which records the candidate rule already implied by §5.3 and §10.9.

**Did not move:** every one of §5's eleven claims; every threshold in §5.4; every refusal in §4; every claim
id and every claim wording; §6.3's untouchable list; §8's ceiling sentence; §10 in its entirety, including
§10.1's NO-GO, §10.7's second sequence, §10.9's GO and §10.10's re-measurement; and §11's audit of Phase 11.
**No verdict of any tranche is written, moved, re-worded or narrowed by this section.**

**Phase 9's `P9-2`, `P9-3`, `P9-5` and `P9-11` stay OPEN. Phase 11 tier two stays OPEN and `P11-R1` is NOT
RUN. Phase 13 is NOT ENTERED by this amendment**, which contacts nothing and runs nothing.

### 13.5 THE CURRENT CANDIDATE — the sequence, three consecutive fresh times, from `cdbad42`

**§10.9 IS NOT DISTURBED, NOT RE-OPENED AND NOT SUPERSEDED BY THIS.** It records three consecutive fresh
complete sequences from `a8d7232`, and that record stands exactly as written: it is a statement about
`a8d7232` and it remains true of `a8d7232`. This section answers the question §13.3 raises — what a candidate
carrying the Phase 13 pre-entry instrument repair, its re-audit residuals and this amendment can say for
itself — and its only consumer is Phase 13's entry criterion **E4**.

**THE CANDIDATE IS `cdbad42bf04d4653af7ac26a6a00fa15087e7736`.** It was staged **three separate times**, once
at the head of each sequence, and each staging proved **0 files differing and 0 text files carrying a CR** on
either side against `git archive` of that commit with the working-tree conversion disabled.

**THE DAEMON IMAGE DIGEST IS `sha256:216f1ae6f298781b34b0855f1b5201d5db51eec816b8ccf894876797a7a21a46` IN ALL
THREE — THE SAME DIGEST `a8d7232`, `61445f2` AND `8be98c2` PRODUCED.** That is the sentence that says no
daemon byte moved across any of this work. `projectiond/` is untouched, and the image built from the staged
tree proves it rather than asserting it.

#### What one complete sequence is, and it is §10.9's definition unchanged

Ten arms, in this order, **no arm skipped, folded or omitted in any of the three**. Arms 3 and 5 are not the
same arm counted twice — §5.2 names the single run and the wrapper as separate claims, so each sequence ran
the Phase 10 rehearsal **four** times and the Phase 11 mixed gate **four** times.

| # | Arm | Claims it answers |
|---|---|---|
| 1 | `projection-phase12-stage.sh preflight --full` — read-only, **before anything is created** | `P12-P1` |
| 2 | `projection-phase12-stage.sh stage --commit cdbad42`, then `npm ci` and `docker build` on the host | `P12-P2` |
| 3 | `deploy/projection-phase10-rehearsal.sh` on the real host | `P12-R1`, and `P10-3` `P10-4` `P10-5` `P10-6` `P10-8` `P10-9` stamped `rehearsal=true` |
| 4 | `deploy/projection-phase11-mixed-gate.sh` on the real host | `P12-R2`, and `P11-M1`…`P11-M6` stamped `fake=true` |
| 5 | `go:phase10-rehearsal:three` | `P12-R3` first half, `P10-2` |
| 6 | `go:phase11-mixed-gate:three` | `P12-R3` second half, `P11-S2` |
| 7 | `go:alpha-acceptance`, `go:real-provider-gate:fake`, `go:publisher-mount-gate`, `go:restart-topology-gate` | `P12-R4`, `P10-7`, `P11-S3` |
| 8 | the host's container, network and volume **sets**, its full `docker ps -a` rows, the mountpoints under the staging directory and `endpoint.json`, observed **independently of the gates** before arm 3 and after arm 7 | `P12-C1` |
| 9 | `npx tsc --noEmit`, then the **full offline inventory from Git Bash and from an ordinary PowerShell** | `P12-S1`, `P10-1`, `P11-S1` |
| 10 | twelve suites run one by one, including Phase 10's, Phase 11's, this document's, the two gate audits and both Phase 13 pre-entry suites | `P12-A1`, `P12-A2`, `P12-A3` |

#### What the three sequences measured

| | sequence 1 | sequence 2 | sequence 3 |
|---|---|---|---|
| staged files differing / text files with a CR | 0 / 0 | 0 / 0 | 0 / 0 |
| daemon image digest | `216f1ae6…` | `216f1ae6…` | `216f1ae6…` |
| `projection-phase10-rehearsal.sh` | exit 0, 31 s | exit 0, 31 s | exit 0, 31 s |
| `projection-phase11-mixed-gate.sh` | exit 0, 62 s | exit 0, 62 s | exit 0, 63 s |
| `go:phase10-rehearsal:three` | exit 0, 93 s | exit 0, 94 s | exit 0, 93 s |
| `go:phase11-mixed-gate:three` | exit 0, 190 s | exit 0, 188 s | exit 0, 188 s |
| `alpha-acceptance` / `real-provider --fake` / `publisher-mount` / `restart-topology` | exit 0 × 4 | exit 0 × 4 | exit 0 × 4 |
| host containers / networks / volumes, before → after | 46 / 18 / 47 → 46 / 18 / 47 | same | same |
| **SET membership** — names present before and absent after, per kind | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| full `docker ps -a` rows (id, name, state, created) differing | 0 | 0 | 0 |
| mountpoints under the staging directory, after | 0 | 0 | 0 |
| `projection-*` containers after; appliance container; appliance network | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| `endpoint.json` under the appliance's own path | absent before, absent after | absent, absent | absent, absent |
| `npx tsc --noEmit` | clean | clean | clean |
| offline inventory, **Git Bash** | **339 / 339 / 0 failed / 0 required-but-skipped**, 793 s | 339 / 339 / 0 / 0, 741 s | 339 / 339 / 0 / 0, 736 s |
| offline inventory, **an ordinary PowerShell** | **339 / 339 / 0 / 0**, 732 s | 339 / 339 / 0 / 0, 736 s | 339 / 339 / 0 / 0, 738 s |
| working tree, entering and leaving each sequence | clean / clean | clean / clean | clean / clean |

**All six inventory arms report `RESULT: PASS — every selected suite ran and exited zero`,** and the **39 not
selected** are the Docker-only acceptance suites the default run has always excluded. "Not selected" is not
"skipped". The count is **339 rather than 338** because this branch adds one offline suite,
`projection-phase13.ts`.

**THE PREFLIGHT SAID THE SAME THING THREE TIMES, BEFORE ANYTHING WAS CREATED:** no appliance container, no
`projection-alpha` network, ports 5670 / 5680 / 8300 all free, `/dev/fuse` reachable from a container, and
the staging directory on `/mnt/user`, `fuse.shfs`, propagation **`shared`**.

#### The twelve suites of arm 10, identical in all three sequences

`projection-phase10` 31/0 · `projection-phase11` 39/0 · `projection-phase12` 29/0 ·
`projection-phase10-gate-audit` 29/0 · `projection-phase11-gate-audit` 56/0 ·
`projection-phase13-preentry` 42/0 · `projection-phase13-preentry-gate-audit` 76/0 ·
`projection-phase13` 30/0 · `projection-real-provider` 75/0 · `torbox-resolver` 84/0 ·
`projection-bounded-recovery` 52/0 — the OPERATOR SOURCE DIGEST, **unmoved** — · `custody-runtime-closure` 39/0.

#### The closure functions, run rather than summarised

The shipped functions were given this campaign's verdicts. Every verdict started at `skip` and was moved only
by an exit code a shipped command produced.

`phase10ClosureProblems` — **0 problems.**
`phase11ClosureProblems`, tier one — **0 problems.**
`phase12ClosureProblems` — **0 problems.**
`phase13PreEntryClosureProblems` — **0 problems.**

**AND THE GREEN IS NOT VACUOUS, WHICH IS A CONTROL RATHER THAN AN ASSURANCE.** The same evidence with **one
byte changed** was re-run through the same functions: sequence 1's Phase 10 rehearsal exit status flipped
gives `phase12ClosureProblems` **1 problem**; the rehearsal three-run wrapper flipped gives
`phase10ClosureProblems` **1**; one Phase 11 arm flipped gives `phase11ClosureProblems` **1**. And at **two**
sequences rather than three, `phase12ClosureProblems` returns **2** — the count refusing to round up, which
is the behaviour §10.7 recorded and is still the behaviour.

#### What this DOES and DOES NOT say

**It says exactly one thing: `cdbad42` carries a Phase 12 GO of its own.** Phase 13's entry criterion E4 is
satisfied by this section and by nothing else in it.

**It does not enter Phase 13.** No provider, CDN, resolver, indexer, NNTP server, media server or production
container was contacted in any of the three sequences. No credential was read for value, printed, written
into evidence or rotated. `endpoint.json` was neither read for value nor written, and no origin allowlist was
widened, reordered or edited. **`P11-R1` is NOT RUN and has no half.** Phase 9's `P9-2`, `P9-3`, `P9-5` and
`P9-11` stay OPEN. Nothing about the mixed PRODUCT: a fake range origin is not a provider and a fake worker
is not an NNTP feed.

#### What is left on the host after this campaign, including what `P12-C1` does not count

**Three items, and they are named with their sizes rather than summarised.**

| what | size | note |
|---|---|---|
| `/mnt/user/appdata/catalog-phase13-preentry-authorization` | 125 MB | the staging directory: the candidate, its `node_modules`, four empty gate-root directories. Its basename carries the `catalog-phase13-preentry-` marker the staging script admits, so **Phase 12's own preserved candidate at `catalog-phase12-closure` was never touched** |
| `projectiond:phase13prep-frozen` | 10.3 MB | the image the digest above pins |
| `golang:1.26` | 874 MB | **RE-PULLED BY THIS CAMPAIGN, and that is a difference from §10.8.** The arm-1 preflight of sequence 1 reported the pinned Go toolchain image as **NOT PRESENT**; §10.8 recorded it as already cached. The Phase 11 mixed gate runs `projectiond/cmd/fakerange` through it, so sequence 1 pulled it. It is an image, not a container, network or volume, so it moves none of the SET figures above — and it is recorded here rather than left for somebody to find |

Container, network and volume sets: **46 / 18 / 47, identical to how the campaign found them.** Zero
`projection-*` containers, no appliance container, no appliance network, zero mountpoints under the staging
directory. The wrapper's own transcripts were written under `/root` and `/mnt/user/appdata`, copied off the
host, and **deleted**.

#### The orchestration this campaign used, and why it is not in the candidate

Two bounded scripts — one that orders the shipped commands on the host and observes the host independently of
them, and one that runs the shipped closure functions over the recorded exit codes. **Neither is a file in
this repository**, for the reason §10.9 gives about its own wrapper: adding one would have moved the tree the
campaign exists to measure and restarted the series. Everything they did is reproducible from shipped
commands alone. The cost of that choice is stated rather than hidden: the wrappers are not themselves under
review.

#### THREE candidates were frozen and discarded before this one, and none of them is counted

**None of this is a courtesy, and none of it is rounded up.** A host half ran green from `b838f11`; a second
from `33e5ae8`; and a **complete campaign of three sequences ran green from `fb43087`**. Each was discarded
the moment a defect was found in the tree it was measuring, and each defect was repaired with a control that
was watched failing on the unrepaired bytes.

| discarded candidate | what was found, and how |
|---|---|
| `b838f11` | `phase13EntryRefusals` printed **two identical sentences** for two different unevaluated fields, so a reader could not tell which one to go and fill in. Found by DRIVING the function against this campaign's own entry state |
| `33e5ae8` | a **bare-LF blank-line literal** in a document parse — LF in the worktree it was written in, CRLF in an ordinary Windows checkout of the identical tree hash, where `indexOf` answers `-1` and `slice(at, -1)` is the rest of the file. Found by reading `git ls-files --eol` and then driving the parse against a CRLF rendering |
| `fb43087` | an **ownership parse that read past its own section**, which claimed the operator's `objects.json` and `endpoint.json` as paths this tranche owns the moment the run record named them by shape. Found by installing the run record and running the suite — after three green sequences had already been taken from it |

**THE THIRD ONE IS THE EXPENSIVE SENTENCE AND IT IS THE ONE WORTH KEEPING.** Three complete sequences — about
two hours of host and development-host time — were thrown away because a suite inside the candidate carried a
latent parse defect that only the run record could expose. Keeping them would have meant publishing figures
from a tree that no longer exists, which is what §10.9 wrote about its own two superseded campaigns. **A
campaign that survives a repair to its own candidate is a campaign whose figures belong to no tree.**

### 13.6 THE RE-MEASUREMENT ON THE RECORD COMMIT, WHICH IS NOT A FOURTH SEQUENCE

Recorded so that "the record commit is documentation-only" is a **measurement** rather than an assertion —
§10.10's procedure, applied to §13.5's campaign.

**MEASURED ON COMMIT `2453ab5`**, the commit that carries §13.5 and the Phase 13 preparation document's §14,
and which differs from candidate `cdbad42` in **three documentation files and in nothing else**.

| | |
|---|---|
| `npx tsc --noEmit` | **clean** |
| Full offline inventory, **Git Bash** | **339 selected / 339 passed / 0 failed / 39 not selected / 0 required-but-skipped**, 745 s — `RESULT: PASS` |
| Full offline inventory, **an ordinary PowerShell** | **339 / 339 / 0 / 39 / 0**, 742 s — `RESULT: PASS` |
| `projection-phase9` / `projection-phase10` / `projection-phase11` / `projection-phase12` | 39/0 · 31/0 · 39/0 · 29/0 |
| `projection-phase13` / `projection-phase13-preentry` / `projection-phase13-preentry-gate-audit` | 30/0 · 42/0 · 76/0 |
| `projection-phase8-gate-audit` / `projection-phase9-gate-audit` / `projection-phase10-gate-audit` / `projection-phase11-gate-audit` | 17/0 · 19/0 · 29/0 · 56/0 |
| `projection-real-provider` / `torbox-resolver` / `torbox-boundary` | 75/0 · 84/0 (5 win32 blocks skipped) · 7/0 |
| `projection-bounded-recovery` — the OPERATOR SOURCE DIGEST | 52/0, **unmoved** |
| `custody-runtime-closure` / `projection-gate-embedded-programs` | 39/0 · 64/0 |
| working tree, entering and leaving | clean / clean |
| `phase9RequiresSoakRerun` over every path changed since `a8d7232` (26) and since `fe4c1fd` (12) | **FALSE** both times; **zero** `projectiond/` files changed |
| the eight provider source allowlist suites, diffed since `a8d7232` | **zero moved** |

**WHY IT IS IN THE COMMIT AFTER THE ONE IT MEASURES, AND THIS IS THE REGRESS ENDING RATHER THAN CONTINUING.**
The tree carrying §13.5 cannot also carry the figures produced by running against §13.5. So the record commit
is measured, its figures land in the next commit, which names the tree they belong to, and it stops there. **A
third commit measuring the second is not taken, and would prove nothing the second does not.**

**IT CLOSES NOTHING AND IS COUNTED IN NOTHING.** The host tier was not re-run on the record commit and no
figure in §13.5 depends on it. Its only job is to show that the documentation edits carrying this campaign's
record leave every suite that reads them green.

### 13.7 WHAT IS LEFT ON THE HOST, MEASURED AFTER EVERYTHING

| what | size | note |
|---|---|---|
| `/mnt/user/appdata/catalog-phase13-preentry-authorization` | 125 MB | this campaign's staging directory |
| `/mnt/user/appdata/catalog-phase12-closure` | 125 MB | **§10.8's, untouched.** Its preserved candidate was never at risk: the staging script's guard admits two literal markers and this campaign's directory carries the other one |
| `projectiond:phase13prep-frozen` | 10.3 MB | the image `216f1ae6…` was built into |
| `projectiond:phase12-frozen` | 10.3 MB | §10.8's, untouched |
| `golang:1.26` | 874 MB | **re-pulled by this campaign.** Sequence 1's preflight reported it ABSENT where §10.8 recorded it cached; the Phase 11 mixed gate runs the fake range origin through it. An image is not a container, a network or a volume, so it moves none of §13.5's SET figures — and it is named here rather than left to be found |

**Containers / networks / volumes: 46 / 18 / 47 — identical to how the campaign found them.** Zero
`projection-*` containers, no appliance container, no appliance network, **zero mountpoints** under the
staging directory. The two orchestration wrappers' own transcripts — 57 files across `/root` and
`/mnt/user/appdata` — were read off the host and **deleted**, along with the host-side runner script.

---

### 13.8 THE CANDIDATE RULE APPLIED AGAIN — `cdbad42` IS SUPERSEDED AS A PHASE 13 CANDIDATE

**§13.5 IS NOT DISTURBED, NOT RE-OPENED AND NOT SUPERSEDED BY THIS.** It records three consecutive fresh
complete sequences from `cdbad42bf04d4653af7ac26a6a00fa15087e7736`, and that record stands exactly as
written: it is a statement about `cdbad42` and it remains true of `cdbad42` whatever else lands. §10.9's GO
from `a8d7232` is untouched, as are §10.10, §13.6 and §13.7.

**WHAT HAPPENED, AND IT IS §13.3's OWN RULE APPLIED TO ITS AUTHOR.** An independent review of `b676b58`
reproduced three MEDIUM defects and three LOW ones in the Phase 13 authorization-prep tranche. Repairing them
moved **`src/core/projection/phase13.ts`** and **`test/projection-phase13.ts`**, and §13.5's own definition of
a complete sequence reads those bytes twice:

| arm | what it reads |
|---|---|
| **arm 9** — the full offline inventory, from Git Bash and from an ordinary PowerShell | selects `test/projection-phase13.ts`, which imports `src/core/projection/phase13.ts`. It is the reason the count is **339 rather than 338** |
| **arm 10** — the twelve suites run one by one | runs `projection-phase13` as one of the twelve |

§13.3 states the test in one sentence: a Phase 13 candidate may be `a8d7232`, **or a descendant whose only
differences are documents Phase 12's suites do not read.** A descendant that moves a module a suite imports
and the suite that imports it is **not** such a descendant. **So `cdbad42` has no Phase 13 GO to lend a tree
that no longer matches it, the series restarts at one, and two of the three sequences §13.5 records are not
two thirds of anything.** That sentence is §13.3's, and it is applied here to work done after §13.3 was
written rather than only to work done before it.

**WHAT MOVED BETWEEN `cdbad42` AND THE NEW CANDIDATE — five files, and every one of them named:**

| path | why it is or is not a sequence-invalidating change |
|---|---|
| `src/core/projection/phase13.ts` | **INVALIDATING.** `src/`, and imported by a suite arms 9 and 10 both run |
| `test/projection-phase13.ts` | **INVALIDATING.** A suite arms 9 and 10 both run, and one of arm 9's selected 339 |
| `docs/PROJECTION_PHASE_13_REAL_PROVIDER_ACCEPTANCE.md` | **INVALIDATING BY ITSELF ANYWAY** — `test/projection-phase13.ts` parses §5's tables, §6's and §7's rows, §13's ownership table and §14's status, so it is a document a suite reads |
| `docs/PROJECTION_PHASE_12_AUDIT_AND_PROVIDER_FREE_CLOSURE.md` | this section. §1–§12 untouched; §13.1–§13.7 untouched |
| `docs/PROJECTION_PHASE_13_PRE_ENTRY_INSTRUMENT_REPAIR.md` | its §13 residual list only |

**NO `projectiond/` FILE MOVED — zero — so the daemon image digest is expected to be `216f1ae6…` again, and
the sequences below are what say it rather than this sentence.** No gate script moved. No wrapper moved.
`phase13-preentry.ts` — the instrument §4's ninth refusal of the Phase 13 contract forbids this tranche to
touch — is **byte-identical**, which is why the repair to `originStabilityRefusals`'s missing pool refusal was
made at the **caller's** site instead.

**WHAT THIS AMENDMENT DOES NOT DO.** It does not declare Phase 12 NO-GO and it weakens nothing. Every one of
§5's eleven claims, every threshold in §5.4, every refusal in §4, §10 in its entirety, §11's audit, and
§13.1–§13.7 stand exactly as written. **No verdict of any tranche is written, moved, re-worded or narrowed by
this section. Phase 9's `P9-2`, `P9-3`, `P9-5` and `P9-11` stay OPEN. Phase 11 tier two stays OPEN and
`P11-R1` is NOT RUN. Phase 13 is NOT ENTERED**, and this section contacts nothing and runs nothing.

**THE NEW CANDIDATE IS THE COMMIT THAT CARRIES THIS SECTION**, and its own three sequences are recorded in a
later section measured after they ran, never before. **Until that record exists, no candidate carries a Phase
12 GO of its own and Phase 13 entry criterion E4 is NOT MET.**

### 13.9 THE CURRENT CANDIDATE — the sequence, three consecutive fresh times, from `96f750c`

**§10.9, §13.5, §13.6 AND §13.7 ARE NOT DISTURBED, NOT RE-OPENED AND NOT SUPERSEDED BY THIS.** Each is a
statement about the commit it names and each remains true of that commit. This section answers the question
§13.8 raises — what the candidate carrying the Phase 13 repair tranche can say for itself — and its only
consumer is Phase 13's entry criterion **E4**.

**THE CANDIDATE IS `96f750c628a69493569ba1e7a6dfed5ae7655ffd`.** It was staged **three separate times**, once
at the head of each sequence, and each staging proved **0 files differing and 0 text files carrying a CR** on
either side against `git archive` of that commit with the working-tree conversion disabled.

**THE DAEMON IMAGE DIGEST IS `sha256:216f1ae6f298781b34b0855f1b5201d5db51eec816b8ccf894876797a7a21a46` IN ALL
THREE — THE SAME DIGEST `a8d7232`, `cdbad42`, `61445f2` AND `8be98c2` PRODUCED.** That is the sentence that
says no daemon byte moved across the repair either. `projectiond/` is untouched, and the image built from the
staged tree proves it rather than asserting it.

**THE TEN ARMS ARE §13.5's, UNCHANGED, AND NO ARM WAS SKIPPED, FOLDED OR OMITTED IN ANY OF THE THREE.**

| | sequence 1 | sequence 2 | sequence 3 |
|---|---|---|---|
| staged files differing / text files with a CR | 0 / 0 | 0 / 0 | 0 / 0 |
| daemon image digest | `216f1ae6…` | `216f1ae6…` | `216f1ae6…` |
| `projection-phase10-rehearsal.sh` | exit 0, 31 s | exit 0, 31 s | exit 0, 31 s |
| `projection-phase11-mixed-gate.sh` | exit 0, 62 s | exit 0, 63 s | exit 0, 63 s |
| `go:phase10-rehearsal:three` | exit 0, 93 s | exit 0, 93 s | exit 0, 92 s |
| `go:phase11-mixed-gate:three` | exit 0, 188 s | exit 0, 187 s | exit 0, 187 s |
| `alpha-acceptance` / `real-provider --fake` / `publisher-mount` / `restart-topology` | exit 0 × 4 (34 / 26 / 101 / 66 s) | exit 0 × 4 (35 / 26 / 101 / 66 s) | exit 0 × 4 (35 / 26 / 101 / 66 s) |
| host containers / networks / volumes, before → after | 46 / 18 / 47 → 46 / 18 / 47 | same | same |
| **SET membership** — names present before and absent after, per kind | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| names ADDED, per kind — measured as well, because a count is satisfied by a removal and a creation | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| full `docker ps -a` rows (id, name, state, created) differing | 0 | 0 | 0 |
| mountpoints under the staging directory, after | 0 | 0 | 0 |
| `projection-*` containers after; appliance container; appliance network | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| `endpoint.json` under the appliance's own path | absent before, absent after | absent, absent | absent, absent |
| ports 5670 / 5680 / 8300 / 5580 / 8140, after | all free | all free | all free |
| `npx tsc --noEmit` | clean, 9 s | clean, 8 s | clean, 8 s |
| offline inventory, **Git Bash** | **339 / 339 / 0 failed / 39 not selected / 0 required-but-skipped**, 762 s | 339 / 339 / 0 / 39 / 0, 733 s | 339 / 339 / 0 / 39 / 0, 765 s |
| offline inventory, **an ordinary PowerShell** | **339 / 339 / 0 / 39 / 0**, 766 s | 339 / 339 / 0 / 39 / 0, 749 s | 339 / 339 / 0 / 39 / 0, 783 s |
| working tree, entering and leaving each sequence | clean / clean | clean / clean | clean / clean |
| host half, end to end | 604 s | 605 s | 604 s |

**All six inventory arms report `RESULT: PASS — every selected suite ran and exited zero`,** and the **39 not
selected** are the Docker-only acceptance suites the default run has always excluded. "Not selected" is not
"skipped". The count is **339**, unchanged: this tranche adds no suite and removes none.

**THE PREFLIGHT SAID THE SAME THING THREE TIMES, BEFORE ANYTHING WAS CREATED:** no appliance container, no
`projection-alpha` network, ports 5670 / 5680 / 8300 all free, `/dev/fuse` reachable from a container, and the
staging directory on `/mnt/user`, `fuse.shfs`, propagation **`shared`**.

#### The twelve suites of arm 10, identical in all three sequences

`projection-phase10` 31/0 · `projection-phase11` 39/0 · `projection-phase12` 29/0 ·
`projection-phase10-gate-audit` 29/0 · `projection-phase11-gate-audit` 56/0 ·
`projection-phase13-preentry` 42/0 · `projection-phase13-preentry-gate-audit` 76/0 ·
`projection-phase13` **42/0** — thirty before the repair tranche, and the twelve new checks are named in
Phase 13 §14.5 — · `projection-real-provider` 75/0 · `torbox-resolver` 84/0 (5 win32 blocks skipped) ·
`projection-bounded-recovery` 52/0 — the OPERATOR SOURCE DIGEST, **unmoved** — · `custody-runtime-closure` 39/0.

#### The closure functions, run rather than summarised

The shipped functions were given this campaign's verdicts. Every verdict started at `skip` and was moved only
by an exit code a shipped command produced.

| function | over this campaign | the control, and it is DRIVEN rather than asserted |
|---|---|---|
| `phase10ClosureProblems` | **0 problems** | two sequences rather than three → **1 problem** |
| `phase11ClosureProblems` (tier one) | **0 problems** | the same evidence offered as **tier two** → **4 problems** |
| `phase12ClosureProblems` | **0 problems** | two sequences rather than three → **1**; one verdict moved to `skip` → **2** |
| `phase13PreEntryClosureProblems` | **0 problems** | one verdict moved to `skip` → **2 problems** |
| `phase13ClosureProblems` | **12 problems** | the mode is not `real`, and **each of the eleven claims has no verdict**. It is the function REFUSING TO CLOSE ANYTHING, which is the correct answer for a phase that has not run |

#### What this DOES and DOES NOT say

**IT SAYS** the candidate `96f750c` carries a complete Phase 12 provider-free sequence of its own, three
consecutive fresh times, zero skips, on the operator's real Unraid host — so Phase 13's entry criterion **E4**
is satisfied **by this candidate** rather than inherited from another one.

**IT DOES NOT SAY** anything about a provider. **NO PROVIDER, CDN, RESOLVER, INDEXER, NNTP SERVER, MEDIA
SERVER OR PRODUCTION CONTAINER WAS CONTACTED.** No credential was read for value, printed, written into
evidence or rotated. `endpoint.json` was not read for value, not written, and its `allowedOrigins` was not
widened, reordered or edited. **Phase 13 is NOT ENTERED and NOT RUN**, and every claim of §5 of the Phase 13
contract is **unrecorded**. `P11-R1` is NOT RUN and has no half. Phase 9's `P9-2`, `P9-3`, `P9-5` and `P9-11`
stay OPEN. Phase 11 tier two stays OPEN. **Phase 14 and Phase 15 are NOT ENTERED.**

`phase9RequiresSoakRerun` is **FALSE** over every path changed since `a8d7232` (26), since `fe4c1fd` (12),
since `cdbad42` (5) and since `b676b58` (5); **zero** `projectiond/` files changed on any of those sets; and
**zero** of the eight provider source allowlist suites moved.

#### What is left on the host after this campaign

| what | size | note |
|---|---|---|
| `/mnt/user/appdata/catalog-phase13-preentry-authorization` | 125 MB | this campaign's staging directory, the same one §13.7 names, re-staged three times and left holding the new candidate |
| `/mnt/user/appdata/catalog-phase12-closure` | 125 MB | **§10.8's, untouched** |
| `projectiond:phase13prep-frozen` | 10.3 MB | rebuilt three times, `216f1ae6…` every time |
| `projectiond:phase12-frozen` | 10.3 MB | §10.8's, untouched |
| `golang:1.26` | 874 MB | **re-pulled by this campaign.** All three preflights reported it ABSENT; the Phase 11 mixed gate runs the fake range origin through it. An image is not a container, a network or a volume, so it moves none of the SET figures above — and it is named here rather than left to be found |

**Containers / networks / volumes: 46 / 18 / 47 — identical to how the campaign found them.** Zero
`projection-*` containers, no appliance container, no appliance network, **zero mountpoints** under the
staging directory, all five gate ports free, and `endpoint.json` absent under the appliance path. The
campaign's own host-side runner script and its three transcripts, and the eight per-arm gate logs it wrote
under `/mnt/user/appdata`, were read off the host and **deleted**; `/root` holds nothing dated later than
2026‑08‑15.

### 13.10 THE RE-MEASUREMENT ON THE RECORD COMMIT, WHICH IS NOT A FOURTH SEQUENCE

**IT CLOSES NOTHING AND IS COUNTED IN NOTHING**, exactly as §13.6 is. The host tier was **not** re-run and no
figure in §13.9 depends on it. Its only job is to show that the documentation edits carrying §13.9 and Phase
13 §14.6 leave every suite that reads them green.

**The commit measured is `5d80dd01460903953310e55bb9530671196747c5`.**

| | |
|---|---|
| `npx tsc --noEmit` | **clean**, 10 s |
| full offline inventory, **Git Bash** | **339 / 339 / 0 failed / 39 not selected / 0 required-but-skipped**, 777 s — `RESULT: PASS` |
| full offline inventory, **an ordinary PowerShell** | **339 / 339 / 0 / 39 / 0**, 782 s — `RESULT: PASS` |
| `projection-phase8-gate-audit` / `projection-phase9` / `projection-phase9-gate-audit` | 17/0 · 39/0 · 19/0 |
| `projection-phase10` / `projection-phase10-gate-audit` | 31/0 · 29/0 |
| `projection-phase11` / `projection-phase11-gate-audit` / `projection-phase12` | 39/0 · 56/0 · 29/0 |
| `projection-phase13` / `projection-phase13-preentry` / `projection-phase13-preentry-gate-audit` | **42/0** · 42/0 · 76/0 |
| `projection-real-provider` / `torbox-resolver` / `torbox-boundary` | 75/0 · 84/0 (5 win32 blocks skipped) · 7/0 |
| `projection-bounded-recovery` — the OPERATOR SOURCE DIGEST | 52/0, **unmoved** |
| `custody-runtime-closure` / `projection-gate-embedded-programs` | 39/0 · 64/0 |
| working tree, entering and leaving | clean / clean |
| `phase9RequiresSoakRerun` over every path changed since `a8d7232` (26), `fe4c1fd` (12), `cdbad42` (5) and `b676b58` (5) | **FALSE** on all four; **zero** `projectiond/` files changed |
| the eight provider source allowlist suites, diffed since `a8d7232` | **zero moved** |

**AND THE REGRESS ENDS HERE, FOR §13.6's REASON.** The tree carrying §13.9 cannot also carry the figures
produced by running against §13.9, so the record commit is measured and its figures land in the next commit,
which names the tree they belong to. **A third commit measuring the second is not taken, and would prove
nothing the second does not.**

### 13.11 THE CANDIDATE RULE APPLIED AGAIN — `96f750c` IS SUPERSEDED

An independent review of record commit `2e51127` reproduced numeric evidence that fails open in the Phase 13
entry, closure and exit functions. Repairing it necessarily changes the Phase 13 contract, its shipped module
and the suite selected by arms 9 and 10 of this sequence. Therefore candidate `96f750c` and the three-sequence
record in §13.9 remain true historical records about that commit, but **do not transfer** to a descendant
carrying this repair.

**THE SERIES RESTARTS AT ONE.** Until a later commit freezes the complete repair and the ten-arm provider-free
sequence runs from that exact commit three consecutive fresh times with zero skips and no reused evidence,
**NO NEW CANDIDATE CARRIES A PHASE 12 GO OF ITS OWN AND PHASE 13 E4 IS NOT MET.** No historical commit or run
record is rewritten by this amendment.
