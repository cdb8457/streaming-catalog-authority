import {
  buildSidecarEvidenceHarnessPacket,
  formatSidecarEvidenceHarnessPacketText,
} from './sidecar-evidence-harness-packet.js';

function main(): void {
  const report = buildSidecarEvidenceHarnessPacket();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatSidecarEvidenceHarnessPacketText(report));
}

main();
