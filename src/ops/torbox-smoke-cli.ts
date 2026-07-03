import {
  buildTorBoxSmokeShellReport,
  formatTorBoxSmokeShellJson,
  formatTorBoxSmokeShellText,
  parseTorBoxSmokeShellArgs,
  torBoxSmokeShellUsage,
} from './torbox-smoke-shell.js';

/**
 * Phase 37 - TorBox smoke CLI shell.
 *
 * Operator entrypoint shape only. This command performs local preflight checks, emits a redaction-safe
 * refusal report, and exits before any TorBox transport could be contacted.
 */
function main(): number {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(torBoxSmokeShellUsage());
    return 0;
  }

  const parsed = parseTorBoxSmokeShellArgs(argv);
  if ('error' in parsed) {
    console.error(torBoxSmokeShellUsage());
    console.error(`refusing: ${parsed.error}`);
    return 2;
  }

  const report = buildTorBoxSmokeShellReport(parsed);
  process.stdout.write(parsed.json ? formatTorBoxSmokeShellJson(report) : formatTorBoxSmokeShellText(report));
  return 2;
}

process.exit(main());
