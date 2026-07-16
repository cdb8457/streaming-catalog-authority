import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LOCAL_OPS_REGISTRY } from '../src/ops/promotion-acceptance-meta.js';

// Closure guard for the Phase 230 local tooling: every local tool must have a module, a CLI, a test, a
// doc, ops+test package scripts, and be wired into the test:phase230-local gate; every doc must state
// its non-live / no-Phase-231 boundary; and the local gate must contain ONLY local suites. This proves
// the local toolchain is complete and self-contained. It reads files + package.json only.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const exists = (rel: string): boolean => existsSync(`${root}/${rel}`);
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
const gate = pkg.scripts['test:phase230-local'] ?? '';

// Every local tool: module base -> doc name. Each has a CLI, a test, and ops:/test: scripts.
const TOOLS = LOCAL_OPS_REGISTRY; // single source of truth (also drives the acceptance meta-check)

// Test-only local suites (no module/CLI/ops script).
const TEST_ONLY = ['promotion-live-boundary-guard', 'phase230-local-suite-manifest', 'phase230-closure'];
// The one guarded service exercised (fixture-only) in the gate.
const SERVICE_SUITE = 'real-library-promotion';

console.log('Running Phase 230 local closure guard:\n');

for (const { base, doc } of TOOLS) {
  test(`${base} is fully mapped (module, cli, test, doc, scripts, gate)`, () => {
    assert(exists(`src/ops/${base}.ts`), `missing module src/ops/${base}.ts`);
    assert(exists(`src/ops/${base}-cli.ts`), `missing cli src/ops/${base}-cli.ts`);
    assert(exists(`test/${base}.ts`), `missing test test/${base}.ts`);
    assert(exists(`docs/${doc}.md`), `missing doc docs/${doc}.md`);
    assert(typeof pkg.scripts[`ops:${base}`] === 'string', `missing ops:${base} script`);
    assert(typeof pkg.scripts[`test:${base}`] === 'string', `missing test:${base} script`);
    assert(gate.includes(`tsx test/${base}.ts`), `test/${base}.ts not in test:phase230-local`);
    const d = read(`docs/${doc}.md`);
    assert(d.includes('Phase 231') && /no Phase 231|does not authorize Phase 231|no live-promotion|no live Jellyfin|never contacts Jellyfin/i.test(d), `docs/${doc}.md lacks boundary language`);
  });
}

test('the test-only local suites exist and are in the gate', () => {
  for (const base of TEST_ONLY) {
    assert(exists(`test/${base}.ts`), `missing test/${base}.ts`);
    assert(gate.includes(`tsx test/${base}.ts`), `test/${base}.ts not in the gate`);
  }
});

test('the guarded service fixture suite is in the gate', () => {
  assert(exists(`test/${SERVICE_SUITE}.ts`), `missing test/${SERVICE_SUITE}.ts`);
  assert(gate.includes(`tsx test/${SERVICE_SUITE}.ts`), `${SERVICE_SUITE} not in the gate`);
});

test('the local gate contains ONLY local suites (no legacy/live/DB suites)', () => {
  const allowed = new Set<string>([
    ...TOOLS.map((t) => t.base), ...TEST_ONLY, SERVICE_SUITE,
  ]);
  const referenced = [...gate.matchAll(/tsx test\/([a-z0-9-]+)\.ts/g)].map((m) => m[1]!);
  assert(referenced.length > 0, 'gate references no suites');
  for (const suite of referenced) {
    assert(allowed.has(suite), `test:phase230-local references a non-local suite: ${suite}`);
  }
});

test('the closure index doc exists and states the boundary', () => {
  assert(exists('docs/PHASE_230_LOCAL_CLOSURE_INDEX.md'), 'missing closure index doc');
  const d = read('docs/PHASE_230_LOCAL_CLOSURE_INDEX.md');
  assert(d.includes('Phase 231') && /no live Jellyfin|never contacts Jellyfin|does not authorize Phase 231/i.test(d), 'closure index lacks boundary language');
  for (const { base } of TOOLS) assert(d.includes(base), `closure index does not map ${base}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
