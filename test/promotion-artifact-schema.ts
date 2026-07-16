import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateArtifactSchema, validateArtifactSchemas, type ArtifactBundle } from '../src/ops/promotion-artifact-schema.js';
import { verifyArtifactIntegrity } from '../src/ops/promotion-artifact-integrity.js';
import { runPromotionRehearsal } from '../src/ops/promotion-rehearsal.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-schema-')); }
const now = (() => { let i = 0; return () => new Date(Date.UTC(2026, 6, 16, 9, 0, i++)); })();

interface RawBundle {
  approvalEvidence: Record<string, unknown>;
  promotionEvidence: Record<string, unknown>;
  evidenceReview: Record<string, unknown>;
  readiness: Record<string, unknown>;
  acceptancePacket: Record<string, unknown>;
}

async function bundleFromRehearsal(root: string): Promise<{ bundle: ArtifactBundle; raw: RawBundle }> {
  const { artifacts } = await runPromotionRehearsal({ workDir: root, runId: 'schema', now });
  const clone = (v: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
  const raw: RawBundle = {
    approvalEvidence: clone(artifacts.approvalEvidence),
    promotionEvidence: clone(artifacts.promotionEvidence),
    evidenceReview: clone(artifacts.evidenceReview),
    readiness: clone(artifacts.readiness),
    acceptancePacket: clone(artifacts.acceptancePacket),
  };
  return { bundle: raw, raw };
}

function reseal(obj: Record<string, unknown>, field: string, scope: string): void {
  const without: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) if (k !== field) without[k] = obj[k];
  obj[field] = createHash('sha256').update(`${scope}:${JSON.stringify(without)}`).digest('hex');
}

console.log('Running Phase 230 artifact-schema suite:\n');

await test('accepts a clean, schema-valid bundle', async () => {
  const root = workspace();
  try {
    const { bundle } = await bundleFromRehearsal(root);
    const rep = validateArtifactSchemas(bundle);
    assert(rep.ok, `ok (problems: ${rep.problems.join(',')})`);
    assertEq(rep.checkedArtifacts.length, 5, 'all five checked');
    assert(/^[0-9a-f]{64}$/.test(rep.schemaDigest), 'schema digest present');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('rejects a malformed-but-self-digested artifact that the integrity verifier accepts', async () => {
  const root = workspace();
  try {
    const { bundle, raw } = await bundleFromRehearsal(root);
    // Corrupt the acceptance packet status to an invalid enum, then RE-SEAL its self-digest. The
    // sealDigest is terminal (no other artifact references it), so integrity still passes.
    raw.acceptancePacket.status = 'TOTALLY_BOGUS_STATUS';
    reseal(raw.acceptancePacket, 'sealDigest', 'phase-230-acceptance-seal');

    const integrity = verifyArtifactIntegrity(bundle);
    assert(integrity.ok, `integrity verifier still accepts it (problems: ${integrity.problems.join(',')})`);

    const schema = validateArtifactSchemas(bundle);
    assert(!schema.ok, 'schema validation rejects it');
    assert(schema.problems.includes('ACCEPTANCE_PACKET_STATUS_INVALID'), 'invalid status reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const FAILED_STATE_CASES: Array<{ kind: keyof RawBundle; field: string; value: string; boolField?: string; digestField: string; scope: string; code: string }> = [
  { kind: 'approvalEvidence', field: 'status', value: 'APPROVAL_ATTESTATION_INVALID', digestField: 'evidenceDigest', scope: 'phase-230-approval-evidence', code: 'APPROVAL_EVIDENCE_STATUS_INVALID' },
  { kind: 'promotionEvidence', field: 'status', value: 'REAL_LIBRARY_PROMOTION_FAILED', boolField: 'ok', digestField: 'evidenceDigest', scope: 'phase-230-report', code: 'PROMOTION_EVIDENCE_STATUS_INVALID' },
  { kind: 'evidenceReview', field: 'status', value: 'PROMOTION_EVIDENCE_REJECTED', boolField: 'ok', digestField: 'reviewDigest', scope: 'phase-230-evidence-review', code: 'EVIDENCE_REVIEW_STATUS_INVALID' },
  { kind: 'readiness', field: 'verdict', value: 'BLOCKED', digestField: 'checklistDigest', scope: 'phase-230-readiness-checklist', code: 'READINESS_STATUS_INVALID' },
  { kind: 'acceptancePacket', field: 'status', value: 'ACCEPTANCE_REFUSED', boolField: 'accepted', digestField: 'sealDigest', scope: 'phase-230-acceptance-seal', code: 'ACCEPTANCE_PACKET_STATUS_INVALID' },
];

for (const c of FAILED_STATE_CASES) {
  await test(`rejects a re-self-digested ${c.kind} in a failed/refused state`, async () => {
    const root = workspace();
    try {
      const { bundle, raw } = await bundleFromRehearsal(root);
      const artifact = raw[c.kind];
      artifact[c.field] = c.value;
      if (c.boolField) artifact[c.boolField] = false; // realistic failed-state boolean
      reseal(artifact, c.digestField, c.scope); // valid self-digest over the failed-state body
      const rep = validateArtifactSchemas(bundle);
      assert(!rep.ok, 'strict schema rejects the failed/refused state');
      assert(rep.problems.includes(c.code), `${c.code} reported`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

await test('a re-self-digested REFUSED acceptance passes integrity but fails strict schema', async () => {
  const root = workspace();
  try {
    const { bundle, raw } = await bundleFromRehearsal(root);
    raw.acceptancePacket.status = 'ACCEPTANCE_REFUSED';
    raw.acceptancePacket.accepted = false;
    reseal(raw.acceptancePacket, 'sealDigest', 'phase-230-acceptance-seal');
    const integrity = verifyArtifactIntegrity(bundle);
    assert(integrity.ok, `integrity still accepts the resealed terminal packet (problems: ${integrity.problems.join(',')})`);
    const schema = validateArtifactSchemas(bundle);
    assert(!schema.ok, 'strict schema rejects the refused acceptance');
    assert(schema.problems.includes('ACCEPTANCE_PACKET_STATUS_INVALID') && schema.problems.includes('ACCEPTANCE_PACKET_NOT_SUCCESSFUL'), 'status + not-successful reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('rejects a wrong report type', async () => {
  const root = workspace();
  try {
    const { bundle, raw } = await bundleFromRehearsal(root);
    raw.readiness.report = 'something-else';
    const rep = validateArtifactSchemas(bundle);
    assert(!rep.ok, 'rejected');
    assert(rep.problems.includes('READINESS_REPORT_INVALID'), 'report-invalid reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('rejects a bad version', async () => {
  const root = workspace();
  try {
    const { bundle, raw } = await bundleFromRehearsal(root);
    raw.promotionEvidence.version = 2;
    const rep = validateArtifactSchemas(bundle);
    assert(!rep.ok, 'rejected');
    assert(rep.problems.includes('PROMOTION_EVIDENCE_VERSION_INVALID'), 'version-invalid reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('rejects a not-flagged-redaction-safe artifact', async () => {
  const root = workspace();
  try {
    const { bundle, raw } = await bundleFromRehearsal(root);
    raw.evidenceReview.redactionSafe = false;
    const rep = validateArtifactSchemas(bundle);
    assert(!rep.ok, 'rejected');
    assert(rep.problems.includes('EVIDENCE_REVIEW_NOT_REDACTION_SAFE'), 'not-redaction-safe reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('rejects a missing required field and a missing artifact', async () => {
  const root = workspace();
  try {
    const { raw } = await bundleFromRehearsal(root);
    delete raw.approvalEvidence.itemDigest;
    const rep = validateArtifactSchemas({ approvalEvidence: raw.approvalEvidence, promotionEvidence: raw.promotionEvidence, evidenceReview: raw.evidenceReview, readiness: raw.readiness });
    assert(!rep.ok, 'rejected');
    assert(rep.problems.includes('APPROVAL_EVIDENCE_MISSING_FIELD'), 'missing-field reported');
    assert(rep.problems.includes('ACCEPTANCE_PACKET_MISSING'), 'missing-artifact reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test('single-artifact validation and empty input do not throw', () => {
  assertEq(validateArtifactSchema('readiness', { report: 'phase-230-promotion-readiness-checklist', version: 1, redactionSafe: true, verdict: 'READY', items: [], blockers: [], targetRoot: 'sandbox', checklistDigest: 'a'.repeat(64) }).length, 0, 'valid single artifact passes');
  assert(validateArtifactSchema('readiness', 42).length > 0, 'garbage single artifact is rejected');
  const rep = validateArtifactSchemas({});
  assert(!rep.ok && !JSON.stringify(rep).includes('/mnt/'), 'empty input rejected and redaction-safe');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
