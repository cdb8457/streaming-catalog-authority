import {
  USENET_ADMISSION_BOUNDS,
  isTransientRefusal,
  type UsenetRefusalReason,
} from './sab-contract.js';
import { seal, type SealedValue } from './sealed.js';
import { PROJECTION_PROBE_PLAN, probeOffsetsFor, type ProbePosition } from '../projection/manifest-v1.js';

// Projection Phase 9 §3, FOURTH DELIVERABLE — "a completed-output admission service with no-follow path
// checks, stable-size confirmation and digesting".
//
// THE THREE HARD REFUSALS THIS FILE IS THE ENFORCEMENT OF:
//
//   "publish a path while the worker can still mutate it"
//   "follow a symlink or admit a device, FIFO, socket or directory as media"
//   "infer success from a job disappearing from the queue"
//
// AND THE ORDER OF THE CHECKS IS PART OF THE CONTRACT. Cheap structural refusals come first, so a path that
// escapes the root, a component that is a symlink, or a node that is a device is refused before anything is
// opened. Then the dwell, then the digest, then the RE-CHECK after the digest. Reordering any of them turns a
// refusal into a window.
//
// WHY EVERY FILESYSTEM CALL IS INJECTED. Not for tidiness. The refusals this module exists for are conditions
// a test host cannot always create — a symlink needs a privilege on Windows, a FIFO does not exist there at
// all, a file that changes size between two stats is a race nobody can schedule reliably. An injected
// filesystem lets the boundary suite drive every single one deterministically on every platform, and the real
// implementation is thirty lines that the operator gate exercises against a real kernel.
//
// THE PATHS ARE POSIX. The worker runs in a Linux container and its completed directory is a Linux path. A
// backslash in one is not a separator, it is a character in a filename, and this module refuses it rather
// than interpreting it — because interpreting it differently from the kernel is how a containment check gets
// walked past.

export type OutputNodeKind =
  | 'file' | 'directory' | 'symlink' | 'block-device' | 'character-device' | 'fifo' | 'socket'
  | 'unknown' | 'missing';

/** What one `lstat` says. `dev` and `ino` are strings because a Linux inode does not fit a JS number. */
export interface OutputStat {
  readonly kind: OutputNodeKind;
  readonly sizeBytes: number;
  readonly dev: string;
  readonly ino: string;
  readonly mtimeMs: number;
  readonly nlink: number;
  readonly mode?: number;
}

export interface OutputDigestResult {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly probes: readonly { readonly position: ProbePosition; readonly offset: number; readonly length: number; readonly sha256: string }[];
  /**
   * The stat taken on the OPEN DESCRIPTOR, after the read finished.
   *
   * WHY IT COMES BACK FROM HERE RATHER THAN FROM A SECOND `lstat`. A second `lstat` describes whatever is at
   * the path NOW, which is a different question from "did the thing I just read get replaced while I read
   * it". An `fstat` on the descriptor the bytes came from answers the second one, and that is the one that
   * matters.
   */
  readonly observed: OutputStat;
}

export interface OutputFileSystem {
  /** `lstat`. A symlink reports itself and is never resolved. */
  lstat(path: string): Promise<OutputStat>;
  /** Directory entry names, not paths. Bounded by the caller. */
  readDir(path: string): Promise<readonly string[]>;
  /**
   * Open with O_NOFOLLOW, read the whole file once, and produce the whole-file digest, the fixed probe
   * windows and the descriptor's own final stat.
   */
  digest(path: string, sizeBytes: number): Promise<OutputDigestResult>;
}

export interface AdmissionClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type OutputCheck<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: UsenetRefusalReason; readonly detail: string; readonly transient: boolean };

const refuse = <T>(reason: UsenetRefusalReason, detail: string): OutputCheck<T> =>
  ({ ok: false, reason, detail, transient: isTransientRefusal(reason) });
const accept = <T>(value: T): OutputCheck<T> => ({ ok: true, value });

// ---------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------

/**
 * Split an absolute POSIX path into segments, refusing everything that is not one.
 *
 * NO RESOLUTION HAPPENS HERE. `.` and `..` are refused rather than collapsed, because collapsing them is a
 * claim about what the kernel would do with a path containing a symlink, and this module's whole position is
 * that it does not make claims like that — it walks, checking each component.
 */
export function splitAbsolutePosixPath(path: string): OutputCheck<readonly string[]> {
  if (typeof path !== 'string' || path.length === 0) {
    return refuse('output-path-not-normalized', 'the path is empty');
  }
  if (path.length > 4096) return refuse('output-path-not-normalized', 'the path is longer than the contract allows');
  if (!path.startsWith('/')) return refuse('output-path-not-normalized', 'the path is not absolute');
  if (path.includes('\\')) return refuse('output-path-not-normalized', 'the path contains a backslash');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return refuse('output-path-not-normalized', 'the path contains a control character');
  if (path !== path.normalize('NFC')) return refuse('output-path-not-normalized', 'the path is not NFC-normalized');

  const segments = path.split('/').slice(1);
  const trimmed = segments.length > 0 && segments[segments.length - 1] === '' ? segments.slice(0, -1) : segments;
  if (trimmed.length === 0) return refuse('output-path-not-normalized', 'the path names no component below the root');
  for (const segment of trimmed) {
    if (segment.length === 0) return refuse('output-path-not-normalized', 'the path has an empty component');
    if (segment === '.' || segment === '..') {
      return refuse('output-path-escapes-root', 'the path contains a relative component');
    }
    if (segment.length > 255) return refuse('output-path-not-normalized', 'a path component is longer than a name can be');
  }
  return accept(trimmed);
}

/**
 * The containment check, done on SEGMENTS rather than on strings.
 *
 * A string `startsWith` test is the classic way this is got wrong: `/downloads/complete-other` starts with
 * `/downloads/complete`. Comparing component by component cannot make that mistake.
 */
export function relativeSegmentsUnderRoot(root: string, candidate: string): OutputCheck<readonly string[]> {
  const rootSegments = splitAbsolutePosixPath(root);
  if (!rootSegments.ok) return rootSegments;
  const candidateSegments = splitAbsolutePosixPath(candidate);
  if (!candidateSegments.ok) return candidateSegments;

  if (candidateSegments.value.length <= rootSegments.value.length) {
    return refuse('output-path-escapes-root', 'the completed path is not strictly below the configured root');
  }
  for (let index = 0; index < rootSegments.value.length; index += 1) {
    if (candidateSegments.value[index] !== rootSegments.value[index]) {
      return refuse('output-path-escapes-root', 'the completed path is not below the configured root');
    }
  }
  return accept(candidateSegments.value.slice(rootSegments.value.length));
}

// ---------------------------------------------------------------------------------------------------------
// The no-follow walk
// ---------------------------------------------------------------------------------------------------------

/**
 * Walk from the root to the leaf, checking each component, following nothing.
 *
 * WHY A WALK AND NOT ONE `lstat` ON THE LEAF. An `lstat` on the leaf proves the LEAF is not a symlink. It
 * proves nothing about `/downloads/complete/job` being a symlink into somebody else's share — and if it is,
 * the file this process opens is not the file it checked, whatever the leaf's own stat said.
 */
export async function walkNoFollow(
  fs: OutputFileSystem,
  root: string,
  segments: readonly string[],
  expectLeaf: 'file' | 'directory',
): Promise<OutputCheck<OutputStat>> {
  const rootStat = await statOrMissing(fs, root);
  if (rootStat.kind === 'missing') return refuse('output-root-unusable', 'the configured completed root does not exist');
  if (rootStat.kind === 'symlink') return refuse('output-root-unusable', 'the configured completed root is a symbolic link');
  if (rootStat.kind !== 'directory') return refuse('output-root-unusable', 'the configured completed root is not a directory');

  let path = root;
  for (let index = 0; index < segments.length; index += 1) {
    path = `${path}/${segments[index] as string}`;
    const stat = await statOrMissing(fs, path);
    const last = index === segments.length - 1;

    if (stat.kind === 'missing') {
      return refuse('output-missing', 'a component of the completed path does not exist');
    }
    if (stat.kind === 'symlink') {
      return last
        ? refuse('output-is-symlink', 'the completed output is a symbolic link, which is refused rather than followed')
        : refuse('output-component-is-symlink', 'a directory on the way to the completed output is a symbolic link');
    }
    if (!last) {
      if (stat.kind !== 'directory') {
        return refuse('output-component-is-symlink', 'a component on the way to the completed output is not a directory');
      }
      continue;
    }
    if (expectLeaf === 'directory') {
      if (stat.kind !== 'directory') return refuse('output-root-unusable', 'the completed job path is not a directory');
      return accept(stat);
    }
    if (stat.kind !== 'file') {
      // A DEVICE, FIFO OR SOCKET NAMED AS MEDIA IS THE INTERESTING CASE, not the accidental one. Reading a
      // FIFO blocks forever; reading a character device can produce unbounded bytes. Both are refused by
      // KIND before anything is opened.
      return refuse('output-not-regular-file', 'the completed output is not a regular file');
    }
    return accept(stat);
  }
  return refuse('output-missing', 'the completed path named nothing below the root');
}

async function statOrMissing(fs: OutputFileSystem, path: string): Promise<OutputStat> {
  try {
    return await fs.lstat(path);
  } catch {
    return { kind: 'missing', sizeBytes: 0, dev: '0', ino: '0', mtimeMs: 0, nlink: 0 };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Finding the one media file
// ---------------------------------------------------------------------------------------------------------

/**
 * The extensions an admitted entry may have.
 *
 * DELIBERATELY SHORT. This is a Phase 9 alpha whose Usenet half serves ordinary video files to three media
 * servers. An allowlist means a `.exe`, a `.sh` or a `.par2` that survives unpacking cannot become a file in
 * a namespace three media servers scan, and widening it later is a visible edit rather than a side effect.
 */
export const USENET_MEDIA_EXTENSIONS: readonly string[] = Object.freeze([
  'mkv', 'mp4', 'm4v', 'mov', 'avi', 'ts', 'm2ts', 'webm',
]);

/**
 * Names that mean the worker has not finished, whatever its API said.
 *
 * §4's "publish a path while the worker can still mutate it" has a second, quieter form: the worker says
 * Completed, its post-processing has moved on, and an unpack artefact is still being deleted in the
 * background. Refusing on residue is transient — the next reconciliation looks again — and it costs nothing.
 */
export const USENET_RESIDUE_SUFFIXES: readonly string[] = Object.freeze([
  '.rar', '.r00', '.par2', '.001', '.tmp', '.part', '.!ut', '.incomplete', '.__unpack__',
]);

// `.nzb` IS DELIBERATELY NOT ON THAT LIST, and the reason is the difference between an artefact and an input.
// An operator who has SABnzbd's NZB backup writing into the completed folder would otherwise have every job
// refused as residue — transiently, so reconciliation would retry it forever and never tell anybody why. The
// original NZB is the operator's own input, which §4 forbids deleting and which nothing here should be
// waiting for the worker to remove. It is simply not a media extension, so it is not a candidate, and it is
// ignored exactly as a `.nfo` or a `.srt` is.

export interface FoundOutput {
  /** Relative to the completed root, as segments. Never a bare string that could be re-split differently. */
  readonly segments: readonly string[];
  readonly stat: OutputStat;
}

/**
 * Find the single admissible media file under a completed job directory.
 *
 * EXACTLY ONE, OR A REFUSAL. Zero means the worker produced nothing this contract will publish; more than one
 * means the control plane would be choosing, and "the biggest one" is a heuristic that quietly publishes the
 * wrong file the first time a release ships with a sample and a feature of similar size. An operator who has
 * a genuine multi-file release is told so, by name of reason, and Phase 9 §6 already says this alpha does not
 * do download selection policy.
 */
export async function findAdmissibleOutput(
  fs: OutputFileSystem,
  root: string,
  jobSegments: readonly string[],
): Promise<OutputCheck<FoundOutput>> {
  // THE WORKER MAY NAME A FILE RATHER THAN A FOLDER. SABnzbd normally reports a completed job's own
  // directory, but a configuration that does not create one per job reports the file. Handling only the
  // directory case would refuse those jobs as `output-root-unusable`, which is a true sentence about the
  // wrong thing. The file case is checked FIRST because it is the narrower one, and because every refusal it
  // can produce — a symlink, a device, a missing component — is the refusal the directory walk would produce
  // anyway.
  const asFile = await walkNoFollow(fs, root, jobSegments, 'file');
  if (asFile.ok) {
    const name = (jobSegments[jobSegments.length - 1] ?? '').toLowerCase();
    if (USENET_RESIDUE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
      return refuse('output-unpack-residue', 'the worker named an unpack or repair artefact as its output');
    }
    const dot = name.lastIndexOf('.');
    if (!USENET_MEDIA_EXTENSIONS.includes(dot === -1 ? '' : name.slice(dot + 1))) {
      return refuse('output-not-uniquely-identified', 'the worker named a file this contract will not publish');
    }
    if (asFile.value.sizeBytes < USENET_ADMISSION_BOUNDS.MIN_OUTPUT_BYTES) {
      return refuse('output-empty', 'the worker named a file smaller than anything this contract publishes');
    }
    return accept({ segments: jobSegments, stat: asFile.value });
  }

  const leaf = await walkNoFollow(fs, root, jobSegments, 'directory');
  if (!leaf.ok) return leaf;

  const candidates: FoundOutput[] = [];
  const queue: Array<readonly string[]> = [jobSegments];
  let visited = 0;

  while (queue.length > 0) {
    const current = queue.shift() as readonly string[];
    const depth = current.length - jobSegments.length;
    if (depth > USENET_ADMISSION_BOUNDS.MAX_OUTPUT_DEPTH) {
      return refuse('output-root-unusable', 'the completed job directory is nested deeper than the contract walks');
    }
    const path = `${root}/${current.join('/')}`;
    let entries: readonly string[];
    try {
      entries = await fs.readDir(path);
    } catch {
      return refuse('output-root-unusable', 'a directory under the completed job could not be listed');
    }
    if (entries.length > USENET_ADMISSION_BOUNDS.MAX_DIRECTORY_ENTRIES) {
      return refuse('output-root-unusable', 'a directory under the completed job holds more entries than the contract walks');
    }

    for (const entry of entries) {
      visited += 1;
      if (visited > USENET_ADMISSION_BOUNDS.MAX_DIRECTORY_ENTRIES) {
        return refuse('output-root-unusable', 'the completed job holds more entries than the contract walks');
      }
      if (entry === '.' || entry === '..' || entry.includes('/') || entry.includes('\\')) {
        return refuse('output-path-not-normalized', 'a directory entry is not a plain name');
      }
      const lower = entry.toLowerCase();
      if (USENET_RESIDUE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
        return refuse('output-unpack-residue', 'an unpack or repair artefact is still present beside the output');
      }

      const segments = [...current, entry];
      const stat = await statOrMissing(fs, `${root}/${segments.join('/')}`);
      if (stat.kind === 'symlink') {
        return refuse('output-component-is-symlink', 'a symbolic link is present under the completed job');
      }
      if (stat.kind === 'directory') {
        queue.push(segments);
        continue;
      }
      if (stat.kind !== 'file') {
        return refuse('output-not-regular-file', 'a device, FIFO or socket is present under the completed job');
      }
      const dot = lower.lastIndexOf('.');
      const extension = dot === -1 ? '' : lower.slice(dot + 1);
      if (!USENET_MEDIA_EXTENSIONS.includes(extension)) continue;
      if (stat.sizeBytes < USENET_ADMISSION_BOUNDS.MIN_OUTPUT_BYTES) continue;
      candidates.push({ segments, stat });
    }
  }

  if (candidates.length === 0) {
    return refuse('output-not-uniquely-identified', 'the completed job holds no file this contract will publish');
  }
  if (candidates.length > 1) {
    return refuse('output-not-uniquely-identified',
      'the completed job holds more than one publishable file, and this phase does not choose between them');
  }
  return accept(candidates[0] as FoundOutput);
}

// ---------------------------------------------------------------------------------------------------------
// Stability and proof
// ---------------------------------------------------------------------------------------------------------

/** Two stats describe the same file, unchanged, when all four of these agree. */
export function sameFile(a: OutputStat, b: OutputStat): boolean {
  return a.kind === b.kind && a.dev === b.dev && a.ino === b.ino
    && a.sizeBytes === b.sizeBytes && a.mtimeMs === b.mtimeMs;
}

export interface ProvenOutput {
  readonly segments: readonly string[];
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly probes: readonly { readonly position: ProbePosition; readonly offset: number; readonly length: number; readonly sha256: string }[];
  /** The absolute path, sealed. It exists so the caller can hand it on, not so it can be printed. */
  readonly sealedPath: SealedValue;
  readonly stat: OutputStat;
}

/**
 * Prove one completed output: it holds still, it is what it was, and these are its bytes.
 *
 * THE SEQUENCE, AND WHY EACH STEP IS WHERE IT IS.
 *
 *   sample 1 -> dwell -> sample 2      the worker is not writing it now
 *   size and kind bounds               it is a plausible media file at all
 *   digest, through one descriptor     these are the bytes, read once, without re-opening the path
 *   fstat on that same descriptor      the bytes that were read came from the file that was checked
 *   lstat the path once more           the NAME still points at that same file
 *
 * The last two are different questions and both have to be asked. The fstat catches a truncate or an append
 * during the read; the final lstat catches a rename-over, where the descriptor is fine and the path now names
 * something else — which is exactly what an unpacker doing an atomic replace does.
 */
export async function proveOutput(
  fs: OutputFileSystem,
  clock: AdmissionClock,
  root: string,
  segments: readonly string[],
): Promise<OutputCheck<ProvenOutput>> {
  const path = `${root}/${segments.join('/')}`;

  const first = await walkNoFollow(fs, root, segments, 'file');
  if (!first.ok) return first;
  if (first.value.nlink > 1) {
    // A SECOND NAME IS A SECOND WRITER. Nothing about the checks below binds a file that some other path can
    // still reach, and an admitted entry whose bytes another name can replace is not admitted, it is borrowed.
    return refuse('output-multiply-linked', 'the completed output has more than one name on the filesystem');
  }
  if (first.value.sizeBytes < USENET_ADMISSION_BOUNDS.MIN_OUTPUT_BYTES) {
    return refuse('output-empty', 'the completed output is smaller than anything this contract will publish');
  }
  if (first.value.sizeBytes > USENET_ADMISSION_BOUNDS.MAX_OUTPUT_BYTES) {
    return refuse('output-too-large', 'the completed output is larger than this contract will digest');
  }

  let previous = first.value;
  for (let sample = 1; sample < USENET_ADMISSION_BOUNDS.STABLE_SAMPLES; sample += 1) {
    await clock.sleep(USENET_ADMISSION_BOUNDS.STABLE_DWELL_MS);
    const next = await walkNoFollow(fs, root, segments, 'file');
    if (!next.ok) return next;
    if (!sameFile(previous, next.value)) {
      return refuse('output-still-changing', 'the completed output changed between two observations');
    }
    previous = next.value;
  }

  let digested: OutputDigestResult;
  try {
    digested = await fs.digest(path, previous.sizeBytes);
  } catch {
    return refuse('output-missing', 'the completed output could not be read');
  }

  if (digested.sizeBytes !== previous.sizeBytes) {
    return refuse('output-mutated-during-digest', 'the completed output changed size while it was being read');
  }
  if (!sameFile(previous, digested.observed)) {
    return refuse('output-mutated-during-digest', 'the completed output was replaced while it was being read');
  }
  const after = await walkNoFollow(fs, root, segments, 'file');
  if (!after.ok) return after;
  if (!sameFile(previous, after.value)) {
    return refuse('output-mutated-during-digest', 'the completed path named a different file after it was read');
  }
  // THE LINK COUNT IS ASKED AGAIN, ON BOTH LATER OBSERVATIONS, AND NOT ONLY ON THE FIRST.
  //
  // `sameFile` deliberately compares kind, device, inode, size and mtime — and `link(2)` changes none of
  // those. So a second name created after the first stat is invisible to every check between here and there:
  // the file is the same file, at the same size, with the same mtime, and it now has another name through
  // which its bytes can be replaced the instant this function returns. The first check is the cheap one that
  // refuses the ordinary case before anything is read; these two close the window it leaves open.
  if (digested.observed.nlink > 1 || after.value.nlink > 1) {
    return refuse('output-multiply-linked',
      'the completed output gained a second name while it was being proved, so something other than the '
      + 'worker can still replace its bytes');
  }

  const expectedProbes = probeOffsetsFor(digested.sizeBytes, PROJECTION_PROBE_PLAN.WINDOW_BYTES);
  if (digested.probes.length !== expectedProbes.length) {
    return refuse('output-mutated-during-digest', 'the probe set does not match the plan the size implies');
  }
  for (let index = 0; index < expectedProbes.length; index += 1) {
    const want = expectedProbes[index];
    const got = digested.probes[index];
    if (want === undefined || got === undefined || got.position !== want.position
      || got.offset !== want.offset || got.length !== want.length) {
      return refuse('output-mutated-during-digest', 'a probe is not at the offset its size implies');
    }
    if (!/^[0-9a-f]{64}$/.test(got.sha256)) {
      return refuse('output-mutated-during-digest', 'a probe digest is not 64 lower-case hex characters');
    }
  }
  if (!/^[0-9a-f]{64}$/.test(digested.sha256)) {
    return refuse('output-mutated-during-digest', 'the whole-file digest is not 64 lower-case hex characters');
  }

  return accept({
    segments,
    sizeBytes: digested.sizeBytes,
    sha256: digested.sha256,
    probes: digested.probes,
    sealedPath: seal('completed-path', path),
    stat: previous,
  });
}
