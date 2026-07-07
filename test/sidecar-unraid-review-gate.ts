import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { completeSidecarUnraidEvidenceBundleTemplate } from '../src/ops/sidecar-unraid-evidence-capture.js';
import {
  buildSidecarUnraidReviewGateReport,
  formatSidecarUnraidReviewGateText,
  parseSidecarUnraidEvidenceBundleJson,
  sampleCompleteSidecarUnraidEvidenceBundle,
  type SidecarUnraidReviewGateReport,
} from '../src/ops/sidecar-unraid-review-gate.js';

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

console.log('Running Phase 108 sidecar Unraid review gate suite:\n');

test('complete redacted bundle is ready for review but closes no gates', () => {
  const report = buildSidecarUnraidReviewGateReport(completeSidecarUnraidEvidenceBundleTemplate() as Record<string, unknown>);
  assert(report.ok === true, 'report ok');
  assert(report.report === 'phase-108-sidecar-unraid-review-gate', 'report id');
  assert(report.reviewReadiness === 'ready-for-review', 'ready for review');
  assert(report.commandExecution === false && report.evidenceValuesEchoed === false, 'no execution or value echo');
  assert(report.liveServiceContact === false && report.providerContactAllowed === false, 'no live/provider contact');
  assert(report.closesO4 === false && report.closesO5 === false, 'no gate closure');
  assert(report.summary.fail === 0, 'no fail findings');
  assert(report.findings.some((finding) => finding.code === 'REVIEWER_STILL_REQUIRED'), 'reviewer warning present');
});

test('missing or unsafe evidence fields make review not-ready', () => {
  const bad = {
    ...completeSidecarUnraidEvidenceBundleTemplate(),
    localSocketHealth: 'missing',
    tcpListenerObserved: true,
    closesO4: true,
  };
  const report = buildSidecarUnraidReviewGateReport(bad as Record<string, unknown>);
  assert(report.ok === false, 'bad report not ok');
  assert(report.reviewReadiness === 'not-ready-for-review', 'bad report not ready');
  const codes = new Set(report.findings.map((finding) => finding.code));
  assert(codes.has('LOCAL_SOCKET_HEALTH_CAPTURED_REQUIRED'), 'missing health fails');
  assert(codes.has('NO_TCP_LISTENER_OBSERVED_REQUIRED'), 'TCP observed fails');
  assert(codes.has('BUNDLE_DOES_NOT_CLOSE_O4_REQUIRED'), 'O4 closure claim fails');
});

test('parser rejects malformed, array, and primitive inputs', () => {
  assert(parseSidecarUnraidEvidenceBundleJson('{') === 'REVIEW_GATE_JSON_MALFORMED', 'malformed rejected');
  assert(parseSidecarUnraidEvidenceBundleJson('[]') === 'REVIEW_GATE_OBJECT_REQUIRED', 'array rejected');
  assert(parseSidecarUnraidEvidenceBundleJson('"x"') === 'REVIEW_GATE_OBJECT_REQUIRED', 'primitive rejected');
});

test('CLI reads one explicit redacted evidence file and omits hostile values', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'phase-108-review-'));
  const sentinels = ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://user:pass@example.invalid/db'];
  try {
    const input = join(tmp, 'evidence.redacted.json');
    writeFileSync(input, JSON.stringify(sampleCompleteSidecarUnraidEvidenceBundle()), 'utf8');
    const direct = execFileSync('node', ['--import', 'tsx', 'src/ops/sidecar-unraid-review-gate-cli.ts', input, '--json'], {
      cwd: root,
      env: {
        ...process.env,
        TOKEN: sentinels[0],
        PRIVATE_TITLE: sentinels[1],
        DATABASE_URL: sentinels[2],
      },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(direct) as SidecarUnraidReviewGateReport;
    assert(parsed.report === 'phase-108-sidecar-unraid-review-gate', 'direct JSON report id');
    assert(parsed.reviewReadiness === 'ready-for-review', 'CLI ready for review');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const documented = execSync(`${npm} run --silent ops:sidecar-unraid-review-gate -- -- ${input} --json`, { cwd: root, encoding: 'utf8' });
    const documentedParsed = JSON.parse(documented) as SidecarUnraidReviewGateReport;
    assert(documentedParsed.ok === true, 'documented command ok');
    const text = formatSidecarUnraidReviewGateText(parsed);
    for (const sentinel of [...sentinels, input, tmp]) {
      assert(!direct.includes(sentinel), `direct output omits ${sentinel}`);
      assert(!documented.includes(sentinel), `documented output omits ${sentinel}`);
      assert(!text.includes(sentinel), `text output omits ${sentinel}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('source and docs preserve static review-gate boundary', () => {
  const source = `${read('src/ops/sidecar-unraid-review-gate.ts')}\n${read('src/ops/sidecar-unraid-review-gate-cli.ts')}`;
  const combined = `${source}\n${read('docs/PHASE_108_SIDECAR_UNRAID_REVIEW_GATE.md')}\n${read('README.md')}\n${read('package.json')}`;
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
  ]) assert(!source.includes(forbidden), `Phase 108 source excludes ${forbidden}`);
  for (const required of [
    'phase-108-sidecar-unraid-review-gate',
    'SIDECAR_UNRAID_REVIEW_GATE',
    'single-redacted-sidecar-unraid-evidence-json-file',
    'commandExecution: false',
    'evidenceValuesEchoed: false',
    'reviewReadiness',
    'closesO4: false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 108 surface preserves ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
