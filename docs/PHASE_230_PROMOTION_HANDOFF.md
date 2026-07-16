# Phase 230: Coordinator Handoff Packet (local, non-live)

Report id: `phase-230-promotion-coordinator-handoff`

Status: `PHASE_230_PROMOTION_HANDOFF_READY`

Summarizes the offline Phase 230 artifacts — a sealed acceptance packet, and optionally a rehearsal
(single or matrix) manifest and an artifact-integrity report — into a single **redaction-safe**
coordinator handoff packet. The packet carries explicit, always-present language that it authorizes
**nothing** live.

It reads parsed JSON only; it performs no promotion, never touches `/mnt/user/media/Movies`, never
contacts Jellyfin, and **never authorizes Phase 231 or live promotion**. `authorization` is the constant
`NONE`.

## Contents

- `authorization`: always `NONE`.
- `handoffState`: `READY_FOR_COORDINATOR` iff the acceptance packet is `ACCEPTED_SEALED`/accepted AND
  (if supplied) the integrity report is `ok` AND the rehearsal outcome is a pass; otherwise `NOT_READY`
  with generic `blockers` (`ACCEPTANCE_MISSING`, `ACCEPTANCE_NOT_SEALED`, `INTEGRITY_NOT_OK`,
  `REHEARSAL_NOT_PASSED`, `RAW_PATH_IN_HANDOFF`).
- `disclaimers`: the fixed `HANDOFF_DISCLAIMERS` — including "This handoff does NOT authorize Phase 231."
  and "This handoff does NOT authorize live promotion." — present in **every** packet, ready or not.
- `acceptance` (status/accepted/sealDigest), `boundDigests`, and optional `rehearsal`/`integrity`
  summaries — all digests/enums/booleans, no raw paths or titles. A `handoffDigest` seals the packet.

## Files

- `src/ops/promotion-handoff.ts` — `buildCoordinatorHandoff(input)`, `HANDOFF_DISCLAIMERS`.
- `src/ops/promotion-handoff-cli.ts` — CLI wrapper.
- `test/promotion-handoff.ts` — 8 tests: READY path, always-present disclaimers, NOT_READY on refused
  acceptance / not-ok integrity / failed rehearsal / missing acceptance, redaction-safety, and a spawned
  CLI run.

## Usage

```
npm run ops:promotion-handoff -- --acceptance-packet f [--rehearsal-manifest f] [--integrity-report f] [--out handoff.json]
```

Exit `0` = `READY_FOR_COORDINATOR`, `1` = `NOT_READY`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization — stated explicitly in the packet itself.
