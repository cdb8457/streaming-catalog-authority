import { OPERATOR_UI_FIXTURE_PACKETS } from './operator-ui-fixtures.js';
import type {
  OperatorUiCategoryLabel,
  OperatorUiPacketDescriptor,
  OperatorUiScreenId,
  OperatorUiStatusLabel,
} from './operator-ui-packet-contract.js';

export interface OperatorUiSanitizedPacketCell {
  readonly label: string;
  readonly statusLabel: OperatorUiStatusLabel;
  readonly categoryLabel: OperatorUiCategoryLabel;
}

export interface OperatorUiSanitizedPacketRow {
  readonly cells: readonly OperatorUiSanitizedPacketCell[];
}

export interface OperatorUiSanitizedPacket {
  readonly screenId: OperatorUiScreenId;
  readonly screenLabel: OperatorUiCategoryLabel;
  readonly descriptor: OperatorUiPacketDescriptor;
  readonly rows: readonly OperatorUiSanitizedPacketRow[];
}

export interface OperatorUiSanitizedPacketSnapshot {
  readonly ok: true;
  readonly code: 'OPERATOR_UI_SANITIZED_PACKET_SNAPSHOT';
  readonly source: 'operator-ui-fixture-packets';
  readonly dataMode: 'synthetic-fixture-only';
  readonly packetCount: number;
  readonly screens: readonly OperatorUiScreenId[];
  readonly packets: readonly OperatorUiSanitizedPacket[];
}

export function buildOperatorUiSanitizedPacketSnapshot(): OperatorUiSanitizedPacketSnapshot {
  const packets = OPERATOR_UI_FIXTURE_PACKETS.map((packet) => ({
    screenId: packet.screenId,
    screenLabel: packet.screenLabel,
    descriptor: packet.descriptor,
    rows: packet.rows.map((row) => ({
      cells: row.cells.map((cell) => ({
        label: cell.label,
        statusLabel: cell.statusLabel ?? 'Static',
        categoryLabel: cell.categoryLabel ?? packet.screenLabel,
      })),
    })),
  }));

  return {
    ok: true,
    code: 'OPERATOR_UI_SANITIZED_PACKET_SNAPSHOT',
    source: 'operator-ui-fixture-packets',
    dataMode: 'synthetic-fixture-only',
    packetCount: packets.length,
    screens: packets.map((packet) => packet.screenId),
    packets,
  };
}
