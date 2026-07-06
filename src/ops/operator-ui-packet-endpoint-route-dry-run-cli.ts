import {
  buildOperatorUiPacketEndpointRouteDryRunReport,
  formatOperatorUiPacketEndpointRouteDryRunText,
} from './operator-ui-packet-endpoint-route-dry-run.js';

function main(): void {
  const report = buildOperatorUiPacketEndpointRouteDryRunReport();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatOperatorUiPacketEndpointRouteDryRunText(report));
}

main();
