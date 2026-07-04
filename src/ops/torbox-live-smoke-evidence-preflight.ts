import {
  isTorBoxLiveSmokeOperation,
  isTorBoxLiveSmokeProbe,
  TORBOX_LIVE_SMOKE_CATEGORIES,
  TORBOX_LIVE_SMOKE_OPERATIONS,
  TORBOX_LIVE_SMOKE_PROBES,
  torBoxLiveSmokeOperationForProbe,
} from './torbox-live-smoke-labels.js';

export type TorBoxLiveSmokeEvidenceInputErrorCode =
  | 'EVIDENCE_FILE_READ_FAILED'
  | 'EVIDENCE_FILE_TOO_LARGE'
  | 'EVIDENCE_JSON_MALFORMED'
  | 'EVIDENCE_OBJECT_REQUIRED';

export type TorBoxLiveSmokeEvidenceFindingLevel = 'pass' | 'warn' | 'fail';

export interface TorBoxLiveSmokeEvidenceFinding {
  readonly level: TorBoxLiveSmokeEvidenceFindingLevel;
  readonly code: string;
  readonly field?: string;
  readonly message: string;
}

export interface TorBoxLiveSmokeEvidenceSummary {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
  readonly total: number;
}

export interface TorBoxLiveSmokeEvidencePreflightReport {
  readonly report: 'phase-44-torbox-live-smoke-evidence-preflight';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly purpose: 'verify-phase-43-torbox-live-smoke-evidence-shape';
  readonly evidenceInput: 'single-user-supplied-json-file';
  readonly evidenceValuesEchoed: false;
  readonly liveTorBoxContact: false;
  readonly closesLiveSmokeReview: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly reviewReadiness: 'ready-for-review' | 'not-ready-for-review';
  readonly findings: readonly TorBoxLiveSmokeEvidenceFinding[];
  readonly summary: TorBoxLiveSmokeEvidenceSummary;
}

const ROOT_KEYS = [
  'report',
  'phase',
  'ok',
  'liveSmokeAttempted',
  'wouldContactTorBox',
  'command',
  'mode',
  'probe',
  'operation',
  'category',
  'evidence',
  'notes',
] as const;

const EVIDENCE_KEYS = ['statuses', 'counts', 'credentialFile', 'scopedRef'] as const;
const COUNT_KEYS = [
  'serviceStatusChecks',
  'hosterMetadataChecks',
  'cacheAvailabilityChecks',
  'availabilityHits',
  'availabilityMisses',
  'availabilityUnknown',
] as const;

const STATUSES = ['available', 'unavailable', 'unknown'] as const;

export function buildTorBoxLiveSmokeEvidencePreflightReport(
  evidence: Record<string, unknown>,
): TorBoxLiveSmokeEvidencePreflightReport {
  const findings: TorBoxLiveSmokeEvidenceFinding[] = [];

  findings.push(...requiredLiteral(evidence, 'report', 'phase-43-torbox-live-smoke-cli', 'REPORT_NAME_VALID'));
  findings.push(...requiredLiteral(evidence, 'phase', 43, 'PHASE_VALID'));
  findings.push(...requiredBoolean(evidence, 'ok', 'OK_BOOLEAN_PRESENT'));
  findings.push(...requiredLiteral(evidence, 'liveSmokeAttempted', true, 'LIVE_SMOKE_ATTEMPTED_TRUE'));
  findings.push(...requiredLiteral(evidence, 'wouldContactTorBox', true, 'WOULD_CONTACT_TORBOX_TRUE'));
  findings.push(...requiredLiteral(evidence, 'command', 'smoke:torbox-readonly', 'COMMAND_VALID'));
  findings.push(...requiredLiteral(evidence, 'mode', 'live-transport-smoke', 'MODE_VALID'));
  findings.push(enumFinding(evidence.probe, TORBOX_LIVE_SMOKE_PROBES, 'probe', 'PROBE_VALID', 'PROBE_INVALID'));
  findings.push(enumFinding(evidence.operation, TORBOX_LIVE_SMOKE_OPERATIONS, 'operation', 'OPERATION_VALID', 'OPERATION_INVALID'));
  findings.push(enumFinding(evidence.category, TORBOX_LIVE_SMOKE_CATEGORIES, 'category', 'CATEGORY_VALID', 'CATEGORY_INVALID'));
  findings.push(operationMatchesProbeFinding(evidence.probe, evidence.operation));

  findings.push(noUnexpectedKeys(evidence, ROOT_KEYS, 'root'));
  findings.push(validateEvidenceBlock(evidence.evidence));
  findings.push(validateNotes(evidence.notes));

  findings.push(warn('O4_REMAINS_DEFERRED', 'evidence', 'O4 production custodian acceptance remains open/deferred.'));
  findings.push(warn('O5_REMAINS_DEFERRED', 'evidence', 'O5 managed KEK custody/scheduling remains open/deferred.'));
  findings.push(warn('FILE_CUSTODIAN_NOT_PRODUCTION_KMS', 'evidence', 'FileCustodian remains a hardened reference harness, not production KMS.'));
  findings.push(warn('OPERATOR_REVIEW_STILL_REQUIRED', 'evidence', 'Passing this preflight does not prove TorBox availability or close reviewer signoff.'));

  return fromFindings(findings);
}

export function buildTorBoxLiveSmokeEvidencePreflightInputErrorReport(
  code: TorBoxLiveSmokeEvidenceInputErrorCode,
): TorBoxLiveSmokeEvidencePreflightReport {
  const messages: Record<TorBoxLiveSmokeEvidenceInputErrorCode, string> = {
    EVIDENCE_FILE_READ_FAILED: 'Evidence JSON file could not be read from the supplied path.',
    EVIDENCE_FILE_TOO_LARGE: 'Evidence JSON file exceeds the preflight size limit.',
    EVIDENCE_JSON_MALFORMED: 'Evidence input is not valid JSON.',
    EVIDENCE_OBJECT_REQUIRED: 'Evidence JSON must be an object, not an array or primitive.',
  };
  return fromFindings([fail(code, 'evidence', messages[code])]);
}

export function parseTorBoxLiveSmokeEvidenceJson(
  jsonText: string,
): Record<string, unknown> | TorBoxLiveSmokeEvidenceInputErrorCode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripLeadingUtf8Bom(jsonText)) as unknown;
  } catch {
    return 'EVIDENCE_JSON_MALFORMED';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'EVIDENCE_OBJECT_REQUIRED';
  return parsed as Record<string, unknown>;
}

export function formatTorBoxLiveSmokeEvidencePreflightJson(report: TorBoxLiveSmokeEvidencePreflightReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatTorBoxLiveSmokeEvidencePreflightText(report: TorBoxLiveSmokeEvidencePreflightReport): string {
  return [
    'Phase 44 TorBox live smoke evidence preflight',
    '',
    'Purpose: verify Phase 43 live smoke evidence shape',
    `Redaction-safe: ${report.redactionSafe ? 'yes' : 'no'}`,
    `Evidence values echoed: ${report.evidenceValuesEchoed ? 'yes' : 'no'}`,
    `Live TorBox contact: ${report.liveTorBoxContact ? 'true' : 'false'}`,
    `Closes live smoke review: ${report.closesLiveSmokeReview ? 'true' : 'false'}`,
    `O4 status: ${report.o4Status}`,
    `O5 status: ${report.o5Status}`,
    `FileCustodian: ${report.fileCustodianStatus}`,
    `Review readiness: ${report.reviewReadiness}`,
    `Summary: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    'Findings:',
    ...report.findings.map((finding) => {
      const field = finding.field ? ` field=${finding.field}` : '';
      return `- ${finding.level.toUpperCase()} ${finding.code}${field}: ${finding.message}`;
    }),
    '',
  ].join('\n');
}

export function torBoxLiveSmokeEvidenceReportHasFailures(report: TorBoxLiveSmokeEvidencePreflightReport): boolean {
  return report.summary.fail > 0;
}

function validateEvidenceBlock(value: unknown): TorBoxLiveSmokeEvidenceFinding {
  if (!isRecord(value)) return fail('EVIDENCE_BLOCK_REQUIRED', 'evidence', 'Evidence block must be an object.');
  const problems: string[] = [];
  const unexpected = unexpectedKeys(value, EVIDENCE_KEYS);
  if (unexpected > 0) problems.push('unexpected evidence fields');
  if (!Array.isArray(value.statuses) || value.statuses.length === 0 || !value.statuses.every((item) => inList(item, STATUSES))) {
    problems.push('invalid statuses');
  }
  if (!isRecord(value.counts)) {
    problems.push('missing counts');
  } else {
    if (unexpectedKeys(value.counts, COUNT_KEYS) > 0) problems.push('unexpected count fields');
    for (const key of COUNT_KEYS) {
      if (!isNonNegativeInteger(value.counts[key])) problems.push(`invalid count ${key}`);
    }
  }
  if (value.credentialFile !== 'configured') problems.push('credentialFile must be configured');
  if (value.scopedRef !== 'present' && value.scopedRef !== 'not-recorded') problems.push('invalid scopedRef marker');
  return problems.length === 0
    ? pass('EVIDENCE_BLOCK_VALID', 'evidence', 'Evidence block has the Phase 43 redaction-safe shape.')
    : fail('EVIDENCE_BLOCK_INVALID', 'evidence', 'Evidence block does not match the Phase 43 redaction-safe shape.');
}

function validateNotes(value: unknown): TorBoxLiveSmokeEvidenceFinding {
  if (!Array.isArray(value)) return fail('NOTES_ARRAY_REQUIRED', 'notes', 'Notes must be an array.');
  if (!value.every((item) => typeof item === 'string')) return fail('NOTES_INVALID', 'notes', 'Notes must contain strings only.');
  return pass('NOTES_PRESENT', 'notes', 'Notes are present without being echoed by this preflight.');
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: unknown,
  passCode: string,
): TorBoxLiveSmokeEvidenceFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} matches the expected Phase 43 value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must match the expected Phase 43 value.`)];
}

function requiredBoolean(
  object: Record<string, unknown>,
  field: string,
  passCode: string,
): TorBoxLiveSmokeEvidenceFinding[] {
  return [typeof object[field] === 'boolean'
    ? pass(passCode, field, `${field} is boolean.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must be boolean.`)];
}

function enumFinding(
  value: unknown,
  allowed: readonly string[],
  field: string,
  passCode: string,
  failCode: string,
): TorBoxLiveSmokeEvidenceFinding {
  return inList(value, allowed)
    ? pass(passCode, field, `${field} is allowlisted.`)
    : fail(failCode, field, `${field} must be an allowlisted fixed value.`);
}

function operationMatchesProbeFinding(probe: unknown, operation: unknown): TorBoxLiveSmokeEvidenceFinding {
  if (!isTorBoxLiveSmokeProbe(probe) || !isTorBoxLiveSmokeOperation(operation)) {
    return fail('PROBE_OPERATION_PAIR_INVALID', 'operation', 'probe and operation must be allowlisted before pair validation.');
  }
  return torBoxLiveSmokeOperationForProbe(probe) === operation
    ? pass('PROBE_OPERATION_PAIR_VALID', 'operation', 'operation matches the fixed probe mapping.')
    : fail('PROBE_OPERATION_PAIR_INVALID', 'operation', 'operation must match the fixed probe mapping.');
}

function noUnexpectedKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): TorBoxLiveSmokeEvidenceFinding {
  return unexpectedKeys(object, allowed) === 0
    ? pass('NO_UNEXPECTED_FIELDS', field, 'No unexpected evidence fields are present.')
    : fail('UNEXPECTED_FIELDS_PRESENT', field, 'Unexpected fields are present.');
}

function fromFindings(findings: readonly TorBoxLiveSmokeEvidenceFinding[]): TorBoxLiveSmokeEvidencePreflightReport {
  const summary = summarize(findings);
  return {
    report: 'phase-44-torbox-live-smoke-evidence-preflight',
    version: 1,
    redactionSafe: true,
    purpose: 'verify-phase-43-torbox-live-smoke-evidence-shape',
    evidenceInput: 'single-user-supplied-json-file',
    evidenceValuesEchoed: false,
    liveTorBoxContact: false,
    closesLiveSmokeReview: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    reviewReadiness: summary.fail === 0 ? 'ready-for-review' : 'not-ready-for-review',
    findings,
    summary,
  };
}

function summarize(findings: readonly TorBoxLiveSmokeEvidenceFinding[]): TorBoxLiveSmokeEvidenceSummary {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function unexpectedKeys(object: Record<string, unknown>, allowed: readonly string[]): number {
  return Object.keys(object).filter((key) => !allowed.includes(key)).length;
}

function inList(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function stripLeadingUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

function pass(code: string, field: string, message: string): TorBoxLiveSmokeEvidenceFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): TorBoxLiveSmokeEvidenceFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): TorBoxLiveSmokeEvidenceFinding {
  return { level: 'warn', code, field, message };
}
