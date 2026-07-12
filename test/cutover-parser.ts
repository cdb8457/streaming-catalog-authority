import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCutoverDoctorCheckpoint } from '../src/ops/cutover-doctor-check.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg} (expected ${String(expected)}, got ${String(actual)})`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

console.log('Running Phase 196 cutover parser suite:\n');

test('parses the retained Phase 195 post-switch doctor artifact as healthy', () => {
  const raw = read('test/fixtures/phase-196/phase-195-post-switch-doctor.raw.txt');
  const result = parseCutoverDoctorCheckpoint(raw);
  assertEq(result.status, 'healthy', 'status');
  assertEq(result.ok, true, 'ok');
  assertEq(result.fail, 0, 'fail count');
  assert((result.warn ?? 0) >= 1, 'warns are allowed');
});

test('classifies doctor ok:false/fail checks as unhealthy, not parse-error', () => {
  const raw = [
    '> npm banner',
    JSON.stringify({
      reportVersion: 1,
      ok: false,
      checks: [
        { name: 'db-owner-reachable', state: 'pass', detail: 'owner/admin connection responds' },
        { name: 'custodian-reachable', state: 'fail', detail: 'key custodian is not reachable' },
      ],
    }),
  ].join('\n');
  const result = parseCutoverDoctorCheckpoint(raw);
  assertEq(result.status, 'unhealthy', 'status');
  assertEq(result.retryable, false, 'not retryable');
  assertEq(result.fail, 1, 'fail count');
});

test('classifies malformed or missing JSON as retryable parse-error', () => {
  for (const raw of ['> npm banner only\n', '{"ok":true}\n', '{"reportVersion":1,"ok":true,"checks":"bad"}\n']) {
    const result = parseCutoverDoctorCheckpoint(raw);
    assertEq(result.status, 'parse-error', 'status');
    assertEq(result.retryable, true, 'retryable');
    assert(result.reason?.includes('no valid doctor JSON object'), 'reason explains missing schema');
  }
});

test('classifies nonzero exit with healthy JSON as retryable checkpoint error', () => {
  const raw = read('test/fixtures/phase-196/phase-195-post-switch-doctor.raw.txt');
  const result = parseCutoverDoctorCheckpoint(raw, 1);
  assertEq(result.status, 'parse-error', 'status');
  assertEq(result.retryable, true, 'retryable');
  assert(result.reason?.includes('exit code was nonzero'), 'reason explains exit disagreement');
});

test('package, docs, and deploy guard include Phase 196 parser fix', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const doc = read('docs/PHASE_196_CUTOVER_PARSER_FIX.md');
  const deploy = read('test/deploy.ts');
  assertEq(pkg.scripts['test:cutover-parser'], 'tsx test/cutover-parser.ts', 'script');
  assert(doc.includes('phase-196-cutover-parser-fix'), 'doc id');
  assert(doc.includes('phase-195-post-switch-doctor.raw.txt'), 'real fixture cited');
  assert(deploy.includes('Phase 196 cutover doctor/parser fix'), 'deploy guard');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
