/**
 * No-leak gate for event payloads.
 *
 * Two layers, both enforcing identity by STRUCTURE rather than by guessing at
 * meaning:
 *
 *   1. Key allowlist — a payload may only contain keys that are known to be
 *      operational and non-identifying. Anything else (title, name, year,
 *      external_ids, value, hash, magnet, url, key, token, ...) is rejected
 *      simply because it is not on the list. This is what structurally keeps
 *      content identity out of the log.
 *
 *   2. Signature scan — defence in depth on string VALUES. We only match things
 *      that have an unambiguous signature (URLs, magnet links, urn topics, raw
 *      sha1/sha256 hashes, JWTs, api-key/bearer shapes). We deliberately do NOT
 *      pattern-match plain words like "infohash": an operational LABEL such as
 *      ref_type = "infohash" is legitimate and must pass. The infohash *value*
 *      is blocked structurally (it can never reach a payload), not by word scan.
 */

export class NoLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoLeakError';
  }
}

/** Keys permitted anywhere inside an event payload. Keep this list tiny. */
const ALLOWED_PAYLOAD_KEYS = new Set<string>(['op', 'weight']);

/** String-value signatures that indicate a leaked secret or content identity. */
const SIGNATURES: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /https?:\/\//i, label: 'url' },
  { re: /magnet:\?/i, label: 'magnet link' },
  { re: /\burn:/i, label: 'urn topic' },
  { re: /\bxt=/i, label: 'exact-topic param' },
  { re: /\b[a-f0-9]{40}\b/i, label: 'sha1 / infohash value' },
  { re: /\b[a-f0-9]{64}\b/i, label: 'sha256 value' },
  { re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, label: 'jwt' },
  { re: /\b[sprk]k_[A-Za-z0-9]{16,}\b/, label: 'api key' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{12,}/i, label: 'bearer token' },
];

/**
 * Throws NoLeakError if `payload` contains a forbidden key (anywhere, including
 * nested) or a string value matching a secret/identity signature. Called BEFORE
 * any event is persisted.
 */
export function assertNoLeak(payload: unknown, path = 'payload'): void {
  if (payload === null || payload === undefined) return;

  if (typeof payload === 'string') {
    for (const { re, label } of SIGNATURES) {
      if (re.test(payload)) {
        throw new NoLeakError(`no-leak: value at ${path} matches forbidden ${label} signature`);
      }
    }
    return;
  }

  if (typeof payload === 'number' || typeof payload === 'boolean') return;

  if (Array.isArray(payload)) {
    payload.forEach((v, i) => assertNoLeak(v, `${path}[${i}]`));
    return;
  }

  if (typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (!ALLOWED_PAYLOAD_KEYS.has(key)) {
        throw new NoLeakError(`no-leak: forbidden payload key "${key}" at ${path}`);
      }
      assertNoLeak(value, `${path}.${key}`);
    }
    return;
  }

  throw new NoLeakError(`no-leak: unsupported payload type at ${path}`);
}
