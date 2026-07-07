export type SidecarUnraidCustodianReviewVerdict = 'GO' | 'HOLD' | 'REJECTED';
export type SidecarUnraidCustodianReviewVerdictInputErrorCode =
  | 'VERDICT_INPUT_REQUIRED'
  | 'VERDICT_FILE_READ_FAILED'
  | 'VERDICT_FILE_TOO_LARGE'
  | 'VERDICT_JSON_MALFORMED'
  | 'VERDICT_OBJECT_REQUIRED';

export interface SidecarUnraidCustodianReviewVerdictFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface SidecarUnraidCustodianReviewVerdictReport {
  readonly report: 'phase-114-sidecar-unraid-custodian-review-verdict-preflight';
  readonly version: 1;
  readonly purpose: 'verify-redaction-safe-o4-sidecar-custodian-review-verdict';
  readonly source: 'single-redacted-sidecar-custodian-review-verdict-json-file';
  readonly sourceBoundaryPreflight: 'phase-113-sidecar-unraid-custodian-boundary-preflight';
  readonly redactionSafe: true;
  readonly verdictValuesEchoed: false;
  readonly rawReviewerNotesIncluded: false;
  readonly commandExecution: false;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly liveServiceContact: false;
  readonly providerContactAllowed: false;
  readonly productionReady: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly verdict: SidecarUnraidCustodianReviewVerdict | 'invalid';
  readonly reviewReadiness: 'ready-for-o4-closure-gate' | 'not-ready-for-o4-closure-gate';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly SidecarUnraidCustodianReviewVerdictFinding[];
}

const VERDICTS = new Set<SidecarUnraidCustodianReviewVerdict>(['GO', 'HOLD', 'REJECTED']);

export function buildSidecarUnraidCustodianReviewVerdictReport(
  record: Record<string, unknown>,
): SidecarUnraidCustodianReviewVerdictReport {
  const findings: SidecarUnraidCustodianReviewVerdictFinding[] = [];
  findings.push(...requiredLiteral(record, 'report', 'phase-114-sidecar-unraid-custodian-review-verdict', 'VERDICT_RECORD_VALID'));
  findings.push(...requiredLiteral(record, 'redactionSafe', true, 'VERDICT_REDACTION_SAFE'));
  findings.push(...requiredLiteral(record, 'boundaryPreflight', 'ready-for-independent-review', 'BOUNDARY_PREFLIGHT_READY'));
  findings.push(...requiredLiteral(record, 'sourceBoundaryPreflight', 'phase-113-sidecar-unraid-custodian-boundary-preflight', 'BOUNDARY_PREFLIGHT_SOURCE_MATCHES'));
  findings.push(...requiredLiteral(record, 'verdictValuesEchoed', false, 'VERDICT_NO_VALUES_ECHOED'));
  findings.push(...requiredLiteral(record, 'rawReviewerNotesIncluded', false, 'VERDICT_NO_RAW_NOTES'));
  findings.push(...requiredLiteral(record, 'rawEvidenceIncluded', false, 'VERDICT_NO_RAW_EVIDENCE'));
  findings.push(...requiredLiteral(record, 'secretPathsIncluded', false, 'VERDICT_NO_SECRET_PATHS'));
  findings.push(...requiredLiteral(record, 'commandExecution', false, 'VERDICT_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(record, 'serviceInstalled', false, 'VERDICT_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(record, 'serviceStarted', false, 'VERDICT_NO_SERVICE_START'));
  findings.push(...requiredLiteral(record, 'providerContactAllowed', false, 'VERDICT_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(record, 'productionReady', false, 'VERDICT_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(record, 'closesO4', false, 'VERDICT_DOES_NOT_CLOSE_O4'));
  findings.push(...requiredLiteral(record, 'closesO5', false, 'VERDICT_DOES_NOT_CLOSE_O5'));

  const verdict = typeof record.verdict === 'string' && VERDICTS.has(record.verdict as SidecarUnraidCustodianReviewVerdict)
    ? record.verdict as SidecarUnraidCustodianReviewVerdict
    : 'invalid';
  findings.push(verdict === 'invalid'
    ? fail('VERDICT_REQUIRED', 'verdict', 'verdict must be GO, HOLD, or REJECTED.')
    : pass(`VERDICT_${verdict}`, 'verdict', 'verdict has a fixed allowed value.'));

  if (verdict === 'GO') {
    findings.push(warn('O4_CLOSURE_GATE_STILL_REQUIRED', 'o4Status', 'GO can advance to an O4 closure gate but does not close O4 here.'));
  } else if (verdict === 'HOLD') {
    findings.push(warn('REVIEWER_HOLD_RECORDED', 'verdict', 'Reviewer HOLD blocks O4 closure gate readiness.'));
  } else if (verdict === 'REJECTED') {
    findings.push(warn('REVIEWER_REJECTED_RECORDED', 'verdict', 'Reviewer rejection blocks O4 closure gate readiness.'));
  }

  findings.push(warn('O5_REMAINS_DEFERRED', 'o5Status', 'O5 managed KEK custody remains outside this review verdict.'));
  return fromFindings(findings, verdict);
}

export function buildSidecarUnraidCustodianReviewVerdictInputErrorReport(
  code: SidecarUnraidCustodianReviewVerdictInputErrorCode,
): SidecarUnraidCustodianReviewVerdictReport {
  const messages: Record<SidecarUnraidCustodianReviewVerdictInputErrorCode, string> = {
    VERDICT_INPUT_REQUIRED: 'One sidecar custodian review verdict JSON input is required.',
    VERDICT_FILE_READ_FAILED: 'The supplied sidecar custodian review verdict JSON file could not be read.',
    VERDICT_FILE_TOO_LARGE: 'The supplied sidecar custodian review verdict JSON file exceeds the input size limit.',
    VERDICT_JSON_MALFORMED: 'The supplied sidecar custodian review verdict input is not valid JSON.',
    VERDICT_OBJECT_REQUIRED: 'The supplied sidecar custodian review verdict JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])], 'invalid');
}

export function parseSidecarUnraidCustodianReviewVerdictJson(
  jsonText: string,
): Record<string, unknown> | SidecarUnraidCustodianReviewVerdictInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'VERDICT_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'VERDICT_JSON_MALFORMED';
  }
}

export function sampleSidecarUnraidCustodianReviewVerdictRecord(
  verdict: SidecarUnraidCustodianReviewVerdict = 'GO',
): Record<string, unknown> {
  return {
    report: 'phase-114-sidecar-unraid-custodian-review-verdict',
    redactionSafe: true,
    boundaryPreflight: 'ready-for-independent-review',
    sourceBoundaryPreflight: 'phase-113-sidecar-unraid-custodian-boundary-preflight',
    verdict,
    verdictValuesEchoed: false,
    rawReviewerNotesIncluded: false,
    rawEvidenceIncluded: false,
    secretPathsIncluded: false,
    commandExecution: false,
    serviceInstalled: false,
    serviceStarted: false,
    providerContactAllowed: false,
    productionReady: false,
    closesO4: false,
    closesO5: false,
  };
}

export function formatSidecarUnraidCustodianReviewVerdictJson(report: SidecarUnraidCustodianReviewVerdictReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatSidecarUnraidCustodianReviewVerdictText(report: SidecarUnraidCustodianReviewVerdictReport): string {
  const lines = [
    'Phase 114 sidecar Unraid custodian review verdict preflight',
    `Verdict: ${report.verdict}`,
    `Review readiness: ${report.reviewReadiness}`,
    `Verdict values echoed: ${report.verdictValuesEchoed ? 'yes' : 'no'}`,
    `Raw reviewer notes included: ${report.rawReviewerNotesIncluded ? 'yes' : 'no'}`,
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

export function sidecarUnraidCustodianReviewVerdictHasFailures(report: SidecarUnraidCustodianReviewVerdictReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(
  findings: readonly SidecarUnraidCustodianReviewVerdictFinding[],
  verdict: SidecarUnraidCustodianReviewVerdictReport['verdict'],
): SidecarUnraidCustodianReviewVerdictReport {
  const summary = summarize(findings);
  return {
    report: 'phase-114-sidecar-unraid-custodian-review-verdict-preflight',
    version: 1,
    purpose: 'verify-redaction-safe-o4-sidecar-custodian-review-verdict',
    source: 'single-redacted-sidecar-custodian-review-verdict-json-file',
    sourceBoundaryPreflight: 'phase-113-sidecar-unraid-custodian-boundary-preflight',
    redactionSafe: true,
    verdictValuesEchoed: false,
    rawReviewerNotesIncluded: false,
    commandExecution: false,
    serviceInstalled: false,
    serviceStarted: false,
    liveServiceContact: false,
    providerContactAllowed: false,
    productionReady: false,
    closesO4: false,
    closesO5: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    verdict,
    reviewReadiness: summary.fail === 0 && verdict === 'GO' ? 'ready-for-o4-closure-gate' : 'not-ready-for-o4-closure-gate',
    summary,
    findings,
  };
}

function summarize(findings: readonly SidecarUnraidCustodianReviewVerdictFinding[]): SidecarUnraidCustodianReviewVerdictReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): SidecarUnraidCustodianReviewVerdictFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): SidecarUnraidCustodianReviewVerdictFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): SidecarUnraidCustodianReviewVerdictFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): SidecarUnraidCustodianReviewVerdictFinding {
  return { level: 'warn', code, field, message };
}
