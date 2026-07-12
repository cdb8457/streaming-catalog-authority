import {
  buildSidecarFactoryEvidencePacket,
  formatSidecarFactoryEvidenceText,
} from './sidecar-factory-evidence.js';

async function main(): Promise<void> {
  const report = await buildSidecarFactoryEvidencePacket();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  }

  process.stdout.write(formatSidecarFactoryEvidenceText(report));
  process.exit(report.ok ? 0 : 1);
}

main().catch(() => {
  process.stdout.write('Phase 189 sidecar factory evidence failed closed.\n');
  process.exit(1);
});
