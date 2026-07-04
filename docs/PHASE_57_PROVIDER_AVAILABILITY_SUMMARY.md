# Phase 57 - Provider Availability Summary

Phase 57 adds a pure count-only summary for sanitized provider availability bridge reports.

The summary is intended for future operator/orchestration visibility without widening the provider
privacy boundary:

- counts `candidate`, `skip`, and `hold` decisions;
- counts fixed statuses: `available`, `unavailable`, `unknown`, `stale`, and `invalid`;
- emits a fixed readiness label: `empty`, `has-candidates`, `all-skipped`, or `held`;
- includes no item rows, provider locators, provider details, raw refs, URLs, credentials, media
  identity, or provider payloads.

## Scope

Included:

- one pure summary module;
- fixed aggregate counts and readiness labels;
- hostile/malformed input fail-closed handling;
- tests for redaction and no runtime creep.

Not included:

- no live TorBox contact;
- no provider transport construction;
- no env reads or credential reads;
- no database access or event-log persistence;
- no downloads, playback, scheduler, HTTP service, UI, scraping, provider writes, or CI live-network
  requirement.

This phase does not enable provider mode, close O4, or close O5. O4 and O5 remain open/deferred, and
`FileCustodian` remains a hardened reference harness rather than production KMS.
