import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGateDag, verifyGateDag, type GateNode } from '../src/ops/promotion-gate-dag.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

const root = fileURLToPath(new URL('..', import.meta.url));

console.log('Running Phase 230 gate DAG suite:\n');

await test('the gate DAG is acyclic and every dependency resolves', () => {
  const dag = verifyGateDag();
  assert(dag.ok, `ok (problems: ${dag.problems.join(',')})`);
  assert(dag.acyclic, 'acyclic');
  assertEq(dag.topoOrder.length, dag.nodeCount, 'topo order covers every node');
  assert(/^[0-9a-f]{64}$/.test(dag.dagDigest), 'dag digest present');
});

await test('every node points at a real test file and its deps precede it in topo order', () => {
  const dag = verifyGateDag();
  const position = new Map(dag.topoOrder.map((id, i) => [id, i]));
  for (const node of dag.nodes) {
    assert(existsSync(`${root}/${node.test}`), `missing test ${node.test} for ${node.id}`);
    for (const dep of node.dependsOn) {
      assert(position.get(dep)! < position.get(node.id)!, `${dep} must precede ${node.id}`);
    }
  }
});

await test('a manually-introduced cycle is detected', () => {
  const nodes = buildGateDag().map((n) => ({ ...n })) as GateNode[];
  // approval depends on promotion which depends on approval -> cycle
  const idx = nodes.findIndex((n) => n.id === 'approval');
  nodes[idx] = { ...nodes[idx]!, dependsOn: ['promotion'] };
  const dag = verifyGateDag(nodes);
  assert(!dag.ok, 'rejected');
  assert(!dag.acyclic && dag.problems.includes('CYCLE_DETECTED'), 'cycle detected');
});

await test('an unknown dependency is detected', () => {
  const nodes = buildGateDag().map((n) => ({ ...n })) as GateNode[];
  nodes.push({ id: 'orphan', test: 'test/none.ts', dependsOn: ['does-not-exist'], blockers: [] });
  const dag = verifyGateDag(nodes);
  assert(!dag.ok, 'rejected');
  assert(dag.problems.some((p) => p.startsWith('UNKNOWN_DEPENDENCY:')), 'unknown dependency reported');
});

await test('CLI verifies the DAG and never echoes raw paths to stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-dag-'));
  try {
    const outPath = join(dir, 'catalog-authority-test-library', 'DAGMARKER-out', 'dag.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-gate-dag-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: root, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `acyclic exit 0 (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'dag file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.acyclic, true, 'stdout acyclic');
    assert(!(res.stdout ?? '').includes('DAGMARKER') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
