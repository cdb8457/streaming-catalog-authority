import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TORBOX_LIVE_SMOKE_PLAN,
  formatTorBoxLiveSmokePlanJson,
  formatTorBoxLiveSmokePlanText,
  type TorBoxLiveSmokePlan,
} from '../src/ops/torbox-live-smoke-plan.js';

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

console.log('Running Phase 45 TorBox live smoke operator plan suite:\n');

test('plan covers the operator sequence from readiness through evidence retention', () => {
  assert(TORBOX_LIVE_SMOKE_PLAN.report === 'phase-45-torbox-live-smoke-operator-plan', 'report name');
  assert(TORBOX_LIVE_SMOKE_PLAN.steps.length === 6, 'six ordered steps');
  assert(TORBOX_LIVE_SMOKE_PLAN.steps.map((step) => step.number).join(',') === '1,2,3,4,5,6', 'steps numbered 1-6');
  for (const title of [
    'Confirm static readiness metadata',
    'Run service-status live smoke',
    'Run hoster-metadata live smoke',
    'Run optional cache-availability live smoke',
    'Preflight saved Phase 43 reports',
    'Retain redacted summary only',
  ]) assert(TORBOX_LIVE_SMOKE_PLAN.steps.some((step) => step.title === title), `contains ${title}`);
  assert(TORBOX_LIVE_SMOKE_PLAN.steps.some((step) => step.commandShapes.some((cmd) => cmd.includes('smoke:torbox-readonly'))), 'contains live smoke command shape');
  assert(TORBOX_LIVE_SMOKE_PLAN.steps.some((step) => step.commandShapes.some((cmd) => cmd.includes('ops:torbox-live-smoke-evidence-preflight'))), 'contains evidence preflight command shape');
});

test('plan is static and keeps production gates open', () => {
  assert(TORBOX_LIVE_SMOKE_PLAN.liveTorBoxContact === false, 'plan does not contact TorBox');
  assert(TORBOX_LIVE_SMOKE_PLAN.commandExecution === false, 'plan does not execute commands');
  assert(TORBOX_LIVE_SMOKE_PLAN.credentialValuesIncluded === false, 'no credential values');
  assert(TORBOX_LIVE_SMOKE_PLAN.credentialPathsIncluded === false, 'no credential paths');
  assert(TORBOX_LIVE_SMOKE_PLAN.rawRefsIncluded === false, 'no raw refs');
  assert(TORBOX_LIVE_SMOKE_PLAN.providerPayloadsIncluded === false, 'no provider payloads');
  assert(TORBOX_LIVE_SMOKE_PLAN.o4Status === 'open/deferred', 'O4 remains open');
  assert(TORBOX_LIVE_SMOKE_PLAN.o5Status === 'open/deferred', 'O5 remains open');
  assert(TORBOX_LIVE_SMOKE_PLAN.fileCustodianStatus === 'reference-harness-not-production-kms', 'FileCustodian boundary visible');
});

test('text and JSON output contain placeholders but no concrete secret/path/ref values', () => {
  const text = formatTorBoxLiveSmokePlanText();
  const json = formatTorBoxLiveSmokePlanJson();
  const parsed = JSON.parse(json) as TorBoxLiveSmokePlan;
  assert(parsed.steps.length === 6, 'json has six steps');
  for (const placeholder of TORBOX_LIVE_SMOKE_PLAN.placeholders) {
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
  ]) {
    assert(!text.includes(forbidden), `text excludes ${forbidden}`);
    assert(!json.includes(forbidden), `json excludes ${forbidden}`);
  }
});

test('live smoke command shapes use copy-paste-safe npm separators and clean JSON mode', () => {
  const commandShapes = TORBOX_LIVE_SMOKE_PLAN.steps.flatMap((step) => step.commandShapes);
  const liveSmoke = commandShapes.filter((cmd) => cmd.includes('smoke:torbox-readonly'));
  assert(liveSmoke.length === 3, 'three live smoke command shapes');
  for (const cmd of liveSmoke) {
    assert(cmd.startsWith('npm run --silent smoke:torbox-readonly -- -- --live-smoke'), 'live smoke command uses --silent and extra separator');
    assert(cmd.includes('--live-transport --read-only --redacted --operator-authorized'), 'live smoke gates present');
    assert(cmd.includes('--credential-file <torbox-token-file>'), 'credential placeholder only');
    assert(cmd.endsWith('.json>') || cmd.includes('--json > <phase-43-'), 'redirects JSON to placeholder report');
    assert(!cmd.includes('npm run smoke:torbox-readonly -- --live-smoke'), 'old npm-consuming shape absent');
  }

  const preflights = commandShapes.filter((cmd) => cmd.includes('ops:torbox-live-smoke-evidence-preflight'));
  assert(preflights.length === 3, 'three evidence preflight command shapes');
  for (const cmd of preflights) {
    assert(cmd.startsWith('npm run --silent ops:torbox-live-smoke-evidence-preflight -- -- '), 'preflight command uses --silent');
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
  const text = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/torbox-live-smoke-plan-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/torbox-live-smoke-plan-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text === formatTorBoxLiveSmokePlanText(), 'text output is fixed');
  assert(json === formatTorBoxLiveSmokePlanJson(), 'json output is fixed');
  for (const sentinel of ['SCARY_SENTINEL', 'C:/secret/sentinel', 'postgresql://scary']) {
    assert(!text.includes(sentinel), `text omits ${sentinel}`);
    assert(!json.includes(sentinel), `json omits ${sentinel}`);
  }
});

test('documented npm JSON invocation returns parseable JSON', () => {
  const out = execFileSync('npm', ['run', 'ops:torbox-live-smoke-plan', '--', '--', '--json'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const marker = '{\n  "report": "phase-45-torbox-live-smoke-operator-plan"';
  const jsonStart = out.indexOf(marker);
  assert(jsonStart >= 0, 'npm output contains JSON report');
  const parsed = JSON.parse(out.slice(jsonStart)) as TorBoxLiveSmokePlan;
  assert(parsed.report === 'phase-45-torbox-live-smoke-operator-plan', 'parsed JSON report name');
  assert(parsed.liveTorBoxContact === false && parsed.commandExecution === false, 'parsed JSON is static');
});

test('source has no filesystem, env, network, DB, Docker, adapter-mode, or execution creep', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assert(pkg.scripts['ops:torbox-live-smoke-plan'] === 'tsx src/ops/torbox-live-smoke-plan-cli.ts', 'ops script is present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-live-smoke-plan.ts'), 'suite is in npm test');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm ci');

  const plan = read('src/ops/torbox-live-smoke-plan.ts');
  const cli = read('src/ops/torbox-live-smoke-plan-cli.ts');
  const combined = `${plan}\n${cli}`;
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
  ]) assert(!combined.includes(forbidden), `Phase 45 source excludes ${forbidden}`);
});

test('Phase 48 command plan fix doc is wired and preserves non-live scope', () => {
  const doc = read('docs/PHASE_48_TORBOX_SMOKE_COMMAND_PLAN_FIX.md');
  const readme = read('README.md');
  const combined = `${doc}\n${readme}`;
  for (const kw of [
    'npm run --silent smoke:torbox-readonly -- -- --live-smoke',
    'keeps redirected JSON clean',
    'prevents npm from consuming smoke CLI flags',
    'no live TorBox calls',
    'no command execution from the plan command',
    'no credential values',
    'no downloads',
    'playback',
    'O4 and O5 remain open/deferred',
    'FileCustodian` remains a hardened reference harness',
  ]) assert(combined.includes(kw), `Phase 48 docs include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
