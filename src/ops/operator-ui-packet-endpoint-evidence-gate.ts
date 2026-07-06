import { buildOperatorUiPacketEndpointLimitsReport } from './operator-ui-packet-endpoint-limits.js';
import { buildOperatorUiPacketEndpointReadinessReport } from './operator-ui-packet-endpoint-readiness.js';

export type OperatorUiPacketEndpointEvidenceGateReportName = 'operator-ui-packet-endpoint-evidence-gate';
export type OperatorUiPacketEndpointEvidenceGateReportVersion = 'phase-77.v1';
export type OperatorUiPacketEndpointEvidenceGateStatus = 'blocked';
export type OperatorUiPacketEndpointEvidenceGatePhase = 'evidence-required';

export interface OperatorUiPacketEndpointEvidencePrerequisite {
  readonly id:
    | 'static-route-surface-regression-evidence'
    | 'auth-access-contract-evidence'
    | 'phase-76-limits-enforcement-evidence'
    | 'method-rejection-evidence'
    | 'failure-redaction-evidence'
    | 'packet-source-evidence'
    | 'redaction-evidence'
    | 'no-live-data-evidence'
    | 'endpoint-test-evidence'
    | 'independent-reviewer-go-evidence'
    | 'operator-acceptance-evidence';
  readonly status: 'required-before-endpoint-exposure';
  readonly requirement: string;
  readonly evidenceKind: string;
  readonly sourcePhase: string;
}

export interface OperatorUiPacketEndpointEvidenceGateReport {
  readonly ok: true;
  readonly code: 'OPERATOR_UI_PACKET_ENDPOINT_EVIDENCE_GATE_REPORTED';
  readonly message: 'Operator UI packet endpoint evidence gate is blocked until all future exposure evidence is reviewed.';
  readonly reportName: OperatorUiPacketEndpointEvidenceGateReportName;
  readonly reportVersion: OperatorUiPacketEndpointEvidenceGateReportVersion;
  readonly status: {
    readonly overall: OperatorUiPacketEndpointEvidenceGateStatus;
    readonly phase: OperatorUiPacketEndpointEvidenceGatePhase;
  };
  readonly endpointExposure: {
    readonly status: 'blocked';
    readonly implementation: 'not-implemented';
    readonly endpointId: 'sanitized-local-packet-endpoint';
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
  readonly immutablePrerequisites: readonly OperatorUiPacketEndpointEvidencePrerequisite[];
  readonly blockers: readonly string[];
  readonly allowedFutureEvidenceArtifactLabels: readonly string[];
  readonly forbiddenEvidenceFields: readonly string[];
  readonly futureTestMatrixLabels: readonly string[];
  readonly retainedBoundaries: readonly string[];
}

const IMMUTABLE_PREREQUISITES = [
  {
    id: 'static-route-surface-regression-evidence',
    status: 'required-before-endpoint-exposure',
    requirement: 'static runtime route-surface regression evidence proves only GET /, GET /healthz, and GET /manifest.json exist before implementation',
    evidenceKind: 'route-surface-regression',
    sourcePhase: 'phase-72-through-phase-77',
  },
  {
    id: 'auth-access-contract-evidence',
    status: 'required-before-endpoint-exposure',
    requirement: 'no packet endpoint until a reviewed local operator auth boundary exists',
    evidenceKind: 'auth-access-review',
    sourcePhase: 'phase-74',
  },
  {
    id: 'phase-76-limits-enforcement-evidence',
    status: 'required-before-endpoint-exposure',
    requirement: 'request target, header, body, response, packet, string, and array limits from Phase 76 must be enforced and tested in the future implementation',
    evidenceKind: 'limits-enforcement-tests',
    sourcePhase: 'phase-76',
  },
  {
    id: 'method-rejection-evidence',
    status: 'required-before-endpoint-exposure',
    requirement: 'GET-only initial endpoint; HEAD rejected unless explicitly reviewed; POST, PUT, PATCH, DELETE, OPTIONS, and OTHER receive fixed sanitized rejections',
    evidenceKind: 'method-matrix-tests',
    sourcePhase: 'phase-76',
  },
  {
    id: 'failure-redaction-evidence',
    status: 'required-before-endpoint-exposure',
    requirement: 'fixed 404, 405, 413, and 429 failures with no echo of request or private content',
    evidenceKind: 'failure-redaction-tests',
    sourcePhase: 'phase-76',
  },
  {
    id: 'packet-source-evidence',
    status: 'required-before-endpoint-exposure',
    requirement: 'only a sanitized future packet producer may feed the endpoint; direct DB, provider, or raw-ref sources are forbidden',
    evidenceKind: 'source-boundary-review',
    sourcePhase: 'phase-69',
  },
  {
    id: 'redaction-evidence',
    status: 'required-before-endpoint-exposure',
    requirement: 'logs, evidence, and errors use synthetic labels only and exclude private identity or endpoint payload content',
    evidenceKind: 'redaction-sentinel-tests',
    sourcePhase: 'phase-77',
  },
  {
    id: 'no-live-data-evidence',
    status: 'required-before-endpoint-exposure',
    requirement: 'fixtures and synthetic packets only until an explicit later phase authorizes live packet ingestion',
    evidenceKind: 'synthetic-fixture-attestation',
    sourcePhase: 'phase-77',
  },
  {
    id: 'endpoint-test-evidence',
    status: 'required-before-endpoint-exposure',
    requirement: 'focused endpoint tests exist before route exposure, including oversized target, header, body, response, method rejection, blocked route, raw-target bypass, and redaction sentinel cases',
    evidenceKind: 'endpoint-test-matrix',
    sourcePhase: 'phase-77',
  },
  {
    id: 'independent-reviewer-go-evidence',
    status: 'required-before-endpoint-exposure',
    requirement: 'independent reviewer GO is recorded before endpoint exposure',
    evidenceKind: 'reviewer-go-record',
    sourcePhase: 'future-reviewed-phase',
  },
  {
    id: 'operator-acceptance-evidence',
    status: 'required-before-endpoint-exposure',
    requirement: 'redaction-safe operator packet and review record are accepted before endpoint exposure',
    evidenceKind: 'operator-acceptance-record',
    sourcePhase: 'future-reviewed-phase',
  },
] as const satisfies readonly OperatorUiPacketEndpointEvidencePrerequisite[];

const BLOCKERS = [
  'endpoint exposure remains blocked because required evidence artifacts do not exist',
  'endpoint implementation remains not-implemented',
  'Phase 75 readiness remains not-ready',
  'Phase 76 limits remain contract-only and not implemented',
  'reviewed local operator auth boundary does not exist',
  'independent reviewer GO does not exist',
  'operator acceptance record does not exist',
] as const;

const ALLOWED_FUTURE_EVIDENCE_ARTIFACT_LABELS = [
  'static-route-surface-regression-report',
  'local-operator-auth-boundary-review',
  'phase-76-limits-enforcement-test-report',
  'method-rejection-matrix-report',
  'failure-redaction-sentinel-report',
  'sanitized-packet-source-boundary-review',
  'synthetic-fixture-only-attestation',
  'endpoint-redaction-sentinel-test-report',
  'independent-reviewer-go-record',
  'operator-acceptance-record',
] as const;

const FORBIDDEN_EVIDENCE_FIELDS = [
  'titles',
  'external IDs',
  'provider names/logos',
  'raw refs',
  'infohashes',
  'magnets',
  'URLs',
  'credentials',
  'tokens',
  'cookies',
  'DB URLs',
  'DB errors',
  'request paths',
  'query strings',
  'headers',
  'bodies',
  'packet contents',
  'artifact contents',
] as const;

const FUTURE_TEST_MATRIX_LABELS = [
  'oversized-request-target',
  'oversized-header-count',
  'request-body-rejected',
  'oversized-response-blocked',
  'packet-count-limit-enforced',
  'string-field-limit-enforced',
  'array-field-limit-enforced',
  'get-only-success-path',
  'head-rejected-unless-reviewed',
  'method-rejection',
  'unsafe-method-fixed-rejection',
  'blocked-route-fixed-404',
  'raw-target-bypass-fixed-404',
  'redaction-sentinel-no-echo',
  'rate-limit-fixed-429',
] as const;

const RETAINED_BOUNDARIES = [
  'static runtime route surface remains only GET /, GET /healthz, GET /manifest.json',
  'Phase 75 readiness remains not-ready',
  'Phase 76 limits remain contract-only and not-implemented',
  'O4 remains open/deferred',
  'O5 remains open/deferred',
  'FileCustodian remains a hardened reference harness only',
  'Provider availability remains packet/count/advisory only',
  'no endpoint route handler',
  'no runtime auth implementation',
  'no API framework',
  'no DB/env/fs reads',
  'no network calls',
  'no provider integration',
  'no frontend or browser JavaScript',
  'no packet ingestion',
  'no playback/download/scraping/media-server behavior',
] as const;

export function buildOperatorUiPacketEndpointEvidenceGateReport(): OperatorUiPacketEndpointEvidenceGateReport {
  const readiness = buildOperatorUiPacketEndpointReadinessReport();
  const limits = buildOperatorUiPacketEndpointLimitsReport();

  return {
    ok: true,
    code: 'OPERATOR_UI_PACKET_ENDPOINT_EVIDENCE_GATE_REPORTED',
    message: 'Operator UI packet endpoint evidence gate is blocked until all future exposure evidence is reviewed.',
    reportName: 'operator-ui-packet-endpoint-evidence-gate',
    reportVersion: 'phase-77.v1',
    status: {
      overall: 'blocked',
      phase: 'evidence-required',
    },
    endpointExposure: {
      status: 'blocked',
      implementation: 'not-implemented',
      endpointId: 'sanitized-local-packet-endpoint',
    },
    phase75Readiness: {
      reportName: readiness.reportName,
      reportVersion: readiness.reportVersion,
      code: readiness.code,
      status: readiness.status.overall,
    },
    phase76Limits: {
      reportName: limits.reportName,
      reportVersion: limits.reportVersion,
      code: limits.code,
      phase: limits.status.phase,
      implementation: limits.status.overall,
    },
    immutablePrerequisites: IMMUTABLE_PREREQUISITES.map((prerequisite) => ({ ...prerequisite })),
    blockers: [...BLOCKERS],
    allowedFutureEvidenceArtifactLabels: [...ALLOWED_FUTURE_EVIDENCE_ARTIFACT_LABELS],
    forbiddenEvidenceFields: [...FORBIDDEN_EVIDENCE_FIELDS],
    futureTestMatrixLabels: [...FUTURE_TEST_MATRIX_LABELS],
    retainedBoundaries: [...RETAINED_BOUNDARIES],
  };
}

export function formatOperatorUiPacketEndpointEvidenceGateText(
  report: OperatorUiPacketEndpointEvidenceGateReport = buildOperatorUiPacketEndpointEvidenceGateReport(),
): string {
  const lines = [
    'Operator UI Packet Endpoint Evidence Gate',
    `code: ${report.code}`,
    `report: ${report.reportName}`,
    `version: ${report.reportVersion}`,
    `status: ${report.status.overall} / ${report.status.phase}`,
    `endpoint exposure: ${report.endpointExposure.status} / ${report.endpointExposure.implementation}`,
    `phase 75 readiness: ${report.phase75Readiness.status}`,
    `phase 76 limits: ${report.phase76Limits.phase} / ${report.phase76Limits.implementation}`,
    '',
    'Immutable prerequisites:',
  ];

  for (const prerequisite of report.immutablePrerequisites) {
    lines.push(`- ${prerequisite.id}: ${prerequisite.status}`);
    lines.push(`  requirement: ${prerequisite.requirement}`);
    lines.push(`  evidence: ${prerequisite.evidenceKind} (${prerequisite.sourcePhase})`);
  }

  lines.push('', 'Blockers:');
  for (const blocker of report.blockers) lines.push(`- ${blocker}`);

  lines.push('', 'Allowed future evidence artifact labels:');
  for (const label of report.allowedFutureEvidenceArtifactLabels) lines.push(`- ${label}`);

  lines.push('', 'Forbidden evidence fields:');
  for (const field of report.forbiddenEvidenceFields) lines.push(`- ${field}`);

  lines.push('', 'Future test matrix labels:');
  for (const label of report.futureTestMatrixLabels) lines.push(`- ${label}`);

  lines.push('', 'Retained boundaries:');
  for (const boundary of report.retainedBoundaries) lines.push(`- ${boundary}`);

  return `${lines.join('\n')}\n`;
}
