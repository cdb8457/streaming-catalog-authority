import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildTorBoxLiveSmokePacketManifestReport,
  buildTorBoxLiveSmokePacketManifestInputErrorReport,
  formatTorBoxLiveSmokePacketManifestJson,
  parseTorBoxLiveSmokePacketManifestJson,
  type TorBoxLiveSmokePacketManifestReport,
} from '../src/ops/torbox-live-smoke-packet-manifest.js';

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

function readyManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    report: 'phase-53-torbox-live-smoke-packet-manifest',
    redactionSafe: true,
    artifactContentsIncluded: false,
    credentialValuesIncluded: false,
    credentialPathsIncluded: false,
    rawRefsIncluded: false,
    providerPayloadsIncluded: false,
    liveTorBoxContact: false,
    commandExecution: false,
    closesLiveSmokeReview: false,
    o4Status: 'open/deferred',
    o5Status: 'open/deferred',
    fileCustodianStatus: 'reference-harness-not-production-kms',
    artifacts: [
      { kind: 'phase-43-service-status-report', label: 'redacted-service-status-report' },
      { kind: 'phase-43-hoster-metadata-report', label: 'redacted-hoster-metadata-report' },
      { kind: 'phase-44-service-status-preflight', label: 'redacted-service-status-preflight' },
      { kind: 'phase-44-hoster-metadata-preflight', label: 'redacted-hoster-metadata-preflight' },
      { kind: 'phase-49-summary-pack', label: 'redacted-summary-pack' },
      { kind: 'phase-51-review-gate', label: 'redacted-review-gate' },
    ],
    ...overrides,
  };
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/torbox-live-smoke-packet-manifest-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 53 TorBox live smoke packet manifest suite:\n');

test('ready manifest prepares redaction-safe review', () => {
  const report = buildTorBoxLiveSmokePacketManifestReport(readyManifest());
  assert(report.report === 'phase-53-torbox-live-smoke-packet-manifest-preflight', 'report name');
  assert(report.reviewReadiness === 'ready-for-review', 'ready for review');
  assert(report.manifestValuesEchoed === false, 'no manifest values echoed');
  assert(report.artifactContentsIncluded === false, 'no artifact contents');
  assert(report.findings.some((finding) => finding.code === 'PHASE_51_REVIEW_GATE_PRESENT'), 'review gate present');
  assert(report.findings.some((finding) => finding.code === 'OPTIONAL_CACHE_ARTIFACTS_ABSENT' && finding.level === 'warn'), 'cache absent warning');
});

test('optional cache artifacts are accepted only as a pair', () => {
  const paired = buildTorBoxLiveSmokePacketManifestReport(readyManifest({
    artifacts: [
      ...(readyManifest().artifacts as unknown[]),
      { kind: 'phase-43-cache-availability-report', label: 'redacted-cache-report' },
      { kind: 'phase-44-cache-availability-preflight', label: 'redacted-cache-preflight' },
    ],
  }));
  assert(paired.reviewReadiness === 'ready-for-review', 'paired cache ready');
  assert(paired.findings.some((finding) => finding.code === 'OPTIONAL_CACHE_ARTIFACTS_PAIRED'), 'paired code');

  const unpaired = buildTorBoxLiveSmokePacketManifestReport(readyManifest({
    artifacts: [
      ...(readyManifest().artifacts as unknown[]),
      { kind: 'phase-43-cache-availability-report', label: 'redacted-cache-report' },
    ],
  }));
  assert(unpaired.reviewReadiness === 'not-ready-for-review', 'unpaired cache blocks');
  assert(unpaired.findings.some((finding) => finding.code === 'OPTIONAL_CACHE_ARTIFACTS_UNPAIRED'), 'unpaired code');
});

test('missing or duplicate required artifact blocks review', () => {
  const missing = buildTorBoxLiveSmokePacketManifestReport(readyManifest({
    artifacts: (readyManifest().artifacts as Array<Record<string, unknown>>).filter((artifact) => artifact.kind !== 'phase-51-review-gate'),
  }));
  assert(missing.reviewReadiness === 'not-ready-for-review', 'missing review gate blocks');
  assert(missing.findings.some((finding) => finding.code === 'PHASE_51_REVIEW_GATE_REQUIRED'), 'missing code');

  const duplicate = buildTorBoxLiveSmokePacketManifestReport(readyManifest({
    artifacts: [
      ...(readyManifest().artifacts as unknown[]),
      { kind: 'phase-51-review-gate', label: 'redacted-review-gate-copy' },
    ],
  }));
  assert(duplicate.reviewReadiness === 'not-ready-for-review', 'duplicate review gate blocks');
  assert(duplicate.findings.some((finding) => finding.code === 'PHASE_51_REVIEW_GATE_REQUIRED'), 'duplicate code');
});

test('unsafe manifest metadata and hostile values do not leak', () => {
  const sentinels = [
    'TORBOX_TOKEN=secret-token',
    '/run/secrets/torbox-token',
    'RAW-INFOHASH-SECRET',
    'https://api.torbox.app/v1/api/torrents/checkcached?token=secret',
    'Private Movie Title 1999',
  ];
  const report = buildTorBoxLiveSmokePacketManifestReport(readyManifest({
    credentialValuesIncluded: true,
    credentialPathsIncluded: true,
    rawRefsIncluded: true,
    providerPayloadsIncluded: true,
    artifactContentsIncluded: true,
    artifacts: [
      ...(readyManifest().artifacts as unknown[]),
      { kind: 'phase-43-cache-availability-report', label: sentinels.join(' ') },
    ],
    notes: sentinels.join(' '),
  }));
  const output = formatTorBoxLiveSmokePacketManifestJson(report);
  assert(report.reviewReadiness === 'not-ready-for-review', 'unsafe metadata blocks');
  for (const sentinel of sentinels) assert(!output.includes(sentinel), `output excludes ${sentinel}`);
});

test('parser and fixed input errors fail closed without value echo', () => {
  assert(parseTorBoxLiveSmokePacketManifestJson('{nope') === 'PACKET_MANIFEST_JSON_MALFORMED', 'malformed');
  assert(parseTorBoxLiveSmokePacketManifestJson('[]') === 'PACKET_MANIFEST_OBJECT_REQUIRED', 'array');
  assert(parseTorBoxLiveSmokePacketManifestJson('\ufeff{"ok":true}') instanceof Object, 'BOM accepted');
  const report = buildTorBoxLiveSmokePacketManifestInputErrorReport('PACKET_MANIFEST_FILE_READ_FAILED');
  assert(report.reviewReadiness === 'not-ready-for-review', 'input error not ready');
  assert(!formatTorBoxLiveSmokePacketManifestJson(report).includes('/secret/path'), 'no path echo');
});

test('CLI reads one explicit manifest file and emits parseable JSON without path leaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'torbox-packet-manifest-'));
  try {
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(readyManifest()), 'utf8');
    const result = runCli([manifestPath, '--json']);
    assert(result.status === 0, 'CLI exits zero for ready manifest');
    const stdout = String(result.stdout);
    const stderr = String(result.stderr);
    const parsed = JSON.parse(stdout) as TorBoxLiveSmokePacketManifestReport;
    assert(parsed.report === 'phase-53-torbox-live-smoke-packet-manifest-preflight', 'stdout JSON report');
    assert(parsed.reviewReadiness === 'ready-for-review', 'stdout ready');
    assert(!stdout.includes(manifestPath), 'stdout omits path');
    assert(!stderr.includes(manifestPath), 'stderr omits path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI rejects missing, directory, oversized, and multiple inputs without path leaks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'torbox-packet-manifest-'));
  try {
    const oversized = join(dir, 'oversized.json');
    writeFileSync(oversized, JSON.stringify({ padding: 'x'.repeat(70 * 1024) }), 'utf8');
    mkdirSync(join(dir, 'subdir'));
    for (const args of [
      ['--json'],
      [join(dir, 'missing.json'), '--json'],
      [join(dir, 'subdir'), '--json'],
      [oversized, '--json'],
      [oversized, oversized, '--json'],
    ]) {
      const result = runCli(args);
      assert(result.status !== 0, `non-zero for ${args.length} args`);
      const combined = `${result.stdout}\n${result.stderr}`;
      assert(!combined.includes(dir), 'no directory path leak');
      assert(!combined.includes(oversized), 'no file path leak');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('npm package-script JSON invocation emits parseable redaction-safe JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'torbox-packet-manifest-'));
  try {
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(readyManifest()), 'utf8');
    const result = spawnSync('npm', ['run', '--silent', 'ops:torbox-live-smoke-packet-manifest', '--', '--', manifestPath, '--json'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    assert(result.status === 0, 'npm script exits zero');
    const parsed = JSON.parse(result.stdout) as TorBoxLiveSmokePacketManifestReport;
    assert(parsed.report === 'phase-53-torbox-live-smoke-packet-manifest-preflight', 'stdout is Phase 53 JSON');
    assert(parsed.manifestValuesEchoed === false, 'no manifest values echoed');
    assert(!result.stdout.includes(manifestPath), 'stdout omits path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('docs and source preserve static packet-manifest boundaries', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  assert(pkg.scripts['ops:torbox-live-smoke-packet-manifest'] === 'tsx src/ops/torbox-live-smoke-packet-manifest-cli.ts', 'ops script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-packet-manifest.ts'), 'suite in npm test');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');

  const source = `${read('src/ops/torbox-live-smoke-packet-manifest.ts')}\n${read('src/ops/torbox-live-smoke-packet-manifest-cli.ts')}`;
  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'request-download-link',
    'request-permalink',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'docker compose',
  ]) assert(!source.includes(forbidden), `Phase 53 source excludes ${forbidden}`);
  assert(!read('src/ops/torbox-live-smoke-packet-manifest.ts').includes("from 'node:fs'"), 'pure manifest module has no filesystem dependency');
  assert(read('src/ops/torbox-live-smoke-packet-manifest-cli.ts').includes("from 'node:fs'"), 'CLI has bounded explicit file reads');

  const docs = `${read('docs/PHASE_53_TORBOX_LIVE_SMOKE_PACKET_MANIFEST.md')}\n${read('README.md')}`;
  for (const kw of [
    'phase-53-torbox-live-smoke-packet-manifest',
    'ops:torbox-live-smoke-packet-manifest',
    'single-operator-supplied-packet-manifest-json-file',
    'artifactContentsIncluded',
    'no artifact contents',
    'does not close live-smoke review',
    'O4 and O5 remain open/deferred',
    'FileCustodian',
  ]) assert(docs.includes(kw), `docs include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
