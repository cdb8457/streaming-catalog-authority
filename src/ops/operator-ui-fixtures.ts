import {
  OPERATOR_UI_EXAMPLE_PACKET_DESCRIPTORS,
  type OperatorUiCategoryLabel,
  type OperatorUiPacketDescriptor,
  type OperatorUiPacketFieldDescriptor,
  type OperatorUiPacketValidationResult,
  type OperatorUiScreenId,
  type OperatorUiStatusLabel,
  validateOperatorUiPacketDescriptor,
} from './operator-ui-packet-contract.js';

export type OperatorUiFixturePacketCode =
  | 'OPERATOR_UI_FIXTURE_PACKET_ACCEPTED'
  | 'OPERATOR_UI_FIXTURE_PACKET_REJECTED';

export interface OperatorUiFixtureRow {
  readonly cells: readonly OperatorUiPacketFieldDescriptor[];
}

export interface OperatorUiFixturePacket {
  readonly screenId: OperatorUiScreenId;
  readonly screenLabel: OperatorUiCategoryLabel;
  readonly descriptor: OperatorUiPacketDescriptor;
  readonly rows: readonly OperatorUiFixtureRow[];
}

export interface OperatorUiFixtureValidationReport {
  readonly ok: boolean;
  readonly code: OperatorUiFixturePacketCode;
  readonly message:
    | 'Operator UI fixture packets are redaction-safe.'
    | 'Operator UI fixture packet rejected by static contract.';
  readonly screens: readonly OperatorUiScreenId[];
  readonly acceptedCount: number;
  readonly rejectedCount: number;
}

const SCREEN_LABELS: Record<OperatorUiScreenId, OperatorUiCategoryLabel> = {
  overview: 'System Health',
  'catalog-authority': 'Catalog Authority',
  'privacy-crypto-shredding': 'Privacy Gate',
  'key-custodian-o4-status': 'Operator Configuration',
  reconciler: 'Reconcile Gate',
  'backup-restore': 'Backup Gate',
  'provider-availability-packets': 'Provider Availability',
  'audit-queue': 'Audit Review',
  'settings-operator-configuration': 'Redaction Policy',
};

const ROW_STATUS_BY_INDEX: readonly OperatorUiStatusLabel[] = [
  'Verified',
  'Open',
  'Deferred',
  'Warning',
  'Synced',
  'Count Only',
  'Advisory',
  'Reference Harness',
  'Not Production KMS',
];

const PACKET_KEYS = new Set(['screenId', 'screenLabel', 'descriptor', 'rows']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withDeterministicStatus(
  field: OperatorUiPacketFieldDescriptor,
  index: number,
): OperatorUiPacketFieldDescriptor {
  return {
    label: field.label,
    statusLabel: field.statusLabel ?? ROW_STATUS_BY_INDEX[index % ROW_STATUS_BY_INDEX.length],
    categoryLabel: field.categoryLabel,
  };
}

function rowsForDescriptor(descriptor: OperatorUiPacketDescriptor): readonly OperatorUiFixtureRow[] {
  return [
    {
      cells: descriptor.fields.map((field, index) => withDeterministicStatus(field, index)),
    },
  ];
}

export const OPERATOR_UI_FIXTURE_PACKETS: readonly OperatorUiFixturePacket[] =
  OPERATOR_UI_EXAMPLE_PACKET_DESCRIPTORS.map((descriptor) => ({
    screenId: descriptor.screenId,
    screenLabel: SCREEN_LABELS[descriptor.screenId],
    descriptor,
    rows: rowsForDescriptor(descriptor),
  })) as readonly OperatorUiFixturePacket[];

export function validateOperatorUiFixturePacket(input: unknown): OperatorUiPacketValidationResult {
  if (!isRecord(input)) {
    return validateOperatorUiPacketDescriptor(input);
  }

  if (!('descriptor' in input)) return validateOperatorUiPacketDescriptor(input);
  if (Object.keys(input).some((key) => !PACKET_KEYS.has(key))) return fixedFixtureRejection();

  const descriptorResult = validateOperatorUiPacketDescriptor(input.descriptor);
  if (!descriptorResult.ok) return descriptorResult;

  const descriptor = input.descriptor as OperatorUiPacketDescriptor;
  if (
    input.screenId !== descriptor.screenId
    || input.screenLabel !== SCREEN_LABELS[descriptor.screenId]
    || JSON.stringify(input.rows) !== JSON.stringify(rowsForDescriptor(descriptor))
  ) return fixedFixtureRejection();

  return descriptorResult;
}

export function validateOperatorUiFixturePackets(
  packets: readonly OperatorUiFixturePacket[] = OPERATOR_UI_FIXTURE_PACKETS,
): OperatorUiFixtureValidationReport {
  const screens: OperatorUiScreenId[] = [];
  let rejectedCount = 0;

  for (const packet of packets) {
    screens.push(packet.screenId);
    if (!validateOperatorUiFixturePacket(packet).ok) rejectedCount++;
  }

  return {
    ok: rejectedCount === 0,
    code: rejectedCount === 0 ? 'OPERATOR_UI_FIXTURE_PACKET_ACCEPTED' : 'OPERATOR_UI_FIXTURE_PACKET_REJECTED',
    message: rejectedCount === 0
      ? 'Operator UI fixture packets are redaction-safe.'
      : 'Operator UI fixture packet rejected by static contract.',
    screens,
    acceptedCount: packets.length - rejectedCount,
    rejectedCount,
  };
}

export function formatOperatorUiFixtureReport(
  report: OperatorUiFixtureValidationReport = validateOperatorUiFixturePackets(),
): string {
  return [
    `code=${report.code}`,
    `ok=${report.ok ? 'yes' : 'no'}`,
    `accepted=${report.acceptedCount}`,
    `rejected=${report.rejectedCount}`,
    `screens=${report.screens.join(',')}`,
  ].join('\n');
}

function fixedFixtureRejection(): OperatorUiPacketValidationResult {
  return validateOperatorUiPacketDescriptor({ screenId: 'overview', fields: [] });
}
