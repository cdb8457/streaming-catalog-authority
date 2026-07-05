# Phase 60 - Operator UI Architecture

Phase 60 defines the architecture for a future operator UI. It is documentation only: no web UI,
frontend framework, HTTP route, database reader, provider adapter, playback surface, or runtime
dashboard is added in this phase.

The future UI should feel like a professional homelab appliance: local-first, calm, readable,
medium-density, privacy-aware, and built for operators who need quick confidence in catalog,
privacy, backup, reconciliation, and packet-review state.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS.

## Non-Goals

- No React, Vite, Next, Express, API routes, or UI runtime.
- No database reads or direct event-store queries from a dashboard.
- No provider integrations or live provider controls.
- No TorBox, Real-Debrid, Plex, Jellyfin, Hermes, scraping, downloading, playback, or library
  orchestration work.
- No media browsing, watchlist, poster art, streaming artwork, provider logos, content titles,
  external IDs, infohashes, magnets, credentials, tokens, or user library data.
- No implementation use of the Stitch generated HTML, remote images, or generated assets.

## Architecture Principle

The operator UI should eventually consume sanitized operator packets and status summaries, not raw
domain records. The UI boundary is a privacy-preserving presentation layer over explicit, reviewed
views that are safe to display on a local appliance console.

Allowed future UI inputs:

- count-only catalog and provider availability summaries;
- redacted backup verification summaries;
- redacted reconcile summaries;
- key-control state labels and custodian status labels;
- event sequence labels and audit finding categories;
- operator configuration metadata that excludes secrets and raw paths.

Forbidden future UI inputs:

- raw item identity;
- raw provider refs;
- raw external identifiers;
- raw event payloads;
- key material, handles, receipts, or secret paths;
- live provider responses;
- user media library records;
- credentials or environment dumps.

## Information Architecture

The application shell should use a fixed left navigation and a top status/search strip. The left
navigation is the stable map of operator responsibility. The top strip carries appliance status,
global search/filter affordances for safe labels only, and compact warning indicators.

Required conceptual screens:

| Screen | Purpose | Primary Display |
| --- | --- | --- |
| Overview | Roll up catalog, privacy, backup, packet, audit, and gate status. | System health summary plus recent sanitized activity. |
| Catalog Authority | Inspect catalog authority state without exposing item identity. | Dense table using Item A, Item B, Provider Count, Shred State, and Reconcile Status. |
| Privacy & Crypto-Shredding | Inspect key-control and crypto-shredding lifecycle state. | Privacy/key-control panels and crypto-shredding status rows. |
| Key Custodian / O4 Status | Keep external custodian readiness visible. | O4 open/deferred status, custodian contract evidence checklist, and FileCustodian boundary note. |
| Reconciler | Review drift, lost-ack, and repair posture. | Reconciler activity panel with event sequence and reconcile status rows. |
| Backup & Restore | Review backup integrity and restore gate readiness. | Backup integrity panel, replay-and-compare status, backup verified labels. |
| Provider Availability Packets | Review advisory packet counts from sanitized summaries. | Provider Count, Packet Count, Review Required, and availability category counts. |
| Audit Queue | Review immutable operational events and held findings. | Audit queue/log view with event sequence, review badges, and warning states. |
| Settings / Operator Configuration | Configure future display preferences and safe operator metadata. | Settings panels for local appliance behavior, redaction policy labels, and disabled future integrations. |

## Screen Map

```text
Operator Shell
  Overview
    System Health Summary
    Catalog Authority Snapshot
    Privacy Gate Snapshot
    Backup Integrity Snapshot
    Provider Availability Packet Snapshot
    Recent Sanitized Activity

  Catalog Authority
    Catalog Authority Table
    Item Detail Drawer, labels only
    Reconcile Status Summary

  Privacy & Crypto-Shredding
    Key-Control State Panel
    Crypto-Shredding Status Rows
    Shred State History, event sequence only

  Key Custodian / O4 Status
    Custodian Status
    O4 Evidence Checklist
    O5 Deferred Notice
    FileCustodian Reference Harness Notice

  Reconciler
    Reconciler Activity Panel
    Drift Queue
    Lost-Ack Recovery Status

  Backup & Restore
    Backup Integrity Panel
    Backup Verified History
    Restore Replay-and-Compare Gate

  Provider Availability Packets
    Packet Count Summary
    Review Required Queue
    Count-Only Availability Matrix

  Audit Queue
    Audit Queue Table
    Event Sequence Log
    Review Required Findings

  Settings / Operator Configuration
    Display Density
    Redaction Policy
    Local Appliance Metadata
    Future Integration Placeholders, disabled
```

## Operator Workflow Map

1. Open Overview to confirm System Health, Backup Integrity, Reconcile Status, Provider Count, Packet
   Count, and Review Required.
2. If Reconcile Status is warning or danger, open Reconciler and inspect event sequence rows.
3. If Backup Integrity is not verified, open Backup & Restore and inspect Backup Verified status.
4. If Key State or Custodian Status is warning, open Privacy & Crypto-Shredding or Key Custodian /
   O4 Status and review safe labels only.
5. If Packet Count or Review Required changes, open Provider Availability Packets and inspect
   count-only packet summaries.
6. If a warning/error badge appears, open Audit Queue and review the redacted event sequence.
7. Use Settings / Operator Configuration only for local UI behavior and redaction policy review; do
   not add provider credentials or live integration controls in this architecture phase.

## Component Inventory

- left navigation: fixed desktop rail with active muted orange marker and compact icons.
- top status strip: appliance status, safe search/filter, warnings, and compact operator controls.
- system health summary: small bordered metric panels for Reconcile Status, Backup Integrity,
  Provider Count, Packet Count, Review Required, Key State, and Custodian Status.
- catalog authority table: dense rows using Item A, Item B, Provider Count, Shred State, and
  Reconcile Status.
- privacy/key-control state panel: displays Key State and Custodian Status without key material.
- crypto-shredding status rows: display Shred State and event sequence labels; no destructive CTA.
- reconciler activity panel: compact terminal-flavored rows for reconcile status, event sequence,
  and lost-ack categories.
- backup integrity panel: Backup Integrity and Backup Verified status with replay-and-compare
  result labels.
- provider availability packet viewer: Provider Count, Packet Count, Review Required, and
  count-only availability categories.
- audit queue/log view: Event Sequence table with sanitized action categories and review state.
- review-required badge: warning chip for rows needing operator review.
- warning/error states: muted clay and red states with text labels, never color alone.
- settings panels: bounded configuration groups for display density, redaction policy, and future
  disabled integration placeholders.

## Data Display Rules

Use only synthetic operational labels in examples and future mock data:

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

Never display real titles, external IDs, provider names/logos, infohashes, magnets, credentials,
user library data, poster art, or streaming artwork.

## Future Implementation Phase Plan

1. Phase 61: define a static UI packet contract for redacted screen data. No UI runtime.
2. Phase 62: add deterministic fixtures for safe operator packet examples. No provider contact.
3. Phase 63: build a read-only UI prototype over fixture packets only.
4. Phase 64: add contract tests that reject unsafe display fields.
5. Phase 65: connect to sanitized local operator packets through an explicit read-only boundary.

Any implementation phase must preserve this architecture boundary and be separately authorized.
