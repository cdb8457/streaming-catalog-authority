import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { reviewPromotionEvidence } from './promotion-evidence-review.js';

// Offline reviewer CLI for a phase-230-real-library-promotion evidence file. Reads the JSON,
// runs the review, writes a redaction-safe review record. Never promotes, never touches the
// real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-evidence-review --evidence <promotion-evidence.json> [--out <review.json>]',
    '',
    'Local, non-live: validates that a produced promotion evidence report is well-formed, redaction-safe,',
    'complete, internally consistent, and that its evidenceDigest recomputes. Exit 0 = accepted, 1 = rejected.',
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
  const evidence = valueAfter(args, '--evidence');
  const out = valueAfter(args, '--out');
  if (!evidence) {
    console.error(usage());
    return 2;
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(readFileSync(evidence, 'utf8'));
  } catch {
    console.error('evidence file is missing or not valid JSON');
    return 2;
  }
  const review = reviewPromotionEvidence(candidate);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(review, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-evidence-review-capture',
    ok: review.ok,
    status: review.status,
    redactionSafe: true,
    subjectStatus: review.subjectStatus,
    checks: review.checks,
    problems: review.problems,
    reviewDigest: review.reviewDigest,
    ...(out ? { outputFile: out } : {}),
  }, null, 2));
  return review.ok ? 0 : 1;
}

process.exit(main());
