export type UnraidPostSwitchMaintenanceReviewInputErrorCode =
  | 'POST_SWITCH_MAINTENANCE_INPUT_REQUIRED'
  | 'POST_SWITCH_MAINTENANCE_FILE_READ_FAILED'
  | 'POST_SWITCH_MAINTENANCE_FILE_TOO_LARGE'
  | 'POST_SWITCH_MAINTENANCE_JSON_MALFORMED'
  | 'POST_SWITCH_MAINTENANCE_OBJECT_REQUIRED';

export interface UnraidPostSwitchMaintenanceReviewFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface UnraidPostSwitchMaintenanceReview {
  readonly report: 'phase-138-unraid-post-switch-maintenance-review';
  readonly version: 1;
  readonly purpose: 'review-post-switch-maintenance-evidence-without-provider-or-ui-scope';
  readonly source: 'single-operator-supplied-unraid-post-switch-maintenance-json-file';
  readonly sourcePostSwitchEvidenceReview: 'phase-137-unraid-post-switch-evidence-review';
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
  readonly maintenanceStatus: 'post-switch-maintenance-evidence-accepted' | 'not-ready';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly UnraidPostSwitchMaintenanceReviewFinding[];
}

export function buildUnraidPostSwitchMaintenanceReview(evidence: Record<string, unknown>): UnraidPostSwitchMaintenanceReview {
  const findings: UnraidPostSwitchMaintenanceReviewFinding[] = [];
  findings.push(...requiredLiteral(evidence, 'record', 'phase-138-unraid-post-switch-maintenance-record', 'POST_SWITCH_MAINTENANCE_RECORD'));
  findings.push(...requiredLiteral(evidence, 'sourcePostSwitchEvidenceReview', 'phase-137-unraid-post-switch-evidence-review', 'SOURCE_PHASE_137_REVIEW'));
  findings.push(...requiredLiteral(evidence, 'phase137OperationalStatus', 'service-running-with-open-hardening-warnings', 'PHASE_137_OPERATIONAL'));
  findings.push(...requiredLiteral(evidence, 'redactionSafe', true, 'MAINTENANCE_REDACTION_SAFE'));
  findings.push(...requiredLiteral(evidence, 'evidenceValuesEchoed', false, 'MAINTENANCE_NO_EVIDENCE_VALUES'));
  findings.push(...requiredLiteral(evidence, 'inputValuesEchoed', false, 'MAINTENANCE_NO_INPUT_VALUES'));
  findings.push(...requiredLiteral(evidence, 'commandExecution', false, 'MAINTENANCE_REVIEW_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(evidence, 'scriptGenerated', false, 'MAINTENANCE_NO_SCRIPT'));
  findings.push(...requiredLiteral(evidence, 'mutatesUnraid', false, 'MAINTENANCE_REVIEW_NO_MUTATION'));
  findings.push(...requiredLiteral(evidence, 'providerContactAllowed', false, 'MAINTENANCE_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(evidence, 'providerModeEnabled', false, 'MAINTENANCE_NO_PROVIDER_MODE'));
  findings.push(...requiredLiteral(evidence, 'rawSecretsIncluded', false, 'MAINTENANCE_NO_RAW_SECRETS'));
  findings.push(...requiredLiteral(evidence, 'rawLogsIncluded', false, 'MAINTENANCE_NO_RAW_LOGS'));
  findings.push(...requiredLiteral(evidence, 'identityValuesIncluded', false, 'MAINTENANCE_NO_IDENTITY_VALUES'));
  findings.push(...requiredLiteral(evidence, 'userScriptsPreservePersistentPostgres', true, 'USER_SCRIPTS_PRESERVE_POSTGRES'));
  findings.push(...requiredLiteral(evidence, 'doctorScriptComplete', true, 'DOCTOR_SCRIPT_COMPLETE'));
  findings.push(...requiredLiteral(evidence, 'backupVerifyScriptComplete', true, 'BACKUP_VERIFY_SCRIPT_COMPLETE'));
  findings.push(...requiredLiteral(evidence, 'kekRewrapPlanScriptComplete', true, 'KEK_REWRAP_PLAN_SCRIPT_COMPLETE'));
  findings.push(...requiredLiteral(evidence, 'plaintextBackupCandidates', 0, 'NO_PLAINTEXT_BACKUP_CANDIDATES'));
  findings.push(...requiredLiteral(evidence, 'serviceName', 'repo-postgres-1', 'SERVICE_NAME_CAPTURED'));
  findings.push(...requiredLiteral(evidence, 'serviceStateAfterMaintenance', 'healthy', 'SERVICE_HEALTHY_AFTER_MAINTENANCE'));
  findings.push(...requiredLiteral(evidence, 'publishedPorts', false, 'NO_PUBLISHED_PORTS'));
  findings.push(...requiredLiteral(evidence, 'serviceInstalled', true, 'SERVICE_INSTALLED_RECORDED'));
  findings.push(...requiredLiteral(evidence, 'serviceStarted', true, 'SERVICE_STARTED_RECORDED'));
  findings.push(...requiredLiteral(evidence, 'launchApproved', true, 'LAUNCH_APPROVAL_CARRIED_FORWARD'));
  findings.push(...requiredLiteral(evidence, 'productionReady', false, 'PRODUCTION_READY_REMAINS_FALSE'));
  findings.push(...requiredLiteral(evidence, 'fileCustodianStatus', 'reference-harness-not-production-kms', 'FILE_CUSTODIAN_BOUNDARY'));
  findings.push(warn('O4_REMAINS_OPEN', 'o4Status', 'FileCustodian remains a reference harness, not external production KMS.'));
  findings.push(warn('O5_REMAINS_OPEN', 'o5Status', 'Managed KEK custody/scheduling remains open.'));
  return fromFindings(findings);
}

export function buildUnraidPostSwitchMaintenanceReviewInputError(code: UnraidPostSwitchMaintenanceReviewInputErrorCode): UnraidPostSwitchMaintenanceReview {
  const messages: Record<UnraidPostSwitchMaintenanceReviewInputErrorCode, string> = {
    POST_SWITCH_MAINTENANCE_INPUT_REQUIRED: 'One Unraid post-switch maintenance JSON input is required.',
    POST_SWITCH_MAINTENANCE_FILE_READ_FAILED: 'The supplied Unraid post-switch maintenance JSON file could not be read.',
    POST_SWITCH_MAINTENANCE_FILE_TOO_LARGE: 'The supplied Unraid post-switch maintenance JSON file exceeds the input size limit.',
    POST_SWITCH_MAINTENANCE_JSON_MALFORMED: 'The supplied Unraid post-switch maintenance input is not valid JSON.',
    POST_SWITCH_MAINTENANCE_OBJECT_REQUIRED: 'The supplied Unraid post-switch maintenance JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseUnraidPostSwitchMaintenanceReviewJson(jsonText: string): Record<string, unknown> | UnraidPostSwitchMaintenanceReviewInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'POST_SWITCH_MAINTENANCE_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'POST_SWITCH_MAINTENANCE_JSON_MALFORMED';
  }
}

export function formatUnraidPostSwitchMaintenanceReviewJson(report: UnraidPostSwitchMaintenanceReview): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatUnraidPostSwitchMaintenanceReviewText(report: UnraidPostSwitchMaintenanceReview): string {
  const lines = [
    'Phase 138 Unraid post-switch maintenance review',
    `Maintenance status: ${report.maintenanceStatus}`,
    `Service installed: ${report.serviceInstalled ? 'true' : 'false'}`,
    `Service started: ${report.serviceStarted ? 'true' : 'false'}`,
    `Launch approved: ${report.launchApproved ? 'true' : 'false'}`,
    `Production ready: ${report.productionReady ? 'true' : 'false'}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function unraidPostSwitchMaintenanceReviewHasFailures(report: UnraidPostSwitchMaintenanceReview): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly UnraidPostSwitchMaintenanceReviewFinding[]): UnraidPostSwitchMaintenanceReview {
  const summary = summarize(findings);
  const ready = summary.fail === 0;
  return {
    report: 'phase-138-unraid-post-switch-maintenance-review',
    version: 1,
    purpose: 'review-post-switch-maintenance-evidence-without-provider-or-ui-scope',
    source: 'single-operator-supplied-unraid-post-switch-maintenance-json-file',
    sourcePostSwitchEvidenceReview: 'phase-137-unraid-post-switch-evidence-review',
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
    maintenanceStatus: ready ? 'post-switch-maintenance-evidence-accepted' : 'not-ready',
    summary,
    findings,
  };
}

function summarize(findings: readonly UnraidPostSwitchMaintenanceReviewFinding[]): UnraidPostSwitchMaintenanceReview['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(object: Record<string, unknown>, field: string, expected: string | boolean | number, passCode: string): UnraidPostSwitchMaintenanceReviewFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): UnraidPostSwitchMaintenanceReviewFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): UnraidPostSwitchMaintenanceReviewFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): UnraidPostSwitchMaintenanceReviewFinding {
  return { level: 'warn', code, field, message };
}
