import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildWatchdogHygiene, type WatchdogHygieneInput } from './promotion-watchdog-hygiene.js';

// Offline automation / watchdog hygiene CLI. Verifies the Orca watcher's declared config and work queue are
// safe (debounced, idempotent, dedup-by-digest, no auto-promote, live-boundary-guarded) with no duplicate,
// stale, or malformed queue entries. Never promotes, never touches the real Movies root, never contacts
// Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-watchdog-hygiene --config <config.json> --queue <queue.json> [--currentrun <id>] [--out <report.json>]',
    '',
    'Local, non-live: WATCHDOG_HYGIENE_CLEAN only when the config declares the safe invariants and the queue',
    'carries no duplicate/stale/malformed entries. It authorizes NOTHING live and does not authorize Phase 231.',
    'Exit 0 = CLEAN, 1 = VIOLATED.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}
function readJson(path: string, label: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} file is missing or not valid JSON`); }
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const input: WatchdogHygieneInput = {};
  try {
    const cfg = valueAfter(args, '--config');
    const q = valueAfter(args, '--queue');
    const run = valueAfter(args, '--currentrun');
    if (cfg !== undefined) (input as Record<string, unknown>).config = readJson(cfg, 'config');
    if (q !== undefined) (input as Record<string, unknown>).queue = readJson(q, 'queue');
    if (run !== undefined) (input as Record<string, unknown>).currentRun = run;
  } catch (err) { console.error((err as Error).message); return 2; }
  const report = buildWatchdogHygiene(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-watchdog-hygiene-capture',
    overall: report.overall,
    authorization: report.authorization,
    redactionSafe: true,
    configSafe: report.configSafe,
    queueCount: report.queueCount,
    uniqueCount: report.uniqueCount,
    blockers: report.blockers,
    watchdogDigest: report.watchdogDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return report.overall === 'WATCHDOG_HYGIENE_CLEAN' ? 0 : 1;
}

process.exit(main());
