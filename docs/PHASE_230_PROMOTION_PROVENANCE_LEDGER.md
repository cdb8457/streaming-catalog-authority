# Phase 230: Provenance Ledger (local, non-live)

Report id: `phase-230-promotion-provenance-ledger`

Status: `PHASE_230_PROMOTION_PROVENANCE_LEDGER_READY`

From a fixture evidence bundle (and, optionally, the replay, evidence packet, and review transcript) it
records, for every Phase 230 artifact/report: its report id, self-digest, **producing** tool,
**consuming** tools, and present/absent status. It reads parsed JSON only; it performs no promotion,
never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live.

## Ledger

Fifteen entries, one per artifact/report id, each `{ id, producer, consumers, status, digest? }`.
`complete` is true only when every entry's self-digest is present; `absent` lists any missing ids. The
ledger carries only ids, tool names, statuses, and SHA-256 digests — no raw paths or titles — and a
`ledgerDigest`. The producer/consumer graph is the static Phase 230 pipeline: approval → promotion →
review → readiness → acceptance → integrity/schema → handoff → dashboard → bundle → replay →
evidence packet, with the rehearsal manifest and review transcript as siblings.

## Files

- `src/ops/promotion-provenance-ledger.ts` — `buildProvenanceLedger(input)`.
- `src/ops/promotion-provenance-ledger-cli.ts` — CLI wrapper.
- `test/promotion-provenance-ledger.ts` — 4 tests: complete ledger, partial-input absences,
  redaction-safety, and a spawned CLI run.

## Usage

```
npm run ops:promotion-provenance-ledger -- --bundle bundle.json [--replay f] [--evidence f] [--transcript f] [--out ledger.json]
```

Exit `0` = complete, `1` = incomplete.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization.
