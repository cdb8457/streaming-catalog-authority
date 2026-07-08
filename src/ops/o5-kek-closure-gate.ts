export type O5KekClosureGateInputErrorCode =
  | 'KEK_PREFLIGHT_INPUT_REQUIRED'
  | 'KEK_PREFLIGHT_FILE_READ_FAILED'
  | 'KEK_PREFLIGHT_FILE_TOO_LARGE'
  | 'KEK_PREFLIGHT_JSON_MALFORMED'
  | 'KEK_PREFLIGHT_OBJECT_REQUIRED'
  | 'VERDICT_REPORT_INPUT_REQUIRED'
  | 'VERDICT_REPORT_FILE_READ_FAILED'
  | 'VERDICT_REPORT_FILE_TOO_LARGE'
  | 'VERDICT_REPORT_JSON_MALFORMED'
  | 'VERDICT_REPORT_OBJECT_REQUIRED';

export interface O5KekClosureGateFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface O5KekClosureGateReport {
  readonly report: 'phase-118-o5-kek-closure-gate-preflight';
  readonly version: 1;
  readonly purpose: 'combine-redacted-o5-kek-preflight-and-review-verdict-evidence';
  readonly sourceKekPreflight: 'phase-30-kek-evidence-preflight';
  readonly sourceReviewVerdict: 'phase-117-o5-kek-review-verdict-preflight';
  readonly redactionSafe: true;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly liveServiceContact: false;
  readonly providerContactAllowed: false;
  readonly productionReady: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'closed/authorized';
  readonly o5Status: 'closure-ready-pending-final-authorization' | 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly reviewReadiness: 'ready-for-final-o5-authorization' | 'not-ready-for-final-o5-authorization';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly O5KekClosureGateFinding[];
}

export function buildO5KekClosureGateReport(
  kekPreflightReport: Record<string, unknown>,
  verdictReport: Record<string, unknown>,
): O5KekClosureGateReport {
  const findings: O5KekClosureGateFinding[] = [];
  findings.push(...requiredLiteral(kekPreflightReport, 'report', 'phase-30-kek-evidence-preflight', 'KEK_PREFLIGHT_REPORT_VALID'));
  findings.push(...requiredLiteral(kekPreflightReport, 'reviewReadiness', 'ready-for-review', 'KEK_PREFLIGHT_READY'));
  findings.push(...requiredLiteral(kekPreflightReport, 'redactionSafe', true, 'KEK_PREFLIGHT_REDACTION_SAFE'));
  findings.push(...requiredLiteral(kekPreflightReport, 'descriptorValuesEchoed', false, 'KEK_PREFLIGHT_NO_VALUES_ECHOED'));
  findings.push(...requiredLiteral(kekPreflightReport, 'o5Status', 'open/deferred', 'KEK_PREFLIGHT_O5_OPEN'));
  findings.push(...requiredLiteral(kekPreflightReport, 'closesO5', false, 'KEK_PREFLIGHT_DOES_NOT_CLOSE_O5'));

  findings.push(...requiredLiteral(verdictReport, 'report', 'phase-117-o5-kek-review-verdict-preflight', 'VERDICT_REPORT_VALID'));
  findings.push(...requiredLiteral(verdictReport, 'reviewReadiness', 'ready-for-o5-closure-gate', 'VERDICT_READY'));
  findings.push(...requiredLiteral(verdictReport, 'verdict', 'GO', 'VERDICT_GO'));
  findings.push(...requiredLiteral(verdictReport, 'redactionSafe', true, 'VERDICT_REDACTION_SAFE'));
  findings.push(...requiredLiteral(verdictReport, 'verdictValuesEchoed', false, 'VERDICT_NO_VALUES_ECHOED'));
  findings.push(...requiredLiteral(verdictReport, 'rawReviewerNotesIncluded', false, 'VERDICT_NO_RAW_NOTES'));
  findings.push(...requiredLiteral(verdictReport, 'commandExecution', false, 'VERDICT_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(verdictReport, 'serviceInstalled', false, 'VERDICT_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(verdictReport, 'serviceStarted', false, 'VERDICT_NO_SERVICE_START'));
  findings.push(...requiredLiteral(verdictReport, 'providerContactAllowed', false, 'VERDICT_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(verdictReport, 'productionReady', false, 'VERDICT_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(verdictReport, 'closesO4', false, 'VERDICT_DOES_NOT_CLOSE_O4'));
  findings.push(...requiredLiteral(verdictReport, 'closesO5', false, 'VERDICT_DOES_NOT_CLOSE_O5'));

  findings.push(warn('FINAL_O5_AUTHORIZATION_STILL_REQUIRED', 'o5Status', 'This preflight can mark O5 closure-ready, but final authorization is a separate gate.'));
  findings.push(warn('PRODUCTION_READINESS_STILL_FALSE', 'productionReady', 'Production readiness remains false after this O5 closure preflight.'));
  findings.push(warn('NO_UNRAID_SERVICE_MUTATION', 'serviceInstalled', 'This closure preflight installs and starts no Unraid service.'));

  return fromFindings(findings);
}

export function buildO5KekClosureGateInputErrorReport(
  code: O5KekClosureGateInputErrorCode,
): O5KekClosureGateReport {
  const messages: Record<O5KekClosureGateInputErrorCode, string> = {
    KEK_PREFLIGHT_INPUT_REQUIRED: 'One Phase 30 KEK evidence preflight JSON input is required.',
    KEK_PREFLIGHT_FILE_READ_FAILED: 'The supplied Phase 30 KEK evidence preflight JSON file could not be read.',
    KEK_PREFLIGHT_FILE_TOO_LARGE: 'The supplied Phase 30 KEK evidence preflight JSON file exceeds the input size limit.',
    KEK_PREFLIGHT_JSON_MALFORMED: 'The supplied Phase 30 KEK evidence preflight input is not valid JSON.',
    KEK_PREFLIGHT_OBJECT_REQUIRED: 'The supplied Phase 30 KEK evidence preflight JSON value must be an object.',
    VERDICT_REPORT_INPUT_REQUIRED: 'One Phase 117 review verdict report JSON input is required.',
    VERDICT_REPORT_FILE_READ_FAILED: 'The supplied Phase 117 review verdict report JSON file could not be read.',
    VERDICT_REPORT_FILE_TOO_LARGE: 'The supplied Phase 117 review verdict report JSON file exceeds the input size limit.',
    VERDICT_REPORT_JSON_MALFORMED: 'The supplied Phase 117 review verdict report input is not valid JSON.',
    VERDICT_REPORT_OBJECT_REQUIRED: 'The supplied Phase 117 review verdict report JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseO5KekClosureGateJson(
  jsonText: string,
  kind: 'kekPreflight' | 'verdict',
): Record<string, unknown> | O5KekClosureGateInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return kind === 'kekPreflight' ? 'KEK_PREFLIGHT_OBJECT_REQUIRED' : 'VERDICT_REPORT_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return kind === 'kekPreflight' ? 'KEK_PREFLIGHT_JSON_MALFORMED' : 'VERDICT_REPORT_JSON_MALFORMED';
  }
}

export function sampleO5KekPreflightReport(): Record<string, unknown> {
  return {
    report: 'phase-30-kek-evidence-preflight',
    reviewReadiness: 'ready-for-review',
    redactionSafe: true,
    descriptorValuesEchoed: false,
    o5Status: 'open/deferred',
    closesO5: false,
  };
}

export function sampleO5KekVerdictReport(): Record<string, unknown> {
  return {
    report: 'phase-117-o5-kek-review-verdict-preflight',
    reviewReadiness: 'ready-for-o5-closure-gate',
    verdict: 'GO',
    redactionSafe: true,
    verdictValuesEchoed: false,
    rawReviewerNotesIncluded: false,
    commandExecution: false,
    serviceInstalled: false,
    serviceStarted: false,
    providerContactAllowed: false,
    productionReady: false,
    closesO4: false,
    closesO5: false,
  };
}

export function formatO5KekClosureGateJson(report: O5KekClosureGateReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatO5KekClosureGateText(report: O5KekClosureGateReport): string {
  const lines = [
    'Phase 118 O5 KEK closure gate preflight',
    `Review readiness: ${report.reviewReadiness}`,
    `O4 status: ${report.o4Status}`,
    `O5 status: ${report.o5Status}`,
    `Input values echoed: ${report.inputValuesEchoed ? 'yes' : 'no'}`,
    `Command execution: ${report.commandExecution ? 'true' : 'false'}`,
    `Production ready: ${report.productionReady ? 'true' : 'false'}`,
    `Closes O4: ${report.closesO4 ? 'true' : 'false'}`,
    `Closes O5: ${report.closesO5 ? 'true' : 'false'}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function o5KekClosureGateHasFailures(report: O5KekClosureGateReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly O5KekClosureGateFinding[]): O5KekClosureGateReport {
  const summary = summarize(findings);
  const ready = summary.fail === 0;
  return {
    report: 'phase-118-o5-kek-closure-gate-preflight',
    version: 1,
    purpose: 'combine-redacted-o5-kek-preflight-and-review-verdict-evidence',
    sourceKekPreflight: 'phase-30-kek-evidence-preflight',
    sourceReviewVerdict: 'phase-117-o5-kek-review-verdict-preflight',
    redactionSafe: true,
    inputValuesEchoed: false,
    commandExecution: false,
    serviceInstalled: false,
    serviceStarted: false,
    liveServiceContact: false,
    providerContactAllowed: false,
    productionReady: false,
    closesO4: false,
    closesO5: false,
    o4Status: 'closed/authorized',
    o5Status: ready ? 'closure-ready-pending-final-authorization' : 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    reviewReadiness: ready ? 'ready-for-final-o5-authorization' : 'not-ready-for-final-o5-authorization',
    summary,
    findings,
  };
}

function summarize(findings: readonly O5KekClosureGateFinding[]): O5KekClosureGateReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): O5KekClosureGateFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): O5KekClosureGateFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): O5KekClosureGateFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): O5KekClosureGateFinding {
  return { level: 'warn', code, field, message };
}

