import type { SecretStore } from '../secrets/secret-store.js';

export type LogSink = (line: string) => void;

export interface RedactingLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * A logger that routes every line through the SecretStore's redaction before it
 * reaches the sink, so application logging cannot emit a URL/key/magnet/token or
 * any registered secret literal in the clear. This is the same no-leak scanner
 * used on event payloads, applied to logs (Phase 2 #2).
 */
export function createRedactingLogger(store: SecretStore, sink: LogSink = (l) => console.log(l)): RedactingLogger {
  const emit = (level: string, message: string): void => sink(`[${level}] ${store.redact(message)}`);
  return {
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  };
}
