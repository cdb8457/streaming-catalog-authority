# Projection Phase 11 — MIXED-SOURCE ACCEPTANCE

**Status: AUTHORIZED, NOT BUILT, NOT RUN.** This document is the contract. It is committed **before** anything
is built against it, for the reason Phase 6 §11.1.1 records: a threshold written down after the run that
measured it is not a threshold, it is a description.

**AND IT IS A TWO-TIER CONTRACT, WHICH IS THE ONE THING A READER MUST TAKE FROM IT BEFORE ANYTHING ELSE.**
Phase 10 §8.1 authorised exactly one kind of Phase 11 closure and forbade the other:

> Phase 11 — the mixed-source acceptance gate — may later close **only its provider-free instrument tier**. A
> tier-one GO is a GO **on the instrument**: it says the gate exists, can fail, and reached every arm in fake
> mode. **It closes nothing about the mixed product.**

That sentence is the ceiling on everything below, and §5 turns it into a rule a function enforces rather than a
paragraph a reader is trusted to remember.

---

## 1. Product outcome

An operator has an appliance serving one namespace. Phase 9 gave that namespace the ability to hold files a
Usenet worker produced alongside objects a provider serves by range. Phase 10 gave the operator a way to put
either kind into it and a way to be told when the namespace and the disk have stopped agreeing.

**Nothing has ever asked whether the two halves survive each other under acceptance conditions.** Phase 9's
§5.4 mixed-manifest claim was answered by a provider-free rehearsal against an in-memory namespace; its §5.5
claim — three real media servers scanning and reading both — is one of the four still open. Phase 10 built a
control plane and deliberately started no daemon at all: its compose file says so in its own comment, *"a
daemon would be something to read the result WITH, and reading the result is Phase 11's question."*

**Phase 11 is that question.** Can one mount, owned by one appliance, present a generation holding both a
provider-backed entry and an admitted-Usenet local entry, such that each is readable **for what it is**, and
such that a failure of either source moves **nothing at all** about the other?

**And Phase 11 answers it in two tiers, because only one of them can be answered without an operator.**

---

## 2. What this tranche decides, and what it refuses to decide

### 2.1 There is no instrument for the mixed question, and that is the whole gap

Phase 9's rehearsal drives a fake SABnzbd and publishes into `createRehearsalNamespace` — an **in-memory**
namespace with no database, no mount, no daemon and no reader. Phase 10's rehearsal drives a real migrated
PostgreSQL through the shipped content plane and starts **no appliance**. The real-provider gate mounts and
reads, but its corpus is TorBox-shaped only: there is no `local` entry in it and no worker anywhere near it.

So every component of the mixed answer exists and **nothing composes them**. That is not a defect in any of
the three; it is the seam between them, and a seam nobody has stood on is a seam nobody knows the strength of.

### 2.2 What a fake-mode run can honestly establish, and what it cannot

A gate driving a fake range origin and a fake SABnzbd-compatible worker can establish that **the instrument
exists, reaches every arm it declares, and can fail**. It cannot establish anything about a real provider's
timing, a real NNTP article's arrival, a real indexer's naming, or what Plex, Jellyfin and Emby do when they
scan a directory holding both kinds. A fake worker that always completes is not evidence about a worker that
sometimes does not.

**Therefore the closure rule has two tiers and they may not be averaged.** §5 lists ten tier-one claims and
four tier-two claims, and `phase11ClosureProblems` refuses a tier-two verdict that carries `fake: true`
exactly as `phase9ClosureProblems` refuses a rehearsal verdict on a provider-required claim.

### 2.3 The mount point still has exactly one owner, and it is not this tranche

Phase 8 §13's ownership rule survives unchanged. **This tranche starts no daemon of its own, writes no
Compose service for one, and never mounts, binds, unmounts or writes inside the mount point.** Where the gate
needs an appliance it invokes **`deploy/projection-alpha.sh`** — the shipped operator script, with the
environment contract an operator would set — and where it needs a namespace it invokes
**`deploy/projection-content.sh`**, the content plane Phase 10 built and Phase 10's own independent audit
repaired in nine places. §4's fourth refusal is that rule as a refusal, and §6.3 is it as a file list.

### 2.4 The Phase 9 prerequisite is inherited, not discharged

Phase 10 §8 records that Phase 9's four open live claims must be run from a Phase 10-or-later candidate.
**Phase 11 does not discharge that prerequisite and does not touch those claims.** `P9-2`, `P9-3`, `P9-5` and
`P9-11` are exactly as open after this document as before it, and §4's second refusal forbids this tranche
from closing, partially satisfying, re-labelling or re-wording any of them.

---

## 3. Deliverables

### 3.1 Architecture decision — a gate that composes shipped commands, and owns no product surface

Phase 11 **adds no product source at all.** No new module under `src/core/`, no new operator verb, no new CLI,
no change to the content plane, the publisher, the admission path or the daemon. Everything it ships is an
**instrument**: a rules module the gate is measured against, a gate, its two wrappers, a Compose file for the
throwaway database, and two offline suites.

Three reasons, in descending order of force:

1. **The product surface the mixed question needs already exists and is closed.** `add-torbox` registers an
   `http-range` source; `add-local` registers a `local` one; `publish` mints a generation; `projection-alpha.sh`
   mounts and serves it. A tranche that added a "mixed" verb would be adding a fourth way to do what three
   already do, and the fourth is the one nothing else is tested against.
2. **Every path this tranche could add to the product is a path on somebody else's soak.** §4's sixth refusal
   and `phase9RequiresSoakRerun` are the check; a tranche that ships no product source cannot trip it.
3. **The gap §2.1 names is a composition gap.** The honest repair for a composition gap is a composition, and
   a composition belongs in a gate.

### 3.2 The deliverables

| id | Deliverable |
|---|---|
| **D11.1** | **`src/core/projection/phase11.ts`** — the tranche's rules as code: the fourteen claim ids of §5 in the document's order, the two tiers, the six predeclared arms of §5.2, every threshold either IMPORTED from the closed tranche it came from or NEW and named as new, and `phase11ClosureProblems`, which is what decides whether a run closed. Nothing in it imports a gate, touches a filesystem or contacts anything. |
| **D11.2** | **`deploy/projection-phase11-mixed-gate.sh`** — the mixed-source acceptance gate. It runs the six arms of §5.2 against a **fake** range origin and a **fake** SABnzbd-compatible worker, driving **`deploy/projection-alpha.sh`** for the appliance and **`deploy/projection-content.sh`** for the namespace. Every verdict it emits is stamped `fake=true`. Exit 0 when every arm passed, 1 when any failed, **77 when this host cannot run it at all** — which is a SKIP and is not a pass. |
| **D11.3** | **`deploy/projection-phase11-mixed-gate-three.sh`** and **`-optional.sh`** — the repetition wrapper and the skip-folding entry point, in the shape every gate in this repository already uses. Runs are COUNTED; the closing message is guarded by the count; a 77 propagates as 77 rather than being folded; the fold into zero is a separate entry point somebody has to type. |
| **D11.4** | **`docker-compose.projection-phase11.yml`** — a throwaway PostgreSQL on host port **5680**, `tmpfs` data directory, its own project and network, pinned by digest. Cross-checked against every other Compose file in the repository by `test/projection-phase11.ts` rather than trusted from a comment. **No daemon service, no worker service, no media server, no provider, and `endpoint.json` neither mounted nor named.** |
| **D11.5** | **`test/projection-phase11.ts`** — the tranche's own rules, offline: that every threshold is the value the tranche it claims to come from holds, read from that module; that the fourteen claims are the document's fourteen in the document's order; that the two tiers are a partition; that a **fake** verdict cannot close a tier-two claim; that a skip, a duplicate, a short run or a self-supplied budget is not success; that this tranche does not re-open the Phase 8 soak, asserted by RUNNING `phase9RequiresSoakRerun`; and that the ownership boundary of §2.3 held. |
| **D11.6** | **`test/projection-phase11-gate-audit.ts`** — the adversarial audit, following `test/projection-phase10-gate-audit.ts`'s **call-graph** model over the shipped bytes, with the shell chosen by EXECUTION through `test/posix-shell-kit.ts` rather than by name. It pins the classes of defect that survive `bash -n`: a function defined and never called, a variable read under `set -u` that nothing sets, a verdict id §5 does not name, an arm the gate stopped recording, an id recorded twice, a wrapper that runs something other than what it names, and an accounting loop that can announce a sequence it did not complete. **Every structural check has a CONTROL that tampers a copy and asserts the audit FAILS.** |
| **D11.7** | **`package.json` and `test/suite-inventory.json`** — new scripts and new offline suites only. No existing script's meaning changes. |
| **D11.8** | **NOT PHASE 11 SCOPE, RECORDED SO NOBODY CONCLUDES IT WAS FORGOTTEN.** The tier-two runs of §5's `P11-R*` claims. They need operator TorBox credentials, an operator SABnzbd with a real NNTP provider configured in it, at least one NZB the operator is entitled to, and three real pre-attached media servers. Nothing in this repository can build, fake or infer any of those, and §4's third refusal forbids a fake run from claiming one. |

### 3.3 The fake arm, and exactly what stands in for what

| what a real run has | what the fake arm uses | what it therefore cannot say |
|---|---|---|
| a TorBox endpoint serving objects by HTTP range | `projectiond/cmd/fakerange`, run as `go run` inside the pinned Go image, on loopback port **8300**, emitting its own object descriptor — the same fake every other gate in this repository builds | nothing about a real CDN pool, a rotating origin allowlist, a real token, or provider-side rate limiting |
| an operator's SABnzbd with a real NNTP provider behind it | `startFakeSabnzbd` from `src/core/usenet/sab-fake-service.ts`, on an ephemeral loopback port, driven through the shipped Phase 9 command path | nothing about a real article, a real repair, a real unpack, a real failure, or a job that arrives incomplete |
| the operator's own media | bytes synthesised **in the gate's own run directory** by a heredoc-written helper, never all one value so that a probe window over them is a meaningful digest | nothing about media identity, naming, or what a real library looks like |
| three real pre-attached media servers | **NOTHING. There is no stand-in and none is simulated.** | §5's `P11-R2` in its entirety |

**THE FOURTH ROW IS THE IMPORTANT ONE.** Phase 9's §5.5 is open for the same reason and Phase 10 did not
attempt it either. A gate that started three containers and called them media servers would be a gate whose
green run says something true about containers and nothing at all about Plex.

---

## 4. Hard refusals

Phase 11 shall not:

1. add a source kind, a manifest field, a schema version, a degraded reason or a divergence code — Phase 10
   §3.3's six divergence codes stay six and Phase 9's six job states stay six;
2. close, partially satisfy, re-label or re-word **P9-2, P9-3, P9-5 or P9-11**, edit
   `docs/PROJECTION_PHASE_9_TORBOX_USENET.md`, or edit `src/core/projection/phase9.ts`;
3. **record a tier-two verdict from a fake run, in any form** — not as a pass, not as a partial, not as a
   "measured under fake conditions". `phase11ClosureProblems` refuses it, and the gate's own emittable set
   structurally cannot contain one;
4. **start a second daemon, write a Compose service for one, or mount, bind, unmount or write inside the
   projection mount point** — where an appliance is needed the gate invokes `deploy/projection-alpha.sh`, and
   one mount point keeps exactly one owner;
5. modify `deploy/projection-alpha.sh`, its two helper programs, `deploy/projectiond-alpha.env.example` or
   `docker-compose.projection-alpha.yml` — the OPERATOR SOURCE DIGEST is unmoved and
   `test/projection-bounded-recovery.ts` is what checks it;
6. modify any path on `PHASE9_SOAK_TRIGGERING_SOURCE`, so `phase9RequiresSoakRerun` over this tranche's own
   changed-path set is FALSE and **the Phase 8 soak is not re-run**;
7. contact a real TorBox endpoint, a real CDN origin, an indexer, an operator's SABnzbd, an NNTP server or a
   media server — **it is provider-free by construction, and `endpoint.json` is not read, not written and not
   touched at any point**, with its mtime recorded before and after;
8. modify `projectiond/`, any Phase 7, 8, 9 or 10 gate script, any closed tranche's run record, or
   `src/core/projection/phase10.ts`'s closure logic — Phase 11 **imports** Phase 10's thresholds and does not
   re-derive them;
9. place a credential, an NZB or indexer URL, an article id, a completed source path, a provider object
   reference, a media identity or an arbitrary OS error string in any emitted document — `SealedValue` and
   `assertSealedSafe` are **reused** rather than re-implemented;
10. delete media, a worker's history or operator input — Phase 9 §4's fifth refusal, imported unchanged;
11. degrade, retire, delete, publish or restore anything without an explicit operator verb or an explicit
    operator flag — Phase 10 §4's second refusal, imported unchanged;
12. claim Real-Debrid, a second host, high availability, a load figure, an uptime figure or a production
    release.

---

## 5. Closure rule — two tiers, fourteen claims, and only one tier is reachable without an operator

The phase's **tier one** is GO only when **one frozen candidate** demonstrates all ten of `P11-M*` and
`P11-S*`. The phase's **tier two** is GO only when one frozen candidate demonstrates all four of `P11-R*`
against real operator inputs, and **no tier-one result contributes to that verdict**.

### 5.1 Tier one — the instrument. Provider-free, and every claim is answerable on one host.

| id | Claim | Kind |
|---|---|---|
| **P11-M1** | one published generation holds at least one provider-backed `http-range` entry and at least one `local` entry a fake worker produced, assembled through **shipped verbs only** | arm — provider-free |
| **P11-M2** | each half is readable through the **one** mount `projection-alpha.sh` owns, **for what it is**: the `local` half from disk with the fake origin's counters unmoved, the `http-range` half by range against the fake origin with its counters moved | arm — provider-free |
| **P11-M3** | publishing a generation that adds one half leaves **every recorded field** of the other half's entry identical, and its bytes through the mount identical | arm — provider-free |
| **P11-M4** | a failure injected into ONE source — the range origin stopped, then the worker's completed file removed — disturbs **ZERO** recorded fields of the other source's entry, and the other half stays readable | arm — provider-free — **MEASURED** against `CROSS_SOURCE_FIELDS_DISTURBED_MAX` |

**WHAT "EVERY RECORDED FIELD" IS, NAMED HERE RATHER THAN LEFT TO THE GATE TO CHOOSE.** The six the shipped
`status --json` surface carries per entry: `path`, `kinds`, `sizeBytes`, `visibility`, `degradedReason` and
`publication`. A gate that picked its own subset would be a gate whose zero is about the fields it felt like
comparing, so the comparison is over the **whole record**, and a field present in one capture and absent from
the other counts as moved.

**THE LOCATOR IS DELIBERATELY NOT AMONG THEM, AND THAT IS A REFUSAL RATHER THAN A GAP.** §4's ninth refusal
keeps a provider object reference out of every emitted document, so the shipped status surface does not carry
one — and a gate that diffed a locator would first have to put that reference into its own evidence, which is
the exact thing `P11-M6` asserts no preserved file does. The two claims cannot both be satisfied, and this
contract chooses the refusal. What a moved locator would break — the bytes a media server reads — is covered
directly instead: `P11-M3` and `P11-M4` both re-read the other half **through the mount** and compare its
bytes.
| **P11-M5** | the whole mixed sequence needs **zero** hand-run commands and **zero** operator interventions, and nothing publishes implicitly — an `add` without `--publish` mints no generation | arm — provider-free |
| **P11-M6** | **every arm this gate declares was REACHED**; cleanup leaves zero phase-owned containers, networks and volumes, asserted from inside the run; and no preserved evidence carries a secret, a URL, an origin, a path or a media identity | arm — provider-free — **MEASURED** against `UNREACHED_ARMS_MAX` |
| **P11-S1** | the full offline inventory passes on the development host with every Phase 11 suite in it, from **Git Bash** and from **an ordinary PowerShell** | sequence-level — provider-free |
| **P11-S2** | `go:phase11-mixed-gate:three` — three consecutive fresh runs, exit 0, **zero skips**, on the real Unraid host | sequence-level — provider-free — measured against `CONSECUTIVE_FRESH_RUNS` |
| **P11-S3** | the provider-free regression subset is green from that one candidate: `alpha-acceptance`, `real-provider-gate --fake`, `publisher-mount`, `restart-topology`, `phase10-rehearsal:three` | sequence-level — provider-free |
| **P11-S4** | the complete tier-one sequence passes **three consecutive fresh** times | sequence-level — provider-free — measured against `CONSECUTIVE_FRESH_RUNS` |

### 5.2 Tier two — the mixed PRODUCT. Not reachable without an operator, and NOT RUN.

| id | Claim | What only the operator can supply |
|---|---|---|
| **P11-R1** | a **real** TorBox object and a **real** Usenet-admitted file sit in one published generation on the appliance | TorBox credentials and an entitled object; a SABnzbd with a real NNTP provider configured in it; one NZB the operator is entitled to |
| **P11-R2** | **Plex, Jellyfin and Emby** each scan and read **both** entries through their existing pre-attached binds | three real, already-attached media servers |
| **P11-R3** | a **real** provider outage — the TorBox origin, then the worker — leaves the other half readable and the mounted namespace stable | a real provider whose outage can be induced or waited for |
| **P11-R4** | the complete mixed-product sequence passes **three consecutive fresh** times | all of the above, three times |

**NOT ONE OF THESE FOUR IS ANSWERABLE BY THIS TRANCHE, AND THE GATE CANNOT EMIT AN ID FOR ONE.** §4's third
refusal is the rule; `PHASE11_FAKE_EMITTABLE_GATE_IDS` is the rule as a list; `phase11ClosureProblems` is the
rule as a function; and `test/projection-phase11-gate-audit.ts`'s multiset check over the shipped bytes is the
rule as an assertion about the script that actually runs.

### 5.3 Thresholds

Every imported threshold names the tranche it came from and is READ FROM THAT MODULE rather than restated.
Every NEW one is new because no earlier tranche could have measured it.

| name | value | source |
|---|---|---|
| `CONSECUTIVE_FRESH_RUNS` | 3 | IMPORTED — `PHASE10_RULES.CONSECUTIVE_FRESH_RUNS`, itself Phase 9 ← Phase 8 ← Phase 3 |
| `OPERATOR_INTERVENTIONS_MAX` | 0 | IMPORTED — `PHASE10_RULES.OPERATOR_INTERVENTIONS_MAX` |
| `RESIDUE_MAX` | 0 | IMPORTED — `PHASE10_RULES.RESIDUE_MAX` |
| `HAND_RUN_COMMANDS_MAX` | 0 | IMPORTED — `PHASE10_RULES.HAND_RUN_COMMANDS_MAX` |
| `GENERATION_BYTES_CHANGED_BY_REPORT_MAX` | 0 | IMPORTED — `PHASE10_RULES.GENERATION_BYTES_CHANGED_BY_REPORT_MAX` |
| `ADMISSIONS_WITHOUT_DRIFT_CHECK_MAX` | 0 | IMPORTED — `PHASE10_RULES.ADMISSIONS_WITHOUT_DRIFT_CHECK_MAX` |
| `MIN_TORBOX_ENTRIES` | 1 | IMPORTED — `PHASE9_RULES.MIN_TORBOX_ENTRIES` |
| `MIN_ADMITTED_USENET_ENTRIES` | 1 | IMPORTED — `PHASE9_RULES.MIN_ADMITTED_USENET_ENTRIES` |
| `CROSS_SOURCE_FIELDS_DISTURBED_MAX` | **0** | **NEW.** §1's question as a number. No earlier tranche could measure it because no earlier tranche composed the two sources under one mount. |
| `UNREACHED_ARMS_MAX` | **0** | **NEW.** Phase 10 §8.1 authorises a tier-one GO only if the gate *"reached every arm in fake mode"*. An arm nobody reached is the Phase 8 defect that cost six hours, and this is the number that makes the authorised sentence checkable. |
| `TIER_TWO_IDS_EMITTABLE_BY_A_FAKE_RUN` | **0** | **NEW.** §4's third refusal as a number a run records, and the multiset the audit checks the shipped script against. |

**A CLAIM WITH NO BUDGET IN THIS TABLE HAS NOTHING TO MEASURE**, and a run that supplies a measurement for one
has invented a budget. `phase11ClosureProblems` refuses both directions.

### 5.4 The six predeclared arms, and why they are predeclared

The arm ids are `P11-M1` … `P11-M6` and they are **fixed by this document before the gate exists.** A gate
that chose its own arms at run time would be a gate whose green run is a statement about the arms it felt like
running, and `UNREACHED_ARMS_MAX = 0` would be unmeasurable because there would be no denominator.

The gate emits `ARM <id> reached` at the **start** of each arm and a `VERDICT <id> <outcome> fake=true` at its
end. **REACHED IS NOT PASSED**, and the distinction is the whole of `P11-M6`: an arm that ran and failed is
evidence; an arm a conditional jumped over is the absence of evidence wearing the same colour as a pass.

---

## 6. File ownership, so two dispatches cannot collide

### 6.1 Phase 11 owns, new

`docs/PROJECTION_PHASE_11_MIXED_SOURCE_ACCEPTANCE.md`, `src/core/projection/phase11.ts`,
`deploy/projection-phase11-mixed-gate.sh`, `deploy/projection-phase11-mixed-gate-three.sh`,
`deploy/projection-phase11-mixed-gate-optional.sh`, `docker-compose.projection-phase11.yml`,
`test/projection-phase11.ts`, `test/projection-phase11-gate-audit.ts`.

### 6.2 Phase 11 modifies, bounded

| File | Change |
|---|---|
| `package.json` | new scripts only. No existing script's meaning changes. |
| `test/suite-inventory.json` | two new offline suites only. |

**AND NOTHING ELSE. THIS TRANCHE SHIPS NO PRODUCT SOURCE.** §3.1 is the reason; this table is the check.

### 6.3 Phase 11 must not touch

`deploy/projection-alpha.sh` and its two helper programs; `deploy/projectiond-alpha.env.example`;
`docker-compose.projection-alpha.yml`; `deploy/projection-content.sh`; `src/ops/projection-content.ts`;
`src/ops/projection-content-cli.ts`; anything on `PHASE9_SOAK_TRIGGERING_SOURCE`; `projectiond/`; any Phase 7,
8, 9 or 10 gate script or run record; `docs/PROJECTION_PHASE_9_TORBOX_USENET.md`;
`docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md`; `src/core/projection/phase7.ts`, `phase8.ts`,
`phase9.ts`, `phase10.ts`.

---

## 7. Risks, named here rather than discovered later

| id | Risk | Mitigation, decided now |
|---|---|---|
| **R1** | A tier-one GO gets quoted as "mixed source works". | The tier-one claim ids all begin `P11-M` or `P11-S`, the gate stamps every verdict `fake=true`, the closing message names all four `P11-R*` as still open, and `test/projection-phase11-gate-audit.ts` asserts it does. §8 is the sentence a roadmap row may write and may not exceed. |
| **R2** | The gate needs an appliance and a mount, and the easy way to get one is to mount it. | §4's fourth refusal. The gate invokes `deploy/projection-alpha.sh` and the audit asserts the shipped bytes contain no `mount`, `umount`, `fusermount` or `mount --bind` invocation of their own. One mount point, one owner, still `projection-alpha.sh`. |
| **R3** | `UNREACHED_ARMS_MAX` becomes a constant the run cannot fail, which is Phase 10's own audit defect #7 exactly. | The count is derived from the run's `ARM … reached` markers against `PHASE11_ARM_GATE_IDS` read from the module, and the audit carries a control that removes a marker from a copy and asserts the count moves. A number a run cannot fail to meet is not a measurement. |
| **R4** | `CROSS_SOURCE_FIELDS_DISTURBED_MAX` is declared rather than diffed. | The gate captures the other half's record to a file before each injection and diffs it field by field afterwards with a heredoc-written helper that prints a count. The audit's control tampers a captured record and asserts the count moves. |
| **R5** | The fake range origin needs a Go toolchain, and a host without one produces a red run that is about the host. | It is a **precondition checked before anything is created**, and failing it is a **77 SKIP**, not a failure — Phase 10 §11.5's seventh defect, imported as a design rule. A red run caused by which machine it was launched on is not a verdict about the product. |
| **R6** | Port 8300 or 5680 is taken by another gate, and two gates lend each other state. | `test/projection-phase11.ts` cross-checks both against every other Compose file and every other deploy script in the repository, rather than trusting §5's comment. |
| **R7** | The gate grows a second daemon "just for reading". | §4's fourth refusal, §6.3's file list, and the Compose file that has one service in it. A daemon service added to `docker-compose.projection-phase11.yml` fails `test/projection-phase11.ts`. |

---

## 8. What Phase 11 does NOT close, and the sentence a roadmap row may not exceed

**It closes no Phase 9 claim.** `P9-2`, `P9-3`, `P9-5` and `P9-11` are exactly as open as Phase 10 left them,
and Phase 10 §8's prerequisite — that they be run from a Phase 10-or-later candidate — is inherited unchanged.

**It closes no Phase 10 claim.** Not one of Phase 10 §5's ten is answered here, and §11.7.4 of that document
still says what it says: the Phase 10 rehearsal has never run end to end on any host.

**It closes nothing about the mixed product.** A tier-one GO is a GO **on the instrument**. The sentence a
Phase 11 roadmap row may write, and must not exceed, is Phase 10 §8.1's own:

> *what is missing is a run rather than a gate.*

It is **one host**. It is not a soak, a load test, an uptime claim, an availability claim, a second host, high
availability or a production release. It provides no Real-Debrid, no instant Usenet streaming, no automatic
source failover, no indexer search and no download-selection policy.

**No threshold in §5.3 and no refusal in §4 may move after this commit** except by a commit that changes this
document **first**, states what moved and why, and re-runs everything already measured against the old value.

---

## 9. Exact inputs

### 9.1 For the tier-one closing run

| Input | Value |
|---|---|
| Host | the real Unraid host, via the existing gate-run procedure |
| Database | throwaway PostgreSQL, `docker-compose.projection-phase11.yml`, host port **5680**, `tmpfs` data directory |
| Range origin | `projectiond/cmd/fakerange`, `go run` inside the pinned Go image, loopback port **8300** |
| Worker | `startFakeSabnzbd`, ephemeral loopback port, started and stopped by the run |
| Corpus | synthesised by the gate in its own run directory. **No operator content.** |
| Credentials | **none** |
| `endpoint.json` | **not read, not written, not touched** — asserted, with its mtime recorded before and after |
| Media servers | **none**, and none simulated |
| Provider window needed | **none** |

### 9.2 For the tier-two runs, which are NOT RUN

Everything below is something **only the operator possesses**, and nothing on it is something this project
could build, fake or infer. That distinction is what makes "provider-free ready" an honest stopping point
rather than an excuse.

- TorBox credentials and at least one object the operator is entitled to;
- a running SABnzbd the operator controls, with **an NNTP provider already configured in it** — this project
  never reads or holds one — and a dedicated category with its own incomplete and complete directories;
- at least one NZB or indexer URL for content the operator is legally entitled to download, and one the
  operator expects to fail or arrive incomplete;
- the complete directory placed under the media root the appliance already serves;
- **three real, already-attached media servers**: Plex, Jellyfin and Emby.

---

## 10. Run record

### 10.1 STATUS

**Filled in by the tranche that builds against this document. Nothing above may be read as a verdict, and
this section is empty until a run has happened.**
