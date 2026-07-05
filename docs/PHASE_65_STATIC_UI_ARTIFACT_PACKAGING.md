# Phase 65 - Static UI Artifact Packaging

Phase 65 adds static operator UI artifact packaging for the Phase 63 read-only prototype. It is a
fixture-only inspection artifact, not a production UI, browser app, server, API, or runtime data
surface.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains advisory/count-only.

## Purpose

`src/ops/operator-ui-static-artifact.ts` exposes `buildOperatorUiStaticArtifact()`. The helper renders
the Phase 63 static HTML, runs the Phase 64 allowlist gate through `inspectOperatorUiRenderedHtml()`,
and returns artifact metadata plus the HTML only when inspection passes.

The suggested artifact filename is `operator-ui-static-prototype.html`. The metadata contains fixed
codes, byte count, SHA-256 digest, content type, filename, and the Phase 64 inspection report. JSON
evidence intentionally omits the HTML body.

## Generate The Artifact

The helper and CLI do not write files. To retain the static HTML artifact, redirect stdout:

```sh
npm run --silent ops:operator-ui-static-artifact > operator-ui-static-prototype.html
```

For redaction-safe metadata only:

```sh
npm run --silent ops:operator-ui-static-artifact -- --json
```

The CLI exits nonzero if the Phase 64 allowlist gate rejects the render. Rejection output uses fixed
codes and does not echo disallowed rendered values.

## Privacy And Non-Goals

This phase remains fixture-only. It reads no files, env, database, event store, provider, credential,
or local media data. It performs no network calls and auto-writes no artifact.

In short: no React, Vite, Next, Express, frontend framework, bundler, HTTP route, API route, database read, provider adapter, network call, env read, file read, browser JavaScript, browser storage, external asset, remote font, provider control, playback, download, or streaming behavior.

The digest is over the static fixture HTML only. It must not be treated as evidence over live data,
secret data, provider results, or local media identity.

## Future Phase 66

Recommended next step: visual/layout refinement over the fixture artifact only. If live or sanitized
local packets are proposed, Phase 66 should start with an explicit decision gate before any source is
connected to local data.
