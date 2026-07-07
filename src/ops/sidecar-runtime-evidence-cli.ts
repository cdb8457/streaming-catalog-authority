import {
  buildSidecarRuntimeEvidencePacket,
  formatSidecarRuntimeEvidencePacketText,
} from './sidecar-runtime-evidence.js';

async function main(): Promise<void> {
  const report = await buildSidecarRuntimeEvidencePacket();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  }

  process.stdout.write(formatSidecarRuntimeEvidencePacketText(report));
  process.exit(report.ok ? 0 : 1);
}

main().catch(() => {
  process.stdout.write('Phase 101/102 sidecar runtime evidence failed closed.\n');
  process.exit(1);
});
