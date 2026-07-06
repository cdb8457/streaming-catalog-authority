import {
  buildOperatorUiPacketEndpointReadinessReport,
  formatOperatorUiPacketEndpointReadinessText,
} from './operator-ui-packet-endpoint-readiness.js';

function main(): void {
  const report = buildOperatorUiPacketEndpointReadinessReport();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatOperatorUiPacketEndpointReadinessText(report));
}

main();
