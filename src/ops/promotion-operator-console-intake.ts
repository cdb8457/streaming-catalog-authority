import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSOLE_ARTIFACT_FILENAMES,
  CONSOLE_PHASES,
  type ArtifactStatus,
  type OperatorConsoleInput,
} from './promotion-operator-console.js';

// The one place the Phase 242 console chain touches a filesystem. Every caller that turns an operator's
// directory or bundle into console intake comes through here -- the Phase 242 CLI and the Phase 243 dashboard
// both do -- so discovery semantics exist once and cannot drift apart between surfaces.
//
// ALLOWLISTED, NEVER PATH-DRIVEN. Candidate paths are built from the FIXED filename table joined to the one
// directory the operator named, non-recursively. No filename, glob or path is ever taken from the data being
// read, so a hostile artifact cannot steer a read. Entries that are not on the allowlist are counted and
// otherwise untouched -- a directory legitimately holds other things.
//
// FAIL CLOSED ON ANYTHING THAT IS NOT A PLAIN, BOUNDED FILE. A symlink, directory, device or socket sitting
// under an allowlisted name is refused rather than followed: following it would let something outside the
// named directory be read as though it were an artifact. So is a file larger than the cap -- an artifact of
// this chain is a few kilobytes of digests, and nothing here needs to be able to exhaust memory. Both are
// reported as MALFORMED, never as ABSENT: an operator whose artifact was refused must be told, not left
// reading "the phase has not happened yet".
//
// AND THE CHECK MUST BIND TO THE OBJECT, NOT THE NAME. Inspecting a path and then separately opening that
// path is a check/use race: between the two calls the name can be repointed at a symlink, and the open
// follows it -- so the thing validated and the thing read are different objects, and every guarantee above
// evaporates. A name is not a handle.
//
// So the read is anchored to ONE opened descriptor. The name is inspected without following links, the
// descriptor is opened (with O_NOFOLLOW where the platform has it), and then everything that matters is
// re-established on the OPENED OBJECT: it must be a regular file by `fstat`, and it must be the SAME object
// the no-follow inspection saw. The bytes come from that same descriptor. The property this buys is stronger
// than "open did not follow a link" -- it is "the bytes parsed came from the object that was validated, or
// nothing was parsed at all". A swap during the window changes the identity and fails closed; a swap to a
// link pointing back at the very same file is harmless, because that file is the one already validated.
//
// Where identity cannot be established at all -- a filesystem that reports no inode -- and the platform has
// no O_NOFOLLOW either, there is no way to know what was opened, so the read is refused. Fail closed.

// Generous by three orders of magnitude for a real artifact, and still far too small to hurt.
export const CONSOLE_INTAKE_MAX_ARTIFACT_BYTES = 1024 * 1024;

// POSIX refuses the open outright on a symlink. Windows has no equivalent open flag, so there the identity
// check below is the whole of the no-follow guarantee -- which is why it is not optional.
const O_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
const NOFOLLOW_BY_OPEN = O_NOFOLLOW !== 0;

// Exists so the check/use window can be driven deterministically from a test: a physical race is not
// reproducible, and a race this important must not be tested by hoping. Production callers pass nothing, and
// the hook is invoked at exactly the moment a swap would have to happen to matter -- after the name has been
// inspected, before the descriptor is opened.
export interface ConsoleIntakeReadHooks {
  readonly afterInspect?: (path: string) => void;
}

type BoundedRead = { readonly ok: true; readonly text: string } | { readonly ok: false };
const REFUSED: BoundedRead = { ok: false };

// Two stats of the same object taken through different routes must agree on identity. `dev` is compared only
// when both report one: a path-based stat on Windows leaves it zero while the handle-based stat fills in the
// volume serial, so requiring it there would refuse every legitimate artifact. `ino` is exact on both (it is
// the NTFS file index) and is compared as a BigInt so a 64-bit index cannot lose precision on the way.
function isSameObject(inspected: { dev: bigint; ino: bigint }, opened: { dev: bigint; ino: bigint }): boolean {
  if (inspected.ino === 0n || opened.ino === 0n) return NOFOLLOW_BY_OPEN;
  if (inspected.ino !== opened.ino) return false;
  if (inspected.dev !== 0n && opened.dev !== 0n && inspected.dev !== opened.dev) return false;
  return true;
}

export function readBoundedRegularFile(path: string, hooks: ConsoleIntakeReadHooks = {}): BoundedRead {
  let inspected: { dev: bigint; ino: bigint; size: bigint; isFile: () => boolean };
  try { inspected = lstatSync(path, { bigint: true }); } catch { return REFUSED; }
  if (!inspected.isFile()) return REFUSED;                                   // symlink, directory, device, socket
  if (inspected.size > BigInt(CONSOLE_INTAKE_MAX_ARTIFACT_BYTES)) return REFUSED;

  hooks.afterInspect?.(path);

  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) return REFUSED;
    if (!isSameObject(inspected, opened)) return REFUSED;

    // One byte more than the size just validated, so a file that GREW between the stat and the read fills the
    // buffer and is refused rather than read short or allocated for. The allocation is bounded twice over --
    // by the validated size and by the cap -- so no amount of growth turns into an unbounded allocation.
    const capacity = Number(inspected.size) + 1;
    const buffer = Buffer.alloc(capacity);
    let total = 0;
    while (total < capacity) {
      const read = readSync(fd, buffer, total, capacity - total, null);
      if (read === 0) break;
      total += read;
    }
    if (total >= capacity) return REFUSED;
    return { ok: true, text: buffer.toString('utf8', 0, total) };
  } catch {
    return REFUSED;
  } finally {
    // The descriptor is released on every path out, including the refusals above and any throw.
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

export class ConsoleIntakeError extends Error {
  readonly code: 'CONSOLE_INTAKE_DIRECTORY_UNREADABLE' | 'CONSOLE_INTAKE_BUNDLE_UNREADABLE';

  // The offending path is deliberately never carried on the error: it is operator input, and nothing in this
  // chain reflects operator input back into a message, a log or a page.
  constructor(code: ConsoleIntakeError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'ConsoleIntakeError';
  }
}

export interface DiscoveredConsoleIntake {
  readonly artifacts: Record<string, { readonly status: ArtifactStatus; readonly report?: unknown }>;
  readonly unknownFilesIgnored: number;
}

export function consoleIntakeAllowedFilenames(): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const phase of CONSOLE_PHASES) for (const name of CONSOLE_ARTIFACT_FILENAMES[phase]!) allowed.add(name);
  return allowed;
}

export function discoverConsoleIntake(dir: string, hooks: ConsoleIntakeReadHooks = {}): DiscoveredConsoleIntake {
  let entries: readonly string[];
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    entries = readdirSync(dir);
  } catch {
    throw new ConsoleIntakeError('CONSOLE_INTAKE_DIRECTORY_UNREADABLE', 'the artifact directory is missing or not a readable directory');
  }

  const allowed = consoleIntakeAllowedFilenames();
  const artifacts: Record<string, { status: ArtifactStatus; report?: unknown }> = {};

  for (const phase of CONSOLE_PHASES) {
    const names = CONSOLE_ARTIFACT_FILENAMES[phase]!.filter((name) => entries.includes(name));
    if (names.length === 0) continue;                                  // ABSENT: normal, never a defect
    if (names.length > 1) { artifacts[String(phase)] = { status: 'DUPLICATE' }; continue; }
    artifacts[String(phase)] = readArtifact(join(dir, names[0]!), hooks);
  }
  return { artifacts, unknownFilesIgnored: entries.filter((e) => !allowed.has(e)).length };
}

function readArtifact(path: string, hooks: ConsoleIntakeReadHooks): { status: ArtifactStatus; report?: unknown } {
  const read = readBoundedRegularFile(path, hooks);
  if (!read.ok) return { status: 'MALFORMED' };
  try {
    return { status: 'PRESENT', report: JSON.parse(read.text) };
  } catch {
    // Read cleanly, but not JSON. A defect in the artifact, NOT an absence.
    return { status: 'MALFORMED' };
  }
}

export function readConsoleBundle(path: string, hooks: ConsoleIntakeReadHooks = {}): unknown {
  const read = readBoundedRegularFile(path, hooks);
  if (!read.ok) throw new ConsoleIntakeError('CONSOLE_INTAKE_BUNDLE_UNREADABLE', 'the bundle file is missing, oversized, or not valid JSON');
  try {
    return JSON.parse(read.text);
  } catch {
    throw new ConsoleIntakeError('CONSOLE_INTAKE_BUNDLE_UNREADABLE', 'the bundle file is missing, oversized, or not valid JSON');
  }
}

// One intake, either way in, so both surfaces build the console from identical input.
export function buildConsoleIntake(
  source: { readonly dir: string } | { readonly bundle: string },
  hooks: ConsoleIntakeReadHooks = {},
): OperatorConsoleInput {
  if ('dir' in source) {
    const found = discoverConsoleIntake(source.dir, hooks);
    return { mode: 'DIRECTORY', artifacts: found.artifacts, unknownFilesIgnored: found.unknownFilesIgnored };
  }
  return { mode: 'BUNDLE', bundle: readConsoleBundle(source.bundle, hooks) };
}
