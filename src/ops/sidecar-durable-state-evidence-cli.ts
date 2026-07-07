import {
  buildDurableSidecarStateEvidencePacket,
  formatDurableSidecarStateEvidenceText,
} from './sidecar-durable-state-evidence.js';

async function main(): Promise<void> {
  const report = await buildDurableSidecarStateEvidencePacket();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  }

  process.stdout.write(formatDurableSidecarStateEvidenceText(report));
  process.exit(report.ok ? 0 : 1);
}

main().catch(() => {
  process.stdout.write('Phase 103/104 durable sidecar state evidence failed closed.\n');
  process.exit(1);
});
