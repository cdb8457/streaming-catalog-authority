# Phase 230: Final Coordinator Review Bundle (local, non-live)

Report id: `phase-230-promotion-coordinator-review-bundle`

Status: `PHASE_230_PROMOTION_REVIEW_BUNDLE_READY`

Combines the five top-level offline records — the **evidence packet**, the **review transcript**, the
**provenance ledger**, the **gate DAG** (graph), and the **archive manifest** — into one redaction-safe,
deterministic coordinator review bundle that is `REVIEW_BUNDLE_READY` **only when all are present, valid,
and green**. It reads parsed JSON only; it performs no promotion, never touches `/mnt/user/media/Movies`,
never contacts Jellyfin, and **never authorizes Phase 231 or live promotion** (`authorization` is the
constant `NONE`).

## Green criteria

| Component | Green when |
|-----------|-----------|
| `evidence` | `overall === EVIDENCE_COMPLETE` |
| `transcript` | `verdict === REVIEW_CLEAN` |
| `ledger` | `complete === true` |
| `dag` | `ok === true` (acyclic) |
| `archive` | `overall === ARCHIVE_READY` |

Beyond the per-component green checks it enforces a consistency cross-check: the **archive manifest's own
component digests must match the evidence/transcript/ledger/dag actually supplied here** — so an archive
built over a *different* run is caught (`ARCHIVE_EVIDENCE_MISMATCH`, `ARCHIVE_TRANSCRIPT_MISMATCH`,
`ARCHIVE_LEDGER_MISMATCH`, `ARCHIVE_DAG_MISMATCH`) even when every component is individually green.

`overall` is `REVIEW_BUNDLE_READY` iff every component is present, green, and consistent; otherwise
`REVIEW_BUNDLE_BLOCKED` with generic blockers (`*_MISSING`, `*_INVALID`, `EVIDENCE_NOT_COMPLETE`,
`TRANSCRIPT_NOT_CLEAN`, `LEDGER_INCOMPLETE`, `DAG_NOT_ACYCLIC`, `ARCHIVE_NOT_READY`,
`ARCHIVE_*_MISMATCH`). Each component carries name/present/ok/digest; the fixed no-live / no-Phase-231
disclaimers are present in every bundle; and the whole is sealed with a `reviewBundleDigest`.

## Files

- `src/ops/promotion-review-bundle.ts` — `buildReviewBundle(input)`.
- `src/ops/promotion-review-bundle-cli.ts` — CLI wrapper.
- `test/promotion-review-bundle.ts` — 6 tests: all-green READY, missing component, not-clean transcript,
  a cross-run archive mismatch, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-review-bundle -- --evidence f --transcript f --ledger f --dag f --archive f [--out bundle.json]
```

Exit `0` = `REVIEW_BUNDLE_READY`, `1` = `REVIEW_BUNDLE_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization — stated explicitly in the bundle itself.
