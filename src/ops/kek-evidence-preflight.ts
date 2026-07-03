export type KekEvidenceRedactionReviewStatus = 'passed' | 'pending' | 'failed' | 'unknown';
export type KekEvidenceFindingLevel = 'pass' | 'warn' | 'fail';

export type KekEvidencePreflightInputErrorCode =
  | 'DESCRIPTOR_FILE_READ_FAILED'
  | 'DESCRIPTOR_FILE_TOO_LARGE'
  | 'DESCRIPTOR_JSON_MALFORMED'
  | 'DESCRIPTOR_OBJECT_REQUIRED';

export interface KekEvidenceDescriptor {
  readonly rewrapPlanEvidenceLabel?: string;
  readonly rotationRecordLabel?: string;
  readonly managedKekCustodyDocumented?: boolean;
  readonly rotationScheduleDocumented?: boolean;
  readonly operatorRunbookDocumented?: boolean;
  readonly alertTriageDocumented?: boolean;
  readonly independentSecretMediaDocumented?: boolean;
  readonly noRawSecretsInEvidence?: boolean;
  readonly residualRiskAccepted?: boolean;
  readonly redactionReviewStatus?: KekEvidenceRedactionReviewStatus;
}

export interface KekEvidencePreflightFinding {
  readonly level: KekEvidenceFindingLevel;
  readonly code: string;
  readonly field?: keyof KekEvidenceDescriptor | 'descriptor';
  readonly message: string;
}

export interface KekEvidencePreflightSummary {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
  readonly total: number;
}

export interface KekEvidencePreflightReport {
  readonly report: 'phase-30-kek-evidence-preflight';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly purpose: 'prepare-o5-managed-kek-custody-and-scheduling-evidence-review';
  readonly descriptorInput: 'single-user-supplied-json-file';
  readonly descriptorValuesEchoed: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly closesO5: false;
  readonly reviewReadiness: 'ready-for-review' | 'not-ready-for-review';
  readonly findings: readonly KekEvidencePreflightFinding[];
  readonly summary: KekEvidencePreflightSummary;
}

const REQUIRED_TRUE_FIELDS = [
  'managedKekCustodyDocumented',
  'rotationScheduleDocumented',
  'operatorRunbookDocumented',
  'alertTriageDocumented',
  'independentSecretMediaDocumented',
  'noRawSecretsInEvidence',
  'residualRiskAccepted',
] as const;

export function buildKekEvidencePreflightReport(descriptor: Record<string, unknown>): KekEvidencePreflightReport {
  const typed = descriptor as KekEvidenceDescriptor;
  const findings: KekEvidencePreflightFinding[] = [];

  for (const field of REQUIRED_TRUE_FIELDS) {
    if (typed[field] === true) findings.push(pass(`${toCode(field)}_DECLARED`, field, `${field} is declared.`));
    else findings.push(fail(`${toCode(field)}_REQUIRED`, field, `${field} must be true before O5 evidence can be reviewed.`));
  }

  if (hasNonEmptyLabel(typed.rewrapPlanEvidenceLabel)) {
    findings.push(pass('REWRAP_PLAN_EVIDENCE_LABEL_PRESENT', 'rewrapPlanEvidenceLabel', 'Rewrap plan evidence is labeled for review.'));
  } else {
    findings.push(fail('REWRAP_PLAN_EVIDENCE_LABEL_REQUIRED', 'rewrapPlanEvidenceLabel', 'A rewrap plan evidence label is required.'));
  }

  if (hasNonEmptyLabel(typed.rotationRecordLabel)) {
    findings.push(pass('ROTATION_RECORD_LABEL_PRESENT', 'rotationRecordLabel', 'Rotation record evidence is labeled for review.'));
  } else {
    findings.push(fail('ROTATION_RECORD_LABEL_REQUIRED', 'rotationRecordLabel', 'A rotation record label is required.'));
  }

  if (typed.redactionReviewStatus === 'passed') {
    findings.push(pass('REDACTION_REVIEW_PASSED', 'redactionReviewStatus', 'Redaction review is marked passed.'));
  } else if (typed.redactionReviewStatus === 'failed') {
    findings.push(fail('REDACTION_REVIEW_FAILED', 'redactionReviewStatus', 'Redaction review must pass before O5 evidence can be reviewed.'));
  } else {
    findings.push(fail('REDACTION_REVIEW_REQUIRED', 'redactionReviewStatus', 'A passed redaction review is required before O5 evidence can be reviewed.'));
  }

  if (!findings.some((finding) => finding.level === 'fail')) {
    findings.push(warn(
      'O5_STILL_REQUIRES_REVIEW',
      'descriptor',
      'Descriptor metadata is complete, but O5 remains open/deferred until separate reviewer and operator acceptance.',
    ));
  }

  findings.push(warn('O4_REMAINS_DEFERRED', 'descriptor', 'O4 production custodian acceptance remains open/deferred.'));
  findings.push(warn('FILE_CUSTODIAN_NOT_PRODUCTION_KMS', 'descriptor', 'FileCustodian remains a hardened reference harness, not production KMS.'));

  return fromFindings(findings);
}

export function buildKekEvidencePreflightInputErrorReport(code: KekEvidencePreflightInputErrorCode): KekEvidencePreflightReport {
  const messageByCode: Record<KekEvidencePreflightInputErrorCode, string> = {
    DESCRIPTOR_FILE_READ_FAILED: 'Descriptor JSON file could not be read from the supplied path.',
    DESCRIPTOR_FILE_TOO_LARGE: 'Descriptor JSON file exceeds the preflight size limit.',
    DESCRIPTOR_JSON_MALFORMED: 'Descriptor input is not valid JSON.',
    DESCRIPTOR_OBJECT_REQUIRED: 'Descriptor JSON must be an object, not an array or primitive.',
  };
  return fromFindings([fail(code, 'descriptor', messageByCode[code])]);
}

export function parseKekEvidenceDescriptorJson(jsonText: string): Record<string, unknown> | KekEvidencePreflightInputErrorCode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripLeadingUtf8Bom(jsonText)) as unknown;
  } catch {
    return 'DESCRIPTOR_JSON_MALFORMED';
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'DESCRIPTOR_OBJECT_REQUIRED';
  }

  return parsed as Record<string, unknown>;
}

export function formatKekEvidencePreflightJson(report: KekEvidencePreflightReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatKekEvidencePreflightText(report: KekEvidencePreflightReport): string {
  const lines: string[] = [];
  lines.push('Phase 30 KEK custody and scheduling evidence preflight');
  lines.push('');
  lines.push('Purpose: prepare O5 managed KEK custody and scheduling evidence review');
  lines.push(`Redaction-safe: ${report.redactionSafe ? 'yes' : 'no'}`);
  lines.push(`Descriptor values echoed: ${report.descriptorValuesEchoed ? 'yes' : 'no'}`);
  lines.push(`O4 status: ${report.o4Status}`);
  lines.push(`O5 status: ${report.o5Status}`);
  lines.push(`FileCustodian: ${report.fileCustodianStatus}`);
  lines.push(`Closes O5: ${report.closesO5 ? 'true' : 'false'}`);
  lines.push(`Review readiness: ${report.reviewReadiness}`);
  lines.push(`Summary: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`);
  lines.push('');
  lines.push('Findings:');
  for (const finding of report.findings) {
    const field = finding.field ? ` field=${finding.field}` : '';
    lines.push(`- ${finding.level.toUpperCase()} ${finding.code}${field}: ${finding.message}`);
  }
  return `${lines.join('\n')}\n`;
}

export function reportHasFailures(report: KekEvidencePreflightReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly KekEvidencePreflightFinding[]): KekEvidencePreflightReport {
  const summary = summarize(findings);
  return {
    report: 'phase-30-kek-evidence-preflight',
    version: 1,
    redactionSafe: true,
    purpose: 'prepare-o5-managed-kek-custody-and-scheduling-evidence-review',
    descriptorInput: 'single-user-supplied-json-file',
    descriptorValuesEchoed: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    closesO5: false,
    reviewReadiness: summary.fail === 0 ? 'ready-for-review' : 'not-ready-for-review',
    findings,
    summary,
  };
}

function summarize(findings: readonly KekEvidencePreflightFinding[]): KekEvidencePreflightSummary {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function hasNonEmptyLabel(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function stripLeadingUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

function toCode(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => `_${ch}`).toUpperCase();
}

function pass(code: string, field: KekEvidencePreflightFinding['field'], message: string): KekEvidencePreflightFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: KekEvidencePreflightFinding['field'], message: string): KekEvidencePreflightFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: KekEvidencePreflightFinding['field'], message: string): KekEvidencePreflightFinding {
  return { level: 'warn', code, field, message };
}
