# Phase 230: Closure Summary v3 (local, non-live)

Report id: `phase-230-promotion-closure-summary-v3`

Status: `PHASE_230_PROMOTION_CLOSURE_SUMMARY_V3_READY`

Summarizes the Phase 230 **local-only** closure state from **authoritative bounded** inputs, with exact
commit/test visibility, a mandatory observed-state record, and redaction-safe failure evidence. It is
fail-closed and authorizes nothing: `authorization` is the constant `NONE` and `status` stays `PENDING`.

## Inputs

- `reviewAuthorization` — the review-authorization scaffold, which itself chained the terminal readiness to
  the commit-range / transcript evidence and bound a review matrix to the authoritative context. Its
  placeholders carry the exact reviewed commit shas + test labels.
- `coordinatorReadiness` — the coordinator readiness manifest.
- `observedState` — a locally observed-state record `{ observed, head, source?, stateDigest? }`, where `head`
  is the reviewed commit the state was observed at.

## What it checks (fail closed)

Each report's self-digest is recomputed. `CLOSURE_SUMMARY_READY` only when all hold, else
`CLOSURE_SUMMARY_BLOCKED`:

- **Bounded terminal context** — review-authorization present, right id, digest recomputes,
  `LOCAL_REVIEW_AUTHORIZED` (`UNBOUND_TERMINAL_CONTEXT`).
- **Bounded coordinator context** — coordinator-readiness present, right id, digest recomputes,
  `COORDINATOR_READINESS_CONFIRMED` (`UNBOUND_COORDINATOR_CONTEXT`).
- **Observed-state requirement** — a record with `observed === true` is supplied (`OBSERVED_STATE_MISSING`)
  and is **bound to the authoritative reviewed head**: its `head` must equal the terminal reviewed commit
  (`OBSERVED_STATE_UNBOUND`), so a stale observation of a different head cannot pass.
- **Verified component digests** — a present bounded input that does not recompute is
  `COMPONENT_DIGEST_UNVERIFIED`.
- **Live-boundary closed** — any input claiming `authorization` other than `NONE`/`PENDING`, or **any string
  anywhere in the observed-state record** (a deep, recursive scan — not merely the `source` field) that names
  a live/network/media surface (Jellyfin, an http(s) URL, an Emby token, a `library/Refresh`, a `/mnt/` path)
  or a raw path, is a `LIVE_BOUNDARY_ESCAPE`.

## Output

Exact **commit visibility** (`head`, ordered commit shas, count) and **test visibility** (test labels, count)
are surfaced from the verified review-authorization placeholders. Failure evidence is a set of per-check
booleans (`terminal-context-bound`, `coordinator-context-bound`, `observed-state-present`,
`observed-state-bound-to-head`, `component-digests-verified`, `live-boundary-closed`) — **codes and booleans
only, never a raw path, title,
or the observed-state source**. Only verified digests are recorded in `boundDigests`. It reads parsed JSON
only; it performs no promotion, never touches the real Movies root, never contacts Jellyfin, and is sealed
with a `summaryV3Digest`. **READY summarizes local closure for a human; it does NOT approve, merge, or
authorize Phase 231 / any live promotion.**

## Files

- `src/ops/promotion-closure-summary-v3.ts` — `buildClosureSummaryV3(input)` + gates/boundary/disclaimers.
- `src/ops/promotion-closure-summary-v3-cli.ts` — CLI wrapper.
- `test/promotion-closure-summary-v3.ts` — 8 tests: ready with bounded contexts + observed state (exact
  commit/test visibility, PENDING); missing observed state; observed state not bound to the reviewed head;
  unbound terminal / coordinator context; unverified component digest; live-boundary escape (incl. deep /
  nested and non-source fields); empty input; and a spawned CLI run.

## Usage

```
npm run ops:promotion-closure-summary-v3 -- --reviewauthorization ra.json --coordinatorreadiness cr.json \
    --observedstate os.json [--out summary.json]
```

Exit `0` = `CLOSURE_SUMMARY_READY`, `1` = `CLOSURE_SUMMARY_BLOCKED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
