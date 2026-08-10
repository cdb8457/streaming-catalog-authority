# Projection Phase 3 — the reliability loop

**Status: NOT RUN, and BLOCKED on an operator input.** Every threshold in §4 was fixed before the first
measured run and none has moved since. §8 records what the real runs observed and what stopped each; §9 the
nine gate defects and what each cost; **§11 the blocker — the provider has rotated its CDN origin out of the
operator's allowlist, which the daemon refuses exactly as it must**; §12 the operational fact this tranche
established. Arms A2-A6 have never completed.

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

**NOT RUN — and it is blocked on a finding rather than on a defect.** No run has satisfied the closure rule
in §4.1. Four runs have been taken on the real Unraid host, each on a frozen tree, and every one is recorded
in §8.2 with what it established and what stopped it. §11 is the finding that stops the fourth, and it needs
a decision this document cannot make for itself.

**WHAT HAS BEEN OBSERVED ANYWAY, AND IT IS MOST OF THE GATE.** These are observations from runs that did not
close; none of them closes anything, and each names the run it came from.

| What | Observed | Run |
|---|---|---|
| the operator's real object published under a gate-chosen path, admitted, mounted | yes | 1–4 |
| it is a decodable video through the mount (`ffprobe`, one interval) | yes | 1–4 |
| the resolver refused at the transport from the gate network | yes | 1–4 |
| all three real media servers catalogue both entries at the published size as ordinary files | yes, through each server's own predicate | 2–4 |
| the cold three-way concurrent scan **observed with all three servers in flight**, over a real provider with **no barrier to rendezvous at** | 25 samples, 3 servers observed scanning, 1 fully attributed three-way sample; continuous run **1 sample / 0 s, recorded against no floor** exactly as §4 predeclared | 3 |
| all three direct-play the real object | Emby **36** decoded media seconds, Jellyfin **30**, Plex **30**; startup **1.5 / 1.7 / 1.42 s** against 10,000 ms; pacing 1.00 / 0.99 / 0.995; longest stall **0 s** on all three | 3 |
| the four operator windows digest-compared through the mount | **4 matched, 0 problems**, slowest window **4,227 ms** | 3, 4 |
| the same four windows read **inside each server's own container as its own uid** | all three matched, before the fault | 4 |
| **A1** — graceful daemon restart: namespace went away and came back for a **fresh** sibling | **1,514 ms** against a 22,000 ms budget | 4 |
| **A1** — the same namespace, for the **consumers that were already attached** | **all three failed** — see §11 | 4 |
| host left as found | container/network/volume/mountpoint sets identical after every run, including the one stopped by hand once its stale mount was cleared through the repository's own helper | 1–4 |

**ARMS A2–A6 HAVE NEVER RUN.** The loop dies in cycle 1's recovery phase, so nothing in this document says
anything about SIGKILL-over-a-corpse, auto-remount, the sustained outage, credential rotation or the frontend
restart **with consumers attached**. That is five sixths of the subject and it is open.

### 8.1 Offline

Taken on the Windows development host, at the commit under test. **They are not gate evidence**; they are
what makes a run worth attempting.

| What | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run go:vet` / `go:build` / `go:test` | every package `ok`, through the pinned `golang:1.26.5-bookworm` image |
| `npx tsx test/projection-reliability-loop.ts` | **52 passed, 0 failed**, 1 block skipped and named (`win32` carries no POSIX mode) |
| `npx tsx test/custody-runtime-closure.ts` | 39/0 — every shipped `.sh` parses under LF and CRLF |
| `npx tsx test/projection-three-server-concurrency.ts` | 133/0, with the `--no-barrier` containment |
| `npx tsx test/projection-mount-hardening.ts` | 28/0 |
| `npx tsx test/projection-multi-frontend.ts` | 17/0 |
| `npx tsx test/projection-overlap-measurement-mode.ts` | 13/0 |
| `npx tsx test/projection-evidence-consistency.ts` | 4/0 |

### 8.2 The four runs, and what stopped each

| Run | Frozen tree | What it established | What stopped it |
|---|---|---|---|
| 1 | `73a5f957…` | setup, publish, mount, three servers cataloguing, decodable video | the gate warmed the window it was about to measure (§9.1 #1) |
| 2 | `af0bf074…` | the cold three-way overlap observation, with all three in flight | Emby's `paced-play` takes a flag the other two do not (§9.1 #2) |
| 3 | `af6dc324…` | **all three servers direct-played the real object**; four windows digest-matched | two results formats across three drivers (§9.1 #3) |
| 4 | `8978c64d…` | in-container reads by all three before the fault; A1 recovered a fresh sibling in 1,514 ms | **§11** — the consumers that were already attached could not read afterwards |
| 5 | `f53b8d91…` | the bind-ordering fix in place: setup, publish, three servers bound before the mount, generation 2 admitted | **§11** — every read of the operator's object now fails EIO. The provider rotated its CDN origin out of the allowlist; the independent Phase 1 TorBox gate fails identically on the same host |

A fifth attempt sat between 3 and 4 and was **stopped by hand** rather than failing: busybox's `tail` does
not seek (§9.1 #4). It left one stale mountpoint, which `projection_gate_cleanup_run` cleared; the host's
counts returned to 42 containers / 26 running / 17 networks / 45 volumes / 0 `fuse.projectiond`.

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

**SEVEN SO FAR. ALL SEVEN ARE IN THE GATE AND NONE IS IN THE PRODUCT** — and one of them is a finding
*about* the product rather than against it. Three were found by reading the arms against the closure rule;
four needed the gate to actually execute on the real host, and each was invisible until the one before it was
fixed. Every one is pinned by a test in `test/projection-reliability-loop.ts` that **fails against the commit
before its fix and passes after**, which is the only form of "fixed" this tranche accepts.

### 9.1 Found by running it on the real host

| # | What was wrong | What it cost |
|---|---|---|
| 1 | **The gate warmed the window it was about to measure.** The three per-server `scan` calls that produce the item ids playback needs are also the first thing that reads a 1.7 GB remote object through three `ffprobe`s — Plex's took 15 s. They ran *before* the loop, so cycle 1's concurrent scan observed a warm two-entry re-scan finishing between two of the observer's ticks | **4 samples, ZERO servers in flight**, and the run died on its own simultaneity assertion having destroyed the overlap it existed to create. It is the warning G18's own header gives — "the three concurrent scans are the FIRST thing that ever reads it" — rediscovered a tranche later. The scans moved into `ensure_items`, called once, after the observation; the pin checks the function, the ordering **and** that there is exactly one call site, because a second one earlier would reintroduce the defect while leaving an ordering check satisfied |
| 2 | **One helper flattened three different ways of being addressed.** It handed all three consumers `http://127.0.0.1:<published port>` — which, from inside the consumer's own container, is the consumer. And Emby's `paced-play` takes `--local-work-dir` beside `--work-dir`, which the other two do not | the run died at the first of the three with `--local-work-dir is required`, having never reached the other two. Jellyfin and Emby are reached by container name; **Plex by address, never by name**, because it answers 401 to a request whose `Host` header it does not recognise — and the address is read per call, because arm A6 restarts all three containers. The pin is the class rather than the instance: it reads each driver's **required flag set out of that driver's own source** and asserts the call supplies every one |
| 3 | **Two results formats across three drivers.** Jellyfin's and Emby's `appendResult` rewrite a JSON array; Plex's appends one JSON object per line. `playfigures.cjs` knew one shape and threw on the other | it printed nothing, and `record.cjs` then did exactly the right thing with an absent measurement and **failed the verdict for a play that had succeeded** — 1.42 s to first frame, 30 decoded media seconds, pacing 0.995, zero stalls. Both shapes are read now, and the pin uses all three drivers' real id spellings so a rename fails offline |
| 4 | **`tail -c +N` does not seek in busybox, and Emby's image ships busybox.** The operator records windows in **descending** order — so that every fetch after the first is a genuinely backward-going ranged GET — so the first in-container read was at offset 1,576,983,267 of a 1,732,948,646-byte object, and busybox read and discarded every byte before it | the run wedged for seven minutes and was stopped by hand. The daemon's own counters at that moment: **4.4 TB of cache-served reads across 1,048,208 playback-cache hits, against 261 provider misses and ~147 MB actually fetched.** **THE PRODUCT WAS FINE** — the playback cache absorbed exactly what it exists to absorb and the provider cost stayed bounded; the gate was what was wrong. It is `dd` with a byte-granular skip now, the capability is **probed before it is trusted**, a short read is named as a short read rather than reported as a wrong digest, and the call site is bounded at two read deadlines |

### 9.2 Found by reading the arms against the closure rule

| # | What was wrong | What it cost |
|---|---|---|
| 5 | **Three arms never took the measurement the closure rule requires of them.** `RL-R-ready-ms` is required once per cycle, and A4, A5 and A6 never set `RECOVERY_MS` | cycles 4, 5 and 6 would have recorded the **previous cycle's** recovery time, against the right budget, and passed. It starts **empty** at every cycle now — empty rather than `-1`, because `record.cjs` fails a measurement that is not a number while `-1 <= 22000` is perfectly true — and each of the three takes its own |
| 6 | **The recovery clock measured the gate's own orchestration.** It started before `restart_daemon`, so it timed `docker rm -f`, a `docker run` and a node container booting `tsx` to serve the resolver — against a budget derived from the **daemon's** pointer poll and read deadline | the clock is read inside `start_daemon` now. And A6, where the daemon never moves, no longer times three media servers booting against a daemon-readiness budget: how long they took is recorded against **no budget at all**, which is the honest shape for somebody else's software starting up |
| 7 | **The arm that measures an open breaker could outlive it.** A4's hold was twelve reads five seconds apart — sixty seconds against a sixty-second cooldown | the breaker closes on its own after the cooldown and admits exactly one half-open probe, so the window measuring *zero requests while the breaker is open* could have counted that probe: **one legitimate request against a ceiling of zero, failing a correct product for doing precisely what the contract says it must.** The window is `HOLD_WINDOW_MS`, half the cooldown, and the fraction rather than the number is the point — it stays inside if the cooldown ever changes |

**AND THE GATE'S OWN CONSTRUCTION COST FOUR MORE, ALL CAUGHT OFFLINE BY THE PINS BEFORE ANY HOST SAW THEM:**
two NUL bytes an em-dash pass left in a shell script; three multi-line `node -e` arguments that made the whole
file unparseable to `test/custody-runtime-closure.ts` — which is the Phase 2 bake-off's own closing finding,
reproduced by this tranche a dispatch later; a `mkdir`-parent pin that could not see past a backslash
continuation, which is that same document's defect #7 *inside the pin written to catch defect #7*; and a
verdict log written into the directory the cleanup contract deletes, so the closure check would have judged a
document four ids short of what it requires.

**NO THRESHOLD MOVED AND NO PRODUCT CODE CHANGED.** `test/projection-reliability-loop.ts` asserts the second
half directly: every Phase 1 and Phase 2 constant this tranche touches is checked against its own value, so a
budget cannot be loosened to make a run pass without a test failing.

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

---

## 11. THE BLOCKER: THE PROVIDER HAS ROTATED ITS CDN ORIGIN, AND ONLY THE OPERATOR CAN SAY SO

**THE LOOP CANNOT REACH A BYTE OF THE OPERATOR'S OBJECT RIGHT NOW, AND THE PRODUCT IS THE REASON — WORKING
CORRECTLY.**

Run 5 stopped at the decodable-video check. The diagnosis is not this gate's alone: the **independent**
`deploy/projection-torbox-real-gate.sh`, which closed Phase 1 and which this tranche did not touch, fails
the same way on the same host today.

| What | Observed |
|---|---|
| `stat` through the mount | **an ordinary regular file at exactly 1,732,948,646 bytes** — the namespace is fine |
| the resolver | **resolved a torrent reference in 1 attempt**, five times, HTTP **200**, over **https** |
| every read | **EIO**, in **0, 168, 299, 350, 432 and 1,271 ms** |

Reads that fail in **under a third of a second, after a successful resolution**, have not contacted
anything. That is the daemon refusing a resolved URL locally, which it does for exactly one reason.

**CONFIRMED DIRECTLY, WITHOUT PRINTING ANYTHING THAT MUST NOT BE PRINTED.** One resolution was taken through
the operator's own resolver and compared, *inside the container that already holds the credential*, against
the operator's `allowedOrigins`. Only these words came out:

```
resolver-status=200          resolved=yes                 resolved-origin-scheme=https
allowed-origin-count=2       resolved-origin-in-allowlist=NO
resolved-origin-digest=d4064d307d25
allowlisted-origin-digest=256c61b89300   allowlisted-origin-digest=b16331429dc1
```

The resolved origin matches neither allowlisted origin. **TorBox has rotated the CDN origin it hands back,
and `endpoint.json` no longer names it.** No URL, host, reference or secret was printed, written or placed
in argv; the comparison happened where those values already live and a boolean came out.

### 11.1 This is the allowlist doing its job, and it has happened before

`PROJECTIOND_ACCESS_RESOLUTION.RESOLVED_URL_HOST_MUST_BE_IN_ENDPOINT_ALLOWLIST` is the rule, and
`access-url-outside-endpoint-allowlist` is **terminal** and **counts toward the breaker** — a resolved URL is
provider-supplied data, and following one to a host nobody configured is the redirect-to-an-attacker case.
`docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6.16 records the identical event during Phase 1 and documents
`allowedOrigins` as **perishable** for this reason. **This is the second observation of it against a real
provider, and the first with three media servers attached.** Nothing here is a product defect.

### 11.2 Why this gate will not fix it

Refreshing the allowlist means **writing to `endpoint.json` under the operator's 0600 secrets directory** —
an operator-supplied input this tranche reads and has never written. It is the authority boundary this work
was told to stop at, and it is a boundary worth keeping: the allowlist is the one control standing between a
provider-supplied URL and the daemon's egress, and a harness that edited it to make its own run pass would
be removing the check it exists to exercise.

**What an operator does:** take the origin the resolver now returns and add it to `allowedOrigins` in
`endpoint.json`, keeping the file at `0600`. Nothing else changes; every threshold and every arm stays as
predeclared, and the loop resumes at run 6.

### 11.3 What is NOT blocked by it

Everything that does not need a provider byte. The gate's own construction, the eight defects in §9, the
closure logic, the bind ordering that §12 records, and every offline suite are unaffected and green. The
figures in §8 were taken **before** the rotation and remain what they were: three real media servers
direct-playing this object through the production mount, four operator windows digest-matched through the
mount and inside each server's own container, and a three-way concurrent scan observed with all three in
flight.

### 11.4 Re-observed on 2026-08-10, and the origin had rotated AGAIN

The fix in §13.7 was frozen and the loop restarted. It stopped in the same place, on the same check, and the
recheck was run again — same script, same redaction boundary, one boolean out:

```
observedAtUnixMs=1786348429994        resolverStatus=200        resolved=yes
allowedOriginCount=2                  resolvedOriginScheme=https
allowedOriginDigests=256c61b89300     allowedOriginDigests=b16331429dc1
resolvedOriginDigest=4b416e9283c3     resolvedOriginInAllowlist=NO      verdict=disallowed
```

**The two allowlisted origins are unchanged. The resolved origin is not the one seen before** —
`4b416e9283c3` now, `d4064d307d25` at the first observation. The provider has rotated its CDN origin **a
second time, between two observations of the same blocker**.

That changes what an operator is being asked for, so it is recorded rather than left implicit: adding the
single origin observed at some moment may not hold, because this provider appears to rotate faster than a
one-time allowlist edit survives. **The decision is the operator's** — refresh `allowedOrigins` and accept
that the loop must start promptly afterwards, or widen the entry to whatever stable form the provider
publishes. This tranche will not write that file either way, for the reason in §11.2.

**Everything that does not need a provider byte was completed while blocked**, and it is in §13.7–§13.9: the
mechanism proven by reading the dependency, the fix, the host regression for it, and the Phase 2 tranche
re-run three consecutive times against the frozen image.

## 12. CONSUMER ATTACHMENT — a contract now, demonstrated on all three real servers

**THE FACT.** A consumer that attaches to the projected path **after** `projectiond` has mounted there
cannot follow a remount, and no daemon behaviour can make it. A bind taken while the path is a **plain
directory** is a slave of the **parent's** peer group, so every later mount at that path propagates in; a
bind taken **over an existing mount** is a slave of that mount's peer group only, and once it is gone the
next mount belongs to a group the container never joined.

**A SIGKILL RESTART IS THE EXCEPTION, AND IT IS WHY THIS WENT UNSEEN FOR THREE TRANCHES.** A SIGKILL
unmounts nothing, so the restart **stacks** inside the peer group the consumer did join. That is the only
recovery path Phase 1's G12 exercises, which is why every data-plane gate has always passed while binding
the mountpoint directly — and why the two paths that *remove* the mount went unexamined until Phase 3 ran
them with consumers attached.

### 12.1 It is a shipped contract, not a fact about one gate

`PROJECTIOND_CONSUMER_ATTACHMENT` in `src/core/projection/runtime-contract.ts` and **§11 of
`docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md`** carry it: bind **before** the first mount, bind the
**mountpoint itself** with `rslave`, a late binder survives a SIGKILL restart and survives **neither** a
graceful restart nor an external unmount, and `REPAIRABLE_BY_THE_DAEMON` is **false**.
`test/projection-reliability-loop.ts` pins every one of those, pins that the two survival lists stay
disjoint, and pins the gate's own call **order** — because the remedy is an order, and only an order can
express it.

### 12.2 THE PARENT-BIND REMEDY IS SUPERSEDED, AND BY WHAT

The first reading of the evidence was that consumers must bind the **parent** of the mountpoint. That would
also work, and it is strictly more disruptive: it changes the topology behind **every Phase 1 data-plane
result**, none of which were taken on it.

A controlled experiment then isolated the actual variable. **Two consumers, identical in every respect —
same source, same target, same `rslave` — differing only in when they attached.** Only the late one failed.
The bind spelling never needed to change; only its order did. The contract therefore requires the **order**
and leaves the topology alone, and this paragraph exists so the narrower remedy is recorded as *superseding*
the first one rather than quietly replacing it.

### 12.3 Demonstrated with all three real consumers, and with a control that must fail

`deploy/projection-consumer-attachment-check.sh` (`npm run go:consumer-attachment-check`) runs both sides of
§11 on **real, digest-pinned Plex, Jellyfin and Emby**, with **no provider, no operator corpus and no
credential** — the daemon's configuration names no endpoint at all, so there is nothing it could contact.

**Why the control is not optional.** Without it, "all three still read" is satisfied by a run in which the
mount never went away — the shape this repository keeps finding, where a step reports a result the product
was never consulted for. So a **fourth** consumer takes a byte-for-byte identical bind *after* the mount
exists, and the check **requires it to fail both faults**.

| Gate id | What it holds |
|---|---|
| `AC1` / `AC2` | all three, and the control, read **before** any fault — or nothing below means anything |
| `AC3` | all three read after a **graceful daemon stop and restart** |
| `AC4` | the control **cannot** — so AC3 had a subject |
| `AC5` | all three read after an **external `umount`** under a living daemon with `--auto-remount` |
| `AC6` | the control **cannot** — so AC5 had a subject |
| `AC7` / `AC8` | this run's own mountpoints and directory **asserted** gone, not reported |

**Run record — Unraid `tower`, THREE consecutive fresh runs, 8 checks and 0 failed in each, on the
frozen tree in §8.2’s last row.** Three because one green run is a coincidence, which is this repository’s
rule for everything else and has no reason to be relaxed for a demonstration. The reads are
taken **inside each server's own container as uid 1000** and are **bytes**, not metadata: a dead FUSE mount
can still answer `stat` from a warm attribute cache while `open` returns `ENOTCONN`, so a `test -f` here
would pass over the exact state the check exists to detect.

**What it does not show.** It contacts no provider, closes no G-number, and is not a Phase 3 acceptance run.
It says nothing about playback, amplification or any budget. It exists so §11 is executable rather than
written down — and so the ordering remedy is a demonstrated property of the product's deployment contract
rather than a habit of one gate.

---

## 13. THE PRODUCT DEFECT PHASE 3 EXISTS TO FIND

**`--auto-remount` CANNOT RECOVER AN ABORTED CONNECTION WHILE A CONSUMER HOLDS THE MOUNT.** Arm A3, run on
the real host with the three real media servers attached, in the daemon's own words:

```
projectiond: serve loop died: the FUSE serve loop exited without a requested unmount
projectiond: remount attempt 1/3
projectiond: remount refused: transport endpoint is not connected
```

All three attempts are refused, the namespace never returns, and **all three media servers lose the library**
— `RL-F-A3-remounted-in-place`, `RL-F-A3-frontends-read-after-remount` and the phase-R byte reads all fail.

### 13.1 The mechanism, and it is an asymmetry inside the daemon

`remountLoop` probes the mountpoint, and when what it finds is **ours** it calls `(*mount).Unmount()` before
mounting again. **With a consumer holding the mount, that unmount fails** — the mountpoint is busy — so the
dead mount stays, and the plain `fusefs.Mount` that follows is refused with `ENOTCONN`.

**THE STARTUP PATH ALREADY SOLVES EXACTLY THIS AND THE REMOUNT PATH DOES NOT USE IT.** At startup, a stale
`projectiond` mount is handled by *stacking over it* — `main.go` logs `stale projectiond mount detected` and
`stacking over the stale mount (default)`. That is the same object in the same state, and the daemon knows
what to do with it. `remountLoop` instead insists on clearing it first, which is possible only when nobody
is holding it.

> **CORRECTION, from §13.6.** The second paragraph above is wrong about *why*, and the error is worth keeping
> rather than deleting because it cost two fix attempts. Startup and remount call the same `fusefs.Mount`;
> there is no asymmetry in the code. The asymmetry is in **the age of the corpse**: a startup lands seconds
> after the death and a remount lands minutes after it, and the mount syscall's dependence on the corpse
> expires in between. The first paragraph — the cleanup unmount failing against a held mount — was a real
> defect and was fixed; it was simply not the one that kept A3 failing.

### 13.2 Why no tranche before this one could see it

- **Phase 2's serve-death gate passes** because its only other participant is a poller that holds no
  reference: `Unmount()` succeeds there, so the remount succeeds.
- **A one-consumer isolation run passes too** — measured here: `serve loop died` → `remount attempt 1/3` →
  `remounted; serving generation 1`, readyz ready, the consumer still reading.
- **It needs a consumer with an OPEN reference**, which is what a media server has and what only Phase 3
  attaches while injecting a fault.

It is the same shape as Phase 2's headline defect one level deeper. That one was *recovered for the daemon
and for nobody else*; this one is **does not recover at all, once anybody is actually using it**.

### 13.3 What is NOT in doubt

The fault is real and injected: `abort:done 1` against the connection the daemon was serving, guarded to
`fuse.projectiond` mounts under this run's own directory. The death is real and the daemon saw it. Arms
**A1 and A2 pass completely** in the same runs — graceful restart and SIGKILL-over-a-corpse both recover with
all three servers reading afterwards, zero churn, and recovery in ~1.5 s against a 22,000 ms budget. The
difference is not the consumers being attached; it is *this recovery path* with them attached.

### 13.4 The decision it needs

The apparent minimal fix is in `projectiond`: when the cleanup unmount is refused and what is at the
mountpoint is our own dead mount, **stack over it, exactly as the startup probe already does**, rather than
failing the attempt. That is a product change on a path **Phase 2 closed on**, so it implies re-running the
three Phase 2 mount-hardening gates to show nothing regressed. Making that change and re-validating another
tranche's closed evidence is not a call this document takes on its own.

### 13.5 The fix attempts, and the state this leaves

**THREE DAEMON REVISIONS, EACH RE-VALIDATED AGAINST ALL THREE PHASE 2 MOUNT-HARDENING GATES, AND A3 STILL
DOES NOT PASS.** Recorded in order, because two of the three were wrong and one was actively harmful.

| # | Change | Result |
|---|---|---|
| 1 | our own **stale** mount is cleared with a **lazy detach** rather than an ordinary unmount, which cannot remove a mount a consumer holds | the detach fired; the remount was still refused `ENOTCONN` — there was another corpse underneath |
| 2 | the cleanup **drains**, detaching while the probe still calls the mount ours | **actively harmful.** It removed the operator's **bind**: `detached 2 stale mount(s) … (now empty)`, a remount into a namespace with no host peer, `/readyz` ready, and all three servers reading nothing — the defect `--auto-remount` was repaired for once already, reached from the other direction |
| 3 | the drain decides on **identity** (top-of-stack fstype) and never goes below the **mount count taken before this process mounted anything** | safe again, and A3 still fails: the bind at a projection mount point is commonly a bind **of a projectiond mount**, so it matches by type, and the count is what stops the drain rather than anything about the mount itself |

**WHY #2 IS THE IMPORTANT ROW.** All nine Phase 2 runs passed while it was shipped, and could not have caught
it: **not one Phase 2 gate has a consumer attached.** The check that caught it is `RL-F-A3`'s
frontends-read-after-remount, and only because it had just been changed from `test -r` to a real
approved-window digest read — the metadata form had been reporting *2 of 3 readable* over a namespace that
was gone. That is Phase 3 doing exactly what it was built for, on its own author.

**WHAT IS NOT YET UNDERSTOOD, STATED AS A GAP RATHER THAN A THEORY.** An isolation run that reproduces the
precondition — a host-side corpse, a second daemon whose bind is therefore a bind *of* that corpse, a
consumer attached first, then an abort of the topmost connection — **did not reproduce the failure**: the
consumer kept reading and the daemon logged no serve death at all. So the conditions under which A3 fails
are not yet reproducible outside the full loop, and **no further daemon change should be made until they
are.** Three speculative edits to a recovery path is already one more than the evidence supported.

### 13.6 The mechanism, read rather than guessed

The rule at the end of §13.5 was kept: the next step was not a fourth edit but **one instrumented run of the
real gate**, using A3's own injection and topology. It produced the two facts that closed the question.

**FACT ONE — the drain is correct and the floor it stops at is a corpse.** Before the abort the mount point
carried two mounts in every namespace: a floor (`dev 0:351`) and the live mount on top of it (`dev 0:361`),
with each consumer additionally holding its own bind. The abort chose the served connection
(`abort:choice majmin=0:361 minor=361`, `abort:done 1`), the serve death was observed, and the drain removed
**exactly one** layer and stopped: `floor 1, now 2, on top fuse.projectiond` → `detached 1 … (now on top: the
startup floor (1 at the floor, 1 now))`. The operator's bind was preserved, which is what #3 was for. And
then: `remount refused: transport endpoint is not connected`.

So the floor is simultaneously **the propagation anchor** and **one of our own dead mounts** — in a container
the mount point IS the operator's bind, and a bind of a path a previous daemon mounted carries that daemon's
dead superblock. It cannot be removed: a mount's propagation comes from its **parent**, and with the anchor
gone the next mount's parent is the container's own root, in a peer group with no host peer. That is #2's
failure, measured.

**FACT TWO — the mount syscall asks the corpse a question, and the answer expires after 60 seconds.** From
go-fuse v2.10.1, `fuse/mount_linux.go`, inside `mountDirect`:

```go
fd, err = syscall.Open("/dev/fuse", os.O_RDWR, 0)   // line 32
...
var st syscall.Stat_t
err = syscall.Stat(mountPoint, &st)                 // line 49
if err != nil { return }
```

The whole use of that stat is `rootmode=%o` from `st.Mode & S_IFMT`, and under `DirectMountStrict` its error
is returned unchanged as the mount error. **`stat` on the root of a FUSE mount is answered from the kernel's
attribute cache while the cache is warm and reaches the connection once it is not** — and this daemon sets
`attrTimeout = 60 * time.Second`. So:

| when the mount over a corpse happens | attribute cache | result |
|---|---|---|
| A2's restart, seconds after the SIGKILL | warm | `stat` answers, the daemon stacks over the corpse, **passes** |
| A3's remount, minutes into a cycle | expired | `stat` gets `ENOTCONN`, every attempt refused, **never recovers** |

That is the entire asymmetry of §13.1, and it is not in this repository's code. It also makes the defect
much larger than A3: **any daemon that has ever restarted over a corpse loses `--auto-remount` permanently
after about a minute** — the arm merely happens to be the thing that waits long enough to notice.

### 13.7 The fix: mount over the anchor without asking it anything

Nothing in the mount syscall needs the corpse to answer. Attaching a mount resolves the path through the
dentry cache and never issues a `getattr`; go-fuse asks only to fill in `rootmode`, and **the mount point of
this daemon is a directory by contract** — a mount point that were not one could not have been mounted over
in the first place. So `fusefs` supplies `rootmode=S_IFDIR` from what is already known, performs the mount
itself, and hands go-fuse the resulting connection through its documented `/dev/fd/N` mount point
(`projectiond/internal/fusefs/selfmount_linux.go`).

Four things about it are load-bearing, and each is pinned:

- **The probe comes first.** `Mount` decides with `ProbeMountpoint` *before* calling `fuse.NewServer`. Only
  our own stale mount is ever mounted over by hand; foreign, live, empty and unrecognised mount exactly as
  they always have, which is what keeps a hand-rolled mount from ever pointing at somebody else's file
  system.
- **...and that order is also a leak fix.** `mountDirect` opens `/dev/fuse` at line 32, *then* fails the stat
  at line 49, and returns the open descriptor alongside the error; `mount` drops it without closing. (Its
  `syscall.Mount` failure path does close it — only this one does not.) Asking go-fuse first and falling back
  afterwards would leak one descriptor per recovery attempt for the life of the process. The doomed call is
  never made instead.
- **`Server.Unmount` cannot be used on a `/dev/fd/N` mount point** — it returns *Cannot unmount magic
  mountpoint* and detaches nothing, so a graceful stop would report success and leave the mount standing.
  `Mounted` keeps the real path and unmounts by syscall.
- **`Server.WaitMount` skips its poll hack** for the same reason, so `Mount` forces the INIT handshake itself
  with one `statfs` before returning. Handing back a mount whose INIT has not landed is the production hang
  the `Mounted` type exists to make unrepresentable.

`max_read` is deliberately **not** sent. go-fuse sends `max_read=MaxWrite` from a value `NewServer` fills in
from the kernel's own limit, which this process would have to guess before `NewServer` runs; a wrong guess
caps every read at whatever the guess was, and no assertion anywhere would fail. Omitted, the kernel's
default applies and the read size is negotiated in INIT, where go-fuse negotiates it anyway.

**The detach cap was made a stopping reason too.** Reaching `maxDetach` left the drain's `stoppedAt` at its
initial `"nothing"`, so a supervisor that had removed eight layers and was **still** above the floor logged
the same sentence as one that had tidied up completely. It now names the cap. It is reported rather than
treated as fatal, because stacking over residual layers *works* — it is what the daemon does at startup over
every corpse it inherits — and refusing to remount would turn a state the product recovers from into an
outage.

**Prior-state coverage.** Both new offline pins fail against `894b36f`, the immediately preceding product
state, and pass after: *THE CORPSE DRAIN FAILS CLOSED* on the cap (`running out of detaches is not
distinguished from a clean drain`) and *THE REMOUNT ASKS THE MOUNT POINT NOTHING* on the absent file. The Go
suite adds a table over the mount data — root mode, `allow_other`, `default_permissions`, the three options
the kernel takes as flags and rejects as data, and the omission of `max_read` — because a mount with the
wrong option string does not refuse, it succeeds and behaves differently.
