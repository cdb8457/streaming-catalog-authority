export type SidecarUnraidAcceptanceDecision = 'accepted' | 'rejected' | 'deferred';
export type SidecarUnraidAcceptanceInputErrorCode =
  | 'ACCEPTANCE_INPUT_REQUIRED'
  | 'ACCEPTANCE_FILE_READ_FAILED'
  | 'ACCEPTANCE_FILE_TOO_LARGE'
  | 'ACCEPTANCE_JSON_MALFORMED'
  | 'ACCEPTANCE_OBJECT_REQUIRED';

export interface SidecarUnraidAcceptanceFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface SidecarUnraidAcceptanceReport {
  readonly report: 'phase-110-sidecar-unraid-acceptance-preflight';
  readonly version: 1;
  readonly purpose: 'verify-redaction-safe-sidecar-unraid-acceptance-record';
  readonly source: 'single-operator-supplied-sidecar-unraid-acceptance-record-json-file';
  readonly redactionSafe: true;
  readonly recordValuesEchoed: false;
  readonly commandExecution: false;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly providerContactAllowed: false;
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly decision: SidecarUnraidAcceptanceDecision | 'invalid';
  readonly reviewReadiness: 'ready-for-handoff' | 'not-ready-for-handoff';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly SidecarUnraidAcceptanceFinding[];
}

const DECISIONS = new Set<SidecarUnraidAcceptanceDecision>(['accepted', 'rejected', 'deferred']);

export function buildSidecarUnraidAcceptanceReport(record: Record<string, unknown>): SidecarUnraidAcceptanceReport {
  const findings: SidecarUnraidAcceptanceFinding[] = [];
  findings.push(...requiredLiteral(record, 'report', 'phase-110-sidecar-unraid-acceptance-record', 'ACCEPTANCE_RECORD_VALID'));
  findings.push(...requiredLiteral(record, 'redactionSafe', true, 'ACCEPTANCE_REDACTION_SAFE'));
  findings.push(...requiredLiteral(record, 'reviewSummaryPreflight', 'ready-for-acceptance-record', 'REVIEW_SUMMARY_READY'));
  findings.push(...requiredLiteral(record, 'recordValuesEchoed', false, 'ACCEPTANCE_NO_RECORD_VALUES'));
  findings.push(...requiredLiteral(record, 'commandExecution', false, 'ACCEPTANCE_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(record, 'serviceInstalled', false, 'ACCEPTANCE_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(record, 'serviceStarted', false, 'ACCEPTANCE_NO_SERVICE_START'));
  findings.push(...requiredLiteral(record, 'providerContactAllowed', false, 'ACCEPTANCE_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(record, 'closesO4', false, 'ACCEPTANCE_DOES_NOT_CLOSE_O4'));
  findings.push(...requiredLiteral(record, 'closesO5', false, 'ACCEPTANCE_DOES_NOT_CLOSE_O5'));
  findings.push(...requiredLiteral(record, 'o4Status', 'open/deferred', 'O4_STILL_OPEN'));
  findings.push(...requiredLiteral(record, 'o5Status', 'open/deferred', 'O5_STILL_OPEN'));
  findings.push(...requiredLiteral(record, 'fileCustodianStatus', 'reference-harness-not-production-kms', 'FILE_CUSTODIAN_BOUNDARY'));

  const decision = typeof record.decision === 'string' && DECISIONS.has(record.decision as SidecarUnraidAcceptanceDecision)
    ? record.decision as SidecarUnraidAcceptanceDecision
    : 'invalid';
  findings.push(decision === 'invalid'
    ? fail('ACCEPTANCE_DECISION_REQUIRED', 'decision', 'decision must be accepted, rejected, or deferred.')
    : pass(`ACCEPTANCE_DECISION_${decision.toUpperCase()}`, 'decision', 'decision has a fixed allowed value.'));

  if (decision === 'accepted') {
    findings.push(...requiredLiteral(record, 'independentReviewerVerdict', 'GO', 'INDEPENDENT_REVIEWER_GO'));
  } else if (decision === 'rejected') {
    findings.push(warn('ACCEPTANCE_REJECTED', 'decision', 'sidecar Unraid evidence is rejected; O4/O5 remain open.'));
  } else if (decision === 'deferred') {
    findings.push(warn('ACCEPTANCE_DEFERRED', 'decision', 'sidecar Unraid evidence remains deferred; O4/O5 remain open.'));
  }

  findings.push(warn('O4_REMAINS_OPEN', 'review', 'This acceptance record does not close O4.'));
  findings.push(warn('O5_REMAINS_OPEN', 'review', 'This acceptance record does not close O5.'));
  return fromFindings(findings, decision);
}

export function buildSidecarUnraidAcceptanceInputErrorReport(code: SidecarUnraidAcceptanceInputErrorCode): SidecarUnraidAcceptanceReport {
  const messages: Record<SidecarUnraidAcceptanceInputErrorCode, string> = {
    ACCEPTANCE_INPUT_REQUIRED: 'One sidecar Unraid acceptance record JSON input is required.',
    ACCEPTANCE_FILE_READ_FAILED: 'The supplied sidecar Unraid acceptance record JSON file could not be read.',
    ACCEPTANCE_FILE_TOO_LARGE: 'The supplied sidecar Unraid acceptance record JSON file exceeds the input size limit.',
    ACCEPTANCE_JSON_MALFORMED: 'The supplied sidecar Unraid acceptance record input is not valid JSON.',
    ACCEPTANCE_OBJECT_REQUIRED: 'The supplied sidecar Unraid acceptance record JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])], 'invalid');
}

export function parseSidecarUnraidAcceptanceJson(jsonText: string): Record<string, unknown> | SidecarUnraidAcceptanceInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'ACCEPTANCE_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'ACCEPTANCE_JSON_MALFORMED';
  }
}

export function formatSidecarUnraidAcceptanceJson(report: SidecarUnraidAcceptanceReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatSidecarUnraidAcceptanceText(report: SidecarUnraidAcceptanceReport): string {
  const lines = [
    'Phase 110 sidecar Unraid acceptance preflight',
    `Decision: ${report.decision}`,
    `Review readiness: ${report.reviewReadiness}`,
    `Record values echoed: ${report.recordValuesEchoed ? 'yes' : 'no'}`,
    `Command execution: ${report.commandExecution ? 'true' : 'false'}`,
    `Service installed: ${report.serviceInstalled ? 'true' : 'false'}`,
    `Provider contact allowed: ${report.providerContactAllowed ? 'true' : 'false'}`,
    `O4 status: ${report.o4Status}`,
    `O5 status: ${report.o5Status}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function sidecarUnraidAcceptanceHasFailures(report: SidecarUnraidAcceptanceReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(
  findings: readonly SidecarUnraidAcceptanceFinding[],
  decision: SidecarUnraidAcceptanceReport['decision'],
): SidecarUnraidAcceptanceReport {
  const summary = summarize(findings);
  return {
    report: 'phase-110-sidecar-unraid-acceptance-preflight',
    version: 1,
    purpose: 'verify-redaction-safe-sidecar-unraid-acceptance-record',
    source: 'single-operator-supplied-sidecar-unraid-acceptance-record-json-file',
    redactionSafe: true,
    recordValuesEchoed: false,
    commandExecution: false,
    serviceInstalled: false,
    serviceStarted: false,
    providerContactAllowed: false,
    closesO4: false,
    closesO5: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    decision,
    reviewReadiness: summary.fail === 0 ? 'ready-for-handoff' : 'not-ready-for-handoff',
    summary,
    findings,
  };
}

function summarize(findings: readonly SidecarUnraidAcceptanceFinding[]): SidecarUnraidAcceptanceReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): SidecarUnraidAcceptanceFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): SidecarUnraidAcceptanceFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): SidecarUnraidAcceptanceFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): SidecarUnraidAcceptanceFinding {
  return { level: 'warn', code, field, message };
}
