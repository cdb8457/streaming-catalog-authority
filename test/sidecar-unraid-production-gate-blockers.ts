import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSidecarUnraidProductionGateBlockersPacket,
  formatSidecarUnraidProductionGateBlockersJson,
  formatSidecarUnraidProductionGateBlockersText,
  type SidecarUnraidProductionGateBlockersPacket,
} from '../src/ops/sidecar-unraid-production-gate-blockers.js';

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

function assertShape(packet: SidecarUnraidProductionGateBlockersPacket): void {
  assert(packet.report === 'phase-112-sidecar-unraid-production-gate-blockers', 'report');
  assert(packet.code === 'SIDECAR_UNRAID_PRODUCTION_GATE_BLOCKERS', 'code');
  assert(packet.sourceHandoff === 'phase-111-sidecar-unraid-review-handoff', 'source handoff');
  assert(packet.productionReady === false, 'not production ready');
  assert(packet.launchApproved === false, 'no launch approval');
  assert(packet.serviceInstallApproved === false, 'no service install approval');
  assert(packet.serviceInstalled === false && packet.serviceStarted === false, 'service not installed or started');
  assert(packet.providerModeEnabled === false, 'provider mode disabled');
  assert(packet.commandExecution === false, 'no command execution');
  assert(packet.liveServiceContact === false && packet.providerContactAllowed === false, 'no live/provider contact');
  assert(packet.tcpListenerAllowed === false && packet.httpApiAllowed === false, 'no TCP/HTTP');
  assert(packet.lanExposureAllowed === false && packet.reverseProxyAllowed === false, 'no LAN/reverse proxy');
  assert(packet.closesO4 === false && packet.closesO5 === false, 'no gate closure');
  assert(packet.o4Status === 'open/deferred' && packet.o5Status === 'open/deferred', 'gates open');
  assert(packet.fileCustodianStatus === 'reference-harness-not-production-kms', 'FileCustodian boundary');
  assert(packet.blockers.length === 4, 'four blockers');
}

function assertNoSentinels(output: string): void {
  for (const sentinel of ['SECRET_VALUE_SENTINEL', 'PRIVATE_TITLE_SENTINEL', 'postgres://', 'Authorization', 'Bearer ', 'http://localhost', 'https://api']) {
    assert(!output.includes(sentinel), `output excludes ${sentinel}`);
  }
}

console.log('Running Phase 112 sidecar Unraid production gate blockers suite:\n');

test('packet enumerates unresolved production blockers and closes no gates', () => {
  const packet = buildSidecarUnraidProductionGateBlockersPacket();
  assertShape(packet);
  const blockerIds = packet.blockers.map((blocker) => blocker.id);
  for (const id of ['o4-managed-custodian-boundary', 'o4-independent-review-verdict', 'o5-managed-kek-custody', 'unraid-service-live-validation']) {
    assert(blockerIds.includes(id), `blocker ${id}`);
  }
  for (const label of packet.requiredNextEvidenceLabels) assert(label.endsWith('-redacted'), `redacted evidence label ${label}`);
});

test('formatters and CLIs emit deterministic redaction-safe output', () => {
  const packet = buildSidecarUnraidProductionGateBlockersPacket();
  const json = formatSidecarUnraidProductionGateBlockersJson(packet);
  const text = formatSidecarUnraidProductionGateBlockersText(packet);
  assertShape(JSON.parse(json) as SidecarUnraidProductionGateBlockersPacket);
  assert(text.includes('Phase 112 sidecar Unraid production gate blockers'), 'text title');
  assert(text.includes('productionReady: false'), 'text production false');
  assert(text.includes('closesO4: false'), 'text O4 false');
  assertNoSentinels(json);
  assertNoSentinels(text);

  const direct = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/sidecar-unraid-production-gate-blockers-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL',
      DATABASE_URL: 'postgres://secret',
    },
    encoding: 'utf8',
  });
  assertShape(JSON.parse(direct) as SidecarUnraidProductionGateBlockersPacket);
  assertNoSentinels(direct);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:sidecar-unraid-production-gate-blockers -- -- --json', { cwd: root, encoding: 'utf8' });
  assertShape(JSON.parse(output) as SidecarUnraidProductionGateBlockersPacket);
});

test('source and docs preserve blocker-only boundary', () => {
  const source = `${read('src/ops/sidecar-unraid-production-gate-blockers.ts')}\n${read('src/ops/sidecar-unraid-production-gate-blockers-cli.ts')}`;
  const docs = `${read('docs/PHASE_112_SIDECAR_UNRAID_PRODUCTION_GATE_BLOCKERS.md')}\n${read('README.md')}\n${read('package.json')}`;
  assert((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['ops:sidecar-unraid-production-gate-blockers'] === 'tsx src/ops/sidecar-unraid-production-gate-blockers-cli.ts', 'ops script');
  assert((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['test:sidecar-unraid-production-gate-blockers'] === 'tsx test/sidecar-unraid-production-gate-blockers.ts', 'test script');
  for (const forbidden of ['node:fs', 'node:http', 'node:https', 'node:net', 'process.env', 'globalThis.fetch', 'fetch(', 'execSync', 'spawnSync', "from 'pg'", 'ProviderAdapter', 'TorBoxReadOnlyClient', 'JellyfinHttpClient']) {
    assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  }
  for (const required of ['Phase 112', 'SIDECAR_UNRAID_PRODUCTION_GATE_BLOCKERS', 'phase-111-sidecar-unraid-review-handoff', 'productionReady: false', 'serviceInstallApproved: false', 'providerModeEnabled: false', 'closesO4: false', 'closesO5: false', 'O4/O5 remain open/deferred', 'FileCustodian remains a hardened reference harness']) {
    assert(docs.includes(required), `docs include ${required}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
