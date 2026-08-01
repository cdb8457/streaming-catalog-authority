# Projection Phase 1 — the manifest publisher

**What this document is.** The producer half of the Phase 1 vertical slice: how a projected namespace is
registered in PostgreSQL, how one consistent snapshot of it becomes an immutable manifest generation, and what
happens at each point a publish can be interrupted. It is a description of code that runs, not a plan.

**What it is not.** It is not evidence about a media server. Plex, Jellyfin, Emby and Unraid acceptance are
still ahead of this work; `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` §6 is the table that says which gate
can be closed where, and none of the gates below closes G7–G13, G18 or G22.

---

## 1. The gap this closed, and how narrowly

The manifest names, per entry, an exact byte length, an mtime, a visibility state and a stable source
descriptor — `{rootId, relativePath}` for a local file, `{endpointId, objectRef}` for an HTTP Range object.

**Nothing in the catalog schema could answer any of them.** `items` holds an opaque id and an encrypted
identity blob; there is no file, no size, no path and no locator anywhere in it, and there is no honest way to
derive one. Phase 0 §2.7 already says an entry whose exact size is not known is not projectable, so a
publisher that inferred a size would be publishing something the contract forbids — and a guessed size is a
file a media server cannot play.

So the gap was closed **explicitly**, with the smallest boundary that keeps the control plane authoritative:

| Table (schema v10) | What it holds | Identity layer |
|---|---|---|
| `projection_source_roots` | the configured local roots and HTTP Range endpoints a locator may name | — |
| `projection_versions` | one exact byte stream: size, mtime, and the byte-identity proof | layer 2 |
| `projection_entries` | what appears in the namespace, at which path, in which visibility state | layers 1 and 3 |
| `projection_entry_sources` | where the bytes are: kind, preference, root and opaque object reference | layer 3 |
| `projection_generations` | every published generation, **including its exact artifact bytes**, length and digest | — |
| `projection_pointer` | which generation the control plane says is current | — |

Every one of them is owner-managed and written only through `cat_projection_*` SECURITY DEFINER commands, the
same shape `import_history` and `managed_collections` already use. The runtime role can read them and cannot
write them.

**What is deliberately absent.** No provider name, no TorBox-shaped column, no API surface, no scanner and no
scraper. Every row is asserted by whoever registered it. There is no code path in the database or the
registration service that could fetch a value it was not given.

**What cannot be stored, and why it cannot rather than merely is not.** An access URL, a signed link, a token,
a header, an expiry, a lease or a WebDAV credential. `checkLocatorValue` — the contract's own check, the one
admission uses — refuses a URL-shaped or credential-shaped value at registration, and a column CHECK refuses
`://`, `?`, `&`, `@` and `\` in the database. Access material is the daemon's, in memory, for the length of
one read (Phase 0 §7.6).

## 2. How a generation is built

`src/core/projection/publisher.ts` is a pure function: `(snapshot, predecessor, clock, intent) -> bytes, or
problems`. It opens no file, makes no network call and reads no clock — every input arrives as an argument,
which is what makes a generation reproducible by a reviewer.

It does **not** re-implement admission. Every rule the daemon enforces is enforced by calling
`validateManifestV1` and `validateSuccession` out of `manifest-v1.ts` — the same functions the fixture corpus
and the Go port are checked against. A producer with its own idea of what is admissible is a producer that
eventually publishes something the daemon refuses, and the refusal surfaces at the mount rather than at the
publish.

What it adds are the checks the contract cannot express, because they are about the snapshot rather than about
the manifest: a missing version row, a locator naming an unconfigured root, a source whose kind disagrees with
its root, an entry with no source, a deletion naming something that was never `retiring`, a deletion inside
its grace period. Each has its own `PRODUCER_*` code.

**Nothing changed is not a generation.** A content digest over what a generation *says* — intent, entries,
deletions, and none of the four fields that change on every publish — is recorded with each generation. A
publish over an unmoved catalog compares equal and mints nothing: no sequence burned, no pointer rewritten,
no reader made to re-read an artifact identical to the one it has.

## 3. How a generation is published, and what a crash at each point leaves behind

```
  1. take the publisher lock            pg_try_advisory_lock, session-scoped
  2. RECOVER, always, before anything   make the directory agree with the database
  3. read the snapshot AND prepare      one REPEATABLE READ transaction; artifact bytes committed
  4. write the artifact                 same-directory temp -> fsync -> rename -> fsync the directory
  5. make it current IN THE DATABASE    <- the commit point
  6. write the pointer file             last; the moment a daemon can see it
```

**The order is the design.** PostgreSQL is the durable authority; the filesystem is a rendering of it.

| Interrupted at | What is on disk | What the next run does |
|---|---|---|
| after 3 | a `prepared` generation, no artifact | resumes it from the **committed bytes** — the same artifact, not an equivalent rebuild |
| after 4 | artifact present, not current | resumes it; the artifact already matches, so nothing is rewritten |
| after 5 | database ahead of the pointer file | rewrites the pointer from the database and **stops** |
| any | pointer or artifact deleted, truncated or tampered with | rewrites it from the database and **stops** |

**Why a repair stops rather than continuing.** A daemon admits a successor only when its sequence is exactly
one past the generation it is serving (Phase 0 §5 check 5); a skipped sequence is a permanent refusal, not
something it catches up from. A run that repaired the directory and then also published a successor could hand
a running daemon a jump. So a repair is its own outcome, and the next run builds the successor against a
directory that is now correct.

**A second publisher is refused, not queued.** Two producers minting successors to one predecessor would both
be internally consistent and one of them would be a lie. The lock is session-scoped because a publish spans a
transaction, then filesystem work, then a second transaction, and a lock that ended at the first COMMIT would
leave the interesting half unprotected. The CLI exits 4 and says `concurrent-publisher`.

**One current generation is a database invariant**, not a convention the publisher observes: a partial unique
index on `state = 'current'`.

## 4. Operating it

```sh
npm run ops:migrate                       # deploys schema v10

npm run ops:projection-register -- root    --id media --kind local
npm run ops:projection-register -- root    --id vault --kind http-range
npm run ops:projection-register -- version --key movie-a --size 3145728 --mtime 2026-06-01T10:00:00.000Z
npm run ops:projection-register -- entry   --item <catalog-uuid> --version-key movie-a \
                                           --path "Movies/A/A.bin" --source local:media:a.bin

npm run ops:projection-publish -- --manifest-dir /var/lib/projectiond/manifest
npm run ops:projection-publish -- --manifest-dir /var/lib/projectiond/manifest --status
```

Retiring and deleting, which is the only way an entry ever leaves the namespace:

```sh
npm run ops:projection-register -- retire --path "Movies/A/A.bin" --intent-key drop-a \
                                          --declared-at <ts> --grace <ts>
npm run ops:projection-publish  -- --manifest-dir <dir>                       # publishes the retirement
# ... the grace deadline passes. Nothing happens: a deadline expiring removes nothing.
npm run ops:projection-publish  -- --manifest-dir <dir> --intent deletion --delete "Movies/A/A.bin"
```

**Exit codes are the interface.** `0` published, unchanged, recovered or resumed; `3` refused (the snapshot
cannot produce an admissible generation, and nothing changed); `4` another publisher holds the lock.

**A source is `kind:rootId:objectRef` and nothing else.** There is no field for a URL, a token, a header or an
expiry, so the shape of the argument makes ephemeral access material unrepresentable rather than merely
discouraged.

**The report is redaction-safe by construction**, like every other report here: counts, digests, a sequence, a
generated artifact name and closed-set problem codes. No projected path, no locator, no object reference.

## 5. The gates

| Gate | Command | What it proves |
|---|---|---|
| Unit | `npm run test:projection-publisher` | id derivation, canonical bytes, every producer refusal, succession, the grace and shrink rules, path immutability, and the durable-write/pointer round trip. Pure and offline. |
| Database | `npm run test:projection-publisher-db` | the schema against a real migrated PostgreSQL; the runtime role can read and cannot write; the exact bytes recorded; idempotence; the advisory lock; a crash at **each** of the three boundaries recovered; degrade, retire and delete end to end; every generation in the ledger admissible and the chain unbroken. |
| End to end | `npm run go:publisher-mount-gate` | PostgreSQL in Docker → the production write path → the production publisher → the **already-merged** production `projectiond` image, strict-direct-mounted → both projected files read and SHA-256 hashed by a separate non-root container against digests recorded outside the mount → a successor published while a handle is open → forged malformed, oversized, digest-mismatched, shrinking and relocating generations, every one refused with the namespace and the bytes unchanged. |
| Wiring | `npm run test:projectiond-wiring` | that the publisher is wired, that the daemon still holds no database, and that nothing here contacts a provider or a media server. |

The end-to-end gate uses `internal/fakeprovider` as its HTTP Range endpoint — the only "provider" any
automated gate in this repository contacts. Its object bytes are a pure function of the reference and the
offset, so the digests it emits describe exactly what a reader will get, and they are recorded outside the
mount so that a hash which only proves "the file hashes to its own contents" cannot pass.

## 6. What is still not proved

**No real media server has read any of this.** The end-to-end gate mounts the production image and reads it
with an ordinary non-root container, which is how a media server runs but is not one. Specifically still open:

- **Plex, Jellyfin and Emby**: scan, direct play, seek, forced transcode, generation swap mid-playback, kill
  and recover, and re-scan churn — Phase 1 gates G7–G13 and G18.
- **Unraid**: a real host, real shares, real mount propagation into real media-server containers.
- **A real provider endpoint**: real TLS, real redirects refused, real `Content-Range`, real `429`.
- **Three consecutive green runs on Linux or Unraid**, which is what the acceptance plan says "passing" means.

A Windows or Docker Desktop green run is not a Phase 1 pass and is not reported as one.
