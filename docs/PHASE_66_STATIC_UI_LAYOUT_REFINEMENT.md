# Phase 66 - Static UI Layout Refinement

Phase 66 refines the static operator UI artifact layout while keeping the surface fixture-only. It is
a static UI layout refinement over the Phase 63 renderer and Phase 65 artifact packaging, not a live
browser application.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS. Provider availability remains advisory/count-only.

## What Changed

`src/ops/operator-ui-static-prototype.ts` keeps rendering from `OPERATOR_UI_FIXTURE_PACKETS`, but the
fixed chrome is more structured:

- a clearer graphite appliance shell with left navigation and a shallow top strip;
- an overview band with summary cards and a status rail;
- denser panel headings with read-only fixture state;
- table frames for responsive overflow;
- static responsive CSS for desktop, tablet, and small screens.

The visual direction stays Graphite + Muted Orange: bordered panels, compact tables, restrained
status chips, 8px-or-smaller radii, no gradients, no decorative effects, no marketing hero, and no
media-browsing treatment.

## Fixture-Only Boundary

This phase does not connect live packets, sanitized local packets, database rows, event-store data,
provider data, credentials, local files, environment variables, or network resources. The static HTML
still comes only from fixture packets plus fixed safe chrome text.

There is no React, Vite, Next, Express, frontend framework, bundler, HTTP route, API route, database
read, event-store read, provider adapter, network call, env read, file read, browser JavaScript,
browser storage, external asset, remote font, image, form, input, button, provider control, playback,
download, or streaming behavior.

## Gates Still Required

Phase 64 remains the render allowlist gate. Any visible chrome added by this phase is explicitly
listed in `OPERATOR_UI_RENDER_STATIC_CHROME_TEXT`, and `test:operator-ui-render-allowlist` must
continue to accept the generated HTML.

Phase 65 remains the artifact packaging gate. `buildOperatorUiStaticArtifact()` still renders,
inspects, hashes, and describes the artifact only after the allowlist accepts it. JSON metadata
remains metadata-only and omits the HTML body.

Phase 66 adds `test:operator-ui-static-layout` to assert the layout landmarks, flat panel structure,
static responsive CSS, no external/browser-JavaScript references, and deterministic artifact
metadata/digest behavior.

## Future Decision Gate

Connecting live or sanitized local packets is deferred. Before any local packet source is connected,
a later phase must explicitly decide the allowed source, redaction contract, review evidence, and
failure behavior. Phase 66 does not authorize that connection.
