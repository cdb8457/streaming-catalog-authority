export type OperatorUiAuthAccessContractName = 'operator-ui-auth-access-contract';
export type OperatorUiAuthAccessContractVersion = 'phase-74.v1';
export type OperatorUiAuthAccessContractStatus = 'not-implemented' | 'contract-only';
export type OperatorUiFutureAuthMechanismStatus = 'future-review-only/not-implemented';

export interface OperatorUiFutureAuthMechanism {
  readonly id:
    | 'operator-local-secret-file'
    | 'reverse-proxy-forward-auth-attestation'
    | 'mTLS-or-local-network-attestation';
  readonly status: OperatorUiFutureAuthMechanismStatus;
  readonly boundary: string;
}

export interface OperatorUiAuthAccessContractReport {
  readonly ok: true;
  readonly code: 'OPERATOR_UI_AUTH_ACCESS_CONTRACT_REPORTED';
  readonly message: 'Operator UI auth/access contract is fixed, contract-only, and no-input.';
  readonly contractName: OperatorUiAuthAccessContractName;
  readonly contractVersion: OperatorUiAuthAccessContractVersion;
  readonly status: {
    readonly implementation: 'not-implemented';
    readonly phase: 'contract-only';
  };
  readonly runtimeExposureAllowedNow: '127.0.0.1 fixture preview only';
  readonly remoteExposure: 'blocked until explicit future phase';
  readonly futureAuthMechanisms: readonly OperatorUiFutureAuthMechanism[];
  readonly hardRequirementsBeforePacketOrDataRoute: readonly string[];
  readonly forbiddenRoutesUntilLaterPhase: readonly string[];
  readonly forbiddenRuntimeBehaviorUntilLaterPhase: readonly string[];
  readonly retainedFailClosedRuntimeBehavior: readonly string[];
  readonly openBoundaries: readonly string[];
}

const FUTURE_AUTH_MECHANISMS = [
  {
    id: 'operator-local-secret-file',
    status: 'future-review-only/not-implemented',
    boundary: 'Candidate category only; no secret file path, read, parsing, or validation is implemented.',
  },
  {
    id: 'reverse-proxy-forward-auth-attestation',
    status: 'future-review-only/not-implemented',
    boundary: 'Candidate category only; no reverse-proxy header, TLS, public bind, or proxy support is implemented.',
  },
  {
    id: 'mTLS-or-local-network-attestation',
    status: 'future-review-only/not-implemented',
    boundary: 'Candidate category only; no certificate, socket, TLS, or network attestation code is implemented.',
  },
] as const satisfies readonly OperatorUiFutureAuthMechanism[];

const HARD_REQUIREMENTS_BEFORE_PACKET_OR_DATA_ROUTE = [
  'Explicit Clint authorization and independent reviewer GO are required',
  'No public bind without a reviewed deployment/auth model',
  'No direct DB reads from UI runtime',
  'Sanitized packet source only after Phase 69 contract and auth/access review',
  'All operator-facing outputs must be redaction-safe',
  'No credentials/tokens/cookies/session values in logs, docs, or evidence',
  'Rate, size, method, and raw-target fail-closed behavior must be retained',
  'O4 and O5 remain open unless separately proven',
  'FileCustodian remains a hardened reference harness only',
] as const;

const FORBIDDEN_ROUTES_UNTIL_LATER_PHASE = [
  '/api/*',
  '/packets',
  '/login',
  '/session',
  '/auth',
  '/token',
  '/callback',
  '/logout',
  '/oauth',
  '/sso',
  '/admin',
] as const;

const FORBIDDEN_RUNTIME_BEHAVIOR_UNTIL_LATER_PHASE = [
  'runtime cookie/session/token/bearer/basic parsing',
  'environment/config/file secret reads',
  'TLS, reverse-proxy, or public-bind implementation',
  'frontend framework or browser JavaScript',
  'direct DB reads, provider calls, packet source, playback, download, scraping, or media-server logic',
] as const;

const RETAINED_FAIL_CLOSED_RUNTIME_BEHAVIOR = [
  'Runtime route surface remains only GET /, GET /healthz, and GET /manifest.json',
  'Blocked auth/data paths return fixed 404 responses',
  'Known routes reject unsupported methods with fixed 405 responses',
  'Request bodies are ignored and never echoed',
  'Raw request-target bypass forms remain fixed 404',
] as const;

const OPEN_BOUNDARIES = [
  'Remote exposure remains blocked until explicit future phase',
  'Provider availability remains packet/count/advisory only',
  'O4 production custodian is open/deferred',
  'O5 managed KEK custody/scheduling is open/deferred',
  'FileCustodian remains a hardened reference harness, not production KMS',
] as const;

export function buildOperatorUiAuthAccessContractReport(): OperatorUiAuthAccessContractReport {
  return {
    ok: true,
    code: 'OPERATOR_UI_AUTH_ACCESS_CONTRACT_REPORTED',
    message: 'Operator UI auth/access contract is fixed, contract-only, and no-input.',
    contractName: 'operator-ui-auth-access-contract',
    contractVersion: 'phase-74.v1',
    status: {
      implementation: 'not-implemented',
      phase: 'contract-only',
    },
    runtimeExposureAllowedNow: '127.0.0.1 fixture preview only',
    remoteExposure: 'blocked until explicit future phase',
    futureAuthMechanisms: FUTURE_AUTH_MECHANISMS.map((mechanism) => ({ ...mechanism })),
    hardRequirementsBeforePacketOrDataRoute: [...HARD_REQUIREMENTS_BEFORE_PACKET_OR_DATA_ROUTE],
    forbiddenRoutesUntilLaterPhase: [...FORBIDDEN_ROUTES_UNTIL_LATER_PHASE],
    forbiddenRuntimeBehaviorUntilLaterPhase: [...FORBIDDEN_RUNTIME_BEHAVIOR_UNTIL_LATER_PHASE],
    retainedFailClosedRuntimeBehavior: [...RETAINED_FAIL_CLOSED_RUNTIME_BEHAVIOR],
    openBoundaries: [...OPEN_BOUNDARIES],
  };
}

export function formatOperatorUiAuthAccessContractText(
  report: OperatorUiAuthAccessContractReport = buildOperatorUiAuthAccessContractReport(),
): string {
  const lines = [
    'Operator UI Auth/Access Contract Gate',
    `code: ${report.code}`,
    `contract: ${report.contractName}`,
    `version: ${report.contractVersion}`,
    `implementation: ${report.status.implementation}`,
    `phase: ${report.status.phase}`,
    `runtime exposure allowed now: ${report.runtimeExposureAllowedNow}`,
    `remote exposure: ${report.remoteExposure}`,
    '',
    'Future auth mechanisms:',
  ];

  for (const mechanism of report.futureAuthMechanisms) {
    lines.push(`- ${mechanism.id}: ${mechanism.status}`);
    lines.push(`  boundary: ${mechanism.boundary}`);
  }

  lines.push('', 'Hard requirements before packet or data routes:');
  for (const requirement of report.hardRequirementsBeforePacketOrDataRoute) lines.push(`- ${requirement}`);

  lines.push('', 'Forbidden routes until later phase:');
  for (const route of report.forbiddenRoutesUntilLaterPhase) lines.push(`- ${route}`);

  lines.push('', 'Forbidden runtime behavior until later phase:');
  for (const behavior of report.forbiddenRuntimeBehaviorUntilLaterPhase) lines.push(`- ${behavior}`);

  lines.push('', 'Retained fail-closed runtime behavior:');
  for (const behavior of report.retainedFailClosedRuntimeBehavior) lines.push(`- ${behavior}`);

  lines.push('', 'Open boundaries:');
  for (const boundary of report.openBoundaries) lines.push(`- ${boundary}`);

  return `${lines.join('\n')}\n`;
}
