# Phase 230: Evidence Bundle Minimizer / Redaction Proof (local, non-live)

Report id: `phase-230-promotion-evidence-minimizer`

Status: `PHASE_230_PROMOTION_EVIDENCE_MINIMIZER_READY`

Projects each supplied report down to a **minimal** record — report id, status enum, self-digest, and
numeric counts only — dropping every free-text field (disclaimers, human gates, doc references, commit
subjects, etc.). It then **proves** the minimal bundle is redaction-safe: a deep scan confirms every packed
string is a report id, an `UPPER_SNAKE` status enum, or a hex digest, and every packed number is a count.
It reads parsed JSON only; it performs no promotion, never touches `/mnt/user/media/Movies`, never contacts
Jellyfin, and authorizes nothing live (`authorization` is the constant `NONE`).

`overall` is `MINIMIZED_CLEAN` when the minimal bundle has no free-text leak, `MINIMIZED_LEAK` (with the
leaking report ids) if any packed string is not a report id / status enum / digest, or `NO_REPORTS` for
empty input. `packedKinds` is the fixed proof that only `DIGESTS`, `STATUSES`, and `COUNTS` are packed; the
whole is sealed with a `minimizerDigest`.

## Files

- `src/ops/promotion-evidence-minimizer.ts` — `buildEvidenceMinimizer(reports)`, `PACKED_KINDS`.
- `src/ops/promotion-evidence-minimizer-cli.ts` — CLI wrapper (repeatable `--report`).
- `test/promotion-evidence-minimizer.ts` — 5 tests: clean over real reports, a planted status leak, the
  free-text-drop proof, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-evidence-minimizer -- --report a.json --report b.json [--out minimal.json]
```

Exit `0` = `MINIMIZED_CLEAN`, `1` = `MINIMIZED_LEAK` / `NO_REPORTS`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
