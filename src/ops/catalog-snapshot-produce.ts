import { randomBytes } from 'node:crypto';
import {
  closeSync, constants as fsConstants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  CatalogExportError,
  produceCatalogSnapshot,
  type ProducedSnapshot,
} from '../core/catalog/external-export.js';
import { INBOX_NAME_RE } from './catalog-import-inbox.js';

// Phase 274 — writing a produced snapshot to disk, atomically, and saying exactly what was produced.
//
// WHY THE FILESYSTEM PART IS ITS OWN MODULE. `core/catalog/external-export.ts` takes a string and returns a
// value; it cannot open a file, and that is what makes "producing a snapshot performs no I/O of its own"
// checkable rather than promised. Everything that touches a descriptor is here, and it is deliberately small
// enough to read in one sitting.
//
// -----------------------------------------------------------------------------------------------------
// THE WRITE IS ATOMIC, AND A HALF-WRITTEN SNAPSHOT CANNOT EXIST AT THE DESTINATION NAME.
// -----------------------------------------------------------------------------------------------------
//
// The bytes go to a temporary file in the SAME directory, are flushed to stable storage with `fsync`, and are
// then PUBLISHED to the destination name in one step. A reader — including this product's own import inbox,
// which is watching that folder — sees either the old file or the complete new one, never a prefix. A crash
// before the publish leaves the temporary file behind and the destination untouched; the temporary name
// begins with a dot, which the inbox's own name grammar refuses, so a leftover can never be offered as a
// snapshot.
//
// -----------------------------------------------------------------------------------------------------
// "NO OVERWRITE" IS A GUARANTEE, NOT A CHECK — AND `rename` COULD NOT GIVE IT.
// -----------------------------------------------------------------------------------------------------
//
// THE DEFECT THIS CLOSES. The first version of this module `lstat`ed the destination, refused if something
// was there, and then published with `renameSync`. Both halves are individually correct and the pair is
// still wrong: `rename` REPLACES its destination unconditionally, so two producers that both found the name
// free would both write a temp and both rename — and the second would silently destroy the first completed
// snapshot, under a flag whose whole documented meaning is that it will not do that. The window is small and
// it is real: an import folder is a shared folder, and "I ran it twice by mistake" is the ordinary case.
//
// HOW IT IS CLOSED. When `--overwrite` was NOT given, the publish is `link(temp, destination)`. `link` is the
// POSIX primitive that FAILS when its destination exists, atomically, with `EEXIST` — there is no window in
// which the name was checked and then taken, because the check IS the creation of the name. The temporary
// name is then unlinked, leaving exactly one name for an inode whose bytes were already `fsync`ed. When
// `--overwrite` WAS given, the publish is `renameSync`, because replacing is then the thing that was asked
// for and rename is the only primitive that does it atomically.
//
// THIS IS AN INTERNAL HARD LINK BETWEEN TWO NAMES OF ONE SNAPSHOT FILE IN ONE DIRECTORY. It is not a symbolic
// link, it is not a media link, it does not point into a media library, and it exists for microseconds. The
// absolute invariant this product keeps — it never creates a MEDIA symlink and never couples itself to an
// acquisition pipeline — is untouched by it, and `test/external-snapshot-produce.ts` asserts the invariant
// that actually matters (no symbolic-link call appears anywhere in this module, and a published snapshot is
// not a symbolic link) rather than forbidding the one primitive that makes the refusal honest. That test
// scans for the symbolic-link call by NAME, so this comment deliberately does not spell it.
//
// WHERE A FILESYSTEM CANNOT DO IT, THE ANSWER IS A REFUSAL. A filesystem with no hard links (FAT, some
// network mounts) fails the `link` with `EPERM`/`ENOSYS`/`EOPNOTSUPP`. This module then REFUSES and says so,
// rather than falling back to a `rename` it knows can clobber — the same discipline the import inbox applies
// to `O_NOFOLLOW`. An operator who genuinely wants replacement can pass `--overwrite`, which is a decision
// rather than an accident.
//
// THE TEMPORARY FILE CANNOT BE A SYMLINK, AND THE GUARANTEE IS THE OPEN'S, NOT A CHECK'S. It is created with
// `O_CREAT | O_EXCL`, which fails if the name exists at all — including as a symbolic link, including a
// dangling one. `O_NOFOLLOW` is added where the platform defines it; it is belt-and-braces here rather than
// the guarantee, which is why this module — unlike the browser-facing inbox — still works on a platform that
// does not define it. The destination is ALSO `lstat`ed first, which is where a symlink or a non-regular file
// at that name is diagnosed properly; that check is advisory for the race and authoritative for nothing, and
// the publish above is what actually decides.
//
// THE PUBLISHED FILE IS GROUP- AND WORLD-READABLE, AND THE TEMPORARY ONE IS NOT. The temp is created 0600, so
// a partially written document is never readable by anyone else; the descriptor is `fchmod`ed to 0644 after
// the last byte and before the publish. That is not cosmetic: the shipped stack mounts the import folder into
// a container that runs as a DIFFERENT uid, so a snapshot produced on the host at 0600 is a snapshot the
// product itself cannot read — which the acceptance gates would have discovered as a failed import.
//
// AND THAT `fchmod` FAILS CLOSED. The first version of it swallowed every error with a comment about Windows,
// which is true of exactly one platform and false of the others: on POSIX an `EPERM` or an `EROFS` would have
// published a 0600 snapshot and reported success, and the run that discovered it would be the import that
// could not read the file. Windows has no POSIX mode bits, so the step is SKIPPED there — deliberately, by
// asking the platform, not by catching whatever comes back. Everywhere else a failure removes the temporary,
// publishes nothing, and says so, carrying the errno code (which names a rule, never a path). The mode change
// is then `fsync`ed in its own right: it is metadata, and metadata that is not durable before the publish is
// a permission that can be lost by the same power cut the data survived.
//
// NO DIRECTORY IS EVER CREATED. The destination directory must already exist; a producer that created
// directories would be a producer that could be pointed at a path and made to build one.
//
// THE REPORT IS REDACTION-SAFE BY CONSTRUCTION. Counts, digests, closed-set words and a BASE NAME. No title,
// no reference value, no attribute value, no external-system label, no directory and no absolute path appears
// in it — a produced-file report is exactly the kind of thing that ends up in a support bundle.

export const SNAPSHOT_PRODUCE_REPORT = 'phase-274-external-snapshot';
export const SNAPSHOT_PRODUCE_VERSION = 1;

/** The NUL character, spelled without an escape so this file stays plain text end to end. */
const NUL = String.fromCharCode(0);

/**
 * When set, every produced snapshot must land inside this directory, named only by its base name.
 *
 * The same discipline `CATALOG_IMPORT_DIR` applies to reading: an installation that has declared where
 * produced snapshots go cannot be talked into writing one somewhere else. Unset — a developer or a bare CLI
 * run — the operator names any path they can already write, with this process's own privileges and no more.
 */
export const SNAPSHOT_OUT_DIR_ENV = 'CATALOG_SNAPSHOT_OUT_DIR';

export class SnapshotProducePathError extends Error {
  readonly code = 'CATALOG_SNAPSHOT_PATH_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'SnapshotProducePathError';
  }
}

export interface ResolvedOutputPath {
  /** The resolved directory the file will be created in. Never put in a report. */
  readonly directory: string;
  /** The base name. This is the only part of the path any report ever carries. */
  readonly name: string;
  /** The full destination path. Never put in a report. */
  readonly path: string;
}

/**
 * Decide where a produced snapshot goes, and refuse anything that is not a plain file name in a real
 * directory.
 *
 * THE NAME MUST BE ONE THE IMPORT INBOX WOULD OFFER. `INBOX_NAME_RE` — a bare `.json` name, no separator, no
 * leading dot, no control character. Producing a file the product's own panel would then refuse to list would
 * be a workflow with a hole in the middle of it, so the two grammars are the same grammar.
 *
 * MESSAGES NAME THE CONSTRAINT, NEVER THE PATH. A rejected path is usually a mount that is not where somebody
 * thought it was, and echoing host paths into a report that gets pasted into an issue is how a filesystem
 * layout leaves the machine.
 */
export function resolveProducedSnapshotPath(
  requested: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOutputPath {
  if (requested.trim() === '') throw new SnapshotProducePathError('no output file was named');
  if (requested.includes(NUL)) throw new SnapshotProducePathError('the output file name is not a usable path');

  const configured = env[SNAPSHOT_OUT_DIR_ENV];
  const configuredDir = configured === undefined || configured.trim() === '' ? null : configured;

  let directory: string;
  let name: string;
  if (configuredDir !== null) {
    // A BARE NAME ONLY. With a configured output directory there is no legitimate reason to spell a path:
    // allowing one would mean the containment rule is enforced by a comparison rather than by the grammar,
    // and a comparison is something a future edit can weaken.
    if (requested.includes('/') || requested.includes('\\') || isAbsolute(requested)) {
      throw new SnapshotProducePathError(
        `${SNAPSHOT_OUT_DIR_ENV} is set, so the output must be a plain file name inside it, with no folder part`);
    }
    name = requested;
    try {
      directory = realpathSync(resolve(configuredDir));
    } catch {
      throw new SnapshotProducePathError(`the directory named by ${SNAPSHOT_OUT_DIR_ENV} does not exist or cannot be read`);
    }
  } else {
    const full = resolve(requested);
    name = basename(full);
    try {
      directory = realpathSync(dirname(full));
    } catch {
      throw new SnapshotProducePathError('the folder the output file would go in does not exist or cannot be read');
    }
  }

  if (!INBOX_NAME_RE.test(name)) {
    throw new SnapshotProducePathError(
      'the output file must be a plain .json name of letters, digits, dot, dash and underscore — the same '
      + 'names the import panel is willing to offer');
  }

  const path = join(directory, name);
  // Belt-and-braces for the configured case, and the only containment check in the unconfigured one: after
  // resolving the directory through symlinks, the destination must still be exactly one component below it.
  if (relative(directory, path) !== name) {
    throw new SnapshotProducePathError('the output file must be directly inside the folder that was resolved for it');
  }
  return { directory, name, path };
}

export type SnapshotProduceMode = 'preview' | 'write';

export interface SnapshotProductionReport {
  readonly report: typeof SNAPSHOT_PRODUCE_REPORT;
  readonly version: typeof SNAPSHOT_PRODUCE_VERSION;
  readonly ok: boolean;
  readonly mode: SnapshotProduceMode;
  /**
   * That the records came from an external system, and NOT WHICH ONE.
   *
   * The SNAPSHOT keeps the operator's real label — its `source` is `external.<system>` and every derived item
   * id is a function of that, which is the whole provenance mechanism. This REPORT does not, because it is a
   * different kind of document: it is printed to scrollback, to a CI log and into a support bundle somebody
   * pastes into an issue, and "which acquisition or media tool this operator runs" is exactly the sort of
   * thing that should not travel that way. A report that carried the label while calling itself
   * redaction-safe would be making a claim it does not keep.
   */
  readonly provenance: 'external-input';
  readonly entries: number;
  readonly records: number;
  readonly references: number;
  readonly recordsWithoutReferences: number;
  /** sha256 of the export that was read. */
  readonly inputDigest: string;
  /** sha256 of the exact bytes produced. What an operator compares two runs by. */
  readonly contentDigest: string;
  /** The importer's own order-independent digest of the normalized document. */
  readonly snapshotDigest: string;
  readonly bytes: number;
  /** The BASE NAME the snapshot was written as, or null for a preview. Never a directory, never a path. */
  readonly fileName: string | null;
  /** True when an existing file at that name was replaced. */
  readonly replaced: boolean;
  /** Declared, and asserted by this phase's suite against this module's own imports. */
  readonly network: 'none';
  readonly acquisition: 'external-input-only';
  readonly mediaAccess: 'none';
  readonly symlinksCreated: 0;
  readonly notes: readonly string[];
}

export interface ProduceSnapshotInput {
  /** The export document, already read as text by whoever resolved it. */
  readonly text: string;
  /** Where to write it. Omitted for a preview, which writes nothing at all. */
  readonly output?: ResolvedOutputPath;
  /** Replace an existing file at that name. Off by default: producing must not clobber by accident. */
  readonly overwrite?: boolean;
  /**
   * A TEST SEAM, called after the temporary file is complete and immediately before it is published.
   *
   * It exists for one reason: the no-overwrite guarantee is about a window — the moment between "the name was
   * free" and "the name is mine" — and a suite that cannot open that window can only argue the window is
   * closed. This lets a suite create the destination in EXACTLY that window, deterministically, so
   * "two producers cannot both succeed" is proved rather than believed. It is the same reasoning that made
   * `catalog-import-inbox.ts` take an injectable syscall surface.
   *
   * Production callers never pass it, and `test/external-snapshot-produce.ts` asserts that no `src/` caller
   * does. Passing it cannot weaken anything: the publish below decides on its own, whatever this did.
   */
  readonly beforePublish?: () => void;
}

/**
 * Produce a snapshot, and — unless this is a preview — write it atomically.
 *
 * A PREVIEW IS STRUCTURALLY INCAPABLE OF WRITING. It is not a flag consulted late: with no `output` there is
 * no path in this function's scope, so there is nothing for a later edit to accidentally write to.
 */
export function produceSnapshotFile(input: ProduceSnapshotInput): SnapshotProductionReport {
  const produced = produceCatalogSnapshot(input.text);
  if (input.output === undefined) {
    return report(produced, 'preview', null, false, [
      'This was a preview. Nothing was written. Re-run with --out <name.json> to produce the file.',
    ]);
  }
  const overwrite = input.overwrite === true;
  const replaced = writeAtomically(input.output, produced.text, overwrite,
    input.beforePublish === undefined ? {} : { beforePublish: input.beforePublish });
  // THE NO-REPLACE CLAIM IS MADE ONLY WHERE IT IS TRUE. `replaced` comes from the check BEFORE the write, so
  // on the `--overwrite` path it cannot see a file that appeared during it — which is fine, because that path
  // was asked to replace. Claiming "it could not have replaced anything" there would be claiming a property
  // of the OTHER path.
  const note = overwrite
    ? (replaced
      ? 'An existing snapshot of that name was replaced, atomically: a reader saw either the old file or the new one.'
      : 'The snapshot was written atomically. --overwrite was given, so anything that had appeared at that name '
        + 'would have been replaced.')
    : 'The snapshot was written atomically: it appeared complete or not at all, and it could not have replaced '
      + 'a file that appeared at that name while it was being written.';
  return report(produced, 'write', input.output.name, replaced, [
    note,
    'Nothing was imported. Preview it with ops:catalog-import, then apply it.',
  ]);
}

function report(
  produced: ProducedSnapshot,
  mode: SnapshotProduceMode,
  fileName: string | null,
  replaced: boolean,
  notes: readonly string[],
): SnapshotProductionReport {
  return {
    report: SNAPSHOT_PRODUCE_REPORT,
    version: SNAPSHOT_PRODUCE_VERSION,
    ok: true,
    mode,
    provenance: 'external-input',
    entries: produced.entries,
    records: produced.snapshot.items.length,
    references: produced.references,
    recordsWithoutReferences: produced.entriesWithoutReferences,
    inputDigest: produced.inputDigest,
    contentDigest: produced.contentDigest,
    snapshotDigest: produced.snapshot.digest,
    bytes: produced.bytes,
    fileName,
    replaced,
    network: 'none',
    acquisition: 'external-input-only',
    mediaAccess: 'none',
    symlinksCreated: 0,
    notes: [...notes],
  };
}

/** Said the same way by the early check and by the publish, so one refusal cannot read as two different ones. */
export const SNAPSHOT_ALREADY_THERE_MESSAGE =
  'a file of that name is already there; pass --overwrite to replace it';

/**
 * The mode a PUBLISHED snapshot carries: readable by the account that imports it, writable by nobody else.
 *
 * The shipped stack bind-mounts the import folder into a container running as a different uid from whoever
 * produced the file, so this is a functional requirement and not a preference.
 */
export const PUBLISHED_FILE_MODE = 0o644;

/**
 * The two calls that decide whether a completed temporary is publishable, and the platform question in front
 * of them.
 *
 * INJECTABLE FOR ONE REASON: a suite has to be able to prove BOTH branches — that Windows skips the mode
 * change, and that a POSIX failure publishes nothing — on whatever host it happens to be running on. A test
 * that could only exercise the branch its own platform takes would leave the other one covered by nothing but
 * a reading of the code, which is how `fchmod` came to swallow every error in the first place. Same reasoning
 * as `catalog-import-inbox.ts`'s injectable syscall surface.
 */
export interface SnapshotModeSurface {
  readonly platform: NodeJS.Platform;
  fchmod(fd: number, mode: number): void;
  fsync(fd: number): void;
}

export const realModeSurface: SnapshotModeSurface = {
  platform: process.platform,
  fchmod: (fd, mode) => fchmodSync(fd, mode),
  fsync: (fd) => fsyncSync(fd),
};

/**
 * Make a completed temporary readable by the account that will import it, durably — or refuse.
 *
 * Called with the descriptor still open, after the data has been flushed and before anything is published.
 * Throws `SnapshotProducePathError` on POSIX when the mode cannot be set; the caller removes the temporary and
 * publishes nothing, which is the only honest answer to "this file would not have been readable".
 */
export function makePublishable(fd: number, surface: SnapshotModeSurface = realModeSurface): void {
  // WINDOWS IS ASKED FOR, NOT INFERRED FROM A FAILURE. It has no POSIX mode bits to set, so there is nothing
  // to do and nothing to lose; every other platform must succeed or publish nothing.
  if (surface.platform === 'win32') return;
  try {
    surface.fchmod(fd, PUBLISHED_FILE_MODE);
  } catch (err) {
    // THE ERRNO CODE AND NOTHING ELSE. `fchmod` acts on a descriptor, so the driver's own message carries no
    // path — but taking only a bounded, upper-case code means that stays true however the runtime words it.
    const code = (err as NodeJS.ErrnoException).code;
    const named = typeof code === 'string' && /^[A-Z]{1,16}$/.test(code) ? ` (${code})` : '';
    throw new SnapshotProducePathError(
      `the snapshot could not be made readable by the account that imports it${named}, so nothing was published. `
      + 'Produce into a folder this user owns on an ordinary local filesystem.');
  }
  // THE MODE CHANGE IS METADATA, AND IT IS FLUSHED IN ITS OWN RIGHT. The data was already `fsync`ed above;
  // without this second flush a power cut between here and the publish could leave a durable file whose
  // durable mode is still 0600, which is exactly the unreadable snapshot this step exists to prevent.
  try {
    surface.fsync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const named = typeof code === 'string' && /^[A-Z]{1,16}$/.test(code) ? ` (${code})` : '';
    throw new SnapshotProducePathError(
      `the snapshot's permissions could not be flushed to stable storage${named}, so nothing was published.`);
  }
}

/**
 * Publish a completed temporary file to its destination name.
 *
 * WITHOUT `--overwrite` THIS IS `link`, AND THAT IS THE WHOLE POINT. `link` fails when the destination exists
 * — atomically, with `EEXIST`, decided by the kernel and not by anything this process observed a moment
 * earlier. It is what makes "producing must not clobber by accident" a guarantee rather than a check that a
 * second producer can run straight past. `rename` cannot give it: rename replaces, always.
 *
 * WITH `--overwrite` THIS IS `rename`, AND THAT IS ALSO THE POINT. Replacement was asked for, and rename is
 * the primitive that replaces without the destination ever being briefly absent.
 *
 * Exported so a suite can drive it directly with two independently completed temporaries, which is exactly
 * the shape of two concurrent producers.
 */
export function publishTemporary(temporary: string, destination: string, overwrite: boolean): void {
  if (overwrite) {
    try {
      renameSync(temporary, destination);
    } catch {
      try { unlinkSync(temporary); } catch { /* the publish already failed; a leftover temp is not a second failure */ }
      throw new SnapshotProducePathError('the snapshot could not be moved into place');
    }
    return;
  }

  try {
    linkSync(temporary, destination);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // A SECOND PRODUCER GOT THERE FIRST, or the file was there all along and the early check raced it.
      // Either way the destination is untouched and this run wrote nothing anybody can see.
      throw new SnapshotProducePathError(SNAPSHOT_ALREADY_THERE_MESSAGE);
    }
    if (code === 'EPERM' || code === 'ENOSYS' || code === 'EOPNOTSUPP' || code === 'ENOTSUP' || code === 'EXDEV' || code === 'EMLINK') {
      // NO SILENT FALLBACK TO `rename`. A filesystem that cannot link cannot give the no-replace guarantee,
      // and quietly publishing anyway would mean the default refusal is a comment rather than a behaviour.
      throw new SnapshotProducePathError(
        'this filesystem cannot publish a snapshot without the risk of replacing one that appeared while it was '
        + 'being written, so nothing was published. Produce into a folder on an ordinary local filesystem, or '
        + 'pass --overwrite if replacing whatever is at that name is what you actually want.');
    }
    throw new SnapshotProducePathError('the snapshot could not be moved into place');
  } finally {
    // The temporary name goes either way. On success the inode now has the destination name and losing this
    // one costs nothing; on failure it is residue. A temp that cannot be unlinked is dot-prefixed, so the
    // import inbox will never offer it — it is untidy, and it is not a reason to fail a publish that worked.
    try { unlinkSync(temporary); } catch { /* untidy, never unsafe */ }
  }
}

/**
 * The seams a SUITE may pass and production never does.
 *
 * Grouped into one object so they are obviously not part of the ordinary call: `writeAtomically(output, text,
 * overwrite)` is the whole production surface, and anything in here is a test opening a window or standing in
 * for a platform.
 */
export interface SnapshotWriteSeams {
  /** Called after the temporary is complete and immediately before it is published. */
  readonly beforePublish?: () => void;
  /** Stands in for the platform and the two mode calls, so both branches can be proved on any host. */
  readonly mode?: SnapshotModeSurface;
}

/**
 * Write `text` to `output.path` so that the name is never observed holding a partial document.
 *
 * Returns whether an existing file was replaced.
 */
export function writeAtomically(
  output: ResolvedOutputPath,
  text: string,
  overwrite: boolean,
  seams: SnapshotWriteSeams = {},
): boolean {
  // WHAT IS ALREADY THERE, ASKED WITH `lstat` SO A SYMLINK IS SEEN AS A SYMLINK rather than reported as
  // whatever it points at. This is a DIAGNOSTIC, not the guarantee: it is what tells an operator "that name is
  // a symbolic link" or "that name is a directory" instead of a bare EEXIST, and it saves producing a document
  // that could not be published anyway. The publish below is what actually decides, and it decides atomically.
  let existed = false;
  try {
    const current = lstatSync(output.path);
    existed = true;
    if (current.isSymbolicLink()) {
      throw new SnapshotProducePathError('the output name is a symbolic link, and this command will not write through one');
    }
    if (!current.isFile()) {
      throw new SnapshotProducePathError('the output name is not a regular file');
    }
    if (!overwrite) {
      throw new SnapshotProducePathError(SNAPSHOT_ALREADY_THERE_MESSAGE);
    }
  } catch (err) {
    if (err instanceof SnapshotProducePathError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new SnapshotProducePathError('the output file could not be examined');
    }
  }

  const buffer = Buffer.from(text, 'utf8');
  // A LEADING DOT, ON PURPOSE: `INBOX_NAME_RE` refuses it, so a temporary file left behind by a crash can
  // never be offered to an operator as a snapshot. The random suffix means two producers running at once
  // cannot collide, and `O_EXCL` means a collision would be a refusal rather than a silent overwrite.
  const temporary = join(output.directory, `.${output.name}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  } catch {
    throw new SnapshotProducePathError('a temporary file could not be created beside the output; check the folder is writable');
  }

  try {
    // `fstat` on the descriptor we hold, not on the name: it is the file that was created, and nothing can
    // substitute it afterwards because the name is never mentioned again until the publish.
    if (!fstatSync(fd).isFile()) {
      throw new SnapshotProducePathError('the temporary output is not a regular file');
    }
    let written = 0;
    while (written < buffer.byteLength) {
      written += writeSync(fd, buffer, written, buffer.byteLength - written, null);
    }
    // FLUSHED BEFORE THE PUBLISH. Without this the publish can be durable while the bytes are not, and a
    // machine that loses power leaves the destination name pointing at a zero-length file — which is the
    // exact "the snapshot appeared and was empty" failure the atomic write exists to prevent.
    fsyncSync(fd);
    // READABLE ONLY NOW, AND ON THE DESCRIPTOR RATHER THAN THE NAME. The temp was created 0600 so a partial
    // document was never anyone else's to read; the published snapshot has to be readable by the container
    // that imports it, which runs as a different uid from whoever produced the file on the host. This THROWS
    // on POSIX when it cannot be done, and the catch below is what turns that into "nothing was published".
    makePublishable(fd, seams.mode ?? realModeSurface);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(temporary); } catch { /* the write already failed; a leftover temp is not a second failure */ }
    if (err instanceof SnapshotProducePathError) throw err;
    throw new SnapshotProducePathError('the snapshot could not be written');
  }
  closeSync(fd);

  // THE WINDOW, OPENED ON PURPOSE — only ever by a suite. See `SnapshotWriteSeams.beforePublish`.
  //
  // IT IS INSIDE THE CLEANUP, and that is not a formality: the temporary is COMPLETE by this point, so a hook
  // that throws and left it behind would leave a full snapshot lying in the operator's import folder under a
  // name nothing ever collects. Production never passes a hook and so can never reach this, which is exactly
  // why it would have gone unnoticed.
  if (seams.beforePublish !== undefined) {
    try {
      seams.beforePublish();
    } catch (err) {
      try { unlinkSync(temporary); } catch { /* the hook already failed; a leftover temp is not a second failure */ }
      // Rethrown as it came: the error belongs to whoever passed the hook, and rewording a suite's own failure
      // into this module's vocabulary would only hide what actually went wrong.
      throw err;
    }
  }

  publishTemporary(temporary, output.path, overwrite);

  // The DIRECTORY entry, flushed too, so the publish itself survives a power loss. Best-effort: opening a
  // directory for fsync is not portable (Windows refuses it), and a produced file that is durable but whose
  // directory entry is not is still strictly better than no attempt at all.
  try {
    const dirFd = openSync(output.directory, fsConstants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* not portable, and not a reason to fail a write that succeeded */ }

  return existed;
}

/** The human-readable summary. Counts, digests, a base name, and nothing else. */
export function renderSnapshotProduction(result: SnapshotProductionReport): string {
  const lines: string[] = [];
  lines.push(`Snapshot production — ${result.mode === 'preview' ? 'PREVIEW (nothing was written)' : 'WRITTEN'}`);
  // THE LABEL OF THE SYSTEM THE EXPORT CAME OUT OF IS DELIBERATELY ABSENT. The snapshot itself carries it, as
  // `external.<system>`, and that is where provenance belongs; this line is what somebody pastes into an issue.
  lines.push(`  provenance        ${result.provenance}`);
  lines.push(`  entries read      ${result.entries}`);
  lines.push(`  records produced  ${result.records}`);
  lines.push(`  provider refs     ${result.references}`);
  lines.push(`  without refs      ${result.recordsWithoutReferences}`);
  lines.push(`  input digest      ${result.inputDigest.slice(0, 16)}`);
  lines.push(`  content digest    ${result.contentDigest.slice(0, 16)}`);
  lines.push(`  snapshot digest   ${result.snapshotDigest.slice(0, 16)}`);
  lines.push(`  bytes             ${result.bytes}`);
  if (result.fileName !== null) lines.push(`  written as        ${result.fileName}${result.replaced ? ' (replaced)' : ''}`);
  lines.push(`  network           ${result.network}`);
  lines.push(`  acquisition       ${result.acquisition}`);
  lines.push(`  media access      ${result.mediaAccess}`);
  lines.push(`  symlinks created  ${result.symlinksCreated}`);
  for (const note of result.notes) lines.push(`  note: ${note}`);
  lines.push(`  RESULT: ${result.ok ? 'OK' : 'INCOMPLETE'}`);
  return lines.join('\n');
}

export { CatalogExportError };
