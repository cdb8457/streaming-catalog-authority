export type UnraidServiceInstallAuthorizationInputErrorCode =
  | 'APPROVAL_GATE_INPUT_REQUIRED'
  | 'APPROVAL_GATE_FILE_READ_FAILED'
  | 'APPROVAL_GATE_FILE_TOO_LARGE'
  | 'APPROVAL_GATE_JSON_MALFORMED'
  | 'APPROVAL_GATE_OBJECT_REQUIRED'
  | 'AUTHORIZATION_INPUT_REQUIRED'
  | 'AUTHORIZATION_FILE_READ_FAILED'
  | 'AUTHORIZATION_FILE_TOO_LARGE'
  | 'AUTHORIZATION_JSON_MALFORMED'
  | 'AUTHORIZATION_OBJECT_REQUIRED';

export interface UnraidServiceInstallAuthorizationFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface UnraidServiceInstallAuthorizationReport {
  readonly report: 'phase-123-unraid-service-install-authorization';
  readonly version: 1;
  readonly purpose: 'authorize-future-operator-run-unraid-service-install-window-without-execution';
  readonly sourceApprovalGate: 'phase-122-unraid-service-runbook-approval-gate';
  readonly redactionSafe: true;
  readonly inputValuesEchoed: false;
  readonly rawAuthorizationNotesIncluded: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly serviceInstallApproved: boolean;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly mutatesUnraid: false;
  readonly liveServiceContact: false;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly productionReady: false;
  readonly launchApproved: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'closed/authorized';
  readonly o5Status: 'closed/authorized';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly installAuthorizationStatus: 'install-window-authorized' | 'not-authorized';
  readonly nextRequiredEvidence: readonly string[];
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly UnraidServiceInstallAuthorizationFinding[];
}

export function buildUnraidServiceInstallAuthorizationReport(
  approvalGateReport: Record<string, unknown>,
  authorizationRecord: Record<string, unknown>,
): UnraidServiceInstallAuthorizationReport {
  const findings: UnraidServiceInstallAuthorizationFinding[] = [];
  findings.push(...requiredLiteral(approvalGateReport, 'report', 'phase-122-unraid-service-runbook-approval-gate', 'APPROVAL_GATE_REPORT_VALID'));
  findings.push(...requiredLiteral(approvalGateReport, 'runbookApprovalStatus', 'ready-for-future-install-authorization', 'APPROVAL_GATE_READY'));
  findings.push(...requiredLiteral(approvalGateReport, 'readyForInstallAuthorization', true, 'APPROVAL_GATE_READY_FLAG'));
  findings.push(...requiredLiteral(approvalGateReport, 'redactionSafe', true, 'APPROVAL_GATE_REDACTION_SAFE'));
  findings.push(...requiredLiteral(approvalGateReport, 'inputValuesEchoed', false, 'APPROVAL_GATE_NO_VALUES_ECHOED'));
  findings.push(...requiredLiteral(approvalGateReport, 'rawReviewerNotesIncluded', false, 'APPROVAL_GATE_NO_RAW_NOTES'));
  findings.push(...requiredLiteral(approvalGateReport, 'commandExecution', false, 'APPROVAL_GATE_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(approvalGateReport, 'scriptGenerated', false, 'APPROVAL_GATE_NO_SCRIPT_GENERATED'));
  findings.push(...requiredLiteral(approvalGateReport, 'serviceInstallApproved', false, 'APPROVAL_GATE_DID_NOT_APPROVE_INSTALL'));
  findings.push(...requiredLiteral(approvalGateReport, 'serviceInstalled', false, 'APPROVAL_GATE_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(approvalGateReport, 'serviceStarted', false, 'APPROVAL_GATE_NO_SERVICE_START'));
  findings.push(...requiredLiteral(approvalGateReport, 'productionReady', false, 'APPROVAL_GATE_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(approvalGateReport, 'closesO4', false, 'APPROVAL_GATE_DOES_NOT_CLOSE_O4'));
  findings.push(...requiredLiteral(approvalGateReport, 'closesO5', false, 'APPROVAL_GATE_DOES_NOT_CLOSE_O5'));

  findings.push(...requiredLiteral(authorizationRecord, 'record', 'phase-123-unraid-service-install-authorization-record', 'AUTHORIZATION_RECORD_VALID'));
  findings.push(...requiredLiteral(authorizationRecord, 'authorizesServiceInstallWindow', true, 'AUTHORIZATION_APPROVES_INSTALL_WINDOW'));
  findings.push(...requiredLiteral(authorizationRecord, 'scope', 'unraid-service-install-window-only', 'AUTHORIZATION_SCOPE_INSTALL_WINDOW_ONLY'));
  findings.push(...requiredLiteral(authorizationRecord, 'redactionSafe', true, 'AUTHORIZATION_REDACTION_SAFE'));
  findings.push(...requiredLiteral(authorizationRecord, 'authorizationValuesEchoed', false, 'AUTHORIZATION_NO_VALUES_ECHOED'));
  findings.push(...requiredLiteral(authorizationRecord, 'rawAuthorizationNotesIncluded', false, 'AUTHORIZATION_NO_RAW_NOTES'));
  findings.push(...requiredLiteral(authorizationRecord, 'commandExecution', false, 'AUTHORIZATION_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(authorizationRecord, 'scriptGenerated', false, 'AUTHORIZATION_NO_SCRIPT_GENERATED'));
  findings.push(...requiredLiteral(authorizationRecord, 'serviceInstalled', false, 'AUTHORIZATION_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(authorizationRecord, 'serviceStarted', false, 'AUTHORIZATION_NO_SERVICE_START'));
  findings.push(...requiredLiteral(authorizationRecord, 'providerContactAllowed', false, 'AUTHORIZATION_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(authorizationRecord, 'productionReady', false, 'AUTHORIZATION_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(authorizationRecord, 'launchApproved', false, 'AUTHORIZATION_NO_LAUNCH_APPROVAL'));
  findings.push(...requiredLiteral(authorizationRecord, 'closesO4', false, 'AUTHORIZATION_DOES_NOT_CLOSE_O4'));
  findings.push(...requiredLiteral(authorizationRecord, 'closesO5', false, 'AUTHORIZATION_DOES_NOT_CLOSE_O5'));

  findings.push(warn('INSTALL_STILL_OPERATOR_RUN', 'serviceInstallApproved', 'Authorization permits a future operator-run install window only.'));
  findings.push(warn('NO_UNRAID_SERVICE_MUTATION', 'serviceInstalled', 'This record installs and starts no Unraid service.'));
  findings.push(warn('PRODUCTION_READINESS_STILL_FALSE', 'productionReady', 'Production readiness remains false.'));

  return fromFindings(findings);
}

export function buildUnraidServiceInstallAuthorizationInputErrorReport(
  code: UnraidServiceInstallAuthorizationInputErrorCode,
): UnraidServiceInstallAuthorizationReport {
  const messages: Record<UnraidServiceInstallAuthorizationInputErrorCode, string> = {
    APPROVAL_GATE_INPUT_REQUIRED: 'One Phase 122 approval gate JSON input is required.',
    APPROVAL_GATE_FILE_READ_FAILED: 'The supplied Phase 122 approval gate JSON file could not be read.',
    APPROVAL_GATE_FILE_TOO_LARGE: 'The supplied Phase 122 approval gate JSON file exceeds the input size limit.',
    APPROVAL_GATE_JSON_MALFORMED: 'The supplied Phase 122 approval gate input is not valid JSON.',
    APPROVAL_GATE_OBJECT_REQUIRED: 'The supplied Phase 122 approval gate JSON value must be an object.',
    AUTHORIZATION_INPUT_REQUIRED: 'One Phase 123 authorization record JSON input is required.',
    AUTHORIZATION_FILE_READ_FAILED: 'The supplied Phase 123 authorization record JSON file could not be read.',
    AUTHORIZATION_FILE_TOO_LARGE: 'The supplied Phase 123 authorization record JSON file exceeds the input size limit.',
    AUTHORIZATION_JSON_MALFORMED: 'The supplied Phase 123 authorization record input is not valid JSON.',
    AUTHORIZATION_OBJECT_REQUIRED: 'The supplied Phase 123 authorization record JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseUnraidServiceInstallAuthorizationJson(
  jsonText: string,
  kind: 'approvalGate' | 'authorization',
): Record<string, unknown> | UnraidServiceInstallAuthorizationInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return kind === 'approvalGate' ? 'APPROVAL_GATE_OBJECT_REQUIRED' : 'AUTHORIZATION_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return kind === 'approvalGate' ? 'APPROVAL_GATE_JSON_MALFORMED' : 'AUTHORIZATION_JSON_MALFORMED';
  }
}

export function sampleUnraidServiceRunbookApprovalGateReport(): Record<string, unknown> {
  return {
    report: 'phase-122-unraid-service-runbook-approval-gate',
    runbookApprovalStatus: 'ready-for-future-install-authorization',
    readyForInstallAuthorization: true,
    redactionSafe: true,
    inputValuesEchoed: false,
    rawReviewerNotesIncluded: false,
    commandExecution: false,
    scriptGenerated: false,
    serviceInstallApproved: false,
    serviceInstalled: false,
    serviceStarted: false,
    productionReady: false,
    closesO4: false,
    closesO5: false,
  };
}

export function sampleUnraidServiceInstallAuthorizationRecord(): Record<string, unknown> {
  return {
    record: 'phase-123-unraid-service-install-authorization-record',
    authorizesServiceInstallWindow: true,
    scope: 'unraid-service-install-window-only',
    redactionSafe: true,
    authorizationValuesEchoed: false,
    rawAuthorizationNotesIncluded: false,
    commandExecution: false,
    scriptGenerated: false,
    serviceInstalled: false,
    serviceStarted: false,
    providerContactAllowed: false,
    productionReady: false,
    launchApproved: false,
    closesO4: false,
    closesO5: false,
  };
}

export function formatUnraidServiceInstallAuthorizationJson(report: UnraidServiceInstallAuthorizationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatUnraidServiceInstallAuthorizationText(report: UnraidServiceInstallAuthorizationReport): string {
  const lines = [
    'Phase 123 Unraid service install authorization',
    `Install authorization status: ${report.installAuthorizationStatus}`,
    `Service install approved: ${report.serviceInstallApproved ? 'true' : 'false'}`,
    `Service installed: ${report.serviceInstalled ? 'true' : 'false'}`,
    `Service started: ${report.serviceStarted ? 'true' : 'false'}`,
    `Command execution: ${report.commandExecution ? 'true' : 'false'}`,
    `Script generated: ${report.scriptGenerated ? 'true' : 'false'}`,
    `Production ready: ${report.productionReady ? 'true' : 'false'}`,
    `Launch approved: ${report.launchApproved ? 'true' : 'false'}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function unraidServiceInstallAuthorizationHasFailures(report: UnraidServiceInstallAuthorizationReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly UnraidServiceInstallAuthorizationFinding[]): UnraidServiceInstallAuthorizationReport {
  const summary = summarize(findings);
  const authorized = summary.fail === 0;
  return {
    report: 'phase-123-unraid-service-install-authorization',
    version: 1,
    purpose: 'authorize-future-operator-run-unraid-service-install-window-without-execution',
    sourceApprovalGate: 'phase-122-unraid-service-runbook-approval-gate',
    redactionSafe: true,
    inputValuesEchoed: false,
    rawAuthorizationNotesIncluded: false,
    commandExecution: false,
    scriptGenerated: false,
    serviceInstallApproved: authorized,
    serviceInstalled: false,
    serviceStarted: false,
    mutatesUnraid: false,
    liveServiceContact: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    productionReady: false,
    launchApproved: false,
    closesO4: false,
    closesO5: false,
    o4Status: 'closed/authorized',
    o5Status: 'closed/authorized',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    installAuthorizationStatus: authorized ? 'install-window-authorized' : 'not-authorized',
    nextRequiredEvidence: authorized ? [
      'operator-run-install-window-evidence-redacted',
      'service-install-result-redacted',
      'rollback-readiness-confirmation-redacted',
      'post-install-validation-plan-redacted',
    ] : [],
    summary,
    findings,
  };
}

function summarize(findings: readonly UnraidServiceInstallAuthorizationFinding[]): UnraidServiceInstallAuthorizationReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): UnraidServiceInstallAuthorizationFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): UnraidServiceInstallAuthorizationFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): UnraidServiceInstallAuthorizationFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): UnraidServiceInstallAuthorizationFinding {
  return { level: 'warn', code, field, message };
}
