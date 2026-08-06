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
| G18 **High-concurrency scan** | **RUN ON A REAL UNRAID HOST — three consecutive fresh runs, 64 assertions each, none failed and none skipped. See §6.3.** It closes G18 for THIS gate and nothing else: G7-G13 are other gates and remain open. **HISTORICALLY** this row read `NOT RUN`: the gate existed and **had been run on Docker Desktop only**, and §6 says Docker Desktop closes none of G7–G13 or G18. `deploy/projection-three-server-concurrency-gate.sh` puts a real, digest-pinned Plex, Jellyfin and Emby on the SAME production mount, SAME admitted generation, SAME ~50-entry corpus and SAME fake endpoint, and observes all three scanning at the same instant. **That is now run on Unraid, and the three columns to the right are not independent runs of anything — they are the same run observed three ways**, which is what G18 asks for | **same run** — Jellyfin scanned concurrently and was observed doing it | **same run** — Emby scanned concurrently and was observed doing it |
| G22 **Comparison control** | **RUN ON A REAL UNRAID HOST — three consecutive fresh runs, 70 assertions each, none failed and none skipped. See §6.3.** G22 has no pass threshold, so what three Unraid runs establish is that the comparison instrumentation held there and its figures are reproducible — NOT that the naive path passed or failed anything. Previously, A gate now exists and has been run on **Docker Desktop only**: `deploy/projection-rclone-comparison-gate.sh` puts the SAME ~50-entry corpus behind a digest-pinned rclone mount of a deterministic WebDAV endpoint and drives the SAME three real, digest-pinned media servers over it, with the SAME observer, the SAME barrier and the SAME overlap floors G18 uses. **HISTORICALLY** this column read `NOT RUN`, because §6 says Docker Desktop closes none of G7–G13, G18 or G22 and every run then had been on Docker Desktop; **it has since run 3/3 on a real Unraid host.** `docs/PROJECTION_PHASE_1_RCLONE_COMPARISON.md` §7 is the only place that says what has been run, and it carries **sixteen runs — one failure and fifteen completed, twelve of them through the committed three-consecutive-fresh-run wrapper in four sequences of three**. A coordinator review then found that the endpoint counted each response's Content-Length and reported it as what had been served, which invalidated one conclusion the document drew and none of its request, catalogue, overlap or cold-state evidence; the remediated instrument counts COMMITTED and OBSERVED bytes separately and has been run four more times, 70 assertions each with none failed and none skipped | same gate, same run, same platform — **NOT RUN** | same gate, same run, same platform — **NOT RUN** |
| G24–G26 **Lease gates** | **RUN — 3/3 consecutive fresh runs on a real Unraid host**, 29 assertions per run, 0 failed, 0 skipped, by `deploy/projection-lease-gate.sh` with a **synthetic reader**. These gates **need no media server**: they are about the daemon's transport resolution, not about a scanner, so no column below applies to them. See §6.8 | — | — |
| G27 **Path immutability** | **RUN — 3/3 consecutive fresh runs on a real Unraid host**, **85 assertions per run, 0 failed, 0 skipped**, by `deploy/projection-path-lifecycle-gate.sh`. ONE daemon, ONE mount, ONE generation sequence and all three servers reading it, so the three columns to the right are not independent runs of anything — they are the same run observed three ways, which is what G27 asks for. See §6.9. The admission-refusal half remains closed offline by `npm run test:projection-publisher` | **same run** — observed the refusal, the removal and the addition | **same run** — observed the refusal, the removal and the addition |

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

**A FOURTH GATE EXISTS, IT IS THE FIRST ONE ABOUT ALL THREE SERVERS AT ONCE, AND THE G18 ROW READ `NOT RUN`
WHEN THIS WAS WRITTEN. IT NO LONGER DOES — HISTORICAL, SUPERSEDED BY §6.3.** `deploy/projection-three-server-concurrency-gate.sh` — `npm run go:three-server-concurrency-gate` —
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
fifth gate now exists for it and has been run on Docker Desktop only; see below. **G27's three-server half has
now RUN — 3/3 consecutive fresh Unraid runs, 85 assertions each; see §6.9.** No real provider endpoint has ever
been contacted, and **Phase 1 remains open on that ground alone**.

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

**HISTORICAL — SUPERSEDED BY §6.3. What follows was true when it was written and is kept in its own words so
the sequence of what was believed when is not lost; the correction is the sentence after it.**

**With that, all three media servers have a gate, and the tranche is no closer to closing than it was.** §6 says
the media-server gates close on a Linux or Unraid host; **none of the three gates has ever run on one**. What
has changed is that "one of the three is untouched" — true when the Plex gate merged — is no longer the reason
the tranche is open. The reason is the platform, and it was always going to be.

**THE CORRECTION: ALL THREE HAVE SINCE RUN ON A REAL UNRAID HOST**, three consecutive fresh runs each — Jellyfin
366 assertions per run, Emby 395/394/394, Plex 414/412/414 — and so have G18, G22, G24–G26 and G27. **The
platform is no longer the reason the tranche is open.** §6.3 is the authority on those runs.

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

**EVERY PHASE 1 GATE NOW HAS AN EXECUTABLE FORM AND THREE CONSECUTIVE FRESH UNRAID RUNS — SEVEN OF THEM —
AND PHASE 1 STILL DOES NOT CLOSE.** G27's three-server half was the last one missing; it now exists and has
run (§6.4, §6.9). A gate for the real-provider corpus now exists too and has been exercised offline 3/3 (§6.10), which changes what is missing from *a gate* to *a run*. **What is left is one thing and one thing only: no real provider endpoint has ever been
contacted** — which §2 names as a corpus of the tranche and §6 places on this very environment. The reason
Phase 1 is open is no longer the platform, no longer a missing lease gate, and no longer a missing lifecycle
gate. **It is that single remaining ground, and nothing else.**

### 6.7 HISTORICAL — what the G24–G26 audit found before the gate existed

> **This section is a record of a PRIOR STATE and is kept for its finding, not for its status.** Everything
> below describing the gate as unwritten or unrun was true when it was written and is **not true now**:
> G24–G26 have since been built and have run 3/3 on a real Unraid host — see §6.8, which is the authority.
> What survives unchanged is the finding itself: **the product already did all of it.**

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

**SO NOTHING IN THE PRODUCT WAS IMPLEMENTED FOR THESE GATES, AND THAT IS THE FINDING — it still stands.**
What was missing was never the behaviour; it was the evidence. §6.1 recorded G24–G26 as "not run", which was
right **at the time**, on the principle that **a capability that exists and has never been exercised end to
end is not a gate that passed.** The evidence now exists (§6.8), and **no product code was changed to produce
it.**

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

**WHAT REMAINED AT THAT POINT WAS THE GATE ITSELF** — the script that stands up PostgreSQL, the publisher,
the endpoint in resolver mode and the daemon, drives a synthetic reader across a deliberate lapse, and runs
three consecutive fresh times on the Unraid host. **It was then written, and it has run: see §6.8.** This
paragraph is left in place because the sequence of claims matters — the gate was not treated as evidence
until it had actually run.

### 6.8 G24–G26 — run, and what each measured

**THREE CONSECUTIVE FRESH RUNS ON THE REAL UNRAID HOST: 29 assertions per run, 0 failed, 0 skipped**, each
leaving zero mountpoints and no run directory. `npm run go:lease-gate:three`, commit **`ab29078`**,
evidence `lease-three-final.log`.

**THE SEQUENCE WAS RESTARTED FROM RUN 1 ON THAT COMMIT.** An earlier 3/3 exists at `lease-three-d424553.log`,
but the full offline suite then caught three shipped-script parse violations in the gate; the gate changed
materially, and a sequence run against different bytes is not evidence about these ones.

| Clause | Measured, every run |
|---|---|
| G24 re-resolves **once** | resolutions delta **exactly 1**, with the lapse observed at the endpoint |
| G24 completes with correct bytes | 33,554,432 / 33,554,432, digest recorded outside the mount |
| G24 identity unchanged | all **seven** pinned fields byte-identical; no new generation published |
| G25 stampede | **20** readers started, **exactly 1** resolution served them all |
| G25 cooldown setup | the failed resolution **reached the endpoint exactly once**, so the fault was really consumed |
| G25 cooldown | **0** resolutions inside it; EIO in **340 / 345 / 377 ms** against a 10,000 ms ceiling |
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

### 6.9 G27's three-server half — run, and what it measured

**3/3 CONSECUTIVE FRESH RUNS ON THE REAL UNRAID HOST, 85 ASSERTIONS PER RUN, 0 FAILED, 0 SKIPPED.** Commit
`a9fa7ab`, evidence `evidence/lifecycle-three-final.log` in the isolated checkout,
via `npm run go:path-lifecycle-gate:three`. One production `projectiond`, one FUSE mount, one admitted
generation sequence, and the same three digest-pinned media servers the other gates use — Jellyfin 10.10.7,
Plex, Emby 4.9.5.0 — all reading the SAME mount.

**EVERY PHASE IS A SET DIFFERENCE, NOT A COUNT.** Each observation lists all three servers' catalogues with
each server's OWN item id, and the phases compare inventories: what entered, what left, and what changed
identity underneath a path that stayed. A count that happens to drop, a scan that returned nothing, an
inventory read twice, and a server that removed the wrong item and added another all produce the same count
and are all refused.

| Phase | What it required | What was measured |
|---|---|---|
| **L1** seed | the item at path A catalogued exactly once, as an ordinary file, on all three | 2 items per server (the entry and a bystander), all three |
| **L2** refusal | a successor moving the carried entry **directly to path B** is refused; served generation unchanged; path B absent; path A still there | the daemon logged `PATH_CHANGED_FOR_CARRIED_ENTRY` and kept serving its generation; **0 added, 0 removed, 0 item-id churn on all three** |
| **L3** retiring | path A still catalogued AND still readable through the mount | present on all three, 0 churn, digest matched |
| **L4** past grace | the grace deadline crossed, and **nothing disappears because time passed** | present on all three, 0 churn, still readable |
| **L5** deletion | **exactly** path A removed, nothing added, no unrelated churn, on all three | 1 removed, and it was path A, on all three; 0 added, 0 churn |
| **L6** addition | **exactly** path B added, ordinary-file metadata correct, size and bytes right | 1 added, and it was path B, on all three; 42,628 bytes; digest matched a value recorded OUTSIDE the mount before publishing |
| **L7** watch state | **recorded, asserted by nothing** | **all three servers did NOT preserve it** — every item id changed across the delete+add pair |
| **L8** sequence | four DISTINCT admitted generations | 4 of 4, none unknown |

**WHAT L7 IS AND IS NOT.** All three servers reassigned the item id across the delete and the add, so on all
three a play position or watched flag attached to the old item does not follow the new one. **That is
recorded and it fails nothing.** This product has never promised watch state survives a delete and an add,
G27 explicitly says the observation is not an assertion, and the check is built so it cannot become one:
`watchStateObservations` has no budget and no comparison, and an offline test pins that for preserved, not
preserved and not determinable alike.

**FOUR HARNESS DEFECTS WERE FOUND AND FIXED, AND NO PRODUCT CODE WAS CHANGED.** The fixtures were `.bin`
files Plex's scanner never opens, so the gate had been asserting a three-server lifecycle against two
servers; the scan barrier wrote a shape `corpusProblems` does not parse; the forged-pointer rollback did
`rm -rf` on a bind-mounted directory and detached the daemon's own mount from it; and the served-generation
observer matched only the daemon's first-mount log line, not the per-admission one, so it returned the same
answer forever. **Each was in the gate. The daemon refused the illegal move correctly the first time it was
ever asked.**

**THIS CLOSES G27 AND NOTHING ELSE.** No real provider endpoint has ever been contacted, and Phase 1 remains
open on that ground.

### 6.10 The real-provider correctness gate — built, exercised offline, NOT RUN against a provider

**THE LAST OUTSTANDING REQUIREMENT NOW HAS A GATE, AND THAT IS NOT THE SAME AS HAVING RUN IT.** §2 asks for
1–3 files the operator is legally entitled to, to answer whether the HTTP Range adapter works against a real
endpoint. `deploy/projection-real-provider-gate.sh` is that gate. **No real provider has been contacted, and
Phase 1 remains open on exactly that ground.**

**IT SUPPLIES NOTHING ITSELF AND LOOKS IN EXACTLY ONE PLACE.** It never invents a credential, an object
manifest or an endpoint; it does not search the filesystem for anything that might be a secret, does not read
one from the environment, and does not prompt. With the approved inputs absent it **skips with status 77** and
says a skip closes nothing. That is the correct outcome on any machine an operator has not prepared, and it is
what happens on this host today.

**WHAT IS ASSERTED.** Real TLS with the system trust store and no pinning; redirect refusal; `206` only, with
`Content-Range` granting exactly the requested window; the provider's total agreeing with the operator
manifest; `Content-Length` agreeing with the window; a body neither short nor long; digests recorded **outside
the mount** compared against reads **through** it; a **backward** read and one **past 90 %** of the object;
finite deadlines on every request and every read; retries bounded; **at most one** access refresh per read;
zero contact with any origin outside the allowlist; an ordinary read-only FUSE mount refusing write, create,
unlink and chmod; no access material anywhere on disk, searched for by the exact value the run used; and a
**positive byte count**, because every ceiling above is satisfied by a run that contacted nothing.

**NOT ASSERTED, DELIBERATELY.** 429s are **recorded and asserted by nothing** — a real provider is entitled to
rate-limit, this corpus is never a load test, and G16 asserts zero 429s against the fake endpoint where the
harness controls the load. Where the supplied endpoint serves stable references directly, the refresh
assertion **skips**; G24–G26 hold that contract in full.

**NOTHING REACHES ARGV, A LOG LINE OR A REPORT.** argv is world-readable, so every URL, reference and
credential arrives as a **file path**. An object's only identity anywhere in the output is an operator-chosen
label and a 12-character digest prefix; the stable reference is the one field that never reaches a report at
all. The scrubber refuses URL shapes, signed query parameters, credentials, long opaque strings and media
filenames, and runs **before** the report is printed.

| Run | Mode | Result |
|---|---|---|
| `npm run go:real-provider-gate:fake` | offline fixture | **33 assertions, 0 failed, 3 skipped** — 3/3 consecutive fresh runs on the real Unraid host, `evidence/rp-fake-three.log`. **HISTORICALLY 2 skipped**; the third is `RP3-egress-allowlist`, corrected from a fabricated pass to an honest skip — see §6.11 |
| `npm run go:real-provider-gate` | real | **SKIPPED (77)** — no operator corpus exists at the approved path |
| `npm run test:projection-real-provider` | offline | **74 adversarial tests** (was 60) |

**AND THE SEQUENCE ABOVE WAS NOT REPRODUCIBLE AT THE MERGE THAT RECORDED IT.** At `01af2d3` this gate could
not complete **run 1 of 3** on the very host this table names: it died in its own preflight negative control,
because the rule that control assumes had never existed. §6.11 records what it was. The 3/3 above is the
sequence measured **after** that fix, on an isolated checkout of the same host.

**THE 3/3 FAKE SEQUENCE CLOSES NOTHING.** It proves the gate evaluates every assertion and can fail. The
skips are the TLS assertions, which skip against a plaintext fixture and are asserted against a real endpoint
— that is how the report distinguishes the two, and a skip is never a pass. **No product code was changed:**
the adapter already refuses redirects, accepts only `206`, requires an exact `Content-Range`, checks the total,
bounds the body, terminalises a second refresh and enforces both the allowlist and the credential file mode.

**WHAT AN OPERATOR MUST SUPPLY TO CLOSE THIS.** Three files under
`/mnt/user/appdata/catalog/secrets/real-provider/`, directory mode `0700`:

| File | Mode | What it is |
|---|---|---|
| `credential` | **`0600`** | The long-lived token, and nothing else. The daemon refuses any mode with `0o077` set, and so does preflight, before anything is contacted. |
| `objects.json` | `0600` | 1–3 objects: `label`, `ref`, `sizeBytes`, and **either** `sha256` **or** `probeDigests`. Template: `deploy/real-provider-objects.template.json`. |
| `endpoint.json` | `0600` | `id`, **exactly one** of `resolverUrl` or `directBaseUrl` (https), a non-empty `allowedOrigins`, and both fixture switches false. Template: `deploy/real-provider-endpoint.template.json`. |

Then: `npm run go:real-provider-gate` to preflight and run once, and
`npm run go:real-provider-gate:three` for the three consecutive fresh runs the plan requires.

**THE TORBOX GATE READS A DIFFERENT DIRECTORY, AND IT HAS TO.** `deploy/projection-torbox-real-gate.sh`
takes its four inputs from `…/secrets/real-provider/torbox/` (`PROJECTION_TORBOX_INPUT_DIR`), because its
`endpoint.json` schema is the **inverse** of the one above: this gate requires exactly one of `resolverUrl`
or `directBaseUrl`, and that one **refuses both** — the resolver's address depends on a network namespace
the gate creates, so the operator cannot write it. Both gates read the same three FILENAMES, so while they
shared one directory, preparing either turned the other's honest `SKIPPED (77)` into a hard failure and
neither could be prepared without breaking the other. `credential` also means different things in the two:
here the token sent to the provider, there the gate secret the daemon presents to the loopback resolver.

### 6.11 The credential-free heredoc audit — what executing the gates' own embedded programs found

**THE GATES' MEASUREMENTS ARE MADE BY SMALL PROGRAMS EMBEDDED IN THE SHELL SCRIPTS AS HEREDOCS, AND ALMOST
NONE OF THEM HAD EVER BEEN RUN BY A TEST.** `test/torbox-resolver.ts` had begun extracting three of them and
executing them against fixtures; an inventory of every heredoc written into the run directory across all
`deploy/projection-*gate*.sh` found **131**, of which **3** had executable coverage. The rest were held only
by string-matching the surrounding shell — which is how a gate acquires a measurement that is wrong in a way
no assertion can see. This audit extended the technique to the security- and correctness-critical remainder.
**Every defect below was found by RUNNING the shipped program, and every one is proved by a test that fails
against `01af2d3` and passes after the fix.**

| # | Where | What was wrong | How it presented |
|---|---|---|---|
| 1 | `endpointProblems`, via the real-provider gate's own preflight negative control | **No rule refused an unedited template.** `deploy/real-provider-endpoint.template.json` is structurally valid by construction, so preflight answered "PREFLIGHT PASSED — the inputs are well formed" over an endpoint whose id, base URL and allowlist were all still `REPLACE-ME` | **The gate could not complete run 1 of 3 on the Unraid host at the merge base.** Its fake-mode control dies if the template is accepted, and it was. An operator who filled in credential and objects but not the endpoint got a green preflight and a run aimed at `REPLACE-ME.example.invalid` |
| 2 | `scan.cjs` — **3 gates, 6 call sites** | The credential-leak measurement reported **`0`** without having looked, three ways: a needle under 8 characters skipped the walk entirely; any file over **64 MiB** was skipped; a root that did not exist was walked in silence. It also decoded the haystack as `latin1` while the needle was `utf8`, so a non-ASCII secret could never match itself | This is the only measurement behind **"no access material reached disk"** (`RP6-no-lease-on-disk`) and behind the TorBox gates' "neither secret reached anything this run wrote". In the real gates both needles are **operator-supplied**. The same secret was found in a 32 MiB file and invisible in a 64 MiB one |
| 3 | `observations.cjs` — real-provider gate | `cleanup: { mountpoints: 0, containers: 0, runDirectories: 0 }` and `disallowedOriginContacts: 0` were **literals**. The verdict layer that consumes them is falsifiable and well tested, so **four RP6 assertions and one RP3 assertion were handed a constant they could never fail against** | Worse than unmeasured: the record was written **before** the EXIT trap, while the mount container was still running by design, so `containers: 0` was **false**. `RP3-egress-allowlist` passed under a note claiming it was "observed at a listener the gate stands up" — this gate stands up no such listener; that sentence belongs to the lease gate |
| 4 | `probe-resolver.cjs` — both TorBox gates | `http.request` applies **no default timeout** in Node, and none was set | A resolver that accepted the connection and never answered left the gate **hung, not failed** — no assertion, no cleanup, no report. The transport probe shipped beside it already bounded itself at 3 s |
| 5 | `cleanupResults` / the gate's success path | **This run's own directory and mounts were asserted by nothing.** Every verdict is read out of the run directory, so `RP6-run-directories` deliberately excluded the only directory that could have leaked — while being named as though it did not. The EXIT trap's `projection_gate_report_cleanliness` is a REPORT by construction: its own comment explains that a non-zero return there would overwrite the gate's exit status | **A successful gate could print `cleanup: 1 mountpoint left behind` and still exit 0** — the report-versus-assertion gap §6.5 exists to close, reappearing inside the gate meant to close it. §6.5 records four dangling mountpoints from exactly this, each answering `Transport endpoint is not connected`, and warns that a stale mount is how the NEXT run inherits a namespace and passes for the wrong reason |
| 6 | `verify.cjs` — TorBox **mount** gate | It still clamps a fixed 64 KiB window back inside the object — the arithmetic the **real** gate's copy was corrected away from. Below 655,360 bytes the "past 90%" read happens **below** 90%; at 65,536 or less it lands on offset **zero**, identical to the backward read, failing a correct mount | **LATENT, not live**: this gate's corpus is its own and is 8 MiB. Recorded as a divergence the earlier correction left behind, and closed by a **refusal** rather than new arithmetic, because the cold pass depends on the shifted offsets staying where they are |

**HOW #5 IS CLOSED, AND WHY THE ORDER MATTERS.** The line that counted other runs' leftovers is renamed
`RP6-foreign-run-directories` and says in its own note what it does **not** cover. This run's own directory
and mounts became a new, harder assertion — `RP7-own-run-directory-removed` and `RP7-own-mountpoints-removed`,
decided in the module like every other verdict and driven through a `real_provider cleanup` phase. It runs
**after** the report is printed and **after** the evidence is copied out from under the run directory, so
requiring that directory to be gone cannot cost the operator the results that justify the verdict; and it is
reached only when every earlier phase succeeded, so it cannot mask an earlier failure. **The EXIT trap is
unchanged for every failure path**, where it must stay a report for the reason its own comment gives. The
mountpoint half keeps §6.0's three-valued treatment — a host that cannot enumerate its mounts skips it loudly
— while the directory half is unconditional, because every host can answer whether a directory exists.

**AND PRESERVING THE EVIDENCE IS PART OF THAT PRECONDITION, NOT A COURTESY BESIDE IT.** The step that asserts
the run directory is gone is the step that deletes it, and the run directory is the only place the verdict
evidence exists. The first version of it copied both artifacts with `|| true` and then printed "evidence kept"
unconditionally — so a copy that failed for any reason (a full disk, a read-only gate root, a results file the
verdict never wrote) destroyed the only record of why the run passed, said it had kept it, and exited 0. That
is the same class of defect as reporting a measurement never taken, applied to the thing that justifies every
other measurement. Both artifacts must now exist, be non-empty, copy successfully, and compare **byte-identical**
to what the run wrote; any of those failing ends the run non-zero **before** anything is deleted. The shipped
`copy_evidence` function is extracted and executed by the offline suite against all four cases.

**WHAT THE FIXES DO NOT DO.** No threshold moved, no hard failure became a skip, and no redaction was
loosened — the leak scan still prints a bare count and never a filename, a line or the needle. The one
verdict that changed character is `RP3-egress-allowlist`, and it changed **from a pass the gate wrote for
itself to a skip that says so**: the gate has no listener on the excluded origin and now declines to claim
one, while **G26 continues to assert the allowlist in full** against a listener `deploy/projection-lease-gate.sh`
really does stand up. That is the third skip in §6.10's table.

**WHAT WAS RUN.** On an isolated checkout at `/mnt/user/appdata/catalog-phase1-heredoc-audit` on the same
Unraid host: `npm run go:torbox-mount-gate:three` **3/3, exit 0**; the real-provider gate in fake mode
**3/3, 33 assertions, 0 failed, 3 skipped**; and `deploy/projection-torbox-real-gate.sh` **SKIPPED (77)**,
having contacted nothing. Every run reported `cleanup: 0 mountpoints and no run directory left under the gate
root`, both gate roots were left empty, and the host's container, network, volume and mountpoint counts were
identical before and after (26 running / 42 total, 17, 45, 0).

### 6.12 The second credential-free audit loop — the shell siblings, and the half the first fix left behind

**THE FIRST LOOP CORRECTED `scan.cjs` AND LEFT ITS FIVE SHELL SIBLINGS UNTOUCHED.** §6.11 records
`leakcheck.sh` nowhere, because the inventory was of programs and this one is five byte-identical copies of
the same fifteen lines across `deploy/projection-{jellyfin,emby,plex}-dataplane-gate.sh`,
`deploy/projection-three-server-concurrency-gate.sh` and `deploy/projection-rclone-comparison-gate.sh` —
**fifteen call sites**, carrying the same claim `scan.cjs` carries and, as it turned out, three of the same
defects. **Every finding below was produced by executing the shipped bytes** — the shell helpers in the
gates' own digest-pinned `alpine@sha256:d9e853e8…`, the `.cjs` helpers under `node` — **and every one is
pinned by a test that fails against `dac5abe` and passes after.** The new suite is
`test/projection-gate-embedded-programs.ts`, and its mutation proof, measured against the **final** bytes of
both trees and with the working tree restored byte-identical after each swap, is:

| Platform | against merge base `dac5abe` | against this tree |
|---|---|---|
| Windows / Docker Desktop (developer machine) | **7 passed, 20 failed** | **27 passed, 0 failed** |
| Unraid host, as root | **4 passed, 23 failed** | **27 passed, 0 failed** |

The two rows differ by exactly the three cases Windows cannot express — the two unopenable-file fixtures and
the fifo fixture, which need POSIX modes and a real named pipe. Those are **reported rather than judged** on
Windows, which is §6.0's three-valued rule; they are live on the host and are among the 23 failures there.

| # | Where | What was wrong | How it presented |
|---|---|---|---|
| 1 | `leakcheck.sh` — **5 gates, 15 call sites** | `grep -rlF "$pattern" /scan 2>/dev/null` **discarded grep's errors and its exit status alike**, so a root that did not exist and a file that could not be opened went down the same path as a clean miss: no output, no leak, exit 0 | Measured in the pinned image: a secret sitting in plain text in a **mode-000 file was reported ABSENT**, and a `/scan` that did not exist was reported **CLEAN**. This is the only measurement behind "no provider access material reached disk" in all five gates |
| 2 | the same 15 call sites | **The needle was in argv.** Each passed the secret as a `docker run` argument | `docker inspect -f '{{json .Config.Cmd}}'` returned `["sh","/out/leakcheck.sh","the mount client cache","PJDDAV…","Authorization:"]` — the value **verbatim**, for the life of the container, and in the host's `ps` besides. The rclone gate's own comment, fifteen lines above its first call, says its token "is in no argv, no container inspect output and no shell history"; **the only place it ever reached argv was the check written to prove it had not leaked** |
| 3 | the same helper's failure path | It printed **`LEAK: '<the secret>' appears under <label>`** and then up to five **matched file paths** | §7 of this plan allows counts, digests and gate ids and nothing else, and §6.11 says in its own words that the leak scan "never [prints] a filename, a line or the needle". A hit now names the needle by its **index** and nothing else |
| 4 | `scan.cjs` — 3 gates, 6 call sites | The half the first correction left behind: it closed "a root that did not exist was walked in silence" and left **"a file that could not be opened was skipped in silence"** — `catch { continue; }`, with the readable files beside it keeping `examined` above zero so the "a scan that opened nothing is not a scan that found nothing" guard never fired | Executed as uid 65534 over one harmless readable file and one mode-000 file holding the credential: **merge base prints `0` and exits `0`; the corrected program exits 4 and says which coverage it did not have.** These six call sites run **on the host as the operator** over directories containers wrote as other uids, so it is live. A socket or fifo is now skipped rather than read, which could otherwise block for ever |
| 5 | `cacheceiling.cjs` — 3 gates | **A missing `sizeBytes` RAISED the ceiling.** `undefined < SINGLE_PROBE_BELOW` is false, so an entry with no size fell through to the three-window branch and bought itself 3 MiB of headroom | On a 51-entry corpus with one size removed the ceiling went from **25,185,364 to 29,858,950**, silently, exit 0. A budget that **loosens** when its input degrades is what §5.1 exists to prevent, and this one bounds the probe cache in all three media-server gates |
| 6 | `published.cjs` — 3 gates | `total + entry.sizeBytes` is **string concatenation** when one size is a string | A 122,345,436-byte corpus reported **87,511,611,050,000,008,594,275** — a syntactically valid integer `test -lt` accepts without complaint, about 10^15 times the truth, which made `test "$CACHE_BYTES" -lt "$PUBLISHED_BYTES"` unfailable. A missing size reported `NaN` |
| 7 | `identity.cjs` — the lease gate, G24 | It read the **first** directory entry beginning `generation-`, which is not the generation `pointer.json` names — while `PointerDocument` carries `artifactName` and always did | Executed with `generation-1-FIRST.json` and `generation-2-SECOND.json` present and the pointer naming the second, it emitted `generationId: gen_SECOND` and `sequence: 2` **beside** `projectedEntryId: pe_OLD`, `sourceId: src_OLD` and `sourceGeneration: 1` — **one record describing two generations.** Because the before and the after call read the same wrong file, **three of the seven pinned fields were read out of a document nothing rewrites during the window** and could not have differed whatever the daemon did. §6.8 records "all seven pinned fields byte-identical"; **four were measured.** `sources[0]` was positional besides, so a failover between two sources was invisible by construction; a pinned entry must now carry exactly one |
| 8 | `counters.cjs` — 3 gates | `snapshot[name] ?? 0` printed **`0`** for a counter the endpoint does not carry | **LATENT, not live**: every name these gates ask for — `heldRequests`, `currentHeldWaiters`, `holdTimeouts`, `rangeRequests`, `resolutions` — exists in `fakeprovider.go` today, and that is asserted so it stays true. Recorded and refused because it is a zero meaning "the field is not there" on the surface every §5 budget is differenced from, and `windowProblems` in `lease-gates.ts` already refuses exactly that absence one layer up |

**AND TWO OF THE CORRECTIONS ABOVE WERE THEMSELVES WRONG FIRST, WHICH IS RECORDED RATHER THAN TIDIED AWAY.**
A review of this loop's own diff, before any host run, found all three:

- **`Number.isInteger` IS NOT THE GUARD.** The first version of findings 5, 6 and 8 refused a non-integer and
  accepted `2**53 + 2` and every integer above it — where `+` has already stopped being exact. A corpus could
  then carry sizes that each pass while the total is off by an arbitrary amount, in the arithmetic that
  decides §5.1's budgets. All three now use **`Number.isSafeInteger`** — what `windowProblems` in
  `lease-gates.ts` already holds the lease counters to — and `published.cjs` checks its **running** total
  too, because individually safe sizes can sum past the boundary. `cacheceiling.cjs` cannot reach it from its
  input (its per-entry contribution is capped at three windows, so it is bounded by the entry count and would
  need about three billion of them); the guard is kept because that cap is a property of the program, and a
  program's own invariant is what a later edit removes silently. Both facts are pinned by tests.
- **REFUSING `/` IN `pointer.artifactName` LEFT WINDOWS OPEN.** The first version of finding 7 read the
  pointer's `artifactName` and rejected a POSIX separator. On Windows `\` is a separator too: measured, a
  pointer naming `generation-..\..\..\outside\elsewhere.json` made that version **read an entry out of a
  file the manifest directory does not contain, and exit 0**. The name is now **derived** from `sequence` and
  `generationId` — both checked against the shapes `deriveGenerationId` and `artifactNameFor` actually
  produce, `gen_<32 hex>` and a non-negative safe integer — and the pointer's own `artifactName` must equal
  it. Traversal is impossible by construction rather than by blacklist, and the regression asserts the
  refusal comes from **that rule** rather than from `ENOENT`, since a path that merely does not exist would
  pass against no rule at all.

- **AND MOVING THE NEEDLES INTO A FILE INTRODUCED A THIRD ONE, WHICH IS THE POINT OF REVIEWING A DIFF.**
  The first version counted needles with `wc -l` and read them with a plain `while read`. Both drop an
  **unterminated final record**, so a nonempty one-needle file with no trailing newline counted **zero**
  needles, ran **zero** searches, and then agreed with itself at zero — `0 needles read of 0 expected`,
  `0 hits`, exit 0. Reproduced against the same secret in the same tree the terminated list finds it in:
  *"1 file(s) examined for 0 needle(s), 0 hit(s)"*, clean. A malformed needle list is precisely what a caller
  gets wrong, and it produced the friendliest possible answer. The helper now **refuses** a list that does
  not end in a newline and one that holds no complete needle, and a second regression asserts every needle
  file the five gates write is built by a newline-terminating `printf '%s\n'` — so the rule is a guard rather
  than a trap.

**AND THE SHARPEST TWO CASES DROP PRIVILEGES RATHER THAN SKIPPING, BECAUSE THE GATES ARE RUN AS ROOT.**
"A file the scan could not open" is a fixture root reads straight through, so on the tranche-closing host —
where these gates run as uid 0 — the case would have passed against the **unfixed** program just as readily
as against the fixed one, and a regression that cannot fail on the only machine that closes anything is not
one. The regression therefore spawns the shipped helper as uid 65534 when the suite is root, and both
unopenable-file cases are among the 23 host failures in the table above. Windows carries no POSIX mode and
cannot express the fixture at all; there it is **reported rather than judged**, which is §6.0's own
three-valued rule, and no claim is made from that silence.

**WHAT WAS CHECKED AND FOUND SOUND, because a loop that only reports findings is not an audit.** busybox
1.36.1's `du -b` really is apparent size (it is missing from the usage summary and present in the option
table, and was verified at 3,004,096 over a 3,000,000-byte file), so the probe-cache measurement is in the
unit it claims; busybox `grep -rlF` matches across NUL bytes, so the binary probe cache really is searched;
`cacheceiling.cjs`'s window and threshold are `PROJECTION_PROBE_PLAN.WINDOW_BYTES` and
`SINGLE_PROBE_BELOW_BYTES` exactly; every counter name the gates ask for exists at the endpoint; and the
`RESOLUTIONS >= 1` guard already fails closed on an absent field. `token.sh` in the rclone gate was examined
and no defect was found in it — its custody claim holds everywhere except call sites 2 above.

**NO THRESHOLD MOVED AND NO FAILURE BECAME A SKIP.** The one thing that is *reported rather than required* is
new: `leakcheck.sh` now prints how many files it examined, and the caller says whether that count has a
floor. It is 1 for the manifest directory, the daemon probe cache and every media server's library state,
and **0 for the rclone client's own cache and configuration** — that client is run `--vfs-cache-mode off` and
is entitled to write nothing there, and inventing a floor would be fitting a threshold to an expectation.
The count is in the output either way, so a scan of nothing is now visible where before it was silent.

**AND THE HOST RUNS SETTLED THAT SPLIT AS A MEASUREMENT RATHER THAN A JUDGEMENT.** Identically across three
fresh runs of each gate on the Unraid host:

| Scan root | Files examined | Needles |
|---|---|---|
| the published manifest directory | **3** | 7 |
| the daemon probe cache | **52** | 8 |
| each media server's library state (Jellyfin / Plex / Emby) | **22 / 396 / 46** | 4 |
| the rclone client's own cache | **0** | 3 |
| the rclone client's own configuration | **0** | 1 |

Zero hits everywhere. The last two rows are the point: **the naive client writes nothing into either
directory**, so those two checks were vacuous before this loop and had no way to say so — and had the floor
of 1 been applied there uniformly, it would have failed a *correct* run of G22 three times out of three. The
first three rows are comfortably above their floor, so requiring one there costs a correct run nothing.

**WHAT WAS RUN, AND WHAT WAS NOT.** On an isolated checkout at
`/mnt/user/appdata/catalog-phase1-heredoc-audit-2` on the same Unraid host, verified **byte-identical to the
committed tree by `sha256sum` over all 1,575 tracked files**:

**EVERY GATE WHOSE EXECUTABLE BYTES THIS LOOP CHANGED WAS RUN THREE CONSECUTIVE FRESH TIMES**, and each
assertion count is the one already on record for that gate — this loop moved none of them:

| Gate | Result | On record |
|---|---|---|
| `go:torbox-mount-gate:three` | **3/3, exit 0** | — |
| `go:real-provider-gate:fake` | **3/3, 33 assertions, 0 failed, 3 skipped** each, `RP7-own-run-directory-removed` and `RP7-own-mountpoints-removed` passing every run | §6.10: 33 / 3 skipped |
| `deploy/projection-torbox-real-gate.sh` | **SKIPPED (77)**, having contacted nothing | §6.10 |
| `go:lease-gate:three` | **3/3, 29 assertions, 0 failed, 0 skipped** each — with the corrected `identity.cjs` | §6.8: 29 |
| `go:jellyfin-dataplane-gate:three` | **3/3, 366 / 366 / 366 assertions, 0 failed, 0 skipped** | §6.3: 366 |
| `go:emby-dataplane-gate:three` | **3/3, 394 / 395 / 395 assertions, 0 failed, 0 skipped** | §6.3: 395 / 394 / 394 |
| `go:plex-dataplane-gate:three` | **3/3, 414 / 414 / 414 assertions, 0 failed, 0 skipped** | §6.3: 414 / 412 / 414 |
| `go:three-server-concurrency-gate:three` | **3/3, 64 assertions, 0 failed, 0 skipped** each | §6.3: 64 |
| `go:rclone-comparison-gate:three` | **3/3, 70 assertions, 0 failed, 0 skipped** each | §6.3: 70 |

The five media-server and comparison gates ran **sequentially, one at a time**, between 03:00 and 05:24 on
the host. Every run reported `cleanup: 0 mountpoints and no run directory left under the gate root`, and the
host's container, network, volume and catalog-mountpoint counts were sampled **between every gate** and were
identical at all six samples: **26 running / 42 total, 17 networks, 45 volumes, 0 mountpoints** under
`/mnt/user/appdata/catalog*`. No production media, service, Compose project, secret or unrelated network was
touched.

**THESE RUNS CHANGE NOTHING IN §6.1, AND SAYING SO IS THE POINT.** They are the validation this loop owed for
the bytes it edited — that the corrected programs do not fail a correct run — not new evidence about G7–G13,
G18 or G22, which were already recorded as run on this host. §6.1's rows are unchanged.

**AND IT CLOSES NOTHING.** No real provider endpoint was contacted, no operator corpus exists at either
approved path, and Phase 1 remains open on exactly that ground.

### 6.13 The third credential-free audit loop — the measurement primitives every verdict is computed from

**THE INVENTORY FIRST, BECAUSE THE PREVIOUS TWO LOOPS EACH FOUND WHAT THEY WERE LOOKING AT AND NOT WHAT THEY
WERE NOT.** `deploy/projection-*gate*.sh` carries **131 heredoc blocks**, which are **82 distinct programs** —
the difference is the copies, and the copies are the point: `jq.cjs` is byte-identical in **eleven** gates,
`leakcheck.sh` in five, `baseline.sh` in four plus a fifth that differs by one field, and `sha.cjs` exists in
three forms across eight gates. §6.11 executed six programs; §6.12 executed the shared
leak/cache/published/counters/scan/identity subset. **This loop took the tranche neither of them touched: the
primitives that turn a read into a number** — the digest helpers, the JSON field reader, the read-only
baseline, the seek probes and the concurrent-reader harness — **across all eleven gates.**

**EVERY FINDING BELOW WAS PRODUCED BY RUNNING THE SHIPPED BYTES**, the `.sh` helpers in the gates' own
digest-pinned `alpine@sha256:d9e853e8…` and the `.cjs` helpers under `node`, against fixtures built for the
purpose. Candidates were found by surveying the inventory; EVERY FINDING RECORDED HERE WAS CONFIRMED BY
EXECUTING THE SHIPPED BYTES, and the ones that survived reading but not execution are in the "checked and
found sound" paragraph below. The offline cases live in
`test/projection-gate-embedded-programs.ts`; the three programs that hard-code `/mnt` and `/out` cannot
honestly run on a developer's machine and live in the new `test/projection-gate-mount-programs.ts`, which
declares `requires: ["docker"]` so a host that cannot provide one is **told** rather than reporting a pass.

**LIVE AND LATENT ARE MARKED, AND THE DISTINCTION IS NOT A SOFTENER.** Two of these defects are reachable
with the gates' own present-day fixtures. The rest are held off today by an assertion or a literal elsewhere
in the gate — they are defects in the measurement, not in the current run, and calling them "live" would
overstate what was found exactly as calling them "theoretical" would understate it.

| # | Program | Copies / sites | What it did | Live? |
|---|---|---|---|---|
| 1 | `out/verify.sh` (publisher-mount) | 1 / 1 | The step headed **"a seek into each file returns bytes"** ran `dd … \| wc -c` **and nothing at all read the number**. `dd` reports success past EOF and its status is lost to the pipe regardless, so the count *was* the measurement and no one looked at it. Measured in the pinned image: a seek into **a file that does not exist** prints `0`, pipeline status 0, and the phase goes on to report every mutation refused and **exit 0** | **LIVE** |
| 2 | `out/stampede.sh` and its call site (lease) | 1 / 1 | Twenty concurrent readers each wrote `ok` or `fail` and **nothing ever opened one**: `--opens` was counted from the `.started` files, which the loop writes the instant it launches each job. `dd` exits 0 for a read landing past EOF, so a reader that moved **no bytes** wrote `ok` anyway. Measured: a 1 MiB object against readers seeking 4–80 MiB gives `started=20, ok=20, fail=0`. G25 divides one resolution by that count | **LIVE** |
| 3 | `sha.cjs`, ranged form | 3 gates / 6 ranged sites | A window at or past EOF **digested to `e3b0c442…b855`, the digest of the empty string, exit 0**. Measured on a 100 000-byte object read at offset 5 000 000. The gate computes its **expectation** with this program and then has the daemon serve the same window, so an unsatisfiable range degrades **both sides to that one value** and `--expect-sha` compares it against itself. A short read did the same thing more quietly | latent — the `> 3 MiB` fixture assertions keep today's windows in range |
| 4 | `jq.cjs` | **11 gates / 11 sites** | `raw += chunk` coerces each stdin Buffer with its own `toString()`, so a multi-byte character split across a 64 KiB read boundary became **two U+FFFD replacement characters**. Measured on an 800 KB document: **24 of them, exit 0, and a value that is not the value the document carried**. Every gate reads `test "$(field outcome …)" = "published"` through this program. A document that is not an object also answered `''` for **every** field — the shape of a field that is merely absent | latent — today's fixtures are ASCII. **The operator corpus Phase 1 closes against is not guaranteed to be**, and no such corpus exists yet to measure |
| 5 | `out/seekprobe.sh` (rclone) | 1 / 2 sites | `dd \| sha256sum` answered the empty digest for a read that produced nothing. The caller runs **this same program on both sides of its own comparison**, inside the mount and outside it, so the forward- and backward-seek assertions compare that one value against itself; only the third line is checked against a value recorded elsewhere. Separately, a `SEEK_BLOCK` of `0` makes the "forward seek past the middle" and the "backward seek to the start" **the same read** | latent — the large fixture keeps the block in range and non-zero |
| 6 | `out/baseline.sh` | 4 + 1 / 6 sites | `for target in "$@"` over an empty argument list runs its body zero times and falls off the end. Measured in the pinned image: **no arguments, no output, exit 0** — every property it exists to establish (regular file, not a symlink, not a `.strm`, mode 444) reported as holding for a set it never opened | latent — the callers' paths carry a literal prefix today |
| 7 | `objects.cjs`, lease and publisher forms | 2 / 5 sites | The four-gate sibling names an unmatched ref and exits 1; **these two did not**, and reached `object.sha256` on `undefined`. Fail-closed, but as a TypeError inside a helper rather than as "the endpoint is not serving the object this gate registered" | latent — fail-closed either way |

**WHAT THE CORRECTIONS DO, AND WHAT THEY DELIBERATELY DO NOT.** Every one refuses an input the program used
to absorb: a range the object cannot satisfy, a byte count of zero where bytes were claimed, an empty target
list, a document that is not an object, a reader that demanded nothing. **NO THRESHOLD MOVED AND NO FAILURE
BECAME A SKIP.** The publisher-mount seek is asserted at **greater than zero and no more** — a FUSE read may
legitimately return a short block, and turning that step into an exact-length check would invent a threshold
the gate never stated. The honest answers are unchanged and are pinned as such: the corrected `sha.cjs` still
returns the digest `node:crypto` computes over the same bytes and the same window, and that equality is
asserted rather than assumed.

**ONE OF THESE FIXES ALREADY EXISTED ONE PROCESS DOWNSTREAM, WHICH IS WHY THE PRODUCER MATTERS.**
`projection-plex-dataplane-cli.ts` says in its own comment that `--object-sizes` "used to `.filter()` out
anything that was not a finite positive number … and a shell variable that expanded to nothing an empty
list", and it now makes every such token fatal. `sizelist.cjs`, **the program that produces that flag**,
still performs exactly that filter — a size that fails to compute is dropped before the CLI can ever refuse
it. It is recorded here as **examined and not corrected in this loop**: the drop shrinks the ceiling rather
than widening it, so it is fail-closed on the budget, and correcting a producer whose consumer already
refuses the bad value deserves its own measurement rather than a ride on this one.

**MUTATION PROOF, measured against the final bytes of both trees, with the working tree restored
byte-identical after each swap** (the staged `git diff --cached -- deploy/` fingerprint `43ee3c7f90…`
reproduced after every revert, and each suite returned to its full pass count):

| Suite | Platform | against merge base `1e59255` | against this tree |
|---|---|---|---|
| `projection-gate-embedded-programs.ts` | Windows, Node 22, Git `bash` | **33 passed, 9 failed** | **42 passed, 0 failed** |
| `projection-gate-mount-programs.ts` | Linux, busybox 1.36.1, the gates' own pinned alpine | **4 passed, 2 failed** | **6 passed, 0 failed** |

All **eleven** failures are the defect cases; the controls beside them pass against both trees, which is what
makes them controls. **Two of the new cases initially passed against the merge base and were rewritten until
they did not** — the multi-byte fixture had been built with its characters on even offsets, where no read
boundary can fall inside one, so it came back perfect from the defective program; and the offset-validation
case passed on exit status alone, because NaN also reaches `createReadStream` and throws. Both now assert the
thing that actually changed. A third case failed against the *corrected* program for a fixture defect of its
own — a fill pattern with a period of 256 makes every 64 KiB block identical — and the fixture, not the
assertion, was corrected.

**AND THE CORRECTIONS THEMSELVES WERE REVIEWED, WHICH FOUND THREE DEFECTS IN THEM.** Two were caught only by
a second reader and one by re-reading my own diff, and they are recorded because a loop that audits shipped
programs and exempts its own patches is not applying its method:

- **The cumulative-overflow guard was defeated by the arithmetic it used to detect the overflow.** The ranged
  `sha.cjs` validated `start` and `length` individually as safe integers and then computed
  `start + length - 1`, so `MAX_SAFE_INTEGER` with a length of 2 passed both guards — the same
  individually-safe-but-cumulatively-unsafe class the previous loop corrected in `cacheceiling.cjs`. My first
  fix tested `!Number.isSafeInteger(start + length - 1)`, which does not work: `MAX_SAFE_INTEGER + 2` **rounds
  to 2⁵³** and subtracting one lands back on `MAX_SAFE_INTEGER`, which `isSafeInteger` then calls safe. The
  bound is now expressed with subtraction only — `length - 1 > Number.MAX_SAFE_INTEGER - start`, exact under
  the preconditions already checked — and nothing is added until the window is known to fit. The regression
  asserts the **diagnosis**, not just the status: without the check the program opens the stream, reads
  nothing, and blames the object for yielding too few bytes.
- **A `|| true` was missing where `pipefail` made its absence fatal.** The new lease-gate check counts the
  readers that returned bytes with `grep -lx ok …`, and `grep` exits 1 when it matches nothing — which is
  exactly the case the check exists to catch. Under this file's `set -euo pipefail` the gate died **at the
  assignment**, before the diagnostic naming the failed readers could run: still fail-closed, but reported as
  a nameless non-zero exit. The zero it produces is now judged rather than swallowed.
- **An unsupported certainty in the new comments.** The `jq.cjs` comment asserted that the operator corpus
  Phase 1 closes against *is* non-ASCII. No such corpus exists, so nothing has measured it; all twelve
  occurrences now say it is **not guaranteed** to be ASCII.

**WHAT WAS CHECKED AND FOUND SOUND, because a loop that only reports findings is not an audit.** `sha.cjs`'s
two range-free forms and `alive.sh` fail closed already; `probes.cjs` and `seekprobes.cjs` cannot pass an
empty probe set, because `transcode-soak-verify` gates `unprobed` at zero and floors the decoded seconds;
`--object-sizes` refuses an empty or non-numeric token fatally at the consumer; `probe.sh`'s missing
`pipefail` is harmless because a failed `wget` produces no `206 Partial Content` for `grep` to find and the
pipeline fails on grep's own status; and the index arithmetic in `probe-seeks.sh` and `probe-soak.sh` differs
between the two (`${index#0}` versus `sed 's/^seg-0*//'`) but both reach the same number through `Number()`
at the consumer.

**WHAT WAS RUN ON THE HOST, AND ON WHICH BYTES.** On an isolated checkout at
`/mnt/user/appdata/catalog-phase1-heredoc-audit-3` on the same Unraid host (7.2.3, kernel 6.12.54, Docker
27.5.1, Node 22.18.0), verified **byte-identical to the committed tree by `sha256sum` over all 1,576 tracked
files** — combined digest `d744c43668c9…`, zero differing files.

**THE SEQUENCE WAS SPLIT IN TWO, AND THE REASON IS PART OF THE EVIDENCE.** Reviewing this loop's own
corrections found three defects in them, two of which changed executable bytes AFTER the first checkout had
been hashed. The gates whose executable bytes moved — the lease gate and the three dataplane gates — were
therefore **discarded from the first sequence and run again** against a re-synced, re-verified tree. Every
other gate drifted only in COMMENT text inside `jq.cjs`, which alters no executed statement, so those runs
stand as taken. Naming which runs were thrown away is the point: a sequence that quietly kept them would be
reporting evidence for bytes that were not shipped.

| Gate | Result | On record |
|---|---|---|
| `go:torbox-mount-gate:three` | **3/3, exit 0**, none skipped | §6.12: 3/3 |
| `deploy/projection-torbox-real-gate.sh` | **SKIPPED (77)** — no operator corpus, having contacted nothing | §6.10 |
| `deploy/projection-real-provider-gate.sh` (real mode) | **SKIPPED (77)** — no provider corpus, having contacted nothing | §6.10 |
| `go:real-provider-gate:fake` ×3 | **3/3, 33 assertions, 0 failed, 3 skipped** each | §6.10: 33 / 3 skipped |
| `go:path-lifecycle-gate:three` | **3/3, 85 assertions, 0 failed, 0 skipped** each | §6.9 |
| `go:publisher-mount-gate` ×3 | **3/3, exit 0** | §6.1 |
| `go:rclone-comparison-gate:three` | **3/3, 70 assertions, 0 failed, 0 skipped** each | §6.3: 70 |
| `go:three-server-concurrency-gate:three` | **3/3, 64 assertions, 0 failed, 0 skipped** each | §6.3: 64 |
| `go:lease-gate:three` | **3/3, 29 assertions, 0 failed, 0 skipped** each — rerun on final bytes | §6.8: 29 |
| `go:jellyfin-dataplane-gate:three` | **3/3, 366 / 366 / 366 assertions, 0 failed, 0 skipped** — rerun on final bytes | §6.3: 366 |
| `go:emby-dataplane-gate:three` | **3/3, 395 / 394 / 395 assertions, 0 failed, 0 skipped** — rerun on final bytes | §6.3: 395 / 394 / 394; §6.12: 394 / 395 / 395 — this count varies by run |
| `go:plex-dataplane-gate:three` | **3/3, 414 / 414 / 414 assertions, 0 failed, 0 skipped** — rerun on final bytes | §6.3: 414 / 412 / 414 |

**EVERY ASSERTION COUNT IS THE ONE ALREADY ON RECORD FOR THAT GATE. This loop moved none of them**, which is
what "no threshold moved" has to mean when it is checked rather than asserted.

**THE LIVE CORRECTION IS VISIBLE IN THE HOST OUTPUT**, which is the whole point of calling it live. The
publisher-mount phase that used to print a bare number under "a seek into each file returns bytes" now
reports and asserts it, identically across all three runs:

```
--- a seek into each file returns bytes
    /mnt/Movies/Local One/Local One.bin at block 512 returned 1024 byte(s)
    /mnt/Movies/Remote Two/Remote Two.bin at block 2048 returned 1024 byte(s)
```

**THE HOST WAS LEFT AS IT WAS FOUND.** Every gate reported `cleanup: 0 mountpoints and no run directory left
under the gate root`. The host's container, network, volume and catalog-mountpoint counts were sampled
**before and after every gate** and were identical at every sample across both sequences:
**26 running / 42 total, 17 networks, 45 volumes, 0 mountpoints** under `/mnt/user/appdata/catalog*`. No
production media, service, Compose project, secret or unrelated network was touched, and the isolated
checkout was removed afterwards.

**AND IT CLOSES NOTHING.** Two gates skipped at status 77 having opened no socket, because **no real provider
credential and no operator corpus exists at either approved path**. The fake-provider runs exercise the
corrected programs and close nothing about a provider: a deterministic fake is not a provider. §6.1's rows
are unchanged, and Phase 1 remains open on exactly the ground §6.10 already names.

### 6.14 The fourth credential-free audit loop — the programs that decide what the corpus IS

**THE TRANCHE, AND WHY IT IS THIS ONE.** §6.11 executed six programs, §6.12 the shared leak/cache/published/
counters/scan/identity subset, §6.13 the measurement primitives. What none of them touched is the layer
those primitives measure THROUGH: the four programs that build the ~50-entry corpus and the document every
later phase is compared against — **`gen-corpus.sh`, `corpus.cjs`, `expect.cjs` and `sizelist.cjs`**. Every
scan barrier, every per-entry anchor assertion, every byte ceiling and the byte floor beneath it is a
comparison against something one of these four wrote. **None of them had ever been executed by a test.**

**THE INVENTORY, COUNTED RATHER THAN ASSUMED.** Eighteen copies across seven gates, which are **ten distinct
programs** at **thirty-one call sites**:

| Program | Copies | Distinct | Where |
|---|---|---|---|
| `out/gen-corpus.sh` | 5 | 1 program + 1 line | plex, emby, jellyfin, three-server, rclone — the rclone copy puts its LOCAL entries at the END of the run; everything else is identical |
| `corpus.cjs` | 4 | 2 | plex/emby/jellyfin are **one program in code** (only comment text differs); the three-server copy adds a large barrier object described through a shared helper |
| `expect.cjs` | 6 | 4 | plex/emby/jellyfin are **one program in code**; the three-server, rclone and path-lifecycle copies are three different programs that share the name |
| `sizelist.cjs` | 1 | 1 | plex only, two call sites |
| `seed-expect.cjs` | 2 | 2 | three-server (from arguments) and rclone (from the registration document) |

**EVERY FINDING BELOW WAS PRODUCED BY RUNNING THE SHIPPED BYTES** — the `.cjs` copies under `node`, the
`.sh` copies under `bash` and again under the busybox `sh` of the gates' own digest-pinned image, against
fixtures built for the purpose. Nothing here is a reading of the source that was not then executed.

**NOT ONE OF THE FOURTEEN IS LIVE, AND THAT IS STATED FIRST RATHER THAN BURIED.** §6.11 and §6.13 each found
defects reachable with the gates' own present-day inputs. **This loop found none.** Every one below is held
off today by a literal in the gate, by `set -euo pipefail` around the command substitution that feeds it, or
by a floor one process downstream. They are defects in what the corpus layer would do with a degraded input,
not in what it does with today's. Calling them live would overstate the loop; calling them theoretical would
understate a set in which **four separate programs report success over an artefact they did not produce**.

| # | Program | Copies / sites | What it did, MEASURED | Live? |
|---|---|---|---|---|
| 1 | `out/gen-corpus.sh` | 5 / 5 | With `total` empty or non-numeric, `[ "$i" -le "$total" ]` exits 2 — **and a command that fails as the CONDITION of a `while` is exempt from `set -e`.** The loop ended on its first evaluation, **not one file was written**, and the script printed `  generated  corpus files` and **EXITED 0**. `total=0` did the same without even the error line. The closing line echoed the **ARGUMENT** it was handed and never a count: `abc` in produced `generated abc corpus files` out | latent — `CORPUS_COUNT` and `CORPUS_LOCAL` are literals in all five gates |
| 2 | `out/gen-corpus.sh` | 5 / 5 | It never looked at what the encoder left. A stub exiting 0 having created three **empty** files produced `generated 3 corpus files` and exit 0; the zero-byte entries then fail their digest comparison forty steps later, inside a gate whose subject is a media server | latent — ffmpeg does write bytes today |
| 3 | `corpus.cjs` | 4 / 4 | `Number(totalRaw)` on anything non-numeric is NaN and `1 <= NaN` is false, so the walk ran **zero times**: it wrote an **EMPTY** `corpus-register.json`, an **EMPTY** `corpus-expected.json`, a `corpus-totals.json` reading `{entries: 0, localEntries: 2, remoteEntries: -2}`, printed `0` and **EXITED 0**. Every caller sends that `0` to `/dev/null` | latent — `corpus-check --min-entries 50/51` and `test "$CORPUS_TOTAL" -ge 48` floor it one process later |
| 4 | `corpus.cjs` | 4 / 4 | `localEntries` and `remoteEntries` were the **arguments**, restated in the output document as though they were findings — the header above them says all three documents come from one walk. `corpus.cjs work 2 4` wrote `remoteEntries: -2` at exit 0, and the plex gate spends that as `--entries "$(( CORPUS_REMOTE_ENTRIES + 2 ))"`, the denominator of the request budget, **with no floor anywhere beneath it** | latent |
| 5 | `corpus.cjs` | 4 / 4 | The published `sizeBytes` came from a **second `statSync`**, not from the bytes that were digested. The digest describes what the file was when it was read; the size describes what it is now. A manifest whose two fields can mean two byte streams | latent |
| 6 | `corpus.cjs` | 4 / 4 | `object.probes.map(…)` on an endpoint object registered without a probe plan — a **TypeError inside a property read** rather than a statement about the object. `ProbeOffsetsFor` returns nothing for a zero-length object, which is exactly the case | latent — fail-closed either way |
| 7 | `expect.cjs` (plex/emby/jellyfin) | 3 / 16 | `anchor: rest[i + 4] === 'anchor'` made **every other token mean "not an anchor"** — `anchored`, `Anchor`, an argument a shell dropped for expanding to nothing. Every consumer selects `entry.anchor === true`, so the per-entry anchor assertions (`EM3-…-size:`, `TS2-anchor:`, `RC2-anchor:`) **iterate zero times and record nothing**, while every aggregate beside them passes. Measured: exit 0, `anchor: false` | latent — all sixteen call sites spell it correctly today |
| 8 | `expect.cjs` (plex/emby/jellyfin) | 3 / 16 | `kind` was written straight through. `sizelist.cjs` selects `kind === 'http-range'` and `corpus-check --min-remote` floors that same count, so `htttp-range` removes the object from the byte **ceiling** and the byte **floor** together — and the floor is the assertion that the scan opened the entries | latent |
| 9 | `expect.cjs` (plex/emby/jellyfin) | 3 / 16 | `Number(size)` turned `''` into **0** and `'abc'` into NaN, which `JSON.stringify` writes as **`null`** — both what a shell hands over when the measuring command produced nothing. The digest was not checked at all. A duplicate key silently accumulated; a base document that is not an array was a **TypeError on `entries.push`** | latent — `corpusSelfProblems` refuses `sizeBytes <= 0` downstream and names the corpus rather than the measurement; **nothing anywhere checked the digest** |
| 10 | `sizelist.cjs` | 1 copy, 1 site, 2 windows | **The defect §6.13 recorded and deferred.** `if (Number.isFinite(size) && size > 0)` dropped an extra size, so `sizelist.cjs expected.json "" 9000000` returned `40000,50000,9000000` at exit 0 — the soak source simply gone — while `projection-plex-dataplane-cli.ts` says in its own comment that it made exactly those tokens fatal, which it cannot do for a token it is never handed | latent — `set -euo pipefail` makes today's `wc -c` substitutions fail rather than empty |
| 11 | `sizelist.cjs` | 1 copy, 1 site, 2 windows | The **corpus** side was never checked at all: `entry.sizeBytes` went straight into `join`, where `undefined` becomes an **empty token** — `[undefined, 4000000].join(',')` is `",4000000"`. `kind` was unchecked too, so a misspelling removed the object from the list in silence | latent |
| 12 | `expect.cjs` (rclone) | 1 / 1 | `canaryRef` and `barrierRef` were compared and never checked. A mistyped canary reference skipped nothing, so **the canary was written into the corpus expectation it exists to stay out of** — the one object this gate reads before the measurement. A mistyped barrier reference produced an expectation with **ZERO anchors at exit 0**, and `verify-corpus` then ran its per-anchor loop zero times for all three servers | latent — `RC2-corpus-size` catches the canary leak by exact count; **nothing catches the zero-anchor case** |
| 13 | `expect.cjs` (path-lifecycle) | 1 / 1 | `for (let index = 0; index + 2 < rest.length; index += 3)` walked whole triples and **silently dropped a trailing remainder** — its three siblings refuse one outright with `rest.length % 5`; this copy alone absorbed it. The entry it drops is the entry the barrier then never waits for, which is what the program's own comment says it exists to prevent. No arguments at all wrote **`[]`**, and a barrier over an empty expectation releases immediately | latent |
| 14 | `seed-expect.cjs` and `expect.cjs` (three-server) | 2 / 2 | The same unvalidated `Number(size)` and unchecked digest as #9, in two more programs that share neither its code nor its shape | latent |

**WHAT THE CORRECTIONS DO, AND THE ONE DIRECTION THAT MATTERS.** Every one refuses an input the program used
to absorb, by name, before it writes anything: a count that is not a count, a token outside a closed
vocabulary, a size or digest that did not measure, a reference that matches no registered object, a partial
argument group, an empty list. **NO THRESHOLD MOVED AND NO FAILURE BECAME A SKIP.** The happy-path output of
all ten programs is byte-for-byte what it was — asserted, not assumed, by a control beside every refusal
case, and `corpus.cjs`'s two derived counts reproduce the arithmetic they replaced exactly on every real
input (`localEntries` was `localCount`; `remoteEntries` was `total - localCount`, and on the three-server
copy `expected.length - localCount`, both of which the walk now counts to the same numbers).

**THE ONE FINDING THAT CHANGED A PREVIOUS LOOP'S CONCLUSION IS #10, AND IT IS RECORDED AS A CORRECTION TO
§6.13 RATHER THAN AS A NEW DISCOVERY.** §6.13 examined the same filter and left it, reasoning that dropping a
size **shrinks the ceiling** and is therefore fail-closed on the budget. That reading is half the story. The
same list is also the **floor** — `sizes.reduce((total, size) => total + Math.min(size, PROBE_WINDOW_BYTES), 0)`,
asserted with the note *"a scan that read less than that did not open the entries"*. Dropping a
four-megabyte soak source takes a whole 1 MiB probe window off the least a real scan could have cost, so a
scan that never opened that object still clears the floor. **That direction is fail-open**, which is why the
producer is corrected now instead of recorded a second time.

**AND THE CORRECTIONS WERE REVIEWED, WHICH FOUND ONE DEFECT IN THEM.** The first draft wrote the
`gen-corpus.sh` validation as `case … ) echo …; exit 1 ;;` — semicolon-joined arms. `test/projection-plex-dataplane.ts`
reads the shipped gate line by line and requires every deliberate exit on the default path to be a bare
`exit 1` or the skip status, and it **failed against my patch**: `the default path exits only to skip or to
fail: exit 1 ;;`. It is recorded because the repository's own invariant caught a patch written by the loop
whose subject is programs that do not check themselves. Three further assumptions were checked against the
producers rather than assumed: both fake endpoints emit `hex.EncodeToString`, so the new 64-hex digest rule
cannot reject a real registration; `manifest.ProbeOffsetsFor` returns an empty plan **only** for a
zero-length object, so the new non-empty rule cannot reject a real one; and every one of the sixteen `anchor`
call sites spells the token `anchor` or `plain`, which is why those are the two the vocabulary admits.

**CHECKED AND FOUND SOUND, WHICH IS PART OF THE RESULT.** `gen-corpus.sh` contains no pipeline, so the
absence of `pipefail` from its own `set -eu` costs it nothing. Its per-index pattern, tone and duration do
vary, and `corpus-check` asserts the resulting digests are distinct rather than trusting that they are.
`smallRemoteBytes` and `localBytes` are accumulated from the same walk that produces the entries and were
already findings rather than arguments. rclone's `out/seed-expect.cjs` already refused an unregistered seed
reference. `corpusProblems` matches by key and not by position, so nothing depends on the order these
programs emit. Byte totals are ~48 entries of ~40 KB beside a 105 MB fixture — four orders of magnitude
below the exact-integer boundary — and every byte figure the corrections touch is now checked with
`Number.isSafeInteger` rather than `Number.isFinite`.

**THE COPIES ARE NOW PINNED AS COPIES.** Three new tests assert that the five `gen-corpus.sh` copies are one
program but for the split line, and that the three dataplane copies of `corpus.cjs` and of `expect.cjs` are
one program in code with only comment text differing. §6.12 exists because one loop corrected `scan.cjs` and
left five shell siblings untouched; these assertions are what stops that happening to this tranche.

**MUTATION PROOF, measured against the final bytes of both trees, with the working tree restored
byte-identical after the swap** — `git hash-object` over all six changed gates reproduced exactly after the
revert, and both suites returned to their full pass counts:

| Suite | Platform | against merge base `4a762d5` | against this tree |
|---|---|---|---|
| `projection-gate-embedded-programs.ts` | Windows, Node 22, Git `bash` | **49 passed, 15 failed** | **64 passed, 0 failed** |
| `projection-gate-mount-programs.ts` | the gates' own pinned alpine, busybox 1.36.1 | **7 passed, 2 failed** | **9 passed, 0 failed** |

All **seventeen** failures are the defect cases. **Seven new cases pass against BOTH trees and are the
controls** — the happy-path output of each program, and the three copy-identity assertions — which is what
makes them controls rather than more of the same. One correction has **no dedicated case and is recorded as
such**: #5, the size taken from the bytes that were digested, whose disagreement branch requires a file to
change length between two syscalls and cannot be provoked offline without inventing a race the gate does not
run. It was reviewed and is asserted only by the control that the honest path still publishes the same size.

**WHAT WAS RUN ON THE HOST, AND ON WHICH BYTES.** On an isolated checkout at
`/mnt/user/appdata/catalog-phase1-heredoc-audit-4` on the same Unraid host (7.2.3, kernel 6.12.54, Docker
27.5.1, Node 22.18.0 on the host), verified **byte-identical to the committed tree by `sha256sum` over all
1,576 tracked files** at the moment the sequence started — combined digest `8c204d2e4fb8…`, **zero differing
files**. `node_modules` was taken from the previous audit checkout, whose `package-lock.json` hashes
identically.

**ONE FILE MOVED AFTER THAT POINT, AND IT IS THIS ONE.** The runs below were being written up while they
ran, so `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` is not byte-identical to the copy on the host — no gate
reads it, and it executes nothing. The claim that matters is stated over the files that *are* executed:
**the combined digest over the other 1,575 tracked files is `1ba5247851e3…` on both sides, zero differing**,
which is the same figure before the sequence, during it and in the committed tree. Saying "byte-identical"
without naming the exception would be the kind of unchecked claim this loop exists to remove.

**A FIRST SEQUENCE WAS STARTED AND DISCARDED, AND NAMING IT IS THE POINT.** It was launched against an
earlier checkout whose combined digest was `d2d7eb83c105…`. While its first gate was running, reviewing the
diff found a 137-character line inside the path-lifecycle heredoc — longer than any line that gate has ever
carried, whose own maximum is 113 — and wrapping it changed **executed bytes** under a run already in
flight. The sequence was stopped, the gate was sent `TERM` so its own trap cleanup ran, the host was
confirmed back at its production baseline, the tree was re-synced and re-verified, and **the whole sequence
was started again from the beginning**. Nothing from the first sequence is reported below. A loop that
quietly kept a run taken against bytes it then changed would be reporting evidence for bytes that were never
shipped, which is the failure §6.13 recorded for the same reason.

**EVERY GATE WHOSE EXECUTABLE BYTES THIS LOOP CHANGED, THREE CONSECUTIVE FRESH TIMES.** Six gates, eighteen
runs, run in one sequence with nothing else on the host:

| Gate | Result | On record |
|---|---|---|
| `go:path-lifecycle-gate:three` | **3/3, 85 assertions, 0 failed, 0 skipped** each | §6.9: 85 |
| `go:rclone-comparison-gate:three` | **3/3, 70 assertions, 0 failed, 0 skipped** each | §6.3: 70 |
| `go:three-server-concurrency-gate:three` | **3/3, 64 assertions, 0 failed, 0 skipped** each | §6.3: 64 |
| `go:jellyfin-dataplane-gate:three` | **3/3, 366 / 366 / 366 assertions, 0 failed, 0 skipped** | §6.3: 366 |
| `go:emby-dataplane-gate:three` | **3/3, 395 / 395 / 394 assertions, 0 failed, 0 skipped** | §6.3: 395 / 394 / 394; §6.12: 394 / 395 / 395; §6.13: 395 / 394 / 395 — **this count varies by run and has on every loop** |
| `go:plex-dataplane-gate:three` | **3/3, 414 / 414 / 414 assertions, 0 failed, 0 skipped** | §6.3: 414 / 412 / 414; §6.13: 414 / 414 / 414 |

**EVERY ASSERTION COUNT IS THE ONE ALREADY ON RECORD FOR THAT GATE. This loop moved none of them.** The one
figure that is not constant — Emby's — is not constant on any previous loop either, and the three values
seen here are drawn from the same {394, 395} the three previous records carry.

**THE CORRECTION IS VISIBLE IN THE HOST OUTPUT, WHICH IS WHAT MAKES IT MORE THAN A CLAIM.** The generator's
closing line used to echo the count it had been ASKED for. Across the eighteen runs it now reports a count of
files it opened and found non-empty, and the two values are exactly the two `CORPUS_COUNT` literals:

```
      9   generated 47 corpus files      (the three dataplane gates, CORPUS_COUNT=47)
      6   generated 48 corpus files      (three-server and rclone, CORPUS_COUNT=48)
```

**AND NOT ONE OF THE NEW REFUSALS FIRED.** Every corrected program ran at every call site in all eighteen
runs and rejected nothing: no `gen-corpus:` diagnostic, no "is not a whole number", no "anchor or plain",
no "no probe plan", no "not a sha256", no "budget over nothing". The corpora published were 50 entries
(plex), 51 (emby and jellyfin) and 50 (the shared three-server corpus), each clearing its own
`corpus-check --min-entries` floor. **A correction that refuses bad input has to be shown not to refuse good
input, and eighteen runs across six gates is that demonstration.**

**THE BYTES DID NOT MOVE UNDER THE SEQUENCE.** The combined digest over the 1,575 executed tracked files was
re-taken after the last run and is `1ba5247851e3…` — identical to the figure before the first run.

**THE HOST WAS LEFT AS IT WAS FOUND.** Its container, network, volume and catalog-mountpoint counts were
sampled **before and after every one of the six gates** and were identical at all twelve samples:
**26 running / 42 total, 17 networks, 45 volumes, 0 mountpoints** under `/mnt/user/appdata/catalog*` — the
same figures §6.13 recorded. Afterwards: zero leftover gate containers, zero leftover gate networks, zero
mountpoints, and the isolated checkout removed. No production media, service, Compose project, secret or
unrelated network was touched.

**AND IT CLOSES NOTHING.** No gate in this loop contacted a provider, and none could: the corrections are to
programs that describe a synthetic corpus, and the endpoints they are described against are the same
deterministic fakes §6.10 already says close nothing. **No real provider endpoint and no operator corpus
exists at either approved path.** §6.1's rows are unchanged, Phase 1 remains open on exactly the ground
§6.10 names, and nothing here is evidence about a real provider.

### 6.4 The gates that did not exist — now none of them

**A GATE THAT HAS NOT BEEN WRITTEN CANNOT BE RUN, AND SAYING SO IS NOT THE SAME AS SAYING IT FAILED.**
**This section used to list four gates. All four now exist and all four have run**, and every one is kept in
the table below with its result rather than deleted, because a row that quietly disappeared would read as
closure by omission. **Nothing in this section is missing any more.** That does NOT close Phase 1: §6.9
records what G27 measured, and the tranche stays open on the one ground that remains.

| Gate | State |
|---|---|
| **G24** lease expires mid-read | **RUN — 3/3 consecutive fresh Unraid runs**, 29 assertions per run, 0 failed, 0 skipped. `deploy/projection-lease-gate.sh`. |
| **G25** lease expiry does not stampede | **RUN — same sequence.** Exactly one resolution served twenty concurrent opens; the 21st, inside the cooldown, asked the resolver nothing and failed in 340–377 ms. |
| **G26** a refreshed response is held to every rule | **RUN — same sequence.** All four malformed shapes replayed after a refresh, zero bytes accepted from each; the disallowed origin was never contacted. |
| **G27** three-server half | **RUN — 3/3 consecutive fresh Unraid runs**, **85 assertions per run, 0 failed, 0 skipped**. `deploy/projection-path-lifecycle-gate.sh`, §6.9. The admission-refusal half remains closed offline by `npm run test:projection-publisher`, and this gate does not replace it. |

**§6.1'S `not run` NO LONGER APPLIES TO ANY ROW IN THIS SECTION.** What remains open is §6.9's closing
paragraph and the provider ground below, not a missing gate.

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
