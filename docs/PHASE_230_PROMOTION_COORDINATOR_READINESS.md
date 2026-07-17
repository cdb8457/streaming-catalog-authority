# Phase 230: Final Coordinator Readiness Manifest (local, non-live)

Report id: `phase-230-promotion-coordinator-readiness-manifest`

Status: `PHASE_230_PROMOTION_COORDINATOR_READINESS_READY`

The terminal record of the Phase 230 hardening batch. It consumes the **acceptance preflight**, the
**failure-mode matrix**, the **report schema strictness pass**, the **final boundary audit**, and the
**CLI ergonomics guard**, and confirms coordinator readiness only when every one is present, valid, green
(`PREFLIGHT_READY`, `FAILURE_MATRIX_COMPLETE`, `REPORT_SCHEMA_OK`, `BOUNDARY_AUDIT_CLEAN`,
`CLI_ERGONOMICS_OK`), and carries a valid sha256 self-digest (recorded in `boundDigests`; else
`COMPONENT_DIGEST_MISSING/INVALID`). It reads parsed JSON only; it performs no promotion, never touches
`/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live (`authorization` is the
constant `NONE`).

`overall` is `COORDINATOR_READINESS_CONFIRMED` iff no blocker fires, else
`COORDINATOR_READINESS_NOT_CONFIRMED` with generic blockers (`*_MISSING`, `*_INVALID`,
`ACCEPTANCE_PREFLIGHT_NOT_READY`, `FAILURE_MATRIX_INCOMPLETE`, `REPORT_SCHEMA_NOT_OK`,
`BOUNDARY_AUDIT_FAILED`, `CLI_ERGONOMICS_NOT_OK`). **CONFIRMED means the machine-side evidence is complete
for coordinator review — it is NOT an approval, a merge, or a Phase 231 authorization**; the human gates
(diff review, optional full `npm test`, coordinator ACCEPT via the acceptance seal, the merge itself,
Phase 231) are always enumerated and remain human. Sealed with a `readinessDigest`.

## Files

- `src/ops/promotion-coordinator-readiness.ts` — `buildCoordinatorReadiness(input)`,
  `READINESS_HUMAN_GATES`, `READINESS_DISCLAIMERS`.
- `src/ops/promotion-coordinator-readiness-cli.ts` — CLI wrapper.
- `test/promotion-coordinator-readiness.ts` — 4 tests: confirmed over the real full hardening chain,
  missing/not-green/digestless inputs, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-coordinator-readiness -- --preflight f --failurematrix f --reportschema f --boundaryaudit f --cliergonomics f [--out readiness.json]
```

Exit `0` = `COORDINATOR_READINESS_CONFIRMED`, `1` = `COORDINATOR_READINESS_NOT_CONFIRMED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
