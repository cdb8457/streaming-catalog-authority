import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSidecarRuntimeDesignPacket,
  formatSidecarRuntimeDesignPacketText,
  type SidecarRuntimeDesignPacket,
} from '../src/ops/sidecar-runtime-design-packet.js';

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
const documentedNpmJsonCommand = 'npm run --silent ops:sidecar-runtime-design-packet -- -- --json';

console.log('Running Phase 99 sidecar runtime design packet suite:\n');

test('packet selects Unraid local sidecar design but implements no runtime', () => {
  const first = buildSidecarRuntimeDesignPacket();
  const second = buildSidecarRuntimeDesignPacket();
  assert(JSON.stringify(first) === JSON.stringify(second), 'packet is deterministic');
  assert(first.report === 'phase-99-sidecar-runtime-design-packet', 'report id');
  assert(first.runtimeDesignSelected === true, 'runtime design selected');
  assert(first.runtimeImplemented === false, 'runtime not implemented');
  assert(first.liveValidationAllowed === false, 'live validation not allowed');
  assert(first.custodyBoundary === 'external-self-hosted', 'self-hosted external boundary selected');
  assert(first.o4Status === 'open/deferred' && first.o5Status === 'open/deferred', 'O4/O5 remain open');
});

test('decisions choose separate process, Unix socket, independent state, and sidecar attestation', () => {
  const report = buildSidecarRuntimeDesignPacket();
  const byId = new Map(report.decisions.map((decision) => [decision.id, decision]));
  assert(byId.get('process-boundary')?.status === 'selected', 'process boundary selected');
  assert(byId.get('ipc-boundary')?.decision.includes('Unix domain socket'), 'Unix socket selected');
  assert(byId.get('state-boundary')?.decision.includes('separate from the catalog database'), 'state boundary selected');
  assert(byId.get('attestation-boundary')?.decision.includes('sidecar-owned attestation'), 'attestation boundary selected');
  assert(byId.get('supervision-boundary')?.status === 'deferred', 'service supervision deferred');
  assert(report.blockedShapes.includes('TCP listener'), 'TCP listener blocked');
  assert(report.blockedShapes.includes('O4 or O5 closure'), 'gate closure blocked');
});

test('text and JSON omit hostile environment values', () => {
  const sentinels = ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://user:pass@example.invalid/db'];
  const json = execFileSync('node', ['--import', 'tsx', 'src/ops/sidecar-runtime-design-packet-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: sentinels[0],
      PRIVATE_TITLE: sentinels[1],
      DATABASE_URL: sentinels[2],
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(json) as SidecarRuntimeDesignPacket;
  const text = formatSidecarRuntimeDesignPacketText(parsed);
  for (const sentinel of sentinels) {
    assert(!json.includes(sentinel), `json omits ${sentinel}`);
    assert(!text.includes(sentinel), `text omits ${sentinel}`);
  }
});

test('documented npm JSON command is parseable and static', () => {
  const output = execSync(documentedNpmJsonCommand, { cwd: root, encoding: 'utf8' });
  const parsed = JSON.parse(output) as SidecarRuntimeDesignPacket;
  assert(parsed.report === 'phase-99-sidecar-runtime-design-packet', 'documented json report id');
  assert(parsed.runtimeImplemented === false, 'documented json does not implement runtime');
});

test('source/docs preserve no-daemon no-live-service boundary', () => {
  const source = `${read('src/ops/sidecar-runtime-design-packet.ts')}\n${read('src/ops/sidecar-runtime-design-packet-cli.ts')}`;
  const combined = `${source}\n${read('docs/PHASE_99_SIDECAR_RUNTIME_DESIGN_PACKET.md')}\n${read('README.md')}\n${read('package.json')}`;
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
  ]) assert(!source.includes(forbidden), `Phase 99 source excludes ${forbidden}`);
  for (const required of [
    'phase-99-sidecar-runtime-design-packet',
    'Unix domain socket',
    'owner-only filesystem permissions',
    'external-self-hosted',
    'runtimeImplemented: false',
    'liveValidationAllowed: false',
    'no daemon',
    'no socket listener',
    'no HTTP API',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 99 surface preserves ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
