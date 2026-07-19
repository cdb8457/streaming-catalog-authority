# Phase 230: Closure Input Bundle Audit (local, non-live)

Report id: `phase-230-promotion-closure-input-bundle-audit`

Status: `PHASE_230_PROMOTION_CLOSURE_INPUT_BUNDLE_AUDIT_READY`

## Why this exists

Self-sealing gives **integrity, not authenticity**: a report can recompute its own self-digest and still be
forged. Exact-equality of a parent's `boundDigests` to a supplied child does not help if the child is itself
a forged green self-sealed report. This auditor validates the **whole input mesh at once** so a bundle that
forges the aggregators but omits (or shallow-forges) their real children fails closed.

## What it proves

Given a bundle (array) of the closure input reports, a report is **mesh-valid** only when:

- it recomputes (self-digest) and is green (its expected overall), and
- for each aggregator, **every** declared child binding exactly equals the recomputed self-digest of a
  **supplied** child report that is **itself mesh-valid** — a fixpoint over the bundle (the DAG has no cycles).

Aggregator child sets: `review-authorization` → terminal-readiness-v2, terminal-closure, commit-range-closure,
transcript-verification, review-matrix; `terminal-readiness-v2` → terminal-closure, pack-component-integrity,
aggregator-digest-audit, artifact-export-manifest, negative-evidence-corpus, watchdog-hygiene;
`terminal-closure` → transcript-verification, evidence-minimizer, commit-range-closure, regression-oracle,
coordinator-readiness; `coordinator-readiness` → acceptance-preflight, failure-mode-matrix, report-schema,
boundary-audit, cli-ergonomics.

Validity is keyed by the **exact recomputed self-digest**, never by report-id membership, and a report id
supplied more than once with **conflicting** content (a copy that is missing/not-green or carries a different
self-digest) is **ambiguous and never mesh-valid** (`DUPLICATE_REPORT_ID`) — so a genuine same-id anchor
cannot shadow a different forged top-level object. Identical duplicate copies are permitted.

`overall` is `CLOSURE_BUNDLE_VERIFIED` only when the roots — `review-authorization`, `coordinator-readiness`,
and `terminal-readiness-v2` — are all mesh-valid (`BUNDLE_ROOT_UNRESOLVED` otherwise; `DUPLICATE_REPORT_ID` on
a conflicting duplicate; `NO_REPORTS` guards an empty bundle). It reads parsed JSON only; it performs no promotion, never touches the real Movies root, never
contacts Jellyfin, and its `authorization` field is the constant `NONE`. It echoes only report short-names,
booleans, and counts — never a raw path — and is sealed with an `auditDigest`. `closure-summary-v3` consumes
this auditor (over its RA/CR + anchor bundle) so RA/CR are context-bound only when the mesh fully resolves.

**Residual (documented, not a defect):** a *fully-consistent deep forgery* — every report at every level
forged, self-sealed, and mutually consistent — cannot be distinguished from a genuine bundle by any pure
JSON-parsing tool; that is the signing problem and is out of scope for a local, trust-root-free auditor. This
op closes the practical forged-anchor class (aggregators forged, real children absent or shallow-forged).

## Files

- `src/ops/promotion-closure-input-bundle-audit.ts` — `buildClosureInputBundleAudit(input)`,
  `meshValidReports(reports)`, `BUNDLE_ROOTS`.
- `src/ops/promotion-closure-input-bundle-audit-cli.ts` — CLI wrapper.
- `test/promotion-closure-input-bundle-audit.ts` — 5 tests: verified on the genuine full mesh; broken when an
  aggregator's deep children are missing (forged shallow anchors); broken with `DUPLICATE_REPORT_ID` on a
  conflicting duplicate id; empty input; and a spawned CLI run.

## Usage

```
npm run ops:promotion-closure-input-bundle-audit -- --reports bundle.json [--out audit.json]
```

Exit `0` = `CLOSURE_BUNDLE_VERIFIED`, `1` = `CLOSURE_BUNDLE_BROKEN`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
