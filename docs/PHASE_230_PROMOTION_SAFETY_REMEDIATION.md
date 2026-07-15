# Phase 230: Promotion Safety Remediation

Report id: `phase-230-promotion-safety-remediation`

Status: `PHASE_230_PROMOTION_SAFETY_REMEDIATED`

Phase type: safety remediation of the guarded real-library promotion service implemented in commit
`015b3ef`. No runtime, Docker Compose, custody-mode, provider, downloader, scraper, playback, Gelato,
AIO Streams, or Jellyfin-write behavior is added or changed. The only changes are to
`src/ops/real-library-promotion.ts` and its test suite `test/real-library-promotion.ts`.

## Why this pass exists

The Phase 229 boundary requires that rollback/withdrawal **never delete a pre-existing real-library
file** and that promotion **refuse symlink escapes**. An audit of the Phase 230 implementation found
the withdrawal path violated the first rule and the symlink rule was unimplemented.

## Findings and fixes

| # | Finding | Severity | Fix | Proof |
|---|---------|----------|-----|-------|
| 1 | **Withdrawal deletes a pre-existing real-library file.** When the destination already existed with a matching checksum (`alreadyPresent`), `--withdraw-after` still ran `withdrawPromotedFile`, which `rmSync`'d the file the run did **not** create. The run then reported `PROMOTION_WITHDRAWAL_FAILED` — *after* the real file was already gone. The live launcher (`deploy/unraid-real-library-promotion.sh`) always passes `--withdraw-after`, so re-promoting an already-present item destroyed the real file. | Data loss | The run now tracks `createdByRun`; withdrawal is only attempted for a file this run actually copied. A withdrawal request against a pre-existing file fails closed with `PROMOTION_WITHDRAWAL_REFUSED` and deletes nothing. | Test: *refuses to withdraw a pre-existing real-library file (no data loss)* — asserts the file survives and the refusal code is present. |
| 2 | **Directory cleanup could remove a pre-existing real-library directory.** Withdrawal removed the destination's parent directory whenever it was empty, regardless of whether the promotion created it. | Data loss | The run tracks `createdDirectory` (whether the movie directory existed before the run). Cleanup only removes a directory this run created, never the target root itself, and never a symlinked directory. | Test: *withdrawal keeps a pre-existing destination directory and its unrelated files* — promotes into a shared directory containing an unrelated sibling and asserts both survive withdrawal. |
| 3 | **Symlink escapes were not refused** (explicitly required by Phase 229). `isWithin` uses `resolve()`, which does not resolve symlinks, so a symlinked source, a symlinked ancestor of the source, or a symlinked destination component could redirect reads/writes outside the approved roots while passing the textual containment check. | Boundary escape | Added `isSymlink` and `hasSymlinkComponent`. The source is refused if it is a symlink or has a symlinked ancestor inside the test library (`PROMOTION_SOURCE_INVALID`); the destination is refused if any existing component escapes the Movies root via symlink (`PROMOTION_TARGET_FORBIDDEN`); withdrawal refuses a symlinked promoted path. | Test: *refuses a symlinked destination directory that escapes the approved root* — asserts refusal and that nothing was written through the symlink. |

## Invariants restored

- Withdrawal only ever removes a file and (optionally) a directory that **this promotion run created**.
- A pre-existing real-library file or directory is never modified or deleted by a promotion run.
- No promotion read or write follows a symlink out of the isolated test library or the approved
  `/mnt/user/media/Movies` root.

## Verification

- `tsc -p tsconfig.json --noEmit` — clean.
- `test/real-library-promotion.ts` — **8 passed, 0 failed** (5 prior + 3 new regression tests).

Pre-existing doc-string assertion failures in `test/real-library-promotion-boundary.ts` and
`test/deploy.ts` are unrelated to this remediation (they fail identically at commit `015b3ef`) and are
out of scope.

## Second-pass remediation (follow-up review)

A follow-up review of the first-pass commit raised further items. The first-pass fixes
(pre-existing-file withdrawal refusal and directory-ownership scoping) are preserved unchanged.
Addressed here:

| Item | Finding | Fix | Proof |
|------|---------|-----|-------|
| 4 | **Visibility/absence could be satisfied by the wrong item.** The CLI visibility client matched by loose path suffix and by title / title-year. The isolated test-library twin (same title, also `VISIBLE_IN_JELLYFIN`) could satisfy "visible in the real library" (false positive) and mask absence after withdrawal (false negative), since visibility and absence must query the *exact* promoted path. | Added the pure, exported `realLibraryPathMatch`, which compares the normalized **exact** destination path only. The CLI client drops the title/title-year fallbacks and matches path-exact; a non-match fails closed (visibility timeout). | Test: *exact-path matcher rejects the same-title test-library twin and other items*. |
| 5 | **Symlink containment / TOCTOU gaps.** `hasSymlinkComponent` never flagged a symlinked *root*; containment used only textual `resolve()`; `treeDigest` used `statSync` (follows symlinks). | `hasSymlinkComponent` now rejects a symlinked root. Added `resolvesWithin` (realpath of the approved root vs. the deepest existing ancestor), re-checked immediately before/after each mutation — source, post-mkdir directory, post-materialization file, and withdrawal. `treeDigest` now uses `lstatSync` and records symlinks as `l:` without ever following them. Residual TOCTOU is bounded by realpath-immediately-before-use (Node exposes no portable `openat`/`O_NOFOLLOW`). | Test: *refuses a symlinked target root that escapes to an outside directory* (plus the existing symlinked-destination test). |
| 6 | **Visibility exceptions escaped as raw errors.** `awaitVisible`/`awaitAbsent` threw (client-required, HTTP, or network errors), rejecting the run's promise and printing raw text — not redaction-safe, no digested evidence. | Both visibility calls are wrapped; any exception becomes a bounded, generic `PROMOTION_VISIBILITY_CHECK_FAILED` transition with a fixed value-free message — no URL, path, or raw error text enters evidence. | Test: *visibility client exception yields a redaction-safe digested failure* — asserts the failure code and that the endpoint/secret never appear in the serialized report. |

Items (1)–(3) of the follow-up review were truncated from the received message and are **not** addressed
here; they remain outstanding pending the reviewer re-sharing them. No Phase 231 authorization is implied.

The Phase 224–227 local-media test-library import path (`local-media-pipeline-cli.ts`) still uses the
loose matcher; it is deliberately out of scope for this real-library promotion remediation.

Second-pass verification: `tsc --noEmit` clean; `test/real-library-promotion.ts` **11 passed, 0 failed**;
promotion boundary and deploy guard unchanged from baseline (only the pre-existing CRLF doc-assertion
failures remain).

## Exit status

Phase 230 promotion service safety invariants are restored and covered by regression tests. The single
operator-approved live promotion remains gated exactly as defined in Phase 229. Follow-up review items
(1)–(3) remain open pending their (truncated) text.
