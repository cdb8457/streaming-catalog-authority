import { isDirectRun } from '../../src/ops/direct-run.js';
import {
  abandonSafetySetLifecycle,
  runSafetySetLifecycle,
  writeSafetySetJournal,
  type SafetyFailpoint,
  type SafetySetJournal,
} from '../../src/ops/safety-set-lifecycle.js';
import { MaintenanceRefused } from '../../src/ops/maintenance-safety.js';
import type { SafetySetPolicy } from '../../src/ops/safety-set-model.js';

// Phase 317 — a safety-set lifecycle run, or an abandon, that really stops existing at a named boundary.
//
// -----------------------------------------------------------------------------------------------------
// WHY A CHILD PROCESS, AND WHY NOTHING ELSE WOULD DO.
// -----------------------------------------------------------------------------------------------------
//
// The state the recovery exists for is a process that died between an effect landing and the journal
// recording it. Throwing from an injected primitive cannot produce it: the run catches a failure and records
// it as a `failed` entry, which is correct behaviour for a real error and is a state the recovery already
// handles. A suite that threw would be testing the error path under a new name.
//
// So this runs the REAL command in its own process and calls `process.exit` at the boundary. Everything in
// this command is synchronous, so `process.exit` inside the failpoint hook is exactly a kill between the
// effect and the next write: no catch runs, no `finally` runs, no journal update happens, and both lock
// directories are left behind exactly as a real crash would leave them.
//
// The parent asserts the on-disk state this produces and then resumes or abandons IN PROCESS, so what is
// under test is the shipped recovery and not a re-implementation of it.

/** The exit code this child uses for a deliberate death, chosen not to collide with any real refusal. */
export const SAFETY_CRASH_EXIT_CODE = 137;

interface CrashConfig {
  readonly projectRoot: string;
  readonly destination: string;
  readonly confirm: string;
  readonly suffix: string;
  readonly policy: SafetySetPolicy;
  readonly nowMs: number;
  /**
   * Where to stop existing.
   *
   *   `after-journal`                       — the journal exists and not one directory has moved.
   *   `after-quarantine-marker-built`       — the claim tree holds a valid marker and is NOT published.
   *   `after-quarantine-marker-published`   — the predictable quarantine path exists, marked, and empty.
   *   `after-quarantine-rename:<claim>`     — the rename landed and NOTHING has recorded it.
   *   `after-quarantine-mark:<claim>`       — the rename landed and the journal says so.
   *   `after-floor-proof`                   — everything is quarantined and nothing has been deleted.
   *   `after-deleting-mark:<claim>`         — the journal says `deleting` and the tree is still INTACT.
   *   `after-remove:<claim>`                — the tree is gone and NOTHING has recorded it.
   *   `after-abandon-rename:<claim>`        — an abandon put a claim back and NOTHING has recorded it.
   */
  readonly crashAt: string;
  /** `run` (the default), `resume`, or `abandon`. */
  readonly operation?: 'run' | 'resume' | 'abandon';
  /**
   * Make the Nth journal write throw instead of landing, so the failure paths that arrive AFTER an effect can
   * be driven for real rather than described. Counted from 1, across this child's whole run.
   */
  readonly failJournalWriteAt?: number;
  /** Make the final journal clear throw. */
  readonly failJournalClear?: boolean;
}

function main(): number {
  const config = JSON.parse(process.argv[2] ?? '{}') as CrashConfig;
  const die = (): never => {
    // NOT A THROW. The point of this child is that no handler anywhere gets to run.
    process.exit(SAFETY_CRASH_EXIT_CODE);
  };
  const at = (point: SafetyFailpoint, name: string): void => {
    if (config.crashAt === point || config.crashAt === `${point}:${name}`) die();
  };

  let writes = 0;
  const journalWriter = (projectRoot: string, journal: SafetySetJournal): void => {
    writes += 1;
    if (config.failJournalWriteAt !== undefined && writes >= config.failJournalWriteAt) {
      throw new MaintenanceRefused('the safety-set lifecycle journal could not be written');
    }
    writeSafetySetJournal(projectRoot, journal);
  };
  const journalClearer = (): void => {
    if (config.failJournalClear === true) {
      throw new MaintenanceRefused(
        'the safety-set lifecycle journal could not be removed from the project directory');
    }
  };
  const deps = {
    now: () => new Date(config.nowMs),
    suffix: () => config.suffix,
    at,
    ...(config.failJournalWriteAt === undefined ? {} : { journalWriter }),
    ...(config.failJournalClear === true ? { journalClearer } : {}),
  };

  try {
    if (config.operation === 'abandon') {
      abandonSafetySetLifecycle(config.projectRoot, deps);
    } else {
      runSafetySetLifecycle(
        { projectRoot: config.projectRoot, destination: config.destination },
        config.policy,
        deps,
        config.operation === 'resume'
          ? { kind: 'resume', confirm: config.confirm }
          : { kind: 'run', confirm: config.confirm },
      );
    }
  } catch (err) {
    // The run refused, or failed after an effect, for a reason of its own before it reached the boundary.
    // Both are different outcomes from the crash this child exists to produce, and the parent distinguishes
    // them by exit code.
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  // Reaching here means the boundary was never hit: the parent must fail rather than test nothing.
  return 2;
}

// ONLY WHEN RUN AS THE CHILD. A module that removed safety sets on import would turn every import into an act.
if (isDirectRun(import.meta.url)) {
  process.exitCode = main();
}
