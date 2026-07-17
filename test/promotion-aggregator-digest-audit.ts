import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditAggregators, buildAggregatorDigestAudit, type AggregatorSource } from '../src/ops/promotion-aggregator-digest-audit.js';
import { verifySelfDigests } from '../src/ops/promotion-self-digest-verifier.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

// A synthetic conformant binder: recomputes (verifySelfDigests), fails closed on mismatch, and its test
// asserts the rejection. These strings mirror the real binder shape without touching the repo.
const CONFORMANT_MODULE = "import { verifySelfDigests } from './x.js';\n"
  + "const v = verifySelfDigests([obj]).results[0]?.verified === true;\n"
  + "if (!v) blockers.push('COMPONENT_DIGEST_MISMATCH');\n";
const CONFORMANT_TEST = "assert(r.blockers.includes('COMPONENT_DIGEST_MISMATCH'), 'green-body tamper');\n";
function conformant(name: string): AggregatorSource { return { name, moduleSrc: CONFORMANT_MODULE, testSrc: CONFORMANT_TEST }; }

console.log('Running Phase 230 aggregator digest fail-open audit suite:\n');

test('the real repository audit is CLEAN: every component-digest binder recomputes', () => {
  const a = buildAggregatorDigestAudit(projectRoot);
  assertEq(a.overall, 'AGGREGATOR_AUDIT_CLEAN', `clean (gaps: ${a.gaps.join(',')})`);
  assertEq(a.authorization, 'NONE', 'authorizes nothing');
  assert(a.binderCount >= 6, `at least six binders discovered (got ${a.binderCount})`);
  assertEq(a.conformantCount, a.binderCount, 'every discovered binder is conformant');
  assert(a.aggregators.every((x) => x.recomputes && x.mismatchEnforced && x.mismatchTested), 'every binder recomputes, enforces, and is tested');
  // the known binders must all be present
  const names = new Set(a.aggregators.map((x) => x.aggregator));
  for (const n of ['terminal-closure', 'coordinator-readiness', 'review-automation', 'chain-bundle', 'reviewer-pack', 'pack-component-integrity']) {
    assert(names.has(n), `binder ${n} audited`);
  }
  assertEq(verifySelfDigests([a]).overall, 'ALL_VERIFIED', 'audit self-verifies');
  assert(!JSON.stringify(a).includes('/mnt/') && !JSON.stringify(a).includes(':\\'), 'redaction-safe');
});

test('CLEAN on synthetic all-conformant binders', () => {
  const a = auditAggregators([conformant('alpha'), conformant('beta')]);
  assertEq(a.overall, 'AGGREGATOR_AUDIT_CLEAN', 'clean');
  assertEq(a.binderCount, 2, 'two binders');
  assertEq(a.conformantCount, 2, 'both conformant');
});

test('FAILED with RECOMPUTE_ABSENT when a binder never delegates to the self-digest verifier', () => {
  const shapeOnly: AggregatorSource = {
    name: 'shape-only',
    moduleSrc: "const d = asSha256(raw);\nif (d === undefined) blockers.push('COMPONENT_DIGEST_INVALID');\nif (d) boundDigests[c] = d;\n",
    testSrc: 'assert(true);',
  };
  const a = auditAggregators([shapeOnly]);
  assertEq(a.overall, 'AGGREGATOR_AUDIT_FAILED', 'failed');
  assert(a.gaps.includes('RECOMPUTE_ABSENT'), 'recompute-absent gap');
  assert(a.gaps.includes('MISMATCH_NOT_ENFORCED'), 'mismatch-not-enforced gap');
  assert(a.aggregators[0]!.conformant === false, 'shape-only binder non-conformant');
});

test('FAILED with MISMATCH_NOT_ENFORCED when a binder recomputes but never fails closed on it', () => {
  const noEnforce: AggregatorSource = {
    name: 'no-enforce',
    moduleSrc: "const v = verifySelfDigests([obj]);\nif (v.overall === 'ALL_VERIFIED') boundDigests[c] = d;\n",
    testSrc: "assert(r.blockers.includes('COMPONENT_DIGEST_MISMATCH'));",
  };
  const a = auditAggregators([noEnforce]);
  assertEq(a.overall, 'AGGREGATOR_AUDIT_FAILED', 'failed');
  assert(a.gaps.includes('MISMATCH_NOT_ENFORCED'), 'mismatch-not-enforced gap');
  assert(!a.gaps.includes('RECOMPUTE_ABSENT'), 'recompute present');
});

test('FAILED with MISMATCH_UNTESTED when the recompute rejection is not asserted in a test', () => {
  const untested: AggregatorSource = {
    name: 'untested',
    moduleSrc: CONFORMANT_MODULE,
    testSrc: "assert(r.overall === 'READY', 'only the happy path');",
  };
  const a = auditAggregators([untested]);
  assertEq(a.overall, 'AGGREGATOR_AUDIT_FAILED', 'failed');
  assert(a.gaps.includes('MISMATCH_UNTESTED'), 'mismatch-untested gap');
  assert(!a.gaps.includes('RECOMPUTE_ABSENT') && !a.gaps.includes('MISMATCH_NOT_ENFORCED'), 'only the test gap');
});

test('FAILED with NO_BINDERS_FOUND when discovery yields nothing (never a vacuous pass)', () => {
  const a = auditAggregators([]);
  assertEq(a.overall, 'AGGREGATOR_AUDIT_FAILED', 'failed');
  assert(a.gaps.includes('NO_BINDERS_FOUND'), 'no-binders-found gap');
  assertEq(a.binderCount, 0, 'zero binders');
});

test('CLI runs the audit and never echoes raw paths to stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-aggaudit-'));
  try {
    const outPath = join(root, 'catalog-authority-test-library', 'AGGMARKER-out', 'audit.json');
    mkdirSync(join(root, 'x'), { recursive: true });
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-aggregator-digest-audit-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CLEAN exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'audit file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'AGGREGATOR_AUDIT_CLEAN', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('AGGMARKER') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
