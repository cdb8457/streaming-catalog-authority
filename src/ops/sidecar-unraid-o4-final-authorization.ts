export type SidecarUnraidO4FinalAuthorizationInputErrorCode =
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

export interface SidecarUnraidO4FinalAuthorizationFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface SidecarUnraidO4FinalAuthorizationReport {
  readonly report: 'phase-116-sidecar-unraid-o4-final-authorization';
  readonly version: 1;
  readonly purpose: 'record-final-o4-authorization-after-redacted-closure-gate';
  readonly sourceClosureGate: 'phase-115-sidecar-unraid-o4-closure-gate-preflight';
  readonly redactionSafe: true;
  readonly inputValuesEchoed: false;
  readonly commandExecution: false;
  readonly serviceInstalled: false;
  readonly serviceStarted: false;
  readonly liveServiceContact: false;
  readonly providerContactAllowed: false;
  readonly productionReady: false;
  readonly closesO4: boolean;
  readonly closesO5: false;
  readonly o4Status: 'closed/authorized' | 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly authorizationStatus: 'o4-authorized' | 'not-authorized';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly SidecarUnraidO4FinalAuthorizationFinding[];
}

export function buildSidecarUnraidO4FinalAuthorizationReport(
  closureGateReport: Record<string, unknown>,
  authorizationRecord: Record<string, unknown>,
): SidecarUnraidO4FinalAuthorizationReport {
  const findings: SidecarUnraidO4FinalAuthorizationFinding[] = [];
  findings.push(...requiredLiteral(closureGateReport, 'report', 'phase-115-sidecar-unraid-o4-closure-gate-preflight', 'CLOSURE_GATE_REPORT_VALID'));
  findings.push(...requiredLiteral(closureGateReport, 'reviewReadiness', 'ready-for-final-o4-authorization', 'CLOSURE_GATE_READY'));
  findings.push(...requiredLiteral(closureGateReport, 'o4Status', 'closure-ready-pending-final-authorization', 'CLOSURE_GATE_O4_READY'));
  findings.push(...requiredLiteral(closureGateReport, 'redactionSafe', true, 'CLOSURE_GATE_REDACTION_SAFE'));
  findings.push(...requiredLiteral(closureGateReport, 'inputValuesEchoed', false, 'CLOSURE_GATE_NO_VALUES_ECHOED'));
  findings.push(...requiredLiteral(closureGateReport, 'commandExecution', false, 'CLOSURE_GATE_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(closureGateReport, 'serviceInstalled', false, 'CLOSURE_GATE_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(closureGateReport, 'serviceStarted', false, 'CLOSURE_GATE_NO_SERVICE_START'));
  findings.push(...requiredLiteral(closureGateReport, 'providerContactAllowed', false, 'CLOSURE_GATE_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(closureGateReport, 'productionReady', false, 'CLOSURE_GATE_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(closureGateReport, 'closesO4', false, 'CLOSURE_GATE_DID_NOT_ALREADY_CLOSE_O4'));
  findings.push(...requiredLiteral(closureGateReport, 'closesO5', false, 'CLOSURE_GATE_DOES_NOT_CLOSE_O5'));

  findings.push(...requiredLiteral(authorizationRecord, 'record', 'phase-116-sidecar-unraid-o4-final-authorization-record', 'AUTHORIZATION_RECORD_VALID'));
  findings.push(...requiredLiteral(authorizationRecord, 'authorizesO4Closure', true, 'AUTHORIZATION_APPROVES_O4'));
  findings.push(...requiredLiteral(authorizationRecord, 'scope', 'o4-managed-custodian-boundary-only', 'AUTHORIZATION_SCOPE_O4_ONLY'));
  findings.push(...requiredLiteral(authorizationRecord, 'redactionSafe', true, 'AUTHORIZATION_REDACTION_SAFE'));
  findings.push(...requiredLiteral(authorizationRecord, 'authorizationValuesEchoed', false, 'AUTHORIZATION_NO_VALUES_ECHOED'));
  findings.push(...requiredLiteral(authorizationRecord, 'commandExecution', false, 'AUTHORIZATION_EXECUTES_NOTHING'));
  findings.push(...requiredLiteral(authorizationRecord, 'serviceInstalled', false, 'AUTHORIZATION_NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(authorizationRecord, 'serviceStarted', false, 'AUTHORIZATION_NO_SERVICE_START'));
  findings.push(...requiredLiteral(authorizationRecord, 'providerContactAllowed', false, 'AUTHORIZATION_NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(authorizationRecord, 'productionReady', false, 'AUTHORIZATION_NOT_PRODUCTION_READY'));
  findings.push(...requiredLiteral(authorizationRecord, 'closesO5', false, 'AUTHORIZATION_DOES_NOT_CLOSE_O5'));

  findings.push(warn('O5_REMAINS_DEFERRED', 'o5Status', 'O5 managed KEK custody remains open/deferred after O4 authorization.'));
  findings.push(warn('PRODUCTION_READINESS_STILL_FALSE', 'productionReady', 'Production readiness remains false after O4 authorization.'));
  findings.push(warn('NO_UNRAID_SERVICE_MUTATION', 'serviceInstalled', 'This authorization record installs and starts no Unraid service.'));

  return fromFindings(findings);
}

export function buildSidecarUnraidO4FinalAuthorizationInputErrorReport(
  code: SidecarUnraidO4FinalAuthorizationInputErrorCode,
): SidecarUnraidO4FinalAuthorizationReport {
  const messages: Record<SidecarUnraidO4FinalAuthorizationInputErrorCode, string> = {
    CLOSURE_GATE_INPUT_REQUIRED: 'One Phase 115 O4 closure gate JSON input is required.',
    CLOSURE_GATE_FILE_READ_FAILED: 'The supplied Phase 115 O4 closure gate JSON file could not be read.',
    CLOSURE_GATE_FILE_TOO_LARGE: 'The supplied Phase 115 O4 closure gate JSON file exceeds the input size limit.',
    CLOSURE_GATE_JSON_MALFORMED: 'The supplied Phase 115 O4 closure gate input is not valid JSON.',
    CLOSURE_GATE_OBJECT_REQUIRED: 'The supplied Phase 115 O4 closure gate JSON value must be an object.',
    AUTHORIZATION_INPUT_REQUIRED: 'One Phase 116 final authorization JSON input is required.',
    AUTHORIZATION_FILE_READ_FAILED: 'The supplied Phase 116 final authorization JSON file could not be read.',
    AUTHORIZATION_FILE_TOO_LARGE: 'The supplied Phase 116 final authorization JSON file exceeds the input size limit.',
    AUTHORIZATION_JSON_MALFORMED: 'The supplied Phase 116 final authorization input is not valid JSON.',
    AUTHORIZATION_OBJECT_REQUIRED: 'The supplied Phase 116 final authorization JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseSidecarUnraidO4FinalAuthorizationJson(
  jsonText: string,
  kind: 'closureGate' | 'authorization',
): Record<string, unknown> | SidecarUnraidO4FinalAuthorizationInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return kind === 'closureGate' ? 'CLOSURE_GATE_OBJECT_REQUIRED' : 'AUTHORIZATION_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return kind === 'closureGate' ? 'CLOSURE_GATE_JSON_MALFORMED' : 'AUTHORIZATION_JSON_MALFORMED';
  }
}

export function sampleSidecarUnraidO4ClosureGateReport(): Record<string, unknown> {
  return {
    report: 'phase-115-sidecar-unraid-o4-closure-gate-preflight',
    reviewReadiness: 'ready-for-final-o4-authorization',
    o4Status: 'closure-ready-pending-final-authorization',
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

export function sampleSidecarUnraidO4AuthorizationRecord(): Record<string, unknown> {
  return {
    record: 'phase-116-sidecar-unraid-o4-final-authorization-record',
    authorizesO4Closure: true,
    scope: 'o4-managed-custodian-boundary-only',
    redactionSafe: true,
    authorizationValuesEchoed: false,
    commandExecution: false,
    serviceInstalled: false,
    serviceStarted: false,
    providerContactAllowed: false,
    productionReady: false,
    closesO5: false,
  };
}

export function formatSidecarUnraidO4FinalAuthorizationJson(report: SidecarUnraidO4FinalAuthorizationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatSidecarUnraidO4FinalAuthorizationText(report: SidecarUnraidO4FinalAuthorizationReport): string {
  const lines = [
    'Phase 116 sidecar Unraid O4 final authorization',
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

export function sidecarUnraidO4FinalAuthorizationHasFailures(report: SidecarUnraidO4FinalAuthorizationReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly SidecarUnraidO4FinalAuthorizationFinding[]): SidecarUnraidO4FinalAuthorizationReport {
  const summary = summarize(findings);
  const authorized = summary.fail === 0;
  return {
    report: 'phase-116-sidecar-unraid-o4-final-authorization',
    version: 1,
    purpose: 'record-final-o4-authorization-after-redacted-closure-gate',
    sourceClosureGate: 'phase-115-sidecar-unraid-o4-closure-gate-preflight',
    redactionSafe: true,
    inputValuesEchoed: false,
    commandExecution: false,
    serviceInstalled: false,
    serviceStarted: false,
    liveServiceContact: false,
    providerContactAllowed: false,
    productionReady: false,
    closesO4: authorized,
    closesO5: false,
    o4Status: authorized ? 'closed/authorized' : 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    authorizationStatus: authorized ? 'o4-authorized' : 'not-authorized',
    summary,
    findings,
  };
}

function summarize(findings: readonly SidecarUnraidO4FinalAuthorizationFinding[]): SidecarUnraidO4FinalAuthorizationReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): SidecarUnraidO4FinalAuthorizationFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): SidecarUnraidO4FinalAuthorizationFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): SidecarUnraidO4FinalAuthorizationFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): SidecarUnraidO4FinalAuthorizationFinding {
  return { level: 'warn', code, field, message };
}

