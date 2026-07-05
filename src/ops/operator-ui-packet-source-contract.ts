export type OperatorUiPacketSourceOptionId =
  | 'immutable-readonly-packet-snapshot'
  | 'sanitized-local-packet-endpoint';

export type OperatorUiPacketSourceStatus = 'allowed-future-source/not-implemented';

export interface OperatorUiPacketSourceOption {
  readonly id: OperatorUiPacketSourceOptionId;
  readonly status: OperatorUiPacketSourceStatus;
  readonly contract: string;
}

export interface OperatorUiPacketSourceContractReport {
  readonly ok: true;
  readonly code: 'OPERATOR_UI_PACKET_SOURCE_CONTRACT_REPORTED';
  readonly message: 'Operator UI packet source contract is fixed, synthetic, and no-input.';
  readonly source: 'fixed-synthetic-packet-source-contract';
  readonly allowedFutureSources: readonly OperatorUiPacketSourceOption[];
  readonly requiredProducerGuards: readonly string[];
  readonly forbiddenSourceShapes: readonly string[];
  readonly forbiddenDataCategories: readonly string[];
  readonly runtimeDecision: {
    readonly localReadonlyRuntime: 'blocked/deferred until source, auth, and runtime designs are satisfied';
    readonly liveProduct: 'not-ready';
  };
  readonly boundaries: readonly string[];
}

const ALLOWED_FUTURE_SOURCES = [
  {
    id: 'immutable-readonly-packet-snapshot',
    status: 'allowed-future-source/not-implemented',
    contract: 'Future runtime may consume immutable/read-only packet snapshots after explicit sanitization and allowlist checks.',
  },
  {
    id: 'sanitized-local-packet-endpoint',
    status: 'allowed-future-source/not-implemented',
    contract: 'Future runtime may consume an explicit sanitized local packet endpoint after source, access, auth, and runtime designs are reviewed.',
  },
] as const satisfies readonly OperatorUiPacketSourceOption[];

const REQUIRED_PRODUCER_GUARDS = [
  'Packet producer must sit behind explicit sanitization and allowlist checks',
  'Packet producer must emit only redaction-safe operator packets',
  'Packet producer must emit only synthetic labels, counts, and statuses',
  'Packet source must preserve Phase 61 operator UI packet descriptor allowlists',
  'Provider availability remains packet/count/advisory only',
] as const;

const FORBIDDEN_SOURCE_SHAPES = [
  'direct UI DB reads',
  'raw event payloads',
  'provider or adapter reads',
  'live packet ingestion',
  'local state scans',
  'operator data passthrough',
  'mutable packet streams',
] as const;

const FORBIDDEN_DATA_CATEGORIES = [
  'real titles',
  'external IDs',
  'provider names/logos',
  'raw provider refs',
  'infohashes',
  'magnets',
  'credentials',
  'paths',
  'artwork',
  'user library data',
  'raw event payloads',
  'media-control/retrieval commands',
] as const;

const BOUNDARIES = [
  'No source implementation is added',
  'No endpoint implementation is added',
  'No direct UI DB access is allowed',
  'No raw event payloads are allowed',
  'No provider or DB direct consumption is allowed',
  'No packet producer, runtime, or ingestion path is implemented',
  'Local read-only runtime remains blocked/deferred',
  'Live product launch remains not-ready',
  'O4 production custodian is open/deferred',
  'O5 managed KEK custody/scheduling is open/deferred',
  'FileCustodian remains a hardened reference harness, not production KMS',
] as const;

export function buildOperatorUiPacketSourceContractReport(): OperatorUiPacketSourceContractReport {
  return {
    ok: true,
    code: 'OPERATOR_UI_PACKET_SOURCE_CONTRACT_REPORTED',
    message: 'Operator UI packet source contract is fixed, synthetic, and no-input.',
    source: 'fixed-synthetic-packet-source-contract',
    allowedFutureSources: ALLOWED_FUTURE_SOURCES.map((sourceOption) => ({ ...sourceOption })),
    requiredProducerGuards: [...REQUIRED_PRODUCER_GUARDS],
    forbiddenSourceShapes: [...FORBIDDEN_SOURCE_SHAPES],
    forbiddenDataCategories: [...FORBIDDEN_DATA_CATEGORIES],
    runtimeDecision: {
      localReadonlyRuntime: 'blocked/deferred until source, auth, and runtime designs are satisfied',
      liveProduct: 'not-ready',
    },
    boundaries: [...BOUNDARIES],
  };
}

export function formatOperatorUiPacketSourceContractText(
  report: OperatorUiPacketSourceContractReport = buildOperatorUiPacketSourceContractReport(),
): string {
  const lines = [
    'Operator UI Packet Source Contract',
    `code: ${report.code}`,
    `source: ${report.source}`,
    '',
    'Allowed future sources:',
  ];

  for (const sourceOption of report.allowedFutureSources) {
    lines.push(`- ${sourceOption.id}: ${sourceOption.status}`);
    lines.push(`  contract: ${sourceOption.contract}`);
  }

  lines.push('', 'Required producer guards:');
  for (const guard of report.requiredProducerGuards) lines.push(`- ${guard}`);

  lines.push('', 'Forbidden source shapes:');
  for (const shape of report.forbiddenSourceShapes) lines.push(`- ${shape}`);

  lines.push('', 'Forbidden data categories:');
  for (const category of report.forbiddenDataCategories) lines.push(`- ${category}`);

  lines.push(
    '',
    'Runtime decision:',
    `- local-readonly-runtime: ${report.runtimeDecision.localReadonlyRuntime}`,
    `- live-product: ${report.runtimeDecision.liveProduct}`,
    '',
    'Boundaries:',
  );
  for (const boundary of report.boundaries) lines.push(`- ${boundary}`);

  return `${lines.join('\n')}\n`;
}
