# Phase 38 - TorBox Smoke Fixture Harness

Phase 38 adds deterministic fixture execution to the `smoke:torbox-readonly` shell. It does not add a live TorBox transport. It still does not add SDK integration, provider mode, or proof that TorBox works against a real account.

The fixture mode is explicit:

```text
npm run smoke:torbox-readonly -- --live-smoke --read-only --redacted --operator-authorized --credential-ref <opaque-ref> --fixture available --json
```

The fixture flag attaches only a local fake transport result. It never contacts TorBox and never
reads provider credentials. The `<opaque-ref>` value remains an operator-owned label only and is not
printed.

## Scope

Included:

- local deterministic fixture scenarios for the Phase 37 CLI shell;
- redaction-safe PASS/BLOCK JSON and text output;
- fixed output categories for auth, quota, timeout, parse, and ambiguous-response paths;
- deterministic tests in `test:torbox-smoke-fixture`;
- deploy guard wiring that keeps live TorBox out of CI.

Not included:

- no live TorBox calls;
- no real TorBox transport implementation;
- no `@torbox/torbox-api` dependency or import;
- no global fetch, Node network modules, browser automation, Docker invocation, HTTP service,
  frontend runtime, UI build tooling, scraping, downloading, playback, Plex, Jellyfin, Real-Debrid,
  or provider expansion;
- no environment-variable reads, secret-file reads, token handling, token-in-URL examples, DB
  writes, event-log writes, provider payload persistence, `ADAPTER_MODE` wiring, or adapter-factory
  mode for TorBox;
- no adapter-factory mode for TorBox;
- no create-download, request-download-link, request-permalink, user list, user data, control,
  delete, export, CDN, permalink URL, library-management, or media-server behavior.

## Fixture Scenarios

Allowed fixture scenarios:

| Fixture | Public category | Meaning |
|---|---|---|
| `available` | `fixture-ok` | local advisory hit |
| `unavailable` | `fixture-ok` | local advisory miss |
| `unknown` | `fixture-ok` | local advisory unknown |
| `auth` | `auth` | redacted auth failure |
| `quota` | `quota` | redacted quota/rate-limit failure |
| `timeout` | `timeout` | redacted timeout failure |
| `parse` | `parse` | redacted parse failure |
| `ambiguous-response` | `ambiguous-response` | redacted ambiguous provider-shape failure |

Output is limited to fixed gates, operation names, categories, and counts. Fixture mode never prints
tokens, API keys, raw refs, credential URLs, secret values, secret file paths, raw endpoint URLs,
raw response bodies, provider payloads, titles, years, item ids, CDN URLs, or permalink URLs.

## Readiness Meaning

Phase 38 proves only that operator-style TorBox smoke output can be rendered and redacted using local
fixtures. It does not prove live TorBox availability, downloading, playback, media-server sync, or
production readiness.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.
