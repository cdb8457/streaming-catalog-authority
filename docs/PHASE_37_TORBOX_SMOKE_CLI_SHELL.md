# Phase 37 - TorBox Smoke CLI Shell

Phase 37 adds the operator command shell for a future TorBox read-only smoke, but still does not add
a live TorBox transport. The command refuses before provider contact because no live transport is
attached in this phase.

The command is:

```text
npm run smoke:torbox-readonly -- --live-smoke --read-only --redacted --operator-authorized --credential-ref <opaque-ref> --json
```

The `<opaque-ref>` value is an operator-owned label only. It must not be a token, API key, credential
URL, secret value, or secret file path. Phase 37 records only whether a credential reference was
provided; it never prints the value.

## Scope

Included:

- `smoke:torbox-readonly` package script, operator-run only and absent from `npm run test` / `npm run ci`;
- `src/ops/torbox-smoke-cli.ts`, a small CLI wrapper;
- `src/ops/torbox-smoke-shell.ts`, local preflight/report formatting logic;
- deterministic tests in `test:torbox-smoke-cli`;
- README/deploy guard wiring.

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
- no create-download, request-download-link, request-permalink, user list, user data, control,
  delete, export, CDN, permalink URL, library-management, or media-server behavior.

## Refusal Behavior

The command returns a redaction-safe refusal report. It is expected to exit non-zero until a later
separately reviewed phase adds a live transport.

It refuses when any of these gates are missing:

- operator authorization;
- explicit `--live-smoke`;
- explicit `--read-only`;
- credential reference presence;
- explicit `--redacted`;
- supported cache ref type when `--probe cache-availability` is selected;
- scoped-ref presence when `--probe cache-availability` is selected;
- live transport attachment.

The final gate always blocks in Phase 37:

```text
BLOCK no-live-transport-attached (transport)
```

That block is intentional. It proves the command shape exists without contacting TorBox.

## Redaction Contract

Public output may include only:

- command name;
- mode;
- probe name;
- operation name;
- fixed gate names;
- fixed categories;
- counts;
- whether credential indirection was configured;
- whether a scoped ref was present.

Public output must never include tokens, API keys, bearer values, cookies, credential URLs, secret
values, secret file paths, raw refs, infohashes, digests, raw endpoint URLs, raw response bodies,
provider payloads, titles, years, item ids, CDN URLs, or permalink URLs.

## Supported Probe Shells

| Probe | Operation | Phase 37 behavior |
|---|---|---|
| service-status | `status-check` | preflight only, then refuses |
| hoster-metadata | `hoster-list` | preflight only, then refuses |
| cache-availability | `cache-availability` | validates ref type/presence only, then refuses |

Cache availability accepts only a supported ref type and a boolean presence marker. It does not
accept or print a raw ref value in Phase 37.

## Readiness Meaning

Phase 37 does not prove TorBox works. It proves the operator command shell is fail-closed,
redaction-safe, out of CI, detached from `ADAPTER_MODE`, and blocked before provider contact.

Phase 38 follows with `docs/PHASE_38_TORBOX_SMOKE_FIXTURE_HARNESS.md` and deterministic
`--fixture` output for the same shell. Phase 38 still adds no live TorBox transport, SDK dependency,
provider mode, or proof that real TorBox works.

O4 remains open/deferred. O5 remains open/deferred. `FileCustodian` remains a hardened reference
harness, not production KMS.
