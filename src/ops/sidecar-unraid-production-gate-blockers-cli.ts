import {
  buildSidecarUnraidProductionGateBlockersPacket,
  formatSidecarUnraidProductionGateBlockersJson,
  formatSidecarUnraidProductionGateBlockersText,
} from './sidecar-unraid-production-gate-blockers.js';

const packet = buildSidecarUnraidProductionGateBlockersPacket();
process.stdout.write(process.argv.includes('--json')
  ? formatSidecarUnraidProductionGateBlockersJson(packet)
  : formatSidecarUnraidProductionGateBlockersText(packet));
