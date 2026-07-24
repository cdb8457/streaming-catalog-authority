import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildPostRunObservationRecord,
  buildPostRunObservationSkeleton,
  type PostRunObservationInput,
} from './promotion-post-run-observation-record.js';

// Phase 233 post-run observation and withdrawal RECORD validator CLI. Given the Phase 232 human
// execution-authorization record and a separately supplied human observation of what actually happened, it
// validates that the observation is well-formed, redaction-safe, bound by digest to that authorization's one
// promote-observe-withdraw operation, and internally coherent -- including the withdrawal proof, which holds
// only when the observed state after withdrawal equals the observed state before the run.
//
// It observes NOTHING: it performs no run, captures no state, and triggers no withdrawal. With --skeletonout
// it writes only a NOT_RUN, all-PENDING blank observation for a human to complete. It never runs the promotion
// launcher, never reads or writes the real Movies library, never contacts Jellyfin, and never reads the secret
// approval file.
//
// Exit 0 = RECORDED (a coherent observation of a real run exists), 1 = INVALID (fail closed),
// 2 = input read error, 3 = PENDING (valid, but nothing was run or observed).

const EXIT: Readonly<Record<string, number>> = {
  POST_RUN_OBSERVATION_RECORDED: 0,
  POST_RUN_OBSERVATION_INVALID: 1,
  POST_RUN_OBSERVATION_PENDING: 3,
};

function usage(): string {
  return [
    'usage: ops:promotion-post-run-observation-record --authorizationrecord <phase-232-report.json> \\',
    '         [--observation <post-run-observation.json>] [--out <report.json>] [--skeletonout <observation.json>]',
    '',
    'Local, non-live. Validates a separately supplied human post-run observation against the Phase 232',
    'authorization record: the authorization must be a genuine APPROVED record that itself performed and',
    'captured nothing; the observation must be strictly shaped, redaction-safe, bound to that record digest',
    'and all five operation digests, and coherent -- NOT_RUN observes nothing, COMPLETED must show an actual',
    'observed change, and a PERFORMED withdrawal must restore the exact observed state from before the run.',
    '--skeletonout writes a NOT_RUN, all-PENDING blank observation; it never claims a run happened.',
    '',
    'It performs, captures, and authorizes nothing: performedByThisTool and capturedByThisTool are false.',
    'Exit 0 = RECORDED, 1 = INVALID, 2 = input error, 3 = PENDING.',
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
  const input: PostRunObservationInput = {};
  const map: Array<[keyof PostRunObservationInput, string]> = [
    ['authorizationRecord', '--authorizationrecord'], ['observation', '--observation'],
  ];
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }

  // Fail closed: a skeleton is only emitted for a genuine, APPROVED authorization record.
  const skeleton = skeletonOut ? buildPostRunObservationSkeleton(input.authorizationRecord) : null;
  if (skeletonOut && skeleton) writeJson(skeletonOut, skeleton);

  const report = buildPostRunObservationRecord(input);
  if (out) writeJson(out, report);
  console.log(JSON.stringify({
    report: 'phase-233-promotion-post-run-observation-record-capture',
    overall: report.overall,
    recordedOutcome: report.recordedOutcome,
    recordedWithdrawal: report.recordedWithdrawal,
    observationRecorded: report.observationRecorded,
    withdrawalProven: report.withdrawalProven,
    performedByThisTool: report.performedByThisTool,
    capturedByThisTool: report.capturedByThisTool,
    redactionSafe: true,
    authorizationValid: report.authorizationValid,
    observationWellFormed: report.observationWellFormed,
    observationRedactionSafe: report.observationRedactionSafe,
    observationBound: report.observationBound,
    observationCoherent: report.observationCoherent,
    boundDigests: report.boundDigests,
    observedStatePresence: report.observedStatePresence,
    boundary: report.boundary,
    blockers: report.blockers,
    observationDigest: report.observationDigest,
    ...(out ? { outputWritten: true } : {}),
    ...(skeletonOut ? { skeletonWritten: skeleton !== null } : {}),
  }, null, 2));
  return EXIT[report.overall] ?? 1;
}

process.exit(main());
