# Phase 230: Cross-Component Context-Consistency Audit (local, non-live)

Report id: `phase-230-promotion-context-consistency-audit`

Status: `PHASE_230_PROMOTION_CONTEXT_CONSISTENCY_AUDIT_READY`

## Why this exists

Many Phase 230 reports carry a slice of the review context — `branch`, `base`, `head` / reviewed commit, the
ordered commit shas, and the required test set. Each can be independently green and self-digested, yet a set
stitched from different runs (or a fresh full chain in which **one** component was resealed onto a different
head/range) can disagree on that shared context. The existing checks catch *specific* seams —
`acceptance-preflight` binds a supplied context to the reviewer-pack provenance; `review-authorization` binds
a review matrix to the commit-range / transcript evidence via a digest chain; `promotion-aggregator-digest-audit`
proves binders *recompute* their component digests. **None reconciles the whole set at the value level.**

This audit does. Because it compares context **values** (not just digests), it catches a partial re-stitch
that every digest-level check accepts: a component resealed to a valid self-digest but a different head is
individually valid yet inconsistent with its peers.

## What it checks

Given a bundle (array) of Phase 230 reports, it recomputes each supplied report's self-digest and, over the
**verified** context-bearing ones, reconciles every shared field:

- a recognized context report that does not recompute → `COMPONENT_UNVERIFIED` (fail closed);
- fewer than two verified context components → `INSUFFICIENT_CONTEXT_COMPONENTS` (no vacuous pass);
- `branch` (`CONTEXT_BRANCH_INCONSISTENT`), `base` (`CONTEXT_BASE_INCONSISTENT`), `head` /reviewed-commit
  (`CONTEXT_HEAD_INCONSISTENT`), the **ordered** commit shas (`CONTEXT_COMMITS_INCONSISTENT`), and the test
  set (`CONTEXT_TESTS_INCONSISTENT`) — every contributing report must agree.

`overall` is `CONTEXT_CONSISTENT` only when no blocker fires. Reconciled report ids and their projected
fields: `merge-readiness-dry-run`, `merge-review-evidence-pack` (provenance), `acceptance-preflight`,
`commit-range-closure`, `transcript-verification`, `review-transcript`, `coordinator-final-summary`,
`provenance-diff`, and `review-matrix`. Reports outside this set are ignored.

It is deterministic and reads parsed JSON only; it performs no promotion, never touches the real Movies root,
never contacts Jellyfin, and its `authorization` field is the constant `NONE`. It echoes only shas (hex),
path-free labels, counts, and booleans — never a raw path or title — and is sealed with an `auditDigest`. A
`CONTEXT_CONSISTENT` result is **not** an approval and does not authorize Phase 231 or any live action.

## Files

- `src/ops/promotion-context-consistency-audit.ts` — `buildContextConsistencyAudit(input)`.
- `src/ops/promotion-context-consistency-audit-cli.ts` — CLI wrapper.
- `test/promotion-context-consistency-audit.ts` — 6 tests: consistent over the full chain; a freshly-resealed
  final-summary reviewing a different head; a resealed pack with altered tests + a resealed matrix with
  altered commits; an unverified component; fewer than two components; and a spawned CLI run.

## Usage

```
npm run ops:promotion-context-consistency-audit -- --reports bundle.json [--out audit.json]
```

`bundle.json` is a JSON array of Phase 230 reports. Exit `0` = `CONTEXT_CONSISTENT`, `1` =
`CONTEXT_INCONSISTENT`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
