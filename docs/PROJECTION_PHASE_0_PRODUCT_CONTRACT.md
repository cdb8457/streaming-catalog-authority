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
window), and an `admission` block (intent, entry count, deletions, relocations, deletion-guard state).

2.5 An entry **SHALL** carry: `projectedEntryId`, `logicalMediaId`, `projectedVersionId`, `path`, `nodeKind`,
`sizeBytes`, `mtime`, `mode`, `readOnly`, `inode`, `visibility`, `degraded`, `retiring`, `sources`. Every one
of those fields is required; an unknown field **SHALL** cause refusal of the whole generation.

2.6 `nodeKind` **SHALL** be `file`. Directories are **derived** by `projectiond` from entry paths. A
directory has no byte stream, therefore no projected version, therefore no inode this contract could derive
without falling back to the path — and a path-derived inode is exactly the instability §3 forbids.

2.7 `sizeBytes` **SHALL** be the exact byte length. There is no estimate, no unknown and no placeholder. An
entry whose exact size is not known is **not projectable** and **SHALL NOT** appear in a manifest.

2.8 `mode` **SHALL** be `0444` and `readOnly` **SHALL** be `true`.

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

3.4 `inode` **SHALL** be derived deterministically from `projectedVersionId` and from nothing else — never
from the path, never from the active source, never from a provider identifier. The derivation is
`deriveInode()` in `src/core/projection/manifest-v1.ts`: the leading 8 bytes of
`sha256("projectiond.ino.v1\n" || projectedVersionId)`, big-endian, top bit cleared, values below 1024
displaced upward. Two different projected versions deriving one inode **SHALL** cause refusal.

3.5 `projectedEntryId` **SHALL** be stable across generations and across path corrections. A path correction
**SHALL** be declared as a `relocation`; the entry's `projectedEntryId`, `projectedVersionId`, `inode`,
`sizeBytes` and `mtime` **SHALL NOT** change with it.

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

4.7 **Media-server refresh.** `projectiond` **SHALL** request a refresh only for **additions** and for
**completed explicit deletions**. A relocation is a real rename in the namespace and earns no refresh
request — the media server observes it on its own next scan. A degraded transition earns nothing.

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
    `projectedVersionId`, `inode`, `sizeBytes` and `mtime`; a changed path is declared as a relocation naming
    the exact previous path.
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

7.6 **Retry classification.** Retryable: connection reset, connection timeout, body idle timeout, `408`,
`429`, `500`, `502`, `503`, `504`. Credential-refresh-then-retry: `401`, `403`, `410` — the daemon **MAY**
re-read its token from the secret file and retry the same ranged GET **once per source generation**. That is
the whole of "link refresh" in v1: the daemon **SHALL NOT** request a new locator from a provider, because it
has no such surface and acquiring one would put provider policy in the data plane. Terminal: `400`, `404`,
`416`, unsupported range, range mismatch, short body, size disagreement, TLS verification failure, and an
**expired locator** — only a new generation can supply a fresh one. A terminal classification fails the
**source** for that read; the source **SHALL NOT** be retried. `Retry-After` is honoured up to 5 s and never
past the read deadline.

7.7 **Circuit breaker.** Per endpoint: 5 failures in 30 s opens it for 60 s; half-open admits exactly one
probe. While open, reads against that endpoint **SHALL** fail fast locally with **zero provider traffic**.

7.8 **Admission limits.** At most 8 in-flight source requests globally, 4 per endpoint, 4 connections per
endpoint. A read that cannot obtain a slot within 5 s **SHALL** return **EIO** — it **SHALL NOT** queue past
its deadline and **SHALL NOT** hang.

7.9 **Cross-open single-flight.** Two opens reading the same chunk of the same projected version **SHALL**
produce exactly one source request. Reads are aligned to a 4 MiB chunk so single-flight and cache keys are
exact rather than overlapping.

7.10 **Caches.** The **probe-prefix cache** is persistent, keyed by `projectedVersionId` — never by path and
never by source, so a failover keeps it — holds one probe window per version, and is capped at 2 GiB total.
The **playback cache** is ephemeral, capped at 512 MiB total and 64 MiB per open handle, and is dropped on
release.

7.11 **Read-ahead.** Suppressed entirely within the probe window, so a metadata scan never pulls more than it
asked for. Beyond it, three sequential chunk-aligned reads start read-ahead of at most four chunks; a
non-sequential seek cancels it immediately and abandons in-flight prefetch. An open handle pins its
generation, its bound source and its cached chunks; eviction **SHALL NOT** take them.

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
