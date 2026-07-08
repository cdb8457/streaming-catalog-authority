export type SidecarUnraidO4ClosureGateInputErrorCode =
  | 'BOUNDARY_REPORT_INPUT_REQUIRED'
  | 'BOUNDARY_REPORT_FILE_READ_FAILED'
  | 'BOUNDARY_REPORT_FILE_TOO_LARGE'
  | 'BOUNDARY_REPORT_JSON_MALFORMED'
  | 'BOUNDARY_REPORT_OBJECT_REQUIRED'
  | 'VERDICT_REPORT_INPUT_REQUIRED'
  | 'VERDICT_REPORT_FILE_READ_FAILED'
  | 'VERDICT_REPORT_FILE_TOO_LARGE'
  | 'VERDICT_REPORT_JSON_MALFORMED'
  | 'VERDICT_REPORT_OBJECT_REQUIRED';

export interface SidecarUnraidO4ClosureGateFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface SidecarUnraidO4ClosureGateReport {
  readonly report: 'phase-115-sidecar-unraid-o4-closure-gate-preflight';
  readonly version: 1;
  readonly purpose: 'combine-redacted-sidecar-o4-boundary-and-review-verdict-evidence';
  readonly sourceBoundaryPreflight: 'phase-113-sidecar-unraid-custodian-boundary-preflight';
  readonly sourceReviewVerdict: 'phase-114-sidecar-unraid-custodian-review-verdict-preflight';
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
  readonly o4Status: 'closure-ready-pending-final-authorization' | 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly reviewReadiness: 'ready-for-final-o4-authorization' | 'not-ready-for-final-o4-authorization';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly SidecarUnraidO4ClosureGateFinding[];
}

export function buildSidecarUnraidO4ClosureGateReport(
  boundaryReport: Record<string, unknown>,
  verdictReport: Record<string, unknown>,
): SidecarUnraidO4ClosureGateReport {
  const findings: SidecarUnraidO4ClosureGateFinding[] = [];
  findings.push(...requiredLiteral(boundaryReport, 'report', 'phase-113-sidecar-unraid-custodian-boundary-preflight', 'BOUNDARY_REPORT_VALID'));
  findings.push(...requiredLiteral(boundaryReport, 'reviewReadiness', 'ready-for-independent-review', 'BOUNDARY_READY'));
  findings.push(...requiredLiteral(boundaryReport, 'redactionSafe', true, 'BOUNDARY_REDACTION_SAFE'));
  findings.push(...requiredLiteral(boundaryReport, 'descriptorValuesEchoed', false, 'BOUNDARY_NO_VALUES_ECHOED'));
  findings.push(...requiredLiteral(boundaryReport, 'commandExecution', false, 'BOUNDARY_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(boundaryReport, 'serviceInstalled', false, 'BOUNDARY_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(boundaryReport, 'serviceStarted', false, 'BOUNDARY_NO_SERVICE_START'));
  findings.push(...requiredLiteral(boundaryReport, 'providerContactAllowed', false, 'BOUNDARY_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(boundaryReport, 'productionReady', false, 'BOUNDARY_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(boundaryReport, 'closesO4', false, 'BOUNDARY_DOES_NOT_CLOSE_O4'));
  findings.push(...requiredLiteral(boundaryReport, 'closesO5', false, 'BOUNDARY_DOES_NOT_CLOSE_O5'));

  findings.push(...requiredLiteral(verdictReport, 'report', 'phase-114-sidecar-unraid-custodian-review-verdict-preflight', 'VERDICT_REPORT_VALID'));
  findings.push(...requiredLiteral(verdictReport, 'reviewReadiness', 'ready-for-o4-closure-gate', 'VERDICT_READY'));
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

  findings.push(warn('FINAL_O4_AUTHORIZATION_STILL_REQUIRED', 'o4Status', 'This preflight can mark O4 closure-ready, but final authorization is a separate gate.'));
  findings.push(warn('O5_REMAINS_DEFERRED', 'o5Status', 'O5 managed KEK custody remains open/deferred.'));
  findings.push(warn('PRODUCTION_READINESS_STILL_FALSE', 'productionReady', 'Production readiness remains false after this O4 closure preflight.'));

  return fromFindings(findings);
}

export function buildSidecarUnraidO4ClosureGateInputErrorReport(
  code: SidecarUnraidO4ClosureGateInputErrorCode,
): SidecarUnraidO4ClosureGateReport {
  const messages: Record<SidecarUnraidO4ClosureGateInputErrorCode, string> = {
    BOUNDARY_REPORT_INPUT_REQUIRED: 'One Phase 113 boundary preflight report JSON input is required.',
    BOUNDARY_REPORT_FILE_READ_FAILED: 'The supplied Phase 113 boundary preflight report JSON file could not be read.',
    BOUNDARY_REPORT_FILE_TOO_LARGE: 'The supplied Phase 113 boundary preflight report JSON file exceeds the input size limit.',
    BOUNDARY_REPORT_JSON_MALFORMED: 'The supplied Phase 113 boundary preflight report input is not valid JSON.',
    BOUNDARY_REPORT_OBJECT_REQUIRED: 'The supplied Phase 113 boundary preflight report JSON value must be an object.',
    VERDICT_REPORT_INPUT_REQUIRED: 'One Phase 114 review verdict report JSON input is required.',
    VERDICT_REPORT_FILE_READ_FAILED: 'The supplied Phase 114 review verdict report JSON file could not be read.',
    VERDICT_REPORT_FILE_TOO_LARGE: 'The supplied Phase 114 review verdict report JSON file exceeds the input size limit.',
    VERDICT_REPORT_JSON_MALFORMED: 'The supplied Phase 114 review verdict report input is not valid JSON.',
    VERDICT_REPORT_OBJECT_REQUIRED: 'The supplied Phase 114 review verdict report JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseSidecarUnraidO4ClosureGateJson(
  jsonText: string,
  kind: 'boundary' | 'verdict',
): Record<string, unknown> | SidecarUnraidO4ClosureGateInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return kind === 'boundary' ? 'BOUNDARY_REPORT_OBJECT_REQUIRED' : 'VERDICT_REPORT_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return kind === 'boundary' ? 'BOUNDARY_REPORT_JSON_MALFORMED' : 'VERDICT_REPORT_JSON_MALFORMED';
  }
}

export function sampleSidecarUnraidO4BoundaryReport(): Record<string, unknown> {
  return {
    report: 'phase-113-sidecar-unraid-custodian-boundary-preflight',
    reviewReadiness: 'ready-for-independent-review',
    redactionSafe: true,
    descriptorValuesEchoed: false,
    commandExecution: false,
    serviceInstalled: false,
    serviceStarted: false,
    providerContactAllowed: false,
    productionReady: false,
    closesO4: false,
    closesO5: false,
  };
}

export function sampleSidecarUnraidO4VerdictReport(): Record<string, unknown> {
  return {
    report: 'phase-114-sidecar-unraid-custodian-review-verdict-preflight',
    reviewReadiness: 'ready-for-o4-closure-gate',
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

export function formatSidecarUnraidO4ClosureGateJson(report: SidecarUnraidO4ClosureGateReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatSidecarUnraidO4ClosureGateText(report: SidecarUnraidO4ClosureGateReport): string {
  const lines = [
    'Phase 115 sidecar Unraid O4 closure gate preflight',
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

export function sidecarUnraidO4ClosureGateHasFailures(report: SidecarUnraidO4ClosureGateReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly SidecarUnraidO4ClosureGateFinding[]): SidecarUnraidO4ClosureGateReport {
  const summary = summarize(findings);
  const ready = summary.fail === 0;
  return {
    report: 'phase-115-sidecar-unraid-o4-closure-gate-preflight',
    version: 1,
    purpose: 'combine-redacted-sidecar-o4-boundary-and-review-verdict-evidence',
    sourceBoundaryPreflight: 'phase-113-sidecar-unraid-custodian-boundary-preflight',
    sourceReviewVerdict: 'phase-114-sidecar-unraid-custodian-review-verdict-preflight',
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
    o4Status: ready ? 'closure-ready-pending-final-authorization' : 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    reviewReadiness: ready ? 'ready-for-final-o4-authorization' : 'not-ready-for-final-o4-authorization',
    summary,
    findings,
  };
}

function summarize(findings: readonly SidecarUnraidO4ClosureGateFinding[]): SidecarUnraidO4ClosureGateReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): SidecarUnraidO4ClosureGateFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): SidecarUnraidO4ClosureGateFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): SidecarUnraidO4ClosureGateFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): SidecarUnraidO4ClosureGateFinding {
  return { level: 'warn', code, field, message };
}
