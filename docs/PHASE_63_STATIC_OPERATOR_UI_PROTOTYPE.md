# Phase 63 - Static Operator UI Prototype

Phase 63 adds a read-only static operator UI prototype generated from Phase 62 fixture packets only.
It is a visual prototype for the nine allowed operator screens, not a live application surface.

O4 and O5 remain open/deferred. `FileCustodian` remains a hardened reference harness, not production
KMS.

## Purpose

The renderer in `src/ops/operator-ui-static-prototype.ts` returns a complete static HTML document
string. It consumes `OPERATOR_UI_FIXTURE_PACKETS`, uses only Phase 61/62 screen, field, status, and
category labels, and performs no runtime lookup.

The prototype covers:

- `overview`
- `catalog-authority`
- `privacy-crypto-shredding`
- `key-custodian-o4-status`
- `reconciler`
- `backup-restore`
- `provider-availability-packets`
- `audit-queue`
- `settings-operator-configuration`

## Generate And Open

To inspect the static HTML locally:

```sh
npm run --silent ops:operator-ui-static-prototype > operator-ui-static-prototype.html
```

Open the generated HTML file with a browser. The CLI prints only the deterministic renderer output
to stdout. It reads no files or env values and makes no network, database, provider, or server call.

## Design Constraints

The prototype follows Phase 60 Graphite + Muted Orange direction:

- graphite surfaces using `#111214`, `#1A1B1E`, and `#232428`;
- structural borders using `#303238`;
- muted orange accent using `#D18A3A`;
- restrained status colors for verified, warning, failed/blocked, and informational states;
- left navigation, a shallow top status strip, compact bordered panels, and tables;
- 8px or smaller corner radius;
- terminal flavor only for safe sequence/status metadata rows.

There are no generated images, imported Stitch assets, remote fonts, external CSS, external images,
JavaScript, browser storage, or framework runtime.

## Privacy/Non-Goals

This phase has the same static privacy boundary as Phase 61 and Phase 62.

The prototype contains no real titles, external IDs, provider names or logos, raw refs, infohashes,
magnets, credentials, tokens, secrets, paths, URLs, poster or artwork data, raw logs, raw payloads,
user library/media identity, playback actions, download actions, streaming actions, destructive
controls, provider controls, or live operational identities.

There is no React, Vite, Next, Express, frontend framework, bundler, HTTP route, API route, database
read, provider adapter, network call, env read, file read, browser storage, external asset, remote
font, provider control, playback, download, or streaming behavior.

In short: no React, Vite, Next, Express, frontend framework, bundler, HTTP route, API route, database read, provider adapter, network call, env read, file read, browser storage, external asset, remote font, provider control, playback, download, or streaming behavior.

Provider availability remains advisory/count-only.

## Future Phase 64

Phase 64 should harden the render boundary before any broader UI work. Recommended scope:

- explicit render allowlist checks between fixture packets and HTML output;
- static privacy assertions for generated markup;
- stricter checks that no new visible copy bypasses Phase 61/62 labels;
- reviewer-friendly evidence that the prototype cannot consume runtime/provider data.
