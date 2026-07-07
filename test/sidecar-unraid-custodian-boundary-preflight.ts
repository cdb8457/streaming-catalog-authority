import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSidecarUnraidCustodianBoundaryPreflightReport,
  formatSidecarUnraidCustodianBoundaryJson,
  parseSidecarUnraidCustodianBoundaryJson,
  sampleSidecarUnraidCustodianBoundaryDescriptor,
  type SidecarUnraidCustodianBoundaryReport,
} from '../src/ops/sidecar-unraid-custodian-boundary-preflight.js';

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

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...sampleSidecarUnraidCustodianBoundaryDescriptor(), ...overrides };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/sidecar-unraid-custodian-boundary-preflight-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 113 sidecar Unraid custodian boundary preflight suite:\n');

test('complete redacted descriptor is ready for independent review but closes no gates', () => {
  const report = buildSidecarUnraidCustodianBoundaryPreflightReport(descriptor());
  assert(report.report === 'phase-113-sidecar-unraid-custodian-boundary-preflight', 'report id');
  assert(report.reviewReadiness === 'ready-for-independent-review', 'ready');
  assert(report.descriptorValuesEchoed === false, 'no descriptor values echoed');
  assert(report.commandExecution === false, 'no execution');
  assert(report.serviceInstalled === false && report.serviceStarted === false, 'no service install/start');
  assert(report.providerContactAllowed === false, 'no provider contact');
  assert(report.productionReady === false, 'not production ready');
  assert(report.closesO4 === false && report.closesO5 === false, 'no gate closure');
  assert(report.o4Status === 'open/deferred' && report.o5Status === 'open/deferred', 'gates open');
  assert(report.findings.some((finding) => finding.code === 'O4_STILL_REQUIRES_INDEPENDENT_REVIEW'), 'O4 warning present');
});

test('unsafe or missing boundary fields block review readiness', () => {
  const report = buildSidecarUnraidCustodianBoundaryPreflightReport(descriptor({
    appCannotReadRawDek: false,
    fileCustodianIsProductionKms: true,
    tcpListenerAllowed: true,
    rawEvidenceIncluded: true,
  }));
  assert(report.reviewReadiness === 'not-ready-for-independent-review', 'blocked');
  assert(report.summary.fail >= 4, 'failures counted');
  const codes = new Set(report.findings.map((finding) => finding.code));
  assert(codes.has('APP_CANNOT_READ_RAW_DEK_REQUIRED'), 'app raw DEK fail');
  assert(codes.has('FILE_CUSTODIAN_NOT_PRODUCTION_KMS_REQUIRED'), 'FileCustodian production claim fail');
  assert(codes.has('NO_TCP_LISTENER_REQUIRED'), 'TCP fail');
  assert(codes.has('NO_RAW_EVIDENCE_REQUIRED'), 'raw evidence fail');
});

test('parser and CLI read one explicit descriptor file without path or value leaks', () => {
  assert(parseSidecarUnraidCustodianBoundaryJson('{bad') === 'BOUNDARY_JSON_MALFORMED', 'malformed');
  assert(parseSidecarUnraidCustodianBoundaryJson('[]') === 'BOUNDARY_OBJECT_REQUIRED', 'array');
  assert(parseSidecarUnraidCustodianBoundaryJson('\ufeff{"ok":true}') instanceof Object, 'BOM accepted');
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-boundary-'));
  try {
    const input = join(dir, 'boundary.json');
    writeFileSync(input, JSON.stringify(descriptor({
      notes: 'SECRET_VALUE_SENTINEL PRIVATE_TITLE_SENTINEL postgres://user:pass@example.invalid/db',
    })), 'utf8');
    const result = runCli([input, '--json']);
    const stdout = String(result.stdout);
    assert(result.status === 0, 'CLI exits zero');
    const parsed = JSON.parse(stdout) as SidecarUnraidCustodianBoundaryReport;
    assert(parsed.reviewReadiness === 'ready-for-independent-review', 'stdout ready');
    for (const forbidden of [input, dir, 'SECRET_VALUE_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'postgres://user:pass@example.invalid/db']) {
      assert(!stdout.includes(forbidden), `stdout omits ${forbidden}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects missing, directory, oversized, and multiple inputs without path leaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-boundary-'));
  try {
    const oversized = join(dir, 'oversized.json');
    writeFileSync(oversized, JSON.stringify({ padding: 'x'.repeat(70 * 1024) }), 'utf8');
    for (const args of [
      ['--json'],
      [join(dir, 'missing.json'), '--json'],
      [dir, '--json'],
      [oversized, '--json'],
      [oversized, oversized, '--json'],
    ]) {
      const result = runCli(args);
      assert(result.status !== 0, `non-zero for ${args.join(' ')}`);
      const combined = `${String(result.stdout)}\n${String(result.stderr)}`;
      assert(!combined.includes(dir), 'no directory path leak');
      assert(!combined.includes(oversized), 'no file path leak');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source and docs preserve preflight-only boundary', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['ops:sidecar-unraid-custodian-boundary-preflight'] === 'tsx src/ops/sidecar-unraid-custodian-boundary-preflight-cli.ts', 'ops script');
  assert(pkg.scripts['test:sidecar-unraid-custodian-boundary-preflight'] === 'tsx test/sidecar-unraid-custodian-boundary-preflight.ts', 'test script');
  assert(formatSidecarUnraidCustodianBoundaryJson(buildSidecarUnraidCustodianBoundaryPreflightReport(descriptor())).includes('phase-113-sidecar-unraid-custodian-boundary-preflight'), 'json report');

  const source = `${read('src/ops/sidecar-unraid-custodian-boundary-preflight.ts')}\n${read('src/ops/sidecar-unraid-custodian-boundary-preflight-cli.ts')}`;
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    'execSync',
    'spawnSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);

  const docs = `${read('docs/PHASE_113_SIDECAR_UNRAID_CUSTODIAN_BOUNDARY_PREFLIGHT.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const required of [
    'Phase 113',
    'phase-113-sidecar-unraid-custodian-boundary-preflight',
    'single-redacted-sidecar-custodian-boundary-json-file',
    'managed-custodian-sidecar-boundary-attestation-redacted',
    'descriptorValuesEchoed: false',
    'commandExecution: false',
    'productionReady: false',
    'closesO4: false',
    'closesO5: false',
    'O4/O5 remain open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(docs.includes(required), `docs include ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
