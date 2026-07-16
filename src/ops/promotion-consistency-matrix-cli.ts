import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildConsistencyMatrix, type ConsistencyInput } from './promotion-consistency-matrix.js';

// Offline cross-report consistency-matrix CLI. Cross-checks the shared digests across the evidence packet,
// review transcript, provenance ledger, gate DAG, archive manifest, and review bundle. Never promotes,
// never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-consistency-matrix --evidence <f> --transcript <f> --ledger <f> --dag <f> --archive <f> --reviewbundle <f> [--out <matrix.json>]',
    '',
    'Local, non-live: MATRIX_CONSISTENT only when every shared digest agrees across all supplied reports.',
    'It authorizes NOTHING live and does not authorize Phase 231. Exit 0 = CONSISTENT, 1 = INCONSISTENT/INCOMPLETE.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}
function readJson(path: string, label: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} file is missing or not valid JSON`); }
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const map: Array<[keyof ConsistencyInput, string]> = [
    ['evidence', '--evidence'], ['transcript', '--transcript'], ['ledger', '--ledger'],
    ['dag', '--dag'], ['archive', '--archive'], ['reviewBundle', '--reviewbundle'],
  ];
  const input: ConsistencyInput = {};
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const matrix = buildConsistencyMatrix(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(matrix, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-cross-report-consistency-matrix-capture',
    overall: matrix.overall,
    authorization: matrix.authorization,
    redactionSafe: true,
    edges: matrix.edges,
    mismatches: matrix.mismatches,
    incomplete: matrix.incomplete,
    matrixDigest: matrix.matrixDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return matrix.overall === 'MATRIX_CONSISTENT' ? 0 : 1;
}

process.exit(main());
