import { readFileSync, statSync } from 'node:fs';
import {
  buildO5KekClosureGateInputErrorReport,
  buildO5KekClosureGateReport,
  formatO5KekClosureGateJson,
  formatO5KekClosureGateText,
  o5KekClosureGateHasFailures,
  parseO5KekClosureGateJson,
  type O5KekClosureGateInputErrorCode,
} from './o5-kek-closure-gate.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: O5KekClosureGateInputErrorCode): never {
  const report = buildO5KekClosureGateInputErrorReport(code);
  process.stdout.write(process.argv.includes('--json') ? formatO5KekClosureGateJson(report) : formatO5KekClosureGateText(report));
  process.exit(1);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson(path: string | undefined, kind: 'kekPreflight' | 'verdict'): Record<string, unknown> | O5KekClosureGateInputErrorCode {
  if (!path || path.startsWith('--')) return kind === 'kekPreflight' ? 'KEK_PREFLIGHT_INPUT_REQUIRED' : 'VERDICT_REPORT_INPUT_REQUIRED';
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return kind === 'kekPreflight' ? 'KEK_PREFLIGHT_FILE_READ_FAILED' : 'VERDICT_REPORT_FILE_READ_FAILED';
    if (stat.size > MAX_INPUT_BYTES) return kind === 'kekPreflight' ? 'KEK_PREFLIGHT_FILE_TOO_LARGE' : 'VERDICT_REPORT_FILE_TOO_LARGE';
    return parseO5KekClosureGateJson(readFileSync(path, 'utf8'), kind);
  } catch {
    return kind === 'kekPreflight' ? 'KEK_PREFLIGHT_FILE_READ_FAILED' : 'VERDICT_REPORT_FILE_READ_FAILED';
  }
}

const kekPreflight = readJson(argValue('--kek-preflight'), 'kekPreflight');
if (typeof kekPreflight === 'string') inputError(kekPreflight);
const verdict = readJson(argValue('--verdict'), 'verdict');
if (typeof verdict === 'string') inputError(verdict);

const report = buildO5KekClosureGateReport(kekPreflight, verdict);
process.stdout.write(process.argv.includes('--json') ? formatO5KekClosureGateJson(report) : formatO5KekClosureGateText(report));
if (o5KekClosureGateHasFailures(report)) process.exit(1);

