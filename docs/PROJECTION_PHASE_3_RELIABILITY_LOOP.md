# Projection Phase 3 — the reliability loop

**Status: NOT RUN.** Every threshold in §4 was fixed before the first measured run, and §8 is empty until a
run fills it. This document is a contract, not a record; the moment it carries figures it also carries the
commit, tree digest and image digest they were taken on.

**What Phase 3 is, in one sentence.** The product doing its ordinary job — three real media servers reading a
real provider's object through the production `projectiond` mount — *while the lifecycle failures Phase 2
hardened are done to it on purpose*, repeatedly, from a clean host each time.

**The one thing it adds, and it is narrow.** Phase 1 proved the slice works. Phase 2 proved the daemon's own
mount lifecycle survives three named failures — **with no media server in any of the nine runs and no real
provider contacted**. Phase 3 is the intersection those two tranches deliberately left empty: **the same
failures, with all three consumers attached, over a real provider.** Nothing else. No new frontend, no new
source adapter, no packaging, no release.

**Why the intersection is not implied by the two halves.** Phase 2's own worst defect is the argument:
`--auto-remount` recovered the namespace **for the daemon and for nobody else** — the daemon logged success,
`/readyz` said ready, and no consumer could see a file. That defect is invisible to every gate that has no
consumer attached, and it is invisible to every gate that has no fault injected. It is visible only here.

---

## 1. The topology

**ONE** PostgreSQL, **ONE** publisher, **ONE** production `projectiond`, **ONE** FUSE mount, **ONE**
loopback-only TorBox resolver sharing the daemon's network namespace, and **THREE** real, digest-pinned media
servers — Plex, Jellyfin and Emby — each holding the **same** mount directory as the **same** Movies library
root, for the whole run.

It is the G18 topology with G18's fake endpoint replaced by the real one, and the real one is reached exactly
the way `deploy/projection-torbox-real-gate.sh` reaches it: the daemon container starts first, the resolver
joins it with `--network container:<daemon>`, so the resolver is never published to a host port and the
TorBox API key exists only inside the resolver container. The daemon holds the gate secret and nothing else.

| Piece | Where it comes from | Why not something new |
|---|---|---|
| the three media servers, their bootstraps, libraries, scans, catalogues and paced play | `src/ops/projection-{jellyfin,plex,emby}-dataplane-cli.ts`, unchanged | six of the Jellyfin gate's behavioural conclusions are false for Emby; a unified driver would inherit every one |
| the three-way scan observation | `src/ops/projection-three-server-concurrency-cli.ts`, `concurrent-scan` + `verify-overlap`, unchanged except §7's one contained flag | whether three scans overlapped is a property of one clock watching three servers |
| the resolver, its loopback-only arrangement, its reachability probe and the operator input contract | `deploy/projection-torbox-real-gate.sh` and `src/ops/torbox-resolver-cli.ts`, unchanged | it is the only arrangement that has ever contacted TorBox and survived a review |
| unmount propagation, run-directory removal and the cleanliness report | `deploy/projection-gate-cleanup.sh`, unchanged | `rm -rf` over a dead FUSE mount does not do what it looks like it does |
| every budget in §4 | `src/core/projection/runtime-contract.ts`, imported | the budgets are code; this document restates none of them |

**The namespace is two entries and both are load-bearing.**

- **The real entry** — the operator's TorBox object, published at a projected path this gate chooses:
  `Movies/Projection Real Object 01 (2026)/Projection Real Object 01 (2026).mkv`. **The operator's own label
  is never used as a path component**, so it cannot reach a media server's database, and it is a needle in
  the leak search instead.
- **The local seed entry** — a synthetic file generated on the host. It exists for two reasons: three
  libraries need a directory that resolves before anything remote is published (and Plex begins scanning a
  section the instant it exists, which nothing in its API can prevent), and it is the **control**: a fault
  aimed at the remote path must not stop the local one reading correctly, and a fault aimed at the mount must
  stop both.

**`.mkv` IS A CHOICE AND IT IS NOT DERIVED FROM ANYTHING.** The operator's `objects.json` carries a label with
no extension, and the container format of the object is not something this repository is entitled to know.
`.mkv` is what makes all three scanners treat the entry as a movie file; every one of them then determines
the codec facts by probing the bytes, not the name. The gate `ffprobe`s the entry once, through the mount,
before it asks any server to play it, and **fails with a named message if it is not a decodable video** —
rather than proceeding and blaming a media server for a corpus the plan requires the operator to have chosen
as playable video.

## 2. A cycle

One cycle is four phases and it is the unit everything in §4 is counted in.

| Phase | What happens | What is required |
|---|---|---|
| **O — ordinary** | all three servers rescan the namespace; each produces its own catalogue through its own ordinary-file predicate; each plays the real entry through its own direct-play path | the real entry and the seed entry present at their published sizes as ordinary files on all three, zero churn, play starts inside the budget and decodes |
| **B — bytes** | the four operator-approved windows are read **through the mount** and digested, and **each media server reads the same four windows inside its own container as its own uid** | every digest equals the value recorded outside the mount before any run; `lstat` says an ordinary regular file at exactly the published size |
| **F — fault** | one arm from §3, in the fixed order A1…A6 | the arm's own assertions |
| **R — recovery** | phase B again, then phase O again | identical digests, identical identities, zero churn, inside the arm's recovery budget |

**A cycle that skips a phase is a failed cycle.** The results document carries one terminal verdict per phase
per cycle; a run whose arm set is not exactly the six ids in §3 fails on the set, not on the count.

## 3. The six arms

Each is a failure Phase 2 hardened, done here **with three consumers attached and a real provider behind the
mount**. The order is fixed so a run is reproducible and so the two arms that drop the daemon's in-memory
lease come before the two that depend on a resolution actually happening.

| Id | The failure | How it is caused | What is asserted beyond phases B and R |
|---|---|---|---|
| **A1** | graceful daemon restart | `docker stop -t 30`, then start | the namespace goes away and comes back; `/readyz` ready inside `READY_BUDGET_MS`; all three servers read the entry again from **inside their own containers** |
| **A2** | daemon SIGKILL, then restart over the corpse | `docker kill -s KILL`, verify the corpse is stale by `statfs` answering ENOTCONN from a sibling while mountinfo still names `fuse.projectiond`, then start | the probe **names** the corpse and stacks over it; recovery inside `READY_BUDGET_MS`; **zero library churn on all three** |
| **A3** | the mount is taken out from under a living daemon | external `umount` through a shared mount from a sibling container, daemon running `--auto-remount` | the daemon observes a serve death and remounts **in place**; the entry's inode, size and mtime are unchanged; and — the assertion this whole tranche exists for — **all three media servers can read the file through their own binds afterwards**, which is precisely what Phase 2's `--auto-remount` defect did not deliver |
| **A4** | sustained provider outage past the breaker's budget | the resolver's copy of the TorBox credential is emptied, so it answers **503 to every request without contacting TorBox at all**, and the daemon is restarted so no lease is cached; the credential is restored **mid-hold**, so the endpoint is healthy and receiving nothing | reads fail inside `READ_DEADLINE_MS`; the breaker opens; **zero resolver requests during the remainder of the hold, counted in the resolver's own log against a live and healthy resolver**; the namespace does not churn on any of the three; the first read after the cooldown succeeds and digest-matches inside `OUTAGE_RECOVERY_BUDGET_MS` |
| **A5** | credential rotation | two halves. **(i) invisible while the lease holds:** the resolver's accepted gate secret is rotated while the daemon still presents the old one, and reads keep succeeding, because a resolved source needs no resolution. **(ii) refused, then converged:** the daemon is restarted so a resolution is required — the resolution is **refused** and the read fails EIO with the namespace unchanged; the new secret is then delivered to the daemon's token file and the read converges | the refusal is observed in the resolver's own log; convergence within `ROTATION_CONVERGENCE_READS` reads; **the breaker does not open**, which is what bounds the refusal half at `ROTATION_REFUSAL_READS_MAX` |
| **A6** | frontend restart and rescan | all three media servers restarted over the same mountpoint | each comes back, rescans warm, and settles on the **same identities** — zero added, zero removed, zero item-id churn on all three |

**Why the daemon runs with `--auto-remount` for the whole run.** A3 needs it. A1 and A2 are unaffected by it —
a requested stop and a SIGKILL are not serve deaths — and running two daemon configurations inside one run
would mean the six arms were not done to the same subject.

**Why A5 restarts the daemon in its second half, said plainly rather than glossed.** Access material is
memory-only by contract (`PROJECTIOND_ACCESS_RESOLUTION.LEASE_STORAGE`). A rotation cannot be observed against
a source whose lease is still valid — and that is the first half's finding, asserted rather than worked
around. Forcing a resolution therefore means dropping the lease, and the only way to drop it is to restart the
daemon. The restart is part of the arm.

## 4. The predeclared thresholds

**Every one of these was written down before the first measured run.** Where a number is derived, the
derivation is given and the source constant is named; where a number is **chosen**, it says so, because a
chosen number presented as a derived one is the failure this repository keeps finding in its own documents.

| Name | Value | Where it comes from |
|---|---|---|
| `CYCLES_PER_RUN` | **6** | one per arm in §3. Not a round number: the arm list is the cycle list |
| `CONSECUTIVE_FRESH_RUNS` | **3** | the repository's own closure convention for every gate that has ever closed. One green run is a coincidence |
| `READY_BUDGET_MS` | **22,000** | `2,000` (the gate's own `--poll 2s` pointer interval) + `READ_DEADLINE_MS` `20,000`. Those are the only two bounded waits between a daemon start and a namespace a sibling container can read |
| `READ_FAIL_BUDGET_MS` | **20,000** | `PROJECTIOND_READ_POLICY.READ_DEADLINE_MS`, straight. A read that fails during an outage fails inside the product's own deadline or the product is wrong |
| `BREAKER_REFUSAL_BUDGET_MS` | **5,000** | `PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS`. A read refused locally by an open breaker never queues, so it must beat the shortest wait any admitted read could incur. The observed figure is recorded beside it and is expected to be three orders of magnitude smaller; **the ceiling is the derived one, not the observed one** |
| `OUTAGE_RECOVERY_BUDGET_MS` | **80,000** | `PROJECTIOND_CIRCUIT_BREAKER.OPEN_COOLDOWN_MS` `60,000` + `READ_DEADLINE_MS` `20,000`, measured from the release instant to a successful digest-matching read |
| `HOLD_RESOLVER_REQUESTS_MAX` | **0** | `PROJECTIOND_CIRCUIT_BREAKER.WHILE_OPEN` — `fail-fast-locally-zero-provider-traffic` |
| `HOLD_WINDOW_MS` | **30,000** | half of `OPEN_COOLDOWN_MS`, and **the fraction is the point rather than the number**. The claim measured over this window is *zero requests reached the endpoint while the breaker was open*, and the breaker closes on its own after the cooldown and admits one half-open probe. A window that could outlast the cooldown would count that probe — one legitimate request against a ceiling of zero — and fail a correct product for doing exactly what the contract says it must. Half is strictly inside by construction, and stays so if the cooldown ever changes |
| `HALF_OPEN_PROBES` | **1** | `PROJECTIOND_CIRCUIT_BREAKER.HALF_OPEN_PROBES` |
| `ROTATION_CONVERGENCE_READS` | **2** | the daemon caches the credential in memory and re-reads the file only on a 401/403 from the resolver (`projectiond/internal/source/resolver.go`, `Reload` at the `StatusUnauthorized`/`StatusForbidden` branch). One read spends the reload; the next presents the new value. Two is the maximum that mechanism can need — it is a property of the code, not a measurement |
| `ROTATION_REFUSAL_READS_MAX` | **2** | strictly under `PROJECTIOND_CIRCUIT_BREAKER.FAILURE_THRESHOLD` `5`, because `CondSourceAuthRefused` counts toward the breaker and A5 is not about the breaker |
| `LIBRARY_CHURN_MAX` | **0** | `PROJECTION_PHASE_1_BUDGETS.MAX_LIBRARY_CHURN_ITEMS` |
| `RESOLUTIONS_PER_WIRE_READ_MAX` | **1** | `PROJECTIOND_READ_POLICY.MAX_ACCESS_REFRESHES_PER_READ` and `PROJECTIOND_ACCESS_RESOLUTION.MAX_REFRESHES_PER_SOURCE_PER_COOLDOWN`, both 1 |
| `PLAY_START_BUDGET_MS` | **10,000** | `MEDIA_SERVER_SOAK.MAX_STARTUP_SECONDS`, which is G8's own ten seconds, imported rather than restated |
| `PLAY_DECODED_SECONDS_MIN` | **30** | **CHOSEN, with both bounds named.** *Below:* the shipped Jellyfin driver's `paced-play` requires at least 30 progress records from the decoder, roughly one a second, so a shorter window fails that driver's own floor for a reason that is about the window and not about the product — thirty seconds is the shortest window in which all three shipped drivers can report at all. *Above:* §2 of the acceptance plan calls the real-provider corpus a correctness corpus and says it is *never a load test*, and 30 s × 3 servers × 6 cycles × 3 runs = 1,620 decoded seconds is already the outer edge of what one can be asked for. **This is not G8 and does not re-close it** — G8's five minutes are closed on the fake corpus, three times, on this host |
| `WINDOW_DIGESTS` | **4, exact equality** | the operator's own `probeDigests`, recorded outside the mount by direct HTTPS ranged GETs before any run existed |
| `SEED_READ_REQUIRED` | every phase B | the local control entry must read correctly wherever the real one does, and must fail with it when the fault is the mount |

**No threshold in this table may be weakened by a run.** `test/projection-reliability-loop.ts` pins every one
of them against the shipped gate, so a change to any number is a test failure and not a quiet edit.

### 4.1 The closure rule

**Phase 3 closes when, and only when:**

1. `npm run go:reliability-loop-gate:three` completes **three consecutive fresh runs, exit 0, zero skips**, on
   the real Unraid host, **from one frozen commit** whose `deploy/`, `projectiond/`, `src/` and `package.json`
   bytes do not move afterwards;
2. every one of the **18 cycles** completes all four phases, with the arm set in each run exactly
   `A1 A2 A3 A4 A5 A6`;
3. every phase B and every phase R matches all four operator digests exactly;
4. all three frontends are **proven subjects in every cycle** — each with its own catalogue document and its
   own in-container read of the same four windows;
5. every recovery lands inside the budget §4 names for its arm;
6. the host's containers, networks, volumes and `fuse.projectiond` mountpoints are **the same sets** — not
   merely the same counts — before and after every run, and the gate root is empty afterwards;
7. no secret, stable reference, CDN host or operator label appears in anything the run preserves.

**A skip is a failure for the `:three` wrapper**, as it is for every other gate here, and only
`:optional` folds 77 to 0 while saying NOTHING WAS PROVED.

**Why three runs of six cycles and not one run of eighteen.** The question Phase 3 asks is whether the product
survives a fault *from a clean start*, and a long single run answers a different question — whether it
survives a fault while already degraded by the last one. Eighteen cycles inside one process would also mean
one host preparation, one image build and one set of media-server containers standing behind every figure, so
a single unlucky container would take the whole record. Three fresh runs is the same eighteen cycles with
three independent starts.

## 5. What Phase 3 does not claim

- **It is not a load test and it is not a throughput measurement.** One object, four 64 KiB windows and thirty
  decoded seconds per server per cycle. No latency, bandwidth or time-to-first-byte figure here is a
  performance claim, and the wall-clock numbers are this host's.
- **It does not re-close G7–G13, G18 or G22.** Those are Phase 1 gates with their own corpora and their own
  sequences. In particular the ~50-entry corpus is not here, so nothing about scan cost, amplification,
  concurrency budgets or re-scan churn *at corpus scale* is measured.
- **It declares no winner between frontends and it is not a bake-off.** `rclone` appears in this tranche only
  if a diagnosis needs a control, labelled as one; Phase 2 declared no winner and Phase 3 does not invent one.
  `docs/ADR_002_PROJECTION_APPLIANCE.md` is untouched.
- **The continuous three-way overlap is RECORDED, not required.** The three-way scan observation runs in the
  already-pinned `measurement` mode: all three servers observed scanning and at least one fully attributed
  three-way sample are **required**; the two continuous-run floors are recorded against no floor. A rescan of
  an unchanged library is legitimately cheap (G19), so a floor on how long three of them overlap is a floor on
  the wrong thing. G18 is where the strict interpretation lives and it has already run 3/3 on this host.
- **One object is one object.** Every property here is shown for this provider and this shape of object.
- **Provider bytes are not counted.** There is no counter on the far side of a real CDN, and the daemon
  publishes no cumulative provider-byte figure. What is bounded is what the gate itself asks for; what is
  recorded is the daemon's own playback-cache counters and the resolver's own resolution count.
- **No 429 was provoked and none is asserted**, exactly as §6.10 and §6.15 of the acceptance plan say.

## 6. Evidence, secrets and the host

**What is preserved, and it is one file.** `.projection-reliability-loop-gate/evidence/cycles-<pid>.json`, at
mode 0700, holding gate-chosen labels, window geometry, byte counts, elapsed times, verdicts and gate ids. It
structurally cannot hold a secret, a reference, a URL or a provider filename — which is what makes it safe to
preserve from a **failing** run, where the leak scan has not run yet.

**The four operator inputs are read from `PROJECTION_TORBOX_INPUT_DIR`** (default
`/mnt/user/appdata/catalog/secrets/real-provider/torbox`), copied into a 0700 run directory at 0600, never
moved and never widened. With any of them missing the gate **exits 77 before an image is built, a database is
started or a packet is sent**.

**The leak search runs over the manifest directory, the probe cache, all three media servers' library state
and the preserved evidence**, for the API key, the gate secret, the stable reference, the operator's label and
the CDN host. It is the shared `leakcheck.sh` shape: a needle list that arrives as a **file path** rather than
in argv, a `grep` whose non-match and whose failure-to-look are different outcomes, and a hit that names the
needle by index and never prints it.

**The CDN origin is in the daemon's own configuration file by construction**, inside the 0700 run directory,
because the daemon cannot enforce an egress allowlist it has not been told. That is stated here rather than
searched for and quietly excluded.

**The host is left as it was found, and that is asserted rather than reported.** Container, network, volume
and mountpoint **sets** are captured before and after; the success path cleans up explicitly and asserts the
result; the EXIT trap is the failure path's cleanup and can only report, for the reason
`projection_gate_report_cleanliness` gives in its own comment.

## 7. The one shared-code change, and how it is contained

`concurrent-scan` requires `--endpoint` and `--barrier-ref` because G18 rendezvouses three scanners at a held
provider read. **A real provider has no control surface**, so Phase 3 passes neither — and
`runConcurrentScans` already supports that (`opts.endpointBaseUrl !== undefined && opts.barrierRef !==
undefined`); only the CLI makes the two flags mandatory.

So the CLI takes **`--no-barrier`**, and it is the same containment shape `--overlap-mode` was given:

- **absent, the two flags stay mandatory.** Every Phase 1 caller is bit-for-bit unaffected.
- **an unrecognised combination is refused**, never defaulted: passing `--no-barrier` *with* a barrier
  reference is an error rather than a silent preference.
- `test/projection-reliability-loop.ts` asserts **no gate in `deploy/` except this one** contains the flag,
  and `test/projection-three-server-concurrency.ts` keeps asserting the mandatory path.
- with no barrier the run records `barrier: none` in its own outcome, so a results file cannot be read as a
  rendezvous that happened.

**Nothing else in `src/` or `projectiond/` is changed by this tranche unless a real run proves a product
defect** — and if one does, the fix, its regression test and the rerun are recorded in §9.

## 8. Run record

**NOT RUN.**

| Run | Host | Cycles | Arms | Failed | Skipped | Evidence |
|---|---|---|---|---|---|---|
| 1/3 | — | — | — | — | — | NOT RUN |
| 2/3 | — | — | — | — | — | NOT RUN |
| 3/3 | — | — | — | — | — | NOT RUN |

Offline checks, taken on the Windows development host, are recorded in §8.1 when they are taken. They are not
gate evidence: they are what makes a run worth attempting.

### 8.1 Offline

**NOT TAKEN.**

## 9. Defects found, and what each cost

**NONE YET, AND THAT IS THE HONEST STATE OF A TRANCHE WHOSE GATE HAS NEVER RUN.** Phase 1 found six gate
defects on its first real-provider run and fourteen more in the review after it; Phase 2 found nineteen in a
harness that had never completed an arm. The expectation here is not zero, and a table with nothing in it
means the loop has not been run, not that it is clean.

## 10. Reproduction

```sh
# Offline, contacts nothing, runs everywhere in seconds.
npx tsx test/projection-reliability-loop.ts
npx tsx test/projection-mount-hardening.ts
npx tsx test/projection-three-server-concurrency.ts
npx tsx test/custody-runtime-closure.ts
npm run typecheck

# The gate. Needs the operator inputs and a host where /dev/fuse is reachable from a container.
npm run go:reliability-loop-gate            # one run; 77 propagates
npm run go:reliability-loop-gate:three      # the closure command; 77 is a FAILURE
npm run go:reliability-loop-gate:optional   # 77 -> 0, and says NOTHING WAS PROVED
```

It binds host ports **8180–8183**, **32560** and **5590** — a block no other gate in `deploy/` claims, checked
by test — so it can run beside the Phase 1 and Phase 2 gates rather than colliding with them. **Do not run two
gates at once on one host**: they bind fixed loopback ports, and the second dies with a port collision that
reads like a defect and is not.
