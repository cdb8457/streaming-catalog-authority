import { createHash } from 'node:crypto';
import { constants, promises as fsPromises } from 'node:fs';

import { USENET_ADMISSION_BOUNDS } from './sab-contract.js';
import { PROJECTION_PROBE_PLAN, probeOffsetsFor } from '../projection/manifest-v1.js';
import type { OutputDigestResult, OutputFileSystem, OutputStat } from './completed-output.js';

// Projection Phase 9 — the real filesystem behind the admission checks, and nothing else.
//
// EVERY DECISION IN `completed-output.ts` IS MADE FROM THE VALUES THIS FILE RETURNS. So this file's whole job
// is to answer honestly and to open nothing it was not asked to:
//
//   `lstat`, never `stat`. A `stat` on a symlink describes the target; every refusal in the walk depends on a
//   symlink reporting itself.
//
//   `O_NOFOLLOW` on the open. The walk already proved the leaf was not a link, but the walk finished a moment
//   ago and the open is now: without the flag, a link swapped into place in between is followed silently.
//   With it, the open fails, and a failed open is a refusal.
//
//   ONE DESCRIPTOR FOR THE WHOLE READ, and the final stat taken FROM IT. Re-opening the path to check it
//   would be checking a different question. `fstat` on the descriptor the bytes came from is the only stat
//   that describes the thing that was actually read.
//
//   ONE PASS FOR THE WHOLE DIGEST AND THE THREE PROBES. The probe windows are subranges of the same byte
//   stream, so computing them separately would mean reading a large file twice for no additional proof.

export function createRealOutputFileSystem(): OutputFileSystem {
  return {
    async lstat(path: string): Promise<OutputStat> {
      const stat = await fsPromises.lstat(path, { bigint: true });
      return {
        kind: kindOf(stat),
        // A size above 2^53-1 cannot survive a JSON round trip, and the manifest contract refuses one, so it
        // is clamped to an impossible-but-safe value here and refused by the bound check rather than silently
        // rounded into a smaller number.
        sizeBytes: stat.size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(stat.size),
        dev: stat.dev.toString(10),
        ino: stat.ino.toString(10),
        mtimeMs: Number(stat.mtimeNs / 1_000_000n),
        nlink: Number(stat.nlink),
        mode: Number(stat.mode) & 0o7777,
      };
    },

    async readDir(path: string): Promise<readonly string[]> {
      return fsPromises.readdir(path);
    },

    async digest(path: string, sizeBytes: number): Promise<OutputDigestResult> {
      // O_NOFOLLOW is POSIX. On a platform that does not define it the constant is undefined, and the open
      // falls back to a plain read-only open — which is why the gate that proves the symlink refusal runs on
      // the Linux host and not on a developer laptop.
      const noFollow = (constants as Record<string, number | undefined>)['O_NOFOLLOW'] ?? 0;
      const handle = await fsPromises.open(path, constants.O_RDONLY | noFollow);
      try {
        const whole = createHash('sha256');
        const plan = probeOffsetsFor(sizeBytes, PROJECTION_PROBE_PLAN.WINDOW_BYTES)
          .map((window) => ({ ...window, hash: createHash('sha256') }));

        const chunk = Buffer.allocUnsafe(USENET_ADMISSION_BOUNDS.DIGEST_CHUNK_BYTES);
        let position = 0;
        let read = 0;
        do {
          const result = await handle.read(chunk, 0, chunk.byteLength, position);
          read = result.bytesRead;
          if (read === 0) break;
          const slice = chunk.subarray(0, read);
          whole.update(slice);
          for (const window of plan) {
            const start = Math.max(window.offset, position);
            const end = Math.min(window.offset + window.length, position + read);
            if (end > start) window.hash.update(slice.subarray(start - position, end - position));
          }
          position += read;
        } while (read > 0);

        const stat = await handle.stat({ bigint: true });
        return {
          sha256: whole.digest('hex'),
          sizeBytes: position,
          probes: plan.map((window) => ({
            position: window.position,
            offset: window.offset,
            length: window.length,
            sha256: window.hash.digest('hex'),
          })),
          observed: {
            kind: kindOf(stat),
            sizeBytes: stat.size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(stat.size),
            dev: stat.dev.toString(10),
            ino: stat.ino.toString(10),
            mtimeMs: Number(stat.mtimeNs / 1_000_000n),
            nlink: Number(stat.nlink),
            mode: Number(stat.mode) & 0o7777,
          },
        };
      } finally {
        await handle.close();
      }
    },
  };
}

interface KindBearing {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

function kindOf(stat: KindBearing): OutputStat['kind'] {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  if (stat.isBlockDevice()) return 'block-device';
  if (stat.isCharacterDevice()) return 'character-device';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  return 'unknown';
}
