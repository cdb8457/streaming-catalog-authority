import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSidecarEvidenceHarnessPacket,
  formatSidecarEvidenceHarnessPacketText,
  type SidecarEvidenceHarnessPacket,
  type SidecarEvidenceManifest,
} from '../src/ops/sidecar-evidence-harness-packet.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const documentedNpmJsonCommand = 'npm run --silent ops:sidecar-evidence-harness-packet -- -- --json';

function completeManifest(overrides: Partial<SidecarEvidenceManifest> = {}): SidecarEvidenceManifest {
  return {
    runtimeDesignLabel: 'phase-99-runtime-design-redacted',
    contractKitLabel: 'sidecar-contract-kit-redacted',
    failureInjectionLabel: 'sidecar-failure-injection-redacted',
    attestationLabel: 'sidecar-attestation-redacted',
    redactionReviewLabel: 'sidecar-redaction-review-redacted',
    backupRestoreLabel: 'sidecar-backup-restore-redacted',
    operatorAcceptanceLabel: 'operator-acceptance-redacted',
    reviewerAcceptanceLabel: 'reviewer-acceptance-redacted',
    sidecarProcessImplemented: true,
    unixSocketBoundaryImplemented: true,
    independentSidecarStateImplemented: true,
    appCannotForgeAttestation: true,
    noRawSecretsInEvidence: true,
    restoreWithoutSidecarFailsClosed: true,
    ...overrides,
  };
}

function codes(report: SidecarEvidenceHarnessPacket): Set<string> {
  return new Set(report.findings.map((finding) => finding.code));
}

console.log('Running Phase 100 sidecar evidence harness packet suite:\n');

test('empty manifest is not ready and still closes no gates', () => {
  const report = buildSidecarEvidenceHarnessPacket();
  assert(report.report === 'phase-100-sidecar-evidence-harness-packet', 'report id');
  assert(report.reviewReadiness === 'not-ready-for-review', 'empty manifest not ready');
  assert(report.summary.fail > 0, 'empty manifest has fail findings');
  assert(report.closesO4 === false && report.closesO5 === false, 'packet closes no gates');
  assert(report.o4Status === 'open/deferred' && report.o5Status === 'open/deferred', 'O4/O5 remain open');
});

test('complete manifest becomes ready for review but still never closes O4', () => {
  const report = buildSidecarEvidenceHarnessPacket(completeManifest());
  assert(report.summary.fail === 0, 'complete manifest has no fail findings');
  assert(report.reviewReadiness === 'ready-for-review', 'complete manifest ready for review');
  assert(codes(report).has('O4_STILL_REQUIRES_REVIEW'), 'separate O4 review still required');
  assert(codes(report).has('O5_REMAINS_DEFERRED'), 'O5 remains deferred');
  assert(report.closesO4 === false && report.closesO5 === false, 'complete manifest closes no gates');
});

test('hostile manifest values are never echoed in text or JSON', () => {
  const sentinels = [
    'postgres://user:pass@example.invalid/db',
    '/boot/config/secrets/completion-secret',
    'Private Movie Title 1999',
    'tmdb:603-provider-ref',
    '-----BEGIN PRIVATE KEY-----',
  ];
  const report = buildSidecarEvidenceHarnessPacket(completeManifest({
    runtimeDesignLabel: sentinels.join('|'),
    contractKitLabel: sentinels[0],
  }));
  const json = JSON.stringify(report);
  const text = formatSidecarEvidenceHarnessPacketText(report);
  for (const sentinel of sentinels) {
    assert(!json.includes(sentinel), `json omits ${sentinel}`);
    assert(!text.includes(sentinel), `text omits ${sentinel}`);
  }
});

test('CLI and documented npm JSON command emit static packet only', () => {
  const sentinels = ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://user:pass@example.invalid/db'];
  const direct = execFileSync('node', ['--import', 'tsx', 'src/ops/sidecar-evidence-harness-packet-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: sentinels[0],
      PRIVATE_TITLE: sentinels[1],
      DATABASE_URL: sentinels[2],
    },
    encoding: 'utf8',
  });
  const directParsed = JSON.parse(direct) as SidecarEvidenceHarnessPacket;
  assert(directParsed.report === 'phase-100-sidecar-evidence-harness-packet', 'direct json report id');
  const documented = execSync(documentedNpmJsonCommand, { cwd: root, encoding: 'utf8' });
  const documentedParsed = JSON.parse(documented) as SidecarEvidenceHarnessPacket;
  assert(documentedParsed.report === 'phase-100-sidecar-evidence-harness-packet', 'documented json report id');
  for (const sentinel of sentinels) {
    assert(!direct.includes(sentinel), `direct json omits ${sentinel}`);
    assert(!documented.includes(sentinel), `documented json omits ${sentinel}`);
  }
});

test('source/docs preserve evidence-only no-runtime boundary', () => {
  const source = `${read('src/ops/sidecar-evidence-harness-packet.ts')}\n${read('src/ops/sidecar-evidence-harness-packet-cli.ts')}`;
  const combined = `${source}\n${read('docs/PHASE_100_SIDECAR_EVIDENCE_HARNESS_PACKET.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    'docker compose',
    'express',
    'fastify',
    'koa',
    'listen(',
    'createServer',
    'setInterval',
    'setTimeout',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 100 source excludes ${forbidden}`);
  for (const required of [
    'phase-100-sidecar-evidence-harness-packet',
    'manifestValuesEchoed: false',
    'requiredLabels',
    'restoreWithoutSidecarFailsClosed',
    'no daemon',
    'no socket listener',
    'no HTTP API',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 100 surface preserves ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
