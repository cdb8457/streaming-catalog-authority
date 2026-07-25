import { BootstrapError, runBootstrap } from './bootstrap.js';

/**
 * Phase 253 — the first-run bootstrap Compose gates the app on.
 *
 *   npm run ops:bootstrap        (in the stack: `docker compose up -d` runs it for you)
 *
 * Applies the schema idempotently under an exclusive lock, provisions the runtime credential and the
 * completion secret, and proves the least-privileged runtime connection can read the applied version. Exits
 * 0 only when all of that is true, so `depends_on: { condition: service_completed_successfully }` is a real
 * gate rather than a formality.
 *
 * Prints step codes and fixed sentences. Never a connection string, a password, a secret or a host path.
 */
const json = process.argv.slice(2).includes('--json');

runBootstrap()
  .then((result) => {
    if (json) {
      console.log(JSON.stringify(result));
      return;
    }
    console.log('ops:bootstrap — first-run database setup');
    for (const step of result.steps) console.log(`  ${step.outcome.padEnd(15)} ${step.id}: ${step.detail}`);
    console.log(`\nops:bootstrap complete — schema version ${result.schemaVersion}.`);
  })
  .catch((err: unknown) => {
    const code = err instanceof BootstrapError ? err.code : 'BOOTSTRAP_FAILED';
    const message = (err as Error).message;
    if (json) {
      console.log(JSON.stringify({ ok: false, report: 'phase-253-bootstrap', code, message }));
    } else {
      // The message is the one the step already chose or a driver error. Driver errors can name a host and a
      // database, which is why this goes to stderr as a single line rather than into a page or a report.
      console.error(`ops:bootstrap failed: ${code}: ${message}`);
      console.error('The app container is deliberately not started when this fails. Fix the cause and re-run');
      console.error('`docker compose up -d`; this command is idempotent and safe to repeat.');
    }
    process.exit(1);
  });
