import {
  buildSidecarUnraidServicePlan,
  formatSidecarUnraidServicePlanText,
} from './sidecar-unraid-service-plan.js';

function main(): void {
  const plan = buildSidecarUnraidServicePlan();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatSidecarUnraidServicePlanText(plan));
}

main();
