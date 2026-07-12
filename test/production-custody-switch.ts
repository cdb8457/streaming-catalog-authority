import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

console.log('Running Phase 195 production custody switch attempt suite:\n');

test('phase record documents attempted rollback and keeps gates open', () => {
  const doc = read('docs/PHASE_195_PRODUCTION_CUSTODY_SWITCH.md');
  for (const required of [
    'phase-195-production-custody-switch',
    'attempted-with-rollback',
    'Production custody is not switched',
    'Rollback trigger: `post_switch_doctor_failed`',
    'post-switch doctor output later parsed as `ok:true`',
    'phase-195-precondition-evidence',
    'phase-195-custody-state-backup-verified',
    'phase-195-post-rollback-verification',
    'O4 status after this attempt: `open/deferred`',
    'O5 status after this attempt: `open/deferred`',
    'Phase 195 exit criteria are not met',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

test('runtime compose remains on file custody after rollback', () => {
  const compose = read('docker-compose.unraid.runtime.yml');
  assert((compose.match(/CUSTODIAN_MODE: file/g) ?? []).length >= 2, 'app and ops remain file mode');
  assert(!compose.includes('CUSTODIAN_MODE: sidecar'), 'app/ops are not left in sidecar mode');
  assert(compose.includes('CUSTODIAN_KEYSTORE_DIR: /var/lib/catalog/keystore'), 'file keystore env restored');
  assert(compose.includes('CUSTODIAN_KEK_FILE: /run/secrets/custodian_kek'), 'KEK secret env restored');
});

test('doctor sidecar compatibility remains available for a future retry', () => {
  const source = `${read('src/ops/doctor.ts')}\n${read('src/ops/doctor-cli.ts')}\n${read('src/ops/operator-ui-service.ts')}\n${read('test/ops-doctor.ts')}`;
  assert(source.includes('completion secret is delegated to the sidecar custodian'), 'delegated completion-secret check');
  assert(source.includes("custodianConfig.mode === 'sidecar'"), 'sidecar caller branch');
  assert(source.includes('doctor - sidecar mode delegates completion secret out of app/ops'), 'sidecar doctor regression test');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
