#!/usr/bin/env node
// Projection Phase 5 — the mount-health gate's thresholds, published to the shell that measures against them.
//
// THE NUMBERS LEAVE HERE AND NOWHERE ELSE. `PROJECTIOND_MOUNT_HEALTH` freezes them; this renders them as
// assignments a POSIX shell can `eval`; and `test/projection-operational-mount-health.ts` asserts the gate
// contains no literal spelling of any of them. That is what stops the gate carrying a second copy of a number
// the contract derives — the drift this repository has already had to retire budgets over.
//
// PHASE 4'S NUMBERS TRAVEL WITH THEM, under the same prefix, because the Phase 5 gate consumes them too. A
// gate that read one set from a module and the other from its own text would be exactly half protected.

import {
  PROJECTIOND_MOUNT_HEALTH,
  PROJECTIOND_MOUNT_OBSERVATION,
  READYZ_CANNOT_HAVE_WAITED_FOR_A_PROBE,
  LIVEZ_CANNOT_HAVE_WAITED_FOR_A_PROBE,
  HEALTHCHECK_START_PERIOD_CLEARS_BOOTSTRAP_GRACE,
  HEALTHCHECK_TIMEOUT_CLEARS_READINESS_BUDGET,
  DAEMON_DECIDES_UNHEALTHY_NOT_DOCKER,
  MOUNT_HEALTH_POLICY_IS_BOUNDED_BY_ITS_SAMPLER,
} from '../core/projection/runtime-contract.js';

/**
 * The derived facts the gate's arms depend on, checked WHERE THEY ARE PUBLISHED.
 *
 * If any one of them stopped holding, an arm would keep passing while measuring something else — a latency
 * budget that a blocking handler could satisfy, a container health that flipped on Docker's retry count
 * rather than on the daemon's policy, a transient the daemon was entitled to fail. So the gate cannot even
 * load its thresholds when one of them breaks.
 */
const DERIVED: ReadonlyArray<readonly [string, boolean, string]> = [
  ['READYZ_CANNOT_HAVE_WAITED_FOR_A_PROBE', READYZ_CANNOT_HAVE_WAITED_FOR_A_PROBE,
    'the readiness budget is no longer strictly under the probe timeout'],
  ['LIVEZ_CANNOT_HAVE_WAITED_FOR_A_PROBE', LIVEZ_CANNOT_HAVE_WAITED_FOR_A_PROBE,
    'the liveness budget is no longer strictly under the probe timeout'],
  ['HEALTHCHECK_START_PERIOD_CLEARS_BOOTSTRAP_GRACE', HEALTHCHECK_START_PERIOD_CLEARS_BOOTSTRAP_GRACE,
    'the healthcheck would count a probe the bootstrap grace answered, so a container could report healthy '
    + 'having never observed its mount'],
  ['HEALTHCHECK_TIMEOUT_CLEARS_READINESS_BUDGET', HEALTHCHECK_TIMEOUT_CLEARS_READINESS_BUDGET,
    'an endpoint answering inside its own budget could be recorded as a healthcheck timeout'],
  ['DAEMON_DECIDES_UNHEALTHY_NOT_DOCKER', DAEMON_DECIDES_UNHEALTHY_NOT_DOCKER,
    'Docker would call the container unhealthy before the daemon believed the fault, so the anti-flap policy '
    + 'would live in two places and therefore in neither'],
  ['MOUNT_HEALTH_POLICY_IS_BOUNDED_BY_ITS_SAMPLER', MOUNT_HEALTH_POLICY_IS_BOUNDED_BY_ITS_SAMPLER,
    'the hold, the grace, the confirmation or the anti-flap transient no longer sits where its derivation '
    + 'puts it relative to the sampler'],
];

function main(): void {
  const [command = '', ...rest] = process.argv.slice(2);
  const shell = rest.includes('--sh');

  if (command !== 'budgets') {
    console.error(`projection-mount-health: unknown command: ${command || '(none)'}`);
    process.exit(1);
  }

  for (const [name, holds, why] of DERIVED) {
    if (!holds) {
      console.error(`projection-mount-health: ${name} no longer holds: ${why}`);
      process.exit(1);
    }
  }

  // THE PHASE 4 NUMBERS FIRST, so a shell that evals this needs no second source. They are re-exported, not
  // re-declared: their values and derivations are Phase 4's and this tranche moves none of them.
  for (const [key, value] of Object.entries(PROJECTIOND_MOUNT_OBSERVATION)) {
    if (typeof value !== 'number') continue;
    if (shell) console.log(`MH_${key}=${String(value)}`);
    else console.log(`  ${key.padEnd(34)} ${String(value)}`);
  }
  for (const [key, value] of Object.entries(PROJECTIOND_MOUNT_HEALTH)) {
    if (typeof value !== 'number') continue;
    if (shell) console.log(`MH_${key}=${String(value)}`);
    else console.log(`  ${key.padEnd(34)} ${String(value)}`);
  }
  if (shell) {
    // The reason codes and the states travel with the numbers, so the gate never spells one either.
    console.log(`MH_READY_REASONS='${PROJECTIOND_MOUNT_HEALTH.READY_REASONS.join(' ')}'`);
    console.log(`MH_STATES='${PROJECTIOND_MOUNT_OBSERVATION.STATES.join(' ')}'`);
    // Named individually as well, because an arm asserts one specific code and picking a word out of a
    // space-separated list in a shell is how a typo becomes a silently unfailable comparison.
    for (const reason of PROJECTIOND_MOUNT_HEALTH.READY_REASONS) {
      console.log(`MH_REASON_${reason.toUpperCase().replace(/-/g, '_')}='${reason}'`);
    }
    console.log(`MH_STATE_LIVE='${PROJECTIOND_MOUNT_OBSERVATION.STATES[0]}'`);
  } else {
    console.log(`  ${'READY_REASONS'.padEnd(34)} ${PROJECTIOND_MOUNT_HEALTH.READY_REASONS.join(' ')}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`projection-mount-health: ${(error as Error).message}`);
  process.exit(1);
}
