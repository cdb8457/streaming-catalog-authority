import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_CUSTODIAN_CONTRACT,
  validateProductionCustodianDescriptor,
  type ProductionCustodianDescriptor,
  type ProductionCustodianValidationReport,
} from '../src/core/crypto/production-custodian-contract.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push([name, err]);
    console.log(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertIncludes(haystack: string, needle: string, msg: string): void {
  assert(haystack.includes(needle), msg);
}

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
}

function completeDescriptor(overrides: Partial<ProductionCustodianDescriptor> = {}): ProductionCustodianDescriptor {
  return {
    adapterName: 'ManagedCustodianAdapter',
    adapterVersion: 'phase-28-static-contract',
    custodyBoundary: 'external-managed',
    implementsKeyCustodian: true,
    attestationFormatDocumented: true,
    durableTombstones: true,
    appCannotForgeAttestation: true,
    failClosedSemanticsDocumented: true,
    liveValidationEvidenceLabel: 'operator-live-validation-redacted',
    contractKitCommandLabel: 'contract-kit-redacted',
    redactionReviewStatus: 'passed',
    noRawSecretsInEvidence: true,
    backupRestoreFailClosedEvidence: true,
    ...overrides,
  };
}

function reportText(report: ProductionCustodianValidationReport): string {
  return JSON.stringify(report, null, 2);
}

function codes(report: ProductionCustodianValidationReport): Set<string> {
  return new Set(report.findings.map((finding) => finding.code));
}

console.log('Running Phase 28 production custodian contract suite:\n');

test('contract includes required KeyCustodian invariants from Phase 16/21', () => {
  const invariants = PRODUCTION_CUSTODIAN_CONTRACT.requiredKeyCustodianInvariants.join('\n');
  for (const phrase of [
    'provision is idempotent',
    'commitProvision is idempotent',
    'destroy is idempotent',
    'destroyed is terminal',
    'status returns only provisional, active, destroyed, or not_found',
    'get fails closed',
    'listStaleProvisioning',
    'durable non-secret tombstones',
    'app cannot forge',
    'lost acknowledgements',
  ]) assertIncludes(invariants, phrase, `contract covers ${phrase}`);

  const phase16 = read('docs/PHASE_16_EXTERNAL_CUSTODIAN_READINESS.md');
  const phase21 = read('docs/PHASE_21_EXTERNAL_CUSTODIAN_ACCEPTANCE.md');
  assert(phase16.includes('Required `KeyCustodian` Invariants'), 'Phase 16 invariant section still present');
  assert(phase21.includes('Operator-Run Live Validation'), 'Phase 21 live validation section still present');
});

test('validator fails and warns when FileCustodian/reference harness is claimed as production KMS', () => {
  const report = validateProductionCustodianDescriptor(completeDescriptor({
    adapterName: 'FileCustodian production KMS',
    custodyBoundary: 'in-app-reference',
  }));
  const got = codes(report);
  assert(got.has('REFERENCE_HARNESS_NOT_PRODUCTION_KMS'), 'fails FileCustodian-as-production claim');
  assert(got.has('REFERENCE_HARNESS_DESCRIPTOR_REVIEW_REQUIRED'), 'warns for reference harness review');
  assert(got.has('EXTERNAL_BOUNDARY_REQUIRED'), 'fails in-app reference boundary');
  assert(report.fileCustodianStatus === 'reference-harness-not-production-kms', 'report preserves FileCustodian boundary');
});

test('validator never closes O4 without external boundary, live validation, redaction, and attestation evidence', () => {
  const incomplete = validateProductionCustodianDescriptor({
    adapterName: 'Some Adapter',
    custodyBoundary: 'unknown',
    implementsKeyCustodian: true,
    durableTombstones: true,
  });
  const got = codes(incomplete);
  for (const code of [
    'EXTERNAL_BOUNDARY_REQUIRED',
    'ATTESTATION_FORMAT_DOCUMENTED_REQUIRED',
    'APP_CANNOT_FORGE_ATTESTATION_REQUIRED',
    'LIVE_VALIDATION_LABEL_REQUIRED',
    'REDACTION_REVIEW_REQUIRED',
  ]) assert(got.has(code), `missing evidence yields ${code}`);
  assert(incomplete.o4Status === 'open/deferred' && incomplete.closesO4 === false, 'incomplete descriptor cannot close O4');

  const complete = validateProductionCustodianDescriptor(completeDescriptor());
  assert(complete.o4Status === 'open/deferred' && complete.closesO4 === false, 'complete metadata still cannot close O4');
  assert(codes(complete).has('O4_STILL_REQUIRES_REVIEW'), 'complete metadata still requires reviewer/operator acceptance');
});

test('validator output is redaction-safe for hostile descriptor strings', () => {
  const sentinels = [
    'postgres://user:pass@example.invalid/db',
    'https://kms.example.invalid/key?token=SECRET_TOKEN',
    'TOKEN=abc123',
    'CUSTODIAN_KEK=base64secret',
    '/run/secrets/completion-secret',
    'movie title private identity',
    'jellyfin-token-123',
  ];
  const report = validateProductionCustodianDescriptor(completeDescriptor({
    adapterName: `Hostile ${sentinels.join(' ')}`,
    adapterVersion: sentinels.join('|'),
    liveValidationEvidenceLabel: sentinels[0],
    contractKitCommandLabel: sentinels[1],
  }));
  const text = reportText(report);
  for (const sentinel of sentinels) assert(!text.includes(sentinel), `output does not echo ${sentinel}`);
  assert(text.includes('"redactionSafe": true'), 'report declares redaction-safe output');
});

test('source has no network/DB/fs/Docker/cloud/vendor/live-service imports and no env reads', () => {
  const source = read('src/core/crypto/production-custodian-contract.ts');
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    "from 'pg'",
    'from "pg"',
    'docker compose',
    'process.env',
    'globalThis.fetch',
    'fetch(',
    'aws-sdk',
    '@aws-sdk',
    '@google-cloud',
    '@azure',
    'node-vault',
    'openbao',
    'loadDbConfig',
    'loadCustodianConfig',
    'createCustodian',
  ]) assert(!source.includes(forbidden), `contract source does not include ${forbidden}`);
  assert(!/^import\s/m.test(source), 'contract source has no imports');
});

test('O4/O5 remain open/deferred in docs and validator output', () => {
  const report = validateProductionCustodianDescriptor(completeDescriptor());
  const output = reportText(report);
  assert(output.includes('"o4Status": "open/deferred"'), 'validator output keeps O4 open/deferred');
  assert(output.includes('"o5Status": "open/deferred"'), 'validator output keeps O5 open/deferred');
  assert(output.includes('"closesO4": false'), 'validator output refuses O4 closure');

  for (const rel of [
    'docs/PHASE_28_PRODUCTION_CUSTODIAN_CONTRACT.md',
    'README.md',
    'docs/PHASE_16_EXTERNAL_CUSTODIAN_READINESS.md',
    'docs/PHASE_21_EXTERNAL_CUSTODIAN_ACCEPTANCE.md',
    'docs/PHASE_22_PRODUCTION_READINESS_GATE.md',
    'docs/RELEASE_CHECKLIST.md',
  ]) {
    const doc = read(rel);
    assert(/O4[\s\S]{0,160}open\/deferred|O4[\s\S]{0,160}remains open|does not close O4/i.test(doc), `${rel} keeps O4 open/deferred`);
    assert(/O5[\s\S]{0,160}open\/deferred|O5[\s\S]{0,160}remains open|managed KEK custody/i.test(doc), `${rel} keeps O5 visible`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
