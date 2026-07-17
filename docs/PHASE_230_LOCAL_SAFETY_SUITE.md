# Phase 230: Local Safety Suite Harness (local, non-live)

Report id: `phase-230-local-safety-suite`

Status: `PHASE_230_LOCAL_SAFETY_SUITE_READY`

A single package script, `test:phase230-local`, that runs **only** the Phase 230 local safety suites —
and deliberately **excludes** the full `npm test` aggregate and the legacy / live / known-failing suites
(the CRLF-sensitive doc-string suites, the embedded-PostgreSQL suites, and the live Jellyfin suites).
This gives a fast, self-contained, always-green regression gate for the local tooling. Running it
performs no promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes
nothing live.

## Included suites

`promotion-approval`, `promotion-evidence-review`, `promotion-readiness`, `promotion-acceptance-seal`,
`real-library-promotion` (the guarded service, fixture tests only), `promotion-rehearsal`,
`promotion-rehearsal-matrix`, `promotion-artifact-integrity`, `promotion-artifact-schema`,
`promotion-dashboard`, `promotion-handoff`, `promotion-fixture-bundle`, `promotion-bundle-replay`,
`promotion-evidence-packet`, `promotion-bundle-diff`, `promotion-tamper-corpus`,
`promotion-review-transcript`, `promotion-provenance-ledger`, `promotion-gate-dag`,
`promotion-changelog`, `promotion-archive-manifest`, `promotion-acceptance-meta`,
`promotion-injection-corpus`, `promotion-review-bundle`, `promotion-consistency-matrix`,
`promotion-self-digest-verifier`, `promotion-cli-contract`, `promotion-determinism`,
`promotion-blocker-taxonomy`, `promotion-final-summary`, `promotion-closure-hygiene`,
`promotion-negative-evidence-corpus`, `promotion-release-checklist`, `promotion-merge-readiness`,
`promotion-provenance-diff`, `promotion-gate-coverage`, `promotion-chain-bundle`,
`promotion-redaction-corpus`, `promotion-boundary-policy`, `promotion-review-automation`,
`promotion-live-boundary-guard`, `phase230-closure`, and the `phase230-local-suite-manifest` guard itself.

## Excluded (by design)

`real-library-promotion-boundary` and `deploy` (CRLF-sensitive doc-string assertions), `config` (the
full-aggregate entry point), and the embedded-PostgreSQL / live-Jellyfin suites.

## Regression guard

`test/phase230-local-suite-manifest.ts` reads `package.json` and asserts `test:phase230-local` includes
every local suite, excludes every legacy/live/known-failing suite, and is not the full aggregate — so
the gate can't silently drift.

## Usage

```
npm run test:phase230-local
```

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
