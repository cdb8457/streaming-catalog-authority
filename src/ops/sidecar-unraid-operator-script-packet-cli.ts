import {
  buildSidecarUnraidOperatorScriptPacket,
  formatSidecarUnraidOperatorScriptPacketText,
} from './sidecar-unraid-operator-script-packet.js';

function main(): void {
  const packet = buildSidecarUnraidOperatorScriptPacket();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
    return;
  }
  process.stdout.write(formatSidecarUnraidOperatorScriptPacketText(packet));
}

main();
