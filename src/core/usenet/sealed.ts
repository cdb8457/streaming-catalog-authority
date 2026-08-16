import { createHash } from 'node:crypto';
import { inspect } from 'node:util';

// Projection Phase 9 — the values that must never be printed, as a TYPE rather than as a discipline.
//
// WHAT §4 OF THE CONTRACT FORBIDS, AND WHY A RULE WAS NOT ENOUGH. Phase 9 must not place an NNTP or SABnzbd
// credential anywhere a human or a log can see it, and its closure rule 9 says secrets, NZB/indexer URLs,
// article ids and completed source paths appear in NONE of the preserved evidence. Every previous tranche
// enforced that with a scrubber at the edge — redact the line just before it is written. A scrubber is a
// filter over a value that already exists as a string, and every one of them has the same failure: the value
// reaches somewhere the scrubber is not. `console.log(job)`, a thrown Error whose message interpolates a
// field, a JSON.stringify of a whole result object, a metric label, a template literal in a new code path
// written six months later by somebody who never read the rule.
//
// SO THE VALUE IS NOT A STRING. It is an object with no string conversion that yields it. `toString`,
// `toJSON` and Node's `util.inspect` custom hook all return the same fixed marker, so the four ways a value
// accidentally becomes text — interpolation, concatenation, JSON.stringify and console.log — are all closed by
// construction. Reading the value takes `.reveal()`, which is a verb a reviewer can grep for and which appears
// in exactly the places that must compose a request or open a file.
//
// WHAT A DIAGNOSTIC GETS INSTEAD. `fingerprint()` — twelve hex characters of a domain-separated digest. It is
// stable, so an operator can say "the same key as yesterday" or "a different NZB from the one that failed",
// and it is not reversible, so saying it leaks nothing. Every operator-facing surface in this tranche names a
// sealed value by its fingerprint and by nothing else.
//
// THIS MODULE OPENS NO FILE, MAKES NO REQUEST AND READS NO ENVIRONMENT.

/**
 * What a sealed value IS. The kind travels in the marker and in the fingerprint's domain separator, so two
 * different kinds of secret can never produce the same fingerprint from the same bytes.
 */
export const SEALED_KINDS = Object.freeze([
  /** A SABnzbd API key, read from a restrictive file. Never argv, never an environment value. */
  'sab-api-key',
  /** An operator-approved NZB or indexer URL. Submitted, never logged, never stored in the clear. */
  'nzb-source',
  /** An absolute host path under the worker's completed-download root. Opened, never printed. */
  'completed-path',
  /** A worker-side job reference (SABnzbd's `nzo_id`). Opaque provider state; correlated, never published. */
  'job-ref',
] as const);

export type SealedKind = (typeof SEALED_KINDS)[number];

/** The one text a sealed value can turn into, whichever of the four accidental routes is taken. */
export function sealedMarkerFor(kind: SealedKind): string {
  return `[sealed:${kind}]`;
}

const FINGERPRINT_DOMAIN = 'projection.phase9.sealed.v1';
/** Twelve hex characters. Long enough that two live values do not collide, short enough to read aloud. */
export const SEALED_FINGERPRINT_LENGTH = 12;

/** Nothing this large is one of the four kinds above; a larger input is a mistake about what is being sealed. */
export const SEALED_MAX_BYTES = 8 * 1024;

export class SealedValueError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'SealedValueError';
  }
}

/**
 * A value that is carried, compared and fingerprinted, and that cannot be printed.
 *
 * The payload is a private class field (`#value`), not a closure variable and not a property: a private field
 * is absent from `Object.keys`, from the spread operator, from `structuredClone` and from `JSON.stringify`'s
 * own enumeration, so none of the generic "copy this object" idioms can lift it back out into a plain object
 * that no longer has the guards.
 */
export class SealedValue {
  readonly kind: SealedKind;
  readonly #value: string;
  #fingerprint: string | null = null;

  constructor(kind: SealedKind, value: string) {
    if (!(SEALED_KINDS as readonly string[]).includes(kind)) {
      throw new SealedValueError('SEALED_KIND_UNKNOWN', 'a sealed value names one of the four declared kinds');
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new SealedValueError('SEALED_VALUE_EMPTY', 'a sealed value cannot be empty');
    }
    if (Buffer.byteLength(value, 'utf8') > SEALED_MAX_BYTES) {
      throw new SealedValueError('SEALED_VALUE_TOO_LARGE', 'a sealed value is bounded');
    }
    this.kind = kind;
    this.#value = value;
    Object.freeze(this);
  }

  /** The ONLY way back to the bytes, and the word a reviewer greps for. */
  reveal(): string {
    return this.#value;
  }

  get byteLength(): number {
    return Buffer.byteLength(this.#value, 'utf8');
  }

  /**
   * A stable, non-reversible name for this exact value. Domain-separated by kind, so the same string sealed
   * as a key and as a path fingerprints differently and no report can conflate them.
   */
  fingerprint(): string {
    if (this.#fingerprint === null) {
      const digest = createHash('sha256').update(`${FINGERPRINT_DOMAIN}\n${this.kind}\n${this.#value}`, 'utf8');
      this.#fingerprint = digest.digest('hex').slice(0, SEALED_FINGERPRINT_LENGTH);
    }
    return this.#fingerprint;
  }

  /** Constant-time-ish equality that never returns the value and never short-circuits on a prefix. */
  equals(other: unknown): boolean {
    if (!(other instanceof SealedValue) || other.kind !== this.kind) return false;
    return other.fingerprint() === this.fingerprint();
  }

  toString(): string {
    return sealedMarkerFor(this.kind);
  }

  toJSON(): string {
    return sealedMarkerFor(this.kind);
  }

  [Symbol.toPrimitive](): string {
    return sealedMarkerFor(this.kind);
  }

  get [Symbol.toStringTag](): string {
    return `SealedValue(${this.kind})`;
  }

  [inspect.custom](): string {
    return sealedMarkerFor(this.kind);
  }
}

/** Seal a value. The only constructor call this tranche makes outside a test. */
export function seal(kind: SealedKind, value: string): SealedValue {
  return new SealedValue(kind, value);
}

export function isSealed(value: unknown): value is SealedValue {
  return value instanceof SealedValue;
}

/**
 * The last line of defence, used by every surface that writes evidence.
 *
 * It is NOT a redactor: it does not rewrite, it REFUSES. A structure that still carries a raw secret at the
 * point of being written is a structure whose author believed something untrue about it, and quietly deleting
 * the value would leave that belief in place. `sealedProblems` names the position instead, exactly as the
 * manifest contract names `entries[12].path`.
 *
 * The scan is shape-based rather than word-based: what it looks for is a value that LOOKS like one of the four
 * sealed kinds appearing as a bare string. A caller passes the already-sealed structure, so anything matching
 * is by definition something that escaped a seal.
 */
export function sealedProblems(value: unknown, at = ''): readonly string[] {
  const problems: string[] = [];
  walk(value, at === '' ? 'value' : at, problems, new Set<unknown>(), 0);
  return problems;
}

/** Depth is bounded so a cyclic or adversarially deep structure cannot turn a safety check into a hang. */
const MAX_SCAN_DEPTH = 24;

const RAW_SHAPES: ReadonlyArray<{ readonly code: string; readonly re: RegExp }> = Object.freeze([
  { code: 'RAW_URL', re: /\b(?:https?|ftp|nntp|nntps|news|snews):\/\//i },
  { code: 'RAW_ABSOLUTE_PATH', re: /(?:^|[\s"'=(])(?:\/(?:downloads?|complete|incomplete|media|mnt|data|var|home|usenet)\/)/i },
  { code: 'RAW_WINDOWS_PATH', re: /(?:^|[\s"'=(])[A-Za-z]:\\/ },
  { code: 'RAW_ARTICLE_ID', re: /<[^<>@\s]{6,}@[^<>\s]{2,}>/ },
  { code: 'RAW_API_KEY_QUERY', re: /\bapikey=[^&\s]+/i },
  { code: 'RAW_NZO_ID', re: /\bSABnzbd_nzo_[A-Za-z0-9_-]+/ },
]);

function walk(value: unknown, at: string, problems: string[], seen: Set<unknown>, depth: number): void {
  if (problems.length >= 50) return;
  if (depth > MAX_SCAN_DEPTH) {
    problems.push(`SCAN_DEPTH_EXCEEDED at ${at}`);
    return;
  }
  if (value instanceof SealedValue) return;
  if (typeof value === 'string') {
    for (const shape of RAW_SHAPES) {
      if (shape.re.test(value)) problems.push(`${shape.code} at ${at}`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walk(value[index], `${at}[${index}]`, problems, seen, depth + 1);
    }
    return;
  }
  // AN ERROR IS SCANNED BY ITS MESSAGE, WHICH `Object.entries` CANNOT SEE. `message`, `name` and `stack` are
  // non-enumerable own properties, so an `Error` reached the loop below and came back clean whatever it said
  // — and a thrown `Error` whose message interpolates a path or a URL is the single most likely way one of
  // them reaches a report, because it is the one string in this project that this project did not compose.
  if (value instanceof Error) {
    walk(value.message, `${at}.message`, problems, seen, depth + 1);
    walk(value.name, `${at}.name`, problems, seen, depth + 1);
    if (typeof (value as { cause?: unknown }).cause !== 'undefined') {
      walk((value as { cause?: unknown }).cause, `${at}.cause`, problems, seen, depth + 1);
    }
    // `stack` is deliberately NOT scanned: it names source files by absolute path on every host, so every
    // error would report a `RAW_ABSOLUTE_PATH` and the check would be turned off within a week. A stack is
    // never part of the evidence these surfaces emit; a message routinely is.
  }
  // A `Map` OR A `Set` IS WALKED BY ITS CONTENTS. `Object.entries` on either returns nothing at all, so a
  // structure that carried a raw URL inside one passed this scanner — the last line of defence — clean.
  if (value instanceof Map) {
    let index = 0;
    for (const [key, child] of value.entries()) {
      walk(key, `${at}.key[${index}]`, problems, seen, depth + 1);
      walk(child, `${at}.value[${index}]`, problems, seen, depth + 1);
      index += 1;
      if (problems.length >= 50) return;
    }
    return;
  }
  if (value instanceof Set) {
    let index = 0;
    for (const child of value.values()) {
      walk(child, `${at}.member[${index}]`, problems, seen, depth + 1);
      index += 1;
      if (problems.length >= 50) return;
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    walk(child, `${at}.${key}`, problems, seen, depth + 1);
  }
}

/** Throws unless the structure is clean. Used by the CLI immediately before it prints anything. */
export function assertSealedSafe(value: unknown, at = ''): void {
  const problems = sealedProblems(value, at);
  if (problems.length > 0) {
    throw new SealedValueError('SEALED_LEAK_REFUSED',
      `refusing to emit a structure carrying unsealed identity: ${problems.join('; ')}`);
  }
}
