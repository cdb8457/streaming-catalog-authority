# Projection Phase 1 — the executable acceptance plan

**What Phase 1 is.** One vertical slice: a manifest produced by the control plane, admitted by `projectiond`,
mounted over FUSE, and scanned and played by Plex, Jellyfin and Emby. It is the whole product working end to
end, thinly. It is not a subsystem, not an evidence packet, and not a review gate.

**What "passing" means.** Every hard gate in §3, §4 and §5 holds, on the platform §6 says it must hold on, on
**three consecutive runs**. One green run is a coincidence.

**The budgets are code.** `PROJECTION_PHASE_1_BUDGETS` in `src/core/projection/runtime-contract.ts`. The
harness imports them; it does not restate them.

---

## 1. Scope of the slice

- Two source adapters, **shipped in the same tranche**: **local passthrough** and **HTTP Range**. Neither
  ships alone. A local-only daemon proves nothing about the design, and a remote-only one cannot be compared
  against a known-correct baseline.
- One FUSE mount, read-only, exposing a namespace derived from one admitted generation.
- The control plane produces manifests through the Phase 0 contract and publishes them atomically.
- No operator UI surface, no scheduler, no metrics backend, no packaging. Those are not Phase 1.

## 2. The corpora

| Corpus | Size | Purpose |
|---|---|---|
| **Local** | 10 real files on disk, 3 of them > 3 MiB so the full probe plan applies | The known-correct baseline. Anything the remote path does differently is a defect until proved otherwise. |
| **Fake remote** | ~50 entries served by an in-harness HTTP Range server | Amplification, concurrency, re-scan and duplicate-probe measurement. Deterministic, offline, and the only corpus a CI job runs against. The server has **two modes**: direct reads against a stable `objectRef`, and an **expiring-lease** mode where the reference must first be resolved into a short-lived access URL that starts answering `401`/`410` once it lapses. |
| **Real provider** | **1–3 files the operator is legally entitled to**, supplied by the operator | Correctness of the real transport: real TLS, real redirects refused, real `Content-Range`, real `429` behaviour. Never in CI. Never a load test. |

The real-provider corpus is deliberately tiny. It exists to answer "does the HTTP Range adapter work against
a real endpoint", which is a **correctness** question and needs three files. Every **quantitative** question
is answered against the fake corpus, where the harness controls the answers and can assert on them.

## 3. Hard gates — namespace and metadata

| # | Gate | Passes when |
|---|---|---|
| G1 | **Manifest admission** | The three shipped generations admit; every one of the 28 adversarial fixtures is refused with its named problem; a refusal leaves the previously admitted generation serving. (`npm run test:projection-manifest-v1`) |
| G2 | **Metadata is local** | A full scan of the ~50-entry fake remote corpus issues **zero** database queries and **zero** provider requests for `getattr`, `lookup`, `readdir` and `statfs`. Counted at the harness's fake server and at the daemon's own counters. |
| G3 | **Stable metadata** | Across two scans, a generation swap, a source failover, an access-lease refresh and a daemon restart, every entry's `inode`, `sizeBytes` and `mtime` are byte-identical. Asserted per entry, not in aggregate. |
| G4 | **Degraded is present, not absent** | Marking 10 entries `degraded` keeps all 10 visible with unchanged `inode`/`size`/`mtime`; each read fails **EIO** in under 50 ms; the fake provider records **zero** requests for them. |
| G5 | **Retiring is readable** | A retiring entry reads normally. Its grace deadline passing changes nothing. It disappears only when an explicit deletion generation names it. |
| G6 | **Outage is not deletion** | Kill PostgreSQL. The namespace is unchanged for 30 minutes, reads keep working, and the media servers report **zero** removed items. Then publish an empty generation: it is **refused**, and the namespace is still unchanged. |

## 4. Hard gates — media servers

Run against **Plex, Jellyfin and Emby**, each with the mount as a library root.

| # | Gate | Passes when |
|---|---|---|
| G7 | **Scan** | Each server completes a full library scan of the ~50-entry corpus and matches every item. |
| G8 | **Play** | Direct play starts within 10 s and runs 5 minutes without a stall on each server. |
| G9 | **Seek** | Ten seeks, including backwards and to > 90 % of duration, each producing playable video within 10 s. |
| G10 | **Transcode** | A forced transcode runs 5 minutes on each server. This is the gate that generates non-sequential, multi-position reads, so it is the one that exercises read-ahead cancellation. |
| G11 | **Generation swap mid-read** | A generation is admitted while a playback is in flight. The playback does not stutter, does not error, and finishes bound to the generation it opened against. |
| G12 | **Kill and recover** | `SIGKILL` the daemon during playback, restart it, remount. The library shows **zero** added and **zero** removed items on the next scan across all three servers. Playback is expected to fail and be resumable; the library is not. |
| G13 | **Re-scan churn** | A second full scan, with no manifest change, adds and removes **zero** items on all three servers. |
| G24 | **A lease expires mid-read, and nothing notices** | Against the fake endpoint's expiring-lease mode, with a lease deliberately shorter than the read: a generation-pinned read is in flight when the access lease lapses; the daemon re-resolves the stable reference **once**; the read continues and completes with correct bytes; and `projectedEntryId`, `generationId`, `sourceId`, `sourceGeneration`, `inode`, `sizeBytes` and `mtime` are unchanged before and after. **No new manifest generation is published**, and the media server is told nothing. |
| G25 | **A lease expiry does not stampede the resolver** | Twenty concurrent opens of the same entry meet the same expired lease. Resolution requests observed at the fake endpoint: **exactly one**. A twenty-first open inside the cooldown, after a *failed* resolution, produces **zero** further resolution requests and an **EIO**, and the namespace is unchanged. |
| G26 | **A refreshed response is held to every rule the first one was** | The fake endpoint, after a refresh, answers with a mismatched `Content-Range`, then a short body, then a total size disagreeing with the manifest, then a `200` full body. Each is failed exactly as an un-refreshed response would be; bytes accepted from any of them: **0**. A resolved URL whose host is outside the endpoint allowlist is **not contacted at all**. |
| G27 | **A path is immutable, and a corrected path is a delete and an add** | A successor that moves a carried entry's path is **refused** by admission and the namespace does not change. The retire → grace → delete → add sequence is then run end to end; all three servers show the removal and the addition. Whether a server preserves watch state across that pair is **recorded, not asserted** — this plan does not claim it. |

## 5. Hard gates — amplification

Measured at the harness's fake HTTP Range server during one full **synthetic scan** of the ~50-entry corpus.
A synthetic scan opens every entry and reads a small window at each of the three fixed probe offsets of the
contract's own probe plan. It is not a real media server's metadata pass, and none of these numbers is
evidence about one; see G7 and the environment table for where that is proved instead.

**EVERY MULTIPLIER NAMES ITS DENOMINATOR.** "1.2x" of an unnamed quantity is not a budget. An earlier draft
said "provider requests ≤ 1.2x the entry count", which was arithmetically unreachable against an
implementation that necessarily makes one ranged request per scan window — three per entry — so the gate
could never have passed however well the daemon behaved.

| # | Gate | Budget |
|---|---|---|
| G14a | **Range-request multiplier** | Ranged GETs against the object endpoint **≤ 1.2x** (entry count x scan windows per entry). With three windows and 50 entries: **≤ 180**. |
| G14b | **Resolution-request multiplier** | Access-resolution requests **≤ 1.2x** the entry count. With 50 entries: **≤ 60**. |
| G15 | **Byte multiplier** | Provider bytes **≤ 1.2x** (probe window x scan windows per entry x entry count). Measured on **both** byte columns the endpoint reports — see §5.1. |
| G16 | **Rate limiting** | HTTP **429** responses observed: **0**. Not "few". Zero — a 429 means the admission limits did not hold. |
| G17 | **Connection cap** | Concurrent provider connections never exceed the configured per-endpoint cap, sampled at the server on every accept. |
| G18 | **High-concurrency scan** | All three servers scanning simultaneously: G14a–G17 still hold, unchanged. |
| G19 | **Re-scan** | A second synthetic scan with an unchanged manifest issues **zero** ranged GETs and **zero** resolutions — the persistent scan-window cache already holds every byte such a scan reads, at all three windows, and survives a daemon restart. |
| G20 | **Duplicate probe / single-flight** | Twenty concurrent opens of the same entry, each reading the same first chunk, produce **exactly one** provider request. |
| G21 | **Range discipline** | A fake server that answers a ranged request with a full-body `200` causes the source to fail immediately; bytes read from that response: **0**. A server that returns a short body, a mismatched `Content-Range`, or a total size disagreeing with the manifest is likewise failed. |
| G22 | **Comparison control** | The same corpus behind an rclone/WebDAV mount, measured the same way. This is **evidence, not architecture**: it exists to record what the naive approach costs. It has no pass threshold. A gate now exists — `deploy/projection-rclone-comparison-gate.sh`, described in `docs/PROJECTION_PHASE_1_RCLONE_COMPARISON.md` — and **a gate existing is not a gate run**: §6.1 below is the authority on that. What it holds to a threshold is the **instrumentation** (the mount works, the corpus is exact, the telemetry is coherent and fully attributed, the window is cold, nothing leaks); **no cost figure it produces is compared against anything**, because an expensive number here is the finding. |

**What G14a–G21 measure, and what they deliberately do not.** These budgets are the **daemon's** traffic while
a library is scanned and played. They do **not** include the traffic the **control plane** spends computing
byte-identity probes when it produces a manifest — up to three probe windows per projected version, once,
at production time, and zero thereafter for an unchanged version. That cost belongs to manifest production
and is measured separately in G23; folding it into the scan budget would make a one-off look like a per-scan
cost and would hide a real regression in the scan path.

### 5.1 Where `MAX_SCAN_BYTE_FRACTION` is asserted, and why it is not asserted everywhere

**THE FRACTION IS UNCHANGED AT 0.5. WHAT CHANGED IS WHERE IT IS ASSERTED, AND THE FIRST UNRAID RUN IS WHY.**

The media-server gates held a scan to `MAX_SCAN_BYTE_FRACTION` of the remote bytes above the contract's
single-probe threshold, pooled over the corpus. On Unraid that ceiling came out at **4,297,137** over an
**8,594,275**-byte object, and the daemon's scan of that object costs one of exactly two legitimate values:

| Read pattern | Bytes |
|---|---|
| 1 probe window (1,048,576) + one EOF-clipped demand block (2,724,273) | **3,772,849** |
| 2 probe windows (2,097,152) + the same clipped block | **4,821,425** |

They differ by one probe window, both are inside the contract's own probe plan, and **the ceiling sat between
them** — so a correct daemon passed or failed by luck. Docker Desktop happened to produce the smaller
pattern; Unraid produced both. That is the "arithmetically unreachable budget" this section already warns
about, and it had reached the most load-bearing number in the tranche.

**A FRACTION BELOW 1.0 IS UNREACHABLE ON A SMALL OBJECT BY CONSTRUCTION.** The daemon serves a 4 MiB demand
block for a one-byte read, so identifying a small object costs a whole block whatever the daemon does.
Fitting the ceiling to what had been measured would have been a record of an observation with room around it
— a move this repository has already rejected twice, as a `3.0` multiplier and as a size clamp the next run
exceeded.

So the budget is now **two bounds, asserted per object, against the object's own length**:

| Bound | Applies to | What it is |
|---|---|---|
| **Block geometry** | every object | `BLOCK x min(4 MiB, size) + SMALL x min(1 MiB, size)` — the daemon's own demand block and probe window, at the per-class caps measured across every instrumented scan window this repository has. Not one number in it is chosen. |
| **`MAX_SCAN_BYTE_FRACTION` = 0.5** | objects **≥ 94 MiB** | the product's whole argument, unchanged. 94 MiB is computed, not picked: it is the smallest whole MiB at which the maximum legitimate geometry sits comfortably below half the object **and** a whole-object read clearly breaches it. |

**BOTH ARE ASSERTED WHERE BOTH APPLY, AND NEITHER REPLACES THE OTHER.** On a 94 MiB object the geometry
(36,700,160) is the *tighter* of the two and the fraction (49,283,072) the looser, so asserting only the
fraction there would be **weaker** than what came before. They bound different things: the geometry bounds the
mechanism, the fraction bounds the outcome.

**PER OBJECT, NOT POOLED, BECAUSE A TOTAL IS WHERE A RUNAWAY OBJECT HIDES.** A corpus total under a shared
ceiling is perfectly consistent with one object downloaded in full and thirty-eight barely touched. The
aggregate is kept beside the per-object verdicts — it catches bytes served for a reference the gate never
registered, which attribution cannot — but the **binding** verdicts name their object.

**AND THE CORPUS MUST CONTAIN AN OBJECT BIG ENOUGH TO CARRY THE CLAIM.** Every assertion above is satisfied by
a corpus of tiny files, with the fraction simply not asserted on anything and no verdict saying so. So the
gates assert that at least one fraction-bearing object was present: **shrinking or re-ordering the corpus
cannot silently retire the product's central budget.**

### 5.2 The two byte columns, and what the observed one does and does not mean

The fake endpoint reports **committed** bytes — the payload length it undertook to serve, counted before the
write — and **observed** bytes, **the count the handler's own `http.ResponseWriter.Write` RETURNED, and
nothing else**. `MAX_SCAN_BYTE_FRACTION` and the geometry
are asserted on **both**.

**THE OBSERVED COLUMN IS AN APPLICATION-WRITE OBSERVATION AND NOTHING STRONGER.** It is **not** peer receipt,
**not** a TCP acknowledgement, **not** exact wire bytes and **not** provider billing. The word "delivery" is
avoided for that reason.

**COMMITTED IS NOT EVEN THAT.** A demand block the daemon abandons part-way — its read-ahead cancellation
working exactly as G10 exercises it — is counted in the committed column in full and never written. The first
Unraid run failed a budget on 63,586 bytes that were never written, on a window that had been served 981,074
bytes *under* the ceiling. So committed is asserted at the budget plus **only the abandonment its own
truncated bodies justify**, and that allowance is bounded twice: one demand block per abandoned body, and no
more abandoned bodies than the window served ranged requests. A window that abandoned nothing is held to
exactly the budget, unchanged.

| # | Gate | Budget |
|---|---|---|
| G23 | **Manifest production cost** | Producing a generation over the ~50-entry corpus reads at most three probe windows per **newly seen** projected version and **zero** bytes for a version carried unchanged from the predecessor. Re-producing an unchanged generation reads **zero** provider bytes. |

## 6. Where each gate can be proved

| Environment | Can close | Cannot close |
|---|---|---|
| **Windows / Docker Desktop, developer machine** | G1. The manifest contract, path normalization, inode derivation, admission, succession and the adversarial corpus — all pure, all offline. Go unit tests for the Range client against a fake server. | Everything involving a mount. No FUSE, no mount propagation, no media server, no page cache, no inode observed by a scanner. |
| **Linux CI (GitHub-hosted runner, containerized)** | G1, plus G14a, G14b, G15–G17, G19, G20, G21, G23, G24, G25, G26 against the fake corpus with a **synthetic** reader driving the mount instead of a media server. The lease gates need no media server, so they run here. FUSE is available in a privileged container; mount propagation into a *sibling* container is not reliably testable here. | G7–G13, G18, G22 — all require real media servers reading a mount they can see. G6's PostgreSQL-outage leg is automatable; its media-server assertion is not. G27's admission-refusal half is automatable here; its three-server half is not. |
| **Linux / Unraid real environment, operator-run** | Everything, including G7–G13, G18, G22 and G27, and the real-provider correctness runs — which are the only place a **real** expiring access URL is exercised. | Nothing — but it is manual, so it is run at tranche close and before any release, not per commit. |

**This split is a statement about evidence, not a schedule.** A Windows green run is not a Phase 1 pass and
**SHALL NOT** be reported as one. The tranche closes on a Linux/Unraid run, three times.

### 6.0 What the tranche-closing host has to have, and why Docker Desktop cannot tell you

The row above says the Linux/Unraid environment can close everything. It does **not** say the gates will start
there, and until one is run the difference is unmeasured. **Docker Desktop hides an entire class of
host-shaped defect**: its bind sources live inside a Linux VM whose root is already a shared mount, and it
ignores uid, gid and mode on the host side of a bind. A host-shaped assumption that is simply wrong on Linux
therefore produces a green run here, every time, forever.

Two such assumptions have already been found, and neither was found by a check:

- a token file written `0600` that the consumer container's uid could not have read — invisible here because
  Docker Desktop ignores modes;
- a path spelling that a Windows `node` resolved to `C:\c\Users\…`, which killed a run twenty minutes in.

`deploy/projection-*-dataplane-gate.sh` now run `src/ops/projection-host-preflight-cli.ts` **before** they
build an image or start a container, and `npm run test:projection-host-preflight` holds the rules offline
against the mount tables of hosts none of us has. What the preflight and this table are derived from is
**platform semantics plus the two defects measured above — not an Unraid run.** Nothing here has been observed
on the tranche-closing host, because nothing has.

| Requirement | Why | Check |
|---|---|---|
| **Node.js and npx on the HOST** | every gate drives its media server from `npx tsx src/ops/…`, which runs on the host, not in a container. **A stock Unraid installation has no Node.js**, so the command this plan names as tranche-closing cannot start there | `node --version && npx --version` |
| **The gate's working directory on a `shared` mount** | the daemon binds its mount point `rshared` so the FUSE namespace reaches the media server beside it, and the kernel permits `rshared` only from an already-shared source. Docker refuses the container outright otherwise — **the daemon never starts**. Systemd remounts `/` shared at boot; **Unraid is not systemd**, and a checkout under `/mnt/user` is on `shfs`, a FUSE share. Neither is shared by default | `findmnt -no PROPAGATION -T .` |
| **Docker Compose v2** (`docker compose`, not `docker-compose`) | each gate stands up its throwaway PostgreSQL with `up -d --wait`, and `--wait` is v2. On Unraid this is the Compose Manager plugin | `docker compose version` |
| **`/dev/fuse` reachable from a container** | the daemon serves the projection over FUSE. Already probed: the gates exit **77** — a SKIP, never a pass — when it is missing | `docker run --rm --device /dev/fuse:/dev/fuse alpine test -c /dev/fuse` |
| **A traversable run directory** | the paced consumer runs as uid 1000 and writes into directories the gates `chmod 777`; those are reached *through* the run root, which `mkdir -p` creates under the operator's umask. At `077` it is `0700` and uid 1000 cannot traverse it, however permissive the leaf is. The gates now `chmod 755` it explicitly rather than inheriting a umask | the preflight's `traversal` command |
| **No SELinux enforcement, or relabelled binds** | on an enforcing host a container cannot read an unrelabelled bind, and every gate binds several. Unraid does not use SELinux, so this bounds "Linux" generally rather than the tranche-closing host. **Recorded rather than handled**, because adding `:z` relabels files on the operator's disk | `getenforce` |

**THE COMPARISON CONTROL NEEDS EVERY ONE OF THESE TOO, AND THAT IS ITSELF A SMALL RESULT.**
`deploy/projection-rclone-comparison-gate.sh` stands up no daemon and no database — the naive path has
neither — but it still mounts FUSE from a container and propagates the namespace `rshared` to three media
servers beside it. So Node and `npx` on the **host**, a **shared** mount for the run directory, `/dev/fuse`
reachable from a container, a **traversable** run directory and Compose v2 are required of it exactly as they
are of the four `projectiond` gates, and it runs the same `src/ops/projection-host-preflight-cli.ts` before it
starts a container. **The naive topology avoids none of the host requirements this table lists** — whatever
else differs between the two, the host they need does not.

**The preflight diagnoses and does not repair.** Making a host mount shared is `mount --make-rshared`, which
changes the machine the operator is standing on and outlives the run. A gate that did that quietly would be
mutating a host to make itself pass, so it names the remedy instead.

**Its verdicts are three-valued, and the third value is the point.** On a host with no `/proc/self/mountinfo`
— any Windows host — propagation is `undetermined`, reported on stderr, and **not** treated as a pass; the same
is true of the traversal check, which declines to judge a platform that carries no POSIX modes. A check that
could not run is not a check that passed, and the alternative was a preflight that broke the only environment
these gates have ever run in.

### 6.1 What has actually been run, and against which server

The table above says where a gate *can* be closed. This one says what has been *run*, because the two are not
the same and only the second is evidence.

| Gate | Jellyfin | Plex | Emby |
|---|---|---|---|
| G7 **Scan** | run — `npm run go:jellyfin-dataplane-gate`, against a real digest-pinned Jellyfin with the mount as a library root. **The plan's ~50-entry corpus is now run**: 50 published identities, each catalogued at the published size as an ordinary file, with zero missing, zero duplicated and zero unexpected. Zero churn across a repeat scan, and across the daemon SIGKILL/restart/remount path, which is followed by a byte-for-byte read so it cannot pass on a dead mount. A graceful daemon restart under a long-running media server is **not** proved here and the reason is recorded | run on Docker Desktop only — `npm run go:plex-dataplane-gate`, against a real digest-pinned UNCLAIMED Plex. 51 published identities catalogued at the published size, zero missing, duplicated or unexpected, and zero churn across a repeat scan, a media-server restart, the daemon SIGKILL/restart/remount path and a mid-scan generation swap. Four green runs, three of them consecutive and fresh; see that gate's run record | run on Docker Desktop only — `npm run go:emby-dataplane-gate`, against a real digest-pinned Emby 4.9.5.0. 50 published identities catalogued at the published size as **ordinary files**, zero missing, wrong-sized, duplicated or unexpected, and zero churn — removals, duplicates, item-id, metadata **and projected path** — across a repeat scan, a media-server restart, the daemon SIGKILL/restart/remount path and a mid-scan generation swap. "Ordinary file" is asserted differently here because **this server never sends `LocationType`**: see that gate's §3.10. Four green runs, three of them consecutive and fresh |
| G8 **Play** | run — direct play, digest-compared against values recorded outside the mount, **and the plan's five minutes are now run**: a real decoder consuming at the media's own rate for 300 s, startup under 10 s, no stall, with decoded media time and the media-per-wall-second ratio both asserted so that a fast download and a sleep cannot pass. See §6.2 | run on Docker Desktop only — direct play digest-compared against values recorded outside the mount, plus five minutes of paced play: startup 1.34 s, 300 decoded media seconds, pacing ratio 0.999, longest stall 0 s | run on Docker Desktop only — direct play digest-compared against values recorded outside the mount, plus five minutes of paced play: startup 2.3 s, 305 decoded media seconds, pacing ratio 1.00, longest stall 0 s. **And one thing neither other column can claim:** the identical direct-play request carrying **no credential** is answered **401** and the gate asserts that refusal — the pinned Jellyfin answers it 200 with the whole file |
| G9 **Seek** | run — **the plan's ten seeks are now run**, including four backward transitions and two positions beyond 90 % of duration, each returning decodable `h264` inside 10 s, all ten segments distinct, and the decoded timestamps tracking the requested positions with a constant offset. The earlier ranged-request evidence (`206` and `Content-Range` asserted before the body is read) is kept as the byte-level control | run on Docker Desktop only — ten media-time seeks including backward transitions and two past 90 % of duration, ten distinct segments, slowest 0.33 s against a 10 s ceiling | run on Docker Desktop only — ten media-time seeks, four backward transitions, two past 90 % of duration, ten distinct segments, slowest 0.3 s against a 10 s ceiling, decoded-offset spread **0.0 s**. The position each seek is held against comes from the server's own cumulative `#EXTINF` sums, because **Emby publishes no `runtimeTicks`** in a segment URL; the gate asserts that none does |
| G10 **Transcode** | run — forced `mpeg4` → `h264` proved by decoding the segments, **and the plan's five minutes are now run** as five minutes of *paced, continuously decoded, transcoded playback*. **NOT closed as five minutes of encoder liveness** — see §6.2, which records why that is a different claim and what was measured | run on Docker Desktop only — forced `mpeg4` —> `h264` proved by decoding, five minutes of paced continuously decoded transcoded playback, 39 distinct segments, 312 decoded seconds. **NOT closed as five minutes of encoder liveness** — see §6.2 | run on Docker Desktop only — forced `mpeg4` —> `h264` proved by decoding, five minutes of paced continuously decoded transcoded playback, 108 distinct segments, 324 decoded seconds over a 320 s wall span. **NOT closed as five minutes of encoder liveness** — and on this server **both** encoder instruments returned nothing at all (0 files, 0 live-`TranscodingInfo` samples of 21), which that gate's §3.9 says is not a finding about the encoder |
| G11 **Generation swap mid-read** | run — the in-flight stream completed correctly across an admitted successor | not run | run on Docker Desktop only — one held-open response body, partially consumed and not drained, completed with the whole file's digest across an admitted successor, with 13,670,080 of its 13,981,376 bytes arriving after the event |
| G12 **Kill and recover** | run — `SIGKILL` mid-stream, restart, remount: zero added, zero removed, zero item-id churn; playback resumable | not run | run on Docker Desktop only — `SIGKILL` mid-stream, restart, remount, followed by a byte-for-byte read through the media server's own mount so it cannot pass on a dead one: zero added, removed, duplicated, item-id-churned, metadata-drifted or path-drifted; the published generation did not move; playback resumable |
| G13 **Re-scan churn** | run — twice, plus across a media-server restart | not run | run on Docker Desktop only — a repeat corpus scan, a scan after the media-server restart, and a plain re-scan, each with zero churn of any kind; the plain re-scan cost the provider **zero** ranged GETs and **zero** bytes |
| G18 **High-concurrency scan** | **RUN ON A REAL UNRAID HOST — three consecutive fresh runs, 64 assertions each, none failed and none skipped. See §6.3.** It closes G18 for THIS gate and nothing else: G7-G13 are other gates and remain open. Previously, A gate now exists and has been run on Docker Desktop only: `deploy/projection-three-server-concurrency-gate.sh` puts a real, digest-pinned Plex, Jellyfin and Emby on the SAME production mount, SAME admitted generation, SAME ~50-entry corpus and SAME fake endpoint, and observes all three scanning at the same instant. §6 says Docker Desktop closes none of G7–G13 or G18, so this column stays NOT RUN | same gate, same run, same platform — **NOT RUN** | same gate, same run, same platform — **NOT RUN** |
| G22 **Comparison control** | **RUN ON A REAL UNRAID HOST — three consecutive fresh runs, 70 assertions each, none failed and none skipped. See §6.3.** G22 has no pass threshold, so what three Unraid runs establish is that the comparison instrumentation held there and its figures are reproducible — NOT that the naive path passed or failed anything. Previously, A gate now exists and has been run on **Docker Desktop only**: `deploy/projection-rclone-comparison-gate.sh` puts the SAME ~50-entry corpus behind a digest-pinned rclone mount of a deterministic WebDAV endpoint and drives the SAME three real, digest-pinned media servers over it, with the SAME observer, the SAME barrier and the SAME overlap floors G18 uses. §6 says Docker Desktop closes none of G7–G13, G18 or G22, so this column stays NOT RUN. `docs/PROJECTION_PHASE_1_RCLONE_COMPARISON.md` §7 is the only place that says what has been run, and it carries **sixteen runs — one failure and fifteen completed, twelve of them through the committed three-consecutive-fresh-run wrapper in four sequences of three**. A coordinator review then found that the endpoint counted each response's Content-Length and reported it as what had been served, which invalidated one conclusion the document drew and none of its request, catalogue, overlap or cold-state evidence; the remediated instrument counts COMMITTED and OBSERVED bytes separately and has been run four more times, 70 assertions each with none failed and none skipped | same gate, same run, same platform — **NOT RUN** | same gate, same run, same platform — **NOT RUN** |
| G24–G26 **Lease gates** | **not run** through a media server; the fake endpoint supports the mode, this gate uses the direct one | — | — |
| G27 **Path immutability** | admission half closed by `npm run test:projection-publisher`; **the three-server half is not run** | not run | not run |

`docs/PROJECTION_PHASE_1_JELLYFIN_DATA_PLANE.md` describes the gate that produced the Jellyfin column. Every
run of it so far has been on **Windows / Docker Desktop**, which §6 says closes none of G7–G13. The tranche
still closes on Linux or Unraid, three consecutive times, and on **all three** media servers.

**A second gate exists and the Plex column now records it as run on Docker Desktop.**
`deploy/projection-plex-dataplane-gate.sh` — `npm run go:plex-dataplane-gate` — drives a real,
digest-pinned, **unclaimed** Plex Media Server over the same production mount, and
`docs/PROJECTION_PHASE_1_PLEX_DATA_PLANE.md` describes what it asserts. **A gate existing is not a gate
passing**, and the Plex column changed only when that document's run record (§7 of it) carried a real
count: **five rows covering seven runs — three failing and four green**, the last three of the green ones
consecutive and each starting from nothing. That record also states plainly that it is **not** a complete
index: two further runs of this gate happened and were never given rows, so seven is what the table carries
rather than every time the gate has run. **All seven are Windows / Docker Desktop, which §6 says closes none
of G7—G13.** The column therefore reads `run` and the gate stays open.

**A THIRD GATE EXISTS AND THE EMBY COLUMN NOW RECORDS IT AS RUN ON DOCKER DESKTOP.**
`deploy/projection-emby-dataplane-gate.sh` — `npm run go:emby-dataplane-gate` — drives a real, digest-pinned
Emby 4.9.5.0 over the same production mount, and `docs/PROJECTION_PHASE_1_EMBY_DATA_PLANE.md` describes what it
asserts. **A gate existing is not a gate passing**, and the Emby column changed only when that document's run
record (§7 of it) carried a real count: **seven runs — three failing and four green**, the last three of the
green ones consecutive, each starting from nothing, and each 353 assertions with none failed and none skipped.
**All seven are Windows / Docker Desktop, which §6 says closes none of G7–G13.** The column therefore reads
`run` and the gate stays open.

**A FOURTH GATE EXISTS, IT IS THE FIRST ONE ABOUT ALL THREE SERVERS AT ONCE, AND THE G18 ROW STILL READS
NOT RUN.** `deploy/projection-three-server-concurrency-gate.sh` — `npm run go:three-server-concurrency-gate` —
stands up **one** PostgreSQL, **one** publisher, **one** admitted generation, **one** production `projectiond`,
**one** FUSE mount and **one** fake HTTP Range endpoint, and puts **three** real, digest-pinned media servers
on the same mount directory as the same library root.
`docs/PROJECTION_PHASE_1_THREE_SERVER_CONCURRENCY.md` describes what it asserts, and §7 of that document is the
only place that says what has been run: **fourteen runs, one failing and thirteen green, twelve of the
thirteen through the committed three-consecutive-fresh-run wrapper in four sequences of three, each 59
assertions with none failed and none skipped. All fourteen are Windows / Docker Desktop, which §6 says closes
none of G7–G13 or G18. Fourteen of them predate a coordinator review that tightened what the gate asserts;
the remediated gate has since been run too — one failure that exposed a real defect in it, then **three
consecutive fresh green runs, 62 assertions each with none failed and none skipped. A later review found that
its fake endpoint counted each response's COMMITTED payload length and discarded what its write returned; the
endpoint now records both columns, its byte ceilings are asserted against BOTH at unchanged values, and four
further runs — one standalone and three through the wrapper — measured 64 assertions each with none failed and
none skipped, with COMMITTED and OBSERVED bytes IDENTICAL at 13,205,874 because the daemon drains every
body**, still on Docker
Desktop and still closing nothing.** The one failure is worth reading: it was the gate's, not the product's — the barrier
was released the instant the rendezvous succeeded, which destroyed the overlap it had just created.

**It is not a wrapper around the other three gates, and the distinction is the whole point.** Running those
three at once would stand up three PostgreSQLs, three daemons, three mounts and three corpora, and would
demonstrate that three unrelated appliances can coexist on one laptop. Nothing would be shared, so nothing
would be about concurrency on one data plane.

**Simultaneity is OBSERVED, not inferred from three triggers landing together.** One process asks all three
servers their own present-tense scan state on a shared tick; a tick in which all three said `Running` is a
sample of three simultaneous in-flight scans, and three sequential scans produce zero of those. A tick whose
three answers were more than two seconds apart is recorded as imprecise and cannot count. The trigger spread
is recorded as a harness health check and is explicitly not the evidence.

**The window is COLD, on two independent instruments**, because G19 above says a re-scan legitimately costs the
provider nothing — which would let a warm window satisfy every ceiling in §5 by doing nothing at all. The
corpus is published only after all three libraries exist and after Plex's unavoidable library-creation scan has
been waited out; the endpoint is asserted to have served **zero bytes for any corpus object** before the scans
opened — the load-bearing check — and the daemon's own scan-window cache is asserted to have **grown** across
the window. **Not** that the daemon's cache was empty: it is not, because that gate publishes a local seed
entry on purpose and a local entry's own byte-identity window lands in the same cache.

**WHAT THAT GATE STILL DOES NOT CLOSE, AND WHY THE ROW ABOVE READS `NOT RUN`.** Every run has been on Windows /
Docker Desktop, which §6 says closes none of G7–G13 or G18. **Per-server provider attribution is impossible
there and is not claimed**: one daemon serves all three servers, so the endpoint sees the daemon and never the
server behind a byte — every byte is attributed to a corpus OBJECT and none to a SERVER. **G22 is NOT RUN — a
fifth gate now exists for it and has been run on Docker Desktop only; see below. G27's three-server half is not
run.** No real provider endpoint has ever been contacted, and **Phase 1 remains open**.

**AND THE SENTENCE THAT USED TO END THIS PARAGRAPH — "no run has ever happened on Linux or Unraid" — IS NOW
FALSE AND HAS BEEN REMOVED RATHER THAN SOFTENED.** See §6.3. Removing it changes nothing about G7–G13, which
are other gates.

**A FIFTH GATE EXISTS, IT IS THE COMPARISON CONTROL, AND THE G22 ROW STILL READS NOT RUN.**
`deploy/projection-rclone-comparison-gate.sh` — `npm run go:rclone-comparison-gate` — stands up **one**
deterministic WebDAV endpoint serving the **same** ~50-entry corpus, generated from a generator body that is
character-for-character the three-server gate's and compared to it by an offline test; **one** read-only,
digest-pinned rclone mount of that endpoint with a **fresh** cache; and the **same three** real, digest-pinned
media servers on that one mount directory as their library root. It uses G18's **own** observer, **own**
overlap analysis, **own** floors and **own** barrier, imported rather than reimplemented, because "measured the
same way" is only true if it is the same measurement.

**IT STANDS UP NO POSTGRESQL, NO PUBLISHER, NO MANIFEST AND NO `projectiond`, AND THE ABSENCE IS HALF OF WHAT
IS BEING COMPARED.** The naive path has none of those.

**WHAT IT ASSERTS AND WHAT IT REFUSES TO ASSERT ARE DIFFERENT KINDS OF THING, AND THE SPLIT IS THE POINT.** G22
has no pass threshold, so **every cost figure is recorded and compared against nothing** — a gate that failed
on an expensive number would be a gate nobody could run to produce the finding. What fails closed is the
instrumentation: the mount works and is proved to carry the bytes, the corpus is exactly the corpus, all three
servers really scan and really overlap, the telemetry is coherent, monotonic and fully attributed, the window
is **cold** on two instruments on opposite sides of the wire, no credential leaks, every image is
digest-pinned, every wait is bounded and cleanup succeeds.

**AND IT IS A CONTROL, NOT A CANDIDATE.** `docs/ADR_002_PROJECTION_APPLIANCE.md` §2 rejected rclone over WebDAV
as production architecture for reasons no cost figure touches, and kept it as a test control in those words. A
cheap number would not reopen that decision and an expensive one is not what closed it.
`docs/PROJECTION_PHASE_1_RCLONE_COMPARISON.md` describes what it measures, §7 of that document is the only
place that says what has been run, and **every run so far has been on Windows / Docker Desktop, which §6 says
closes nothing**.

**With that, all three media servers have a gate, and the tranche is no closer to closing than it was.** §6 says
the media-server gates close on a Linux or Unraid host; **none of the three gates has ever run on one**. What
has changed is that "one of the three is untouched" — true when the Plex gate merged — is no longer the reason
the tranche is open. The reason is the platform, and it was always going to be.

**Emby is the second server in the MediaBrowser API family, and that is what made it worth doing rather than
cheap.** Six of the Jellyfin gate's hardest-won behavioural conclusions turned out to be **false for Emby**:
no `StartupWizardCompleted` anywhere, no `LocationType` even when requested, no `runtimeTicks` in a segment
URL, no transcoding temp path in the encoding configuration, a `docker exec` that lands as root, and — in the
other direction — a direct-play endpoint that **refuses an unauthenticated request**, which lets the Emby gate
assert something the Jellyfin gate had to decline to claim. A parameterised second driver would have inherited
every one of them. Three of the six were found by **failing runs** rather than by reasoning, and that gate's §4
records what each cost.

That document also carries a **retracted** finding
and the confound behind it: three probes said an unclaimed Plex needs plex.tv to answer its own local API,
all three addressed the server by container name, and what was refusing was Plex's Host-header rebinding
protection. Re-measured with no route to the internet and the server addressed by IP, an unclaimed Plex
answered the four requests needed to inspect and create a library — and no more than those four were tried,
so scanning and playback on an air-gapped Plex are **not** established.

It also records something §5 should not be read as already covering for Plex. §5's byte budgets are measured
against a **synthetic** scan, and its own preamble says none of those numbers is evidence about a real media
server's metadata pass. Against a real Plex the *budget* for identifying one object is
`BLOCK x min(4 MiB, size) + SMALL x min(1 MiB, size)` — the per-response-class caps (8 demand blocks + 3
probe windows) evaluated at the object's own length. **So on a small fixture that ceiling already
permits a whole-object read, and satisfying it would prove nothing about the fraction.** That is a limit of
the instrument and not a lower bound — it does not mean a below-one read is unreachable there. The 1.28x and
1.66x measured over the 8.6 MB and 14.0 MB fixtures are separately just observations of what was read: they
neither prove nor disprove the argument. The Plex gate therefore asserts the fraction where an actual-byte
measurement has margin — **one object above 94 MiB**, against the same 0.5 the Jellyfin gate is held to — and
that assertion has now been observed to hold on Docker Desktop, at 0.109 of the 105.4 MB fixture, in four
green runs. On an object that size the envelope (0.348 on that fixture) is the tighter of the two bounds,
so 0.5 remains the explicit headline but is not what would fail first. An earlier per-open model —
`2 opens x min(3 x 4 MiB, size)`, saturating at 24 MiB — was **retired** when gate6 exceeded it, 32,505,856
against 25,165,824.

### 6.3 THE FIRST RUNS ON A REAL UNRAID HOST — what they were, and what they were not

**TWO GATES HAVE NOW RUN ON A REAL UNRAID HOST, THREE CONSECUTIVE FRESH RUNS EACH, AND THE TRANCHE IS STILL
OPEN.** This section exists because §6.1 is the evidence authority and an authority that concealed a partial
truth would be worse than one that recorded it.

The host: **Unraid 7.2.3, kernel 6.12.54, Docker 27.5.1, Compose v2.40.3, Node 22.18.0 on the host**, from an
isolated checkout under `/mnt/user/appdata/catalog`. `/mnt/user` is `fuse.shfs` with propagation **`shared`**.

**THE HOST PREFLIGHT RETURNED AN AUTHORITATIVE VERDICT FOR THE FIRST TIME.** §6.0 says its verdicts are
three-valued and that `undetermined` is not a pass; every previous run was on Windows, where propagation and
traversal are exactly that. On this host both were measured for real, `/dev/fuse` was reachable from a
container and SELinux was absent. §6.0 predicted a checkout under `/mnt/user` would **not** be shared by
default; on this host it is, so the requirement was satisfied without mutating the host and no
`mount --make-rshared` was performed.

| Gate | Runs | Result |
|---|---|---|
| **G18** three-server concurrency | 3 consecutive, fresh | **64 assertions per run, 0 failed, 0 skipped** |
| **G22** rclone comparison control | 3 consecutive, fresh | **70 assertions per run, 0 failed, 0 skipped** |
| **Jellyfin** data plane (G7–G13’s Jellyfin share) | 3 consecutive, fresh | **366 assertions per run, 0 failed, 0 skipped** |
| **Emby** data plane (G7–G13’s Emby share) | 3 consecutive, fresh | **395 / 394 / 394 assertions, 0 failed, 0 skipped** |
| **Plex** data plane (G7–G13’s Plex share) | **3/3 consecutive fresh** | **414 / 412 / 414 assertions, 0 failed, 0 skipped** |

**AND EVERY ONE OF THOSE RUNS LEFT THE HOST CLEAN**, which is a claim the gates now make themselves: each
reports `cleanup: 0 mountpoints and no run directory left under the gate root`, on success and on failure
alike. Before the correction in §6.5 the same gate left four dangling mountpoints behind.

**PLEX NOW PASSES, AND IT TOOK TWO GATE DEFECTS TO GET THERE.** Both earlier sequences stopped at run 1, on
different assertions, and neither was a byte budget nor a fault in the product. §6.6 records what they were
and how each was answered without moving a number. The measurements that had failed now read:

| Assertion | Before | After |
|---|---|---|
| `PX9-scan-range-requests-floor` | **0** against a floor of 1 | **5** |
| `PX9-scan-provider-bytes-floor` | **0** against 1,048,576 | **11,534,336** |
| `PX20` liveness | `output-advances` **7**, then **6**, against a floor of 8 | `advance-gap-seconds` **48** against a ceiling of **120** |

**ALL FIVE GATES THAT HAVE AN EXECUTABLE FORM NOW HAVE THREE CONSECUTIVE FRESH UNRAID RUNS, AND PHASE 1 STILL
DOES NOT CLOSE.** G24–G26 and G27's three-server half have **no executable gate at all** (§6.4), and **no real
provider endpoint has ever been contacted** — which §2 names as a corpus of the tranche and §6 places on this
very environment. What has changed is that the reason Phase 1 is open is no longer the platform.

### 6.7 What the G24–G26 audit found: the product was already there

**THE DAEMON'S TRANSPORT-RESOLUTION PATH IS COMPLETE, AND WAS COMPLETE BEFORE ANYONE LOOKED.** The audit this
tranche began with expected to find lease handling absent or partial. It is neither:

| Behaviour G24–G26 require | Where it already lives |
|---|---|
| Re-resolve a stable reference when access material lapses | `source/http.go` — a `ClassAccessRefresh` failure is followed by exactly one `resolver.Refresh` |
| At most ONE refresh per read | the same function, followed by `terminalize`, which makes a post-refresh failure un-refreshable so a refresh can never lead to another |
| Single-flight resolution under a stampede | `resolver.go` — `slot.inflight`, so concurrent callers wait on one call |
| A cooldown after a FAILED resolution | `resolver.go` — `RefreshCooldown` against `lastRefreshAt` |
| An egress allowlist a resolved URL cannot escape | `resolver.go` — `AllowedOrigins`, with a separate switch for private addresses |
| Access material that cannot leak | `Lease.String()` returns `<access-lease redacted>`, so an accidental `%v` prints a placeholder |

**SO NOTHING IN THE PRODUCT WAS IMPLEMENTED FOR THESE GATES, AND THAT IS THE FINDING.** What was missing was
never the behaviour; it was the evidence. §6.1 recorded G24–G26 as "not run" and that remains exactly right —
**a capability that exists and has never been exercised end to end is not a gate that passed.**

**WHAT THIS TRANCHE BUILT** is the half that was missing, up to but not including the run:

- an **uncounted control surface** on the fake endpoint (`/control/fault/…`, `/control/expire-leases`) so a
  gate running the endpoint in its own container can arm a fault and lapse a lease — with Go tests proving a
  control request moves neither the range counter nor the resolution counter, and that a deliberately lapsed
  lease is refused on the **ordinary** path and the **ordinary** counter rather than a special case;
- `--lease-ttl` and `--token-file` on `cmd/fakerange`, the credential from a file and never from argv;
- the budgets, the fail-closed window rules and the verdicts in `src/core/projection/lease-gates.ts`, every
  number traced to the clause that fixes it rather than to a measurement;
- **28 adversarial offline tests**, weighted toward the false passes these gates are unusually exposed to,
  because all three are statements about an ABSENCE — one resolution, zero bytes, zero requests — and an
  absence is satisfied by doing nothing at all. A window in which no lease ever lapsed, a stampede whose
  readers did not all start, a resolution that never happened so no disallowed host was ever named: each is
  refused by name.

**WHAT REMAINS IS THE GATE ITSELF**: the script that stands up PostgreSQL, the publisher, the endpoint in
resolver mode and the daemon, drives a synthetic reader across a deliberate lapse, and runs three consecutive
fresh times on the Unraid host. **Until that exists and has run, G24–G26 stay `not run`,** and the row above
says so.

### 6.8 G24–G26 — run, and what each measured

**THREE CONSECUTIVE FRESH RUNS ON THE REAL UNRAID HOST: 29 assertions per run, 0 failed, 0 skipped**, each
leaving zero mountpoints and no run directory. `npm run go:lease-gate:three`, commit `d424553`.

| Clause | Measured, every run |
|---|---|
| G24 re-resolves **once** | resolutions delta **exactly 1**, with the lapse observed at the endpoint |
| G24 completes with correct bytes | 33,554,432 / 33,554,432, digest recorded outside the mount |
| G24 identity unchanged | all **seven** pinned fields byte-identical; no new generation published |
| G25 stampede | **20** readers started, **exactly 1** resolution served them all |
| G25 cooldown | **0** resolutions inside it; EIO in **331–346 ms** against a 10,000 ms ceiling |
| G26 refreshed responses | all **4** shapes replayed, **0** bytes accepted from each |
| G26 allowlist | **0** requests reached the disallowed origin, observed at a listener the gate stands up |

**A CORRECTION WORTH RECORDING, BECAUSE IT WAS PUBLISHED AS A PRODUCT DEFECT AND WAS NOT ONE.** An earlier
run reported that `RefreshCooldown` did not cover `Resolver.Get`, so a read whose cached lease was already
expired could resolve without consulting it. **That was wrong.** `Get` passes `slot.resolvedOnce` as its
`isRefresh` argument, and `resolvedOnce` is set on every resolution — so once anything has resolved for a
transport identity, every later resolution on an expired lease **is** cooldown-governed.

What actually happened was a harness ordering defect. The stampede ends with a **successful** resolution,
which starts a cooldown of its own; the gate armed the resolver fault immediately afterwards, so its setup
read was refused **locally**, never reached the endpoint, and left the fault **armed**. The measured read
that followed was by then outside the cooldown, consumed the waiting fault, and recorded one resolution.

The gate now waits out the prior cooldown on a wait derived from `COOLDOWN_MS`, **measures** that the setup
failure reached the endpoint exactly once, and **refuses** a measured window that landed after the cooldown
lapsed — because a zero there would prove nothing. **No product code was changed.**

### 6.4 The gates that do not exist

**A GATE THAT HAS NOT BEEN WRITTEN CANNOT BE RUN, AND SAYING SO IS NOT THE SAME AS SAYING IT FAILED.**

| Gate | State |
|---|---|
| **G24** lease expires mid-read | **RUN — 3/3 consecutive fresh Unraid runs**, 29 assertions per run, 0 failed, 0 skipped. `deploy/projection-lease-gate.sh`. |
| **G25** lease expiry does not stampede | **RUN — same sequence.** Exactly one resolution served twenty concurrent opens; the 21st, inside the cooldown, asked the resolver nothing and failed in ~331 ms. |
| **G26** a refreshed response is held to every rule | **RUN — same sequence.** All four malformed shapes replayed after a refresh, zero bytes accepted from each; the disallowed origin was never contacted. |
| **G27** three-server half | The admission-refusal half is closed offline by `npm run test:projection-publisher`. The retire → grace → delete → add sequence across three servers has **no executable gate.** |

Writing these is slice work and is permitted by the roadmap's anti-detour rule. Until they exist, §6.1's
`not run` for them means **nothing has been executed**, not that something was executed and fell short.

### 6.5 The cleanup defect the real host exposed

After four Jellyfin runs the isolated checkout carried **four dangling mountpoints**, each reporting
`Transport endpoint is not connected`. The gates' own comments say a stale mount is how the next run inherits
a namespace and passes for the wrong reason, so this was the failure mode the gate warns about happening to
the gate.

**IT WAS A PROPAGATION DEFECT, NOT A TIMING ONE.** The daemon binds its mount point `rshared` so the FUSE
namespace reaches the media server beside it. The cleanup then ran `umount -l` inside a *different* container
whose bind of the gate root carried Docker's default `rprivate` propagation — and an unmount in a private
mount namespace is invisible outside it. The unmount genuinely succeeded, in a namespace discarded a
millisecond later. **Docker Desktop cannot show this**: its bind sources live inside a Linux VM reached over a
filesystem share, so there is no host-side mountpoint to leak. The same defect was present on the
kill-and-recover path, where a stale mount would have let a remount assertion pass against a namespace that
was not there.

### 6.2 What the five-minute gates prove, and the one thing G10 does not

**G8 and G9 are proved as written.** A five-minute play is a real decoder consuming the stream at the media's
own frame rate: startup, decoded media time, the ratio of media seconds to wall seconds, and the longest
interval in which the decoder made no progress are each asserted separately, because a five-minute claim is
otherwise passed by downloading the file and sleeping. Ten seeks are ten *distinct* segments at ten media
positions, four of the transitions backwards and two past 90 % of duration, each decoded rather than merely
answered — and the decoded timestamps move one second per second of media asked for, which is what
distinguishes a seek from the same segment served ten times.

**G10 says "a forced transcode runs 5 minutes", and this gate proves five minutes of PACED, CONTINUOUSLY
DECODED, TRANSCODED PLAYBACK. It does not prove five minutes of encoder work, and the difference is
measured rather than glossed over.**

Measured against the pinned server on a developer machine: the transcoding job encodes a 340-second,
320×240, 150 kbit/s source in about **1.6 seconds** and exits. That is with `EnableThrottling` on, a
throttle delay configured, and a player session attached by reporting playback the way a client does. Live
`TranscodingInfo` is populated immediately and is null fifteen seconds later, because there is no longer a
job. An earlier draft of this gate asserted that the encoder's own output spanned most of the window; that
assertion would have failed every correct run on this hardware, and calling 1.6 seconds evidence of five
minutes would have been an overclaim of exactly the kind this plan exists to prevent.

So the five minutes are proved from the **client and the output**, and the encoder is **recorded**:

| Asserted | What it refuses |
|---|---|
| The **source** codec, as the media server identified it, is `mpeg4` | a transcode "to h264" from a source that was already h264 |
| Decoded `h264` media time ≥ 300 s, over **every** consumed segment | counting files the server emitted; a remux; empty segments |
| Wall span across segment arrivals ≥ 300 s | nothing on its own — see the next row |
| Longest gap between **adjacent** arrivals ≤ 20 s | consuming every segment in ten seconds, sleeping, and fetching one more at the end |
| ≥ 25 % of the required media decoded in the **last third** of the window | a dense start with a padded tail |
| All consumed segments distinct | one segment delivered fifty times, which satisfies every row above |

| Recorded, not asserted | Why |
|---|---|
| The encoder's own output-file span, and how many files | it is how far **ahead of the paced client** the encoder ran, not how long it ran |
| Samples with live `TranscodingInfo` | it goes null when the job exits, which is seconds into the window |
| Samples where the server reported the playback method as `Transcode` | **the field is client-writable.** A negative control against a live server, with a real transcode serving the segments throughout, showed that a client reporting `DirectPlay` is recorded as `DirectPlay`. An earlier version asserted an 80 % share of it *while the gate was itself sending `PlayMethod: Transcode`* — a claim made here, handed to the server, and read back as the server's. The gate now sends no `PlayMethod` at all |
| Playback reports the server refused | session telemetry gathered while the server was ignoring the client describes the harness's silence, not the server's view |

**On slower hardware, a longer source or a heavier profile, the encoder would still be working across the
window and the recorded numbers would say so.** That is a property of the machine, not of the data plane,
which is why it is reported rather than required. **G10 is recorded as run, not as closed.**

## 7. What the harness must record

One redaction-safe report per run: gate id, verdict, and the measured number against its budget. Counts,
digests and gate ids only — no path, no locator, no object reference, no token, no media-server id, no
address. Same rule as every other report in this repository.

## 8. What Phase 1 explicitly does not do

- No write path of any kind, in the daemon or the manifest.
- No provider beyond a configured HTTP Range endpoint. No download creation, and no access request for
  anything the control plane did not already name as a stable reference in a manifest.
- No TorBox-specific adapter. Phase 1 needs one generic HTTP Range adapter with transport resolution; that
  the resulting contract is one a TorBox-shaped source could actually live inside is a design requirement,
  not a Phase 1 deliverable.
- No path relocation. v1 has none, by decision, and Phase 1 does not add one.
- No operator UI, no packaging, no release, no Unraid template, no scheduler.
- No third source adapter, no second frontend, no metrics backend, no evidence-packet phase.
