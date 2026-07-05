# Phase 61 - Operator UI Packet Contract

Phase 61 defines a static, allowlisted packet contract for future operator UI screen data. It is a
contract phase only: no UI renders data, no runtime reads data, and no transport boundary is added.

The contract exists so future UI work starts from redaction-safe screen packets instead of raw
catalog, provider, log, backup, or configuration records.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS.

## UI Packet Boundary

Future operator UI screens may consume only descriptors accepted by
`validateOperatorUiPacketDescriptor()`. A descriptor contains:

- one allowlisted conceptual screen id;
- a non-empty list of allowlisted display field labels;
- optional fixed status labels;
- optional fixed category labels.

The validator returns only fixed codes and messages. It does not echo rejected values, unknown field
names, raw descriptors, parse snippets, paths, URLs, provider refs, titles, tokens, or logs.

## Allowed Screens

These are the allowed screens for the static contract.

- `overview`
- `catalog-authority`
- `privacy-crypto-shredding`
- `key-custodian-o4-status`
- `reconciler`
- `backup-restore`
- `provider-availability-packets`
- `audit-queue`
- `settings-operator-configuration`

## Allowed Fields

These are the allowed fields for display descriptors.

- Item A
- Item B
- Provider Count
- Shred State
- Backup Integrity
- Reconcile Status
- Event Sequence
- Packet Count
- Review Required
- Key State
- Custodian Status
- Backup Verified

Fixed status/category labels are limited to operational states and safe screen categories such as
Open, Deferred, Verified, Warning, Failed, Blocked, Synced, Count Only, Advisory, System Health,
Privacy Gate, Provider Availability, Audit Review, Operator Configuration, and Redaction Policy.

## Forbidden Data Categories

These are the forbidden data categories for the contract and future fixtures.

The packet contract rejects or excludes categories such as:

- real titles;
- external IDs;
- provider refs, provider names, and provider logos;
- infohashes and magnets;
- credentials, tokens, secrets, secret paths, and database URLs;
- paths and URLs;
- poster art, streaming artwork, and image labels;
- raw payloads and raw logs;
- user library data, media identity, playback, download, and stream controls.

Provider availability remains advisory and count-only. It must not become an item-availability,
download, playback, provider-control, or provider-mode surface.

## Non-Goals

This phase adds no React, Vite, Next, Express, frontend framework, CSS, image, HTTP route, API route, database read, provider adapter, network call, env read, or file read.

It also adds no dashboard runtime, browser global, document/window usage, DB/Docker access, provider
integration, TorBox, Real-Debrid, Plex, Jellyfin, Hermes, scraping, metadata service, download flow,
playback flow, or UI-connected provider logic.

## Future Phase 62 Fixture Plan

Phase 62 should add deterministic fixture packets built from this contract. Those fixtures should
exercise every allowed screen with synthetic labels only, stay static/local, and continue to reject
raw title, provider, credential, path, URL, artwork, log, payload, playback, download, and stream
categories.

Phase 62 must still avoid frontend rendering and provider contact unless separately authorized.
