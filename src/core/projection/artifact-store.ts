import {
  closeSync, existsSync, fstatSync, fsyncSync, openSync, readFileSync, readSync, renameSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { manifestDigestOfBytes } from './manifest-v1.js';

// Projection Phase 1 — the filesystem half of publication.
//
// THE ONLY THING A READER WATCHES IS `pointer.json`. Everything else in the manifest directory is content
// addressed by a name no reader looks for, so an artifact can be written, torn, re-written and written again
// without any of it being observable. The pointer is then moved into place by `rename()`, which is atomic on
// every filesystem this product supports — so a reader sees the previous pointer or the new one, and never a
// prefix of either (Phase 0 §2.2).
//
// WHY EVERY WRITE IS temp-in-the-SAME-DIRECTORY, fsync, rename, fsync-the-directory.
//   - SAME DIRECTORY, because `rename()` is only atomic within a filesystem, and a temp directory can be a
//     different one. A cross-device rename is a copy, and a copy is exactly the torn read this avoids.
//   - fsync THE FILE before the rename, because a rename that reaches the disk before the bytes it names
//     leaves a pointer to a file full of nothing after a power cut.
//   - fsync THE DIRECTORY after the rename, because the rename itself is metadata, and metadata is buffered
//     too. Without it the artifact survives and the name that finds it does not.
//
// WINDOWS. A directory cannot be opened for fsync there. Production is Linux (Phase 0 §10.1) and the gate that
// proves this runs on Linux; on a Windows development machine the directory sync is skipped rather than
// faked, and `directorySynced` in the result says which happened, so no run can claim durability it did not
// obtain.

/** The one name a reader watches. */
export const POINTER_FILE_NAME = 'pointer.json';

/**
 * The pointer document, in exactly the shape the daemon decodes.
 *
 * The daemon refuses unknown fields and trailing content, so this type is not a convenience — it is the wire
 * format, and a sixth field here would be a pointer every daemon rejects.
 */
export interface PointerDocument {
  readonly generationId: string;
  readonly sequence: number;
  readonly artifactName: string;
  readonly artifactBytes: number;
  readonly manifestDigest: string;
}

export interface DurableWrite {
  readonly path: string;
  readonly bytes: number;
  /** False only where the PLATFORM cannot sync a directory. A failure anywhere else throws. */
  readonly directorySynced: boolean;
}

/**
 * A directory sync that could not be performed, on a platform where it should have been.
 *
 * It is an error and not a flag. The rename is what publishes a generation, and the directory sync is what
 * makes the rename itself survive a power cut; a publisher that skipped it and still answered "published"
 * would be claiming a durability it did not obtain. The artifact and the pointer are already in place when
 * this throws, so the run is exactly as recoverable as any other interrupted run — the next one finds the
 * disagreement and finishes it.
 */
export class DirectorySyncFailedError extends Error {
  readonly code = 'DIRECTORY_SYNC_FAILED';

  constructor(readonly cause: NodeJS.ErrnoException) {
    super(`the manifest directory could not be synced: ${cause.code ?? cause.message}`);
    this.name = 'DirectorySyncFailedError';
  }
}

/**
 * Is a failed directory sync a fact about the PLATFORM, or a fact about this write?
 *
 * Windows has no way to open a directory for `fsync`, so the attempt fails there for every directory, always,
 * and no amount of retrying changes it — that is `unsupported`, and Phase 0 §10.1 already says production is
 * Linux, so a development machine reporting it is honest rather than broken. Anywhere else a failure is a
 * REAL failure: the filesystem was asked to make a rename durable and said no.
 *
 * Split out and exported because it is the whole policy, and a policy buried inside a catch block is one
 * nobody can test on the platform where it matters least and matters most.
 */
export function directorySyncFailureIsFatal(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

function syncDirectory(dir: string): boolean {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
      return true;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (directorySyncFailureIsFatal(process.platform)) {
      throw new DirectorySyncFailedError(error as NodeJS.ErrnoException);
    }
    return false;
  }
}

/**
 * Write `bytes` to `dir/name`, durably and atomically.
 *
 * The temp name carries the process id so two publishers cannot write the same temp — although the advisory
 * lock in the publish service means two publishers should never be here at once, a temp collision would be a
 * silent corruption rather than a refusal, and that is not a thing to leave to a lock being correct.
 */
export function writeDurable(dir: string, name: string, bytes: Buffer): DurableWrite {
  const target = join(dir, name);
  const temp = join(dir, `.${name}.${process.pid}.tmp`);
  const fd = openSync(temp, 'w', 0o644);
  try {
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, target);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* the temp is already gone; the rename failure is what matters */ }
    throw error;
  }
  return { path: target, bytes: bytes.length, directorySynced: syncDirectory(dir) };
}

/**
 * Read a file back and prove it is EXACTLY the bytes it should be.
 *
 * Length is measured on the descriptor the bytes come from, and a byte after the declared end fails the
 * check — the same rule the daemon applies, for the same reason: a file that grew between the stat and the
 * read is not the file that was verified.
 */
export function readExact(path: string, expectedBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size !== expectedBytes) return null;
    const data = Buffer.alloc(expectedBytes);
    let read = 0;
    while (read < expectedBytes) {
      const n = readSync(fd, data, read, expectedBytes - read, read);
      if (n <= 0) return null;
      read += n;
    }
    const extra = Buffer.alloc(1);
    if (readSync(fd, extra, 0, 1, expectedBytes) > 0) return null;
    return data;
  } finally {
    closeSync(fd);
  }
}

/** Is the artifact on disk, of the right length, and digesting to the right thing? */
export function artifactMatches(dir: string, name: string, bytes: number, digest: string): boolean {
  const data = readExact(join(dir, name), bytes);
  return data !== null && manifestDigestOfBytes(data) === digest;
}

/** Publish the artifact if it is not already there, byte for byte. Idempotent by construction. */
export function ensureArtifact(dir: string, name: string, bytes: Buffer, digest: string): DurableWrite | null {
  if (artifactMatches(dir, name, bytes.length, digest)) return null;
  return writeDurable(dir, name, bytes);
}

/** The pointer's bytes. One trailing newline so the file is well-formed text; the daemon ignores it. */
export function serializePointer(pointer: PointerDocument): Buffer {
  return Buffer.from(`${JSON.stringify({
    generationId: pointer.generationId,
    sequence: pointer.sequence,
    artifactName: pointer.artifactName,
    artifactBytes: pointer.artifactBytes,
    manifestDigest: pointer.manifestDigest,
  }, null, 2)}\n`, 'utf8');
}

/**
 * Is there a pointer FILE, whatever it contains?
 *
 * `readPointer` answers null for a directory with no pointer and for a directory holding a half-written or
 * hand-edited one, which is right for the publisher — its job is the same either way — and wrong for anything
 * reporting health. `projectiond` does not see "null" in the second case; it sees a file, reads it, and
 * refuses it. A status surface that called those two states both empty would report a directory the daemon
 * is actively rejecting as a clean installation.
 */
export function pointerFilePresent(dir: string): boolean {
  return existsSync(join(dir, POINTER_FILE_NAME));
}

/**
 * Read the published pointer, or null when there is none or it is not one.
 *
 * A malformed pointer reads as ABSENT rather than raising. The publisher's job when it finds one is the same
 * either way — republish the pointer the database says is current — and a publisher that crashed on a
 * half-written file would be unable to repair exactly the state it exists to repair.
 */
export function readPointer(dir: string): PointerDocument | null {
  const path = join(dir, POINTER_FILE_NAME);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const doc = parsed as Record<string, unknown>;
  const keys = Object.keys(doc).sort().join(',');
  if (keys !== 'artifactBytes,artifactName,generationId,manifestDigest,sequence') return null;
  if (typeof doc['generationId'] !== 'string' || typeof doc['artifactName'] !== 'string'
    || typeof doc['manifestDigest'] !== 'string'
    || !Number.isSafeInteger(doc['sequence']) || !Number.isSafeInteger(doc['artifactBytes'])) return null;
  return {
    generationId: doc['generationId'],
    sequence: doc['sequence'] as number,
    artifactName: doc['artifactName'],
    artifactBytes: doc['artifactBytes'] as number,
    manifestDigest: doc['manifestDigest'],
  };
}

/** Publish the pointer. This is the last write of a publish and the moment a reader can see the generation. */
export function writePointer(dir: string, pointer: PointerDocument): DurableWrite {
  return writeDurable(dir, POINTER_FILE_NAME, serializePointer(pointer));
}
