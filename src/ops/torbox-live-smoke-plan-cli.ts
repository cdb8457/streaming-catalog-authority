import { formatTorBoxLiveSmokePlanJson, formatTorBoxLiveSmokePlanText } from './torbox-live-smoke-plan.js';

/**
 * Phase 45 - TorBox live smoke operator plan.
 *
 * STATIC and LOCAL ONLY. Prints deterministic command shapes for manually running Phase 43 live
 * smoke and Phase 44 evidence preflight. It does not execute commands, read env values, read files,
 * read credentials, call TorBox, construct transports, or validate real evidence.
 */
function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:torbox-live-smoke-plan [--json]');
    return 0;
  }
  const unsupported = args.filter((arg) => arg !== '--json' && arg !== '--');
  if (unsupported.length > 0) {
    console.error('usage: ops:torbox-live-smoke-plan [--json]');
    return 2;
  }

  const asJson = args.includes('--json');
  process.stdout.write(asJson ? formatTorBoxLiveSmokePlanJson() : formatTorBoxLiveSmokePlanText());
  return 0;
}

process.exit(main());
