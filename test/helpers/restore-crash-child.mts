import { renameSync } from 'node:fs';
import { isDirectRun } from '../../src/ops/direct-run.js';
import { MIGRATION_VERSION } from '../../src/db/schema-version.js';
import {
  abandonRestore, realStagingCopier, runCompleteRestore, writeRestoreJournal,
  type CompleteRestoreRequest, type RestoreJournal, type StagingCopier,
} from '../../src/ops/complete-restore.js';
import { restoreStack, setDumpDigest, setKeystoreDigest } from './fake-restore-stack.js';

// Phase 303 (second correction) — a restore that really stops existing, at a named boundary.
//
// -----------------------------------------------------------------------------------------------------
// WHY A CHILD PROCESS, AND WHY NOTHING ELSE WOULD DO.
// -----------------------------------------------------------------------------------------------------
//
// The state the recovery exists for is a process that died between an effect landing and the journal
// recording it. The obvious way to produce that in a suite is to throw from an injected primitive — and it
// does not work, because it is not what happens. `runGuarded` CATCHES a runner that throws and turns it into
// a recorded step failure; the step machinery catches anything else and records it too. That is correct
// behaviour for a real error, and it means an exception can never leave the journal in the state a kill
// leaves it in. A suite that threw would be testing the error path it already tests, under a new name.
//
// So this runs the restore in its own process and calls `process.exit` at the boundary. Everything in this
// command is synchronous, so `process.exit` inside an injected primitive is exactly a kill between the
// effect and the next write: no catch runs, no `finally` runs, no journal update happens, and the lock
// directory is left behind exactly as a real crash would leave it.
//
// The parent asserts the on-disk state this produces and then resumes IN PROCESS, so what is under test is
// the shipped recovery and not a re-implementation of it.

/** The exit code this child uses for a deliberate death, chosen not to collide with any real refusal. */
export const CRASH_EXIT_CODE = 137;

interface CrashConfig {
  readonly projectRoot: string;
  readonly setDir: string;
  readonly setName: string;
  readonly confirm: string;
  readonly suffix: string;
  /**
   * Where to stop existing.
   *
   *   `rename:<n>`    — after the nth rename a swap performs (1 = between the two halves).
   *   `command:<s>`   — after the command whose argv contains `<s>` has run.
   *   `replay`        — inside the database replay, after the dump has gone in.
   *   `staging:<id>`  — DURING the copy of component `<id>` into staging, once its artifact exists. This is
   *                     the window a marker written last could not describe.
   *   `complete:<id>` — the instant BEFORE the journal records step `<id>` as complete: the step's effect
   *                     has landed and nothing has recorded it.
   *   `after:<id>`    — the instant AFTER that record reaches disk. For the LAST step this is the window in
   *                     which the operation is complete, its journal says so, and the cleanup and the
   *                     journal clear have not happened.
   */
  readonly crashAt: string;
  readonly buildSchema?: number;
  readonly initialSchema?: number;
  readonly custodian?: 'inline' | 'sidecar';
  readonly sidecarState?: string;
  readonly promotionRecords?: string | null;
  /** `restore` (the default) or `abandon` — both halves of an abandon are crashable boundaries too. */
  readonly operation?: 'restore' | 'abandon';
}

function main(): number {
  const config = JSON.parse(process.argv[2] ?? '{}') as CrashConfig;
  const world = restoreStack({
    buildSchema: config.buildSchema ?? MIGRATION_VERSION,
    ...(config.initialSchema === undefined ? {} : { initialSchema: config.initialSchema }),
    moments: [{ dumpDigest: setDumpDigest(config.setDir), keystoreDigest: setKeystoreDigest(config.setDir) }],
    ...(config.sidecarState === undefined ? {} : { sidecarStateDir: config.sidecarState }),
  });

  const die = (): never => {
    // NOT A THROW. The point of this child is that no handler anywhere gets to run.
    process.exit(CRASH_EXIT_CODE);
  };

  // A KILL DURING THE COPY ITSELF, which is synchronous and so cannot be interrupted by a timer, a signal
  // handler or an exception from outside it. The copier is injected for exactly this: `staging:<id>` copies
  // the component and then stops existing, leaving the tree CLAIMED and not sealed — the window the
  // write-the-marker-last design could not describe at all.
  const copier: StagingCopier = (source, destination, id) => {
    realStagingCopier(source, destination, id);
    if (config.crashAt === `staging:${id}`) die();
  };

  let renames = 0;
  const rename = (from: string, to: string): void => {
    renameSync(from, to);
    renames += 1;
    if (config.crashAt === `rename:${renames}`) die();
  };

  const runner: typeof world.runner = (command) => {
    const outcome = world.runner(command);
    if (config.crashAt.startsWith('command:')
      && [command.program, ...command.args].join(' ').includes(config.crashAt.slice('command:'.length))) {
      die();
    }
    return outcome;
  };

  // THE JOURNAL WRITE IS THE BOUNDARY. Dying here is dying with the effect on disk and no record of it,
  // which is precisely the state a kill produces and the state the recovery is for.
  const journalWriter = (projectRoot: string, journal: RestoreJournal): void => {
    if (config.crashAt.startsWith('complete:')) {
      const id = config.crashAt.slice('complete:'.length);
      const step = journal.steps.find((entry) => entry.id === id);
      if (step !== undefined && step.state === 'complete') die();
    }
    writeRestoreJournal(projectRoot, journal);
    if (config.crashAt.startsWith('after:')) {
      const id = config.crashAt.slice('after:'.length);
      const step = journal.steps.find((entry) => entry.id === id);
      if (step !== undefined && step.state === 'complete') die();
    }
  };

  const fileRunner: typeof world.inputRunner = (command, source) => {
    const outcome = world.inputRunner(command, source);
    if (config.crashAt === 'replay') die();
    return outcome;
  };

  if (config.operation === 'abandon') {
    // BOTH HALVES OF AN ABANDON ARE BOUNDARIES. `rename:1` dies after the restored copy has been moved to
    // its `.abandoned-` name and before the previous contents are put back — the window in which the target
    // does not exist at all. `rename:2` dies after the second, before the journal records either.
    try {
      abandonRestore(config.projectRoot, {
        rename,
        // `phase:abandoning` dies the instant the direction reaches disk and before the first rename — the
        // window between "an operator asked to abandon" and "anything on disk says so".
        journalWriter: (projectRoot, journal) => {
          writeRestoreJournal(projectRoot, journal);
          if (config.crashAt === 'phase:abandoning' && journal.phase === 'abandoning') die();
        },
      });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}
`);
      return 1;
    }
    return 2;
  }

  const request: CompleteRestoreRequest = {
    projectRoot: config.projectRoot,
    destination: 'backups',
    setName: config.setName,
    custodian: config.custodian ?? 'inline',
    secrets: 'secrets',
    ...(config.promotionRecords === undefined ? { promotionRecords: 'promotion-records' }
      : config.promotionRecords === null ? {} : { promotionRecords: config.promotionRecords }),
    ...(config.sidecarState === undefined ? {} : { sidecarState: 'sidecar-state' }),
  };

  try {
    runCompleteRestore(request, {
      runner,
      fileRunner,
      backupFileRunner: world.outputRunner,
      ledger: world.ledger,
      suffix: () => config.suffix,
      now: () => new Date(0),
      rename,
      journalWriter,
      copier,
    }, { kind: 'run', confirm: config.confirm, acceptDataLoss: null });
  } catch (err) {
    // The run failed for a reason of its own before it reached the boundary. That is a different outcome
    // from the crash this child exists to produce, and the parent distinguishes them by exit code.
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  // Reaching here means the boundary was never hit: the parent must fail rather than test nothing.
  return 2;
}

// ONLY WHEN RUN AS THE CHILD. The suite imports this module for its exit code, and a module that performed a
// restore on import would turn every import into an act.
if (isDirectRun(import.meta.url)) {
  process.exitCode = main();
}
