# Projection Phase 1 — G18, the three-media-server high-concurrency scan

**What G18 says, verbatim** (`docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §5):

> All three servers scanning simultaneously: G14a–G17 still hold, unchanged.

**What runs it.** `deploy/projection-three-server-concurrency-gate.sh` — `npm run go:three-server-concurrency-gate`.
Three consecutive fresh runs: `npm run go:three-server-concurrency-gate:three`.

**What a pass here closes: NOTHING.** §6 of the acceptance plan says the media-server gates close on a Linux
or Unraid host. Every run of this gate so far has been on Windows / Docker Desktop, and the §6.1 table
therefore still carries **G18 as NOT RUN**. This document exists to say precisely what the gate does, what it
measured, and what it refuses to claim.

---

## 1. What this is not

**It is not a wrapper that launches the three existing data-plane gates.** Each of those stands up its own
PostgreSQL, its own publisher, its own daemon, its own mount, its own fake endpoint and its own corpus.
Running the three at once would demonstrate that three unrelated appliances can coexist on one laptop, which
is a fact about Docker Desktop and not about this product. Nothing in such a run would be shared, so nothing
in it would be about concurrency on **one** data plane.

**It is not a fourth media-server driver.** `src/ops/projection-three-server-concurrency.ts` opens no wizard,
creates no library, authenticates against nothing and knows no endpoint spelling. It delegates to the three
existing drivers, and an offline test refuses any media-server endpoint spelling appearing in its code.

**It is not a playback gate.** G8, G9 and G10 are the five-minute gates and they belong to the three
single-server documents. G18 as the acceptance plan writes it is about **scanning**, and this gate adds no
playback, no seek and no transcode. Nothing here decodes anything, which is why the media generator is chosen
for convenience rather than for independence — a point the three single-server gates cannot make.

## 2. What it actually stands up

| One of | Three of |
|---|---|
| PostgreSQL (own Compose project, own network, own port 5510, tmpfs storage) | media servers: **Plex**, **Jellyfin**, **Emby**, each pinned to the same digest its own gate pins |
| the production publisher, and one admitted generation carrying the whole corpus | library roots — the **same** `/media/projection/Movies`, inside the **same** bind of the **same** `mnt` directory |
| the production `projectiond` image, `/dev/fuse` + `CAP_SYS_ADMIN`, strict direct mount, `rshared` | server-specific start-up shapes, because the three images genuinely differ |
| the fake HTTP Range endpoint (`internal/fakeprovider`), in resolver mode, with a per-run lease secret | ordinary-file predicates, because the three servers describe a file differently |
| a ~50-entry corpus, one expectation document, one set of published sizes and digests | |

The three start-up commands are deliberately **not** unified. Jellyfin runs under `--user 1000:1000` with all
capabilities dropped. Emby cannot: its entrypoint is an s6 supervision tree that reads `UID`/`GID` and does
the setuid itself, so it needs `SETUID`/`SETGID`/`CHOWN`/`DAC_OVERRIDE`/`FOWNER` and no `--user`. Plex takes
`PLEX_UID`/`PLEX_GID`, needs no claim token, and must be addressed by **address** rather than by name because
it treats a request whose `Host` header it does not recognise as non-local and answers 401. A single
parameterised helper would have had to pick one of those three, and two of the three servers would not have
started at all.

## 3. How "simultaneously" is established

### 3.1 Not by starting three commands quickly

Three triggers landing inside a second is perfectly compatible with three scans that never overlapped: a fast
server can finish before a slow one starts. The **trigger spread is recorded** as a harness health check —
a large one means something is wrong with the harness — and it is deliberately not the evidence.
`TRIGGER_SPREAD_IS_NOT_OVERLAP_EVIDENCE` in `src/core/projection/three-server-concurrency.ts` is that
statement as a constant, and an offline test holds it.

### 3.2 By observation, on one clock

One process fires all three triggers together and then, on a shared tick, asks **all three servers** their own
present-tense "am I scanning right now":

| Server | The question it is actually asked |
|---|---|
| Jellyfin | `GET /ScheduledTasks` → the `RefreshLibrary` task's `State` is `Running` or `Cancelling` |
| Emby | the same key on the same endpoint — and *only* the state field, never a stale progress percentage |
| Plex | the section reports `refreshing`, or a library activity is outstanding at `/activities` |

A tick in which all three said yes is a sample of three simultaneous in-flight scans. **Three sequential scans
produce zero of those, by construction**, and the offline suite drives exactly that timeline and requires the
analysis to refuse it.

Three properties are required of the observation, and each closes a different way of overstating it:

- **at least three samples in ONE UNBROKEN RUN** — one is a point, and a point can be produced by two scans
  that touched at the edges, which is the closest thing to sequential that still technically overlaps;
- **that unbroken run must last at least two seconds** — so a burst of samples inside one tick cannot satisfy
  both the count and the duration;
- **a run is broken by any disqualifying sample and by any gap over twice the nominal tick (1 s)**, and its
  duration is **credited at most one nominal tick per gap** — so an observer that fell behind cannot charge
  the time it did not poll, and a run assembled entirely from ceiling-width gaps is credited half its wall
  span and cannot clear the floor. An earlier version allowed 2.5 s, five polling intervals, on the reasoning
  that a tick may be as wide as the simultaneity bound; that conflates how far apart the three answers
  *within one tick* may be with how many polls may go missing *between* ticks, and at 2.5 s three samples
  cleared the two-second floor with 120 ms of observation in a five-second span. Both floors used to be applied
  to TOTALS — a count of simultaneous samples anywhere in the window, and `last − first` across them called a
  span. Three simultaneous samples scattered across two minutes, with the servers observed *idle* between
  them, cleared both while nothing had overlapped for two seconds at any point. `last − first` is not a
  duration: it counts every idle, unreadable and imprecise sample in between as though it had been overlap,
  and it counts stretches in which nothing was sampled at all. The gap ceiling is derived as **twice the
  nominal tick — `2 × SAMPLE_INTERVAL` = 1 s, one missed poll and no more** — and it is strictly below the
  two-second duration floor, so a run cannot be assembled out of ceiling-width gaps and still clear it. On
  top of that, **each gap is credited at most one nominal tick** whatever the clock said, so a run whose
  ticks all ran late is credited half its wall span and needs twice as many samples: **unobserved time cannot
  become overlap duration**, even inside the tolerance. The totals are still reported, and the distance between them and the unbroken run is
  itself informative; so is the distance between the credited duration and the same run's wall span;
- **every tick's three answers within two seconds of each other**. A tick is not an instant. If the slowest
  answer arrived thirty seconds after the fastest, "all three said Running in this tick" is compatible with
  the first having finished before the last was asked. Wider ticks are counted as **imprecise** and can never
  count toward the simultaneous total, however unanimous they were.

A second, independent witness is required as well: **each server's own `ScanBarrier` must have seen its own
scanner in flight**. That barrier watches from inside the scan and refuses a fast-complete. Requiring both
means one broken instrument cannot carry the claim.

### 3.3 …and by a rendezvous, so the observation is not luck

Before any scan is triggered, one remote object's provider read is **held** at the fake endpoint. A scanner
that reaches that object stops there and waits, so the three arrive at their own pace and then coexist. The
object is the large fixture and its projected path sorts first in the namespace, so a scanner reaches it
early.

**Both bounds on the hold are derived from daemon constants, and respecting only one of them would still
break the run:**

| Bound | Derived from | Why |
|---|---|---|
| the endpoint's `--max-hold`, **4.5 s** | `PROJECTIOND_READ_POLICY.FIRST_BYTE_DEADLINE_MS` = 10 s, **and** `MAX_QUEUE_WAIT_MS` = 5 s, which it must be STRICTLY under | a held response that has not begun by the first-byte deadline is abandoned and the **read fails**, so a media server would catalogue a file it could not open — the gate would be manufacturing the defect it claims to measure |
| the blocking window, **3 s** | `PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS` = 5 s, **less the release overshoot** | held requests occupy the daemon's four per-endpoint slots, and a read that cannot get one inside that budget returns EIO — a longer hold would mis-catalogue forty-nine entries it has nothing to do with. It is 3 s rather than 4 because the arm window is timed from when this gate NOTICES a block while the backstop is timed from when the request actually blocks; see §3.4 |

**The backstop is strictly below the queue-wait budget, and an earlier version was exactly equal to it.** It
was 5 s against a 5 s budget while the text beside it claimed "strictly shorter". At equality the guarantee is
gone on the boundary: a read arriving an instant after another blocks would wait the entire budget and could
be refused admission — the very starvation the bound exists to prevent. The chain is now strictly ordered and
every term derived:

`arm 3,000 ms + release overshoot 500 ms ≤ backstop 4,500 ms < MAX_QUEUE_WAIT_MS 5,000 ms < FIRST_BYTE_DEADLINE_MS 10,000 ms`

**The overshoot term is why the arm is 3 s and not 4 s.** The arm window is timed from when this gate notices
a block; the backstop from when the request actually blocks. The barrier watchdog bounds the distance between
them at two of its own 250 ms periods — one to notice, one to act — and the arm window has to leave room for
it. `assertHoldChainIsFailClosed` checks the whole relation at module load, so a future edit to any single
term fails immediately rather than three real Docker runs later. See §3.4.

### 3.4 The two clocks, and the run that failed on the difference

**The endpoint's backstop is timed from when a request ACTUALLY blocks; this gate's arm window is timed from
when it NOTICES.** Those are different clocks, and the second lags the first.

**Run 2 of the first fully remediated sequence failed exactly there** — `holdTimeouts` moved to 1 while run 1
of the same sequence passed on identical code, because run 1 happened to detect the block one tick sooner. A
gate whose verdict depends on which tick a poll lands in is not measuring the data plane.

The fix has two halves, and the first alone was not enough:

- **the arm window leaves room for the lag** — 3 s, so that arm + overshoot still fits under the 4.5 s
  backstop, machine-checked at load by `assertHoldChainIsFailClosed`;
- **the release moved off the observation tick onto its own watchdog.** Moving only the *detection* to the
  top of the tick narrowed the lag and did not close it: the *release* still fired at tick granularity, and a
  tick is one sleep plus three server polls, each of which may take up to `SAMPLE_MAX_SPAN`. Worst case the
  release lands 2.5 s late — more than any arm window under the backstop can absorb. A release is a real-time
  safety action and must not queue behind unbounded work, so it no longer does: the watchdog polls the
  endpoint's own uncounted `/counters` on a 250 ms cadence and releases exactly when the window elapses.
  An executable regression drives the real function against a loopback endpoint with 1.5 s server polls and
  fails if the release is ever queued behind them again.

**The blocking clock starts when the watchdog first OBSERVES a request blocked, not when the hold is armed.**
(Not when the request blocks, either — that is the backstop's clock, and the gap between the two is exactly
what §3.4 is about. Measured across the three green runs, the arm window of 3 s produced an actual block of
3.1 s.) An armed hold nothing
has reached costs nothing and starves nobody, so it stays armed until a scanner actually arrives. Timing it
from the arming would have expired it before the first scanner got there on a slow host, and the gate would
then fail its own "a provider request was actually blocked" assertion for having been too careful.

**The hold runs for its whole window and is not released when the rendezvous succeeds**, which is the second
thing the first real run taught. The first version released the moment all three servers were seen scanning at
once; it worked, and it defeated itself — the hold came off, the three scans finished at three different
speeds, and the measured three-way overlap was **two samples spanning 0.75 s**, under the two-second floor.
Releasing on success destroys what success created. Those held seconds are not manufactured overlap: every
server in them is genuinely mid-scan, each one's own barrier says so independently, and a scanner waiting on a
provider read is exactly as in-flight as one walking a directory.

**The hold is not the evidence and this document will not pretend otherwise.** Three seconds is not long enough
to guarantee a three-way rendezvous on a slow host. What the hold does is make the observation likelier and
make the scans provably **cold**; the claim rests on the simultaneous samples.

## 4. How the window is kept cold

This is the other way a gate like this lies, and it is not hypothetical. **G19 of the acceptance plan says a
re-scan over an unchanged manifest issues zero ranged GETs** — a correct property of the product and a
catastrophe for this measurement, because a warm window satisfies every ceiling by doing nothing at all.

Three things make it cold, and all three are asserted:

1. **The corpus is published after every library exists.** Generation 1 is a single **local** entry, so the
   three libraries have a real directory to point at and the provider serves zero bytes for it.
2. **Plex's unavoidable creation scan is waited out explicitly.** Plex begins scanning a section as soon as
   it exists and nothing in its API asks it not to. The gate drives one explicit scan of the one-entry
   generation and waits for Plex's own barrier to say it settled, *then* publishes the corpus. Without this
   step Plex would catalogue part of the corpus before the concurrent scan was triggered.
3. **Two independent instruments say the window was cold**: the endpoint had served **zero bytes for any
   corpus object** before it opened, and the daemon's own `probeCacheBytes` **grew** across it. Plus a floor
   — at least one ranged GET per uncached remote entry — because a scan that reached the provider zero times
   scores perfectly against every ceiling in this gate.

   **The daemon-side check is a growth and not an emptiness, and that is a measured correction rather than a
   softening.** The first real run read **33,187 bytes** of scan-window cache immediately before the
   concurrent scan and nothing was wrong: the gate publishes a LOCAL seed entry on purpose — so Plex's
   unavoidable creation scan has something to find that costs the provider nothing — and a local passthrough
   entry's own byte-identity window lands in the same cache. An emptiness assertion would have failed every
   correct run. "The cache is empty" was never the property that mattered anyway; "no CORPUS window is in it"
   is, and the endpoint's per-object totals answer that exactly while the daemon's single aggregate cannot
   answer it at all.

**The readiness canary.** The endpoint's range semantics have to be checked before anything depends on them,
and the obvious way — one ranged GET against a corpus object — would put bytes on that object and destroy the
cold measurement before the gate had done anything. So the readiness probe reads a **canary**: an object
registered at the endpoint, never named by any generation, never visible through the mount. The window
assertion splits the run's bytes between the corpus and the canary and requires the canary's share of the
window to be **zero**.

## 5. G14a–G17 across the simultaneous window

The budgets are **imported, not restated**: `MEDIA_SERVER_BUDGETS` in
`src/core/projection/media-server-dataplane.ts`, the same object the three single-server gates hold. "Unchanged"
is the word the acceptance plan uses.

### 5.1 The order of the checks is the argument

| Order | Check | What it refuses |
|---|---|---|
| 1 | **Is the instrument trustworthy?** No counter fell across the window; both request partitions are exact; every served byte is attributed to a registered object; the per-object columns all have one entry per object | a counter that reset makes every ceiling pass by producing a small delta; a missing counter read through `?? 0` passes more comfortably still |
| 1b | **Every byte belongs to the shared corpus.** `corpusBytes + otherBytes == totalBytes`, and `otherBytes == 0` | a byte served for something this gate never published |
| 2 | **Was the window cold?** §4 above | a warm cache satisfying every ceiling by doing nothing |
| 3 | G14a, G14b, G15, G16, G17 | the amplification failures themselves |
| 4 | **Per object**, and the per-entry request shape | an aggregate pass hiding one object downloaded whole |

Anything short of step 1 holding **fails closed**. `parseProviderCounters` returns problems rather than a
snapshot, and the CLI refuses to assert a budget over telemetry it does not trust. There is no
`as ProviderCounters` cast anywhere in this gate, and an offline test refuses one: a cast over `JSON.parse`
makes a missing field `undefined`, every arithmetic on it `NaN`, and `NaN <= ceiling` is **false** — so a
budget over broken telemetry would pass.

### 5.2 The denominators, named

**G14a, G14b and G15 are the ACCEPTANCE PLAN'S OWN ceilings, imported from `PROJECTION_PHASE_1_BUDGETS`.**
G18 says G14a–G17 hold *unchanged*, so the multipliers are the plan's ×1.2 and the denominators are the
plan's:

| Gate | Ceiling | Against 43 remote entries |
|---|---|---|
| G14a | `⌈1.2 × (entries × SCAN_WINDOWS_PER_ENTRY)⌉` | 155 |
| G14b | `⌈1.2 × entries⌉` | 52 |
| G15 | `⌊1.2 × (probe window × SCAN_WINDOWS_PER_ENTRY × entries)⌋` | 162,319,564 |

**An earlier version of this gate asserted 258 and 258 instead**, using the three single-server gates' looser
×6 real-scanner multipliers and relegating the plan's own numbers to a note headed "bonus observation". The
measurements cleared both, which is precisely what made it easy to miss: nothing failed, and the gate was
still claiming a budget it had not checked. A gate that asserts 258 while §5 says 155 is not G14a unchanged;
it is a different budget wearing G14a's name. **There is no longer any flag by which the multiplier or the
window count can be supplied** — a `--windows` option used to exist, and a required acceptance gate that can
be weakened from a command line is not a required gate.

The looser real-scanner allowance is still **recorded**, because §5's own preamble says its numbers are
measured against a *synthetic* scan and are not evidence about a real media server's metadata pass. Both are
true. The required ceiling is the plan's; the other is reported so the distance is visible rather than argued
about.

**One denominator for three servers, not three.** One daemon serves all three, and its scan-window cache is
what the second and third scan read from, so a 3× denominator would be a budget nothing could ever breach.
That is a statement about the *denominator*, which the plan fixes as the entry count — not licence to move
the *multiplier*, which is what the earlier version had done.

**G15's stricter companion — bytes, per object.** The plan's flat ceiling above is asserted first and always.
Beside it, and never instead of it, the per-object model below is asserted too; on this corpus it is the
tighter of the two (116,514,941 against the plan's 162,319,564). Two bounds inside it, and the tighter one
binds per object:

- **Block geometry × the number of scanners.** `daemonBlockByteCeiling(size)` is
  `8 × min(4 MiB, size) + 3 × min(1 MiB, size)` — the daemon's own demand block, the daemon's own probe
  window, and the response-class caps measured across nineteen instrumented scan windows. It is re-exported
  from `plex-dataplane.ts` rather than copied, because two spellings of one geometry is how a gate ends up
  holding the daemon to a bound the daemon stopped having. Three servers scan independently and nothing
  *promises* that the second and third read from what the first cached — that promise is the thing under test
  — so the ceiling derivable without assuming the answer is three times the single-scanner envelope. It is
  loose on a small object, and it is loose **honestly**: a tighter number here would be a number fitted to a
  measurement.
- **The byte fraction, where it is the tighter of the two.** Above `PLEX_LARGE_FIXTURE.MIN_BYTES` (94 MiB)
  `MAX_SCAN_BYTE_FRACTION` = 0.5 binds instead. **This is the assertion that requires the cache to have been
  shared**: three independent scanners each paying a full ~35 MiB envelope is ~105 MiB against a ~49 MB
  allowance, so passing it is the statement that the second and third concurrent scans read what the first one
  cached. It is the reason the gate generates a 94 MiB+ fixture rather than reusing a small one.

The **aggregate** ceiling is the *sum of the per-object ceilings*, not a multiplier over a pooled size. A
pooled denominator lets the large entries pay for the small ones, which is exactly how a corpus of tiny files
hides a large object being downloaded whole.

**The sharing ratio** — what the window cost as a share of the three-independent-scanner worst case — is
**recorded and asserted on by nothing**. It is the interesting number, and a floor or ceiling on it would be
asserting an efficiency this gate has very few observations of.

**G16 — HTTP 429.** Zero. Asserted inside the window *and* as a whole-run invariant, because a delta lets a
429 in one window cancel against a window that did not include it.

**G17 — the connection cap, twice, with both denominators named and neither pretending to be the other.**

| Counter | Ceiling | Why that one |
|---|---|---|
| `peakConcurrent` — in-flight ranged requests | `PROJECTIOND_ADMISSION_LIMITS.PER_ENDPOINT_MAX_INFLIGHT_REQUESTS`, and the daemon config **sets** `maxConnections` explicitly | only the daemon's ranged requests reach this counter; `/counters` and `/control/*` do not go through the range path at all |
| `peakConns` — sampled on every **accept**, which is the sampling point G17 names | the looser `MAX_PEAK_CONNECTIONS` | it also counts **this gate's own** connections to the uncounted `/counters` surface, and judging the daemon against a number that includes the harness would be judging the harness |

### 5.3 The per-entry request shape

Bytes alone cannot describe a mix of requests, and one mix is a defect no byte total can see: an **oversized**
response — a body larger than a demand block, which is either a coalesced read or a full body answering a
ranged request. It has never been observed in nineteen instrumented windows, and its ceiling here is **zero,
unmultiplied by the number of scanners**, because three servers do not make one legitimate. Full and clipped
blocks share one cap, exactly as `PLEX_SCAN_ENVELOPE` says, because a clipped block is one round trip for at
most a demand block and is never dearer than a full one.

## 6. What each server is held to, and what is deliberately not unified

**One expectation document, three predicates.** The corpus, the published sizes and the digests are shared —
that is what makes this one library rather than three. What is not shared is how each server describes an
ordinary file:

| Server | "an ordinary file" is |
|---|---|
| Jellyfin | `Protocol: File`, not remote, non-empty container, **`LocationType: FileSystem`**, direct-play supported |
| Emby | the same minus `LocationType`, which **this server never sends** — `MediaSources[0].Type !== 'Placeholder'` replaces it |
| Plex | `accessible` **and** `exists` off a `checkFiles=1` response, which makes the server stat the file through the mount as it answers — a field family the other two do not have |

The one time this repository flattened those, the flattened predicate matched **zero of two** correctly
catalogued entries. Each server is therefore listed by its own driver and judged by its own predicate, and the
count that is asserted is `matched` — published keys present at the published size as ordinary files — so
"the scan found fifty things" cannot stand in for "the scan found the fifty things that were published".

## 7. Run record

**A gate existing is not a gate passing.** This section is the only place that says what has been run.

| # | Host | Outcome | Assertions | What it measured, or why it failed |
|---|---|---|---|---|
| 1 | Windows / Docker Desktop | **FAILED** at `TS1-simultaneous-samples`, 2 against a floor of 3 | — | **A real defect in this gate, found by running it.** The barrier was released the instant the three-way rendezvous was observed. It worked — all three servers were seen scanning at once — and releasing on success destroyed what success had created: the three scans then finished at three different speeds and the measured overlap was two samples spanning 0.75 s. It also measured **33,187 bytes of scan-window cache before the window** and would have failed the "the cache was empty" assertion, which was itself wrong: the gate publishes a LOCAL seed entry on purpose and a local entry's own byte-identity window lands in that cache. Both were fixed: the hold now runs for its whole bounded window, and the daemon-side cold check is a GROWTH rather than an emptiness |
| 2 | Windows / Docker Desktop | **PASSED** | 59, none failed, none skipped | the first green run, and the source of the numbers in §7.1 |
| 3–5 | Windows / Docker Desktop | **PASSED**, three consecutive fresh runs through the committed wrapper `npm run go:three-server-concurrency-gate:three` | 59 each, none failed, none skipped | wrapper exit 0, `3 of 3 consecutive … none skipped` |
| 6–8 | Windows / Docker Desktop | **PASSED**, a second wrapper sequence | 59 each, none failed, none skipped | wrapper exit 0 |
| 9–11 | Windows / Docker Desktop | **PASSED**, a third wrapper sequence | 59 each, none failed, none skipped | wrapper exit 0 |
| 12–14 | Windows / Docker Desktop | **PASSED**, a fourth wrapper sequence, against the tree exactly as committed at `974a7de` | 59 each, none failed, none skipped | wrapper exit 0 |

**Thirteen green runs and one failure, all on Windows / Docker Desktop, and the §6.1 table still reads NOT
RUN.** Twelve of the thirteen came through the committed three-consecutive-fresh-run wrapper, in four
sequences of three, with no edit to any tracked file inside a sequence. That is the repetition the acceptance
plan asks for — **on the wrong platform**. §6 of the plan says the media-server gates close on a Linux or
Unraid host, and none of these fourteen runs was one.

| 15 | Windows / Docker Desktop | **FAILED** at `TS3-cold-window` with `hold-lapsed: 1` | — | **The first run of the fully remediated gate, and a real defect in it.** The endpoint's backstop is timed from when a request ACTUALLY blocks; the arm window was timed from when the gate's polled `/counters` NOTICED. Run 15 detected the block one tick later than run 14 had and the release missed the 4,500 ms backstop. Fixed in `c677065`: the release moved off the observation tick onto its own 250 ms watchdog, and the arm window shortened to 3 s so arm + overshoot fits under the backstop. See §3.4 |
| 16–18 | Windows / Docker Desktop | **PASSED**, three consecutive fresh runs through the committed wrapper against `c677065` | **62 each, none failed, none skipped** | wrapper exit 0. The first green sequence of the fully remediated gate — see §7.2 |
| 19 | Windows / Docker Desktop | **PASSED**, against `9f1d4de` — the first run after the endpoint learned to count what its writes RETURNED | **64, none failed, none skipped** | see §7.3. The two extra assertions are the observed-column G15 and the body-outcome record; `TS3-G15-provider-bytes` is now `…-committed`, so a future run record must not be compared against 62 |
| 20–22 | Windows / Docker Desktop | **PASSED**, three consecutive fresh runs through the committed wrapper against `9f1d4de` | 64 each, none failed, none skipped | wrapper exit 0; the working tree was still clean at `9f1d4de` afterwards |

### 7.2 What the three remediated runs measured

Every figure below held **identically in all three runs** unless a range is given.

| | |
|---|---|
| assertions | **62** per run, **0 failed, 0 skipped** (the pre-remediation runs recorded 59; the extra three are the split continuous-overlap ids, the recorded media-server multiplier and the additional block-geometry G15) |
| **overlap** | **7 samples with all three servers scanning at the same instant, in one unbroken run**, credited **3.0 s** (wall 3.1 s), **0 runs broken by a gap**. Shorter than the pre-remediation 4.1–4.6 s **because the hold is now 3 s rather than 4.1 s** — the margin over the 2 s floor is 1.5×, which is real but thinner than before and is the number to watch |
| observation quality | 53–65 samples per run, 12 with two or more servers scanning, **0 too wide to describe one instant** (widest 0.02–0.03 s), **0 with a server that could not be read** |
| scan durations | Plex 26–32 s, Emby 7 s, Jellyfin 4 s |
| barrier | one provider request blocked, released after **3.1 s** every time — arm 3,000 ms plus ~100 ms of watchdog overshoot, against a 4,500 ms backstop — and **`holdTimeouts` 0** in all three |
| cold window | endpoint served **0 bytes** for any corpus object beforehand; daemon scan-window cache grew **33,187 → 5,093,165 bytes**; **47 ranged GETs covered 43 uncached remote entries** |
| per server | **50 / 50 matched** on Jellyfin, Plex and Emby, through each server's own predicate |
| **G14a** | **47** against the acceptance plan's **155** (`⌈1.2 × 43 × 3⌉`) |
| **G14b** | **43** against the plan's **52** (`⌈1.2 × 43⌉`) |
| **G15** | **13,205,874 bytes** against the plan's **162,319,564** — and against the stricter block-geometry sum of **116,514,941**, asserted in addition |
| G16 | **0** HTTP 429, in-window and whole-run |
| G17 | peak concurrent provider reads **4 / 4** (the configured per-endpoint cap, reached and not exceeded); peak connections on accept **6 / 8** |
| request shape | **0** oversized responses; every object inside 3× the per-entry envelope |
| sharing ratio | **0.076** of the three-independent-scanner worst case — recorded, asserted on by nothing |
| lease redaction | **43 access leases** minted per run; none found in the manifest directory, the probe cache or any of the three servers' library state; report **redaction-safe** |
| cleanup | the namespace was **gone** after the daemon stopped, in all three runs |

**These are Docker Desktop runs and they close nothing.** §6 of the acceptance plan says the media-server
gates close on a Linux or Unraid host. No run of this gate — remediated or not — has happened on one, no real
provider endpoint has ever been contacted, and the §6.1 table still carries **G18 as NOT RUN**.

**AND THE FOURTEEN EARLIER RUNS WERE AGAINST THE PRE-REMEDIATION GATE.** A coordinator review afterwards found five defects — per-object telemetry that was not fail-closed,
an overlap "span" that was not a duration, a preflight that ran after the `/dev/fuse` probe container, a
`report` that exited zero over a skipped assertion, and G14a/G14b/G15 asserted against the media-server
gates' ×6 multipliers instead of the acceptance plan's ×1.2 — and the fixes changed what the gate asserts.
Concretely:

- **the numbers in §7.1 are still what those runs measured**; nothing measured was invalidated, and every one
  of them clears the stricter canonical ceilings (47 ≤ 155, 43 ≤ 52, 13,205,874 ≤ 162,319,564);
- **the assertion count and several gate ids have changed.** Those runs recorded 59 assertions and ids like
  `TS1-simultaneous-samples`; the remediated gate records more, and the overlap ids are now
  `TS1-continuous-simultaneous-samples` / `-seconds`. A future run record must not be compared against 59;
- **the continuous-overlap floor has not been exercised against a live timeline.** The measured 9–10 samples
  over 4.1–4.6 s are continuous at the 500 ms tick rate — `(n−1) × ~510 ms` accounts for the whole span, and
  every run reported zero imprecise and zero unreadable samples — and the offline suite reproduces both
  shapes and requires them to pass. That is an argument from the retained aggregates, not an observation of
  the new code against a real timeline;
- **one runtime constant moved**: the endpoint's hard hold backstop, 5 s → 4.5 s, so that it is strictly
  below the 5 s admission queue-wait budget rather than equal to it. It governs only the crash path.

**Runs 15–18 settled that.** The remediated gate has now been run: one failure that exposed a real defect in
it, then three consecutive fresh green runs against `c677065`. The continuous-overlap floor has been
exercised against live timelines and holds at 1.5× margin.

**The row for runs 12–14 was necessarily written after they finished**, which is true of every run record and
is not a gap in this one: that edit changed this document and nothing the gate reads. Re-running after each
edit that records a run would not terminate.

**The numbers are stable across the nine wrapper runs**, which is what a deterministic corpus should produce:
provider bytes 13,205,874 in every run, 47 ranged GETs in every run, 43 resolutions in every run, the large
fixture at 0.109x in every run. What varied is timing: the three-way overlap measured **9 to 10 samples
spanning 4.1–4.6 s**, and Plex's scan took 25–32 s against Emby's 8 s and Jellyfin's 5–6 s.

### 7.1 What a passing run measures

| | |
|---|---|
| corpus | **50 published identities**, one generation, one mount, one endpoint — 43 remote (one of them the 105,406,871-byte barrier fixture) and 7 local |
| **overlap** | **9 samples with all three servers scanning at the same instant, in one unbroken run**, wall span **4.1 s** (credited **4.0 s** under the later rule — gaps of ~511 ms, each worth one nominal 500 ms tick), out of 61 samples. 13 samples had two or more. **0 samples were too wide to describe one instant** (widest tick 0.02 s) and **0 had a server that could not be read** |
| scan durations | Plex 30 s (55 samples in flight), Emby 8 s (13), Jellyfin 5 s (9) |
| trigger spread | 0 s — **recorded, and not the evidence** |
| barrier | one provider request blocked, held for **4.1 s**, **zero holds lapsed** |
| cold window | endpoint had served **0 bytes** for any corpus object beforehand; the daemon's scan-window cache grew **33,187 → 5,093,165 bytes** |
| per server | **50 / 50 matched** on all three, through each server's own predicate: zero missing, zero wrong-sized, zero not-ordinary, zero duplicated, zero unexpected |
| G14a | **47** ranged GETs against the acceptance plan's **155** |
| G14b | **43** resolutions against the plan's **52** |
| G15 aggregate | **13,205,874 bytes** against the plan's **162,319,564** — and against the stricter block-geometry sum of **116,514,941**, asserted in addition |
| G15 large fixture | **11,534,336 bytes = 0.109x** of the object's own length, against the x0.5 ceiling. Three independent scanners each paying a full envelope would have been 110,100,480 bytes and would have breached it |
| G15 per object | **0 breaches** across 43 exercised objects |
| G16 | **0** HTTP 429, in the window and across the whole run |
| G17 | peak concurrent provider reads **4 / 4** (the configured per-endpoint in-flight cap — held exactly at it); peak connections on accept **6 / 8** |
| request shape | **0** oversized responses; every object inside 3x the daemon's own per-entry envelope |
| sharing ratio | **0.076** of the three-independent-scanner worst case. **Recorded, asserted on by nothing** |

**The G17 reading is worth stating plainly: the in-flight cap was reached and not exceeded.** Four concurrent
provider reads against a configured cap of four is the admission limiter doing its job under three
simultaneous scanners, which is the only condition in this repository that has ever pushed it there.

### 7.3 The endpoint now counts what its writes RETURNED, and the two columns are identical here

**WHAT WAS WRONG.** `internal/fakeprovider` counted a response's **committed** payload length before writing
it and then did `_, _ = w.Write(payload)`, discarding both the byte count and the error. Every byte figure
this gate has ever reported — including the 13,205,874 in §7.1 and §7.2 — was therefore what the endpoint
**undertook to write**, not what its writes returned. That was found by a review of the sibling G22 gate,
where the same shape had supported a conclusion about delivery that the instrument could not carry.

**WHAT IS THERE NOW.** The write's own returned count and error, recorded in a second phase, per object and in
aggregate; completed and truncated body outcomes; and a live in-flight gauge whose non-zero value makes the
analysis **refuse** the snapshot rather than quote it. The gate's counter reads wait, boundedly, for that
gauge to reach zero. Deterministic Go controls drive an early client close on an 8 MiB body and require the
two columns to come apart, and a fully consumed body and require them to agree exactly.

**WHAT FOUR RUNS AGAINST `9f1d4de` MEASURED, and it is the reassuring answer:**

| | runs 19–22 |
|---|---|
| bodies written in full / abandoned part-way | **47 / 0**, in every run |
| **COMMITTED** bytes | **13,205,874**, in every run |
| **OBSERVED** application-write bytes | **13,205,874**, in every run |

**The daemon drains every body it asks for**, so the two columns are equal and every historical figure in §7.1
and §7.2 stands unchanged as both. That is a measurement, not an assumption — it is exactly what was
unmeasured before, and a topology whose client abandoned reads would have shown a gap here.

**THE CEILINGS DID NOT MOVE, AND ARE NOW ASSERTED TWICE.** G15 and the per-object byte bounds are checked
against the committed column — every assertion this gate has ever made, at the same numbers — **and** against
the observed column beside it, which is the acceptance intent when the question is bytes written. Observed can
never exceed committed, so adding the second check cannot weaken the first; it exists so the column that is
reported is also the column that is enforced, and `breachedObjects` fires on either.

**AND "OBSERVED" IS A PRECISE, LIMITED WORD.** It is the count `http.ResponseWriter.Write` returned: bytes the
application handler handed to the HTTP stack. **NOT** proof of peer receipt, **NOT** a TCP acknowledgement,
**NOT** exact wire bytes — chunked framing, headers and any TLS overhead sit outside it — and **NOT** provider
billing. `OBSERVED_BYTES_ARE_APPLICATION_WRITES` states that as a value, and the offline suite holds it.

## 8. What this gate does not prove

These are enumerated as data in `THREE_SERVER_NONCLAIMS`, printed by
`npx tsx src/ops/projection-three-server-concurrency-cli.ts nonclaims`, emitted by the gate itself at the end
of every passing run, and asserted by the offline suite — so an edit that quietly softens one fails a test
rather than a review.

- **A Docker Desktop pass is NOT Linux or Unraid closure and closes none of G7–G13 or G18.**
- **No run of this gate has ever happened on a real Linux or Unraid host.**
- **No real provider endpoint has ever been contacted.** The endpoint is the in-repository fake.
- **Per-server provider attribution is impossible here and is not claimed.** One daemon serves all three
  servers, so the endpoint sees the daemon and never the server behind a byte. Every byte is attributed to a
  corpus **object**; no byte is attributed to a **server**, and a gate that reported "Jellyfin cost N bytes"
  would be inventing a number. What is per-server is the catalogue evidence and the overlap evidence.
- **G22**, the rclone/WebDAV comparison control, is **NOT RUN** for tranche purposes. A gate for it now
  exists — `deploy/projection-rclone-comparison-gate.sh`, described in
  `docs/PROJECTION_PHASE_1_RCLONE_COMPARISON.md` — and has been run on Docker Desktop only, which §6 of the
  acceptance plan says closes nothing. It reuses this gate's observer, overlap analysis, floors and barrier
  rather than reimplementing them.
- **G27's three-server half** is not run.
- **Phase 1 remains open.**

Two further limits worth stating in full rather than leaving to be inferred:

- **The byte-fraction claim is tested on one object.** The 94 MiB threshold is where the fraction becomes the
  tighter bound; below it the daemon's own block envelope permits a whole-object read and asserting 0.5 would
  be asserting something no ceiling constrains. So exactly one entry in the corpus carries that assertion, and
  the other forty-nine are held to block geometry.
- **Nothing here decodes anything.** Every "the server catalogued this correctly" statement is about the
  server's own listing of size, container and file kind. The gate makes no claim about the bytes being
  playable; that is G8–G10, and it belongs to the three single-server gates.
