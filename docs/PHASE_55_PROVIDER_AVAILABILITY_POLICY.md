# Phase 55 - Provider Availability Policy

Phase 55 adds a pure policy layer for turning advisory provider adapter results into fixed routing
decisions.

The policy is intentionally narrow:

- `available` becomes a redaction-safe `candidate`;
- `unavailable` becomes `skip`;
- `unknown`, stale, malformed, or invalid input becomes `hold`;
- every decision remains `advisoryOnly: true` and `persisted: false`;
- provider locators, raw refs, provider payload details, URLs, credentials, item ids, and media
  identity are never echoed.

## Scope

Included:

- one pure TypeScript policy module;
- fixed decision status and action labels;
- stale-result fail-closed handling;
- tests for redaction and no provider/runtime creep.

Not included:

- no live TorBox contact;
- no provider transport construction;
- no env reads or credential reads;
- no database access or event-log persistence;
- no downloads, playback, scheduler, HTTP service, UI, scraping, provider writes, or CI live-network
  requirement.

This phase does not enable provider mode, close O4, or close O5. O4 and O5 remain open/deferred, and
`FileCustodian` remains a hardened reference harness rather than production KMS.
