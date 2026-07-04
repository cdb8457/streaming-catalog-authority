import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TORBOX_LIVE_SMOKE_OPERATOR_PACKET,
  formatTorBoxLiveSmokeOperatorPacketJson,
  formatTorBoxLiveSmokeOperatorPacketText,
  type TorBoxLiveSmokeOperatorPacket,
} from '../src/ops/torbox-live-smoke-operator-packet.js';

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

console.log('Running Phase 52 TorBox live smoke operator packet suite:\n');

test('packet covers the run-save-review workflow through Phase 51', () => {
  assert(TORBOX_LIVE_SMOKE_OPERATOR_PACKET.report === 'phase-52-torbox-live-smoke-operator-packet', 'report name');
  assert(TORBOX_LIVE_SMOKE_OPERATOR_PACKET.steps.length === 8, 'eight ordered steps');
  assert(TORBOX_LIVE_SMOKE_OPERATOR_PACKET.steps.map((step) => step.number).join(',') === '1,2,3,4,5,6,7,8', 'steps numbered 1-8');
  for (const phase of ['Phase 43', 'Phase 44', 'Phase 49', 'Phase 51', 'Phase 52']) {
    assert(TORBOX_LIVE_SMOKE_OPERATOR_PACKET.steps.some((step) => step.phase === phase), `contains ${phase}`);
  }
  for (const command of [
    'smoke:torbox-readonly',
    'ops:torbox-live-smoke-evidence-preflight',
    'ops:torbox-live-smoke-summary-pack',
    'ops:torbox-live-smoke-review-gate',
  ]) {
    assert(TORBOX_LIVE_SMOKE_OPERATOR_PACKET.steps.some((step) => step.commandShapes.some((shape) => shape.includes(command))), `contains ${command}`);
  }
});

test('packet is static and keeps production gates open', () => {
  const packet = TORBOX_LIVE_SMOKE_OPERATOR_PACKET;
  assert(packet.liveTorBoxContact === false, 'packet does not contact TorBox');
  assert(packet.commandExecution === false, 'packet does not execute commands');
  assert(packet.credentialValuesIncluded === false, 'no credential values');
  assert(packet.credentialPathsIncluded === false, 'no credential paths');
  assert(packet.rawRefsIncluded === false, 'no raw refs');
  assert(packet.providerPayloadsIncluded === false, 'no provider payloads');
  assert(packet.summaryValuesEchoed === false, 'no summary values echoed');
  assert(packet.closesLiveSmokeReview === false, 'does not close review');
  assert(packet.o4Status === 'open/deferred', 'O4 remains open');
  assert(packet.o5Status === 'open/deferred', 'O5 remains open');
  assert(packet.fileCustodianStatus === 'reference-harness-not-production-kms', 'FileCustodian boundary visible');
});

test('review gate required and optional probes are explicit', () => {
  const packet = TORBOX_LIVE_SMOKE_OPERATOR_PACKET;
  assert(packet.requiredReviewGateInputs.join(',') === 'service-status,hoster-metadata', 'required probes fixed');
  assert(packet.optionalReviewGateInputs.join(',') === 'cache-availability', 'optional probe fixed');
  assert(packet.reviewRules.some((rule) => rule.includes('service-status') && rule.includes('hoster-metadata')), 'required review rule');
  assert(packet.reviewRules.some((rule) => rule.includes('cache-availability') && rule.includes('optional')), 'optional cache rule');
  assert(packet.reviewRules.some((rule) => rule.includes('does not close live-smoke review')), 'review closure warning');
});

test('text and JSON output contain placeholders but no concrete secret/path/ref values', () => {
  const text = formatTorBoxLiveSmokeOperatorPacketText();
  const json = formatTorBoxLiveSmokeOperatorPacketJson();
  const parsed = JSON.parse(json) as TorBoxLiveSmokeOperatorPacket;
  assert(parsed.report === 'phase-52-torbox-live-smoke-operator-packet', 'json report name');
  for (const placeholder of TORBOX_LIVE_SMOKE_OPERATOR_PACKET.placeholders) {
    assert(text.includes(placeholder), `text includes placeholder ${placeholder}`);
    assert(json.includes(placeholder), `json includes placeholder ${placeholder}`);
  }
  for (const forbidden of [
    'Bearer ',
    'TORBOX_TOKEN=',
    'api.torbox.app/v1',
    'postgres://',
    '/mnt/user/',
    '/run/secrets/torbox-token',
    'RAW-INFOHASH',
    'SECRET-PROVIDER-PAYLOAD',
    'Private Movie Title',
  ]) {
    assert(!text.includes(forbidden), `text excludes ${forbidden}`);
    assert(!json.includes(forbidden), `json excludes ${forbidden}`);
  }
});

test('CLI output is deterministic and ignores hostile environment values', () => {
  const env = {
    ...process.env,
    TORBOX_TOKEN: 'SCARY_SENTINEL_TORBOX_TOKEN',
    TORBOX_CREDENTIAL_FILE: 'C:/secret/sentinel/token.txt',
    TORBOX_RAW_REF: 'SCARY_SENTINEL_RAW_REF',
    DATABASE_URL: 'postgresql://scary:secret@example.invalid/db',
  };
  const text = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/torbox-live-smoke-operator-packet-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/torbox-live-smoke-operator-packet-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text === formatTorBoxLiveSmokeOperatorPacketText(), 'text output is fixed');
  assert(json === formatTorBoxLiveSmokeOperatorPacketJson(), 'json output is fixed');
  for (const sentinel of ['SCARY_SENTINEL', 'C:/secret/sentinel', 'postgresql://scary']) {
    assert(!text.includes(sentinel), `text omits ${sentinel}`);
    assert(!json.includes(sentinel), `json omits ${sentinel}`);
  }
});

test('documented npm JSON invocation returns parseable JSON', () => {
  const out = execFileSync('npm', ['run', 'ops:torbox-live-smoke-operator-packet', '--', '--', '--json'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const marker = '{\n  "report": "phase-52-torbox-live-smoke-operator-packet"';
  const jsonStart = out.indexOf(marker);
  assert(jsonStart >= 0, 'npm output contains JSON report');
  const parsed = JSON.parse(out.slice(jsonStart)) as TorBoxLiveSmokeOperatorPacket;
  assert(parsed.report === 'phase-52-torbox-live-smoke-operator-packet', 'parsed JSON report name');
  assert(parsed.liveTorBoxContact === false && parsed.commandExecution === false, 'parsed JSON is static');
});

test('source has no filesystem, env, network, DB, Docker, adapter-mode, or execution creep', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assert(pkg.scripts['ops:torbox-live-smoke-operator-packet'] === 'tsx src/ops/torbox-live-smoke-operator-packet-cli.ts', 'ops script is present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-operator-packet.ts'), 'suite is in npm test');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm ci');

  const packet = read('src/ops/torbox-live-smoke-operator-packet.ts');
  const cli = read('src/ops/torbox-live-smoke-operator-packet-cli.ts');
  const combined = `${packet}\n${cli}`;
  for (const forbidden of [
    '@torbox/torbox-api',
    "from 'pg'",
    'from "pg"',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'loadDbConfig',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'execFileSync',
    'spawnSync',
    'docker compose',
    'ADAPTER_MODE',
    'createAdapter',
    'createTorBoxLiveTransport',
    'TorBoxReadOnlyClient',
    'requestDownloadLink',
    'create-download',
    'request-download-link',
    'request-permalink',
    'readFileSync',
    'readdirSync',
    'existsSync',
  ]) assert(!combined.includes(forbidden), `Phase 52 source excludes ${forbidden}`);
});

test('docs preserve the static redaction boundary', () => {
  const doc = read('docs/PHASE_52_TORBOX_LIVE_SMOKE_OPERATOR_PACKET.md');
  const readme = read('README.md');
  const combined = `${doc}\n${readme}`;
  for (const kw of [
    'phase-52-torbox-live-smoke-operator-packet',
    'ops:torbox-live-smoke-operator-packet',
    'service-status',
    'hoster-metadata',
    'cache-availability',
    'Phase 49 summary',
    'Phase 51 review-gate',
    'no credential values',
    'no raw refs',
    'no live TorBox calls from the packet command',
    'does not close live-smoke review',
    'O4 and O5 remain open/deferred',
    'FileCustodian',
  ]) assert(combined.includes(kw), `docs include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
