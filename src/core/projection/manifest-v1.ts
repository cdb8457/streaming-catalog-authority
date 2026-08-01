import { createHash } from 'node:crypto';

// Projection Phase 0 — the projection manifest, version 1.
//
// WHAT THIS IS. The control plane (this TypeScript/PostgreSQL application) publishes an immutable,
// versioned, digest-checked artifact describing a read-only regular-file namespace. A separate small Go
// daemon (`projectiond`) loads that artifact into immutable memory and serves the namespace. This module is
// the NORMATIVE definition of that artifact: the shape, the identity rules, the visibility lifecycle and the
// admission checks. `docs/schemas/projection-manifest-v1.schema.json` is the portable JSON Schema rendering
// of the same contract, and `test/projection-manifest-v1.ts` proves the two agree field for field.
//
// WHAT THIS MODULE IS NOT. It reads a value and returns a value. It opens no file, makes no network call,
// spawns no process and touches no database. It therefore cannot scan a media path, cannot contact a
// provider and cannot be talked into it by anything in a manifest, because no code path here could act on
// such an instruction. The daemon is the only thing that touches a source, and the daemon is not this.
//
// UNAVAILABILITY IS NEVER ABSENCE. Every rule below that looks paranoid is that one rule wearing a
// different hat. A generation is a complete assertion of the namespace; it is not a scan result. A routine
// generation may not omit an entry its predecessor carried — omission is only reachable through a deletion
// generation, which requires an entry to have been affirmatively marked `retiring` first, with a grace
// deadline that has passed. A control plane that cannot see a source publishes `degraded`, or publishes
// nothing at all and lets the daemon keep serving what it already admitted. Neither of those can shrink a
// media server's library, and no failed, short or timed-out scan can reach the namespace at all.
//
// PROBLEMS NAME CODES AND POSITIONS, NEVER VALUES. Every message is of the form
// `ENTRY_PATH_NOT_NORMALIZED at entries[12].path`. A path, a locator or an object reference never appears in
// a problem, a log line or a report.

export const PROJECTION_MANIFEST_FORMAT = 'catalog-authority.projection-manifest';
export const PROJECTION_MANIFEST_VERSION = 1;

/**
 * Bounds. Every one of them is a refusal, not a truncation: a manifest that exceeds one is rejected whole,
 * and the daemon keeps serving its last admitted generation.
 */
export const PROJECTION_LIMITS = Object.freeze({
  /**
   * The artifact is read into memory before it is parsed, so its size is bounded first. The two bounds are
   * sized against each other deliberately: an entry with the full three-probe byte identity is under 1 KiB
   * of JSON, so a manifest at MAX_ENTRIES fits inside MAX_ARTIFACT_BYTES with room. A bound that could never
   * be reached because the other one always fires first would be a bound that says nothing.
   */
  MAX_ARTIFACT_BYTES: 256 * 1024 * 1024,
  MAX_ENTRIES: 200_000,
  MAX_SOURCES_PER_ENTRY: 8,
  MAX_PATH_BYTES: 4096,
  MAX_PATH_SEGMENT_BYTES: 255,
  /** JSON carries no int64. A size above 2^53-1 cannot survive a parse, so it is refused rather than rounded. */
  MAX_SIZE_BYTES: Number.MAX_SAFE_INTEGER,
  MAX_LOCATOR_VALUE_LENGTH: 512,
  MAX_PROBES_PER_SOURCE: 3,
  /** How many distinct problems a rejection reports before it stops listing them. */
  MAX_REPORTED_PROBLEMS: 50,
} as const);

/**
 * The byte-identity probe plan. Two sources may carry the same projected-version id ONLY with proof, and
 * this is the proof: the exact byte size plus partial hashes at fixed, size-derived offsets. The offsets are
 * fixed by this table rather than chosen per manifest, because "the producer picked the offsets" is not a
 * proof of anything a verifier can re-run.
 */
export const PROJECTION_PROBE_PLAN = Object.freeze({
  /** The probe window, in bytes. Also the byte budget the Phase 1 amplification gate is measured against. */
  WINDOW_BYTES: 1_048_576,
  /** In order. `head` at 0; `middle` at floor(size/2) - floor(window/2), clamped; `tail` at size - window. */
  OFFSETS: Object.freeze(['head', 'middle', 'tail'] as const),
  /** Below three windows the three probes would overlap, so a file that small is proved by one whole-file probe. */
  SINGLE_PROBE_BELOW_BYTES: 3 * 1_048_576,
} as const);

export type ProbePosition = (typeof PROJECTION_PROBE_PLAN.OFFSETS)[number];

/** The visibility lifecycle. These three are the whole set; there is no fourth and no "missing". */
export const PROJECTION_VISIBILITY_STATES = Object.freeze(['available', 'degraded', 'retiring'] as const);
export type ProjectionVisibility = (typeof PROJECTION_VISIBILITY_STATES)[number];

/** Phase 1 has exactly two source adapters. A third is a Phase 2 decision, not a manifest field. */
export const PROJECTION_SOURCE_KINDS = Object.freeze(['local', 'http-range'] as const);
export type ProjectionSourceKind = (typeof PROJECTION_SOURCE_KINDS)[number];

/** Why an entry is degraded. A closed set, because the daemon routes on it and an operator reads it. */
export const PROJECTION_DEGRADED_REASONS = Object.freeze([
  'source-unreachable',
  'source-rejected',
  'byte-identity-mismatch',
  'locator-expired',
  'endpoint-circuit-open',
  'operator-hold',
] as const);
export type ProjectionDegradedReason = (typeof PROJECTION_DEGRADED_REASONS)[number];

export const PROJECTION_GENERATION_INTENTS = Object.freeze(['routine', 'deletion'] as const);
export type ProjectionGenerationIntent = (typeof PROJECTION_GENERATION_INTENTS)[number];

/**
 * The shrink guard, defense in depth. The succession rules already make an accidental deletion structurally
 * unreachable (an entry must be `retiring` past its grace deadline before it can be deleted at all). This is
 * the second lock on the same door: a deletion generation that removes more than this must carry an explicit
 * acknowledgement bound to the exact id set it removes.
 */
export const PROJECTION_SHRINK_GUARD = Object.freeze({
  MAX_DELETIONS_ABSOLUTE: 50,
  MAX_DELETIONS_FRACTION: 0.1,
} as const);

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_LABEL = /^sha256:[0-9a-f]{64}$/;
const ID_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DECIMAL_UINT = /^[1-9][0-9]{0,19}$/;
const PRINTABLE_ASCII = /^[\x21-\x7e][\x20-\x7e]*$/;

/**
 * Words that must never appear in a locator, in any case. A provider token is read from a secret file by the
 * daemon and composed into a request there; it is not a manifest field, and a locator that looks like it
 * might be carrying one is refused rather than redacted. `://`, `?`, `&` and `@` are refused separately: a
 * v1 locator names a configured endpoint and an opaque object reference, never a URL.
 */
const LOCATOR_FORBIDDEN_WORDS = Object.freeze([
  'token', 'apikey', 'api_key', 'secret', 'password', 'passwd', 'auth', 'bearer',
  'signature', 'session', 'cookie', 'credential',
] as const);
const LOCATOR_FORBIDDEN_CHARS = Object.freeze(['://', '?', '&', '@', '\\'] as const);

// ---------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------

export interface ProbeDigest {
  readonly position: ProbePosition;
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}

export interface ByteIdentity {
  readonly sizeBytes: number;
  readonly probeWindowBytes: number;
  readonly probes: readonly ProbeDigest[];
}

export interface LocalLocator {
  readonly rootId: string;
  readonly relativePath: string;
}

export interface HttpRangeLocator {
  readonly endpointId: string;
  readonly objectRef: string;
  readonly expiresAt: string | null;
}

export interface ProjectionSource {
  readonly sourceId: string;
  readonly kind: ProjectionSourceKind;
  readonly preference: number;
  readonly sourceGeneration: number;
  readonly locator: LocalLocator | HttpRangeLocator;
  readonly byteIdentity: ByteIdentity | null;
}

export interface DegradedState {
  readonly reason: ProjectionDegradedReason;
  readonly since: string;
}

export interface RetiringState {
  readonly deletionIntentId: string;
  readonly declaredAt: string;
  readonly graceDeadline: string;
}

export interface ProjectedEntry {
  readonly projectedEntryId: string;
  readonly logicalMediaId: string;
  readonly projectedVersionId: string;
  readonly path: string;
  readonly nodeKind: 'file';
  readonly sizeBytes: number;
  readonly mtime: string;
  readonly mode: number;
  readonly readOnly: true;
  readonly inode: string;
  readonly visibility: ProjectionVisibility;
  readonly degraded: DegradedState | null;
  readonly retiring: RetiringState | null;
  readonly sources: readonly ProjectionSource[];
}

export interface GenerationPredecessor {
  readonly generationId: string;
  readonly sequence: number;
  readonly manifestDigest: string;
}

export interface GenerationProvenance {
  readonly producer: string;
  readonly producerVersion: string;
  readonly controlPlaneSchemaVersion: number;
  readonly sourceSnapshotDigest: string;
  readonly probeWindowBytes: number;
}

export interface GenerationRelocation {
  readonly projectedEntryId: string;
  readonly previousPath: string;
}

export interface GenerationAdmission {
  readonly intent: ProjectionGenerationIntent;
  readonly entryCount: number;
  readonly deletions: readonly string[];
  readonly relocations: readonly GenerationRelocation[];
  readonly deletionGuardAcknowledged: boolean;
  readonly deletionGuardDigest: string | null;
}

export interface ManifestGeneration {
  readonly generationId: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly predecessor: GenerationPredecessor | null;
  readonly provenance: GenerationProvenance;
  readonly admission: GenerationAdmission;
}

export interface ProjectionManifestV1 {
  readonly format: typeof PROJECTION_MANIFEST_FORMAT;
  readonly version: 1;
  readonly generation: ManifestGeneration;
  readonly entries: readonly ProjectedEntry[];
}

export interface ManifestProblem {
  readonly code: string;
  readonly at: string;
}

export interface ManifestValidation {
  readonly ok: boolean;
  readonly problems: readonly ManifestProblem[];
  readonly manifest: ProjectionManifestV1 | null;
}

// ---------------------------------------------------------------------------------------------------------
// Path normalization and inode derivation
// ---------------------------------------------------------------------------------------------------------

export interface PathNormalization {
  readonly ok: boolean;
  readonly path: string | null;
  readonly code: string | null;
}

/**
 * A projected path is relative, slash-separated, NFC-normalized and free of anything a filesystem or a media
 * server would have to interpret. The check is a REFUSAL rather than a rewrite: a producer that emits
 * `a//b` is emitting a path it does not have a stable rule for, and accepting it here would mean the
 * daemon's namespace disagrees with the control plane's idea of it.
 */
export function normalizeProjectedPath(raw: unknown): PathNormalization {
  if (typeof raw !== 'string') return { ok: false, path: null, code: 'PATH_NOT_A_STRING' };
  if (raw.length === 0) return { ok: false, path: null, code: 'PATH_EMPTY' };
  if (Buffer.byteLength(raw, 'utf8') > PROJECTION_LIMITS.MAX_PATH_BYTES) {
    return { ok: false, path: null, code: 'PATH_TOO_LONG' };
  }
  if (raw !== raw.normalize('NFC')) return { ok: false, path: null, code: 'PATH_NOT_NFC' };
  if (raw.includes('\\')) return { ok: false, path: null, code: 'PATH_BACKSLASH' };
  if (raw.startsWith('/')) return { ok: false, path: null, code: 'PATH_ABSOLUTE' };
  if (raw.endsWith('/')) return { ok: false, path: null, code: 'PATH_TRAILING_SLASH' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) return { ok: false, path: null, code: 'PATH_CONTROL_CHARACTER' };

  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, path: null, code: 'PATH_EMPTY_SEGMENT' };
    if (segment === '.' || segment === '..') return { ok: false, path: null, code: 'PATH_RELATIVE_SEGMENT' };
    if (segment !== segment.trim()) return { ok: false, path: null, code: 'PATH_SEGMENT_PADDED' };
    if (Buffer.byteLength(segment, 'utf8') > PROJECTION_LIMITS.MAX_PATH_SEGMENT_BYTES) {
      return { ok: false, path: null, code: 'PATH_SEGMENT_TOO_LONG' };
    }
  }
  return { ok: true, path: raw, code: null };
}

/**
 * The case-and-form fold two paths are compared under. Unraid shares, macOS clients and SMB all reach this
 * namespace, and on any of them `A.mkv` and `a.mkv` are one file. Two entries that fold together are a
 * refusal here rather than a collision there.
 */
export function foldProjectedPath(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/**
 * `ino` is derived from the projected-version id and from nothing else — never from the path, never from the
 * active source, never from a provider identifier. That is the whole reason a failover, a link refresh or a
 * path correction cannot make a media server treat a file it already knows as a new one.
 *
 * The domain separator is part of the input so that a future ino rule can exist without ever colliding with
 * this one. The top bit is cleared because a signed 64-bit inode is what the FUSE ABI and every consumer of
 * it actually carries, and the low 1024 are reserved for the mount root and the daemon's own nodes.
 */
export function deriveInode(projectedVersionId: string): string {
  const digest = createHash('sha256').update(`projectiond.ino.v1\n${projectedVersionId}`, 'utf8').digest();
  let value = digest.readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn;
  if (value < 1024n) value += 1024n;
  return value.toString(10);
}

/** The fixed probe offsets for a size. Returns [] for a zero-byte file: there is nothing to probe. */
export function probeOffsetsFor(sizeBytes: number, windowBytes: number = PROJECTION_PROBE_PLAN.WINDOW_BYTES):
Array<{ position: ProbePosition; offset: number; length: number }> {
  if (sizeBytes <= 0) return [];
  if (sizeBytes < PROJECTION_PROBE_PLAN.SINGLE_PROBE_BELOW_BYTES) {
    return [{ position: 'head', offset: 0, length: sizeBytes }];
  }
  const middle = Math.floor(sizeBytes / 2) - Math.floor(windowBytes / 2);
  return [
    { position: 'head', offset: 0, length: windowBytes },
    { position: 'middle', offset: middle, length: windowBytes },
    { position: 'tail', offset: sizeBytes - windowBytes, length: windowBytes },
  ];
}

/** Canonical JSON: recursively key-sorted, no whitespace. The input to every digest this contract names. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** `sha256:<hex>` over the EXACT artifact bytes. This is what a pointer file carries and what chains. */
export function manifestDigestOfBytes(bytes: Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** `sha256:<hex>` over the sorted deletion id set. A deletion acknowledgement is bound to exactly this. */
export function deletionAcknowledgementDigest(deletions: readonly string[]): string {
  const sorted = [...deletions].sort();
  return `sha256:${createHash('sha256').update(canonicalJson(sorted), 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------------------------------------
// Static validation of a single manifest
// ---------------------------------------------------------------------------------------------------------

class Problems {
  private readonly list: ManifestProblem[] = [];
  add(code: string, at: string): void {
    if (this.list.length < PROJECTION_LIMITS.MAX_REPORTED_PROBLEMS) this.list.push({ code, at });
  }
  get any(): boolean { return this.list.length > 0; }
  get all(): readonly ManifestProblem[] { return this.list; }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));

function checkNoUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], at: string, p: Problems): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) p.add('UNKNOWN_FIELD', `${at}.${key}`);
  }
}

function validateByteIdentity(value: unknown, sizeBytes: number, at: string, p: Problems): void {
  if (!isRecord(value)) { p.add('BYTE_IDENTITY_MALFORMED', at); return; }
  checkNoUnknownKeys(value, ['sizeBytes', 'probeWindowBytes', 'probes'], at, p);
  if (value['sizeBytes'] !== sizeBytes) p.add('BYTE_IDENTITY_SIZE_MISMATCH', `${at}.sizeBytes`);
  const windowBytes = value['probeWindowBytes'];
  if (windowBytes !== PROJECTION_PROBE_PLAN.WINDOW_BYTES) p.add('BYTE_IDENTITY_WINDOW_INVALID', `${at}.probeWindowBytes`);
  const probes = value['probes'];
  if (!Array.isArray(probes)) { p.add('BYTE_IDENTITY_PROBES_MALFORMED', `${at}.probes`); return; }
  if (probes.length > PROJECTION_LIMITS.MAX_PROBES_PER_SOURCE) p.add('BYTE_IDENTITY_TOO_MANY_PROBES', `${at}.probes`);

  const expected = probeOffsetsFor(sizeBytes, PROJECTION_PROBE_PLAN.WINDOW_BYTES);
  if (probes.length !== expected.length) { p.add('BYTE_IDENTITY_PROBE_COUNT', `${at}.probes`); return; }
  for (let index = 0; index < expected.length; index += 1) {
    const probeAt = `${at}.probes[${index}]`;
    const probe = probes[index];
    const want = expected[index];
    if (!isRecord(probe) || want === undefined) { p.add('BYTE_IDENTITY_PROBE_MALFORMED', probeAt); continue; }
    checkNoUnknownKeys(probe, ['position', 'offset', 'length', 'sha256'], probeAt, p);
    if (probe['position'] !== want.position) p.add('BYTE_IDENTITY_PROBE_POSITION', `${probeAt}.position`);
    if (probe['offset'] !== want.offset) p.add('BYTE_IDENTITY_PROBE_OFFSET', `${probeAt}.offset`);
    if (probe['length'] !== want.length) p.add('BYTE_IDENTITY_PROBE_LENGTH', `${probeAt}.length`);
    if (typeof probe['sha256'] !== 'string' || !HEX64.test(probe['sha256'])) {
      p.add('BYTE_IDENTITY_PROBE_DIGEST', `${probeAt}.sha256`);
    }
  }
}

function scanLocatorValue(value: string, at: string, p: Problems): void {
  if (value.length === 0 || value.length > PROJECTION_LIMITS.MAX_LOCATOR_VALUE_LENGTH) {
    p.add('LOCATOR_VALUE_LENGTH', at);
    return;
  }
  if (!PRINTABLE_ASCII.test(value)) { p.add('LOCATOR_VALUE_NOT_PRINTABLE_ASCII', at); return; }
  for (const forbidden of LOCATOR_FORBIDDEN_CHARS) {
    if (value.includes(forbidden)) { p.add('LOCATOR_VALUE_URL_SHAPED', at); return; }
  }
  const lowered = value.toLowerCase();
  for (const word of LOCATOR_FORBIDDEN_WORDS) {
    if (lowered.includes(word)) { p.add('LOCATOR_VALUE_CREDENTIAL_SHAPED', at); return; }
  }
}

function validateSource(value: unknown, sizeBytes: number, at: string, p: Problems): ProjectionSource | null {
  if (!isRecord(value)) { p.add('SOURCE_MALFORMED', at); return null; }
  checkNoUnknownKeys(value, ['sourceId', 'kind', 'preference', 'sourceGeneration', 'locator', 'byteIdentity'], at, p);

  const sourceId = value['sourceId'];
  if (typeof sourceId !== 'string' || !/^src_[0-9a-f]{32}$/.test(sourceId)) p.add('SOURCE_ID_INVALID', `${at}.sourceId`);

  const kind = value['kind'];
  if (typeof kind !== 'string' || !(PROJECTION_SOURCE_KINDS as readonly string[]).includes(kind)) {
    p.add('SOURCE_KIND_INVALID', `${at}.kind`);
  }
  if (!isInteger(value['preference'], 0, PROJECTION_LIMITS.MAX_SOURCES_PER_ENTRY - 1)) {
    p.add('SOURCE_PREFERENCE_INVALID', `${at}.preference`);
  }
  if (!isInteger(value['sourceGeneration'], 1, Number.MAX_SAFE_INTEGER)) {
    p.add('SOURCE_GENERATION_INVALID', `${at}.sourceGeneration`);
  }

  const locator = value['locator'];
  if (!isRecord(locator)) {
    p.add('LOCATOR_MALFORMED', `${at}.locator`);
  } else if (kind === 'local') {
    checkNoUnknownKeys(locator, ['rootId', 'relativePath'], `${at}.locator`, p);
    const rootId = locator['rootId'];
    if (typeof rootId !== 'string' || !ID_LABEL.test(rootId)) p.add('LOCATOR_ROOT_ID_INVALID', `${at}.locator.rootId`);
    const relative = normalizeProjectedPath(locator['relativePath']);
    if (!relative.ok) p.add('LOCATOR_RELATIVE_PATH_INVALID', `${at}.locator.relativePath`);
    else scanLocatorValue(relative.path ?? '', `${at}.locator.relativePath`, p);
  } else if (kind === 'http-range') {
    checkNoUnknownKeys(locator, ['endpointId', 'objectRef', 'expiresAt'], `${at}.locator`, p);
    const endpointId = locator['endpointId'];
    if (typeof endpointId !== 'string' || !ID_LABEL.test(endpointId)) {
      p.add('LOCATOR_ENDPOINT_ID_INVALID', `${at}.locator.endpointId`);
    }
    const objectRef = locator['objectRef'];
    if (typeof objectRef !== 'string') p.add('LOCATOR_OBJECT_REF_INVALID', `${at}.locator.objectRef`);
    else scanLocatorValue(objectRef, `${at}.locator.objectRef`, p);
    const expiresAt = locator['expiresAt'];
    if (expiresAt !== null && !isTimestamp(expiresAt)) p.add('LOCATOR_EXPIRES_AT_INVALID', `${at}.locator.expiresAt`);
  }

  const byteIdentity = value['byteIdentity'];
  if (byteIdentity !== null) validateByteIdentity(byteIdentity, sizeBytes, `${at}.byteIdentity`, p);

  return p.any ? null : (value as unknown as ProjectionSource);
}

function validateEntry(value: unknown, at: string, p: Problems): void {
  if (!isRecord(value)) { p.add('ENTRY_MALFORMED', at); return; }
  checkNoUnknownKeys(value, [
    'projectedEntryId', 'logicalMediaId', 'projectedVersionId', 'path', 'nodeKind', 'sizeBytes',
    'mtime', 'mode', 'readOnly', 'inode', 'visibility', 'degraded', 'retiring', 'sources',
  ], at, p);

  const entryId = value['projectedEntryId'];
  if (typeof entryId !== 'string' || !/^pe_[0-9a-f]{64}$/.test(entryId)) p.add('ENTRY_ID_INVALID', `${at}.projectedEntryId`);
  const mediaId = value['logicalMediaId'];
  if (typeof mediaId !== 'string' || !UUID.test(mediaId)) p.add('LOGICAL_MEDIA_ID_INVALID', `${at}.logicalMediaId`);
  const versionId = value['projectedVersionId'];
  if (typeof versionId !== 'string' || !/^pv_[0-9a-f]{64}$/.test(versionId)) {
    p.add('PROJECTED_VERSION_ID_INVALID', `${at}.projectedVersionId`);
  }

  const path = normalizeProjectedPath(value['path']);
  if (!path.ok) p.add(`ENTRY_${path.code ?? 'PATH_INVALID'}`, `${at}.path`);

  // Directories are DERIVED by the daemon from the file paths above; they are not manifest rows. A directory
  // has no byte stream, so it has no projected version, so an ino derived from a projected version could not
  // exist for one — and an ino derived from a directory's path would be an identity that changes when the
  // path is corrected, which is the exact failure this contract exists to prevent.
  if (value['nodeKind'] !== 'file') p.add('ENTRY_NODE_KIND_INVALID', `${at}.nodeKind`);

  const sizeBytes = value['sizeBytes'];
  if (!isInteger(sizeBytes, 0, PROJECTION_LIMITS.MAX_SIZE_BYTES)) p.add('ENTRY_SIZE_INVALID', `${at}.sizeBytes`);
  if (!isTimestamp(value['mtime'])) p.add('ENTRY_MTIME_INVALID', `${at}.mtime`);
  // 0o444. The namespace is read-only in the mode bits as well as in the operation table, so a media server
  // that consults permissions before attempting a write never attempts one.
  if (value['mode'] !== 0o444) p.add('ENTRY_MODE_INVALID', `${at}.mode`);
  if (value['readOnly'] !== true) p.add('ENTRY_READ_ONLY_INVALID', `${at}.readOnly`);

  const inode = value['inode'];
  if (typeof inode !== 'string' || !DECIMAL_UINT.test(inode)) {
    p.add('ENTRY_INODE_INVALID', `${at}.inode`);
  } else if (typeof versionId === 'string' && inode !== deriveInode(versionId)) {
    p.add('ENTRY_INODE_NOT_DERIVED', `${at}.inode`);
  }

  const visibility = value['visibility'];
  if (typeof visibility !== 'string' || !(PROJECTION_VISIBILITY_STATES as readonly string[]).includes(visibility)) {
    p.add('ENTRY_VISIBILITY_INVALID', `${at}.visibility`);
  }

  const degraded = value['degraded'];
  if (visibility === 'degraded') {
    if (!isRecord(degraded)) p.add('ENTRY_DEGRADED_STATE_REQUIRED', `${at}.degraded`);
    else {
      checkNoUnknownKeys(degraded, ['reason', 'since'], `${at}.degraded`, p);
      const reason = degraded['reason'];
      if (typeof reason !== 'string' || !(PROJECTION_DEGRADED_REASONS as readonly string[]).includes(reason)) {
        p.add('ENTRY_DEGRADED_REASON_INVALID', `${at}.degraded.reason`);
      }
      if (!isTimestamp(degraded['since'])) p.add('ENTRY_DEGRADED_SINCE_INVALID', `${at}.degraded.since`);
    }
  } else if (degraded !== null) {
    p.add('ENTRY_DEGRADED_STATE_FORBIDDEN', `${at}.degraded`);
  }

  const retiring = value['retiring'];
  if (visibility === 'retiring') {
    if (!isRecord(retiring)) p.add('ENTRY_RETIRING_STATE_REQUIRED', `${at}.retiring`);
    else {
      checkNoUnknownKeys(retiring, ['deletionIntentId', 'declaredAt', 'graceDeadline'], `${at}.retiring`, p);
      const intentId = retiring['deletionIntentId'];
      if (typeof intentId !== 'string' || !HEX32.test(intentId)) {
        p.add('ENTRY_DELETION_INTENT_ID_INVALID', `${at}.retiring.deletionIntentId`);
      }
      const declaredAt = retiring['declaredAt'];
      const graceDeadline = retiring['graceDeadline'];
      if (!isTimestamp(declaredAt)) p.add('ENTRY_RETIRING_DECLARED_AT_INVALID', `${at}.retiring.declaredAt`);
      if (!isTimestamp(graceDeadline)) p.add('ENTRY_RETIRING_GRACE_DEADLINE_INVALID', `${at}.retiring.graceDeadline`);
      if (isTimestamp(declaredAt) && isTimestamp(graceDeadline) && Date.parse(graceDeadline) <= Date.parse(declaredAt)) {
        p.add('ENTRY_RETIRING_GRACE_NOT_IN_FUTURE', `${at}.retiring.graceDeadline`);
      }
    }
  } else if (retiring !== null) {
    p.add('ENTRY_RETIRING_STATE_FORBIDDEN', `${at}.retiring`);
  }

  const sources = value['sources'];
  if (!Array.isArray(sources)) { p.add('ENTRY_SOURCES_MALFORMED', `${at}.sources`); return; }
  // An entry with no source is an entry that cannot be read. That is not "degraded", it is a producer bug,
  // and admitting it would put a file in the namespace that answers EIO forever with no state saying why.
  if (sources.length < 1) p.add('ENTRY_SOURCES_EMPTY', `${at}.sources`);
  if (sources.length > PROJECTION_LIMITS.MAX_SOURCES_PER_ENTRY) p.add('ENTRY_TOO_MANY_SOURCES', `${at}.sources`);

  const size = isInteger(sizeBytes, 0, PROJECTION_LIMITS.MAX_SIZE_BYTES) ? sizeBytes : -1;
  const preferences = new Set<number>();
  const sourceIds = new Set<string>();
  for (let index = 0; index < sources.length; index += 1) {
    const sourceAt = `${at}.sources[${index}]`;
    validateSource(sources[index], size, sourceAt, p);
    const source = sources[index];
    if (isRecord(source)) {
      const preference = source['preference'];
      if (typeof preference === 'number') {
        if (preferences.has(preference)) p.add('SOURCE_PREFERENCE_DUPLICATE', `${sourceAt}.preference`);
        preferences.add(preference);
      }
      const sourceId = source['sourceId'];
      if (typeof sourceId === 'string') {
        if (sourceIds.has(sourceId)) p.add('SOURCE_ID_DUPLICATE', `${sourceAt}.sourceId`);
        sourceIds.add(sourceId);
      }
    }
  }
  // Preference is a total order starting at zero: "which source do I try next" must never have a gap or a
  // tie, because a tie is a coin flip and a coin flip is a source that a failover cannot reason about.
  for (let expected = 0; expected < sources.length; expected += 1) {
    if (!preferences.has(expected)) { p.add('SOURCE_PREFERENCE_NOT_CONTIGUOUS', `${at}.sources`); break; }
  }

  // Multi-source entries need proof. Two locators pointing at bytes nobody compared are two DIFFERENT
  // projected versions wearing one id, and a mid-handle failover between them would hand a player the middle
  // of a different file.
  if (sources.length > 1) {
    const identities = sources.map((source) => (isRecord(source) ? canonicalJson(source['byteIdentity']) : 'null'));
    for (let index = 0; index < identities.length; index += 1) {
      if (identities[index] === 'null') p.add('MULTI_SOURCE_BYTE_IDENTITY_REQUIRED', `${at}.sources[${index}].byteIdentity`);
    }
    const first = identities[0];
    for (let index = 1; index < identities.length; index += 1) {
      if (identities[index] !== first) p.add('MULTI_SOURCE_BYTE_IDENTITY_MISMATCH', `${at}.sources[${index}].byteIdentity`);
    }
  }
}

function validateGeneration(value: unknown, entryCount: number, p: Problems): void {
  if (!isRecord(value)) { p.add('GENERATION_MALFORMED', 'generation'); return; }
  checkNoUnknownKeys(value, ['generationId', 'sequence', 'createdAt', 'predecessor', 'provenance', 'admission'], 'generation', p);

  const generationId = value['generationId'];
  if (typeof generationId !== 'string' || !/^gen_[0-9a-f]{32}$/.test(generationId)) {
    p.add('GENERATION_ID_INVALID', 'generation.generationId');
  }
  const sequence = value['sequence'];
  if (!isInteger(sequence, 1, Number.MAX_SAFE_INTEGER)) p.add('GENERATION_SEQUENCE_INVALID', 'generation.sequence');
  if (!isTimestamp(value['createdAt'])) p.add('GENERATION_CREATED_AT_INVALID', 'generation.createdAt');

  const predecessor = value['predecessor'];
  if (sequence === 1) {
    if (predecessor !== null) p.add('GENERATION_FIRST_HAS_PREDECESSOR', 'generation.predecessor');
  } else if (!isRecord(predecessor)) {
    p.add('GENERATION_PREDECESSOR_REQUIRED', 'generation.predecessor');
  } else {
    checkNoUnknownKeys(predecessor, ['generationId', 'sequence', 'manifestDigest'], 'generation.predecessor', p);
    const predecessorId = predecessor['generationId'];
    if (typeof predecessorId !== 'string' || !/^gen_[0-9a-f]{32}$/.test(predecessorId)) {
      p.add('GENERATION_PREDECESSOR_ID_INVALID', 'generation.predecessor.generationId');
    }
    if (typeof sequence === 'number' && predecessor['sequence'] !== sequence - 1) {
      p.add('GENERATION_PREDECESSOR_SEQUENCE_INVALID', 'generation.predecessor.sequence');
    }
    const digest = predecessor['manifestDigest'];
    if (typeof digest !== 'string' || !SHA256_LABEL.test(digest)) {
      p.add('GENERATION_PREDECESSOR_DIGEST_INVALID', 'generation.predecessor.manifestDigest');
    }
  }

  const provenance = value['provenance'];
  if (!isRecord(provenance)) {
    p.add('PROVENANCE_MALFORMED', 'generation.provenance');
  } else {
    checkNoUnknownKeys(provenance, [
      'producer', 'producerVersion', 'controlPlaneSchemaVersion', 'sourceSnapshotDigest', 'probeWindowBytes',
    ], 'generation.provenance', p);
    if (provenance['producer'] !== 'catalog-authority') p.add('PROVENANCE_PRODUCER_INVALID', 'generation.provenance.producer');
    const producerVersion = provenance['producerVersion'];
    if (typeof producerVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(producerVersion)) {
      p.add('PROVENANCE_PRODUCER_VERSION_INVALID', 'generation.provenance.producerVersion');
    }
    if (!isInteger(provenance['controlPlaneSchemaVersion'], 1, 10_000)) {
      p.add('PROVENANCE_SCHEMA_VERSION_INVALID', 'generation.provenance.controlPlaneSchemaVersion');
    }
    const snapshotDigest = provenance['sourceSnapshotDigest'];
    if (typeof snapshotDigest !== 'string' || !SHA256_LABEL.test(snapshotDigest)) {
      p.add('PROVENANCE_SNAPSHOT_DIGEST_INVALID', 'generation.provenance.sourceSnapshotDigest');
    }
    if (provenance['probeWindowBytes'] !== PROJECTION_PROBE_PLAN.WINDOW_BYTES) {
      p.add('PROVENANCE_PROBE_WINDOW_INVALID', 'generation.provenance.probeWindowBytes');
    }
  }

  const admission = value['admission'];
  if (!isRecord(admission)) { p.add('ADMISSION_MALFORMED', 'generation.admission'); return; }
  checkNoUnknownKeys(admission, [
    'intent', 'entryCount', 'deletions', 'relocations', 'deletionGuardAcknowledged', 'deletionGuardDigest',
  ], 'generation.admission', p);

  const intent = admission['intent'];
  if (typeof intent !== 'string' || !(PROJECTION_GENERATION_INTENTS as readonly string[]).includes(intent)) {
    p.add('ADMISSION_INTENT_INVALID', 'generation.admission.intent');
  }
  if (admission['entryCount'] !== entryCount) p.add('ADMISSION_ENTRY_COUNT_MISMATCH', 'generation.admission.entryCount');

  const deletions = admission['deletions'];
  if (!Array.isArray(deletions)) {
    p.add('ADMISSION_DELETIONS_MALFORMED', 'generation.admission.deletions');
  } else {
    const seen = new Set<string>();
    for (let index = 0; index < deletions.length; index += 1) {
      const id = deletions[index];
      if (typeof id !== 'string' || !/^pe_[0-9a-f]{64}$/.test(id)) {
        p.add('ADMISSION_DELETION_ID_INVALID', `generation.admission.deletions[${index}]`);
      } else if (seen.has(id)) {
        p.add('ADMISSION_DELETION_ID_DUPLICATE', `generation.admission.deletions[${index}]`);
      } else seen.add(id);
    }
    // A routine generation cannot remove anything. Deletion is a separate, declared kind of generation, and
    // that is what makes "the scan came back short" structurally unable to become "the file is gone".
    if (intent === 'routine' && deletions.length > 0) {
      p.add('ADMISSION_ROUTINE_GENERATION_DELETES', 'generation.admission.deletions');
    }
    if (intent === 'deletion' && deletions.length === 0) {
      p.add('ADMISSION_DELETION_GENERATION_EMPTY', 'generation.admission.deletions');
    }
    const acknowledged = admission['deletionGuardAcknowledged'];
    if (typeof acknowledged !== 'boolean') {
      p.add('ADMISSION_DELETION_GUARD_INVALID', 'generation.admission.deletionGuardAcknowledged');
    }
    const guardDigest = admission['deletionGuardDigest'];
    if (acknowledged === true) {
      if (typeof guardDigest !== 'string' || !SHA256_LABEL.test(guardDigest)) {
        p.add('ADMISSION_DELETION_GUARD_DIGEST_INVALID', 'generation.admission.deletionGuardDigest');
      } else if (guardDigest !== deletionAcknowledgementDigest(deletions as string[])) {
        p.add('ADMISSION_DELETION_GUARD_DIGEST_MISMATCH', 'generation.admission.deletionGuardDigest');
      }
    } else if (guardDigest !== null) {
      p.add('ADMISSION_DELETION_GUARD_DIGEST_FORBIDDEN', 'generation.admission.deletionGuardDigest');
    }
  }

  const relocations = admission['relocations'];
  if (!Array.isArray(relocations)) {
    p.add('ADMISSION_RELOCATIONS_MALFORMED', 'generation.admission.relocations');
  } else {
    const seen = new Set<string>();
    for (let index = 0; index < relocations.length; index += 1) {
      const at = `generation.admission.relocations[${index}]`;
      const relocation = relocations[index];
      if (!isRecord(relocation)) { p.add('ADMISSION_RELOCATION_MALFORMED', at); continue; }
      checkNoUnknownKeys(relocation, ['projectedEntryId', 'previousPath'], at, p);
      const id = relocation['projectedEntryId'];
      if (typeof id !== 'string' || !/^pe_[0-9a-f]{64}$/.test(id)) p.add('ADMISSION_RELOCATION_ID_INVALID', `${at}.projectedEntryId`);
      else if (seen.has(id)) p.add('ADMISSION_RELOCATION_ID_DUPLICATE', `${at}.projectedEntryId`);
      else seen.add(id);
      if (!normalizeProjectedPath(relocation['previousPath']).ok) {
        p.add('ADMISSION_RELOCATION_PREVIOUS_PATH_INVALID', `${at}.previousPath`);
      }
    }
  }
}

/**
 * Validate one manifest in isolation. This is admission checks 1 through 4 and 6 through 10 of the Phase 0
 * contract; the predecessor and shrink-guard checks that need the previous generation are `validateSuccession`.
 *
 * Either every rule holds and the caller gets a fully typed manifest, or the caller gets every problem found
 * and no manifest. There is no state in which some of a generation was admitted.
 */
export function validateManifestV1(input: unknown): ManifestValidation {
  const p = new Problems();
  if (!isRecord(input)) {
    return { ok: false, problems: [{ code: 'MANIFEST_NOT_AN_OBJECT', at: '' }], manifest: null };
  }
  checkNoUnknownKeys(input, ['format', 'version', 'generation', 'entries'], '', p);
  if (input['format'] !== PROJECTION_MANIFEST_FORMAT) p.add('MANIFEST_FORMAT_INVALID', 'format');
  if (input['version'] !== PROJECTION_MANIFEST_VERSION) p.add('MANIFEST_VERSION_INVALID', 'version');

  const entries = input['entries'];
  if (!Array.isArray(entries)) {
    p.add('MANIFEST_ENTRIES_MALFORMED', 'entries');
    return { ok: false, problems: p.all, manifest: null };
  }
  if (entries.length > PROJECTION_LIMITS.MAX_ENTRIES) p.add('MANIFEST_TOO_MANY_ENTRIES', 'entries');

  validateGeneration(input['generation'], entries.length, p);
  for (let index = 0; index < entries.length; index += 1) validateEntry(entries[index], `entries[${index}]`, p);

  // Cross-entry rules. These are the ones a per-entry schema cannot express, and they are the ones that
  // decide whether a namespace is coherent.
  const byPath = new Map<string, number>();
  const byFoldedPath = new Map<string, number>();
  const byEntryId = new Map<string, number>();
  const byInode = new Map<string, string>();
  const byVersion = new Map<string, { sizeBytes: unknown; mtime: unknown; inode: unknown; identity: string }>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry)) continue;
    const at = `entries[${index}]`;

    const path = entry['path'];
    if (typeof path === 'string') {
      if (byPath.has(path)) p.add('DUPLICATE_PATH', `${at}.path`);
      else byPath.set(path, index);
      const folded = foldProjectedPath(path);
      if (byFoldedPath.has(folded)) p.add('PATH_CASE_COLLISION', `${at}.path`);
      else byFoldedPath.set(folded, index);
    }

    const entryId = entry['projectedEntryId'];
    if (typeof entryId === 'string') {
      if (byEntryId.has(entryId)) p.add('DUPLICATE_PROJECTED_ENTRY_ID', `${at}.projectedEntryId`);
      else byEntryId.set(entryId, index);
    }

    const versionId = entry['projectedVersionId'];
    const inode = entry['inode'];
    if (typeof inode === 'string' && typeof versionId === 'string') {
      const owner = byInode.get(inode);
      // Two DIFFERENT projected versions deriving the same ino is a 2^63 collision, not a producer mistake.
      // It is still a refusal: a namespace where two files share an inode is a namespace where a media
      // server's dedupe silently drops one of them.
      if (owner !== undefined && owner !== versionId) p.add('INODE_COLLISION', `${at}.inode`);
      byInode.set(inode, versionId);
    }

    if (typeof versionId === 'string') {
      const sources = Array.isArray(entry['sources']) ? entry['sources'] : [];
      const first = sources.length > 0 && isRecord(sources[0]) ? (sources[0] as Record<string, unknown>)['byteIdentity'] : null;
      const identity = canonicalJson(first);
      const seen = byVersion.get(versionId);
      if (seen === undefined) {
        byVersion.set(versionId, { sizeBytes: entry['sizeBytes'], mtime: entry['mtime'], inode, identity });
      } else {
        // Size and mtime belong to the projected VERSION, not to the entry. Two entries naming one version
        // and disagreeing about its size is the metadata instability that makes a library re-scan forever.
        if (seen.sizeBytes !== entry['sizeBytes']) p.add('SHARED_VERSION_SIZE_MISMATCH', `${at}.sizeBytes`);
        if (seen.mtime !== entry['mtime']) p.add('SHARED_VERSION_MTIME_MISMATCH', `${at}.mtime`);
        if (seen.inode !== inode) p.add('SHARED_VERSION_INODE_MISMATCH', `${at}.inode`);
        if (identity === 'null' || seen.identity === 'null') {
          p.add('SHARED_VERSION_BYTE_IDENTITY_REQUIRED', `${at}.sources[0].byteIdentity`);
        } else if (identity !== seen.identity) {
          p.add('SHARED_VERSION_BYTE_IDENTITY_MISMATCH', `${at}.sources[0].byteIdentity`);
        }
      }
    }
  }

  const admission = isRecord(input['generation']) ? (input['generation'] as Record<string, unknown>)['admission'] : null;
  if (isRecord(admission)) {
    const deletions = Array.isArray(admission['deletions']) ? admission['deletions'] : [];
    for (let index = 0; index < deletions.length; index += 1) {
      const id = deletions[index];
      // A deletion generation removes an entry by naming it. An entry that is both present and deleted is a
      // producer that has not decided, and admitting it would leave the daemon to guess.
      if (typeof id === 'string' && byEntryId.has(id)) {
        p.add('DELETED_ENTRY_STILL_PRESENT', `generation.admission.deletions[${index}]`);
      }
    }
    const relocations = Array.isArray(admission['relocations']) ? admission['relocations'] : [];
    for (let index = 0; index < relocations.length; index += 1) {
      const relocation = relocations[index];
      if (isRecord(relocation)) {
        const id = relocation['projectedEntryId'];
        if (typeof id === 'string' && !byEntryId.has(id)) {
          p.add('RELOCATED_ENTRY_ABSENT', `generation.admission.relocations[${index}].projectedEntryId`);
        }
      }
    }
  }

  if (p.any) return { ok: false, problems: p.all, manifest: null };
  return { ok: true, problems: [], manifest: input as unknown as ProjectionManifestV1 };
}

// ---------------------------------------------------------------------------------------------------------
// Succession: admitting a generation against the one already admitted
// ---------------------------------------------------------------------------------------------------------

export interface AdmittedGeneration {
  readonly manifest: ProjectionManifestV1;
  /** `sha256:<hex>` over the EXACT bytes of the admitted artifact, as recorded when it was admitted. */
  readonly manifestDigest: string;
}

export interface SuccessionValidation {
  readonly ok: boolean;
  readonly problems: readonly ManifestProblem[];
  /** Entries a media server should be told about: new projected entry ids only. */
  readonly additions: readonly string[];
  /** Entries a media server should be told about: completed explicit deletions only. */
  readonly deletions: readonly string[];
  /** Path corrections. Real in the namespace, and deliberately NOT a refresh trigger. */
  readonly relocations: readonly string[];
  /** Entries that changed to or from `degraded`. Never a refresh trigger, in either direction. */
  readonly degradedChanges: readonly string[];
}

/**
 * Validate a candidate generation against the generation currently admitted. `nowIso` is the daemon's clock
 * at admission time, supplied rather than read, because a module that reads a clock cannot be tested against
 * a grace deadline.
 */
export function validateSuccession(
  previous: AdmittedGeneration,
  next: ProjectionManifestV1,
  nowIso: string,
): SuccessionValidation {
  const p = new Problems();
  const additions: string[] = [];
  const deletions: string[] = [];
  const relocations: string[] = [];
  const degradedChanges: string[] = [];

  const prev = previous.manifest;
  if (next.generation.sequence !== prev.generation.sequence + 1) {
    p.add('SUCCESSION_SEQUENCE_NOT_NEXT', 'generation.sequence');
  }
  const predecessor = next.generation.predecessor;
  if (predecessor === null) {
    p.add('SUCCESSION_PREDECESSOR_MISSING', 'generation.predecessor');
  } else {
    if (predecessor.generationId !== prev.generation.generationId) {
      p.add('SUCCESSION_PREDECESSOR_ID_MISMATCH', 'generation.predecessor.generationId');
    }
    if (predecessor.sequence !== prev.generation.sequence) {
      p.add('SUCCESSION_PREDECESSOR_SEQUENCE_MISMATCH', 'generation.predecessor.sequence');
    }
    if (predecessor.manifestDigest !== previous.manifestDigest) {
      p.add('SUCCESSION_PREDECESSOR_DIGEST_MISMATCH', 'generation.predecessor.manifestDigest');
    }
  }
  if (Date.parse(next.generation.createdAt) < Date.parse(prev.generation.createdAt)) {
    p.add('SUCCESSION_CREATED_AT_REGRESSES', 'generation.createdAt');
  }

  const prevById = new Map(prev.entries.map((entry) => [entry.projectedEntryId, entry]));
  const nextById = new Map(next.entries.map((entry) => [entry.projectedEntryId, entry]));
  const declaredDeletions = new Set(next.generation.admission.deletions);
  const relocationByEntry = new Map(next.generation.admission.relocations.map((r) => [r.projectedEntryId, r]));

  for (const [entryId, before] of prevById) {
    const after = nextById.get(entryId);
    if (after === undefined) {
      // THE RULE. An entry may leave the namespace only by being named in a deletion generation, and only
      // after it was affirmatively marked `retiring` and its grace deadline passed. Nothing about a scan,
      // a provider outage or an unreachable control plane can reach this branch.
      if (!declaredDeletions.has(entryId)) {
        p.add('ENTRY_DISAPPEARED_WITHOUT_DELETION', `previous:${entryId.slice(0, 11)}`);
        continue;
      }
      if (before.visibility !== 'retiring' || before.retiring === null) {
        p.add('DELETED_ENTRY_WAS_NOT_RETIRING', `previous:${entryId.slice(0, 11)}`);
        continue;
      }
      if (Date.parse(before.retiring.graceDeadline) > Date.parse(nowIso)) {
        p.add('DELETED_ENTRY_GRACE_NOT_ELAPSED', `previous:${entryId.slice(0, 11)}`);
        continue;
      }
      deletions.push(entryId);
      continue;
    }

    // Identity is immutable across generations. This is the single property that makes a media server's
    // library survive a failover, a link refresh, a path correction and a daemon restart.
    if (after.logicalMediaId !== before.logicalMediaId) p.add('LOGICAL_MEDIA_ID_CHANGED', `previous:${entryId.slice(0, 11)}`);
    if (after.projectedVersionId !== before.projectedVersionId) p.add('PROJECTED_VERSION_ID_CHANGED', `previous:${entryId.slice(0, 11)}`);
    if (after.inode !== before.inode) p.add('INODE_CHANGED', `previous:${entryId.slice(0, 11)}`);
    if (after.sizeBytes !== before.sizeBytes) p.add('SIZE_CHANGED', `previous:${entryId.slice(0, 11)}`);
    if (after.mtime !== before.mtime) p.add('MTIME_CHANGED', `previous:${entryId.slice(0, 11)}`);

    if (after.path !== before.path) {
      const relocation = relocationByEntry.get(entryId);
      if (relocation === undefined || relocation.previousPath !== before.path) {
        p.add('PATH_CHANGED_WITHOUT_RELOCATION', `previous:${entryId.slice(0, 11)}`);
      } else relocations.push(entryId);
    }
    // A retiring entry does NOT expire into deletion. Its grace deadline passing changes nothing on its own:
    // it stays readable, in the namespace, until an operator's explicit deletion generation removes it. An
    // entry may also be un-retired, which is what makes a mistaken retirement recoverable.
    if (before.visibility === 'retiring' && after.visibility === 'retiring' && after.retiring !== null
      && before.retiring !== null && after.retiring.deletionIntentId !== before.retiring.deletionIntentId) {
      p.add('RETIREMENT_INTENT_CHANGED', `previous:${entryId.slice(0, 11)}`);
    }
    if ((before.visibility === 'degraded') !== (after.visibility === 'degraded')) degradedChanges.push(entryId);
  }

  for (const [entryId] of nextById) {
    if (!prevById.has(entryId)) additions.push(entryId);
  }
  for (const declared of declaredDeletions) {
    if (!prevById.has(declared)) p.add('DELETION_NAMES_UNKNOWN_ENTRY', `deletion:${declared.slice(0, 11)}`);
  }

  // The shrink guard, defense in depth on top of a rule that already makes this unreachable.
  const budget = Math.max(
    PROJECTION_SHRINK_GUARD.MAX_DELETIONS_ABSOLUTE,
    Math.floor(prev.entries.length * PROJECTION_SHRINK_GUARD.MAX_DELETIONS_FRACTION),
  );
  if (declaredDeletions.size > budget && next.generation.admission.deletionGuardAcknowledged !== true) {
    p.add('SHRINK_GUARD_UNACKNOWLEDGED', 'generation.admission.deletionGuardAcknowledged');
  }

  return {
    ok: !p.any,
    problems: p.all,
    additions: additions.sort(),
    deletions: deletions.sort(),
    relocations: relocations.sort(),
    degradedChanges: degradedChanges.sort(),
  };
}

/**
 * What a media server is told after a swap. Additions and completed explicit deletions, and nothing else.
 *
 * A relocation is a real rename in the namespace and the media server will observe it on its own next scan;
 * it does not earn a refresh request, because a path correction is a correction and not new content. A
 * change to or from `degraded` earns nothing at all — that is the whole point of `degraded`, and a refresh
 * on it would be exactly the library churn this design exists to prevent.
 */
export function refreshRequestFor(succession: SuccessionValidation): {
  readonly refreshRequired: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
} {
  return {
    refreshRequired: succession.additions.length > 0 || succession.deletions.length > 0,
    added: succession.additions,
    removed: succession.deletions,
  };
}
