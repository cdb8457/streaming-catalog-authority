import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFailureMatrix } from './promotion-failure-matrix.js';

// Offline failure-mode matrix CLI. Maps every catalogued blocker code to its test suite, doc, and gate
// reference and classifies the evidence. Never promotes, never touches the real Movies root, never
// contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-failure-matrix [--out <matrix.json>]',
    '',
    'Local, non-live: FAILURE_MATRIX_COMPLETE when every blocker maps to an existing test + doc + gate with',
    'evidence. Fails closed on an unmapped blocker, stale taxonomy, missing test path, or blocker without',
    'evidence. It authorizes NOTHING live and does not authorize Phase 231. Exit 0 = COMPLETE, 1 = INCOMPLETE.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
  const matrix = buildFailureMatrix(projectRoot);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(matrix, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-failure-mode-matrix-capture',
    overall: matrix.overall,
    authorization: matrix.authorization,
    redactionSafe: true,
    codeCount: matrix.codeCount,
    mappedCount: matrix.mappedCount,
    kinds: matrix.kinds,
    gaps: matrix.gaps,
    failureMatrixDigest: matrix.failureMatrixDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return matrix.overall === 'FAILURE_MATRIX_COMPLETE' ? 0 : 1;
}

process.exit(main());
