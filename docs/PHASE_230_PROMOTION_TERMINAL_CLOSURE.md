# Phase 230: Terminal Closure Manifest (local, non-live)

Report id: `phase-230-promotion-terminal-closure-manifest`

Status: `PHASE_230_PROMOTION_TERMINAL_CLOSURE_READY`

The terminal record that ties together all the local evidence. It consumes the **transcript verification**,
the **evidence minimizer / redaction proof**, the **commit-range closure**, the **regression oracle**, and
the **coordinator readiness** manifest, and confirms terminal closure only when every one is present, valid,
green (`TRANSCRIPT_VERIFIED`, `MINIMIZED_CLEAN`, `RANGE_CLOSED`, `ORACLE_COMPLETE`,
`COORDINATOR_READINESS_CONFIRMED`), and carries a sha256 self-digest that actually **recomputes against its
body** — the recompute is delegated to the authoritative self-digest verifier, so a green status paired with
a well-formed but wrong digest (a tampered/forged body) fails closed with `COMPONENT_DIGEST_MISMATCH`. Only a
genuinely-verified digest is recorded in `boundDigests` (`COMPONENT_DIGEST_MISSING` when absent,
`COMPONENT_DIGEST_INVALID` when not a sha256). It reads parsed JSON only; it performs no promotion, never
touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live (`authorization` is
the constant `NONE`).

`overall` is `TERMINAL_CLOSURE_CONFIRMED` iff no blocker fires, else `TERMINAL_CLOSURE_NOT_CONFIRMED` with
generic blockers (`*_MISSING`, `*_INVALID`, `TRANSCRIPT_VERIFICATION_NOT_VERIFIED`,
`EVIDENCE_MINIMIZER_NOT_CLEAN`, `COMMIT_RANGE_NOT_CLOSED`, `REGRESSION_ORACLE_INCOMPLETE`,
`COORDINATOR_READINESS_NOT_CONFIRMED`). **CONFIRMED means the local evidence chain is complete for
coordinator review — it is NOT an approval, a merge, or a Phase 231 / live-promotion authorization.** Every
manifest restates the remaining human gates and the closed live-boundary (`boundary`), and is sealed with a
`terminalDigest`.

## Files

- `src/ops/promotion-terminal-closure.ts` — `buildTerminalClosure(input)`, `TERMINAL_HUMAN_GATES`,
  `TERMINAL_BOUNDARY`, `TERMINAL_DISCLAIMERS`.
- `src/ops/promotion-terminal-closure-cli.ts` — CLI wrapper.
- `test/promotion-terminal-closure.ts` — 4 tests: confirmed over the real full evidence chain, a
  missing/not-green/digestless component, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-terminal-closure -- --transcriptverification f --evidenceminimizer f --commitrangeclosure f --regressionoracle f --coordinatorreadiness f [--out manifest.json]
```

Exit `0` = `TERMINAL_CLOSURE_CONFIRMED`, `1` = `TERMINAL_CLOSURE_NOT_CONFIRMED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
