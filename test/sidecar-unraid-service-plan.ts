import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSidecarUnraidServicePlan,
  formatSidecarUnraidServicePlanText,
  type SidecarUnraidServicePlan,
} from '../src/ops/sidecar-unraid-service-plan.js';

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
const documentedNpmJsonCommand = 'npm run --silent ops:sidecar-unraid-service-plan -- -- --json';

console.log('Running Phase 105 sidecar Unraid service plan suite:\n');

test('plan is deterministic and never installs or starts a service', () => {
  const first = buildSidecarUnraidServicePlan();
  const second = buildSidecarUnraidServicePlan();
  assert(JSON.stringify(first) === JSON.stringify(second), 'plan is deterministic');
  assert(first.report === 'phase-105-sidecar-unraid-service-plan', 'report id');
  assert(first.servicePlanReady === true, 'plan ready');
  assert(first.serviceInstalled === false && first.serviceStarted === false, 'service not installed or started');
  assert(first.mutatesUnraid === false, 'does not mutate Unraid');
  assert(first.tcpListenerAllowed === false && first.httpApiAllowed === false, 'TCP and HTTP blocked');
  assert(first.lanExposureAllowed === false && first.reverseProxyAllowed === false, 'LAN and reverse proxy blocked');
  assert(first.closesO4 === false && first.closesO5 === false, 'no gate closure');
});

test('plan includes appdata layout, permissions, blocked actions, and operator checks', () => {
  const plan = buildSidecarUnraidServicePlan();
  assert(plan.appdataLayout.some((item) => item.includes('/mnt/user/appdata/streaming-catalog-authority/sidecar/state')), 'state appdata path present');
  assert(plan.permissionModel.includes('sidecar state directory owner-only'), 'owner-only state permission');
  assert(plan.serviceWrapperSteps.some((step) => step.id === 'health-check' && step.status === 'planned'), 'health check planned');
  assert(plan.serviceWrapperSteps.some((step) => step.id === 'boot-install' && step.status === 'deferred'), 'boot install deferred');
  for (const blocked of ['writing /boot/config/go', 'installing rc.d scripts', 'binding TCP ports', 'claiming O4 or O5 closure']) {
    assert(plan.blockedActions.includes(blocked), `blocked action present: ${blocked}`);
  }
  assert(plan.operatorChecks.includes('mismatched sidecar state makes reads fail closed'), 'restore mismatch operator check present');
});

test('CLI and documented npm command are parseable and redaction-safe', () => {
  const sentinels = ['SECRET_TOKEN_SENTINEL', 'Private Movie Sentinel', 'postgres://user:pass@example.invalid/db'];
  const direct = execFileSync('node', ['--import', 'tsx', 'src/ops/sidecar-unraid-service-plan-cli.ts', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      TOKEN: sentinels[0],
      PRIVATE_TITLE: sentinels[1],
      DATABASE_URL: sentinels[2],
    },
    encoding: 'utf8',
  });
  const directParsed = JSON.parse(direct) as SidecarUnraidServicePlan;
  assert(directParsed.report === 'phase-105-sidecar-unraid-service-plan', 'direct JSON report id');
  const documented = execSync(documentedNpmJsonCommand, { cwd: root, encoding: 'utf8' });
  const documentedParsed = JSON.parse(documented) as SidecarUnraidServicePlan;
  assert(documentedParsed.serviceInstalled === false, 'documented plan does not install service');
  const text = formatSidecarUnraidServicePlanText(directParsed);
  for (const sentinel of sentinels) {
    assert(!direct.includes(sentinel), `direct output omits ${sentinel}`);
    assert(!documented.includes(sentinel), `documented output omits ${sentinel}`);
    assert(!text.includes(sentinel), `text output omits ${sentinel}`);
  }
});

test('source and docs preserve plan-only no-mutation boundary', () => {
  const source = `${read('src/ops/sidecar-unraid-service-plan.ts')}\n${read('src/ops/sidecar-unraid-service-plan-cli.ts')}`;
  const combined = `${source}\n${read('docs/PHASE_105_SIDECAR_UNRAID_SERVICE_PLAN.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const forbidden of [
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose up',
    'execSync',
    'spawnSync',
    'writeFile',
    'chmodSync',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 105 source excludes ${forbidden}`);
  for (const required of [
    'phase-105-sidecar-unraid-service-plan',
    'SIDECAR_UNRAID_SERVICE_PLAN',
    'serviceInstalled: false',
    'serviceStarted: false',
    'mutatesUnraid: false',
    'tcpListenerAllowed: false',
    'httpApiAllowed: false',
    'lanExposureAllowed: false',
    'closesO4: false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 105 surface preserves ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
