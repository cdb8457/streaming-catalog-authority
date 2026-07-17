import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildReviewTranscript, type ReviewTranscriptInput } from './promotion-review-transcript.js';

// Offline coordinator review-transcript CLI. Records a review from the reviewed commit and an input JSON
// of test results / blockers / remediations into a redaction-safe, deterministic transcript. Never
// promotes, never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-review-transcript --reviewed-commit <sha> [--input <review.json>] [--out <transcript.json>]',
    '',
    'The input JSON may carry { testResults: [{command,passed,failed}], blockers: [], remediations: [] }.',
    'Local, non-live: REVIEW_CLEAN only when the commit is valid, every test passed, and there are no',
    'blockers. Exit 0 = REVIEW_CLEAN, 1 = REVIEW_BLOCKED. Authorizes nothing live.',
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
  const reviewedCommit = valueAfter(args, '--reviewed-commit');
  const inputPath = valueAfter(args, '--input');
  const out = valueAfter(args, '--out');
  if (!reviewedCommit) {
    console.error(usage());
    return 2;
  }
  let fromFile: Partial<ReviewTranscriptInput> = {};
  if (inputPath) {
    try {
      const parsed = JSON.parse(readFileSync(inputPath, 'utf8'));
      if (parsed && typeof parsed === 'object') fromFile = parsed as Partial<ReviewTranscriptInput>;
    } catch {
      console.error('input file is missing or not valid JSON');
      return 2;
    }
  }
  const transcript = buildReviewTranscript({
    reviewedCommit,
    ...(fromFile.testResults ? { testResults: fromFile.testResults } : {}),
    ...(fromFile.blockers ? { blockers: fromFile.blockers } : {}),
    ...(fromFile.remediations ? { remediations: fromFile.remediations } : {}),
  });
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(transcript, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-review-transcript-capture',
    verdict: transcript.verdict,
    authorization: transcript.authorization,
    redactionSafe: true,
    problems: transcript.problems,
    blockers: transcript.blockers,
    transcriptDigest: transcript.transcriptDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return transcript.verdict === 'REVIEW_CLEAN' ? 0 : 1;
}

process.exit(main());
