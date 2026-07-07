export type SidecarUnraidCustodianBoundaryInputErrorCode =
  | 'BOUNDARY_INPUT_REQUIRED'
  | 'BOUNDARY_FILE_READ_FAILED'
  | 'BOUNDARY_FILE_TOO_LARGE'
  | 'BOUNDARY_JSON_MALFORMED'
  | 'BOUNDARY_OBJECT_REQUIRED';

export interface SidecarUnraidCustodianBoundaryFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface SidecarUnraidCustodianBoundaryReport {
  readonly report: 'phase-113-sidecar-unraid-custodian-boundary-preflight';
  readonly version: 1;
  readonly purpose: 'preflight-redacted-o4-sidecar-custodian-boundary-evidence';
  readonly descriptorInput: 'single-redacted-sidecar-custodian-boundary-json-file';
  readonly sourceBlocker: 'managed-custodian-sidecar-boundary-attestation-redacted';
  readonly redactionSafe: true;
  readonly descriptorValuesEchoed: false;
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
  readonly reviewReadiness: 'ready-for-independent-review' | 'not-ready-for-independent-review';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly SidecarUnraidCustodianBoundaryFinding[];
}

export function buildSidecarUnraidCustodianBoundaryPreflightReport(
  descriptor: Record<string, unknown>,
): SidecarUnraidCustodianBoundaryReport {
  const findings: SidecarUnraidCustodianBoundaryFinding[] = [];
  findings.push(...requiredLiteral(descriptor, 'report', 'phase-113-sidecar-unraid-custodian-boundary-descriptor', 'BOUNDARY_DESCRIPTOR_REPORT_VALID'));
  findings.push(...requiredLiteral(descriptor, 'redactionSafe', true, 'BOUNDARY_REDACTION_SAFE'));
  findings.push(...requiredLiteral(descriptor, 'sourceBlocker', 'managed-custodian-sidecar-boundary-attestation-redacted', 'BOUNDARY_SOURCE_BLOCKER_MATCHES'));
  findings.push(...requiredLiteral(descriptor, 'sidecarRunsOutsideAppProcess', true, 'SIDECAR_OUTSIDE_APP_PROCESS'));
  findings.push(...requiredLiteral(descriptor, 'appCannotReadRawDek', true, 'APP_CANNOT_READ_RAW_DEK'));
  findings.push(...requiredLiteral(descriptor, 'appCannotForgeAttestation', true, 'APP_CANNOT_FORGE_ATTESTATION'));
  findings.push(...requiredLiteral(descriptor, 'attestationFormatDocumented', true, 'ATTESTATION_FORMAT_DOCUMENTED'));
  findings.push(...requiredLiteral(descriptor, 'durableNonSecretTombstones', true, 'DURABLE_NON_SECRET_TOMBSTONES'));
  findings.push(...requiredLiteral(descriptor, 'lostAckRecoveryDocumented', true, 'LOST_ACK_RECOVERY_DOCUMENTED'));
  findings.push(...requiredLiteral(descriptor, 'restoreMismatchFailsClosed', true, 'RESTORE_MISMATCH_FAILS_CLOSED'));
  findings.push(...requiredLiteral(descriptor, 'localSocketOnly', true, 'LOCAL_SOCKET_ONLY'));
  findings.push(...requiredLiteral(descriptor, 'tcpListenerAllowed', false, 'NO_TCP_LISTENER'));
  findings.push(...requiredLiteral(descriptor, 'httpApiAllowed', false, 'NO_HTTP_API'));
  findings.push(...requiredLiteral(descriptor, 'lanExposureAllowed', false, 'NO_LAN_EXPOSURE'));
  findings.push(...requiredLiteral(descriptor, 'providerContactAllowed', false, 'NO_PROVIDER_CONTACT'));
  findings.push(...requiredLiteral(descriptor, 'fileCustodianIsProductionKms', false, 'FILE_CUSTODIAN_NOT_PRODUCTION_KMS'));
  findings.push(...requiredLiteral(descriptor, 'rawEvidenceIncluded', false, 'NO_RAW_EVIDENCE'));
  findings.push(...requiredLiteral(descriptor, 'secretPathsIncluded', false, 'NO_SECRET_PATHS'));
  findings.push(...requiredLiteral(descriptor, 'serviceInstalled', false, 'NO_SERVICE_INSTALL'));
  findings.push(...requiredLiteral(descriptor, 'serviceStarted', false, 'NO_SERVICE_START'));
  findings.push(...requiredLiteral(descriptor, 'closesO4', false, 'DESCRIPTOR_DOES_NOT_CLOSE_O4'));
  findings.push(...requiredLiteral(descriptor, 'closesO5', false, 'DESCRIPTOR_DOES_NOT_CLOSE_O5'));
  findings.push(warn('O4_STILL_REQUIRES_INDEPENDENT_REVIEW', 'o4Status', 'This preflight can become ready for independent review but does not close O4.'));
  findings.push(warn('O5_REMAINS_DEFERRED', 'o5Status', 'O5 managed KEK custody remains outside this preflight.'));
  return fromFindings(findings);
}

export function buildSidecarUnraidCustodianBoundaryInputErrorReport(
  code: SidecarUnraidCustodianBoundaryInputErrorCode,
): SidecarUnraidCustodianBoundaryReport {
  const messages: Record<SidecarUnraidCustodianBoundaryInputErrorCode, string> = {
    BOUNDARY_INPUT_REQUIRED: 'One sidecar custodian boundary descriptor JSON input is required.',
    BOUNDARY_FILE_READ_FAILED: 'The supplied sidecar custodian boundary descriptor JSON file could not be read.',
    BOUNDARY_FILE_TOO_LARGE: 'The supplied sidecar custodian boundary descriptor JSON file exceeds the input size limit.',
    BOUNDARY_JSON_MALFORMED: 'The supplied sidecar custodian boundary descriptor input is not valid JSON.',
    BOUNDARY_OBJECT_REQUIRED: 'The supplied sidecar custodian boundary descriptor JSON value must be an object.',
  };
  return fromFindings([fail(code, 'input', messages[code])]);
}

export function parseSidecarUnraidCustodianBoundaryJson(
  jsonText: string,
): Record<string, unknown> | SidecarUnraidCustodianBoundaryInputErrorCode {
  try {
    const parsed: unknown = JSON.parse(stripBom(jsonText));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'BOUNDARY_OBJECT_REQUIRED';
    return parsed as Record<string, unknown>;
  } catch {
    return 'BOUNDARY_JSON_MALFORMED';
  }
}

export function sampleSidecarUnraidCustodianBoundaryDescriptor(): Record<string, unknown> {
  return {
    report: 'phase-113-sidecar-unraid-custodian-boundary-descriptor',
    redactionSafe: true,
    sourceBlocker: 'managed-custodian-sidecar-boundary-attestation-redacted',
    sidecarRunsOutsideAppProcess: true,
    appCannotReadRawDek: true,
    appCannotForgeAttestation: true,
    attestationFormatDocumented: true,
    durableNonSecretTombstones: true,
    lostAckRecoveryDocumented: true,
    restoreMismatchFailsClosed: true,
    localSocketOnly: true,
    tcpListenerAllowed: false,
    httpApiAllowed: false,
    lanExposureAllowed: false,
    providerContactAllowed: false,
    fileCustodianIsProductionKms: false,
    rawEvidenceIncluded: false,
    secretPathsIncluded: false,
    serviceInstalled: false,
    serviceStarted: false,
    closesO4: false,
    closesO5: false,
  };
}

export function formatSidecarUnraidCustodianBoundaryJson(report: SidecarUnraidCustodianBoundaryReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatSidecarUnraidCustodianBoundaryText(report: SidecarUnraidCustodianBoundaryReport): string {
  const lines = [
    'Phase 113 sidecar Unraid custodian boundary preflight',
    `reviewReadiness: ${report.reviewReadiness}`,
    `descriptorValuesEchoed: ${report.descriptorValuesEchoed ? 'true' : 'false'}`,
    `commandExecution: ${report.commandExecution ? 'true' : 'false'}`,
    `productionReady: ${report.productionReady ? 'true' : 'false'}`,
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

export function sidecarUnraidCustodianBoundaryHasFailures(report: SidecarUnraidCustodianBoundaryReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly SidecarUnraidCustodianBoundaryFinding[]): SidecarUnraidCustodianBoundaryReport {
  const summary = summarize(findings);
  return {
    report: 'phase-113-sidecar-unraid-custodian-boundary-preflight',
    version: 1,
    purpose: 'preflight-redacted-o4-sidecar-custodian-boundary-evidence',
    descriptorInput: 'single-redacted-sidecar-custodian-boundary-json-file',
    sourceBlocker: 'managed-custodian-sidecar-boundary-attestation-redacted',
    redactionSafe: true,
    descriptorValuesEchoed: false,
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
    reviewReadiness: summary.fail === 0 ? 'ready-for-independent-review' : 'not-ready-for-independent-review',
    summary,
    findings,
  };
}

function summarize(findings: readonly SidecarUnraidCustodianBoundaryFinding[]): SidecarUnraidCustodianBoundaryReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function requiredLiteral(
  object: Record<string, unknown>,
  field: string,
  expected: string | boolean,
  passCode: string,
): SidecarUnraidCustodianBoundaryFinding[] {
  return [object[field] === expected
    ? pass(passCode, field, `${field} has the expected fixed value.`)
    : fail(`${passCode}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function pass(code: string, field: string, message: string): SidecarUnraidCustodianBoundaryFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): SidecarUnraidCustodianBoundaryFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: string, message: string): SidecarUnraidCustodianBoundaryFinding {
  return { level: 'warn', code, field, message };
}
