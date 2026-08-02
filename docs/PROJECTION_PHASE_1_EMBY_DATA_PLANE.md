# Projection Phase 1 — the Emby data plane

**What this document is.** A description of a gate that runs. It is the **third** media server to read the
projected mount, and the second one in the MediaBrowser API family — which makes it the one that shows whether
the Jellyfin gate's conclusions were about *the data plane* or about *Jellyfin*. Everything below §1–§5 is
asserted by `deploy/projection-emby-dataplane-gate.sh` on every run; nothing there is a plan.

**What it is not.** It is not Phase 1 closure, and it is not an evidence packet, a review gate or an acceptance
record. A real Unraid host and a real provider endpoint remain entirely unproved, every run so far has been on
**Windows / Docker Desktop**, which `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6 says closes **none** of
G7–G13, and the tranche closes on a Linux or Unraid host, on all three media servers, **three consecutive
times**.

**What has actually been run, as of the last edit to this file.** See §7. That section is the run record, it is
separate from the description of the gate above it on purpose, and the two are not the same kind of statement:
everything else says what the gate asserts, and §7 says how many times it has been observed to hold and where.

---

## 1. Why this is not the Jellyfin gate with a different image

Jellyfin was forked from Emby, so the endpoint spellings are largely shared and the temptation to parameterise
the first gate is strong. **Six of the Jellyfin gate's hardest-won behavioural conclusions are false for
Emby**, and every one of them was found by measurement against a live, digest-pinned `emby/embyserver` 4.9.5.0
rather than by reading documentation. One of the six was found by a **failing run of this gate** rather than by
a probe, which is recorded in §4.

Two of them are false in the direction that lets this gate assert something **stronger** than the Jellyfin one
can. Four are false in a way that would have made a copied gate hang, re-run a completed wizard on every phase,
silently compare its own arithmetic with itself, or — the one the failing run caught — match **zero** of the
entries it had just correctly catalogued.

| | Jellyfin | Emby |
|---|---|---|
| Wizard completion | `StartupWizardCompleted` in `/System/Info/Public` | **no such field anywhere.** Unauthenticated `GET /Startup/Configuration` answers **200** before the wizard and **401** after — §3.1 |
| Authorization header | `Authorization: MediaBrowser …` | **`X-Emby-Authorization`**, this server's own spelling. `Authorization` also works and is *recorded, not relied on* — §3.2 |
| Direct play with **no** credential | **200 with the whole file** | **401.** So this gate asserts the refusal, which the Jellyfin gate had to decline to claim — §3.3 |
| Transcoding temp path | `TranscodingTempPath` in the encoding config | **the field does not exist.** The job writes to `/config/transcoding-temp`, which the gate **binds** rather than sets — §3.4 |
| Throttle delay | `ThrottleDelaySeconds` | **does not exist**; `EnableThrottling` defaults false and the gate leaves it alone — §3.4 |
| Where a segment's position comes from | `runtimeTicks` in the server-generated segment URL | **nothing in the URL.** Position is the cumulative `#EXTINF` sum of the server's own playlist — §3.5 |
| "an ordinary file" | `Protocol=File`, `IsRemote=false`, a real container, **`LocationType=FileSystem`** | **`LocationType` is never sent**, even when explicitly requested. Replaced by `MediaSources[0].Type != Placeholder` and `MediaSources[0].Path == item.Path` — §3.10 |
| `docker exec` identity | the media server's uid (`--user 1000:1000` from outside) | **root.** The image drops privilege internally from `UID`/`GID`, so the write-refusal test names the uid it runs as, and runs twice — §3.6 |
| The decoder | the server's own ffmpeg, `/usr/lib/jellyfin-ffmpeg/` | the server's own ffmpeg, **`/bin/ffmpeg`** (Plex, by contrast, ships no ffprobe at all) |
| Item ids | path-derived GUIDs | **decimal database row ids**, and `MediaSources[0].Id` is `mediasource_<id>` — §3.7 |

What **is** shared lives in `src/core/projection/media-server-dataplane.ts` and is imported by all three drivers
unchanged: the deadlines, the amplification budgets, the five-minute thresholds, the ten-seek plan, the corpus
comparison, the scan barrier, the redaction rule and the verdict helpers. Those are statements about *what a
five-minute claim has to mean* and *what a report may contain*, and they do not become different statements
because a different server is answering. Everything whose truth depends on Emby lives in
`src/core/projection/emby-dataplane.ts`, with the measurement that produced it recorded beside it.

## 2. What the gate does, in order

1. **A real, migrated PostgreSQL** on its own throwaway instance, on its own port (5500), in its own Compose
   project — so it runs beside the Jellyfin gate, the Plex gate, the publisher gate and an installation without
   any of them lending it state.
2. **Legal synthetic media, generated on the machine that runs the gate**, by the ffmpeg inside the pinned Emby
   image, from ffmpeg's own `testsrc` / `testsrc2` / `smptebars` patterns and a sine tone. Nothing is
   downloaded, nothing copyrighted is touched, no media fixture is committed. Each entry uses a different
   pattern, tone and duration, so no two are byte-identical — otherwise reading the wrong one would still match
   its digest.
3. **A ~50-entry corpus of tiny files, and exactly ONE long source.** The corpus answers G7, which is a question
   about fifty identities rather than about bytes; the long source answers G8, G9 and G10, which need a duration
   and only need one.
4. **Digests and byte lengths recorded outside the mount**, before anything is published.
5. **The production publisher**, and a pointer whose digest is verified against the artifact file.
6. **The already-merged production `projectiond` image**, strict-direct-mounted with `/dev/fuse`,
   `CAP_SYS_ADMIN` and nothing else, its namespace bind-propagated to sibling containers.
7. **Emby, its server process running as uid 1000**, stood up non-interactively through its own first-run API,
   given the mount as a Movies library root with every internet metadata fetcher off.
8. **A real scan**, then direct play, the anonymous negative control, a real HTTP Range seek and a forced
   transcode over the first small generation.
9. **The ~50-entry corpus published on top of it**, scanned and re-scanned with zero churn of any kind.
10. **The five-minute half**: ten media-time seeks, five minutes of paced direct play, and five minutes of
    paced, continuously decoded, transcoded playback.
11. **The violent half**: a successor published under a held-open stream, a `SIGKILL` of the daemon mid-stream,
    a daemon restart, a media-server restart, a generation admitted mid-scan, a provider outage, and more scans.
12. **The refusals**: every mutation attempted from inside Emby's own container — twice, as two identities —
    and the leak checks over the manifest, the probe cache and the media server's library state.

## 3. The assertions, and why each is worth making

| Gate | What passes |
|---|---|
| `EM1` | The server is stood up through its own `/Startup/*` API; the wizard is **shut afterwards**, asserted rather than assumed; and the **version the findings were measured against** is asserted, so a moved digest is a named failure rather than a silent inheritance. |
| `EM2` | The library root is the projected mount, created with every internet metadata fetcher and realtime monitoring off, and asserted to point at the mount after creation rather than merely requested. |
| `EM3` | Every published entry appears, at **the size the control plane published**, as an **ordinary file** — `Protocol=File`, `LocationType=FileSystem`, not remote, a real container, direct-playable, not a `.strm`. Aggregate over the corpus, individually over the anchors, plus a check that every id has the shape this server was measured to mint. |
| `EM4` | Direct play returns the file's bytes, digest-compared against the value recorded **outside** the mount, for both the local and the HTTP Range entry. |
| `EM4b` | **The identical request with no credential is refused.** See §3.3. |
| `EM5` | A ranged request answers **206** with the exact `Content-Range`, asserted **before the body is read**, and the bytes match a window hashed on the host. A 200-with-the-whole-file cannot pass as a successful seek. |
| `EM6` | A forced transcode, proved by **decoding what came out**: the media is encoded as `mpeg4`, `h264` is demanded, and the segments are ffprobed. Plus: no server-generated playlist URL carried a credential. |
| `EM7` | **One HTTP response body**, opened once and deliberately left partially consumed, is still mid-delivery when a successor is admitted — and then completes **from that same response**, with the digest over everything it delivered and a measured share arriving *after* the event. Across a daemon `SIGKILL` that same stream is permitted to fail; that outcome is recorded as `EM7-open-stream-interrupted`, is explicitly **not** generation-pinning evidence, and resumability is asserted separately. |
| `EM8` | After the daemon restarts and remounts, playback is **resumable** and the bytes are still the published ones. |
| `EM9` / `EM9b` | What a scan cost at the provider: ranged GETs, resolutions and **bytes as a fraction of the object's own length**, with both denominators named. |
| `EM10`–`EM13` | Across a successor, a daemon crash and recovery, a media-server restart and a plain re-scan: **zero removals, zero duplicates, zero item-id churn, zero metadata drift and zero path drift**. |
| `EM14` | A re-scan of an unchanged generation costs the provider **zero** ranged GETs and **zero** bytes. |
| `EM15` | Across the **whole run**: zero 429s, zero full-body answers to a ranged request, and a peak connection count under the cap. |
| `EM16` | A generation admitted **strictly inside a running scan**, made deterministic rather than raced — §3.8. |
| `EM17` | The directory the encoder-ahead measurement reads is really the one bound in, so a zero-file soak means the encoder wrote nothing rather than that the gate looked in the wrong place. |
| `EM18` | **Five minutes of direct play, paced** — plus the credential-exposure assertion §3.3 forces this gate to make. |
| `EM19` | **Ten media-time seeks**, backwards and past 90 % of duration, against positions the server itself declares — §3.5. |
| `EM20` | **Five minutes of paced, continuously decoded, transcoded playback.** Encoder liveness is recorded and asserted by nothing — §3.9. |
| `EM21` | The probe cache is within what a fixed-window plan can account for, and is smaller than the library it caches windows of. |

Alongside them, outside the driver: every mutation attempted from **inside Emby's own container** is refused,
**twice** (§3.6); the mount is deliberately **not** bound `:ro`, so what refuses the write is the daemon and not
a Docker flag; and the per-run lease marker appears in none of the manifest directory, the probe cache or the
media server's library state.

### 3.1 The wizard flag that does not exist

Emby's `/System/Info/Public` returns `LocalAddresses`, `RemoteAddresses`, `ServerName`, `Version`, `Id` — and,
once the server has worked out its own addresses, `LocalAddress` and `WanAddress`. **There is no
`StartupWizardCompleted`, before the wizard or after it.**

The Jellyfin driver decides whether to run the first-run wizard with `info?.StartupWizardCompleted !== true`.
Against Emby that reads `undefined !== true`, which is **always true**. A copied bootstrap would therefore
re-run `/Startup/User` and `/Startup/Complete` on **every** invocation — including the re-login the gate
performs after restarting the media server, which exists precisely to prove the installation *survived*. The
gate would have been destroying the evidence it came to collect.

What replaces it is the wizard endpoint's own access control, measured in one session against the pinned
server:

| | before `POST /Startup/Complete` | after |
|---|---|---|
| `GET /Startup/Configuration`, no credential | **200** `{"UICulture":"en-us"}` | **401** `Access token is invalid or expired.` |
| `GET /System/Info`, no credential | **200**, full body | **401** |

Both moved together. The gate keys on `/Startup/Configuration` rather than `/System/Info` because only one of
them is *about* the wizard; keying on the general one would be keying on a coincidence.

**An unrecognised status is a failure, not a default.** A 503 from a server still starting, or a status a future
version invents, is neither. Reading it as "complete" would skip the bootstrap and leave every later phase
unauthenticated; reading it as "open" would re-run the wizard over a live installation. Neither is safe, so
`embyWizardPhase` returns `unknown` and the driver refuses.

**And the wizard is asserted to have shut.** A `/Startup/Complete` that answered 204 without completing anything
would leave the server permanently open to anonymous callers, and every later "authenticated" phase would be
measuring an endpoint that answers to anybody.

### 3.2 The authorization header, and a compatibility observation

The pinned Emby accepts the `MediaBrowser Client=…, Device=…, DeviceId=…, Version=…, Token=…` scheme under
**both** `Authorization` and `X-Emby-Authorization`; `POST /Users/AuthenticateByName` answered 200 to each, with
the same user body.

**This gate sends `X-Emby-Authorization` everywhere**, and that is a deliberate choice rather than a coin toss.
`Authorization` working today is a compatibility affordance of a fork's ancestor; `X-Emby-Authorization` is the
header this server documents and its own clients send. A gate driving Emby through the compatibility path would
be testing the affordance as much as the product, and would break on the release that finally drops it — with a
failure that looked like a projection defect.

That both work is **recorded** by `EM1-auth-header-compatibility` and asserted by nothing. The day it flips is
the day a Jellyfin-shaped driver stops working against Emby, and a dated observation is what makes that a
finding rather than a surprise.

### 3.3 The one place Emby lets this gate claim *more* than the Jellyfin gate can

`GET /Videos/{id}/stream?static=true&mediaSourceId=…`, with **no credential of any kind**:

- pinned **Jellyfin**: **200, the whole file.** This is why `PLAYBACK_ENDPOINT_IS_ANONYMOUS` exists in the
  shared module and why that gate states plainly that its direct-play evidence is about **bytes** and not about
  authorization — that server would have served those bytes to anybody who asked.
- pinned **Emby 4.9.5.0**: **401**, 35 bytes of body. With a valid token in `X-Emby-Authorization`: **200**,
  8,594,315 bytes, the file's own digest.

So `EM4b` **issues the unauthorized request and requires the refusal.** It is not a weakening of anything: the
authenticated direct-play digest assertions stand exactly as they do on the other two servers, and this is
evidence in addition to them. A 200 here would mean the pinned server had started serving media to
unauthenticated callers, which is a regression this gate is in a position to notice. A status that is neither a
refusal nor a serve — a connection error, a 500 — is **also** a failure, because the control has then measured
nothing.

**What it costs, and how that cost is paid.** The five-minute paced-play phase is an ffmpeg in another container
reading the stream URL. On Jellyfin it carries no credential *because none is needed*, and that gate's comment
says explicitly that putting one on a `docker run` command line would publish it to `docker inspect` and to
every process listing on the host, to buy nothing. Here it buys everything, so the cost is real:

- The token is written to a **file** in the gate's run directory, which the cleanup trap deletes on success and
  on failure. It is mode **0644**, and that is a stated trade-off rather than an oversight: the consumer
  container runs as uid 1000 and the gate does not — on an Unraid host it runs as root — so a 0600 file owned
  by the host user is unreadable by the container that has to read it, and the five-minute play would fail on
  exactly the platform this gate exists to eventually close on. Docker Desktop hides that by ignoring modes on
  bind mounts, which is why it would have shipped. **What the looser mode costs:** for the length of one run, a
  local user who can read the gate's own run directory can read a throwaway media-server token in it. The
  token belongs to a container destroyed with the directory.
- The consumer's command is a small `/bin/sh` script — also in the run directory — that reads the file and
  `exec`s ffmpeg. `docker run`'s argv names a script path, a binary path, a URL, a duration and an output path.
  **None of them is the credential.**
- `EM18-paced-play-credential-not-in-docker-metadata` searches `docker inspect` of that container for the
  **exact live token** — a value, not a pattern — and `EM18-paced-play-inspect-observed` fails if the inspect
  came back empty, because a search that found nothing by reading nothing is not evidence.

**What this does not solve, stated rather than omitted.** ffmpeg has no file-based header option, so the token
is in the argv of the ffmpeg process **inside its own container** for as long as it runs. That is a smaller
surface than `docker inspect` — which persists after the container is gone and is readable by anything that can
reach the Docker socket — but it is not nothing, and this gate does not claim "the credential never appears in
a process listing". It claims what it measures.

### 3.4 Nothing to configure, so the encoder is observed by binding

`GET /System/Configuration/encoding` on the pinned Emby returns exactly:

```
EncodingThreadCount, ExtractionThreadCount, DownMixAudioBoost, EnableThrottling, ThrottleBufferSize,
ThrottleHysteresis, ThrottlingMethod, H264Crf, EnableHardwareEncoding, EnableSubtitleExtraction,
EnableOnTheFlyAttachmentExtraction, CodecConfigurations, HardwareAccelerationMode, EnableHardwareToneMapping,
EnableSoftwareToneMapping, TranscodingMaxWidth, EnableHevcEncoding
```

There is no `TranscodingTempPath` and no `ThrottleDelaySeconds`. `GET /System/Configuration` has neither
either. The Jellyfin gate's `configure-encoding` phase sets both, and its comment says the temp path is *what
makes the encoder observable at all*.

So there is nothing to configure, and POSTing a document with fields the server ignores would be a phase
reporting success for doing nothing. What makes the encoder observable here is that Emby writes to a **fixed**
path — `/config/transcoding-temp`, inside the volume the gate already binds because the library database lives
there. `EM17` asserts that the host side of that bind exists, so a soak that later reports zero encoder output
files fails as *"the encoder wrote nothing"* rather than silently as *"the gate looked in the wrong place"*.

**`EnableThrottling` defaults to `false` and the gate leaves it alone.** Turning it on would be tuning the
server to make a number nobody asserts on look better, which is how a recorded measurement becomes a managed
one.

**`/System/Info` also carries `HardwareAccelerationRequiresPremiere`.** The gate forces a software transcode and
nothing it asserts depends on hardware acceleration, so no licensed feature is exercised — but the field is
worth recording, because "Emby transcoded" and "Emby transcoded the way a Premiere installation would" are
different claims and only the first is made here.

### 3.5 Ten seeks, against positions the server states a different way

`startTimeTicks` on `master.m3u8` is **accepted (200) and does not change the playlist**: the variant still
lists all 114 segments and 342 s of `#EXTINF`, exactly as an unseeked one does. So "ask for 90 % in and a tenth
remains" is not a statement this server makes.

That much matches Jellyfin. **The consequence differs, and the difference is worth recording precisely because
the conclusion is the same.** On Jellyfin the seeked request's parameters propagate into every generated
segment URL, land beside the playlist generator's own `runtimeTicks`, and the segment endpoint answers **400**.
Emby's segment URLs carry only `PlaySessionId`, so the segment still fetches fine — measured, **200**. Two
servers fail the `startTimeTicks` approach for different reasons and arrive at the same place; treating that as
one behaviour would be assuming one server's mechanism of the other.

So a seek is a **direct request for the segment at the position wanted** — out of order, backwards, wherever —
which is what an HLS client does when somebody drags a scrubber, and which makes the server restart its encoder
at that position. That is exactly the non-sequential, multi-position read this data plane exists to make cheap.

**The position the gate compares against comes from the playlist, not from the URL.** Emby's segment references
are `hls1/main/{N}.ts?PlaySessionId=…` and nothing else — no `runtimeTicks`. What the playlist *does* state is
`#EXT-X-TARGETDURATION:4` and an `#EXTINF:3.0000, nodesc` before every segment, and the cumulative sum of those
is where the server says each segment begins. **It is still the server's arithmetic**, not the gate's guess.

Verified against a decoder, three segments requested out of order:

| segment | declared start (Σ `#EXTINF`) | decoded picture start | offset |
|---|---|---|---|
| 1 | 3 s | 13.0 s | 10.0 |
| 106 | 318 s | 328.0 s | 10.0 |
| 22 | 66 s | 76.0 s | 10.0 |

A **constant** offset of 10.0 s — this server's presentation-time base — which is precisely the property
`decodedOffsetSpreadSeconds` asserts, and precisely what a server returning the same segment ten times cannot
produce. The playlist total, 114 × 3.0 = 342.00 s against a 340 s source, is separately checked against the
media's own duration so that a playlist generated for a different item fails rather than quietly relocating
every seek.

**Two assertions exist only because of this substitution**, and neither has an equivalent in the Jellyfin gate:

- `EM19-seek-playlist-usable` refuses a playlist the seek gate could not mean anything against — one segment,
  or all-zero durations, or duplicate references. Every per-seek assertion (ten requests, ten 200s, ten
  decodable segments) passes against those, while `serverPositionSeconds` is identically zero for all ten and
  the position error measures nothing.
- `EM19-seek-segment-position-source` asserts that **no** segment URL declares a position of its own. If a
  future Emby started publishing `runtimeTicks`, this driver would go on summing `#EXTINF` while a better
  number sat unused. A non-zero count says *re-measure which source is authoritative* rather than continuing
  silently.

### 3.6 The write-refusal test has to name the uid it runs as

Emby's image entrypoint is `/init`, an s6 supervision tree, and its config carries `UID=2`, `GID=2`, `PUID=`,
`PGID=` — the documented way to choose the uid is the **environment**, not `--user`. Started with
`-e UID=1000 -e GID=1000`, `ps -o user,comm` inside the container shows `root s6-svscan`, `root s6-supervise`,
… and **`1000 EmbyServer`**. `docker exec … id` reports **`uid=0(root)`**.

Jellyfin's gate runs its container as `--user 1000:1000`, so every process in it — including a `docker exec` —
is the media server's own uid, and its write-refusal script asserts `id -u != 0` inline.

Copying that here **fails**, which is fine: it would be noticed. The dangerous repair is the one where somebody
deletes the uid assertion to make it pass, because then the mutation attempts run as root — and root failing to
write to a read-only FUSE mount is a much *weaker* statement than an ordinary uid failing to, since it is the
one case where the kernel's own permission bits would not have refused anyway.

**So the gate runs the mutations twice, as both, and asserts both**, because neither alone says what both say:

- **as uid 1000**, the identity the server actually runs as. This is the claim that matters: the media server
  cannot write to its own library root.
- **as root**, which is strictly stronger: no permission bit is standing in the way, so what refuses is the
  daemon and not the kernel's mode check.

The script asserts *which* identity it is running as before it attempts anything, so a future `docker exec` that
silently landed somewhere else fails rather than quietly testing the wrong thing. The same `-u 1000:1000`
applies to the pre-scan readability check and to the post-remount byte read — root being able to read the mount
says nothing about whether the server can, and the server is the thing that has to.

**The capability set is the narrowest the image actually starts under, measured rather than copied**: `--cap-drop
ALL`, then `SETUID`/`SETGID` for the privilege drop and `CHOWN`/`DAC_OVERRIDE`/`FOWNER` for the config
directory it takes ownership of on first run. `--cap-drop ALL` alone — which is what the Jellyfin gate uses,
because that container is `--user`ed from outside — leaves this image unable to start at all.

### 3.7 What a stable Emby item id does and does not corroborate

Emby's item ids are small decimal integers minted by its own database: the library created by this gate is
`ItemId: "3"` and its first movie is `Id: "6"`, with `MediaSources[0].Id` of `mediasource_6`. Jellyfin mints a
32-hex GUID derived from the item's path.

**"Zero item-id churn" is exactly as meaningful against a row id as against a GUID** — a scanner that deleted
and re-created the row gets a new number. What it does *not* mean on Emby is what it incidentally also means on
Jellyfin: that the id is a function of the path, so a matching id independently corroborates a matching path.
On Emby the id is a counter. The gate therefore asserts the projected **path** separately
(`EM1x-…-path-drift`), because otherwise that half of the identity claim would be carried by nothing.

The media-source id being `mediasource_<id>` rather than the item id is a correctness question and not
cosmetics: using the item id produces a request the server answers differently.

### 3.8 How the mid-scan window is made deterministic

A small library scan takes a couple of seconds, and the handshake — observe running, publish, observe running
again — costs about as long. Timing it is a coin flip, and a coin flip with a retry loop around it is still not
evidence. **Measured on this server, a one-item scan starts and finishes between two polls**: the first sample
after `POST /Library/Refresh` already reads `State: "Idle"` with a new `LastExecutionResult.StartTimeUtc`. That
is exactly the fast-complete case the shared `ScanBarrier` was built for, and a barrier demanding that
`Running` be *observed* would hang forever here.

So the scan is made to **block on something the gate controls**. A brand-new remote entry is published first;
its probe windows are not in the daemon's cache, so the scanner's probe of it must fetch from the endpoint —
and the endpoint is told to hold that request. The entry has to be new: anything already scanned has its
windows cached, and `EM14` asserts a re-scan costs the provider nothing, so a hold on an existing entry would
never be hit.

The publish is then bracketed by **two present-tense observations** that the scanner is still in flight, with
the live `currentHeldWaiters` gauge up before and after and **zero** hold timeouts in between — so the publish
landed strictly inside the scan window with both edges observed, rather than one observed and the other
assumed. There is no `sleep` anywhere in the handshake.

### 3.9 Five minutes of transcode, and the one thing this gate does not claim

`EM20` proves **five minutes of paced, continuously decoded, transcoded playback**. It does **not** claim five
minutes of encoder CPU time, and the difference is measured rather than glossed over.

| Asserted | What it refuses |
|---|---|
| The **source** codec, as the media server identified it, is `mpeg4` | a "transcode to h264" from a source that was already h264 |
| Decoded `h264` media time ≥ 300 s, over **every** consumed segment | counting files the server emitted; a remux; empty segments |
| Wall span across segment arrivals ≥ 300 s | nothing on its own — see the next row |
| Longest gap between **adjacent** arrivals ≤ 20 s | consuming every segment in ten seconds, sleeping, and fetching one more at the end |
| ≥ 25 % of the required media decoded in the **last third** of the window | a dense start with a padded tail |
| All consumed segments distinct | one segment delivered fifty times, which satisfies every row above |

| Recorded, not asserted | Why |
|---|---|
| The encoder's own output-file span, and how many files there were | it is how far **ahead of the paced client** the encoder ran, not how long it ran. `EnableThrottling` is false by default here and the gate does not turn it on. **On this server it came back empty** — see below |
| Samples with live `TranscodingInfo` | it goes null when the job exits. **On this server it was zero at every sample** — see below |
| Samples where the server reported the playback method as `Transcode` | **the field is client-writable in this API family.** The Jellyfin gate established it by three-arm negative control: reporting `DirectPlay` made that server record `DirectPlay` while a real transcode served the segments. This gate authors **no** `PlayMethod` at all, and measured that the pinned Emby reports `Transcode` on its own when the client asserts nothing — which is recorded and carries no assertion |

**Both encoder instruments returned nothing on this server, and that is reported rather than glossed.**
Measured: the encoder-ahead span was **0 seconds over 0 files**, and live `TranscodingInfo` was present in
**0 of 21** successful session samples — while, over the same window, 108 distinct segments arrived, every one
decoded as `h264` from an `mpeg4` source, totalling 324 decoded media seconds across a 320-second wall span.

**A zero here is not a finding about the encoder.** It is equally consistent with two things this gate cannot
tell apart: the server writing no observable output, and the server writing segments and deleting them once
served — which the Jellyfin gate measured *its* server doing, and which a fifteen-second sampler can miss
entirely. That is exactly why both numbers are recorded and asserted on by nothing. `EM17` asserts only that
the directory being read is the one bound in; it does not license reading a zero as "the encoder wrote none".

The five-minute claim rests where §3.9's first table puts it: on the **decoded output**, which is not empty and
was produced by a decoder outside the process that fetched it.

**G10 is recorded as run, not as closed.**

### 3.10 The field that is never sent, and what replaces it

`GET /Items?…&fields=Path,MediaSources` and `…&fields=Path,MediaSources,LocationType` return the **identical**
key set on the pinned server:

```
Name, ServerId, Id, Container, MediaSources, Path, RunTimeTicks, Size, Bitrate, IsFolder, Type, UserData,
ImageTags, BackdropImageTags, MediaType
```

`LocationType` is in neither. Asking for it does not produce it. Jellyfin returns it, and the Jellyfin gate's
ordinary-file predicate requires it to read `FileSystem`.

**Dropping the check is not the response.** `LocationType === 'FileSystem'` refused two things: an item the
server catalogued as `Virtual` — a placeholder it never opened — and one it considered `Remote`. Both are
exactly the failures this appliance exists to avoid being mistaken for, and the whole product claim is that a
media server sees *a file on a disk*.

**What Emby supplies instead is a straighter answer to the same question.** `MediaSources[0].Type` is the
media-source kind; it reads `"Default"` for a real file, and the value meaning "catalogued but not backed by
openable media" is `"Placeholder"`. That is the same refusal `Virtual` performed, made against the media source
rather than inferred from the item. Beside it, `MediaSources[0].Path` is the file the source actually points
at — **which the Jellyfin predicate never checked at all** — so requiring it to equal the item's own projected
path is a check this family of gates did not previously have.

So one field this server does not send is replaced by two it does, one of which asserts strictly more than the
original. The remaining conditions — `Protocol=File`, `IsRemote=false`, a non-empty container, direct-play
support, and not a `.strm` — are unchanged.

## 4. Defects found while building this gate

**An inherited predicate that matched zero of two correctly catalogued entries — found by a failing run, not by
reasoning.** The first complete attempt at this gate reached `EM3-scan1`, reported `item-count measured=2
budget=2`, and then reported `corpus-matched measured=0 budget=2`. Both published entries were present, at the
right size, as real files; the predicate was requiring `LocationType === 'FileSystem'`, and this server sends
no `LocationType` at all (§3.10). Two things came out of it:

- the predicate now rests on fields Emby actually sends, and asserts one thing more than the original did;
- **the failure is now diagnosable.** `corpus-matched` failed with a bare `0/2` and no indication of which
  property was wrong, which cost a whole half-hour run to interpret. Its note now carries the breakdown —
  how many were missing, at the wrong size, or not ordinary — and the first distinct reasons the predicate
  gave. A count with no diagnosis is a count somebody has to reproduce to understand.

**One directory, two spellings, and a run that died twenty minutes in.** The second complete attempt reached
the five-minute paced play — past the scan, the corpus, the repeat scan and the ten seeks — and died with
`ENOENT ... \c\Users\...\emby-consumer-token`. On an MSYS shell the absolute path Docker Desktop understands is
`/c/Users/…`, and a Windows `node` handed that opens `C:\c\Users\…`, which does not exist. The gate script has
carried that distinction in its own header from the first line it was written; the driver did not, because it
inherited a signature from the Jellyfin driver — which takes only Docker's spelling and gets away with it
**because it has no credential to deliver and therefore never opens the directory**. The paced consumer here
writes two files into it. `PacedPlayOptions` now takes both spellings, the gate passes `$WORK` for Docker and
`$REL` for node, and the offline suite asserts it by actually calling the function and checking where the files
landed — a structural check alone would pass against a driver that named the field and used the other one two
lines later.

**A five-minute gate that failed on a rounding boundary rather than on behaviour.** The third complete attempt
reached the paced direct play and reported `EM18-paced-play-decoded-media-seconds` **299 against 300** —
alongside startup 2.3 s, no stall, and a healthy pacing ratio. Nothing was wrong with the playback. `ffmpeg -t
300` stops at the last output frame at or before 300 s, so the final `-progress` record reports marginally
under 300 s of decoded media, and `Math.floor` of that is 299. Asking the consumer for exactly the number
being asserted makes the gate turn on where the last frame lands.

**The threshold did not move; the request did, and it moved up.** The consumer is now asked to decode
`300 + PACED_PLAY_DECODE_MARGIN_SECONDS`, and the assertion is still the acceptance plan's 300 decoded media
seconds. A pass therefore means *at least* five minutes of decoded media rather than exactly five minutes
measured with a favourable rounding, and every other bound — the pacing ratio, the stall ceiling, the wall
clock — still applies across whatever the consumer actually did. **The Jellyfin and Plex gates carry the same
knife-edge** and have so far landed on the other side of it; that is recorded here rather than fixed there,
because changing a merged gate's thresholds is not this tranche's work.

**A token mode that would have failed on the platform this gate exists for.** The token file was written 0600.
The consumer container runs as uid 1000; the gate does not, and on an Unraid host it runs as root — so the
container that must read the file could not have. Docker Desktop ignores modes on bind mounts, so every run
here would have passed and the first Unraid run would have failed in the five-minute phase. It is now 0644,
with the cost stated in §3.3 rather than left to be discovered.

**A version string that would have failed the report, found by the offline suite rather than by a run.** §7 of
the acceptance plan forbids an IP address in a report, and the pattern enforcing it is four dot-separated groups
of one to three digits. Emby's version is `4.9.5.0` — it matches exactly. The entirely reasonable note
`server version 4.9.5.0` therefore made `findRedactionProblems` refuse the **whole report**, at the very end of
a half-hour run, after every assertion had already passed. The fix is `redactionSafeVersion`, which renders the
version with hyphens; the alternative — widening the address pattern to admit "things that look like versions"
— would have put a hole in a rule every report in this repository is checked against, in order to accommodate
one note. The offline suite carries the leaky row as a regression test.

**A `#EXTINF` suffix that parsed to `NaN`.** Emby writes `#EXTINF:3.0000, nodesc`. Stripping only the first
comma leaves `3.0000 nodesc`, and `Number(…)` of that is `NaN`. A `NaN` cumulative position would have made
every seek assertion below it **vacuous rather than failing** — the comparison `Math.abs(NaN - x) > ceiling` is
false, so a position error of "not a number" passes a ceiling. The parser splits on the comma and the offline
suite asserts no duration parses as `NaN`.

**A segment with no usable `#EXTINF` in front of it.** Dropping such a segment would renumber every segment
after it, so a seek to index N would fetch a different segment from the one whose position was computed — and
nothing downstream could see that it had. It is kept, at zero, and `embyPlaylistProblems` is what refuses a
playlist made of them.

## 5. Where this can and cannot be run

| Environment | What the gate closes |
|---|---|
| **Windows / Docker Desktop** | Everything above, provided `/dev/fuse` is reachable from a container. **This is not Phase 1 closure and SHALL NOT be reported as one.** If FUSE is missing the gate exits **77**, the three-run wrapper propagates it, and no caller can read the result as a pass. |
| **Linux CI** | The offline suite (`npm run test:projection-emby-dataplane`) runs anywhere. The gate itself needs FUSE, mount propagation into a sibling container and a media server; it is **not** wired into a CI job, because a gate that is flaky in CI gets disabled and then gets deleted. |
| **Linux / Unraid, operator-run** | The place the tranche actually closes, three consecutive times: `npm run go:emby-dataplane-gate:three` — **and the same for Jellyfin and Plex**. |

## 6. What is still not proved

- **Three consecutive green runs on Linux or Unraid**, which is what the acceptance plan means by passing. Every
  run of this gate has been on Windows / Docker Desktop.
- **A real Unraid host**: real shares, real mount propagation, real Unraid container templates.
- **A real provider endpoint**, and therefore **TorBox**: real TLS, real redirects refused, real `Content-Range`,
  real `429`. The only endpoint any automated gate here contacts is `internal/fakeprovider`, in a container, on
  a private network.
- **The expiring-lease gates (G24–G26) through a media server.** The endpoint supports the mode and this gate
  runs it in **resolver** mode — a real lease is minted and searched for — but nothing here lets one lapse
  mid-read.
- **G18, the simultaneous-client gate.** It requires all three media servers scanning at once. Three gates now
  exist; none of them has ever run beside the other two.
- **G22**, the rclone/WebDAV comparison control, and **G27**'s three-server half.
- **Anything air-gapped.** Nothing this gate asserts depends on an external service being reachable — the server
  is stood up entirely through its own local API and the library it creates has every internet fetcher off — but
  the gate's network is an ordinary bridge, and Emby's own `/System/Info/Public` was observed reporting a
  **WAN address**, so the server does reach out on its own initiative. "Does not depend on the internet" and
  "has been proved with no route to it" are different claims and only the first is made.
- **A graceful daemon restart under a long-running media server**, on Linux or Unraid. This gate exercises the
  `SIGKILL` path, which is strictly more violent and is followed by a byte-for-byte read through the media
  server's own mount so it cannot pass on a dead one. The graceful path is not proved here, for the reason the
  Jellyfin document records: on this host a graceful daemon stop can leave a container that was started *before*
  it holding a dead FUSE mount whose `stat` still answers.
- **The credential's absence from the consumer's own process table.** §3.3 asserts the token never reaches
  `docker inspect`. It does reach the argv of the ffmpeg process inside its container, because ffmpeg has no
  file-based header option, and that is stated rather than asserted away.
- **Hardware-accelerated transcoding**, which this server reports as requiring Emby Premiere. The gate forces a
  software transcode and asserts nothing about the licensed path.

A Windows or Docker Desktop green run is not a Phase 1 pass and is not reported as one. **Phase 1 is open.**

## 7. The run record

**Status: this gate has never been run to completion. It closes nothing, and the Emby column of
`docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6.1 still reads `not run`.**

This section is deliberately the only place in this document that says how many times anything has happened, and
it is deliberately separate from the description of what the gate asserts. A document that describes a gate's
assertions reads, at a glance, exactly like a document that reports them holding — and this repository has three
hundred phases of the second kind written before the first.

**A gate existing is not a gate passing.** Everything in §3 is a statement about what
`deploy/projection-emby-dataplane-gate.sh` asserts when it runs. Until a complete run passes with a recorded
assertion count, that is a description of code and not evidence about a media server.

| Run | Environment | Command | Outcome |
|---|---|---|---|
| — | — | — | **no complete run has been recorded** |

The findings in §3 are a different kind of statement and they **were** measured: each one comes from a live,
digest-pinned `emby/embyserver` 4.9.5.0 answering real requests during the construction of this gate, and the
request and response are recorded beside each constant in `src/core/projection/emby-dataplane.ts`. Those are
measurements of the media server. They are **not** measurements of the data plane, because none of them was
taken through a FUSE mount.
