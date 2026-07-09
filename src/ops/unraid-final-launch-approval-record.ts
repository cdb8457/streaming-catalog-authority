export type UnraidFinalLaunchApprovalRecordInputErrorCode =
  | 'FINAL_LAUNCH_APPROVAL_INPUT_REQUIRED'
  | 'FINAL_LAUNCH_APPROVAL_FILE_READ_FAILED'
  | 'FINAL_LAUNCH_APPROVAL_FILE_TOO_LARGE'
  | 'FINAL_LAUNCH_APPROVAL_JSON_MALFORMED'
  | 'FINAL_LAUNCH_APPROVAL_OBJECT_REQUIRED';

export interface UnraidFinalLaunchApprovalRecordFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface UnraidFinalLaunchApprovalRecord {
  readonly report: 'phase-135-unraid-final-launch-approval-record';
  readonly version: 1;
  readonly purpose: 'record-final-human-launch-approval-without-executing-switch';
  readonly source: 'single-operator-supplied-final-launch-approval-record-json-file';
  readonly sourceLaunchReadinessDecision: 'phase-134-unraid-launch-readiness-decision';
  readonly requiredLaunchReadinessStatus: 'ready-for-final-launch-approval-record';
  readonly redactionSafe: true;
  readonly approvalValuesEchoed: false;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly mutatesUnraid: false;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly serviceInstallApproved: true;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly productionReady: false;
  readonly launchApproved: boolean;
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly finalLaunchApprovalStatus: 'ready-for-production-switch-execution-packet' | 'not-ready-for-production-switch-execution-packet';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly UnraidFinalLaunchApprovalRecordFinding[];
}

export function buildUnraidFinalLaunchApprovalRecord(record: Record<string, unknown>): UnraidFinalLaunchApprovalRecord {
  const findings: UnraidFinalLaunchApprovalRecordFinding[] = [];
  findings.push(...requiredLiteral(record, 'record', 'phase-135-unraid-final-launch-approval-record', 'FINAL_LAUNCH_APPROVAL_RECORD_LABEL'));
  findings.push(...requiredLiteral(record, 'sourceLaunchReadinessDecision', 'phase-134-unraid-launch-readiness-decision', 'PHASE_134_SOURCE_DECISION'));
  findings.push(...requiredLiteral(record, 'launchReadinessStatus', 'ready-for-final-launch-approval-record', 'PHASE_134_READY_FOR_FINAL_APPROVAL'));
  findings.push(...requiredLiteral(record, 'verdict', 'GO', 'FINAL_LAUNCH_APPROVAL_VERDICT_GO'));
  findings.push(...requiredLiteral(record, 'operatorFinalLaunchApproval', 'APPROVE_UNRAID_PRODUCTION_SWITCH', 'FINAL_LAUNCH_APPROVAL_TOKEN'));
  findings.push(...requiredLiteral(record, 'approvedByHuman', true, 'FINAL_LAUNCH_APPROVAL_HUMAN_APPROVED'));
  findings.push(...requiredLiteral(record, 'redactionSafe', true, 'FINAL_LAUNCH_APPROVAL_REDACTION_SAFE'));
  findings.push(...requiredLiteral(record, 'approvalValuesEchoed', false, 'FINAL_LAUNCH_APPROVAL_NO_APPROVAL_VALUES'));
  findings.push(...requiredLiteral(record, 'inputValuesEchoed', false, 'FINAL_LAUNCH_APPROVAL_NO_INPUT_VALUES'));
  findings.push(...requiredLiteral(record, 'commandExecution', false, 'FINAL_LAUNCH_APPROVAL_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(record, 'scriptGenerated', false, 'FINAL_LAUNCH_APPROVAL_NO_SCRIPT'));
  findings.push(...requiredLiteral(record, 'mutatesUnraid', false, 'FINAL_LAUNCH_APPROVAL_NO_MUTATION'));
  findings.push(...requiredLiteral(record, 'providerContactAllowed', false, 'FINAL_LAUNCH_APPROVAL_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(record, 'providerModeEnabled', false, 'FINAL_LAUNCH_APPROVAL_NO_PROVIDER_MODE'));
  findings.push(...requiredLiteral(record, 'serviceInstalled', false, 'FINAL_LAUNCH_APPROVAL_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(record, 'serviceStarted', false, 'FINAL_LAUNCH_APPROVAL_NO_SERVICE_START'));
  findings.push(...requiredLiteral(record, 'productionReady', false, 'FINAL_LAUNCH_APPROVAL_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(record, 'fileCustodianStatus', 'reference-harness-not-production-kms', 'FILE_CUSTODIAN_BOUNDARY'));
  findings.push(warn('FINAL_LAUNCH_APPROVAL_DOES_NOT_EXECUTE_SWITCH', 'commandExecution', 'This record approves preparing the switch execution packet but never executes it.'));
  findings.push(warn('FINAL_LAUNCH_APPROVAL_NOT_RUNTIME_PROOF', 'productionReady', 'Production readiness still requires the real switch and post-switch evidence.'));
  return fromFindings(findings);
}

export function buildUnraidFinalLaunchApprovalRecordInputError(code: UnraidFinalLaunchApprovalRecordInputErrorCode): UnraidFinalLaunchApprovalRecord {
  const messages: Record<UnraidFinalLaunchApprovalRecordInputErrorCode, string> = {
    FINAL_LAUNCH_APPROVAL_INPUT_REQUIRED: 'One final launch approval record JSON input is required.',
    FINAL_LAUNCH_APPROVAL_FILE_READ_FAILED: 'The supplied final launch approval record JSON file could not be read.',
    FINAL_LAUNCH_APPROVAL_FILE_TOO_LARGE: 'The supplied final launch approval record JSON file exceeds the input size limit.',
    FINAL_LAUNCH_APPROVAL_JSON_MALFORMED: 'The supplied final launch approval record input is not valid JSON.',
    FINAL_LAUNCH_APPROVAL_OBJECT_REQUIRED: 'The supplied final launch approval record JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseUnraidFinalLaunchApprovalRecordJson(jsonText: string): Record<string, unknown> | UnraidFinalLaunchApprovalRecordInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'FINAL_LAUNCH_APPROVAL_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'FINAL_LAUNCH_APPROVAL_JSON_MALFORMED';
  }
}

export function formatUnraidFinalLaunchApprovalRecordJson(report: UnraidFinalLaunchApprovalRecord): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatUnraidFinalLaunchApprovalRecordText(report: UnraidFinalLaunchApprovalRecord): string {
  const lines = [
    'Phase 135 Unraid final launch approval record',
    `Final launch approval status: ${report.finalLaunchApprovalStatus}`,
    `Launch approved: ${report.launchApproved ? 'true' : 'false'}`,
    `Production ready: ${report.productionReady ? 'true' : 'false'}`,
    `Command execution: ${report.commandExecution ? 'true' : 'false'}`,
    `Service installed: ${report.serviceInstalled ? 'true' : 'false'}`,
    `Service started: ${report.serviceStarted ? 'true' : 'false'}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function unraidFinalLaunchApprovalRecordHasFailures(report: UnraidFinalLaunchApprovalRecord): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly UnraidFinalLaunchApprovalRecordFinding[]): UnraidFinalLaunchApprovalRecord {
  const summary = summarize(findings);
  const approved = summary.fail === 0;
  return {
    report: 'phase-135-unraid-final-launch-approval-record',
    version: 1,
    purpose: 'record-final-human-launch-approval-without-executing-switch',
    source: 'single-operator-supplied-final-launch-approval-record-json-file',
    sourceLaunchReadinessDecision: 'phase-134-unraid-launch-readiness-decision',
    requiredLaunchReadinessStatus: 'ready-for-final-launch-approval-record',
    redactionSafe: true,
    approvalValuesEchoed: false,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    serviceInstallApproved: true,
    serviceInstalled: false,
    serviceStarted: false,
    productionReady: false,
    launchApproved: approved,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    finalLaunchApprovalStatus: approved
      ? 'ready-for-production-switch-execution-packet'
      : 'not-ready-for-production-switch-execution-packet',
    summary,
    findings,
  };
}

function summarize(findings: readonly UnraidFinalLaunchApprovalRecordFinding[]): UnraidFinalLaunchApprovalRecord['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(object: Record<string, unknown>, field: string, expected: string | boolean, passCode: string): UnraidFinalLaunchApprovalRecordFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): UnraidFinalLaunchApprovalRecordFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): UnraidFinalLaunchApprovalRecordFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): UnraidFinalLaunchApprovalRecordFinding {
  return { level: 'warn', code, field, message };
}
