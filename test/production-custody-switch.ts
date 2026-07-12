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

console.log('Running Phase 197 production custody switch retry suite:\n');

test('phase record documents successful sidecar switch and O4 closure eligibility', () => {
  const doc = read('docs/PHASE_197_PRODUCTION_CUSTODY_SWITCH_RETRY.md');
  for (const required of [
    'phase-197-production-custody-switch-retry',
    'production-sidecar-custody-active',
    'CUSTODIAN_MODE=sidecar',
    'attempt=1 doctor_exit=0 parser_exit=0 verdict=healthy',
    '"status":"healthy"',
    'post-switch doctor parser output',
    'app-path doctor parser output',
    'sidecar exposure proof',
    'Persistence evidence manifest digest',
    'Rollback was not triggered.',
    'O4 status after Phase 197: `closure-eligible`',
    'O5 status after Phase 197: `open/deferred`',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

test('runtime compose asserts sidecar custody after successful switch', () => {
  const compose = read('docker-compose.unraid.runtime.yml');
  assert((compose.match(/CUSTODIAN_MODE: sidecar/g) ?? []).length >= 2, 'app and ops are sidecar mode');
  assert(!compose.includes('CUSTODIAN_MODE: file'), 'app/ops are not left in file mode');
  assert((compose.match(/CUSTODIAN_SIDECAR_SOCKET_PATH: \/run\/catalog-sidecar\/catalog-sidecar\.sock/g) ?? []).length >= 2, 'app and ops receive socket path');
  assert((compose.match(/sidecar\/run:\/run\/catalog-sidecar/g) ?? []).length >= 2, 'app and ops mount only sidecar run socket path');
  assert(!compose.includes('CUSTODIAN_KEYSTORE_DIR: /var/lib/catalog/keystore'), 'file keystore env removed from app/ops');
  assert(!compose.includes('CUSTODIAN_KEK_FILE: /run/secrets/custodian_kek'), 'KEK secret env removed from app/ops');
});

test('doctor sidecar compatibility is the active production path', () => {
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
