import type { SecretStore } from '../secrets/secret-store.js';

export type LogSink = (line: string) => void;

export interface RedactingLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * A logger that routes every line through the SecretStore's redaction before it
 * reaches the sink (Phase 2 #2).
 *
 * Two layers: the message string is redacted by literal/signature scan; structured
 * `fields` are redacted **before** serialization (`redactDeep`), so JSON escaping
 * cannot bypass redaction. Prefer passing identity via `fields` over interpolating
 * it into the message string.
 */
export function createRedactingLogger(store: SecretStore, sink: LogSink = (l) => console.log(l)): RedactingLogger {
  const emit = (level: string, message: string, fields?: Record<string, unknown>): void => {
    let line = `[${level}] ${store.redact(message)}`;
    if (fields !== undefined) line += ` ${JSON.stringify(store.redactDeep(fields))}`;
    sink(line);
  };
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
