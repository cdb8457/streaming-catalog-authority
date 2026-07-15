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

console.log('Running Phase 224 working foundation plan suite:\n');

test('Phase 224 honestly redefines launch-ready as infrastructure readiness only', () => {
  const doc = read('docs/PHASE_224_WORKING_FOUNDATION_REDEFINITION.md');
  const phase200 = read('docs/PHASE_200_LAUNCH_READINESS_PASS.md');
  const phase223 = read('docs/PHASE_223_RELEASE_CUT.md');
  for (const required of [
    'phase-224-working-foundation-redefinition',
    'Prior `launch-ready` claims in Phase 200 and Phase 223 describe infrastructure readiness',
    'not product\nreadiness',
    'WORKING_FOUNDATION = one complete, boring, repeatable media workflow from input to visible result',
    'PRODUCT_READY_FALSE_E2E_WORKFLOW_MISSING',
    'Phase 224 Addendum',
    'infrastructure readiness, not product',
  ]) {
    const haystack = required === 'Phase 224 Addendum' || required === 'infrastructure readiness, not product'
      ? `${phase200}\n${phase223}`
      : doc;
    assert(haystack.includes(required), `record includes ${required}`);
  }
});

test('capability matrix records what works, what is partial, and what is missing', () => {
  const doc = read('docs/PHASE_224_WORKING_FOUNDATION_REDEFINITION.md');
  for (const required of [
    '| Runtime stack | Working for infrastructure scope |',
    '| Custody path | Working for current sidecar scope |',
    '| Operator UI/API | Working for health/status scope |',
    '| Jellyfin read-only integration | Partial, read-only only |',
    '| Jellyfin write integration | Not working / blocked |',
    '| Local media import | Missing |',
    '| Provider integrations | Missing / out of scope |',
    '| Download/acquisition | Missing / out of scope |',
    '| Playback orchestration | Missing / out of scope |',
    '| End-to-end visible media workflow | Missing |',
  ]) assert(doc.includes(required), `capability matrix includes ${required}`);
});

test('first workflow defines local media import without providers', () => {
  const doc = read('docs/PHASE_224_WORKING_FOUNDATION_REDEFINITION.md');
  for (const required of [
    'First Workflow: Local-Media Pipeline',
    '/mnt/user/media/catalog-authority-test-library',
    '/Movies/<Title> (<Year>)/<Title> (<Year>).<ext>',
    'Import mode for the first proof:',
    '`copy`',
    'source remains unchanged',
    'Destination file observed with matching size and SHA-256',
    'Jellyfin read-only query returns mapped item',
    'operator input -> catalog item stored -> media file imported -> Jellyfin can see it -> UI reports the lifecycle status',
  ]) assert(doc.includes(required), `workflow includes ${required}`);
});

test('state machine and failure semantics require observed-state verification', () => {
  const doc = read('docs/PHASE_224_WORKING_FOUNDATION_REDEFINITION.md');
  for (const required of [
    '`REQUESTED`',
    '`STORED`',
    '`IMPORT_VALIDATING`',
    '`IMPORTING`',
    '`IMPORTED`',
    '`JELLYFIN_SCAN_WAITING`',
    '`VISIBLE_IN_JELLYFIN`',
    '`FAILED`',
    'verification\nmeans observed state, not accepted commands or HTTP status codes alone',
    '`IMPORT_DESTINATION_COLLISION`',
    '`IMPORT_COPY_MISMATCH`',
    '`JELLYFIN_SCAN_TIMEOUT`',
    '`JELLYFIN_VISIBLE_MISMATCH`',
    'repeating a successful import with the same source checksum and destination is a no-op success',
  ]) assert(doc.includes(required), `state/failure section includes ${required}`);
});

test('phase ladder and non-scope guards keep providers and playback out', () => {
  const doc = read('docs/PHASE_224_WORKING_FOUNDATION_REDEFINITION.md');
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['test:working-foundation-plan'] === 'tsx test/working-foundation-plan.ts', 'phase test script present');
  assert(
    (pkg.scripts.test ?? '').includes('test/versioned-release-cut.ts && tsx test/working-foundation-plan.ts && tsx test/import-state-machine.ts && tsx test/jellyfin-test-library-preflight.ts && tsx test/real-library-promotion-boundary.ts && tsx test/real-library-promotion.ts && tsx test/deploy.ts'),
    'aggregate test includes Phase 224 before deploy guard',
  );
  for (const required of [
    'Phase 225: local import service and lifecycle state machine, local/fake evidence only.',
    'Phase 226: live single-file end-to-end on Unraid.',
    'Phase 227: repeatability and failure-injection proof.',
    'Phase 228: working-foundation acceptance record.',
    'provider integrations',
    'download orchestration',
    'playback orchestration',
    'Jellyfin writes or collection mutation',
    'Providers get defined later as "how files arrive at Step 3."',
  ]) assert(doc.includes(required), `ladder/non-scope includes ${required}`);
  for (const forbidden of [
    'provider live mode enabled',
    'download enabled',
    'playback enabled',
    'scraping enabled',
    'JELLYFIN_WRITE_CAPABLE_LAUNCH_ELIGIBLE',
    'PRODUCT_READY_TRUE',
  ]) assert(!doc.includes(forbidden), `plan excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
