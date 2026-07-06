import { buildOperatorUiAuthAccessContractReport } from './operator-ui-auth-access-contract.js';
import { buildOperatorUiPacketSourceContractReport } from './operator-ui-packet-source-contract.js';

export type OperatorUiPacketEndpointReadinessReportName = 'operator-ui-packet-endpoint-readiness';
export type OperatorUiPacketEndpointReadinessReportVersion = 'phase-75.v1';
export type OperatorUiPacketEndpointReadinessStatus = 'not-ready';
export type OperatorUiPacketEndpointReadinessPhase = 'preflight-only';

export interface OperatorUiPacketEndpointReadinessDependencyCheck {
  readonly id:
    | 'phase-69-packet-source-contract'
    | 'phase-74-auth-access-contract'
    | 'static-runtime-route-surface'
    | 'sanitized-local-packet-endpoint'
    | 'direct-ui-db-reads'
    | 'provider-availability'
    | 'o4-o5-production-boundaries'
    | 'file-custodian-boundary';
  readonly status:
    | 'contract-present/endpoint-not-implemented'
    | 'contract-present/auth-not-implemented'
    | 'fixed-route-surface-only'
    | 'blocked/not-implemented'
    | 'forbidden'
    | 'packet-count-advisory-only'
    | 'open-deferred-unless-separately-proven'
    | 'reference-harness-only';
  readonly evidence: string;
  readonly requiredBeforeEndpoint: boolean;
}

export interface OperatorUiPacketEndpointReadinessReport {
  readonly ok: true;
  readonly code: 'OPERATOR_UI_PACKET_ENDPOINT_READINESS_REPORTED';
  readonly message: 'Operator UI packet endpoint readiness preflight is fixed, static, no-input, and not-ready.';
  readonly reportName: OperatorUiPacketEndpointReadinessReportName;
  readonly reportVersion: OperatorUiPacketEndpointReadinessReportVersion;
  readonly status: {
    readonly overall: OperatorUiPacketEndpointReadinessStatus;
    readonly phase: OperatorUiPacketEndpointReadinessPhase;
  };
  readonly blockedEndpoint: {
    readonly id: 'sanitized-local-packet-endpoint';
    readonly status: 'blocked/not-implemented';
    readonly reason: 'endpoint and runtime auth are not implemented';
  };
  readonly dependencyChecks: readonly OperatorUiPacketEndpointReadinessDependencyCheck[];
  readonly staticRuntimeRouteSurface: readonly string[];
  readonly futureImplementationPrerequisites: readonly string[];
  readonly forbiddenRoutesNow: readonly string[];
  readonly forbiddenRuntimeAdditionsNow: readonly string[];
  readonly forbiddenDataCategories: readonly string[];
  readonly retainedHardeningRequirements: readonly string[];
  readonly openBoundaries: readonly string[];
}

const STATIC_RUNTIME_ROUTE_SURFACE = [
  'GET /',
  'GET /healthz',
  'GET /manifest.json',
] as const;

const FUTURE_IMPLEMENTATION_PREREQUISITES = [
  'explicit Clint authorization and reviewer GO',
  'auth/access implementation phase completed and reviewed',
  'endpoint source must consume only sanitized redaction-safe operator packets',
  'no real titles, external IDs, provider names/logos, raw refs, infohashes, magnets, credentials, paths, artwork, user library data, or raw event payloads',
  'no provider calls, playback/download/scraping/media-server logic, direct DB access, or live packet ingestion',
  'route/method/body/raw-target hardening retained',
  'size/rate bounds defined before endpoint exists',
  'evidence/redaction tests added before any endpoint route is exposed',
] as const;

const FORBIDDEN_ROUTES_NOW = [
  '/api/*',
  '/packets',
  '/packet',
  '/operator-packets',
  '/data',
  '/events',
  '/catalog',
  '/items',
  '/auth',
  '/login',
  '/session',
  '/token',
  '/callback',
  '/logout',
  '/oauth',
  '/sso',
  '/admin',
] as const;

const FORBIDDEN_RUNTIME_ADDITIONS_NOW = [
  'route handlers',
  'API framework',
  'DB/env/fs reads',
  'fetch/network calls',
  'provider integration',
  'browser JS/framework',
  'cookies/sessions/tokens',
  'provider calls, playback/download/scraping/media-server logic',
] as const;

const FORBIDDEN_DATA_CATEGORIES = [
  'real titles',
  'external IDs',
  'provider names/logos',
  'raw refs',
  'infohashes',
  'magnets',
  'credentials',
  'paths',
  'artwork',
  'user library data',
  'raw event payloads',
] as const;

const RETAINED_HARDENING_REQUIREMENTS = [
  'static runtime route surface remains only GET /, GET /healthz, GET /manifest.json',
  'blocked packet/data/auth paths return fixed 404 responses',
  'known routes reject unsupported methods with fixed 405 responses',
  'request bodies are ignored and never echoed',
  'raw request-target bypass forms remain fixed 404',
] as const;

const OPEN_BOUNDARIES = [
  'O4 remains open/deferred unless separately proven',
  'O5 remains open/deferred unless separately proven',
  'FileCustodian remains a hardened reference harness only',
  'Provider availability remains packet/count/advisory only',
] as const;

function buildDependencyChecks(): OperatorUiPacketEndpointReadinessDependencyCheck[] {
  const packetSource = buildOperatorUiPacketSourceContractReport();
  const authAccess = buildOperatorUiAuthAccessContractReport();
  const endpointSource = packetSource.allowedFutureSources.find(
    (sourceOption) => sourceOption.id === 'sanitized-local-packet-endpoint',
  );

  return [
    {
      id: 'phase-69-packet-source-contract',
      status: 'contract-present/endpoint-not-implemented',
      evidence: `Phase 69 packet source contract exists (${packetSource.code}); sanitized local packet endpoint remains ${endpointSource?.status ?? 'not-implemented'}.`,
      requiredBeforeEndpoint: true,
    },
    {
      id: 'phase-74-auth-access-contract',
      status: 'contract-present/auth-not-implemented',
      evidence: `Phase 74 auth/access contract exists (${authAccess.code}); auth implementation remains ${authAccess.status.implementation}.`,
      requiredBeforeEndpoint: true,
    },
    {
      id: 'static-runtime-route-surface',
      status: 'fixed-route-surface-only',
      evidence: 'Static runtime route surface remains only GET /, GET /healthz, GET /manifest.json.',
      requiredBeforeEndpoint: true,
    },
    {
      id: 'sanitized-local-packet-endpoint',
      status: 'blocked/not-implemented',
      evidence: 'Sanitized local packet endpoint remains blocked.',
      requiredBeforeEndpoint: true,
    },
    {
      id: 'direct-ui-db-reads',
      status: 'forbidden',
      evidence: 'Direct UI DB reads remain forbidden.',
      requiredBeforeEndpoint: true,
    },
    {
      id: 'provider-availability',
      status: 'packet-count-advisory-only',
      evidence: 'Provider availability remains packet/count/advisory only.',
      requiredBeforeEndpoint: true,
    },
    {
      id: 'o4-o5-production-boundaries',
      status: 'open-deferred-unless-separately-proven',
      evidence: 'O4/O5 remain open/deferred unless separately proven.',
      requiredBeforeEndpoint: true,
    },
    {
      id: 'file-custodian-boundary',
      status: 'reference-harness-only',
      evidence: 'FileCustodian remains reference harness only.',
      requiredBeforeEndpoint: true,
    },
  ];
}

export function buildOperatorUiPacketEndpointReadinessReport(): OperatorUiPacketEndpointReadinessReport {
  return {
    ok: true,
    code: 'OPERATOR_UI_PACKET_ENDPOINT_READINESS_REPORTED',
    message: 'Operator UI packet endpoint readiness preflight is fixed, static, no-input, and not-ready.',
    reportName: 'operator-ui-packet-endpoint-readiness',
    reportVersion: 'phase-75.v1',
    status: {
      overall: 'not-ready',
      phase: 'preflight-only',
    },
    blockedEndpoint: {
      id: 'sanitized-local-packet-endpoint',
      status: 'blocked/not-implemented',
      reason: 'endpoint and runtime auth are not implemented',
    },
    dependencyChecks: buildDependencyChecks().map((check) => ({ ...check })),
    staticRuntimeRouteSurface: [...STATIC_RUNTIME_ROUTE_SURFACE],
    futureImplementationPrerequisites: [...FUTURE_IMPLEMENTATION_PREREQUISITES],
    forbiddenRoutesNow: [...FORBIDDEN_ROUTES_NOW],
    forbiddenRuntimeAdditionsNow: [...FORBIDDEN_RUNTIME_ADDITIONS_NOW],
    forbiddenDataCategories: [...FORBIDDEN_DATA_CATEGORIES],
    retainedHardeningRequirements: [...RETAINED_HARDENING_REQUIREMENTS],
    openBoundaries: [...OPEN_BOUNDARIES],
  };
}

export function formatOperatorUiPacketEndpointReadinessText(
  report: OperatorUiPacketEndpointReadinessReport = buildOperatorUiPacketEndpointReadinessReport(),
): string {
  const lines = [
    'Operator UI Packet Endpoint Readiness Preflight',
    `code: ${report.code}`,
    `report: ${report.reportName}`,
    `version: ${report.reportVersion}`,
    `status: ${report.status.overall} / ${report.status.phase}`,
    `blocked endpoint: ${report.blockedEndpoint.id} - ${report.blockedEndpoint.status}`,
    `blocked reason: ${report.blockedEndpoint.reason}`,
    '',
    'Dependency checks:',
  ];

  for (const check of report.dependencyChecks) {
    lines.push(`- ${check.id}: ${check.status}`);
    lines.push(`  evidence: ${check.evidence}`);
  }

  lines.push('', 'Static runtime route surface:');
  for (const route of report.staticRuntimeRouteSurface) lines.push(`- ${route}`);

  lines.push('', 'Future implementation prerequisites:');
  for (const prerequisite of report.futureImplementationPrerequisites) lines.push(`- ${prerequisite}`);

  lines.push('', 'Forbidden routes now:');
  for (const route of report.forbiddenRoutesNow) lines.push(`- ${route}`);

  lines.push('', 'Forbidden runtime additions now:');
  for (const addition of report.forbiddenRuntimeAdditionsNow) lines.push(`- ${addition}`);

  lines.push('', 'Forbidden data categories:');
  for (const category of report.forbiddenDataCategories) lines.push(`- ${category}`);

  lines.push('', 'Retained hardening requirements:');
  for (const requirement of report.retainedHardeningRequirements) lines.push(`- ${requirement}`);

  lines.push('', 'Open boundaries:');
  for (const boundary of report.openBoundaries) lines.push(`- ${boundary}`);

  return `${lines.join('\n')}\n`;
}
