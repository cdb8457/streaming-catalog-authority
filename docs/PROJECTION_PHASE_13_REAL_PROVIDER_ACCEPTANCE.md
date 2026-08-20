# Projection Phase 13 — REAL TORBOX ACCEPTANCE

**PHASE 13 IS NOT ENTERED BY THIS DOCUMENT.** This is the contract a later, separately authorised Phase 13
run is measured against, written and committed **before** anything is run against a provider — which is
operator prerequisite #1 of `docs/PROJECTION_PHASE_13_PRE_ENTRY_INSTRUMENT_REPAIR.md` §7, and the one thing
that cannot be written afterwards without the contract becoming a description of whatever happened.

**NO PROVIDER WAS CONTACTED TO PRODUCE ANY OF IT.** No credential was read, printed, written or rotated. No
origin allowlist was read for value, widened, reordered or edited. `endpoint.json` was neither read nor
written. No container was started or stopped, no media server was touched, and no production state changed.

**`P11-R1` IS NOT RUN AND STAYS NOT RUN.** It is a conjunction about co-residency — a real provider-backed
entry **and** a real Usenet-admitted file in **one published generation** — and Phase 13 supplies only the
first. Phase 12 §13.1 supersedes the sentence that called that "the provider half"; §11 below is the
structural form of the same refusal.

| | |
|---|---|
| What this is | the **contract**: claim ids, thresholds, refusals, entry and exit criteria, inputs by shape, and file ownership |
| What it is not | a run, an authorisation, an entry, a claim about the operator's account, or evidence of anything |
| Instrument | `deploy/projection-torbox-real-gate.sh` and `deploy/projection-torbox-real-gate-three.sh`. **Not** the generic real-provider gate — Phase 12 §13.2 supersedes that row and §2.2 below says why |
| Namespace | `P13-A*` for the provider-facing arms, `P13-S*` for the sequence. Reserved by the pre-entry tranche and unspoken for until now |
| Rules as code | `src/core/projection/phase13.ts` — written in a **later** commit than this document, deliberately |
| Status | **NOT RUN.** §14 is the run record and it records that nothing has run |

**WHY THIS FILE IS NOT NAMED AFTER THE PROVIDER, AND THE TITLE IS.** All eight provider source allowlists
under `test/` walk `src/` and refuse any unlisted file that names the provider at all. `phase13.ts` carries
this document's path in its ownership list, so a filename that named the provider would put the provider's
name in `src/` and require eight security boundaries to move for a string. `phase12.ts` and
`phase13-preentry.ts` avoided the same question the same way, and Phase 11 §6.2 records what widening those
lists costs. **Zero allowlists moved for this tranche.**

---

## 1. What Phase 13 is for, in one paragraph

Everything this repository knows about the projection data plane against a real provider is a statement about
a **fake** range origin. `projectiond/cmd/fakerange` serves bytes, the mount serves them back, and eleven
provider-free claims are GO on the operator's own Unraid host, three consecutive fresh times. **None of that
is a statement about TorBox.** Phase 13 is the run that makes "it has never contacted a real provider" false:
the operator's own entitled objects, resolved by the operator's own metered account, read back through the
mount as ordinary read-only files, with the API key never entering the daemon container and the host left
exactly as it was found.

**IT IS ONE HALF OF ONE PATH.** It is not the mixed product, not Usenet, not three media servers, not an
outage, not a soak and not a release. §12 lists what it may close and §11 lists what it may not.

---

## 2. What is GO, what is OPEN, and what Phase 13 may do to each

Nothing below this table may contradict it.

| | State before Phase 13 | What Phase 13 may do to it |
|---|---|---|
| **Phase 10** | **GO** (Phase 12 §10.9) | nothing. No Phase 10 claim is written, moved, re-worded or narrowed |
| **Phase 11 tier one** | **GO** (Phase 12 §10.9) | nothing |
| **Phase 12** | **GO from candidate `a8d7232`** (§10.9); **and NOT YET from any later candidate** (§13.3) | nothing to that record. `P13-S2` below is Phase 13 *asking* for a Phase 12 GO of its own candidate, not Phase 13 granting one |
| **Phase 9** — `P9-2`, `P9-3`, `P9-5`, `P9-11` | **OPEN** | nothing. Phase 10 §8's prerequisite is inherited and discharged by none of this |
| **Phase 11 tier two** — `P11-R1`…`P11-R4` | **OPEN / NOT RUN** | nothing. **`P11-R1` has no half to close** |
| **Phase 13 pre-entry** — `P13PRE-*` | **complete** (that document's §10.1, §12, §13) | nothing. It is a closed record about an instrument |
| **Phase 14, Phase 15** | **NOT ENTERED** | nothing, and no work of theirs is begun |

### 2.1 The seven sentences, verbatim

`PHASE13_PRESERVED_STATES` in `phase13.ts` holds exactly these, and `test/projection-phase13.ts` asserts this
document still carries every one of them word for word. A tranche that stopped saying one of these would be a
tranche that had quietly moved it.

- Phase 10 is GO and Phase 13 does not touch it
- Phase 11 tier one is GO and Phase 13 does not touch it
- Phase 12 is GO from candidate a8d7232 and Phase 13 does not touch that record
- Phase 9 stays OPEN, and none of P9-2, P9-3, P9-5 or P9-11 is answered here
- Phase 11 tier two stays OPEN, and P11-R1 is NOT RUN and has no half to close
- Phase 14 is NOT ENTERED and no Usenet or media-server claim is closed
- a Phase 13 GO is one half of one path on one host, and is not the mixed product

### 2.2 The instrument, and why it is not the one the roadmap named

Phase 12 §12.1 names `deploy/projection-real-provider-gate.sh`. **Phase 12 §13.2 supersedes that**, and this
contract enacts the supersession by naming `deploy/projection-torbox-real-gate.sh` instead. Two independent
reasons, either sufficient:

1. **The generic gate's real mode has never run anywhere.** It is repaired and the repair is regressed
   offline, but a gate you are not running is a gate no repair has survived.
2. **It now refuses a real run outright.** Three of its five decision-bearing observations have no counter
   surface on the real path, so a real run carrying UNTAKEN fields is refused rather than reported. It
   **cannot produce complete real evidence at all**, which is honest and is also disqualifying.

The provider-specific gate resolves in the daemon's own network namespace, never mounts the provider key into
the daemon, bounds its read step with a corpus-derived ceiling, captures and asserts both container logs,
scans byte-exactly for both secrets, and probes read-only refusals as both an unprivileged uid **and** uid 0.

### 2.3 What a Phase 13 GO means, and no more

> the operator's own entitled objects were published as a generation, resolved by the operator's own
> account, and read back byte-correct through a read-only FUSE mount on the operator's own host, three
> consecutive fresh times from one frozen candidate — with the API key never inside the daemon container,
> the origin allowlist unmoved, and the host left as it was found.

**Ceiling sentence**, held as a constant so a summary that grew past it has to edit a module:

> one provider, one host, one half of the mixed path; no Usenet, no media server, no outage, no soak

**A RECORDED RESIDUAL ABOUT THE BLOCK QUOTE ABOVE, AND IT IS NOT REPAIRED BECAUSE REPAIRING IT WOULD MEAN
FALSIFYING HISTORY.** This document was committed at `6cf953a`, before any code, which is entry criterion
**E1**. That first version of the meaning read *"the operator's own entitled **TorBox** objects … on the
operator's own **Unraid** host"*. The commit that added `src/core/projection/phase13.ts` — `b838f11`, a
**later** commit — dropped both names, so `PHASE13_MEANING` could carry the sentence without putting the
provider's name in `src/`, where **all eight provider source allowlists** would have had to move for a
string. **No claim id, threshold, refusal, entry criterion or exit criterion moved with it**, and §3.1 and
§5.1 still pin `deploy/projection-torbox-real-gate.sh`, the operator's own **Unraid** host and the operator's
own **TorBox** account by name — so nothing is materially loosened. But the edit ran in the **widening**
direction and it was made in the implementation commit rather than in the contract commit, which is a shade
less clean than "written in a later commit than this document, deliberately" implies. **It is recorded here
rather than rewritten**, and `test/projection-phase13.ts` carries the control that stops the neutralisation
spreading: it asserts §3.1's and §5.1's pins are still present, word for word, and that the module still
names neither.

### 2.4 What Phase 13 is not

It is none of these, and says so rather than leaving it to be inferred: **the mixed product**, **Usenet**,
**a media-server acceptance**, **a provider outage**, **a soak**, **a load test**, **an uptime claim**, **an
availability claim**, **a second host**, **high availability**, **a production release**, **Real-Debrid**,
**instant Usenet streaming**, **automatic source failover**, **indexer search**, **a download-selection
policy**.

---

## 3. Scope

### 3.1 In scope

Running `deploy/projection-torbox-real-gate.sh` and `deploy/projection-torbox-real-gate-three.sh` on the
operator's real Unraid host, from one frozen candidate, against the operator's own already-served TorBox
account; recording the result; and the closure module and suite that decide whether the result closes
anything. **Phase 13 ships no product daemon source**, no `projectiond/` change, and no change to any module
on `PHASE9_SOAK_TRIGGERING_SOURCE`.

### 3.2 Out of scope, and named rather than left to be inferred

- **Any change to the gate to make a run go green.** A gate repaired mid-run is a gate the run did not
  survive. Phase 13's instrument is frozen at its candidate; a defect found during a run **stops the run**,
  is repaired with a control, and the series **restarts at one** from a new candidate.
- **Any widening of `allowedOrigins`.** §8 is the whole policy. A widening is a **blocker**, not a step.
- **Any credential change, rotation or generation.** The operator places the files; Phase 13 opens them by
  path inside the process that needs them and never reads one for value.
- **Any induced or awaited provider outage.** That is `P11-R3` and it is deliberately not Phase 13's.
- **Any media server.** Plex, Jellyfin and Emby are `P11-R2` and Phase 14's.
- **Any Usenet, NZB, SABnzbd or NNTP work.** Phase 14's, entirely.
- **The generic real-provider gate's counter surface.** The pre-entry tranche assigned it out of scope with
  an owner named; Phase 13 does not supply it and does not need it.

---

## 4. Hard refusals

Phase 13 shall not:

1. **read, print, write into evidence, rotate, replace, generate or change any credential**, or accept one
   from argv, an environment variable or a prompt. Every secret is named by **path** and opened inside the
   process that needs it;
2. **read `endpoint.json` for value, widen, edit, reorder or normalise `allowedOrigins`, or write
   `endpoint.json` at all.** The readiness recorder reads it to compute a digest, a count and a shape, and
   emits **no member of it**;
3. **place a credential, an object reference, a URL, an origin, an access-material value, a media identity or
   an operator share path in any emitted document.** `SealedValue`, `assertSealedSafe`, `findLeaks` and
   `findResultLeaks` are **reused**, never re-implemented;
4. **induce, simulate, provoke or wait for a provider outage**, or contact an indexer, an NNTP server, a
   media server or any production container;
5. **start a second daemon, write a Compose service for one, or mount, bind, unmount or write inside the
   projection mount point.** Where an appliance is needed a gate invokes `deploy/projection-alpha.sh`, and
   **one mount point keeps exactly one owner**;
6. **record a verdict for a claim it did not run, fold a skip into a pass, or report exit 77 as success.**
   77 is a SKIP, a SKIP is not a PASS, and the `-optional` entry points close **no** claim;
7. **write a `P9-`, `P10-`, `P11-`, `P12-` or `P13PRE-` verdict of its own**, or move any claim of those
   tranches by any route — **and in particular it does not close, half-close, partially satisfy, re-word or
   narrow `P11-R1`**;
8. **weaken a threshold, delete a required suite, relax a required-but-skipped count, or rewrite a prior run
   record.** A superseded sentence is kept whole and marked superseded;
9. **modify anything on `PHASE13_FORBIDDEN_SOURCE`**, which is the pre-entry tranche's forbidden list plus
   `phase13-preentry.ts` itself — and, **from the moment a candidate is frozen**, the two gate scripts and
   the wrapper this phase's evidence is *about*. A tranche that could edit the instrument it is measured
   through is a tranche whose measurement concludes whatever it needs to.
   **THE CLAUSE AFTER THE DASH IS AN AMENDMENT, AND IT IS A CORRECTION RATHER THAN A LOOSENING.** As first
   written this refusal described `PHASE13_FORBIDDEN_SOURCE` as already containing the gate scripts, which
   the constant has never held and §13's own ownership table contradicts: this preparation tranche
   **repaired** `deploy/projection-real-provider-gate.sh` and `deploy/projection-torbox-real-gate.sh`, each
   with a control, **before** any candidate was frozen. `deploy/projection-torbox-real-gate-three.sh` — the
   wrapper `P13-S1` is measured through — is unmodified by this branch and stays so. The rule the sentence
   was always making is the one now written: **a defect found on the way to a run is repaired with a control
   and the series restarts at one; a gate repaired mid-campaign is a gate the campaign did not survive**;
10. **run more than one gate campaign on the host at a time.** The gates bind fixed loopback ports; a second
    concurrent run dies with a bind failure that reads like a gate defect and is not;
11. **ask a human for a secret value, print one, or write one into evidence.** A blocker is recorded as the
    **shape** of what is missing;
12. **push, merge, tag, open a pull request, change a default branch, deploy to production, begin Phase 14,
    or do any Real-Debrid work of any kind.**

---

## 5. The claims

`PHASE13_CLOSURE_GATE_IDS` holds these eleven ids **in this order**, and `test/projection-phase13.ts` asserts
the list and this document agree — so the defect Phase 12 found at its own §11.4, where the shipped function
was stricter than the prose it was written from, cannot recur here.

### 5.1 Tier A — the provider-facing arms. **NOT ANSWERABLE WITHOUT A REAL ACCOUNT.**

Every one of these is a statement about a run of `deploy/projection-torbox-real-gate.sh` against the
operator's own TorBox account. **No fake run may record one**, and `phase13ClosureProblems` refuses a result
set whose run mode is anything but `real`.

| id | Claim | Budget |
|---|---|---|
| `P13-A1-operator-inputs-preflight-before-any-contact` | all four operator inputs are present and usable, both secrets are mode 0600 and **differ**, and every input check passes with **nothing built, started or contacted** | `PREFLIGHT_CONTACTS_MAX` |
| `P13-A2-a-generation-of-the-operators-references-is-published-and-mounted` | a generation whose sources are the operator's TorBox stable references is published, and the daemon serves it as ordinary read-only files through a FUSE mount | — |
| `P13-A3-the-operators-objects-read-back-byte-correct` | every declared probe window of every object reads back matching the digest authority the corpus declares, through the mount | `READ_MISMATCHES_MAX` |
| `P13-A4-exactly-one-resolution-per-object` | the resolver resolved **at least** once per object — so the provider was genuinely contacted — and **at most** once per object, so no read after the first minted fresh access material against a metered account | `RESOLUTIONS_PER_OBJECT_MIN`, `RESOLUTIONS_PER_OBJECT_MAX` |
| `P13-A5-the-api-key-never-enters-the-daemon-and-nothing-written-carries-a-secret` | the TorBox credential is **absent from the daemon container's filesystem**, and a byte-exact scan of everything this run wrote and both containers' logs finds neither secret and no object reference | `SECRET_TRACES_MAX` |
| `P13-A6-the-mount-refuses-writes-as-an-unprivileged-uid-and-as-uid-0` | write, create, unlink and chmod are refused through the mount **both** as the uid a media server runs as **and** as uid 0, which permissions cannot refuse | `WRITE_PATHS_ADMITTED_MAX` |
| `P13-A7-the-host-is-left-as-it-was-found` | the container, network and volume **sets** are preserved as membership rather than as counts; no mountpoint and no run directory survives; the appliance's own container, network and mount point are untouched | `HOST_SET_LOSSES_MAX`, `RESIDUE_MAX` |
| `P13-A8-the-origin-allowlist-is-unmoved-before-and-after` | a no-contact readiness record taken immediately before the sequence and immediately after carries the **same whole-file digest, the same member count and the same member digests** for `endpoint.json` | `ALLOWLIST_MEMBERS_MOVED_MAX` |

### 5.2 Tier S — the sequence, and the candidate it ran from

| id | Claim | Budget |
|---|---|---|
| `P13-S1-three-consecutive-fresh-real-runs-zero-skips` | `deploy/projection-torbox-real-gate-three.sh` completes **three consecutive fresh** runs of the gate, none skipped, none failed, each from a fresh database, manifest directory, resolver, mount and **probe cache**, from one frozen candidate | `CONSECUTIVE_FRESH_RUNS`, `SKIPPED_RUNS_MAX` |
| `P13-S2-the-candidate-carries-a-phase-12-go-of-its-own` | the complete Phase 12 provider-free sequence has been run from **this** candidate, three consecutive fresh times, with zero skips, and `phase12ClosureProblems` returns empty for it | `CONSECUTIVE_FRESH_RUNS`, `SKIPPED_CLAIMS_MAX` |
| `P13-S3-typecheck-and-full-offline-inventory-both-shells` | `npx tsc --noEmit` clean, and the **full** offline inventory green from **Git Bash** and from an **ordinary PowerShell**, from that same candidate — not a focused subset and not a run stopped part-way | `REQUIRED_BUT_SKIPPED_MAX` |

### 5.3 The thresholds

| name | value | source |
|---|---|---|
| `CONSECUTIVE_FRESH_RUNS` | 3 | **IMPORTED** — `PHASE12_RULES.CONSECUTIVE_FRESH_RUNS`, itself Phase 11 ← Phase 10 ← Phase 9 ← Phase 8 ← Phase 3 |
| `SKIPPED_CLAIMS_MAX` | 0 | **IMPORTED** — `PHASE12_RULES.SKIPPED_CLAIMS_MAX` |
| `RESIDUE_MAX` | 0 | **IMPORTED** — `PHASE12_RULES.RESIDUE_MAX` |
| `REPAIRS_WITHOUT_A_CONTROL_MAX` | 0 | **IMPORTED** — `PHASE12_RULES.REPAIRS_WITHOUT_A_CONTROL_MAX`. **Read by E3**, through `repairsWithoutAControlInCandidate`. It was named by no claim and read by no function until this amendment, which is the D3 defect — *a budget nothing can move* — that the pre-entry tranche found in `P13PRE-C3` and repaired for itself, recurring in the successor contract |
| `ORIGIN_RECORD_MAX_AGE_MINUTES` | 60 | **IMPORTED** — `phase13-preentry.ts`, and read from there rather than restated |
| `ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES` | 10 | **IMPORTED** — `phase13-preentry.ts` |
| `PREFLIGHT_CONTACTS_MAX` | **0** | **NEW.** An input check that contacted something has spent a resolution to discover a typo, and has done it before anything could be scanned for a leak |
| `READ_MISMATCHES_MAX` | **0** | **NEW.** A byte that came back wrong is the whole product failing, and there is no interesting fraction of it |
| `RESOLUTIONS_PER_OBJECT_MIN` | **1** | **NEW.** The only floor in this contract. Every ceiling here is satisfied by a run that contacted nothing, which is the failure mode a provider-facing gate must not have |
| `RESOLUTIONS_PER_OBJECT_MAX` | **1** | **NEW.** Access material is valid for hours and the run is seconds long, so a second resolution for the same object is a resolution storm against a metered account |
| `SECRET_TRACES_MAX` | **0** | **NEW.** TorBox authenticates with a query parameter, so a request URL is itself a bearer credential. Anything that logs one publishes the key |
| `WRITE_PATHS_ADMITTED_MAX` | **0** | **NEW.** Measured as both uids, because a refusal that only holds for an unprivileged uid is a refusal the daemon is not making |
| `HOST_SET_LOSSES_MAX` | **0** | **NEW.** "Left as found" is about a SET. A count is satisfied by a removal and a creation |
| `ALLOWLIST_MEMBERS_MOVED_MAX` | **0** | **NEW.** The allowlist is perishable and the pool rotates; a movement is escalated as a digest and never edited to make a run go green |
| `SKIPPED_RUNS_MAX` | **0** | **NEW.** 77 is a skip. "Two of three passed" is not what three consecutive fresh runs means |
| `REQUIRED_BUT_SKIPPED_MAX` | **0** | **IMPORTED in spirit, NEW as a name.** The offline inventory's own required-but-skipped counter, which is the number a stopped-part-way run moves |

*A claim with no budget in this table has nothing to measure, and a run that supplies a measurement for one
has invented a budget.* `phase13ClosureProblems` refuses both directions.

**A CLAIM WHOSE BUDGET COLUMN NAMES TWO THRESHOLDS IS MEASURED AGAINST BOTH, AND THAT SENTENCE IS AN
AMENDMENT.** It is written here **before** anything is measured against it, and it records a defect an
independent review found in the shipped module rather than in this table: `phase13BudgetKeyFor` returned **one**
key per claim, so `RESIDUE_MAX` — the budget §5.1 gives `P13-A7`'s residue half — was read by **no function**,
`CONSECUTIVE_FRESH_RUNS` was read by nothing at closure, and `P13-S2` was given **no** budget at all and
therefore **actively refused** a result set that recorded the claim the way §5.2 documents it. That is the
defect Phase 12 found at its own §11.4 — the shipped function disagreeing with the prose it was written from —
recurring in the **one part of §5 the suite never compared**. The Budget column above is unchanged; the
module now maps it in full through `phase13BudgetKeysFor`, and `test/projection-phase13.ts` parses this
table row by row and refuses any disagreement, in either direction, for every one of the eleven.

**Where §5 gives a claim two thresholds, the second is carried by its own named field**, because the
`measured`/`budget` pair on a result is **one** number:

| claim | its `measured`/`budget` pair | its second measurement |
|---|---|---|
| `P13-A4` | — (a **range**, checked on its own so its floor is not dropped) | `perObjectDenominator`, against `RESOLUTIONS_PER_OBJECT_MIN` and `RESOLUTIONS_PER_OBJECT_MAX` |
| `P13-A7` | `HOST_SET_LOSSES_MAX` — names present **before** and absent **after** | `residueSurviving`, against `RESIDUE_MAX` — a mountpoint, a run directory or another artefact the run **created** and left behind. "Left as it was found" is broken in both directions, and a count is satisfied by a removal and a creation |
| `P13-S1` | `SKIPPED_RUNS_MAX` | `consecutiveFreshRuns`, against `CONSECUTIVE_FRESH_RUNS`, which is a **FLOOR** |
| `P13-S2` | `SKIPPED_CLAIMS_MAX` | `consecutiveFreshRuns`, against `CONSECUTIVE_FRESH_RUNS` |

**THE FLOOR IS WHY THE SECOND FIELD EXISTS AT ALL.** Every ceiling in §5.3 is satisfied by **one** run with
no skips, so without `consecutiveFreshRuns` the words "three consecutive fresh" are a title rather than a
measurement — the same argument `RESOLUTIONS_PER_OBJECT_MIN` exists for one tier up.

### 5.4 Numeric domains — validation precedes comparison

**EVERY DECISION-BEARING NUMBER IS REFUSED BEFORE COMPARISON UNLESS IT BELONGS TO THE DOMAIN OF THE THING IT
MEASURES.** `typeof value === 'number'` is not evidence: it admits `NaN` and both infinities, and a one-sided
ceiling admits negative evidence. The executable domains are:

| semantic domain | fields | executable rule |
|---|---|---|
| counts, run totals, residue, repairs, skips and claims | every entry count; every count-valued `measured` and `budget`; `residueSurviving`; `consecutiveFreshRuns`; every exit run/residue/repair/skip/claim count; both origin-plan pool counts | **finite nonnegative integer** before any floor or ceiling comparison |
| positive counts and denominators | E6 `allowedOriginCount`; A4 `perObjectDenominator` | **finite positive integer**; zero is not a denominator and an allowlist admitting zero members cannot serve an object |
| ages, durations and elapsed measurements | E7 `originRecheckAgeMinutes`; E9 `shortestObservedOriginLifetimeMinutes`, `boundedSequenceDurationMinutes`, `originRecordAgeMinutes` | **finite and nonnegative**, with the imported E9 lifetime and bounded-duration policy retaining its stricter **positive-only** rule |
| statuses | E7 `originRecheckExitStatus`; X1 `wrapperExitStatus` | **finite nonnegative integer** before disposition or equality; zero remains the only passing status where the criterion requires zero |
| A4 numerator and denominator | A4 `measured`; A4 `perObjectDenominator` | numerator is a **finite nonnegative integer** resolution count; denominator is a **finite positive integer** object count; only then may the total be compared with the per-object floor and ceiling |

**MISSING REMAINS REFUSED. ZERO PASSES DOMAIN VALIDATION ONLY WHERE ZERO IS A LEGITIMATE MEASUREMENT.** Zero is
valid for losses, residue, repairs, skips, moved members, contacts, mismatches, traces, admitted writes and
an observed pool. It does not satisfy a positive denominator, E6's positive admitted-member count, a positive
origin lifetime/duration, or a floor that requires work to have occurred. Fractions are refused for every
count-valued metric even when a one-sided comparison would otherwise put them on the passing side.

The module carries one registry assigning every numeric field to one of these semantic domains, and the suite
sweeps the entry, closure and exit numeric surfaces against it. Adding a numeric field without assigning a
domain, or assigning a registry entry that no shipped decision surface consumes, is a failing structural
control rather than a silent fall-back to a comparison.

---

## 6. ENTRY CRITERIA — every one must pass before a single packet

**PHASE 13 IS NOT ENTERED UNTIL ALL OF THESE PASS**, and `phase13EntryRefusals` is the same list as a
function: it returns one sentence per unmet criterion and the empty list only when every one is met. **An
unevaluated criterion is not a satisfied one** — the function refuses an `undefined` as loudly as a `false`,
because the failure mode of an entry gate is a field nobody filled in.

| # | Criterion | How it is evidenced |
|---|---|---|
| **E1** | **This contract is committed**, before anything is run | the commit that carries this document precedes every run record commit |
| **E2** | **Phase 12 is amended**, superseding §12.1's two wrong sentences, by that document's own §8 procedure | Phase 12 §13, committed before this document |
| **E3** | **The candidate is frozen and named**, staged byte-identically both ways with zero text files carrying a CR, and carrying **zero repairs that no control fails on** | `deploy/projection-phase12-stage.sh preflight --full`, then `stage --commit <candidate>`; `repairsWithoutAControlInCandidate`, against `REPAIRS_WITHOUT_A_CONTROL_MAX`. **A repair nobody proved is a repair whose defect can come back green**, and until this amendment that threshold was one nothing could move |
| **E4** | **The candidate carries a Phase 12 GO of its own** — the complete provider-free sequence, three consecutive fresh times, zero skips | `P13-S2`. Phase 12's GO from `a8d7232` does **not** transfer; Phase 12 §13.3 says why |
| **E5** | **The operator has placed all four inputs** under the gate's own approved directory, both secrets mode 0600 and different values, and has confirmed **by reference only** at least one object they are entitled to | the gate's own preflight, which exits 77 having contacted nothing if any is absent. **The reference never enters an emitted document** |
| **E6** | **`endpoint.json` exists, is already serving, and its `allowedOrigins` already admits the pool the operator's objects are served from** | a no-contact readiness record (shape, count, member digests) plus §8's origin recheck |

| **E7** | **The origin recheck inside the hour before the sequence returns 0** | `deploy/projection-provider-origin-recheck.sh`. **70 is a blocker**, escalated as a digest and never widened; any other status means **not measured**, and not measured is not allowed |
| **E8** | **No other gate campaign is running on the host, and its residue is accounted for** — zero `projection-*` containers, no `projection-alpha` container or network, and the gate's ports free | a fresh before-baseline taken **immediately** before the run. A figure from a readiness review is a sampled fact by then, and pairing it with a fresh one invents an instant |
| **E9** | **The origin-stability plan is satisfied** — a measured shortest origin turn, a bounded sequence duration that fits inside it with margin, a record younger than the maximum age, and an observed pool no larger than the allowlist | `originStabilityRefusals`, §8 |

**E6 AND E9 CARRY TWO COPIES OF ONE FACT, AND THE FUNCTION NOW REFUSES THEM WHEN THEY DISAGREE.** This is an
amendment, written before it is measured against, and it records a defect found by **running** the entry gate
rather than by reading it. E6 reads `allowedOriginCount`; E9 reads `originPlan.allowedOriginCount`. Nothing
asserted the two agreed, so filling the plan's copy in as the **observed pool size** rather than as the
allowlist's count made §14.3's six-against-seven refusal — the one that section calls *"the one that matters
most"* — **disappear**, and `phase13MayEnter` returned **true** on an otherwise unchanged state. **No provider
fact had to move; one field was filled in inconsistently.** The disagreement is **refused, never reconciled**:
choosing one of the two numbers would be this repository deciding which of the operator's measurements is the
real one, and §8's pool comparison would then be made against a number nobody took.

**AND E9's PLAN IS REFUSED WHEN ITS TWO COUNTS ARE ABSENT, WHICH IS THE SAME AMENDMENT FROM THE OTHER SIDE.**
`originStabilityRefusals` guards its pool comparison with `typeof allowed === 'number' && typeof pool ===
'number'`, so an **absent** `observedPoolSize` — or an absent plan-side `allowedOriginCount` — produced **no
refusal at all**, while an unmeasured lifetime, an unbounded duration and an ageless record are each refused
there **by name**. The pool was the one field in that function where *not measured* read as *satisfied*, and
§8's own sentence is the opposite. **The refusal is added at E9's own site in `phase13.ts` rather than inside
`originStabilityRefusals`**, because `phase13-preentry.ts` is on `PHASE13_FORBIDDEN_SOURCE` and §4's ninth
refusal forbids this tranche from editing the instrument it is measured through; that module is left
**byte-identical**. **A zero is still a measurement and is not refused** — what is refused is an absent, a
`NaN`, an infinity and a negative, none of which is a number of origins anybody observed.

**E4 IS THE ONE MOST LIKELY TO BE ARGUED WITH, AND IT IS NOT NEGOTIABLE.** Phase 12's GO is a closed record
about `a8d7232`. Between that commit and any candidate carrying the pre-entry repair, the **staging script**
that is arms 1 and 2 of every sequence moved, the gate arm 7 runs moved, `src/core/projection/real-provider.ts`
moved, and two suites plus the selection list arm 9 reads moved. A sequence is what says those bytes work
together on that host.

---

## 7. EXIT CRITERIA — what a Phase 13 GO requires

**THESE ARE `phase13ExitRefusals`, AND THAT SENTENCE IS AN AMENDMENT.** §13's ownership row has always said
this module carries *"§6's entry criteria and §7's exit criteria, as code"*. §6 had `phase13EntryRefusals`;
§7 had `PHASE13_EXIT_CRITERIA` — **six strings** — and a suite that asserted each label has a row in this
table. **X3 and X5 had no executable counterpart at all**, so half of that ownership sentence was a label
rather than a claim. The function is written **before** any run it could measure, it refuses an `undefined`
as loudly as a `false` for every field, and **it is not a GO even when it is empty**: a GO is written by a
person, into a run record, from evidence.

| # | Criterion | The fields it is refused through |
|---|---|---|
| **X1** | `deploy/projection-torbox-real-gate-three.sh` completed **3 of 3**, none skipped, exit 0, from one frozen candidate — `P13-S1` | `wrapperRunsCompleted` (a **FLOOR**, `CONSECUTIVE_FRESH_RUNS`), `wrapperRunsSkipped`, `wrapperExitStatus`, `candidate` |
| **X2** | Every Tier A claim has a **pass** verdict from a **real**-mode run; none is absent, skipped or duplicated — `P13-A1`…`P13-A8` | **read off the result set**, never declared beside it — a declaration about verdicts is a second copy of the verdicts and the two can disagree |
| **X3** | **No credential was read, printed, written to evidence, rotated or changed**, and no provider outage was induced | `credentialReadPrintedOrChanged`, `providerOutageInduced`. Both are stated in the **failing** direction, so only an explicit `false` passes and nobody discharges X3 by leaving a field out |
| **X4** | **The origin allowlist is unmoved**, and its state is recorded before and after by digest — `P13-A8` | `allowlistWholeFileDigestUnchanged`, `allowlistMemberDigestsUnchanged`, `allowlistMembersMoved` |
| **X5** | **The host is left as it was found**: container, network and volume sets preserved as membership; no mountpoint; no run directory; the appliance untouched — `P13-A7` | `hostSetLosses`, `residueSurviving`, `applianceUntouched` — **both directions**, because a count is satisfied by a removal and a creation |
| **X6** | `phase13ClosureProblems` returns **empty** over the run's own verdicts, and the green is proved non-vacuous by re-running the same evidence with **one byte changed** and watching it refuse | `phase13ClosureProblems` is **run**, and `tamperedEvidenceStillRefused` carries the control. A function that returns empty for everything returns empty for a real run too |

**AND THE RUN RECORD MUST STATE WHAT IT DOES NOT COUNT.** Phase 12 §10.8's paragraph is inherited: whatever
the campaign leaves on the host — a staging directory, a frozen image, preserved evidence — is named with its
size, or the residue figure is a statement about the things somebody remembered.

---

## 8. THE ORIGIN-HOUR CONSTRAINT

`docs/PROJECTION_ALPHA_OPERATOR_RUNBOOK.md` records the measurement that makes this a section rather than a
sentence: **seven distinct origins, each served roughly 40 to 84 minutes, cycling back.** A three-run provider
sequence includes three image builds, three migrations and three mounts. **A rotation across it is likely,
not hypothetical**, and its signature is precise: `stat` succeeds, the listing is perfect, and every read
fails `EIO` in well under a second.

**WITHOUT A POLICY, A ROTATION MID-SEQUENCE READS AS A HARD FAIL ABOUT THE PRODUCT. IT IS NOT ONE.** And the
temptation it creates — widen `allowedOrigins` until it goes green — is the thing Phase 12 §12.1 calls a
blocker rather than a step.

*(The sentence above is completed here. As first written it opened "**WITHOUT A POLICY THAT READS AS A HARD
FAIL ABOUT THE PRODUCT. IT IS NOT ONE.**" — a clause was missing and the sentence did not parse. §14.3 says
the same thing correctly and is the reading restored. **No threshold, refusal, claim or criterion moves with
it.**)*

So Phase 13 reads the policy `phase13-preentry.ts` already carries, rather than restating it:

- **`originStabilityRefusals(plan)`** — the reasons a sequence **may not start**: an unmeasured origin
  lifetime (an unmeasured lifetime is not a generous one); an unbounded sequence duration; a duration that
  does not fit inside the **shortest observed** turn with `ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES` of margin;
  a record older than `ORIGIN_RECORD_MAX_AGE_MINUTES`, because a stale record is an answer about a
  **different** origin; and an observed pool **larger than** the allowlist.
- **`originRotationDisposition(status)`** — `0` proceed, `70` **`abort-origin-rotated`**, anything else
  **`abort-not-measured`**. **Neither abort is a FAIL, and neither is a licence to widen anything.**

**AND THE PLAN'S TWO COUNTS MUST BE PRESENT BEFORE THAT COMPARISON MEANS ANYTHING.** `originStabilityRefusals`
compares the pool to the allowlist only when **both** are numbers, so an absent `observedPoolSize` — or an
absent plan-side `allowedOriginCount` — produced no refusal at all. E9 refuses both absences by name in
`phase13.ts`, leaving `phase13-preentry.ts` byte-identical as §4's ninth refusal requires. **A zero is still a
measurement.** §6 records the whole amendment.

**THE SEQUENCE IS BOUNDED BEFORE IT STARTS.** Phase 13 declares its own duration in minutes and the plan
refuses it if it does not fit. A sequence that ran past its declared duration is a sequence whose origin
answer expired mid-run, and the run is **aborted and restarted at one**, not extended.

**AN ABORT IS RECORDED AS A COUNT AND A DIGEST.** Never as an origin, never as a URL, never as a member.

---

## 9. EXACT OPERATOR INPUTS — by reference and shape only

**NOTHING IN THIS SECTION IS A VALUE, AND NOTHING IN IT WAS READ.** These are the four files the shipped gate
opens, described by the shape `deploy/torbox-resolver.template.json` already publishes. The operator places
them; Phase 13 never generates, prompts for, prints or records one.

| file | shape | who ever sees it |
|---|---|---|
| `torbox-credential` | one line, the operator's API key, **mode 0600**, non-empty | **the resolver container only.** Never mounted into the daemon container at all |
| `credential` | the **gate secret** — any locally generated high-entropy string, **mode 0600**, non-empty, and **not equal to** `torbox-credential` | the daemon, which presents it to the loopback resolver as a bearer |
| `objects.json` | 1–3 objects the operator is legally entitled to; each `ref` is `torbox:<torrent\|webdl\|usenet>:<itemId>:<fileId>`, plus the declared size and digest authority. **Treat as a secret**: a reference identifies an item in the account | the gate's preflight and register step, inside the process |
| `endpoint.json` | `id`, `allowedOrigins` (https, scheme+host+port, no path, no wildcard, no loopback/private/link-local/metadata address), `allowInsecureHttp: false`, `allowPrivateAddresses: false`. **The operator writes no `resolverUrl`, no `directBaseUrl`, no `loopbackResolver` and no `tokenFile`** — the gate owns topology and refuses a file that supplies any of them | the gate, which builds the effective endpoint from it |

**THE DIRECTORY.** The gate's own, not the generic gate's: the two `endpoint.json` schemas are mutually
exclusive, so sharing one directory made preparing either break the other. Named by environment override, and
the gate never searches the filesystem for anything that might be a credential.

**WHAT IS RECORDED ABOUT THEM, AND THE LIST IS CLOSED.** Existence, type, mode, non-emptiness; size and a
whole-file digest for the **non-secret** files only; the key **shape** of each JSON document; the allowlist's
**count** and per-member **digest**. **No value, no URL, no origin, no object reference, no media identity,
no operator share path.** The two secret files are **not digested** — a digest of a short token is derived
from its content, and nothing Phase 13 writes may be.

---

## 10. Cleanup, redaction and mount ownership

### 10.1 Cleanup is a success condition, not a report

The gate cleans up explicitly on the success path and **asserts** the result through the `real_provider
cleanup` verdict; the EXIT trap is the failure path's cleanup and **reports** rather than asserts, with one
bounded exception — it measures set preservation and may turn a green run **red**, never the other way.

Every removal is scoped to **this run's own** compose project, containers, network and volumes, named by a
run id that is the pid **plus four bytes of entropy**. Ownership of the network is decided from an inventory
taken **before the first create**, which is the only moment at which "did this run create it?" has an answer.

### 10.2 Redaction

Every emitted document passes `assertSealedSafe` / `findLeaks` / `findResultLeaks`, **reused and never
re-implemented**. The readiness recorder's scrubber runs over the **rendered** record rather than over its
pieces, and **fails closed**: a suspected leak refuses the whole record rather than printing something it
cannot stand behind. The eight provider source allowlists are **not widened**: `phase13.ts` names no
provider, which is why it does not have to be.

### 10.3 Mount ownership

**One mount point keeps exactly one owner.** Phase 13 starts no second daemon, writes no Compose service for
one, and does not mount, bind, unmount or write inside the projection mount point. The gate's own mount is
its own, under its own run directory, and is removed by the run that created it. The appliance's container,
network and mount point are named nowhere in Phase 13's instrument and are not touched.

**A mount point's owner is the mountinfo tuple, not the filesystem type**, and a fresh fact paired with a
sampled one invents an instant — which is why E8's baseline is taken immediately before the run and not read
out of an earlier record.

---

## 11. What Phase 13 may NOT close

**No `P11-R*` verdict of any kind.** `P11-R1` is a conjunction about co-residency and Phase 13 supplies one
of its two conjuncts; `PHASE13_FORBIDDEN_EMITTABLE_IDS` refuses all four **by id as well as by prefix**, and
`phase13ClosureProblems` refuses a result set containing one. Phase 12 §13.1 supersedes the sentence that
called Phase 13's share "the provider half".

**No `P9-` verdict.** `P9-2`, `P9-3`, `P9-5` and `P9-11` are exactly as open as Phase 11 left them, and Phase
10 §8's prerequisite is inherited and discharged by none of this.

**No `P10-`, `P12-` or `P13PRE-` verdict.** Those tranches' records are closed and Phase 13 writes into none
of them. `P13-S2` **reads** a Phase 12 result; it does not write one.

**Nothing about the mixed product.** A real TorBox object alone in a generation demonstrates nothing about
co-residency with a Usenet-admitted file, which is Phase 14's subject.

**Nothing about media servers, outages, soaks, uptime, load, a second host or a release.**

---

## 12. What Phase 13 MAY close

The eight Tier A arms and the three Tier S claims of §5, and **nothing else**. Each is an id minted by this
document, in a namespace no earlier tranche has written into, describing something the shipped gate actually
observes.

**A GO here is the sentence in §2.3 and no larger one.**

---

## 13. File ownership — every path this tranche touches

**THIS TABLE IS THE AUTHORITY, and it is complete.** `src/core/projection/phase13.ts` deliberately carries
only the subset that does not name a provider — all eight provider source allowlists refuse an unlisted
`src/` file that names one, and this tranche widens none of them. `test/projection-phase13.ts` parses the
paths out of this table, unions them with the module's list, and runs `phase9RequiresSoakRerun` over the
**union**, so the soak question is asked of everything.

| Path | New or modified | What changed |
|---|---|---|
| `docs/PROJECTION_PHASE_13_REAL_PROVIDER_ACCEPTANCE.md` | new | this contract and its run record |
| `src/core/projection/phase13.ts` | new | §5's claims, §5.3's thresholds, §6's entry criteria and §7's exit criteria, as code — including `phase13BudgetKeysFor` (§5's Budget column in full), the E6/E9 agreement refusal, E9's two plan-count refusals, E3's `repairsWithoutAControlInCandidate`, and `phase13ExitRefusals` |
| `test/projection-phase13.ts` | new | the tranche's own rules, and the prose ↔ function agreement — including the row-by-row Budget-column comparison, the driven proof that every named budget is read, the D3 sweep over `PHASE13_RULES`, the two entry-gate regressions, the origin-plan field-drop sweep, the §7 sweep, and the §2.3 pin control |
| `docs/PROJECTION_PHASE_12_AUDIT_AND_PROVIDER_FREE_CLOSURE.md` | modified | **§13 ONLY** — the amendment superseding §12.1's two sentences and recording the candidate rule. No §1–§12 sentence, threshold, refusal, claim id or claim wording is edited |
| `docs/PROJECTION_PHASE_13_PRE_ENTRY_INSTRUMENT_REPAIR.md` | modified | **§10.1, §10.3, §12.5 and a new §13 ONLY** — the three stale figures a re-audit named, the three unlisted commits, and the eight residuals' dispositions |
| `deploy/projection-real-provider-gate.sh` | modified | the collision-resistant run id, the 0700 observations directory, the failure-path set-preservation measurement, and the `grep -c` defect |
| `deploy/projection-torbox-real-gate.sh` | modified | the collision-resistant run id, the failure-path set-preservation measurement, and the `grep -c` defect. **Nothing about what it observes** |
| `test/projection-phase13-preentry.ts` | modified | the fail-closed git-driven ownership check, the post-candidate ownership union, and the §10.3 ↔ §11 agreement check |
| `test/projection-phase13-preentry-gate-audit.ts` | modified | the driven controls for N4, N5, N6 and N7, and the regression for the `grep -c` defect |
| `test/projection-real-provider.ts` | modified | its run-id pins follow the derivation |
| `src/ops/projection-emby-dataplane.ts` | modified | the provider-free validation repair: `docker run` may use an already-local image only and cannot resolve a missing image through a registry |
| `test/projection-emby-dataplane.ts` | modified | the offline missing-image control is rejected locally by Docker's argument parser, and structurally pins `--pull=never`, so the suite cannot contact or wait on a registry |
| `test/suite-inventory.json` | modified | the new offline suite |
| `package.json` | modified | the new scripts. **No existing script's meaning changes** |

**Not touched, and checked:** everything on `PHASE13_FORBIDDEN_SOURCE`. **No `projectiond/` source. No
product daemon change of any kind. No `deploy/projection-torbox-real-gate-three.sh` change** — the wrapper
Phase 13's own sequence claim is measured through is frozen at the candidate.

---

## 14. RUN RECORD — **PHASE 13 IS NOT RUN**

### 14.1 STATUS

| | |
|---|---|
| Phase 13 | **NOT RUN. NOT ENTERED.** |
| Provider contact | **none, ever, by this repository** |
| Tier A verdicts | **none.** All eight are unrecorded, which is not the same as skipped and is not the same as failed |
| Tier S verdicts | **none** |
| `P11-R1` | **NOT RUN**, and it has no half |
| What has been done | this contract; the Phase 12 amendment; the pre-entry instrument repair and its re-audit residuals; and the preparation campaign §14.2 records |

### 14.2 The preparation campaign — what it is, and what it is NOT

**IT IS NOT A PHASE 13 RUN AND IT CLOSES NO CLAIM OF §5.** No provider, CDN, resolver, indexer, NNTP server,
media server or production container was contacted. No credential was read for value, printed, written into
evidence or rotated. `endpoint.json` was **not read for value**, not written, and its `allowedOrigins` was
not widened, reordered or edited. Every Tier A and Tier S claim of §5 is **unrecorded**, which is not the
same as skipped and is not the same as failed.

What it did was discharge the provider-free half of §6, so that the entry decision in §14.3 is a decision
about measured facts rather than about intentions.

#### 14.2.1 The candidate, and its own Phase 12 GO — **E3, E4**

**`cdbad42bf04d4653af7ac26a6a00fa15087e7736`.** The complete Phase 12 provider-free sequence ran from it
**three consecutive fresh times, zero skips, on the operator's real Unraid host**, and Phase 12 §13.5 is that
record. Staged three separate times, **0 files differing and 0 text files carrying a CR** each time. The
daemon image digest is `sha256:216f1ae6…` in all three — **the same digest `a8d7232` produced**, which is
what says no daemon byte moved across the pre-entry repair, its residuals or the Phase 12 amendment.

`phase10ClosureProblems`, `phase11ClosureProblems` (tier one), `phase12ClosureProblems` and
`phase13PreEntryClosureProblems` were **run** over this campaign's verdicts and each returned **0 problems**;
the same evidence with one byte changed returns problems from all three, and at two sequences rather than
three `phase12ClosureProblems` returns 2. **E4 is satisfied.**

#### 14.2.2 The no-contact readiness record — **E6**, and nothing else

`deploy/projection-preentry-readiness.sh record` was run **on the real host**, against the operator's own
approved input directory, **twice**. **IT CONTACTS NOTHING**: no socket is opened, no resolver started, no
container run, no resolution spent. Its scrubber runs over the RENDERED record and **fails closed** — a
suspected leak refuses the whole record rather than printing something it cannot stand behind.

**WHAT IT REPORTED, AND THIS IS THE WHOLE OF WHAT MAY BE WRITTEN DOWN:**

| what | shape only |
|---|---|
| the input directory | present, `directory`, mode **0700** |
| the two secret files | present, `regular-file`, mode **0600**, non-empty, **not digested** — a digest of a short token is derived from its content, and nothing this program writes may be |
| `objects.json` | present, `regular-file`, mode **0600**, whole-file digest `b3962c49…`, shape `array[1]` |
| `endpoint.json` | present, `regular-file`, mode **0600**, whole-file digest `fce52a48…`, shape `allowInsecureHttp:boolean, allowPrivateAddresses:boolean, allowedOrigins:array[6], id:string` |
| the origin allowlist | **6 members**, as **6 member digests**, sorted |
| the endpoint's transport shape | names **neither** a resolver URL nor a direct base URL |

**THE TWO RECORDS ARE IDENTICAL IN EVERY DIGEST**, which is the demonstration that the before/after method
`P13-A8` rests on works without contacting anything: a digest of a file nobody edited is the same digest.

**AND THE LAST ROW IS A SECOND, INDEPENDENT CONFIRMATION THAT §2.2 NAMES THE RIGHT INSTRUMENT.** An
`endpoint.json` naming neither transport is exactly what the provider-specific gate REQUIRES — it constructs
the resolver URL from a network namespace it creates — and exactly what the generic real-provider gate
REFUSES. The operator's directory is prepared for the gate this contract names, and would make the other one
fail rather than skip.

**NO VALUE, NO URL, NO ORIGIN, NO OBJECT REFERENCE, NO MEDIA IDENTITY AND NO OPERATOR SHARE PATH IS IN THIS
DOCUMENT**, and none was read out to produce that table. A member digest is not a locator and cannot be
dialled.

#### 14.2.3 The host, measured immediately after the campaign — **E8, partly**

46 containers / 18 networks / 47 volumes, **identical to how the campaign found them**; **0** `projection-*`
containers; no appliance container and no appliance network; **0** mountpoints under the staging directory;
ports 5670 / 5680 / 8300 / 5580 / 8140 all free; no other gate campaign running. What the campaign left is
named with its size in Phase 12 §13.5, including one image it re-pulled.

#### 14.2.4 The entry criteria, run rather than summarised — `phase13EntryRefusals`

| # | Criterion | Result |
|---|---|---|
| **E1** | the contract is committed before anything is run | **MET.** `6cf953a` precedes every commit that measures anything |
| **E2** | Phase 12 is amended by its own §8 procedure | **MET.** Phase 12 §13, commit `50492b4` |
| **E3** | the candidate is frozen, staged, byte-identical both ways | **MET.** 0 differing, 0 CR, three times |
| **E4** | the candidate carries a Phase 12 GO of its own | **MET.** Phase 12 §13.5 |
| **E5** | the operator's four inputs, both secrets 0600 **and different values**, and one entitled object confirmed **by reference only** | **NOT MET — TWO FIELDS UNEVALUATED.** All four inputs are present at 0600 and non-empty. Whether the two secrets **differ** cannot be answered without reading their contents, which §4's first refusal forbids this tranche; the gate's own preflight answers it at run time with a `cmp` inside the process. And no operator has confirmed an entitled object |
| **E6** | the allowlist exists, is serving, and admits the pool | **PARTIALLY MET.** The record is taken and the allowlist admits **6** members. Whether those six are the pool the operator's objects are served from is E7's and E9's question, and the answer below is no |
| **E7** | the origin recheck inside the hour, exit 0 | **NOT MET — NOT MEASURED.** `deploy/projection-provider-origin-recheck.sh` **starts a resolver and spends one resolution against the operator's metered account**, which is provider contact and is forbidden here. **Not measured is not allowed**, and this refusal is the contract working rather than failing |
| **E8** | no other campaign, residue accounted for, **a fresh before-baseline** | **NOT MET — one field.** No other campaign is running, the residue is accounted for and the ports are free; but a baseline taken now is a **sampled** fact by the time a run starts, and pairing it with a fresh one invents an instant. It must be re-taken immediately before the run |
| **E9** | the origin-stability plan | **NOT MET — TWO REFUSALS, AND ONE OF THEM IS THE FINDING OF THIS CAMPAIGN.** See §14.3 |

`phase13MayEnter` returns **false**, with **seven** refusals. Each names the field somebody has to go and
fill in.

### 14.3 THE ENTRY DECISION — **PHASE 13 ENTRY IS NOT AUTHORISED**

**Not one of the seven refusals is a fact about the product.** Four are measurements nobody has taken yet,
two need a person, and one is a fact about the provider's CDN that the operator has to act on.

**THE ONE THAT MATTERS MOST IS E9, AND IT IS EXACTLY WHAT §8 EXISTS FOR.** The pool is observed serving from
**seven** distinct origins — `docs/PROJECTION_ALPHA_OPERATOR_RUNBOOK.md` measured that on this host across
one day, each origin served for roughly forty to eighty-four minutes, cycling back — and the operator's
allowlist admits **six**. Some member of the pool is therefore **outside** it, and a rotation onto that
member during a three-run sequence is **certain given enough time**. Its signature is precise: `stat`
succeeds, the listing is perfect, and every read fails `EIO` in well under a second.

**THAT WOULD READ AS A HARD FAIL ABOUT THE PRODUCT, AND IT IS NOT ONE.** A Phase 13 run started today would
very likely go red for a reason that has nothing to do with the data plane, and the natural next move —
widen `allowedOrigins` until it goes green — is the one thing §4's second refusal, §8, and Phase 12 §12.1 all
forbid. **A widening made to turn a run green is a permanent change to an egress control, made under time
pressure, to admit a host nobody verified.** It is escalated as a **count and a digest**, which is what
§14.2.2's table is, and the operator decides.

**AND THE SECOND E9 REFUSAL IS THE HONEST ONE ABOUT THIS RECORD ITSELF.** The seven-origin figure is a
sampled fact from a runbook, not a measurement taken within `ORIGIN_RECORD_MAX_AGE_MINUTES` of a run. The
plan is refused for carrying no current age, not merely for the count.

#### What is left for an operator, and it is all of it

Every one of these needs a person, a window, or a resolution against a metered account. **None is this
tranche's to discharge, and none of them can be discharged by reading.**

1. **Confirm the two secret files are different values** (E5). The gate's own preflight does this with a
   `cmp` inside the process and fails closed if they are equal; nothing here may read them.
2. **Confirm at least one entitled object, by reference only** (E5). The reference never enters an emitted
   document.
3. **Reconcile the allowlist with the observed pool** (E6, E9) — the count is 6 against an observed 7. This
   is an operator decision about an egress control, escalated here as a count and a digest and **not** made
   by this tranche.
4. **Run `deploy/projection-provider-origin-recheck.sh` inside the hour before the sequence** (E7). Exit 0
   proceeds; **exit 70 is a blocker escalated as a digest and never widened**; anything else is not measured,
   and not measured is not allowed.
5. **Declare a bounded sequence duration and take a current origin measurement** (E9), so the plan is about
   the origin being served now rather than about a different one.
6. **Take the before-baseline immediately before the run** (E8).

Only then does `phase13MayEnter` return true — and **even then it is not an authorisation**. It says the
criteria this repository can check are met. Contacting a provider is the operator's decision, in the
operator's own window, against the operator's own metered account.

#### The state of every claim, unchanged by all of this

**PHASE 13 IS NOT ENTERED AND NOT RUN.** All eight Tier A arms and all three Tier S claims are
**unrecorded**. `phase13ClosureProblems` given this campaign's evidence returns **twelve** problems — the
mode is not `real`, and each of the eleven claims has no verdict — which is the function refusing to close
anything, driven rather than asserted.

**`P11-R1` IS NOT RUN AND HAS NO HALF.** **Phase 9's `P9-2`, `P9-3`, `P9-5` and `P9-11` stay OPEN.** **Phase
11 tier two stays OPEN.** **Phase 10, Phase 11 tier one and Phase 12's `a8d7232` record stay GO**, and Phase
12 now additionally records a GO for `cdbad42` in its own §13.5. **Phase 14 and Phase 15 are NOT ENTERED and
no work of theirs was begun.** `phase9RequiresSoakRerun` over every path this branch touches returns
**FALSE**; **zero** of the provider source allowlists moved; **zero** `projectiond/` files changed.

### 14.4 The record commit, measured

Phase 12 §13.6 carries it: the commit that added §14 above was re-measured — `npx tsc --noEmit` clean, the
**full offline inventory 339/339/0 failed/0 required-but-skipped from Git Bash AND from an ordinary
PowerShell**, seventeen suites green one by one including all four gate audits, the soak trigger **FALSE**
over every path changed since `a8d7232` and since `fe4c1fd`, **zero** `projectiond/` files, and **zero** of
the eight provider source allowlists moved. The working tree was clean entering and leaving.

**IT CLOSES NOTHING.** It shows that the documentation edits carrying this record leave every suite that
reads them green, and Phase 12 §13.7 records exactly what is left on the host. **Phase 13 is still NOT RUN
and NOT ENTERED.**

### 14.5 THE REPAIR TRANCHE — an independent review of the record commit, and what it found

**IT IS NOT A PHASE 13 RUN EITHER, AND IT CLOSES NOTHING.** No provider, CDN, resolver, indexer, NNTP server,
media server or production container was contacted. No credential, `endpoint.json`, object reference, URL,
origin, media identity or allowlist member was read for value, printed or stored. No allowlist was widened.
Every Tier A and Tier S claim of §5 is still **unrecorded**.

An independent read-only review of `b676b58` reproduced **three MEDIUM** defects and **three LOW** ones, all
of them in this tranche's own contract and module rather than in any product source. Each was **reproduced
here from first principles before anything was changed**, and each repair carries a control that **fails on
`b676b58`'s bytes**.

| # | What it was | Where it is repaired | The control that fails without the repair |
|---|---|---|---|
| **F1** | **MEDIUM.** E6 read `allowedOriginCount`, E9 read `originPlan.allowedOriginCount` — two copies of ONE fact, and nothing asserted they agreed. Filling the plan's copy in as the observed pool size made §14.3's six-against-seven refusal **disappear** and `phase13MayEnter` returned **true** with an EMPTY list | §6, and `phase13EntryRefusals` | `phase13MayEnter` on the campaign's own figures with the plan's copy at 7: **true** before, **false** after |
| **F2** | **MEDIUM.** `originStabilityRefusals` compares the pool to the allowlist only when both are numbers, so an **absent** `observedPoolSize` — or an absent plan-side `allowedOriginCount` — produced **no refusal at all** | §6 and §8, at **E9's own site**. `phase13-preentry.ts` is on `PHASE13_FORBIDDEN_SOURCE` and §4's ninth refusal forbids this tranche to edit it; it is **byte-identical** | `phase13MayEnter` on a plan missing either count: **true** before, **false** after. A pool of **zero** is still a measurement and still passes |
| **F3** | **MEDIUM.** §5's Budget column named two thresholds for four claims and `phase13BudgetKeyFor` returned one. `RESIDUE_MAX` was read by **no function**; `CONSECUTIVE_FRESH_RUNS` by nothing at closure; `P13-S2` had **no** budget and **actively refused** a result set recording it the way §5.2 documents it | §5, `phase13BudgetKeysFor`, and the second measurement fields | driving `residueSurviving: 1`, and `consecutiveFreshRuns: 1` on `P13-S1` and on `P13-S2`: **no problem raised** before, refused after. `phase13BudgetKeyFor` for `P13-S2`: `undefined` before, `SKIPPED_CLAIMS_MAX` after |
| **F4** | **LOW.** `REPAIRS_WITHOUT_A_CONTROL_MAX` was named by no claim and read by no function — the **D3** class the pre-entry tranche found in `P13PRE-C3` | §5.3 and E3, through `repairsWithoutAControlInCandidate` | `phase13MayEnter` with one repair carrying no control: **true** before, **false** after. And a sweep now asserts **every** key of `PHASE13_RULES` is named by a claim or **driven** to a refusal |
| **F5** | **LOW.** §7 was six strings. X3 and X5 had **no executable counterpart at all**, while §13 claimed the module carries §7 "as code" | §7 and `phase13ExitRefusals` | the export does not exist before; after, an entirely unevaluated exit state refuses on **all six** of X1…X6 |
| **F6** | **LOW.** `b838f11`, the commit that added `phase13.ts`, also dropped **TorBox** and **Unraid** from §2.3's meaning so `PHASE13_MEANING` could carry it without putting a provider name in `src/` | **ACCEPTED RESIDUAL, recorded in §2.3 rather than rewritten.** History is not falsified and no claim, threshold, refusal or criterion moved with it | a control asserts §3.1's and §5.1's pins — the two gate scripts, the operator's own **Unraid** host, the operator's own **TorBox** account, the **TorBox** credential and the **TorBox** stable references — are still present word for word, so the neutralisation cannot spread |

**AND ONE FINDING OF THIS TRANCHE'S OWN, found while checking whether F2 could be repaired where it lives.**
§4's ninth refusal described `PHASE13_FORBIDDEN_SOURCE` as already containing the two gate scripts. The
constant has never held them and §13's own table records both as **modified by this tranche, each with a
control**. The sentence is corrected to say what the rule always was — the instrument freezes when the
candidate does — rather than the constant being widened to match a sentence, which would have made this
tranche's own §13 table illegal retroactively. `deploy/projection-torbox-real-gate-three.sh` is unmodified
and stays so. §8's opening sentence, which was missing a clause and did not parse, is completed to the
reading §14.3 already carries.

#### 14.5.1 What the review reproduced and did NOT find

The same review re-measured every figure in §14.2 and §14.4 independently and **all of them reproduced
exactly** — the seven refusals and their identities, the twelve closure problems, `339 / 339 / 0 failed / 39
not selected / 0 required-but-skipped`, the 15 M / 5 A of §10.3, the 18 commits, the soak trigger FALSE over
both path sets with **zero** `projectiond/` files, and the host figures **46 / 18 / 47**, zero
`projection-*` containers, zero mountpoints, five ports free, 125 MB / 125 MB, and the daemon image digest
`sha256:216f1ae6…` **identical to Phase 12's**. **No forbidden path had moved, no source allowlist had moved,
and no credential, URL, origin, object reference, media identity or allowlist member appeared anywhere in the
diff.** The findings above are latent contract defects that bite at the **first real run**, which is why they
are repaired **before** an entry decision rather than after one.

#### 14.5.2 The entry decision is UNCHANGED, and it was re-measured rather than restated

`phase13EntryRefusals`, driven over exactly the facts §14.2.4 records, still returns **SEVEN** refusals and
`phase13MayEnter` is still **false**. **They are the same seven** — 2×E5, 2×E7, 1×E8, 2×E9 — and that is the
point: the repairs close paths by which an entry could have been authorised on an inconsistent or unmeasured
state, and they manufacture **no new blocker** for a state that was honestly filled in.  §14.3's remediation
list stands unchanged, and none of it is this tranche's to discharge.

**AND E4 IS NOW REFUSED AS WELL, WHICH MAKES EIGHT, BECAUSE THE CANDIDATE CHANGED.** Repairing F1–F5 moved
`src/core/projection/phase13.ts` and `test/projection-phase13.ts` — bytes arm 9 and arm 10 of a Phase 12
sequence both read — so `cdbad42` is superseded as a Phase 13 candidate under Phase 12 §13.3's own rule, and
Phase 12 §13.8 records that. Until the complete Phase 12 provider-free sequence has run from the new
candidate **three consecutive fresh times with zero skips**, no candidate carries a Phase 12 GO of its own and
**E4 is NOT MET**.

**PHASE 13 ENTRY REMAINS NOT AUTHORISED. PHASE 13 IS NOT RUN AND NOT ENTERED.** All eight Tier A arms and all
three Tier S claims are **unrecorded**. `P11-R1` is NOT RUN and has no half. Phase 9's `P9-2`, `P9-3`, `P9-5`
and `P9-11` stay OPEN; Phase 11 tier two stays OPEN; Phase 10, Phase 11 tier one and Phase 12's `a8d7232`
record stay GO, and Phase 12's `cdbad42` record in §13.5 stays exactly as written — it is a statement about
`cdbad42`. **Phase 14 and Phase 15 are NOT ENTERED and no work of theirs was begun.**

### 14.6 THE CANDIDATE AND ITS SEQUENCES — **E4 IS NOW MET, AND ENTRY IS STILL NOT AUTHORISED**

**THIS IS STILL NOT A PHASE 13 RUN.** No provider, CDN, resolver, indexer, NNTP server, media server or
production container was contacted. No credential, `endpoint.json`, object reference, URL, origin, media
identity or allowlist member was read for value, printed or stored. No allowlist was widened. **Every Tier A
and Tier S claim of §5 remains unrecorded.**

#### 14.6.1 The candidate — **E3**

**`96f750c628a69493569ba1e7a6dfed5ae7655ffd`**, the commit carrying Phase 12 §13.8 and §14.5. Staged onto the
operator's real Unraid host **three separate times**, once at the head of each sequence, each proving **0
files differing and 0 text files carrying a CR** in both directions. **Repairs carrying no control: 0** —
every one of F1…F5 has a control that was watched failing on `b676b58`'s bytes, which is the field
`REPAIRS_WITHOUT_A_CONTROL_MAX` is now read through.

#### 14.6.2 The candidate's own Phase 12 GO — **E4**

**The complete Phase 12 provider-free sequence ran from `96f750c` three consecutive fresh times, zero skips,
on the operator's real Unraid host**, and Phase 12 §13.9 is that record. Ten arms each, no arm skipped, folded
or omitted. **The daemon image digest is `sha256:216f1ae6…` in all three — the same digest `a8d7232` and
`cdbad42` produced** — which is what says no daemon byte moved across the repair.
`phase10ClosureProblems`, `phase11ClosureProblems` (tier one), `phase12ClosureProblems` and
`phase13PreEntryClosureProblems` were **run** over this campaign's verdicts and each returned **0 problems**;
each has a control that moves it — two sequences rather than three, the same evidence offered as tier two, one
verdict moved to `skip`. **E4 IS SATISFIED, and it is satisfied by THIS candidate rather than inherited.**

#### 14.6.3 The host — **E8, partly**, and it is the same partly as before

46 containers / 18 networks / 47 volumes before and after **every one of the three sequences**, with **0**
names lost and **0** gained in each kind, **0** differing `docker ps -a` rows, **0** mountpoints under the
staging directory, **0** `projection-*` containers, no appliance container, no appliance network,
`endpoint.json` absent under the appliance path, and ports 5670 / 5680 / 8300 / 5580 / 8140 all free. What the
campaign leaves is named with its size in Phase 12 §13.9. **E8 is still NOT MET on one field**: a baseline
taken now is a **sampled** fact by the time a run starts, and pairing it with a fresh one invents an instant.

#### 14.6.4 The entry criteria, run rather than summarised — `phase13EntryRefusals`

**`phase13MayEnter` returns `false`, with SEVEN refusals**, driven over exactly the facts §14.2 and §14.6
record. They are **the same seven** §14.2.4 recorded — 2×E5, 2×E7, 1×E8, 2×E9 — with **E3 and E4 now met for
this candidate** rather than for a superseded one.

| # | Criterion | Result |
|---|---|---|
| **E1** | the contract is committed before anything is run | **MET.** `6cf953a` precedes every commit that measures anything |
| **E2** | Phase 12 is amended by its own §8 procedure | **MET.** Phase 12 §13, commit `50492b4`; §13.8 and §13.9 extend the same section |
| **E3** | the candidate is frozen, staged, byte-identical both ways, and carries no repair without a control | **MET.** 0 differing, 0 CR, three times; 0 repairs without a control |
| **E4** | the candidate carries a Phase 12 GO of its own | **MET.** Phase 12 §13.9 |
| **E5** | the operator's four inputs, both secrets 0600 **and different values**, and one entitled object confirmed **by reference only** | **NOT MET — TWO FIELDS UNEVALUATED**, unchanged from §14.2.4 and for the same reasons: reading the two secrets to compare them is what §4's first refusal forbids this tranche, and no operator has confirmed an entitled object |
| **E6** | the allowlist exists, is serving, and admits the pool | **PARTIALLY MET.** The record is taken and the allowlist admits **6** members. The two copies of that count now have to AGREE, and they do — both say 6. Whether those six are the pool is E7's and E9's question, and the answer is still no |
| **E7** | the origin recheck inside the hour, exit 0 | **NOT MET — NOT MEASURED**, unchanged. The recheck starts a resolver and spends one resolution against the operator's metered account, which is provider contact and is forbidden here |
| **E8** | no other campaign, residue accounted for, **a fresh before-baseline** | **NOT MET — one field**, unchanged |
| **E9** | the origin-stability plan | **NOT MET — TWO REFUSALS.** The plan carries no current age, and the pool is **7** against an allowlist of **6**. Both counts are now required to be present and both are; a plan missing either would be refused by name |

**AND THAT THE COUNT DID NOT MOVE IS THE POINT OF §14.5.** The repairs close paths by which entry could have
been authorised on an inconsistent or unmeasured state — the same seven refusals could previously be reduced
to **zero** by filling one field in differently — and they manufacture **no new blocker** for a state that was
filled in honestly.

#### 14.6.5 The state of every claim, unchanged by all of this

**PHASE 13 IS NOT ENTERED AND NOT RUN. PHASE 13 ENTRY IS NOT AUTHORISED.** All eight Tier A arms and all three
Tier S claims are **unrecorded**. `phase13ClosureProblems` given this campaign's evidence returns **twelve**
problems — the mode is not `real`, and each of the eleven claims has no verdict — which is the function
refusing to close anything, driven rather than asserted, and `phase13Closed` is **false**.

§14.3's remediation list stands **unchanged and complete**: the two secret values, the entitled object, the
allowlist against the observed pool, the origin recheck inside the hour, a bounded duration with a current
origin measurement, and the before-baseline. **None is this tranche's to discharge and none can be discharged
by reading.**

**`P11-R1` IS NOT RUN AND HAS NO HALF.** Phase 9's `P9-2`, `P9-3`, `P9-5` and `P9-11` stay OPEN. Phase 11 tier
two stays OPEN. Phase 10, Phase 11 tier one and Phase 12's `a8d7232` record stay GO; Phase 12's `cdbad42`
record stays exactly as written and is superseded only as a **candidate**, never as a record. **Phase 14 and
Phase 15 are NOT ENTERED and no work of theirs was begun.** `phase9RequiresSoakRerun` is **FALSE** over every
path this branch touches; **zero** provider source allowlists moved; **zero** `projectiond/` files changed.

### 14.7 The record commit, measured, and what is left on the host

Phase 12 §13.10 carries it: the commit that added §14.6 above — `5d80dd0` — was re-measured. **`npx tsc
--noEmit` clean**, the **full offline inventory 339 / 339 / 0 failed / 39 not selected / 0
required-but-skipped from Git Bash AND from an ordinary PowerShell**, `RESULT: PASS` on both, **seventeen
suites green one by one** including all four gate audits and both Phase 13 suites, the soak trigger **FALSE**
over every path changed since `a8d7232`, `fe4c1fd`, `cdbad42` and `b676b58`, **zero** `projectiond/` files,
and **zero** of the eight provider source allowlists moved. The working tree was clean entering and leaving.

**IT CLOSES NOTHING.** It shows that the documentation edits carrying this record leave every suite that reads
them green, and Phase 12 §13.9 records exactly what is left on the host.

#### What is left on the host, measured after everything

| what | measured |
|---|---|
| containers / networks / volumes | **46 / 18 / 47**, identical to how the campaign found them |
| `projection-*` containers; appliance container; appliance network | **0 / 0 / 0** |
| mountpoints under the staging directory | **0** |
| ports 5670 / 5680 / 8300 / 5580 / 8140 | **all five free** |
| `/mnt/user/appdata/catalog-phase13-preentry-authorization` | **125 MB** — this campaign's staging directory, holding the new candidate |
| `/mnt/user/appdata/catalog-phase12-closure` | **125 MB** — §10.8's, untouched |
| `projectiond:phase13prep-frozen` / `projectiond:phase12-frozen` | 10.3 MB each, **both `sha256:216f1ae6…`** |
| `golang:1.26` | **874 MB, re-pulled** by this campaign — all three preflights reported it ABSENT. An image is not a container, a network or a volume |
| `endpoint.json` under the appliance's own path | **absent**, before and after every sequence |
| the campaign's own artefacts — one host-side runner script, three transcripts, eight per-arm gate logs | **read off the host and deleted.** `/root` holds nothing dated later than 2026‑08‑15, which is an earlier campaign |

**PHASE 13 IS STILL NOT RUN AND NOT ENTERED, AND ENTRY IS STILL NOT AUTHORISED.**

### 14.8 NUMERIC-DOMAIN REPAIR — contract and invalidation recorded before implementation

An independent review of `2e51127` drove the shipped exports directly and found that one-sided comparisons
accepted invalid numeric evidence across all three decision surfaces. Before this amendment or any
implementation change, the scratch matrix observed `phase13MayEnter === true` for `NaN` and negative repair,
run-floor, age and host-count evidence; `phase13Closed === true` for invalid claim measurements, residue,
fresh-run totals and A4 ratio inputs; and `phase13ExitSatisfied === true` for invalid completed-run, skipped-run,
moved-member, host-loss and residue values. The matrix included `NaN`, both infinities, negatives and
fractional count values, with which exact invalid values happened to fail already recorded rather than
misreported as repaired.

§5.4 is the contract-first amendment: it assigns every decision-bearing numeric field to an executable
semantic domain before comparison, preserves legitimate zero measurements, and requires a structural sweep
so a later field cannot silently inherit `typeof number` plus a one-sided comparison. The implementation and
table-driven controls follow in later commits; `src/core/projection/phase13-preentry.ts` remains byte-identical.

**Candidate `96f750c` is invalidated before any new measurement.** Phase 12 §13.11 records the invalidation and
the restart-at-one rule. Phase 13 is **NOT RUN, NOT ENTERED, AND ENTRY IS NOT AUTHORISED**; all eleven claims
remain unrecorded, the seven live-entry refusals remain to be re-measured, and Phases 14 and 15 are not entered.
