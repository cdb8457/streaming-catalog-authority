export type UnraidFinalHumanApprovalRecordVerdict = 'GO' | 'HOLD';
export type UnraidFinalHumanApprovalRecordInputErrorCode =
  | 'FINAL_APPROVAL_RECORD_INPUT_REQUIRED'
  | 'FINAL_APPROVAL_RECORD_FILE_READ_FAILED'
  | 'FINAL_APPROVAL_RECORD_FILE_TOO_LARGE'
  | 'FINAL_APPROVAL_RECORD_JSON_MALFORMED'
  | 'FINAL_APPROVAL_RECORD_OBJECT_REQUIRED';

export interface UnraidFinalHumanApprovalRecordFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface UnraidFinalHumanApprovalRecordPreflight {
  readonly report: 'phase-129-unraid-final-human-approval-record-preflight';
  readonly version: 1;
  readonly purpose: 'verify-explicit-human-production-approval-record-without-approving-production';
  readonly source: 'single-operator-supplied-final-human-approval-record-json-file';
  readonly sourceTemplate: 'phase-128-unraid-final-human-approval-template';
  readonly sourceProductionReadinessDecision: 'phase-127-unraid-production-readiness-decision';
  readonly redactionSafe: true;
  readonly recordValuesEchoed: false;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly serviceInstallApproved: true;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly mutatesUnraid: false;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly productionReady: false;
  readonly launchApproved: false;
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly verdict: UnraidFinalHumanApprovalRecordVerdict | 'invalid';
  readonly approvalRecordStatus: 'ready-for-operator-production-switch' | 'not-ready-for-operator-production-switch';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly UnraidFinalHumanApprovalRecordFinding[];
}

const VERDICTS = new Set<UnraidFinalHumanApprovalRecordVerdict>(['GO', 'HOLD']);

export function buildUnraidFinalHumanApprovalRecordPreflight(
  record: Record<string, unknown>,
): UnraidFinalHumanApprovalRecordPreflight {
  const findings: UnraidFinalHumanApprovalRecordFinding[] = [];
  findings.push(...requiredLiteral(record, 'record', 'phase-128-unraid-final-human-production-approval-record', 'FINAL_APPROVAL_RECORD_LABEL'));
  findings.push(...requiredLiteral(record, 'sourceTemplate', 'phase-128-unraid-final-human-approval-template', 'FINAL_APPROVAL_SOURCE_TEMPLATE'));
  findings.push(...requiredLiteral(record, 'sourceProductionReadinessDecision', 'phase-127-unraid-production-readiness-decision', 'FINAL_APPROVAL_SOURCE_DECISION'));
  findings.push(...requiredLiteral(record, 'scope', 'unraid-foundation-final-human-production-approval-only', 'FINAL_APPROVAL_SCOPE'));
  findings.push(...requiredLiteral(record, 'redactionSafe', true, 'FINAL_APPROVAL_REDACTION_SAFE'));
  findings.push(...requiredLiteral(record, 'mustExcludeRawNotes', true, 'FINAL_APPROVAL_EXCLUDES_RAW_NOTES'));
  findings.push(...requiredLiteral(record, 'rawNotesIncluded', false, 'FINAL_APPROVAL_RAW_NOTES_NOT_INCLUDED'));
  findings.push(...requiredLiteral(record, 'recordValuesEchoed', false, 'FINAL_APPROVAL_NO_RECORD_VALUES'));
  findings.push(...requiredLiteral(record, 'inputValuesEchoed', false, 'FINAL_APPROVAL_NO_INPUT_VALUES'));
  findings.push(...requiredLiteral(record, 'commandExecution', false, 'FINAL_APPROVAL_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(record, 'scriptGenerated', false, 'FINAL_APPROVAL_NO_SCRIPT'));
  findings.push(...requiredLiteral(record, 'serviceInstallApproved', true, 'FINAL_APPROVAL_INSTALL_WINDOW_APPROVED'));
  findings.push(...requiredLiteral(record, 'serviceInstalled', false, 'FINAL_APPROVAL_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(record, 'serviceStarted', false, 'FINAL_APPROVAL_NO_SERVICE_START'));
  findings.push(...requiredLiteral(record, 'mutatesUnraid', false, 'FINAL_APPROVAL_NO_UNRAID_MUTATION'));
  findings.push(...requiredLiteral(record, 'providerContactAllowed', false, 'FINAL_APPROVAL_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(record, 'providerModeEnabled', false, 'FINAL_APPROVAL_NO_PROVIDER_MODE'));
  findings.push(...requiredLiteral(record, 'productionReady', false, 'FINAL_APPROVAL_PREFLIGHT_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(record, 'launchApproved', false, 'FINAL_APPROVAL_PREFLIGHT_NOT_LAUNCH_APPROVED'));
  findings.push(...requiredLiteral(record, 'fileCustodianStatus', 'reference-harness-not-production-kms', 'FINAL_APPROVAL_FILE_CUSTODIAN_BOUNDARY'));

  const verdict = typeof record.verdict === 'string' && VERDICTS.has(record.verdict as UnraidFinalHumanApprovalRecordVerdict)
    ? record.verdict as UnraidFinalHumanApprovalRecordVerdict
    : 'invalid';
  findings.push(verdict === 'invalid'
    ? fail('FINAL_APPROVAL_VERDICT_REQUIRED', 'verdict', 'verdict must be GO or HOLD.')
    : pass(`FINAL_APPROVAL_VERDICT_${verdict}`, 'verdict', 'verdict has a fixed allowed value.'));

  if (verdict === 'GO') {
    findings.push(pass('FINAL_APPROVAL_RECORD_READY_FOR_OPERATOR_SWITCH', 'verdict', 'explicit human GO record is valid for the next operator production switch step.'));
  } else if (verdict === 'HOLD') {
    findings.push(warn('FINAL_APPROVAL_RECORD_HOLD', 'verdict', 'explicit human approval is HOLD; production switch remains blocked.'));
  }

  findings.push(warn('PREFLIGHT_DOES_NOT_APPROVE_PRODUCTION', 'productionReady', 'This preflight never flips productionReady to true.'));
  findings.push(warn('PREFLIGHT_DOES_NOT_APPROVE_LAUNCH', 'launchApproved', 'This preflight never flips launchApproved to true.'));
  return fromFindings(findings, verdict);
}

export function buildUnraidFinalHumanApprovalRecordInputErrorPreflight(
  code: UnraidFinalHumanApprovalRecordInputErrorCode,
): UnraidFinalHumanApprovalRecordPreflight {
  const messages: Record<UnraidFinalHumanApprovalRecordInputErrorCode, string> = {
    FINAL_APPROVAL_RECORD_INPUT_REQUIRED: 'One final human approval record JSON input is required.',
    FINAL_APPROVAL_RECORD_FILE_READ_FAILED: 'The supplied final human approval record JSON file could not be read.',
    FINAL_APPROVAL_RECORD_FILE_TOO_LARGE: 'The supplied final human approval record JSON file exceeds the input size limit.',
    FINAL_APPROVAL_RECORD_JSON_MALFORMED: 'The supplied final human approval record input is not valid JSON.',
    FINAL_APPROVAL_RECORD_OBJECT_REQUIRED: 'The supplied final human approval record JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])], 'invalid');
}

export function parseUnraidFinalHumanApprovalRecordJson(
  jsonText: string,
): Record<string, unknown> | UnraidFinalHumanApprovalRecordInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'FINAL_APPROVAL_RECORD_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'FINAL_APPROVAL_RECORD_JSON_MALFORMED';
  }
}

export function formatUnraidFinalHumanApprovalRecordPreflightJson(
  report: UnraidFinalHumanApprovalRecordPreflight,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatUnraidFinalHumanApprovalRecordPreflightText(
  report: UnraidFinalHumanApprovalRecordPreflight,
): string {
  const lines = [
    'Phase 129 Unraid final human approval record preflight',
    `Verdict: ${report.verdict}`,
    `Approval record status: ${report.approvalRecordStatus}`,
    `Record values echoed: ${report.recordValuesEchoed ? 'yes' : 'no'}`,
    `Production ready: ${report.productionReady ? 'true' : 'false'}`,
    `Launch approved: ${report.launchApproved ? 'true' : 'false'}`,
    `Service installed: ${report.serviceInstalled ? 'true' : 'false'}`,
    `Service started: ${report.serviceStarted ? 'true' : 'false'}`,
    `Provider contact allowed: ${report.providerContactAllowed ? 'true' : 'false'}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function unraidFinalHumanApprovalRecordHasFailures(report: UnraidFinalHumanApprovalRecordPreflight): boolean {
  return report.summary.fail > 0;
}

function fromFindings(
  findings: readonly UnraidFinalHumanApprovalRecordFinding[],
  verdict: UnraidFinalHumanApprovalRecordPreflight['verdict'],
): UnraidFinalHumanApprovalRecordPreflight {
  const summary = summarize(findings);
  return {
    report: 'phase-129-unraid-final-human-approval-record-preflight',
    version: 1,
    purpose: 'verify-explicit-human-production-approval-record-without-approving-production',
    source: 'single-operator-supplied-final-human-approval-record-json-file',
    sourceTemplate: 'phase-128-unraid-final-human-approval-template',
    sourceProductionReadinessDecision: 'phase-127-unraid-production-readiness-decision',
    redactionSafe: true,
    recordValuesEchoed: false,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    serviceInstallApproved: true,
    serviceInstalled: false,
    serviceStarted: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    productionReady: false,
    launchApproved: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    verdict,
    approvalRecordStatus: summary.fail === 0 && verdict === 'GO'
      ? 'ready-for-operator-production-switch'
      : 'not-ready-for-operator-production-switch',
    summary,
    findings,
  };
}

function summarize(findings: readonly UnraidFinalHumanApprovalRecordFinding[]): UnraidFinalHumanApprovalRecordPreflight['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): UnraidFinalHumanApprovalRecordFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): UnraidFinalHumanApprovalRecordFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): UnraidFinalHumanApprovalRecordFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): UnraidFinalHumanApprovalRecordFinding {
  return { level: 'warn', code, field, message };
}
