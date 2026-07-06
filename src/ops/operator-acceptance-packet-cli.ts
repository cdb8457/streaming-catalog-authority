import {
  buildOperatorAcceptancePacket,
  formatOperatorAcceptancePacketJson,
  formatOperatorAcceptancePacketText,
} from './operator-acceptance-packet.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    process.exitCode = 1;
    process.stderr.write('usage: ops:operator-acceptance-packet [--json]\n');
    return;
  }

  const packet = buildOperatorAcceptancePacket();
  process.stdout.write(args.includes('--json')
    ? formatOperatorAcceptancePacketJson(packet)
    : formatOperatorAcceptancePacketText(packet));
}

void main();
