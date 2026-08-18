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
   `phase13-preentry.ts` itself, plus the two gate scripts and the wrapper this phase's evidence is *about* —
   a tranche that could edit the instrument it is measured through is a tranche whose measurement concludes
   whatever it needs to;
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
| `REPAIRS_WITHOUT_A_CONTROL_MAX` | 0 | **IMPORTED** — `PHASE12_RULES.REPAIRS_WITHOUT_A_CONTROL_MAX` |
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
| **E3** | **The candidate is frozen and named**, and staged byte-identically both ways with zero text files carrying a CR | `deploy/projection-phase12-stage.sh preflight --full`, then `stage --commit <candidate>` |
| **E4** | **The candidate carries a Phase 12 GO of its own** — the complete provider-free sequence, three consecutive fresh times, zero skips | `P13-S2`. Phase 12's GO from `a8d7232` does **not** transfer; Phase 12 §13.3 says why |
| **E5** | **The operator has placed all four inputs** under the gate's own approved directory, both secrets mode 0600 and different values, and has confirmed **by reference only** at least one object they are entitled to | the gate's own preflight, which exits 77 having contacted nothing if any is absent. **The reference never enters an emitted document** |
| **E6** | **`endpoint.json` exists, is already serving, and its `allowedOrigins` already admits the pool the operator's objects are served from** | a no-contact readiness record (shape, count, member digests) plus §8's origin recheck |
| **E7** | **The origin recheck inside the hour before the sequence returns 0** | `deploy/projection-provider-origin-recheck.sh`. **70 is a blocker**, escalated as a digest and never widened; any other status means **not measured**, and not measured is not allowed |
| **E8** | **No other gate campaign is running on the host, and its residue is accounted for** — zero `projection-*` containers, no `projection-alpha` container or network, and the gate's ports free | a fresh before-baseline taken **immediately** before the run. A figure from a readiness review is a sampled fact by then, and pairing it with a fresh one invents an instant |
| **E9** | **The origin-stability plan is satisfied** — a measured shortest origin turn, a bounded sequence duration that fits inside it with margin, a record younger than the maximum age, and an observed pool no larger than the allowlist | `originStabilityRefusals`, §8 |

**E4 IS THE ONE MOST LIKELY TO BE ARGUED WITH, AND IT IS NOT NEGOTIABLE.** Phase 12's GO is a closed record
about `a8d7232`. Between that commit and any candidate carrying the pre-entry repair, the **staging script**
that is arms 1 and 2 of every sequence moved, the gate arm 7 runs moved, `src/core/projection/real-provider.ts`
moved, and two suites plus the selection list arm 9 reads moved. A sequence is what says those bytes work
together on that host.

---

## 7. EXIT CRITERIA — what a Phase 13 GO requires

| # | Criterion |
|---|---|
| **X1** | `deploy/projection-torbox-real-gate-three.sh` completed **3 of 3**, none skipped, exit 0, from one frozen candidate — `P13-S1` |
| **X2** | Every Tier A claim has a **pass** verdict from a **real**-mode run; none is absent, skipped or duplicated — `P13-A1`…`P13-A8` |
| **X3** | **No credential was read, printed, written to evidence, rotated or changed**, and no provider outage was induced |
| **X4** | **The origin allowlist is unmoved**, and its state is recorded before and after by digest — `P13-A8` |
| **X5** | **The host is left as it was found**: container, network and volume sets preserved as membership; no mountpoint; no run directory; the appliance untouched — `P13-A7` |
| **X6** | `phase13ClosureProblems` returns **empty** over the run's own verdicts, and the green is proved non-vacuous by re-running the same evidence with **one byte changed** and watching it refuse |

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

**WITHOUT A POLICY THAT READS AS A HARD FAIL ABOUT THE PRODUCT. IT IS NOT ONE.** And the temptation it
creates — widen `allowedOrigins` until it goes green — is the thing Phase 12 §12.1 calls a blocker rather
than a step.

So Phase 13 reads the policy `phase13-preentry.ts` already carries, rather than restating it:

- **`originStabilityRefusals(plan)`** — the reasons a sequence **may not start**: an unmeasured origin
  lifetime (an unmeasured lifetime is not a generous one); an unbounded sequence duration; a duration that
  does not fit inside the **shortest observed** turn with `ORIGIN_LIFETIME_SAFETY_MARGIN_MINUTES` of margin;
  a record older than `ORIGIN_RECORD_MAX_AGE_MINUTES`, because a stale record is an answer about a
  **different** origin; and an observed pool **larger than** the allowlist.
- **`originRotationDisposition(status)`** — `0` proceed, `70` **`abort-origin-rotated`**, anything else
  **`abort-not-measured`**. **Neither abort is a FAIL, and neither is a licence to widen anything.**

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
| `src/core/projection/phase13.ts` | new | §5's claims, §5.3's thresholds, §6's entry criteria and §7's exit criteria, as code |
| `test/projection-phase13.ts` | new | the tranche's own rules, and the prose ↔ function agreement |
| `docs/PROJECTION_PHASE_12_AUDIT_AND_PROVIDER_FREE_CLOSURE.md` | modified | **§13 ONLY** — the amendment superseding §12.1's two sentences and recording the candidate rule. No §1–§12 sentence, threshold, refusal, claim id or claim wording is edited |
| `docs/PROJECTION_PHASE_13_PRE_ENTRY_INSTRUMENT_REPAIR.md` | modified | **§10.1, §10.3, §12.5 and a new §13 ONLY** — the three stale figures a re-audit named, the three unlisted commits, and the eight residuals' dispositions |
| `deploy/projection-real-provider-gate.sh` | modified | the collision-resistant run id, the 0700 observations directory, the failure-path set-preservation measurement, and the `grep -c` defect |
| `deploy/projection-torbox-real-gate.sh` | modified | the collision-resistant run id, the failure-path set-preservation measurement, and the `grep -c` defect. **Nothing about what it observes** |
| `test/projection-phase13-preentry.ts` | modified | the fail-closed git-driven ownership check, the post-candidate ownership union, and the §10.3 ↔ §11 agreement check |
| `test/projection-phase13-preentry-gate-audit.ts` | modified | the driven controls for N4, N5, N6 and N7, and the regression for the `grep -c` defect |
| `test/projection-real-provider.ts` | modified | its run-id pins follow the derivation |
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

### 14.2 The preparation campaign — what it is and what it is NOT

This section is filled in by the tranche that wrote this contract. **It is not a Phase 13 run and closes no
claim of §5.** It records the provider-free work that has to exist before an entry decision can honestly be
made: the amended Phase 12 sequence run from a candidate that includes this work, the no-contact readiness
record taken on the host, and the entry criteria evaluated one by one.

*(Filled in below by the preparation tranche.)*

### 14.3 The entry decision

*(Filled in below. It is a decision about §6's criteria and nothing else, and it is NOT an authorisation to
contact a provider — that is the operator's, and it needs the operator's own window.)*
