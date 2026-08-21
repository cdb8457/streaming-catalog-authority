# Claude Code review handoff — projection appliance, Phases 0–15

## 1. Purpose of this handoff

This file is the review entry point for a Claude Code session that needs to understand the projection
appliance work in this repository without inheriting an earlier coordinator's private context.

Review target:

- repository: `streaming-catalog-authority`;
- integration branch: `cdb8457/projection-phase3-reliability-loop`;
- implementation baseline: `c9228a5` (`PROJECTION PHASES 14-15: add preflight and release controls`);
- contract baseline immediately before it: `c37a630`;
- current product version in `package.json`: `1.2.6`;
- current locally verified inventory: **341 offline suites selected, 341 passed, 0 failed,
  0 required-but-skipped**;
- total registered inventory: **380 suites** across offline, database and Docker capability groups.

The handoff itself is documentation. It does not change a provider, manifest, mount, operator command,
runtime image, database schema, release artifact or phase verdict.

The requested review is initially **read-only**. Do not repair an issue while discovering it. Record the
finding, identify its owning contract and show which test or closure predicate should fail. A repair should
begin only after the finding has a disposition and a bounded ownership list.

---

## 2. The product in one page

The repository contains two related systems:

1. the existing TypeScript/PostgreSQL **control plane and catalog authority**; and
2. the Go/FUSE **projection data plane**, `projectiond`.

The control plane owns identity, catalog lifecycle, erasure, custody, source registration, immutable
manifest publication and operator decisions. The data plane serves the exact read-only regular-file
namespace the control plane published. It does not own a second database and does not decide what exists.

The central promise is:

> **Unavailability never presents as absence.**

A provider failure, database outage, control-plane restart or short scan must not make an existing library
look deleted. `projectiond` keeps serving the last admitted immutable generation. A bad successor pointer,
artifact, digest or manifest is refused without disturbing the generation already in memory.

The namespace exposes regular files, not symlinks, WebDAV URLs or provider identifiers. FUSE is the
production frontend. rclone/WebDAV is retained only as a comparison control; it is not the product
architecture.

The currently selected source scope is **TorBox plus Usenet**:

- TorBox objects use the provider-neutral HTTP Range/resolver path already proven by earlier projection
  phases.
- Usenet content is acquired, repaired and unpacked by an external SABnzbd worker. Only a completed,
  stable, verified regular file is admitted as a local source.
- Real-Debrid is deliberately deferred and is not implemented or represented as supported.

### 2.1 System flow

```text
operator/catalog decisions
        |
        v
TypeScript + PostgreSQL source registry
        |
        v
canonical immutable manifest artifact + atomic pointer
        |
        v
projectiond admission (length, digest, schema, succession)
        |
        v
immutable in-memory namespace
        |
        v
local passthrough or HTTP Range source adapter
        |
        v
read-only FUSE regular files
        |
        +------> Plex
        +------> Jellyfin
        +------> Emby
```

### 2.2 Identity has three layers

Do not collapse these during review:

1. `logicalMediaId` is the catalog identity.
2. `projectedVersionId` identifies one exact byte stream and owns size, mtime and inode stability.
3. a source locator tells the data plane where those bytes can be read.

Provider access URLs, signed URLs, tokens and leases are ephemeral transport material. They are not
manifest identity and must not cause a new namespace generation during ordinary renewal.

---

## 3. Normative reading order

Read in this order. Later run records can supersede an earlier status sentence while preserving it for
auditability.

1. `docs/ADR_002_PROJECTION_APPLIANCE.md`
   - architectural decision, rejected alternatives and control-plane/data-plane split.
2. `docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md`
   - normative RFC 2119 requirements.
3. `src/core/projection/manifest-v1.ts`
   - executable manifest structure, identity, admission and succession rules.
4. `src/core/projection/runtime-contract.ts`
   - executable operations, errors, deadlines, limits, caches, secrets and platform boundaries.
5. `docs/schemas/projection-manifest-v1.schema.json`
   - portable structural schema.
6. `docs/PROJECTION_ROADMAP.md`
   - phase history and current product direction.
7. `docs/PROJECTION_PHASE_9_TORBOX_USENET.md`
8. `docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md`
9. `docs/PROJECTION_PHASE_11_MIXED_SOURCE_ACCEPTANCE.md`
10. `docs/PROJECTION_PHASE_12_AUDIT_AND_PROVIDER_FREE_CLOSURE.md`
11. `docs/PROJECTION_PHASE_13_PRE_ENTRY_INSTRUMENT_REPAIR.md`
12. `docs/PROJECTION_PHASE_13_REAL_PROVIDER_ACCEPTANCE.md`
13. `docs/PROJECTION_PHASE_14_USENET_MIXED_ACCEPTANCE.md`
14. `docs/PROJECTION_PHASE_15_RELEASE_AND_ROLLBACK.md`
15. the corresponding `src/core/projection/phase*.ts`, test suites and deploy gates.

### 3.1 Preserved-history warning

The opening status lines in some phase contracts are historical and intentionally remain on disk. Do not
quote the first status-looking sentence and stop reading.

- Phase 9's opening says “authorized, not yet built”; later phases show that its product and provider-free
  rehearsal were built, while four live claims remain open.
- Phase 10's opening says “not yet built”; its later section 11.9 records **GO**.
- Phase 11's opening says “not built, not run”; its later section 10.8 records **tier-one GO**, while tier two
  remains open and not run.
- Phase 12 keeps an earlier NO-GO record, then section 10.9 records **GO** and later amendments apply the
  frozen-candidate rule to successor candidates.
- Phase 13's current run record remains authoritative: **NOT RUN, NOT ENTERED, ENTRY NOT AUTHORISED**.

This preservation is deliberate. A roadmap row or phase document must not erase a failed or superseded
record merely because a later candidate passed.

---

## 4. Repository map

| Path | Responsibility | Review focus |
|---|---|---|
| `src/core/catalog/` | catalog authority and lifecycle | authority remains append-only and separate from projection transport |
| `src/core/projection/` | executable projection contracts and publisher logic | manifest identity, admission, closure predicates, no provider leakage into neutral modules |
| `src/core/usenet/` | SABnzbd boundary, durable job ledger, completed-output proof and admission | exactly-once behavior, no-follow filesystem checks, redaction and refusal states |
| `src/ops/` | operator and test-driving CLIs | strict input shapes, safe errors, no value echo, no hidden mutation |
| `projectiond/` | Go data plane | read-only FUSE namespace, immutable generation, bounded reads/caches/recovery |
| `projectiond/internal/daemon/` | pointer loading, readiness/liveness, mount observation and admission | last-known-good preservation and truth-vs-belief semantics |
| `projectiond/internal/manifest/` | data-plane manifest parsing | strict structure and cross-language agreement |
| `projectiond/internal/namespace/` | immutable namespace | stable inode/path behavior and generation pinning |
| `projectiond/internal/source/` | local and HTTP Range adapters | bounded transport, resolver single-flight/cooldown and allowlists |
| `projectiond/internal/cache/` | probe and playback caches | bounded memory/disk ownership and restart-safe probe behavior |
| `projectiond/internal/fusefs/` | filesystem frontend | regular files only, mutation returns `EROFS` |
| `deploy/projection-alpha.sh` | shipped lifecycle owner | sole mount/daemon owner; install/start/stop/upgrade/rollback behavior |
| `deploy/projection-content.sh` | shipped content-plane surface | operator content changes without owning the mount |
| `deploy/projection-*-gate*.sh` | real-host/fake-provider instruments | exact claims, cleanup, skip semantics and three-run accounting |
| `docker-compose.projection-*.yml` | isolated gate topologies | pinned images, loopback-only ports, no second mount owner |
| `test/` | executable contracts and adversarial controls | controls must prove that audits bite, not merely parse source |
| `test/suite-inventory.json` | canonical suite registry | no suite silently omitted; capability group is explicit |
| `docs/PROJECTION_PHASE_*.md` | contracts, evidence and amendments | distinguish contract, run, verdict, non-claim and supersession |

### 4.1 Technology and execution assumptions

- Node.js 22 runtime image.
- strict TypeScript targeting ES2022 with `noUncheckedIndexedAccess`.
- PostgreSQL 16; the control plane remains the only database authority.
- Go data plane built/tested with the pinned Go 1.26.5 image used by the projection harnesses.
- Linux/Unraid is required for real FUSE, mount propagation and real media-server evidence.
- Windows can run the compiler and offline inventory but cannot close a Linux mount claim.
- Shell gates require a real POSIX shell. Optional wrappers may fold an environmental skip for convenience;
  closure functions never treat that fold as evidence.

---

## 5. Non-negotiable product invariants

A review finding is high priority if it can violate any row below.

| Invariant | Consequence |
|---|---|
| Control plane is the sole authority | `projectiond` cannot invent, remove, rename or select catalog entries |
| No second database in the data plane | no SQLite or shadow catalog state |
| Unavailability is not absence | last admitted generation remains visible through control/provider outages |
| Manifest publication is immutable and atomic | exact bytes, length and digest are checked before admission |
| Bad successor does not disturb current generation | refusal is fail-closed, not replacement with an empty tree |
| Namespace is read-only regular files | no symlinks and every mutation path returns `EROFS` |
| One mount point has one owner | gates drive `projection-alpha.sh`; they do not start a competing daemon |
| Consumers attach before the first appliance mount | remount remains visible through the existing Plex/Jellyfin/Emby binds |
| Provider identity stays below file identity | URL/lease renewal cannot churn paths, versions or inodes |
| Operator secrets never enter evidence | no keys, tokens, URLs, refs, paths or media identity in reports/errors |
| Skip is not pass | exit 77 and required-but-skipped counts cannot close a claim |
| Counts have explicit numeric domains | reject `NaN`, infinities, negatives and fractional counts before comparison |
| A gate cannot set its own budget | thresholds are committed before execution and imported from their owner |
| Cleanup is part of success | residue, altered host sets or an unowned mount prevents closure |
| Real-Debrid is outside current scope | no implied support, fallback or dependency |

### 5.1 Usenet-specific invariants

- The worker owns acquisition, decoding, repair and unpacking; none occurs in the FUSE read path.
- Only completed, stable, regular, no-follow-verified files can be admitted.
- Queue disappearance is not success; history must positively prove completion.
- The durable job ledger reserves before submit and prevents a restart from duplicating a job.
- An admitted entry is not unpublished by a later refusal.
- No cleanup command deletes operator content, SABnzbd history or an operator's input.
- A Usenet failure must not move or hide an already admitted TorBox entry.

---

## 6. Spec-opt workflow for Claude Code

“Spec-opt” in this handoff means **specification first, observable optimization second**. Correctness and
claim boundaries are optimized before code volume or runtime speed.

### 6.1 Required loop

1. **Select one observable.** State the user-visible or operator-visible behavior being reviewed.
2. **Find its authority.** Name the exact contract section and executable constant/function that owns it.
3. **Build the trace.** Follow contract → module → CLI/gate → report → test → inventory entry.
4. **State the failure oracle.** Identify which test, closure predicate or run assertion must fail if the
   behavior is wrong.
5. **Attack the oracle.** Prefer a control that tampers a copy or drives a boundary over a check that only
   searches for a string.
6. **Record the finding before repair.** Classify it as product, instrument, document, environment or
   out-of-scope.
7. **Bound ownership.** List every file that a repair must modify and every neighboring file it must not.
8. **Write/adjust the spec and failing control first.** Never move a threshold after observing a result.
9. **Implement the smallest complete repair.** Avoid a second code path, installer, daemon or copied rule.
10. **Optimize only with measurements.** Preserve semantics, bounds, redaction and last-known-good behavior.
11. **Run focused gates, then the complete required inventory.** Report selected/pass/fail/skip counts.
12. **Update evidence without rewriting history.** Mark an old statement superseded and keep it whole.

### 6.2 Review quality bar

A useful finding contains:

- severity and class;
- exact file and symbol/section;
- violated invariant;
- concrete reachable scenario;
- current behavior and expected behavior;
- the test or control that should catch it;
- repair ownership and regression cost;
- whether real-host or provider evidence would be invalidated.

A vague observation such as “needs more tests,” “could be cleaner” or “may race” is not a finding until the
reachable state and failure oracle are named.

### 6.3 Optimization guardrails

Do not optimize by:

- merging control-plane and data-plane authority;
- caching absence or a failed scan as a namespace decision;
- replacing a closed-set error with an arbitrary upstream error string;
- widening a provider allowlist to make a test pass;
- reducing three fresh runs, a soak duration or a cleanup assertion after a failure;
- sharing one self-reported boolean between the system under test and its verifier;
- replacing set equality with count equality;
- trusting a media-server search hint when a local exact filter is required;
- adding a parallel “temporary” operator path that bypasses shipped commands.

---

## 7. Current Projection Phase ledger

| Projection phase | Current state | What it established or still needs |
|---|---|---|
| 0 | Frozen/done | executable manifest/runtime contract and architecture decision |
| 1 | Done | vertical slice: publisher → manifest → `projectiond` → FUSE → three media servers; real TorBox contact later discharged the remaining provider sentence |
| 2 | Done | mount hardening and rclone comparison control; rclone remains a control, not architecture |
| 3 | Closed | six-arm reliability loop with all three real consumers over a real provider |
| 4 | Closed | observed mount truth added beside remembered mount state |
| 5 | Closed | observed truth becomes readiness-authoritative with bounded grace/hold/recovery policy |
| 6 | Closed | deployable Unraid alpha and bounded, reason-aware recovery |
| 7 | GO | operator-usable alpha with real TorBox bytes and three real media servers |
| 8 | GO | repeated operator soak over inherited state, recovery, upgrade and rollback |
| 9 | Product and provider-free rehearsal built; real closure open | TorBox + SABnzbd/local admission exists. `P9-2`, `P9-3`, `P9-5`, `P9-11` still need real Usenet/mixed evidence |
| 10 | GO | provider-free operator content plane and divergence reporting |
| 11 | Tier one GO; tier two open | fake/instrument tier passed. `P11-R1`–`P11-R4` require real mixed-source and real media-server evidence |
| 12 | GO | independent audit, repaired instrument controls, provider-free host closure and roadmap for 13–15 |
| 13 | Contract/pre-entry built; **NOT RUN, NOT ENTERED, NOT AUTHORISED** | real TorBox acceptance awaits complete entry authorization and operator window |
| 14 | **PREFLIGHT ONLY; NOT RUN, NOT ENTERED** | boolean-only operator preflight for real Usenet and mixed three-server acceptance |
| 15 | **CONTROL PLANE ONLY; NOT RUN, NOT CLOSED** | release/rollback/soak/review planner and fail-closed closure predicate |

No statement in this table promotes a preparation artifact into live evidence.

---

## 8. What the latest build added

### 8.1 Projection Phase 14

Files:

- `docs/PROJECTION_PHASE_14_USENET_MIXED_ACCEPTANCE.md`
- `src/core/projection/phase14.ts`
- `src/ops/projection-phase14-preflight-cli.ts`
- `test/projection-phase14.ts`

The preflight accepts a closed set of thirteen boolean confirmations. It refuses unknown fields and
non-boolean values. It cannot carry a worker address, credential, category name, path, NZB/indexer reference
or media identity because its schema has no field capable of carrying one.

Required shapes cover:

- Phase 13 GO and zero skips;
- an already-running operator SABnzbd with NNTP already configured;
- dedicated category, incomplete directory and complete directory;
- one entitled success source and one expected-failure/incomplete source;
- the completed directory already below the served media root; and
- Plex, Jellyfin and Emby already attached before the appliance mount.

The report is `READY` or `BLOCKED`. In both cases:

- `phase14Entered` is false;
- `contactsMade` is zero;
- `valuesEchoed` is false;
- `claimsClosed` is empty; and
- all eligible claims remain listed as open.

`READY` means “ready to request separate live authorization,” not GO and not permission to contact a worker
or provider.

Commands:

```bash
npm run test:projection-phase14
npm run ops:projection-phase14-preflight -- --json
npm run ops:projection-phase14-preflight -- --descriptor path/to/boolean-only.json --json
```

Expected default behavior: exit 3 / `BLOCKED`, because an empty descriptor confirms nothing.

### 8.2 Projection Phase 15

Files:

- `docs/PROJECTION_PHASE_15_RELEASE_AND_ROLLBACK.md`
- `src/core/projection/phase15.ts`
- `src/ops/projection-phase15-plan-cli.ts`
- `test/projection-phase15.ts`

The planner composes existing surfaces rather than creating substitutes:

- package/acceptance: `deploy/ci/release-candidate-acceptance.sh`;
- install: `deploy/projection-alpha.sh install`;
- upgrade: `deploy/projection-alpha.sh upgrade`;
- rollback: `deploy/projection-alpha.sh rollback`;
- soak decision: `phase9RequiresSoakRerun(actualChangedPaths)`;
- review: an independent reader who did not build the tranche.

Entry can be prepared after Phase 14 GO, or after the Phase 14 preflight when every open claim and its
required window is recorded. This is preparation only.

Closure is fail-closed. It requires:

- frozen commit, immutable image digest and reproducible build;
- real-host install, upgrade and rollback;
- preserved host container/network/volume membership;
- readable namespace and byte identity after rollback;
- literal shipped-runbook execution with zero outside commands and zero interventions;
- the Phase 8 soak if and only if the shared changed-path predicate requires it;
- exactly three fresh tier-one and three fresh tier-two sequences with zero skips; and
- independent review with findings recorded and disposition `accept`.

The closure predicate recomputes the soak decision from the actual changed-path set. It does not trust a
self-reported `soakRequired` boolean.

Commands:

```bash
npm run test:projection-phase15
npm run ops:projection-phase15-plan -- --input path/to/entry-and-changed-paths.json --json
```

The planner prints only the changed-path count, not the paths themselves, and executes no maintenance
command.

---

## 9. Verification model

### 9.1 Safe local review commands

```bash
npm run typecheck
npm run test:inventory
npm run test:projection-phase14
npm run test:projection-phase15
npm run test:phase9
npm run test:phase10
npm run test:phase11
npm run test:phase12
npm run test:phase13-preentry
npm run test:phase13
npm run test:release-candidate-acceptance
npm run test:offline
```

Latest measured result on the integration branch:

```text
suites selected 341 | passed 341 | failed 0 | not selected 39 | required-but-skipped 0
```

The 39 non-offline suites are not implied failures; they belong to database or Docker capability groups.
Run them only with their declared dependencies and report capability skips honestly.

### 9.2 Real-host commands are not review toys

Commands under `deploy/projection-*-gate.sh`, especially real-provider, Phase 7/8, Phase 11 and TorBox gates,
can create containers, mounts and provider traffic. Do not run them merely to “see what happens.” First read
their phase entry criteria, verify exact host ownership, establish the frozen candidate, obtain operator
authorization and preserve before-state sets.

Never:

- print or request an API key, provider reference, endpoint URL, NZB/indexer URL or completed source path;
- edit an origin allowlist to turn a blocked run green;
- induce a provider or NNTP outage;
- treat an optional-wrapper exit zero as phase evidence;
- start a second `projectiond` at the production mount point;
- delete operator content or worker history during cleanup.

### 9.3 What to compare during code review

For each phase module, compare:

1. claim ids and order against the contract table;
2. thresholds against their imported owner;
3. numeric domains before comparisons;
4. closure predicate against every prose exit criterion;
5. gate-emitted ids against the module's emittable set;
6. three-run wrapper accounting and exit 77 behavior;
7. cleanup assertions against actual created resources;
8. file ownership table against `git diff --name-only`;
9. suite presence in `test/suite-inventory.json`;
10. redaction scans against every preserved output and failure path.

---

## 10. Review assignments for Claude Code

Perform these passes in order and produce findings before patches.

### Pass A — contract topology

- Confirm Phase 0 schema, TypeScript contract and Go manifest reader agree.
- Confirm later phases do not add a source kind, manifest field, schema version or degraded reason without an
  explicit earlier contract amendment.
- Confirm a later phase never closes a claim owned by an earlier phase.

### Pass B — Phase 14 redaction and non-entry

- Attack the boolean-only parser with arrays, null, unknown keys, strings, numbers and inherited properties.
- Confirm every Phase 12 section 12.2 operator input has exactly one requirement row.
- Confirm no report or error can echo the descriptor path or a descriptor value.
- Confirm all-true produces readiness only and cannot produce Phase 14 entry or closure.

### Pass C — Phase 15 closure integrity

- Compare every Phase 12 section 12.3 exit criterion with `phase15ClosureProblems`.
- Attack every numeric field with invalid domains.
- Prove the changed-path soak predicate cannot be replaced by the evidence's own boolean.
- Check exact-three semantics, zero skips and independent-review acceptance.
- Confirm the planner executes no command and exposes no changed path.

### Pass D — composition boundaries

- Trace one TorBox entry and one admitted Usenet local entry from registration through publication and FUSE.
- Confirm a source failure cannot rewrite the other entry's visibility or identity.
- Confirm the shipped lifecycle script remains sole mount owner.

### Pass E — historical evidence consistency

- Verify current status from the latest run-record/amendment section, not the first historical heading.
- Verify changed files are claimed by a post-candidate ownership table.
- Verify a record commit does not silently inherit evidence from a superseded candidate.

### Requested review output

Return:

1. a findings list ordered by severity;
2. a spec-to-code trace table;
3. tests run with exact counts and capability skips;
4. files examined but not changed;
5. proposed repairs as separate bounded change sets;
6. residual risks and which require a real host/operator window.

If there are no findings, say which adversarial controls were exercised. “Looks good” alone is not an
independent review.

---

## 11. Future phases

### 11.1 Authoritative next execution work — already contracted

These are the actual next phases. Their control surfaces are built, but their live evidence is not.

#### Projection Phase 13 — real TorBox acceptance

Entry requires every Phase 13 criterion to pass from one frozen candidate, the operator's already-served
TorBox configuration to remain unchanged, a no-contact readiness record, an entitled object reference by
shape only, and explicit authorization. The run must use the provider-specific TorBox real gate, complete
three fresh times with zero skips, preserve the allowlist and host sets, and leave no residue.

Do not begin Phase 14 merely because Phase 13 tooling exists. Phase 13 must be GO.

#### Projection Phase 14 — real Usenet and mixed-source three-server acceptance

First run the boolean-only preflight. If any confirmation is missing, stop. With all prerequisites and a
separate operator authorization, run the real SABnzbd/NNTP mixed-source sequence. It must prove completed
admission, expected refusal, one mixed generation, Plex/Jellyfin/Emby reads, restart safety, isolation across
source failures and three fresh sequences. `P11-R3` closes only if a natural outage occurs or can be waited
for; an outage is never induced.

#### Projection Phase 15 — release candidate, rollback, smoke, soak and independent review

Prepare the plan from the actual changed-path set. In an authorised maintenance window, build one frozen
candidate, reproduce its image, drive shipped install/upgrade/rollback commands, perform literal operator
smoke, run the soak iff required, complete both sequence tiers three times and obtain independent acceptance.
Only `phase15ClosureProblems(...)` returning empty may support a Phase 15 closure statement.

### 11.2 Proposed post-Phase-15 roadmap — NOT AUTHORISED

No contract currently authorises Projection Phase 16 or later. The following is a proposed dependency queue,
not evidence and not permission to implement it. Before work begins, write one narrow contract with entry,
exit, refusals, ownership and invalidation rules.

#### Proposed Projection Phase 16 — distributable operator beta

**Entry:** Phase 15 GO and independent acceptance.

**Goal:** turn the accepted candidate into one versioned, digest-pinned beta artifact and Unraid installation
path using existing release machinery. Prove clean install, upgrade from the last supported alpha, rollback,
fresh-host preflight and documentation from the actual bundle.

**Refusals:** no new provider, no automatic indexer/search policy, no second installer, no silent migration,
no claim of general availability.

#### Proposed Projection Phase 17 — field supportability and bounded endurance

**Entry:** Phase 16 beta installed by an operator from the shipped artifact.

**Goal:** validate actionable health/status, bounded log volume, restart persistence, cache/ledger growth,
provider rotation handling and operator recovery over a predeclared endurance window. Every alert must map to
a shipped diagnostic or recovery action.

**Refusals:** no uptime percentage, high-availability claim or automatic failover unless a later contract
defines and measures one. Do not turn transient provider absence into namespace deletion.

#### Proposed Projection Phase 18 — v1 release disposition

**Entry:** Phase 16 packaging GO and Phase 17 supportability GO, with all Phase 13–15 open claims resolved or
explicitly carried as documented limitations.

**Goal:** independent release review, exact artifact/digest publication, anonymous-pull verification where
the release system requires it, install/upgrade/rollback instructions and an explicit supported-scope matrix
for TorBox, completed-file Usenet, Plex, Jellyfin and Emby.

**Refusals:** no Real-Debrid claim, no instant Usenet streaming, no HA/load/uptime claim and no erasure of
known rough edges from the release notes.

### 11.3 Optional backlog, deliberately outside the numbered roadmap

- Real-Debrid architecture decision and provider contract, only after an explicit operator decision reopens
  it. Do not copy TorBox assumptions into a second provider.
- second-host portability evidence;
- high availability/failover design;
- indexer search and content-selection policy;
- instant Usenet streaming;
- load/performance characterization.

Each item changes product scope and must not be smuggled into a reliability or packaging repair.

---

## 12. Known review traps

1. **Historical status lines are not current verdicts.** Read the latest run record.
2. **A gate existing is not a gate passing.** Phase 13–15 tooling does not mean live closure.
3. **Fake provider evidence cannot close real-provider claims.** Tier boundaries are strict.
4. **A media-server container is not Plex/Jellyfin/Emby evidence.** Real tier-two claims need the real
   applications through their own pre-attached binds.
5. **Count equality is weaker than set equality.** A removal plus creation preserves a count.
6. **A mounted boolean is belief, not observation.** Later readiness uses bounded observed truth.
7. **Cleanup can destroy the subject.** Resource names and mount identity must be owned and re-checked at the
   instant of mutation.
8. **CRLF can invalidate byte-oriented shell audits.** Parsers must behave the same under LF and CRLF, while
   shipped shell remains LF.
9. **A self-reported prerequisite is not proof.** Recompute decisions such as soak triggering.
10. **Provider rotation is usually BLOCKED, not product FAIL.** Never widen policy during a run.
11. **No-contact preflight is a real boundary.** Do not “validate” it by pinging the service it guards.
12. **Documentation-only successors can invalidate candidate ownership.** Run the Git-driven ownership tests
    after committing new files.

---

## 13. Copy/paste Claude Code review prompt

```text
Review this repository at the current integration branch using
docs/CLAUDE_CODE_PROJECTION_REVIEW_HANDOFF.md as the entry point.

Begin read-only. Follow the normative reading order and the spec-opt loop. Reconcile current phase status
from the latest run-record/amendment sections, not preserved historical headings. Review the complete
control-plane -> manifest -> projectiond -> FUSE -> media-server path, with deep adversarial passes over
Projection Phases 14 and 15.

Do not contact a real provider, worker or media server. Do not run a real-host gate, change an allowlist,
read a secret, start a competing daemon or mutate an operator mount. Do not repair findings during the
discovery pass.

Return findings ordered by severity, a spec-to-code trace, exact tests/counts, proposed bounded repair sets,
and residual risks requiring operator or real-host evidence. If no findings exist, identify the adversarial
controls actually exercised. Treat all post-Phase-15 roadmap entries as proposals, not authorization.
```

---

## 14. Handoff acceptance checklist

Claude should be able to answer all of these before changing code:

- Why is rclone present but not the architecture?
- Which process decides what exists, and which process only serves bytes?
- What prevents a provider outage from looking like mass deletion?
- Why is provider lease renewal not a new manifest generation?
- Why must media-server binds exist before the first appliance mount?
- Which Phase 9 and Phase 11 claims remain open?
- Why is Phase 13 tooling not Phase 13 GO?
- What does Phase 14 `READY` mean and explicitly not mean?
- How does Phase 15 derive whether a soak is required?
- Which commands are safe offline and which require operator authorization?
- Why must old NO-GO text remain in the documents?
- Why is Real-Debrid absent from the current roadmap?

If any answer is unclear, return to the normative reading order rather than inferring it from filenames.

---

## 15. File ownership

| Path | New or modified | Purpose |
|---|---|---|
| `docs/CLAUDE_CODE_PROJECTION_REVIEW_HANDOFF.md` | new | self-contained Claude Code review and future-phase handoff |
