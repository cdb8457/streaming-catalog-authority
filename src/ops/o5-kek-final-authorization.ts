export type O5KekFinalAuthorizationInputErrorCode =
  | 'CLOSURE_GATE_INPUT_REQUIRED'
  | 'CLOSURE_GATE_FILE_READ_FAILED'
  | 'CLOSURE_GATE_FILE_TOO_LARGE'
  | 'CLOSURE_GATE_JSON_MALFORMED'
  | 'CLOSURE_GATE_OBJECT_REQUIRED'
  | 'AUTHORIZATION_INPUT_REQUIRED'
  | 'AUTHORIZATION_FILE_READ_FAILED'
  | 'AUTHORIZATION_FILE_TOO_LARGE'
  | 'AUTHORIZATION_JSON_MALFORMED'
  | 'AUTHORIZATION_OBJECT_REQUIRED';

export interface O5KekFinalAuthorizationFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface O5KekFinalAuthorizationReport {
  readonly report: 'phase-119-o5-kek-final-authorization';
  readonly version: 1;
  readonly purpose: 'record-final-o5-authorization-after-redacted-closure-gate';
  readonly sourceClosureGate: 'phase-118-o5-kek-closure-gate-preflight';
  readonly redactionSafe: true;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly liveServiceContact: false;
  readonly providerContactAllowed: false;
  readonly productionReady: false;
  readonly closesO4: false;
  readonly closesO5: boolean;
  readonly o4Status: 'closed/authorized';
  readonly o5Status: 'closed/authorized' | 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly authorizationStatus: 'o5-authorized' | 'not-authorized';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly O5KekFinalAuthorizationFinding[];
}

export function buildO5KekFinalAuthorizationReport(
  closureGateReport: Record<string, unknown>,
  authorizationRecord: Record<string, unknown>,
): O5KekFinalAuthorizationReport {
  const findings: O5KekFinalAuthorizationFinding[] = [];
  findings.push(...requiredLiteral(closureGateReport, 'report', 'phase-118-o5-kek-closure-gate-preflight', 'CLOSURE_GATE_REPORT_VALID'));
  findings.push(...requiredLiteral(closureGateReport, 'reviewReadiness', 'ready-for-final-o5-authorization', 'CLOSURE_GATE_READY'));
  findings.push(...requiredLiteral(closureGateReport, 'o5Status', 'closure-ready-pending-final-authorization', 'CLOSURE_GATE_O5_READY'));
  findings.push(...requiredLiteral(closureGateReport, 'redactionSafe', true, 'CLOSURE_GATE_REDACTION_SAFE'));
  findings.push(...requiredLiteral(closureGateReport, 'inputValuesEchoed', false, 'CLOSURE_GATE_NO_VALUES_ECHOED'));
  findings.push(...requiredLiteral(closureGateReport, 'commandExecution', false, 'CLOSURE_GATE_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(closureGateReport, 'serviceInstalled', false, 'CLOSURE_GATE_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(closureGateReport, 'serviceStarted', false, 'CLOSURE_GATE_NO_SERVICE_START'));
  findings.push(...requiredLiteral(closureGateReport, 'providerContactAllowed', false, 'CLOSURE_GATE_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(closureGateReport, 'productionReady', false, 'CLOSURE_GATE_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(closureGateReport, 'closesO4', false, 'CLOSURE_GATE_DOES_NOT_CLOSE_O4'));
  findings.push(...requiredLiteral(closureGateReport, 'closesO5', false, 'CLOSURE_GATE_DID_NOT_ALREADY_CLOSE_O5'));

  findings.push(...requiredLiteral(authorizationRecord, 'record', 'phase-119-o5-kek-final-authorization-record', 'AUTHORIZATION_RECORD_VALID'));
  findings.push(...requiredLiteral(authorizationRecord, 'authorizesO5Closure', true, 'AUTHORIZATION_APPROVES_O5'));
  findings.push(...requiredLiteral(authorizationRecord, 'scope', 'o5-managed-kek-custody-only', 'AUTHORIZATION_SCOPE_O5_ONLY'));
  findings.push(...requiredLiteral(authorizationRecord, 'redactionSafe', true, 'AUTHORIZATION_REDACTION_SAFE'));
  findings.push(...requiredLiteral(authorizationRecord, 'authorizationValuesEchoed', false, 'AUTHORIZATION_NO_VALUES_ECHOED'));
  findings.push(...requiredLiteral(authorizationRecord, 'commandExecution', false, 'AUTHORIZATION_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(authorizationRecord, 'serviceInstalled', false, 'AUTHORIZATION_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(authorizationRecord, 'serviceStarted', false, 'AUTHORIZATION_NO_SERVICE_START'));
  findings.push(...requiredLiteral(authorizationRecord, 'providerContactAllowed', false, 'AUTHORIZATION_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(authorizationRecord, 'productionReady', false, 'AUTHORIZATION_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(authorizationRecord, 'closesO4', false, 'AUTHORIZATION_DOES_NOT_CLOSE_O4'));

  findings.push(warn('PRODUCTION_READINESS_STILL_FALSE', 'productionReady', 'Production readiness remains false after O5 authorization.'));
  findings.push(warn('NO_UNRAID_SERVICE_MUTATION', 'serviceInstalled', 'This authorization record installs and starts no Unraid service.'));
  findings.push(warn('FILE_CUSTODIAN_STILL_REFERENCE', 'fileCustodianStatus', 'FileCustodian remains a hardened reference harness, not production KMS.'));

  return fromFindings(findings);
}

export function buildO5KekFinalAuthorizationInputErrorReport(
  code: O5KekFinalAuthorizationInputErrorCode,
): O5KekFinalAuthorizationReport {
  const messages: Record<O5KekFinalAuthorizationInputErrorCode, string> = {
    CLOSURE_GATE_INPUT_REQUIRED: 'One Phase 118 O5 closure gate JSON input is required.',
    CLOSURE_GATE_FILE_READ_FAILED: 'The supplied Phase 118 O5 closure gate JSON file could not be read.',
    CLOSURE_GATE_FILE_TOO_LARGE: 'The supplied Phase 118 O5 closure gate JSON file exceeds the input size limit.',
    CLOSURE_GATE_JSON_MALFORMED: 'The supplied Phase 118 O5 closure gate input is not valid JSON.',
    CLOSURE_GATE_OBJECT_REQUIRED: 'The supplied Phase 118 O5 closure gate JSON value must be an object.',
    AUTHORIZATION_INPUT_REQUIRED: 'One Phase 119 final authorization JSON input is required.',
    AUTHORIZATION_FILE_READ_FAILED: 'The supplied Phase 119 final authorization JSON file could not be read.',
    AUTHORIZATION_FILE_TOO_LARGE: 'The supplied Phase 119 final authorization JSON file exceeds the input size limit.',
    AUTHORIZATION_JSON_MALFORMED: 'The supplied Phase 119 final authorization input is not valid JSON.',
    AUTHORIZATION_OBJECT_REQUIRED: 'The supplied Phase 119 final authorization JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseO5KekFinalAuthorizationJson(
  jsonText: string,
  kind: 'closureGate' | 'authorization',
): Record<string, unknown> | O5KekFinalAuthorizationInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return kind === 'closureGate' ? 'CLOSURE_GATE_OBJECT_REQUIRED' : 'AUTHORIZATION_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return kind === 'closureGate' ? 'CLOSURE_GATE_JSON_MALFORMED' : 'AUTHORIZATION_JSON_MALFORMED';
  }
}

export function sampleO5KekClosureGateReport(): Record<string, unknown> {
  return {
    report: 'phase-118-o5-kek-closure-gate-preflight',
    reviewReadiness: 'ready-for-final-o5-authorization',
    o5Status: 'closure-ready-pending-final-authorization',
    redactionSafe: true,
    inputValuesEchoed: false,
    commandExecution: false,
    serviceInstalled: false,
    serviceStarted: false,
    providerContactAllowed: false,
    productionReady: false,
    closesO4: false,
    closesO5: false,
  };
}

export function sampleO5KekAuthorizationRecord(): Record<string, unknown> {
  return {
    record: 'phase-119-o5-kek-final-authorization-record',
    authorizesO5Closure: true,
    scope: 'o5-managed-kek-custody-only',
    redactionSafe: true,
    authorizationValuesEchoed: false,
    commandExecution: false,
    serviceInstalled: false,
    serviceStarted: false,
    providerContactAllowed: false,
    productionReady: false,
    closesO4: false,
  };
}

export function formatO5KekFinalAuthorizationJson(report: O5KekFinalAuthorizationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatO5KekFinalAuthorizationText(report: O5KekFinalAuthorizationReport): string {
  const lines = [
    'Phase 119 O5 KEK final authorization',
    `Authorization status: ${report.authorizationStatus}`,
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

export function o5KekFinalAuthorizationHasFailures(report: O5KekFinalAuthorizationReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly O5KekFinalAuthorizationFinding[]): O5KekFinalAuthorizationReport {
  const summary = summarize(findings);
  const authorized = summary.fail === 0;
  return {
    report: 'phase-119-o5-kek-final-authorization',
    version: 1,
    purpose: 'record-final-o5-authorization-after-redacted-closure-gate',
    sourceClosureGate: 'phase-118-o5-kek-closure-gate-preflight',
    redactionSafe: true,
    inputValuesEchoed: false,
    commandExecution: false,
    serviceInstalled: false,
    serviceStarted: false,
    liveServiceContact: false,
    providerContactAllowed: false,
    productionReady: false,
    closesO4: false,
    closesO5: authorized,
    o4Status: 'closed/authorized',
    o5Status: authorized ? 'closed/authorized' : 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    authorizationStatus: authorized ? 'o5-authorized' : 'not-authorized',
    summary,
    findings,
  };
}

function summarize(findings: readonly O5KekFinalAuthorizationFinding[]): O5KekFinalAuthorizationReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): O5KekFinalAuthorizationFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): O5KekFinalAuthorizationFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): O5KekFinalAuthorizationFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): O5KekFinalAuthorizationFinding {
  return { level: 'warn', code, field, message };
}

