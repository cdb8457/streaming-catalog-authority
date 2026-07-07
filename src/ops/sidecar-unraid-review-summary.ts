export type SidecarUnraidReviewSummaryInputErrorCode =
  | 'REVIEW_SUMMARY_INPUT_REQUIRED'
  | 'REVIEW_SUMMARY_FILE_READ_FAILED'
  | 'REVIEW_SUMMARY_FILE_TOO_LARGE'
  | 'REVIEW_SUMMARY_JSON_MALFORMED'
  | 'REVIEW_SUMMARY_OBJECT_REQUIRED';

export interface SidecarUnraidReviewSummaryFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface SidecarUnraidReviewSummaryReport {
  readonly report: 'phase-109-sidecar-unraid-review-summary';
  readonly version: 1;
  readonly code: 'SIDECAR_UNRAID_REVIEW_SUMMARY';
  readonly purpose: 'summarize-redacted-sidecar-unraid-review-gate-report';
  readonly source: 'single-redacted-phase-108-review-gate-json-file';
  readonly redactionSafe: true;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly providerContactAllowed: false;
  readonly tcpListenerAllowed: false;
  readonly httpApiAllowed: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly reviewReadiness: 'ready-for-acceptance-record' | 'not-ready-for-acceptance-record';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly SidecarUnraidReviewSummaryFinding[];
}

export function buildSidecarUnraidReviewSummaryReport(
  gateReport: Record<string, unknown>,
): SidecarUnraidReviewSummaryReport {
  const findings: SidecarUnraidReviewSummaryFinding[] = [];
  findings.push(...requiredLiteral(gateReport, 'report', 'phase-108-sidecar-unraid-review-gate', 'PHASE_108_REPORT_VALID'));
  findings.push(...requiredLiteral(gateReport, 'redactionSafe', true, 'PHASE_108_REDACTION_SAFE'));
  findings.push(...requiredLiteral(gateReport, 'evidenceValuesEchoed', false, 'PHASE_108_NO_EVIDENCE_VALUES'));
  findings.push(...requiredLiteral(gateReport, 'commandExecution', false, 'PHASE_108_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(gateReport, 'liveServiceContact', false, 'PHASE_108_NO_LIVE_SERVICE_CONTACT'));
  findings.push(...requiredLiteral(gateReport, 'providerContactAllowed', false, 'PHASE_108_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(gateReport, 'serviceInstalled', false, 'PHASE_108_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(gateReport, 'serviceStarted', false, 'PHASE_108_NO_SERVICE_START'));
  findings.push(...requiredLiteral(gateReport, 'reviewReadiness', 'ready-for-review', 'PHASE_108_READY_FOR_REVIEW'));
  findings.push(...requiredLiteral(gateReport, 'closesO4', false, 'PHASE_108_DOES_NOT_CLOSE_O4'));
  findings.push(...requiredLiteral(gateReport, 'closesO5', false, 'PHASE_108_DOES_NOT_CLOSE_O5'));
  findings.push(warn('O4_REMAINS_OPEN', 'o4Status', 'O4 remains open/deferred after this summary.'));
  findings.push(warn('O5_REMAINS_OPEN', 'o5Status', 'O5 remains open/deferred after this summary.'));
  findings.push(warn('FILE_CUSTODIAN_REFERENCE_ONLY', 'fileCustodianStatus', 'FileCustodian remains a hardened reference harness.'));
  return fromFindings(findings);
}

export function buildSidecarUnraidReviewSummaryInputErrorReport(
  code: SidecarUnraidReviewSummaryInputErrorCode,
): SidecarUnraidReviewSummaryReport {
  const messages: Record<SidecarUnraidReviewSummaryInputErrorCode, string> = {
    REVIEW_SUMMARY_INPUT_REQUIRED: 'One Phase 108 review-gate JSON input is required.',
    REVIEW_SUMMARY_FILE_READ_FAILED: 'The supplied Phase 108 review-gate JSON file could not be read.',
    REVIEW_SUMMARY_FILE_TOO_LARGE: 'The supplied Phase 108 review-gate JSON file exceeds the input size limit.',
    REVIEW_SUMMARY_JSON_MALFORMED: 'The supplied Phase 108 review-gate input is not valid JSON.',
    REVIEW_SUMMARY_OBJECT_REQUIRED: 'The supplied Phase 108 review-gate JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseSidecarUnraidReviewSummaryJson(
  jsonText: string,
): Record<string, unknown> | SidecarUnraidReviewSummaryInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'REVIEW_SUMMARY_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'REVIEW_SUMMARY_JSON_MALFORMED';
  }
}

export function formatSidecarUnraidReviewSummaryJson(report: SidecarUnraidReviewSummaryReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatSidecarUnraidReviewSummaryText(report: SidecarUnraidReviewSummaryReport): string {
  const lines = [
    'Phase 109 sidecar Unraid review summary',
    `code: ${report.code}`,
    `reviewReadiness: ${report.reviewReadiness}`,
    `inputValuesEchoed: ${report.inputValuesEchoed ? 'true' : 'false'}`,
    `commandExecution: ${report.commandExecution ? 'true' : 'false'}`,
    `serviceInstalled: ${report.serviceInstalled ? 'true' : 'false'}`,
    `providerContactAllowed: ${report.providerContactAllowed ? 'true' : 'false'}`,
    `closesO4: ${report.closesO4 ? 'true' : 'false'}`,
    `closesO5: ${report.closesO5 ? 'true' : 'false'}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function sidecarUnraidReviewSummaryHasFailures(report: SidecarUnraidReviewSummaryReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly SidecarUnraidReviewSummaryFinding[]): SidecarUnraidReviewSummaryReport {
  const summary = summarize(findings);
  return {
    report: 'phase-109-sidecar-unraid-review-summary',
    version: 1,
    code: 'SIDECAR_UNRAID_REVIEW_SUMMARY',
    purpose: 'summarize-redacted-sidecar-unraid-review-gate-report',
    source: 'single-redacted-phase-108-review-gate-json-file',
    redactionSafe: true,
    inputValuesEchoed: false,
    commandExecution: false,
    serviceInstalled: false,
    serviceStarted: false,
    providerContactAllowed: false,
    tcpListenerAllowed: false,
    httpApiAllowed: false,
    closesO4: false,
    closesO5: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    reviewReadiness: summary.fail === 0 ? 'ready-for-acceptance-record' : 'not-ready-for-acceptance-record',
    summary,
    findings,
  };
}

function summarize(findings: readonly SidecarUnraidReviewSummaryFinding[]): SidecarUnraidReviewSummaryReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): SidecarUnraidReviewSummaryFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): SidecarUnraidReviewSummaryFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): SidecarUnraidReviewSummaryFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): SidecarUnraidReviewSummaryFinding {
  return { level: 'warn', code, field, message };
}
