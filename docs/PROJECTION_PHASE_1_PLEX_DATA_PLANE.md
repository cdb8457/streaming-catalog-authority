# Projection Phase 1 — the Plex data plane

**What this document is.** A description of a gate that runs. It is the **second** media server to read the
projected mount, and the second is the one that shows whether the data plane works or whether the first gate
was shaped around one server. Everything below is asserted by `deploy/projection-plex-dataplane-gate.sh` on
every run; nothing here is a plan.

**What it is not.** It is not Phase 1 closure, and it is not an evidence packet, a review gate or an
acceptance record. **Emby**, a real Unraid host and a real provider endpoint remain entirely unproved, every
run so far has been on **Windows / Docker Desktop**, which `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6
says closes **none** of G7–G13, and the tranche closes on a Linux or Unraid host, on all three media servers,
**three consecutive times**.

**What has actually been run, as of the last edit to this file.** See §7. That section is the run record, it
is separate from the description of the gate above it on purpose, and the two are not the same kind of
statement: everything else in this document says what the gate asserts, and §7 says how many times it has
been observed to hold and where.

---

## 1. What is shared with the Jellyfin gate, and what is not

The temptation with a second media server is to parameterise the first gate. Almost nothing survives the
translation, and two of the Jellyfin gate's hardest-won conclusions are **wrong for Plex in the opposite
direction** — so copying them across would have been the same failure as copying its request shapes.

| | Jellyfin | Plex |
|---|---|---|
| Standing it up | a non-interactive first-run wizard, then a token | **no wizard and no account**: an unclaimed server answers its local API with no credential at all |
| Authorization | `MediaBrowser Client=…, Token=…` | none authored by this gate; `X-Plex-Token` is only ever *recognised*, never sent |
| Direct play | `/Videos/{id}/stream?static=true` | `GET` of the part's own key — there is no decision to ask for |
| "An ordinary file" | `Protocol=File`, `LocationType=FileSystem`, `IsRemote=false`, a real container | `accessible` and `exists` from `checkFiles=1`, which makes the server **stat the file through the mount as it answers** |
| Scan completion | a scheduled task's `State` | a section's `refreshing` flag **plus** `/activities` being drained — see §3.3 |
| Seeking | request the segment at the position, out of order | the same, and for the same reason — but the position is read from the playlist's own `#EXTINF` sums |
| The encoder over five minutes | finishes the whole source in ~1.6 s and exits; **recorded, asserted by nothing** | **throttles against the client's pace and stays alive**; a bounded liveness claim is asserted — see §3.6 |
| A client-writable play-method field | yes — Jellyfin's `PlayState.PlayMethod`, proved client-writable by negative control against a live Jellyfin | **no such field exists on Plex** — see §3.7 |
| The decoder | the server's own ffmpeg | **necessarily a third party's**: the Plex image ships no ffprobe at all |

What **is** shared lives in `src/core/projection/media-server-dataplane.ts` and is imported by both drivers
unchanged: the deadlines, the amplification budgets, the five-minute thresholds, the ten-seek plan, the
corpus comparison, the redaction rule and the verdict helpers. Those are statements about *what a
five-minute claim has to mean* and *what a report may contain*, not about any server's API. Everything whose
truth depends on Plex lives in `src/core/projection/plex-dataplane.ts`.

## 2. What the gate does, in order

1. **A real, migrated PostgreSQL** on its own throwaway instance, on its own port, in its own Compose
   project — so it can run beside the Jellyfin gate and beside an installation without either lending it
   state.
2. **Legal synthetic media, generated on the machine that runs the gate**, from ffmpeg's own `testsrc` /
   `testsrc2` / `smptebars` patterns and a sine tone. Nothing is downloaded, nothing copyrighted is touched,
   no media fixture is committed. Each entry uses a different pattern, tone and duration, so no two are
   byte-identical — otherwise reading the wrong one would still match its digest.
3. **A ~50-entry corpus of tiny files, and exactly ONE long source.** The corpus answers G7, which is a
   question about fifty identities rather than about bytes; the long source answers G8, G9 and G10, which
   need a duration and only need one.
4. **Digests and byte lengths recorded outside the mount**, before anything is published.
5. **The production publisher**, and a pointer whose digest is verified against the artifact file.
6. **The already-merged production `projectiond` image**, strict-direct-mounted with `/dev/fuse`,
   `CAP_SYS_ADMIN` and nothing else, its namespace bind-propagated to sibling containers.
7. **Plex, unclaimed, running as uid 1000**, given the mount as a library root with Plex's own
   personal-media agent — so no item identity in the run depends on plex.tv's catalogue.
8. **A real scan**, then direct play, a real HTTP Range seek and a forced transcode over the first small
   generation.
9. **The ~50-entry corpus published on top of it**, scanned and re-scanned with zero churn of any kind.
10. **The five-minute half**: ten media-time seeks, five minutes of paced direct play, and five minutes of
    paced, continuously decoded, transcoded playback.
11. **The violent half**: a mid-stream generation swap, a `SIGKILL` of the daemon mid-stream, a daemon
    restart, a media-server restart, a generation admitted mid-scan, a provider outage, and more scans.

## 3. The assertions, and why each is worth making

| Gate | What passes |
|---|---|
| `PX1` | The server is **unclaimed** (`claimed=0`, asserted not assumed) and answers its own local API without a credential. |
| `PX2` | The library root is the projected mount, created with the **personal-media agent**, which is asserted after creation rather than merely requested. |
| `PX3` | Every published entry appears, at **the size the control plane published**, with Plex's own **live** `accessible`/`exists` answer through the mount; and every item's `guid` is `tv.plex.agents.none://…`, so nothing was matched against an online catalogue. |
| `PX4` | Direct play returns the file's bytes, digest-compared against the value recorded outside the mount, for **both** the local and the HTTP Range entry. Evidence about **bytes**, not about authorization — see §3.1. |
| `PX5` | A ranged request answers **206** with the exact `Content-Range`, asserted **before the body is read**, and the bytes match a window hashed on the host. A 200-with-the-whole-file cannot pass as a successful seek. |
| `PX6` | A forced transcode, proved by **decoding what came out**: the media is encoded as `mpeg4`, `h264` is demanded, and the segments are ffprobed by a decoder that is not Plex. |
| `PX7` | **One HTTP response body**, opened once and deliberately left partially consumed, is still mid-delivery when a successor is admitted — and then completes **from that same response**, with the digest taken over everything it delivered. A measured share of the file must arrive *after* the event. Across a daemon `SIGKILL` that same held-open stream is permitted to fail; that outcome is recorded as `PX7-open-stream-interrupted`, is explicitly **not** generation-pinning evidence, and resumability is asserted separately by a new request. |
| `PX8` | After the daemon restarts and remounts, playback is **resumable** and the bytes are still the published ones. |
| `PX9` / `PX9b` | What a scan cost at the provider: ranged GETs, resolutions and **bytes as a fraction of the object's own length**, with both denominators named — see §3.4. |
| `PX10`–`PX13` | Across a successor, a daemon crash and recovery, a media-server restart and a plain re-scan: **zero removals, zero duplicates, zero `ratingKey` churn, zero `guid` churn and zero metadata drift**. Identity, not just presence — a server that re-created an item under a new rating key has lost every piece of watch state attached to it. |
| `PX14` | A re-scan of an unchanged generation costs the provider **zero** ranged GETs and **zero** bytes. |
| `PX15` | Across the **whole run**: zero 429s, zero full-body answers to a ranged request, and a peak connection count under the cap. |
| `PX16` | A generation admitted **strictly inside a running scan**, made deterministic rather than raced — see §3.2. |
| `PX18` | **Five minutes of direct play, paced** — see §3.5. |
| `PX19` | **Ten media-time seeks**, backwards and past 90 % of duration — see §3.6. |
| `PX20` | **Five minutes of paced, continuously decoded, transcoded playback**, plus a **bounded encoder-liveness claim** Plex can actually support — see §3.7. |

Alongside them, outside the driver: every mutation attempted from **inside Plex's own container, as its own
non-root uid**, is refused; the mount is deliberately **not** bound `:ro`, so what refuses the write is the
daemon and not a Docker flag. The probe cache is additionally bounded in size, because a read path that
started writing whole objects through it would pass every substring check ever written.

### 3.0 Whose Plex account this needs, and the one thing it does need

**No Plex account, no claim token, no personal credential anywhere in this repository.** An **unclaimed**
Plex Media Server serves its whole local HTTP API to an address inside `allowedNetworks` with **no
credential at all**. The gate asserts `claimed="0"` on every run, and separately asserts that no
`PlexOnlineToken` and no `PlexOnlineMail` were written to the server's own preferences file — so "unclaimed"
is a measurement rather than a promise about how the container was started.

**It does not need the internet either — and this section previously said the opposite, with three
measurements behind it.** The retraction is kept rather than tidied away, because a confounded experiment
that produced a confident wrong conclusion is worth more as a record than as an absence.

What was measured, and what was concluded from it:

1. Started on a Docker network created `--internal`, Plex came up, answered `/identity` with `claimed="0"`,
   and answered **401 to `GET /`, `GET /library/sections` and `POST /library/sections`**.
2. A server that was already answering unauthenticated was detached from its internet-capable network and
   attached to an internal one. Within seconds every endpoint except `/identity` began answering 401.
3. Its own log said `MyPlex: Error -6 requesting JSON from https://servers.plex.tv/api/v2/…`.

The conclusion drawn — that unauthenticated local access is contingent on reaching plex.tv — was **false**,
and it was written into this document, into the contract module, into the acceptance plan, and into a skip
check in the gate that would have reported SKIPPED on a perfectly capable offline host. **Every probe in
those three observations addressed the server by its Docker container NAME**, and what was refusing was
Plex's Host-header rebinding protection (§3.0.1). The `MyPlex: Error -6` line was true and irrelevant: an
unclaimed server logs it and carries on.

**Re-measured properly** — the same `--internal` network, DNS for `servers.plex.tv` failing inside the
container throughout, the server addressed **by IP**:

| request | answer |
|---|---|
| `GET /` | **200** |
| `GET /library/sections` | **200** |
| `GET /:/prefs` | **200** |
| `POST /library/sections` | **201**, library created |

**Those four requests were made and no others, and the claim is exactly that wide: an unclaimed Plex with no
route to the internet answers the endpoints needed to inspect and create a library.** Scanning, direct play,
seeking and transcoding on an air-gapped Plex are **not** established — this gate has never run that way, and
this section is a targeted probe rather than a run of the gate. `PLEX_AIR_GAPPED_TESTED_PATHS` in the contract
module is the same list, so the claim cannot quietly widen into "the whole local API".

What the corrected measurement does settle is that the gate's plex.tv skip check was wrong, and it has been
**deleted**. A false SKIP is the same family of defect as a false PASS.

The gate's own network is an ordinary bridge rather than an internal one for a reason that has nothing to do
with Plex: the driver runs on the host and reaches the server through a published port, and Docker Desktop
cannot publish a port from a container attached only to an internal network. Everything the product owns
stays private regardless — the daemon, the fake provider endpoint and the mount are on the gate's own
network, the provider's counters account for every media byte the server fetched, and the run asserts that no
provider access material reaches the manifest, the probe cache or Plex's own library state.

### 3.0.1 The Host header, which is what was actually refusing

Plex refuses a request whose `Host` header names something it does not recognise, and answers **401**. Its
own log is explicit: `Request came in with unrecognized domain / IP '<name>' in header Host; treating as
non-local`. Measured with everything else held identical — same peer, same network, same unclaimed server:

| request | answer |
|---|---|
| `http://<container-name>:32400/library/sections` | **401** |
| `http://<container-ip>:32400/library/sections` | **200** |
| by IP, with `Host: <container-name>` | **401** |
| by name, with `Host: <container-ip>:32400` | **200** |
| by name, with `Host: localhost:32400` | **200** |

It is DNS-rebinding protection, it is keyed on the `Host` header rather than on the peer address, and
`allowedNetworks` does not override it. It cost two things: the paced direct-play phase, whose consumer
reached the server container-to-container by name and got a 401 out of ffmpeg before it decoded a frame; and
the entire false plex.tv finding above. **Every URL this gate hands to a container now names the server by
address**, and the gate refuses to continue if it cannot resolve one.

### 3.1 Two things this gate deliberately does **not** claim

**It does not claim playback was authorized.** The gate runs an unclaimed server on purpose, and an unclaimed
server answers everything to a local address. A passing direct-play gate is therefore evidence that the
**bytes** are right. Reading "authenticated playback" into it would be reading in something that was never
measured — and on this configuration it would be false.

**It does not claim no credential exists on disk.** Plex persists its own device records and its own server
identity, and it has to: this gate restarts it and then requires the library to still be there. Those are
Plex's own, they are not provider access material, and they are not searched for. The claim the product
actually makes is narrower and stronger: **no PROVIDER access lease — its URL, its header, its token or its
expiry — reaches the manifest, the daemon's probe cache, or the media server's library state.** The endpoint
runs in **resolver mode**, so the daemon really does exchange the stable `objectRef` for a short-lived access
URL, header and expiry; the lease id carries a **per-run 16-byte random marker**; all three locations are
searched for **that exact value**; and the run asserts at least one resolution was served, because a run that
minted no lease would pass a search for a secret that never existed.

Unlike the Jellyfin harness, **this gate persists no media-server credential of its own** — an unclaimed Plex
needs none, so there is nothing to write down.

### 3.2 How the mid-scan window is made deterministic

Proving something happened *while a library scan was running* against a real media server is otherwise a
race, and a coin flip with a retry loop around it is not evidence. So the scan is made to **block on
something the gate controls**:

1. A **brand-new remote entry** is published first. It has to be new: anything already scanned has its probe
   windows cached, and `PX14` asserts a re-scan costs the provider nothing — so a hold on an existing entry
   would never be hit.
2. The fake endpoint is told to **hold** ranged reads of that object. The scanner blocks in an uncached
   provider read, and the scan is now deterministically still running.
3. The scanner is confirmed running, the successor is published, and the scanner is confirmed running
   **again**. Both edges of the window are observed; neither is assumed.
4. The hold is released and the scan completes normally.

**A live gauge, not a lifetime counter.** `heldRequests` says a request entered a hold at *some* point, and
stays up after the hold's bound fires and the request proceeds. The gate waits for `currentHeldWaiters` to
**rise**, requires it to still be up **after** the publish, and requires **zero `holdTimeouts` across the
window** — because a waiter that lapsed and a fresh one that replaced it would leave the gauge looking
unchanged over a window that had a gap in it. After releasing, the gauge must return to zero, or every
reading above was a leak rather than a live waiter.

### 3.3 The scan-completion flag that lies for half a minute

Plex's section carries a `refreshing` attribute, and it looks exactly like the thing to wait on. Measured,
polling a fifty-entry scan every two seconds:

```
t=0    refreshing=1  activities=[library.update.section, butler]
t=2    refreshing=1  activities=[library.update.section, library.update.item.metadata x3, butler]
t=6    refreshing=0  activities=[library.update.item.metadata x3, butler]      <-- items still moving
t=34   refreshing=0  activities=[butler]                                        <-- actually settled
```

**`refreshing` goes false roughly twenty-eight seconds before the library stops changing.** A barrier that
watched only that flag would return while Plex was still writing item metadata, and every assertion made
afterwards would be made against a library mid-write. The failure would be intermittent, would look like
flakiness, and the repair somebody reaches for when a gate is flaky is a sleep.

So `PlexScanBarrier` requires all three of: an execution having demonstrably happened, `refreshing` false,
and **no library-scoped activity outstanding**. `butler` is excluded by name, because an idle server carries
a permanent `type="butler" progress="100"` row and a barrier that waited for `/activities` to be *empty*
would wait forever. `scannedAt` is the baseline, so a scan that starts and finishes between two polls is
recognised as a valid **completion** without being recorded as an **in-flight observation** — those are two
different facts and only the second can support "a generation was admitted while a scan was running".

### 3.4 The ~50-entry corpus, and the two denominators

G7 is a scan of a **~50-entry corpus**. What it measures is whether a media server catalogues fifty distinct
identities correctly — a question about namespace, metadata and stable identity, not about bytes. Fifty large
files would answer the same question, cost gigabytes of generated media and minutes of encoding per run, and
would make the gate slow enough that somebody would eventually shrink the corpus. A fifty-entry gate run
against five entries is worse than no gate at all.

**The scan is asserted as a count of MATCHED IDENTITIES, not a count of items.** A listing of fifty arbitrary
files has the right length. `PX3-corpus-matched 50/50` counts only published keys that were present, at the
published size, with Plex's own live `accessible`/`exists` answer — so it cannot be satisfied by fifty of
anything else. Alongside it, `missing`, `wrong-size`, `not-ordinary`, `duplicated` and `unexpected` are each
zero, so a shortfall says what went wrong rather than only that something did.

**WHAT A PLEX SCAN COSTS AT THE PROVIDER, AND THE WRONG ANSWER THAT WAS TRIED FIRST.**

Three byte budgets failed on the first full run:

| scan | provider bytes | remote bytes in the library | ratio |
|---|---|---|---|
| two-entry generation | 17,825,792 | 13,981,407 | **1.28x** |
| ~50-entry corpus | 40,096,953 | 24,111,354 | **1.66x** |
| ten seeks | 54,485,469 | 8,594,275 | **6.34x** |

The first answer was a Plex-specific `MAX_SCAN_BYTE_MULTIPLIER = 3.0` — a number above 1.0 chosen to sit
above what had been measured. **That was rejected in review and it deserved to be.** A ceiling placed above an
observation is a record of the observation with room around it: it would have passed a daemon that read every
object three times over, and it retired the product's central claim instead of testing it.

**The arithmetic the multiplier was hiding.** The daemon serves a **4 MiB demand block** for a one-byte read
(`readpath.ChunkBytes`). Plex opens each new item **twice** — its own log shows `Plex Media Scanner --analyze`
launched for every new item, in addition to the scan that found it, with the scheduled deep-analysis task off
— and touches about **three blocks per open**. So identifying *one* object costs up to **24 MiB no matter how
large it is**. The soak fixture is 8.6 MB and the anchor 14.0 MB. Against objects smaller than that fixed
window, *"reads a fraction of the object"* is not a property a correct implementation can have: 1.28x and
1.66x are the block geometry, not waste, and the fixture was the wrong instrument.

So the ceiling is derived rather than chosen: **`opens x min(blocks x chunk, size)` per object** — a fixed
window, clamped by the object, the same shape whether the object is 40 KB or 400 MB. Sizes are handed to it
one at a time, because a total would let the large entries buy headroom for the small ones.

**And the product's claim is asserted where it can mean something: one 96 MiB remote fixture**, four times the
fixed window, held to the **shared** `MAX_SCAN_BYTE_FRACTION` of 0.5 — the same constant the Jellyfin gate is
held to, not one of Plex's own. Published in its own generation and measured in its own counter window, so the
delta is attributable to that object alone. The shared constant was never widened; widening it would have
slackened the Jellyfin gate to make this one pass.

**The seek ceiling is the same geometry.** A seek restarts the encoder, and a restart is an open: at most
three demand blocks, plus one session-setup allowance. `1.2x the object per seek` was both loose and unstable
— a hair above the arithmetic floor on a small fixture, meaningless on a large one.

**What was untouched, and is the strongest amplification claim Plex supports:** a re-scan of an unchanged
generation costs the provider **zero** ranged GETs and **zero** bytes.

**And one that was not measured at all until review caught it:** the scan after a **media-server restart**
re-fetched **+37,924,876 bytes over +14 ranged requests**, while the warm scan immediately after cost zero.
The gate had a counter window around the warm scan and none around the restart scan — the strongest-sounding
half of a two-part measurement with the expensive half unmeasured. It is budgeted now, as a cold scan, because
from the daemon's side that is what it is.

**The byte budget names two denominators.** Above the contract's single-probe threshold an object is
identified from a **fraction** of itself, and that fraction carries the product's entire argument. Below it,
the contract's own probe plan is a single window covering the **whole** object, so identifying such an entry
costs its whole length by construction and a sub-1.0 budget over it could never pass. One combined budget
would let the large entries pay for the small ones — and a regression in the large read path would disappear
into the average.

**Plex's own background jobs are turned off, and that is not a weakening of the read path.**
`ButlerTaskDeepMediaAnalysis` and its relatives read **whole media files** on a schedule; a run whose butler
window opened mid-gate would put those bytes inside the amplification window and the report would accuse the
daemon of downloading the library. Every preference is **read back and compared** after being set, because
`PUT /:/prefs` answers 200 for a name it does not recognise — a fire-and-forget call would be a check that
cannot fail.

**The trash is left on auto-empty, Plex's default, on purpose.** With the trash held, a file that had
genuinely vanished would sit in the library as an unavailable item and every "zero removed" assertion would
be true of a library that had lost its media. With auto-empty on, a removal is a removal.

### 3.5 Five minutes of direct play, and the three ways to fake it

`PX4` proves the **bytes** are right: it drains a response and digests it, in a second or two. Nothing about
it can support *"direct play starts within 10 s and runs 5 minutes without a stall"*, and the obvious way to
make it take five minutes — add a sleep — produces a phase that takes five minutes and measures a download.

`PX18` runs a **real decoder at the media's own frame rate** (`ffmpeg -re`, in a pinned image that is not
Plex, on the gate's own network) and holds its progress trace against five separate numbers:

| Measured | What it refuses |
|---|---|
| Startup: launch to first decoded frame | a server that takes half a minute to produce a picture |
| Wall clock ≥ 300 s | nothing on its own |
| **Decoded media time** ≥ 300 s | sleeping for five minutes having decoded four seconds |
| **Media seconds per wall second**, floor and ceiling | draining the whole file in twenty seconds and sleeping — which passes every row above and sits in the hundreds here |
| Longest interval with no decoder progress | a play that froze for ninety seconds and caught up, whose endpoints are identical to a correct run's |

The decoder's own output is then re-probed end to end, because "decoded/playable output" is a decoder's
answer and a byte count is not one.

### 3.6 Ten seeks, and the mechanism it took three measurements to get right

**A seek against Plex is a new `start.m3u8` at the wanted `offset`, on the same session, followed by the
segment at that position.** The client tells the server where to restart. It does not ask for a distant
segment and leave the server to infer it.

**The Jellyfin mechanism does not work here, and it fails in the worst possible way: slowly, and only after
several requests.** The Jellyfin gate holds one playlist and requests whichever segment it wants; Jellyfin
answers every one in well under a second, and the Plex driver was written the same way. Measured against a
purely **local** file — no FUSE, no provider, nothing of this product involved — in this gate's own seek
order:

```
seg 00000  212ms | 00002  112ms | 00039  191ms | 00008   57ms | 00026 192ms | 00000 64ms
seg 00017  196ms | 00041 45073ms | 00006  109ms | 00033 TIMED OUT (45s)      | 00014 191ms
```

It works for the first six and then wedges. Two full gate runs were lost to it before the mechanism was
suspected rather than the data plane: the first reported a 20.33 s seek, the second timed out on segment
00017 after 30 s. **Raising the timeout would have converted a broken mechanism into a slow one and left the
ten-second contract meaningless**, which is why the local-file arm was run first — it separates "Plex cannot
do this" from "the projection stalled", and the answer was the former.

The same ten positions, same server, same file, through the offset mechanism:

```
296ms  312ms  268ms  322ms  316ms  316ms  329ms  354ms  311ms  270ms
```

**Not one assertion was weakened to get there.** The ten returned bodies are distinct, every one decodes as
`h264`, and every decoded start timestamp sits exactly **+10.0 s** from the position the server's own playlist
gives that segment — a spread of 0.167 s across all ten. The ten-second ceiling now passes with two orders of
magnitude of headroom instead of failing.

**One prerequisite, which cost an afternoon.** A segment request answers **404** — every time, for every
index — until the session's variant playlist has been fetched once. The session's segment namespace does not
exist before that, so fetching it is part of opening a session and part of every seek.

**The position credited to a seek is the server's own arithmetic.** `serverPositionSeconds` is the running sum
of the playlist's `#EXTINF` values up to the requested segment: the server stating where that segment begins.
A gate that computed `index * 8` would be hard-coding one build's segmenter into an acceptance gate.

**The position-error ceiling is derived, not shared.** A seek lands on a segment boundary; Plex's segments are
eight seconds and Jellyfin's are three, and the shared constant is four. Reusing four would fail a correct
Plex seek roughly half the time, and widening the shared constant to eight would have quietly slackened the
Jellyfin gate by five seconds — a gate weakened to make a different gate pass. So the ceiling is **one segment
as the server's own playlist declares it, plus a second**.

**The session warm-up is timed apart from the ten.** A seek is a transition within an established session;
bringing the session up and getting its first output is playback startup, which G8 budgets and G9 does not
mention. The warm-up reads the segment at the very start of the media — the one position the plan never asks
for, so it cannot pre-warm any of the ten — and is asserted under its own gate id against its own ceiling, so
a session that took a minute to produce a picture fails loudly rather than disappearing into the gap between
two gates.

Every per-seek assertion — a 200, a non-empty body, decodable `h264`, inside ten seconds — is satisfied by a
server that returned the first eight seconds of the file ten times over. So the properties that belong to the
**set** are asserted too: ten **distinct** segments, a position the server itself agrees with to within one
segment, decoded timestamps spanning at least 80 % of the media, and — the temporal assertion — a **constant**
offset between each decoded start timestamp and the position asked for. That constant is *measured*, not
hard-coded, because it is one server's presentation-time convention. What is universal is that it does not
change as the position moves.

### 3.7 Five minutes of transcode — and the one claim Plex supports that Jellyfin does not

**What `PX20` claims: five minutes of paced, continuously decoded, transcoded playback.** The source is
encoded as `mpeg4`, `h264` is demanded, and every consumed segment is decoded by a decoder that is not Plex.

| Asserted | What it refuses |
|---|---|
| The **source** codec is `mpeg4` | a transcode "to h264" from a source that was already h264 |
| Decoded `h264` media time ≥ 300 s, over **every** consumed segment | counting files the server emitted; a remux; empty segments |
| Wall span across segment arrivals ≥ 300 s | nothing on its own — see the next row |
| Longest gap between **adjacent** arrivals ≤ 20 s | consuming every segment in ten seconds, sleeping, and fetching one more at the end |
| ≥ 25 % of the required media decoded in the **last third** of the window | a dense start with a padded tail |
| All consumed segments distinct | one segment delivered fifty times, which satisfies every row above |

**And, unlike the Jellyfin gate, a bounded ENCODER claim — because Plex behaves differently and pretending
otherwise in either direction would be dishonest.** The Jellyfin gate records encoder lifetime and asserts
nothing about it, because its encoder finishes a 340-second, 320×240, 150 kbit/s source in about **1.6
seconds** and exits; an encoder-lifetime assertion there would fail every correct run. Plex throttles the
encoder against the client's consumption — `TranscoderThrottleBuffer` defaults to sixty seconds — so the job
stays alive. Measured over a ninety-second paced probe against the pinned image:

```
t=0s    throttled=false complete=false maxOffsetAvailable=16
t=8s    throttled=true  complete=false maxOffsetAvailable=104
t=50s   throttled=false complete=false maxOffsetAvailable=112
t=58s   throttled=true  complete=false maxOffsetAvailable=152
t=91s   throttled=true  complete=false maxOffsetAvailable=160
```

So three things about the encoder **are** asserted: the number of distinct moments at which
`maxOffsetAvailable` was seen to **increase** (fresh output), the wall span between the first and last of
those moments, and at least one sample in which the server said the job was **throttled** — which an encoder
that raced to the end of the file and exited cannot produce. Every floor sits well below the measured
behaviour, because a threshold pinned to an observed value fails on a loaded machine and a gate that fails
when nothing is wrong gets disabled and then gets deleted.

| Recorded, not asserted | Why |
|---|---|
| `progress`, `speed`, the produced-output span, and how many samples called the decision a transcode | the server's own bookkeeping. It agrees with the decoded output here; if it ever stopped agreeing, the decoded output is what this gate would believe |
| The encoder's own output-file count and span | it is how far **ahead of the paced client** the encoder ran |

**Plex has no client-writable play-method field, and that is stated rather than assumed.** The Jellyfin gate
discovered by negative control — three arms against a live server with a genuine transcode serving the
segments in every one — that a client reporting `PlayMethod: DirectPlay` is read back as `DirectPlay`, so
Jellyfin's `PlayState.PlayMethod` is authored by whoever last spoke. Plex's equivalent surface is
`/transcode/sessions`, and there is **no client endpoint that writes any of its fields**: Plex's client-facing
progress API is `/:/timeline`, whose parameters are position, state and item. There is no play-method field
for a client to lie in. That makes the Jellyfin hazard structurally absent here — and it still does not make
the field the evidence, because "not forgeable by the client" is a much weaker statement than "a measurement
of the encoder". The transcode claim rests on the decoded output; `/transcode/sessions` is used only for the
encoder-lifetime question, which decoded output cannot answer at all.

### 3.8 The graceful-restart behaviour, recorded separately

The Jellyfin gate found that on this host a **graceful** daemon stop leaves a container that was started
*before* it holding a dead FUSE mount: the bind-propagated namespace does not pick up the replacement, `stat`
still answers out of the kernel's cache, and only an `open` finds out — and a zero-churn result taken across
that was passing *because* of the failure, since a scanner that cannot read a library root is supposed to
decline to delete its items.

**This gate inherits that finding and its remedy rather than re-testing it.** The projection-restart evidence
is the `SIGKILL` path, which is strictly more violent, already asserts zero churn, and follows the remount
with a **byte-for-byte read from inside the media server's own container** before any churn assertion is
made — so it cannot pass while the mount is dead. Whether a graceful daemon restart under a long-running
media server recovers on **Linux or Unraid**, where mount propagation is not travelling through a Docker
Desktop VM, remains **not proved and deliberately open**.

## 4. Defects found while building this gate

Recorded because the class they belong to — *a check that cannot fail, or a comment that describes one
behaviour while the code does another* — is the reason this repository is where it is.

**"The server is up" and "the server will create a library" are two different facts.** The first real run of
this gate died at the first WRITE: `/identity` answered, `/` answered, `PUT /:/prefs` answered and every
preference read back correctly, and then `POST /library/sections` came back
`400 … the server is still starting up. Please retry later`. The fix is a bounded wait — and the shape of it
matters more than the fact of it. A retry keyed on **400** would swallow every genuine refusal that endpoint
makes: an agent that does not exist, a scanner that does not exist, a location the server cannot see. Each of
those would become a two-minute wait ending in a timeout with the real reason discarded, which is precisely
the class of check this repository exists to stop shipping. So the retryable answer is recognised by **the
sentence Plex writes**, everything else is raised on the first attempt with the server's own body attached,
and the offline suite drives all three cases: the transient one is waited out, an unknown-scanner 400 fails
after exactly **one** POST, and a server that never finishes starting up ends at a bounded deadline.

**A segment request answers 404 until the variant playlist has been fetched.** The first version of the seek
phase asked for ten segments and got ten 404s. The failure looked like a broken seek plan; it was a missing
prerequisite, and the session's segment namespace simply does not exist until `index.m3u8` has been generated
once. The playlist fetch is now part of opening a session rather than something a caller can forget.

**A listing pager that trusted `totalSize` would silently truncate.** Plex **omits** `totalSize` from the
container whenever the requested window covers the whole section. A pager reading `totalSize ?? length` is
right by luck for a library of exactly one page and **wrong for one page plus one** — and every corpus
assertion would then have been made over a listing that was missing entries the scan had found. Paging is
decided by the page length instead.

**`checkFiles=1` is ignored on the section listing.** It is honoured only on `/library/metadata/{keys}`, which
is why the driver makes a second, batched request per twenty items. Without it, "an ordinary file" would have
been a statement about what the scanner cached at import time — which stays true across a mount that has
died, and which is precisely the failure mode the Jellyfin gate found and had to delete a step over.

**The transcode endpoint refuses an unrecognised client platform.** `X-Plex-Platform=Linux` answers **400**
with `TranscodeUniversalRequest: unable to find a matching profile` in the server log. The endpoint resolves
a client profile from the `X-Plex-*` fields and refuses the request when it cannot. The gate presents a
profile the server has.

**`refreshing` is not scan completion.** See §3.3. This is the one that would have shipped as intermittent
flakiness rather than as a visible failure.

**A confident wrong finding, and the confound that produced it.** See §3.0. Three probes said an unclaimed
Plex needs plex.tv to answer its own local API; all three addressed the server by container name, and the
Host header was what refused. It reached this document, the contract module, the acceptance plan and a skip
check in the gate before it was caught by an unrelated failure -- the paced consumer's 401 -- which had the
same cause. It is the most expensive defect in this list because nothing it touched was failing.

**The paced consumer reached the server by container name and got a 401.** See §3.0.1. Every URL handed to a
container now names the server by address, and the gate refuses to continue without one.

## 5. Where this can and cannot be run

| Environment | What the gate closes |
|---|---|
| **Windows / Docker Desktop** | Everything above, provided `/dev/fuse` is reachable from a container. **This is not Phase 1 closure and SHALL NOT be reported as one.** If FUSE is missing the gate exits **77**, the three-run wrapper propagates it, and no caller can read the result as a pass. There is no plex.tv prerequisite; there was, and it was wrong -- see §3.0. |
| **Linux CI** | The offline suite (`npm run test:projection-plex-dataplane`) runs anywhere. The gate itself needs FUSE, mount propagation into a sibling container and a media server; it is **not** wired into a CI job, because a gate that is flaky in CI gets disabled and then gets deleted. |
| **Linux / Unraid, operator-run** | The place the tranche actually closes, three consecutive times: `npm run go:plex-dataplane-gate:three` — **and the same for Jellyfin and Emby**. |

## 6. What is still not proved

- **Emby.** Nothing here has been run against it. One of the three media servers §4 of the acceptance plan
  names is untouched.
- **A real Unraid host**: real shares, real mount propagation, real Unraid container templates.
- **A real provider endpoint**, and therefore **TorBox**: real TLS, real redirects refused, real
  `Content-Range`, real `429`. The only endpoint any automated gate here contacts is
  `internal/fakeprovider`, in a container, on a private network.
- **The expiring-lease gates** (G24–G26) through a media server. The endpoint supports the mode and this gate
  runs it in **resolver** mode — a real lease is minted and searched for — but nothing here lets one lapse
  mid-read.
- **G18, the simultaneous-client gate.** It requires all three media servers scanning at once, and there are
  two.
- **G22**, the rclone/WebDAV comparison control, and **G27**'s three-server half.
- **The product's "a scan reads a fraction of the object" argument, on Plex — not contradicted, not yet
  demonstrated.** The 1.28x and 1.66x measured earlier are of fixtures SMALLER than Plex's fixed ~24 MiB scan
  cost, so no correct implementation could have scored better against them and they settle nothing either
  way. The claim is now asserted against a 96 MiB fixture, held to the same 0.5 fraction Jellyfin is held to
  — and **that assertion has never been observed to hold, because no run of this gate has passed**. See §3.4.
  Jellyfin remains the only server on which the argument is demonstrated.
- **A graceful daemon restart under a long-running media server**, on Linux or Unraid. See §3.8.
- **Anything air-gapped beyond four requests.** What was measured with no route to the internet (§3.0) is
  `GET /`, `GET /library/sections`, `GET /:/prefs` and `POST /library/sections`. **Scanning, direct play,
  seeking and transcoding on an air-gapped Plex are not established at all** — the gate's own network is an
  ordinary bridge, because Docker Desktop cannot publish a port from an internal network and the driver runs
  on the host, so no run of this gate has ever been air-gapped.
- **Three consecutive green runs on Linux or Unraid**, which is what the acceptance plan means by passing.

A Windows or Docker Desktop green run is not a Phase 1 pass and is not reported as one. **Phase 1 is open.**

## 7. The run record

**Status: the gate is written and has NOT yet been observed to pass. Nothing in §3 is evidence yet.**

This section is deliberately the only place in this document that says how many times anything has happened,
and it is deliberately separate from the description of what the gate asserts. A document that describes a
gate's assertions reads, at a glance, exactly like a document that reports them holding — and this repository
has three hundred phases of the second kind written before the first. Until a row appears below with a real
count and a real date, `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6.1 records Plex as **not run** and this
document claims nothing.

| Runs | Environment | Command | Outcome |
|---|---|---|---|
| — | — | — | not yet run |
