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
| G15 | **Byte multiplier** | Provider bytes **≤ 1.2x** (probe window x scan windows per entry x entry count). |
| G16 | **Rate limiting** | HTTP **429** responses observed: **0**. Not "few". Zero — a 429 means the admission limits did not hold. |
| G17 | **Connection cap** | Concurrent provider connections never exceed the configured per-endpoint cap, sampled at the server on every accept. |
| G18 | **High-concurrency scan** | All three servers scanning simultaneously: G14a–G17 still hold, unchanged. |
| G19 | **Re-scan** | A second synthetic scan with an unchanged manifest issues **zero** ranged GETs and **zero** resolutions — the persistent scan-window cache already holds every byte such a scan reads, at all three windows, and survives a daemon restart. |
| G20 | **Duplicate probe / single-flight** | Twenty concurrent opens of the same entry, each reading the same first chunk, produce **exactly one** provider request. |
| G21 | **Range discipline** | A fake server that answers a ranged request with a full-body `200` causes the source to fail immediately; bytes read from that response: **0**. A server that returns a short body, a mismatched `Content-Range`, or a total size disagreeing with the manifest is likewise failed. |
| G22 | **Comparison control** | The same corpus behind an rclone/WebDAV mount, measured the same way. This is **evidence, not architecture**: it exists to record what the naive approach costs. It has no pass threshold. |

**What G14a–G21 measure, and what they deliberately do not.** These budgets are the **daemon's** traffic while
a library is scanned and played. They do **not** include the traffic the **control plane** spends computing
byte-identity probes when it produces a manifest — up to three probe windows per projected version, once,
at production time, and zero thereafter for an unchanged version. That cost belongs to manifest production
and is measured separately in G23; folding it into the scan budget would make a one-off look like a per-scan
cost and would hide a real regression in the scan path.

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
| G18 **High-concurrency scan** | **NOT RUN** for tranche purposes. A gate now exists and has been run on Docker Desktop only: `deploy/projection-three-server-concurrency-gate.sh` puts a real, digest-pinned Plex, Jellyfin and Emby on the SAME production mount, SAME admitted generation, SAME ~50-entry corpus and SAME fake endpoint, and observes all three scanning at the same instant. §6 says Docker Desktop closes none of G7–G13 or G18, so this column stays NOT RUN | same gate, same run, same platform — **NOT RUN** | same gate, same run, same platform — **NOT RUN** |
| G22 **Comparison control** | **not run** | — | — |
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
none of G7–G13 or G18 — and all fourteen predate a coordinator review that tightened what the gate asserts,
so the REMEDIATED gate has not been run on a real host at all.** The one failure is worth reading: it was the gate's, not the product's — the barrier
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
server behind a byte — every byte is attributed to a corpus OBJECT and none to a SERVER. **G22 is not run.
G27's three-server half is not run.** No real provider endpoint has ever been contacted, no run has ever
happened on Linux or Unraid, and **Phase 1 remains open**.

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
