export type UnraidServiceRunbookApprovalGateInputErrorCode =
  | 'RUNBOOK_INPUT_REQUIRED'
  | 'RUNBOOK_FILE_READ_FAILED'
  | 'RUNBOOK_FILE_TOO_LARGE'
  | 'RUNBOOK_JSON_MALFORMED'
  | 'RUNBOOK_OBJECT_REQUIRED'
  | 'REVIEW_INPUT_REQUIRED'
  | 'REVIEW_FILE_READ_FAILED'
  | 'REVIEW_FILE_TOO_LARGE'
  | 'REVIEW_JSON_MALFORMED'
  | 'REVIEW_OBJECT_REQUIRED';

export interface UnraidServiceRunbookApprovalFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface UnraidServiceRunbookApprovalGateReport {
  readonly report: 'phase-122-unraid-service-runbook-approval-gate';
  readonly version: 1;
  readonly purpose: 'gate-redacted-runbook-review-before-future-service-install-authorization';
  readonly sourceRunbook: 'phase-121-unraid-service-install-runbook';
  readonly redactionSafe: true;
  readonly inputValuesEchoed: false;
  readonly rawReviewerNotesIncluded: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly serviceInstallApproved: false;
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
  readonly runbookApprovalStatus: 'ready-for-future-install-authorization' | 'not-ready';
  readonly readyForInstallAuthorization: boolean;
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly UnraidServiceRunbookApprovalFinding[];
}

export function buildUnraidServiceRunbookApprovalGateReport(
  runbookReport: Record<string, unknown>,
  reviewRecord: Record<string, unknown>,
): UnraidServiceRunbookApprovalGateReport {
  const findings: UnraidServiceRunbookApprovalFinding[] = [];
  findings.push(...requiredLiteral(runbookReport, 'report', 'phase-121-unraid-service-install-runbook', 'RUNBOOK_REPORT_VALID'));
  findings.push(...requiredLiteral(runbookReport, 'runbookReviewStatus', 'draft-pending-operator-review', 'RUNBOOK_DRAFT_REVIEW_STATUS'));
  findings.push(...requiredLiteral(runbookReport, 'redactionSafe', true, 'RUNBOOK_REDACTION_SAFE'));
  findings.push(...requiredLiteral(runbookReport, 'inputValuesEchoed', false, 'RUNBOOK_NO_VALUES_ECHOED'));
  findings.push(...requiredLiteral(runbookReport, 'commandExecution', false, 'RUNBOOK_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(runbookReport, 'scriptGenerated', false, 'RUNBOOK_NO_SCRIPT_GENERATED'));
  findings.push(...requiredLiteral(runbookReport, 'serviceInstallApproved', false, 'RUNBOOK_NO_SERVICE_INSTALL_APPROVAL'));
  findings.push(...requiredLiteral(runbookReport, 'serviceInstalled', false, 'RUNBOOK_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(runbookReport, 'serviceStarted', false, 'RUNBOOK_NO_SERVICE_START'));
  findings.push(...requiredLiteral(runbookReport, 'mutatesUnraid', false, 'RUNBOOK_NO_UNRAID_MUTATION'));
  findings.push(...requiredLiteral(runbookReport, 'providerContactAllowed', false, 'RUNBOOK_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(runbookReport, 'productionReady', false, 'RUNBOOK_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(runbookReport, 'closesO4', false, 'RUNBOOK_DOES_NOT_CLOSE_O4'));
  findings.push(...requiredLiteral(runbookReport, 'closesO5', false, 'RUNBOOK_DOES_NOT_CLOSE_O5'));
  findings.push(...requiredLiteral(runbookReport, 'o4Status', 'closed/authorized', 'RUNBOOK_O4_ALREADY_AUTHORIZED'));
  findings.push(...requiredLiteral(runbookReport, 'o5Status', 'closed/authorized', 'RUNBOOK_O5_ALREADY_AUTHORIZED'));

  findings.push(...requiredLiteral(reviewRecord, 'record', 'phase-122-unraid-service-runbook-approval-record', 'REVIEW_RECORD_VALID'));
  findings.push(...requiredLiteral(reviewRecord, 'verdict', 'GO', 'REVIEW_VERDICT_GO'));
  findings.push(...requiredLiteral(reviewRecord, 'scope', 'unraid-service-runbook-review-only', 'REVIEW_SCOPE_RUNBOOK_ONLY'));
  findings.push(...requiredLiteral(reviewRecord, 'redactionSafe', true, 'REVIEW_REDACTION_SAFE'));
  findings.push(...requiredLiteral(reviewRecord, 'reviewValuesEchoed', false, 'REVIEW_NO_VALUES_ECHOED'));
  findings.push(...requiredLiteral(reviewRecord, 'rawReviewerNotesIncluded', false, 'REVIEW_NO_RAW_NOTES'));
  findings.push(...requiredLiteral(reviewRecord, 'commandExecution', false, 'REVIEW_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(reviewRecord, 'scriptGenerated', false, 'REVIEW_NO_SCRIPT_GENERATED'));
  findings.push(...requiredLiteral(reviewRecord, 'serviceInstallApproved', false, 'REVIEW_DOES_NOT_APPROVE_INSTALL'));
  findings.push(...requiredLiteral(reviewRecord, 'serviceInstalled', false, 'REVIEW_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(reviewRecord, 'serviceStarted', false, 'REVIEW_NO_SERVICE_START'));
  findings.push(...requiredLiteral(reviewRecord, 'productionReady', false, 'REVIEW_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(reviewRecord, 'closesO4', false, 'REVIEW_DOES_NOT_CLOSE_O4'));
  findings.push(...requiredLiteral(reviewRecord, 'closesO5', false, 'REVIEW_DOES_NOT_CLOSE_O5'));

  findings.push(warn('INSTALL_AUTHORIZATION_STILL_FUTURE', 'serviceInstallApproved', 'A GO review only prepares a future install authorization gate.'));
  findings.push(warn('NO_UNRAID_SERVICE_MUTATION', 'serviceInstalled', 'This gate installs and starts no Unraid service.'));
  findings.push(warn('PRODUCTION_READINESS_STILL_FALSE', 'productionReady', 'Production readiness remains false.'));

  return fromFindings(findings);
}

export function buildUnraidServiceRunbookApprovalGateInputErrorReport(
  code: UnraidServiceRunbookApprovalGateInputErrorCode,
): UnraidServiceRunbookApprovalGateReport {
  const messages: Record<UnraidServiceRunbookApprovalGateInputErrorCode, string> = {
    RUNBOOK_INPUT_REQUIRED: 'One Phase 121 runbook JSON input is required.',
    RUNBOOK_FILE_READ_FAILED: 'The supplied Phase 121 runbook JSON file could not be read.',
    RUNBOOK_FILE_TOO_LARGE: 'The supplied Phase 121 runbook JSON file exceeds the input size limit.',
    RUNBOOK_JSON_MALFORMED: 'The supplied Phase 121 runbook input is not valid JSON.',
    RUNBOOK_OBJECT_REQUIRED: 'The supplied Phase 121 runbook JSON value must be an object.',
    REVIEW_INPUT_REQUIRED: 'One Phase 122 review record JSON input is required.',
    REVIEW_FILE_READ_FAILED: 'The supplied Phase 122 review record JSON file could not be read.',
    REVIEW_FILE_TOO_LARGE: 'The supplied Phase 122 review record JSON file exceeds the input size limit.',
    REVIEW_JSON_MALFORMED: 'The supplied Phase 122 review record input is not valid JSON.',
    REVIEW_OBJECT_REQUIRED: 'The supplied Phase 122 review record JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseUnraidServiceRunbookApprovalGateJson(
  jsonText: string,
  kind: 'runbook' | 'review',
): Record<string, unknown> | UnraidServiceRunbookApprovalGateInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return kind === 'runbook' ? 'RUNBOOK_OBJECT_REQUIRED' : 'REVIEW_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return kind === 'runbook' ? 'RUNBOOK_JSON_MALFORMED' : 'REVIEW_JSON_MALFORMED';
  }
}

export function sampleUnraidServiceInstallRunbookReport(): Record<string, unknown> {
  return {
    report: 'phase-121-unraid-service-install-runbook',
    runbookReviewStatus: 'draft-pending-operator-review',
    redactionSafe: true,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    serviceInstallApproved: false,
    serviceInstalled: false,
    serviceStarted: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    productionReady: false,
    closesO4: false,
    closesO5: false,
    o4Status: 'closed/authorized',
    o5Status: 'closed/authorized',
  };
}

export function sampleUnraidServiceRunbookApprovalRecord(): Record<string, unknown> {
  return {
    record: 'phase-122-unraid-service-runbook-approval-record',
    verdict: 'GO',
    scope: 'unraid-service-runbook-review-only',
    redactionSafe: true,
    reviewValuesEchoed: false,
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

export function formatUnraidServiceRunbookApprovalGateJson(report: UnraidServiceRunbookApprovalGateReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatUnraidServiceRunbookApprovalGateText(report: UnraidServiceRunbookApprovalGateReport): string {
  const lines = [
    'Phase 122 Unraid service runbook approval gate',
    `Runbook approval status: ${report.runbookApprovalStatus}`,
    `Ready for install authorization: ${report.readyForInstallAuthorization ? 'true' : 'false'}`,
    `Input values echoed: ${report.inputValuesEchoed ? 'yes' : 'no'}`,
    `Raw reviewer notes included: ${report.rawReviewerNotesIncluded ? 'yes' : 'no'}`,
    `Command execution: ${report.commandExecution ? 'true' : 'false'}`,
    `Script generated: ${report.scriptGenerated ? 'true' : 'false'}`,
    `Service install approved: ${report.serviceInstallApproved ? 'true' : 'false'}`,
    `Service installed: ${report.serviceInstalled ? 'true' : 'false'}`,
    `Service started: ${report.serviceStarted ? 'true' : 'false'}`,
    `Production ready: ${report.productionReady ? 'true' : 'false'}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function unraidServiceRunbookApprovalGateHasFailures(report: UnraidServiceRunbookApprovalGateReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly UnraidServiceRunbookApprovalFinding[]): UnraidServiceRunbookApprovalGateReport {
  const summary = summarize(findings);
  const ready = summary.fail === 0;
  return {
    report: 'phase-122-unraid-service-runbook-approval-gate',
    version: 1,
    purpose: 'gate-redacted-runbook-review-before-future-service-install-authorization',
    sourceRunbook: 'phase-121-unraid-service-install-runbook',
    redactionSafe: true,
    inputValuesEchoed: false,
    rawReviewerNotesIncluded: false,
    commandExecution: false,
    scriptGenerated: false,
    serviceInstallApproved: false,
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
    runbookApprovalStatus: ready ? 'ready-for-future-install-authorization' : 'not-ready',
    readyForInstallAuthorization: ready,
    summary,
    findings,
  };
}

function summarize(findings: readonly UnraidServiceRunbookApprovalFinding[]): UnraidServiceRunbookApprovalGateReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): UnraidServiceRunbookApprovalFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): UnraidServiceRunbookApprovalFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): UnraidServiceRunbookApprovalFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): UnraidServiceRunbookApprovalFinding {
  return { level: 'warn', code, field, message };
}
