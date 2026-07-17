# Phase 230: Static Live-Boundary Policy Compiler (local, non-live)

Report id: `phase-230-promotion-boundary-policy`

Status: `PHASE_230_PROMOTION_BOUNDARY_POLICY_READY`

Compiles the closed-live-boundary policy into a machine-readable rule set and verifies it **statically**
over the repo. It reads files + the shared op registry only; it performs no promotion, never touches
`/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live (`authorization` is the
constant `NONE`). It fails closed on any violation.

## Compiled rules

- `no-forbidden-hooks` — no registered op's module or CLI source may contain a forbidden live hook:
  network fetch, Jellyfin scan/auth-header/env hooks, the deploy launcher name, process spawning, or the
  live promotion CLI (else `FORBIDDEN_HOOK_FOUND`). The hook literals are fragment-assembled inside the
  compiler so its own source stays clean under its own policy.
- `docs-state-boundary` — every registered op's doc must reference Phase 231 and state the non-live
  boundary (else `BOUNDARY_LANGUAGE_MISSING`).
- `sandboxed-promotion-caller` — only the rehearsal may invoke the guarded promotion service (else
  `UNSANDBOXED_PROMOTION_CALL`).

`overall` is `BOUNDARY_POLICY_ENFORCED` when every rule holds, else `BOUNDARY_POLICY_VIOLATED`. The report
carries only rule names, booleans, counts, and generic violation codes (no raw digests/paths/titles) plus a
`policyDigest`. This complements the live-boundary guard test: the guard is the enforcing test; this
compiler emits the same policy as coordinator-consumable evidence.

## Files

- `src/ops/promotion-boundary-policy.ts` — `buildBoundaryPolicy(projectRoot)`, `BOUNDARY_POLICY_RULES`,
  `BOUNDARY_HOOK_COUNT`.
- `src/ops/promotion-boundary-policy-cli.ts` — CLI wrapper.
- `test/promotion-boundary-policy.ts` — 5 tests: enforced over the live repo, a planted live hook, a
  planted unsandboxed promotion caller, an empty root (docs violation), and a spawned CLI run.

## Usage

```
npm run ops:promotion-boundary-policy -- [--out policy.json]
```

Exit `0` = `BOUNDARY_POLICY_ENFORCED`, `1` = `BOUNDARY_POLICY_VIOLATED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
