import { readFileSync, statSync } from 'node:fs';
import {
  buildUnraidServiceInstallAuthorizationInputErrorReport,
  buildUnraidServiceInstallAuthorizationReport,
  formatUnraidServiceInstallAuthorizationJson,
  formatUnraidServiceInstallAuthorizationText,
  parseUnraidServiceInstallAuthorizationJson,
  type UnraidServiceInstallAuthorizationInputErrorCode,
  unraidServiceInstallAuthorizationHasFailures,
} from './unraid-service-install-authorization.js';

const MAX_INPUT_BYTES = 64 * 1024;

function inputError(code: UnraidServiceInstallAuthorizationInputErrorCode): never {
  const report = buildUnraidServiceInstallAuthorizationInputErrorReport(code);
  process.stdout.write(process.argv.includes('--json') ? formatUnraidServiceInstallAuthorizationJson(report) : formatUnraidServiceInstallAuthorizationText(report));
  process.exit(1);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson(path: string | undefined, kind: 'approvalGate' | 'authorization'): Record<string, unknown> | UnraidServiceInstallAuthorizationInputErrorCode {
  if (!path || path.startsWith('--')) return kind === 'approvalGate' ? 'APPROVAL_GATE_INPUT_REQUIRED' : 'AUTHORIZATION_INPUT_REQUIRED';
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return kind === 'approvalGate' ? 'APPROVAL_GATE_FILE_READ_FAILED' : 'AUTHORIZATION_FILE_READ_FAILED';
    if (stat.size > MAX_INPUT_BYTES) return kind === 'approvalGate' ? 'APPROVAL_GATE_FILE_TOO_LARGE' : 'AUTHORIZATION_FILE_TOO_LARGE';
    return parseUnraidServiceInstallAuthorizationJson(readFileSync(path, 'utf8'), kind);
  } catch {
    return kind === 'approvalGate' ? 'APPROVAL_GATE_FILE_READ_FAILED' : 'AUTHORIZATION_FILE_READ_FAILED';
  }
}

const approvalGate = readJson(argValue('--approval-gate'), 'approvalGate');
if (typeof approvalGate === 'string') inputError(approvalGate);
const authorization = readJson(argValue('--authorization'), 'authorization');
if (typeof authorization === 'string') inputError(authorization);

const report = buildUnraidServiceInstallAuthorizationReport(approvalGate, authorization);
process.stdout.write(process.argv.includes('--json') ? formatUnraidServiceInstallAuthorizationJson(report) : formatUnraidServiceInstallAuthorizationText(report));
if (unraidServiceInstallAuthorizationHasFailures(report)) process.exit(1);
