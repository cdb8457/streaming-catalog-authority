import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildExecutionAuthorizationRecord,
  buildExecutionAuthorizationRecordSkeleton,
  type ExecutionAuthorizationRecordInput,
} from './promotion-execution-authorization-record.js';

// Phase 232 human execution-authorization RECORD validator CLI. Given the Phase 231 digest-bound gate
// report and a separately supplied operator decision record, it validates that the record is well-formed,
// redaction-safe, bound by digest to the gate's one promote-observe-withdraw operation, and internally
// coherent -- and reports the decision the human recorded.
//
// It creates and infers NOTHING: with --skeletonout it writes only an all-PENDING blank record for a human
// to complete. It never runs the promotion launcher, never reads or writes the real Movies library, never
// contacts Jellyfin, and never reads the secret approval file. Even the APPROVED outcome performs no run:
// execution stays NOT_PERFORMED and captured artifacts stay NONE.
//
// Exit 0 = APPROVED (a valid, digest-bound human approval record exists), 1 = INVALID (fail closed),
// 2 = input read error, 3 = PENDING (valid, no authorization recorded), 4 = DECLINED (valid, refused).

const EXIT: Readonly<Record<string, number>> = {
  EXECUTION_AUTHORIZATION_RECORD_APPROVED: 0,
  EXECUTION_AUTHORIZATION_RECORD_INVALID: 1,
  EXECUTION_AUTHORIZATION_RECORD_PENDING: 3,
  EXECUTION_AUTHORIZATION_RECORD_DECLINED: 4,
};

function usage(): string {
  return [
    'usage: ops:promotion-execution-authorization-record --gate <phase-231-report.json> \\',
    '         [--record <operator-decision-record.json>] [--out <report.json>] [--skeletonout <record.json>]',
    '',
    'Local, non-live. Validates a separately supplied human decision record against the Phase 231',
    'digest-bound execution-authorization template: strict shape, redaction-safe, bound to the gate by its',
    'authorization digest AND all five operation digests, and coherent with the recorded decision. Post-run',
    'fields must stay PENDING -- this records a decision, never an execution. --skeletonout writes an',
    'all-PENDING blank record for a human to complete; it never produces a decided record.',
    '',
    'It authorizes no run: execution is NOT_PERFORMED and captured artifacts are NONE.',
    'Exit 0 = APPROVED, 1 = INVALID, 2 = input error, 3 = PENDING, 4 = DECLINED.',
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
  const input: ExecutionAuthorizationRecordInput = {};
  const map: Array<[keyof ExecutionAuthorizationRecordInput, string]> = [['gate', '--gate'], ['record', '--record']];
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }

  // Fail closed: a skeleton is only emitted for a valid, TEMPLATE_READY, authorized-nothing gate.
  const skeleton = skeletonOut ? buildExecutionAuthorizationRecordSkeleton(input.gate) : null;
  if (skeletonOut && skeleton) writeJson(skeletonOut, skeleton);

  const report = buildExecutionAuthorizationRecord(input);
  if (out) writeJson(out, report);
  console.log(JSON.stringify({
    report: 'phase-232-promotion-execution-authorization-record-capture',
    overall: report.overall,
    recordedDecision: report.recordedDecision,
    authorizationRecorded: report.authorizationRecorded,
    execution: report.execution,
    capturedArtifacts: report.capturedArtifacts,
    redactionSafe: true,
    gateValid: report.gateValid,
    recordWellFormed: report.recordWellFormed,
    recordRedactionSafe: report.recordRedactionSafe,
    recordBound: report.recordBound,
    decisionCoherent: report.decisionCoherent,
    boundDigests: report.boundDigests,
    fieldStates: report.fieldStates,
    boundary: report.boundary,
    blockers: report.blockers,
    recordDigest: report.recordDigest,
    ...(out ? { outputWritten: true } : {}),
    ...(skeletonOut ? { skeletonWritten: skeleton !== null } : {}),
  }, null, 2));
  return EXIT[report.overall] ?? 1;
}

process.exit(main());
