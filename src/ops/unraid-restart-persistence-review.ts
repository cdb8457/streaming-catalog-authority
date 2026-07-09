export type UnraidRestartPersistenceReviewInputErrorCode =
  | 'UNRAID_RESTART_PERSISTENCE_INPUT_REQUIRED'
  | 'UNRAID_RESTART_PERSISTENCE_FILE_READ_FAILED'
  | 'UNRAID_RESTART_PERSISTENCE_FILE_TOO_LARGE'
  | 'UNRAID_RESTART_PERSISTENCE_JSON_MALFORMED'
  | 'UNRAID_RESTART_PERSISTENCE_OBJECT_REQUIRED';

export interface UnraidRestartPersistenceReviewFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface UnraidRestartPersistenceReview {
  readonly report: 'phase-139-unraid-restart-persistence-review';
  readonly version: 1;
  readonly purpose: 'review-unraid-restart-persistence-evidence-without-provider-or-ui-scope';
  readonly source: 'single-operator-supplied-unraid-restart-persistence-json-file';
  readonly sourcePostSwitchMaintenanceReview: 'phase-138-unraid-post-switch-maintenance-review';
  readonly redactionSafe: true;
  readonly evidenceValuesEchoed: false;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly mutatesUnraid: false;
  readonly serverRebooted: false;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly serviceInstalled: true;
  readonly serviceStarted: true;
  readonly launchApproved: true;
  readonly productionReady: false;
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly restartPersistenceStatus: 'restart-persistence-evidence-accepted' | 'not-ready';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly UnraidRestartPersistenceReviewFinding[];
}

export function buildUnraidRestartPersistenceReview(evidence: Record<string, unknown>): UnraidRestartPersistenceReview {
  const findings: UnraidRestartPersistenceReviewFinding[] = [];
  findings.push(...requiredLiteral(evidence, 'record', 'phase-139-unraid-restart-persistence-record', 'RESTART_PERSISTENCE_RECORD'));
  findings.push(...requiredLiteral(evidence, 'sourcePostSwitchMaintenanceReview', 'phase-138-unraid-post-switch-maintenance-review', 'SOURCE_PHASE_138_REVIEW'));
  findings.push(...requiredLiteral(evidence, 'phase138MaintenanceStatus', 'post-switch-maintenance-evidence-accepted', 'PHASE_138_MAINTENANCE_ACCEPTED'));
  findings.push(...requiredLiteral(evidence, 'deployedCommit', '8ddf3f3', 'DEPLOYED_COMMIT_CAPTURED'));
  findings.push(...requiredLiteral(evidence, 'redactionSafe', true, 'RESTART_REDACTION_SAFE'));
  findings.push(...requiredLiteral(evidence, 'evidenceValuesEchoed', false, 'RESTART_NO_EVIDENCE_VALUES'));
  findings.push(...requiredLiteral(evidence, 'inputValuesEchoed', false, 'RESTART_NO_INPUT_VALUES'));
  findings.push(...requiredLiteral(evidence, 'commandExecution', false, 'RESTART_REVIEW_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(evidence, 'scriptGenerated', false, 'RESTART_NO_SCRIPT'));
  findings.push(...requiredLiteral(evidence, 'mutatesUnraid', false, 'RESTART_REVIEW_NO_MUTATION'));
  findings.push(...requiredLiteral(evidence, 'serverRebooted', false, 'SERVER_NOT_REBOOTED'));
  findings.push(...requiredLiteral(evidence, 'providerContactAllowed', false, 'RESTART_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(evidence, 'providerModeEnabled', false, 'RESTART_NO_PROVIDER_MODE'));
  findings.push(...requiredLiteral(evidence, 'rawSecretsIncluded', false, 'RESTART_NO_RAW_SECRETS'));
  findings.push(...requiredLiteral(evidence, 'rawLogsIncluded', false, 'RESTART_NO_RAW_LOGS'));
  findings.push(...requiredLiteral(evidence, 'identityValuesIncluded', false, 'RESTART_NO_IDENTITY_VALUES'));
  findings.push(...requiredLiteral(evidence, 'restartScope', 'compose-postgres-service', 'RESTART_SCOPE_CAPTURED'));
  findings.push(...requiredLiteral(evidence, 'serviceName', 'repo-postgres-1', 'SERVICE_NAME_CAPTURED'));
  findings.push(...requiredLiteral(evidence, 'serviceStateBeforeRestart', 'healthy', 'SERVICE_HEALTHY_BEFORE_RESTART'));
  findings.push(...requiredLiteral(evidence, 'healthTransitionObserved', true, 'HEALTH_TRANSITION_OBSERVED'));
  findings.push(...requiredLiteral(evidence, 'serviceStateAfterRestart', 'healthy', 'SERVICE_HEALTHY_AFTER_RESTART'));
  findings.push(...requiredLiteral(evidence, 'preRestartDoctorOk', true, 'PRE_RESTART_DOCTOR_OK'));
  findings.push(...requiredLiteral(evidence, 'postRestartDoctorOk', true, 'POST_RESTART_DOCTOR_OK'));
  findings.push(...requiredLiteral(evidence, 'schemaVersionAfterRestart', 3, 'SCHEMA_VERSION_PERSISTED'));
  findings.push(...requiredLiteral(evidence, 'completionSecretMatchAfterRestart', true, 'COMPLETION_SECRET_MATCH_PERSISTED'));
  findings.push(...requiredLiteral(evidence, 'custodianReachableAfterRestart', true, 'CUSTODIAN_REACHABLE_AFTER_RESTART'));
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

export function buildUnraidRestartPersistenceReviewInputError(code: UnraidRestartPersistenceReviewInputErrorCode): UnraidRestartPersistenceReview {
  const messages: Record<UnraidRestartPersistenceReviewInputErrorCode, string> = {
    UNRAID_RESTART_PERSISTENCE_INPUT_REQUIRED: 'One Unraid restart persistence JSON input is required.',
    UNRAID_RESTART_PERSISTENCE_FILE_READ_FAILED: 'The supplied Unraid restart persistence JSON file could not be read.',
    UNRAID_RESTART_PERSISTENCE_FILE_TOO_LARGE: 'The supplied Unraid restart persistence JSON file exceeds the input size limit.',
    UNRAID_RESTART_PERSISTENCE_JSON_MALFORMED: 'The supplied Unraid restart persistence input is not valid JSON.',
    UNRAID_RESTART_PERSISTENCE_OBJECT_REQUIRED: 'The supplied Unraid restart persistence JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseUnraidRestartPersistenceReviewJson(jsonText: string): Record<string, unknown> | UnraidRestartPersistenceReviewInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'UNRAID_RESTART_PERSISTENCE_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'UNRAID_RESTART_PERSISTENCE_JSON_MALFORMED';
  }
}

export function formatUnraidRestartPersistenceReviewJson(report: UnraidRestartPersistenceReview): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatUnraidRestartPersistenceReviewText(report: UnraidRestartPersistenceReview): string {
  const lines = [
    'Phase 139 Unraid restart persistence review',
    `Restart persistence status: ${report.restartPersistenceStatus}`,
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

export function unraidRestartPersistenceReviewHasFailures(report: UnraidRestartPersistenceReview): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly UnraidRestartPersistenceReviewFinding[]): UnraidRestartPersistenceReview {
  const summary = summarize(findings);
  return {
    report: 'phase-139-unraid-restart-persistence-review',
    version: 1,
    purpose: 'review-unraid-restart-persistence-evidence-without-provider-or-ui-scope',
    source: 'single-operator-supplied-unraid-restart-persistence-json-file',
    sourcePostSwitchMaintenanceReview: 'phase-138-unraid-post-switch-maintenance-review',
    redactionSafe: true,
    evidenceValuesEchoed: false,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    mutatesUnraid: false,
    serverRebooted: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    serviceInstalled: true,
    serviceStarted: true,
    launchApproved: true,
    productionReady: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    restartPersistenceStatus: summary.fail === 0 ? 'restart-persistence-evidence-accepted' : 'not-ready',
    summary,
    findings,
  };
}

function summarize(findings: readonly UnraidRestartPersistenceReviewFinding[]): UnraidRestartPersistenceReview['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(object: Record<string, unknown>, field: string, expected: string | boolean | number, passCode: string): UnraidRestartPersistenceReviewFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): UnraidRestartPersistenceReviewFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): UnraidRestartPersistenceReviewFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): UnraidRestartPersistenceReviewFinding {
  return { level: 'warn', code, field, message };
}
