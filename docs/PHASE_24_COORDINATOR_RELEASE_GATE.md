# Phase 24 - Coordinator Release Gate

This is the repeatable coordinator process for future phase handoffs, PR decisions, merges, tags, and
post-merge verification. It is documentation plus static guardrails only. It adds no runtime behavior,
app code, scheduler daemon, GitHub automation, CI workflow, provider/debrid/Plex/Jellyfin behavior,
scraping, downloading, playback, HTTP service, UI, real KMS/cloud SDK, live external custodian, or
network dependency.

Use this with `docs/PHASE_22_PRODUCTION_READINESS_GATE.md`,
`docs/PHASE_23_OPERATOR_EVIDENCE_PACKAGING.md`, and `docs/RELEASE_CHECKLIST.md`.

## Hard Scope Boundary Checklist

Every future phase starts with this checklist. HOLD if any item is false.

- The requested phase has an explicit branch/base commit and target branch.
- Builder works from an isolated worktree or branch, never directly on `master`.
- The task does not change product readiness status unless Clint explicitly authorized that phase.
- O4 remains open/deferred unless separate operator evidence proves or formally accepts a real
  external/managed custodian.
- O5 remains open/deferred unless separate operator evidence proves or formally accepts managed age
  KEK custody plus rotation automation/scheduling.
- `FileCustodian` remains a hardened reference harness, not production KMS.
- CI stays deterministic and does not require Docker, network, live Jellyfin, live external custodian,
  cloud services, age tooling, a production database, or operator credentials.
- No runtime behavior is added unless the phase explicitly asks for product implementation.
- No provider/debrid/Plex/Jellyfin expansion, scraping/downloading/playback, HTTP service, UI, real
  KMS/cloud SDK, live external custodian, or scheduler daemon is introduced by coordinator guidance.

## Builder Intake Requirements

Before PR-GO, the Builder report must include all of the following. HOLD until complete.

- Branch name and exact base commit.
- Exact commit hash or hashes produced by the Builder.
- Files changed.
- Tests run with exact command names and outcomes.
- A short summary of what changed and why.
- Explicit statement that no runtime behavior was added when the phase is docs/test only.
- Explicit statement that O4/O5 remain open/deferred when readiness gates are in scope.
- Residual risks and reviewer focus areas.
- Any skipped verification with the concrete reason.

## Pre-Push / PR-GO Checks

Run these before telling Builder to push or before opening review. Replace `<branch>` and `<base>` with
the actual values from the intake.

```powershell
git status --short --branch
git rev-parse HEAD
git rev-parse <base>
git merge-base --is-ancestor <base> HEAD
git diff --check <base>...HEAD
git diff --stat <base>...HEAD
npm run test:deploy
npm run typecheck
```

PR-GO requires:

- Worktree is clean except intended branch changes.
- HEAD descends from the named base.
- `git diff --check` passes.
- Targeted deterministic tests pass.
- Docs and tests match the phase scope.
- No forbidden scope expansion appears in the diff.
- Builder supplied all intake requirements.

## Reviewer-Required Conditions

Request an independent Reviewer before merge when any condition applies:

- The phase touches release gates, production-readiness language, privacy/redaction rules, backup or
  restore guidance, custodian/KEK wording, operator evidence, or CI expectations.
- The diff modifies shared tests that enforce scope boundaries.
- The diff mentions O4, O5, `FileCustodian`, production readiness, external custodian, KMS, live
  services, or operator credentials.
- The phase creates a new cross-phase runbook or checklist.
- Builder skipped `npm run ci` or any expected gate.

Reviewer prompt must include the base commit, branch, commit hashes, files changed, tests run, skipped
tests, and specific security/scope risks to examine.

## Pre-Merge GO Checks

Run these after review is clean and before merging to `master`.

```powershell
git fetch origin
git status --short --branch
git rev-parse master
git rev-parse origin/master
git merge-base --is-ancestor origin/master HEAD
git diff --check origin/master...HEAD
npm run test:deploy
npm run typecheck
npm run ci
```

Pre-merge GO requires:

- Reviewer findings are either resolved or explicitly accepted by Clint.
- `master` and `origin/master` are at the expected checkpoint or the mismatch is explained and accepted.
- `npm run ci` passes, or Coordinator records why it is not feasible and what targeted coverage ran.
- No HOLD condition is present.
- Clint has approved any readiness wording that could be interpreted as closing an operator gate.

## Post-Merge / Tag / Push Verification

Run these after merge, tag, and push. Replace `<phase-tag>` with the release tag for the phase.

```powershell
git checkout master
git pull --ff-only origin master
git status --short --branch
git rev-parse HEAD
git tag --points-at HEAD
git rev-parse <phase-tag>
git rev-parse origin/master
git ls-remote --tags origin <phase-tag>
npm run test:deploy
```

Post-merge GO requires:

- `master`, `origin/master`, and the phase tag point to the same expected commit.
- The working tree is clean.
- The pushed tag exists on origin.
- The lightweight post-merge static check passes.
- Coordinator records the final commit, tag, tests, and any deferred gates.

## HOLD Conditions

Stop and report the blocker instead of merging, tagging, or pushing when any of these occur:

- Worktree is unexpectedly dirty or contains unrelated changes.
- Local `master`, `origin/master`, tag, or base commit does not match the expected checkpoint.
- Builder worked directly on `master`.
- Required Builder intake data is missing.
- Any required deterministic check fails.
- The diff adds runtime behavior in a docs/test phase.
- The diff adds live-service CI requirements, network dependencies, Docker requirements, cloud SDKs,
  operator credentials, production DB requirements, age tooling requirements, or live Jellyfin/external
  custodian requirements.
- The diff closes, hides, or softens O4/O5 without separate operator evidence or Clint acceptance.
- The diff describes `FileCustodian` as production KMS instead of a hardened reference harness.
- Reviewer reports a P0/security/correctness issue.

## Ask-Clint Conditions

Ask Clint before proceeding when any of these occur:

- A phase changes product readiness wording, closes or accepts O4/O5, or changes operator evidence
  requirements.
- A required gate cannot run and the replacement coverage is not obvious.
- The target branch, base commit, tag name, or remote state differs from the handoff.
- Reviewer findings are valid but the fix would broaden scope or change phase intent.
- A requested change touches provider/debrid/Plex/Jellyfin behavior, scraping, downloading, playback,
  HTTP/UI, scheduler automation, real KMS/cloud SDKs, or live external custodian integration.
- The safest next phase is ambiguous.

## Release Note Template

Use this short release-gate note in coordinator handoffs:

```text
Branch:
Base:
Commit(s):
Files changed:
Tests:
Reviewer:
Scope statement:
O4/O5:
FileCustodian:
Residual risks:
Next action:
```

The `Scope statement` must say whether runtime behavior was added. For docs/test-only phases it must
state: no runtime behavior was added. The `O4/O5` line must state that O4/O5 remain open/deferred unless
the phase explicitly and separately proves or accepts them.
