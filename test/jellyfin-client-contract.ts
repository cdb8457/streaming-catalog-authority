import { FakeJellyfinClient } from '../src/core/adapters/jellyfin/fake-client.js';
import { runJellyfinClientContract, type ContractHarness } from './jellyfin-contract-kit.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

const h: ContractHarness = {
  async test(name, fn) {
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
  },
  assert(cond, msg) { if (!cond) throw new Error(msg); },
  assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); },
};

async function main(): Promise<void> {
  console.log('Running Phase 11 shared JellyfinClient contract vs the fake (Stage 11.1):\n');
  await runJellyfinClientContract('FakeJellyfinClient', h, (library) => new FakeJellyfinClient(library));

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
