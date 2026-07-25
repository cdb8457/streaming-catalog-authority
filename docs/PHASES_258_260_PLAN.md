# Phases 258–260 — from release machinery to a working product

## Why this group exists

Phases 242–257 built a release: an image, a bundle, a Compose stack, first-run diagnostics, a support report,
backup and restore. All of it is real and all of it is about *installing* Catalog Authority. None of it lets
somebody who installed it **do** anything: there is no way to get catalog records in, and no way to look at
them once they are there.

These three phases close that. By the end, an ordinary operator can put a file of catalog records on disk,
run one command, and browse and search what they imported in the authenticated web UI.

The order is forced by what each step depends on. The test command had to be fixed first, because the two
product phases add suites and the aggregate command could not run on Windows at all and could not notice a
suite that was never wired in. Import has to exist before there is anything to browse.

## Phase 258 — make the aggregate test command real and cross-platform

**Problem.** `npm test` was one 11,935-character `&&` chain. cmd.exe refuses a command line over 8,191
characters, so the suite was unreachable on Windows. A chain reports the exit code of whatever ran last, so
a truncated chain still exits zero. And thirteen files under `test/` were outside the chain entirely — seven
of them real, passing, offline suites that simply never ran.

**Shape.** An explicit inventory (`test/suite-inventory.json`) naming every file under `test/` exactly once,
as a suite or as an imported helper. A runner (`src/ops/test-runner.ts` + `-cli.ts`) that spawns each suite as
`node <tsx-cli> test/<file> [args]` with an argument array and `shell: false`, captures every exit code
separately, and refuses to exit zero unless every selected suite ran and passed. Drift between the inventory
and `test/` fails the run before anything is spawned. Capability-gated suites (the two that need a Docker
daemon) stay in the inventory, are reported by name with their reason, and are never counted as passes.

**Not in scope.** Rewriting any suite. The 500+ focused `test:*` scripts are untouched, and CI keeps driving
them directly.

## Phase 259 — offline catalog import

**Problem.** The only way to get a record into the authority was `ops:catalog-ingest-item`, which creates
exactly one item from command-line flags. That is a validation tool, not an import path.

**Shape.** A documented offline snapshot format (a single JSON file), a validator that checks the whole
document before the first write, deterministic item identities derived from `(source, externalId)`, a
dry-run preview that persists nothing, and an idempotent apply that goes through `CatalogAuthority.addItem`
so identity is encrypted with a per-item key exactly as every other write is.

**Boundaries this phase does not cross.** It reads exactly one file, chosen by the operator. It never scans
a media path, never contacts Jellyfin or any provider, never touches the network, and produces no promotion
evidence of any kind. Reports carry counts, digests and field names — never a title, a provider ref value or
any raw payload.

## Phase 260 — authenticated read-only catalog browser

**Problem.** Once records are imported there is nothing that shows them.

**Shape.** Two authenticated read-only endpoints (`/api/catalog`, `/api/catalog/item`) behind the existing
operator token, and a Catalog panel in the operator UI with counts, search, deterministic sort, bounded
pagination, filters grounded in fields that actually exist, and a record detail view. An empty catalog is a
healthy state that explains how to fill it, not an error.

**The constraint that shapes the design.** Item identity is encrypted at rest with a per-item key. There is
no plaintext title column to index or sort on, and adding one would defeat crypto-shredding. So the browser
decrypts a bounded window through `CatalogAuthority`, and says so honestly when a search was truncated
rather than implying it saw the whole catalog. Provider ref values are shown as a masked digest and never in
the clear.

## What stays true throughout

Reproducible builds and digest pinning, least privilege, fail-closed behaviour, read-only promotion evidence,
secret and log redaction, and the existing required Docker/browser/lifecycle CI gates. No phase here
publishes, tags, deploys, or authorises a promotion.
