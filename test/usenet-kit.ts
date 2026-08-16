import { createHash } from 'node:crypto';

import type { AdmissionClock, OutputDigestResult, OutputFileSystem, OutputStat } from '../src/core/usenet/completed-output.js';
import type { AdmissionPublisher } from '../src/core/usenet/admission.js';
import type { ApiKeyFileStat, ApiKeyFileSystem } from '../src/core/usenet/sab-api-key.js';
import { PROJECTION_PROBE_PLAN, probeOffsetsFor } from '../src/core/projection/manifest-v1.js';
import { deriveProjectedEntryId } from '../src/core/projection/manifest-v1.js';

// Projection Phase 9 — the shared harness for this tranche's twelve offline suites.
//
// WHY A KIT RATHER THAN TWELVE COPIES. `jellyfin-contract-kit.ts` set the precedent and the argument is the
// same: a copied harness is twelve chances to weaken one assertion, and a copied FAKE is twelve subtly
// different opinions about what a filesystem does. The interesting property of the fake filesystem below is
// that it can produce, deterministically and on any platform, every condition the admission checks exist to
// refuse — a symlinked parent, a FIFO, a file that changes between two stats, a file replaced during a read.
// A real filesystem can produce some of those only with privileges, and the races not at all.

// ---------------------------------------------------------------------------------------------------------
// The tiny harness every suite in this repository uses
// ---------------------------------------------------------------------------------------------------------

export interface Harness {
  test(name: string, fn: () => void | Promise<void>): void;
  /**
   * A heading, QUEUED rather than printed.
   *
   * A `console.log` at the top level would print before any of the tests it introduces, because the tests are
   * queued — so the headings would all appear first and the output would say nothing about which test belongs
   * to which section. Queuing the heading puts it back where a reader expects it.
   */
  section(title: string): void;
  finish(): Promise<void>;
}

export function createHarness(title: string): Harness {
  let passed = 0;
  let failed = 0;
  const failures: Array<[string, unknown]> = [];
  const pending: Array<Promise<void>> = [];
  console.log(title);

  const run = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok  ${name}`);
    } catch (error) {
      failed += 1;
      failures.push([name, error]);
      console.log(`  FAIL  ${name}`);
    }
  };

  const queue = (fn: () => Promise<void>): void => {
    // Sequenced, not parallel: several of these suites drive a real HTTP server and a shared fake clock, and
    // an interleaved run would make a failure depend on which test happened to be in flight.
    const previous = pending[pending.length - 1] ?? Promise.resolve();
    pending.push(previous.then(fn));
  };

  return {
    test(name, fn) {
      queue(() => run(name, fn));
    },
    section(heading) {
      queue(async () => { console.log(`\n${heading}`); });
    },
    async finish() {
      await Promise.all(pending);
      console.log(`\n${passed} passed, ${failed} failed`);
      if (failures.length > 0) {
        for (const [name, error] of failures) {
          console.error(`\n  ${name}\n    ${(error as Error).message}`);
        }
        process.exit(1);
      }
    },
  };
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: got ${String(actual)}, want ${String(expected)}`);
}

export async function assertThrows(fn: () => unknown | Promise<unknown>, match: RegExp, message: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const text = `${(error as { code?: string }).code ?? ''} ${(error as Error).message}`;
    if (!match.test(text)) throw new Error(`${message}: threw ${text}`);
    return;
  }
  throw new Error(`${message}: nothing was thrown`);
}

// ---------------------------------------------------------------------------------------------------------
// The fake filesystem
// ---------------------------------------------------------------------------------------------------------

export interface FakeNode {
  kind: OutputStat['kind'];
  /** For a file: its bytes. The digest is computed over these, so a mutation changes the proof. */
  bytes?: Buffer;
  nlink?: number;
  mtimeMs?: number;
  dev?: string;
  ino?: string;
}

export interface FakeFileSystemOptions {
  /** Called before every `lstat`, so a test can mutate the tree between two samples. */
  beforeStat?: (path: string, sample: number) => void;
  /** Called after the digest read has finished but before its `fstat`, to model a replace-during-read. */
  duringDigest?: (path: string) => void;
}

export interface FakeFileSystem extends OutputFileSystem {
  set(path: string, node: FakeNode): void;
  remove(path: string): void;
  statCount(): number;
  digestCount(): number;
}

/**
 * A filesystem held in a Map, keyed by absolute POSIX path.
 *
 * IT DOES NOT RESOLVE ANYTHING. A symlink node simply reports `symlink` and the walk refuses it — which is
 * exactly what the real implementation does with `lstat`, and modelling a resolution here would be modelling
 * a behaviour the product deliberately does not have.
 */
export function createFakeFileSystem(
  initial: Readonly<Record<string, FakeNode>> = {},
  options: FakeFileSystemOptions = {},
): FakeFileSystem {
  const nodes = new Map<string, FakeNode>(Object.entries(initial));
  let stats = 0;
  let digests = 0;
  let inode = 1000;
  const inodes = new Map<string, string>();

  const inodeFor = (path: string): string => {
    const existing = inodes.get(path);
    if (existing !== undefined) return existing;
    inode += 1;
    const value = String(inode);
    inodes.set(path, value);
    return value;
  };

  const statOf = (path: string, node: FakeNode): OutputStat => ({
    kind: node.kind,
    sizeBytes: node.bytes?.byteLength ?? 0,
    dev: node.dev ?? '64768',
    ino: node.ino ?? inodeFor(path),
    mtimeMs: node.mtimeMs ?? 1_700_000_000_000,
    nlink: node.nlink ?? 1,
    mode: node.kind === 'directory' ? 0o755 : 0o644,
  });

  return {
    set(path, node) { nodes.set(path, node); },
    remove(path) { nodes.delete(path); },
    statCount: () => stats,
    digestCount: () => digests,

    async lstat(path: string): Promise<OutputStat> {
      stats += 1;
      options.beforeStat?.(path, stats);
      const node = nodes.get(path);
      if (node === undefined) throw new Error(`ENOENT ${path}`);
      return statOf(path, node);
    },

    async readDir(path: string): Promise<readonly string[]> {
      const node = nodes.get(path);
      if (node === undefined || node.kind !== 'directory') throw new Error(`ENOTDIR ${path}`);
      const prefix = `${path}/`;
      const names: string[] = [];
      for (const key of nodes.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.includes('/')) continue;
        names.push(rest);
      }
      return names.sort();
    },

    async digest(path: string, _sizeBytes: number): Promise<OutputDigestResult> {
      digests += 1;
      const node = nodes.get(path);
      if (node === undefined || node.kind !== 'file' || node.bytes === undefined) {
        throw new Error(`ENOENT ${path}`);
      }
      const bytes = node.bytes;
      const probes = probeOffsetsFor(bytes.byteLength, PROJECTION_PROBE_PLAN.WINDOW_BYTES).map((window) => ({
        position: window.position,
        offset: window.offset,
        length: window.length,
        sha256: createHash('sha256').update(bytes.subarray(window.offset, window.offset + window.length)).digest('hex'),
      }));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      // The replacement happens BETWEEN the read and the descriptor's own stat, which is exactly the window
      // the real implementation's `fstat` closes.
      options.duringDigest?.(path);
      const after = nodes.get(path);
      return {
        sha256,
        sizeBytes: bytes.byteLength,
        probes,
        observed: after === undefined
          ? { kind: 'missing', sizeBytes: 0, dev: '0', ino: '0', mtimeMs: 0, nlink: 0 }
          : statOf(path, after),
      };
    },
  };
}

/** A clock that never actually waits, so a two-second dwell costs a test nothing. */
export function createFakeClock(): AdmissionClock & { sleeps(): readonly number[]; elapsed(): number } {
  const slept: number[] = [];
  let current = 1_700_000_000_000;
  return {
    now: () => current,
    async sleep(ms: number) { slept.push(ms); current += ms; },
    sleeps: () => [...slept],
    elapsed: () => current - 1_700_000_000_000,
  };
}

/** A publisher that records what it was asked to publish and derives the id the real one would. */
export function createFakePublisher(options: { failTimes?: number } = {}): AdmissionPublisher & {
  published(): readonly { path: string; versionKey: string; itemId: string; sha256: string }[];
} {
  const rows: Array<{ path: string; versionKey: string; itemId: string; sha256: string }> = [];
  let remainingFailures = options.failTimes ?? 0;
  return {
    async publish(plan, itemId) {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('the registration boundary refused');
      }
      rows.push({ path: plan.projectedPath, versionKey: plan.versionKey, itemId, sha256: plan.sha256 });
      return { projectedEntryId: deriveProjectedEntryId(plan.projectedPath) };
    },
    published: () => rows.map((row) => ({ ...row })),
  };
}

/** A credential filesystem whose every refusal a test can produce on any platform. */
export function createFakeApiKeyFileSystem(
  entries: Readonly<Record<string, { stat: ApiKeyFileStat; content?: string; readThrows?: boolean }>>,
): ApiKeyFileSystem {
  return {
    async lstatFile(path: string): Promise<ApiKeyFileStat> {
      const entry = entries[path];
      if (entry === undefined) return { kind: 'missing', sizeBytes: 0 };
      return entry.stat;
    },
    async readFileNoFollow(path: string): Promise<Buffer> {
      const entry = entries[path];
      if (entry === undefined || entry.readThrows === true) throw new Error('EACCES');
      return Buffer.from(entry.content ?? '', 'utf8');
    },
  };
}

/** Deterministic media bytes of an exact length. Large enough to clear the minimum output bound. */
export function mediaBytes(sizeBytes: number, seed = 7): Buffer {
  const buffer = Buffer.allocUnsafe(sizeBytes);
  let value = seed;
  for (let index = 0; index < sizeBytes; index += 1) {
    value = (value * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    buffer[index] = value & 0xff;
  }
  return buffer;
}

/** One megabyte and a bit: above `MIN_OUTPUT_BYTES`, below the three-window probe threshold. */
export const SMALL_MEDIA_BYTES = 1_048_576 + 4_096;
