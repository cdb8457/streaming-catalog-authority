# Phase 69 - Sanitized Local Operator Packet Source Contract

Phase 69 defines the only future packet source contract allowed for a local read-only operator UI.
It is fixed, synthetic, and no-input. It does not implement a packet producer, endpoint, runtime UI,
live UI server, API route, HTTP listener, DB read, env read, filesystem scan, network call, provider
call/integration, playback, download, scraping, media-server logic, credentials, or live packet
ingestion.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains packet/count/advisory only.

## Allowed Future Sources

A future local read-only runtime may consume only one of these separately authorized source shapes:

- immutable/read-only packet snapshots;
- explicit sanitized local packet endpoint.

Both are future source contracts only. Neither is implemented in this phase.

## Producer Contract

Any future packet producer must sit behind explicit sanitization and allowlist checks. It may emit
only redaction-safe operator packets using synthetic labels, counts, and statuses. It must preserve
the Phase 61 operator UI packet descriptor allowlists.

The producer must not expose direct UI DB reads, raw event payloads, provider or adapter reads, live
packet ingestion, local state scans, operator data passthrough, or mutable packet streams.

This means no direct UI DB reads, no raw event payloads, no raw provider refs, and provider availability remains packet/count/advisory only.

## Forbidden Data Categories

The source contract excludes real titles, external IDs, provider names/logos, raw provider refs,
infohashes, magnets, credentials, paths, artwork, user library data, raw event payloads,
playback/download controls, and media-server data.

Provider availability remains packet/count/advisory only. It must not become an item-availability,
provider-control, playback, download, or provider-mode surface.

## CLI

Text output:

```sh
npm run --silent ops:operator-ui-packet-source-contract
```

JSON output:

```sh
npm run --silent ops:operator-ui-packet-source-contract -- -- --json
```

Both outputs are deterministic and parseable. The CLI has no inputs beyond the `--json` output
selection and does not read environment variables, files, databases, local packets, provider data, or
network resources.

## Boundary

This phase adds no source implementation, endpoint implementation, producer implementation, packet
ingestion path, runtime UI, live UI/API/server, direct DB access, env/file read, network call,
provider execution, playback/download/scraping/media-server behavior, or credential handling.

Local read-only runtime remains blocked until source, auth, and runtime designs are satisfied. Live
product launch remains not ready.
