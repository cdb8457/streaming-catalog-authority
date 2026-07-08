import { readFileSync, statSync } from 'node:fs';
import {
  buildSidecarUnraidO4FinalAuthorizationInputErrorReport,
  buildSidecarUnraidO4FinalAuthorizationReport,
  formatSidecarUnraidO4FinalAuthorizationJson,
  formatSidecarUnraidO4FinalAuthorizationText,
  parseSidecarUnraidO4FinalAuthorizationJson,
  sidecarUnraidO4FinalAuthorizationHasFailures,
  type SidecarUnraidO4FinalAuthorizationInputErrorCode,
} from './sidecar-unraid-o4-final-authorization.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: SidecarUnraidO4FinalAuthorizationInputErrorCode): never {
  const report = buildSidecarUnraidO4FinalAuthorizationInputErrorReport(code);
  process.stdout.write(process.argv.includes('--json') ? formatSidecarUnraidO4FinalAuthorizationJson(report) : formatSidecarUnraidO4FinalAuthorizationText(report));
  process.exit(1);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson(path: string | undefined, kind: 'closureGate' | 'authorization'): Record<string, unknown> | SidecarUnraidO4FinalAuthorizationInputErrorCode {
  if (!path || path.startsWith('--')) return kind === 'closureGate' ? 'CLOSURE_GATE_INPUT_REQUIRED' : 'AUTHORIZATION_INPUT_REQUIRED';
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return kind === 'closureGate' ? 'CLOSURE_GATE_FILE_READ_FAILED' : 'AUTHORIZATION_FILE_READ_FAILED';
    if (stat.size > MAX_INPUT_BYTES) return kind === 'closureGate' ? 'CLOSURE_GATE_FILE_TOO_LARGE' : 'AUTHORIZATION_FILE_TOO_LARGE';
    return parseSidecarUnraidO4FinalAuthorizationJson(readFileSync(path, 'utf8'), kind);
  } catch {
    return kind === 'closureGate' ? 'CLOSURE_GATE_FILE_READ_FAILED' : 'AUTHORIZATION_FILE_READ_FAILED';
  }
}

const closureGate = readJson(argValue('--closure-gate'), 'closureGate');
if (typeof closureGate === 'string') inputError(closureGate);
const authorization = readJson(argValue('--authorization'), 'authorization');
if (typeof authorization === 'string') inputError(authorization);

const report = buildSidecarUnraidO4FinalAuthorizationReport(closureGate, authorization);
process.stdout.write(process.argv.includes('--json') ? formatSidecarUnraidO4FinalAuthorizationJson(report) : formatSidecarUnraidO4FinalAuthorizationText(report));
if (sidecarUnraidO4FinalAuthorizationHasFailures(report)) process.exit(1);

