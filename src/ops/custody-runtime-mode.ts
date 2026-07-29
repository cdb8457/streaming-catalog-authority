import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MaintenanceRefused, readFileNoFollow, resolveMaintenanceRoot } from './maintenance-safety.js';

// Phase 289 — which custody the shipped stack is running, as a thing an operator SELECTS rather than edits.
//
// -----------------------------------------------------------------------------------------------------
// WHAT THE SHIPPED STACK ASKED AN OPERATOR TO DO, AND WHY IT COULD NOT BE DONE SAFELY.
// -----------------------------------------------------------------------------------------------------
//
// The runtime compose file wired the sidecar to the STATIC KEK and mounted the ring's root key beside it,
// with a comment telling the operator what to do after migrating:
//
//     "AFTER migrating, set SIDECAR_ROOT_KEY_FILE, remove SIDECAR_KEK_FILE and unmount custodian_kek"
//
// That is three hand-edits to a shipped YAML file, on a NAS, in a web terminal, against a stack whose
// daemon refuses to start if the result is wrong in either direction — and the file is REPLACED by the next
// release, silently reverting an installation to static custody it had already migrated away from. A
// migration whose last step is "edit this file correctly and remember to redo it after every upgrade" is a
// migration most installations will never complete, and the ones that do will not survive an upgrade.
//
// So the two states are two COMPOSE FILES, and the mode is a marker an operator sets with a documented
// command:
//
//   ROOT-ONLY (the canonical steady state) — `docker-compose.unraid.runtime.yml` alone. The sidecar is
//   wired to the root wrapping key, the static KEK is not mounted anywhere, and no service but the sidecar
//   can reach the key material.
//
//   BOOTSTRAP (temporary, for an installation that has not migrated yet) — the runtime file PLUS
//   `docker-compose.unraid.bootstrap.yml`, which adds the static KEK back and adds the one-shot
//   custody-maintenance service that performs the migration. Nothing else changes.
//
// THE DAEMON STILL REFUSES BOTH SOURCES OR NEITHER. That check has not moved: these files simply make the
// two valid wirings the only two an operator can select, instead of asking them to construct one by hand.

/** The two states this stack can be in. A closed set: there is no third, and no "partly migrated". */
export const CUSTODY_RUNTIME_MODES = ['bootstrap', 'root-only'] as const;
export type CustodyRuntimeMode = typeof CUSTODY_RUNTIME_MODES[number];

/** The canonical steady-state stack: root-only ring custody. */
export const RUNTIME_COMPOSE_FILE = 'docker-compose.unraid.runtime.yml';

/** The temporary overlay that puts an unmigrated installation back into static custody, and nothing else. */
export const BOOTSTRAP_COMPOSE_FILE = 'docker-compose.unraid.bootstrap.yml';

/**
 * The marker an operator sets. It lives in the PROJECT directory, beside the compose files.
 *
 * A FILE RATHER THAN AN ENVIRONMENT VARIABLE, DELIBERATELY. An environment variable is set in whatever shell
 * ran the last command: it is invisible to the next operator, invisible to a scheduled command, and gone
 * after a reboot. Which custody an installation is running is a property of the INSTALLATION, so it is
 * written where the installation is.
 */
export const CUSTODY_MODE_FILENAME = 'custody-runtime-mode';

/** How large that marker may be. It holds one word. */
export const MAX_CUSTODY_MODE_BYTES = 64;

export interface CustodyModeSelection {
  readonly mode: CustodyRuntimeMode;
  /** The compose files, in the order they must be passed to `-f`. Later files override earlier ones. */
  readonly composeFiles: readonly string[];
  /**
   * Whether a marker was actually there.
   *
   * `false` means the DEFAULT was used, and the default is the steady state. An installation that has never
   * heard of this marker is an installation that should be running root-only custody — and if it has not
   * migrated, its sidecar refuses to start and says so, which is the honest outcome. The alternative default
   * would be to assume bootstrap, which would silently keep a migrated installation on its static key.
   */
  readonly declared: boolean;
}

export function composeFilesForMode(mode: CustodyRuntimeMode): readonly string[] {
  return mode === 'bootstrap'
    ? Object.freeze([RUNTIME_COMPOSE_FILE, BOOTSTRAP_COMPOSE_FILE])
    : Object.freeze([RUNTIME_COMPOSE_FILE]);
}

/** The `-f` arguments for a mode, ready to sit between `compose` and its verb. */
export function composeFileArgs(mode: CustodyRuntimeMode): readonly string[] {
  return composeFilesForMode(mode).flatMap((file) => ['-f', file]);
}

/**
 * Which mode this project is in, read from the marker — or the steady state, because there is none.
 *
 * EVERY OTHER OUTCOME IS A REFUSAL. A marker that is a symbolic link, a directory, larger than one word, or
 * a word this build does not define is not a mode to guess at: the file decides which key material the
 * sidecar is wired to, and reading a mode wrong is starting the stack on the wrong custody.
 */
export function readCustodyRuntimeMode(projectRoot: string): CustodyModeSelection {
  const root = resolveMaintenanceRoot(projectRoot, 'project directory');
  const path = join(root, CUSTODY_MODE_FILENAME);
  if (!existsSync(path)) {
    return { mode: 'root-only', composeFiles: composeFilesForMode('root-only'), declared: false };
  }
  const opened = readFileNoFollow(path, 'custody runtime mode marker', MAX_CUSTODY_MODE_BYTES);
  const text = opened.bytes.toString('utf8').trim();
  if (!isCustodyRuntimeMode(text)) {
    throw new MaintenanceRefused(
      'the custody runtime mode marker in this project does not name a mode this build defines. Refused: '
      + `which custody the sidecar runs under is not something to guess. Set it with one of ${
        CUSTODY_RUNTIME_MODES.join(' or ')} using the documented command, or remove it to return to the `
      + 'steady state.');
  }
  return { mode: text, composeFiles: composeFilesForMode(text), declared: true };
}

export function isCustodyRuntimeMode(value: unknown): value is CustodyRuntimeMode {
  return typeof value === 'string' && (CUSTODY_RUNTIME_MODES as readonly string[]).includes(value);
}

/**
 * Put the project into a mode, atomically.
 *
 * TEMP-AND-RENAME, so a marker is never half-written: a reader that caught a partial write would read a word
 * this build does not define, which is a refusal — safe, but a refusal an operator would have to diagnose in
 * the middle of a cutover. The rename makes the marker the old word or the new one.
 */
export function writeCustodyRuntimeMode(projectRoot: string, mode: CustodyRuntimeMode): void {
  const root = resolveMaintenanceRoot(projectRoot, 'project directory');
  if (!isCustodyRuntimeMode(mode)) throw new MaintenanceRefused('that is not a custody runtime mode');
  const path = join(root, CUSTODY_MODE_FILENAME);
  const temp = `${path}.${randomUUID()}.tmp`;
  // EXCLUSIVE CREATE. `wx` is `O_CREAT | O_EXCL | O_WRONLY`: if anything is already at that name — including
  // a symbolic link somebody planted — this fails instead of writing through it.
  writeFileSync(temp, `${mode}\n`, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
  try {
    renameSync(temp, path);
  } catch {
    try { rmSync(temp, { force: true }); } catch { /* the refusal below is the outcome */ }
    throw new MaintenanceRefused('the custody runtime mode marker could not be put into place');
  }
}

/**
 * Return the project to the steady state by REMOVING the marker.
 *
 * Removing rather than writing `root-only` is the same decision as the default above: the steady state is
 * what an installation is in when nobody has said otherwise, and leaving a marker behind that says so invites
 * the next reader to wonder what it is for.
 */
export function clearCustodyRuntimeMode(projectRoot: string): void {
  const root = resolveMaintenanceRoot(projectRoot, 'project directory');
  rmSync(join(root, CUSTODY_MODE_FILENAME), { force: true });
}
