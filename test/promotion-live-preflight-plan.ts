import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLivePreflightPlan, LIVE_PREFLIGHT_DISCLAIMERS } from '../src/ops/promotion-live-preflight-plan.js';
import { verifySelfDigests } from '../src/ops/promotion-self-digest-verifier.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const A = 'a'.repeat(64); const B = 'b'.repeat(64);
function validPlan() {
  return {
    noClobber: true, sameChecksum: true, observedStateRequired: true,
    rollback: { strategy: 'restore-prior', windowMinutes: 60 }, withdrawal: { allowed: true, byRunId: true },
    items: [{ itemId: 'item-1', approvalId: 'appr-1', approvalStatus: 'PENDING', sourceDigest: A, destinationDigest: B }],
  };
}

console.log('Running Phase 230 live preflight plan suite:\n');

await test('PREFLIGHT_PLAN_VALID for a well-formed pending plan; authorizes nothing (PENDING/NONE)', () => {
  const r = buildLivePreflightPlan({ plan: validPlan() });
  assertEq(r.overall, 'PREFLIGHT_PLAN_VALID', `valid (blockers: ${r.blockers.join(',')})`);
  assertEq(r.authorization, 'NONE', 'authorization NONE');
  assertEq(r.status, 'PENDING', 'status PENDING');
  assertEq(r.itemCount, 1, 'one item');
  assert(r.items.every((i) => i.approvalPending && i.sourceBound && i.destinationBound), 'item pending + digest-bound');
  assert(r.policyChecks.every((p) => p.ok), 'all policies present');
  assertEq(r.disclaimers.length, LIVE_PREFLIGHT_DISCLAIMERS.length, 'disclaimers present');
  assertEq(verifySelfDigests([r]).overall, 'ALL_VERIFIED', 'report self-verifies');
  assert(!JSON.stringify(r).includes('/mnt/'), 'redaction-safe');
});

await test('INVALID when an item is pre-approved (not PENDING) or missing source/destination digests', () => {
  const preApproved = { ...validPlan(), items: [{ itemId: 'x', approvalId: 'a', approvalStatus: 'APPROVED', sourceDigest: A, destinationDigest: B }] };
  assert(buildLivePreflightPlan({ plan: preApproved }).blockers.includes('ITEM_NOT_PENDING'), 'ITEM_NOT_PENDING');
  const noSrc = { ...validPlan(), items: [{ itemId: 'x', approvalId: 'a', approvalStatus: 'PENDING', destinationDigest: B }] };
  assert(buildLivePreflightPlan({ plan: noSrc }).blockers.includes('SOURCE_DIGEST_MISSING'), 'SOURCE_DIGEST_MISSING');
  const noDest = { ...validPlan(), items: [{ itemId: 'x', approvalId: 'a', approvalStatus: 'PENDING', sourceDigest: A }] };
  assert(buildLivePreflightPlan({ plan: noDest }).blockers.includes('DESTINATION_DIGEST_MISSING'), 'DESTINATION_DIGEST_MISSING');
  const noApprovalField = { ...validPlan(), items: [{ itemId: 'x', sourceDigest: A, destinationDigest: B }] };
  assert(buildLivePreflightPlan({ plan: noApprovalField }).blockers.includes('ITEM_APPROVAL_FIELD_MISSING'), 'ITEM_APPROVAL_FIELD_MISSING');
});

await test('INVALID when a required plan policy is missing', () => {
  for (const [key, code] of [['noClobber', 'NO_CLOBBER_POLICY_MISSING'], ['sameChecksum', 'SAME_CHECKSUM_POLICY_MISSING'], ['observedStateRequired', 'OBSERVED_STATE_NOT_REQUIRED']] as const) {
    const p = validPlan() as Record<string, unknown>; delete p[key];
    assert(buildLivePreflightPlan({ plan: p }).blockers.includes(code), code);
  }
  const noRollback = validPlan() as Record<string, unknown>; delete noRollback.rollback;
  assert(buildLivePreflightPlan({ plan: noRollback }).blockers.includes('ROLLBACK_CONSTRAINT_MISSING'), 'ROLLBACK_CONSTRAINT_MISSING');
  const noWithdrawal = validPlan() as Record<string, unknown>; delete noWithdrawal.withdrawal;
  assert(buildLivePreflightPlan({ plan: noWithdrawal }).blockers.includes('WITHDRAWAL_CONSTRAINT_MISSING'), 'WITHDRAWAL_CONSTRAINT_MISSING');
});

await test('INVALID (fail closed) on any raw path / Jellyfin / network / media surface in the plan', () => {
  for (const poison of ['/mnt/user/media/Movies/x.mkv', 'http://192.168.1.10/library/Refresh', 'jellyfin://server', 'C:\\media\\x.mp4']) {
    const p = validPlan() as Record<string, unknown>; (p.items as Array<Record<string, unknown>>)[0]!.note = poison;
    const r = buildLivePreflightPlan({ plan: p });
    assert(r.blockers.includes('LIVE_SURFACE_IN_PLAN'), `LIVE_SURFACE_IN_PLAN for ${poison.slice(0, 8)}`);
    assert(!JSON.stringify(r).includes('/mnt/') && !JSON.stringify(r).includes('jellyfin') && !JSON.stringify(r).includes('.mkv'), 'poison never echoed');
  }
});

test('INVALID and redaction-safe on missing plan / no items', () => {
  assert(buildLivePreflightPlan({}).blockers.includes('PLAN_MISSING'), 'PLAN_MISSING');
  const r = buildLivePreflightPlan({ plan: { noClobber: true, sameChecksum: true, observedStateRequired: true, rollback: { a: 1 }, withdrawal: { a: 1 }, items: [] } });
  assert(r.blockers.includes('NO_ITEMS'), 'NO_ITEMS');
  assertEq(r.authorization, 'NONE', 'authorization NONE');
});

await test('CLI validates the plan and never echoes raw paths to stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-preflight-'));
  try {
    const planPath = join(root, 'plan.json'); writeFileSync(planPath, JSON.stringify(validPlan()));
    const outPath = join(root, 'catalog-authority-test-library', 'PPMARKER-out', 'plan.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-live-preflight-plan-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--plan', planPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `VALID exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'plan report written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'PREFLIGHT_PLAN_VALID', 'stdout overall');
    assertEq(parsed.status, 'PENDING', 'stdout status PENDING');
    assert(!(res.stdout ?? '').includes('PPMARKER') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
