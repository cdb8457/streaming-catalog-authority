export type OperatorUiLaunchSurfaceId = 'static-preview' | 'local-readonly-ui' | 'live-product';
export type OperatorUiLaunchReadiness = 'ready' | 'blocked/deferred' | 'not-ready';

export interface OperatorUiLaunchReadinessSurface {
  readonly id: OperatorUiLaunchSurfaceId;
  readonly label: string;
  readonly readiness: OperatorUiLaunchReadiness;
  readonly summary: string;
  readonly gates: readonly string[];
}

export interface OperatorUiLaunchReadinessReport {
  readonly ok: true;
  readonly code: 'OPERATOR_UI_LAUNCH_READINESS_REPORTED';
  readonly message: 'Operator UI launch readiness is fixed, synthetic, and redaction-safe.';
  readonly source: 'fixed-synthetic-readiness';
  readonly surfaces: readonly OperatorUiLaunchReadinessSurface[];
  readonly launchDecision: {
    readonly staticPreview: 'fixture-only static preview can be generated/shared after Phase 64 and Phase 65 gates pass';
    readonly localReadonlyUi: 'blocked/deferred pending explicit future authorization and design';
    readonly liveProduct: 'not-ready pending security, runtime, access, custody, and production gates';
  };
  readonly blockers: readonly string[];
  readonly boundaries: readonly string[];
}

const PHASE_64_65_GATE =
  'Phase 64 render allowlist and Phase 65 artifact packaging are required for static artifact preview';

const SURFACES = [
  {
    id: 'static-preview',
    label: 'Fixture-only static operator UI preview',
    readiness: 'ready',
    summary: 'Ready to generate/share as a fixture-only static artifact when required static gates pass.',
    gates: [
      PHASE_64_65_GATE,
      'Static preview remains fixture-only and redaction-safe',
    ],
  },
  {
    id: 'local-readonly-ui',
    label: 'Local read-only operator UI',
    readiness: 'blocked/deferred',
    summary: 'Blocked/deferred until a later phase explicitly authorizes and designs a local read-only surface.',
    gates: [
      'Sanitized local packet source is not implemented',
      'Auth/access boundary is not implemented',
      'Live UI/API/runtime is not implemented or authorized',
    ],
  },
  {
    id: 'live-product',
    label: 'Live product launch',
    readiness: 'not-ready',
    summary: 'Not ready until security/runtime/production gates are designed, implemented, and reviewed.',
    gates: [
      'Live UI/API/runtime is not implemented or authorized',
      'Auth/access boundary is not implemented',
      'O4 production custodian is open/deferred',
      'O5 managed KEK custody/scheduling is open/deferred',
      'FileCustodian is reference harness only',
    ],
  },
] as const satisfies readonly OperatorUiLaunchReadinessSurface[];

const BLOCKERS = [
  'Live UI/API/runtime is not implemented or authorized',
  'Sanitized local packet source is not implemented',
  'Auth/access boundary is not implemented',
  'O4 production custodian is open/deferred',
  'O5 managed KEK custody/scheduling is open/deferred',
  'FileCustodian is reference harness only',
  'FileCustodian remains a hardened reference harness, not production KMS',
  PHASE_64_65_GATE,
  'Provider availability remains packet/count/advisory only',
] as const;

const BOUNDARIES = [
  'Static UI remains fixture-only',
  'No real titles, external IDs, provider names/logos, infohashes, magnets, credentials, user library data, poster art, or streaming artwork are displayed',
  'Local/live product launch is blocked',
] as const;

export function buildOperatorUiLaunchReadinessReport(): OperatorUiLaunchReadinessReport {
  return {
    ok: true,
    code: 'OPERATOR_UI_LAUNCH_READINESS_REPORTED',
    message: 'Operator UI launch readiness is fixed, synthetic, and redaction-safe.',
    source: 'fixed-synthetic-readiness',
    surfaces: SURFACES.map((surface) => ({
      ...surface,
      gates: [...surface.gates],
    })),
    launchDecision: {
      staticPreview: 'fixture-only static preview can be generated/shared after Phase 64 and Phase 65 gates pass',
      localReadonlyUi: 'blocked/deferred pending explicit future authorization and design',
      liveProduct: 'not-ready pending security, runtime, access, custody, and production gates',
    },
    blockers: [...BLOCKERS],
    boundaries: [...BOUNDARIES],
  };
}

export function formatOperatorUiLaunchReadinessText(
  report: OperatorUiLaunchReadinessReport = buildOperatorUiLaunchReadinessReport(),
): string {
  const lines = [
    'Operator UI Launch Readiness',
    `code: ${report.code}`,
    `source: ${report.source}`,
    '',
    'Readiness levels:',
  ];

  for (const surface of report.surfaces) {
    lines.push(`- ${surface.id}: ${surface.readiness}`);
    lines.push(`  label: ${surface.label}`);
    lines.push(`  summary: ${surface.summary}`);
    lines.push('  gates:');
    for (const gate of surface.gates) lines.push(`  - ${gate}`);
  }

  lines.push(
    '',
    'Launch decision:',
    `- static-preview: ${report.launchDecision.staticPreview}`,
    `- local-readonly-ui: ${report.launchDecision.localReadonlyUi}`,
    `- live-product: ${report.launchDecision.liveProduct}`,
    '',
    'Blockers and gates:',
  );
  for (const blocker of report.blockers) lines.push(`- ${blocker}`);

  lines.push('', 'Boundaries:');
  for (const boundary of report.boundaries) lines.push(`- ${boundary}`);

  return `${lines.join('\n')}\n`;
}
