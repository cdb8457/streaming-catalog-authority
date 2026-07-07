import {
  buildSidecarUnraidEvidenceCapturePacket,
  formatSidecarUnraidEvidenceCapturePacketText,
} from './sidecar-unraid-evidence-capture.js';

function main(): void {
  const packet = buildSidecarUnraidEvidenceCapturePacket();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
    return;
  }
  process.stdout.write(formatSidecarUnraidEvidenceCapturePacketText(packet));
}

main();
