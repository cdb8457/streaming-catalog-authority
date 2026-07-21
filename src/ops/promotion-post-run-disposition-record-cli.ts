import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildPostRunDispositionRecord,
  buildPostRunDispositionSkeleton,
  type PostRunDispositionInput,
} from './promotion-post-run-disposition-record.js';

// Phase 234 post-run disposition review RECORD validator CLI. Given the Phase 233 observation record and a
// separately supplied human review of it, it validates that the disposition is well-formed, redaction-safe,
// bound by digest to that observation's one promote-observe-withdraw operation, and coherent -- including the
// unwithdrawn-failure rule, under which a FAILED run may only be ACCEPTED once its withdrawal is proven.
//
// It reviews NOTHING: it forms no judgement, performs no run or remediation, and captures no state. With
// --skeletonout it writes only an all-PENDING blank disposition for a human to complete. It never runs the
// promotion launcher, never reads or writes the real Movies library, never contacts Jellyfin, and never reads
// the secret approval file.
//
// NOT_REVIEWABLE is distinct from INVALID and takes precedence: it means the CHAIN has nothing to review (the
// upstream observation is absent, not genuine, or not RECORDED), not that the supplied disposition is broken.
//
// Exit 0 = ACCEPTED, 1 = INVALID (fail closed), 2 = input read error, 3 = PENDING, 4 = REJECTED,
// 5 = NOT_REVIEWABLE.

const EXIT: Readonly<Record<string, number>> = {
  POST_RUN_DISPOSITION_ACCEPTED: 0,
  POST_RUN_DISPOSITION_INVALID: 1,
  POST_RUN_DISPOSITION_PENDING: 3,
  POST_RUN_DISPOSITION_REJECTED: 4,
  POST_RUN_DISPOSITION_NOT_REVIEWABLE: 5,
};

function usage(): string {
  return [
    'usage: ops:promotion-post-run-disposition-record --observationrecord <phase-233-report.json> \\',
    '         [--disposition <post-run-disposition.json>] [--out <report.json>] [--skeletonout <disposition.json>]',
    '',
    'Local, non-live. Validates a separately supplied human disposition against the Phase 233 observation',
    'record: the observation must be a genuine RECORDED observation that itself performed and captured',
    'nothing; the disposition must be strictly shaped, redaction-safe, bound to that observation digest and',
    'all five operation digests, and coherent -- it must review the outcome that was actually observed, an',
    'acceptance must carry a full review, and a FAILED run may only be accepted once its withdrawal is',
    'proven upstream. --skeletonout writes an all-PENDING blank disposition; it pre-affirms nothing.',
    '',
    'It reviews, performs, captures, and remediates nothing: reviewedByThisTool and performedByThisTool are',
    'false. NOT_REVIEWABLE means the chain has nothing to review and no disposition can override it.',
    'Exit 0 = ACCEPTED, 1 = INVALID, 2 = input error, 3 = PENDING, 4 = REJECTED, 5 = NOT_REVIEWABLE.',
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
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const skeletonOut = valueAfter(args, '--skeletonout');
  const input: PostRunDispositionInput = {};
  const map: Array<[keyof PostRunDispositionInput, string]> = [
    ['observationRecord', '--observationrecord'], ['disposition', '--disposition'],
  ];
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }

  // Fail closed: a skeleton is only emitted for a genuine, RECORDED observation.
  const skeleton = skeletonOut ? buildPostRunDispositionSkeleton(input.observationRecord) : null;
  if (skeletonOut && skeleton) writeJson(skeletonOut, skeleton);

  const report = buildPostRunDispositionRecord(input);
  if (out) writeJson(out, report);
  console.log(JSON.stringify({
    report: 'phase-234-promotion-post-run-disposition-record-capture',
    overall: report.overall,
    recordedDisposition: report.recordedDisposition,
    dispositionAccepted: report.dispositionAccepted,
    observationReviewable: report.observationReviewable,
    reviewedByThisTool: report.reviewedByThisTool,
    performedByThisTool: report.performedByThisTool,
    capturedByThisTool: report.capturedByThisTool,
    redactionSafe: true,
    dispositionWellFormed: report.dispositionWellFormed,
    dispositionRedactionSafe: report.dispositionRedactionSafe,
    dispositionBound: report.dispositionBound,
    dispositionCoherent: report.dispositionCoherent,
    reviewedOutcome: report.reviewedOutcome,
    reviewedWithdrawal: report.reviewedWithdrawal,
    withdrawalProvenUpstream: report.withdrawalProvenUpstream,
    boundDigests: report.boundDigests,
    fieldStates: report.fieldStates,
    boundary: report.boundary,
    blockers: report.blockers,
    dispositionDigest: report.dispositionDigest,
    ...(out ? { outputWritten: true } : {}),
    ...(skeletonOut ? { skeletonWritten: skeleton !== null } : {}),
  }, null, 2));
  return EXIT[report.overall] ?? 1;
}

process.exit(main());
