#!/usr/bin/env node
// Projection Phase 6 — the recovery gate's thresholds and codes, published to the shell that measures
// against them.
//
// THE NUMBERS AND THE CODES LEAVE HERE AND NOWHERE ELSE. `PROJECTIOND_MOUNT_RECOVERY` freezes them; this
// renders them as assignments a POSIX shell can `eval`; and `test/projection-bounded-recovery.ts` asserts the
// gate contains no literal spelling of any of them. An arm comparing against a mistyped literal is an arm
// that can never fail, and this repository has already found that shape five separate times.
//
// PHASE 4 AND PHASE 5'S NUMBERS TRAVEL WITH THEM, under the same prefix, because the recovery gate consumes
// them too: it waits out a fault hold before a recovery can even be entitled to act, and it asserts that a
// transient bounded by `ANTI_FLAP_TRANSIENT_MS` produces no action at all.

import {
  PROJECTIOND_MOUNT_HEALTH,
  PROJECTIOND_MOUNT_OBSERVATION,
  PROJECTIOND_MOUNT_RECOVERY,
  RECOVERY_NEVER_ACTS_ON_A_FAULT_READINESS_DID_NOT_BELIEVE,
  RECOVERY_ATTEMPTS_CANNOT_OVERLAP,
  RECOVERY_CANNOT_LOOP_FOREVER,
  RECOVERY_REFUND_REQUIRES_A_FRESH_OBSERVATION,
} from '../core/projection/runtime-contract.js';

/**
 * The derived facts the gate's arms depend on, checked WHERE THEY ARE PUBLISHED.
 *
 * If any one of them stopped holding, an arm would keep passing while measuring something else — a recovery
 * that fired on a transient the daemon was entitled to survive, two attempts overlapping in wall-clock, a
 * budget that a restart refunds, or a refund granted by the same observation that granted readiness. So the
 * gate cannot even load its thresholds when one of them breaks.
 */
const DERIVED: ReadonlyArray<readonly [string, boolean, string]> = [
  ['RECOVERY_NEVER_ACTS_ON_A_FAULT_READINESS_DID_NOT_BELIEVE',
    RECOVERY_NEVER_ACTS_ON_A_FAULT_READINESS_DID_NOT_BELIEVE,
    'the sustain window, the tick or the anti-flap relation no longer sits where its derivation puts it, so '
    + 'a recovery could fire on a fault readiness had not already believed'],
  ['RECOVERY_ATTEMPTS_CANNOT_OVERLAP', RECOVERY_ATTEMPTS_CANNOT_OVERLAP,
    'the cooldown no longer outlasts the whole attempt deadline, so an abandoned attempt could be running '
    + 'while the next one starts'],
  ['RECOVERY_CANNOT_LOOP_FOREVER', RECOVERY_CANNOT_LOOP_FOREVER,
    'the budget is no longer finite, durable and cleared only by a human, or a restart policy changed'],
  ['RECOVERY_REFUND_REQUIRES_A_FRESH_OBSERVATION', RECOVERY_REFUND_REQUIRES_A_FRESH_OBSERVATION,
    'the confirmation window no longer outlasts a whole worst-case sampling window, so the budget could be '
    + 'refunded by the same observation that granted readiness'],
];

/** A contract key rendered as a shell-safe identifier fragment. */
const shellName = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

function main(): void {
  const [command = '', ...rest] = process.argv.slice(2);
  const shell = rest.includes('--sh');

  if (command !== 'budgets') {
    console.error(`projection-recovery: unknown command: ${command || '(none)'}`);
    process.exit(1);
  }

  for (const [name, holds, why] of DERIVED) {
    if (!holds) {
      console.error(`projection-recovery: ${name} no longer holds: ${why}`);
      process.exit(1);
    }
  }

  const groups = [PROJECTIOND_MOUNT_OBSERVATION, PROJECTIOND_MOUNT_HEALTH, PROJECTIOND_MOUNT_RECOVERY];
  for (const group of groups) {
    for (const [key, value] of Object.entries(group)) {
      if (typeof value !== 'number') continue;
      if (shell) console.log(`RC_${key}=${String(value)}`);
      else console.log(`  ${key.padEnd(36)} ${String(value)}`);
    }
  }

  if (!shell) {
    console.log(`  ${'DECISION_CODES'.padEnd(36)} ${PROJECTIOND_MOUNT_RECOVERY.DECISION_CODES.join(' ')}`);
    console.log(`  ${'STATES'.padEnd(36)} ${PROJECTIOND_MOUNT_RECOVERY.STATES.join(' ')}`);
    return;
  }

  // The whole closed sets, so an arm can assert membership rather than a spelling...
  console.log(`RC_DECISION_CODES='${PROJECTIOND_MOUNT_RECOVERY.DECISION_CODES.join(' ')}'`);
  console.log(`RC_STATES='${PROJECTIOND_MOUNT_RECOVERY.STATES.join(' ')}'`);
  console.log(`RC_REMEDIATIONS='${PROJECTIOND_MOUNT_RECOVERY.REMEDIATIONS.join(' ')}'`);
  // ...and every one named individually, because picking a word out of a space-separated list in a shell is
  // how a typo becomes a silently unfailable comparison.
  for (const code of PROJECTIOND_MOUNT_RECOVERY.DECISION_CODES) {
    console.log(`RC_CODE_${shellName(code)}='${code}'`);
  }
  for (const state of PROJECTIOND_MOUNT_RECOVERY.STATES) {
    console.log(`RC_STATE_${shellName(state)}='${state}'`);
  }
  for (const remediation of PROJECTIOND_MOUNT_RECOVERY.REMEDIATIONS) {
    console.log(`RC_REMEDIATION_${shellName(remediation)}='${remediation}'`);
  }
  // The readiness reasons and the observation states the recovery arms key off, from Phase 5 and Phase 4.
  for (const reason of PROJECTIOND_MOUNT_HEALTH.READY_REASONS) {
    console.log(`RC_REASON_${shellName(reason)}='${reason}'`);
  }
  for (const state of PROJECTIOND_MOUNT_OBSERVATION.STATES) {
    console.log(`RC_OBSERVED_${shellName(state)}='${state}'`);
  }
  console.log(`RC_LEDGER_FILENAME='${PROJECTIOND_MOUNT_RECOVERY.LEDGER_FILENAME}'`);
}

try {
  main();
} catch (error) {
  console.error(`projection-recovery: ${(error as Error).message}`);
  process.exit(1);
}
