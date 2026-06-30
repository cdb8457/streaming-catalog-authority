import { EVENT_REGISTRY, KNOWN_REF_TYPES } from '../catalog/events.js';

/**
 * No-leak gate.
 *
 * Two functions, two jobs:
 *
 *   - validateEventPayload(type, payload): the PRIMARY defense for the event
 *     log. Each event type has a typed payload schema. Keys must match exactly;
 *     values must satisfy a type/enum/range. This is what structurally keeps
 *     content identity out of events — an attacker cannot smuggle a title in as
 *     `op` because `op` must be a member of the fixed ref-type enum.
 *
 *   - assertNoLeak(value): a generic signature scanner over string values. Used
 *     as defense-in-depth inside payload validation, and reusable on its own for
 *     log redaction in Phase 2. It only matches things with an unambiguous
 *     signature (URLs, magnets, urn topics, raw hashes, JWTs, key/bearer shapes)
 *     — never plain words, so legitimate labels like "infohash" pass.
 */

export class NoLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoLeakError';
  }
}

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
 * Returns `text` with every secret/identity signature replaced by a marker. The
 * non-throwing counterpart of assertNoLeak, for log redaction (Phase 2).
 */
export function redactString(text: string): string {
  let out = text;
  for (const { re, label } of SIGNATURES) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    out = out.replace(g, `[redacted:${label}]`);
  }
  return out;
}

/** Throws if any string value (recursively) matches a secret/identity signature. */
export function assertNoLeak(value: unknown, path = 'value'): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    for (const { re, label } of SIGNATURES) {
      if (re.test(value)) {
        throw new NoLeakError(`no-leak: value at ${path} matches forbidden ${label} signature`);
      }
    }
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoLeak(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertNoLeak(v, `${path}.${k}`);
    }
    return;
  }
  throw new NoLeakError(`no-leak: unsupported value type at ${path}`);
}

// --- typed payload schemas --------------------------------------------------

type FieldSpec =
  | { kind: 'enum'; values: ReadonlySet<string>; pattern: RegExp }
  | { kind: 'int'; min: number; max: number };

const REF_TYPE_SET: ReadonlySet<string> = new Set(KNOWN_REF_TYPES);

const PAYLOAD_SCHEMAS: Record<string, Record<string, FieldSpec>> = {
  ItemAdded: {},
  ItemForgotten: {},
  ItemRestored: {},
  ProviderRefAttached: {
    op: { kind: 'enum', values: REF_TYPE_SET, pattern: /^[a-z0-9_]{1,32}$/ },
  },
  BehavioralSignal: {
    weight: { kind: 'int', min: 1, max: 1000 },
  },
};

/**
 * Validates an event payload against its type's schema, then runs the signature
 * scan as a backstop. Throws NoLeakError on any violation. Called before any
 * event is persisted.
 */
export function validateEventPayload(type: string, payload: Record<string, unknown>): void {
  // Messages are deliberately generic: a rejected value or key must never be
  // interpolated into an error string, or it would leak into logs.
  if (!(type in EVENT_REGISTRY)) {
    throw new NoLeakError('no-leak: unknown event type');
  }
  const schema = PAYLOAD_SCHEMAS[type] ?? {};
  const allowed = new Set(Object.keys(schema));

  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new NoLeakError('no-leak: forbidden payload field for event');
    }
  }

  for (const [key, spec] of Object.entries(schema)) {
    const v = payload[key];
    if (v === undefined) {
      throw new NoLeakError('no-leak: missing required payload field');
    }
    if (spec.kind === 'enum') {
      if (typeof v !== 'string' || !spec.values.has(v) || !spec.pattern.test(v)) {
        throw new NoLeakError('no-leak: payload field is not an allowed value');
      }
    } else {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < spec.min || v > spec.max) {
        throw new NoLeakError('no-leak: payload field is out of range');
      }
    }
  }

  // defense in depth: even within the schema, no string may carry a signature
  assertNoLeak(payload, 'payload');
}
