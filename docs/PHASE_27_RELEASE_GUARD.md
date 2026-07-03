# Phase 27 - Coordinator Release Guard Automation

Phase 27 adds `ops:release-guard`, a deterministic local helper for the coordinator release process in
`docs/PHASE_24_COORDINATOR_RELEASE_GATE.md`.

The command is advisory support only. It never approves a handoff, opens a PR, merges, tags, pushes,
deletes branches, edits remotes, reads secrets, reads evidence artifacts, connects to a database,
runs Docker, calls live services, runs age tooling, or closes readiness gates. Coordinator, Reviewer,
and Clint still make GO/HOLD decisions.

## Command

```powershell
npm run ops:release-guard -- -- --base <ref> [--head <ref>] [--tag <tag>] [--phase <n>] [--mode pre-pr|pre-merge|post-merge] [--json]
```

Arguments:

- `--base <ref>` is required.
- `--head <ref>` defaults to `HEAD`.
- `--tag <tag>` checks whether the expected phase tag is absent before merge/tag cleanup and present
  after merge/tag cleanup.
- `--phase <n>` labels the report only.
- `--mode pre-pr|pre-merge|post-merge` defaults to `pre-pr`.
- `--json` emits the same report as JSON.

Unsupported arguments fail closed with usage text.

## Checks

The report prints `pass`, `warn`, or `fail` checks for:

- clean worktree,
- base ancestor of head,
- `git diff --check <base>...<head>`,
- expected tag absent/present depending on mode,
- `master` / `origin/master` alignment for merge-sensitive modes,
- reviewer-required triggers from changed file names and bounded diff text,
- the forbidden mutation boundary reminder.

Warnings are not approval. They are coordinator prompts. Failures return a non-zero exit code because a
local guard check failed or the command was used incorrectly.

## Boundaries

The implementation invokes only read-only local Git inspection through `child_process`. It rejects
mutating Git subcommands in its runner guard. It does not import DB, network, Docker, provider,
debrid, Plex, Jellyfin, cloud, KMS, custodian, or age tooling.

Diff-check output is bounded and redacted before printing. The command does not print environment
values.

O4 remains open/deferred unless separate real external-custodian evidence proves or formally accepts
it. O5 remains open/deferred unless managed KEK custody plus rotation scheduling evidence proves or
formally accepts it. `FileCustodian` remains a hardened reference harness, not production KMS.
