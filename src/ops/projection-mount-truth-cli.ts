#!/usr/bin/env node
// Projection Phase 4 — the mount-truth gate's thresholds, published to the shell that measures against them.
//
// THE NUMBERS LEAVE HERE AND NOWHERE ELSE. `PROJECTIOND_MOUNT_OBSERVATION` freezes them; this renders them as
// assignments a POSIX shell can `eval`; and `test/projection-mount-truth.ts` asserts the gate contains no
// literal spelling of any of them. That is what stops the gate carrying a second copy of a number the
// contract derives — the drift this repository has already had to retire budgets over.

import {
  PROJECTIOND_MOUNT_OBSERVATION,
  READYZ_CANNOT_HAVE_WAITED_FOR_A_PROBE,
} from '../core/projection/runtime-contract.js';

function main(): void {
  const [command = '', ...rest] = process.argv.slice(2);
  const shell = rest.includes('--sh');

  if (command !== 'budgets') {
    console.error(`projection-mount-truth: unknown command: ${command || '(none)'}`);
    process.exit(1);
  }

  // A DERIVED FACT THE GATE DEPENDS ON, CHECKED WHERE IT IS PUBLISHED. MT3's whole claim is that /readyz
  // could not have waited for a probe. If the latency budget ever stopped being strictly under the probe
  // timeout, a handler that blocked on the probe would satisfy its own budget and MT3 would quietly stop
  // meaning anything — so the gate cannot even load its thresholds when that stops holding.
  if (!READYZ_CANNOT_HAVE_WAITED_FOR_A_PROBE) {
    console.error('projection-mount-truth: the /readyz latency budget is no longer strictly under the probe '
      + 'timeout, so MT3 could no longer catch an endpoint that waited for a probe');
    process.exit(1);
  }

  for (const [key, value] of Object.entries(PROJECTIOND_MOUNT_OBSERVATION)) {
    if (typeof value !== 'number') continue;
    if (shell) console.log(`MT_${key}=${String(value)}`);
    else console.log(`  ${key.padEnd(28)} ${String(value)}`);
  }
  if (shell) {
    // The state names travel with the numbers, so the gate never spells one either.
    console.log(`MT_STATES='${PROJECTIOND_MOUNT_OBSERVATION.STATES.join(' ')}'`);
  }
}

try {
  main();
} catch (error) {
  console.error(`projection-mount-truth: ${(error as Error).message}`);
  process.exit(1);
}
