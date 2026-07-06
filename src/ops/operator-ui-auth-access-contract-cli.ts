import {
  buildOperatorUiAuthAccessContractReport,
  formatOperatorUiAuthAccessContractText,
} from './operator-ui-auth-access-contract.js';

function main(): void {
  const report = buildOperatorUiAuthAccessContractReport();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatOperatorUiAuthAccessContractText(report));
}

main();
