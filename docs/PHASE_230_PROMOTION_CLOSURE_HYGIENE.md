# Phase 230: Closure / Dependency Hygiene (local, non-live)

Report id: `phase-230-promotion-closure-hygiene`

Status: `PHASE_230_PROMOTION_CLOSURE_HYGIENE_READY`

A meta-verifier that confirms the Phase 230 toolchain's structural invariants hold together. It reads
files and the shared registries only; it performs no promotion, never touches `/mnt/user/media/Movies`,
never contacts Jellyfin, and authorizes nothing live (`authorization` is the constant `NONE`).

## Checks

- `dag-acyclic` — `verifyGateDag()` is acyclic and every dependency resolves.
- `blockers-catalogued` — every gate-DAG node blocker code appears in `BLOCKER_CODES` (else
  `UNCATALOGUED_BLOCKER`).
- `taxonomy-consistent` — the blocker taxonomy builds `TAXONOMY_CONSISTENT` (else `TAXONOMY_INCONSISTENT`).
- `taxonomy-ops-known` — every taxonomy op is a real gate-DAG node id (else `UNKNOWN_TAXONOMY_OP`).
- `registry-wired` — every `LOCAL_OPS_REGISTRY` base has `ops:`/`test:` scripts, is in the local gate, the
  suite manifest, the live-boundary guard sources, and the closure index (else `REGISTRY_NOT_WIRED`).
- `self-digest-covers-reports` — every op's primary report id is in the self-digest verifier's registry
  (`KNOWN_REPORT_IDS`), so no report can escape self-digest verification (else
  `REPORT_NOT_IN_SELF_DIGEST_REGISTRY`).
- `cli-contract-conformant` — every op's CLI emits a `-capture` report id and a `redactionSafe: true` flag
  (else `CLI_NOT_CONTRACT_CONFORMANT`).

`overall` is `HYGIENE_OK` when no problem fires, else `HYGIENE_VIOLATION`. Output carries only check names,
booleans, counts, and generic problem codes (no raw digests/paths/titles) plus a `hygieneDigest`.

## Files

- `src/ops/promotion-closure-hygiene.ts` — `buildClosureHygiene(projectRoot)`.
- `src/ops/promotion-closure-hygiene-cli.ts` — CLI wrapper.
- `test/promotion-closure-hygiene.ts` — 3 tests: the live toolchain is hygienic, an empty root violates,
  and a spawned CLI run.

## Usage

```
npm run ops:promotion-closure-hygiene -- [--out hygiene.json]
```

Exit `0` = `HYGIENE_OK`, `1` = `HYGIENE_VIOLATION`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
