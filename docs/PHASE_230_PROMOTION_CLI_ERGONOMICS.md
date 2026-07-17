# Phase 230: CLI Ergonomics Guard (local, non-live)

Report id: `phase-230-promotion-cli-ergonomics`

Status: `PHASE_230_PROMOTION_CLI_ERGONOMICS_READY`

Every registered op's CLI must define a `usage()` text and handle `--help` (print usage, exit 0), so an
operator can always discover the contract without side effects. This phase brought all older CLIs up to
that contract and adds a guard that verifies it statically over every registry CLI; the guard's test also
drives a representative CLI sample live (`--help` exits 0 with a usage line; malformed input exits 2 with a
clean one-line message and no stack trace). It reads files + the shared registry only; it performs no
promotion, never touches `/mnt/user/media/Movies`, never contacts Jellyfin, and authorizes nothing live
(`authorization` is the constant `NONE`).

`overall` is `CLI_ERGONOMICS_OK` when every CLI passes, else `CLI_ERGONOMICS_GAP` with generic gaps
(`USAGE_MISSING`, `HELP_MISSING`). Output carries only CLI base names, booleans, and counts (no raw
digests/paths/titles) plus an `ergonomicsDigest`.

## Files

- `src/ops/promotion-cli-ergonomics.ts` — `buildCliErgonomics(projectRoot)`.
- `src/ops/promotion-cli-ergonomics-cli.ts` — CLI wrapper.
- `test/promotion-cli-ergonomics.ts` — 5 tests: every CLI compliant, a live `--help` sample (old + new
  CLIs), a clean malformed-input failure, a planted gap, and a spawned CLI run.

## Usage

```
npm run ops:promotion-cli-ergonomics -- [--out ergonomics.json]
```

Exit `0` = `CLI_ERGONOMICS_OK`, `1` = `CLI_ERGONOMICS_GAP`.

## Boundary

No live promotion, no Jellyfin call, no real Movies write, no deploy-launcher run, no merge/tag/master,
and no Phase 231 or live-promotion authorization. This tool never contacts Jellyfin and does not authorize
Phase 231.
