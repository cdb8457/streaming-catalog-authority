import {
  buildOperatorUiPacketSourceContractReport,
  formatOperatorUiPacketSourceContractText,
} from './operator-ui-packet-source-contract.js';

function main(): void {
  const report = buildOperatorUiPacketSourceContractReport();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatOperatorUiPacketSourceContractText(report));
}

main();
