import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';

// Offline all-artifacts self-digest verifier CLI. Recomputes and checks the self-digest of every supplied
// Phase 230 report. Never promotes, never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-self-digest-verifier --report <f> [--report <f> ...] [--out <verification.json>]',
    '',
    'Local, non-live: ALL_VERIFIED only when every supplied report is recognized and self-consistent.',
    'It authorizes NOTHING live and does not authorize Phase 231. Exit 0 = ALL_VERIFIED, 1 = otherwise.',
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
  const verification = verifySelfDigests(reports);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(verification, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-self-digest-verification-capture',
    overall: verification.overall,
    authorization: verification.authorization,
    redactionSafe: true,
    count: verification.count,
    results: verification.results,
    mismatches: verification.mismatches,
    unrecognized: verification.unrecognized,
    verifierDigest: verification.verifierDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return verification.overall === 'ALL_VERIFIED' ? 0 : 1;
}

process.exit(main());
