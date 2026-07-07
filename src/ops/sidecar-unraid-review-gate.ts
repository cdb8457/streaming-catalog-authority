import {
  completeSidecarUnraidEvidenceBundleTemplate,
  type SidecarUnraidEvidenceBundle,
} from './sidecar-unraid-evidence-capture.js';

export type SidecarUnraidReviewGateInputErrorCode =
  | 'REVIEW_GATE_FILE_READ_FAILED'
  | 'REVIEW_GATE_FILE_TOO_LARGE'
  | 'REVIEW_GATE_JSON_MALFORMED'
  | 'REVIEW_GATE_OBJECT_REQUIRED'
  | 'REVIEW_GATE_INPUT_REQUIRED';

export interface SidecarUnraidReviewGateFinding {
  readonly level: 'pass' | 'warn' | 'fail';
  readonly code: string;
  readonly field: keyof SidecarUnraidEvidenceBundle | 'bundle' | 'review';
  readonly message: string;
}

export interface SidecarUnraidReviewGateReport {
  readonly ok: boolean;
  readonly code: 'SIDECAR_UNRAID_REVIEW_GATE';
  readonly report: 'phase-108-sidecar-unraid-review-gate';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly purpose: 'review-redacted-unraid-sidecar-operator-evidence-without-running-commands';
  readonly source: 'single-redacted-sidecar-unraid-evidence-json-file';
  readonly commandExecution: false;
  readonly evidenceValuesEchoed: false;
  readonly liveServiceContact: false;
  readonly providerContactAllowed: false;
  readonly reviewReadiness: 'ready-for-review' | 'not-ready-for-review';
  readonly closesO4: false;
  readonly closesO5: false;
  readonly o4Status: 'open/deferred';
  readonly o5Status: 'open/deferred';
  readonly fileCustodianStatus: 'reference-harness-not-production-kms';
  readonly summary: {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
    readonly total: number;
  };
  readonly findings: readonly SidecarUnraidReviewGateFinding[];
}

export function buildSidecarUnraidReviewGateReport(bundle: Record<string, unknown>): SidecarUnraidReviewGateReport {
  const findings: SidecarUnraidReviewGateFinding[] = [];
  findings.push(...requiredLiteral(bundle, 'report', 'phase-107-sidecar-unraid-operator-evidence-bundle', 'BUNDLE_REPORT_VALID'));
  findings.push(...requiredLiteral(bundle, 'version', 1, 'BUNDLE_VERSION_VALID'));
  findings.push(...requiredLiteral(bundle, 'redactionSafe', true, 'BUNDLE_REDACTION_SAFE'));
  findings.push(...requiredLiteral(bundle, 'source', 'operator-run-redacted-unraid-sidecar-evidence', 'BUNDLE_SOURCE_VALID'));
  findings.push(...requiredLiteral(bundle, 'valuesEchoed', false, 'BUNDLE_VALUES_NOT_ECHOED'));
  findings.push(...requiredLiteral(bundle, 'commandExecutionByReviewGate', false, 'REVIEW_GATE_EXECUTES_NOTHING'));
  findings.push(...requiredCaptured(bundle, 'setupPermissions', 'SETUP_PERMISSIONS_CAPTURED'));
  findings.push(...requiredCaptured(bundle, 'localSocketHealth', 'LOCAL_SOCKET_HEALTH_CAPTURED'));
  findings.push(...requiredCaptured(bundle, 'restartPersistence', 'RESTART_PERSISTENCE_CAPTURED'));
  findings.push(...requiredCaptured(bundle, 'restoreMismatchFailClosed', 'RESTORE_MISMATCH_FAIL_CLOSED_CAPTURED'));
  findings.push(...requiredCaptured(bundle, 'logRedaction', 'LOG_REDACTION_CAPTURED'));
  findings.push(...requiredFalse(bundle, 'tcpListenerObserved', 'NO_TCP_LISTENER_OBSERVED'));
  findings.push(...requiredFalse(bundle, 'httpApiObserved', 'NO_HTTP_API_OBSERVED'));
  findings.push(...requiredFalse(bundle, 'lanExposureObserved', 'NO_LAN_EXPOSURE_OBSERVED'));
  findings.push(...requiredFalse(bundle, 'reverseProxyObserved', 'NO_REVERSE_PROXY_OBSERVED'));
  findings.push(...requiredFalse(bundle, 'providerContactObserved', 'NO_PROVIDER_CONTACT_OBSERVED'));
  findings.push(...requiredFalse(bundle, 'serviceInstalledByPacket', 'SERVICE_NOT_INSTALLED_BY_PACKET'));
  findings.push(...requiredFalse(bundle, 'closesO4', 'BUNDLE_DOES_NOT_CLOSE_O4'));
  findings.push(...requiredFalse(bundle, 'closesO5', 'BUNDLE_DOES_NOT_CLOSE_O5'));

  if (typeof bundle.operatorRunLabel === 'string' && bundle.operatorRunLabel.trim().length > 0) {
    findings.push(pass('OPERATOR_RUN_LABEL_PRESENT', 'operatorRunLabel', 'operator run label is present.'));
  } else {
    findings.push(fail('OPERATOR_RUN_LABEL_REQUIRED', 'operatorRunLabel', 'operator run label is required.'));
  }

  findings.push(warn('REVIEWER_STILL_REQUIRED', 'review', 'This gate prepares review and does not close O4 or O5.'));
  findings.push(warn('O4_REMAINS_OPEN', 'review', 'O4 remains open/deferred until separate reviewer/operator acceptance.'));
  findings.push(warn('O5_REMAINS_OPEN', 'review', 'O5 remains open/deferred until managed KEK custody and scheduling evidence is reviewed.'));
  findings.push(warn('FILE_CUSTODIAN_NOT_PRODUCTION_KMS', 'review', 'FileCustodian remains a hardened reference harness, not production KMS.'));
  return fromFindings(findings);
}

export function buildSidecarUnraidReviewGateInputErrorReport(code: SidecarUnraidReviewGateInputErrorCode): SidecarUnraidReviewGateReport {
  const messages: Record<SidecarUnraidReviewGateInputErrorCode, string> = {
    REVIEW_GATE_FILE_READ_FAILED: 'A supplied sidecar Unraid evidence JSON file could not be read.',
    REVIEW_GATE_FILE_TOO_LARGE: 'A supplied sidecar Unraid evidence JSON file exceeds the review gate input size limit.',
    REVIEW_GATE_JSON_MALFORMED: 'A supplied sidecar Unraid evidence input is not valid JSON.',
    REVIEW_GATE_OBJECT_REQUIRED: 'A supplied sidecar Unraid evidence JSON value must be an object, not an array or primitive.',
    REVIEW_GATE_INPUT_REQUIRED: 'One sidecar Unraid evidence input is required.',
  };
  return fromFindings([fail(code, 'bundle', messages[code])]);
}

export function parseSidecarUnraidEvidenceBundleJson(jsonText: string): Record<string, unknown> | SidecarUnraidReviewGateInputErrorCode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripLeadingUtf8Bom(jsonText)) as unknown;
  } catch {
    return 'REVIEW_GATE_JSON_MALFORMED';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'REVIEW_GATE_OBJECT_REQUIRED';
  return parsed as Record<string, unknown>;
}

export function sampleCompleteSidecarUnraidEvidenceBundle(): SidecarUnraidEvidenceBundle {
  return completeSidecarUnraidEvidenceBundleTemplate();
}

export function formatSidecarUnraidReviewGateJson(report: SidecarUnraidReviewGateReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatSidecarUnraidReviewGateText(report: SidecarUnraidReviewGateReport): string {
  const lines = [
    'Phase 108 Sidecar Unraid Review Gate',
    '',
    `Review readiness: ${report.reviewReadiness}`,
    `Redaction-safe: ${report.redactionSafe ? 'yes' : 'no'}`,
    `Command execution: ${report.commandExecution ? 'true' : 'false'}`,
    `Evidence values echoed: ${report.evidenceValuesEchoed ? 'true' : 'false'}`,
    `Live service contact: ${report.liveServiceContact ? 'true' : 'false'}`,
    `Provider contact allowed: ${report.providerContactAllowed ? 'true' : 'false'}`,
    `Closes O4: ${report.closesO4 ? 'true' : 'false'}`,
    `Closes O5: ${report.closesO5 ? 'true' : 'false'}`,
    `O4 status: ${report.o4Status}`,
    `O5 status: ${report.o5Status}`,
    `FileCustodian: ${report.fileCustodianStatus}`,
    `Findings: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    ...report.findings.map((finding) => `- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function sidecarUnraidReviewGateHasFailures(report: SidecarUnraidReviewGateReport): boolean {
  return report.summary.fail > 0;
}

function fromFindings(findings: readonly SidecarUnraidReviewGateFinding[]): SidecarUnraidReviewGateReport {
  const summary = summarize(findings);
  return {
    ok: summary.fail === 0,
    code: 'SIDECAR_UNRAID_REVIEW_GATE',
    report: 'phase-108-sidecar-unraid-review-gate',
    version: 1,
    redactionSafe: true,
    purpose: 'review-redacted-unraid-sidecar-operator-evidence-without-running-commands',
    source: 'single-redacted-sidecar-unraid-evidence-json-file',
    commandExecution: false,
    evidenceValuesEchoed: false,
    liveServiceContact: false,
    providerContactAllowed: false,
    reviewReadiness: summary.fail === 0 ? 'ready-for-review' : 'not-ready-for-review',
    closesO4: false,
    closesO5: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    summary,
    findings,
  };
}

function requiredLiteral(
  bundle: Record<string, unknown>,
  field: keyof SidecarUnraidEvidenceBundle,
  expected: string | number | boolean,
  code: string,
): SidecarUnraidReviewGateFinding[] {
  return [bundle[field] === expected
    ? pass(code, field, `${field} has the expected fixed value.`)
    : fail(`${code}_REQUIRED`, field, `${field} must have the expected fixed value.`)];
}

function requiredCaptured(bundle: Record<string, unknown>, field: keyof SidecarUnraidEvidenceBundle, code: string): SidecarUnraidReviewGateFinding[] {
  return [bundle[field] === 'captured'
    ? pass(code, field, `${field} is captured.`)
    : fail(`${code}_REQUIRED`, field, `${field} must be captured.`)];
}

function requiredFalse(bundle: Record<string, unknown>, field: keyof SidecarUnraidEvidenceBundle, code: string): SidecarUnraidReviewGateFinding[] {
  return [bundle[field] === false
    ? pass(code, field, `${field} is false.`)
    : fail(`${code}_REQUIRED`, field, `${field} must be false.`)];
}

function summarize(findings: readonly SidecarUnraidReviewGateFinding[]): SidecarUnraidReviewGateReport['summary'] {
  const summary = { pass: 0, warn: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function stripLeadingUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

function pass(code: string, field: SidecarUnraidReviewGateFinding['field'], message: string): SidecarUnraidReviewGateFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: SidecarUnraidReviewGateFinding['field'], message: string): SidecarUnraidReviewGateFinding {
  return { level: 'fail', code, field, message };
}

function warn(code: string, field: SidecarUnraidReviewGateFinding['field'], message: string): SidecarUnraidReviewGateFinding {
  return { level: 'warn', code, field, message };
}
