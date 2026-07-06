import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export const OPERATOR_UI_LOCAL_AUTH_HEADER = 'x-operator-ui-secret';
export const OPERATOR_UI_LOCAL_AUTH_HEADER_DISPLAY = 'X-Operator-UI-Secret';
export const OPERATOR_UI_LOCAL_AUTH_MAX_SECRET_BYTES = 4096;
export const OPERATOR_UI_LOCAL_AUTH_MIN_SECRET_BYTES = 20;
export const OPERATOR_UI_LOCAL_AUTH_MIN_DISTINCT_CHARS = 8;

export type OperatorUiLocalAuthRuntimeErrorCode =
  | 'OPERATOR_UI_LOCAL_AUTH_SECRET_FILE_REJECTED';

export class OperatorUiLocalAuthRuntimeError extends Error {
  readonly code: OperatorUiLocalAuthRuntimeErrorCode = 'OPERATOR_UI_LOCAL_AUTH_SECRET_FILE_REJECTED';

  constructor() {
    super('Operator UI local auth secret file was rejected safely.');
    this.name = 'OperatorUiLocalAuthRuntimeError';
  }
}

export interface OperatorUiLocalAuthRuntime {
  readonly expectedSecretBytes: Buffer;
  readonly headerName: typeof OPERATOR_UI_LOCAL_AUTH_HEADER;
}

export function loadOperatorUiLocalAuthRuntime(secretFilePath: string): OperatorUiLocalAuthRuntime {
  try {
    const stat = statSync(secretFilePath);
    if (!stat.isFile()) throw new OperatorUiLocalAuthRuntimeError();
    if (stat.size > OPERATOR_UI_LOCAL_AUTH_MAX_SECRET_BYTES) throw new OperatorUiLocalAuthRuntimeError();
    const raw = readFileSync(secretFilePath);
    if (raw.byteLength > OPERATOR_UI_LOCAL_AUTH_MAX_SECRET_BYTES) throw new OperatorUiLocalAuthRuntimeError();
    const normalized = trimOneTrailingNewline(raw);
    if (!isAcceptableSecret(normalized)) throw new OperatorUiLocalAuthRuntimeError();
    return {
      expectedSecretBytes: Buffer.from(normalized),
      headerName: OPERATOR_UI_LOCAL_AUTH_HEADER,
    };
  } catch (err) {
    if (err instanceof OperatorUiLocalAuthRuntimeError) throw err;
    throw new OperatorUiLocalAuthRuntimeError();
  }
}

export function verifyOperatorUiLocalAuthHeader(
  auth: OperatorUiLocalAuthRuntime,
  presentedHeader: string | readonly string[] | undefined,
): boolean {
  if (typeof presentedHeader !== 'string') {
    burnComparison(auth.expectedSecretBytes);
    return false;
  }

  const presented = Buffer.from(presentedHeader, 'utf8');
  if (presented.byteLength !== auth.expectedSecretBytes.byteLength) {
    burnComparison(auth.expectedSecretBytes);
    return false;
  }

  return timingSafeEqual(auth.expectedSecretBytes, presented);
}

function trimOneTrailingNewline(raw: Buffer): Buffer {
  if (raw.byteLength === 0) return raw;
  if (raw[raw.byteLength - 1] !== 0x0A) return raw;
  if (raw.byteLength >= 2 && raw[raw.byteLength - 2] === 0x0D) return raw.subarray(0, raw.byteLength - 2);
  return raw.subarray(0, raw.byteLength - 1);
}

function isAcceptableSecret(secret: Buffer): boolean {
  if (secret.byteLength < OPERATOR_UI_LOCAL_AUTH_MIN_SECRET_BYTES) return false;
  const text = secret.toString('utf8');
  if (text.trim().length === 0) return false;
  if (new Set([...text]).size < OPERATOR_UI_LOCAL_AUTH_MIN_DISTINCT_CHARS) return false;
  return true;
}

function burnComparison(expected: Buffer): void {
  timingSafeEqual(expected, Buffer.alloc(expected.byteLength));
}
