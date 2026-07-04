# Phase 56 - Provider Availability Bridge

Phase 56 wires advisory provider adapter output through the Phase 55 provider availability policy.

The bridge performs one scoped adapter lookup and returns a sanitized report:

- adapter status only: `available`, `unavailable`, or `unknown`;
- fixed Phase 55 decision labels: `candidate`, `skip`, or `hold`;
- `advisoryOnly: true`;
- `persisted: false`;
- no provider locator or detail echo.

## Scope

Included:

- a pure bridge helper for provider availability classification;
- TorBox catalog-bridge acceptance coverage using the bridge helper;
- redaction tests proving locator/detail/raw refs/URLs/credentials are not echoed;
- stale/unknown fail-closed behavior inherited from Phase 55.

Not included:

- no live TorBox contact;
- no provider transport construction;
- no env reads or credential reads;
- no database writes or event-log persistence;
- no downloads, playback, scheduler, HTTP service, UI, scraping, provider writes, or CI live-network
  requirement.

This phase does not enable provider mode beyond the existing explicit injected adapter path, close
O4, or close O5. O4 and O5 remain open/deferred, and `FileCustodian` remains a hardened reference
harness rather than production KMS.
