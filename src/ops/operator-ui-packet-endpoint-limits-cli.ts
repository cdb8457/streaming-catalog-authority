import {
  buildOperatorUiPacketEndpointLimitsReport,
  formatOperatorUiPacketEndpointLimitsText,
} from './operator-ui-packet-endpoint-limits.js';

function main(): void {
  const report = buildOperatorUiPacketEndpointLimitsReport();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatOperatorUiPacketEndpointLimitsText(report));
}

main();
