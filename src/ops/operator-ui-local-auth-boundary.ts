import { buildOperatorUiAuthAccessContractReport } from './operator-ui-auth-access-contract.js';
import { buildOperatorUiPacketEndpointRouteDryRunReport } from './operator-ui-packet-endpoint-route-dry-run.js';

export type OperatorUiLocalAuthBoundaryReportName = 'operator-ui-local-auth-boundary';
export type OperatorUiLocalAuthBoundaryReportVersion = 'phase-79.v1';
export type OperatorUiLocalAuthBoundaryStatus = 'blocked';
export type OperatorUiLocalAuthBoundaryPhase = 'auth-boundary-selection-only';
export type OperatorUiLocalAuthImplementationStatus = 'not-implemented';
export type OperatorUiLocalAuthBoundarySelection =
  'local-operator-secret-file-with-explicit-path-and-redacted-evidence';
export type OperatorUiLocalAuthBoundarySelectionStatus = 'selected-for-future-review/not-implemented';

export interface OperatorUiSelectedAuthBoundary {
  readonly id: OperatorUiLocalAuthBoundarySelection;
  readonly status: OperatorUiLocalAuthBoundarySelectionStatus;
  readonly reason: string;
  readonly futureRequirements: readonly string[];
  readonly forbiddenNow: readonly string[];
}

export interface OperatorUiRejectedAuthBoundary {
  readonly id:
    | 'reverse-proxy-forward-auth-attestation'
    | 'mTLS-or-local-network-attestation'
    | 'browser-cookie-session'
    | 'bearer-token-api';
  readonly status: 'rejected-for-first-implementation';
  readonly reason: string;
}

export interface OperatorUiFutureAuthImplementationGate {
  readonly id:
    | 'explicit-operator-file-path-review'
    | 'redaction-safe-evidence-review'
    | 'secret-file-size-bound-review'
    | 'secret-value-validation-review'
    | 'constant-time-comparison-review'
    | 'loopback-only-runtime-review'
    | 'static-route-regression-review'
    | 'independent-reviewer-go'
    | 'operator-acceptance-record';
  readonly status: 'blocked' | 'required-before-auth-implementation';
  readonly requirement: string;
}

export interface OperatorUiLocalAuthBoundaryReport {
  readonly ok: true;
  readonly code: 'OPERATOR_UI_LOCAL_AUTH_BOUNDARY_REPORTED';
  readonly message: 'Operator UI local auth boundary selection is blocked, contract-only, and not implemented.';
  readonly reportName: OperatorUiLocalAuthBoundaryReportName;
  readonly reportVersion: OperatorUiLocalAuthBoundaryReportVersion;
  readonly status: {
    readonly overall: OperatorUiLocalAuthBoundaryStatus;
    readonly phase: OperatorUiLocalAuthBoundaryPhase;
    readonly authImplementation: OperatorUiLocalAuthImplementationStatus;
  };
  readonly selectedFutureBoundary: OperatorUiLocalAuthBoundarySelection;
  readonly selectedBoundaryStatus: OperatorUiLocalAuthBoundarySelectionStatus;
  readonly rejectedBoundaryOptions: {
    readonly 'reverse-proxy-forward-auth-attestation': 'rejected-for-first-implementation';
    readonly 'mTLS-or-local-network-attestation': 'rejected-for-first-implementation';
    readonly 'browser-cookie-session': 'rejected-for-first-implementation';
    readonly 'bearer-token-api': 'rejected-for-first-implementation';
  };
  readonly currentRuntimeExposure: '127.0.0.1 fixture preview only';
  readonly remoteExposure: 'blocked';
  readonly phase74AuthContract: {
    readonly reportName: 'operator-ui-auth-access-contract';
    readonly reportVersion: 'phase-74.v1';
    readonly code: 'OPERATOR_UI_AUTH_ACCESS_CONTRACT_REPORTED';
    readonly phase: 'contract-only';
    readonly implementation: 'not-implemented';
  };
  readonly phase75Readiness: {
    readonly reportName: 'operator-ui-packet-endpoint-readiness';
    readonly reportVersion: 'phase-75.v1';
    readonly code: 'OPERATOR_UI_PACKET_ENDPOINT_READINESS_REPORTED';
    readonly status: 'not-ready';
  };
  readonly phase76Limits: {
    readonly reportName: 'operator-ui-packet-endpoint-limits';
    readonly reportVersion: 'phase-76.v1';
    readonly code: 'OPERATOR_UI_PACKET_ENDPOINT_LIMITS_REPORTED';
    readonly phase: 'contract-only';
    readonly implementation: 'not-implemented';
  };
  readonly phase77EvidenceGate: {
    readonly reportName: 'operator-ui-packet-endpoint-evidence-gate';
    readonly reportVersion: 'phase-77.v1';
    readonly code: 'OPERATOR_UI_PACKET_ENDPOINT_EVIDENCE_GATE_REPORTED';
    readonly status: 'blocked';
    readonly phase: 'evidence-required';
  };
  readonly phase78RouteDryRun: {
    readonly reportName: 'operator-ui-packet-endpoint-route-dry-run';
    readonly reportVersion: 'phase-78.v1';
    readonly code: 'OPERATOR_UI_PACKET_ENDPOINT_ROUTE_DRY_RUN_REPORTED';
    readonly status: 'blocked';
    readonly phase: 'dry-run-plan-only';
  };
  readonly selectedBoundary: OperatorUiSelectedAuthBoundary;
  readonly rejectedBoundaries: readonly OperatorUiRejectedAuthBoundary[];
  readonly futureImplementationGates: readonly OperatorUiFutureAuthImplementationGate[];
  readonly forbiddenCurrentRoutes: readonly string[];
  readonly currentStaticRuntimeRoutes: readonly ['GET /', 'GET /healthz', 'GET /manifest.json'];
  readonly retainedFailClosedRuntimeBehavior: readonly string[];
  readonly forbiddenImplementationThisPhase: readonly string[];
  readonly forbiddenEvidenceFields: readonly string[];
}

const FUTURE_REQUIREMENTS = [
  'explicit operator-provided file path only in a later reviewed phase',
  'no default secret path',
  'no environment variable secret value',
  'no CLI argument secret value',
  'bounded file size in future implementation, e.g. <= 4096 bytes',
  'trim one trailing newline only',
  'reject empty or whitespace-only values',
  'reject values below minimum entropy or length in future implementation',
  'compare using constant-time comparison in future implementation',
  'never log, echo, persist, hash-output, or include the secret value in evidence',
  'redaction-safe errors only',
  'loopback-only use unless a later reviewed remote access model exists',
  'no browser storage, cookie/session token, bearer/basic auth, or OAuth/Sso in first implementation',
] as const;

const FORBIDDEN_NOW = [
  'auth implementation',
  'secret file path',
  'secret file read',
  'secret parsing',
  'credential validation',
  'environment or config secret read',
  'CLI argument secret value',
  'cookie/session/token/bearer/basic parsing',
  'reverse-proxy header trust',
  'TLS or mTLS implementation',
  'public bind',
  'route handler',
] as const;

const REJECTED_BOUNDARIES = [
  {
    id: 'reverse-proxy-forward-auth-attestation',
    status: 'rejected-for-first-implementation',
    reason: 'Rejected as the first implementation because proxy header trust and deployment attestation need a separate reviewed remote access model.',
  },
  {
    id: 'mTLS-or-local-network-attestation',
    status: 'rejected-for-first-implementation',
    reason: 'Rejected as the first implementation because certificate, TLS, and local-network trust introduce deployment scope beyond the current loopback boundary.',
  },
  {
    id: 'browser-cookie-session',
    status: 'rejected-for-first-implementation',
    reason: 'Rejected as the first implementation because browser storage, cookies, and session state expand runtime auth surface.',
  },
  {
    id: 'bearer-token-api',
    status: 'rejected-for-first-implementation',
    reason: 'Rejected as the first implementation because bearer/basic style API credentials would widen header parsing and evidence redaction risk.',
  },
] as const satisfies readonly OperatorUiRejectedAuthBoundary[];

const FUTURE_IMPLEMENTATION_GATES = [
  {
    id: 'explicit-operator-file-path-review',
    status: 'required-before-auth-implementation',
    requirement: 'Future auth implementation must require an explicit operator-provided file path with no default path.',
  },
  {
    id: 'redaction-safe-evidence-review',
    status: 'required-before-auth-implementation',
    requirement: 'Evidence must prove no secret value, path, credential, token, header, body, or artifact content is logged or emitted.',
  },
  {
    id: 'secret-file-size-bound-review',
    status: 'required-before-auth-implementation',
    requirement: 'Future file read must enforce a bounded file size, e.g. <= 4096 bytes, before reading a secret value.',
  },
  {
    id: 'secret-value-validation-review',
    status: 'required-before-auth-implementation',
    requirement: 'Future validation must trim one trailing newline only and reject empty, whitespace-only, low-entropy, or short values.',
  },
  {
    id: 'constant-time-comparison-review',
    status: 'required-before-auth-implementation',
    requirement: 'Future comparison must use constant-time comparison and redaction-safe failures.',
  },
  {
    id: 'loopback-only-runtime-review',
    status: 'blocked',
    requirement: 'Auth may be used only on loopback unless a later reviewed remote access model exists.',
  },
  {
    id: 'static-route-regression-review',
    status: 'blocked',
    requirement: 'Static runtime route regression must still prove only GET /, GET /healthz, and GET /manifest.json exist now.',
  },
  {
    id: 'independent-reviewer-go',
    status: 'blocked',
    requirement: 'Independent reviewer GO is required before auth implementation.',
  },
  {
    id: 'operator-acceptance-record',
    status: 'blocked',
    requirement: 'Redaction-safe operator acceptance is required before auth implementation.',
  },
] as const satisfies readonly OperatorUiFutureAuthImplementationGate[];

const FORBIDDEN_CURRENT_ROUTES = [
  '/login',
  '/auth',
  '/session',
  '/token',
  '/callback',
  '/logout',
  '/oauth',
  '/sso',
  '/admin',
  '/api/packets',
  '/packets',
  '/packet',
  '/operator-packets',
] as const;

const CURRENT_STATIC_RUNTIME_ROUTES = [
  'GET /',
  'GET /healthz',
  'GET /manifest.json',
] as const;

const RETAINED_FAIL_CLOSED_RUNTIME_BEHAVIOR = [
  'static runtime route surface remains only GET /, GET /healthz, GET /manifest.json',
  'blocked auth, packet, and data paths return fixed 404 responses',
  'known routes reject unsupported methods with fixed 405 responses',
  'request bodies are ignored and never echoed',
  'raw request-target bypass forms remain fixed 404',
  'remote exposure remains blocked',
] as const;

const FORBIDDEN_IMPLEMENTATION_THIS_PHASE = [
  'auth implementation',
  'cookies',
  'sessions',
  'tokens',
  'bearer/basic parsing',
  'password parsing',
  'credential validation',
  'secret-file reads',
  'environment/config reads',
  'reverse-proxy headers',
  'TLS/mTLS',
  'public bind',
  'route handlers',
  'API framework',
  'frontend/browser JavaScript',
  'UI framework',
  'DB reads',
  'fs reads in the pure implementation',
  'network/fetch',
  'provider integration',
  'packet ingestion',
  'playback/download/scraping/media-server behavior',
  'live data access',
] as const;

const FORBIDDEN_EVIDENCE_FIELDS = [
  'secret value',
  'secret path',
  'environment variable secret value',
  'CLI argument secret value',
  'credentials',
  'tokens',
  'cookies',
  'authorization headers',
  'request paths',
  'query strings',
  'headers',
  'bodies',
  'DB URLs',
  'provider names',
  'real titles',
  'external IDs',
  'infohashes',
  'magnets',
  'raw refs',
  'packet contents',
  'artifact contents',
  'user library data',
] as const;

export function buildOperatorUiLocalAuthBoundaryReport(): OperatorUiLocalAuthBoundaryReport {
  const authContract = buildOperatorUiAuthAccessContractReport();
  const routeDryRun = buildOperatorUiPacketEndpointRouteDryRunReport();

  return {
    ok: true,
    code: 'OPERATOR_UI_LOCAL_AUTH_BOUNDARY_REPORTED',
    message: 'Operator UI local auth boundary selection is blocked, contract-only, and not implemented.',
    reportName: 'operator-ui-local-auth-boundary',
    reportVersion: 'phase-79.v1',
    status: {
      overall: 'blocked',
      phase: 'auth-boundary-selection-only',
      authImplementation: 'not-implemented',
    },
    selectedFutureBoundary: 'local-operator-secret-file-with-explicit-path-and-redacted-evidence',
    selectedBoundaryStatus: 'selected-for-future-review/not-implemented',
    rejectedBoundaryOptions: {
      'reverse-proxy-forward-auth-attestation': 'rejected-for-first-implementation',
      'mTLS-or-local-network-attestation': 'rejected-for-first-implementation',
      'browser-cookie-session': 'rejected-for-first-implementation',
      'bearer-token-api': 'rejected-for-first-implementation',
    },
    currentRuntimeExposure: '127.0.0.1 fixture preview only',
    remoteExposure: 'blocked',
    phase74AuthContract: {
      reportName: authContract.contractName,
      reportVersion: authContract.contractVersion,
      code: authContract.code,
      phase: authContract.status.phase,
      implementation: authContract.status.implementation,
    },
    phase75Readiness: {
      reportName: routeDryRun.phase75Readiness.reportName,
      reportVersion: routeDryRun.phase75Readiness.reportVersion,
      code: routeDryRun.phase75Readiness.code,
      status: routeDryRun.phase75Readiness.status,
    },
    phase76Limits: {
      reportName: routeDryRun.phase76Limits.reportName,
      reportVersion: routeDryRun.phase76Limits.reportVersion,
      code: routeDryRun.phase76Limits.code,
      phase: routeDryRun.phase76Limits.phase,
      implementation: routeDryRun.phase76Limits.implementation,
    },
    phase77EvidenceGate: {
      reportName: routeDryRun.phase77EvidenceGate.reportName,
      reportVersion: routeDryRun.phase77EvidenceGate.reportVersion,
      code: routeDryRun.phase77EvidenceGate.code,
      status: routeDryRun.phase77EvidenceGate.status,
      phase: routeDryRun.phase77EvidenceGate.phase,
    },
    phase78RouteDryRun: {
      reportName: routeDryRun.reportName,
      reportVersion: routeDryRun.reportVersion,
      code: routeDryRun.code,
      status: routeDryRun.status.overall,
      phase: routeDryRun.status.phase,
    },
    selectedBoundary: {
      id: 'local-operator-secret-file-with-explicit-path-and-redacted-evidence',
      status: 'selected-for-future-review/not-implemented',
      reason: 'Selected as the first future boundary because it keeps operator auth local, explicit, redaction-safe, and reviewable without browser session state or remote trust.',
      futureRequirements: [...FUTURE_REQUIREMENTS],
      forbiddenNow: [...FORBIDDEN_NOW],
    },
    rejectedBoundaries: REJECTED_BOUNDARIES.map((boundary) => ({ ...boundary })),
    futureImplementationGates: FUTURE_IMPLEMENTATION_GATES.map((gate) => ({ ...gate })),
    forbiddenCurrentRoutes: [...FORBIDDEN_CURRENT_ROUTES],
    currentStaticRuntimeRoutes: [...CURRENT_STATIC_RUNTIME_ROUTES],
    retainedFailClosedRuntimeBehavior: [...RETAINED_FAIL_CLOSED_RUNTIME_BEHAVIOR],
    forbiddenImplementationThisPhase: [...FORBIDDEN_IMPLEMENTATION_THIS_PHASE],
    forbiddenEvidenceFields: [...FORBIDDEN_EVIDENCE_FIELDS],
  };
}

export function formatOperatorUiLocalAuthBoundaryText(
  report: OperatorUiLocalAuthBoundaryReport = buildOperatorUiLocalAuthBoundaryReport(),
): string {
  const lines = [
    'Operator UI Local Auth Boundary Selection',
    `code: ${report.code}`,
    `report: ${report.reportName}`,
    `version: ${report.reportVersion}`,
    `status: ${report.status.overall} / ${report.status.phase}`,
    `auth implementation: ${report.status.authImplementation}`,
    `selected future boundary: ${report.selectedFutureBoundary}`,
    `selected boundary status: ${report.selectedBoundaryStatus}`,
    `current runtime exposure: ${report.currentRuntimeExposure}`,
    `remote exposure: ${report.remoteExposure}`,
    `phase 74 auth contract: ${report.phase74AuthContract.phase} / ${report.phase74AuthContract.implementation}`,
    `phase 75 readiness: ${report.phase75Readiness.status}`,
    `phase 76 limits: ${report.phase76Limits.phase} / ${report.phase76Limits.implementation}`,
    `phase 77 evidence gate: ${report.phase77EvidenceGate.status} / ${report.phase77EvidenceGate.phase}`,
    `phase 78 route dry-run: ${report.phase78RouteDryRun.status} / ${report.phase78RouteDryRun.phase}`,
    '',
    'Selected boundary:',
    `- ${report.selectedBoundary.id}: ${report.selectedBoundary.status}`,
    `  reason: ${report.selectedBoundary.reason}`,
    '  future requirements:',
  ];

  for (const requirement of report.selectedBoundary.futureRequirements) lines.push(`  - ${requirement}`);

  lines.push('  forbidden now:');
  for (const item of report.selectedBoundary.forbiddenNow) lines.push(`  - ${item}`);

  lines.push('', 'Rejected boundaries:');
  for (const boundary of report.rejectedBoundaries) {
    lines.push(`- ${boundary.id}: ${boundary.status}`);
    lines.push(`  reason: ${boundary.reason}`);
  }

  lines.push('', 'Future implementation gates:');
  for (const gate of report.futureImplementationGates) {
    lines.push(`- ${gate.id}: ${gate.status}; ${gate.requirement}`);
  }

  lines.push('', 'Current static runtime routes:');
  for (const route of report.currentStaticRuntimeRoutes) lines.push(`- ${route}`);

  lines.push('', 'Forbidden current routes:');
  for (const route of report.forbiddenCurrentRoutes) lines.push(`- ${route}`);

  lines.push('', 'Retained fail-closed runtime behavior:');
  for (const behavior of report.retainedFailClosedRuntimeBehavior) lines.push(`- ${behavior}`);

  lines.push('', 'Forbidden implementation this phase:');
  for (const item of report.forbiddenImplementationThisPhase) lines.push(`- ${item}`);

  lines.push('', 'Forbidden evidence fields:');
  for (const field of report.forbiddenEvidenceFields) lines.push(`- ${field}`);

  return `${lines.join('\n')}\n`;
}
