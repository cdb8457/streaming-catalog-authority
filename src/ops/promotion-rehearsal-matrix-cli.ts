import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runRehearsalMatrix, type RehearsalMatrixInput } from './promotion-rehearsal-matrix.js';

// Offline rehearsal-matrix CLI: runs every fixture scenario and reports whether each matched its
// expected outcome. Never runs the deploy launcher, never touches the real Movies root, never contacts
// Jellyfin, and authorizes nothing live.

function usage(): string {
  return [
    'usage: ops:promotion-rehearsal-matrix [--work-dir <dir>] [--run-id <id>] [--acceptor-id <id>] \\',
    '    [--keep-sandbox] [--out <matrix.json>]',
    '',
    'Local, non-live: runs the full rehearsal scenario matrix (success + every fault) and checks each',
    'produces its expected outcome. Exit 0 = MATRIX_PASS, 1 = MATRIX_FAIL. Does not authorize Phase 231.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage());
    return 0;
  }
  const out = valueAfter(args, '--out');
  const input: RehearsalMatrixInput = {
    ...(valueAfter(args, '--work-dir') !== undefined ? { workDir: valueAfter(args, '--work-dir') } : {}),
    ...(valueAfter(args, '--run-id') !== undefined ? { runId: valueAfter(args, '--run-id') } : {}),
    ...(valueAfter(args, '--acceptor-id') !== undefined ? { acceptorId: valueAfter(args, '--acceptor-id') } : {}),
    ...(args.includes('--keep-sandbox') ? { keepSandbox: true } : {}),
  };

  let matrix;
  try {
    matrix = await runRehearsalMatrix(input);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(matrix, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-rehearsal-matrix-capture',
    outcome: matrix.outcome,
    redactionSafe: true,
    entries: matrix.entries.map((e) => ({ scenario: e.scenario, expected: e.expected, outcome: e.outcome, matches: e.matches })),
    matrixDigest: matrix.matrixDigest,
    // Never echo the raw --out path; report only that a file was written.
    ...(out ? { matrixWritten: true } : {}),
  }, null, 2));
  return matrix.outcome === 'MATRIX_PASS' ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
