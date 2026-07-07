import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorUiPreviewLaunchPacket,
  formatOperatorUiPreviewLaunchPacketText,
  type OperatorUiPreviewLaunchPacket,
} from '../src/ops/operator-ui-preview-launch-packet.js';

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
const documentedNpmJsonCommand = 'npm run --silent ops:operator-ui-preview-launch-packet -- -- --json';

console.log('Running Phase 97 operator UI preview launch packet suite:\n');

test('packet is deterministic and keeps only static fixture preview ready', () => {
  const first = buildOperatorUiPreviewLaunchPacket();
  const second = buildOperatorUiPreviewLaunchPacket();
  assert(JSON.stringify(first) === JSON.stringify(second), 'report is deterministic');
  assert(first.code === 'OPERATOR_UI_PREVIEW_LAUNCH_PACKET', 'fixed code');
  assert(first.staticPreviewReady === true, 'static preview ready');
  assert(first.localReadonlyUiReady === false, 'local readonly UI not ready');
  assert(first.liveProductReady === false, 'live product not ready');
  assert(first.remoteExposureAllowed === false, 'remote exposure blocked');
  assert(first.liveDataAllowed === false, 'live data blocked');
  assert(first.providerContactAllowed === false, 'provider contact blocked');
});

test('command shapes include local loopback and SSH tunnel only', () => {
  const report = buildOperatorUiPreviewLaunchPacket();
  const ids = new Set(report.commands.map((command) => command.id));
  assert(ids.has('local-loopback'), 'local loopback command present');
  assert(ids.has('unraid-loopback-ssh-tunnel'), 'Unraid SSH tunnel command present');
  assert(report.commands.every((command) => command.exposure === 'loopback-only'), 'all commands are loopback only');
  assert(report.commands.every((command) => command.dataMode === 'fixture-only'), 'all commands are fixture only');
  assert(JSON.stringify(report).includes('--host 127.0.0.1'), 'runtime bind is loopback');
  assert(JSON.stringify(report).includes('ssh -L'), 'SSH tunnel shape is explicit');
  assert(JSON.stringify(report).includes('Do not bind the runtime to 0.0.0.0'), 'remote bind is explicitly blocked');
});

test('text and JSON omit hostile environment values', () => {
  const sentinels = ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://user:pass@example.invalid/db'];
  const json = execFileSync('node', ['--import', 'tsx', 'src/ops/operator-ui-preview-launch-packet-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: sentinels[0],
      PRIVATE_TITLE: sentinels[1],
      DATABASE_URL: sentinels[2],
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(json) as OperatorUiPreviewLaunchPacket;
  assert(parsed.report === 'phase-97-operator-ui-preview-launch-packet', 'json report id');
  const text = formatOperatorUiPreviewLaunchPacketText(parsed);
  for (const sentinel of sentinels) {
    assert(!json.includes(sentinel), `json omits ${sentinel}`);
    assert(!text.includes(sentinel), `text omits ${sentinel}`);
  }
});

test('documented npm JSON command is parseable', () => {
  const output = execSync(documentedNpmJsonCommand, {
    cwd: root,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output) as OperatorUiPreviewLaunchPacket;
  assert(parsed.report === 'phase-97-operator-ui-preview-launch-packet', 'documented json report id');
  assert(parsed.remoteExposureAllowed === false, 'documented json blocks remote exposure');
});

test('source/docs preserve static-only preview boundary', () => {
  const source = `${read('src/ops/operator-ui-preview-launch-packet.ts')}\n${read('src/ops/operator-ui-preview-launch-packet-cli.ts')}`;
  const combined = `${source}\n${read('docs/PHASE_97_OPERATOR_UI_PREVIEW_LAUNCH_PACKET.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const forbidden of [
    'react',
    'vite',
    'next',
    'express',
    'fastify',
    'koa',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    "from 'pg'",
    'docker compose',
    'ADAPTER_MODE',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'writeFile',
    'createWriteStream',
  ]) assert(!source.includes(forbidden), `Phase 97 source excludes ${forbidden}`);
  for (const required of [
    'phase-97-operator-ui-preview-launch-packet',
    'remoteExposureAllowed: false',
    'liveDataAllowed: false',
    'providerContactAllowed: false',
    'loopback-only',
    'fixture-only',
    'Unraid fixture preview through SSH tunnel',
    'Remote exposure remains blocked',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 97 surface preserves ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}

