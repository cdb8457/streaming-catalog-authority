import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { replayFixtureBundle } from './promotion-bundle-replay.js';

// Offline bundle-replay CLI. Reads a fixture evidence bundle and re-derives + re-verifies its reports,
// failing closed on any missing/tamper/wrong-report/mismatch. Never promotes, never touches the real
// Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-bundle-replay --bundle <bundle.json> [--out <replay.json>]',
    '',
    'Local, non-live: re-derives integrity/schema/handoff/dashboard from the bundle artifacts and',
    're-verifies the matrix/manifest self-seals and manifest stage digests. Exit 0 = ok, 1 = replay problem(s).',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const bundlePath = valueAfter(args, '--bundle');
  const out = valueAfter(args, '--out');
  if (!bundlePath) {
    console.error(usage());
    return 2;
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(readFileSync(bundlePath, 'utf8'));
  } catch {
    console.error('bundle file is missing or not valid JSON');
    return 2;
  }
  const replay = replayFixtureBundle(candidate);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(replay, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-bundle-replay-capture',
    ok: replay.ok,
    redactionSafe: true,
    checks: replay.checks,
    problems: replay.problems,
    replayDigest: replay.replayDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return replay.ok ? 0 : 1;
}

process.exit(main());
