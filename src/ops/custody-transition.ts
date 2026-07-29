import { createHash, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { FileCustodian } from '../core/crypto/file-custodian.js';
import {
  activeKek,
  kekRingExists,
  loadKekRing,
  readRootWrappingKey,
  rootKeyId,
  wholeRingDigest,
  type KekRing,
} from '../core/crypto/kek-ring.js';
import { stateDirectoryIdentity } from '../core/crypto/custodian-state-io.js';
import { readKeyFileNoFollow } from './kek-ring-secret-io.js';
import { verifyBackupSet } from './backup-set-verification.js';
import { keyLabel, keystoreSetDigest } from './kek-rotation.js';
import { assertUsableName, resolveInsideRoot } from './maintenance-safety.js';
import {
  clearCustodyRuntimeMode,
  composeFileArgs,
  readCustodyRuntimeMode,
  writeCustodyRuntimeMode,
  type CustodyRuntimeMode,
} from './custody-runtime-mode.js';
import { NO_FETCH_RUN_FLAGS, acquireCustodyStateLocks } from './custody-cutover.js';
import {
  CommandLedger,
  MaintenanceRefused,
  acquireLockDirectory,
  resolveMaintenanceRoot,
  runGuarded,
  type CommandRunner,
  type MaintenanceCommand,
} from './maintenance-safety.js';

// Phase 293 — the upgrade that must not strand a v1.1.4 installation.
//
// -----------------------------------------------------------------------------------------------------
// THE DEFECT THIS EXISTS FOR, AND IT IS THE ONE THAT COULD TAKE A LIVE INSTALLATION DOWN.
// -----------------------------------------------------------------------------------------------------
//
// Phase 289 made the runtime stack ROOT-ONLY by default and gave the temporary static wiring its own overlay,
// selected by a marker. That is right for every installation that knows about the marker — and every
// installation shipped before it has NO MARKER AT ALL. The default for an absent marker is the steady state,
// which is the correct default for a fresh install and the WRONG one for a v1.1.4 installation whose every
// wrapped key is under a static KEK and which has no ring: replace the compose files, restart, and the
// sidecar refuses to start because there is no ring for the root key to open. The app never comes up. Nothing
// is lost, and the installation is down until somebody works out why.
//
// A marker cannot fix that, because the whole problem is that the marker is missing — and a command that
// wrote one based on "is there a file at the ring's name" would be the same class of mistake this tranche
// keeps finding. So this classifies the installation by CRYPTOGRAPHIC EVIDENCE and selects the mode that
// evidence supports:
//
//   LEGACY STATIC — no ring, and the static KEK opens every wrapped key in the keystore, and a complete
//   backup verifies. Select BOOTSTRAP: the stack keeps running exactly as it did, and `ops:custody-cutover`
//   is what ends it.
//
//   INTERRUPTED ADOPTION — a ring that is exactly what an interrupted migration leaves (one generation,
//   active, no pending, adopted from the static KEK, and that generation IS this installation's static key),
//   and every wrapped key opens under it. Select BOOTSTRAP, so the cutover can resume rather than being
//   locked out by a runtime that has already moved on.
//
//   MANAGED RING — a ring the root wrapping key opens, whose ACTIVE generation opens every wrapped key in
//   the keystore. Select ROOT-ONLY: this installation has already crossed.
//
// EVERYTHING ELSE IS A REFUSAL WITH A NAME. A ring the root does not open, a static key that opens nothing,
// a keystore that opens under neither, a rotation caught in flight, a state directory reached through a
// symbolic link, a missing or unverifiable backup, and the genuinely ambiguous empty installation: each is a
// state an operator has to look at, and none of them is a mode to guess.

export const CUSTODY_TRANSITION_REPORT = 'phase-293-custody-transition';
export const CUSTODY_TRANSITION_VERSION = 1;

/** The lock this transaction holds over one installation, beside the two state locks it also takes. */
export const CUSTODY_TRANSITION_LOCK_DIRNAME = '.catalog-custody-transition.lock';

/** What the evidence says an installation IS. A closed set: there is no "probably". */
export type CustodyStateVerdict = 'legacy-static' | 'interrupted-adoption' | 'managed-ring';

export interface CustodyStateEvidence {
  readonly verdict: CustodyStateVerdict;
  readonly selectedMode: CustodyRuntimeMode;
  /** How many wrapped keys were PROVED to open under the key this verdict rests on. */
  readonly keysProved: number;
  /** The ring's active generation, where there is a ring. A number, never a key. */
  readonly ringGeneration: number | null;
  /**
   * Whether a usable ROOT WRAPPING KEY is in place — which on a released v1.1.4 installation it is NOT.
   *
   * A PREREQUISITE, NOT A CLASSIFICATION INPUT. The root key was introduced with the ring; an installation
   * that predates it has no such file, and demanding one to classify it would refuse the entire population
   * this command exists for. So it is reported, and the cutover — which genuinely cannot proceed without it
   * — is where it becomes a requirement.
   */
  readonly rootKeyReady: boolean;
  /** A digest over every proof behind the verdict. Labels and digests only; no key, ever. */
  readonly evidenceDigest: string;
}

export interface CustodyTransitionRequest {
  readonly projectRoot: string;
  readonly projectName: string;
  readonly hostStateDir: string;
  readonly hostRootKeyFile: string;
  readonly hostStaticKeyFile: string;
  readonly hostBackupsDir: string;
  /** The set inside the backups directory a LEGACY installation must have before it is moved. */
  readonly backupSetName: string;
}

export interface ResolvedCustodyTransition extends CustodyTransitionRequest {
  readonly planDigest: string;
  readonly evidence: CustodyStateEvidence;
  /** What the project is running now — which for a v1.1.4 installation is the absent-marker default. */
  readonly currentMode: CustodyRuntimeMode;
  readonly currentModeDeclared: boolean;
  /** Whether anything would actually change. A transition that changes nothing says so and does nothing. */
  readonly changes: boolean;
  readonly composeConfigDigest: string;
}

export interface CustodyTransitionReport {
  readonly report: typeof CUSTODY_TRANSITION_REPORT;
  readonly version: typeof CUSTODY_TRANSITION_VERSION;
  readonly ok: boolean;
  readonly planDigest: string;
  readonly verdict: CustodyStateVerdict;
  readonly fromMode: CustodyRuntimeMode;
  readonly toMode: CustodyRuntimeMode;
  readonly changed: boolean;
  readonly keysProved: number;
  readonly ringGeneration: number | null;
  readonly network: 'none';
  readonly notes: readonly string[];
}

export interface CustodyTransitionDeps {
  readonly runner: CommandRunner;
  readonly ledger: CommandLedger;
}

/**
 * Classify an installation by what its key material actually proves, and select the mode that supports.
 *
 * READ-ONLY, AND IT OPENS NOTHING IT DOES NOT HAVE TO. It reads the two key files, loads the ring if there is
 * one, and asks the custodian's own preflight whether the wrapped keys open. It writes nothing, takes no
 * lock, and starts and stops nothing.
 */
export function classifyCustodyState(request: CustodyTransitionRequest): CustodyStateEvidence {
  const stateDir = resolveMaintenanceRoot(request.hostStateDir, 'sidecar state directory');
  // THE STATE DIRECTORY IS PROVED BEFORE ANYTHING IS READ OUT OF IT. `stateDirectoryIdentity` refuses a
  // symbolic link at the open, so an installation whose state directory is a link to somewhere else is a
  // refusal rather than a classification of whatever is at the other end.
  try {
    stateDirectoryIdentity(stateDir);
  } catch (err) {
    throw new MaintenanceRefused(
      'the sidecar state directory is not one this command will classify: '
      + `${err instanceof Error ? err.message : 'it could not be opened'}. Nothing was changed.`);
  }

  // ---- THE RING DECIDES WHICH PROOF APPLIES, AND IT IS ASKED FIRST -----------------------------------
  //
  // THE DEFECT THIS CLOSES, AND IT WOULD HAVE MISSED THE WHOLE POPULATION. This read the ROOT WRAPPING KEY
  // before it asked whether there was a ring — and a released v1.1.4 installation has no root key file at
  // all, because that file arrived with the ring. So the command written to rescue installations that
  // predate the ring refused every one of them, on their first line, for not having a file the version they
  // are running never created.
  //
  // A ring needs a root key to open, so the ring path reads one. A legacy installation is proved by the key
  // it actually has — its static KEK — and the missing root key is reported as the PREREQUISITE it is.
  if (kekRingExists(stateDir)) return classifyRing(request, stateDir);
  let staticKek: Buffer | null = null;
  try {
    staticKek = readStaticKeyForTransition(request.hostStaticKeyFile);
    return classifyLegacy(request, stateDir, staticKek);
  } finally {
    staticKek?.fill(0);
  }
}

/**
 * Is a usable root wrapping key in place? Answered without refusing, because on the population this command
 * is for the answer is legitimately no.
 *
 * IT IS NOT CREATED HERE. Creating one is `deploy/write-custody-secret.mjs --generate`, which generates the
 * key inside its own process, writes it through a descriptor with the ownership the sidecar needs, and never
 * prints it or takes it as an argument. A transition that minted key material as a side effect of
 * classifying an installation would be a command doing something its name does not say.
 */
function rootKeyIsReady(path: string): { readonly ready: boolean; readonly rootKeyId: string | null } {
  // ---- ABSENT IS A PREREQUISITE. EVERYTHING ELSE IS A REFUSAL. ----------------------------------------
  //
  // THE DEFECT THIS CLOSES. This caught EVERY `readRootWrappingKey` failure and called it "not ready", which
  // collapsed two completely different situations into one word. A v1.1.4 installation has no root key file
  // and that is expected — it is the prerequisite this command exists to name. A root key that IS there and
  // is a symbolic link, a directory, owned by another user, readable by another account, the wrong length or
  // unreadable is not a prerequisite: it is a custody failure sitting where the most sensitive file in the
  // installation should be, and reporting it as "you have not created one yet" would send an operator to
  // create a second one beside it.
  //
  // `lstat` is what tells them apart, and it does not follow a link: nothing there at all is the only
  // `ready: false`.
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return { ready: false, rootKeyId: null };
  let root: Buffer | null = null;
  try {
    root = readRootWrappingKey(path);
    return { ready: true, rootKeyId: rootKeyId(root) };
  } catch (err) {
    throw new MaintenanceRefused(
      'there is something at this installation\'s root wrapping key path and it is not a root wrapping key '
      + `this build will use (${err instanceof Error ? err.message : 'it could not be read'}). That is not a `
      + 'missing prerequisite — it is a custody failure where the most sensitive file in the installation '
      + 'should be. Refused: nothing was changed and no runtime was selected.');
  } finally {
    root?.fill(0);
  }
}

/**
 * The set a bootstrap selection rests on, resolved as ONE NAME INSIDE the backups directory.
 *
 * THE HOLE THIS CLOSES. The name was `join`ed straight onto the backups directory, so `../..`, an absolute
 * path and a nested `a/b` all resolved to somewhere the caller chose rather than to a set inside the
 * directory this installation backs up to. `assertUsableName` is the repository's own rule for what a
 * maintenance name may be, and `resolveInsideRoot` is what proves the result is still inside the root.
 */
function resolveBackupSet(hostBackupsDir: string, backupSetName: string): string {
  const backups = resolveMaintenanceRoot(hostBackupsDir, 'backups directory');
  assertUsableName(backupSetName, 'backup set name');
  return resolveInsideRoot(backups, backupSetName, 'backup set');
}

/**
 * The backup a legacy selection rests on must contain THIS installation's root wrapping key.
 *
 * WHY A PRE-ROOT BACKUP CANNOT AUTHORIZE THIS. The cutover a bootstrap selection points at is a custody
 * CHANGE, and the set it is gated on is the way back from it. A set taken before the root wrapping key
 * existed — which is every set a v1.1.4 installation already has — restores an installation that cannot open
 * the ring the cutover is about to write. It is a perfectly good backup of the old world and no evidence at
 * all about the new one, and accepting it would mean the gate passed while the way back did not exist.
 *
 * So the set's own copy of the root key is read and compared, in constant time, against the live one.
 */
function assertBackupCarriesRootKey(backupSet: string, root: Buffer): string {
  const staged = join(backupSet, 'secrets-backup', 'custodian_root_key');
  let backedUp: Buffer;
  try {
    backedUp = readKeyFileNoFollow(staged, 'root wrapping key inside the backup');
  } catch {
    throw new MaintenanceRefused(
      'the complete backup you named does not carry this installation\'s root wrapping key, so it was taken '
      + 'before that key existed. It is a good backup of the custody this installation is LEAVING and no way '
      + 'back from the custody it is about to enter. Take a fresh complete backup now that the root key is in '
      + 'place, verify it, and run this again. Nothing was changed.');
  }
  try {
    const same = backedUp.length === root.length && timingSafeEqual(backedUp, root);
    if (!same) {
      throw new MaintenanceRefused(
        'the root wrapping key inside the complete backup you named is not the one this installation is '
        + 'wired to, so restoring that set would not restore this installation\'s custody. Take a fresh '
        + 'complete backup and verify it. Nothing was changed.');
    }
    return rootKeyId(backedUp);
  } finally {
    backedUp.fill(0);
  }
}

/** No ring: this is a v1.1.4 installation, or it is not an installation this command understands. */
function classifyLegacy(
  request: CustodyTransitionRequest,
  stateDir: string,
  staticKek: Buffer,
): CustodyStateEvidence {
  const opens = proveKeystoreOpens(stateDir, staticKek,
    'the static KEK this installation is wired to does not open the wrapped keys in its own keystore');
  if (opens.total === 0) {
    // AMBIGUOUS, AND SAID SO RATHER THAN GUESSED. An installation with no ring and no wrapped keys is either
    // a FRESH one — which wants `ops:kek-ring init` and the steady state — or a legacy one whose keystore is
    // not where this command was told to look. Selecting bootstrap would work for the first and hide the
    // second, and the second is the one that matters.
    throw new MaintenanceRefused(
      'this installation has no KEK ring and no wrapped keys, so the evidence does not say which it is. A '
      + 'FRESH installation wants a ring created once with ops:kek-ring init and then the steady state; a '
      + 'legacy one has wrapped keys, and if this one does then the keystore is not where this command was '
      + 'pointed. Nothing was changed.');
  }
  // AND THERE IS A WAY BACK BEFORE ANYTHING MOVES.
  const backupSetDigest = requireVerifiedBackup(request, 'this installation is on legacy static custody');
  const rootKey = rootKeyIsReady(request.hostRootKeyFile);
  // ---- AND IF THERE IS A ROOT KEY, THE BACKUP MUST CARRY IT ------------------------------------------
  //
  // A set taken before the root key existed cannot authorize a selection that points at a custody change.
  // Where the root key is still absent this is not reached: that installation cannot be CONFIRMED at all
  // (see `runCustodyTransition`), and the plan's job there is to name the prerequisite.
  let backupRootKeyId: string | null = null;
  if (rootKey.ready) {
    let root: Buffer | null = null;
    try {
      root = readRootWrappingKey(request.hostRootKeyFile);
      backupRootKeyId = assertBackupCarriesRootKey(
        resolveBackupSet(request.hostBackupsDir, request.backupSetName), root);
    } finally {
      root?.fill(0);
    }
  }
  return {
    verdict: 'legacy-static',
    selectedMode: 'bootstrap',
    keysProved: opens.total,
    ringGeneration: null,
    rootKeyReady: rootKey.ready,
    evidenceDigest: evidenceDigest({
      verdict: 'legacy-static',
      // BOUND EITHER WAY. A root key that appears between the plan and the confirmation changes the
      // evidence, and an operator who created one in that window should re-read the plan.
      rootKeyReady: rootKey.ready,
      rootKeyId: rootKey.rootKeyId,
      // BOUND, so a set swapped for a pre-root one between the plan and the confirmation changes the digest.
      backupRootKeyId,
      staticKeyId: keyLabel(staticKek),
      keysProved: opens.total,
      keystoreSetDigest: keystoreSetDigest(stateDir),
      backupSetDigest,
      ring: null,
    }),
  };
}

/**
 * The verified complete backup a bootstrap selection rests on, and its own digest.
 *
 * WHY EVERY BOOTSTRAP SELECTION NEEDS ONE, INCLUDING THE RESUMED MIGRATION. Selecting bootstrap points an
 * installation at `ops:custody-cutover`, and that command is gated on a set that verifies — on BOTH its
 * paths, including the resume. A transition that selected bootstrap without checking would be handing an
 * operator a runtime whose only forward step refuses, and it would be binding a digest with `null` where the
 * evidence belongs: a plan that names no backup cannot notice a set replaced between the plan and the
 * confirmation.
 *
 * The MANAGED-RING verdict deliberately does not require one, and that is a decision rather than an
 * omission: it selects the steady state, which is where that installation already is, so it changes no
 * custody and needs no way back from a change it is not making. Requiring a set there would refuse a
 * perfectly healthy installation whose backups have simply rotated.
 */
function requireVerifiedBackup(request: CustodyTransitionRequest, why: string): string {
  if (request.backupSetName.trim() === '') {
    throw new MaintenanceRefused(
      `${why} and no backup set was named. The cutover this selection points at is gated on a complete `
      + 'backup that verifies, so this refuses here rather than leaving an operator to discover it there. '
      + 'Nothing was changed.');
  }
  const backup = verifyBackupSet(resolveBackupSet(request.hostBackupsDir, request.backupSetName));
  if (!backup.ok || backup.setDigest === '') {
    throw new MaintenanceRefused(
      `${why} and the complete backup you named does not verify. The cutover this selection points at is `
      + 'gated on one. Take a complete backup, verify it, and run this again. Nothing was changed.');
  }
  return backup.setDigest;
}

/** A ring is there: it is either an interrupted adoption or an installation that has already crossed. */
function classifyRing(
  request: CustodyTransitionRequest,
  stateDir: string,
): CustodyStateEvidence {
  // A RING NEEDS ITS ROOT KEY TO BE ANYTHING AT ALL, so here — and only here — a missing or unusable one is
  // a refusal rather than a prerequisite.
  let root: Buffer;
  try {
    root = readRootWrappingKey(request.hostRootKeyFile);
  } catch (err) {
    throw new MaintenanceRefused(
      'there is a KEK ring in this sidecar state directory and its root wrapping key could not be read ('
      + `${err instanceof Error ? err.message : 'the file could not be opened'}). A ring nobody can open is `
      + 'not a state to select a runtime for. Nothing was changed.');
  }
  try {
    return classifyRingUnderRoot(request, stateDir, root);
  } finally {
    root.fill(0);
  }
}

function classifyRingUnderRoot(
  request: CustodyTransitionRequest,
  stateDir: string,
  root: Buffer,
): CustodyStateEvidence {
  let ring: KekRing;
  try {
    ring = loadKekRing(stateDir, root);
  } catch {
    throw new MaintenanceRefused(
      'there is a KEK ring in this sidecar state directory and the root wrapping key does not open it. That '
      + 'is either a corrupt ring or a root key that belongs to another installation, and neither is a state '
      + 'to select a runtime for. Nothing was changed.');
  }
  // A ROTATION CAUGHT IN FLIGHT IS NOT A STATE TO CLASSIFY. Half the keystore may be under the pending
  // generation; which mode is right depends on how the rotation ends, and this command must not decide that.
  if (ring.pending !== null) {
    throw new MaintenanceRefused(
      'this installation has a KEK rotation in progress: the ring holds a pending generation. Finish or '
      + 'resume it with ops:kek-ring rotate before moving the runtime, because which keys are under which '
      + 'generation is decided by how that rotation ends. Nothing was changed.');
  }
  const active = activeKek(ring);
  let opens: { readonly total: number };
  try {
    opens = proveKeystoreOpens(stateDir, active,
      'the ring in this sidecar state directory does not open the wrapped keys in its own keystore, so this '
      + 'installation is in a mixed state that no runtime selection is correct for');
  } finally {
    active.fill(0);
  }

  // ---- IS IT THE EXACT INTERRUPTED POST-ADOPTION STATE? ------------------------------------------------
  //
  // If it is, the runtime must go to BOOTSTRAP even though a ring exists — because the cutover that was
  // interrupted is what finishes the job, and it can only run from bootstrap. Selecting root-only here would
  // lock an installation out of finishing its own migration.
  const generations = [...ring.generations];
  const first = generations[0];
  const postAdoption = generations.length === 1 && ring.active === 1 && first !== undefined
    && first.generation === 1 && first.state === 'active' && first.origin === 'adopted-from-static-kek';
  // ---- AND THE MARKER IS WHAT TELLS TWO IDENTICAL CRYPTOGRAPHIC STATES APART -------------------------
  //
  // THE DEFECT THIS CLOSES. Treating every post-adoption ring as an INTERRUPTED migration was wrong in a
  // way that would have hurt healthy installations: a cutover that COMPLETED and has not yet rotated leaves
  // exactly the same ring — one generation, active, adopted from the static KEK, with the static key file
  // still on disk because nothing removes it. Cryptographically the two are indistinguishable, and the old
  // branch sent the completed one BACK to bootstrap: a managed installation returned to static custody by
  // the command that was supposed to protect it.
  //
  // What separates them is not cryptography but what the RUNTIME SELECTION says. A cutover that finished
  // removed the marker; one that was interrupted before that step left `bootstrap` declared. So the marker
  // resolves this one ambiguity — and nothing else. Every proof above it has already run: the root opens
  // the ring, the shape is exact, and the keystore opens under it. The marker never substitutes for a
  // proof; it only says which of two equally-proved operational states this is.
  const declared = readCustodyRuntimeMode(request.projectRoot);
  const interrupted = postAdoption && declared.declared && declared.mode === 'bootstrap';
  if (interrupted) {
    let staticKek: Buffer | null = null;
    let ringKey: Buffer | null = null;
    try {
      staticKek = readStaticKeyForTransition(request.hostStaticKeyFile);
      ringKey = Buffer.from(first!.keyHex, 'hex');
      const sameKey = ringKey.length === staticKek.length && timingSafeEqual(ringKey, staticKek);
      if (!sameKey) {
        throw new MaintenanceRefused(
          'this installation holds a ring adopted from a static KEK, and it is not the static KEK this '
          + 'installation is wired to. Those cannot both be right, and selecting a runtime for either would '
          + 'be picking one. Nothing was changed.');
      }
      // THE SAME BACKUP EVIDENCE THE RESUMED CUTOVER WILL DEMAND, bound here so a set replaced between this
      // plan and its confirmation changes the digest.
      const backupSetDigest = requireVerifiedBackup(request,
        'this installation holds a ring left by an interrupted migration');
      return {
        verdict: 'interrupted-adoption',
        selectedMode: 'bootstrap',
        keysProved: opens.total,
        ringGeneration: ring.active,
        rootKeyReady: true,
        evidenceDigest: evidenceDigest({
          verdict: 'interrupted-adoption',
          rootKeyId: rootKeyId(root),
          staticKeyId: keyLabel(staticKek),
          keysProved: opens.total,
          keystoreSetDigest: keystoreSetDigest(stateDir),
          backupSetDigest,
          ring: ringFacts(ring),
        }),
      };
    } finally {
      staticKek?.fill(0);
      ringKey?.fill(0);
    }
  }

  return {
    verdict: 'managed-ring',
    selectedMode: 'root-only',
    keysProved: opens.total,
    ringGeneration: ring.active,
    rootKeyReady: true,
    evidenceDigest: evidenceDigest({
      verdict: 'managed-ring',
      rootKeyId: rootKeyId(root),
      staticKeyId: null,
      keysProved: opens.total,
      keystoreSetDigest: keystoreSetDigest(stateDir),
      // NO BACKUP IS REQUIRED HERE and that is a decision: this selects the steady state, which is where
      // this installation already is, so it changes no custody and needs no way back from a change it is
      // not making. What IS bound is the marker state that resolved the post-adoption ambiguity, so a
      // marker that changes between the plan and the confirmation changes the digest.
      declaredMode: declared.declared ? declared.mode : null,
      postAdoptionShape: postAdoption,
      backupSetDigest: null,
      ring: ringFacts(ring),
    }),
  };
}

/**
 * Every wrapped key in the keystore opens under this key, or a named refusal.
 *
 * The custodian's own preflight does the work, so this is the same proof the migration and the cutover make
 * rather than a second implementation of it.
 */
function proveKeystoreOpens(stateDir: string, kek: Buffer, failure: string): { readonly total: number } {
  let plan;
  try {
    plan = FileCustodian.planRewrapKeystore(stateDir, { fromKek: kek, toKek: kek });
  } catch (err) {
    throw new MaintenanceRefused(
      `${failure} (${err instanceof Error ? err.message : 'the keystore could not be read'}). Nothing was changed.`);
  }
  if (plan.alreadyCurrent !== plan.total) {
    throw new MaintenanceRefused(`${failure}. Nothing was changed.`);
  }
  return { total: plan.total };
}

/**
 * The legacy static KEK, read the way a key file is read — and held to the rule it can actually satisfy.
 *
 * WHERE THE LINE IS, AND WHY IT IS NOT WHERE THE ROOT KEY'S IS. `readRootWrappingKey` refuses any group or
 * other bit, because the root key seals every KEK an installation has and the setup script creates it that
 * way. The STATIC KEK is a file the shipped stacks have always created world-READABLE inside a 0700 secrets
 * directory, and mounted into two containers that way — so a transition that demanded owner-only here would
 * refuse every v1.1.4 installation in existence, which is precisely the population this command is for.
 *
 * So the rule is the one drawn everywhere else in this tranche: readable is the legacy normal and is not
 * refused; WRITABLE by group or other is a live custody failure — an account that can rewrite the static KEK
 * decides what this installation's keys are under — and is. It is opened without following a link and
 * bounded either way.
 */
function readStaticKeyForTransition(path: string): Buffer {
  if (process.platform !== 'win32') {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    let fd: number;
    try {
      fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    } catch {
      throw new MaintenanceRefused(
        'the static KEK file could not be opened without following a link, so this installation cannot be '
        + 'classified. Nothing was changed.');
    }
    try {
      const stats = fstatSync(fd);
      if ((stats.mode & 0o022) !== 0) {
        throw new MaintenanceRefused(
          'the static KEK file is writable by somebody other than its owner, so any account on this host '
          + 'could decide what this installation\'s wrapped keys are under. Refused before any runtime was '
          + 'selected; fix the mode and run this again.');
      }
    } finally {
      try { closeSync(fd); } catch { /* the check above is the outcome */ }
    }
  }
  try {
    return readKeyFileNoFollow(path, 'static KEK');
  } catch (err) {
    throw new MaintenanceRefused(
      `the static KEK could not be read (${err instanceof Error ? err.message : 'it could not be opened'}), `
      + 'so this installation cannot be classified. Nothing was changed.');
  }
}

/** What a ring IS, as numbers and closed words. Never a key. */
function ringFacts(ring: KekRing): unknown {
  return {
    digest: wholeRingDigest(ring),
    active: ring.active,
    pending: ring.pending,
    generations: [...ring.generations].map((entry) => [entry.generation, entry.state, entry.origin]),
  };
}

function evidenceDigest(facts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify({
    report: CUSTODY_TRANSITION_REPORT, version: CUSTODY_TRANSITION_VERSION, ...facts,
  }), 'utf8').digest('hex');
}

/**
 * Resolve a transition and CHANGE NOTHING.
 *
 * One command runs: `compose config`, which renders the merged configuration this project would use for the
 * mode the evidence selects. It starts nothing and writes nothing.
 */
export function planCustodyTransition(
  request: CustodyTransitionRequest,
  deps: CustodyTransitionDeps,
): ResolvedCustodyTransition {
  const projectRoot = resolveMaintenanceRoot(request.projectRoot, 'project directory');
  if (request.projectName.trim() === '') throw new MaintenanceRefused('the compose project name was not given');
  const evidence = classifyCustodyState(request);
  const current = readCustodyRuntimeMode(projectRoot);

  // THE COMPOSE INPUTS ARE BOUND TOO. A plan an operator confirms is a plan about a stack, and a stack whose
  // merged configuration changed between the reading and the running is a different stack.
  const config = runGuarded(deps.runner, deps.ledger, {
    program: 'docker',
    args: ['compose', ...composeFileArgs(evidence.selectedMode), '-p', request.projectName.trim(), 'config'],
    cwd: projectRoot,
    purpose: 'render the merged compose configuration the selected mode would use',
  });
  if (config.status !== 0) {
    throw new MaintenanceRefused(
      'the compose configuration for the mode this evidence selects did not resolve, so there is no stack to '
      + 'select it for. Nothing was changed.');
  }

  const resolved = {
    ...request,
    projectRoot,
    projectName: request.projectName.trim(),
    evidence,
    currentMode: current.mode,
    currentModeDeclared: current.declared,
    // WHAT A CHANGE ACTUALLY IS, WHICH IS NOT "THE MARKER IS MISSING".
    //
    // The steady state is expressed by the marker's ABSENCE, so an installation with no marker that the
    // evidence puts on root-only is ALREADY where it should be — writing and then removing a marker to say
    // so would be two changes to reach the state it was in. Only bootstrap needs a marker declared, because
    // only bootstrap is a state the default does not express.
    changes: evidence.selectedMode === 'bootstrap'
      ? !(current.declared && current.mode === 'bootstrap')
      : current.declared,
    composeConfigDigest: createHash('sha256').update(config.stdout, 'utf8').digest('hex'),
  };
  return Object.freeze({ ...resolved, planDigest: transitionPlanDigest(resolved) });
}

export function transitionPlanDigest(plan: Omit<ResolvedCustodyTransition, 'planDigest'>): string {
  return createHash('sha256').update(JSON.stringify({
    report: CUSTODY_TRANSITION_REPORT,
    version: CUSTODY_TRANSITION_VERSION,
    projectRoot: createHash('sha256').update(plan.projectRoot, 'utf8').digest('hex'),
    projectName: plan.projectName,
    evidenceDigest: plan.evidence.evidenceDigest,
    verdict: plan.evidence.verdict,
    selectedMode: plan.evidence.selectedMode,
    currentMode: plan.currentMode,
    currentModeDeclared: plan.currentModeDeclared,
    composeConfigDigest: plan.composeConfigDigest,
  }), 'utf8').digest('hex');
}

/**
 * Select the mode the evidence supports, having re-proved all of it under the locks.
 *
 * THE LOCKS ARE THE ONES THAT ACTUALLY EXCLUDE THE OTHER KEY OPERATIONS — a rotation, a retirement, and the
 * custodian's own writers — taken in the repository's order and released in the reverse of it. Nothing here
 * runs a container that would want them, so they are held across the whole re-proof and the marker write.
 */
export function runCustodyTransition(
  request: CustodyTransitionRequest & { readonly confirmDigest: string | null },
  deps: CustodyTransitionDeps,
): CustodyTransitionReport {
  const first = planCustodyTransition(request, deps);
  if (request.confirmDigest !== first.planDigest) {
    throw new MaintenanceRefused(
      'the digest you confirmed is not the digest of the transition this command just computed. Nothing was '
      + 'changed. Run with --plan, read it, and copy the digest from the plan you actually read.');
  }
  const lock = acquireLockDirectory(join(first.hostStateDir, CUSTODY_TRANSITION_LOCK_DIRNAME),
    'another custody transition is already running against this installation, or one was interrupted and '
    + 'left its lock behind.');
  let locks: ReturnType<typeof acquireCustodyStateLocks> | null = null;
  try {
    locks = acquireCustodyStateLocks(first.hostStateDir);
    // ---- RE-PROVED UNDER THE LOCKS -------------------------------------------------------------------
    const resolved = planCustodyTransition(request, deps);
    if (resolved.planDigest !== first.planDigest) {
      throw new MaintenanceRefused(
        'the ring, the keystore, the key files or the stack changed between reading this plan and running '
        + 'it. Nothing was changed. Re-run with --plan against what is actually there.');
    }
    // ---- A LEGACY SELECTION IS NOT WRITTEN WHILE THE ROOT KEY IS MISSING -----------------------------
    //
    // THE DEFECT THIS CLOSES, AND IT WOULD HAVE PRODUCED AN UNRUNNABLE STACK. The base compose file mounts
    // the root wrapping key as a BIND, and the bootstrap overlay does not take that mount away — so the
    // stack this selection points at cannot start without the file, and Docker, asked to bind a source that
    // is not there, may CREATE A DIRECTORY at the path where the installation's most sensitive file belongs.
    // Reporting success and writing the marker in that state would hand an operator a runtime selection that
    // is worse than the one they had.
    //
    // The plan still classifies and reports the prerequisite, because that is the diagnosis an operator
    // needs. The confirmation is where it becomes a requirement.
    if (resolved.evidence.verdict === 'legacy-static' && !resolved.evidence.rootKeyReady) {
      throw new MaintenanceRefused(
        'this installation is on legacy static custody and has no root wrapping key, so the runtime this '
        + 'would select cannot start: the stack binds that file, and Docker asked to bind a source that is '
        + 'not there may create a directory where the key belongs. Nothing was changed. Do these two things '
        + 'and run this again: create the key with deploy/write-custody-secret.mjs --generate, which '
        + 'generates it inside its own process and never prints it or takes it as an argument; then take a '
        + 'FRESH complete backup and verify it, because the set you have now was taken before that key '
        + 'existed and is not a way back from the custody change this selection points at.');
    }
    if (!resolved.changes) {
      return report(resolved, false, [
        'This installation is already running the mode its own key material supports, and the marker already '
        + 'says so. Nothing was changed.',
      ]);
    }
    // ---- THE MARKER, THROUGH THE HARDENED WRITER AND NOTHING ELSE ------------------------------------
    //
    // `writeCustodyRuntimeMode` is the O_EXCL-temp, looped, fsync'd, renamed writer; `clearCustodyRuntimeMode`
    // is how the steady state is expressed, because the steady state is the marker's ABSENCE. Nothing here
    // opens the file itself.
    if (resolved.evidence.selectedMode === 'root-only') clearCustodyRuntimeMode(resolved.projectRoot);
    else writeCustodyRuntimeMode(resolved.projectRoot, resolved.evidence.selectedMode);

    return report(resolved, true, notesFor(resolved));
  } finally {
    locks?.writers.release();
    locks?.rotation.release();
    lock.release();
  }
}

function report(
  resolved: ResolvedCustodyTransition,
  changed: boolean,
  notes: readonly string[],
): CustodyTransitionReport {
  return {
    report: CUSTODY_TRANSITION_REPORT,
    version: CUSTODY_TRANSITION_VERSION,
    ok: true,
    planDigest: resolved.planDigest,
    verdict: resolved.evidence.verdict,
    fromMode: resolved.currentMode,
    toMode: resolved.evidence.selectedMode,
    changed,
    keysProved: resolved.evidence.keysProved,
    ringGeneration: resolved.evidence.ringGeneration,
    network: 'none',
    notes,
  };
}

function notesFor(resolved: ResolvedCustodyTransition): readonly string[] {
  const start = `Start the stack with: docker compose ${composeFileArgs(resolved.evidence.selectedMode)
    .join(' ')} up -d ${NO_FETCH_RUN_FLAGS.join(' ')} --no-build`;
  if (resolved.evidence.verdict === 'legacy-static') {
    return [
      'This installation is on LEGACY STATIC custody: it has no ring, and its static KEK was proved to open '
      + `all ${resolved.evidence.keysProved} wrapped keys in its keystore. The runtime is now selected to run `
      + 'exactly as it did before this upgrade.',
      start,
      'THIS IS A TEMPORARY STATE. Finish it with ops:custody-cutover, which adopts that static key as '
      + 'generation 1 of a ring and returns this installation to the steady state.',
      resolved.evidence.rootKeyReady
        ? 'The root wrapping key the ring will be sealed under is already in place.'
        : 'BEFORE THAT CUTOVER, THIS INSTALLATION NEEDS A ROOT WRAPPING KEY: the version it is running '
          + 'predates the ring and never created one. Create it once with deploy/write-custody-secret.mjs '
          + '--generate, which generates the key inside its own process and never prints it or takes it as '
          + 'an argument. Nothing here creates key material.',
    ];
  }
  if (resolved.evidence.verdict === 'interrupted-adoption') {
    return [
      'This installation has a ring that is exactly what an INTERRUPTED migration leaves, holding its own '
      + 'static KEK as generation 1. The runtime is selected back to bootstrap so that cutover can RESUME — '
      + 'selecting the steady state would lock this installation out of finishing its own migration.',
      start,
      'Finish it with ops:custody-cutover, which will detect the ring and plan the remaining half.',
    ];
  }
  return [
    'This installation is already on the sidecar-managed ring: its root wrapping key opens the ring, and '
    + `the active generation was proved to open all ${resolved.evidence.keysProved} wrapped keys. The runtime `
    + 'is the canonical steady state, with no static KEK mounted anywhere.',
    start,
  ];
}

/** The compose arguments a launcher must use for a project, so no upgrade command can ignore the overlay. */
export function launcherComposeArgs(projectRoot: string): readonly string[] {
  return composeFileArgs(readCustodyRuntimeMode(projectRoot).mode);
}

export type { MaintenanceCommand };
