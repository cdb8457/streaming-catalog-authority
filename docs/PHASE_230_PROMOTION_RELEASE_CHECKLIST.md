# Phase 230: Coordinator Evidence Release Checklist (local, non-live)

Report id: `phase-230-promotion-coordinator-release-checklist`

Status: `PHASE_230_PROMOTION_RELEASE_CHECKLIST_READY`

Composes the **coordinator final summary**, the **negative-evidence adversarial corpus**, and the
**closure / dependency hygiene** report (and, optionally, the **self-digest verification**) into an
explicit go/no-go release checklist. It reads parsed JSON only; it performs no promotion, never touches
`/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live (`authorization` is the
constant `NONE`). **Clearing the checklist is not a merge, a release action, or a Phase 231 authorization**
— only a statement that the local evidence preconditions are met.

## Items

| Item | Required | Passes when |
|------|----------|-------------|
| `final-summary` | yes | `FINAL_SUMMARY_READY` |
| `negative-evidence-corpus` | yes | `CORPUS_HELD` |
| `closure-hygiene` | yes | `HYGIENE_OK` |
| `self-digest` | no | `ALL_VERIFIED` (absent does not block) |

`overall` is `RELEASE_CHECKLIST_CLEARED` iff every required item is present, valid, and passing and every
supplied optional item passes; otherwise `RELEASE_CHECKLIST_BLOCKED` with generic blockers
(`*_MISSING`, `*_INVALID`, `FINAL_SUMMARY_NOT_READY`, `NEGATIVE_CORPUS_BREACHED`, `CLOSURE_HYGIENE_NOT_OK`,
`SELF_DIGEST_NOT_VERIFIED`). Every checklist restates the remaining human gates and the fixed non-live /
no-merge disclaimers and is sealed with a `checklistDigest`.

## Files

- `src/ops/promotion-release-checklist.ts` — `buildReleaseChecklist(input)`, `RELEASE_CHECKLIST_HUMAN_GATES`,
  `RELEASE_CHECKLIST_DISCLAIMERS`.
- `src/ops/promotion-release-checklist-cli.ts` — CLI wrapper.
- `test/promotion-release-checklist.ts` — 6 tests: all-cleared, required-only cleared, a missing required
  item, a corpus breach, empty input, and a spawned CLI run.

## Usage

```
npm run ops:promotion-release-checklist -- --finalsummary f --negativecorpus f --closurehygiene f [--selfdigest f] [--out checklist.json]
```

Exit `0` = `RELEASE_CHECKLIST_CLEARED`, `1` = `RELEASE_CHECKLIST_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
