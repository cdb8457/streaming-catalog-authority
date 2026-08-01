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
| **Fake remote** | ~50 entries served by an in-harness HTTP Range server | Amplification, concurrency, re-scan and duplicate-probe measurement. Deterministic, offline, and the only corpus a CI job runs against. |
| **Real provider** | **1–3 files the operator is legally entitled to**, supplied by the operator | Correctness of the real transport: real TLS, real redirects refused, real `Content-Range`, real `429` behaviour. Never in CI. Never a load test. |

The real-provider corpus is deliberately tiny. It exists to answer "does the HTTP Range adapter work against
a real endpoint", which is a **correctness** question and needs three files. Every **quantitative** question
is answered against the fake corpus, where the harness controls the answers and can assert on them.

## 3. Hard gates — namespace and metadata

| # | Gate | Passes when |
|---|---|---|
| G1 | **Manifest admission** | The three shipped generations admit; every one of the 25 adversarial fixtures is refused with its named problem; a refusal leaves the previously admitted generation serving. (`npm run test:projection-manifest-v1`) |
| G2 | **Metadata is local** | A full scan of the ~50-entry fake remote corpus issues **zero** database queries and **zero** provider requests for `getattr`, `lookup`, `readdir` and `statfs`. Counted at the harness's fake server and at the daemon's own counters. |
| G3 | **Stable metadata** | Across two scans, a generation swap, a source failover, a source-generation bump and a daemon restart, every entry's `inode`, `sizeBytes` and `mtime` are byte-identical. Asserted per entry, not in aggregate. |
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

## 5. Hard gates — amplification

Measured at the harness's fake HTTP Range server during one full scan of the ~50-entry corpus.

| # | Gate | Budget |
|---|---|---|
| G14 | **Request multiplier** | Provider requests **≤ 1.2x** the entry count. |
| G15 | **Byte multiplier** | Provider bytes **≤ 1.2x** (configured probe window x entry count). |
| G16 | **Rate limiting** | HTTP **429** responses observed: **0**. Not "few". Zero — a 429 means the admission limits did not hold. |
| G17 | **Connection cap** | Concurrent provider connections never exceed the configured per-endpoint cap, sampled at the server on every accept. |
| G18 | **High-concurrency scan** | All three servers scanning simultaneously: G14–G17 still hold, unchanged. |
| G19 | **Re-scan** | A second scan with an unchanged manifest issues **zero** provider requests — the probe-prefix cache already holds every byte a scan reads. |
| G20 | **Duplicate probe / single-flight** | Twenty concurrent opens of the same entry, each reading the same first chunk, produce **exactly one** provider request. |
| G21 | **Range discipline** | A fake server that answers a ranged request with a full-body `200` causes the source to fail immediately; bytes read from that response: **0**. A server that returns a short body, a mismatched `Content-Range`, or a total size disagreeing with the manifest is likewise failed. |
| G22 | **Comparison control** | The same corpus behind an rclone/WebDAV mount, measured the same way. This is **evidence, not architecture**: it exists to record what the naive approach costs. It has no pass threshold. |

**What G14–G21 measure, and what they deliberately do not.** These budgets are the **daemon's** traffic while
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
| **Linux CI (GitHub-hosted runner, containerized)** | G1, plus G14–G17, G19, G20, G21, G23 against the fake corpus with a **synthetic** reader driving the mount instead of a media server. FUSE is available in a privileged container; mount propagation into a *sibling* container is not reliably testable here. | G7–G13, G18, G22 — all require real media servers reading a mount they can see. G6's PostgreSQL-outage leg is automatable; its media-server assertion is not. |
| **Linux / Unraid real environment, operator-run** | Everything, including G7–G13, G18 and G22, and the real-provider correctness runs. | Nothing — but it is manual, so it is run at tranche close and before any release, not per commit. |

**This split is a statement about evidence, not a schedule.** A Windows green run is not a Phase 1 pass and
**SHALL NOT** be reported as one. The tranche closes on a Linux/Unraid run, three times.

## 7. What the harness must record

One redaction-safe report per run: gate id, verdict, and the measured number against its budget. Counts,
digests and gate ids only — no path, no locator, no object reference, no token, no media-server id, no
address. Same rule as every other report in this repository.

## 8. What Phase 1 explicitly does not do

- No write path of any kind, in the daemon or the manifest.
- No provider beyond a configured HTTP Range endpoint. No download creation, no link request the control
  plane did not put in a manifest.
- No operator UI, no packaging, no release, no Unraid template, no scheduler.
- No third source adapter, no second frontend, no metrics backend, no evidence-packet phase.
