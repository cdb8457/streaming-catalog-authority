# Phase 171 - O4/O5 Review Checklist

Report id: `phase-171-o4-o5-review-checklist`

Phase 171 defines the review checklist for the redaction-safe O4/O5 evidence packet. It is a review
aid only and does not authorize implementation, live service contact, or gate closure.

## Packet Intake

Reviewers should verify:

- the packet uses `phase-166-o4-o5-evidence-packet`;
- all referenced artifacts are redaction-safe labels, not raw paths or secret values;
- O4 descriptor preflight output is present and marked ready for review;
- O5 descriptor preflight output is present and marked ready for review;
- the Phase 96 decision packet authorizes only the offline contract-harness evidence slice;
- KEK rewrap output is a plan artifact only;
- the packet states `O4 remains open` and `O5 remains open`.

## O4 Review Questions

- Is the custodian boundary outside the app process and app database?
- Is `KeyCustodian` conformance documented by a redacted command label?
- Is the attestation format documented and app-non-forgeability addressed?
- Are durable non-secret tombstones documented?
- Does restored-main-DB behavior fail closed until external custodian prerequisites are supplied?
- Has redaction review passed for logs, errors, command output, and evidence labels?

## O5 Review Questions

- Is managed KEK custody documented separately from the app database?
- Is rotation scheduling or an approved rotation cadence documented?
- Is the operator runbook documented?
- Is alert triage documented?
- Is independent secret media handling documented?
- Is residual risk explicitly accepted for any manual custody that remains?
- Has redaction review passed for all retained outputs?

## Automatic Holds

Hold review if any artifact includes raw secret material, raw logs, database URLs, provider refs,
media titles, backup contents, secret file contents, live-service identifiers, token values, or key
material.

Hold review if the packet implies provider contact, scraping, downloading, playback, Real-Debrid live
mode, TorBox live provider mode, Plex/Jellyfin mutation, media-server library writes, or runtime
Compose changes.

## Gate Semantics

O4 remains open. O5 remains open. This phase does not close O4 and does not close O5.

The checklist can support later explicit authorization records, but it is not itself authorization.

