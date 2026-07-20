import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildOperatorAcceptanceTrace, type OperatorAcceptanceTraceInput } from './promotion-operator-acceptance-trace.js';

// Offline operator acceptance trace CLI. Aggregates the approval-request packet + live preflight plan +
// no-live authorization guard + coordinator review checklist v2 into one redaction-safe trace. It authorizes
// nothing (status PENDING). Never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-operator-acceptance-trace --approvalrequest <f> --livepreflight <f> --noliveguard <f> --checklistv2 <f> [--out <trace.json>]',
    '',
    'Local, non-live: ACCEPTANCE_TRACE_READY when every component re-verifies (self-digest recompute + green',
    'status), no component claims a live authorization, and every preflight item is still PENDING. It does NOT',
    'approve anything and does not authorize Phase 231 or live promotion. Exit 0 = READY, 1 = BLOCKED.',
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
  const input: OperatorAcceptanceTraceInput = {};
  try {
    const ar = valueAfter(args, '--approvalrequest');
    const lp = valueAfter(args, '--livepreflight');
    const ng = valueAfter(args, '--noliveguard');
    const cv = valueAfter(args, '--checklistv2');
    if (ar !== undefined) (input as Record<string, unknown>).approvalRequest = readJson(ar, 'approvalRequest');
    if (lp !== undefined) (input as Record<string, unknown>).livePreflight = readJson(lp, 'livePreflight');
    if (ng !== undefined) (input as Record<string, unknown>).noLiveGuard = readJson(ng, 'noLiveGuard');
    if (cv !== undefined) (input as Record<string, unknown>).reviewChecklistV2 = readJson(cv, 'reviewChecklistV2');
  } catch (err) { console.error((err as Error).message); return 2; }
  const trace = buildOperatorAcceptanceTrace(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(trace, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-operator-acceptance-trace-capture',
    overall: trace.overall,
    authorization: trace.authorization,
    status: trace.status,
    redactionSafe: true,
    decision: trace.decision,
    components: trace.components,
    reportIds: trace.reportIds,
    selfDigestOverall: trace.selfDigestOverall,
    blockers: trace.blockers,
    traceDigest: trace.traceDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return trace.overall === 'ACCEPTANCE_TRACE_READY' ? 0 : 1;
}

process.exit(main());
