import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDirectRun } from '../../src/ops/direct-run.js';
import { MIGRATION_VERSION } from '../../src/db/schema-version.js';
import { CommandLedger, MaintenanceRefused } from '../../src/ops/maintenance-safety.js';
import { runVerifiedCompleteBackup } from '../../src/ops/complete-backup.js';
import {
  composeOccupancyProbe,
  planCompleteRestore,
  resolveCompleteRestoreRequest,
  runCompleteRestore,
} from '../../src/ops/complete-restore.js';
import {
  planRetention, resolveRetentionRequest, runRetention,
} from '../../src/ops/backup-retention.js';
import { DEFAULT_RETENTION_POLICY } from '../../src/ops/retention-model.js';
import {
  planSafetySetLifecycle, resolveSafetySetRequest, runSafetySetLifecycle,
} from '../../src/ops/safety-set-lifecycle.js';
import { DEFAULT_SAFETY_SET_POLICY } from '../../src/ops/safety-set-model.js';
import { main as retentionCliMain } from '../../src/ops/backup-retention-cli.js';
import { fakeToolchain } from './fake-toolchain.js';
import { restoreStack, setDumpDigest, setKeystoreDigest } from './fake-restore-stack.js';
import type { ContenderConfig, ContenderResult } from './shared-destination-kit.js';

// Phases 321-328 — ONE REAL PROCESS, running ONE real backup-family command, against a destination another
// real process is holding.
//
// -----------------------------------------------------------------------------------------------------
// WHY A CHILD PROCESS, AND WHY IT IS SPAWNED BY THE HOLDER RATHER THAN BY THE SUITE.
// -----------------------------------------------------------------------------------------------------
//
// The property under test is that a command in ANOTHER PROJECT refuses while this one holds the shared
// destination lock, and refuses BEFORE it has staged, claimed, renamed, deleted, journalled or run a single
// child command. Two things follow from that, and they decide this file's shape:
//
//   1. IT MUST BE A DIFFERENT PROCESS. `mkdir` as a lock excludes processes; two calls in one process would
//      contend for exactly the same directory and prove exactly the same thing, but they would also share a
//      module graph, a working directory and a heap, and "the same process refused itself" is not the claim.
//   2. IT MUST RUN WHILE THE LOCK IS REALLY HELD, with no window and no timing. So the HOLDER spawns it,
//      synchronously, from inside its own locked region — every command in this family is synchronous, so a
//      holder paused inside an injected primitive is a holder that is provably still holding. There is no
//      sleep anywhere in this suite, no polling and no timeout that could pass by accident.
//
// EVERY COMMAND IS DRIVEN THROUGH ITS OWN SHIPPED ENTRY POINT, with the fake toolchain the rest of this
// repository's maintenance suites use: no Docker daemon, no images, no network, no `pg_dump`. The ledger
// this hands the command is reported back, so "no command of any kind was issued before the refusal" is
// checked against the argv list rather than asserted.

const NOW = new Date('2026-07-31T12:00:00.000Z');

function refusalOf(err: unknown): string {
  if (err instanceof MaintenanceRefused) return err.message;
  return `NOT-A-REFUSAL: ${(err as Error).name}: ${(err as Error).message}`;
}

function completeBackup(config: ContenderConfig, ledger: CommandLedger): ContenderResult {
  const tools = fakeToolchain();
  try {
    runVerifiedCompleteBackup({
      projectRoot: config.projectRoot,
      destination: config.destination,
      setName: config.setName ?? 'contender-set',
      custodian: 'inline',
      secrets: 'secrets',
      promotionRecords: 'promotion-records',
    }, { runner: tools.runner, fileRunner: tools.fileRunner, ledger, now: () => NOW });
  } catch (err) {
    return result(config, 'refused', refusalOf(err), ledger);
  }
  return result(config, 'completed', '', ledger);
}

function completeRestore(config: ContenderConfig, ledger: CommandLedger): ContenderResult {
  const setDir = join(config.projectRoot, config.destination, config.setName ?? 'set-a');
  const world = restoreStack({
    buildSchema: MIGRATION_VERSION,
    moments: [{ dumpDigest: setDumpDigest(setDir), keystoreDigest: setKeystoreDigest(setDir) }],
  });
  const request = {
    projectRoot: config.projectRoot,
    destination: config.destination,
    setName: config.setName ?? 'set-a',
    custodian: 'inline' as const,
    secrets: 'secrets',
    promotionRecords: 'promotion-records',
  };
  try {
    // THE PLAN IS MADE BY THIS CONTENDER, so the ONLY thing that can stop it is the lock. A digest borrowed
    // from anywhere else would be refused by the confirmation check and would prove nothing about the lock.
    const resolved = resolveCompleteRestoreRequest(request, composeOccupancyProbe(world.runner, ledger));
    const plan = planCompleteRestore(resolved, { safetySet: true, acceptDataLoss: false });
    runCompleteRestore(request, {
      runner: world.runner,
      fileRunner: world.inputRunner,
      backupFileRunner: world.outputRunner,
      ledger,
      suffix: () => 'aaaaaaaaaaaa',
      now: () => NOW,
    }, { kind: 'run', confirm: plan.digest, acceptDataLoss: null });
  } catch (err) {
    return result(config, 'refused', refusalOf(err), ledger);
  }
  return result(config, 'completed', '', ledger);
}

function backupRetention(config: ContenderConfig, ledger: CommandLedger): ContenderResult {
  const policy = { ...DEFAULT_RETENTION_POLICY, keepLast: 1, minAgeDays: 0 };
  try {
    const resolved = resolveRetentionRequest({
      projectRoot: config.projectRoot, destination: config.destination,
    });
    const plan = planRetention(resolved, policy, NOW);
    if (config.viaCli === true) return retentionViaCli(config, plan.digest, ledger);
    runRetention({ projectRoot: config.projectRoot, destination: config.destination }, policy,
      { now: () => NOW }, { kind: 'run', confirm: plan.digest });
  } catch (err) {
    return result(config, 'refused', refusalOf(err), ledger);
  }
  return result(config, 'completed', '', ledger);
}

/**
 * The same refusal, through the shipped CLI with `--json`.
 *
 * WHAT THIS ADDS THAT THE LIBRARY CALL DOES NOT: the operator-facing surface. A lock refusal has to leave the
 * exit code and the stream discipline every other refusal has — one JSON document on the stream that promises
 * one, and nothing appended to it.
 */
function retentionViaCli(config: ContenderConfig, digest: string, ledger: CommandLedger): ContenderResult {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts: unknown[]) => { out.push(parts.map(String).join(' ')); };
  console.error = (...parts: unknown[]) => { err.push(parts.map(String).join(' ')); };
  let code: number;
  try {
    code = retentionCliMain([
      '--project', config.projectRoot, '--destination', config.destination,
      '--keep-last', '1', '--min-age-days', '0', '--confirm', digest, '--json',
    ]);
  } finally {
    console.log = log;
    console.error = error;
  }
  return {
    label: config.label,
    command: config.command,
    // The CLI turns a refusal into an exit code rather than an exception. Three is this family's "refused".
    outcome: code === 3 ? 'refused' : code === 0 ? 'completed' : 'failed',
    message: [...out, ...err].join('\n'),
    commands: ledger.flat(),
    stdout: out.join('\n'),
    exitCode: code,
  };
}

function safetySetLifecycle(config: ContenderConfig, ledger: CommandLedger): ContenderResult {
  const policy = { ...DEFAULT_SAFETY_SET_POLICY, keepLast: 1, minAgeDays: 0 };
  try {
    const resolved = resolveSafetySetRequest({
      projectRoot: config.projectRoot, destination: config.destination,
    });
    const plan = planSafetySetLifecycle(resolved, policy, NOW);
    runSafetySetLifecycle({ projectRoot: config.projectRoot, destination: config.destination }, policy,
      { now: () => NOW }, { kind: 'run', confirm: plan.digest });
  } catch (err) {
    return result(config, 'refused', refusalOf(err), ledger);
  }
  return result(config, 'completed', '', ledger);
}

function result(
  config: ContenderConfig,
  outcome: ContenderResult['outcome'],
  message: string,
  ledger: CommandLedger,
): ContenderResult {
  return {
    label: config.label,
    command: config.command,
    outcome,
    message,
    commands: ledger.flat(),
    stdout: '',
    exitCode: -1,
  };
}

function main(): number {
  const config = JSON.parse(process.argv[2] ?? '{}') as ContenderConfig;
  const ledger = new CommandLedger();
  let outcome: ContenderResult;
  switch (config.command) {
    case 'complete-backup': outcome = completeBackup(config, ledger); break;
    case 'complete-restore': outcome = completeRestore(config, ledger); break;
    case 'backup-retention': outcome = backupRetention(config, ledger); break;
    case 'safety-set-lifecycle': outcome = safetySetLifecycle(config, ledger); break;
  }
  writeFileSync(config.resultFile, JSON.stringify(outcome), 'utf8');
  // The result file is the report. The exit code only distinguishes "this child ran" from "it did not".
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (err: Error) => {
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exitCode = 9;
  });
}
