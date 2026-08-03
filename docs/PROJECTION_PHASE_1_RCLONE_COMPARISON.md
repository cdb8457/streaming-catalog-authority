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
   was **visible**; the endpoint had neither **promised nor written** a byte for any corpus object; the
   client's cache directory
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
| **media bytes, COMMITTED and OBSERVED**, per object and in total, worst multiplier first | an aggregate is exactly where one file read many times over hides — and on this topology that is the expected shape rather than a defect. The two figures are separate because a Content-Length is what a response PROMISED and a write count is what it DELIVERED, and for one release of this gate only the first existed while the report called it the second. See §7.3 |
| **listing bytes**, counted separately and never folded into the media total | a PROPFIND answer is XML the endpoint authored; counting it beside media would make the most-quoted figure partly a function of how verbose the listing format is |
| **HTTP 429** observed | zero, and stated as a measurement that the client was never rate-limited rather than as evidence that a real service would not |
| **peak connections** (sampled on every accept) and **peak in-flight requests** | the first includes the gate's own polls of the uncounted counters surface; the second does not and is the one that describes the client |
| **scan duration per server** | recorded per server, like every other per-server fact here |
| **item identity and size per server**, through each server's own ordinary-file predicate | this is asserted, not merely recorded: see §6.3 |
| **cache and cold-state facts** — the client's cache directory before and after, its configured cache mode, its directory-cache window, its deadlines | so no figure above can be attributed to a bound the gate imposed without saying so |
| **body outcomes**: how many bodies were written in full and how many the client abandoned part-way | it is the difference between the two byte figures, and it is a fact about how a media server reads rather than a defect |
| **the client's own accounting**, beside both endpoint figures | see §6.2 |

### 6.2 THREE instruments, and why no ratio between them is a provider cost

There are three numbers, not two, and an earlier version of this section had two and drew a conclusion from
their ratio that neither of them supported. See §7.3.

| Instrument | What it counts | Where it is measured |
|---|---|---|
| **committed** | the `Content-Length` each response promised, recorded before its first byte reaches the socket | at the endpoint |
| **observed** | what the write actually put on the socket, recorded after it returned, with whether it finished | at the endpoint |
| **the client's own** | what the mount client believes it passed upward | at the client's control surface |

**Committed minus observed is the ENDPOINT's optimism**, about reads the client asked for and then abandoned.
On this corpus that is the ordinary case: a media server opens the ~105 MB fixture, reads a header, and closes
the handle. **Observed minus client is the CLIENT's read-ahead and discard** — bytes it received and did not
pass upward. They have different causes, they are measured at different places, and **adding them together and
calling the sum a provider cost is what this document did for one release**.

All three are reported. **None is corrected to match another, and no ratio between them is claimed as what the
topology costs a provider.** The endpoint refuses to answer for the observed column at all unless every body
has finished writing — it publishes a live in-flight gauge for exactly that, and a snapshot taken mid-write is
rejected rather than quoted, because there the committed length is counted and the observed one is not.

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
| 1 | Windows / Docker Desktop | **FAILED** at the endpoint readiness probe | — | **A real defect in this gate, found by running it, and it never reached a measurement.** The readiness canary was named `Projection Canary.bin`, like everything else in this corpus, and the probe that reads it is a BusyBox `wget` which does not percent-encode a space in a URL. The whole corpus carries spaces and parentheses on purpose — and rclone escapes them correctly, which the endpoint's own unit tests and every later run confirm — but a readiness probe that failed on its own URL quoting is a gate that never gets as far as measuring anything. The canary was renamed; nothing else changed |
| 2 | Windows / Docker Desktop | **COMPLETED** | 63, none failed, none skipped | the first completed run. **Its assertion count is not the current gate's, and its figures are not quoted in §7.1**: reading this run showed that the per-object costs were reported by MULTIPLIER only, which named five small files at 21–26× and left the ~105 MB fixture — the overwhelming majority of the window's bytes — unnamed in the very report that produced the headline byte total. A second ordering, by bytes, was added, and the byte multiplier was made to print its own denominator, because this run's report gave a multiplier without one. Nothing it measured was invalidated; §7.1 quotes the nine wrapper runs instead, which report every denominator directly |
| 3–5 | Windows / Docker Desktop | **COMPLETED**, three consecutive fresh runs through the committed wrapper `npm run go:rclone-comparison-gate:three`, against the tree exactly as committed at `5cdf55b` | **66 each, none failed, none skipped** | wrapper exit 0, `3 of 3 consecutive … none skipped` |
| 6–8 | Windows / Docker Desktop | **COMPLETED**, a second wrapper sequence, same commit, no tracked file edited between them | 66 each, none failed, none skipped | wrapper exit 0 |
| 9–11 | Windows / Docker Desktop | **COMPLETED**, a third wrapper sequence, same commit | 66 each, none failed, none skipped | wrapper exit 0; the working tree was still clean at `5cdf55b` afterwards |
| 12 | Windows / Docker Desktop | **COMPLETED**, against `12ffef1` — the tree as finally committed | 66, none failed, none skipped | **a confirming run, and it is here because the nine wrapper runs predate the last commit.** That commit changed `.gitignore` and one offline assertion and nothing the gate reads, so it could not have invalidated them — but "could not have" is an argument and this is a measurement. Every figure landed inside the ranges §7.1 records: 981 ranged GETs, 1,832,756,755 media bytes, **17.077×**, 52 PROPFIND, 90,249 bytes of listing XML, the ~105 MB fixture at 1,794,384,634 bytes over 22 GETs, and the client accounting for 34,991,428 bytes over 880 transfers |
| 13 | Windows / Docker Desktop | **COMPLETED**, against `330a9e7` — the first run of the REMEDIATED instrument | 70, none failed, none skipped | **the run that showed how far off the retracted claim was.** 2,783,683,960 bytes COMMITTED against 120,343,984 OBSERVED, with 117 of 1,057 bodies abandoned part-way. See §7.3 and §7.4 |
| 14–16 | Windows / Docker Desktop | **COMPLETED**, three consecutive fresh runs through the committed wrapper, same commit, no tracked file edited inside them | 70 each, none failed, none skipped | wrapper exit 0, `3 of 3 consecutive … none skipped`; the working tree was still clean at `330a9e7` afterwards. §7.4 |

**Fifteen completed runs and one failure, all on Windows / Docker Desktop, and the §6.1 table of the
acceptance plan still reads NOT RUN.** Twelve of the fifteen came through the committed
three-consecutive-fresh-run wrapper, in four sequences of three, with no tracked file edited inside or
between them. **Runs 1–12 were taken with an instrument whose byte counter is now known to have measured
something other than what it was reported as — see §7.3** — and their COMMITTED figures stand as such. That is the repetition the
acceptance plan asks for — **on the wrong platform**. §6 of the plan says G22 closes on a Linux or Unraid
host, and none of these sixteen runs was one. No real provider endpoint has ever been contacted — the WebDAV
endpoint is the in-repository fake — and Phase 1 remains open.

**The rows for runs 3–16 were necessarily written after they finished**, which is true of every run record in
this repository and is not a gap in this one: that edit changes this document and nothing the gate reads.
Re-running after each edit that records a run would not terminate.

### 7.1 What the nine wrapper runs measured

Runs 3–11, on Windows / Docker Desktop, against the tree exactly as committed at `5cdf55b`, with no tracked
file edited inside or between the three sequences.

**Every figure below is RECORDED. None of them is a pass or a failure.** The column headed "the product, for
scale" is quoted from `docs/PROJECTION_PHASE_1_THREE_SERVER_CONCURRENCY.md` §7.2 — a **different gate, in
different runs, on the same host**. It is there so the distance is visible rather than argued about; it is
**not** a measurement this gate took.

#### Identical in all nine runs

| | this topology | the product, for scale |
|---|---|---|
| corpus | **50 identities**, one mount, one endpoint — all 50 served over WebDAV, because this topology has no local passthrough | 50 identities, 43 remote and 7 local |
| corpus's own total length | **107,316,990 bytes** | same corpus |
| per server | **50 / 50 matched** on Jellyfin, Plex and Emby, through each server's own predicate: zero missing, wrong-sized, not-ordinary, duplicated or unexpected | 50 / 50 on all three |
| corpus objects reached | **49 / 49** | — |
| **listing / metadata calls** | **52 PROPFIND**, every one **depth-1**; **0** OPTIONS, **0** HEAD; **90,249 bytes** of listing XML | **no counterpart**: the namespace arrives in one admitted manifest |
| access resolutions | **ABSENT** — this topology has no resolution step | 43 |
| whole-body answers | **0** — every GET carried a `Range` header and was answered `206` | 0 |
| HTTP 429 | **0** observed | 0 |
| mutating requests | **0** reached the read-only endpoint | — |
| overlap | **8 samples with all three scanning at one instant, in one unbroken run**, credited **3.5 s** (wall 3.6 s), 0 broken by a gap, 0 imprecise, 0 unreadable | 7 samples, credited 3.0 s |
| barrier | one request blocked, **0** holds lapsed | one blocked, 0 lapsed |
| cold window | endpoint served **0 bytes** for any corpus object beforehand; client cache directory **0 bytes** before and **0 bytes** after (`--vfs-cache-mode off`) | endpoint 0 bytes; daemon cache grew 33,187 → 5,093,165 |
| scan duration | Emby **7 s**, Jellyfin **5 s** | Emby 7 s, Jellyfin 4 s |
| seek | forward seek past the middle, **backward** seek to the start and a whole-object read all returned the bytes recorded outside the mount | — |
| credential | minted per run, in no argv and no environment value; found in **none** of the client's cache, the client's configuration, or any of the three servers' library state; report **redaction-safe** | — |
| cleanup | the namespace was **gone** after the mount client stopped | gone |

#### Varying across the nine runs

| | this topology | the product, for scale |
|---|---|---|
| **ranged GETs** | **911 – 1,064** | **47**, identical in every run |
| over the 43 entries the product also fetches remotely | **780 – 924** | 47 |
| **media bytes COMMITTED** (see §7.3) | **1,829,512,472 – 2,468,279,423** | **13,205,874**, identical in every run |
| over the 43 comparable entries, committed | **1,824,388,554 – 2,462,665,227** | 13,205,874 |
| **committed, as a multiple of the corpus's own length** | **17.047× – 22.999×** | — |
| the ~105 MB fixture, committed | **1,794,384,634 / 1,899,791,505 / 2,426,891,803 bytes** over **22 / 23 / 29** GETs — **17.023× / 18.023× / 23.024×** its own length | **11,534,336 bytes = 0.109×** |
| worst small object by committed multiplier | between **21×** and **27.9×** its own length, on a different file most runs | — |
| peak connections / in flight | **5 – 6** on accept, **3 – 4** in flight | 6 on accept, 4 in flight |
| Plex scan duration | **23 – 37 s** | 26–32 s |
| observation samples | **45 – 74** | 53–65 |

**The comparison, over the subset where the two sides fetch the same files.** 780–924 ranged GETs against
**47**, and 1,824,388,554–2,462,665,227 COMMITTED bytes against **13,205,874**. Those ratios — roughly 17–20×
the requests and roughly 138–186× the bytes — are divisions of the two measured numbers beside them and
nothing more. **Both sides of the byte ratio are committed lengths**, which is why they are comparable: the
product's endpoint counts its own traffic the same way. What neither side's figure is, is a delivery
claim — see §7.3.

### 7.2 The one thing that is NOT reproducible, and that is the finding

*(every byte figure in this section is a COMMITTED length; see §7.3)*

**The metadata cost is exactly reproducible and the committed byte cost is not.** Fifty-two PROPFINDs and 90,249 bytes
of listing XML, in all nine runs, over a corpus whose generator is byte-for-byte deterministic — confirmed
directly, by generating it twice and comparing every file's size. The media bytes over the same corpus, on the
same host, from the same commit, ranged from **1.83 GB to 2.47 GB**: a spread of **35 %**.

**It is not noise, and the per-object columns say exactly where it comes from.** The ~105 MB fixture was read
in one of exactly **three** patterns — 22, 23 or 29 ranged GETs, for 1,794,384,634, 1,899,791,505 or
2,426,891,803 bytes — and which pattern a run got accounts for essentially the whole spread. With
`--vfs-cache-mode off` and the default 128 MiB read chunk, a read at an offset fetches from that offset
onward and a **backward** seek re-opens the object from the new position; three media servers each probing a
~105 MB container, and how many times each happens to seek backwards in it, is the variable.

**So what the naive path ASKS FOR is a property of the RUN and not of the LIBRARY.** The product's own gate
reports 13,205,874 bytes and 47 ranged GETs in every one of nine wrapper runs, to the byte. This one cannot
be quoted as a single number at all — which is a more useful result than either endpoint of its range, and it
is the kind of thing only a repeated measurement finds.

**Nothing in this section is a threshold, and none of it decides anything.** ADR 002 rejected this topology
for reasons that are not in these tables: a provider's URL space inside the media server's view, file
identity that is a function of a remote path, and an outage that empties the mount. **A cheap number would not
have reopened that, and these expensive ones are not what closed it.**

### 7.3 RETRACTED: the "fifty-times" claim, and the instrument defect behind it

**Runs 1–12 carried a conclusion this document no longer makes.** It read: the endpoint served 1.83–2.47 GB
while the mount client's own accounting reported 33–38 MB for the same windows, a ratio of 50.8× to 64.8×,
and therefore *"a reader given only the client's own figure would understate what this topology costs a
provider by more than fifty times"*. It was called the single most useful thing this control had produced.

**It was not supported by the instrument that produced it.** The endpoint incremented its byte counters by
each response's **Content-Length, before the first byte reached the socket**, and then discarded both the
byte count and the error returned by the write. So the figure it called "served" was **what the responses
PROMISED**, not what was delivered — and a client that opens a large object, reads a header and closes the
handle is indistinguishable, in a counter like that, from one that consumed everything. On a corpus built
around a ~105 MB fixture read by three media servers, that is not a corner case; it is the expected shape,
and it is exactly where the run-to-run spread in §7.2 comes from.

**The gap therefore had at least two causes and the retracted sentence attributed all of it to one.**
Committed-minus-observed is the endpoint's own optimism about reads the client abandoned.
Observed-minus-client is the client's read-ahead and discard. Only the second was ever a statement about how
rclone behaves, and the two were being added together and reported as the first.

**What the figures in §7.1 and §7.2 still are.** They are **COMMITTED** bytes — what the client asked the
endpoint for, measured identically to the way the product's own endpoint measures its own traffic, which is
what makes the two sides comparable at all. Every one of them stands as that. **None of them is a delivery
claim**, and the request counts, the PROPFIND census, the per-server catalogue results, the overlap evidence
and the cold-state evidence are untouched by this.

**What replaced it.** The endpoint now counts both: `committedBytes` before the write and `observedBytes`
after it, per object and in aggregate, together with how many bodies finished and how many were abandoned,
and a live in-flight gauge so a snapshot taken mid-write is **refused** rather than answered. Deterministic
Go tests drive a client that reads 512 bytes of an 8 MiB body and closes, and require the two totals to come
apart; a control test requires them to agree exactly when the body is fully consumed. §7.4 is what the
remediated instrument measured.

**One thing this remediation did NOT change, stated so nobody has to rediscover it.** The product's own fake
endpoint, `projectiond/internal/fakeprovider`, counts its bytes the same way — before the write, discarding
the result. It is left alone here deliberately: its bodies are at most one buffered demand block rather than a
105 MB stream, its client is `projectiond` rather than a media server's prober so it does not abandon reads,
its figures are used as **ceilings** where over-counting is the safe direction, and **it draws no delivery
conclusion from a ratio against a client-side number** — which is the specific thing that made the same shape
wrong here. Changing it would also invalidate G18's recorded run figures. **It is a smaller instance of the
same defect and it is recorded rather than fixed under this tranche.**

### 7.4 What the remediated instrument measured, and how far off the retracted claim was

Runs 13–16, on Windows / Docker Desktop, against `330a9e7`. Run 13 is a standalone run; 14–16 are three
consecutive fresh runs through the committed wrapper, with no tracked file edited inside them. **70 assertions
each, none failed, none skipped.**

| | across runs 13–16 |
|---|---|
| ranged GETs | **959 – 1,057**, every one answered `206`; **0** whole-body answers |
| **media bytes COMMITTED** | **1,831,428,173 – 2,783,683,960** |
| **media bytes OBSERVED** | **94,316,026 – 120,343,984** |
| **as a multiple of the corpus's own 107,316,990 bytes** | **committed 17.065× – 25.938×; OBSERVED 0.878× – 1.121×** |
| bodies completed / abandoned part-way | **866 – 940 completed, 87 – 117 truncated** |
| the ~105 MB fixture | committed **17.023× – 26.023×**; **observed 0.543× – 0.766×** — fewer application-write bytes than the object's own length, in every run |
| over the 43 comparable entries | committed **1,826,340,081 – 2,778,909,482**; **observed 88,930,627 – 115,663,883**; over **820 – 941** GETs |
| the client's own accounting | **34,497,096 – 38,024,565 bytes** over **868 – 928 transfers** |
| everything else | unchanged from §7.1: 52 depth-1 PROPFINDs and 90,249 bytes of listing XML in every run, 0 HTTP 429, 0 mutating requests, 50/50 matched on all three servers, 8 samples / 3.5 s of three-way overlap, cold on both instruments, seek preserved, nothing leaked |

**THE RETRACTED CLAIM WAS WRONG BY ROUGHLY A FACTOR OF TWENTY, AND IN THE DIRECTION THAT FLATTERED THE
FINDING.** It said the client's own figure understates what this topology costs a provider by more than fifty
times. Measured properly, the endpoint **wrote** 94–120 MB while the client accounted for 34–38 MB: a ratio of
about **2.7× to 3.1×**, which is read-ahead and discard and is a real but ordinary property of a VFS. The
remaining ~23× was the endpoint's own optimism about reads the client had abandoned, and it was never a
statement about rclone at all.

**And the headline changes with it — but see §7.5, which retracts half of what this paragraph first said.**
Over the 43 entries both topologies fetch remotely, the product's own gate reported 13,205,874 bytes in every
run. This topology **committed** 1.83–2.78 GB, roughly **138–210×** that figure. It **observed** 88.9–115.7 MB
of application writes. **The second number is NOT comparable with 13,205,874**, and the first draft of this
paragraph compared them anyway: see §7.5.

**What did not change, and is the more durable half of the comparison.** The request count — **959–1,057
ranged GETs against 47** — is unaffected by any of this, because a request is a request whether or not its
body was drained. So is the metadata cost: **52 PROPFINDs and 90,249 bytes of listing XML** for a namespace
that is discovered rather than published, against a product topology that has no counterpart figure because
its namespace arrives in one admitted manifest. So is the absence of a resolution step, the per-server
catalogue evidence, the overlap evidence and the cold-state evidence.

**The run-to-run instability in §7.2 survives too, and now has a second dimension.** Committed still varies
17.065×–25.938×; observed varies 0.878×–1.122×. The same cause explains both — how many times each media
server happens to re-open the ~105 MB fixture and seek backwards in it — but the observed spread is far
narrower, which is itself informative: the client asks for wildly different amounts between runs and ends up
receiving roughly the corpus's own size every time.

### 7.5 RETRACTED AGAIN: the observed-to-committed comparison, and what "observed" is worth

**§7.4 first said this topology "received 88.9–115.7 MB … roughly 6.7× – 8.8×" against the product's
13,205,874, and called the second number "what a provider would transfer". Both halves of that are
withdrawn.**

**IT COMPARED TWO DIFFERENT QUANTITIES.** The 88.9–115.7 MB came from G22's then-new **observed** column. The
13,205,874 came from the product's own fake endpoint, `internal/fakeprovider`, which at that moment still
counted **committed payload length** — recorded before `w.Write`, with the write's result discarded, exactly
the defect §7.3 had just corrected on the other side. An observed figure over a committed one is not a ratio
of anything. **The committed-to-committed comparison in §7.4 was and remains sound**; the observed one was
arithmetic between two different instruments.

**AND "OBSERVED" IS A WEAKER WORD THAN THAT PARAGRAPH USED.** What both endpoints now record is the count
`http.ResponseWriter.Write` RETURNS: bytes the application handler successfully handed to the HTTP stack. It
is **not** proof of peer receipt, **not** a TCP acknowledgement, **not** exact wire bytes — chunked framing,
headers and any TLS overhead sit outside it — and **not** provider billing, which is a commercial artefact
rather than a byte count. So "received", "delivered" and "what a provider would transfer" are all wrong for
it, and this document no longer uses them for either topology.

**WHAT WAS DONE ABOUT IT.** `internal/fakeprovider` now carries the same two-column contract as
`internal/fakewebdav`: committed before the write, the write's own returned count and error after it,
per-object attribution for both, completed/truncated body outcomes, and a live in-flight gauge whose non-zero
value makes the TS analysis **refuse** the snapshot. G18's byte ceilings are asserted on **both** columns —
the committed assertion is every one that gate has ever made and its ceiling has not moved, and the
bytes-written bound is added beside it, which cannot weaken anything because observed can never exceed
committed.

**SO THE ONLY COMPARISONS THIS DOCUMENT MAKES ARE LIKE-FOR-LIKE:** committed against committed, observed
against observed, request counts against request counts. §7.6 is the observed-to-observed figure, measured on
both sides by instruments that now count the same way.

### 7.6 The like-for-like comparison, measured on both sides after the remediation

*(filled in from the runs recorded in §7 below)*

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
- **The endpoint reports COMMITTED and OBSERVED bytes as two separate figures**, and a committed figure is
  not a delivery claim. The client's own accounting is a third measurement, and **no ratio between the three
  is claimed as a provider cost** — see §7.3, where exactly that claim was retracted.
- **There is no access-resolution figure**, because this topology has no resolution step.
- **Nothing here decodes anything.**
- **Phase 1 remains open.**
