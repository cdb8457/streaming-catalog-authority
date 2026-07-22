import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AUDIT_PHASES, buildAuditClosurePacket, type AuditClosurePacketInput } from './promotion-audit-closure-packet.js';

// Phase 241 final audit / closure packet CLI. Given any prefix of the ten chain reports (231-240), it
// re-derives every digest, link, operation identity and per-phase semantic success state in one pass, and
// emits the fixed proof-limit matrix alongside the verdict.
//
// It CREATES NOTHING: no approval, no execution, no observation, no custody, no archive, no judgment. It never
// runs the promotion launcher, reads or writes the real Movies library, contacts Jellyfin, or reads the secret
// approval file.
//
// Absence is normal: a chain that legitimately stops partway is AUDIT_OPEN with no blockers, not an error.
//
// Exit 0 = AUDIT_CLOSED (all ten present, sound, cross-bound and terminal), 1 = AUDIT_INVALID (fail closed),
// 2 = input read error, 3 = AUDIT_OPEN (consistent as far as it goes), 5 = NOT_ELIGIBLE (no Phase 231 anchor).

const EXIT: Readonly<Record<string, number>> = {
  AUDIT_CLOSED: 0,
  AUDIT_INVALID: 1,
  AUDIT_OPEN: 3,
  NOT_ELIGIBLE: 5,
};

function usage(): string {
  return [
    'usage: ops:promotion-audit-closure-packet [--phase231 <f>] [--phase232 <f>] ... [--phase240 <f>] \\',
    '         [--out <report.json>]',
    '',
    'Local, non-live. Audits the whole promotion record chain in one pass: every supplied report must recompute',
    'its own self-digest, be SEMANTICALLY sound by its OWN success booleans and constants with no findings, link',
    'to its parent, and describe the one operation the Phase 231 template anchors. The supplied set must be a',
    'contiguous prefix from Phase 231.',
    '',
    'A green headline is never enough: a self-digest is not a signature, so each phase is checked on its whole',
    'body. A genuine but non-terminal report is not a defect -- it caps the verdict at AUDIT_OPEN.',
    '',
    'The report carries a fixed PROOF-LIMIT MATRIX pairing each phase green state with what it does NOT',
    'establish, so the caveat travels with the artifact. AUDIT_CLOSED means the records are mutually consistent;',
    'it does NOT mean the promotion happened, was correct, or was authorized by anyone in particular.',
    '',
    'It creates nothing and authorizes nothing.',
    'Exit 0 = AUDIT_CLOSED, 1 = AUDIT_INVALID, 2 = input error, 3 = AUDIT_OPEN, 5 = NOT_ELIGIBLE.',
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
  const reports: Record<string, unknown> = {};
  try {
    for (const phase of AUDIT_PHASES) {
      const p = valueAfter(args, `--phase${phase}`);
      if (p !== undefined) reports[String(phase)] = readJson(p, `phase${phase}`);
    }
  } catch (err) { console.error((err as Error).message); return 2; }

  const input: AuditClosurePacketInput = Object.keys(reports).length > 0 ? { reports } : {};
  const report = buildAuditClosurePacket(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-241-promotion-audit-closure-packet-capture',
    overall: report.overall,
    terminalPhase: report.terminalPhase,
    chainComplete: report.chainComplete,
    auditClosed: report.auditClosed,
    identityAnchored: report.identityAnchored,
    suppliedCount: report.suppliedCount,
    approvalCreatedByThisTool: report.approvalCreatedByThisTool,
    executionPerformedByThisTool: report.executionPerformedByThisTool,
    observationCapturedByThisTool: report.observationCapturedByThisTool,
    custodyHeldByThisTool: report.custodyHeldByThisTool,
    archivedByThisTool: report.archivedByThisTool,
    judgmentFormedByThisTool: report.judgmentFormedByThisTool,
    redactionSafe: true,
    phases: report.phases,
    operationDigests: report.operationDigests,
    chainDigests: report.chainDigests,
    proofLimitCount: report.proofLimits.length,
    boundary: report.boundary,
    blockers: report.blockers,
    auditDigest: report.auditDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return EXIT[report.overall] ?? 1;
}

process.exit(main());
