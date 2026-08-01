import { Client } from 'pg';

import { loadDbConfig } from '../../config/env.js';
import {
  checkLocatorValue,
  deriveDeletionIntentId,
  deriveProjectedEntryId,
  deriveProjectedVersionId,
  deriveSourceId,
  normalizeProjectedPath,
  probeOffsetsFor,
  PROJECTION_DEGRADED_REASONS,
  PROJECTION_LIMITS,
  PROJECTION_PROBE_PLAN,
  type ProjectionDegradedReason,
  type ProjectionSourceKind,
} from './manifest-v1.js';

// Projection Phase 1 — the stable source registration boundary.
//
// WHY THIS EXISTS. The manifest needs, per projected entry, an exact byte length, an mtime, a visibility state
// and a STABLE source descriptor. The catalog holds none of them: `items` is an opaque id and an encrypted
// identity blob. Rather than let the publisher guess — a guessed size is a file no media server can play, and
// a guessed locator is a file it cannot open — the control plane is given a place to SAY them, and this is it.
//
// WHAT IT REFUSES, AT THE BOUNDARY RATHER THAN AT PUBLISH TIME.
//   - A path that is not normalized under Phase 0 §6. Normalization is a refusal, never a rewrite.
//   - A locator that is URL-shaped or credential-shaped, using the CONTRACT's own check, so an operator is
//     told at registration what admission would have told them three generations later.
//   - A probe set that is not the fixed plan for the declared size. "The producer picked the offsets" is not
//     a proof a verifier can re-run, so an offset that is not the one the size implies is not stored.
//   - A source list that is not a contiguous preference order from zero with no tie.
//
// WHAT IT CANNOT HOLD. An access URL, a signed link, a token, a header, an expiry or a lease. Not because
// nothing writes one, but because the value would fail `checkLocatorValue` here and the column CHECK in the
// database after that. Access material is the daemon's, in memory, and it never reaches a durable surface.
//
// IT CONTACTS NOTHING. No provider, no endpoint, no media server, and no media file: a byte-identity proof is
// an input to this function, asserted by whoever registered it, not something computed by reaching out.

export class RegistrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RegistrationError';
  }
}

/** Anything that can run a parameterised statement. Lets a caller reuse a transaction. */
export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ProbeInput {
  readonly position: string;
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}

export interface VersionRegistration {
  /** The control plane's own stable key for one exact byte stream. Reused = the same projected version. */
  readonly versionKey: string;
  readonly sizeBytes: number;
  /** `YYYY-MM-DDTHH:MM:SS.sssZ`. Exactly what will be published; there is no rounding downstream. */
  readonly mtime: string;
  /** The byte-identity proof, or null. Required as soon as an entry has two sources or a version is shared. */
  readonly probes?: readonly ProbeInput[] | null;
}

export interface SourceRegistration {
  readonly kind: ProjectionSourceKind;
  /** A configured local root id, or a configured HTTP Range endpoint id. */
  readonly rootId: string;
  /** The relative path under that root, or the opaque object reference at that endpoint. */
  readonly objectRef: string;
  readonly preference?: number;
  readonly sourceGeneration?: number;
}

export interface EntryRegistration {
  /** The catalog record this projected entry belongs to. The manifest's `logicalMediaId`. */
  readonly itemId: string;
  readonly versionKey: string;
  readonly path: string;
  readonly sources: readonly SourceRegistration[];
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requireTimestamp(value: string, field: string): string {
  if (!TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new RegistrationError('TIMESTAMP_INVALID', `${field} must be an exact millisecond UTC timestamp`);
  }
  return value;
}

/** Register a configured local root or HTTP Range endpoint. A locator may only name one of these. */
export async function registerRoot(db: Queryable, rootId: string, kind: ProjectionSourceKind): Promise<void> {
  if (!ID_LABEL.test(rootId)) throw new RegistrationError('ROOT_ID_INVALID', 'a root id is a lower-case label');
  if (kind !== 'local' && kind !== 'http-range') {
    throw new RegistrationError('ROOT_KIND_INVALID', 'a root is local or http-range');
  }
  await db.query('SELECT cat_projection_root_register($1, $2)', [rootId, kind]);
}

/**
 * Assert one exact byte stream, and return its derived id.
 *
 * The probe plan is CHECKED against the declared size rather than accepted. A proof at offsets the size does
 * not imply is not a proof of anything, and storing it would produce a manifest the daemon refuses.
 */
export async function registerVersion(db: Queryable, version: VersionRegistration): Promise<string> {
  if (!VERSION_KEY.test(version.versionKey)) {
    throw new RegistrationError('VERSION_KEY_INVALID', 'a version key is a short opaque label');
  }
  if (!Number.isSafeInteger(version.sizeBytes) || version.sizeBytes < 0
    || version.sizeBytes > PROJECTION_LIMITS.MAX_SIZE_BYTES) {
    throw new RegistrationError('VERSION_SIZE_INVALID', 'a projected version needs an exact byte length');
  }
  requireTimestamp(version.mtime, 'mtime');

  const probes = version.probes ?? null;
  if (probes !== null) {
    const expected = probeOffsetsFor(version.sizeBytes);
    if (probes.length !== expected.length) {
      throw new RegistrationError('VERSION_PROBE_COUNT', 'the probe plan is fixed by the size, not chosen');
    }
    for (let index = 0; index < expected.length; index += 1) {
      const want = expected[index];
      const got = probes[index];
      if (want === undefined || got === undefined || got.position !== want.position
        || got.offset !== want.offset || got.length !== want.length) {
        throw new RegistrationError('VERSION_PROBE_OFFSET', 'a probe is not at the offset its size implies');
      }
      if (!/^[0-9a-f]{64}$/.test(got.sha256)) {
        throw new RegistrationError('VERSION_PROBE_DIGEST', 'a probe digest is 64 lower-case hex characters');
      }
    }
  }

  const versionId = deriveProjectedVersionId(version.versionKey);
  await db.query('SELECT cat_projection_version_register($1, $2, $3, $4, $5, $6)', [
    versionId, version.versionKey, version.sizeBytes, version.mtime,
    probes === null ? null : PROJECTION_PROBE_PLAN.WINDOW_BYTES,
    probes === null ? null : JSON.stringify(probes),
  ]);
  return versionId;
}

/**
 * Register a projected entry and its whole source set, and return its derived id.
 *
 * The id is derived from the PATH, which is what makes Phase 0 §3.5.2 structural: a carried entry cannot move
 * (its id would change, and a changed id is a different entry), and a corrected path arrives as a new entry —
 * a deletion and an addition, both of which a media server is told about honestly.
 */
export async function registerEntry(db: Queryable, entry: EntryRegistration): Promise<string> {
  if (!UUID.test(entry.itemId)) {
    throw new RegistrationError('ITEM_ID_INVALID', 'a projected entry belongs to a catalog record');
  }
  const path = normalizeProjectedPath(entry.path);
  if (!path.ok) throw new RegistrationError(`PATH_${path.code ?? 'INVALID'}`, 'the projected path is not normalized');
  if (entry.sources.length === 0) {
    throw new RegistrationError('ENTRY_SOURCES_EMPTY', 'an entry with no source is an entry that cannot be read');
  }
  if (entry.sources.length > PROJECTION_LIMITS.MAX_SOURCES_PER_ENTRY) {
    throw new RegistrationError('ENTRY_TOO_MANY_SOURCES', 'too many sources for one entry');
  }

  const versionId = deriveProjectedVersionId(entry.versionKey);
  const entryId = deriveProjectedEntryId(path.path as string);

  const payload = entry.sources.map((source, index) => {
    if (!ID_LABEL.test(source.rootId)) {
      throw new RegistrationError('LOCATOR_ROOT_ID_INVALID', 'a locator names a configured root by label');
    }
    if (source.kind === 'local') {
      const relative = normalizeProjectedPath(source.objectRef);
      if (!relative.ok) {
        throw new RegistrationError('LOCATOR_RELATIVE_PATH_INVALID', 'a local locator is a normalized relative path');
      }
    }
    const problem = checkLocatorValue(source.objectRef);
    if (problem !== null) throw new RegistrationError(problem, 'the locator value is not an opaque reference');
    const preference = source.preference ?? index;
    return {
      sourceId: deriveSourceId(source.kind, source.kind === 'local'
        ? { rootId: source.rootId, relativePath: source.objectRef }
        : { endpointId: source.rootId, objectRef: source.objectRef }),
      kind: source.kind,
      preference,
      sourceGeneration: source.sourceGeneration ?? 1,
      rootId: source.rootId,
      objectRef: source.objectRef,
    };
  });

  // A total order from zero with no tie and no gap. "Which source do I try next" must never be a coin flip.
  const preferences = payload.map((source) => source.preference).sort((a, b) => a - b);
  for (let expected = 0; expected < preferences.length; expected += 1) {
    if (preferences[expected] !== expected) {
      throw new RegistrationError('SOURCE_PREFERENCE_NOT_CONTIGUOUS',
        'source preferences must be a contiguous order from zero');
    }
  }

  await db.query('SELECT cat_projection_entry_register($1, $2, $3, $4)',
    [entryId, entry.itemId, versionId, path.path]);
  await db.query('SELECT cat_projection_entry_set_sources($1, $2)', [entryId, JSON.stringify(payload)]);
  return entryId;
}

/** Back to `available`, clearing whatever state it was in. This is what makes a retirement recoverable. */
export async function restoreEntry(db: Queryable, entryId: string): Promise<void> {
  await db.query('SELECT cat_projection_entry_set_available($1)', [entryId]);
}

/**
 * Mark an entry degraded.
 *
 * IT STAYS IN THE NAMESPACE, with its inode, size and mtime untouched. That is the whole point: a source the
 * control plane cannot reach must not be able to shrink a media server's library.
 */
export async function degradeEntry(
  db: Queryable, entryId: string, reason: ProjectionDegradedReason, since: string,
): Promise<void> {
  if (!(PROJECTION_DEGRADED_REASONS as readonly string[]).includes(reason)) {
    throw new RegistrationError('DEGRADED_REASON_INVALID', 'the degraded reason is a closed set');
  }
  await db.query('SELECT cat_projection_entry_degrade($1, $2, $3)',
    [entryId, reason, requireTimestamp(since, 'since')]);
}

/**
 * Declare an intent to delete, with a grace deadline.
 *
 * A RETIRING ENTRY IS FULLY READABLE, and the deadline passing removes nothing. Deletion is a separate,
 * explicit generation, which is what makes an accidental removal unreachable rather than merely unlikely.
 */
export async function retireEntry(
  db: Queryable, entryId: string,
  intent: { readonly intentKey: string; readonly declaredAt: string; readonly graceDeadline: string },
): Promise<string> {
  requireTimestamp(intent.declaredAt, 'declaredAt');
  requireTimestamp(intent.graceDeadline, 'graceDeadline');
  if (Date.parse(intent.graceDeadline) <= Date.parse(intent.declaredAt)) {
    throw new RegistrationError('GRACE_NOT_IN_FUTURE', 'a grace deadline is strictly after its declaration');
  }
  const intentId = deriveDeletionIntentId(intent.intentKey);
  await db.query('SELECT cat_projection_entry_retire($1, $2, $3, $4)',
    [entryId, intentId, intent.declaredAt, intent.graceDeadline]);
  return intentId;
}

/** Open a registry connection, run `fn`, and close it whatever happens. */
export async function withRegistry<T>(
  fn: (db: Queryable) => Promise<T>, connectionString?: string,
): Promise<T> {
  const client = new Client({ connectionString: connectionString ?? loadDbConfig().databaseUrl });
  await client.connect();
  try {
    return await fn(client as unknown as Queryable);
  } finally {
    await client.end().catch(() => undefined);
  }
}
