import {
  buildLaunchGateAuditReport,
  formatLaunchGateAuditJson,
  formatLaunchGateAuditText,
} from './launch-gate-audit.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    process.exitCode = 1;
    process.stderr.write('usage: ops:launch-gate-audit [--json]\n');
    return;
  }

  const report = buildLaunchGateAuditReport();
  process.stdout.write(args.includes('--json') ? formatLaunchGateAuditJson(report) : formatLaunchGateAuditText(report));
}

void main();
