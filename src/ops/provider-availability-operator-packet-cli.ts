import {
  formatProviderAvailabilityOperatorPacketJson,
  formatProviderAvailabilityOperatorPacketText,
} from './provider-availability-operator-packet.js';

/**
 * Phase 59 - provider availability operator packet.
 *
 * STATIC and LOCAL ONLY. Prints a deterministic summary/review workflow for sanitized provider
 * availability bridge reports. It does not execute commands, read env values, read files, read
 * credentials, call providers, construct transports, scan directories, or validate real evidence.
 */
function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:provider-availability-operator-packet [--json]');
    return 0;
  }
  const unsupported = args.filter((arg) => arg !== '--json' && arg !== '--');
  if (unsupported.length > 0) {
    console.error('usage: ops:provider-availability-operator-packet [--json]');
    return 2;
  }

  const asJson = args.includes('--json');
  process.stdout.write(asJson ? formatProviderAvailabilityOperatorPacketJson() : formatProviderAvailabilityOperatorPacketText());
  return 0;
}

process.exit(main());
