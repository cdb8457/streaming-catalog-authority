# Phase 230: Offline Bundle Replay Verifier (local, non-live)

Report id: `phase-230-promotion-bundle-replay`

Status: `PHASE_230_PROMOTION_BUNDLE_REPLAY_READY`

Consumes a fixture evidence bundle and **replays** its derivations offline: it re-derives the integrity,
schema, handoff, and dashboard reports from the bundle's own artifacts and checks they match the stored
digests; it re-verifies the self-seals of the matrix and rehearsal manifest; and it checks the rehearsal
manifest's stage digests match the artifact self-digests. It **fails closed** on any missing, tampered,
wrong-report, or mismatch. It reads parsed JSON only; it performs no promotion, never touches
`/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live.

## What it checks

| Check | Fails with |
|-------|-----------|
| bundle report id / version | `BUNDLE_REPORT_INVALID` |
| bundle self-seal (recompute `bundleDigest` over the body) | `BUNDLE_SELF_DIGEST_MISMATCH` |
| each artifact present | `APPROVAL_EVIDENCE_MISSING`, `PROMOTION_EVIDENCE_MISSING`, … |
| stored report ids | `INTEGRITY_REPORT_WRONG`, `SCHEMA_REPORT_WRONG`, `MATRIX_REPORT_WRONG`, `HANDOFF_REPORT_WRONG`, `DASHBOARD_REPORT_WRONG` |
| integrity re-derived from artifacts matches stored | `INTEGRITY_REPLAY_MISMATCH` |
| schema re-derived from artifacts matches stored | `SCHEMA_REPLAY_MISMATCH` |
| handoff re-derived (from acceptance + matrix + re-derived integrity) matches stored | `HANDOFF_REPLAY_MISMATCH` |
| dashboard re-derived matches stored | `DASHBOARD_REPLAY_MISMATCH` |
| matrix self-seal recomputes | `MATRIX_SELF_DIGEST_MISMATCH` |
| rehearsal manifest self-seal recomputes | `MANIFEST_SELF_DIGEST_MISMATCH` |
| manifest stage digests match artifact self-digests | `MANIFEST_STAGE_MISMATCH` |

`ok` is true only when every check passes; the report carries a `replayDigest`.

## Files

- `src/ops/promotion-bundle-replay.ts` — `replayFixtureBundle(candidate)`.
- `src/ops/promotion-bundle-replay-cli.ts` — CLI wrapper.
- `test/promotion-bundle-replay.ts` — 11 tests: clean bundle, tampered bundle self-seal (digest and a
  top-level field), non-bundle input, missing artifact, tampered integrity/dashboard digest, wrong
  report, tampered matrix self-seal, manifest stage mismatch, and a spawned CLI clean/tamper run.

## Usage

```
npm run ops:promotion-bundle-replay -- --bundle bundle.json [--out replay.json]
```

Exit `0` = ok, `1` = replay problem(s).

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
