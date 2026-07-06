import { buildOperatorUiPacketEndpointReadinessReport } from './operator-ui-packet-endpoint-readiness.js';

export type OperatorUiPacketEndpointLimitsReportName = 'operator-ui-packet-endpoint-limits';
export type OperatorUiPacketEndpointLimitsReportVersion = 'phase-76.v1';
export type OperatorUiPacketEndpointLimitsStatus = 'not-implemented';
export type OperatorUiPacketEndpointLimitsPhase = 'contract-only';
export type OperatorUiPacketEndpointMethod =
  | 'GET'
  | 'HEAD'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'OTHER';

export interface OperatorUiPacketEndpointMethodRule {
  readonly method: OperatorUiPacketEndpointMethod;
  readonly disposition: 'future-only-allowed' | 'rejected-unless-reviewed' | 'rejected';
  readonly response: string;
}

export interface OperatorUiPacketEndpointSizeLimits {
  readonly maxRequestTargetBytes: 2048;
  readonly maxHeaderCount: 64;
  readonly maxRequestBodyBytes: 0;
  readonly maxResponseBytes: 262144;
  readonly maxPacketCount: 64;
  readonly maxStringFieldBytes: 256;
  readonly maxArrayLengthPerField: 64;
}

export interface OperatorUiPacketEndpointRateLimits {
  readonly scope: 'loopback-preview-only';
  readonly maxRequestsPerMinutePerOperatorRuntimeProcess: 60;
  readonly burstSize: 10;
  readonly remoteOrIpTrust: 'none';
  readonly persistenceOrCountersImplemented: false;
}

export interface OperatorUiPacketEndpointFailureRule {
  readonly statusCode: 404 | 405 | 413 | 429;
  readonly appliesTo: string;
  readonly response: string;
}

export interface OperatorUiPacketEndpointLimitsReport {
  readonly ok: true;
  readonly code: 'OPERATOR_UI_PACKET_ENDPOINT_LIMITS_REPORTED';
  readonly message: 'Operator UI packet endpoint limits are fixed contract data only; the endpoint remains not implemented.';
  readonly reportName: OperatorUiPacketEndpointLimitsReportName;
  readonly reportVersion: OperatorUiPacketEndpointLimitsReportVersion;
  readonly status: {
    readonly overall: OperatorUiPacketEndpointLimitsStatus;
    readonly phase: OperatorUiPacketEndpointLimitsPhase;
  };
  readonly blockedEndpoint: {
    readonly id: 'sanitized-local-packet-endpoint';
    readonly status: 'not-implemented';
    readonly reason: 'endpoint, auth, runtime enforcement, counters, and evidence tests are not implemented';
  };
  readonly phase75Readiness: {
    readonly reportName: 'operator-ui-packet-endpoint-readiness';
    readonly reportVersion: 'phase-75.v1';
    readonly code: 'OPERATOR_UI_PACKET_ENDPOINT_READINESS_REPORTED';
    readonly status: 'not-ready';
    readonly requirement: 'Phase 75 readiness remains not-ready until endpoint/auth implementation and evidence tests exist';
  };
  readonly methodRules: readonly OperatorUiPacketEndpointMethodRule[];
  readonly requestBodyRule: 'request bodies are ignored/rejected and never echoed';
  readonly sizeLimits: OperatorUiPacketEndpointSizeLimits;
  readonly rateLimits: OperatorUiPacketEndpointRateLimits;
  readonly failureBehavior: readonly OperatorUiPacketEndpointFailureRule[];
  readonly neverEcho: readonly string[];
  readonly retainedHardeningRequirements: readonly string[];
  readonly forbiddenImplementationThisPhase: readonly string[];
}

const METHOD_RULES = [
  {
    method: 'GET',
    disposition: 'future-only-allowed',
    response: 'only GET may ever serve packet snapshots in the first implementation',
  },
  {
    method: 'HEAD',
    disposition: 'rejected-unless-reviewed',
    response: 'HEAD remains rejected unless explicitly reviewed',
  },
  {
    method: 'POST',
    disposition: 'rejected',
    response: 'fixed sanitized rejection',
  },
  {
    method: 'PUT',
    disposition: 'rejected',
    response: 'fixed sanitized rejection',
  },
  {
    method: 'PATCH',
    disposition: 'rejected',
    response: 'fixed sanitized rejection',
  },
  {
    method: 'DELETE',
    disposition: 'rejected',
    response: 'fixed sanitized rejection',
  },
  {
    method: 'OPTIONS',
    disposition: 'rejected',
    response: 'fixed sanitized rejection',
  },
  {
    method: 'OTHER',
    disposition: 'rejected',
    response: 'fixed sanitized rejection',
  },
] as const satisfies readonly OperatorUiPacketEndpointMethodRule[];

const SIZE_LIMITS = {
  maxRequestTargetBytes: 2048,
  maxHeaderCount: 64,
  maxRequestBodyBytes: 0,
  maxResponseBytes: 262144,
  maxPacketCount: 64,
  maxStringFieldBytes: 256,
  maxArrayLengthPerField: 64,
} as const satisfies OperatorUiPacketEndpointSizeLimits;

const RATE_LIMITS = {
  scope: 'loopback-preview-only',
  maxRequestsPerMinutePerOperatorRuntimeProcess: 60,
  burstSize: 10,
  remoteOrIpTrust: 'none',
  persistenceOrCountersImplemented: false,
} as const satisfies OperatorUiPacketEndpointRateLimits;

const FAILURE_BEHAVIOR = [
  {
    statusCode: 404,
    appliesTo: 'unknown or blocked routes before and after endpoint review',
    response: 'fixed not-found response',
  },
  {
    statusCode: 405,
    appliesTo: 'unsupported known-route methods only after endpoint exists',
    response: 'fixed method-not-allowed response with Allow: GET',
  },
  {
    statusCode: 413,
    appliesTo: 'oversized request or response cases when endpoint is later implemented',
    response: 'fixed payload-too-large response',
  },
  {
    statusCode: 429,
    appliesTo: 'future rate-limit trips',
    response: 'fixed rate-limit response',
  },
] as const satisfies readonly OperatorUiPacketEndpointFailureRule[];

const NEVER_ECHO = [
  'paths',
  'query strings',
  'headers',
  'body snippets',
  'credentials',
  'raw refs',
  'packet contents',
  'provider details',
  'DB errors',
] as const;

const RETAINED_HARDENING_REQUIREMENTS = [
  'raw target bypass closed',
  'query strings cannot create behavior',
  'safe headers retained',
  'no browser JS/framework requirement',
  'no direct DB read',
  'no provider calls',
  'no playback/download/scraping/media-server behavior',
  'no live packet ingestion',
] as const;

const FORBIDDEN_IMPLEMENTATION_THIS_PHASE = [
  'endpoint route',
  'runtime enforcement',
  'auth',
  'rate counters',
  'DB reads',
  'provider behavior',
  'UI/framework code',
] as const;

export function buildOperatorUiPacketEndpointLimitsReport(): OperatorUiPacketEndpointLimitsReport {
  const readiness = buildOperatorUiPacketEndpointReadinessReport();

  return {
    ok: true,
    code: 'OPERATOR_UI_PACKET_ENDPOINT_LIMITS_REPORTED',
    message: 'Operator UI packet endpoint limits are fixed contract data only; the endpoint remains not implemented.',
    reportName: 'operator-ui-packet-endpoint-limits',
    reportVersion: 'phase-76.v1',
    status: {
      overall: 'not-implemented',
      phase: 'contract-only',
    },
    blockedEndpoint: {
      id: 'sanitized-local-packet-endpoint',
      status: 'not-implemented',
      reason: 'endpoint, auth, runtime enforcement, counters, and evidence tests are not implemented',
    },
    phase75Readiness: {
      reportName: readiness.reportName,
      reportVersion: readiness.reportVersion,
      code: readiness.code,
      status: readiness.status.overall,
      requirement: 'Phase 75 readiness remains not-ready until endpoint/auth implementation and evidence tests exist',
    },
    methodRules: METHOD_RULES.map((rule) => ({ ...rule })),
    requestBodyRule: 'request bodies are ignored/rejected and never echoed',
    sizeLimits: { ...SIZE_LIMITS },
    rateLimits: { ...RATE_LIMITS },
    failureBehavior: FAILURE_BEHAVIOR.map((rule) => ({ ...rule })),
    neverEcho: [...NEVER_ECHO],
    retainedHardeningRequirements: [...RETAINED_HARDENING_REQUIREMENTS],
    forbiddenImplementationThisPhase: [...FORBIDDEN_IMPLEMENTATION_THIS_PHASE],
  };
}

export function formatOperatorUiPacketEndpointLimitsText(
  report: OperatorUiPacketEndpointLimitsReport = buildOperatorUiPacketEndpointLimitsReport(),
): string {
  const lines = [
    'Operator UI Packet Endpoint Limits Contract',
    `code: ${report.code}`,
    `report: ${report.reportName}`,
    `version: ${report.reportVersion}`,
    `status: ${report.status.overall} / ${report.status.phase}`,
    `blocked endpoint: ${report.blockedEndpoint.id} - ${report.blockedEndpoint.status}`,
    `blocked reason: ${report.blockedEndpoint.reason}`,
    `phase 75 readiness: ${report.phase75Readiness.status} - ${report.phase75Readiness.requirement}`,
    '',
    'Method rules:',
  ];

  for (const rule of report.methodRules) {
    lines.push(`- ${rule.method}: ${rule.disposition}; ${rule.response}`);
  }

  lines.push('', `Request body rule: ${report.requestBodyRule}`);

  lines.push('', 'Size limits:');
  for (const [key, value] of Object.entries(report.sizeLimits)) {
    lines.push(`- ${key}: ${value}`);
  }

  lines.push('', 'Rate limits:');
  for (const [key, value] of Object.entries(report.rateLimits)) {
    lines.push(`- ${key}: ${value}`);
  }

  lines.push('', 'Failure behavior:');
  for (const rule of report.failureBehavior) {
    lines.push(`- ${rule.statusCode}: ${rule.appliesTo}; ${rule.response}`);
  }

  lines.push('', 'Never echo:');
  for (const item of report.neverEcho) lines.push(`- ${item}`);

  lines.push('', 'Retained hardening requirements:');
  for (const requirement of report.retainedHardeningRequirements) lines.push(`- ${requirement}`);

  lines.push('', 'Forbidden implementation this phase:');
  for (const item of report.forbiddenImplementationThisPhase) lines.push(`- ${item}`);

  return `${lines.join('\n')}\n`;
}
