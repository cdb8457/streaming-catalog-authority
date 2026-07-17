# Phase 230: Final Boundary Audit (local, non-live)

Report id: `phase-230-promotion-boundary-audit`

Status: `PHASE_230_PROMOTION_BOUNDARY_AUDIT_READY`

The FINAL boundary audit. It re-verifies the compiled boundary policy and audits beyond it. It reads files
+ the shared registry only; it performs no promotion, never touches `/mnt/user/media/Movies`, never
contacts Jellyfin, and authorizes nothing live (`authorization` is the constant `NONE`). Every probed
literal is fragment-assembled so the auditor's own source stays clean under its own audit.

## Audit rules (fail closed)

- `policy-enforced` — the static boundary policy compiles to `BOUNDARY_POLICY_ENFORCED`
  (else `AUDIT_POLICY_VIOLATED`).
- `no-network-endpoints` — no registered op source carries an `http/https/ws/wss` endpoint URL; the four
  corpus payload modules are excluded, as they carry adversarial text as data
  (else `AUDIT_NETWORK_URL_FOUND`).
- `no-env-reads` — no registered op source reads the process environment, keeping every tool deterministic
  and unsteerable toward a live surface (else `AUDIT_ENV_READ_FOUND`).
- `gate-only-local` — `test:phase230-local` exists and references ONLY local suites
  (else `AUDIT_NON_LOCAL_SUITE`; an absent gate fails closed).
- `index-docs-state-boundary` — the tooling index, closure index, and safety-suite docs still state the
  Phase 231 boundary (else `AUDIT_DOC_DRIFT`).

`overall` is `BOUNDARY_AUDIT_CLEAN` when every rule holds, else `BOUNDARY_AUDIT_FAILED`. Output carries
only rule names, booleans, counts, and generic violation codes plus an `auditDigest`.

## Files

- `src/ops/promotion-boundary-audit.ts` — `buildBoundaryAudit(projectRoot)`.
- `src/ops/promotion-boundary-audit-cli.ts` — CLI wrapper.
- `test/promotion-boundary-audit.ts` — 5 tests: clean over the live repo, a planted network endpoint, a
  planted env read, an empty root (gate + doc drift + policy), and a spawned CLI run.

## Usage

```
npm run ops:promotion-boundary-audit -- [--out audit.json]
```

Exit `0` = `BOUNDARY_AUDIT_CLEAN`, `1` = `BOUNDARY_AUDIT_FAILED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
