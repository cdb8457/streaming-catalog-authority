# Projection Phase 0 — the executable product contract

**Status:** frozen. Every requirement below is normative. **MUST**, **MUST NOT**, **SHALL** and **SHALL NOT**
carry their RFC 2119 meanings. There are no aspirational statements in this document; a sentence that cannot
be tested does not belong here.

**Machine-readable form.** `src/core/projection/manifest-v1.ts` (structure, identity, admission, succession)
and `src/core/projection/runtime-contract.ts` (operations, errors, deadlines, limits, caches, secrets,
platform). `docs/schemas/projection-manifest-v1.schema.json` is the portable JSON Schema rendering of the
structural half. `test/projection-manifest-v1.ts` proves the three agree and runs in the default `npm test`.

**Scope.** This document freezes only what Projection Phase 1 needs. Anything not decided here is not
deferred with a promise — it is simply out of scope, and a later phase will decide it or will not.

---

## 1. The boundary

1.1 The existing TypeScript/PostgreSQL application **SHALL** remain the sole control plane and catalog
authority. `projectiond` **SHALL NOT** write to the catalog database, and **SHALL NOT** hold any durable
state other than its probe-prefix cache and the last admitted manifest artifact.

1.2 `projectiond` **SHALL** expose a single read-only namespace of **regular files**. A media server
**SHALL NOT** be able to observe a symlink, a WebDAV URL, a provider identifier, an adapter name, or any
distinction between a local and a remote entry — except that a remote entry may be slower and may fail.

1.3 Phase 1 **SHALL** implement exactly two source adapters: **local passthrough** and **HTTP Range**. FUSE
is the frontend. An rclone or WebDAV configuration **MAY** be run as a comparison control in the acceptance
harness; it **SHALL NOT** appear in a production deployment path, a Compose file, or a runbook.

1.4 There **SHALL** be no SQLite and no second database anywhere in the data plane.

1.5 PostgreSQL **SHALL** publish an immutable, versioned, digest-checked manifest artifact, atomically.
`projectiond` **SHALL** load it into immutable memory. While the control plane is unavailable, `projectiond`
**SHALL** continue serving its last admitted generation, unchanged, indefinitely.

1.6 **Unavailability SHALL NOT present as absence.** The namespace is derived from asserted state. A failed,
short or timed-out scan **SHALL NOT** be able to produce a manifest, and **SHALL NOT** be able to remove an
entry. Every rule in §4 and §5 exists to make that structurally true rather than a matter of care.

1.7 v1 exposes **no mutation surface**. There is no write, create, rename, delete, mkdir, rmdir, truncate,
setattr, link, symlink, xattr-set or fallocate operation. Attempting one **SHALL** return **EROFS**.

1.8 **The control plane SHALL hold a stable source registry, and it is where every manifest field comes
from.** *(Amendment — Projection Phase 1, the publisher. Building the producer proved this decision was
missing rather than merely unstated.)*

A manifest names, per entry, an exact byte length, an mtime, a visibility state and a stable source
descriptor. Nothing in the catalog schema before this amendment could answer any of them: `items` is an opaque
id and an encrypted identity blob, with no file, size, path or locator anywhere in it. A producer that
inferred them would be publishing a guess, and §2.7 already forbids a guessed size. So the boundary is
explicit: `projection_source_roots`, `projection_versions`, `projection_entries` and
`projection_entry_sources` (schema v10), written **only** through `cat_projection_*` commands by
`src/core/projection/source-registry.ts`, and read by the publisher.

1.8.1 The registry **SHALL NOT** store an access URL, a signed link, a token, a header, an expiry, a lease, a
WebDAV credential or any other ephemeral access material. This restates §3.3.1 at the place where a producer
could otherwise smuggle one in, and it is enforced twice: `checkLocatorValue` refuses it at registration, and
a column CHECK refuses `://`, `?`, `&`, `@` and `\` in the database.

1.8.2 The registry **SHALL NOT** contact anything. It is asserted state, exactly like `import_history` and
`managed_collections`. No row in it is obtained by scanning a filesystem, calling a provider or scraping
provider state, and nothing in Phase 1 adds a code path that could.

1.9 **Publication SHALL be recoverable from PostgreSQL alone.** *(Amendment — Projection Phase 1.)* The exact
artifact bytes, their length and their digest are committed to `projection_generations` **before** anything is
written to the manifest directory, and the row that says which generation is current is updated **before** the
pointer file a daemon reads. When the database and the directory disagree, the database is right and the
publisher rewrites the directory from the committed bytes — never the reverse. A publisher that has repaired
the directory **SHALL NOT** also publish a successor in the same run: §5 check 5 makes a skipped sequence a
permanent refusal, so a repair that raced ahead would strand a running daemon.

---

## 2. The manifest artifact

2.1 The artifact **SHALL** be a single JSON document with `format` = `catalog-authority.projection-manifest`
and `version` = `1`. It **SHALL** be at most 256 MiB and carry at most 200 000 entries. The two bounds are
sized against each other: a full-fidelity entry is under 1 KiB of JSON, so a manifest at the entry bound fits
inside the byte bound rather than being refused by it first.

2.2 Publication **SHALL** be atomic. The producer writes the generation artifact under a name no reader
watches, `fsync`s it, then publishes a **pointer** by `rename()`. A reader **SHALL** see either the previous
pointer or the new one, never a prefix of either.

2.3 The pointer **SHALL** carry the generation id, the sequence, the artifact's exact byte length and its
`sha256:` digest over the **exact artifact bytes**. `projectiond` **SHALL** verify both before parsing, and
**SHALL** refuse a mismatch without disturbing the generation it is already serving.

2.4 A generation **SHALL** carry: `generationId`, a strictly increasing `sequence`, `createdAt`, a
`predecessor` (`null` only at sequence 1) naming the previous generation's id, sequence and artifact digest,
a `provenance` block (producer, producer version, control-plane schema version, source snapshot digest, probe
window), and an `admission` block (intent, entry count, deletions, deletion-guard state).

2.5 An entry **SHALL** carry: `projectedEntryId`, `logicalMediaId`, `projectedVersionId`, `path`, `nodeKind`,
`sizeBytes`, `mtime`, `mode`, `readOnly`, `inode`, `visibility`, `degraded`, `retiring`, `sources`. Every one
of those fields is required; an unknown field **SHALL** cause refusal of the whole generation.

2.6 `nodeKind` **SHALL** be `file`. Directories are **derived** by `projectiond` from entry paths. A
directory has no byte stream, therefore no projected version, therefore no inode this contract could derive
without falling back to the path — and a path-derived inode is exactly the instability §3 forbids.

2.7 `sizeBytes` **SHALL** be the exact byte length. There is no estimate, no unknown and no placeholder. An
entry whose exact size is not known is **not projectable** and **SHALL NOT** appear in a manifest.

2.8 `mode` **SHALL** be `0444` and `readOnly` **SHALL** be `true`.

2.9 **The artifact bytes SHALL be canonical.** *(Amendment — Projection Phase 1.)* §2.3 makes the pointer's
digest a digest over the exact bytes, which is only a contract if "the exact bytes" is a rule rather than a
producer's choice. The rule is `serializeManifestArtifact()`: canonical JSON — recursively key-sorted, no
whitespace — plus one trailing newline. Two producers of the same manifest therefore emit the same bytes down
to the last one, and a retry emits the artifact it emitted before rather than an equivalent one.

---

## 3. Identity — three layers

3.1 **Layer 1, logical media.** `logicalMediaId` is the control-plane record. Many projected entries **MAY**
share one.

3.2 **Layer 2, projected version.** `projectedVersionId` identifies **one exact byte stream**. `sizeBytes`,
`mtime` and `inode` belong to the projected version, not to the entry: every entry naming a given projected
version, in any generation, **SHALL** carry identical values for all three.

3.3 **Layer 3, source locator.** A source is replaceable and carries no identity. A locator **SHALL** name a
configured `rootId` (local) or `endpointId` (HTTP Range) plus an opaque reference. A locator **SHALL NOT**
contain a URL scheme, a query string, userinfo, a backslash, or any credential-shaped word. A provider token
is **never** a manifest field.

3.3.1 **A locator is STABLE and SHALL NOT carry a lifetime.** There is no `expiresAt`, no TTL, no signed URL
and no lease in a manifest, and a producer that emits one **SHALL** be refused rather than ignored. Access
material expires; the reference to the object does not. Turning the reference into something fetchable is
transport resolution (§7.6), it happens in the daemon, in memory, and it never reaches this document.

3.4 `inode` **SHALL** be derived deterministically from `projectedVersionId` and from nothing else — never
from the path, never from the active source, never from a provider identifier. The derivation is
`deriveInode()` in `src/core/projection/manifest-v1.ts`: the leading 8 bytes of
`sha256("projectiond.ino.v1\n" || projectedVersionId)`, big-endian, top bit cleared, values below 1024
displaced upward. Two different projected versions deriving one inode **SHALL** cause refusal.

3.4.1 **Every id a producer emits SHALL be derived, by the shared helper, from a named input.** *(Amendment —
Projection Phase 1.)* Phase 0 froze the SHAPE of each id and left HOW a producer arrives at one unstated,
which is a gap: a second implementation of "how an id is computed" is exactly how the two halves of this
boundary end up disagreeing about whether two generations name the same entry, and an id that is not a pure
function of stated inputs cannot be recomputed by a reviewer or reproduced by a retry. The derivations live in
`src/core/projection/manifest-v1.ts`, each under its own domain separator, and nowhere else:

| Id | Derived from | Why that input |
|---|---|---|
| `projectedEntryId` | the projected `path` | Makes §3.5.1 and §3.5.2 structural. A carried entry cannot change its path without becoming a different entry, and a corrected path **is** a new entry by construction. |
| `projectedVersionId` | an explicit control-plane **version key** | Deliberately **not** size-and-mtime: byte identity is optional on a single-source entry (§3.6), so a size-and-mtime derivation would collide two genuinely different byte streams that happen to share both — and a collision here is two files sharing one inode, which is the one failure a media server silently swallows. Two entries share a projected version when, and only when, the control plane says so. |
| `sourceId` | the source `kind` and its `locator` | §3.3 says a source is replaceable and carries no identity, so its id is a function of what it points at and nothing else. |
| `generationId` | the `sequence`, the content digest and the predecessor digest | A publish retried over an unchanged snapshot recomputes the same id and the same bytes, which is what makes a retry idempotent instead of a second generation saying what the first one said. |
| `deletionIntentId` | the operator's intent key | Stable across the generations an entry spends `retiring`, which is what §5 check 11 compares. |

3.5 `projectedEntryId` **SHALL** be stable across generations.

3.5.1 **`path` is IMMUTABLE for a carried `projectedEntryId`.** A successor that changes it **SHALL** be
refused (`PATH_CHANGED_FOR_CARRIED_ENTRY`).

An earlier draft of this contract permitted a declared "relocation" and stated that it earned no
media-server refresh. That was not true and could not be made true here. A media server does not learn a new
path without reconciling, and this contract has no mechanism that reconciles it; a stable inode is evidence
about *this* namespace, not evidence that Plex, Jellyfin or Emby preserve their own library item across a
rename. Rather than assert a property of software this project does not control, v1 takes the smaller
contract that it can actually hold.

3.5.2 **A corrected path is modelled as retire, delete, add.** The entry at the wrong path is marked
`retiring` with a deletion intent, its grace deadline elapses, an explicit deletion generation removes it,
and the corrected path arrives as a **new** `projectedEntryId`. Both halves are reported to the media server
under §4.7, because both halves are real.

3.5.3 The control plane **MAY** preserve the `logicalMediaId` and the `projectedVersionId` across that pair,
and if it does, the new entry carries the same `inode`, `sizeBytes` and `mtime`. That is the control plane
keeping its own relationship straight. It is **not** a guarantee that a media server preserved its item:
Plex, Jellyfin and Emby **MAY** each see a deletion and an addition, and this contract does not claim
otherwise.

3.6 **Byte identity.** Two sources **MAY** share a `projectedVersionId` only with proof: the exact
`sizeBytes` plus partial hashes at the fixed offsets of §3.7. Without identical proof on every source they
**SHALL** be separate projected versions. `byteIdentity` is **required** on every source of an entry with more
than one source, and on every source of every entry whose projected version appears more than once.

3.7 The **probe plan** is fixed by size, not chosen by a producer. The probe window is 1 MiB. A file of at
least 3 MiB is proved by three probes — `head` at offset 0, `middle` at `floor(size/2) - 512 KiB`, `tail` at
`size - 1 MiB`. A smaller non-empty file is proved by one whole-file probe. A zero-byte file has no probes. A
manifest declaring any other offset **SHALL** be refused.

---

## 4. Visibility lifecycle

4.1 The states are `available`, `degraded` and `retiring`. There is no fourth state and no "missing".

4.2 **`available`.** Readable through its sources in preference order.

4.3 **`degraded`.** The entry **SHALL** remain present in the namespace with **identical** `inode`,
`sizeBytes` and `mtime`. A read **SHALL** fail fast with **EIO**, answered **from local state**, with
**zero provider traffic**. `degraded` **SHALL** carry a closed-set `reason` and a `since` timestamp. A
degraded transition, in either direction, **SHALL NOT** trigger a media-server refresh.

4.3.0 A `reason` is an assertion by the **control plane**, from its own observation, at the moment it
produced the generation. It is not a live report of the daemon's internal state, and the daemon **SHALL NOT**
act on it beyond failing the read: two entries degraded for different reasons behave identically.

4.3.1 **`projectiond` SHALL NOT re-probe a degraded entry.** There is no per-entry retry timer and no
per-entry backoff that ends in a provider request — a backoff that eventually probes would make `degraded`
cost more traffic than `available`, which is the opposite of why it exists. A degraded entry becomes
`available` only when the control plane admits a generation that says so. The **only** traffic-generating
backoff in the daemon is the circuit breaker's single half-open probe per endpoint per cooldown (§7.7),
which is per **endpoint** and not per entry, and it recovers the endpoint, not the entry's visibility.

4.4 **`retiring`.** Requires affirmative deletion intent: a `deletionIntentId`, a `declaredAt` and a
`graceDeadline` strictly after it. A retiring entry **SHALL** remain fully readable.

4.5 **A grace deadline expiring removes nothing.** A retiring entry **SHALL** remain in the namespace,
readable, until an explicit deletion generation names it. There is no timer, no sweep and no expiry path that
removes an entry. An entry **MAY** be un-retired, which is what makes a mistaken retirement recoverable.

4.6 **Failed or partial discovery SHALL NOT remove an entry.** A routine generation that simply omits an
entry its predecessor carried **SHALL** be refused (`ENTRY_DISAPPEARED_WITHOUT_DELETION`).

4.7 **Media-server refresh.** `projectiond` **SHALL** request a refresh for **additions** and for
**completed explicit deletions**, and there is no third category and no silent one.

A degraded transition earns nothing, in either direction — `degraded` moves no path, no inode, no size and
no mtime, so there is nothing for a media server to reconcile, and a refresh on it would be exactly the
library churn this design exists to prevent. Nothing else can change under a carried entry: §3.5.1 makes a
path immutable, and §5 check 11 makes identity immutable. So a refresh request naming only additions and
deletions is a **complete** account of what a media server would otherwise have had to discover for itself.

---

## 5. Generation admission

A candidate generation **SHALL** be admitted only when every check below passes, in order. A failure at any
step **SHALL** leave the currently admitted generation untouched and serving.

1. **Envelope** — format, version, size bound, entry-count bound.
2. **Digest and length** — the artifact's bytes match the pointer's `sha256:` digest and byte length exactly.
3. **Schema** — every required field present, every value in range, no unknown field anywhere.
4. **Provenance** — producer is `catalog-authority`, producer version is a semantic version, control-plane
   schema version is known, snapshot digest is well formed, probe window equals the configured window.
5. **Predecessor** — `sequence` is exactly one past the admitted generation's; `predecessor.generationId`,
   `predecessor.sequence` and `predecessor.manifestDigest` match the admitted generation exactly. A sequence
   equal to or below the admitted one **SHALL** be refused, not reordered.
6. **Paths** — every path normalized per §6; unique within the generation; unique under a case-and-form fold.
7. **Inodes** — every `inode` equals `deriveInode(projectedVersionId)`; no two distinct projected versions
   share one.
8. **Projectability** — `sizeBytes` is an exact non-negative integer within bound; `mode` is `0444`;
   `readOnly` is `true`; `nodeKind` is `file`.
9. **Duplicate identity consistency** — entries sharing a `projectedVersionId` agree on `sizeBytes`, `mtime`,
   `inode` and byte identity.
10. **Source locators** — at least one source; source ids unique; preferences a contiguous total order from
    zero with no tie; locator shape valid for the kind; no URL shape and no credential-shaped value.
11. **Succession** — every predecessor entry is present unless named in `admission.deletions` of a generation
    whose `intent` is `deletion`; every deleted entry was `retiring` in the predecessor with a
    `graceDeadline` at or before the admission clock; retained entries preserve `logicalMediaId`,
    `projectedVersionId`, `inode`, `sizeBytes` and `mtime`; and a carried entry's `path` is unchanged
    (§3.5.1) — there is no declaration that makes a moved path admissible.
12. **Shrink guard, defense in depth** — a deletion set larger than `max(50, 10% of the predecessor's entry
    count)` **SHALL** require `deletionGuardAcknowledged` with a `deletionGuardDigest` equal to the sha256 of
    the canonical JSON of the sorted deletion id set. An acknowledgement over any other set **SHALL** be
    refused.
13. **Atomic swap** — the new generation becomes visible to all subsequent operations in one step. There is
    no interval in which part of one generation and part of another are observable.
14. **Retention** — a prior generation **SHALL** be retained while any open handle pins it, and **SHALL** be
    reclaimed only after the last such handle is released.

---

## 6. Path normalization

6.1 A path **SHALL** be relative, slash-separated, NFC-normalized, and **SHALL NOT** have a leading or
trailing slash, an empty segment, a `.` or `..` segment, a backslash, a control character, or a segment with
leading or trailing whitespace. A path **SHALL** be at most 4096 bytes; a segment at most 255 bytes.

6.2 Normalization is a **refusal**, never a rewrite. A producer emitting `a//b` does not have a stable rule
for that path, and silently repairing it would make the daemon's namespace disagree with the control plane's
idea of it.

---

## 7. Handles and reads

7.1 `open` **SHALL** bind to exactly one `projectedEntryId`, one `generationId`, one `sourceId` and one
`sourceGeneration`. The handle **SHALL** remain valid across manifest swaps; a generation swap during
playback is invisible to the player. `release` permits reclamation of a pinned prior generation.

7.2 **Mid-handle failover SHALL be permitted only to a source whose byte-identity proof is identical to the
bound source's.** Without that proof the read **SHALL** fail with **EIO**. Handing a player the middle of a
different file is worse than failing, because it is silent.

7.3 `getattr`, `lookup`, `readdir`, `readdirplus`, `statfs`, `open` and `release` **SHALL** be answered from
immutable memory with **zero** database calls and **zero** provider calls. This is why a full library scan of
an entirely remote namespace costs no provider traffic beyond the probe window.

7.4 **Deadlines.** Every read has an absolute deadline of 20 s covering all attempts. Connect is bounded at
5 s, first byte at 10 s, body idle at 15 s. A read that exceeds its deadline **SHALL** return **EIO**; it
**SHALL NOT** extend and **SHALL NOT** become the next read's problem.

7.5 **Range discipline.** A partial request **SHALL** be answered `206` with a `Content-Range` matching the
requested first byte, last byte and the manifest's total size exactly. A **`200` full-body answer to a ranged
request SHALL be treated as a protocol violation**: the connection is aborted at the header, no body byte is
buffered, and the source is failed. A short body is a truncation, not an EOF. A `Content-Range` total
disagreeing with the manifest size means the bytes are not this projected version.

7.6 **Transport resolution.** A manifest locator is a **stable reference** (§3.3) and has no lifetime. The
thing that has a lifetime is the **access material** — a signed URL, a redirect target, a lease — that a
provider hands back when asked to make that reference readable. `projectiond` **MAY** resolve a stable
reference into access material, and **MAY** re-resolve it when the material lapses, under §7.6.1 to §7.6.6.

That is **transport resolution**, and it is the daemon's job. It is not source selection: the control plane
chose the source and proved the byte identity, and nothing here re-opens either. The distinction is the
whole point — an access URL expires on the provider's schedule, and a playback routinely outlives one, so
requiring a new namespace generation for a lapsed lease would couple ordinary reads to catalog churn and
break a generation-pinned handle mid-film.

7.6.1 Access material **SHALL** be memory-only. It **SHALL NOT** be written to a manifest, to disk, to the
probe-prefix cache, to a log line, to a metric label, to argv, or to an error message. The long-lived
credential that authorises a resolution **SHALL** continue to come from a secret file.

7.6.2 A resolved URL is provider-supplied data and **SHALL** be treated as untrusted input. Its host
**SHALL** be checked against the endpoint's configured allowlist; a host outside it **SHALL** fail the read
(`access-url-outside-endpoint-allowlist`) and **SHALL NOT** be contacted. Redirects are still never followed
and TLS verification is still required.

7.6.3 A refresh **SHALL NOT** change `projectedEntryId`, `generationId`, `sourceId`, `sourceGeneration`,
`projectedVersionId`, `inode`, `sizeBytes` or `mtime`. The handle is not rebound and the player is not told.
The refreshed response **SHALL** satisfy the identical Range, `Content-Range`, total-size and byte-identity
rules of §7.5 — a refresh is a new envelope for the same bytes, or it is a failure.

7.6.4 A refresh **SHALL** be single-flighted: concurrent waiters share one in-flight resolution and its
result. At most **one** refresh per source per **30 s cooldown**, daemon-wide, and at most **one** per read.
A refresh **SHALL NOT** trigger another refresh. Twenty handles meeting an expired lease at once therefore
cost one resolution, and a source whose resolutions keep failing cannot be asked again for a minute however
many readers want it.

7.6.5 A resolution is itself bounded at 5 s and is spent **from** the read's absolute deadline, not added to
it. If the resolution fails, is refused, or the budget is exhausted, the read **SHALL** return **EIO** and
the namespace **SHALL NOT** change.

7.6.6 **Retry classification.** Retryable: connection reset, connection timeout, body idle timeout, `408`,
`429`, `500`, `502`, `503`, `504`. Access-refresh-then-retry: `401`, `403`, `410`, expired access lease —
for a debrid or CDN-shaped source these are the normal end of a signed URL's life, not a failure. Terminal:
`400`, `404`, `416`, unsupported range, range mismatch, short body, size disagreement, TLS verification
failure, an unknown source reference, a failed resolution, and a resolved URL outside the allowlist. A
terminal classification fails the **source** for that read; the source **SHALL NOT** be retried.
`Retry-After` is honoured up to 5 s and never past the read deadline.

7.7 **Circuit breaker.** Per endpoint: 5 failures in 30 s opens it for 60 s; half-open admits exactly one
probe. While open, reads against that endpoint **SHALL** fail fast locally with **zero provider traffic**.

7.7.1 A lease lapsing and being successfully re-resolved **SHALL NOT** count toward the failure threshold. It
is the normal life of a signed URL, and counting it would mean a healthy endpoint with a short lease trips
its own breaker during ordinary playback. A resolution that **fails** does count.

7.8 **Admission limits.** At most 8 in-flight source requests globally, 4 per endpoint, 4 connections per
endpoint. A read that cannot obtain a slot within 5 s **SHALL** return **EIO** — it **SHALL NOT** queue past
its deadline and **SHALL NOT** hang.

7.9 **Cross-open single-flight.** Two opens reading the same chunk of the same projected version **SHALL**
produce exactly one source request. Reads are aligned to a 4 MiB chunk so single-flight and cache keys are
exact rather than overlapping.

7.10 **Caches.** The **probe-prefix cache** is persistent, keyed by `projectedVersionId` — never by path and
never by source, so a failover keeps it — holds one probe window per version, and is capped at 2 GiB total.
The **playback cache** is **process-ephemeral**: it lives in memory only, holds nothing across a restart, and
is capped at 512 MiB total.

7.10.1 **A release discharges an admission; it does not delete bytes.** Playback entries are keyed by exact
byte identity — projected version, identity digest, offset and length — so an entry **SHALL** remain readable
after the handle that cached it is released, and a later open asking for the same bytes **SHALL** be served
from it. `release` **SHALL** discharge that handle's admission accounting in full and **SHALL NOT** delete
reusable bytes; the entry becomes an unowned candidate in the global LRU.

*The defect this corrects.* This paragraph read "dropped on release", and the daemon did that. Because the key
is byte identity rather than the handle, the deleted entry was exactly what the next open would ask for, so a
media server's open-read-release scan followed by an analyse pass refetched the same block once per open —
measured through the real read path as the identical block at offset 1,048,576 for 2,724,273 bytes, fetched
four times for four sequential opens.

7.10.1.1 **A read served from the playback cache reaches no provider, and the daemon **SHALL** say so.** A
consequence of 7.10.1 is that a window of real playback — a scan, a direct play, a seek, a transcode — may
produce **zero** provider requests when the bytes are already resident. "Zero provider requests" therefore has
two explanations that call for opposite responses: this daemon served the read from memory, or something that
is not this daemon served it. The daemon **SHALL** publish, on its status surface and independently of any
opt-in diagnostic, the playback cache's **cumulative** hit count and hit **bytes** alongside the resident
level, so the two can be told apart by subtracting two readings. These are counters, not a per-request record:
they carry no offset, no handle, no identity and no byte content.

7.10.2 **The 64 MiB per-handle cap is an admission ceiling.** It bounds what one open handle may **add**. A
cache hit is free reuse: it **SHALL NOT** transfer ownership and **SHALL NOT** count against the reading
handle's ceiling. A handle **SHALL NOT** hold admissions beyond the cap; when a put would exceed it, that
handle's own oldest entries are evicted first, and never another handle's. Both caps are hard: the 512 MiB
total is enforced by evicting the least recently used entry, owned or unowned alike.

7.11 **Read-ahead.** Suppressed entirely within the probe window, so a metadata scan never pulls more than it
asked for. Beyond it, three sequential chunk-aligned reads start read-ahead of at most four chunks; a
non-sequential seek cancels it immediately and abandons in-flight prefetch. An open handle pins its
generation, its bound source and its cached chunks — but a **pin is a preference, not an exemption**, and an
earlier version of this sentence said eviction could not take a pinned chunk. Under a hard ceiling eviction
**SHALL** take them rather than exceed the bound: the scan cache retains pinned records last, and the playback
cache evicts by recency alone. An appliance that ran out of space because a stream asked it to is a worse
failure than a cache miss.

---

## 8. Error mapping and the anti-hang contract

8.1 **ENOENT means one thing: the path is not in the admitted generation.** A provider outage, an expired
locator, an open circuit, a degraded entry and an unavailable control plane **SHALL** map to **EIO**. A media
server treats ENOENT as deletion and will remove the item; it retries EIO.

8.2 A mutation attempt **SHALL** map to **EROFS**. A read starting beyond EOF **SHALL** return zero bytes as
a normal EOF, not an error.

8.3 **No operation may block indefinitely.** Every operation either answers from immutable memory or answers
within a bounded deadline. A hang is worse than an error: an error costs one file, a hang costs the library.

8.4 A control-plane outage is **not an error condition**. It maps to "serve the last admitted generation",
and nothing about it reaches a media server.

---

## 9. Secrets and egress

9.1 A provider token **SHALL** be read from a **secret file** whose path comes from configuration, and
composed into an `Authorization` header at request time. It **SHALL NOT** appear in argv, a log line, a
manifest, an error message, a metric label, or any URL component.

9.1.1 **Ephemeral access material is a short-lived secret and gets the same treatment** (§7.6.1). Memory
only; never the manifest, never disk, never the probe-prefix cache — that one *is* on disk — never a log, a
metric label, argv or an error message.

9.2 **Provider egress and media-server egress are separate policies and SHALL remain separate.** A provider
endpoint is a public host by design; its allowlist is the configured endpoint host set, redirects are never
followed, and TLS verification is required. The media-server rule — a private literal or a local name, no
redirects, no inline key — is unchanged and **SHALL NOT** be relaxed by anything here. `projectiond`
**SHALL NOT** contact a media server at all.

---

## 10. Platform

10.1 Production is **Linux**, including **Unraid**.

10.2 A Windows or Docker Desktop development machine **MAY** run the contract, unit and fake-Range suites.
That is all it proves. It **SHALL NOT** be presented as evidence for FUSE mount propagation, container mount
visibility, media-server scan behaviour, kernel page-cache interaction, inode stability as observed by a
media server, or daemon kill-and-recover. `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6 is the table.
