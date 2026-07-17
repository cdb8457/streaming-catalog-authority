# Phase 230: Automation / Watchdog Hygiene (local, non-live)

Report id: `phase-230-promotion-watchdog-hygiene`

Status: `PHASE_230_PROMOTION_WATCHDOG_HYGIENE_READY`

## Why this exists

The Orca watcher that drives promotion automation must behave safely — it must debounce, be idempotent,
deduplicate queued work by content digest, never auto-promote, and respect the closed live boundary. This
report verifies that behavior **from the records the watcher produces** (its declared config and its work
queue) without running or contacting any watcher, so a duplicate-queue or auto-promote regression is caught
offline.

## What it checks

Given a watcher `config` and a `queue` (and an optional `currentRun`), it reports `WATCHDOG_HYGIENE_CLEAN`
only when all hold, else `WATCHDOG_HYGIENE_VIOLATED`:

- **Config declares the safe invariants** — a positive `debounceMs` (`WATCHER_DEBOUNCE_MISSING`),
  `idempotent: true` (`WATCHER_NOT_IDEMPOTENT`), `autoPromote: false` (`WATCHER_AUTO_PROMOTE_ENABLED`),
  `respectsLiveBoundary: true` (`WATCHER_LIVE_BOUNDARY_UNGUARDED`), and `deduplicateBy: 'content-digest'`
  (`WATCHER_DEDUPE_DISABLED`); a missing config is `WATCHER_CONFIG_MISSING`.
- **Queue is present** (`QUEUE_MISSING`) and every entry is well-formed — a sha256 `itemDigest`
  (`ENTRY_DIGEST_MALFORMED`), an allowed `status` of `queued`/`processed`/`skipped`
  (`ENTRY_STATUS_INVALID`), and a path-free `run` (`ENTRY_RUN_MISSING`).
- **Duplicate-queue prevention** — no content digest is queued more than once (`DUPLICATE_QUEUE_ENTRY`).
- **Freshness** — no entry belongs to a superseded run when `currentRun` is given (`STALE_QUEUE_ENTRY`).

It reads parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts
Jellyfin, and authorizes nothing live (`authorization` is the constant `NONE`). It echoes only content
digests (hex), status enums, booleans, and counts — never raw paths or titles — and is sealed with a
`watchdogDigest`. A CLEAN report is **not** an approval and does not authorize Phase 231.

## Files

- `src/ops/promotion-watchdog-hygiene.ts` — `buildWatchdogHygiene(input)`, `WATCHDOG_DISCLAIMERS`.
- `src/ops/promotion-watchdog-hygiene-cli.ts` — CLI wrapper.
- `test/promotion-watchdog-hygiene.ts` — 6 tests: clean; unsafe config; duplicate + stale entries; malformed
  digest / invalid status / missing queue; empty input; and a spawned CLI run.

## Usage

```
npm run ops:promotion-watchdog-hygiene -- --config config.json --queue queue.json [--currentrun <id>] [--out report.json]
```

Exit `0` = `WATCHDOG_HYGIENE_CLEAN`, `1` = `WATCHDOG_HYGIENE_VIOLATED`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master, and
no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
