export type UnraidSwitchEvidenceReviewInputErrorCode =
  | 'SWITCH_EVIDENCE_INPUT_REQUIRED'
  | 'SWITCH_EVIDENCE_FILE_READ_FAILED'
  | 'SWITCH_EVIDENCE_FILE_TOO_LARGE'
  | 'SWITCH_EVIDENCE_JSON_MALFORMED'
  | 'SWITCH_EVIDENCE_OBJECT_REQUIRED';

export interface UnraidSwitchEvidenceReviewFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface UnraidSwitchEvidenceReview {
  readonly report: 'phase-132-unraid-switch-evidence-review';
  readonly version: 1;
  readonly purpose: 'review-redacted-evidence-after-explicit-operator-switch-without-approving-launch';
  readonly source: 'single-operator-supplied-unraid-switch-evidence-json-file';
  readonly sourceCapturePacket: 'phase-131-unraid-switch-evidence-capture';
  readonly sourceRunbook: 'phase-130-unraid-production-switch-runbook';
  readonly redactionSafe: true;
  readonly evidenceValuesEchoed: false;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly mutatesUnraid: false;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly productionReady: false;
  readonly launchApproved: false;
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly serviceEvidenceStatus: 'service-evidence-present' | 'service-evidence-missing-or-unsafe';
  readonly reviewStatus: 'ready-for-final-production-disposition' | 'not-ready-for-final-production-disposition';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly UnraidSwitchEvidenceReviewFinding[];
}

export function buildUnraidSwitchEvidenceReview(evidence: Record<string, unknown>): UnraidSwitchEvidenceReview {
  const findings: UnraidSwitchEvidenceReviewFinding[] = [];
  findings.push(...requiredLiteral(evidence, 'record', 'phase-132-unraid-switch-evidence-record', 'SWITCH_EVIDENCE_RECORD_LABEL'));
  findings.push(...requiredLiteral(evidence, 'sourceCapturePacket', 'phase-131-unraid-switch-evidence-capture', 'SOURCE_CAPTURE_PACKET'));
  findings.push(...requiredLiteral(evidence, 'sourceRunbook', 'phase-130-unraid-production-switch-runbook', 'SOURCE_RUNBOOK'));
  findings.push(...requiredLiteral(evidence, 'redactionSafe', true, 'SWITCH_EVIDENCE_REDACTION_SAFE'));
  findings.push(...requiredLiteral(evidence, 'evidenceValuesEchoed', false, 'SWITCH_EVIDENCE_NO_VALUES'));
  findings.push(...requiredLiteral(evidence, 'inputValuesEchoed', false, 'SWITCH_EVIDENCE_NO_INPUT_VALUES'));
  findings.push(...requiredLiteral(evidence, 'commandExecution', false, 'SWITCH_EVIDENCE_REVIEW_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(evidence, 'scriptGenerated', false, 'SWITCH_EVIDENCE_REVIEW_NO_SCRIPT'));
  findings.push(...requiredLiteral(evidence, 'mutatesUnraid', false, 'SWITCH_EVIDENCE_REVIEW_NO_MUTATION'));
  findings.push(...requiredLiteral(evidence, 'providerContactAllowed', false, 'SWITCH_EVIDENCE_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(evidence, 'providerModeEnabled', false, 'SWITCH_EVIDENCE_NO_PROVIDER_MODE'));
  findings.push(...requiredLiteral(evidence, 'rawSecretsIncluded', false, 'SWITCH_EVIDENCE_NO_RAW_SECRETS'));
  findings.push(...requiredLiteral(evidence, 'rawLogsIncluded', false, 'SWITCH_EVIDENCE_NO_RAW_LOGS'));
  findings.push(...requiredLiteral(evidence, 'rawBackupContentsIncluded', false, 'SWITCH_EVIDENCE_NO_BACKUP_CONTENTS'));
  findings.push(...requiredLiteral(evidence, 'identityValuesIncluded', false, 'SWITCH_EVIDENCE_NO_IDENTITY_VALUES'));
  findings.push(...requiredLiteral(evidence, 'preSwitchDoctorRedacted', true, 'PRE_SWITCH_DOCTOR_REDACTED'));
  findings.push(...requiredLiteral(evidence, 'operatorSwitchCommandLabelCaptured', true, 'OPERATOR_SWITCH_LABEL_CAPTURED'));
  findings.push(...requiredLiteral(evidence, 'serviceStatusAfterSwitchLabelCaptured', true, 'SERVICE_STATUS_LABEL_CAPTURED'));
  findings.push(...requiredLiteral(evidence, 'postSwitchDoctorRedacted', true, 'POST_SWITCH_DOCTOR_REDACTED'));
  findings.push(...requiredLiteral(evidence, 'composePsAfterSwitchLabelCaptured', true, 'COMPOSE_PS_LABEL_CAPTURED'));
  findings.push(...requiredLiteral(evidence, 'productionReady', false, 'SWITCH_EVIDENCE_REVIEW_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(evidence, 'launchApproved', false, 'SWITCH_EVIDENCE_REVIEW_NOT_LAUNCH_APPROVED'));
  findings.push(...requiredLiteral(evidence, 'fileCustodianStatus', 'reference-harness-not-production-kms', 'FILE_CUSTODIAN_BOUNDARY'));
  findings.push(warn('REVIEW_DOES_NOT_APPROVE_LAUNCH', 'launchApproved', 'This review does not set launchApproved true.'));
  return fromFindings(findings);
}

export function buildUnraidSwitchEvidenceReviewInputError(code: UnraidSwitchEvidenceReviewInputErrorCode): UnraidSwitchEvidenceReview {
  const messages: Record<UnraidSwitchEvidenceReviewInputErrorCode, string> = {
    SWITCH_EVIDENCE_INPUT_REQUIRED: 'One Unraid switch evidence JSON input is required.',
    SWITCH_EVIDENCE_FILE_READ_FAILED: 'The supplied Unraid switch evidence JSON file could not be read.',
    SWITCH_EVIDENCE_FILE_TOO_LARGE: 'The supplied Unraid switch evidence JSON file exceeds the input size limit.',
    SWITCH_EVIDENCE_JSON_MALFORMED: 'The supplied Unraid switch evidence input is not valid JSON.',
    SWITCH_EVIDENCE_OBJECT_REQUIRED: 'The supplied Unraid switch evidence JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseUnraidSwitchEvidenceReviewJson(jsonText: string): Record<string, unknown> | UnraidSwitchEvidenceReviewInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'SWITCH_EVIDENCE_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'SWITCH_EVIDENCE_JSON_MALFORMED';
  }
}

export function formatUnraidSwitchEvidenceReviewJson(report: UnraidSwitchEvidenceReview): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatUnraidSwitchEvidenceReviewText(report: UnraidSwitchEvidenceReview): string {
  const lines = [
    'Phase 132 Unraid switch evidence review',
    `Review status: ${report.reviewStatus}`,
    `Service evidence status: ${report.serviceEvidenceStatus}`,
    `Evidence values echoed: ${report.evidenceValuesEchoed ? 'yes' : 'no'}`,
    `Production ready: ${report.productionReady ? 'true' : 'false'}`,
    `Launch approved: ${report.launchApproved ? 'true' : 'false'}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function unraidSwitchEvidenceReviewHasFailures(report: UnraidSwitchEvidenceReview): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly UnraidSwitchEvidenceReviewFinding[]): UnraidSwitchEvidenceReview {
  const summary = summarize(findings);
  const ready = summary.fail === 0;
  return {
    report: 'phase-132-unraid-switch-evidence-review',
    version: 1,
    purpose: 'review-redacted-evidence-after-explicit-operator-switch-without-approving-launch',
    source: 'single-operator-supplied-unraid-switch-evidence-json-file',
    sourceCapturePacket: 'phase-131-unraid-switch-evidence-capture',
    sourceRunbook: 'phase-130-unraid-production-switch-runbook',
    redactionSafe: true,
    evidenceValuesEchoed: false,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    productionReady: false,
    launchApproved: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    serviceEvidenceStatus: ready ? 'service-evidence-present' : 'service-evidence-missing-or-unsafe',
    reviewStatus: ready ? 'ready-for-final-production-disposition' : 'not-ready-for-final-production-disposition',
    summary,
    findings,
  };
}

function summarize(findings: readonly UnraidSwitchEvidenceReviewFinding[]): UnraidSwitchEvidenceReview['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(object: Record<string, unknown>, field: string, expected: string | boolean, passCode: string): UnraidSwitchEvidenceReviewFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): UnraidSwitchEvidenceReviewFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): UnraidSwitchEvidenceReviewFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): UnraidSwitchEvidenceReviewFinding {
  return { level: 'warn', code, field, message };
}
