import { readFileSync, statSync } from 'node:fs';
import {
  buildO5KekFinalAuthorizationInputErrorReport,
  buildO5KekFinalAuthorizationReport,
  formatO5KekFinalAuthorizationJson,
  formatO5KekFinalAuthorizationText,
  o5KekFinalAuthorizationHasFailures,
  parseO5KekFinalAuthorizationJson,
  type O5KekFinalAuthorizationInputErrorCode,
} from './o5-kek-final-authorization.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: O5KekFinalAuthorizationInputErrorCode): never {
  const report = buildO5KekFinalAuthorizationInputErrorReport(code);
  process.stdout.write(process.argv.includes('--json') ? formatO5KekFinalAuthorizationJson(report) : formatO5KekFinalAuthorizationText(report));
  process.exit(1);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson(path: string | undefined, kind: 'closureGate' | 'authorization'): Record<string, unknown> | O5KekFinalAuthorizationInputErrorCode {
  if (!path || path.startsWith('--')) return kind === 'closureGate' ? 'CLOSURE_GATE_INPUT_REQUIRED' : 'AUTHORIZATION_INPUT_REQUIRED';
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return kind === 'closureGate' ? 'CLOSURE_GATE_FILE_READ_FAILED' : 'AUTHORIZATION_FILE_READ_FAILED';
    if (stat.size > MAX_INPUT_BYTES) return kind === 'closureGate' ? 'CLOSURE_GATE_FILE_TOO_LARGE' : 'AUTHORIZATION_FILE_TOO_LARGE';
    return parseO5KekFinalAuthorizationJson(readFileSync(path, 'utf8'), kind);
  } catch {
    return kind === 'closureGate' ? 'CLOSURE_GATE_FILE_READ_FAILED' : 'AUTHORIZATION_FILE_READ_FAILED';
  }
}

const closureGate = readJson(argValue('--closure-gate'), 'closureGate');
if (typeof closureGate === 'string') inputError(closureGate);
const authorization = readJson(argValue('--authorization'), 'authorization');
if (typeof authorization === 'string') inputError(authorization);

const report = buildO5KekFinalAuthorizationReport(closureGate, authorization);
process.stdout.write(process.argv.includes('--json') ? formatO5KekFinalAuthorizationJson(report) : formatO5KekFinalAuthorizationText(report));
if (o5KekFinalAuthorizationHasFailures(report)) process.exit(1);

