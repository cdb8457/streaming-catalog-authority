# Phase 230: Terminal Readiness v2 (local, non-live)

Report id: `phase-230-promotion-terminal-readiness-v2`

Status: `PHASE_230_PROMOTION_TERMINAL_READINESS_V2_READY`

Where the v1 terminal closure tied together the review-evidence chain, **v2** is the final local-only
readiness record over the whole hardened set. It consumes:

- the **terminal closure** manifest (v1),
- the **pack component-integrity** verifier,
- the **aggregator digest fail-open audit**,
- the **artifact generation/export manifest**,
- the **negative-evidence adversarial corpus**, and
- the **automation/watchdog hygiene** report,

and reports `TERMINAL_READINESS_V2_CONFIRMED` only when every one is present, valid, green
(`TERMINAL_CLOSURE_CONFIRMED`, `PACK_INTEGRITY_VERIFIED`, `AGGREGATOR_AUDIT_CLEAN`,
`ARTIFACT_EXPORT_MANIFEST_COMPLETE`, `CORPUS_HELD`, `WATCHDOG_HYGIENE_CLEAN`), and carries a self-digest that
**recomputes against its body** — delegated to the authoritative self-digest verifier. It **fails closed on
any missing, stale/not-green, or digest-mismatched input** (`*_MISSING`, `*_INVALID`, the per-component
not-green code, or `COMPONENT_DIGEST_MISMATCH`). Only genuinely-verified digests are recorded in
`boundDigests`.

`overall` is `TERMINAL_READINESS_V2_CONFIRMED` iff no blocker fires, else `TERMINAL_READINESS_V2_NOT_CONFIRMED`.
Every manifest restates the remaining human gates and the closed live-boundary (`boundary`) and is sealed
with a `readinessV2Digest`. It reads parsed JSON only; it performs no promotion, never touches the real
Movies root, never contacts Jellyfin, and authorizes nothing live (`authorization` is the constant `NONE`).

**CONFIRMED means the full local evidence set is complete and self-consistent for coordinator review — it is
NOT an approval, a merge, or a Phase 231 / live-promotion authorization**, and the human gates remain.

## Files

- `src/ops/promotion-terminal-readiness-v2.ts` — `buildTerminalReadinessV2(input)`,
  `READINESS_V2_HUMAN_GATES`, `READINESS_V2_BOUNDARY`, `READINESS_V2_DISCLAIMERS`.
- `src/ops/promotion-terminal-readiness-v2-cli.ts` — CLI wrapper.
- `test/promotion-terminal-readiness-v2.ts` — 5 tests: confirmed over the full final chain; a missing /
  not-green component; the green-body tamper (digest recompute) case; empty input; and a spawned CLI run.

## Usage

```
npm run ops:promotion-terminal-readiness-v2 -- --terminalclosure tc.json --packcomponentintegrity pci.json --aggregatordigestaudit ada.json --artifactexportmanifest aem.json --negativeevidencecorpus nec.json --watchdoghygiene wh.json [--out manifest.json]
```

Exit `0` = `TERMINAL_READINESS_V2_CONFIRMED`, `1` = `TERMINAL_READINESS_V2_NOT_CONFIRMED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
