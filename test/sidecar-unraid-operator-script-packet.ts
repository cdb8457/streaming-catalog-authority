import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSidecarUnraidOperatorScriptPacket,
  formatSidecarUnraidOperatorScriptPacketText,
  type SidecarUnraidOperatorScript,
  type SidecarUnraidOperatorScriptPacket,
} from '../src/ops/sidecar-unraid-operator-script-packet.js';

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
const documentedNpmJsonCommand = 'npm run --silent ops:sidecar-unraid-operator-script-packet -- -- --json';

console.log('Running Phase 106 sidecar Unraid operator script packet suite:\n');

test('packet provides scripts but executes nothing and installs no service', () => {
  const packet = buildSidecarUnraidOperatorScriptPacket();
  assert(packet.report === 'phase-106-sidecar-unraid-operator-script-packet', 'report id');
  assert(packet.commandExecution === false, 'commands are not executed');
  assert(packet.operatorRunRequired === true, 'operator run required');
  assert(packet.serviceInstalled === false && packet.serviceStarted === false, 'service not installed or started');
  assert(packet.mutatesUnraidNow === false, 'packet does not mutate Unraid now');
  assert(packet.tcpListenerAllowed === false && packet.httpApiAllowed === false, 'TCP and HTTP blocked');
  assert(packet.lanExposureAllowed === false && packet.reverseProxyAllowed === false, 'LAN and reverse proxy blocked');
  assert(packet.closesO4 === false && packet.closesO5 === false, 'no gate closure');
});

test('scripts cover setup, start, health, stop, and evidence labels', () => {
  const packet = buildSidecarUnraidOperatorScriptPacket();
  const ids = new Set(packet.scripts.map((script) => script.id));
  const expectedScriptIds: SidecarUnraidOperatorScript['id'][] = ['setup', 'start', 'health', 'stop', 'evidence'];
  for (const id of expectedScriptIds) assert(ids.has(id), `${id} script present`);
  assert(packet.scripts.every((script) => script.operatorRunRequired === true), 'all scripts are operator-run');
  assert(packet.scripts.some((script) => script.command.includes('/mnt/user/appdata/streaming-catalog-authority/sidecar')), 'appdata path present');
  assert(packet.scripts.some((script) => script.command.includes('catalog-sidecar.sock')), 'local socket path present');
  assert(packet.blockedActions.includes('automatic command execution'), 'automatic execution blocked');
  assert(packet.blockedActions.includes('claiming O4 or O5 closure'), 'gate closure blocked');
});

test('CLI and documented npm command are parseable and redaction-safe', () => {
  const sentinels = ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://user:pass@example.invalid/db'];
  const direct = execFileSync('node', ['--import', 'tsx', 'src/ops/sidecar-unraid-operator-script-packet-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: sentinels[0],
      PRIVATE_TITLE: sentinels[1],
      DATABASE_URL: sentinels[2],
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(direct) as SidecarUnraidOperatorScriptPacket;
  assert(parsed.report === 'phase-106-sidecar-unraid-operator-script-packet', 'direct JSON report id');
  const documented = execSync(documentedNpmJsonCommand, { cwd: root, encoding: 'utf8' });
  const text = formatSidecarUnraidOperatorScriptPacketText(parsed);
  for (const sentinel of sentinels) {
    assert(!direct.includes(sentinel), `direct output omits ${sentinel}`);
    assert(!documented.includes(sentinel), `documented output omits ${sentinel}`);
    assert(!text.includes(sentinel), `text output omits ${sentinel}`);
  }
});

test('source and docs preserve packet-only no-execution boundary', () => {
  const source = `${read('src/ops/sidecar-unraid-operator-script-packet.ts')}\n${read('src/ops/sidecar-unraid-operator-script-packet-cli.ts')}`;
  const combined = `${source}\n${read('docs/PHASE_106_SIDECAR_UNRAID_OPERATOR_SCRIPT_PACKET.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'execSync',
    'spawnSync',
    'writeFile',
    'chmodSync',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 106 source excludes ${forbidden}`);
  for (const required of [
    'phase-106-sidecar-unraid-operator-script-packet',
    'SIDECAR_UNRAID_OPERATOR_SCRIPT_PACKET',
    'commandExecution: false',
    'operatorRunRequired: true',
    'mutatesUnraidNow: false',
    'serviceInstalled: false',
    'tcpListenerAllowed: false',
    'httpApiAllowed: false',
    'closesO4: false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 106 surface preserves ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
