# Phase 230: Review-Transcript Verifier v2 (local, non-live)

Report id: `phase-230-promotion-transcript-verification`

Status: `PHASE_230_PROMOTION_TRANSCRIPT_VERIFIER_READY`

Binds a review transcript to the **exact** expected test commands and their exit semantics, confirms the
reviewed commit equals the supplied head, and records the fixed full-`npm test` caveat. It reads parsed
JSON only; it performs no promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and
authorizes nothing live (`authorization` is the constant `NONE`).

## What it verifies (fail closed)

- The transcript is present, valid, and `REVIEW_CLEAN` (`TRANSCRIPT_MISSING/INVALID/NOT_CLEAN`).
- The transcript's `reviewedCommit` (40-hex) equals the supplied `head` (`HEAD_MISMATCH`).
- The expected commands are well-formed and non-empty (`EXPECTED_COMMANDS_MISSING`); every expected command
  appears in the transcript's test results (`COMMAND_MISSING`) and reported a clean exit — `exitOk` is true
  iff its `failed` count is 0 (`TEST_EXIT_NONZERO`).

`overall` is `TRANSCRIPT_VERIFIED` iff no blocker fires, else `TRANSCRIPT_UNVERIFIED`. The report records
the bound `head`, per-command `{ command, passed, failed, exitOk }`, the `fullNpmTestCaveat`, and a
`verificationDigest`. Command labels are path-free by construction; no digest/path/title leaks.

## Files

- `src/ops/promotion-transcript-verifier.ts` — `buildTranscriptVerification(input)`, `FULL_NPM_TEST_CAVEAT`.
- `src/ops/promotion-transcript-verifier-cli.ts` — CLI wrapper (repeatable `--command`).
- `test/promotion-transcript-verifier.ts` — 5 tests: verified, a head mismatch, a missing command / non-zero
  exit, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-transcript-verifier -- --transcript f --head <sha> --command "npm run test:phase230-local" [--command ...] [--out verification.json]
```

Exit `0` = `TRANSCRIPT_VERIFIED`, `1` = `TRANSCRIPT_UNVERIFIED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
