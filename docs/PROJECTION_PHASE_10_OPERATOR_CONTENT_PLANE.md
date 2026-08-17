# Projection Phase 10 — the operator content plane

**Status: AUTHORIZED, NOT YET BUILT OR MEASURED.** This document is committed **before** any Phase 10 source
is written and **before** anything is measured against it, which is the rule Phases 7, 8 and 9 each closed
under. Every threshold below is either imported from a closed tranche or is NEW and stated here first. No
number in §4 may move afterwards in either direction without §9's ceremony.

Phase 9 is **not** closed. Phase 8 is closed. Real-Debrid remains deferred, and nothing here calls it
implemented, failed or permanently rejected.

---

## 1. Product outcome

An operator who has an installed, serving appliance can put content into the projection namespace, see that it
is really in the published generation, and be told when the namespace and the disk have stopped agreeing —
**using only shipped verbs, with no hand-run `tsx` command, and without any of it being able to touch the
appliance's mount point, daemon, cache or recovery ledger.**

**PHASE 10 IS PROVIDER-FREE BY CONSTRUCTION.** Every one of §5's ten claims is measurable with no TorBox
account, no CDN origin, no SABnzbd, no NNTP provider and no media server. That is a design constraint and not
an accident. Provider windows are this project's scarcest resource — Phase 8 §11.15.4 measured nine distinct
pool members against a six-entry allowlist and windows from 22 to 367 minutes, and spent five of six
authorised invocations on rotations — so a tranche that can close without one is a tranche that closes.

**PHASE 10 IS ALSO A DEFECT REPAIR, AND THAT IS ITS FIRST DELIVERABLE.** §2.1 is the finding. It is the reason
this document has a consequence for a tranche that is not its own, stated in §8.

---

## 2. What was found, verified independently at `03c26c1`, and what it decides

Every claim in this section was re-derived from the tree at commit `03c26c1` by this tranche's own reading,
not accepted from a report. Each carries the evidence a reader can re-run.

### 2.1 THE TORBOX DRIFT GUARD DOES NOT RUN IN PRODUCTION — it runs in the rehearsal and in one unit test

`62edc12` corrected Phase 9's own record: `torBoxDrift` "was called from one place: the rehearsal", so §4's
sixth hard refusal — *let a Usenet outage alter the TorBox namespace* — had been "proved as a property of the
rehearsal". The repair added an **optional** `AdmissionPublisher.namespaceSnapshot?()`
(`src/core/usenet/admission.ts:64`) and made `admit()` compare around every publish **that can be compared**
(`admission.ts:360`, `:385`).

`namespaceSnapshot` has exactly two implementors in the whole tree:

| Where | What it is |
|---|---|
| `src/ops/usenet-rehearsal.ts:179` | the provider-free rehearsal's in-memory publisher |
| `test/usenet-admission.ts:507` | a unit-test fake |
| — | **and nothing else** |

`createRegistryPublisher` (`src/ops/usenet-command.ts:217`) — the only publisher `openService`
(`usenet-command.ts:448`) ever constructs, and therefore the only publisher the shipped `ops:usenet reconcile`
and `ops:usenet submit` ever use — returns `{ publish }` and nothing more.

So on a real operator's appliance: `namespaceSnapshot` is `undefined`, `before` stays `null`, the comparison
at `admission.ts:385` is skipped entirely, and every admission is recorded with
`admittedWithoutDriftCheck: true` (`admission.ts:433`).

The hedge is honest — the code says "that can be compared" and the outcome field says so out loud — but the
shipped path is **never** comparable, so the guard the review commit moved into the publish path has, in
production, exactly the property it was moved to stop having.

Everything needed to repair it already exists: `readSnapshot` (`src/core/projection/publish-service.ts:188`)
builds the `PublishSnapshot` that `buildGeneration` (`src/core/projection/publisher.ts:195`) already derives
`ProjectedEntry[]` from. `readSnapshot` is private and `publisher.ts`'s per-entry derivation is inline. §3's
D10.1 is that repair, and §7 R1 is the one implementation unknown in it, answered rather than deferred.

**Consequence, and it belongs to Phase 9 rather than to this document:** see §8.

### 2.2 `admitted` does not mean visible — nothing in the Usenet path publishes a generation

`createRegistryPublisher` calls `registerVersion` and `registerEntry`. That is the **registry**, which
`src/ops/projection-register-cli.ts` describes in its own header as "THE ONLY WRITE PATH. The publisher reads;
it never registers." A registered entry is invisible to every media server until `publishGeneration`
(`publish-service.ts:307`) mints a generation and writes the pointer.

`grep -n "publishGeneration\|projection-publish"` over `src/ops/usenet-command.ts`, `src/ops/usenet-rehearsal.ts`,
`src/core/usenet/` and `deploy/projection-phase9-rehearsal.sh` returns **nothing**. Verified at `03c26c1`.

`docs/PROJECTION_PHASE_9_USENET_RUNBOOK.md` §4.2 tells the operator that `admitted` means *"proved and
published, exactly once … nothing; it is in the namespace"*, under a table headed "Six states, and there is no
seventh". §1 of the same document says a Usenet file "becomes visible when it is **admitted**". Both sentences
are **false on a real appliance**: the entry is registered and nothing has published it. That is a
documentation defect sitting on top of a real product gap, and D10.2 and D10.5 close them in that order.

### 2.3 There is no operator path from an installed appliance to content in the namespace

`deploy/projection-alpha.sh` has eight verbs — `preflight install start stop status upgrade rollback
reset-recovery` — and every one is about the appliance's own lifecycle. Not one is about content.
`docs/PROJECTION_ALPHA_OPERATOR_RUNBOOK.md` never mentions `ops:projection-register` or
`ops:projection-publish`.

To put one TorBox object in the namespace today an operator must hand-run `npm run ops:projection-register --
root …`, then `version --key … --size … --mtime … --probe head:0:1048576:<sha256>` four times, then `entry
--item <uuid> --version-key … --path … --source http-range:…`, then `npm run ops:projection-publish`. The
catalog record UUID, the version key, the exact byte size, the exact-millisecond mtime and four probe digests
are all typed by hand into argv.

`deploy/real-provider-objects.template.json` already carries exactly those fields in an operator-facing shape
— `label`, `ref`, `sizeBytes`, `sha256`, `probeDigests[]` — so the **input format for a shipped verb already
exists** and only the verb is missing. D10.3 is the verb.

### 2.4 Nothing reconciles the namespace against what is actually on disk

`publishStatus` (`publish-service.ts:483`) reconciles database ↔ pointer ↔ artifact and answers `agrees`.
Nothing reconciles:

- registry entries against the **current published generation** — §2.2's gap, made visible;
- a `local` source against **the file it names** — and every admitted Usenet entry is a `local` source under
  the operator's media root, which a SABnzbd cleanup, a share move or a disk shuffle can remove;
- the Usenet **job ledger** against the registry;
- an entry the operator wants held for any reason.

`degradeEntry`, `retireEntry` and `restoreEntry` exist (`src/core/projection/source-registry.ts:224`, `:234`,
`:250`) and `PROJECTION_DEGRADED_REASONS` (`manifest-v1.ts:82`) already contains `source-unreachable` and
`operator-hold`. The mechanism is present and unexposed. D10.4 exposes it **as a report plus two explicit
operator verbs**, and adds no reason, no field and no schema version.

### 2.5 The port and the guarded-source facts this tranche needs

- **5670 is free.** `grep -rn 5670` over every `docker-compose*.yml`, `deploy/`, `src/`, `test/` and `docs/`
  finds no host-port use at `03c26c1`. `docker-compose.projection-phase9.yml`'s own comment lists the claimed
  block ending at 5660, and `test/projection-phase9.ts:314` cross-checks its port against every other compose
  file rather than trusting the comment. D10.6 does the same.
- **`PHASE9_SOAK_TRIGGERING_SOURCE`** (`src/core/projection/phase9.ts:319`) holds eight paths. Neither
  `publish-service.ts`, `publisher.ts`, `source-registry.ts`, `usenet-command.ts` nor `status-report.ts` is on
  it. Nothing this tranche is authorised to modify is on it. §4's sixth refusal keeps it that way, and P10-6
  asserts it by running the function rather than by reading the list.
- **The OPERATOR SOURCE DIGEST** `9940edfcb50a6a27…` is recomputed by `test/projection-bounded-recovery.ts:747`
  over `deploy/projection-alpha.sh`, its two helper programs, `deploy/projectiond-alpha.env.example` and
  `docker-compose.projection-alpha.yml`, and compared against the documented value on every run. §4's fifth
  refusal is what keeps it unmoved; that suite is what proves it.

### 2.6 The seven POSIX-shell suites are ANOTHER DISPATCH'S WORK and are not Phase 10's

`03c26c1`'s closing paragraph names seven offline suites — jellyfin, plex and emby dataplane,
three-server-concurrency, path-lifecycle, real-provider and rclone-comparison — as carrying a harness defect
that only shows from PowerShell, where `bash` on a stock Windows PATH is the WSL launcher and the wrapper
controls answer `127`, which is the same vocabulary the defects they hunt speak. `test/posix-shell-kit.ts` is
the repaired reasoning.

**That repair is owned by dispatch `task_49ab24180bd0` and is NOT Phase 10 scope.** This tranche does not edit
those seven files. §6.3 records the boundary and §5's P10-1 records the dependency: the *both-shells* arm of
P10-1 cannot be recorded until that dispatch's commit lands in the same tree, and until then it is **NOT RUN**
rather than passed. Two dispatches editing seven files is the collision §6 exists to prevent.

---

## 3. Deliverables

### 3.1 Architecture decision — a second shipped script, and why not a ninth verb on `projection-alpha.sh`

The content plane ships as **`deploy/projection-content.sh`**. Three reasons, in descending order of force:

1. **`deploy/projection-alpha.sh` is on `PHASE9_SOAK_TRIGGERING_SOURCE`.** Editing it makes
   `phase9RequiresSoakRerun` TRUE and re-opens Phase 8's six-hour soak — three consecutive soaks plus Phase 7's
   whole sequence from the same candidate, against a CDN pool that rotates mid-run. §4's sixth refusal and the
   dispatch constraint agree here, and P10-6 is the assertion rather than the promise.
2. **`test/projection-bounded-recovery.ts` recomputes the OPERATOR SOURCE DIGEST on every run.** An edit there
   fails a suite immediately. That is the guard working, not an obstacle to route around.
3. **Phase 8 §13's ownership rule is about the mount point.** The content plane owns the **database and the
   manifest directory** and never the mount point. One mount point still has exactly one owner, and it is
   still `projection-alpha.sh`.

**No new source kind, no new manifest field, no schema version.** An admitted Usenet file stays a `local`
source and a TorBox object stays `http-range`, exactly as Phase 9 §2 chose.

### 3.2 The deliverables

| id | Deliverable |
|---|---|
| **D10.1** | **The TorBox drift guard runs on every real admission.** A read-only namespace snapshot — `src/core/projection/namespace-snapshot.ts`, over an exported `readSnapshot` — that opens its **own short-lived connection**, reads inside `REPEATABLE READ READ ONLY`, and **takes no publish lock** (§7 R1). `createRegistryPublisher` implements `namespaceSnapshot()`. `admittedWithoutDriftCheck` becomes reachable **only** from a publisher that structurally cannot present a namespace, and the operator surface says which. Closes §2.1. Driven against a **real migrated PostgreSQL**, not argued from source. |
| **D10.2** | **`admitted` means visible, or the surface says it does not.** A new operator-visible **publication** state — `admitted-not-published` — derived by comparing registry entry ids against the ids in the **current published generation**. `reconcile` reports it. Publishing is an **explicit verb** or an **explicit `--publish` flag** and is **never** implicit. Closes §2.2. |
| **D10.3** | **`deploy/projection-content.sh`**, the second shipped operator script, with verbs `preflight`, `add-torbox`, `add-local`, `publish`, `reconcile`, `hold`, `release`, `status`; over a TypeScript core `src/ops/projection-content.ts` and CLI `src/ops/projection-content-cli.ts`. `add-torbox` and `add-local` consume a **file** in `deploy/real-provider-objects.template.json`'s existing shape, so no operator types a digest twice and no reference reaches argv. **Every verb idempotent**, as all eight alpha verbs are. Closes §2.3. |
| **D10.4** | **Ongoing reconciliation that REPORTS and does not act.** The closed divergence set of §3.3. Acting on one requires `hold` (→ `degradeEntry('operator-hold')`) or `release` (→ `restoreEntry`), typed by a human. Uses only reasons already in `PROJECTION_DEGRADED_REASONS`. Closes §2.4. |
| **D10.5** | **`docs/PROJECTION_CONTENT_OPERATOR_RUNBOOK.md`** — zero to a readable namespace, both sources — plus a **correction** to `docs/PROJECTION_PHASE_9_USENET_RUNBOOK.md` §1 and §4.2 that **keeps the false sentences whole** and marks them superseded, in the shape `docs/PROJECTION_ALPHA_OPERATOR_RUNBOOK.md` §6.7 already uses. This repository does not delete a wrong sentence; it retires it. |
| **D10.6** | **The provider-free rehearsal and its rules:** `src/core/projection/phase10.ts` (claim ids, titles, thresholds — every imported one named with the tranche it came from — the provider-free split, and `phase10ClosureProblems`); `deploy/projection-phase10-rehearsal.sh` + `-three.sh` + `-optional.sh`; `docker-compose.projection-phase10.yml` on host port **5670**, cross-checked by the phase suite against every other compose file; and `test/projection-phase10-gate-audit.ts` following `src/core/projection/phase8-gate-audit.ts`'s **call-graph** model with controls that prove the audit bites. |
| **D10.7** | **NOT PHASE 10 SCOPE.** The POSIX-shell harness repair for the seven suites §2.6 names is owned by dispatch `task_49ab24180bd0`. Phase 10 **depends** on it and **asserts its result** in P10-1's second arm; Phase 10 does not edit those files. Recorded as a deliverable id only so no reader concludes it was forgotten. |

### 3.3 The closed divergence set

`reconcile` reports exactly these and invents none:

| code | What it means |
|---|---|
| `registry-ahead-of-generation` | a registered entry is not in the current published generation — §2.2's gap, made visible |
| `generation-pointer-disagrees` | database, pointer and artifact do not agree — `publishStatus`'s existing answer, surfaced |
| `local-source-file-absent` | a `local` locator names a file that is not there |
| `local-source-bytes-changed` | a `local` locator names a file whose size or mtime no longer matches the registered version |
| `entry-degraded` | an entry is degraded, with the reason it carries |
| `ledger-entry-unregistered` | the Usenet job ledger holds an admitted entry the registry does not have |

A seventh code is a contract change and goes through §9.

### 3.4 One deliberate deviation from the proposal this tranche was dispatched against, with its reason

The proposal placed `admitted-not-published` as a **seventh job state** in `src/core/usenet/status-report.ts`.
This contract places it as a **publication** axis on the status document instead, and does **not** extend
`USENET_JOB_STATES`.

The reason is a guard, not a preference. `PHASE9_JOB_STATES` (`phase9.ts:37`) is `USENET_JOB_STATES`
re-exported, and Phase 9 §3's last deliverable names its six states as the closed vocabulary. Adding a seventh
member would silently change what a **closed** tranche's own module exports, which is the shape of change §4's
seventh refusal exists to forbid. The six states describe the **job**; whether the namespace has published it
is a fact about the **generation**, and it belongs on its own axis. The runbook correction in D10.5 says
exactly that, and it is why the correction is more than a word swap.

---

## 4. Hard refusals

Phase 10 shall not:

1. add a source kind, a manifest field or a schema version;
2. degrade, retire, delete, publish or restore anything without an explicit operator verb or an explicit
   operator flag — a timer, a heuristic and a "safe default" are all the same refusal, and `reconcile` is a
   report;
3. contact TorBox, a CDN origin, an indexer, a SABnzbd instance or an NNTP server — **it is provider-free by
   construction, and `endpoint.json` is not read, not written and not touched at any point**, with its mtime
   recorded before and after;
4. write inside the projection mount point, mount, unmount, or start or stop the appliance;
5. modify `deploy/projection-alpha.sh`, its two helper programs, `deploy/projectiond-alpha.env.example` or
   `docker-compose.projection-alpha.yml` — the OPERATOR SOURCE DIGEST `9940edfcb50a6a27…` is unmoved and
   `test/projection-bounded-recovery.ts` is what checks it;
6. modify any path on `PHASE9_SOAK_TRIGGERING_SOURCE`, so `phase9RequiresSoakRerun` over this tranche's own
   changed-path set is FALSE and **the Phase 8 soak is not re-run**;
7. close, partially satisfy, re-label or re-word **P9-2, P9-3, P9-5 or P9-11**, edit
   `docs/PROJECTION_PHASE_9_TORBOX_USENET.md` §5, or edit `src/core/projection/phase9.ts`;
8. delete media, a worker's history or operator input — Phase 9 §4's fifth refusal, imported unchanged;
9. place a credential, an NZB or indexer URL, an article id, a completed source path, a provider object
   reference, a media identity or an arbitrary OS error string in any emitted document — `SealedValue` and
   `assertSealedSafe` are **reused** rather than re-implemented;
10. claim Real-Debrid, a second host, high availability, a load figure, an uptime figure or a production
    release;
11. edit the seven suites of §2.6, which belong to dispatch `task_49ab24180bd0`;
12. modify `projectiond/`, any Phase 7 or Phase 8 gate script, or any closed tranche's run record.

---

## 5. Closure rule — ten claims, and every one is provider-free

The phase is GO only when **one frozen candidate** demonstrates all ten.

| id | Claim | Kind |
|---|---|---|
| **P10-1** | the full offline inventory passes on the development host with every Phase 10 suite in it, from Git Bash; **and, as a second arm, from an ordinary PowerShell** | provider-free — **second arm blocked on the §2.6 integration dependency and recorded NOT RUN until it lands** |
| **P10-2** | `go:phase10-rehearsal:three` — three consecutive fresh runs, exit 0, **zero skips**, on the real Unraid host | provider-free |
| **P10-3** | an admission through the **real** `createRegistryPublisher`, against a **real migrated PostgreSQL**, records **no** `admittedWithoutDriftCheck`; and a forged TorBox-entry move around that same publish is refused `torbox-namespace-drifted`, **permanently**, with the admission **not recorded** | provider-free |
| **P10-4** | an operator goes from an installed, serving, **empty** appliance to a readable namespace holding one entry using **only shipped verbs** — zero hand-run `tsx`, zero operator interventions | provider-free |
| **P10-5** | a `local` source whose file is removed is **reported** and never changed on its own; the published generation is **byte-identical** before and after the report; `hold` then degrades it and `release` restores it | provider-free |
| **P10-6** | OPERATOR SOURCE DIGEST unmoved; `phase9RequiresSoakRerun` over this tranche's own changed-path set is **FALSE**, asserted by a suite that runs the function rather than by a sentence | provider-free |
| **P10-7** | the provider-free regression subset is green from that one candidate: `restart-topology`, `recovery-gate:three`, `mount-truth-gate:three`, `mount-health-gate:three`, `stale-mount`, `serve-death`, `sustained-outage`, `publisher-mount`, `alpha-acceptance` (14 of 14), `real-provider-gate --fake` | provider-free |
| **P10-8** | cleanup leaves zero phase-owned mounts, transient containers, networks and volumes — **asserted from inside the run** rather than reported | provider-free |
| **P10-9** | no preserved evidence carries a secret, a URL, an origin, a path or a media identity | provider-free |
| **P10-10** | the complete sequence passes **three consecutive fresh** times | provider-free |

**Provider-required claims: none.** A claim that needs a provider does not belong in Phase 10.

### 5.1 Thresholds

Every imported threshold names the tranche it came from. Every NEW one is new because no earlier tranche could
have measured it.

| name | value | source |
|---|---|---|
| `CONSECUTIVE_FRESH_RUNS` | 3 | IMPORTED — `PHASE9_RULES.CONSECUTIVE_FRESH_RUNS`, itself Phase 8 ← Phase 3 |
| `OPERATOR_INTERVENTIONS_MAX` | 0 | IMPORTED — `PHASE9_RULES.OPERATOR_INTERVENTIONS_MAX` |
| `RESIDUE_MAX` | 0 | IMPORTED — `PHASE9_RULES.RESIDUE_MAX` |
| `ADMISSIONS_WITHOUT_DRIFT_CHECK_MAX` | **0** | **NEW.** §2.1 is the whole reason this tranche exists; today's shipped value is "every one of them" |
| `AUTOMATIC_NAMESPACE_MUTATIONS_MAX` | **0** | **NEW.** §4's second refusal, as a number a run can record — a `reconcile` that changed one thing has failed |
| `HAND_RUN_COMMANDS_MAX` | **0** | **NEW.** P10-4's measurement: how many `tsx`/`npm run ops:` invocations the operator path needed |
| `GENERATION_BYTES_CHANGED_BY_REPORT_MAX` | **0** | **NEW.** P10-5's measurement, and §7 R5's mitigation |

## 6. File ownership, so two dispatches cannot collide

### 6.1 Phase 10 owns, new

`docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md`, `docs/PROJECTION_CONTENT_OPERATOR_RUNBOOK.md`,
`src/core/projection/phase10.ts`, `src/core/projection/namespace-snapshot.ts`,
`src/ops/projection-content.ts`, `src/ops/projection-content-cli.ts`,
`deploy/projection-content.sh`, `deploy/projection-phase10-rehearsal.sh` (+ `-three.sh`, `-optional.sh`),
`docker-compose.projection-phase10.yml`,
`test/projection-phase10.ts`, `test/projection-phase10-gate-audit.ts`, `test/projection-content-command.ts`,
`test/projection-namespace-snapshot.ts`, and one db-group suite for D10.1's live proof.

### 6.2 Phase 10 modifies, bounded

| File | Change |
|---|---|
| `src/core/projection/publish-service.ts` | export the existing private `readSnapshot`. **No behaviour change.** |
| `src/core/projection/publisher.ts` | export the entry-derivation primitives the snapshot composes, so the picture is built from the publisher's own functions rather than a second implementation of them. **No behaviour change.** |
| `src/ops/usenet-command.ts` | `createRegistryPublisher` implements `namespaceSnapshot`. |
| `src/core/usenet/status-report.ts` | the optional `publication` axis of §3.4. **`USENET_JOB_STATES` is not extended.** |
| `docs/PROJECTION_PHASE_9_USENET_RUNBOOK.md` | §1 and §4.2 corrected, false text kept whole and marked superseded. |
| `package.json`, `test/suite-inventory.json` | new scripts and suites only. |
| the TorBox source allowlists | a new file that names TorBox joins them **with its reason written beside it**, which the allowlist's own comment says is the only legitimate way to widen one. |

### 6.3 Phase 10 must not touch

`deploy/projection-alpha.sh` and its two helper programs; `deploy/projectiond-alpha.env.example`;
`docker-compose.projection-alpha.yml`; anything on `PHASE9_SOAK_TRIGGERING_SOURCE`; `projectiond/`; any Phase 7
or Phase 8 gate script or run record; `docs/PROJECTION_PHASE_9_TORBOX_USENET.md`;
`src/core/projection/phase7.ts`, `phase8.ts`, `phase9.ts`; **and the seven suites of §2.6, which belong to
dispatch `task_49ab24180bd0`.**

---

## 7. Risks, named here rather than discovered later

| id | Risk | Mitigation, decided now |
|---|---|---|
| **R1** | `readSnapshot` is called inside `publishGeneration`'s `REPEATABLE READ` transaction **after** `cat_projection_publish_lock()` is held, so a naive export could be read as needing that lock — and taking the publish lock in the **admission** path would serialise every admission behind every publish. | **DECIDED: the namespace snapshot takes NO publish lock.** It opens its own short-lived connection and reads inside `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`. The lock exists to exclude a second *writer* of generations; a consistent *read* of the registry needs isolation, not exclusion. This is stated here so the implementation is measured against a decision rather than making one. |
| **R2** | The drift guard answers "did the TorBox half move across this publish". A **concurrent** TorBox registration by another operator process is indistinguishable from a Usenet publish having moved one, and the refusal is **permanent**. | Named, not hidden. `reconcile` already takes `withUsenetLedgerLock`; the content-plane runbook states that `ops:usenet reconcile` and the content plane's write verbs are not run concurrently, and the refusal's own detail line says what to check. A conservative false refusal that records nothing is the correct failure direction; the opposite is §2.1. |
| **R3** | `publish-service.ts` is read by nineteen deploy scripts. Even a pure export is a shared-source change. | P10-7's provider-free regression subset from **one frozen candidate** is exactly the payment, and it needs no provider window. |
| **R4** | Widening a TorBox source allowlist is where a guard gets quietly weakened. | Each addition carries its reason inline, as `62edc12` did for `admission.ts` and `status-report.ts`. Eight suites failing on an un-reasoned addition is the design working. |
| **R5** | `reconcile` could grow into an automatic repairer under pressure of convenience. | §4's second refusal, `AUTOMATIC_NAMESPACE_MUTATIONS_MAX = 0`, and P10-5's assertion that the published generation is **byte-identical** before and after a report. |
| **R6** | The §2.6 dependency does not land, and P10-1's second arm is quietly folded into a pass. | P10-1 records it **NOT RUN**. A skip is not a pass, and `phase10ClosureProblems` refuses a closure whose evidence includes one. |

---

## 8. THE CONSEQUENCE FOR PHASE 9, STATED HERE BECAUSE PHASE 10 IS WHAT CAUSED IT

§2.1 is a finding about a **shipped** guard, and it changes what a Phase 9 live run would mean.

**Phase 9's four open live claims — P9-2, P9-3, P9-5 and P9-11 — must be run from a Phase 10-or-later
candidate.** Running them against the tree at `03c26c1` would close Phase 9 on an appliance whose sixth hard
refusal — *let a Usenet outage alter the TorBox namespace* — had never once executed on a single real
admission. The verdict would be true about the run and false about the product.

**This document does not close, partially satisfy, re-label or re-word any Phase 9 claim**, and §4's seventh
refusal forbids it from doing so. It records a **prerequisite**, and the prerequisite is a property of the
candidate, not of the claims. `docs/PROJECTION_PHASE_9_TORBOX_USENET.md` §5 is untouched and remains the only
place a `P9-` verdict may be recorded.

### 8.1 And what this means for the tranche after this one

Phase 11 — the mixed-source acceptance gate — may later close **only its provider-free instrument tier**. A
tier-one GO is a GO **on the instrument**: it says the gate exists, can fail, and reached every arm in fake
mode. **It closes nothing about the mixed product.** No document may call real mixed-product acceptance
complete without live runs against a real provider, real operator content and three real pre-attached media
servers. The sentence a Phase 11 roadmap row may write, and must not exceed, is the one the real-provider gate
already closed in: *what is missing is a run rather than a gate.*

---

## 9. What Phase 10 does NOT close, and how this document may change

**It closes no Phase 9 claim.** It adds no provider. It is **one host**. It is not a soak, a load test, an
uptime claim, an availability claim or a production release. It fixes none of Phase 7 §12.4's five rough
edges. It re-closes nothing in Phases 1–8, and it relabels no earlier tranche's evidence. It does not make
Usenet streaming instant, add source failover, add indexer search, add download-selection policy, or support
Real-Debrid.

**No threshold in §5.1 and no refusal in §4 may move after this commit** except by a commit that changes this
document **first**, states what moved and why, and re-runs everything already measured against the old value.
That is the rule Phase 6 §11.1.1 exists to enforce: figures taken from three different trees were not wrong,
they were **unverifiable**.

---

## 10. Exact inputs for the closing run

| Input | Value |
|---|---|
| Host | the real Unraid host, via the existing gate-run procedure |
| Database | throwaway PostgreSQL, `docker-compose.projection-phase10.yml`, host port **5670**, `tmpfs` data directory |
| Corpus | local files **synthesised by the rehearsal in its own run directory**. No operator content. |
| Credentials | **none** |
| `endpoint.json` | **not read, not written, not touched** — asserted, with its mtime recorded before and after |
| Media servers | **none**, and none simulated |
| Provider window needed | **none** |
| Estimated wall clock | rehearsal single-digit minutes; `:three` well under an hour; the regression subset dominated by `recovery-gate:three` and `mount-health-gate:three` |

---

## 11. Run record

**EMPTY. Nothing has been built or measured against this contract at the time of this commit.**
