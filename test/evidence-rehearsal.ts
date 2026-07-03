import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EVIDENCE_REHEARSAL,
  formatEvidenceRehearsalJson,
  formatEvidenceRehearsalText,
  type EvidenceRehearsal,
} from '../src/ops/evidence-rehearsal.js';

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

console.log('Running Phase 26 operator evidence rehearsal suite:\n');

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

const rowCriteria = [
  'Deployment / Unraid config',
  'External custodian / KMS (O4)',
  'KEK rotation (O5)',
  'Backup/restore + retention',
  'ops:doctor / warning gates',
  'Scheduled operator tasks',
  'Jellyfin validation evidence',
  'CI / test expectations',
  'Privacy / redaction',
];

test('all nine Phase 22 rows and Phase 23 artifact labels are represented', () => {
  assert(EVIDENCE_REHEARSAL.items.length === 9, 'exactly 9 checklist items');
  assert(EVIDENCE_REHEARSAL.items.map((item) => item.phase22Row).join(',') === '1,2,3,4,5,6,7,8,9', 'rows numbered 1-9');
  for (const criterion of rowCriteria) {
    assert(EVIDENCE_REHEARSAL.items.some((item) => item.criterion === criterion), `contains ${criterion}`);
  }
  for (const label of artifactLabels) {
    assert(EVIDENCE_REHEARSAL.items.some((item) => item.phase23ArtifactLabel === label), `contains ${label}`);
  }
});

test('JSON and text outputs are deterministic and redaction-safe', () => {
  const text1 = formatEvidenceRehearsalText();
  const text2 = formatEvidenceRehearsalText();
  const json1 = formatEvidenceRehearsalJson();
  const json2 = formatEvidenceRehearsalJson();
  assert(text1 === text2, 'text output is stable');
  assert(json1 === json2, 'json output is stable');

  const parsed = JSON.parse(json1) as EvidenceRehearsal;
  assert(parsed.report === 'phase-26-operator-evidence-rehearsal-check', 'report name');
  assert(parsed.advisoryOnly === true, 'advisory-only flag');
  assert(parsed.items.length === 9, 'json has 9 items');
  for (const label of artifactLabels) {
    assert(text1.includes(label), `text includes ${label}`);
    assert(json1.includes(label), `json includes ${label}`);
  }
  for (const forbiddenValue of [
    'postgresql://',
    'DATABASE_URL=',
    'CUSTODIAN_KEK=',
    'COMPLETION_SECRET=',
    'JELLYFIN_API_KEY=',
    '/mnt/user/',
    'http://',
    'https://',
  ]) {
    assert(!text1.includes(forbiddenValue), `text omits ${forbiddenValue}`);
    assert(!json1.includes(forbiddenValue), `json omits ${forbiddenValue}`);
  }
});

test('npm package-script JSON invocation emits parseable JSON', () => {
  const out = execFileSync('npm', ['run', 'ops:evidence-rehearsal', '--', '--', '--json'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const marker = '{\n  "report": "phase-26-operator-evidence-rehearsal-check"';
  const jsonStart = out.indexOf(marker);
  assert(jsonStart >= 0, 'npm output contains JSON report');
  const parsed = JSON.parse(out.slice(jsonStart)) as EvidenceRehearsal;
  assert(parsed.report === 'phase-26-operator-evidence-rehearsal-check', 'parsed JSON report name');
  assert(parsed.items.length === 9, 'parsed JSON has 9 rows');
});

test('hostile environment variables containing sentinel secrets are not emitted', () => {
  const env = {
    ...process.env,
    CUSTODIAN_KEK: 'PHASE26_SENTINEL_KEK_VALUE',
    COMPLETION_SECRET: 'PHASE26_SENTINEL_COMPLETION_SECRET',
    HMAC_SECRET: 'PHASE26_SENTINEL_HMAC_SECRET',
    DATABASE_URL: 'postgresql://phase26-sentinel-user:secret@example.invalid/catalog',
    SECRET_FILE_PATH: 'C:/phase26/sentinel/secret/path',
    JELLYFIN_API_KEY: 'PHASE26_SENTINEL_JELLYFIN_TOKEN',
    PROVIDER_REF: 'PHASE26_SENTINEL_PROVIDER_REF',
    MEDIA_TITLE: 'PHASE26_SENTINEL_MEDIA_TITLE',
  };
  const text = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/evidence-rehearsal-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/ops/evidence-rehearsal-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  for (const sentinel of ['PHASE26_SENTINEL', 'postgresql://phase26-sentinel', 'secret@example.invalid', 'C:/phase26/sentinel']) {
    assert(!text.includes(sentinel), `text omits ${sentinel}`);
    assert(!json.includes(sentinel), `json omits ${sentinel}`);
  }
});

test('source does not import filesystem, DB, network, Docker, or live-service modules', () => {
  const cli = read('src/ops/evidence-rehearsal-cli.ts');
  const rehearsal = read('src/ops/evidence-rehearsal.ts');
  const combined = `${cli}\n${rehearsal}`;
  for (const forbidden of [
    "from 'pg'",
    'from "pg"',
    'node:fs',
    'node:path',
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
    'JELLYFIN_ENABLE_NETWORK',
    'JELLYFIN_ALLOW_LIVE_PUBLISH',
  ]) {
    assert(!combined.includes(forbidden), `no ${forbidden}`);
  }
});

test('O4/O5 remain open/deferred and FileCustodian stays reference-only', () => {
  const text = formatEvidenceRehearsalText();
  const o4 = EVIDENCE_REHEARSAL.items.find((item) => item.phase22Row === 2);
  const o5 = EVIDENCE_REHEARSAL.items.find((item) => item.phase22Row === 3);
  assert(o4?.gate === 'deferred', 'O4 row deferred');
  assert(o5?.gate === 'deferred', 'O5 row deferred');
  assert(/O4 remains open\/deferred/i.test(text), 'O4 warning visible');
  assert(/O5 remains open\/deferred/i.test(text), 'O5 warning visible');
  assert(/FileCustodian is a hardened reference harness, not production KMS/i.test(text), 'FileCustodian boundary visible');
  assert(!/closes O4|closes O5|production-ready as turnkey|turnkey production-ready/i.test(text), 'does not close gates or overstate readiness');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
