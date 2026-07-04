import {
  formatTorBoxLiveSmokeOperatorPacketJson,
  formatTorBoxLiveSmokeOperatorPacketText,
} from './torbox-live-smoke-operator-packet.js';

/**
 * Phase 52 - TorBox live smoke operator packet.
 *
 * STATIC and LOCAL ONLY. Prints a deterministic run/save/review workflow for the already-scoped
 * TorBox live smoke commands. It does not execute commands, read env values, read files, read
 * credentials, call TorBox, construct transports, scan directories, or validate real evidence.
 */
function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:torbox-live-smoke-operator-packet [--json]');
    return 0;
  }
  const unsupported = args.filter((arg) => arg !== '--json' && arg !== '--');
  if (unsupported.length > 0) {
    console.error('usage: ops:torbox-live-smoke-operator-packet [--json]');
    return 2;
  }

  const asJson = args.includes('--json');
  process.stdout.write(asJson ? formatTorBoxLiveSmokeOperatorPacketJson() : formatTorBoxLiveSmokeOperatorPacketText());
  return 0;
}

process.exit(main());
