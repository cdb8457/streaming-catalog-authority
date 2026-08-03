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

- **at least three such samples** — one is a point, and a point can be produced by two scans that touched at
  the edges, which is the closest thing to sequential that still technically overlaps;
- **at least two seconds from the first to the last** — so a burst of samples inside one tick cannot satisfy
  both the count and the span;
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
| the endpoint's `--max-hold`, 5 s | `PROJECTIOND_READ_POLICY.FIRST_BYTE_DEADLINE_MS` = 10 s | a held response that has not begun by the first-byte deadline is abandoned and the **read fails**, so a media server would catalogue a file it could not open — the gate would be manufacturing the defect it claims to measure |
| the blocking window, 4 s | `PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS` = 5 s | held requests occupy the daemon's four per-endpoint slots, and a read that cannot get one inside that budget returns EIO — a longer hold would mis-catalogue forty-nine entries it has nothing to do with |

**The blocking clock starts when a request first blocks, not when the hold is armed.** An armed hold nothing
has reached costs nothing and starves nobody, so it stays armed until a scanner actually arrives. Timing it
from the arming would have expired it before the first scanner got there on a slow host, and the gate would
then fail its own "a provider request was actually blocked" assertion for having been too careful.

**The hold is not the evidence and this document will not pretend otherwise.** Four seconds is not long enough
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
3. **Two independent instruments say the window was cold**: the daemon's own `probeCacheBytes` was zero
   before the scan, and the endpoint had served **zero bytes for any corpus object**. Plus a floor — at least
   one ranged GET per uncached remote entry — because a scan that reached the provider zero times scores
   perfectly against every ceiling in this gate.

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

**G14a — ranged GETs.** `≤ MAX_SCAN_RANGE_MULTIPLIER × remote entries`. **One denominator for three servers**,
not three: one daemon serves all three, and its scan-window cache is what the second and third scan read
from. A 3× denominator would be a budget nothing could ever breach.

**G14b — access resolutions.** `≤ MAX_SCAN_RESOLUTION_MULTIPLIER × remote entries`, same reasoning.

**G15 — bytes, per object first and in aggregate second.** Two bounds, and the tighter one binds:

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

| # | Date | Host | Outcome | Assertions | Notes |
|---|---|---|---|---|---|
| _(to be filled by the first real run)_ | | | | | |

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
- **G22**, the rclone/WebDAV comparison control, is not run.
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
