import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

// The consumer's actual download: one deterministic `.tar.gz`, plus a checksum they can verify separately.
//
// An `actions/upload-artifact` upload is not a release. It expires, it is a zip-of-a-zip, and it requires a
// GitHub login and a trip through the Actions UI to reach — which is not a download link you can put in a
// README. The durable artifact is a release asset, and a release asset that is not reproducible cannot be
// checked against anything, so the archive is written by hand rather than shelled out to `tar`:
//
//   * entries sorted by path, so ordering never depends on a filesystem's readdir;
//   * every timestamp zero, every uid/gid zero, every owner name empty, so a build is not stamped with who
//     built it or when;
//   * ustar format with no PAX extended headers (which would carry timestamps back in);
//   * gzip through node's zlib, which writes no mtime into the header.
//
// The result is that two builds of the same bundle are byte-identical, and the published checksum is a fact
// about the contents rather than about the machine.

export class ReleaseArchiveError extends Error {}

export interface ArchiveEntry {
  /** Path inside the archive, relative to the archive root directory. */
  readonly path: string;
  readonly contents: string;
  /** Executable bit for the scripts a user actually runs. */
  readonly executable?: boolean;
}

export interface ArchiveResult {
  readonly filename: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  /** `sha256sum -c`-compatible sidecar contents. */
  readonly checksumFilename: string;
  readonly checksum: string;
}

const BLOCK = 512;
const NAME_LIMIT = 100;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function header(entry: { path: string; size: number; mode: number; typeflag: '0' | '5' }): Buffer {
  if (Buffer.byteLength(entry.path, 'utf8') > NAME_LIMIT) {
    // A longer path would need a PAX or GNU extension, and both carry data this archive deliberately does
    // not have. Refusing is honest; silently truncating would not be.
    throw new ReleaseArchiveError(`path too long for a plain ustar archive: ${entry.path}`);
  }
  const block = Buffer.alloc(BLOCK, 0);
  block.write(entry.path, 0, NAME_LIMIT, 'utf8');
  block.write(octal(entry.mode, 8), 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii');            // uid
  block.write(octal(0, 8), 116, 8, 'ascii');            // gid
  block.write(octal(entry.size, 12), 124, 12, 'ascii');
  block.write(octal(0, 12), 136, 12, 'ascii');          // mtime — always the epoch
  block.write('        ', 148, 8, 'ascii');             // checksum placeholder
  block.write(entry.typeflag, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  // uname/gname stay empty, so the archive does not record the account that built it.
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

function pad(size: number): Buffer {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder, 0);
}

/**
 * Build the archive. `root` is the single top-level directory everything is placed under, so extracting
 * cannot scatter files across the user's working directory.
 */
export function buildDeterministicArchive(root: string, entries: readonly ArchiveEntry[], filename: string): ArchiveResult {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(root)) throw new ReleaseArchiveError(`unsafe archive root: ${root}`);
  if (entries.length === 0) throw new ReleaseArchiveError('refusing to build an empty archive');

  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.path.startsWith('/') || entry.path.includes('..')) throw new ReleaseArchiveError(`unsafe path: ${entry.path}`);
    if (seen.has(entry.path)) throw new ReleaseArchiveError(`duplicate path: ${entry.path}`);
    seen.add(entry.path);
  }

  const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const blocks: Buffer[] = [header({ path: `${root}/`, size: 0, mode: 0o755, typeflag: '5' })];
  for (const entry of sorted) {
    const body = Buffer.from(entry.contents, 'utf8');
    blocks.push(header({
      path: `${root}/${entry.path}`,
      size: body.length,
      mode: entry.executable === true ? 0o755 : 0o644,
      typeflag: '0',
    }), body, pad(body.length));
  }
  // Two zero blocks end a tar; the trailing padding to 10240 keeps `tar` implementations from complaining.
  blocks.push(Buffer.alloc(BLOCK * 2, 0));
  const tar = Buffer.concat(blocks);
  const trailing = tar.length % 10240;
  const padded = trailing === 0 ? tar : Buffer.concat([tar, Buffer.alloc(10240 - trailing, 0)]);

  // level 9 for a stable, small result; node writes no mtime and no filename into the gzip header.
  const bytes = gzipSync(padded, { level: 9 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    filename,
    bytes,
    sha256,
    checksumFilename: `${filename}.sha256`,
    checksum: `${sha256}  ${filename}\n`,
  };
}

export interface ReadArchiveEntry {
  readonly path: string;
  readonly contents: string;
  readonly mode: number;
  readonly mtime: number;
  readonly uid: number;
  readonly gid: number;
  readonly typeflag: string;
}

/** Read an archive back, so a test can assert what a user will actually extract. */
export function readDeterministicArchive(bytes: Buffer): ReadArchiveEntry[] {
  const tar = gunzipSync(bytes);
  const entries: ReadArchiveEntry[] = [];
  let offset = 0;
  const readField = (start: number, length: number): string =>
    tar.subarray(offset + start, offset + start + length).toString('ascii').replace(/\0.*$/, '').trim();

  while (offset + BLOCK <= tar.length) {
    const name = readField(0, NAME_LIMIT);
    if (name === '') { offset += BLOCK; continue; }
    const size = parseInt(readField(124, 12) || '0', 8);
    const typeflag = tar.subarray(offset + 156, offset + 157).toString('ascii');
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size).toString('utf8');
    entries.push({
      path: name,
      contents: body,
      mode: parseInt(readField(100, 8) || '0', 8),
      mtime: parseInt(readField(136, 12) || '0', 8),
      uid: parseInt(readField(108, 8) || '0', 8),
      gid: parseInt(readField(116, 12) || '0', 8),
      typeflag,
    });
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}
