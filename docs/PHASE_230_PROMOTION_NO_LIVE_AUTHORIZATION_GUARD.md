# Phase 230: Final No-Live Authorization Guard (local, non-live)

Report id: `phase-230-promotion-no-live-authorization-guard`

Status: `PHASE_230_PROMOTION_NO_LIVE_AUTHORIZATION_GUARD_READY`

The final backstop against a smuggled live authorization. Given a set of artifacts, any that **claims** a live
authorization fails closed — unless it is explicitly a PENDING human gate doc.

## What it flags

A **claim** is any of: an `authorization` / `status` / `overall` equal to `APPROVED`, `EXECUTE`, `LIVE_READY`,
`PHASE_231_AUTHORIZED`, or `GRANTED`; a truthy `approved` / `execute` / `liveReady` / `phase231Authorized` /
`liveAuthorized` flag; or one of those exact tokens appearing anywhere in the artifact body. (The bare word
`AUTHORIZED` is deliberately **not** flagged, so `LOCAL_REVIEW_AUTHORIZED` and prose like "Phase 231
authorization is NOT granted" are not false positives.)

An artifact that makes a claim is a `LIVE_AUTHORIZATION_CLAIMED` violation **unless** it is an explicit PENDING
human gate doc — `humanGate: true`, `status: 'PENDING'`, `authorization` in `NONE`/`PENDING` — which may LIST
those tokens as pending future steps. `NO_ARTIFACTS` guards an empty set. `overall` is
`NO_LIVE_AUTHORIZATION_CLEAN` only when no artifact claims a live authorization.

It reads parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts
Jellyfin, and echoes only report short-names and booleans — never the offending value. A CLEAN result is not
an approval and does not authorize Phase 231.

## Files

- `src/ops/promotion-no-live-authorization-guard.ts` — `buildNoLiveAuthorizationGuard(input)`.
- `src/ops/promotion-no-live-authorization-guard-cli.ts` — CLI wrapper.
- `test/promotion-no-live-authorization-guard.ts` — 5 tests: clean; violated on
  APPROVED/EXECUTE/LIVE_READY/PHASE_231_AUTHORIZED claims; a PENDING gate doc listing the tokens is exempt
  (but an actual authorization claim is not); no artifacts; and a spawned CLI run. Negative-evidence-corpus
  samples also exercise the guard.

## Usage

```
npm run ops:promotion-no-live-authorization-guard -- --artifacts artifacts.json [--out report.json]
```

Exit `0` = `NO_LIVE_AUTHORIZATION_CLEAN`, `1` = `NO_LIVE_AUTHORIZATION_VIOLATED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
