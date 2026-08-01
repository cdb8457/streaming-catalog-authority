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
| `JD4` | Direct play (`static=true`) returns the file's bytes, digest-compared against the value recorded outside the mount, for **both** the local and the HTTP Range entry. |
| `JD5` | A ranged request answers **206** with the exact `Content-Range`, asserted **before the body is read**, and the bytes match a window hashed on the host. A 200-with-the-whole-file cannot pass as a successful seek. |
| `JD6` | A forced transcode, proved by **decoding what came out**: the media is encoded as `mpeg4`, `h264` is demanded, and the segments Jellyfin produced are ffprobed and must be `h264` with decodable packets. |
| `JD7` | A stream in flight while a successor is published **completes correctly**; a stream in flight across a daemon `SIGKILL` may fail, which is the behaviour §4 G12 of the acceptance plan explicitly permits, and is recorded as such rather than hidden. |
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

Alongside them, outside the driver: every mutation attempted from **inside Jellyfin's own non-root container**
is refused; the mount is deliberately **not** bound `:ro`, so what refuses the write is the daemon and not a
Docker flag. The manifest directory, the daemon's probe cache and the media server's own state are searched
for access material. The probe cache is additionally bounded in size, because a read path that started
writing whole objects through it would pass every substring check ever written.

## 4. Two defects this gate found in itself, and what they cost

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
| **Windows / Docker Desktop** | Everything above, provided `/dev/fuse` is reachable from a container. **This is not Phase 1 closure and SHALL NOT be reported as one.** If `/dev/fuse` is absent the gate skips loudly and says the whole data plane went unproven. |
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
