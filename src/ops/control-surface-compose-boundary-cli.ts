import {
  buildControlSurfaceComposeBoundaryReport,
  formatControlSurfaceComposeBoundaryJson,
  formatControlSurfaceComposeBoundaryText,
} from './control-surface-compose-boundary.js';

const report = buildControlSurfaceComposeBoundaryReport();
process.stdout.write(process.argv.includes('--json')
  ? formatControlSurfaceComposeBoundaryJson(report)
  : formatControlSurfaceComposeBoundaryText(report));
