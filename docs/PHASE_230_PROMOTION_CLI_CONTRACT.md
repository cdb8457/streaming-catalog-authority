# Phase 230: CLI Contract Snapshot Guard (local, non-live)

Report id: `phase-230-promotion-cli-contract`

Status: `PHASE_230_PROMOTION_CLI_CONTRACT_READY`

Every Phase 230 local reporting CLI prints a single redaction-safe JSON capture to stdout. This guard
verifies a captured stdout object against that universal contract and derives a stable top-level key
signature so any drift is visible. It reads parsed JSON only; it performs no promotion, never touches
`/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live (`authorization` is the
constant `NONE`).

## The contract

A compliant capture must have: a `report` id ending in `-capture`; `redactionSafe: true`; at least one
sha256 `*Digest` key; and NO path-like value anywhere (leading `/`, a drive prefix, `/mnt/`, the test
library marker, or a media extension). `verifyCliContract` returns `ok`, the `keySignature` (sorted
top-level keys, excluding the optional `outputWritten`), and generic `problems`
(`REPORT_ID_INVALID`, `REDACTION_FLAG_MISSING`, `DIGEST_MISSING`, `RAW_PATH_LEAK`, `NOT_AN_OBJECT`).
`buildCliContractReport` aggregates many captures: `overall` is `CONTRACT_VIOLATION` if any capture
fails, `NO_CAPTURES` for empty input, else `CONTRACT_OK`.

## Files

- `src/ops/promotion-cli-contract.ts` — `verifyCliContract(capture)`, `buildCliContractReport(captures)`.
- `src/ops/promotion-cli-contract-cli.ts` — CLI wrapper (repeatable `--capture`).
- `test/promotion-cli-contract.ts` — 5 tests: static coverage that every reporting CLI emits the
  redaction flag, per-violation unit checks, a live signature match for two CLIs, empty input, and a
  spawned CLI run.

## Usage

```
npm run ops:promotion-cli-contract -- --capture a.json --capture b.json [--out report.json]
```

Exit `0` = `CONTRACT_OK`, `1` = `CONTRACT_VIOLATION` / `NO_CAPTURES`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
