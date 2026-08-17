import { createHash } from 'node:crypto';
import { constants, existsSync, promises as fsPromises, createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  deriveProjectedEntryId,
  normalizeProjectedPath,
  probeOffsetsFor,
  PROJECTION_PROBE_PLAN,
  type ProbePosition,
  type ProjectedEntry,
} from '../core/projection/manifest-v1.js';
import {
  degradeEntry, registerEntry, registerRoot, registerVersion, restoreEntry, withRegistry,
  type ProbeInput, type Queryable,
} from '../core/projection/source-registry.js';
import { readNamespaceSnapshot } from '../core/projection/namespace-snapshot.js';
import { publishGeneration, publishStatus } from '../core/projection/publish-service.js';
import { readPointer } from '../core/projection/artifact-store.js';
import { assertSealedSafe } from '../core/usenet/sealed.js';
import { UsenetJobLedger, createFileLedgerStorage, usenetLedgerPath } from '../core/usenet/job-ledger.js';
import {
  PHASE10_DIVERGENCE_CODES, PHASE10_DIVERGENCE_MEANINGS, PHASE10_RULES,
  type Phase10DivergenceCode,
} from '../core/projection/phase10.js';

// Projection Phase 10 §3.2 — D10.2, D10.3 and D10.4: THE OPERATOR CONTENT PLANE.
//
// WHAT IT IS FOR. Phase 10 §2.3: `deploy/projection-alpha.sh` has eight verbs and every one is about the
// appliance's own lifecycle. To put one object in the namespace an operator had to hand-run
// `ops:projection-register` three times with a catalog uuid, a version key, an exact byte size, an
// exact-millisecond mtime and four probe digests typed into argv, and then `ops:projection-publish`. This is
// the shipped surface that replaces all of that, and P10-4 measures it: zero hand-run `tsx`, zero operator
// interventions, from an installed empty appliance to a readable namespace.
//
// WHAT IT OWNS AND WHAT IT REFUSES TO OWN. It owns the DATABASE and the MANIFEST DIRECTORY. It never writes
// inside the projection mount point, never mounts or unmounts, and never starts or stops the appliance —
// Phase 8 §13 gave `deploy/projection-alpha.sh` sole ownership of the mount point and Phase 10 §3.1 keeps it.
// One mount point still has exactly one owner, and it is not this.
//
// THE THREE PROPERTIES EVERY VERB HAS, BECAUSE §4's SECOND HARD REFUSAL IS ABOUT ALL THREE.
//
//   * NOTHING IS IMPLICIT. `add-torbox` and `add-local` REGISTER; they do not publish. Publishing is `publish`,
//     or an explicit `--publish` on the verb that registered. Phase 10 §2.2 is why this matters: `admitted`
//     did not mean visible, and the repair is not to publish behind the operator's back — it is to make the
//     surface say which.
//   * `reconcile` REPORTS AND NEVER ACTS. Not one code path in it writes. It is the verb an operator runs when
//     something looks wrong, and a verb that repaired what it found would be a verb that changed the evidence
//     before anybody read it. Acting on a divergence is `hold` or `release`, typed by a human.
//   * EVERY VERB IS IDEMPOTENT. The registration boundary already derives its ids from its inputs and upserts;
//     `publish` reports `unchanged` rather than burning a sequence; `hold` and `release` are state assertions
//     rather than toggles.
//
// INPUTS ARE FILE-BACKED AND ARGV CARRIES NO SECRET. A TorBox object reference is the thing
// `deploy/real-provider-objects.template.json` calls unprintable, and argv is visible in `/proc`, in a shell
// history and in `docker inspect`. So objects arrive in a file whose mode grants nothing to group or other,
// and every document this module emits goes through `assertSealedSafe` before it is returned.
//
// IT CONTACTS NO PROVIDER. Phase 10 is provider-free by construction: nothing here opens a socket to TorBox,
// a CDN origin, an indexer, SABnzbd or an NNTP server, and `endpoint.json` is not read, written or touched.
// The only network peer is the control plane's own PostgreSQL.

export class ContentCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ContentCommandError';
  }
}

const ABSOLUTE_POSIX = /^\/[^\0]*$/;
const ID_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VERSION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENTRY_ID = /^pe_[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------

export interface ContentPlaneConfig {
  /** Where the generation artifacts and the pointer live. The daemon reads this directory. */
  readonly manifestDir: string;
  /** The media root the appliance already serves as a local projection root. */
  readonly mediaRoot: string;
  /** The configured local root id for that media root. */
  readonly rootId: string;
  /** The configured HTTP Range endpoint id TorBox objects are registered against. */
  readonly endpointId: string;
  /**
   * The Usenet control plane's state directory, when there is one.
   *
   * OPTIONAL, and its absence is a REPORTED fact rather than an assumed one: `ledger-entry-unregistered` can
   * only be answered by an installation that has a ledger, and an installation without one must not have that
   * divergence silently reported as clean.
   */
  readonly usenetStateDir?: string;
}

export function parseContentConfig(raw: unknown): ContentPlaneConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ContentCommandError('CONFIG_NOT_AN_OBJECT', 'the content configuration must be a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  const allowed = ['manifestDir', 'mediaRoot', 'rootId', 'endpointId', 'usenetStateDir'];
  for (const key of Object.keys(doc)) {
    if (!allowed.includes(key)) {
      throw new ContentCommandError('CONFIG_UNKNOWN_KEY', `the content configuration has an unknown key: ${key}`);
    }
  }
  const requireAbsolute = (key: string): string => {
    const value = doc[key];
    if (typeof value !== 'string' || !ABSOLUTE_POSIX.test(value) || value.includes('\\')) {
      throw new ContentCommandError(`CONFIG_${key.toUpperCase()}_INVALID`,
        `${key} must be an absolute POSIX path; a relative one would resolve against whatever directory the `
        + 'command happened to be run from');
    }
    return value.replace(/\/+$/, '');
  };
  const requireLabel = (key: string): string => {
    const value = doc[key];
    if (typeof value !== 'string' || !ID_LABEL.test(value)) {
      throw new ContentCommandError(`CONFIG_${key.toUpperCase()}_INVALID`, `${key} names a configured root by label`);
    }
    return value;
  };

  const usenetStateDir = doc['usenetStateDir'];
  if (usenetStateDir !== undefined && (typeof usenetStateDir !== 'string' || !ABSOLUTE_POSIX.test(usenetStateDir))) {
    throw new ContentCommandError('CONFIG_USENETSTATEDIR_INVALID', 'usenetStateDir must be an absolute POSIX path');
  }

  return {
    manifestDir: requireAbsolute('manifestDir'),
    mediaRoot: requireAbsolute('mediaRoot'),
    rootId: requireLabel('rootId'),
    endpointId: requireLabel('endpointId'),
    ...(usenetStateDir === undefined ? {} : { usenetStateDir: (usenetStateDir as string).replace(/\/+$/, '') }),
  };
}

// ---------------------------------------------------------------------------------------------------------
// The injected host boundary
// ---------------------------------------------------------------------------------------------------------

export interface ContentFileStat {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other' | 'missing';
  readonly sizeBytes: number;
  /** Exact-millisecond UTC, as the manifest states it. */
  readonly mtime: string;
  /** False when the platform reports no meaningful POSIX modes, or when the file grants group/other access. */
  readonly ownerOnly: boolean;
}

/**
 * Everything this module asks of a host, injected.
 *
 * INJECTED FOR THE REASON `usenet-command.ts`'s preflight is: the conditions the content plane exists to
 * REPORT — a missing local file, a media root that is a symlink, an objects file readable by everybody — are
 * conditions a test host cannot always produce, and a test that had to create them would be a test that
 * changed the machine it ran on.
 */
export interface ContentHost {
  stat(absolutePath: string): Promise<ContentFileStat>;
  readFile(absolutePath: string): Promise<string>;
  /** The sha256 of an exact window of a file, read without loading the whole thing. */
  digestWindow(absolutePath: string, offset: number, length: number): Promise<string>;
  readonly hasPosixModes: boolean;
}

export function createRealContentHost(): ContentHost {
  const hasPosixModes = process.platform !== 'win32';
  return {
    hasPosixModes,
    async stat(absolutePath) {
      try {
        const link = await fsPromises.lstat(absolutePath);
        if (link.isSymbolicLink()) {
          return { kind: 'symlink', sizeBytes: 0, mtime: isoOf(0), ownerOnly: false };
        }
        const kind = link.isFile() ? 'file' : link.isDirectory() ? 'directory' : 'other';
        // A MODE IS ONLY MEANINGFUL WHERE THE PLATFORM REPORTS ONE. On Windows `mode` is a fiction, and
        // refusing an operator's file over a fictional mode would be refusing the wrong thing — so the fact
        // is reported as "not checkable" rather than as "fine".
        const ownerOnly = hasPosixModes ? (link.mode & (constants.S_IRWXG | constants.S_IRWXO)) === 0 : false;
        return { kind, sizeBytes: link.size, mtime: isoOf(link.mtimeMs), ownerOnly };
      } catch {
        return { kind: 'missing', sizeBytes: 0, mtime: isoOf(0), ownerOnly: false };
      }
    },
    async readFile(absolutePath) {
      return fsPromises.readFile(absolutePath, 'utf8');
    },
    async digestWindow(absolutePath, offset, length) {
      const hash = createHash('sha256');
      const stream = createReadStream(absolutePath, { start: offset, end: offset + length - 1 });
      for await (const chunk of stream) hash.update(chunk as Buffer);
      return hash.digest('hex');
    },
  };
}

/**
 * A filesystem mtime as the manifest's exact-millisecond timestamp.
 *
 * The same reasoning `manifest-bridge.ts`'s `projectedMtimeFrom` records: a nonsensical mtime falls back to
 * the epoch rather than throwing, because the value is metadata a media server displays and it is not
 * identity. Refusing an otherwise-registrable file over it would be refusing the wrong thing.
 */
export function isoOf(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0 || mtimeMs > 8.64e15) return '1970-01-01T00:00:00.000Z';
  return new Date(Math.floor(mtimeMs)).toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z');
}

// ---------------------------------------------------------------------------------------------------------
// The objects file
// ---------------------------------------------------------------------------------------------------------

export interface ContentObjectInput {
  /** The only identity this object has in any report line. Never a filename, a title or an account name. */
  readonly label: string;
  /** The catalog record this entry belongs to. The manifest's `logicalMediaId`. */
  readonly itemId: string;
  /** Where it appears in the namespace. */
  readonly path: string;
  /**
   * TORBOX ONLY: the opaque object reference. NEVER printed, never in argv, never in a report.
   * LOCAL ONLY: `relativePath`, under the media root.
   */
  readonly ref?: string;
  readonly relativePath?: string;
  readonly sizeBytes?: number;
  readonly mtime?: string;
  readonly sha256?: string | null;
  readonly probeDigests?: readonly { readonly offset: number; readonly length: number; readonly sha256: string }[];
}

/**
 * Read and validate an objects file.
 *
 * THE SHAPE IS `deploy/real-provider-objects.template.json`'s, DELIBERATELY. Phase 10 §2.3: that template
 * already carries `label`, `ref`, `sizeBytes`, `sha256` and `probeDigests[]` in an operator-facing shape, so
 * the input format for a shipped verb already existed and only the verb was missing. The three fields it adds
 * — `itemId`, `path`, `mtime` — are the ones a NAMESPACE needs and a corpus file does not.
 *
 * KEYS BEGINNING `_comment` ARE IGNORED, because the template is more than half comments and an operator who
 * edited it in place would otherwise be told their file is malformed.
 */
export async function readObjectsFile(
  host: ContentHost, file: string, kind: 'http-range' | 'local',
): Promise<readonly ContentObjectInput[]> {
  const stat = await host.stat(file);
  if (stat.kind === 'missing') {
    throw new ContentCommandError('OBJECTS_FILE_MISSING', 'the objects file is not there');
  }
  if (stat.kind === 'symlink') {
    throw new ContentCommandError('OBJECTS_FILE_IS_SYMLINK', 'the objects file is a symbolic link, which is never followed');
  }
  if (stat.kind !== 'file') {
    throw new ContentCommandError('OBJECTS_FILE_NOT_REGULAR', 'the objects file is not a regular file');
  }
  // A TORBOX OBJECT REFERENCE IS A SECRET AND ITS FILE IS TREATED AS ONE. The template says so in as many
  // words. A local objects file names no secret, so the mode is not demanded of it.
  if (kind === 'http-range' && host.hasPosixModes && !stat.ownerOnly) {
    throw new ContentCommandError('OBJECTS_FILE_PERMISSIVE',
      'the objects file grants access beyond its owner; it carries opaque object references and its mode must '
      + 'be 0600');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await host.readFile(file));
  } catch {
    throw new ContentCommandError('OBJECTS_FILE_MALFORMED', 'the objects file is not JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new ContentCommandError('OBJECTS_FILE_NOT_A_LIST', 'the objects file is a JSON array of objects');
  }
  if (parsed.length === 0) {
    throw new ContentCommandError('OBJECTS_FILE_EMPTY', 'the objects file names nothing to add');
  }

  return parsed.map((raw, index) => validateObject(raw, index, kind));
}

function validateObject(raw: unknown, index: number, kind: 'http-range' | 'local'): ContentObjectInput {
  const at = `object ${index}`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ContentCommandError('OBJECT_MALFORMED', `${at} is not an object`);
  }
  const doc = raw as Record<string, unknown>;
  const allowed = ['label', 'itemId', 'path', 'ref', 'relativePath', 'sizeBytes', 'mtime', 'sha256', 'probeDigests'];
  for (const key of Object.keys(doc)) {
    if (key.startsWith('_comment')) continue;
    if (!allowed.includes(key)) throw new ContentCommandError('OBJECT_UNKNOWN_KEY', `${at} has an unknown key: ${key}`);
  }

  const label = doc['label'];
  if (typeof label !== 'string' || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(label)) {
    throw new ContentCommandError('OBJECT_LABEL_INVALID',
      `${at} has no usable label; a label is the ONLY identity an object has in a report line, so it is kept `
      + 'boring on purpose: lower-case letters, digits and hyphens, at most 31 characters');
  }
  const itemId = doc['itemId'];
  if (typeof itemId !== 'string' || !UUID.test(itemId)) {
    throw new ContentCommandError('OBJECT_ITEM_ID_INVALID',
      `${at} (${label}) names no catalog record; an entry with no logical media id is an entry no media server `
      + 'can attribute to anything');
  }
  const projectedPath = doc['path'];
  if (typeof projectedPath !== 'string' || !normalizeProjectedPath(projectedPath).ok) {
    throw new ContentCommandError('OBJECT_PATH_INVALID',
      `${at} (${label}) has no normalized projected path; a path is REFUSED here rather than rewritten, because `
      + 'a namespace whose paths cannot be reproduced from what an operator wrote is a namespace no re-scan is '
      + 'idempotent over');
  }

  if (kind === 'http-range') {
    const ref = doc['ref'];
    if (typeof ref !== 'string' || ref.length === 0 || /^REPLACE-ME/.test(ref)) {
      throw new ContentCommandError('OBJECT_REF_INVALID',
        `${at} (${label}) has no opaque object reference, or still carries the template's placeholder`);
    }
    const sizeBytes = doc['sizeBytes'];
    if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) <= 0) {
      throw new ContentCommandError('OBJECT_SIZE_INVALID',
        `${at} (${label}) has no exact size; a total that disagrees with the provider's own Content-Range is `
        + 'how the daemon knows these are not the bytes of the object this entry describes');
    }
    const mtime = doc['mtime'];
    if (typeof mtime !== 'string' || !TIMESTAMP.test(mtime)) {
      throw new ContentCommandError('OBJECT_MTIME_INVALID',
        `${at} (${label}) has no exact-millisecond mtime; there is no rounding downstream, so it cannot be `
        + 'guessed here');
    }
    return {
      label, itemId, path: projectedPath, ref, sizeBytes: sizeBytes as number, mtime,
      ...(doc['sha256'] === undefined || doc['sha256'] === null ? {} : { sha256: String(doc['sha256']) }),
      ...(doc['probeDigests'] === undefined ? {} : { probeDigests: validateProbeDigests(doc['probeDigests'], at, label) }),
    };
  }

  const relativePath = doc['relativePath'];
  if (typeof relativePath !== 'string' || !normalizeProjectedPath(relativePath).ok) {
    throw new ContentCommandError('OBJECT_RELATIVE_PATH_INVALID',
      `${at} (${label}) has no normalized path under the media root; a local locator IS a relative path under a `
      + 'configured root, and an absolute one would name a file no other installation could resolve');
  }
  return { label, itemId, path: projectedPath, relativePath };
}

function validateProbeDigests(
  raw: unknown, at: string, label: string,
): readonly { readonly offset: number; readonly length: number; readonly sha256: string }[] {
  if (!Array.isArray(raw)) throw new ContentCommandError('OBJECT_PROBES_MALFORMED', `${at} (${label}) probeDigests is not a list`);
  return raw.map((probe, index) => {
    if (probe === null || typeof probe !== 'object') {
      throw new ContentCommandError('OBJECT_PROBE_MALFORMED', `${at} (${label}) probe ${index} is not an object`);
    }
    const doc = probe as Record<string, unknown>;
    const offset = doc['offset'];
    const length = doc['length'];
    const sha256 = doc['sha256'];
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
      throw new ContentCommandError('OBJECT_PROBE_OFFSET_INVALID', `${at} (${label}) probe ${index} has no offset`);
    }
    if (!Number.isSafeInteger(length) || (length as number) <= 0) {
      throw new ContentCommandError('OBJECT_PROBE_LENGTH_INVALID', `${at} (${label}) probe ${index} has no length`);
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new ContentCommandError('OBJECT_PROBE_DIGEST_INVALID',
        `${at} (${label}) probe ${index} has no 64-character lower-case hex digest`);
    }
    return { offset: offset as number, length: length as number, sha256 };
  });
}

/**
 * Turn an operator's `probeDigests` into the registry's fixed probe plan, or say exactly what is missing.
 *
 * THE PLAN IS NOT NEGOTIABLE AND THE REFUSAL SAYS WHAT IT IS. `registerVersion` refuses an offset that is not
 * the one the size implies, because "the producer picked the offsets" is not a proof a verifier can re-run.
 * An operator meeting that refusal three commands later, phrased as an offset mismatch, has been told a code;
 * this tells them the exact windows to digest.
 */
export function probePlanFor(
  sizeBytes: number, supplied: readonly { readonly offset: number; readonly length: number; readonly sha256: string }[],
): readonly ProbeInput[] {
  const expected = probeOffsetsFor(sizeBytes, PROJECTION_PROBE_PLAN.WINDOW_BYTES);
  const plan: ProbeInput[] = [];
  for (const window of expected) {
    const match = supplied.find((probe) => probe.offset === window.offset && probe.length === window.length);
    if (match === undefined) {
      throw new ContentCommandError('OBJECT_PROBE_PLAN_MISMATCH',
        `this size needs a digest of exactly ${window.length} bytes at offset ${window.offset} (${window.position}); `
        + `the required windows for ${sizeBytes} bytes are `
        + expected.map((slot) => `${slot.position}:${slot.offset}:${slot.length}`).join(' '));
    }
    plan.push({ position: window.position as ProbePosition, offset: window.offset, length: window.length, sha256: match.sha256 });
  }
  return plan;
}

/** A version key derived from what the entry IS, so re-running `add` twice mints one version rather than two. */
export function contentVersionKeyFor(kind: 'http-range' | 'local', label: string, digestOrPath: string): string {
  const key = `${kind === 'local' ? 'local' : 'torbox'}-${label}-${createHash('sha256').update(digestOrPath).digest('hex').slice(0, 16)}`;
  if (!VERSION_KEY.test(key)) throw new ContentCommandError('VERSION_KEY_INVALID', 'the derived version key is not usable');
  return key;
}

// ---------------------------------------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------------------------------------

export interface ContentProblem {
  readonly code: string;
  readonly message: string;
}

/**
 * Everything that can be wrong before anything is written, in one pass, as sentences.
 *
 * ONE PASS, NOT FIRST-FAILURE. The same argument `usenet-command.ts`'s preflight makes: somebody assembling a
 * manifest directory, a media root and a database should learn everything that is wrong in one run rather
 * than in four.
 */
export async function contentPreflight(
  config: ContentPlaneConfig, host: ContentHost, connectionString?: string,
): Promise<readonly ContentProblem[]> {
  const problems: ContentProblem[] = [];

  for (const [key, dir] of [['manifestDir', config.manifestDir], ['mediaRoot', config.mediaRoot]] as const) {
    const stat = await host.stat(dir);
    if (stat.kind === 'missing') {
      problems.push({ code: `${key.toUpperCase()}_MISSING`, message: `${key} does not exist` });
    } else if (stat.kind === 'symlink') {
      problems.push({
        code: `${key.toUpperCase()}_IS_SYMLINK`,
        message: `${key} is a symbolic link; this contract never follows one, because a link is a second name `
          + 'for a directory somebody else can move',
      });
    } else if (stat.kind !== 'directory') {
      problems.push({ code: `${key.toUpperCase()}_NOT_A_DIRECTORY`, message: `${key} is not a directory` });
    }
  }

  // THE MANIFEST DIRECTORY MUST NOT BE INSIDE THE MEDIA ROOT. A generation artifact written under the tree the
  // appliance projects would appear in the namespace it describes, and the next publish would be reading its
  // own output as content.
  if (isUnder(config.manifestDir, config.mediaRoot)) {
    problems.push({
      code: 'MANIFEST_DIR_INSIDE_MEDIA_ROOT',
      message: 'the manifest directory is inside the media root, so a generation artifact would appear in the '
        + 'namespace it describes',
    });
  }

  try {
    const status = await publishStatus({ manifestDir: config.manifestDir, connectionString });
    if (!status.agrees) {
      problems.push({
        code: 'GENERATION_POINTER_DISAGREES',
        message: 'the control plane and the manifest directory do not agree about what is published; run '
          + 'reconcile before adding anything',
      });
    }
  } catch {
    problems.push({
      code: 'CONTROL_PLANE_UNREACHABLE',
      message: 'the control plane database did not answer; nothing has been assumed about what is published',
    });
  }

  return problems;
}

/** True when `child` is the same directory as `parent` or lies beneath it. Pure string work on POSIX paths. */
export function isUnder(child: string, parent: string): boolean {
  // SEPARATORS ARE NORMALIZED FIRST. The configuration contract demands POSIX paths, but this function is
  // also called on values a TEST or a Windows development host produced, and a comparison that silently
  // answered false on a backslash would be a containment check that stopped containing on the one platform
  // where nobody would notice.
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(child);
  const b = norm(parent);
  return a === b || a.startsWith(`${b}/`);
}

// ---------------------------------------------------------------------------------------------------------
// add-torbox and add-local
// ---------------------------------------------------------------------------------------------------------

export interface AddOutcome {
  readonly label: string;
  readonly path: string;
  readonly projectedEntryId: string;
  readonly versionKey: string;
  readonly sizeBytes: number;
  /**
   * True when this entry is not in the CURRENT PUBLISHED GENERATION - Phase 10 SS2.2's state, answered at the
   * moment it is created rather than only by `reconcile`.
   *
   * IT IS NOT "did the INSERT report a row". The registration boundary derives its ids from its inputs and
   * upserts, so a row count says nothing an operator can use. What they need to know is whether a media
   * server can see this yet, and that is a question about the generation.
   */
  readonly needsPublish: boolean;
}

/**
 * Register TorBox objects. IT DOES NOT PUBLISH.
 *
 * Phase 10 §2.2 is the reason the two are separate verbs: `admitted` did not mean visible, and the repair for
 * that is not to start publishing behind an operator's back. `--publish` is how they ask.
 */
export async function addTorboxObjects(
  config: ContentPlaneConfig, host: ContentHost, file: string, connectionString?: string,
): Promise<readonly AddOutcome[]> {
  const objects = await readObjectsFile(host, file, 'http-range');
  const published = readPublishedEntryIds(config);
  return withRegistry(async (db: Queryable) => {
    await registerRoot(db, config.endpointId, 'http-range');
    const outcomes: AddOutcome[] = [];
    for (const object of objects) {
      const sizeBytes = object.sizeBytes as number;
      const identity = object.sha256 ?? object.ref as string;
      const versionKey = contentVersionKeyFor('http-range', object.label, identity);
      const probes = object.probeDigests === undefined ? null : probePlanFor(sizeBytes, object.probeDigests);
      await registerVersion(db, {
        versionKey, sizeBytes, mtime: object.mtime as string, ...(probes === null ? {} : { probes }),
      });
      const projectedEntryId = await registerEntry(db, {
        itemId: object.itemId,
        versionKey,
        path: object.path,
        sources: [{ kind: 'http-range', rootId: config.endpointId, objectRef: object.ref as string }],
      });
      outcomes.push({
        label: object.label, path: object.path, projectedEntryId, versionKey, sizeBytes,
        needsPublish: !published.has(projectedEntryId),
      });
    }
    return outcomes;
  }, connectionString);
}

/**
 * Register local files. IT READS THEM, AND THAT IS THE POINT.
 *
 * A local file is one this host can open, so its size, its mtime and its probe digests are FACTS this command
 * can establish rather than values an operator has to type. Phase 10 §2.3 counted what they used to have to
 * type: a uuid, a version key, an exact byte size, an exact-millisecond mtime and four digests, per object.
 * For a local source all but the first two are now read from the file, which is why P10-4's
 * `HAND_RUN_COMMANDS_MAX` of zero is reachable at all.
 */
export async function addLocalObjects(
  config: ContentPlaneConfig, host: ContentHost, file: string, connectionString?: string,
): Promise<readonly AddOutcome[]> {
  const objects = await readObjectsFile(host, file, 'local');

  // EVERY FILE IS PROVED BEFORE ANYTHING IS WRITTEN. A run that registered three entries and then found the
  // fourth missing would leave a namespace half-changed by a command the operator will read as having failed.
  const proved: Array<{ readonly object: ContentObjectInput; readonly stat: ContentFileStat; readonly probes: readonly ProbeInput[] }> = [];
  for (const object of objects) {
    const absolute = `${config.mediaRoot}/${object.relativePath as string}`;
    const stat = await host.stat(absolute);
    if (stat.kind === 'missing') {
      throw new ContentCommandError('LOCAL_FILE_MISSING', `${object.label}: the named file is not under the media root`);
    }
    if (stat.kind === 'symlink') {
      throw new ContentCommandError('LOCAL_FILE_IS_SYMLINK', `${object.label}: the named file is a symbolic link, which is never followed`);
    }
    if (stat.kind !== 'file') {
      throw new ContentCommandError('LOCAL_FILE_NOT_REGULAR', `${object.label}: the named file is not a regular file`);
    }
    if (stat.sizeBytes <= 0) {
      throw new ContentCommandError('LOCAL_FILE_EMPTY', `${object.label}: the named file is empty`);
    }
    const probes: ProbeInput[] = [];
    for (const window of probeOffsetsFor(stat.sizeBytes, PROJECTION_PROBE_PLAN.WINDOW_BYTES)) {
      probes.push({
        position: window.position as ProbePosition,
        offset: window.offset,
        length: window.length,
        sha256: await host.digestWindow(absolute, window.offset, window.length),
      });
    }
    proved.push({ object, stat, probes });
  }

  const published = readPublishedEntryIds(config);
  return withRegistry(async (db: Queryable) => {
    await registerRoot(db, config.rootId, 'local');
    const outcomes: AddOutcome[] = [];
    for (const { object, stat, probes } of proved) {
      const versionKey = contentVersionKeyFor('local', object.label, probes.map((probe) => probe.sha256).join(':'));
      await registerVersion(db, { versionKey, sizeBytes: stat.sizeBytes, mtime: stat.mtime, probes });
      const projectedEntryId = await registerEntry(db, {
        itemId: object.itemId,
        versionKey,
        path: object.path,
        sources: [{ kind: 'local', rootId: config.rootId, objectRef: object.relativePath as string }],
      });
      outcomes.push({
        label: object.label, path: object.path, projectedEntryId, versionKey, sizeBytes: stat.sizeBytes,
        needsPublish: !published.has(projectedEntryId),
      });
    }
    return outcomes;
  }, connectionString);
}

// ---------------------------------------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------------------------------------

export interface ContentPublishReport {
  readonly outcome: string;
  readonly sequence: number | null;
  readonly entryCount: number | null;
  readonly additions: number;
  readonly deletions: number;
  readonly problems: readonly string[];
}

/**
 * Publish a generation. EXPLICIT, ALWAYS.
 *
 * It is a thin, honest wrapper: `publishGeneration` already has exactly one outcome per call and already
 * leaves the namespace in a state a daemon can serve. What this adds is a report an operator can read and a
 * problem list that carries codes rather than positions.
 */
export async function publishContent(
  config: ContentPlaneConfig, connectionString?: string,
): Promise<ContentPublishReport> {
  const report = await publishGeneration({
    manifestDir: config.manifestDir,
    ...(connectionString === undefined ? {} : { connectionString }),
  });
  return {
    outcome: report.outcome,
    sequence: report.sequence,
    entryCount: report.entryCount,
    additions: report.additions,
    deletions: report.deletions,
    problems: report.problems.map((problem) => `${problem.code} at ${problem.at}`),
  };
}

// ---------------------------------------------------------------------------------------------------------
// reconcile — D10.4. IT REPORTS AND IT DOES NOT ACT.
// ---------------------------------------------------------------------------------------------------------

export interface ContentDivergence {
  readonly code: Phase10DivergenceCode;
  readonly meaning: string;
  /** The projected path, which is namespace identity rather than content identity. Never a locator. */
  readonly at: string;
  /** Extra context, closed-vocabulary. Never a path outside the namespace, never a URL, never a media id. */
  readonly detail: string;
}

export interface ContentReconcileReport {
  readonly phase: 10;
  readonly publishedSequence: number | null;
  readonly registryEntries: number;
  readonly publishedEntries: number;
  /** How many registered entries are not in the current generation. Phase 10 §2.2's gap, as a number. */
  readonly admittedNotPublished: number;
  readonly divergences: readonly ContentDivergence[];
  /**
   * Whether the Usenet ledger was available to cross-check.
   *
   * REPORTED RATHER THAN ASSUMED. An installation with no ledger cannot answer `ledger-entry-unregistered`,
   * and reporting that as "no divergence" would be reporting a question nobody asked as an answer.
   */
  readonly ledgerChecked: boolean;
}

export async function reconcileContent(
  config: ContentPlaneConfig, host: ContentHost, connectionString?: string,
): Promise<ContentReconcileReport> {
  const divergences: ContentDivergence[] = [];
  const add = (code: Phase10DivergenceCode, at: string, detail: string): void => {
    divergences.push({ code, meaning: PHASE10_DIVERGENCE_MEANINGS[code], at, detail });
  };

  const status = await publishStatus({
    manifestDir: config.manifestDir, ...(connectionString === undefined ? {} : { connectionString }),
  });
  if (!status.agrees) {
    add('generation-pointer-disagrees', 'the manifest directory',
      `database sequence ${String(status.dbSequence)}, pointer sequence ${String(status.pointerSequence)}, `
      + `artifact ${status.artifactPresent ? 'present' : 'absent'}`);
  }

  const registry = await readNamespaceSnapshot(connectionString);
  const published = readPublishedEntryIds(config);

  for (const entry of registry) {
    if (!published.has(entry.projectedEntryId)) {
      // D10.2, THE STATE THE RUNBOOK SAID DID NOT EXIST. A registered entry is invisible to every media server
      // until a generation carries it. Phase 9's runbook told an operator `admitted` meant "it is in the
      // namespace"; on a real appliance nothing in the Usenet path had ever published one.
      add('registry-ahead-of-generation', entry.path, 'admitted-not-published');
    }
    if (entry.visibility === 'degraded') {
      add('entry-degraded', entry.path, entry.degraded?.reason ?? 'unknown');
    }
    for (const source of entry.sources) {
      if (source.kind !== 'local') continue;
      const locator = source.locator as { readonly rootId: string; readonly relativePath: string };
      if (locator.rootId !== config.rootId) continue;
      const stat = await host.stat(`${config.mediaRoot}/${locator.relativePath}`);
      if (stat.kind === 'missing' || stat.kind === 'symlink' || stat.kind === 'other') {
        // THE DIVERGENCE PHASE 10 §2.4 EXISTS FOR. Every admitted Usenet entry is a `local` source under the
        // operator's media root, and a SABnzbd cleanup, a share move or a disk shuffle removes one without
        // anything in this repository noticing.
        add('local-source-file-absent', entry.path, stat.kind);
        continue;
      }
      if (stat.kind === 'directory') { add('local-source-file-absent', entry.path, 'directory'); continue; }
      if (stat.sizeBytes !== entry.sizeBytes || stat.mtime !== entry.mtime) {
        add('local-source-bytes-changed', entry.path,
          `registered ${entry.sizeBytes} bytes at ${entry.mtime}; on disk ${stat.sizeBytes} bytes at ${stat.mtime}`);
      }
    }
  }

  const ledger = readLedgerEntryIds(config);
  if (ledger !== null) {
    const registryIds = new Set(registry.map((entry) => entry.projectedEntryId));
    for (const admitted of ledger) {
      if (!registryIds.has(admitted.projectedEntryId)) {
        add('ledger-entry-unregistered', admitted.projectedPath, `job ${admitted.job}`);
      }
    }
  }

  const report: ContentReconcileReport = {
    phase: 10,
    publishedSequence: status.dbSequence,
    registryEntries: registry.length,
    publishedEntries: published.size,
    admittedNotPublished: divergences.filter((one) => one.code === 'registry-ahead-of-generation').length,
    divergences,
    ledgerChecked: ledger !== null,
  };
  // THE LAST GATE BEFORE ANYTHING IS PRINTED, exactly as `status-report.ts` does it. It REFUSES rather than
  // redacting: a report that still carries a raw locator at the point of being written is a report whose
  // author believed something untrue about it.
  assertSealedSafe(report, 'content-reconcile');
  return report;
}

/**
 * The entry ids in the CURRENT PUBLISHED GENERATION, read from the artifact the pointer names.
 *
 * READ FROM THE ARTIFACT, NOT FROM THE DATABASE. The artifact is what the daemon serves. A comparison against
 * a database row would answer "what does the control plane intend", and the question `admitted-not-published`
 * asks is "what can a media server see".
 *
 * AN UNREADABLE ARTIFACT ANSWERS EMPTY, and that is safe in the only direction that matters: every registered
 * entry is then reported `registry-ahead-of-generation`, which is loud. The opposite default would report a
 * namespace nobody can read as fully published.
 */
function readPublishedEntryIds(config: ContentPlaneConfig): ReadonlySet<string> {
  const pointer = readPointer(config.manifestDir);
  if (pointer === null) return new Set();
  try {
    const bytes = readFileSync(path.join(config.manifestDir, pointer.artifactName), 'utf8');
    const manifest = JSON.parse(bytes) as { entries?: ReadonlyArray<{ projectedEntryId?: unknown }> };
    return new Set((manifest.entries ?? [])
      .map((entry) => String(entry.projectedEntryId))
      .filter((id) => ENTRY_ID.test(id)));
  } catch {
    return new Set();
  }
}

interface LedgerAdmission {
  readonly job: string;
  readonly projectedEntryId: string;
  readonly projectedPath: string;
}

/**
 * The admitted entries the Usenet job ledger holds, or null when there is no ledger to read.
 *
 * NULL AND EMPTY ARE DIFFERENT ANSWERS. `ledgerChecked` on the report is what carries the difference, because
 * "there were no unregistered ledger entries" and "nothing looked" are not the same fact and a report that
 * merged them would be a report that grew quieter the less it could see.
 */
function readLedgerEntryIds(config: ContentPlaneConfig): readonly LedgerAdmission[] | null {
  if (config.usenetStateDir === undefined) return null;
  const file = usenetLedgerPath(config.usenetStateDir);
  if (!existsSync(file)) return null;
  try {
    // THE SHIPPED LEDGER, REPLAYED BY THE SHIPPED CLASS. Parsing the JSONL here would make this a second
    // reader of a durable format, and the second reader is the one that silently stops understanding a record
    // the first one started writing.
    //
    // IT DOES NOT TAKE THE LEDGER LOCK, AND IT MUST NOT. `reconcile` REPORTS, and a report that could block an
    // operator's `submit` would be a read that acts. A record appended while this replays is a record the next
    // reconcile sees, which is correct for a surface whose whole job is "what is true now".
    const ledger = UsenetJobLedger.open(createFileLedgerStorage(file));
    return ledger.all()
      .filter((job) => job.admitted !== null)
      .map((job) => {
        const admitted = job.admitted as { readonly projectedEntryId: string; readonly projectedPath: string };
        return { job: job.key.slice(0, 11), projectedEntryId: admitted.projectedEntryId, projectedPath: admitted.projectedPath };
      });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// hold and release — the only two verbs that act, and a human types both
// ---------------------------------------------------------------------------------------------------------

export interface HoldOutcome {
  readonly path: string;
  readonly projectedEntryId: string;
  readonly visibility: 'degraded' | 'available';
  /** False when the entry was already in the state asked for. Idempotence, reported. */
  readonly changed: boolean;
}

/**
 * Degrade an entry with `operator-hold`.
 *
 * IT STAYS IN THE NAMESPACE. `degradeEntry`'s own comment is the reason: a source the control plane cannot
 * reach must not be able to shrink a media server's library, and the same is true of one a human is holding.
 * The inode, size and mtime are untouched.
 *
 * `operator-hold` IS ALREADY IN THE CLOSED SET. Phase 10 adds no reason, which is §4's first hard refusal.
 */
export async function holdContentEntry(
  config: ContentPlaneConfig, projectedPath: string, since: string, connectionString?: string,
): Promise<HoldOutcome> {
  const normalized = normalizeProjectedPath(projectedPath);
  if (!normalized.ok) throw new ContentCommandError('PATH_NOT_NORMALIZED', 'a hold names a normalized projected path');
  const projectedEntryId = deriveProjectedEntryId(normalized.path as string);

  const before = await readNamespaceSnapshot(connectionString);
  const existing = before.find((entry) => entry.projectedEntryId === projectedEntryId);
  if (existing === undefined) throw new ContentCommandError('ENTRY_UNKNOWN', 'no registered entry has that path');

  await withRegistry((db) => degradeEntry(db, projectedEntryId, 'operator-hold', since), connectionString);
  return {
    path: normalized.path as string,
    projectedEntryId,
    visibility: 'degraded',
    changed: !(existing.visibility === 'degraded' && existing.degraded?.reason === 'operator-hold'),
  };
}

/** Restore a held entry. The symmetric verb, and equally explicit. */
export async function releaseContentEntry(
  config: ContentPlaneConfig, projectedPath: string, connectionString?: string,
): Promise<HoldOutcome> {
  const normalized = normalizeProjectedPath(projectedPath);
  if (!normalized.ok) throw new ContentCommandError('PATH_NOT_NORMALIZED', 'a release names a normalized projected path');
  const projectedEntryId = deriveProjectedEntryId(normalized.path as string);

  const before = await readNamespaceSnapshot(connectionString);
  const existing = before.find((entry) => entry.projectedEntryId === projectedEntryId);
  if (existing === undefined) throw new ContentCommandError('ENTRY_UNKNOWN', 'no registered entry has that path');
  if (existing.visibility === 'retiring') {
    // A RETIRING ENTRY IS NOT A HELD ONE AND RELEASE DOES NOT MEAN "UNDO THE LAST THING". Quietly making a
    // retiring entry available again would cancel a deletion intent an operator declared somewhere else.
    throw new ContentCommandError('ENTRY_RETIRING',
      'that entry is retiring, not held; release does not cancel a declared deletion intent');
  }

  await withRegistry((db) => restoreEntry(db, projectedEntryId), connectionString);
  return {
    path: normalized.path as string,
    projectedEntryId,
    visibility: 'available',
    changed: existing.visibility !== 'available',
  };
}

// ---------------------------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------------------------

export interface ContentStatusEntry {
  readonly path: string;
  readonly kinds: readonly string[];
  readonly sizeBytes: number;
  readonly visibility: string;
  readonly degradedReason: string | null;
  /**
   * D10.2 — THE FACT PHASE 9'S RUNBOOK GOT WRONG, ON ITS OWN AXIS.
   *
   * It is NOT a seventh job state. `USENET_JOB_STATES` describes what a WORKER has done with a job, and Phase
   * 9's six are the whole of that. Whether the namespace has published the result is a fact about the
   * GENERATION, and merging the two would silently change what a closed tranche's own module exports.
   */
  readonly publication: 'published' | 'admitted-not-published';
}

export interface ContentStatusDocument {
  readonly phase: 10;
  readonly publishedSequence: number | null;
  readonly agrees: boolean;
  readonly counts: {
    readonly registered: number;
    readonly published: number;
    readonly admittedNotPublished: number;
    readonly degraded: number;
    readonly held: number;
  };
  readonly entries: readonly ContentStatusEntry[];
}

export async function contentStatus(
  config: ContentPlaneConfig, host: ContentHost, connectionString?: string,
): Promise<ContentStatusDocument> {
  const status = await publishStatus({
    manifestDir: config.manifestDir, ...(connectionString === undefined ? {} : { connectionString }),
  });
  const registry = await readNamespaceSnapshot(connectionString);
  const published = readPublishedEntryIds(config);

  const entries = registry.map((entry: ProjectedEntry): ContentStatusEntry => ({
    path: entry.path,
    kinds: [...new Set(entry.sources.map((source) => source.kind))].sort(),
    sizeBytes: entry.sizeBytes,
    visibility: entry.visibility,
    degradedReason: entry.degraded?.reason ?? null,
    publication: published.has(entry.projectedEntryId) ? 'published' : 'admitted-not-published',
  }));

  const document: ContentStatusDocument = {
    phase: 10,
    publishedSequence: status.dbSequence,
    agrees: status.agrees,
    counts: {
      registered: entries.length,
      published: entries.filter((entry) => entry.publication === 'published').length,
      admittedNotPublished: entries.filter((entry) => entry.publication === 'admitted-not-published').length,
      degraded: entries.filter((entry) => entry.visibility === 'degraded').length,
      held: entries.filter((entry) => entry.degradedReason === 'operator-hold').length,
    },
    entries,
  };
  assertSealedSafe(document, 'content-status');
  return document;
}

// ---------------------------------------------------------------------------------------------------------
// Rendering. The CLI never formats a document itself, exactly as `usenet-command.ts` does not.
// ---------------------------------------------------------------------------------------------------------

export function renderContentPreflight(problems: readonly ContentProblem[]): readonly string[] {
  if (problems.length === 0) {
    return ['projection content preflight: nothing is wrong that can be seen without writing anything'];
  }
  return ['projection content preflight: the following must be fixed before anything is added',
    ...problems.map((problem) => `  ${problem.code}: ${problem.message}`)];
}

export function renderAdd(outcomes: readonly AddOutcome[]): readonly string[] {
  const lines = [`registered ${outcomes.length} ${outcomes.length === 1 ? 'entry' : 'entries'}`];
  for (const outcome of outcomes) {
    lines.push(`  ${outcome.label.padEnd(20)} ${outcome.path} (${outcome.sizeBytes} bytes)`
      + (outcome.needsPublish ? '  NOT IN ANY GENERATION' : '  already published'));
  }
  // THE SENTENCE THAT MAKES §2.2 IMPOSSIBLE TO MISREAD. It is printed by the verb that did the registering,
  // every time, because the runbook that told an operator otherwise is the defect this phase repairs.
  lines.push('');
  lines.push('NOTHING IS VISIBLE YET. A registered entry is in the control plane and in no generation, so no');
  lines.push('media server can see it. Run `publish` to mint a generation, or re-run with --publish.');
  return lines;
}

export function renderPublish(report: ContentPublishReport): readonly string[] {
  const lines = [`publish: ${report.outcome}`];
  if (report.sequence !== null) lines.push(`  generation sequence ${report.sequence}`);
  if (report.entryCount !== null) lines.push(`  ${report.entryCount} entries, +${report.additions} -${report.deletions}`);
  for (const problem of report.problems) lines.push(`  refused: ${problem}`);
  if (report.outcome === 'unchanged') {
    lines.push('  nothing changed, so nothing was published. That is not a failure: publishing an identical');
    lines.push('  generation would burn a sequence and make every reader re-read what it already has.');
  }
  return lines;
}

export function renderReconcile(report: ContentReconcileReport): readonly string[] {
  const lines = ['projection content reconcile — THIS REPORTS AND CHANGES NOTHING'];
  lines.push(`  published generation ${String(report.publishedSequence)}`);
  lines.push(`  ${report.registryEntries} registered, ${report.publishedEntries} published, `
    + `${report.admittedNotPublished} admitted-not-published`);
  if (!report.ledgerChecked) {
    lines.push('  the Usenet job ledger was NOT read, so ledger-entry-unregistered was not answered either way');
  }
  if (report.divergences.length === 0) {
    lines.push('  no divergence');
    return lines;
  }
  for (const divergence of report.divergences) {
    lines.push(`  ${divergence.code}  ${divergence.at}`);
    lines.push(`      ${divergence.meaning}`);
    lines.push(`      ${divergence.detail}`);
  }
  lines.push('');
  lines.push('NOTHING ABOVE WAS ACTED ON. `hold` degrades an entry and `release` restores one; both are typed');
  lines.push('by a human, and this command has no path that writes.');
  return lines;
}

export function renderStatus(document: ContentStatusDocument): readonly string[] {
  const lines = ['projection content status'];
  lines.push(`  generation ${String(document.publishedSequence)}  agrees=${document.agrees}`);
  lines.push(`  registered=${document.counts.registered}  published=${document.counts.published}  `
    + `admitted-not-published=${document.counts.admittedNotPublished}  degraded=${document.counts.degraded}  `
    + `held=${document.counts.held}`);
  if (document.entries.length === 0) lines.push('  (the namespace is empty)');
  for (const entry of document.entries) {
    lines.push(`  ${entry.publication === 'published' ? ' ' : '!'} ${entry.path}`);
    lines.push(`      ${entry.kinds.join(',')}  ${entry.sizeBytes} bytes  ${entry.visibility}`
      + (entry.degradedReason === null ? '' : ` (${entry.degradedReason})`)
      + `  ${entry.publication}`);
  }
  return lines;
}

export function renderHold(outcome: HoldOutcome, verb: 'hold' | 'release'): readonly string[] {
  return [
    `${verb}: ${outcome.path}`,
    `  visibility is now ${outcome.visibility}${outcome.changed ? '' : ' (it already was; nothing changed)'}`,
    '  THE ENTRY IS STILL IN THE NAMESPACE. Its inode, size and mtime are untouched, so no media server\'s',
    '  library shrank. Run `publish` for the change to reach a generation.',
  ];
}

/** Re-exported so a gate and a suite read the closed set from one place. */
export { PHASE10_DIVERGENCE_CODES, PHASE10_RULES };
