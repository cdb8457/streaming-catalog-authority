import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildOperationClosureRecord,
  buildOperationClosureSkeleton,
  type OperationClosureInput,
} from './promotion-operation-closure-record.js';

// Phase 235 operation closure / archival RECORD validator CLI. Given the Phase 234 disposition record and a
// separately supplied human closure record, it validates that the closure is well-formed, redaction-safe, bound
// by digest to that disposition's one promote-observe-withdraw operation, and coherent -- including the
// archival rule, under which closure is archival and never erasure.
//
// It closes, archives, purges and reviews NOTHING: closedByThisTool, archivedByThisTool and purgedByThisTool
// are false. With --skeletonout it writes only an all-PENDING blank closure for a human to complete. It never
// runs the promotion launcher, never reads or writes the real Movies library, never contacts Jellyfin, and
// never reads the secret approval file.
//
// NOT_CLOSEABLE is distinct from INVALID and takes precedence: it means the CHAIN has nothing to close (the
// upstream disposition is absent, not genuine, or not ACCEPTED), not that the supplied closure is broken.
//
// Exit 0 = CLOSED, 1 = INVALID (fail closed), 2 = input read error, 3 = PENDING, 4 = HELD_OPEN,
// 5 = NOT_CLOSEABLE.

const EXIT: Readonly<Record<string, number>> = {
  OPERATION_CLOSURE_CLOSED: 0,
  OPERATION_CLOSURE_INVALID: 1,
  OPERATION_CLOSURE_PENDING: 3,
  OPERATION_CLOSURE_HELD_OPEN: 4,
  OPERATION_CLOSURE_NOT_CLOSEABLE: 5,
};

function usage(): string {
  return [
    'usage: ops:promotion-operation-closure-record --dispositionrecord <phase-234-report.json> \\',
    '         [--closure <operation-closure.json>] [--out <report.json>] [--skeletonout <closure.json>]',
    '',
    'Local, non-live. Validates a separately supplied human closure record against the Phase 234 disposition',
    'record: the disposition must be a genuine ACCEPTED review that itself reviewed and performed nothing; the',
    'closure must be strictly shaped, redaction-safe, bound to that disposition digest and all five operation',
    'digests, and coherent -- it must close the outcome that was actually dispositioned, and closure is',
    'ARCHIVAL, NEVER ERASURE: no valid record may claim the evidence was purged, and closing requires the',
    'evidence archived out-of-band, these chain digests recorded alongside it, and no outstanding remediation.',
    'HELD_OPEN is always available. --skeletonout writes an all-PENDING blank closure; it pre-affirms nothing.',
    '',
    'It closes, archives, purges and reviews nothing: closedByThisTool and purgedByThisTool are false.',
    'NOT_CLOSEABLE means the chain has nothing to close and no closure record can override it.',
    'Exit 0 = CLOSED, 1 = INVALID, 2 = input error, 3 = PENDING, 4 = HELD_OPEN, 5 = NOT_CLOSEABLE.',
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
  const input: OperationClosureInput = {};
  const map: Array<[keyof OperationClosureInput, string]> = [
    ['dispositionRecord', '--dispositionrecord'], ['closure', '--closure'],
  ];
  try {
    for (const [key, flag] of map) {
      const p = valueAfter(args, flag);
      if (p !== undefined) (input as Record<string, unknown>)[key] = readJson(p, key);
    }
  } catch (err) { console.error((err as Error).message); return 2; }

  // Fail closed: a skeleton is only emitted for a genuine, ACCEPTED disposition.
  const skeleton = skeletonOut ? buildOperationClosureSkeleton(input.dispositionRecord) : null;
  if (skeletonOut && skeleton) writeJson(skeletonOut, skeleton);

  const report = buildOperationClosureRecord(input);
  if (out) writeJson(out, report);
  console.log(JSON.stringify({
    report: 'phase-235-promotion-operation-closure-record-capture',
    overall: report.overall,
    recordedClosure: report.recordedClosure,
    operationClosed: report.operationClosed,
    dispositionCloseable: report.dispositionCloseable,
    closedByThisTool: report.closedByThisTool,
    archivedByThisTool: report.archivedByThisTool,
    purgedByThisTool: report.purgedByThisTool,
    redactionSafe: true,
    closureWellFormed: report.closureWellFormed,
    closureRedactionSafe: report.closureRedactionSafe,
    closureBound: report.closureBound,
    closureCoherent: report.closureCoherent,
    closedOutcome: report.closedOutcome,
    archivalAffirmed: report.archivalAffirmed,
    boundDigests: report.boundDigests,
    fieldStates: report.fieldStates,
    boundary: report.boundary,
    blockers: report.blockers,
    closureDigest: report.closureDigest,
    ...(out ? { outputWritten: true } : {}),
    ...(skeletonOut ? { skeletonWritten: skeleton !== null } : {}),
  }, null, 2));
  return EXIT[report.overall] ?? 1;
}

process.exit(main());
