# Phase 230: All-Artifacts Self-Digest Verifier (local, non-live)

Report id: `phase-230-promotion-self-digest-verification`

Status: `PHASE_230_PROMOTION_SELF_DIGEST_VERIFIER_READY`

For any known Phase 230 report, recomputes the self-digest from the report body — every key except the
trailing digest field — under that report's fixed hashing scope, and confirms it equals the stated digest.
It reads parsed JSON only; it performs no promotion, never touches `/mnt/user/media/Movies`, never contacts
Jellyfin, and authorizes nothing live (`authorization` is the constant `NONE`).

## What it checks

A built-in registry maps every Phase 230 report id (approval attestation, evidence review, readiness,
acceptance packet, rehearsal manifest/matrix, artifact integrity/schema, dashboard, handoff, fixture
bundle, bundle replay, evidence packet, bundle diff, tamper corpus, review transcript, provenance ledger,
gate DAG, changelog, archive manifest, acceptance meta, injection corpus, review bundle, and consistency
matrix) to its trailing digest field and hashing scope. Each supplied report is `recognized` + `verified`,
or flagged. `overall` is `DIGEST_MISMATCH` if any recognized report fails, else `UNRECOGNIZED_REPORT` if
any report id is unknown, else `NO_REPORTS` for empty input, else `ALL_VERIFIED`. Output carries only
report ids and booleans (no raw digests/paths/titles) plus a `verifierDigest`.

## Files

- `src/ops/promotion-self-digest-verifier.ts` — `verifySelfDigests(reports)`, `KNOWN_REPORT_IDS`.
- `src/ops/promotion-self-digest-verifier-cli.ts` — CLI wrapper (repeatable `--report`).
- `test/promotion-self-digest-verifier.ts` — 5 tests: all-verified over a 10-report set, a tampered body,
  an unrecognized id, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-self-digest-verifier -- --report a.json --report b.json [--out verification.json]
```

Exit `0` = `ALL_VERIFIED`, `1` = otherwise.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
