import {
  buildOperatorUiLocalAuthBoundaryReport,
  formatOperatorUiLocalAuthBoundaryText,
} from './operator-ui-local-auth-boundary.js';

function main(): void {
  const report = buildOperatorUiLocalAuthBoundaryReport();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatOperatorUiLocalAuthBoundaryText(report));
}

main();
