import {
  buildLongRunningServiceBoundaryReport,
  formatLongRunningServiceBoundaryJson,
  formatLongRunningServiceBoundaryText,
} from './long-running-service-boundary.js';

const report = buildLongRunningServiceBoundaryReport();
process.stdout.write(process.argv.includes('--json')
  ? formatLongRunningServiceBoundaryJson(report)
  : formatLongRunningServiceBoundaryText(report));
