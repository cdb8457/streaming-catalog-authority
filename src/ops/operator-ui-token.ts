import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const OPERATOR_UI_TOKEN_DEFAULT_PATH = '/mnt/user/appdata/catalog/secrets/operator_ui_token';
export const OPERATOR_UI_TOKEN_BYTES = 32;

export interface OperatorUiTokenStatus {
  readonly report: 'phase-148-operator-ui-token';
  readonly path: string;
  readonly exists: boolean;
  readonly readable: boolean;
  readonly bytes: number;
  readonly acceptable: boolean;
}

export class OperatorUiTokenError extends Error {
  readonly code = 'OPERATOR_UI_TOKEN_REJECTED';

  constructor(message = 'Operator UI token operation was rejected safely.') {
    super(message);
    this.name = 'OperatorUiTokenError';
  }
}

export function resolveOperatorUiTokenPath(inputPath?: string, env: Record<string, string | undefined> = process.env): string {
  const resolved = inputPath ?? env.OPERATOR_UI_TOKEN_FILE ?? OPERATOR_UI_TOKEN_DEFAULT_PATH;
  if (resolved.trim() === '') throw new OperatorUiTokenError();
  return resolved;
}

export function buildOperatorUiTokenStatus(path: string): OperatorUiTokenStatus {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return { report: 'phase-148-operator-ui-token', path, exists: true, readable: false, bytes: stat.size, acceptable: false };
    }
    const token = readTokenValue(path);
    return {
      report: 'phase-148-operator-ui-token',
      path,
      exists: true,
      readable: true,
      bytes: Buffer.byteLength(token, 'utf8'),
      acceptable: isAcceptableOperatorUiToken(token),
    };
  } catch {
    return { report: 'phase-148-operator-ui-token', path, exists: existsSync(path), readable: false, bytes: 0, acceptable: false };
  }
}

export function readTokenValue(path: string): string {
  const raw = readFileSync(path, 'utf8');
  return raw.replace(/\r?\n$/, '');
}

export function rotateOperatorUiToken(path: string): OperatorUiTokenStatus {
  const token = generateOperatorUiToken();
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tempPath, 0o600);
  } catch {
    // chmod is best-effort on non-POSIX filesystems; the secret still never prints.
  }
  renameSync(tempPath, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // See best-effort note above.
  }
  return buildOperatorUiTokenStatus(path);
}

export function generateOperatorUiToken(): string {
  return randomBytes(OPERATOR_UI_TOKEN_BYTES).toString('base64');
}

export function isAcceptableOperatorUiToken(token: string): boolean {
  return Buffer.byteLength(token, 'utf8') >= 20
    && token.trim().length > 0
    && new Set([...token]).size >= 8;
}
