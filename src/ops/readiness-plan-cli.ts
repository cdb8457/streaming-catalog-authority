import { formatReadinessPlanJson, formatReadinessPlanText } from './readiness-plan.js';

/**
 * Phase 25 - operator readiness rehearsal plan.
 *
 *   tsx src/ops/readiness-plan-cli.ts [--json]
 *   (or: npm run ops:readiness-plan -- -- --json)
 *
 * STATIC and LOCAL ONLY. Prints a deterministic, redaction-safe skeleton for the Phase 22/23
 * evidence package. It does not load config, read env values, read files, connect to a database,
 * call a network service, run Docker, contact Jellyfin, or validate real operator evidence.
 */
function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:readiness-plan [--json]');
    return 0;
  }
  const unsupported = args.filter((arg) => arg !== '--json' && arg !== '--');
  if (unsupported.length > 0) {
    console.error(`usage: ops:readiness-plan [--json]`);
    return 2;
  }

  const asJson = args.includes('--json');
  process.stdout.write(asJson ? formatReadinessPlanJson() : formatReadinessPlanText());
  return 0;
}

process.exit(main());
