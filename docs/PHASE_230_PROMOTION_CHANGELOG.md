# Phase 230: Release-Note / Changelog Generator (local, non-live)

Report id: `phase-230-promotion-changelog`

Status: `PHASE_230_PROMOTION_CHANGELOG_READY`

From a caller-provided commit list (`sha` + `subject`), produces a redaction-safe changelog with a
no-live / no-Phase-231 footer and the remaining human gates. It is **deterministic** (a pure function of
its input) and does **no** git/process I/O itself — the operator supplies the commit range (e.g. via
`git log --format=...`). It performs no promotion, never touches `/mnt/user/media/Movies`, never contacts
Jellyfin, and authorizes nothing live.

## Contents

- `entries`: `{ sha, subject }` per commit; each `sha` is validated `[0-9a-f]{7,64}` and each `subject`
  is leak-scanned.
- `ok`: true only when there is at least one commit and no problem (`COMMIT_SHA_INVALID`,
  `COMMIT_SUBJECT_MISSING`, `RAW_PATH_IN_CHANGELOG`).
- `humanGates` / `disclaimers`: fixed language (including "does NOT authorize Phase 231") in every
  changelog. `authorization` is the constant `NONE`.
- `changelogDigest`: `sha256("phase-230-changelog:" + body)`; recomputes deterministically.

## Files

- `src/ops/promotion-changelog.ts` — `buildChangelog(input)` + fixed constants.
- `src/ops/promotion-changelog-cli.ts` — CLI wrapper (reads `--input` JSON).
- `test/promotion-changelog.ts` — 5 tests: full changelog, raw-path subject rejected, invalid-sha /
  empty range, redaction-safe + deterministic digest, and a spawned CLI run.

## Usage

```
git log --format='{"sha":"%H","subject":"%s"}' <range>   # operator produces the commit list
npm run ops:promotion-changelog -- --input commits.json [--out changelog.json]
```

Exit `0` = ok, `1` = a problem (e.g. a raw path in a subject).

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
