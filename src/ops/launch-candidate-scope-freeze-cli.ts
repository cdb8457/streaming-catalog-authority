import {
  buildLaunchCandidateScopeFreezePacket,
  formatLaunchCandidateScopeFreezeJson,
  formatLaunchCandidateScopeFreezeText,
} from './launch-candidate-scope-freeze.js';

/**
 * Phase 86 - launch-candidate scope freeze packet.
 *
 * STATIC OUTPUT ONLY. Does not read files, env, DB, credentials, evidence folders, or artifacts;
 * does not contact services; does not approve launch; does not close O4/O5.
 */
function main(): number {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:launch-candidate-scope-freeze [--json]');
    return 0;
  }

  const asJson = args.includes('--json');
  const unsupported = args.filter((arg) => arg !== '--json');
  if (unsupported.length > 0) {
    console.error('usage: ops:launch-candidate-scope-freeze [--json]');
    return 2;
  }

  const packet = buildLaunchCandidateScopeFreezePacket();
  process.stdout.write(asJson ? formatLaunchCandidateScopeFreezeJson(packet) : formatLaunchCandidateScopeFreezeText(packet));
  return 0;
}

process.exit(main());
