import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAcceptanceDashboard } from '../src/ops/promotion-dashboard.js';
import { runPromotionRehearsal } from '../src/ops/promotion-rehearsal.js';
import { runRehearsalMatrix } from '../src/ops/promotion-rehearsal-matrix.js';
import { verifyArtifactIntegrity } from '../src/ops/promotion-artifact-integrity.js';
import { validateArtifactSchemas } from '../src/ops/promotion-artifact-schema.js';
import { buildCoordinatorHandoff } from '../src/ops/promotion-handoff.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-dashboard-')); }
const now = (() => { let i = 0; return () => new Date(Date.UTC(2026, 6, 16, 10, 0, i++)); })();

async function greenInputs(root: string) {
  const { artifacts } = await runPromotionRehearsal({ workDir: root, runId: 'dash', now });
  const bundle = {
    approvalEvidence: artifacts.approvalEvidence, promotionEvidence: artifacts.promotionEvidence,
    evidenceReview: artifacts.evidenceReview, readiness: artifacts.readiness, acceptancePacket: artifacts.acceptancePacket,
  };
  const integrity = verifyArtifactIntegrity(bundle);
  const schema = validateArtifactSchemas(bundle);
  const matrix = await runRehearsalMatrix({ workDir: join(root, 'matrix'), runId: 'dash-m', now });
  const handoff = buildCoordinatorHandoff({ acceptancePacket: artifacts.acceptancePacket, rehearsalManifest: matrix, integrityReport: integrity });
  return { matrix, integrity, schema, handoff };
}

console.log('Running Phase 230 acceptance dashboard suite:\n');

await test('DASHBOARD_READY only when matrix + integrity + schema + handoff are all green', async () => {
  const root = workspace();
  try {
    const { matrix, integrity, schema, handoff } = await greenInputs(root);
    const dash = buildAcceptanceDashboard({ matrix, integrity, schema, handoff });
    assertEq(dash.overall, 'DASHBOARD_READY', `ready (blockers: ${dash.blockers.join(',')})`);
    assertEq(dash.authorization, 'NONE', 'authorizes nothing');
    assertEq(dash.blockers.length, 0, 'no blockers');
    assertEq(dash.panels.length, 4, 'four panels');
    assert(dash.panels.some((p) => p.source === 'schema' && p.ok), 'schema panel present and green');
    assert(dash.panels.every((p) => p.present && p.ok), 'all panels green');
    assert(/^[0-9a-f]{64}$/.test(dash.dashboardDigest), 'dashboard digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the matrix is missing', async () => {
  const root = workspace();
  try {
    const { integrity, schema, handoff } = await greenInputs(root);
    const dash = buildAcceptanceDashboard({ integrity, schema, handoff });
    assertEq(dash.overall, 'DASHBOARD_BLOCKED', 'blocked');
    assert(dash.blockers.includes('MATRIX_MISSING'), 'matrix-missing blocker');
    assert(!dash.panels.find((p) => p.source === 'matrix')!.present, 'matrix panel absent');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when integrity is not ok', async () => {
  const root = workspace();
  try {
    const { matrix, schema, handoff } = await greenInputs(root);
    const badIntegrity = { report: 'phase-230-promotion-artifact-integrity', ok: false, integrityDigest: 'a'.repeat(64) };
    const dash = buildAcceptanceDashboard({ matrix, integrity: badIntegrity, schema, handoff });
    assertEq(dash.overall, 'DASHBOARD_BLOCKED', 'blocked');
    assert(dash.blockers.includes('INTEGRITY_NOT_OK'), 'integrity blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the schema report is missing', async () => {
  const root = workspace();
  try {
    const { matrix, integrity, handoff } = await greenInputs(root);
    const dash = buildAcceptanceDashboard({ matrix, integrity, handoff });
    assertEq(dash.overall, 'DASHBOARD_BLOCKED', 'blocked without schema');
    assert(dash.blockers.includes('SCHEMA_MISSING'), 'schema-missing blocker');
    assert(!dash.panels.find((p) => p.source === 'schema')!.present, 'schema panel absent');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the schema report is not ok', async () => {
  const root = workspace();
  try {
    const { matrix, integrity, handoff } = await greenInputs(root);
    const badSchema = { report: 'phase-230-promotion-artifact-schema', ok: false, schemaDigest: 'c'.repeat(64) };
    const dash = buildAcceptanceDashboard({ matrix, integrity, schema: badSchema, handoff });
    assertEq(dash.overall, 'DASHBOARD_BLOCKED', 'blocked');
    assert(dash.blockers.includes('SCHEMA_NOT_OK'), 'schema-not-ok blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when the handoff is not ready', async () => {
  const root = workspace();
  try {
    const { matrix, integrity, schema } = await greenInputs(root);
    const notReadyHandoff = { report: 'phase-230-promotion-coordinator-handoff', handoffState: 'NOT_READY', authorization: 'NONE', handoffDigest: 'b'.repeat(64) };
    const dash = buildAcceptanceDashboard({ matrix, integrity, schema, handoff: notReadyHandoff });
    assertEq(dash.overall, 'DASHBOARD_BLOCKED', 'blocked');
    assert(dash.blockers.includes('HANDOFF_NOT_READY'), 'handoff blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('BLOCKED when a panel has the wrong report type', async () => {
  const root = workspace();
  try {
    const { integrity, schema, handoff } = await greenInputs(root);
    const dash = buildAcceptanceDashboard({ matrix: { report: 'not-a-matrix', outcome: 'MATRIX_PASS' }, integrity, schema, handoff });
    assertEq(dash.overall, 'DASHBOARD_BLOCKED', 'blocked');
    assert(dash.blockers.includes('MATRIX_INVALID'), 'matrix-invalid blocker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('the dashboard is redaction-safe and does not throw on empty input', () => {
  const dash = buildAcceptanceDashboard({});
  assertEq(dash.overall, 'DASHBOARD_BLOCKED', 'empty is blocked');
  assert(dash.blockers.includes('MATRIX_MISSING') && dash.blockers.includes('INTEGRITY_MISSING') && dash.blockers.includes('SCHEMA_MISSING') && dash.blockers.includes('HANDOFF_MISSING'), 'all missing');
  assert(dash.redactionSafe === true && !JSON.stringify(dash).includes('/mnt/'), 'redaction-safe');
});

await test('CLI renders the dashboard and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const { matrix, integrity, schema, handoff } = await greenInputs(root);
    const dir = join(root, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const matrixPath = join(dir, 'matrix.json');
    const integrityPath = join(dir, 'integrity.json');
    const schemaPath = join(dir, 'schema.json');
    const handoffPath = join(dir, 'handoff.json');
    writeFileSync(matrixPath, JSON.stringify(matrix));
    writeFileSync(integrityPath, JSON.stringify(integrity));
    writeFileSync(schemaPath, JSON.stringify(schema));
    writeFileSync(handoffPath, JSON.stringify(handoff));
    const outPath = join(root, 'catalog-authority-test-library', 'DASHMARKER-out', 'dashboard.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-dashboard-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--matrix', matrixPath, '--integrity', integrityPath, '--schema', schemaPath, '--handoff', handoffPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `READY exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'dashboard file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'DASHBOARD_READY', 'stdout overall');
    assertEq(parsed.authorization, 'NONE', 'stdout authorization NONE');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('DASHMARKER') && !(res.stdout ?? '').includes('catalog-authority-test-library') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
