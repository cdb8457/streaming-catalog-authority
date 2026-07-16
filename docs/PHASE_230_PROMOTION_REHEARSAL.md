# Phase 230: Offline Promotion Rehearsal Bundle / Manifest (local, non-live)

Report id: `phase-230-promotion-rehearsal-manifest`

Status: `PHASE_230_PROMOTION_REHEARSAL_READY`

An end-to-end **rehearsal** of the whole Phase 230 promotion pipeline, run entirely on fixtures in an
ephemeral sandbox, that proves the mechanics work before any real promotion is ever considered. It runs
the real modules in order and emits a redaction-safe **manifest** digesting each stage:

```
approval attestation → guarded promotion (promote AND withdraw) → evidence review → readiness checklist → acceptance seal
```

Promotion visibility is checked by a **local file-state observer** (visible while the promoted file
exists on disk, absent after withdrawal) — **never** Jellyfin. The sandbox has its own
`catalog-authority-test-library` and `Movies` directory under a work dir (default: the OS temp dir);
it is **never** the real `/mnt/user/media/Movies`, and the rehearsal refuses a work dir that would
intersect the real Movies root. The promotion both promotes and withdraws, so the sandbox Movies tree
returns to empty; by default the sandbox is deleted at the end (ephemeral).

It never runs the deploy launcher, never writes to the real Movies root, never contacts Jellyfin, and
authorizes nothing live: a passing rehearsal is a fixture proof of the mechanics, not a live gate, and
does not authorize Phase 231.

## Manifest

`runPromotionRehearsal` returns the raw stage artifacts (in memory) and a manifest:

- `outcome`: `REHEARSAL_PASS` iff all five stages are `ok`; otherwise `REHEARSAL_FAIL`.
- `stages[]`: one entry per stage with `{ stage, ok, status, digest }`, where `status` is that stage's
  own enum (`APPROVAL_ATTESTATION_READY`, `REAL_LIBRARY_PROMOTION_WITHDRAWN`,
  `PROMOTION_EVIDENCE_ACCEPTED`, `READY`, `ACCEPTED_SEALED`) and `digest` is that artifact's own digest.
- `runDigest` / `itemDigest`: digests of the run and item ids.
- `targetRoot`: always the literal `sandbox`.
- `forbidden`: the boundary list (`live-jellyfin`, `real-movies-write`, `deploy-launcher`,
  `phase-231-authorization`, `provider`, `download`, `playback`).
- `manifestDigest`: `sha256("phase-230-rehearsal-manifest:" + body)`.

The manifest carries only digests, enums, and booleans — no raw title, source path, or destination
path — and a self-scan sets `RAW_PATH_IN_MANIFEST` + `REHEARSAL_FAIL` if any path-shaped string is ever
found. The raw stage artifacts contain sandbox paths and are **not** redaction-safe; the CLI only
writes them when `--artifacts-dir` is given (mode 0600), and treats them as operator-local.

## Files

- `src/ops/promotion-rehearsal.ts` — `runPromotionRehearsal(input)`.
- `src/ops/promotion-rehearsal-cli.ts` — CLI wrapper.
- `test/promotion-rehearsal.ts` — 6 tests: full pass, ephemeral cleanup, keep-sandbox clean tree, redaction-safety, real-Movies work-dir refusal, and a spawned CLI end-to-end run.

## Usage

```
npm run ops:promotion-rehearsal -- \
  [--work-dir <dir>] [--title <t>] [--year <y>] [--item-id <id>] [--acceptor-id <id>] \
  [--run-id <id>] [--keep-sandbox] [--out manifest.json] [--artifacts-dir <dir>]
```

Exit `0` = `REHEARSAL_PASS`, `1` = `REHEARSAL_FAIL`. The CLI reports `manifestWritten` / `artifactsWritten`
booleans and never echoes the raw `--out` / `--artifacts-dir` paths to stdout.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master
change, and no Phase 231 or live-promotion authorization is implied by this rehearsal.
