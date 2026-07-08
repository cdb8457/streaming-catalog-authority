import { readFileSync, statSync } from 'node:fs';
import {
  buildSidecarUnraidO4ClosureGateInputErrorReport,
  buildSidecarUnraidO4ClosureGateReport,
  formatSidecarUnraidO4ClosureGateJson,
  formatSidecarUnraidO4ClosureGateText,
  parseSidecarUnraidO4ClosureGateJson,
  sidecarUnraidO4ClosureGateHasFailures,
  type SidecarUnraidO4ClosureGateInputErrorCode,
} from './sidecar-unraid-o4-closure-gate.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: SidecarUnraidO4ClosureGateInputErrorCode): never {
  const report = buildSidecarUnraidO4ClosureGateInputErrorReport(code);
  process.stdout.write(process.argv.includes('--json') ? formatSidecarUnraidO4ClosureGateJson(report) : formatSidecarUnraidO4ClosureGateText(report));
  process.exit(1);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson(path: string | undefined, kind: 'boundary' | 'verdict'): Record<string, unknown> | SidecarUnraidO4ClosureGateInputErrorCode {
  if (!path || path.startsWith('--')) return kind === 'boundary' ? 'BOUNDARY_REPORT_INPUT_REQUIRED' : 'VERDICT_REPORT_INPUT_REQUIRED';
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return kind === 'boundary' ? 'BOUNDARY_REPORT_FILE_READ_FAILED' : 'VERDICT_REPORT_FILE_READ_FAILED';
    if (stat.size > MAX_INPUT_BYTES) return kind === 'boundary' ? 'BOUNDARY_REPORT_FILE_TOO_LARGE' : 'VERDICT_REPORT_FILE_TOO_LARGE';
    return parseSidecarUnraidO4ClosureGateJson(readFileSync(path, 'utf8'), kind);
  } catch {
    return kind === 'boundary' ? 'BOUNDARY_REPORT_FILE_READ_FAILED' : 'VERDICT_REPORT_FILE_READ_FAILED';
  }
}

const boundary = readJson(argValue('--boundary'), 'boundary');
if (typeof boundary === 'string') inputError(boundary);
const verdict = readJson(argValue('--verdict'), 'verdict');
if (typeof verdict === 'string') inputError(verdict);

const report = buildSidecarUnraidO4ClosureGateReport(boundary, verdict);
process.stdout.write(process.argv.includes('--json') ? formatSidecarUnraidO4ClosureGateJson(report) : formatSidecarUnraidO4ClosureGateText(report));
if (sidecarUnraidO4ClosureGateHasFailures(report)) process.exit(1);
