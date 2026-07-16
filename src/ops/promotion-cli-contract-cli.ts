import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildCliContractReport } from './promotion-cli-contract.js';

// Offline CLI contract snapshot guard CLI. Verifies one or more captured CLI stdout objects against the
// universal Phase 230 CLI-output contract. Never promotes, never touches the real Movies root, never
// contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-cli-contract --capture <f> [--capture <f> ...] [--out <report.json>]',
    '',
    'Local, non-live: CONTRACT_OK only when every capture has a -capture report id, a redactionSafe flag,',
    'a sha256 digest, and no path-like values. It authorizes NOTHING live and does not authorize Phase 231.',
    'Exit 0 = CONTRACT_OK, 1 = CONTRACT_VIOLATION / NO_CAPTURES.',
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
  catch { throw new Error('a --capture file is missing or not valid JSON'); }
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  let captures: unknown[];
  try { captures = collectValues(args, '--capture').map(readJson); }
  catch (err) { console.error((err as Error).message); return 2; }
  const report = buildCliContractReport(captures);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-cli-contract-capture',
    overall: report.overall,
    authorization: report.authorization,
    redactionSafe: true,
    results: report.results,
    violations: report.violations,
    contractDigest: report.contractDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return report.overall === 'CONTRACT_OK' ? 0 : 1;
}

process.exit(main());
