export type UnraidLaunchReadinessDecisionInputErrorCode =
  | 'LAUNCH_READINESS_INPUT_REQUIRED'
  | 'LAUNCH_READINESS_FILE_READ_FAILED'
  | 'LAUNCH_READINESS_FILE_TOO_LARGE'
  | 'LAUNCH_READINESS_JSON_MALFORMED'
  | 'LAUNCH_READINESS_OBJECT_REQUIRED';

export interface UnraidLaunchReadinessDecisionFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface UnraidLaunchReadinessDecision {
  readonly report: 'phase-134-unraid-launch-readiness-decision';
  readonly version: 1;
  readonly purpose: 'decide-launch-readiness-without-approving-launch';
  readonly source: 'single-operator-supplied-unraid-production-disposition-json-file';
  readonly sourceProductionDisposition: 'phase-133-unraid-production-disposition';
  readonly redactionSafe: true;
  readonly decisionValuesEchoed: false;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly scriptGenerated: false;
  readonly mutatesUnraid: false;
  readonly providerContactAllowed: false;
  readonly providerModeEnabled: false;
  readonly productionReady: false;
  readonly launchApproved: false;
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly launchReadinessStatus: 'ready-for-final-launch-approval-record' | 'not-ready-for-final-launch-approval-record';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly UnraidLaunchReadinessDecisionFinding[];
}

export function buildUnraidLaunchReadinessDecision(record: Record<string, unknown>): UnraidLaunchReadinessDecision {
  const findings: UnraidLaunchReadinessDecisionFinding[] = [];
  findings.push(...requiredLiteral(record, 'report', 'phase-133-unraid-production-disposition', 'PHASE_133_DISPOSITION_REPORT'));
  findings.push(...requiredLiteral(record, 'verdict', 'GO', 'PHASE_133_VERDICT_GO'));
  findings.push(...requiredLiteral(record, 'dispositionStatus', 'ready-for-launch-readiness-decision', 'PHASE_133_READY_FOR_LAUNCH_READINESS'));
  findings.push(...requiredLiteral(record, 'redactionSafe', true, 'PHASE_133_REDACTION_SAFE'));
  findings.push(...requiredLiteral(record, 'dispositionValuesEchoed', false, 'PHASE_133_NO_DISPOSITION_VALUES'));
  findings.push(...requiredLiteral(record, 'inputValuesEchoed', false, 'PHASE_133_NO_INPUT_VALUES'));
  findings.push(...requiredLiteral(record, 'commandExecution', false, 'PHASE_133_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(record, 'scriptGenerated', false, 'PHASE_133_NO_SCRIPT'));
  findings.push(...requiredLiteral(record, 'mutatesUnraid', false, 'PHASE_133_NO_MUTATION'));
  findings.push(...requiredLiteral(record, 'providerContactAllowed', false, 'PHASE_133_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(record, 'providerModeEnabled', false, 'PHASE_133_NO_PROVIDER_MODE'));
  findings.push(...requiredLiteral(record, 'productionReady', false, 'PHASE_133_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(record, 'launchApproved', false, 'PHASE_133_NOT_LAUNCH_APPROVED'));
  findings.push(...requiredLiteral(record, 'fileCustodianStatus', 'reference-harness-not-production-kms', 'FILE_CUSTODIAN_BOUNDARY'));
  findings.push(warn('LAUNCH_READINESS_DOES_NOT_APPROVE_LAUNCH', 'launchApproved', 'This decision does not set launchApproved true.'));
  findings.push(warn('LAUNCH_READINESS_REQUIRES_SEPARATE_FINAL_APPROVAL', 'approval', 'A separate final launch approval record is still required.'));
  return fromFindings(findings);
}

export function buildUnraidLaunchReadinessDecisionInputError(code: UnraidLaunchReadinessDecisionInputErrorCode): UnraidLaunchReadinessDecision {
  const messages: Record<UnraidLaunchReadinessDecisionInputErrorCode, string> = {
    LAUNCH_READINESS_INPUT_REQUIRED: 'One Phase 133 production disposition JSON input is required.',
    LAUNCH_READINESS_FILE_READ_FAILED: 'The supplied Phase 133 production disposition JSON file could not be read.',
    LAUNCH_READINESS_FILE_TOO_LARGE: 'The supplied Phase 133 production disposition JSON file exceeds the input size limit.',
    LAUNCH_READINESS_JSON_MALFORMED: 'The supplied Phase 133 production disposition input is not valid JSON.',
    LAUNCH_READINESS_OBJECT_REQUIRED: 'The supplied Phase 133 production disposition JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseUnraidLaunchReadinessDecisionJson(jsonText: string): Record<string, unknown> | UnraidLaunchReadinessDecisionInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'LAUNCH_READINESS_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'LAUNCH_READINESS_JSON_MALFORMED';
  }
}

export function formatUnraidLaunchReadinessDecisionJson(report: UnraidLaunchReadinessDecision): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatUnraidLaunchReadinessDecisionText(report: UnraidLaunchReadinessDecision): string {
  const lines = [
    'Phase 134 Unraid launch readiness decision',
    `Launch readiness status: ${report.launchReadinessStatus}`,
    `Production ready: ${report.productionReady ? 'true' : 'false'}`,
    `Launch approved: ${report.launchApproved ? 'true' : 'false'}`,
    `Command execution: ${report.commandExecution ? 'true' : 'false'}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function unraidLaunchReadinessDecisionHasFailures(report: UnraidLaunchReadinessDecision): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly UnraidLaunchReadinessDecisionFinding[]): UnraidLaunchReadinessDecision {
  const summary = summarize(findings);
  return {
    report: 'phase-134-unraid-launch-readiness-decision',
    version: 1,
    purpose: 'decide-launch-readiness-without-approving-launch',
    source: 'single-operator-supplied-unraid-production-disposition-json-file',
    sourceProductionDisposition: 'phase-133-unraid-production-disposition',
    redactionSafe: true,
    decisionValuesEchoed: false,
    inputValuesEchoed: false,
    commandExecution: false,
    scriptGenerated: false,
    mutatesUnraid: false,
    providerContactAllowed: false,
    providerModeEnabled: false,
    productionReady: false,
    launchApproved: false,
    fileCustodianStatus: 'reference-harness-not-production-kms',
    launchReadinessStatus: summary.fail === 0
      ? 'ready-for-final-launch-approval-record'
      : 'not-ready-for-final-launch-approval-record',
    summary,
    findings,
  };
}

function summarize(findings: readonly UnraidLaunchReadinessDecisionFinding[]): UnraidLaunchReadinessDecision['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(object: Record<string, unknown>, field: string, expected: string | boolean, passCode: string): UnraidLaunchReadinessDecisionFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): UnraidLaunchReadinessDecisionFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): UnraidLaunchReadinessDecisionFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): UnraidLaunchReadinessDecisionFinding {
  return { level: 'warn', code, field, message };
}
