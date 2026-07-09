export type UnraidPostSwitchEvidenceReviewInputErrorCode =
  | 'POST_SWITCH_EVIDENCE_INPUT_REQUIRED'
  | 'POST_SWITCH_EVIDENCE_FILE_READ_FAILED'
  | 'POST_SWITCH_EVIDENCE_FILE_TOO_LARGE'
  | 'POST_SWITCH_EVIDENCE_JSON_MALFORMED'
  | 'POST_SWITCH_EVIDENCE_OBJECT_REQUIRED';

export interface UnraidPostSwitchEvidenceReviewFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface UnraidPostSwitchEvidenceReview {
  readonly report: 'phase-137-unraid-post-switch-evidence-review';
  readonly version: 1;
  readonly purpose: 'review-post-switch-operational-evidence-with-open-hardening-warnings';
  readonly source: 'single-operator-supplied-unraid-post-switch-evidence-json-file';
  readonly sourceExecutionPacket: 'phase-136-unraid-production-switch-execution-packet';
  readonly redactionSafe: true;
  readonly evidenceValuesEchoed: false;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly mutatesUnraid: false;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly serviceInstalled: true;
  readonly serviceStarted: true;
  readonly launchApproved: true;
  readonly productionReady: false;
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly o4Status: 'open-warning';
  readonly o5Status: 'open-warning';
  readonly operationalStatus: 'service-running-with-open-hardening-warnings' | 'not-ready';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly UnraidPostSwitchEvidenceReviewFinding[];
}

export function buildUnraidPostSwitchEvidenceReview(evidence: Record<string, unknown>): UnraidPostSwitchEvidenceReview {
  const findings: UnraidPostSwitchEvidenceReviewFinding[] = [];
  findings.push(...requiredLiteral(evidence, 'record', 'phase-137-unraid-post-switch-evidence-record', 'POST_SWITCH_EVIDENCE_RECORD'));
  findings.push(...requiredLiteral(evidence, 'sourceExecutionPacket', 'phase-136-unraid-production-switch-execution-packet', 'SOURCE_EXECUTION_PACKET'));
  findings.push(...requiredLiteral(evidence, 'executionPacketStatus', 'ready-for-real-unraid-production-switch', 'SOURCE_EXECUTION_PACKET_READY'));
  findings.push(...requiredLiteral(evidence, 'deployedCommit', '7e2db7c8b6b9ac68272e01ee51e6c63399fc0ef3', 'DEPLOYED_COMMIT_MATCHES_APPROVAL'));
  findings.push(...requiredLiteral(evidence, 'redactionSafe', true, 'POST_SWITCH_REDACTION_SAFE'));
  findings.push(...requiredLiteral(evidence, 'evidenceValuesEchoed', false, 'POST_SWITCH_NO_EVIDENCE_VALUES'));
  findings.push(...requiredLiteral(evidence, 'inputValuesEchoed', false, 'POST_SWITCH_NO_INPUT_VALUES'));
  findings.push(...requiredLiteral(evidence, 'commandExecution', false, 'POST_SWITCH_REVIEW_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(evidence, 'scriptGenerated', false, 'POST_SWITCH_NO_SCRIPT'));
  findings.push(...requiredLiteral(evidence, 'mutatesUnraid', false, 'POST_SWITCH_REVIEW_NO_MUTATION'));
  findings.push(...requiredLiteral(evidence, 'providerContactAllowed', false, 'POST_SWITCH_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(evidence, 'providerModeEnabled', false, 'POST_SWITCH_NO_PROVIDER_MODE'));
  findings.push(...requiredLiteral(evidence, 'rawSecretsIncluded', false, 'POST_SWITCH_NO_RAW_SECRETS'));
  findings.push(...requiredLiteral(evidence, 'rawLogsIncluded', false, 'POST_SWITCH_NO_RAW_LOGS'));
  findings.push(...requiredLiteral(evidence, 'identityValuesIncluded', false, 'POST_SWITCH_NO_IDENTITY_VALUES'));
  findings.push(...requiredLiteral(evidence, 'appEnv', 'production', 'APP_ENV_PRODUCTION'));
  findings.push(...requiredLiteral(evidence, 'custodianMode', 'file', 'CUSTODIAN_MODE_FILE'));
  findings.push(...requiredLiteral(evidence, 'serviceName', 'repo-postgres-1', 'SERVICE_NAME_CAPTURED'));
  findings.push(...requiredLiteral(evidence, 'serviceState', 'healthy', 'SERVICE_HEALTHY'));
  findings.push(...requiredLiteral(evidence, 'publishedPorts', false, 'NO_PUBLISHED_PORTS'));
  findings.push(...requiredLiteral(evidence, 'postSwitchDoctorOk', true, 'POST_SWITCH_DOCTOR_OK'));
  findings.push(...requiredLiteral(evidence, 'postSwitchDoctorPassCount', 12, 'POST_SWITCH_DOCTOR_PASS_COUNT'));
  findings.push(...requiredLiteral(evidence, 'postSwitchDoctorWarnCount', 2, 'POST_SWITCH_DOCTOR_WARN_COUNT'));
  findings.push(...requiredLiteral(evidence, 'postSwitchDoctorFailCount', 0, 'POST_SWITCH_DOCTOR_FAIL_COUNT'));
  findings.push(...requiredLiteral(evidence, 'o4Status', 'open-warning', 'O4_RECORDED_OPEN_WARNING'));
  findings.push(...requiredLiteral(evidence, 'o5Status', 'open-warning', 'O5_RECORDED_OPEN_WARNING'));
  findings.push(...requiredLiteral(evidence, 'serviceInstalled', true, 'SERVICE_INSTALLED_RECORDED'));
  findings.push(...requiredLiteral(evidence, 'serviceStarted', true, 'SERVICE_STARTED_RECORDED'));
  findings.push(...requiredLiteral(evidence, 'launchApproved', true, 'LAUNCH_APPROVAL_CARRIED_FORWARD'));
  findings.push(...requiredLiteral(evidence, 'productionReady', false, 'PRODUCTION_READY_REMAINS_FALSE'));
  findings.push(...requiredLiteral(evidence, 'fileCustodianStatus', 'reference-harness-not-production-kms', 'FILE_CUSTODIAN_BOUNDARY'));
  findings.push(warn('O4_REMAINS_OPEN', 'o4Status', 'FileCustodian remains a reference harness, not external production KMS.'));
  findings.push(warn('O5_REMAINS_OPEN', 'o5Status', 'Managed KEK custody/scheduling remains open.'));
  return fromFindings(findings);
}

export function buildUnraidPostSwitchEvidenceReviewInputError(code: UnraidPostSwitchEvidenceReviewInputErrorCode): UnraidPostSwitchEvidenceReview {
  const messages: Record<UnraidPostSwitchEvidenceReviewInputErrorCode, string> = {
    POST_SWITCH_EVIDENCE_INPUT_REQUIRED: 'One Unraid post-switch evidence JSON input is required.',
    POST_SWITCH_EVIDENCE_FILE_READ_FAILED: 'The supplied Unraid post-switch evidence JSON file could not be read.',
    POST_SWITCH_EVIDENCE_FILE_TOO_LARGE: 'The supplied Unraid post-switch evidence JSON file exceeds the input size limit.',
    POST_SWITCH_EVIDENCE_JSON_MALFORMED: 'The supplied Unraid post-switch evidence input is not valid JSON.',
    POST_SWITCH_EVIDENCE_OBJECT_REQUIRED: 'The supplied Unraid post-switch evidence JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseUnraidPostSwitchEvidenceReviewJson(jsonText: string): Record<string, unknown> | UnraidPostSwitchEvidenceReviewInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'POST_SWITCH_EVIDENCE_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'POST_SWITCH_EVIDENCE_JSON_MALFORMED';
  }
}

export function formatUnraidPostSwitchEvidenceReviewJson(report: UnraidPostSwitchEvidenceReview): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatUnraidPostSwitchEvidenceReviewText(report: UnraidPostSwitchEvidenceReview): string {
  const lines = [
    'Phase 137 Unraid post-switch evidence review',
    `Operational status: ${report.operationalStatus}`,
    `Service installed: ${report.serviceInstalled ? 'true' : 'false'}`,
    `Service started: ${report.serviceStarted ? 'true' : 'false'}`,
    `Launch approved: ${report.launchApproved ? 'true' : 'false'}`,
    `Production ready: ${report.productionReady ? 'true' : 'false'}`,
    `O4 status: ${report.o4Status}`,
    `O5 status: ${report.o5Status}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function unraidPostSwitchEvidenceReviewHasFailures(report: UnraidPostSwitchEvidenceReview): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly UnraidPostSwitchEvidenceReviewFinding[]): UnraidPostSwitchEvidenceReview {
  const summary = summarize(findings);
  const ready = summary.fail === 0;
  return {
    report: 'phase-137-unraid-post-switch-evidence-review',
    version: 1,
    purpose: 'review-post-switch-operational-evidence-with-open-hardening-warnings',
    source: 'single-operator-supplied-unraid-post-switch-evidence-json-file',
    sourceExecutionPacket: 'phase-136-unraid-production-switch-execution-packet',
    redactionSafe: true,
    evidenceValuesEchoed: false,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    serviceInstalled: true,
    serviceStarted: true,
    launchApproved: true,
    productionReady: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    o4Status: 'open-warning',
    o5Status: 'open-warning',
    operationalStatus: ready ? 'service-running-with-open-hardening-warnings' : 'not-ready',
    summary,
    findings,
  };
}

function summarize(findings: readonly UnraidPostSwitchEvidenceReviewFinding[]): UnraidPostSwitchEvidenceReview['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(object: Record<string, unknown>, field: string, expected: string | boolean | number, passCode: string): UnraidPostSwitchEvidenceReviewFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): UnraidPostSwitchEvidenceReviewFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): UnraidPostSwitchEvidenceReviewFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): UnraidPostSwitchEvidenceReviewFinding {
  return { level: 'warn', code, field, message };
}
