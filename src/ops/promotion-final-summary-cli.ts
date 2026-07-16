import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildFinalSummary, type FinalSummaryInput } from './promotion-final-summary.js';

// Offline coordinator final-summary CLI. Summarizes the review bundle plus optional consistency-matrix,
// self-digest, and taxonomy cross-checks into a redaction-safe one-page verdict. Never promotes, never
// touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-final-summary --reviewbundle <f> --transcript <f> [--matrix <f>] [--selfdigest <f>] [--taxonomy <f>] [--out <summary.json>]',
    '',
    'Local, non-live: FINAL_SUMMARY_READY only when the review bundle is READY and every supplied optional',
    'check is green. It authorizes NOTHING live and does not authorize Phase 231. Exit 0 = READY, 1 = BLOCKED.',
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
  const map: Array<[keyof FinalSummaryInput, string]> = [
    ['reviewBundle', '--reviewbundle'], ['transcript', '--transcript'], ['consistencyMatrix', '--matrix'], ['selfDigest', '--selfdigest'], ['taxonomy', '--taxonomy'],
  ];
  const input: FinalSummaryInput = {};
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const summary = buildFinalSummary(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-coordinator-final-summary-capture',
    overall: summary.overall,
    authorization: summary.authorization,
    redactionSafe: true,
    reviewedCommit: summary.reviewedCommit,
    testResults: summary.testResults,
    testsPassed: summary.testsPassed,
    testsFailed: summary.testsFailed,
    checks: summary.checks,
    blockers: summary.blockers,
    summaryDigest: summary.summaryDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return summary.overall === 'FINAL_SUMMARY_READY' ? 0 : 1;
}

process.exit(main());
