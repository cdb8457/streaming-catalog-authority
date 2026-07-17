# Phase 230: Acceptance Preflight (local, non-live)

Report id: `phase-230-promotion-acceptance-preflight`

Status: `PHASE_230_PROMOTION_ACCEPTANCE_PREFLIGHT_READY`

A **deterministic** ready/not-ready report for coordinator review. It consumes the merge-review evidence
pack (AW) plus the branch/base/head/test context and states **exactly which machine gates passed and which
human gates remain**. It approves nothing, merges nothing, and live-promotes nothing — `approvalsGranted`
is always empty and `authorization` is the constant `NONE`. It reads parsed JSON only; it invokes no git,
performs no promotion, never touches `/mnt/user/media/Movies`, and never contacts Jellyfin. It echoes only
hex shas, counts, and fixed-language strings.

## Machine gates

The reviewer pack must be present, valid, `REVIEWER_PACK_READY`, and its **self-digest must recompute**
(delegated to the self-digest verifier — a forged pack with a made-up or missing digest fails with
`REVIEWER_PACK_DIGEST_MISMATCH`). It must carry the **exact** expected component set (each present + ok,
no unknown — `PACK_COMPONENT_INCOMPLETE` / `PACK_COMPONENT_UNKNOWN`) and the **exact** expected binding
mesh (no missing/failing/unknown — `PACK_BINDING_MISSING` / `PACK_BINDING_FAILED` / `PACK_BINDING_UNKNOWN`);
each is surfaced as an individual `machineGates` entry. The context must be well-formed — path-free branch,
40-hex base/head, validated commits and required tests (`PREFLIGHT_CONTEXT_MISSING/INVALID`) — **and bind to
the pack's authoritative provenance**: the branch/base/head/required-tests must match the values carried
from the packed merge-readiness manifest (`CONTEXT_BRANCH_MISMATCH`, `CONTEXT_BASE_MISMATCH`,
`CONTEXT_HEAD_MISMATCH`, `CONTEXT_REQUIRED_TESTS_MISMATCH`). The **exact ordered commit range** is bound
too — the commit count and the ordered sha list must equal the packed `commitShas`, and `head` must equal
the terminal (tip) commit sha (`CONTEXT_COMMIT_COUNT_MISMATCH`, `CONTEXT_COMMITS_MISMATCH`,
`HEAD_NOT_TERMINAL_COMMIT`); a commit subject is cosmetic and is not bound. Any failing machine gate adds
`MACHINE_GATE_FAILED`; `overall` is `PREFLIGHT_READY` iff no blocker fires, else `PREFLIGHT_NOT_READY`.

## Human gates (always enumerated, never automated)

Human diff review; optionally the full `npm test` aggregate; the explicit coordinator ACCEPT via the
acceptance seal; the merge/tag/push itself; and Phase 231 authorization — none performed or authorized
here. Sealed with a `preflightDigest`; identical inputs always produce identical digests.

## Files

- `src/ops/promotion-acceptance-preflight.ts` — `buildAcceptancePreflight(input)`,
  `PREFLIGHT_HUMAN_GATES`, `PREFLIGHT_DISCLAIMERS`.
- `src/ops/promotion-acceptance-preflight-cli.ts` — CLI wrapper.
- `test/promotion-acceptance-preflight.ts` — 10 tests: ready with exact machine/human gate enumeration,
  determinism, a blocked/digestless pack, a forged minimal ready pack, incomplete/unknown/missing/failing
  components and bindings (resealed), a context that does not bind to the packed provenance, commit-range
  binding (altered subject stays ready; extra/missing/reordered/different sha blocks), a missing/malformed
  context, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-acceptance-preflight -- --reviewerpack f --context f [--out preflight.json]
```

Exit `0` = `PREFLIGHT_READY`, `1` = `PREFLIGHT_NOT_READY`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
