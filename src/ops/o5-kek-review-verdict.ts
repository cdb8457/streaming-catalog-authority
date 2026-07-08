export type O5KekReviewVerdict = 'GO' | 'HOLD' | 'REJECTED';
export type O5KekReviewVerdictInputErrorCode =
  | 'VERDICT_INPUT_REQUIRED'
  | 'VERDICT_FILE_READ_FAILED'
  | 'VERDICT_FILE_TOO_LARGE'
  | 'VERDICT_JSON_MALFORMED'
  | 'VERDICT_OBJECT_REQUIRED';

export interface O5KekReviewVerdictFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface O5KekReviewVerdictReport {
  readonly report: 'phase-117-o5-kek-review-verdict-preflight';
  readonly version: 1;
  readonly purpose: 'verify-redaction-safe-o5-managed-kek-review-verdict';
  readonly source: 'single-redacted-o5-kek-review-verdict-json-file';
  readonly sourceKekPreflight: 'phase-30-kek-evidence-preflight';
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
  readonly o4Status: 'closed/authorized';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly verdict: O5KekReviewVerdict | 'invalid';
  readonly reviewReadiness: 'ready-for-o5-closure-gate' | 'not-ready-for-o5-closure-gate';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly O5KekReviewVerdictFinding[];
}

const VERDICTS = new Set<O5KekReviewVerdict>(['GO', 'HOLD', 'REJECTED']);

export function buildO5KekReviewVerdictReport(record: Record<string, unknown>): O5KekReviewVerdictReport {
  const findings: O5KekReviewVerdictFinding[] = [];
  findings.push(...requiredLiteral(record, 'report', 'phase-117-o5-kek-review-verdict', 'VERDICT_RECORD_VALID'));
  findings.push(...requiredLiteral(record, 'redactionSafe', true, 'VERDICT_REDACTION_SAFE'));
  findings.push(...requiredLiteral(record, 'kekPreflight', 'ready-for-review', 'KEK_PREFLIGHT_READY'));
  findings.push(...requiredLiteral(record, 'sourceKekPreflight', 'phase-30-kek-evidence-preflight', 'KEK_PREFLIGHT_SOURCE_MATCHES'));
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

  const verdict = typeof record.verdict === 'string' && VERDICTS.has(record.verdict as O5KekReviewVerdict)
    ? record.verdict as O5KekReviewVerdict
    : 'invalid';
  findings.push(verdict === 'invalid'
    ? fail('VERDICT_REQUIRED', 'verdict', 'verdict must be GO, HOLD, or REJECTED.')
    : pass(`VERDICT_${verdict}`, 'verdict', 'verdict has a fixed allowed value.'));

  if (verdict === 'GO') {
    findings.push(warn('O5_CLOSURE_GATE_STILL_REQUIRED', 'o5Status', 'GO can advance to an O5 closure gate but does not close O5 here.'));
  } else if (verdict === 'HOLD') {
    findings.push(warn('REVIEWER_HOLD_RECORDED', 'verdict', 'Reviewer HOLD blocks O5 closure gate readiness.'));
  } else if (verdict === 'REJECTED') {
    findings.push(warn('REVIEWER_REJECTED_RECORDED', 'verdict', 'Reviewer rejection blocks O5 closure gate readiness.'));
  }

  findings.push(warn('PRODUCTION_READINESS_STILL_FALSE', 'productionReady', 'Production readiness remains false after this O5 review verdict.'));
  findings.push(warn('NO_UNRAID_SERVICE_MUTATION', 'serviceInstalled', 'This review verdict installs and starts no Unraid service.'));
  return fromFindings(findings, verdict);
}

export function buildO5KekReviewVerdictInputErrorReport(
  code: O5KekReviewVerdictInputErrorCode,
): O5KekReviewVerdictReport {
  const messages: Record<O5KekReviewVerdictInputErrorCode, string> = {
    VERDICT_INPUT_REQUIRED: 'One O5 KEK review verdict JSON input is required.',
    VERDICT_FILE_READ_FAILED: 'The supplied O5 KEK review verdict JSON file could not be read.',
    VERDICT_FILE_TOO_LARGE: 'The supplied O5 KEK review verdict JSON file exceeds the input size limit.',
    VERDICT_JSON_MALFORMED: 'The supplied O5 KEK review verdict input is not valid JSON.',
    VERDICT_OBJECT_REQUIRED: 'The supplied O5 KEK review verdict JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])], 'invalid');
}

export function parseO5KekReviewVerdictJson(jsonText: string): Record<string, unknown> | O5KekReviewVerdictInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'VERDICT_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'VERDICT_JSON_MALFORMED';
  }
}

export function sampleO5KekReviewVerdictRecord(verdict: O5KekReviewVerdict = 'GO'): Record<string, unknown> {
  return {
    report: 'phase-117-o5-kek-review-verdict',
    redactionSafe: true,
    kekPreflight: 'ready-for-review',
    sourceKekPreflight: 'phase-30-kek-evidence-preflight',
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

export function formatO5KekReviewVerdictJson(report: O5KekReviewVerdictReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatO5KekReviewVerdictText(report: O5KekReviewVerdictReport): string {
  const lines = [
    'Phase 117 O5 KEK review verdict preflight',
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

export function o5KekReviewVerdictHasFailures(report: O5KekReviewVerdictReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(
  findings: readonly O5KekReviewVerdictFinding[],
  verdict: O5KekReviewVerdictReport['verdict'],
): O5KekReviewVerdictReport {
  const summary = summarize(findings);
  return {
    report: 'phase-117-o5-kek-review-verdict-preflight',
    version: 1,
    purpose: 'verify-redaction-safe-o5-managed-kek-review-verdict',
    source: 'single-redacted-o5-kek-review-verdict-json-file',
    sourceKekPreflight: 'phase-30-kek-evidence-preflight',
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
    o4Status: 'closed/authorized',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    verdict,
    reviewReadiness: summary.fail === 0 && verdict === 'GO' ? 'ready-for-o5-closure-gate' : 'not-ready-for-o5-closure-gate',
    summary,
    findings,
  };
}

function summarize(findings: readonly O5KekReviewVerdictFinding[]): O5KekReviewVerdictReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): O5KekReviewVerdictFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): O5KekReviewVerdictFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): O5KekReviewVerdictFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): O5KekReviewVerdictFinding {
  return { level: 'warn', code, field, message };
}

