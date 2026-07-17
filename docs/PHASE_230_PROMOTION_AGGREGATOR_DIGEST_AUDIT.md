# Phase 230: Aggregator Digest Fail-Open Audit (local, non-live)

Report id: `phase-230-promotion-aggregator-digest-audit`

Status: `PHASE_230_PROMOTION_AGGREGATOR_DIGEST_AUDIT_READY`

## Why this exists

Coordinator review has repeatedly found the same fail-open: an aggregator that binds a component's self-digest
by checking only that the digest field is **present and well-formed sha256**, without ever **recomputing** it
against the component body. A green status paired with a well-formed-but-wrong digest (a tampered/forged body)
then passes. It was found and fixed in the terminal-closure manifest (BL) and the four closure aggregators,
and again at the source in `reviewer-pack`. This guard institutionalises the fix so the class cannot silently
return in a future aggregator.

## What it proves

It discovers every module that **binds component self-digests** — detected structurally by an emitted
`blockers.push('COMPONENT_DIGEST_MISSING'|'COMPONENT_DIGEST_MISMATCH')` (a real emit, not a data literal, so
the taxonomy / gate-DAG declaration files are not mistaken for binders) — and requires each to:

- **recompute** — delegate to the authoritative self-digest verifier (`verifySelfDigests(`); else
  `RECOMPUTE_ABSENT`;
- **enforce** — fail closed with `COMPONENT_DIGEST_MISMATCH` when a well-formed digest does not recompute;
  else `MISMATCH_NOT_ENFORCED`;
- **test** — carry a test that asserts that rejection (the green-body-tamper case); else `MISMATCH_UNTESTED`.

Discovery that finds no binders is itself a failure (`NO_BINDERS_FOUND`) so the audit can never pass
vacuously. `overall` is `AGGREGATOR_AUDIT_CLEAN` only when every binder is conformant, else
`AGGREGATOR_AUDIT_FAILED`.

The report reads source files and hashes only; it performs no promotion, never touches the real Movies root,
never contacts Jellyfin, and authorizes nothing live (`authorization` is the constant `NONE`). It echoes only
op short-names, booleans, counts, and fixed-language codes — no raw paths — and is sealed with an
`auditDigest`. A CLEAN audit is **not** an approval and does not authorize Phase 231.

The current binder set proven conformant: `terminal-closure`, `coordinator-readiness`, `review-automation`,
`chain-bundle`, `reviewer-pack`, and the `pack-component-integrity` verifier.

## Files

- `src/ops/promotion-aggregator-digest-audit.ts` — `buildAggregatorDigestAudit(projectRoot)` (filesystem
  discovery) and `auditAggregators(inputs)` (pure core).
- `src/ops/promotion-aggregator-digest-audit-cli.ts` — CLI wrapper.
- `test/promotion-aggregator-digest-audit.ts` — 7 tests: the real repo is CLEAN with every known binder
  conformant; synthetic all-conformant; and each gap (`RECOMPUTE_ABSENT`, `MISMATCH_NOT_ENFORCED`,
  `MISMATCH_UNTESTED`, `NO_BINDERS_FOUND`) proven to fire; plus a spawned CLI run.

## Usage

```
npm run ops:promotion-aggregator-digest-audit -- [--out audit.json]
```

Exit `0` = `AGGREGATOR_AUDIT_CLEAN`, `1` = `AGGREGATOR_AUDIT_FAILED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
