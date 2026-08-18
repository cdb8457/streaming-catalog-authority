# Projection Phase 13 — PRE-ENTRY INSTRUMENT REPAIR

**PHASE 13 IS NOT ENTERED BY THIS DOCUMENT AND IS NOT ENTERED BY ANY COMMIT IT DESCRIBES.** No provider was
contacted. No credential was read, printed, written or rotated. No origin allowlist was read for value,
widened, reordered or edited. No container was started or stopped, no media server was touched, no host state
changed, and `endpoint.json` was neither read nor written. **`P11-R1` is NOT RUN**, has no provider half, and
waits on exactly what it waited on before: a real provider-backed entry and a real Usenet-admitted file
sitting in **one published generation**.

| | |
|---|---|
| What this is | the bounded repair of the **instrument** a later, separately authorised Phase 13 would have to use |
| What it is not | Phase 13, a provider run, an allowlist change, a host campaign, or a claim about the mixed product |
| Candidate | integration `f77871f` |
| Namespace | `P13PRE-*`. Deliberately **not** `P13-A*`/`P13-S*`, which belong to a real Phase 13 and stay unspoken for |
| Rules as code | `src/core/projection/phase13-preentry.ts` — written in the **same commit** as §5 below |
| Provoked by | an independent read-only readiness review of `a8d7232`, whose eleven blockers and five findings are dispositioned one by one in §9 |

---

## 1. What this tranche exists for

An independent reviewer read the instrument §12.1 of the Phase 12 document names as Phase 13's, and found
that it **cannot complete a single run in real mode**: it dies at a hardcoded fake-mode input path twelve
steps into a twenty-step program, on a call site nobody has ever executed. That is the headline, and it is
not alone. Four `-optional` wrappers run a gate other than the one their filenames name. Two arms of the
real-provider verdict module skip **forever**, because the observations that decide them are literals the
gate writes identically in both modes. Two `docker compose … up -d --wait` invocations carry no bound. A
cleanup removes a network the run may not have created. There is no way to record an origin allowlist
without spending a resolution against the operator's metered account.

**None of that is discovered by running a provider.** All of it is visible in the shipped bytes, and every
repair for it can be regressed offline. So it is done here, before anything is authorised against a real
account, and this document is the contract it is measured against.

**The order matters and is the reason this is a separate tranche.** Repairing an instrument during the run
that is supposed to use it is how a repair gets credited with a run it did not survive.

---

## 2. What is GO, what is OPEN, and what this tranche does to each

This table is the first thing a reviewer should read, and nothing below it may contradict it.

| | State before | State after | What this tranche did to it |
|---|---|---|---|
| **Phase 10** | **GO** (Phase 12 §10.9) | **GO** | nothing. No Phase 10 claim is written, moved, re-worded or narrowed |
| **Phase 11 tier one** | **GO** (Phase 12 §10.9) | **GO** | nothing |
| **Phase 12** | **GO** (§10.9, three consecutive fresh sequences from `a8d7232`; §10.10 measures the record commit `034ba2e`) | **GO** | nothing. `phase12.ts` is on this tranche's own forbidden list |
| **Phase 9** — `P9-2`, `P9-3`, `P9-5`, `P9-11` | **OPEN** | **OPEN** | nothing. Phase 10 §8's prerequisite is inherited and discharged by none of this |
| **Phase 11 tier two** — `P11-R1`…`P11-R4` | **OPEN / NOT RUN** | **OPEN / NOT RUN** | nothing. §12.1's sentence *"the provider half only of `P11-R1`"* is **superseded** in §8 below rather than implemented |
| **Phase 13** | **NOT ENTERED** | **NOT ENTERED** | its instrument was repaired. Entry is a separate authorisation, and §7 lists the operator prerequisites that are still outstanding |

### 2.1 The six sentences, verbatim

`PHASE13_PREENTRY_PRESERVED_STATES` in `phase13-preentry.ts` holds exactly these six, and
`test/projection-phase13-preentry.ts` asserts this document still carries every one of them word for word.
A tranche that stopped saying one of these would be a tranche that had quietly moved it.

- Phase 10 is GO and this tranche does not touch it
- Phase 11 tier one is GO and this tranche does not touch it
- Phase 12 is GO and this tranche does not touch it
- Phase 9 stays OPEN, and none of P9-2, P9-3, P9-5 or P9-11 is answered here
- Phase 11 tier two stays OPEN, and P11-R1 is NOT RUN and has no half to close
- Phase 13 is NOT ENTERED, and no live-provider claim is closed

### 2.2 What a pre-entry GO means, and no more

> the defects an independent readiness review found in the instrument a later Phase 13 would have to use are
> repaired, each with a control that fails on the unrepaired bytes. NO PROVIDER WAS CONTACTED, no credential
> was read, no allowlist was moved, no host state changed, and Phase 13 is NOT entered.

**Ceiling sentence**, held as a constant so a summary that grew past it has to edit a module:

> the instrument was repaired; nothing was run against a provider, and no claim of any tranche moved

### 2.3 What this tranche is not

It is none of these, and says so rather than leaving it to be inferred: **a real provider run**, **a soak**,
**a load test**, **an uptime claim**, **a second host**, **high availability**, **a production release**,
**Real-Debrid**, **instant Usenet streaming**, **automatic source failover**, **indexer search**.

---

## 3. Scope

### 3.1 In scope

Bounded repairs to gate scripts, their wrappers, their staging script and one new read-only recorder — plus
the contract, the rules module and the two suites that regress them. **This tranche ships no product daemon
source**, no `projectiond/` change, and no change to any module on `PHASE9_SOAK_TRIGGERING_SOURCE`.

### 3.2 Out of scope, and named rather than left to be inferred

- **Any provider contact.** Nothing here resolves a reference, opens a socket to a CDN, or spends a
  resolution. The one existing instrument that does — `deploy/projection-provider-origin-recheck.sh` — is
  **not modified and not invoked**; §6 only writes down the *policy* for how a later run must read its exit
  status.
- **Any host campaign.** No container is started, no image built, no network created, no staging directory
  cleared, no Tower state read or changed.
- **Anything about the mixed product.** A repaired instrument is not a run.
- **The generic real-provider gate's remaining architecture.** §9 records what was repaired in it and what
  was deliberately not.

---

## 4. Hard refusals

This tranche shall not:

1. **read, print, write into evidence, rotate, replace or change any credential**, or accept one from argv,
   an environment variable or a prompt. Every secret is named by **path** and opened inside the process that
   needs it;
2. **read `endpoint.json` for value, widen, edit, reorder or normalise `allowedOrigins`, or write
   `endpoint.json` at all**. The new recorder reads it to compute a digest, a count and a shape, and **emits
   no member of it**;
3. **contact a provider, a CDN, an indexer, an NNTP server, a media server or any production container**, or
   induce, simulate, provoke or wait for an outage;
4. **start a second daemon, write a Compose service for one, or mount, bind, unmount or write inside the
   projection mount point.** Where an appliance is needed a gate invokes `deploy/projection-alpha.sh`, and
   **one mount point keeps exactly one owner**;
5. **record a verdict for a claim it did not run, fold a skip into a pass, or report exit 77 as success.**
   77 is a SKIP, a SKIP is not a PASS, and the `-optional` entry points close **no** claim of this tranche
   or any other;
6. **write a `P9-`, `P10-`, `P11-`, `P12-`, `P13-A` or `P13-S` verdict of its own**, or move any claim of
   those tranches by any route — **and in particular it does not close, half-close, partially satisfy,
   re-word or narrow `P11-R1`**;
7. **weaken a threshold, delete a required suite, relax a required-but-skipped count, or rewrite a prior run
   record.** A superseded sentence is kept whole and marked superseded;
8. **weaken any staging refusal.** §5's `P13PRE-I7` admits one further marker as a **literal in the file**;
   nothing external can set one, and every other basename is refused exactly as before;
9. modify anything on `PHASE13_PREENTRY_FORBIDDEN_SOURCE`, which is Phase 12's forbidden list plus
   `phase12.ts` itself;
10. place a credential, an object reference, a URL, an origin, an access-material value, a media identity or
    an operator share path in **any** emitted document. `SealedValue`, `assertSealedSafe`, `findLeaks` and
    `findResultLeaks` are **reused**, never re-implemented, and the eight provider source allowlists are
    **not widened** — this tranche's source module names no provider, which is why it does not have to be;
11. **ask a human for a secret value, print one, or write one into evidence.** A blocker is recorded as the
    **shape** of what is missing;
12. push, merge, tag, open a pull request, change a default branch, deploy to production, enter Phase 13,
    begin Phase 14, or do any Real-Debrid work of any kind.

---

## 5. The claims

Every claim below is answerable **offline**, from the shipped bytes or from the provider-free path. A claim
that needed a packet would be a Phase 13 claim, and this tranche has none.

`PHASE13_PREENTRY_CLOSURE_GATE_IDS` holds these twelve ids **in this order**, and
`test/projection-phase13-preentry.ts` asserts the list and this document agree — so the defect Phase 12 found
in itself at its own §11.4, where the shipped function was stricter than the prose it was written from,
cannot recur here.

### 5.1 The instrument repairs

| id | Claim | Budget |
|---|---|---|
| `P13PRE-I1-every-optional-wrapper-invokes-the-gate-it-names` | **every** `deploy/*-optional.sh` invokes the gate its own filename names, and folds exit 77 alone | `MISWIRED_OPTIONAL_WRAPPERS_MAX` |
| `P13PRE-I2-the-provider-gate-real-mode-reads-the-operator-input-path` | in real mode the real-provider gate builds its daemon configuration from the **operator's** endpoint and gives the daemon the **operator's** credential; no real-mode call site names a fake-mode path | — |
| `P13PRE-I3-no-decision-bearing-observation-is-a-literal-a-run-cannot-move` | every observation a verdict **or a skip** is decided by is derived from a file the run wrote | `LITERAL_OBSERVATION_FIELDS_MAX` |
| `P13PRE-I4-every-compose-and-provider-wait-is-bounded` | every `docker compose … up -d --wait` in the two provider gates carries `--wait-timeout`, and every read through the mount is wrapped in `timeout --kill-after` with every status it can answer named | `UNBOUNDED_WAITS_MAX` |
| `P13PRE-I5-cleanup-removes-only-what-the-run-created` | a network, container or volume that existed before the run is **never** removed by it; ownership is recorded at creation and read at cleanup; the before and after sets are preserved exactly rather than compared as counts | `PREEXISTING_RESOURCES_REMOVED_MAX` |
| `P13PRE-I6-a-no-contact-readiness-record-emits-shape-only` | a readiness recorder exists that **contacts nothing** and emits existence, type, mode, size, whole-file digest, member **count** and per-member **digest** — and no value, URL, object reference, origin or allowlist member | `REDACTION_LEAKS_MAX` |
| `P13PRE-I7-staging-admits-a-guarded-pre-entry-directory-and-nothing-else` | staging admits one further **literal** marker for a pre-entry directory and refuses every other basename; the absolute-path guard, the traversal guard and the order of guard-before-clear are unchanged | — |
| `P13PRE-I8-a-skip-is-never-folded-into-success` | the closure function refuses any `skip`, refuses an absent verdict, and 77 propagates from every entry point a claim may be recorded from | — |
| `P13PRE-I9-no-earlier-tranche-claim-is-written-or-half-written` | no `P9-`, `P10-`, `P11-`, `P12-`, `P13-A` or `P13-S` id can carry a verdict here, and the eight untouchable ids are refused **by id as well as by prefix** | — |

### 5.2 The campaign

| id | Claim | Budget |
|---|---|---|
| `P13PRE-C1-typecheck-and-offline-inventory-both-shells` | `npx tsc --noEmit` clean, and the **full** offline inventory green from **Git Bash** and from an **ordinary PowerShell**, from one candidate | — |
| `P13PRE-C2-every-repair-carries-a-control-that-fails-on-the-unrepaired-bytes` | each repair above is re-run against a deliberately unrepaired copy of the shipped bytes and the check is asserted to **fail** | `REPAIRS_WITHOUT_A_CONTROL_MAX` |
| `P13PRE-C3-every-readiness-finding-carries-a-disposition` | every finding of the independent readiness review is repaired, superseded, or assigned out of scope **with an owner named** | `FINDINGS_WITHOUT_A_DISPOSITION_MAX` |

### 5.3 The thresholds

| name | value | source |
|---|---|---|
| `MISWIRED_OPTIONAL_WRAPPERS_MAX` | **0** | **NEW.** Four shipped. Counted over every `deploy/*-optional.sh`, not over the ones a phase happens to care about |
| `UNBOUNDED_WAITS_MAX` | **0** | **NEW.** A hang is worse than a failure, because a failure is a verdict and a hang is a person deciding to give up |
| `LITERAL_OBSERVATION_FIELDS_MAX` | **0** | **NEW.** A literal that feeds a verdict manufactures a pass; one that feeds a skip manufactures a skip no repair can clear |
| `PREEXISTING_RESOURCES_REMOVED_MAX` | **0** | **NEW.** "Left as found" is about a SET, and a count-only comparison is satisfied by a removal and a creation |
| `REDACTION_LEAKS_MAX` | **0** | **NEW.** A recorder that contacts nothing can still leak everything |
| `FINDINGS_WITHOUT_A_DISPOSITION_MAX` | **0** | **NEW.** The failure mode of a review is not a wrong finding; it is a finding that quietly stops being mentioned |
| `REPAIRS_WITHOUT_A_CONTROL_MAX` | 0 | **IMPORTED** — `PHASE12_RULES.REPAIRS_WITHOUT_A_CONTROL_MAX` |
| `SKIPPED_CLAIMS_MAX` | 0 | **IMPORTED** — `PHASE12_RULES.SKIPPED_CLAIMS_MAX` |

*A claim with no budget in this table has nothing to measure, and a run that supplies a measurement for one
has invented a budget.* `phase13PreEntryClosureProblems` refuses both directions.

**There is no `CONSECUTIVE_FRESH_RUNS` here, and its absence is deliberate.** This tranche runs no campaign
against a host and counts no fresh sequences; importing a floor it does not measure would be a threshold
with nothing behind it.

---

## 6. The origin policy, for a pool that rotates faster than a sequence takes

`docs/PROJECTION_ALPHA_OPERATOR_RUNBOOK.md` records the measurement that makes this necessary: **seven
distinct origins, each served roughly 40 to 84 minutes, cycling back.** A three-run provider sequence
includes three image builds, three migrations and three mounts. A rotation across it is **likely, not
hypothetical**, and its signature is precise: `stat` succeeds, the listing is perfect, and every read fails
`EIO` in well under a second.

Without a policy that reads as a hard **FAIL about the product**. It is not one, and the temptation it
creates — widen `allowedOrigins` until it goes green — is exactly the thing §12.1 calls a blocker rather
than a step.

So `phase13-preentry.ts` carries the policy as two functions:

- **`originStabilityRefusals(plan)`** — the reasons a sequence **may not start**. It refuses an unmeasured
  origin lifetime (an unmeasured lifetime is not a generous one); an unbounded sequence duration (there is
  nothing for a turn to cover); a duration that does not fit inside the **shortest observed** turn with
  `ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES = 10` of margin; an origin record older than
  `ORIGIN_RECORD_MAX_AGE_MINUTES = 60`, because a stale record is an answer about a **different** origin
  rather than a weaker answer about this one; and an observed pool **larger than** the allowlist, where a
  rotation out of it is certain given enough time.
- **`originRotationDisposition(status)`** — how the existing recheck's exit status is read: `0` proceed,
  `70` **`abort-origin-rotated`**, anything else **`abort-not-measured`**. **Neither abort is a FAIL, and
  neither is a licence to widen anything.** A `70` is escalated as a count and a digest.

**Nothing in this tranche runs either function against a provider.** They are the contract a later
authorised run is measured by, and the suite drives them over their own boundaries offline.

---

## 7. Operator prerequisites still outstanding for a later Phase 13

Recorded here so nobody reads a repaired instrument as a ready run. **None of these is this tranche's to
discharge**, and none was touched.

1. **A Phase 13 contract of its own** — claim ids, thresholds, entry and exit criteria, file ownership —
   written and committed **before** anything is run against a provider. This document is not it.
2. **A Phase 12 amendment superseding §12.1's two wrong sentences** (§8 below), following that document's own
   §8 procedure: the document changes first.
3. **The candidate question.** Phase 12's GO is recorded from `a8d7232`; a Phase 13 run must either use that
   commit or a descendant whose only differences are documents Phase 12's suites do not read — and this
   tranche's commits are **not** that, because they change source and suites. **A Phase 13 candidate that
   includes this work needs Phase 12's complete sequence run again from it.**
4. **The origin recheck within the hour before a sequence** — exit 0 to proceed; exit 70 is a **blocker**,
   escalated as a digest, never widened; any other status means not measured, and not measured is not
   allowed.
5. **No other gate campaign running on the host**, and its residue accounted for: zero `projection-*`
   containers, no `projection-alpha` container or network, and the gate's ports free.
6. **The generic gate's inputs, if it is ever the instrument.** The operator's `real-provider/` directory
   holds only the provider subdirectory; the generic gate's three files are absent, so it answers 77 there.
   §9 records that as found and not repaired-by-population — populating an operator directory is not this
   tranche's act.
7. **A fresh before-baseline**, taken immediately before a run. Any figure from a readiness review is a
   sampled fact by the time a run starts, and pairing it with a fresh one invents an instant.

---

## 8. The two sentences superseded, and why they are not rewritten

Phase 12 §12.1 is **kept whole**. Two of its sentences are superseded here, in the form this repository uses:
the original stands, and the correction is written beside it.

**Superseded 1 — *"the provider half only of `P11-R1`".*** There is no such half. `P11-R1` is a conjunction
about **co-residency**: a real provider-backed entry **and** a real Usenet-admitted file in **one published
generation**. One entitled object alone in a generation demonstrates nothing about co-residency, and calling
it "the provider half" is precisely the averaging Phase 11 §5.2 and Phase 12 §2.5 forbid. The code has always
agreed and is stricter than the prose: `phase11ClosureProblems` has no partial verdict, no half verdict and
no per-claim close, and a tier-one closure refuses to carry a tier-two verdict at all. **A later Phase 13
must mint a claim id of its own for what it actually observed**, and `P11-R1` stays `NOT RUN`.

**Superseded 2 — the instrument named.** §12.1 names `deploy/projection-real-provider-gate.sh`. That gate's
real mode has never run anywhere and, before this tranche, could not: it died at a hardcoded fake-mode input
path. It is repaired here, and the repair is regressed — but the **mature** provider instrument is
`deploy/projection-torbox-real-gate.sh`, which resolves in the daemon's own network namespace, never mounts
the provider key into the daemon, bounds its read step with a corpus-derived ceiling, captures and asserts
both container logs, scans byte-exactly for both secrets, and probes read-only refusals as both an
unprivileged uid **and** uid 0. **A later Phase 13 contract should name that one**, and the repaired generic
gate should be treated as repaired rather than as proven — a gate you are not running is a gate no repair has
survived.

**Neither supersession is enacted by this tranche.** Both belong in a Phase 12 amendment commit that changes
that document first, and that commit is an operator prerequisite (§7 #2), not a thing done here.

---

## 9. Every readiness finding, and its disposition

`FINDINGS_WITHOUT_A_DISPOSITION_MAX` is zero, and this is the table that satisfies it. Each row records what
the review claimed, what an independent re-check of the shipped bytes at `f77871f` found, and what was done.

| # | Finding | Confirmed at `f77871f`? | Disposition |
|---|---|---|---|
| **B1** | Phase 12 is a self-declared NO-GO, which is §12.1's first entry criterion verbatim | **NO — superseded by the candidate.** The review read `a8d7232`. Two commits later, §10.9 records **GO**: three consecutive fresh complete sequences from one frozen candidate, and §10.10 measures the record commit | **CLEARED by the candidate**, not by this tranche. Recorded, and §2 carries the state |
| **B2** | the generic gate's real mode dies at a hardcoded fake-mode endpoint path; the credential never reaches the daemon; `config.cjs` takes three arguments and destructures two | **YES, all three** | **REPAIRED** (`P13PRE-I2`) with a control that fails on the unrepaired bytes |
| **B3** | `observations.cjs` writes `egressObservedAtListener`, `endpointExpires`, `disallowedOriginContacts`, `status429`, `retries` and `refreshesPerRead` as literals in both modes, so two RP3 arms skip forever | **YES** | **REPAIRED IN PART, AND THE PART IS NAMED.** The two fields that decided a **permanent skip** — `endpointExpires` and `egressObservedAtListener`, with `disallowedOriginContacts` behind it — are now read out of evidence the run wrote, and a run that files a listener observation **moves** them. The other three have **no counter surface on the real path**: the daemon exposes none, and adding one is a product change §4 forbids. They are read from an origin-counter observation where one exists and marked **UNTAKEN in `provenance`** where none does. **OUT OF SCOPE for the remainder, OWNER NAMED: a later authorised Phase 13, or the tranche that owns the daemon.** Standing up the excluded-origin listener inside this gate is also assigned there — shipping an unexercised container arrangement is the defect class this tranche exists to remove |
| **B4** | *"the provider half only of `P11-R1`"* has no mechanism and no denominator | **YES** | **SUPERSEDED** in §8, and made structural: `PHASE13_PREENTRY_FORBIDDEN_EMITTABLE_IDS` plus a prefix refusal means no id of another tranche can carry a verdict here (`P13PRE-I9`) |
| **B5** | four `-optional` wrappers run `projection-three-server-concurrency-gate.sh` instead of the gate they name | **YES — exactly four**, confirmed by a sweep of all 23 wrappers: `path-lifecycle`, `real-provider`, `torbox-mount`, `torbox-real` | **REPAIRED** (`P13PRE-I1`), all four, each with its own header prose. The sweep control asserts **every** wrapper, so a fifth cannot appear unnoticed |
| **B6** | Phase 12's staging script refuses a Phase 13 staging directory, and `stage` would `rm -rf` Phase 12's preserved candidate | **YES** | **REPAIRED** (`P13PRE-I7`) by admitting one further **literal** marker rather than by parameterising the guard. A pre-entry directory is now stageable **without** clearing Phase 12's, and every other basename is refused exactly as before |
| **B7** | there is no no-contact origin-allowlist recorder, so exit criterion 4 has no instrument | **YES** | **REPAIRED** (`P13PRE-I6`): `deploy/projection-preentry-readiness.sh` contacts nothing and emits shape only |
| **B8** | mid-sequence CDN rotation will read as a product failure; the disposition is missing | **YES** | **REPAIRED as a policy** (§6). This tranche runs nothing against a provider, so what it can honestly ship is the refusal and the disposition, regressed offline |
| **B9** | two unbounded `compose up --wait` invocations; a network removed unconditionally that the run may not have created; the generic gate's read step has no `timeout` wrapper | **YES, all three** | **REPAIRED** (`P13PRE-I4`, `P13PRE-I5`). The wait bound is asserted over **every** compose-up in both gates, so a repair applied to one and not the other fails |
| **B10** | the provider gate emits no claim-level verdict surface, so a closure function has nothing to read | **YES** | **OUT OF SCOPE, OWNER NAMED: a later authorised Phase 13.** Arm markers and a `results.jsonl` are a *claim* surface, and the ids they would carry are Phase 13's. Minting them here would spend the namespace this tranche exists to protect |
| **B11** | residue `HOST_RESIDUE_MAX` does not count, and a Phase 13 run will add to it | n/a — a host observation, and this tranche reads no host | **OUT OF SCOPE, OWNER NAMED: a later authorised Phase 13**, whose §10 must carry its own "what this does not count" paragraph |
| **F1** | the two provider gates read different directories with mutually exclusive schemas, and this is correct | **YES** | **RESPECTED.** Nothing here unifies them |
| **F2** | the working real instrument is the provider-specific gate, not the one §12.1 names | **YES** | **RECORDED** in §8 as the second supersession. Not enacted here |
| **F3** | a `phase13.ts` naming the provider would need all eight source allowlists widened | **YES** | **AVOIDED, not widened.** `phase13-preentry.ts` names no provider, exactly as `phase12.ts` does not. Zero allowlists moved |
| **F4** | the no-contact preflights that already exist, and their ordering is already right | **YES** | **REUSED.** The new recorder adds the one shape none of them emits and re-implements none of them |
| **F5** | Phase 12's staging preflight probes Phase 10/11's ports, not a provider run's | **YES** | **OUT OF SCOPE, OWNER NAMED: a later authorised Phase 13.** A port list is a statement about which gate is about to run, and this tranche runs none |

**One finding the re-check added, which the review did not name.** The unbounded `docker compose … up -d
--wait` is not confined to the two provider gates: a sweep at `f77871f` finds it in roughly twenty gate
scripts, of which only `projection-phase11-mixed-gate.sh` carries `--wait-timeout`. The other eighteen are
**other tranches' files**, and widening this repair into them would be this tranche editing Phase 7, 8, 9 and
10 instruments it is not measured against. **OUT OF SCOPE, OWNER NAMED: the tranche that owns each script.**
It is written here so it is a recorded finding rather than a discovery.

---

## 10. What was run, and what it said

**EVERY FIGURE BELOW IS OFFLINE.** No provider, CDN, resolver, credential, media server, container, Tower or
host was contacted, started, stopped, read for value or changed to produce any of them. No gate was run: this
tranche repaired instruments and regressed the repairs, and **a repaired instrument is not a run**.

### 10.1 STATUS — the instrument repair is complete; **PHASE 13 IS NOT ENTERED**

| | |
|---|---|
| Base | integration `f77871f` |
| Commits | five, listed in §10.2 |
| Typecheck | `npx tsc --noEmit` — **clean** |
| New suites | `projection-phase13-preentry` 35/0, `projection-phase13-preentry-gate-audit` 47/0 |
| Controls | every repair carries one, and **each was watched failing on the unrepaired bytes** |
| Provider contact | **none** |
| Claims moved | **none.** Phase 10, Phase 11 tier one and Phase 12 stay GO; Phase 9 and Phase 11 tier two stay OPEN; `P11-R1` is **NOT RUN** |

### 10.2 The commits

| commit | what it is |
|---|---|
| `d3f4a12` | **the contract**, committed before any implementation: §5's claims, §5.3's thresholds, §6's origin policy, and the suite that asserts the prose and the closure function agree |
| `c511365` | `P13PRE-I1` — the four miswired `-optional` wrappers, and a sweep over **every** wrapper in the tree |
| `992275c` | `P13PRE-I2/I3/I4/I5/I8` — the real-mode input repair, the derived observations, the bounded waits, ownership-aware cleanup, and the skip refusal |
| `639d07c` | `P13PRE-I6/I7` — the no-contact readiness recorder, and the second staging marker |
| `1236a95` | the origin policy made **reachable**, and `P13PRE-I9` over the shipped bytes |

### 10.3 The files

**New (5):** `docs/PROJECTION_PHASE_13_PRE_ENTRY_INSTRUMENT_REPAIR.md`,
`src/core/projection/phase13-preentry.ts`, `deploy/projection-preentry-readiness.sh`,
`test/projection-phase13-preentry.ts`, `test/projection-phase13-preentry-gate-audit.ts`.

**Modified (11):** the two provider gates, the four `-optional` wrappers, `projection-phase12-stage.sh`,
`test/projection-real-provider.ts`, `test/suite-inventory.json`, `package.json`, `.gitignore`.

**Not touched, and checked:** everything on `PHASE13_PREENTRY_FORBIDDEN_SOURCE` — the appliance script and
its profile, the content plane, the gate cleanup helper, and `phase7.ts` through `phase12.ts`. **No
`projectiond/` source. No product daemon change of any kind.**

### 10.4 The soak trigger

`phase9RequiresSoakRerun` over the **union** of the module's path list and §11's ownership table returns
**FALSE**. Nothing this tranche touches is on `PHASE9_SOAK_TRIGGERING_SOURCE` — that list is six projection
source modules, `deploy/projection-alpha.sh` and `docker-compose.projection-alpha.yml`, and this tranche
modifies none of them. **No Phase 9 soak re-run is triggered.**

### 10.5 The provider source allowlists

**Zero of the eight moved.** `phase13-preentry.ts` names no provider, exactly as `phase12.ts` does not, so
the boundary that stops provider knowledge leaking into the rest of `src/` did not have to be widened for a
filename. All eight suites were run **to completion** — a stopped-part-way inventory is not a figure, which
is Phase 11 §6.2's own lesson.

### 10.6 What every control was watched doing

`REPAIRS_WITHOUT_A_CONTROL_MAX` is zero, and a control nobody has watched fail is a control nobody should
believe. Each of these was run against a deliberately unrepaired copy of the shipped bytes and **asserted to
fail**:

| repair | the tamper the control applies |
|---|---|
| `I1` | the wrapper's default returned to the three-server gate; and a wrapper edited to `exit 0` regardless of status |
| `I2` | the real-mode call site returned to the fake-mode endpoint path; and a `config.cjs` that destructures two of its three arguments again |
| `I3` | either of the two skip-deciding fields restored as a literal |
| `I4` | `--wait-timeout` stripped from **either** gate, so a repair applied to one and not its twin fails |
| `I5` | the cleanup returned to removing the network unconditionally; and a container named without this run's pid |
| `I6` | the scrubber removed (and it **does** leak); a secret digested (and it **is** digested); a reaching command added to the shipped bytes |
| `I7` | the marker handed to an environment variable; and a third marker slipped into the case |
| `I8` | the skip reader's empty-file guard removed, so it prints nothing for an empty file and a caller reads that as "no skips" |

### 10.7 A defect this tranche found in its own audit

The no-contact check was first written as a regex **inside a template literal**, where `\s` is not a
character class but the letter `s`. The pattern it compiled matched nothing. **It was green, and it was
vacuous** — green for exactly the reason a wrapper that runs the wrong gate is green: nobody had made it
fail. The matcher now lives in a named function built from a RegExp **source string**, it carries a control
that drives it against code which really does invoke each command, and a second control tampers the
**shipped bytes** and asserts the check catches it. A pattern that works on a fixture and misses the file is
still vacuous, and those are two different claims.

Two further defects were found by **running** rather than reading: `mktemp -d` under Git Bash answers a POSIX
path the Node runtime resolves against the wrong drive root, and an absolute POSIX path handed to `npx tsx`
does the same. Both would have appeared only when somebody tried to use the program.

### 10.8 What is left on this host that these figures do not count

Nothing. This tranche started no container, created no network or volume, staged nothing, and wrote outside
the repository only into a scratch directory it removes. The `plan` mode writes one helper under
`.projection-preentry-readiness/` and removes it, and that path is ignored by git.

---

## 11. File ownership — every path this tranche touches

**THIS TABLE IS THE AUTHORITY, and it is complete.** `src/core/projection/phase13-preentry.ts` deliberately
carries only the subset that does not name a provider — all eight provider source allowlists refuse an
unlisted `src/` file that names one, and this tranche widens none of them (§9, **F3**).
`test/projection-phase13-preentry.ts` parses the paths out of this table, unions them with the module's list,
and runs `phase9RequiresSoakRerun` over the **union**, so the soak question is asked of everything.

| Path | New or modified | What changed |
|---|---|---|
| `docs/PROJECTION_PHASE_13_PRE_ENTRY_INSTRUMENT_REPAIR.md` | new | this contract and its run record |
| `src/core/projection/phase13-preentry.ts` | new | §5's claims, §5.3's thresholds and §6's origin policy, as code |
| `test/projection-phase13-preentry.ts` | new | the tranche's own rules, and the prose ↔ function agreement |
| `test/projection-phase13-preentry-gate-audit.ts` | new | the adversarial audit over the shipped bytes; every check carries a control |
| `deploy/projection-preentry-readiness.sh` | new | the no-contact, shape-only readiness recorder of `P13PRE-I6` |
| `deploy/projection-real-provider-gate.sh` | modified | the real-mode input repair, the bounded read, the bounded compose wait, the network ownership precondition, the derived observations |
| `deploy/projection-real-provider-gate-optional.sh` | modified | points at its own gate, with its own header |
| `deploy/projection-torbox-real-gate.sh` | modified | the bounded compose wait and the network ownership precondition. **Nothing else** |
| `deploy/projection-torbox-real-gate-optional.sh` | modified | points at its own gate, with its own header |
| `deploy/projection-torbox-mount-gate-optional.sh` | modified | points at its own gate, with its own header |
| `deploy/projection-path-lifecycle-gate-optional.sh` | modified | points at its own gate, with its own header |
| `deploy/projection-phase12-stage.sh` | modified | one further **literal** marker admitted; every other refusal unchanged |
| `test/projection-phase12.ts` | modified | the control for the line above, which belongs to the tranche that made the change |
| `test/projection-real-provider.ts` | modified | its two `config.cjs` calls supply the third argument the repair made load-bearing, and one added assertion that the credential VALUE still never reaches the configuration |
| `test/suite-inventory.json` | modified | the two new offline suites |
| `package.json` | modified | the new scripts. **No existing script's meaning changes** |

**Not touched, and checked:** everything on `PHASE13_PREENTRY_FORBIDDEN_SOURCE` — the appliance script and
its profile, the content plane, the gate cleanup helper, and `phase7.ts` through `phase12.ts`.

---
