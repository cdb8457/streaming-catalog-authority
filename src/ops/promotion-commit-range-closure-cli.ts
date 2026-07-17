import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildCommitRangeClosure, type CommitRangeInput } from './promotion-commit-range-closure.js';

// Offline commit-range closure CLI. Categorizes every commit since base by phase/remediation/docs/chore and
// confirms the range is closed. Reads the range from a file -- invokes no git. Never promotes, never touches
// the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-commit-range-closure --in <range.json> [--out <closure.json>]',
    '',
    'The range file is { base, head, commits:[{sha,subject}] }.',
    'Local, non-live: RANGE_CLOSED only when every commit is categorized, every sha is well-formed, and no',
    'subject leaks a path/title. It authorizes NOTHING live and does not authorize Phase 231.',
    'Exit 0 = RANGE_CLOSED, 1 = RANGE_OPEN.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const inPath = valueAfter(args, '--in');
  const out = valueAfter(args, '--out');
  if (inPath === undefined) { console.error(usage()); return 2; }
  let input: CommitRangeInput;
  try { input = JSON.parse(readFileSync(inPath, 'utf8')) as CommitRangeInput; }
  catch { console.error('--in file is missing or not valid JSON'); return 2; }
  const closure = buildCommitRangeClosure(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(closure, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-commit-range-closure-capture',
    overall: closure.overall,
    authorization: closure.authorization,
    redactionSafe: true,
    base: closure.base,
    head: closure.head,
    commitCount: closure.commitCount,
    categories: closure.categories,
    blockers: closure.blockers,
    closureDigest: closure.closureDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return closure.overall === 'RANGE_CLOSED' ? 0 : 1;
}

process.exit(main());
