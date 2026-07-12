# Phase 175 - O4 Sidecar Readiness Gate

Report id: `phase-175-o4-sidecar-readiness-gate`

Phase 175 is the stop line before implementing the production local sidecar custodian. The current
state is `ready-for-design-review`, not implementation approval.

## Current Evidence Position

The repo now has:

- O4/O5 descriptor templates;
- an O4/O5 capture runbook;
- an O4/O5 review checklist;
- `ops:o4-o5-evidence-packet-review`;
- a Unraid launcher capture command;
- Arcane button guidance for packet capture/review.

This is enough to review the evidence workflow. It is not enough to claim O4 closure.

## Required Before Implementation

Before starting sidecar implementation, reviewers should confirm:

- the sidecar boundary remains local/self-hosted and outside the app process and app database;
- the sidecar API surface is minimal and key-custody-specific;
- attestation signing is owned by the sidecar, not forgeable by the app;
- durable non-secret tombstones are defined;
- restored-main-DB behavior remains fail-closed without sidecar prerequisites;
- Unraid deployment keeps secrets out of packet artifacts;
- O5 KEK custody is designed alongside O4, not as an unrelated second custody system.

## Decision

Recommended next status: `ready-for-sidecar-design-review`.

Not authorized yet: implementation, service installation, Compose changes, O4 closure, O5 closure,
live provider contact, scraping, downloading, playback, Real-Debrid live mode, TorBox live provider
mode, Plex/Jellyfin mutation, or media-server library writes.

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.

