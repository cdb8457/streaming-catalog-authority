import {
  buildOperatorUiRuntimeBoundaryReport,
  formatOperatorUiRuntimeBoundaryText,
} from './operator-ui-runtime-boundary.js';

function main(): void {
  const report = buildOperatorUiRuntimeBoundaryReport();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatOperatorUiRuntimeBoundaryText(report));
}

main();
