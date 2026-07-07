import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSidecarUnraidEvidenceCapturePacket,
  completeSidecarUnraidEvidenceBundleTemplate,
  formatSidecarUnraidEvidenceCapturePacketText,
  type SidecarUnraidEvidenceCapturePacket,
} from '../src/ops/sidecar-unraid-evidence-capture.js';

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
const documentedNpmJsonCommand = 'npm run --silent ops:sidecar-unraid-evidence-capture -- -- --json';

console.log('Running Phase 107 sidecar Unraid evidence capture suite:\n');

test('packet defines expected redacted evidence bundle without executing commands', () => {
  const packet = buildSidecarUnraidEvidenceCapturePacket();
  assert(packet.report === 'phase-107-sidecar-unraid-evidence-capture-packet', 'report id');
  assert(packet.commandExecution === false, 'does not execute commands');
  assert(packet.evidenceValuesEchoed === false, 'does not echo evidence values');
  assert(packet.serviceInstalled === false && packet.serviceStarted === false, 'service not installed or started');
  assert(packet.reviewGateInput === 'single-redacted-sidecar-unraid-evidence-json-file', 'single review input');
  assert(packet.closesO4 === false && packet.closesO5 === false, 'no gate closure');
});

test('complete template has captured statuses and no exposure flags', () => {
  const template = completeSidecarUnraidEvidenceBundleTemplate();
  assert(template.report === 'phase-107-sidecar-unraid-operator-evidence-bundle', 'bundle report id');
  assert(template.setupPermissions === 'captured', 'setup captured');
  assert(template.localSocketHealth === 'captured', 'health captured');
  assert(template.restartPersistence === 'captured', 'restart captured');
  assert(template.restoreMismatchFailClosed === 'captured', 'restore mismatch captured');
  assert(template.logRedaction === 'captured', 'log redaction captured');
  assert(template.tcpListenerObserved === false && template.httpApiObserved === false, 'TCP and HTTP absent');
  assert(template.lanExposureObserved === false && template.reverseProxyObserved === false, 'LAN and reverse proxy absent');
  assert(template.closesO4 === false && template.closesO5 === false, 'bundle closes no gates');
});

test('CLI and documented npm command are parseable and redaction-safe', () => {
  const sentinels = ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://user:pass@example.invalid/db'];
  const direct = execFileSync('node', ['--import', 'tsx', 'src/ops/sidecar-unraid-evidence-capture-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: sentinels[0],
      PRIVATE_TITLE: sentinels[1],
      DATABASE_URL: sentinels[2],
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(direct) as SidecarUnraidEvidenceCapturePacket;
  assert(parsed.report === 'phase-107-sidecar-unraid-evidence-capture-packet', 'direct JSON report id');
  const documented = execSync(documentedNpmJsonCommand, { cwd: root, encoding: 'utf8' });
  const text = formatSidecarUnraidEvidenceCapturePacketText(parsed);
  for (const sentinel of sentinels) {
    assert(!direct.includes(sentinel), `direct output omits ${sentinel}`);
    assert(!documented.includes(sentinel), `documented output omits ${sentinel}`);
    assert(!text.includes(sentinel), `text output omits ${sentinel}`);
  }
});

test('source and docs preserve evidence-capture only boundary', () => {
  const source = `${read('src/ops/sidecar-unraid-evidence-capture.ts')}\n${read('src/ops/sidecar-unraid-evidence-capture-cli.ts')}`;
  const combined = `${source}\n${read('docs/PHASE_107_SIDECAR_UNRAID_EVIDENCE_CAPTURE.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'execSync',
    'spawnSync',
    'writeFile',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 107 source excludes ${forbidden}`);
  for (const required of [
    'phase-107-sidecar-unraid-evidence-capture-packet',
    'SIDECAR_UNRAID_EVIDENCE_CAPTURE_PACKET',
    'single-redacted-sidecar-unraid-evidence-json-file',
    'evidenceValuesEchoed: false',
    'commandExecution: false',
    'serviceInstalled: false',
    'closesO4: false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 107 surface preserves ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
