# Projection Phase 1 — the Jellyfin data plane

**What this document is.** A description of a gate that runs. It is the first evidence in this product that a
**real media server**, rather than a shell with `sha256sum`, can scan, direct-play, seek and transcode out of
the projected mount. Everything below is asserted by `deploy/projection-jellyfin-dataplane-gate.sh` on every
run; nothing here is a plan.

**What it is not.** It is not Phase 1 closure, and it is not an evidence packet, a review gate or an
acceptance record. Plex, Emby, a real Unraid host and a real provider endpoint remain **entirely unproved**,
and `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6 is still the table that says where each gate can be
closed.

---

## 1. The distinction this repository has to keep straight

There are now **two** Jellyfin jobs here, and they prove different things.

| | The **control-plane** job (existing) | The **data-plane** job (this one) |
|---|---|---|
| What it talks to | a **fake** Jellyfin (`test/jellyfin-fake-server.ts`) | a **real** Jellyfin container, pinned by digest |
| What it exercises | collections, matching, outbox, privacy, URL policy | scan, direct play, seek, forced transcode, library churn |
| Media involved | none | a ~50-entry generated corpus plus one long soak source, read through a FUSE mount |
| Mount involved | none | the production `projectiond` image, strict-direct-mounted |
| Command | `npm run test:jellyfin-*` | `npm run go:jellyfin-dataplane-gate` |

Nothing about the control-plane job changed. A green control-plane run has never been evidence about playback
and still is not.

## 2. What the gate does, in order

1. **A real, migrated PostgreSQL** on its own throwaway instance, and the production write path —
   `ops:projection-register` — with one **local** and one **HTTP Range** stable source.
2. **Legal synthetic media, generated on the machine that runs the gate**, by the ffmpeg that ships inside the
   pinned Jellyfin image: ffmpeg's own `testsrc`/`testsrc2`/`smptebars` patterns and a sine tone, encoded to
   mp4. Nothing is downloaded, nothing copyrighted is touched, and no media fixture is committed. Each entry
   uses a different pattern, tone and duration, so no two are byte-identical — otherwise reading the wrong one
   would still match its digest.
2b. **A ~50-entry corpus of tiny files, and exactly ONE long source.** The corpus answers G7, which is a
   question about fifty identities rather than about bytes; the long source answers G8, G9 and G10, which need
   a duration and only need one. Keeping them separate is what lets the corpus stay cheap enough that nobody
   is tempted to shrink it. See §3.4.
3. **Digests and byte lengths recorded outside the mount**, before anything is published.
4. **The production publisher**, and a pointer whose digest is verified against the artifact file.
5. **The already-merged production `projectiond` image**, strict-direct-mounted with `/dev/fuse`,
   `CAP_SYS_ADMIN` and nothing else, its namespace bind-propagated to sibling containers.
6. **Jellyfin, non-root, as an ordinary container**, stood up non-interactively through its own `/Startup/*`
   first-run API — not by forging a config file — and given the mount as a Movies library root.
7. **A real scan**, then direct play, a real HTTP seek and a forced transcode over the first small generation.
8. **The ~50-entry corpus published on top of it**, scanned and re-scanned with zero churn of any kind. The
   projection-restart evidence is the `SIGKILL` path in step 10, for the reason in §3.8.
9. **The five-minute half**: ten media-time seeks, five minutes of paced direct play, and five minutes of
   paced, continuously decoded transcoded playback.
10. **The violent half**: a mid-stream generation swap, a `SIGKILL` of the daemon mid-stream, a daemon
   restart, a media-server restart, a generation admitted mid-scan, a provider outage, and more scans.

## 3. The assertions, and why each is worth making

| Gate | What passes |
|---|---|
| `JD1` / `JD2` | The server is stood up through its own API and the library points at the projected mount. |
| `JD3` | Every published entry appears, with **the size the control plane published**, and Jellyfin's own view of it is an **ordinary file** — `Protocol=File`, `LocationType=FileSystem`, `IsRemote=false`, a real container, not a `.strm` placeholder and not a symlink. |
| `JD4` | Direct play (`static=true`) returns the file's bytes, digest-compared against the value recorded outside the mount, for **both** the local and the HTTP Range entry. This is evidence about **bytes**, not about authorization — see §3.1. |
| `JD5` | A ranged request answers **206** with the exact `Content-Range`, asserted **before the body is read**, and the bytes match a window hashed on the host. A 200-with-the-whole-file cannot pass as a successful seek. |
| `JD6` | A forced transcode, proved by **decoding what came out**: the media is encoded as `mpeg4`, `h264` is demanded, and the segments Jellyfin produced are ffprobed and must be `h264` with decodable packets. |
| `JD7` | **One HTTP response body**, opened once and deliberately left partially consumed, is still mid-delivery when a successor is admitted — and then completes **from that same response**, with the digest taken over everything it delivered. A measured share of the file must arrive *after* the event, so a pre-buffered body cannot pass. Across a daemon `SIGKILL` that same held-open stream is permitted to fail; that outcome is recorded as `JD7-open-stream-interrupted`, is explicitly **not** counted as generation-pinning evidence, and resumability is asserted separately by a new request. |
| `JD8` | After the daemon restarts and remounts, playback is **resumable** and the bytes are still the published ones. |
| `JD9` | What one scan cost at the provider: ranged GETs, resolutions and **bytes as a fraction of the object's own length**. This is the budget that carries the product's argument — a scanner that downloaded the file to identify it would sit at 1.0. |
| `JD10`–`JD13` | Across a successor, a daemon crash and recovery, a media-server restart and a plain re-scan: **zero removals, zero duplicates, zero item-id churn and zero metadata drift**. Identity, not just presence — a server that re-created an item under a new id has lost every piece of watch state attached to it. |
| `JD14` | A re-scan of an unchanged generation costs the provider **zero** ranged GETs and **zero** bytes. |
| `JD15` | Across the **whole run**, not merely one window: zero 429s, zero full-body answers to a ranged request, and a peak connection count under the cap. |
| `JD16` | A generation admitted **while a scan is running**. What the raced scan saw is recorded, not asserted — it may legitimately have seen either generation — but nothing half-formed may appear in it, and the next scan must converge on the successor with zero removals and zero item-id churn. |

**The remote entry's `moov` atom is deliberately at the end of the file.** With `+faststart` the index sits in
the first few kilobytes and a scanner identifies the file from its head alone — which would leave the
contract's **tail** probe window unexercised by any media server, and a great many real files are not written
that way. Leaving the index at the end forces the scanner to seek to the far end of an object it is reading
over HTTP Range. Measured: **two ranged requests and 2 MiB** to identify a 13.9 MB object, or 15 % of it.
There is a **floor** as well as a ceiling on that number, because a scan that reached the provider zero times
would score perfectly against every ceiling and would mean the entry was never opened.

**A source outage is not a deletion.** The provider is stopped outright. The entry stays visible with a
byte-identical size, inode and mode; a publish over the unmoved catalog is still a no-op with zero deletions,
so **no transient outage can produce a smaller published generation**; and once the provider returns, reads
through the media server are correct again.

| `JD16` | A generation admitted **strictly inside a running scan**, made deterministic rather than raced — see §3.2. The scanner is confirmed running immediately *before* the publish and again *after* it returns; what the raced scan saw is recorded, not asserted; nothing half-formed may appear in it; and the next scan must converge with zero removals and zero item-id churn. |
| `JD9b` | What a **~50-entry** scan cost at the provider, with **both denominators named** — see §3.4. |
| `JD13b` | A plain re-scan over the ~50-entry corpus: zero removals, zero additions, zero duplicates, zero item-id churn and zero metadata drift. The projection-RESTART evidence is `JD11`, the crash path, for the reason in section 3.8. |
| `JD18` | **Five minutes of direct play, paced** — see §3.5. |
| `JD19` | **Ten media-time seeks**, backwards and past 90 % of duration — see §3.6. |
| `JD20` | **Five minutes of paced, continuously decoded, transcoded playback** — see §3.7, including the one thing it deliberately does not claim. |

Alongside them, outside the driver: every mutation attempted from **inside Jellyfin's own non-root container**
is refused; the mount is deliberately **not** bound `:ro`, so what refuses the write is the daemon and not a
Docker flag. The probe cache is additionally bounded in size, because a read path that started writing whole
objects through it would pass every substring check ever written.

## 3.2 How the mid-scan window is made deterministic

Proving something happened *while a library scan was running* against a real media server is otherwise a
race. A four-entry Jellyfin scan takes a couple of seconds, and the handshake that observes it, publishes, and
re-checks costs about as long — so the first honest version of this step failed with *"the scan finished
before the mid-scan publish could land."* Retrying until the timing works is a coin flip with a loop around
it, not evidence.

So the scan is made to **block on something the gate controls**:

1. A **brand-new remote entry** is published first. It has to be new: anything already scanned has its probe
   windows cached, and `JD14` asserts a re-scan costs the provider nothing — so a hold on an existing entry
   would never be hit.
2. The fake endpoint is told to **hold** ranged reads of that object. The scanner's `ffprobe` blocks in an
   uncached provider read, and the scan is now deterministically still running.
3. The scanner is confirmed running, the successor is published, and the scanner is confirmed running
   **again**. Both edges of the window are observed; neither is assumed.
4. The hold is released and the scan completes normally.

Three things stop this from being decorative, and the first is the one that took a review to get right.

**A live gauge, not a lifetime counter.** The endpoint originally reported only `heldRequests` — how many
requests had *ever* entered a hold. That number stays up after the hold's bound fires and the request
proceeds, so the gate could have announced that a provider request was blocked across the publish when
nothing had been blocked for some time. It now also reports `currentHeldWaiters` (how many are blocked at
this instant) and `holdTimeouts` (how many holds lapsed rather than being released). The gate waits for the
gauge to **rise** before it claims anything, requires it to still be up **after** the publish, and requires
**zero timeouts across the window** — because a waiter that lapsed and a fresh one that replaced it would
leave the gauge looking unchanged over a window that had a gap in it.

**The release has to drain it.** After releasing, the gauge must return to zero, or every reading above was a
leak rather than a live waiter and the next run would inherit a wedged endpoint.

**The bound stays below the daemon's request timeout,** so a gate that died between hold and release degrades
into a slow read rather than a failed one.

## 3.4 The ~50-entry corpus, and why it is made of tiny files

G7 is a scan of a **~50-entry corpus**. What it measures is whether a media server catalogues fifty distinct
identities correctly — a question about namespace, metadata and stable identity, not about bytes. Fifty large
files would answer the same question, cost gigabytes of generated media and minutes of encoding per run, and
would make the gate slow enough that somebody would eventually shrink the corpus. A fifty-entry gate run
against five entries is worse than no gate at all.

So the corpus is **50 tiny, valid, individually distinct media files** — 47 generated in a single container
(nine local, thirty-eight served over HTTP Range), plus the two original anchors and the long soak source.
Each uses a different pattern, tone and duration; `corpus-check` refuses the run unless all fifty digests are
distinct, because two byte-identical entries would make every digest comparison in this gate decorative.

**The scan is asserted as a count of MATCHED IDENTITIES, not a count of items.** A listing of fifty arbitrary
files has the right length. `JD3-corpus-matched 50/50` counts only published keys that were present, at the
published size, as ordinary files — so it cannot be satisfied by fifty of anything else. Alongside it,
`missing`, `wrong-size`, `not-ordinary`, `duplicated` and `unexpected` are each zero, so a shortfall says what
went wrong rather than only that something did.

**The byte budget names two denominators**, and folding them together would have been the easy mistake. Above
the contract's single-probe threshold an object is identified from a **fraction** of itself, and that fraction
carries the product's entire argument. Below it, the contract's own probe plan is a single window covering the
**whole** object, so identifying such an entry costs its whole length by construction and a sub-1.0 budget over
it could never pass. One combined budget would let the large entries pay for the small ones — and a regression
in the large read path would disappear into the average.

## 3.5 Five minutes of direct play, and the three ways to fake it

`JD4` proves the **bytes** are right: it drains a response and digests it, in a second or two. Nothing about
it can support *"direct play starts within 10 s and runs 5 minutes without a stall"*, and the obvious way to
make it take five minutes — add a sleep — produces a phase that takes five minutes and measures a download.

`JD18` runs a **real decoder at the media's own frame rate** (`ffmpeg -re`, in the pinned media-server image,
on the gate's own network) and holds its progress trace against four separate numbers:

| Measured | What it refuses |
|---|---|
| Startup: launch to first decoded frame | a server that takes half a minute to produce a picture |
| Wall clock ≥ 300 s | nothing on its own |
| **Decoded media time** ≥ 300 s | sleeping for five minutes having decoded four seconds |
| **Media seconds per wall second**, floor and ceiling | draining the whole file in twenty seconds and sleeping — which passes every row above and sits in the hundreds here |
| Longest interval with no decoder progress | a play that froze for ninety seconds and caught up, whose endpoints are identical to a correct run's |

The decoder's own output is then re-probed end to end, because "decoded/playable output" is a decoder's
answer and a byte count is not one. **The consumer sends no credential**, which is a consequence of §3.1's
measurement rather than an oversight: this server answers `static=true` direct play to a request carrying
none, and putting one on a `docker run` command line would publish it to every process listing on the host
to buy nothing.

## 3.6 Ten seeks, and how a seek is actually performed against this server

The obvious spelling is `StartTimeTicks` on `master.m3u8`. Measured against the pinned server, it is wrong in
two ways, and both were only visible by running it:

1. **It does not change the playlist.** The variant playlist for a seeked request lists the whole file — 114
   segments and 340 seconds of `#EXTINF` — exactly as an unseeked one does. So "ask for 90 % of the way in
   and a tenth of the duration remains" is not a statement this server makes.
2. **The segment request then fails.** The server generates child URLs in the shape of the request that asked
   for them, so `startTimeTicks` propagates into every segment URL, lands beside the `runtimeTicks` the
   playlist generator adds, and the segment endpoint answers **400**.

What an HLS client actually does — and therefore what this gate does — is hold one playlist and **request the
segment at the position it wants**, out of order, wherever that is. The server restarts its encoder at that
position to answer, which is the non-sequential, multi-position read this data plane exists to make cheap.

Every per-seek assertion — a 200, a non-empty body, decodable `h264`, inside ten seconds — is satisfied by a
server that returned the first three seconds of the file ten times over. So the properties that belong to the
**set** are asserted too: ten **distinct** segments, a position the server itself agrees with to within one
segment, decoded timestamps spanning at least 80 % of the media, and — the temporal assertion — a
**constant** offset between each decoded start timestamp and the position asked for. The pinned server offsets
its transport-stream timestamps by ten seconds; that constant is *measured*, not hard-coded, because it is one
server's presentation-time convention. What is universal is that it does not change as the position moves.

## 3.7 Five minutes of transcode, and the one thing this gate does **not** claim about it

**What `JD20` claims: five minutes of paced, continuously decoded, transcoded playback.**

**What it does not claim: five minutes of encoder work.** Measured on a developer machine, the transcoding job
encodes the 340-second, 320×240, 150 kbit/s source in about **1.6 seconds** and exits — with `EnableThrottling`
on, a throttle delay configured, and a player session attached. Live `TranscodingInfo` is populated
immediately and is null fifteen seconds later, because there is no longer a job.

An earlier draft of this gate asserted that the encoder's own output files spanned most of the window. That
assertion would have failed every correct run on this hardware, and reporting 1.6 seconds as proof of five
minutes would have been the overclaim this repository exists to stop shipping. Both numbers are now
**recorded with their measurements and asserted on by nothing**.

The five minutes are proved from the client and the output instead:

| Asserted | What it refuses |
|---|---|
| The **source** codec, as the media server identified it, is `mpeg4` | a transcode "to h264" from something that was already h264 |
| Decoded `h264` media ≥ 300 s over **every** consumed segment | counting files; a remux; empty segments |
| Wall span across segment arrivals ≥ 300 s | nothing on its own |
| Longest gap between **adjacent** arrivals ≤ 20 s | consuming everything in ten seconds, sleeping, and fetching one more at the end |
| ≥ 25 % of the required media decoded in the **last third** of the window | a dense start with a padded tail |
| All consumed segments distinct | one segment delivered fifty times, which satisfies every row above |

The first two rows are the transcode claim, and they are asserted **in the same phase** so that neither half
can quietly stop being true while the other is still checked.

### 3.7.1 A circular assertion, and the negative control that removed it

An earlier version of this gate had a seventh asserted row: the server's own `PlayState.PlayMethod` reading
`Transcode` at ≥ 80 % of samples across the window. **The gate's own playback report was sending
`PlayMethod: 'Transcode'` at the time.** That is a claim this harness made, handed to the server, and read
back as though the server had reached it — evidence of nothing but its own round trip.

Three arms against a live pinned server, with a genuine `mpeg4` → `h264` transcode serving the segments in
**every** arm:

| What the client reported | Read at t=0 | Read at t=20 s |
|---|---|---|
| `PlayMethod: Transcode` | `DirectPlay` | `Transcode` |
| nothing at all | `DirectPlay` | `Transcode` |
| `PlayMethod: DirectPlay` | `DirectPlay` | **`DirectPlay`** |

The third arm settles it: **the client's contrary claim wins**, so the field cannot carry an assertion about
what the server was doing. (The second is interesting on its own — the server does derive a value when the
client asserts none — which is why the gate now sends **no** `PlayMethod` at all: a gate must not author the
value it later reads.) The number is still sampled and reported, as telemetry, beside a count of playback
reports the server refused — because session telemetry gathered while the server was ignoring the client
describes this harness's silence rather than the server's view, and a reader is entitled to know which.

What made the session observable at all is worth keeping: a raw HLS request that never reports playback does
not become a session with a `NowPlayingItem`, and **the report has to come before the transcode is
requested**, because the job records itself against the session that exists when it is created.

**On slower hardware, a longer source or a heavier profile the encoder would still be working across the
window, and the recorded numbers would say so.** That is a property of the machine rather than of the data
plane, which is why it is reported rather than required.

## 3.8 A defect this corpus found, and a check that was passing because of it

The gate briefly had a step that stopped the daemon with `docker stop`, remounted, and re-scanned — the
boring restart an installation performs every time it is updated, asserted separately from the crash. It
reported **zero churn over all fifty entries**. The next real read then failed, and the media server's own
encoder log said:

```
[in#0] Error opening input: Transport endpoint is not connected
```

**On this host a graceful daemon stop leaves a container that was started BEFORE it holding a dead FUSE
mount.** The bind-propagated namespace does not pick up the replacement; `stat` still answers out of the
kernel's cache, and only an `open` finds out. `await_namespace` cannot see it either, because it probes with
a **fresh** container, which gets the new mount correctly.

**And the zero-churn result was passing because of the failure, not despite it.** A scanner that cannot read
a library root is *supposed* to decline to delete its items — so "zero removed" was a symptom of the broken
mount rather than evidence against it. That is a check that could not fail, which is the class this
repository exists to stop shipping, and the step was deleted rather than reordered around.

Two things changed as a result:

1. **The projection-restart evidence is the `SIGKILL` path**, which is strictly more violent, already
   asserts zero churn, and follows the remount with a byte-for-byte read through the media server — so it
   cannot pass while the mount is dead.
2. **Every remount is now followed by a read of BYTES from inside the media server's own container**, before
   any churn assertion is made. A failure is named at the point it happens instead of surfacing three phases
   later as an unexplained `500`.

**What is not proved, and is deliberately left open:** whether a graceful daemon restart under a
long-running media server recovers on **Linux or Unraid**, where mount propagation is not travelling through
a Docker Desktop VM. It may well be an artifact of this host. It is recorded here because an appliance whose
daemon cannot be restarted under a running media server would be a serious operational limitation, and
finding out is Linux/Unraid work rather than something this gate can settle.

## 3.1 Two things this gate deliberately does **not** claim

**It does not claim playback was authorized.** Measured against the pinned Jellyfin 10.10.7:
`GET /Videos/{id}/stream?static=true` answers **200 with the whole file to a request carrying no credential at
all**, and answers it just as happily to a deliberately invalid token. Every other endpoint the gate uses —
`/Items`, `/Library/*`, `master.m3u8`, `DELETE /Videos/ActiveEncodings` — answers `401` without a valid one.
So a passing direct-play gate is evidence that the **bytes** are right. Reading "authenticated playback" into
it would be reading in something that was never measured.

**It does not claim no token exists on disk.** The step that checks for leaks used to be headed *"no access
URL, token, header or expiry was persisted anywhere"*, and that was **false as written**, in two ways:

1. **This harness persists a Jellyfin access token on purpose.** Its phases run as separate processes and each
   needs the credential, so it lives in `out/state.json` inside the run directory — which the cleanup trap
   deletes on success and on failure. That is a property of the harness, not of the product.
2. **Jellyfin persists its own authentication state.** A media server that did not could not survive a
   restart, and this gate restarts it and then requires the library to still be there. Its database contains
   its own device and token records, and it is supposed to.

The claim the product actually makes is narrower and stronger: **no PROVIDER access lease — its URL, its
header, its token or its expiry — reaches the manifest, the daemon's probe cache, or the media server's
library state.** Phase 0 §7.6 says that material lives in the daemon's memory for the length of one read and
nowhere else, and that is what the step now checks, under that heading.

To make the check mean something it had to have a subject. The endpoint now runs in **resolver mode**, so the
daemon really does exchange the stable `objectRef` for a short-lived access URL, header and expiry; the lease
id carries a **per-run 16-byte random marker**; and all three locations are searched for **that exact value**.
The run also asserts at least one resolution was served, because a run that minted no lease would pass a
search for a secret that never existed. The previous version ran in direct mode and had no lease at all.

## 4. Defects found in this gate, and what each one cost

Independent review found four more after the first two below, every one of the same class: **a comment that
described one behaviour while the code did another, or a check that could not fail.** They are recorded
because that class is the reason this repository is where it is, not because the list is flattering.

**A skipped run looked exactly like a passing one.** The gate exited `0` when `/dev/fuse` was absent, and the
three-run wrapper looped over it. On a host without FUSE that produced *"3 consecutive runs completed"* and an
exit status of `0`, having proved nothing whatsoever — which is precisely the shape a required Linux/Unraid
acceptance invocation would have taken if it were ever run somewhere the mount could not exist. The gate now
exits **77**; the wrapper counts completed runs, propagates 77, and cannot emit its completion message unless
the count reaches the target. Hosts that genuinely want skip-as-success have their own entry point,
`go:jellyfin-dataplane-gate:optional`, which maps 77 to 0 and nothing else — and which the acceptance plan
does not name as evidence.

**The scan barrier contradicted its own comment.** It claimed to require two consecutive `Idle` samples and to
ignore the `Idle` that precedes a start. The code had no prior-state variable at all: it returned on the first
`Idle` seen more than three seconds after the trigger. A scan slower to *start* than three seconds was
therefore declared **complete before it began**, and every assertion made afterwards was made against a
library the scanner had not yet walked. The three-second constant *was* the barrier. It is now a state machine
over a baseline timestamp taken before the trigger — a new execution start plus terminal `Idle`, which also
handles the fast-complete case a `Running`-must-be-observed rule would hang on — and it is tested against
scripted samples rather than by reading its own comment.

**"A stream in flight across the swap" was two separate requests.** `hold-stream` called `rangeRead` for a
prefix and `rangeRead` again for the remainder. `rangeRead` drains and releases its response, so the first
call *ended* the exchange: Jellyfin closed its file and `projectiond` saw a `RELEASE`. What the gate proved
was that two requests succeed either side of a generation swap. What its gate id and its final report said was
that an active stream survived one. It now opens a single response, consumes part of it, leaves the reader
alone across the event, and resumes the *same* reader — with an anti-buffering assertion that a substantial
share of the file arrived afterwards, since a fully pre-buffered body would make "held open" a fiction.

**The mid-scan race was a `sleep 1`.** A publish one second after the trigger can land before the scanner
starts or after it finishes; either way the step passed while claiming a generation had been admitted *while a
scan was running*. The scanning process now writes a marker at the moment it observes the scan in flight, the
publishing half waits on that marker, and the step fails if it never appears.

**A finished scan could look like a running one.** The in-flight predicate accepted any non-null
`CurrentProgressPercentage` as motion, including alongside `State: 'Idle'`. On the pinned server a scheduled
task's state is derived from whether it holds a cancellation token source, and completion clears that token
source *before* it clears the progress figure — so a response serialized between those two writes reports
`Idle` with a stale progress number. That is a scan which has just **ended**, and one such sample could raise
the mid-scan marker, satisfy the pre-publish guard, and licence a publish into a scan that was already over.
Only `Running` and `Cancelling` are accepted now; an unrecognised state keeps the wait going but claims
nothing.

**An unreadable state could still raise that marker.** Tightening the in-flight predicate left a third case
with nowhere to go: an execution recorded under a state this code does not recognise — `Restarting`, say,
alongside a new timestamp. It is not finished (that needs `Idle`) and not demonstrably under way (that needs
`Running` or `Cancelling`), but with only three phases it had to be reported as one of them, and it was
reported as `running` — the exact phase the in-flight callback fires on. So `observedInFlight` correctly
stayed false while the marker went up anyway. The pre-publish guard would have caught the consequence, but
the callback's contract said one thing and its code did another, which is the defect whatever the next check
happens to catch. There is now a fourth phase, `indeterminate`, and the callback is keyed on the in-flight
**fact** rather than on a phase that merely tends to imply it — so it cannot drift from that fact again
however the phase vocabulary grows.

**A fast-completed scan could still raise that marker.** The barrier tracked one flag for two different
facts — "an execution happened" and "this process saw it running" — and set it in every branch, including the
one for a scan that started and finished between two polls. That is a valid *completion* and is not an
in-flight observation, so a scan nobody ever saw running could write the marker, licence the publish, and be
reported under a gate id claiming the publish landed during it. The two facts are now separate properties:
`executionSeen` and `observedInFlight`. The in-flight callback fires only for a running sample,
`awaitScanRunning` refuses a fast complete by name instead of returning success, and the gate's assertion
reads the in-flight fact. Then, because even a correct observation is only a snapshot, the window itself was
made deterministic — §3.2.

**A live credential was duplicated into every playback URL.** The driver sent the `Authorization` header *and*
`api_key=<token>` in the query of direct-play, transcode and stop-encoding requests. Measured against the
pinned server, the header alone is accepted everywhere, so the query copy bought nothing and put a live
credential in the most leak-prone place available — and worse, Jellyfin generates HLS child URLs *in the shape
of the request that asked for them*, so an `api_key` in the parent propagated into every generated playlist
body. With header-only auth, **no generated child URL contains a credential at all**. The gate now authors no
URL with one, strips any the server hands back before following it, and asserts the count it had to strip
is zero.

### The first two, found while building it

Both are recorded because the failure mode they share — **a check that cannot fail, or a failure that looks
like a pass** — is the one this repository is trying to leave behind.

**A phase that exited 0 having done nothing.** The driver timed its requests with
`signal: AbortSignal.timeout(ms)`, which is the obvious spelling and is wrong. The timer behind it is
**unref'd**; combined with an idle socket, `await fetch(...)` then has nothing holding the event loop open.
Node does what it should with an empty loop — exits, normally, status 0 — and the buffered stdout is lost. Two
runs "passed" the bootstrap phase while Jellyfin was still starting and had accepted the TCP connection
without answering it. A retry loop cannot save you from this: the loop never gets a turn, because the promise
it is awaiting neither settles nor rejects. Every request now uses an explicit `AbortController` behind an
ordinary ref'd `setTimeout`, and the CLI additionally refuses to exit 0 from an incomplete phase.

**A leak check measuring the wrong thing.** The daemon's probe cache was searched for `://`. It matched, every
run, in all three cached windows — because a cached probe window is a verbatim megabyte of compressed video,
and the generated media contains thirteen occurrences of that three-byte sequence in its `mdat` as pure data.
The check was not evidence about access material; it was evidence that a 1-in-16-million byte pattern occurs
in a few megabytes of high-entropy data. It now searches the cache for the things that could only have arrived
there from a leak — the endpoint's host name, a real URL scheme, the lease header, an expiry field, an
authorization header — and the manifest directory, which is text the control plane authored, keeps the strict
rule.

## 5. Where this can and cannot be run

| Environment | What the gate closes |
|---|---|
| **Windows / Docker Desktop** | Everything above, provided `/dev/fuse` is reachable from a container. **This is not Phase 1 closure and SHALL NOT be reported as one.** If `/dev/fuse` is absent the gate exits **77**, the three-run wrapper propagates it, and no caller can read the result as a pass. |
| **Linux CI** | The offline suite (`npm run test:projection-jellyfin-dataplane`) runs anywhere. The gate itself needs FUSE, mount propagation into a sibling container and a media server; it is **not** wired into a CI job, because a gate that is flaky in CI gets disabled and then gets deleted. |
| **Linux / Unraid, operator-run** | The place the tranche actually closes, three consecutive times: `npm run go:jellyfin-dataplane-gate:three`. |

## 6. What is still not proved

- **Plex and Emby.** Nothing here has been run against either. Two of the three media servers §4 of the
  acceptance plan names are untouched.
- **A real Unraid host**: real shares, real mount propagation, real unRAID container templates.
- **A real provider endpoint**, and therefore **TorBox**: real TLS, real redirects refused, real
  `Content-Range`, real `429`. The only endpoint any automated gate here contacts is
  `internal/fakeprovider`, in a container, on a private network.
- **The expiring-lease gates** (G24–G26) through a media server. The endpoint supports the mode and this gate
  runs it in **resolver** mode — a real lease is minted and searched for — but nothing here lets one lapse
  mid-read.
- **G18, the simultaneous-client gate.** It requires all three media servers scanning at once, and there is
  one.
- **G22**, the rclone/WebDAV comparison control, and **G27**'s three-server half.
- **Five minutes of ENCODER work under G10.** What is proved is five minutes of paced, continuously decoded,
  transcoded playback; the encoder finishes in about 1.6 seconds on this hardware and that number is
  recorded rather than dressed up. See §3.7.
- **Three consecutive green runs on Linux or Unraid**, which is what the acceptance plan means by passing.

A Windows or Docker Desktop green run is not a Phase 1 pass and is not reported as one. **Phase 1 is open.**
