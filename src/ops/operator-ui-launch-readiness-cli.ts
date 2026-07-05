import {
  buildOperatorUiLaunchReadinessReport,
  formatOperatorUiLaunchReadinessText,
} from './operator-ui-launch-readiness.js';

function main(): void {
  const report = buildOperatorUiLaunchReadinessReport();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatOperatorUiLaunchReadinessText(report));
}

main();
