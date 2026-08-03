# Projection Phase 1 — G22, the rclone/WebDAV comparison control

**What G22 says, verbatim** (`docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §5):

> The same corpus behind an rclone/WebDAV mount, measured the same way. This is **evidence, not
> architecture**: it exists to record what the naive approach costs. It has no pass threshold.

**What runs it.** `deploy/projection-rclone-comparison-gate.sh` — `npm run go:rclone-comparison-gate`.
Three consecutive fresh runs: `npm run go:rclone-comparison-gate:three`.

**What a pass here closes: NOTHING.** §6 of the acceptance plan says G22 closes on a Linux or Unraid host.
Every run of this gate so far has been on Windows / Docker Desktop, and the §6.1 table therefore still carries
**G22 as NOT RUN**. This document exists to say precisely what the gate does, what it measured, and what it
refuses to claim.

---

## 1. What this is, and the first line is the important one

**It is a CONTROL, not a CANDIDATE.** `docs/ADR_002_PROJECTION_APPLIANCE.md` §2 rejected rclone over WebDAV as
production architecture, for three reasons that no cost figure touches:

- it puts a provider's URL space directly into the media server's view;
- its file identity is a function of the remote's path rather than of anything stable;
- a provider outage empties the mount, which a media server reads as a mass deletion.

That ADR kept it as a **test control**, in those words, and this gate is that control. **A cheap number here
would not reopen the decision, and an expensive one is not what closed it.** Nothing in this tranche replaces
`projectiond`, adds a source adapter, adds a frontend, or proposes one.

**It has no pass threshold, and that is enforced rather than promised.** Every comparative figure the gate
produces is emitted with a note and deliberately *without* a `measured`/`budget` pair — `GateResult` documents
those two as travelling together — so a figure cannot acquire a ceiling without somebody switching to
`withinBudget`, which an offline test refuses. The reason is not politeness. **An expensive number here is the
finding**, and a gate that failed on one would be a gate nobody could run to produce it.

**What does fail closed is everything that makes a number worth reading:** the mount works, the corpus is
exactly the corpus, all three servers use the same mount and really scan and really overlap, the telemetry is
coherent, monotonic and fully attributed, the window is cold, no credential leaks, every image is
digest-pinned, every wait is bounded, and cleanup succeeds. A measurement taken off a broken instrument is
worse than no measurement, because a comparison is exactly the kind of artefact a reader trusts without
re-deriving it.

## 2. The path topology under test, named exactly

```
deterministic WebDAV endpoint  ->  one read-only rclone mount  ->  ORDINARY read-only regular files
                               ->  three real, digest-pinned media servers on that one mount directory
```

| One of | Three of |
|---|---|
| the WebDAV endpoint (`projectiond/internal/fakewebdav`), serving the same ~50-entry corpus from files generated on this machine, with per-object request and byte telemetry | media servers: **Plex**, **Jellyfin**, **Emby**, each pinned to **the same digest the product's own gates pin** |
| one rclone mount — `rclone/rclone@sha256:d597…88afc`, v1.71.1 — read-only, `--vfs-cache-mode off`, fresh cache directory, `/dev/fuse` + `CAP_SYS_ADMIN`, `rshared` | library roots — the **same** `/media/projection/Movies`, inside the **same** bind of the **same** `mnt` directory |
| one corpus, one expectation document, one set of sizes and digests recorded before anything was mounted | server-specific start-up shapes and ordinary-file predicates, because the three images genuinely differ |

**What is deliberately absent, and the absence is half of what is being compared.** There is no manifest, no
admitted generation, no publisher, no PostgreSQL and no `projectiond`. The naive path has none of those.
Standing them up beside it would be measuring something nobody would ever deploy.

**The media-server digests are the product gate's digests, and that is load-bearing.** Every behavioural
finding the three drivers encode belongs to the version behind a particular digest. Pinning a different one
would mean the two sides of the comparison were not read by the same three servers, and the difference between
them would silently include the difference between two Plexes.

## 3. What "the same corpus" means, and how it is enforced

The corpus is **the same fifty identities** the product's three-server gate publishes: one seed entry, one
~105 MB barrier fixture whose projected path sorts first, and forty-eight small, individually distinct
generated files.

**The generator body is character-for-character the one in
`deploy/projection-three-server-concurrency-gate.sh`, and an offline test compares the two scripts rather than
trusting a comment.** Equal counts of differently generated files would not be the same corpus: the cost of
identifying a library depends on the bytes in it, and nothing downstream would have noticed.

**The local/remote split survives as a comment and not as a behaviour.** The product publishes six of the
forty-eight as **local passthrough** entries whose bytes never reach an endpoint. **This topology has no such
distinction** — everything a naive mount presents comes from the remote, because there is nowhere else — so all
fifty are served over WebDAV here. The report therefore rolls the figures up **both** ways:

- over the whole corpus, which is what the naive path actually costs; and
- over the **43** entries the product also fetches remotely, which is the only sub-total for which the two
  sides compare like with like.

A total-against-total comparison would charge the naive path for seven files the product never fetches, which
is a thumb on the scale in the direction this repository is least entitled to push.

## 4. How the window is kept cold

This is the way the gate could most easily lie, and it lies in the *cheap* direction, which is worse. A client
cache that had already been filled answers a scan without reaching the endpoint at all, and the naive path
would then be reported as costing a fraction of what it costs.

The mechanism is different from the product's — there the risk is the daemon's scan-window cache, here it is
the mount client's VFS and directory caches — and the shape of the answer is the same:

1. **The corpus is held back at the endpoint until every library exists.** Only the seed entry is visible
   before that. This is the topology's only analogue of a publish; a naive mount has no publish step at all,
   so the endpoint provides one. It changes nothing about what listing and reading the corpus then costs — it
   decides only *when*.
2. **Plex's unavoidable creation scan is waited out explicitly.** Plex begins scanning a section as soon as it
   exists and nothing in its API asks it not to.
3. **The client's cached listings are dropped explicitly, twice.** Once so the reveal is seen at a moment this
   gate chooses rather than somewhere inside the configured directory-cache window, and once more to undo the
   warming that the visibility check itself caused. **Neither is a tuning**: dropping a cached listing can only
   ever *add* metadata traffic to the measured window, never remove any.
4. **Five things are then asserted**, on two independent instruments on opposite sides of the wire: the corpus
   was **visible**; the endpoint had served **zero bytes** for any corpus object; the client's cache directory
   was **empty**; the window reached the endpoint **at least once per corpus object**; and a request really was
   **blocked at the barrier and released** rather than lapsing.

**The readiness canary.** The endpoint's range semantics have to be checked before anything depends on them,
and the obvious way — one ranged GET against a corpus object — would put bytes on that object and destroy the
cold measurement before the gate had done anything. So the readiness probe reads a **canary**: registered at
the endpoint, served from a path no library root contains, never visible to a media server. The window's bytes
are split between the corpus and the canary and the partition is checked, not assumed.

## 5. How "simultaneously" is established

**By the product gate's own observer, its own analysis and its own floors — not by a second implementation.**
G22 says the corpus is measured *the same way*, and the only way to mean that literally is for the measurement
to be the same function: a comparison whose two sides were observed by two implementations would include the
difference between the two observers, and nobody could subtract that out.

So `src/ops/projection-rclone-comparison.ts` re-exports `runConcurrentScans` and `allAdapters` from the
three-server driver rather than wrapping them, and the CLI takes `analyseOverlap`, `overlapProblems` and
`CONCURRENCY_RULES` from `three-server-concurrency.ts`. One process fires all three triggers together and asks
all three servers their own present-tense scan state on a shared tick; a tick in which all three said `Running`
is a sample of three simultaneous in-flight scans, and **three sequential scans produce zero of those**. The
floors are on one **unbroken run** of those ticks, credited at most one nominal tick per gap.

**Why a sequential window would matter even though nothing here has a threshold.** Three sequential scans cost
a shared mount client very different amounts from three concurrent ones. A run that labelled the first as the
second would be comparing the product's concurrent window against a sequential one and calling the difference a
property of the topology. So the overlap **fails closed** even though the cost does not.

**The rendezvous is the product gate's own hold, with the same arm window and backstop, imported rather than
chosen again** — so the two windows have the same shape. What is *not* inherited is the argument for the bound.
The product derives its ceiling from the daemon's admission limits, because held requests occupy the daemon's
per-endpoint slots. **This topology has no admission limiter at all** — that is one of the things being
compared — so the binding constraint here is the mount client's own IO deadline, which the gate sets explicitly
(`--timeout 30s`) and which a module-load assertion holds the backstop strictly under.

## 6. What is measured, and what cannot be

### 6.1 Measured and reported, with no threshold

| Figure | Why it is here |
|---|---|
| GETs served a body, split **ranged (206)** against **whole-body (200)** | the headline shape of the comparison. A client that asks for whole bodies where the daemon asks for ranges is the finding, and one combined total would erase it |
| **PROPFIND** (depth 0, depth 1, other), **OPTIONS**, **HEAD** | what a namespace costs when it is **discovered** rather than published. The product's topology has no equivalent figure, because its namespace arrives in one admitted manifest |
| **media bytes**, per object and in total, worst multiplier first | an aggregate is exactly where one file read forty times over hides — and on this topology that is the expected shape rather than a defect |
| **listing bytes**, counted separately and never folded into the media total | a PROPFIND answer is XML the endpoint authored; counting it beside media would make the most-quoted figure partly a function of how verbose the listing format is |
| **HTTP 429** observed | zero, and stated as a measurement that the client was never rate-limited rather than as evidence that a real service would not |
| **peak connections** (sampled on every accept) and **peak in-flight requests** | the first includes the gate's own polls of the uncounted counters surface; the second does not and is the one that describes the client |
| **scan duration per server** | recorded per server, like every other per-server fact here |
| **item identity and size per server**, through each server's own ordinary-file predicate | this is asserted, not merely recorded: see §6.3 |
| **cache and cold-state facts** — the client's cache directory before and after, its configured cache mode, its directory-cache window, its deadlines | so no figure above can be attributed to a bound the gate imposed without saying so |
| **the client's own accounting**, beside the endpoint's | see §6.2 |

### 6.2 The two instruments, and why they disagree

Everything the endpoint counts is **what the mount client asked for**. That is not the same as what the client
*did*: its own cache, its read-ahead, its chunk sizing and its request pacing all sit between a media server's
`read()` and a request arriving at the endpoint, and a byte the client fetched and discarded is
indistinguishable at that end from one it used.

So the client's own accounting is read from its remote-control surface and reported **beside** the endpoint's.
**Where they disagree, the disagreement is the finding, and neither is corrected to match the other.**

### 6.3 What is asserted rather than recorded

- **Every published identity, on every server, at the size recorded outside the mount, as an ordinary file**,
  through **each server's own predicate** — Jellyfin's `LocationType`, Emby's `MediaSources[0].Type`, Plex's
  `accessible`/`exists` off a `checkFiles=1` response. The one time this repository flattened those three, the
  flattened predicate matched zero of two correctly catalogued entries.
- **The overlap**, as §5 says.
- **The instrument**, as §1 says.
- **Seek and ordinary-file behaviour at the filesystem level**: a forward seek past the middle of the
  ~105 MB fixture, a **backward** seek to its start, and a whole-object read, each digest-compared against
  values read outside the mount. It runs **after** the measured window so its answer cannot appear inside the
  cost figures. **It is not G9** — ten decoded media-time seeks through a media server are a different claim
  and belong to the three single-server gates.

### 6.4 What cannot be measured here, said before anybody asks

- **There is no access-resolution figure, and it is ABSENT rather than zero.** G14b counts the product's
  exchange of a stable object reference for short-lived access material. **This topology has no such step,
  because its namespace IS its URL space** — which is precisely the property ADR 002 rejected it for. Printing
  a zero would read as an efficiency.
- **No byte is attributed to a media server.** Three servers read one mount served by one client process, so
  the endpoint sees the client and never the server behind a byte. A report that named one media server's own
  byte cost would be inventing a number. What *is* per-server is the catalogue evidence and the overlap
  evidence.
- **Nothing here decodes anything.** Playback, seek-under-load and transcode are G8–G10 and are not run on
  this topology.
- **The figures describe one configuration of one client.** `--vfs-cache-mode full`, a different
  `--vfs-read-chunk-size`, or a different `--dir-cache-time` would produce different numbers. The report states
  which configuration produced these.

## 7. Run record

**A gate existing is not a gate passing.** This section is the only place that says what has been run.

| # | Host | Outcome | Assertions | What it measured, or why it failed |
|---|---|---|---|---|
| — | — | — | — | *(no run has been recorded yet; see §7.1 once one has)* |

**Every run of this gate has been on Windows / Docker Desktop, and the §6.1 table of the acceptance plan still
reads NOT RUN.** §6 of the plan says G22 closes on a Linux or Unraid host, and none of these runs was one. No
real provider endpoint has ever been contacted — the WebDAV endpoint is the in-repository fake — and Phase 1
remains open.

### 7.1 What a completed run measures

*(filled in from a real run; see §7)*

## 8. What this gate does not prove

These are enumerated as data in `RCLONE_COMPARISON_NONCLAIMS`, printed by
`npx tsx src/ops/projection-rclone-comparison-cli.ts nonclaims`, emitted by the gate itself at the end of every
completed run, and asserted by the offline suite — so an edit that quietly turns a measurement into a
recommendation fails a test rather than a review.

- **This is a COMPARISON CONTROL and not an architecture.** Nothing measured here recommends rclone or WebDAV,
  and ADR 002 rejected that topology for reasons no cost figure changes.
- **G22 has no pass threshold**, so no figure here is a pass or a failure; what fails closed is the
  instrumentation, never the cost.
- **A Docker Desktop pass is not Linux or Unraid closure and closes none of G7–G13, G18 or G22.**
- **No run of this gate has ever happened on a real Linux or Unraid host.**
- **No real provider endpoint has ever been contacted.**
- **Per-server attribution is impossible here and is not claimed.**
- **The figures are what the endpoint was ASKED for**; the client's own accounting is a different measurement.
- **There is no access-resolution figure**, because this topology has no resolution step.
- **Nothing here decodes anything.**
- **Phase 1 remains open.**
