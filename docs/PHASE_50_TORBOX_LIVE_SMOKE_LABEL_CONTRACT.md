# Phase 50 - TorBox Live Smoke Label Contract

Phase 50 centralizes the fixed TorBox live-smoke evidence labels used by Phase 43 report production,
Phase 44 evidence preflight, and Phase 49 summary packaging.

The goal is to prevent drift between:

- accepted `probe` values;
- accepted `operation` values;
- accepted `category` values;
- the redaction-safe `invalid-*` fallbacks used by the summary pack.

## Scope

Included:

- one static label contract module;
- shared probe, operation, and category allowlists;
- shared probe-to-operation mapping;
- shared fixed fallback helpers for summary output;
- deterministic tests proving Phase 44 and Phase 49 consume the same labels.

Not included:

- no live TorBox calls;
- no SDK dependency;
- no env reads;
- no credential-file reads;
- no database access;
- no transport construction;
- no provider writes, downloads, playback, scheduler, HTTP, or UI runtime.

This phase does not close live-smoke review. O4 and O5 remain open/deferred, and `FileCustodian`
remains a hardened reference harness rather than production KMS.
