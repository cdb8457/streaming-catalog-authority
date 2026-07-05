export type OperatorUiRuntimeSurfaceId = 'static-preview' | 'local-readonly-runtime' | 'live-product';
export type OperatorUiRuntimeSurfaceStatus = 'ready' | 'blocked/deferred' | 'not-ready';
export type OperatorUiRuntimeControlStatus = 'required/not-implemented' | 'active-static-only';

export interface OperatorUiRuntimeBoundarySurface {
  readonly id: OperatorUiRuntimeSurfaceId;
  readonly status: OperatorUiRuntimeSurfaceStatus;
  readonly summary: string;
}

export interface OperatorUiRuntimeBoundaryControl {
  readonly id: string;
  readonly status: OperatorUiRuntimeControlStatus;
  readonly requirement: string;
}

export interface OperatorUiRuntimeBoundaryReport {
  readonly ok: true;
  readonly code: 'OPERATOR_UI_RUNTIME_BOUNDARY_REPORTED';
  readonly message: 'Operator UI runtime boundary is fixed, synthetic, and no-input.';
  readonly source: 'fixed-synthetic-runtime-boundary';
  readonly surfaces: readonly OperatorUiRuntimeBoundarySurface[];
  readonly requiredFutureControls: readonly OperatorUiRuntimeBoundaryControl[];
  readonly blockedUntil: readonly string[];
  readonly boundaries: readonly string[];
  readonly deferredProductionItems: readonly string[];
}

const SURFACES = [
  {
    id: 'static-preview',
    status: 'ready',
    summary: 'Static preview remains the only ready operator surface.',
  },
  {
    id: 'local-readonly-runtime',
    status: 'blocked/deferred',
    summary: 'Local read-only runtime remains blocked until packet source, access, auth, and runtime designs are satisfied.',
  },
  {
    id: 'live-product',
    status: 'not-ready',
    summary: 'Live product launch remains not ready pending security, custody, runtime, and production gates.',
  },
] as const satisfies readonly OperatorUiRuntimeBoundarySurface[];

const REQUIRED_FUTURE_CONTROLS = [
  {
    id: 'local-bind-access-posture',
    status: 'required/not-implemented',
    requirement: 'Future local-only bind/access posture is required; no bind/listener is implemented now.',
  },
  {
    id: 'operator-access-auth-boundary',
    status: 'required/not-implemented',
    requirement: 'Operator access/auth boundary is required before any local runtime exists.',
  },
  {
    id: 'packet-source-only',
    status: 'required/not-implemented',
    requirement: 'Future UI may consume only a read-only packet endpoint/source; direct UI DB access is forbidden.',
  },
  {
    id: 'no-provider-or-media-control',
    status: 'required/not-implemented',
    requirement: 'Provider execution and media-control/retrieval controls are forbidden for this boundary.',
  },
  {
    id: 'static-preview-only-ready-surface',
    status: 'active-static-only',
    requirement: 'Static preview remains the only ready surface.',
  },
] as const satisfies readonly OperatorUiRuntimeBoundaryControl[];

const BLOCKED_UNTIL = [
  'Phase 69 packet source contract is satisfied',
  'Sanitized packet source design is satisfied',
  'Operator access/auth boundary design is satisfied',
  'Local runtime design is separately authorized and reviewed',
] as const;

const BOUNDARIES = [
  'No live UI/API/runtime is implemented or authorized',
  'No local listener, route, runtime endpoint, DB read, local state read, packet ingestion, or provider execution is implemented',
  'Static preview remains fixture-only and redaction-safe',
  'Phase 64 render allowlist remains intact',
  'Phase 65 static artifact packaging remains intact',
  'Phase 67 launch readiness gate remains intact',
  'Provider availability remains packet/count/advisory only',
] as const;

const DEFERRED_PRODUCTION_ITEMS = [
  'O4 production custodian is open/deferred',
  'O5 managed KEK custody/scheduling is open/deferred',
  'FileCustodian is reference harness only',
  'FileCustodian remains a hardened reference harness, not production KMS',
] as const;

export function buildOperatorUiRuntimeBoundaryReport(): OperatorUiRuntimeBoundaryReport {
  return {
    ok: true,
    code: 'OPERATOR_UI_RUNTIME_BOUNDARY_REPORTED',
    message: 'Operator UI runtime boundary is fixed, synthetic, and no-input.',
    source: 'fixed-synthetic-runtime-boundary',
    surfaces: SURFACES.map((surface) => ({ ...surface })),
    requiredFutureControls: REQUIRED_FUTURE_CONTROLS.map((control) => ({ ...control })),
    blockedUntil: [...BLOCKED_UNTIL],
    boundaries: [...BOUNDARIES],
    deferredProductionItems: [...DEFERRED_PRODUCTION_ITEMS],
  };
}

export function formatOperatorUiRuntimeBoundaryText(
  report: OperatorUiRuntimeBoundaryReport = buildOperatorUiRuntimeBoundaryReport(),
): string {
  const lines = [
    'Operator UI Runtime Boundary Plan',
    `code: ${report.code}`,
    `source: ${report.source}`,
    '',
    'Surfaces:',
  ];

  for (const surface of report.surfaces) {
    lines.push(`- ${surface.id}: ${surface.status}`);
    lines.push(`  summary: ${surface.summary}`);
  }

  lines.push('', 'Required future controls:');
  for (const control of report.requiredFutureControls) {
    lines.push(`- ${control.id}: ${control.status}`);
    lines.push(`  requirement: ${control.requirement}`);
  }

  lines.push('', 'Blocked until:');
  for (const blocker of report.blockedUntil) lines.push(`- ${blocker}`);

  lines.push('', 'Boundaries:');
  for (const boundary of report.boundaries) lines.push(`- ${boundary}`);

  lines.push('', 'Deferred production items:');
  for (const item of report.deferredProductionItems) lines.push(`- ${item}`);

  return `${lines.join('\n')}\n`;
}
