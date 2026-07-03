import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  READINESS_PLAN,
  formatReadinessPlanJson,
  formatReadinessPlanText,
  type ReadinessPlan,
} from '../src/ops/readiness-plan.js';

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

console.log('Running Phase 25 readiness rehearsal suite:\n');

const artifactLabels = [
  '01-deployment-unraid.redacted.md',
  '02-external-custodian-o4.redacted.md',
  '03-kek-rotation-o5.redacted.md',
  '04-backup-restore-retention.redacted.md',
  '05-doctor-warning-gates.redacted.json',
  '06-scheduled-operator-tasks.redacted.md',
  '07-jellyfin-validation.redacted.md',
  '08-ci-test-expectations.redacted.md',
  '09-privacy-redaction.redacted.md',
];

test('plan data covers all 9 Phase 22 rows and artifact labels', () => {
  assert(READINESS_PLAN.rows.length === 9, 'exactly 9 rows');
  assert(READINESS_PLAN.rows.map((r) => r.number).join(',') === '1,2,3,4,5,6,7,8,9', 'rows numbered 1-9');
  for (const label of artifactLabels) {
    assert(READINESS_PLAN.rows.some((row) => row.artifactLabel === label), `contains ${label}`);
  }
  for (const status of ['met', 'operator-provided', 'deferred', 'blocked']) {
    assert(READINESS_PLAN.statuses.includes(status as never), `status category ${status}`);
  }
});

test('text and json output contain all rows and expected artifact labels', () => {
  const text = formatReadinessPlanText();
  const json = formatReadinessPlanJson();
  const parsed = JSON.parse(json) as ReadinessPlan;
  assert(parsed.rows.length === 9, 'json has 9 rows');
  for (let i = 1; i <= 9; i++) {
    assert(text.includes(`${i}. `), `text row ${i}`);
    assert(parsed.rows.some((row) => row.number === i), `json row ${i}`);
  }
  for (const label of artifactLabels) {
    assert(text.includes(label), `text includes ${label}`);
    assert(json.includes(label), `json includes ${label}`);
  }
});

test('O4 and O5 remain open/deferred and FileCustodian is not production KMS', () => {
  const text = formatReadinessPlanText();
  const row2 = READINESS_PLAN.rows.find((row) => row.number === 2);
  const row3 = READINESS_PLAN.rows.find((row) => row.number === 3);
  assert(row2?.status === 'deferred', 'O4 row deferred');
  assert(row3?.status === 'deferred', 'O5 row deferred');
  assert(/O4 remains open\/deferred/i.test(text), 'O4 warning visible');
  assert(/O5 remains open\/deferred/i.test(text), 'O5 warning visible');
  assert(/FileCustodian is a hardened reference harness, not production KMS/i.test(text), 'FileCustodian boundary visible');
  assert(!/closes O4|closes O5|production-ready as turnkey|turnkey production-ready/i.test(text), 'does not close gates or overstate readiness');
});

test('CLI output is deterministic and ignores hostile environment values', () => {
  const env = {
    ...process.env,
    CUSTODIAN_KEK: 'SCARY_SENTINEL_KEK_VALUE',
    COMPLETION_SECRET: 'SCARY_SENTINEL_COMPLETION_SECRET',
    HMAC_SECRET: 'SCARY_SENTINEL_HMAC_SECRET',
    DATABASE_URL: 'postgresql://scary-sentinel-user:secret@example.invalid/catalog',
    JELLYFIN_API_KEY: 'SCARY_SENTINEL_JELLYFIN_TOKEN',
    PROVIDER_REF: 'SCARY_SENTINEL_PROVIDER_REF',
    MEDIA_TITLE: 'SCARY_SENTINEL_MEDIA_TITLE',
  };
  const text = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/readiness-plan-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/readiness-plan-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text === formatReadinessPlanText(), 'text output is fixed');
  assert(json === formatReadinessPlanJson(), 'json output is fixed');
  for (const sentinel of [
    'SCARY_SENTINEL',
    'postgresql://scary-sentinel',
    'secret@example.invalid',
  ]) {
    assert(!text.includes(sentinel), `text omits ${sentinel}`);
    assert(!json.includes(sentinel), `json omits ${sentinel}`);
  }
});

test('documented npm JSON invocation returns JSON', () => {
  const out = execFileSync('npm', ['run', 'ops:readiness-plan', '--', '--', '--json'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const marker = '{\n  "report": "phase-25-readiness-rehearsal-plan"';
  const jsonStart = out.indexOf(marker);
  assert(jsonStart >= 0, 'npm output contains JSON report');
  const parsed = JSON.parse(out.slice(jsonStart)) as ReadinessPlan;
  assert(parsed.report === 'phase-25-readiness-rehearsal-plan', 'parsed JSON report name');
  assert(parsed.rows.length === 9, 'parsed JSON has 9 rows');
});

test('CLI does not import DB, filesystem, network, Docker, or live-service modules', () => {
  const cli = read('src/ops/readiness-plan-cli.ts');
  const plan = read('src/ops/readiness-plan.ts');
  const combined = `${cli}\n${plan}`;
  for (const forbidden of [
    "from 'pg'",
    'from "pg"',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'loadDbConfig',
    'loadCustodianConfig',
    'createCustodian',
    'globalThis.fetch',
    'fetch(',
    'docker compose',
    'process.env',
    'readFileSync',
  ]) {
    assert(!combined.includes(forbidden), `no ${forbidden}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
