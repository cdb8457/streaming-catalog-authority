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
| Media involved | none | two generated mp4 files, read through a FUSE mount |
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
3. **Digests and byte lengths recorded outside the mount**, before anything is published.
4. **The production publisher**, and a pointer whose digest is verified against the artifact file.
5. **The already-merged production `projectiond` image**, strict-direct-mounted with `/dev/fuse`,
   `CAP_SYS_ADMIN` and nothing else, its namespace bind-propagated to sibling containers.
6. **Jellyfin, non-root, as an ordinary container**, stood up non-interactively through its own `/Startup/*`
   first-run API — not by forging a config file — and given the mount as a Movies library root.
7. **A real scan**, then direct play, a real HTTP seek, a forced transcode, a mid-stream generation swap, a
   `SIGKILL` of the daemon mid-stream, a daemon restart, a media-server restart and two more scans.

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
- **The expiring-lease gates** (G24–G26). The endpoint supports the mode; this gate runs against the direct
  one.
- **Three consecutive green runs on Linux or Unraid**, which is what the acceptance plan means by passing.

A Windows or Docker Desktop green run is not a Phase 1 pass and is not reported as one.
