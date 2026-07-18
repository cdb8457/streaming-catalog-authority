import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildReviewAuthorization, type ReviewAuthorizationInput } from './promotion-review-authorization.js';

// Offline coordinator review-authorization scaffold CLI. NOT-authorized unless valid offline evidence (the
// terminal readiness v2 record + the review matrix) is supplied; then it includes the exact reviewed
// commit/test matrix placeholders. LOCAL_REVIEW_AUTHORIZED does NOT authorize Phase 231 or any live
// promotion. Never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-review-authorization --readiness <f> --terminalclosure <f> --commitrangeclosure <f> \\',
    '         --transcriptverification <f> --reviewmatrix <f> [--out <report.json>]',
    '',
    'Local, non-live: LOCAL_REVIEW_AUTHORIZED only when the readiness v2 record recomputes and is CONFIRMED,',
    'the terminal-closure / commit-range-closure / transcript-verification evidence recomputes and is chained',
    'to it by digest, and the review matrix (READY) binds EXACTLY to the authoritative base/head/ordered',
    'commit shas/test set. It authorizes NOTHING live and does not authorize Phase 231. Exit 0 =',
    'LOCAL_REVIEW_AUTHORIZED, 1 = LOCAL_REVIEW_NOT_AUTHORIZED.',
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
  const input: ReviewAuthorizationInput = {};
  const map: Array<[keyof ReviewAuthorizationInput, string]> = [
    ['readiness', '--readiness'], ['terminalClosure', '--terminalclosure'], ['commitRangeClosure', '--commitrangeclosure'],
    ['transcriptVerification', '--transcriptverification'], ['reviewMatrix', '--reviewmatrix'],
  ];
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }
  const report = buildReviewAuthorization(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-review-authorization-capture',
    overall: report.overall,
    authorization: report.authorization,
    redactionSafe: true,
    evidenceValid: report.evidenceValid,
    matrixValid: report.matrixValid,
    contextBound: report.contextBound,
    reviewedCommitCount: report.reviewedCommitCount,
    reviewedTestCount: report.reviewedTestCount,
    boundDigests: report.boundDigests,
    boundary: report.boundary,
    blockers: report.blockers,
    authorizationDigest: report.authorizationDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return report.overall === 'LOCAL_REVIEW_AUTHORIZED' ? 0 : 1;
}

process.exit(main());
