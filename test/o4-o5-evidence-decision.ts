import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildO4O5EvidenceDecisionPacket,
  formatO4O5EvidenceDecisionJson,
  formatO4O5EvidenceDecisionText,
  parseO4O5ImplementationDecisionJson,
  type O4O5EvidenceDecisionReport,
} from '../src/ops/o4-o5-evidence-decision.js';
import type { ProductionCustodianDescriptor } from '../src/core/crypto/production-custodian-contract.js';
import type { KekEvidenceDescriptor } from '../src/ops/kek-evidence-preflight.js';

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

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
}

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decisionLabel: 'phase-96-contract-harness-expansion-redacted',
    decisionStatus: 'authorize-one-slice',
    o4CustodianDirection: 'defer',
    o5CustodyDirection: 'defer',
    unraidDeploymentMode: 'catalog-one-shot-ops-bind-mounted',
    liveServiceContactAllowed: false,
    implementationScopeLabel: 'contract-harness-expansion-without-live-service-contact',
    requiredEvidenceLabels: [
      'phase-95-review-handoff',
      'production-custodian-contract-existing',
      'custodian-acceptance-harness-existing',
      'custodian-preflight-report-redacted',
      'kek-preflight-report-redacted',
      'kek-rewrap-plan-redacted',
      'redaction-review-required',
    ],
    reviewerLabel: 'reviewer-required-before-o4-o5-closure',
    residualRiskLabel: 'o4-o5-residual-risk-pending',
    closesO4: false,
    closesO5: false,
    ...overrides,
  };
}

function custodianDescriptor(overrides: Partial<ProductionCustodianDescriptor> = {}): ProductionCustodianDescriptor {
  return {
    adapterName: 'ManagedCustodianAdapter',
    adapterVersion: 'phase-96-static-preflight',
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

function kekDescriptor(overrides: Partial<KekEvidenceDescriptor> = {}): KekEvidenceDescriptor {
  return {
    rewrapPlanEvidenceLabel: 'kek-rewrap-plan-redacted',
    rotationRecordLabel: 'rotation-record-redacted',
    managedKekCustodyDocumented: true,
    rotationScheduleDocumented: true,
    operatorRunbookDocumented: true,
    alertTriageDocumented: true,
    independentSecretMediaDocumented: true,
    noRawSecretsInEvidence: true,
    residualRiskAccepted: true,
    redactionReviewStatus: 'passed',
    ...overrides,
  };
}

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return path;
}

function codes(report: O4O5EvidenceDecisionReport): Set<string> {
  return new Set(report.findings.map((finding) => finding.code));
}

function assertNoLeak(output: string, sentinels: readonly string[]): void {
  for (const sentinel of sentinels) assert(!output.includes(sentinel), `output leaked sentinel: ${sentinel}`);
}

console.log('Running Phase 96 O4/O5 evidence decision packet suite:\n');

test('valid offline evidence decision authorizes one slice but closes no gates', () => {
  const report = buildO4O5EvidenceDecisionPacket(decision(), custodianDescriptor() as Record<string, unknown>, kekDescriptor() as Record<string, unknown>);
  assert(report.reviewReadiness === 'ready-for-review', 'packet is ready for review');
  assert(report.authorizedScope === 'contract-harness-expansion-without-live-service-contact', 'only the offline contract slice is authorized');
  assert(report.runtimeImplementationAuthorized === false, 'runtime implementation is not authorized');
  assert(report.liveServiceContactAllowed === false, 'live contact remains forbidden');
  assert(report.o4Status === 'open/deferred' && report.o5Status === 'open/deferred', 'O4/O5 remain open');
  assert(report.closesO4 === false && report.closesO5 === false, 'packet closes no gates');
  assert(report.custodianPreflight.closesO4 === false && report.kekPreflight.closesO5 === false, 'nested preflights close no gates');
  assert(codes(report).has('O4_REMAINS_OPEN'), 'O4 remaining open is explicit');
  assert(codes(report).has('O5_REMAINS_OPEN'), 'O5 remaining open is explicit');
});

test('decision refuses live contact, runtime scope, and gate closure', () => {
  const report = buildO4O5EvidenceDecisionPacket(decision({
    liveServiceContactAllowed: true,
    implementationScopeLabel: 'managed-kms-runtime-adapter',
    closesO4: true,
    closesO5: true,
  }), custodianDescriptor() as Record<string, unknown>, kekDescriptor() as Record<string, unknown>);
  const got = codes(report);
  assert(got.has('LIVE_SERVICE_CONTACT_MUST_BE_FALSE'), 'live contact is refused');
  assert(got.has('IMPLEMENTATION_SCOPE_NOT_AUTHORIZED'), 'runtime implementation is refused');
  assert(got.has('CLOSES_O4_MUST_BE_FALSE'), 'O4 closure is refused');
  assert(got.has('CLOSES_O5_MUST_BE_FALSE'), 'O5 closure is refused');
  assert(report.authorizedScope === 'not-authorized', 'invalid decision authorizes nothing');
});

test('hostile decision and descriptor values are never echoed in JSON or text', () => {
  const sentinels = [
    'postgres://user:pass@example.invalid/db',
    'https://kms.example.invalid/key?token=SECRET_TOKEN',
    'CUSTODIAN_KEK=base64secret',
    'AGE-SECRET-KEY-1SECRETSECRETSECRETSECRETSECRETSECRET',
    'Private Movie Title 1999',
    'tmdb:603-provider-ref',
    '/run/secrets/completion-secret',
  ];
  const report = buildO4O5EvidenceDecisionPacket(
    decision({ decisionLabel: sentinels.join(' '), reviewerLabel: sentinels[0], residualRiskLabel: sentinels[1] }),
    custodianDescriptor({ adapterName: sentinels.join('|') }) as Record<string, unknown>,
    kekDescriptor({ rewrapPlanEvidenceLabel: sentinels.join('|') }) as Record<string, unknown>,
  );
  const output = `${formatO4O5EvidenceDecisionJson(report)}\n${formatO4O5EvidenceDecisionText(report)}`;
  assertNoLeak(output, sentinels);
});

test('malformed and primitive decision inputs fail closed', () => {
  const malformed = parseO4O5ImplementationDecisionJson('{"decisionLabel":"secret"');
  const primitive = parseO4O5ImplementationDecisionJson('"secret"');
  assert(malformed === 'DECISION_JSON_MALFORMED', 'malformed JSON rejected');
  assert(primitive === 'DECISION_OBJECT_REQUIRED', 'primitive JSON rejected');
});

test('CLI reads three bounded JSON files and emits parseable redaction-safe JSON', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-96-'));
  try {
    const decisionPath = writeJson(tmp, 'decision.json', decision());
    const custodianPath = writeJson(tmp, 'custodian.json', custodianDescriptor());
    const kekPath = writeJson(tmp, 'kek.json', kekDescriptor());
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, [
      'run',
      '--silent',
      'ops:o4-o5-evidence-decision',
      '--',
      '--',
      '--decision',
      decisionPath,
      '--custodian',
      custodianPath,
      '--kek',
      kekPath,
      '--json',
    ], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      shell: true,
    });
    assert(result.status === 0, `CLI exits 0: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout) as O4O5EvidenceDecisionReport;
    assert(parsed.report === 'phase-96-o4-o5-evidence-decision-packet', 'stdout is Phase 96 JSON report');
    assert(parsed.closesO4 === false && parsed.closesO5 === false, 'CLI JSON closes no gates');
    assertNoLeak(`${result.stdout}\n${result.stderr}`, [decisionPath, custodianPath, kekPath, tmp]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('source/docs preserve offline no-provider no-UI no-service boundary', () => {
  const source = `${read('src/ops/o4-o5-evidence-decision.ts')}\n${read('src/ops/o4-o5-evidence-decision-cli.ts')}`;
  const combined = `${source}\n${read('docs/PHASE_96_O4_O5_EVIDENCE_DECISION_PACKET.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const forbidden of [
    '@aws-sdk/',
    '@azure/',
    '@google-cloud/',
    'express',
    'fastify',
    'koa',
    'node:https',
    'node:http',
    'node:net',
    'node:tls',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'process.env',
    'docker compose',
    '@torbox/torbox-api',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'setInterval(',
    'cron.schedule',
  ]) assert(!source.includes(forbidden), `Phase 96 source excludes ${forbidden}`);
  for (const required of [
    'phase-96-o4-o5-evidence-decision-packet',
    'contract-harness-expansion-without-live-service-contact',
    'runtimeImplementationAuthorized: false',
    'liveServiceContactAllowed: false',
    'closesO4: false',
    'closesO5: false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'No live service contact',
    'No provider, media-server, playback, download, scraping, or UI expansion',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 96 surface preserves ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}

