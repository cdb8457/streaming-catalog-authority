# Phase 230: Fixture Evidence Bundle Generator (local, non-live)

Report id: `phase-230-promotion-fixture-evidence-bundle`

Status: `PHASE_230_PROMOTION_FIXTURE_BUNDLE_READY`

Runs one successful offline rehearsal and assembles a single **redaction-safe, deterministic** evidence
bundle carrying every derived artifact and report. It reads/writes local JSON only; it performs no
promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live
(no Phase 231).

## Contents

- `rehearsalManifest` — the single-run rehearsal manifest.
- `artifacts` — `approvalEvidence` (the redaction-safe approval evidence, **not** the raw approval file
  with real paths), `promotionEvidence`, `evidenceReview`, `readiness`, `acceptancePacket`.
- `reports` — `integrity`, `schema`, `matrix`, `handoff`, `dashboard`.
- `outcome` — `BUNDLE_READY` iff the rehearsal passed, integrity/schema are ok, handoff is
  `READY_FOR_COORDINATOR`, and the dashboard is `DASHBOARD_READY`; otherwise `BUNDLE_INCOMPLETE`.
- `authorization` is the constant `NONE`; a `RAW_PATH_IN_BUNDLE` self-scan note + `BUNDLE_INCOMPLETE`
  fire if any path-shaped string is ever found. The bundle is sealed with a `bundleDigest`.

Given identical fixed inputs (`workDir`, `runId`, `acceptorId`, `now` sequence), the whole bundle is
reproducible and `bundleDigest = sha256("phase-230-fixture-bundle:" + body)` recomputes exactly.

## Files

- `src/ops/promotion-fixture-bundle.ts` — `buildFixtureEvidenceBundle(input)`.
- `src/ops/promotion-fixture-bundle-cli.ts` — CLI wrapper.
- `test/promotion-fixture-bundle.ts` — 5 tests: complete BUNDLE_READY, redaction-safety, bundle-digest
  recomputation, cross-run determinism, and a spawned CLI run.

## Usage

```
npm run ops:promotion-fixture-bundle -- [--work-dir dir] [--run-id id] [--acceptor-id id] [--out bundle.json]
```

Exit `0` = `BUNDLE_READY`, `1` = `BUNDLE_INCOMPLETE`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
