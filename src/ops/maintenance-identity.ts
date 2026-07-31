import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readBackupManifest, type BackupManifest } from './complete-backup.js';
import { verifyBackupSet } from './backup-set-verification.js';
import { MaintenanceRefused, readFileNoFollow } from './maintenance-safety.js';
import { instantOf } from './retention-model.js';

// Phase 313 — the read-only primitives that answer "is this thing still exactly the thing we recorded".
//
// WHY THIS MODULE EXISTS. Two commands in this product now remove directories out of a backup destination:
// `ops:backup-retention` removes backup sets, and `ops:safety-set-lifecycle` removes the claim directories a
// restore published its safety set into. Both have the same load-bearing question immediately before every
// irreversible act — is the tree at this path byte-for-byte the one the plan was made against — and a second
// hand-written copy of that answer is how one of them quietly stops checking something the other checks.
//
// NOTHING HERE PERFORMS AN EFFECT. No rename, no unlink, no write, no directory creation, no child process,
// no network. Every function reads, and either returns a verdict or throws `MaintenanceRefused`. That is what
// makes it safe for the two commands to share: a shared primitive that could act would be a shared primitive
// that could act on the wrong tree.
//
// IT IMPORTS NEITHER COMMAND. `complete-restore.ts` imports the marker id below; if this module imported
// `complete-restore.ts` back for its constants there would be an import cycle, and a cycle between a module
// that defines a constant and a module that validates against it is exactly the shape that produces a
// half-initialised constant at module load. So everything version-specific is passed IN by the caller.

// -----------------------------------------------------------------------------------------------------------
// A backup set's identity
// -----------------------------------------------------------------------------------------------------------

/**
 * Everything an operation recorded about a set at the moment it decided to act on it.
 *
 * `setDigest` alone is not enough and never was: it is computed over what the MANIFEST declares — the set
 * name, the schema version and each component's recorded digest — so two sets taken minutes apart from an
 * unchanged installation hash identically, and a component whose BYTES changed after the set was taken does
 * not move it at all. The verdict, the exact finding set and the manifest's own fields are what close both.
 */
export interface BackupSetCommitment {
  readonly name: string;
  readonly setDigest: string;
  readonly takenAt: string | null;
  readonly schemaVersion: number | null;
  readonly bytes: number;
  readonly entries: number;
  /** Whether the set VERIFIED when the commitment was made. A set that has since started verifying differently
   * is a set that changed, whichever direction it moved in. */
  readonly verified: boolean;
  readonly findings: readonly string[];
}

/** What a manifest says about the shape of a set. The only manifest fields any of this reasons about. */
export interface ManifestShape {
  readonly name: string;
  readonly takenAt: string | null;
  readonly takenAtMs: number | null;
  readonly schemaVersion: number | null;
  readonly bytes: number;
  readonly entries: number;
}

export function manifestShape(name: string, manifest: BackupManifest): ManifestShape {
  const instant = instantOf(manifest.takenAt);
  const declared = manifest.components.filter((component) => component.present);
  return {
    name,
    takenAt: instant === null ? null : instant.takenAt,
    takenAtMs: instant === null ? null : instant.takenAtMs,
    schemaVersion: typeof manifest.schemaVersion === 'number' ? manifest.schemaVersion : null,
    bytes: declared.reduce((total, component) => total + numberOr(component.bytes), 0),
    entries: declared.reduce((total, component) => total + numberOr(component.entries), 0),
  };
}

function numberOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Prove the tree at `path` is EXACTLY the set an operation committed to.
 *
 * A COMMITMENT IS NOT A NAME. The four layers below are each here because one of them alone is not enough:
 *
 *   1. `lstat`, so a symbolic link or a Windows reparse point AT the set's name is refused rather than
 *      followed to bytes nothing verified.
 *   2. The set digest, which binds the manifest's declaration — so a directory replaced by a different set,
 *      or a fabricated inventory row claiming a stranger's directory is a set of ours, dies here.
 *   3. The verdict and the exact finding set, which bind the BYTES — `setDigest` does not move when a
 *      component is tampered with, and `COMPONENT_CHANGED` does.
 *   4. The manifest's own `takenAt`, sizes and schema version, which are what distinguish one of this
 *      product's sets from another of them when the digests agree.
 *
 * The wording of every refusal is deliberately the wording `ops:backup-retention` shipped with, because that
 * command's operators have read it and its suite asserts it.
 */
export function proveBackupSetIdentity(path: string, want: BackupSetCommitment): void {
  if (want.setDigest === '') {
    throw new MaintenanceRefused('this operation recorded no identity for this set, so nothing was removed for it');
  }
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new MaintenanceRefused('this set could not be examined, so nothing was removed for it');
  }
  if (stats.isSymbolicLink()) {
    throw new MaintenanceRefused('this set is a symbolic link, and this command will not remove through one');
  }
  if (!stats.isDirectory()) throw new MaintenanceRefused('this set is not a directory, so it was left alone');
  let report;
  try {
    report = verifyBackupSet(path);
  } catch {
    throw new MaintenanceRefused('this set could not be verified against what was planned, so it was left alone');
  }
  if (report.setDigest !== want.setDigest) {
    throw new MaintenanceRefused(
      'this set is not the one this operation planned to remove — its contents do not match the identity '
      + 'recorded when the plan was made. Nothing was removed for it.');
  }
  const findings = [...new Set(report.problems.map((problem) => problem.finding))].sort();
  if (report.ok !== want.verified || JSON.stringify(findings) !== JSON.stringify([...want.findings])) {
    throw new MaintenanceRefused(
      'this set no longer verifies the way it did when the plan was made. Nothing was removed for it.');
  }
  let manifest: BackupManifest;
  try {
    manifest = readBackupManifest(path);
  } catch {
    throw new MaintenanceRefused('this set\'s manifest could not be read again, so nothing was removed for it');
  }
  const shape = manifestShape(want.name, manifest);
  if (shape.takenAt !== want.takenAt || shape.bytes !== want.bytes || shape.entries !== want.entries
    || shape.schemaVersion !== want.schemaVersion) {
    throw new MaintenanceRefused(
      'this set\'s manifest no longer says what it said when the plan was made. Nothing was removed for it.');
  }
}

// -----------------------------------------------------------------------------------------------------------
// A restore safety-set claim's identity
// -----------------------------------------------------------------------------------------------------------

/**
 * The marker `ops:complete-restore` writes inside a claim directory before it records the claim anywhere.
 *
 * IT IS DECLARED HERE AND IMPORTED THERE, not copied. A second literal of this string would be a second
 * definition of what a claim IS, and the command that removes claims and the command that creates them
 * disagreeing about that is the failure this module exists to make impossible.
 */
export const SAFETY_CLAIM_MARKER_ID = 'catalog-authority.restore-safety-claim';

/**
 * The file name the marker lives under inside a claim directory.
 *
 * Declared beside the marker id for the same reason, and re-exported by `complete-restore.ts` under the name
 * its own callers already use.
 */
export const SAFETY_CLAIM_MARKER_FILE = 'catalog-restore-claim.json';

/** A claim marker is a handful of short fields. A file at that name larger than this is not one of ours. */
export const MAX_CLAIM_MARKER_BYTES = 64 * 1024;

/** What a proved marker says. Every field is validated before it is returned; none is a path. */
export interface RestoreClaimIdentity {
  readonly nonce: string;
  readonly planDigest: string;
  readonly suffix: string;
}

/**
 * Why a directory is not a claim this build may act on. A CLOSED VOCABULARY, so a decision an operator reads
 * is one of a fixed list and a class a future build adds is a compile error rather than a default.
 */
export type ClaimMarkerRefusal =
  | 'NO_MARKER'
  | 'MARKER_UNREADABLE'
  | 'MARKER_NOT_OURS'
  | 'MARKER_OTHER_SCHEMA'
  | 'MARKER_MALFORMED'
  | 'MARKER_NAME_DISAGREES';

export const CLAIM_MARKER_REFUSALS: readonly ClaimMarkerRefusal[] = Object.freeze([
  'NO_MARKER', 'MARKER_UNREADABLE', 'MARKER_NOT_OURS', 'MARKER_OTHER_SCHEMA', 'MARKER_MALFORMED',
  'MARKER_NAME_DISAGREES',
]);

export type ClaimMarkerReading =
  | { readonly ok: true; readonly identity: RestoreClaimIdentity }
  | { readonly ok: false; readonly why: ClaimMarkerRefusal };

/**
 * What the caller has to tell this function about the build whose claims it is reading.
 *
 * PASSED IN RATHER THAN IMPORTED. `complete-restore.ts` owns the journal version, the nonce shape and the
 * directory naming; this module owns the reading. Handing them across the call keeps the dependency pointing
 * one way, and it means a build that bumps its journal version cannot leave a stale copy of the old number
 * here for a marker validator to accept.
 */
export interface ClaimMarkerExpectation {
  /** The journal schema this build implements. A marker from any other is refused AT THE BOUNDARY. */
  readonly journalVersion: number;
  readonly nonceRe: RegExp;
  /** How this build names a claim directory for a nonce. The name and the marker must agree. */
  readonly claimDirName: (nonce: string) => string;
  /** How this build derives an operation suffix from a plan digest. The marker's two fields must agree. */
  readonly suffixOf: (planDigest: string) => string;
}

/**
 * Read the ownership marker inside a claim directory, and prove it describes a claim THIS build wrote.
 *
 * -----------------------------------------------------------------------------------------------------
 * A NAME IS NOT PROVENANCE, IN EITHER DIRECTION.
 * -----------------------------------------------------------------------------------------------------
 *
 * `.pre-restore-claim-<24 hex>` is a name any process can create, and a directory holding a valid marker can
 * be renamed to anything at all. So this checks BOTH: the marker must be one of ours, and the directory's own
 * name must be the one this build derives from the nonce inside it. A marker under a name that disagrees is
 * `MARKER_NAME_DISAGREES` — reported, and never acted on, because a claim somebody moved is a claim whose
 * relationship to the run that made it nobody here can reconstruct.
 *
 * IT ALSO CHECKS THE MARKER AGAINST ITSELF. The suffix a restore writes is derived from its plan digest, so
 * the two fields cannot legitimately disagree — and a forger editing one without the other is caught by an
 * invariant that costs nothing and needs no external state to check.
 *
 * NOTHING IS FOLLOWED. The marker is opened without following a link, and a link AT the marker's name is
 * refused as `MARKER_NOT_OURS` rather than read through.
 */
export function readRestoreClaimMarker(
  claimDir: string,
  claimName: string,
  expected: ClaimMarkerExpectation,
): ClaimMarkerReading {
  const path = join(claimDir, SAFETY_CLAIM_MARKER_FILE);
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return { ok: false, why: 'NO_MARKER' };
  if (stats.isSymbolicLink() || !stats.isFile()) return { ok: false, why: 'MARKER_NOT_OURS' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileNoFollow(path, 'safety set claim marker', MAX_CLAIM_MARKER_BYTES)
      .bytes.toString('utf8'));
  } catch {
    return { ok: false, why: 'MARKER_UNREADABLE' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, why: 'MARKER_NOT_OURS' };
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.marker !== SAFETY_CLAIM_MARKER_ID) return { ok: false, why: 'MARKER_NOT_OURS' };
  // THE VERSION BOUNDARY IS BEFORE EVERY OTHER FIELD, so a marker from a build with a different persisted
  // schema is refused for BEING one rather than for whichever field happens to have moved. There is no
  // migration: a claim decides what a removal is allowed to destroy.
  if (doc.version !== 1 || doc.journalVersion !== expected.journalVersion) {
    return { ok: false, why: 'MARKER_OTHER_SCHEMA' };
  }
  if (typeof doc.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(doc.planDigest)) {
    return { ok: false, why: 'MARKER_MALFORMED' };
  }
  if (typeof doc.nonce !== 'string' || !expected.nonceRe.test(doc.nonce)) {
    return { ok: false, why: 'MARKER_MALFORMED' };
  }
  if (typeof doc.suffix !== 'string' || doc.suffix !== expected.suffixOf(doc.planDigest)) {
    return { ok: false, why: 'MARKER_MALFORMED' };
  }
  if (claimName !== expected.claimDirName(doc.nonce)) return { ok: false, why: 'MARKER_NAME_DISAGREES' };
  return { ok: true, identity: { nonce: doc.nonce, planDigest: doc.planDigest, suffix: doc.suffix } };
}
