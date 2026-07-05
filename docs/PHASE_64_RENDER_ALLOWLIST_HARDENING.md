# Phase 64 - Render Allowlist Hardening

Phase 64 adds a static render allowlist gate for the Phase 63 read-only operator UI prototype.
It is evidence for the render boundary, not a sanitizer and not a live UI runtime.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains advisory/count-only.

## Purpose

`src/ops/operator-ui-render-allowlist.ts` inspects rendered static HTML from
`renderOperatorUiStaticPrototypeHtml()` and returns fixed redaction-safe codes/counts only.
It proves that visible text is derived from Phase 61/62 allowlists plus fixed safe chrome used by
Phase 63.

Allowed render text sources are:

- Phase 61 screen ids, display field labels, status labels, and category labels;
- Phase 62 fixture packet labels derived from those same allowlists;
- fixed Phase 63 screen titles;
- fixed safe chrome such as `Operator UI Static Prototype`, `Static Fixture Console`,
  `Fixture Only`, `Read Only`, `Sanitized Activity`, table headers, and sequence numbers.

The inspection report uses fixed codes such as `OPERATOR_UI_RENDER_FORBIDDEN_TEXT`,
`OPERATOR_UI_RENDER_FORBIDDEN_MARKUP`, and `OPERATOR_UI_RENDER_FORBIDDEN_EXTERNAL_REFERENCE`.
It must not echo disallowed text, provider details, credentials, paths, URLs, raw payloads, or media
identity.

## Forbidden Markup And Content

The render allowlist rejects static HTML containing text outside the allowed set. It also rejects
attempts to add browser JavaScript, external references, or interactive/control markup such as
script, link, image, iframe, form, input, and button elements.

The prototype must not include real titles, external IDs, provider refs/names/logos, infohashes,
magnets, credentials, tokens, secrets, paths, URLs, poster/artwork data, raw logs, raw payloads,
user library/media identity, playback actions, download actions, streaming actions, provider
controls, or live operational identities.

In short: no React, Vite, Next, Express, frontend framework, bundler, HTTP route, API route, database read, provider adapter, network call, env read, file read, browser JavaScript, browser storage, external asset, remote font, provider control, playback, download, or streaming behavior.

## Non-Goals

Phase 64 does not add a renderer rewrite, frontend framework, browser JavaScript, server, API route,
packaged artifact, file watcher, runtime data source, provider adapter, provider mode, playback,
download, or streaming behavior. The helper is a deterministic review/evidence gate for the static
prototype output; it does not make arbitrary runtime data safe to render.

## Future Phase 65

Phase 65 may consider packaging the static prototype artifact or improving visual layout, but should
remain fixture-only unless Clint explicitly authorizes live data. Any packaging work should keep the
Phase 64 allowlist inspection in front of broader UI changes.
