import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDirectRun } from '../../src/ops/direct-run.js';
import { MIGRATION_VERSION } from '../../src/db/schema-version.js';
import {
  CommandLedger,
  DESTINATION_LOCK_DIRNAME,
  MAINTENANCE_LOCK_DIRNAME,
  MaintenanceRefused,
  type MaintenanceCommand,
} from '../../src/ops/maintenance-safety.js';
import { runVerifiedCompleteBackup } from '../../src/ops/complete-backup.js';
import {
  planCompleteRestore, resolveCompleteRestoreRequest, runCompleteRestore,
} from '../../src/ops/complete-restore.js';
import { planRetention, resolveRetentionRequest, runRetention } from '../../src/ops/backup-retention.js';
import { DEFAULT_RETENTION_POLICY } from '../../src/ops/retention-model.js';
import {
  planSafetySetLifecycle, resolveSafetySetRequest, runSafetySetLifecycle,
} from '../../src/ops/safety-set-lifecycle.js';
import { DEFAULT_SAFETY_SET_POLICY } from '../../src/ops/safety-set-model.js';
import { fakeToolchain } from './fake-toolchain.js';
import { restoreStack, setDumpDigest, setKeystoreDigest } from './fake-restore-stack.js';
import {
  HOLDER_CRASH_EXIT_CODE, snapshotTree,
  type ContenderResult, type HoldConfig, type HoldEvidence,
} from './shared-destination-kit.js';

// Phases 321-328 — a REAL backup-family command, stopped dead at a post-lock boundary, while REAL other
// commands are run against the destination it is holding.
//
// -----------------------------------------------------------------------------------------------------
// THE BOUNDARY IS AN INJECTED PRIMITIVE, NOT A TIMER.
// -----------------------------------------------------------------------------------------------------
//
// Everything in this family is synchronous. A holder paused inside one of its own injected primitives is a
// holder that is provably still inside its locked region: no clock decides it, no sleep bounds it, and there
// is no interleaving for a slow machine to get wrong. Each command is held at the earliest primitive it calls
// AFTER `lockDestination` returns:
//
//   ops:backup-retention        `suffix()`  — the lock is held, and NOT ONE BYTE has been written: no
//   ops:safety-set-lifecycle    `suffix()`    journal, no quarantine, no rename. The destination a contender
//                                             meets is pristine apart from the lock directory itself.
//   ops:complete-backup         the first `docker compose stop` — the lock is held and this run's own
//                                             staging directory exists inside the destination.
//   ops:complete-restore        the first `docker compose stop`, which belongs to the SAFETY SET this
//                                             restore is taking — so the lock is held, a claim directory
//                                             exists in the destination, and the volumes are NOT yet
//                                             destroyed. That is the most dangerous instant this product
//                                             has, and it is the one a contender is run against.
//
// WHAT THE HOLDER DOES AT THAT BOUNDARY. It snapshots the destination, runs every contender as its own real
// child process, snapshots the destination again, and writes the evidence. Then it either returns — letting
// the command finish and release both locks — or calls `process.exit`, which is a kill: no `finally` runs,
// no lock is released, and what is left on disk is exactly what a power loss leaves.

const NOW = new Date('2026-07-31T12:00:00.000Z');

function runContenders(config: HoldConfig): HoldEvidence {
  const destinationDir = join(config.projectRoot, config.destination);
  const before = snapshotTree(destinationDir);
  const results: ContenderResult[] = [];
  for (const contender of config.contenders) {
    const child = spawnSync(process.execPath,
      [join(config.repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), config.contenderChild,
        JSON.stringify(contender)],
      { cwd: config.repoRoot, encoding: 'utf8', timeout: 180_000, windowsHide: true });
    if (!existsSync(contender.resultFile)) {
      throw new Error(`the contender ${contender.label} produced no result: exit ${String(child.status)} `
        + `${(child.stderr ?? '').slice(0, 600)}`);
    }
    results.push(JSON.parse(readFileSync(contender.resultFile, 'utf8')) as ContenderResult);
  }
  const after = snapshotTree(destinationDir);
  return {
    lockHeldAtBoundary: existsSync(join(destinationDir, DESTINATION_LOCK_DIRNAME)),
    projectLockHeldAtBoundary: existsSync(join(config.projectRoot, MAINTENANCE_LOCK_DIRNAME)),
    destinationBefore: before,
    destinationAfter: after,
    results,
  };
}

function main(): number {
  const config = JSON.parse(process.argv[2] ?? '{}') as HoldConfig;
  let held = false;

  const hold = (): void => {
    // ONCE. A boundary that fired twice would run every contender twice and hide which state they met.
    if (held) return;
    held = true;
    writeFileSync(config.evidenceFile, JSON.stringify(runContenders(config)), 'utf8');
    if (config.thenCrash === true) {
      // NOT A THROW. The point is that no handler and no `finally` anywhere gets to run, so both locks stay
      // exactly where a killed process leaves them.
      process.exit(HOLDER_CRASH_EXIT_CODE);
    }
  };

  const holdOnStop = (command: MaintenanceCommand): void => {
    if (command.args.includes('stop')) hold();
  };

  try {
    switch (config.command) {
      case 'backup-retention': {
        const policy = { ...DEFAULT_RETENTION_POLICY, keepLast: 1, minAgeDays: 0 };
        const resolved = resolveRetentionRequest({
          projectRoot: config.projectRoot, destination: config.destination,
        });
        const plan = planRetention(resolved, policy, NOW);
        runRetention({ projectRoot: config.projectRoot, destination: config.destination }, policy,
          // `suffix` IS THE BOUNDARY: it is called under both locks and before the journal is written.
          { now: () => NOW, suffix: () => { hold(); return 'aaaaaaaaaaaa'; } },
          { kind: 'run', confirm: plan.digest });
        break;
      }
      case 'safety-set-lifecycle': {
        const policy = { ...DEFAULT_SAFETY_SET_POLICY, keepLast: 1, minAgeDays: 0 };
        const resolved = resolveSafetySetRequest({
          projectRoot: config.projectRoot, destination: config.destination,
        });
        const plan = planSafetySetLifecycle(resolved, policy, NOW);
        runSafetySetLifecycle({ projectRoot: config.projectRoot, destination: config.destination }, policy,
          { now: () => NOW, suffix: () => { hold(); return 'aaaaaaaaaaaa'; } },
          { kind: 'run', confirm: plan.digest });
        break;
      }
      case 'complete-backup': {
        const tools = fakeToolchain();
        runVerifiedCompleteBackup({
          projectRoot: config.projectRoot,
          destination: config.destination,
          setName: config.setName ?? 'holder-set',
          custodian: 'inline',
          secrets: 'secrets',
          promotionRecords: 'promotion-records',
        }, {
          runner: (command) => { holdOnStop(command); return tools.runner(command); },
          fileRunner: tools.fileRunner,
          ledger: tools.ledger,
          now: () => NOW,
        });
        break;
      }
      case 'complete-restore': {
        const setDir = join(config.projectRoot, config.destination, config.setName ?? 'set-a');
        const world = restoreStack({
          buildSchema: MIGRATION_VERSION,
          moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
        });
        const ledger = new CommandLedger();
        const request = {
          projectRoot: config.projectRoot,
          destination: config.destination,
          setName: config.setName ?? 'set-a',
          custodian: 'inline' as const,
          secrets: 'secrets',
          promotionRecords: 'promotion-records',
        };
        const resolved = resolveCompleteRestoreRequest(request);
        const plan = planCompleteRestore(resolved, { safetySet: true, acceptDataLoss: false });
        runCompleteRestore(request, {
          runner: (command) => { holdOnStop(command); return world.runner(command); },
          fileRunner: world.inputRunner,
          backupFileRunner: world.outputRunner,
          ledger,
          suffix: () => 'aaaaaaaaaaaa',
          now: () => NOW,
        }, { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
        break;
      }
    }
  } catch (err) {
    // A holder that refused before it reached the boundary has proved nothing, and the parent must be able
    // to see that rather than read an evidence file that was never written.
    process.stderr.write(`${err instanceof MaintenanceRefused ? err.message : (err as Error).stack}\n`);
    return held ? 3 : 1;
  }
  // Reaching here means the holder ran to completion having held the boundary. Two is "never held".
  return held ? 0 : 2;
}

if (isDirectRun(import.meta.url)) {
  process.exitCode = main();
}
