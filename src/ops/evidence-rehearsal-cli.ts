import { formatEvidenceRehearsalJson, formatEvidenceRehearsalText } from './evidence-rehearsal.js';

/**
 * Phase 26 - operator evidence rehearsal check.
 *
 *   tsx src/ops/evidence-rehearsal-cli.ts [--json]
 *   (or: npm run ops:evidence-rehearsal -- -- --json)
 *
 * STATIC and LOCAL ONLY. Prints deterministic, redaction-safe labels and checklist prompts for the
 * expected Phase 22/23 evidence package shape. It does not load config, read env values, scan
 * evidence files, connect to a database, call a network service, run Docker, contact Jellyfin, or
 * contact a custodian/cloud/KMS.
 */
function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:evidence-rehearsal [--json]');
    return 0;
  }

  const unsupported = args.filter((arg) => arg !== '--json' && arg !== '--');
  if (unsupported.length > 0) {
    console.error('usage: ops:evidence-rehearsal [--json]');
    return 2;
  }

  const asJson = args.includes('--json');
  process.stdout.write(asJson ? formatEvidenceRehearsalJson() : formatEvidenceRehearsalText());
  return 0;
}

process.exit(main());
