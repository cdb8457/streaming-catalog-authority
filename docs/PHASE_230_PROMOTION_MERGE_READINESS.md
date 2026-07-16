# Phase 230: Merge-Readiness Dry-Run Manifest (local, non-live)

Report id: `phase-230-promotion-merge-readiness-dry-run`

Status: `PHASE_230_PROMOTION_MERGE_READINESS_READY`

Given the coordinator evidence **release checklist**, a **dry-run context** (branch / base / head /
commits-since-base / required tests), and optionally the **final summary**, reports whether the branch's
local evidence preconditions for a merge are met — **without performing, staging, or authorizing any merge,
tag, or push to master**. It reads parsed JSON only; it **invokes no git**, performs no promotion, never
touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live (`authorization` is
the constant `NONE`).

`dryRun` is always `true`, `gitInvoked` is always `false`, and `mergeActionsPerformed` is always empty — the
manifest is advisory evidence, never an action.

## What it records

- `branch`, `base`, `head` — from the supplied context (`base`/`head` are 40-hex; the branch name is
  re-validated path-free). No git is run; these are read from the context, not the repository.
- `commitsSinceBase` — the validated `{ sha, subject }` list (subjects re-validated path-free).
- `requiredTests` — the validated command labels that must pass before a merge.
- `fullNpmTestCaveat` — the fixed caveat that the full `npm test` aggregate (legacy/live/CRLF/DB suites) is
  NOT run by the local gate and is out of scope for this dry run.
- `openBlockers` — the union of the release checklist's own blockers and this manifest's blockers.
- The no-action proof: `dryRun: true`, `gitInvoked: false`, `mergeActionsPerformed: []`.

## Readiness criteria

`MERGE_DRY_RUN_READY` requires the release checklist to be present, valid, and `RELEASE_CHECKLIST_CLEARED`;
the context to be present and well-formed; and any supplied final summary to be `FINAL_SUMMARY_READY` **and
bound to the checklist** (its `summaryDigest` must equal the checklist's `boundDigests['final-summary']`).
Otherwise the manifest is `MERGE_DRY_RUN_BLOCKED` with generic blockers
(`RELEASE_CHECKLIST_MISSING/INVALID/NOT_CLEARED`, `MERGE_CONTEXT_MISSING/INVALID`,
`FINAL_SUMMARY_INVALID/NOT_READY`, `FINAL_SUMMARY_BINDING_MISMATCH`). Either way the manifest restates the
remaining human gates — chief among them that **the merge/tag/push itself is a human operator step performed
outside this tooling and is not authorized here** — and the fixed dry-run / non-live disclaimers, and is
sealed with a `manifestDigest`.

## Files

- `src/ops/promotion-merge-readiness.ts` — `buildMergeReadiness(input)`, `MERGE_READINESS_HUMAN_GATES`,
  `MERGE_READINESS_DISCLAIMERS`, `FULL_NPM_TEST_CAVEAT`.
- `src/ops/promotion-merge-readiness-cli.ts` — CLI wrapper.
- `test/promotion-merge-readiness.ts` — 6 tests: ready + performs-no-merge (records branch/base/head/
  commits/tests/caveat), an unbound final summary, a not-cleared checklist (open blockers surfaced), a
  missing/malformed context, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-merge-readiness -- --releasechecklist f --context f [--finalsummary f] [--out manifest.json]
```

Exit `0` = `MERGE_DRY_RUN_READY`, `1` = `MERGE_DRY_RUN_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master
performed or authorized, and no Phase 231 or live-promotion authorization. This tool never contacts
Jellyfin and does not authorize Phase 231.
