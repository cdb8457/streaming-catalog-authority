import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildEvidenceMinimizer } from './promotion-evidence-minimizer.js';

// Offline evidence minimizer / redaction-proof CLI. Projects reports to digests/statuses/counts only and
// proves the minimal bundle is redaction-safe. Never promotes, never touches the real Movies root, never
// contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-evidence-minimizer --report <f> [--report <f> ...] [--out <minimal.json>]',
    '',
    'Local, non-live: MINIMIZED_CLEAN only when the minimal bundle (report ids, status enums, digests,',
    'counts) contains no free-text leak. It authorizes NOTHING live and does not authorize Phase 231.',
    'Exit 0 = MINIMIZED_CLEAN, 1 = MINIMIZED_LEAK / NO_REPORTS.',
  ].join('\n');
}

function collectValues(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1]!);
  return out;
}
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}
function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('a --report file is missing or not valid JSON'); }
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  let reports: unknown[];
  try { reports = collectValues(args, '--report').map(readJson); }
  catch (err) { console.error((err as Error).message); return 2; }
  const minimizer = buildEvidenceMinimizer(reports);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(minimizer, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-evidence-minimizer-capture',
    overall: minimizer.overall,
    authorization: minimizer.authorization,
    redactionSafe: true,
    count: minimizer.count,
    packedKinds: minimizer.packedKinds,
    leaks: minimizer.leaks,
    minimizerDigest: minimizer.minimizerDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return minimizer.overall === 'MINIMIZED_CLEAN' ? 0 : 1;
}

process.exit(main());
