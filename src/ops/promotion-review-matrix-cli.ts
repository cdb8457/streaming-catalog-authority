import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildReviewMatrix, type ReviewMatrixInput } from './promotion-review-matrix.js';

// Offline coordinator review matrix CLI. Emits a redaction-safe commit x test review scaffold with PENDING
// human-sign-off placeholders. It authorizes nothing -- a completed matrix does NOT authorize Phase 231 or
// any live promotion. Never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-review-matrix --range <range.json> [--out <matrix.json>]',
    '',
    'range.json: { "base": <sha40>, "head": <sha40>, "commits": [{ "sha": <sha40> }...], "requiredTests": [<label>...] }',
    '',
    'Local, non-live: REVIEW_MATRIX_READY when the range + test axes are well-formed; every review cell is a',
    'PENDING placeholder for a human. It authorizes NOTHING and does not authorize Phase 231. Exit 0 = READY,',
    '1 = BLOCKED.',
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
  let input: ReviewMatrixInput = {};
  try {
    const range = valueAfter(args, '--range');
    if (range !== undefined) input = readJson(range, 'range') as ReviewMatrixInput;
  } catch (err) { console.error((err as Error).message); return 2; }
  const matrix = buildReviewMatrix(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(matrix, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-review-matrix-capture',
    overall: matrix.overall,
    authorization: matrix.authorization,
    redactionSafe: true,
    base: matrix.base,
    head: matrix.head,
    commitCount: matrix.commitCount,
    testCount: matrix.testCount,
    placeholderCount: matrix.placeholderCount,
    boundary: matrix.boundary,
    blockers: matrix.blockers,
    reviewMatrixDigest: matrix.reviewMatrixDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return matrix.overall === 'REVIEW_MATRIX_READY' ? 0 : 1;
}

process.exit(main());
