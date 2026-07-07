import {
  buildSemiLaunchValidationPacket,
  formatSemiLaunchValidationPacketJson,
  formatSemiLaunchValidationPacketText,
} from './semi-launch-validation-packet.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const packet = buildSemiLaunchValidationPacket();

process.stdout.write(
  json
    ? formatSemiLaunchValidationPacketJson(packet)
    : formatSemiLaunchValidationPacketText(packet),
);
