export type OperatorUiLocalAuthSecretFilePreflightReportName =
  'operator-ui-local-auth-secret-file-preflight';
export type OperatorUiLocalAuthSecretFilePreflightReportVersion = 'phase-80.v1';
export type OperatorUiLocalAuthSecretFilePreflightCode =
  'OPERATOR_UI_LOCAL_AUTH_SECRET_FILE_PREFLIGHT_REPORTED';
export type OperatorUiLocalAuthSecretFilePreflightBoundary =
  'local-operator-secret-file-with-explicit-path-and-redacted-evidence';
export type OperatorUiLocalAuthSecretFilePreflightStatus =
  | 'blocked/preflight-only'
  | 'ready-for-review/preflight-only';
export type OperatorUiLocalAuthSecretFilePreflightImplementation = 'not-implemented';

export type OperatorUiLocalAuthSecretFilePreflightInputErrorCode =
  | 'DESCRIPTOR_FILE_REQUIRED'
  | 'DESCRIPTOR_FILE_READ_FAILED'
  | 'DESCRIPTOR_FILE_IS_DIRECTORY'
  | 'DESCRIPTOR_FILE_TOO_LARGE'
  | 'DESCRIPTOR_JSON_MALFORMED'
  | 'DESCRIPTOR_OBJECT_REQUIRED';

export interface OperatorUiLocalAuthSecretFilePreflightDescriptor {
  readonly boundaryId: OperatorUiLocalAuthSecretFilePreflightBoundary;
  readonly operatorFilePathProvided: boolean;
  readonly defaultPathDisabled: boolean;
  readonly envSecretValueDisabled: boolean;
  readonly cliSecretValueDisabled: boolean;
  readonly maxSecretFileBytes: number;
  readonly trimOneTrailingNewlineOnly: boolean;
  readonly rejectEmptyOrWhitespace: boolean;
  readonly rejectLowEntropyOrShort: boolean;
  readonly constantTimeComparisonPlanned: boolean;
  readonly secretNeverLoggedOrPersisted: boolean;
  readonly redactionSafeErrors: boolean;
  readonly loopbackOnly: boolean;
  readonly browserStorageCookieSessionBearerBasicOAuthDisabled: boolean;
  readonly reviewerGoRecorded: boolean;
  readonly operatorAcceptanceRecorded: boolean;
}

export type OperatorUiLocalAuthSecretFilePreflightFindingLevel = 'pass' | 'fail';

export interface OperatorUiLocalAuthSecretFilePreflightFinding {
  readonly level: OperatorUiLocalAuthSecretFilePreflightFindingLevel;
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

export interface OperatorUiLocalAuthSecretFilePreflightSummary {
  readonly pass: number;
  readonly fail: number;
  readonly total: number;
}

export interface OperatorUiLocalAuthSecretFilePreflightGate {
  readonly id:
    | 'descriptor-shape'
    | 'explicit-operator-file-path-attestation'
    | 'no-default-path'
    | 'no-env-secret-value'
    | 'no-cli-secret-value'
    | 'secret-file-byte-bound'
    | 'newline-trim-policy'
    | 'empty-whitespace-rejection'
    | 'low-entropy-short-rejection'
    | 'constant-time-comparison-review'
    | 'secret-redaction'
    | 'redaction-safe-errors'
    | 'loopback-only'
    | 'browser-storage-cookie-session-bearer-basic-oauth-disabled'
    | 'independent-reviewer-go'
    | 'operator-acceptance-record'
    | 'runtime-auth-implementation'
    | 'static-route-surface-regression';
  readonly status: 'pass' | 'blocked' | 'required-before-auth-implementation';
  readonly requirement: string;
}

export interface OperatorUiLocalAuthSecretFilePreflightReport {
  readonly ok: boolean;
  readonly code: OperatorUiLocalAuthSecretFilePreflightCode;
  readonly message: string;
  readonly reportName: OperatorUiLocalAuthSecretFilePreflightReportName;
  readonly reportVersion: OperatorUiLocalAuthSecretFilePreflightReportVersion;
  readonly selectedBoundary: OperatorUiLocalAuthSecretFilePreflightBoundary;
  readonly authImplementation: OperatorUiLocalAuthSecretFilePreflightImplementation;
  readonly status: OperatorUiLocalAuthSecretFilePreflightStatus;
  readonly descriptorInput: 'single-explicit-operator-json-file';
  readonly descriptorValuesEchoed: false;
  readonly descriptorPathEchoed: false;
  readonly secretFileRead: false;
  readonly secretPathValidatedAgainstFilesystem: false;
  readonly runtimeAuthBlocked: true;
  readonly currentStaticRuntimeRoutes: readonly ['GET /', 'GET /healthz', 'GET /manifest.json'];
  readonly blockedUntilExplicitLaterImplementationReview: readonly string[];
  readonly forbiddenDescriptorFields: readonly string[];
  readonly gates: readonly OperatorUiLocalAuthSecretFilePreflightGate[];
  readonly findings: readonly OperatorUiLocalAuthSecretFilePreflightFinding[];
  readonly summary: OperatorUiLocalAuthSecretFilePreflightSummary;
}

const SELECTED_BOUNDARY: OperatorUiLocalAuthSecretFilePreflightBoundary =
  'local-operator-secret-file-with-explicit-path-and-redacted-evidence';

const ACCEPTED_FIELDS = [
  'boundaryId',
  'operatorFilePathProvided',
  'defaultPathDisabled',
  'envSecretValueDisabled',
  'cliSecretValueDisabled',
  'maxSecretFileBytes',
  'trimOneTrailingNewlineOnly',
  'rejectEmptyOrWhitespace',
  'rejectLowEntropyOrShort',
  'constantTimeComparisonPlanned',
  'secretNeverLoggedOrPersisted',
  'redactionSafeErrors',
  'loopbackOnly',
  'browserStorageCookieSessionBearerBasicOAuthDisabled',
  'reviewerGoRecorded',
  'operatorAcceptanceRecorded',
] as const;

const DANGEROUS_DESCRIPTOR_FIELDS = [
  'secret',
  'secretValue',
  'path',
  'secretPath',
  'filePath',
  'token',
  'password',
  'authorization',
  'cookie',
  'url',
  'databaseUrl',
  'rawRef',
  'infohash',
  'magnet',
  'title',
  'providerName',
  'packetContents',
  'artifactContents',
] as const;

const BLOCKED_UNTIL = [
  'runtime auth remains blocked until an explicit later implementation phase',
  'future implementation must be independently reviewed before auth can be enabled',
  'future implementation must prove redaction-safe evidence without echoing descriptor paths, secret paths, secret values, credentials, packet contents, artifact contents, or user library data',
  'static runtime route surface must remain only GET /, GET /healthz, GET /manifest.json until a later route phase is authorized',
] as const;

const STATIC_RUNTIME_ROUTES = [
  'GET /',
  'GET /healthz',
  'GET /manifest.json',
] as const;

const GATE_REQUIREMENTS = [
  {
    id: 'descriptor-shape',
    field: 'boundaryId',
    requirement: 'Descriptor must use only the Phase 80 boolean/label fields and the selected boundary id.',
  },
  {
    id: 'explicit-operator-file-path-attestation',
    field: 'operatorFilePathProvided',
    requirement: 'Descriptor must attest that a future operator file path is explicit without including the path.',
  },
  {
    id: 'no-default-path',
    field: 'defaultPathDisabled',
    requirement: 'Descriptor must attest that default secret paths are disabled.',
  },
  {
    id: 'no-env-secret-value',
    field: 'envSecretValueDisabled',
    requirement: 'Descriptor must attest that environment secret values are disabled.',
  },
  {
    id: 'no-cli-secret-value',
    field: 'cliSecretValueDisabled',
    requirement: 'Descriptor must attest that CLI secret values are disabled.',
  },
  {
    id: 'secret-file-byte-bound',
    field: 'maxSecretFileBytes',
    requirement: 'Descriptor must set a positive future secret file byte bound of 4096 bytes or less.',
  },
  {
    id: 'newline-trim-policy',
    field: 'trimOneTrailingNewlineOnly',
    requirement: 'Descriptor must attest that only one trailing newline is trimmed in a future implementation.',
  },
  {
    id: 'empty-whitespace-rejection',
    field: 'rejectEmptyOrWhitespace',
    requirement: 'Descriptor must attest that empty or whitespace-only secrets are rejected in a future implementation.',
  },
  {
    id: 'low-entropy-short-rejection',
    field: 'rejectLowEntropyOrShort',
    requirement: 'Descriptor must attest that low-entropy or short secrets are rejected in a future implementation.',
  },
  {
    id: 'constant-time-comparison-review',
    field: 'constantTimeComparisonPlanned',
    requirement: 'Descriptor must attest that constant-time comparison is planned for a later reviewed implementation.',
  },
  {
    id: 'secret-redaction',
    field: 'secretNeverLoggedOrPersisted',
    requirement: 'Descriptor must attest that the secret is never logged, echoed, persisted, or included in evidence.',
  },
  {
    id: 'redaction-safe-errors',
    field: 'redactionSafeErrors',
    requirement: 'Descriptor must attest that future failures use fixed redaction-safe errors.',
  },
  {
    id: 'loopback-only',
    field: 'loopbackOnly',
    requirement: 'Descriptor must attest that future auth remains loopback-only unless separately reviewed.',
  },
  {
    id: 'browser-storage-cookie-session-bearer-basic-oauth-disabled',
    field: 'browserStorageCookieSessionBearerBasicOAuthDisabled',
    requirement: 'Descriptor must attest that browser storage, cookies, sessions, bearer/basic auth, and OAuth are disabled.',
  },
  {
    id: 'independent-reviewer-go',
    field: 'reviewerGoRecorded',
    requirement: 'Descriptor must attest that independent reviewer GO has been recorded for this preflight contract.',
  },
  {
    id: 'operator-acceptance-record',
    field: 'operatorAcceptanceRecorded',
    requirement: 'Descriptor must attest that operator acceptance has been recorded for this preflight contract.',
  },
] as const;

export function buildOperatorUiLocalAuthSecretFilePreflightReport(
  descriptor: Record<string, unknown>,
): OperatorUiLocalAuthSecretFilePreflightReport {
  const findings = validateDescriptor(descriptor);
  return buildReport(findings);
}

export function buildOperatorUiLocalAuthSecretFilePreflightInputErrorReport(
  code: OperatorUiLocalAuthSecretFilePreflightInputErrorCode,
): OperatorUiLocalAuthSecretFilePreflightReport {
  const messages: Record<OperatorUiLocalAuthSecretFilePreflightInputErrorCode, string> = {
    DESCRIPTOR_FILE_REQUIRED: 'Descriptor JSON file is required.',
    DESCRIPTOR_FILE_READ_FAILED: 'Descriptor JSON file could not be read.',
    DESCRIPTOR_FILE_IS_DIRECTORY: 'Descriptor JSON file must be a file.',
    DESCRIPTOR_FILE_TOO_LARGE: 'Descriptor JSON file exceeds the preflight size limit.',
    DESCRIPTOR_JSON_MALFORMED: 'Descriptor input is not valid JSON.',
    DESCRIPTOR_OBJECT_REQUIRED: 'Descriptor JSON must be an object, not an array or primitive.',
  };
  return buildReport([{
    level: 'fail',
    code,
    field: 'descriptor',
    message: messages[code],
  }]);
}

export function parseOperatorUiLocalAuthSecretFilePreflightDescriptorJson(
  jsonText: string,
): Record<string, unknown> | OperatorUiLocalAuthSecretFilePreflightInputErrorCode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripLeadingUtf8Bom(jsonText)) as unknown;
  } catch {
    return 'DESCRIPTOR_JSON_MALFORMED';
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'DESCRIPTOR_OBJECT_REQUIRED';
  }

  return parsed as Record<string, unknown>;
}

export function formatOperatorUiLocalAuthSecretFilePreflightJson(
  report: OperatorUiLocalAuthSecretFilePreflightReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatOperatorUiLocalAuthSecretFilePreflightText(
  report: OperatorUiLocalAuthSecretFilePreflightReport,
): string {
  const lines = [
    'Operator UI Local Auth Secret File Preflight',
    `code: ${report.code}`,
    `report: ${report.reportName}`,
    `version: ${report.reportVersion}`,
    `status: ${report.status}`,
    `selected boundary: ${report.selectedBoundary}`,
    `auth implementation: ${report.authImplementation}`,
    `descriptor input: ${report.descriptorInput}`,
    `descriptor values echoed: ${report.descriptorValuesEchoed ? 'yes' : 'no'}`,
    `descriptor path echoed: ${report.descriptorPathEchoed ? 'yes' : 'no'}`,
    `secret file read: ${report.secretFileRead ? 'yes' : 'no'}`,
    `runtime auth blocked: ${report.runtimeAuthBlocked ? 'yes' : 'no'}`,
    `summary: pass=${report.summary.pass} fail=${report.summary.fail} total=${report.summary.total}`,
    '',
    'Gates:',
  ];

  for (const gate of report.gates) {
    lines.push(`- ${gate.id}: ${gate.status}; ${gate.requirement}`);
  }

  lines.push('', 'Findings:');
  for (const finding of report.findings) {
    lines.push(`- ${finding.level.toUpperCase()} ${finding.code} field=${finding.field}: ${finding.message}`);
  }

  lines.push('', 'Current static runtime routes:');
  for (const route of report.currentStaticRuntimeRoutes) lines.push(`- ${route}`);

  lines.push('', 'Runtime auth remains blocked until:');
  for (const item of report.blockedUntilExplicitLaterImplementationReview) lines.push(`- ${item}`);

  lines.push('', 'Forbidden descriptor fields:');
  for (const field of report.forbiddenDescriptorFields) lines.push(`- ${field}`);

  return `${lines.join('\n')}\n`;
}

export function operatorUiLocalAuthSecretFilePreflightHasFailures(
  report: OperatorUiLocalAuthSecretFilePreflightReport,
): boolean {
  return report.summary.fail > 0;
}

function validateDescriptor(descriptor: Record<string, unknown>): OperatorUiLocalAuthSecretFilePreflightFinding[] {
  const findings: OperatorUiLocalAuthSecretFilePreflightFinding[] = [];
  const accepted = new Set<string>(ACCEPTED_FIELDS);
  const dangerous = new Set<string>(DANGEROUS_DESCRIPTOR_FIELDS.map((field) => field.toLowerCase()));

  for (const key of Object.keys(descriptor)) {
    if (dangerous.has(key.toLowerCase())) {
      findings.push({
        level: 'fail',
        code: 'DANGEROUS_DESCRIPTOR_FIELD_REJECTED',
        field: 'descriptor',
        message: 'Descriptor contains a forbidden sensitive field name.',
      });
      continue;
    }

    if (!accepted.has(key)) {
      findings.push({
        level: 'fail',
        code: 'UNKNOWN_DESCRIPTOR_FIELD_REJECTED',
        field: 'descriptor',
        message: 'Descriptor contains an unknown field.',
      });
    }
  }

  if (descriptor.boundaryId === SELECTED_BOUNDARY) {
    findings.push(pass('BOUNDARY_ID_ACCEPTED', 'boundaryId', 'Selected local secret-file boundary is declared.'));
  } else {
    findings.push(fail('BOUNDARY_ID_REQUIRED', 'boundaryId', 'Selected local secret-file boundary id is required.'));
  }

  for (const gate of GATE_REQUIREMENTS) {
    if (gate.field === 'boundaryId') continue;
    const value = descriptor[gate.field];
    if (gate.field === 'maxSecretFileBytes') {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 4096) {
        findings.push(pass('SECRET_FILE_BYTE_BOUND_ACCEPTED', gate.field, 'Future secret file byte bound is within limit.'));
      } else {
        findings.push(fail('SECRET_FILE_BYTE_BOUND_REQUIRED', gate.field, 'Future secret file byte bound must be positive and at most 4096 bytes.'));
      }
      continue;
    }

    if (value === true) {
      findings.push(pass(`${constantCodePrefix(gate.field)}_ACCEPTED`, gate.field, 'Required descriptor attestation is true.'));
    } else {
      findings.push(fail(`${constantCodePrefix(gate.field)}_REQUIRED`, gate.field, 'Required descriptor attestation must be true.'));
    }
  }

  return findings;
}

function buildReport(
  findings: readonly OperatorUiLocalAuthSecretFilePreflightFinding[],
): OperatorUiLocalAuthSecretFilePreflightReport {
  const summary = summarize(findings);
  const status: OperatorUiLocalAuthSecretFilePreflightStatus =
    summary.fail === 0 ? 'ready-for-review/preflight-only' : 'blocked/preflight-only';

  return {
    ok: summary.fail === 0,
    code: 'OPERATOR_UI_LOCAL_AUTH_SECRET_FILE_PREFLIGHT_REPORTED',
    message: summary.fail === 0
      ? 'Operator UI local auth secret-file preflight is ready for review only; auth remains not implemented.'
      : 'Operator UI local auth secret-file preflight is blocked and fail-closed; auth remains not implemented.',
    reportName: 'operator-ui-local-auth-secret-file-preflight',
    reportVersion: 'phase-80.v1',
    selectedBoundary: SELECTED_BOUNDARY,
    authImplementation: 'not-implemented',
    status,
    descriptorInput: 'single-explicit-operator-json-file',
    descriptorValuesEchoed: false,
    descriptorPathEchoed: false,
    secretFileRead: false,
    secretPathValidatedAgainstFilesystem: false,
    runtimeAuthBlocked: true,
    currentStaticRuntimeRoutes: [...STATIC_RUNTIME_ROUTES],
    blockedUntilExplicitLaterImplementationReview: [...BLOCKED_UNTIL],
    forbiddenDescriptorFields: [...DANGEROUS_DESCRIPTOR_FIELDS],
    gates: buildGates(status),
    findings: findings.map((finding) => ({ ...finding })),
    summary,
  };
}

function buildGates(
  status: OperatorUiLocalAuthSecretFilePreflightStatus,
): readonly OperatorUiLocalAuthSecretFilePreflightGate[] {
  const descriptorGateStatus: OperatorUiLocalAuthSecretFilePreflightGate['status'] =
    status === 'ready-for-review/preflight-only' ? 'pass' : 'blocked';
  return [
    ...GATE_REQUIREMENTS.map((gate) => ({
      id: gate.id,
      status: descriptorGateStatus,
      requirement: gate.requirement,
    })),
    {
      id: 'runtime-auth-implementation',
      status: 'blocked' as const,
      requirement: 'Runtime auth remains blocked until a later explicit implementation and review phase.',
    },
    {
      id: 'static-route-surface-regression',
      status: 'blocked' as const,
      requirement: 'Static route surface remains only GET /, GET /healthz, GET /manifest.json in this phase.',
    },
  ];
}

function summarize(findings: readonly OperatorUiLocalAuthSecretFilePreflightFinding[]): OperatorUiLocalAuthSecretFilePreflightSummary {
  const summary = { pass: 0, fail: 0, total: findings.length };
  for (const finding of findings) summary[finding.level]++;
  return summary;
}

function pass(code: string, field: string, message: string): OperatorUiLocalAuthSecretFilePreflightFinding {
  return { level: 'pass', code, field, message };
}

function fail(code: string, field: string, message: string): OperatorUiLocalAuthSecretFilePreflightFinding {
  return { level: 'fail', code, field, message };
}

function constantCodePrefix(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
}

function stripLeadingUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}
