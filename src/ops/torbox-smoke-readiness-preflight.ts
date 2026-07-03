export type TorBoxSmokeReadinessRedactionReviewStatus = 'passed' | 'pending' | 'failed' | 'unknown';
export type TorBoxSmokeReadinessFindingLevel = 'pass' | 'warn' | 'fail';

export type TorBoxSmokeReadinessPreflightInputErrorCode =
  | 'DESCRIPTOR_FILE_READ_FAILED'
  | 'DESCRIPTOR_FILE_TOO_LARGE'
  | 'DESCRIPTOR_JSON_MALFORMED'
  | 'DESCRIPTOR_OBJECT_REQUIRED';

export interface TorBoxSmokeReadinessDescriptor {
  readonly credentialReferenceLabel?: string;
  readonly transportAcceptanceEvidenceLabel?: string;
  readonly operatorAuthorizationDocumented?: boolean;
  readonly liveNetworkOptInDocumented?: boolean;
  readonly readOnlyIntentDocumented?: boolean;
  readonly scopedRefPolicyDocumented?: boolean;
  readonly redactionPolicyDocumented?: boolean;
  readonly evidenceRetentionPolicyDocumented?: boolean;
  readonly boundedTimeoutPolicyDocumented?: boolean;
  readonly noProviderPayloadRetention?: boolean;
  readonly noAdapterModeWiring?: boolean;
  readonly noDownloadOrPlaybackIntent?: boolean;
  readonly redactionReviewStatus?: TorBoxSmokeReadinessRedactionReviewStatus;
}

export interface TorBoxSmokeReadinessPreflightFinding {
  readonly level: TorBoxSmokeReadinessFindingLevel;
  readonly code: string;
  readonly field?: keyof TorBoxSmokeReadinessDescriptor | 'descriptor';
  readonly message: string;
}

export interface TorBoxSmokeReadinessPreflightSummary {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
  readonly total: number;
}

export interface TorBoxSmokeReadinessPreflightReport {
  readonly report: 'phase-40-torbox-smoke-readiness-preflight';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly purpose: 'prepare-future-torbox-operator-smoke-readiness-review';
  readonly descriptorInput: 'single-user-supplied-json-file';
  readonly descriptorValuesEchoed: false;
  readonly liveTorBoxContact: false;
  readonly closesLiveSmokeReadiness: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly reviewReadiness: 'ready-for-review' | 'not-ready-for-review';
  readonly findings: readonly TorBoxSmokeReadinessPreflightFinding[];
  readonly summary: TorBoxSmokeReadinessPreflightSummary;
}

const REQUIRED_TRUE_FIELDS = [
  'operatorAuthorizationDocumented',
  'liveNetworkOptInDocumented',
  'readOnlyIntentDocumented',
  'scopedRefPolicyDocumented',
  'redactionPolicyDocumented',
  'evidenceRetentionPolicyDocumented',
  'boundedTimeoutPolicyDocumented',
  'noProviderPayloadRetention',
  'noAdapterModeWiring',
  'noDownloadOrPlaybackIntent',
] as const;

export function buildTorBoxSmokeReadinessPreflightReport(
  descriptor: Record<string, unknown>,
): TorBoxSmokeReadinessPreflightReport {
  const typed = descriptor as TorBoxSmokeReadinessDescriptor;
  const findings: TorBoxSmokeReadinessPreflightFinding[] = [];

  for (const field of REQUIRED_TRUE_FIELDS) {
    if (typed[field] === true) findings.push(pass(`${toCode(field)}_DECLARED`, field, `${field} is declared.`));
    else findings.push(fail(`${toCode(field)}_REQUIRED`, field, `${field} must be true before TorBox smoke readiness can be reviewed.`));
  }

  if (hasNonEmptyLabel(typed.credentialReferenceLabel)) {
    findings.push(pass('CREDENTIAL_REFERENCE_LABEL_PRESENT', 'credentialReferenceLabel', 'Credential reference label is present.'));
  } else {
    findings.push(fail('CREDENTIAL_REFERENCE_LABEL_REQUIRED', 'credentialReferenceLabel', 'A non-secret credential reference label is required.'));
  }

  if (hasNonEmptyLabel(typed.transportAcceptanceEvidenceLabel)) {
    findings.push(pass('TRANSPORT_ACCEPTANCE_EVIDENCE_LABEL_PRESENT', 'transportAcceptanceEvidenceLabel', 'Phase 39 transport acceptance evidence is labeled.'));
  } else {
    findings.push(fail('TRANSPORT_ACCEPTANCE_EVIDENCE_LABEL_REQUIRED', 'transportAcceptanceEvidenceLabel', 'A Phase 39 transport acceptance evidence label is required.'));
  }

  if (typed.redactionReviewStatus === 'passed') {
    findings.push(pass('REDACTION_REVIEW_PASSED', 'redactionReviewStatus', 'Redaction review is marked passed.'));
  } else if (typed.redactionReviewStatus === 'failed') {
    findings.push(fail('REDACTION_REVIEW_FAILED', 'redactionReviewStatus', 'Redaction review must pass before TorBox smoke readiness can be reviewed.'));
  } else {
    findings.push(fail('REDACTION_REVIEW_REQUIRED', 'redactionReviewStatus', 'A passed redaction review is required before TorBox smoke readiness can be reviewed.'));
  }

  if (!findings.some((finding) => finding.level === 'fail')) {
    findings.push(warn(
      'LIVE_SMOKE_STILL_REQUIRES_SEPARATE_AUTHORIZATION',
      'descriptor',
      'Descriptor metadata is complete, but live TorBox smoke remains a separate authorized and reviewed phase.',
    ));
  }

  findings.push(warn('O4_REMAINS_DEFERRED', 'descriptor', 'O4 production custodian acceptance remains open/deferred.'));
  findings.push(warn('O5_REMAINS_DEFERRED', 'descriptor', 'O5 managed KEK custody/scheduling remains open/deferred.'));
  findings.push(warn('FILE_CUSTODIAN_NOT_PRODUCTION_KMS', 'descriptor', 'FileCustodian remains a hardened reference harness, not production KMS.'));

  return fromFindings(findings);
}

export function buildTorBoxSmokeReadinessPreflightInputErrorReport(
  code: TorBoxSmokeReadinessPreflightInputErrorCode,
): TorBoxSmokeReadinessPreflightReport {
  const messageByCode: Record<TorBoxSmokeReadinessPreflightInputErrorCode, string> = {
    DESCRIPTOR_FILE_READ_FAILED: 'Descriptor JSON file could not be read from the supplied path.',
    DESCRIPTOR_FILE_TOO_LARGE: 'Descriptor JSON file exceeds the preflight size limit.',
    DESCRIPTOR_JSON_MALFORMED: 'Descriptor input is not valid JSON.',
    DESCRIPTOR_OBJECT_REQUIRED: 'Descriptor JSON must be an object, not an array or primitive.',
  };
  return fromFindings([fail(code, 'descriptor', messageByCode[code])]);
}

export function parseTorBoxSmokeReadinessDescriptorJson(
  jsonText: string,
): Record<string, unknown> | TorBoxSmokeReadinessPreflightInputErrorCode {
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

export function formatTorBoxSmokeReadinessPreflightJson(report: TorBoxSmokeReadinessPreflightReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatTorBoxSmokeReadinessPreflightText(report: TorBoxSmokeReadinessPreflightReport): string {
  const lines: string[] = [];
  lines.push('Phase 40 TorBox smoke readiness preflight');
  lines.push('');
  lines.push('Purpose: prepare future TorBox operator smoke readiness review');
  lines.push(`Redaction-safe: ${report.redactionSafe ? 'yes' : 'no'}`);
  lines.push(`Descriptor values echoed: ${report.descriptorValuesEchoed ? 'yes' : 'no'}`);
  lines.push(`Live TorBox contact: ${report.liveTorBoxContact ? 'true' : 'false'}`);
  lines.push(`Closes live smoke readiness: ${report.closesLiveSmokeReadiness ? 'true' : 'false'}`);
  lines.push(`O4 status: ${report.o4Status}`);
  lines.push(`O5 status: ${report.o5Status}`);
  lines.push(`FileCustodian: ${report.fileCustodianStatus}`);
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

export function reportHasFailures(report: TorBoxSmokeReadinessPreflightReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly TorBoxSmokeReadinessPreflightFinding[]): TorBoxSmokeReadinessPreflightReport {
  const summary = summarize(findings);
  return {
    report: 'phase-40-torbox-smoke-readiness-preflight',
    version: 1,
    redactionSafe: true,
    purpose: 'prepare-future-torbox-operator-smoke-readiness-review',
    descriptorInput: 'single-user-supplied-json-file',
    descriptorValuesEchoed: false,
    liveTorBoxContact: false,
    closesLiveSmokeReadiness: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    reviewReadiness: summary.fail === 0 ? 'ready-for-review' : 'not-ready-for-review',
    findings,
    summary,
  };
}

function summarize(findings: readonly TorBoxSmokeReadinessPreflightFinding[]): TorBoxSmokeReadinessPreflightSummary {
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

function pass(
  code: string,
  field: TorBoxSmokeReadinessPreflightFinding['field'],
  message: string,
): TorBoxSmokeReadinessPreflightFinding {
  return { level: 'pass', code, field, message };
}

function fail(
  code: string,
  field: TorBoxSmokeReadinessPreflightFinding['field'],
  message: string,
): TorBoxSmokeReadinessPreflightFinding {
  return { level: 'fail', code, field, message };
}

function warn(
  code: string,
  field: TorBoxSmokeReadinessPreflightFinding['field'],
  message: string,
): TorBoxSmokeReadinessPreflightFinding {
  return { level: 'warn', code, field, message };
}
