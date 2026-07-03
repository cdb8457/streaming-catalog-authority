# Future Operator Dashboard Examples

These are low-fidelity examples for a future operator dashboard. These are documentation examples
only. Phase 35 adds no frontend code, no UI runtime, no UI build tooling, no HTTP service, and no
browser automation.

The intended product shape is a quiet utilitarian operations UI: dense tables, restrained colors,
predictable navigation, small status indicators, and 8px-or-less radius if cards are ever used. It
should not look like an AI-generated dashboard or a marketing site: no hero section, decorative
gradients, orbs, oversized empty cards, chat chrome, consumer playback UI, or download/play buttons.

## Readiness Gates

```text
Readiness Gates

Gate   Status    Last evidence          Doctor signal       Next action
O4     Open      Deferred by policy      WARN visible        Review external custodian adapter evidence
O5     Open      Deferred by policy      WARN visible        Review managed KEK custody schedule
DB     Met       2026-07 build check     PASS                Continue routine backup rehearsal
CI     Met       Latest package run      PASS                Keep deterministic suites green

Warnings
- O4 remains open/deferred; FileCustodian is a reference harness, not production KMS.
- O5 remains open/deferred; managed KEK custody/scheduling evidence is not accepted.
```

Design notes:

- use table rows and fixed status labels, not prose cards;
- keep doctor warnings visible without implying production readiness;
- link each gate to the redaction-safe evidence document, never to raw artifacts.

## TorBox Smoke

```text
TorBox Smoke

Last run      Mode       Overall    Service   Hosters   Cache refs   Unknown   Failure categories
Not run       Read-only  Not-run    -         -         0            0         -

Recent read-only probe summary
Probe               Attempted   Available   Unavailable   Unknown   Status
Service status      0           -           -             -         Not-run
Hoster metadata     0           -           -             -         Not-run
Cache availability  0           0           0             0         Not-run

Redaction boundary
- Counts and fixed categories only.
- No raw refs, tokens, URLs, response bodies, titles, item ids, CDN URLs, or permalink URLs.
```

Design notes:

- this screen is advisory availability only;
- never include raw refs, secret values, token-bearing URLs, provider payloads, or item identity;
- do not add download, playback, create, permalink, CDN, user, control, delete, or export actions.

## Catalog Privacy

```text
Catalog Privacy

Area                    Status   Last check        Evidence
Crypto-shredding        Met      Latest CI         Phase 2 tests
Backup replay compare   Met      Latest CI         Backup integrity gate
Restore rehearsal       Due      Operator-owned    Redacted rehearsal evidence
External custodian O4   Open     Deferred          Production custodian evidence needed
Managed KEK O5          Open     Deferred          KEK custody/schedule evidence needed

Boundary
- Main DB backups hold ciphertext and key-control state only.
- FileCustodian is a hardened reference harness, not production KMS.
- Redacted evidence must exclude key material, identity, provider refs, and secret paths.
```

Design notes:

- make open gates prominent but not alarming when they are expected deferred work;
- group privacy status by operational responsibility;
- avoid media-title search, consumer watch history, or content artwork in this phase.

## Provider Availability

```text
Provider Availability

Provider   Mode        Scope          Available   Unavailable   Unknown   Last evidence
TorBox     Disabled    Advisory only  0           0             0         Phase 35 template
Jellyfin   Deferred    Publisher      -           -             -         Separate validation docs

Scoped ref summary
Ref type              Checked   Available   Unavailable   Unknown
infohash              0         0           0             0
hash-digest           0         0           0             0
link-derived-digest   0         0           0             0
nzb-derived-digest    0         0           0             0
```

Design notes:

- provider availability is advisory and must not write catalog events;
- show scoped refs as counts and categories only;
- no playback, download, request-link, create, export, or library-management buttons yet.
