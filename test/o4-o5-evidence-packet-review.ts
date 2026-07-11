import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewO4O5EvidencePackets } from '../src/ops/o4-o5-evidence-packet-review.js';

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
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

function samplePacket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packetReport: 'phase-166-o4-o5-evidence-packet',
    createdAt: '2026-07-11T00:00:00.000Z',
    scope: 'redaction-safe-o4-o5-evidence-index',
    o4: {
      descriptorPreflightLabel: 'redacted-phase-29-o4-preflight-label',
      custodianBoundary: 'external-local-sidecar-custodian',
      reviewStatus: 'pending',
    },
    o5: {
      descriptorPreflightLabel: 'redacted-phase-30-o5-preflight-label',
      rewrapPlanLabel: 'redacted-o5-rewrap-plan-label',
      reviewStatus: 'pending',
    },
    decision: {
      decisionPacketLabel: 'redacted-phase-96-decision-packet-label',
      closureRequested: false,
    },
    forbidden: ['no provider contact', 'no scraping', 'no downloading', 'no playback'],
    openGates: ['O4 remains open', 'O5 remains open'],
    ...overrides,
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-o4-o5-packet-review-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function cli(args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/o4-o5-evidence-packet-review-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function cliOk(args: readonly string[]): string {
  return execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/o4-o5-evidence-packet-review-cli.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

console.log('Running Phase 172 O4/O5 evidence packet review suite:\n');

test('review accepts the redacted Phase 166 packet template', () => {
  const report = reviewO4O5EvidencePackets({ files: [`${root}/docs/templates/O4_O5_EVIDENCE_PACKET.redacted.json`] });
  assert(report.report === 'phase-172-o4-o5-evidence-packet-review', 'report id');
  assert(report.ok === true, 'ok');
  assert(report.reviewed === 1 && report.passed === 1 && report.failed === 0, 'counts');
  assert(report.files[0]?.checks.every((check) => check.state === 'pass'), 'all checks pass');
});

test('review fails malformed JSON, missing schema, gate closure, boundary violations, and secret-looking values', () => {
  withTempDir((dir) => {
    const malformed = join(dir, 'malformed.json');
    const missing = join(dir, 'missing.json');
    const closed = join(dir, 'closed.json');
    const boundary = join(dir, 'boundary.json');
    const secret = join(dir, 'secret.json');
    writeFileSync(malformed, '{nope', 'utf8');
    writeJson(missing, { packetReport: 'phase-166-o4-o5-evidence-packet' });
    writeJson(closed, samplePacket({ openGates: ['O4 closed', 'O5 remains open'], decision: { decisionPacketLabel: 'label', closureRequested: true } }));
    writeJson(boundary, samplePacket({ forbidden: ['no provider contact'], note: 'provider mode enabled' }));
    writeJson(secret, samplePacket({ o4: { descriptorPreflightLabel: 'postgresql://user:pass@host/db', custodianBoundary: 'external-local-sidecar-custodian', reviewStatus: 'pending' } }));
    const report = reviewO4O5EvidencePackets({ files: [malformed, missing, closed, boundary, secret] });
    assert(report.ok === false, 'not ok');
    assert(report.failed === 5, 'all fail');
    assert(report.files.some((file) => file.checks.some((check) => check.name === 'json' && check.state === 'fail')), 'json fails');
    assert(report.files.some((file) => file.checks.some((check) => check.name === 'schema' && check.state === 'fail')), 'schema fails');
    assert(report.files.some((file) => file.checks.some((check) => check.name === 'open-gates' && check.state === 'fail')), 'open gates fail');
    assert(report.files.some((file) => file.checks.some((check) => check.name === 'forbidden-boundary' && check.state === 'fail')), 'boundary fails');
    assert(report.files.some((file) => file.checks.some((check) => check.name === 'redaction' && check.state === 'fail')), 'redaction fails');
  });
});

test('CLI prints PASS/FAIL summaries and returns nonzero on any failure', () => {
  withTempDir((dir) => {
    const pass = join(dir, 'pass.json');
    const fail = join(dir, 'fail.json');
    writeJson(pass, samplePacket());
    writeJson(fail, samplePacket({ decision: { decisionPacketLabel: 'label', closureRequested: true } }));
    const text = cliOk([pass]);
    assert(text.includes('PASS'), 'pass text');
    const failedRun = cli([pass, fail]);
    assert(failedRun.status === 1, 'nonzero on failure');
    assert(String(failedRun.stdout).includes('FAIL'), 'fail text');
    const json = cliOk(['--json', pass]);
    assert(json.includes('phase-172-o4-o5-evidence-packet-review'), 'json report');
  });
});

test('source, docs, and package preserve Phase 172 static review boundary', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['test:o4-o5-evidence-packet-review'] === 'tsx test/o4-o5-evidence-packet-review.ts', 'test script');
  assert(pkg.scripts['ops:o4-o5-evidence-packet-review'] === 'tsx src/ops/o4-o5-evidence-packet-review-cli.ts', 'ops script');
  assert((pkg.scripts.test ?? '').includes('test/o4-o5-evidence-decision.ts && tsx test/o4-o5-evidence-packet-review.ts'), 'aggregate order');
  const source = `${read('src/ops/o4-o5-evidence-packet-review.ts')}\n${read('src/ops/o4-o5-evidence-packet-review-cli.ts')}`;
  const combined = [
    source,
    read('docs/PHASE_172_O4_O5_EVIDENCE_PACKET_REVIEW.md'),
    read('README.md'),
    read('package.json'),
  ].join('\n');
  for (const required of [
    'phase-172-o4-o5-evidence-packet-review',
    'ops:o4-o5-evidence-packet-review',
    'valid JSON',
    'schema',
    'open-gates',
    'forbidden-boundary',
    'redaction',
    'O4 remains open',
    'O5 remains open',
  ]) assert(combined.includes(required), `surface includes ${required}`);
  for (const forbidden of [
    '@torbox/torbox-api',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'request-download-link',
    'magnet:',
    'docker compose',
    'globalThis.fetch',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}

