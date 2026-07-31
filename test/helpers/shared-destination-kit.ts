import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MIGRATION_VERSION } from '../../src/db/schema-version.js';
import { REQUIRED_SECRET_FILES } from '../../src/ops/backup-components.js';
import { DESTINATION_LOCK_DIRNAMES } from '../../src/ops/maintenance-safety.js';
import { runVerifiedCompleteBackup } from '../../src/ops/complete-backup.js';
import { fakeToolchain } from './fake-toolchain.js';

// Phases 321-328 — the fixtures TWO PROJECTS SHARING ONE PHYSICAL BACKUP DESTINATION are built from.
//
// -----------------------------------------------------------------------------------------------------
// WHY THE TWO PROJECTS ARE NESTED, AND WHY THAT IS THE HONEST FIXTURE RATHER THAN A CONVENIENCE.
// -----------------------------------------------------------------------------------------------------
//
// This product refuses a backup destination reached through a symbolic link — `resolveInsideRoot` `lstat`s
// every component of the path and stops at the first reparse point, on POSIX and on Windows alike. So the
// obvious way to give one directory two addresses is the ONE way this product will never accept, and a suite
// that used it would be testing a path the shipped commands refuse before they reach the lock at all.
//
// What is left is what real installations actually do: the same directory is reachable from two projects
// because it is bind-mounted, share-mounted, or simply because one project directory sits inside another. The
// last of those needs no privilege, no mount, no daemon and no platform-specific call, and it produces
// EXACTLY the state the lock exists for: two DISTINCT project roots, two DISTINCT maintenance locks, two
// different relative spellings, and ONE physical destination directory.
//
//   <work>/outer                      <- project A, destination "inner/backups"
//   <work>/outer/inner                <- project B, destination "backups"
//   <work>/outer/inner/backups        <- ONE directory, two addresses
//
// Nothing about the nesting is load-bearing: the commands never walk a project root wholesale, only the
// directories they were named. What is load-bearing is that the lock is a DIRECTORY IN THE DESTINATION —
// both spellings resolve to one path here, and even where they did not, both runs would still `mkdir` the
// same inode. Exclusion comes from the filesystem rather than from two processes agreeing on a string.
//
// A suite ALSO proves the symlink alias is refused, so the pair of facts is complete: the aliases this
// product accepts contend on one lock, and the alias it does not accept never reaches one.

export const SECRET_VALUE = 'a-kek-value-that-must-never-appear-in-any-report';

/** The exit code a held child uses when it is told to stop existing. Chosen not to collide with a refusal. */
export const HOLDER_CRASH_EXIT_CODE = 137;

/** What a contender reports when it did not refuse. Distinct from a refusal so a suite cannot confuse them. */
export type ContenderOutcome = 'refused' | 'completed' | 'failed';

export type FamilyCommand =
  | 'complete-backup'
  | 'complete-restore'
  | 'backup-retention'
  | 'safety-set-lifecycle';

export interface ContenderConfig {
  /** A label the suite reads results back by. */
  readonly label: string;
  readonly command: FamilyCommand;
  /** The project this contender runs FROM. Never the holder's. */
  readonly projectRoot: string;
  /** The destination, in this project's own spelling. */
  readonly destination: string;
  /** The set to take (a backup) or to restore from (a restore). */
  readonly setName?: string;
  /** Drive `ops:backup-retention`'s real CLI with `--json`, to prove the operator surface too. */
  readonly viaCli?: true;
  /** Where this child writes its result. The holder collects it. */
  readonly resultFile: string;
}

export interface ContenderResult {
  readonly label: string;
  readonly command: FamilyCommand;
  readonly outcome: ContenderOutcome;
  /** The refusal, verbatim. A suite asserts the vocabulary rather than paraphrasing it. */
  readonly message: string;
  /** Every argv token this contender handed to a runner, flattened. Emptiness is the claim. */
  readonly commands: readonly string[];
  /** stdout, when the contender was driven through a CLI. Used to prove ONE JSON document. */
  readonly stdout: string;
  /** The CLI's exit code, when one ran. `-1` when the contender was driven as a library call. */
  readonly exitCode: number;
}

export interface HoldConfig {
  readonly command: FamilyCommand;
  readonly projectRoot: string;
  readonly destination: string;
  readonly setName?: string;
  /** After the contenders have run: stop existing, leaving both locks exactly as a kill would. */
  readonly thenCrash?: true;
  readonly contenders: readonly ContenderConfig[];
  readonly evidenceFile: string;
  /** The repo root, so the holder can spawn the contender through the same `tsx`. */
  readonly repoRoot: string;
  readonly contenderChild: string;
}

export interface HoldEvidence {
  /** Proof the holder really had the lock at the moment the contenders ran. */
  readonly lockHeldAtBoundary: boolean;
  readonly projectLockHeldAtBoundary: boolean;
  /** The destination, hashed, immediately before and immediately after every contender ran. */
  readonly destinationBefore: Readonly<Record<string, string>>;
  readonly destinationAfter: Readonly<Record<string, string>>;
  readonly results: readonly ContenderResult[];
}

/** A project shaped like a real one: a secrets directory and a promotion-records directory. */
export function makeMaintenanceProject(root: string): string {
  mkdirSync(root, { recursive: true });
  const secrets = join(root, 'secrets');
  mkdirSync(secrets, { recursive: true });
  for (const file of REQUIRED_SECRET_FILES) {
    writeFileSync(join(secrets, file), file === 'custodian_kek' ? SECRET_VALUE : `${file}-live\n`, 'utf8');
  }
  mkdirSync(join(root, 'promotion-records'), { recursive: true });
  writeFileSync(join(root, 'promotion-records', 'record-live.json'), '{"live":1}\n', 'utf8');
  return root;
}

export interface SharedDestination {
  /** Project A. Its destination is `inner/backups`. */
  readonly outer: string;
  /** Project B. Its destination is `backups`. The SAME directory. */
  readonly inner: string;
  /** The one physical directory both of them name. */
  readonly destination: string;
  readonly outerDestination: string;
  readonly innerDestination: string;
}

/** Two real projects, two spellings, one physical destination. */
export function makeSharedDestination(work: string, name: string): SharedDestination {
  const outer = makeMaintenanceProject(join(work, name));
  const inner = makeMaintenanceProject(join(outer, 'inner'));
  const destination = join(inner, 'backups');
  mkdirSync(destination, { recursive: true });
  return {
    outer,
    inner,
    destination,
    outerDestination: 'inner/backups',
    innerDestination: 'backups',
  };
}

/** Take a real, verified set with the shipped command, against a fake toolchain. No daemon, no network. */
export function takeSharedSet(
  projectRoot: string,
  destination: string,
  setName: string,
  takenAt: Date = new Date(0),
): string {
  const tools = fakeToolchain();
  const outcome = runVerifiedCompleteBackup({
    projectRoot, destination, setName, custodian: 'inline',
    secrets: 'secrets', promotionRecords: 'promotion-records',
  }, {
    runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger, now: () => takenAt,
  });
  if (!outcome.ok) {
    throw new Error(`the fixture set ${setName} had to be taken and verified: ${outcome.failures.join('; ')}`);
  }
  return join(projectRoot, destination, setName);
}

/**
 * Every entry under a directory, as a relative path to a digest.
 *
 * A LOCK DIRECTORY IS RECORDED BY ITS NAME AND NOT ITS CONTENTS, because the holder file inside it carries a
 * pid, which is different in every run and is not a fact about whether anything changed.
 */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (current: string): void => {
    for (const name of readdirSync(current).slice().sort()) {
      const child = join(current, name);
      const key = relative(dir, child).split('\\').join('/');
      const stats = lstatSync(child);
      if (stats.isSymbolicLink()) { out[key] = 'link'; continue; }
      if (stats.isDirectory()) {
        out[`${key}/`] = 'dir';
        // A LOCK DIRECTORY IS RECORDED AS A NAME AND NOT DESCENDED INTO: the holder file inside carries a
        // pid, which differs in every run and is not a fact about whether anything changed. Only the exact
        // lock names are skipped, so a SET that happened to end in `.lock` is still hashed in full.
        if (DESTINATION_LOCK_DIRNAMES.includes(name)) continue;
        walk(child);
        continue;
      }
      if (!stats.isFile()) { out[key] = 'special'; continue; }
      out[key] = createHash('sha256').update(readFileSync(child)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

export function sameTree(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const left = Object.keys(a).sort();
  const right = Object.keys(b).sort();
  if (left.length !== right.length) return false;
  return left.every((key, index) => right[index] === key && a[key] === b[key]);
}

/** What changed between two snapshots, for a failure message that says which entry rather than "differs". */
export function treeDifference(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): readonly string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => a[key] !== b[key]).sort();
}

/** The schema every fixture set is taken at, so a restore of one is restorable under this build. */
export const FIXTURE_SCHEMA_VERSION = MIGRATION_VERSION;
