# Phase 36 - TorBox Live Smoke Acceptance Contract

Phase 36 is a safety contract for a future live TorBox smoke command. It is not a live transport.
It is not an operator command, not an SDK integration, and not proof that TorBox works against a real
account.

This phase turns the Phase 35 smoke evidence design into an ordered acceptance gate. The goal is to
make the next live step boring and reviewable: before any future implementation contacts TorBox, the
implementation must prove it follows this contract.

## Scope

Included:

- an acceptance contract for a future opt-in TorBox live smoke command;
- the required execution order for that future command;
- the minimum fail-closed categories and redaction boundaries;
- the future evidence handoff shape that maps back to `docs/templates/TORBOX_SMOKE_EVIDENCE.md`;
- static tests that prove this contract is wired and that Phase 36 remains non-live.

Not included:

- no live TorBox calls;
- no real TorBox transport implementation;
- no operator smoke CLI;
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

## Required Future Execution Order

A future live smoke command must execute in this order and fail closed before contacting TorBox if
any preflight step is missing:

1. Confirm explicit operator authorization for live TorBox smoke.
2. Confirm the command is opt-in and out of CI.
3. Confirm read-only mode.
4. Confirm secret indirection is configured without printing the secret value or secret file path.
5. Confirm the probe set is limited to service status, hoster metadata, and one scoped cache
   availability check at a time.
6. Confirm bounded per-probe timeout and total run timeout.
7. Confirm redaction mode is active.
8. Execute read-only probes through an injected reviewed transport only.
9. Emit only the Phase 35 evidence shape: counts, fixed statuses, operation names, and fail-closed
   categories.
10. Require operator/reviewer redaction signoff before the artifact is shared.

No future command may reorder these checks to touch TorBox before authorization, read-only mode,
secret indirection, timeout bounds, and redaction are confirmed.

## Required Future CLI Contract

A future command should be named as an explicit smoke command, for example `smoke:torbox-readonly`.
That command must be:

- absent from `npm run test` and `npm run ci`;
- operator-run only;
- disabled unless a live-smoke flag and a read-only flag are both present;
- unable to infer enablement from `ADAPTER_MODE`;
- unable to run from default config;
- unable to write to the database or event log;
- unable to print tokens, credential-bearing URLs, raw refs, raw response bodies, provider payloads,
  titles, item ids, CDN URLs, or permalink URLs.

If any of these are not true, the future command must refuse to run before contacting TorBox.

## Allowed Future Probes

Only these read-only probes may be part of the first live smoke implementation:

| Probe | Limit | Evidence |
|---|---|---|
| service status | fixed status/category only | status category |
| hoster metadata | capability/status metadata only | count and category summary |
| cache availability | one scoped ref at a time | aggregate hit/miss/unknown counts |

The cache probe must not retain or display the raw scoped ref. It may only report the redacted
operation name and aggregate category.

## Mandatory Failure Categories

A future implementation must use fixed categories and must not pass through provider messages:

- `auth`
- `quota`
- `timeout`
- `transport`
- `parse`
- `unsupported-ref`
- `empty-ref`
- `ambiguous-response`
- `policy-block`
- `redaction-block`
- `not-authorized`
- `not-read-only`

Unexpected provider shapes must become `ambiguous-response` or `parse`. Provider strings, response
snippets, endpoint URLs, account labels, and SDK diagnostics must not appear in public output.

## Reviewer Checklist For The Future Live Smoke Phase

Before the later live implementation can merge, Reviewer must confirm:

- the command cannot run from CI or the default test chain;
- the command cannot run without explicit live-smoke and read-only acknowledgement;
- no `ADAPTER_MODE` wiring enables TorBox;
- no create/download/request-link/permalink/CDN/user/control/delete/export operations exist;
- redaction tests cover provider errors, parse errors, timeout errors, and hostile input values;
- evidence maps to `docs/templates/TORBOX_SMOKE_EVIDENCE.md`;
- logs and thrown errors expose only operation, status, and fixed category;
- the implementation has no DB writes or event-log writes;
- O4 and O5 remain visible open/deferred gates;
- `FileCustodian` remains a hardened reference harness, not production KMS.

## Readiness Meaning

Phase 36 does not prove TorBox works. It only defines the acceptance order for a later operator-run,
read-only live smoke.

Even a future successful live smoke would not validate downloading, playback, media-server sync, or
production readiness. O4 remains open/deferred until a production external custodian/KMS adapter is
accepted. O5 remains open/deferred until managed KEK custody and scheduling evidence is accepted.

`FileCustodian` remains a hardened reference harness, not production KMS.
