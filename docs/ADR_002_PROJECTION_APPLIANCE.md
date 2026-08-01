# ADR 002 — the projection appliance

**Status:** accepted (Projection Phase 0)
**Supersedes:** the non-goals listed below, and only those.
**Does not supersede:** anything about the catalog authority itself.

## Numbering

This repository's `PHASE_1` … `PHASE_336` sequence is the history of building a catalog authority. It is
finished, it is not renumbered, and nothing here reopens it. The projection appliance restarts at
**Projection Phase 0**, and its documents are named `PROJECTION_PHASE_*`. When a document in this file says
"Phase 1" without a qualifier, it means **Projection Phase 1** — the vertical slice described in
`docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md`.

## Context

This product's purpose is a media library whose files are real to a media server and whose bytes are not
necessarily local. Everything built so far is the **control plane** for that: a PostgreSQL-backed catalog
authority, an operator UI, an import/export path, backup and restore, custody, and a gated Jellyfin
collection control plane. None of it puts a file where Plex, Jellyfin or Emby can open one.

The way that gap is normally closed — a pile of symlinks, an rclone WebDAV mount, a provider-specific FUSE
helper — fails in the same three ways every time. A media server that can see a symlink or a WebDAV URL will
eventually follow one somewhere the operator did not intend. A namespace derived from a scan disappears when
the scan fails, and a media server treats disappearance as deletion. And a mount whose file identity depends
on the provider currently serving the bytes re-adds the whole library the first time a link is refreshed.

## Decision

Build a **projection appliance**: two processes with one boundary between them.

- The existing **TypeScript/PostgreSQL application remains the sole control plane and catalog authority.**
  It owns identity, lifecycle, erasure, custody, operator surfaces and every decision about what exists.
- A new, small **Go daemon, `projectiond`, is the data plane.** It owns exactly one thing: serving bytes.
- `projectiond` exposes a **provider-agnostic, read-only, regular-file namespace**. A media server sees
  regular files. It never sees a symlink, a WebDAV URL, a TorBox identifier, a provider name, or any evidence
  that a source adapter exists.
- **Phase 1 has exactly two source adapters:** local passthrough and HTTP Range. **FUSE is the frontend.**
- **No SQLite, and no second database.** PostgreSQL publishes an immutable, versioned, digest-checked
  **manifest artifact**, atomically. `projectiond` loads it into immutable memory. There is no state in the
  data plane that the control plane did not publish, and no way for the data plane to disagree with it.
- **`projectiond` continues serving its last admitted generation while the control plane is unavailable.**
  An outage of PostgreSQL, of the operator UI, or of the whole control-plane container changes nothing a
  media server can observe.
- **Unavailability never presents as absence.** The namespace is derived from asserted state — never from a
  failed, short or timed-out scan. This is the single rule the whole manifest contract is shaped around.

## The options that were rejected

### 1. Symlink farm

A directory of symlinks into a downloader's output, which is how most self-hosted setups do this.

Rejected. A symlink is a path the media server resolves itself, so the media server — not this product —
decides what gets opened, and a dangling link is indistinguishable from a deleted file. It also cannot
represent a remote byte stream at all without something else having already downloaded it, which is the
problem, not the solution.

### 2. rclone over WebDAV

Point the media server at an rclone mount of a WebDAV endpoint.

Rejected as production architecture. It puts a provider's URL space directly into the media server's view,
its file identity is a function of the remote's path rather than of anything stable, and a provider outage
empties the mount — which a media server reads as a mass deletion. **rclone and WebDAV remain useful as a
test control**: a comparison run that shows what the naive approach does to request counts and library churn
is evidence, and `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` uses one for exactly that. A test control is
not an architecture.

### 3. A provider-specific mount

A TorBox-shaped FUSE filesystem.

Rejected. The provider is the most replaceable component in the design and the one most likely to change.
Binding the namespace to it means the file identity a media server has learned is a function of a business
relationship. The source is a **locator**, three layers below identity, and this is the whole reason the
identity model in `docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md` has three layers.

### 4. (Chosen) A published manifest and a dumb, immutable data plane

The control plane asserts a complete namespace; the daemon serves exactly that and nothing else. The daemon
holds no database, makes no policy decision, and cannot invent, remove or rename an entry. Everything hard —
identity, deletion intent, admission — happens on the side that already has an append-only event log, an
authority in the database and a test suite around both.

## What this supersedes

Each of these was a correct boundary for the phase that wrote it, and each is now narrowed rather than
deleted. **The documents stay on disk**; they are the record of why the boundary existed. What changes is
their scope.

| Superseded | Was | Now |
|---|---|---|
| `docs/PHASE_7_ADAPTER_BOUNDARY.md` — "no adapter may make a network call" | A rule over the whole repository | A rule over the **control plane**. `src/core/adapters/**` still makes no network call, and the deploy suite still proves it. The data plane's HTTP Range adapter lives in `projectiond`, in Go, behind the manifest boundary. |
| `docs/PHASE_31_TORBOX_BOUNDARY.md` — "no downloading, no playback, research only" | The TorBox surface is documentation | Still true of the control plane, and `TORBOX_BOUNDARY_CONTRACT` is unchanged. `projectiond` may perform **read-only ranged GETs against a configured endpoint**. It still creates nothing, deletes nothing, controls nothing, and requests no download link that the control plane did not put in a manifest. |
| `docs/PHASE_55_PROVIDER_AVAILABILITY_POLICY.md` — provider results are advisory only and never persisted | A blanket rule | Unchanged **as a control-plane rule**: an advisory availability result still becomes `candidate` / `skip` / `hold` and is still not persisted. What is new is that the control plane may publish a `degraded` **visibility** in a manifest — which is an assertion about a projected entry, made by the authority, not a cached provider answer. A `hold` never becomes a namespace change. |
| `docs/PHASE_203_MEDIA_PLAYER_BOUNDARY_SELECTION.md` — Jellyfin first, Plex and Emby deferred | A selection for the **write** control plane | Unchanged for writes. The projection namespace is a filesystem, so it has no media-server-specific surface at all, and Phase 1 is validated against **Plex, Jellyfin and Emby together**. Collection writes remain Jellyfin-only and remain behind their four switches. |
| README's "no media folder is scanned, no symbolic link is created" | Read as a product-wide promise | True, verbatim, of the command it describes (`ops:catalog-snapshot-produce`) and of the whole control plane. The data plane creates no symbolic link either — it creates a namespace of regular files, which is a different thing and the point of the design. |

## What this does not change, at all

- **Crypto-shredding and the erasure guarantee.** Identity is still stored only as ciphertext, `forget` is
  still terminal, and the custodian still destroys key lineage. A manifest carries no identity: a projected
  entry names a logical media id and a path, and a path is operator-chosen text.
- **The append-only authority.** Every catalog mutation still goes through the `SECURITY DEFINER` functions.
  A manifest is a **read** of the projection, published outward; nothing about the projection appliance
  writes to the catalog.
- **The media-server URL policy.** A Jellyfin address must still be a **private** literal or a local name,
  redirects are still never followed, and an inline API key is still refused. `projectiond` contacts no media
  server at all. Its provider allowlist is a **separate** policy pointing at public hosts by design, and
  neither policy may be relaxed by the other. `src/core/projection/runtime-contract.ts` states this
  separation as a frozen value, and the suite asserts it.
- **Secret handling.** A provider token comes from a file, is composed into an `Authorization` header, and
  appears in no argv, log, manifest, error message or metric label.
- **Custody, backup, restore, retention and the shared-destination lock.** Untouched. `projectiond` holds no
  durable state that a backup would need beyond its probe cache, which is reconstructible by definition.

## Consequences

- There is now a second language in the product. That is deliberate: the data plane is a hot-path,
  syscall-bound service with hard latency bounds, and it needs a static binary that can be killed and
  restarted without a Node.js runtime in the mount path.
- The control plane gains one new responsibility — producing a manifest — and no new powers.
- The namespace's correctness is now a property of a **document**, which means it is testable offline, on any
  platform, without a mount. `src/core/projection/manifest-v1.ts` and `test/projection-manifest-v1.ts` are
  that test, and they run in the default `npm test`.
- What a manifest cannot prove is a mount. `docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md` says explicitly which
  gates a Windows or Docker Desktop machine can close and which need a real Linux or Unraid host.
