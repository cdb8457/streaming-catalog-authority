import {
  buildOperatorUiPreviewLaunchPacket,
  formatOperatorUiPreviewLaunchPacketText,
} from './operator-ui-preview-launch-packet.js';

function main(): void {
  const report = buildOperatorUiPreviewLaunchPacket();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatOperatorUiPreviewLaunchPacketText(report));
}

main();

