import {
  buildLaunchCandidateMetadataPacket,
  formatLaunchCandidateMetadataJson,
  formatLaunchCandidateMetadataText,
} from './launch-candidate-metadata-packet.js';

/**
 * Phase 87 - launch-candidate metadata packet.
 *
 * STATIC OUTPUT ONLY. Does not read files, env, DB, credentials, evidence folders, or artifacts;
 * does not contact services; does not approve launch; does not approve release candidates; does not close O4/O5.
 */
function main(): number {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:launch-candidate-metadata-packet [--json]');
    return 0;
  }

  const asJson = args.includes('--json');
  const unsupported = args.filter((arg) => arg !== '--json');
  if (unsupported.length > 0) {
    console.error('usage: ops:launch-candidate-metadata-packet [--json]');
    return 2;
  }

  const packet = buildLaunchCandidateMetadataPacket();
  process.stdout.write(asJson ? formatLaunchCandidateMetadataJson(packet) : formatLaunchCandidateMetadataText(packet));
  return 0;
}

process.exit(main());
