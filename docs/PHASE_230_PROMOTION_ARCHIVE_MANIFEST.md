# Phase 230: Evidence Archive Manifest (local, non-live)

Report id: `phase-230-promotion-evidence-archive-manifest`

Status: `PHASE_230_PROMOTION_ARCHIVE_MANIFEST_READY`

Consumes the four top-level offline records — the **provenance ledger**, the **gate DAG**, the
**coordinator evidence packet**, and the **review transcript** — and produces a redaction-safe archive
manifest that is `ARCHIVE_READY` **only when all four are present, valid, and green**. It reads parsed
JSON only; it performs no promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin,
and authorizes nothing live (`authorization` is the constant `NONE`).

## Green criteria

| Component | Green when |
|-----------|-----------|
| `ledger` | `phase-230-promotion-provenance-ledger` and `complete === true` |
| `dag` | `phase-230-promotion-gate-dag` and `ok === true` (acyclic) |
| `evidence` | `phase-230-promotion-coordinator-evidence-packet` and `overall === EVIDENCE_COMPLETE` |
| `transcript` | `phase-230-promotion-review-transcript` and `verdict === REVIEW_CLEAN` |

`overall` is `ARCHIVE_READY` iff every component is present and green; otherwise `ARCHIVE_BLOCKED` with
generic blockers (`*_MISSING`, `*_INVALID`, `LEDGER_INCOMPLETE`, `DAG_NOT_ACYCLIC`, `EVIDENCE_NOT_COMPLETE`,
`TRANSCRIPT_NOT_CLEAN`). Each component carries only its name, presence, ok, and digest; the manifest is
sealed with an `archiveDigest`.

## Files

- `src/ops/promotion-archive-manifest.ts` — `buildArchiveManifest(input)`.
- `src/ops/promotion-archive-manifest-cli.ts` — CLI wrapper.
- `test/promotion-archive-manifest.ts` — 6 tests: all-green READY, missing component, incomplete ledger,
  not-clean transcript, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-archive-manifest -- --ledger f --dag f --evidence f --transcript f [--out archive.json]
```

Exit `0` = `ARCHIVE_READY`, `1` = `ARCHIVE_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
