import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildExecutionAuthorization, type ExecutionAuthorizationInput } from './promotion-execution-authorization.js';

// Phase 231 one-shot execution-authorization gate CLI. Given the prepared P227-A non-live evidence
// (approval build + validate attestations, the live-preflight plan + its report, and the report's
// self-digest verification), it validates and cross-binds them and emits a NOT-authorized,
// human-completable template bound by digest to exactly one promote-observe-withdraw operation.
//
// It authorizes NOTHING: authorization is NONE and the run stays a separate human step. It never runs
// the promotion launcher, never reads or writes the real Movies library, never contacts Jellyfin, and
// never reads the secret approval file. Exit 0 = EXECUTION_AUTHORIZATION_TEMPLATE_READY, 1 = BLOCKED,
// 2 = input read error.

function usage(): string {
  return [
    'usage: ops:promotion-execution-authorization --approvalevidence <f> --approvalvalidation <f> \\',
    '         --preflightplan <f> --preflightreport <f> --preflightselfdigest <f> [--out <report.json>]',
    '',
    'Local, non-live: EXECUTION_AUTHORIZATION_TEMPLATE_READY only when the approval build + validate',
    'attestations recompute, are READY, and share the same one-item bindings; the live-preflight report',
    'recomputes, is PREFLIGHT_PLAN_VALID / PENDING / NONE and re-derives from the supplied plan; the',
    'preflight self-digest is ALL_VERIFIED and is the genuine verification of that report; and the plan',
    'binds by digest to exactly ONE item matching the approval evidence. It authorizes NOTHING live and',
    'does not perform the promotion. Exit 0 = READY, 1 = BLOCKED, 2 = input error.',
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
  const input: ExecutionAuthorizationInput = {};
  const map: Array<[keyof ExecutionAuthorizationInput, string]> = [
    ['approvalEvidence', '--approvalevidence'], ['approvalValidation', '--approvalvalidation'],
    ['preflightPlan', '--preflightplan'], ['preflightReport', '--preflightreport'],
    ['preflightSelfDigest', '--preflightselfdigest'],
  ];
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }

  const report = buildExecutionAuthorization(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-231-promotion-execution-authorization-capture',
    overall: report.overall,
    authorization: report.authorization,
    status: report.status,
    redactionSafe: true,
    approvalEvidenceValid: report.approvalEvidenceValid,
    approvalValidationBound: report.approvalValidationBound,
    preflightValid: report.preflightValid,
    preflightRederived: report.preflightRederived,
    selfDigestBound: report.selfDigestBound,
    operationBound: report.operationBound,
    boundDigests: report.boundDigests,
    templateEmitted: report.template !== null,
    boundary: report.boundary,
    blockers: report.blockers,
    authorizationDigest: report.authorizationDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return report.overall === 'EXECUTION_AUTHORIZATION_TEMPLATE_READY' ? 0 : 1;
}

process.exit(main());
