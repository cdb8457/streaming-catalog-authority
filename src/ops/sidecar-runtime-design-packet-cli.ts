import {
  buildSidecarRuntimeDesignPacket,
  formatSidecarRuntimeDesignPacketText,
} from './sidecar-runtime-design-packet.js';

function main(): void {
  const report = buildSidecarRuntimeDesignPacket();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatSidecarRuntimeDesignPacketText(report));
}

main();
