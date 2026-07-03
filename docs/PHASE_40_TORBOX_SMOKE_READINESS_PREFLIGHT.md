# Phase 40 - TorBox Smoke Readiness Preflight

Phase 40 adds a static, redaction-safe descriptor preflight for future TorBox operator smoke
readiness review. It does not add a live TorBox transport, does not call TorBox, and does not prove
that TorBox works against a real account.

Run it with:

```text
npm run ops:torbox-smoke-readiness-preflight -- -- <descriptor.json>
npm run ops:torbox-smoke-readiness-preflight -- -- <descriptor.json> --json
```

## Scope

Included:

- one required descriptor JSON path;
- bounded descriptor-file read;
- fixed pass/warn/fail findings for future live-smoke readiness metadata;
- redaction-safe text and JSON reports;
- deterministic tests in `test:torbox-smoke-readiness-preflight`;
- deploy guard wiring.

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

## Descriptor

The descriptor is metadata only. Supported fields are:

- `credentialReferenceLabel`: non-secret label showing where the operator-owned credential reference
  is tracked.
- `transportAcceptanceEvidenceLabel`: non-secret label pointing to Phase 39 acceptance evidence.
- `operatorAuthorizationDocumented`: explicit operator authorization is documented.
- `liveNetworkOptInDocumented`: future live network execution requires an explicit opt-in.
- `readOnlyIntentDocumented`: future smoke remains read-only.
- `scopedRefPolicyDocumented`: scoped-ref policy is documented.
- `redactionPolicyDocumented`: redaction policy is documented.
- `evidenceRetentionPolicyDocumented`: evidence-retention policy is documented.
- `boundedTimeoutPolicyDocumented`: bounded timeout policy is documented.
- `noProviderPayloadRetention`: provider payloads must not be retained.
- `noAdapterModeWiring`: TorBox remains absent from `ADAPTER_MODE`.
- `noDownloadOrPlaybackIntent`: download and playback behavior are not part of smoke readiness.
- `redactionReviewStatus`: `passed`, `pending`, `failed`, or `unknown`.

Labels must be non-secret evidence labels only. The descriptor must not include tokens, API keys, raw
refs, raw response bodies, endpoint URLs, credential URLs, secret values, secret file paths, provider
payloads, titles, years, item ids, CDN URLs, or permalink URLs.

## Output

Normal output never echoes descriptor paths, descriptor values, raw JSON, parse snippets, raw parser
errors, credential refs, or provider material. It emits only:

- fixed report metadata;
- fixed finding codes;
- fixed field names;
- fixed messages;
- pass/warn/fail counts.

Complete metadata can produce `reviewReadiness: "ready-for-review"`, but this does not authorize
live TorBox smoke and does not close any live-readiness gate. Live smoke remains a separate
authorized and reviewed future phase.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.

Phase 41 builds on this with a static TorBox endpoint mapping review for the first future live
read-only smoke surface. That mapping review remains docs/tests only: no live TorBox calls, no real
TorBox transport, no SDK dependency, no environment-variable reads, no `ADAPTER_MODE` wiring, and no
live-smoke authorization.
