# Phase 230: AP-AZ Report Schema Strictness (local, non-live)

Report id: `phase-230-promotion-report-schema`

Status: `PHASE_230_PROMOTION_REPORT_SCHEMA_READY`

A strictness pass over the ten AP-AZ report types — provenance diff, gate coverage, artifact chain bundle,
redaction corpus, boundary policy, review automation, merge-review evidence pack, acceptance preflight,
failure-mode matrix, and CLI ergonomics. Each is validated against a **strict** schema: the exact top-level
key set (**no missing keys, no unknown keys**), the fixed literals (`version: 1`, `redactionSafe: true`,
`authorization: 'NONE'`), the `overall` enum, and a well-formed sha256 self-digest — catching
malformed-but-plausible reports the green checks alone would accept.

For a report that is otherwise shape-valid, the stated self-digest is **re-verified** by recomputing it
under the report's correct scope/field (delegated to the self-digest verifier). A wrong-but-well-formed
digest — a valid sha256 that is not the report's actual self-digest — therefore fails closed with
`REPORT_DIGEST_MISMATCH` rather than passing the format check. It reads parsed JSON only; it performs no
promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live.

`overall` is `REPORT_SCHEMA_OK` only when every supplied report is valid; otherwise
`REPORT_SCHEMA_VIOLATION` with generic problems (`REPORT_UNRECOGNIZED`, `REPORT_SHAPE_INVALID`,
`UNKNOWN_KEY`, `REPORT_STATUS_INVALID`, `REPORT_DIGEST_INVALID`, `REPORT_DIGEST_MISMATCH`), or `NO_REPORTS`
for empty input. Output carries only report ids, booleans, and problem codes plus a `reportSchemaDigest`.

## Files

- `src/ops/promotion-report-schema.ts` — `buildReportSchema(reports)`, `REPORT_SCHEMA_IDS`.
- `src/ops/promotion-report-schema-cli.ts` — CLI wrapper (repeatable `--report`).
- `test/promotion-report-schema.ts` — 6 tests: all ten live report types validate, each violation class
  (unknown/missing key, bad status/digest-format, unknown report), a wrong-but-well-formed digest across
  every type (`REPORT_DIGEST_MISMATCH`, with genuine reports still passing), fixed-literal drift, empty
  input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-report-schema -- --report a.json --report b.json [--out schema.json]
```

Exit `0` = `REPORT_SCHEMA_OK`, `1` = `REPORT_SCHEMA_VIOLATION` / `NO_REPORTS`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
