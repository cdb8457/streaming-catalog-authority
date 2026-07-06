import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildLaunchCandidateScopeFreezePacket,
  formatLaunchCandidateScopeFreezeJson,
  formatLaunchCandidateScopeFreezeText,
  type LaunchCandidateScopeFreezePacket,
} from '../src/ops/launch-candidate-scope-freeze.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push([name, err]);
    console.log(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

function assertNoForbiddenOutput(output: string): void {
  for (const forbidden of [
    'SECRET_VALUE_SENTINEL',
    'DATABASE_URL_SENTINEL',
    'TOKEN_VALUE_SENTINEL',
    'PRIVATE_TITLE_SENTINEL',
    'RAW_REF_SENTINEL',
    'INFOHASH_SENTINEL',
    'MAGNET_SENTINEL',
    'credential-file-contents',
    'provider payload body',
    'postgres://',
    'http://localhost',
    'https://api',
    'Authorization',
    'Bearer ',
    'Basic ',
    'OAuth',
  ]) assert(!output.includes(forbidden), `output leaks ${forbidden}`);
}

function assertPacketShape(packet: LaunchCandidateScopeFreezePacket): void {
  assert(packet.ok === true, 'ok marker');
  assert(packet.report === 'phase-86-launch-candidate-scope-freeze', 'report name');
  assert(packet.version === 1, 'version');
  assert(packet.code === 'LAUNCH_CANDIDATE_SCOPE_FREEZE_REPORTED', 'code');
  assert(packet.status === 'blocked-pending-operator-decision', 'blocked pending decision');
  assert(packet.launchApproved === false, 'does not approve launch');
  assert(packet.productionReady === false, 'does not claim production ready');
  assert(packet.closesO4 === false, 'does not close O4');
  assert(packet.closesO5 === false, 'does not close O5');
  assert(packet.sourceDecisionRecord === 'phase-85-launch-decision-record-preflight', 'source decision record');
  assert(packet.sourceAcceptancePacket === 'phase-84-operator-acceptance-packet', 'source acceptance packet');
  assert(packet.packetPurpose === 'freeze-future-launch-candidate-phase-scope', 'purpose');
  assert(packet.requiredBeforeLaunchCandidate.length === 3, 'required sections');
  assert(packet.allowedLaunchCandidateWork.length === 3, 'allowed sections');
  assert(packet.forbiddenLaunchCandidateWork.length === 3, 'forbidden sections');
  assert(packet.reviewerRequiredWhen.some((rule) => rule.includes('launch')), 'reviewer launch rule');
  assert(packet.holdConditions.some((condition) => condition.includes('productionReady true')), 'hold productionReady');
  assert(packet.holdConditions.some((condition) => condition.includes('O4/O5')), 'hold O4/O5');
  assert(packet.explicitNonGoals.includes('No launch approval.'), 'non-goal launch approval');
  assert(packet.explicitNonGoals.includes('No production-readiness approval.'), 'non-goal production readiness');
  assert(packet.explicitNonGoals.includes('No O4 closure.'), 'non-goal O4');
  assert(packet.explicitNonGoals.includes('No O5 closure.'), 'non-goal O5');
}

console.log('Running Phase 86 launch candidate scope freeze suite:\n');

test('packet freezes launch-candidate scope without approving launch', () => {
  const packet = buildLaunchCandidateScopeFreezePacket();
  assertPacketShape(packet);
  assert(packet.forbiddenLaunchCandidateWork.some((item) => item.id === 'runtime-expansion'), 'runtime expansion forbidden');
  assert(packet.forbiddenLaunchCandidateWork.some((item) => item.id === 'provider-or-media-expansion'), 'provider expansion forbidden');
  assert(packet.forbiddenLaunchCandidateWork.some((item) => item.id === 'security-gate-softening'), 'security softening forbidden');
  assertNoForbiddenOutput(JSON.stringify(packet));
});

test('formatters emit deterministic redaction-safe text and JSON', () => {
  const packet = buildLaunchCandidateScopeFreezePacket();
  const json = formatLaunchCandidateScopeFreezeJson(packet);
  const text = formatLaunchCandidateScopeFreezeText(packet);
  assertPacketShape(JSON.parse(json) as LaunchCandidateScopeFreezePacket);
  for (const line of [
    'Phase 86 launch candidate scope freeze',
    'status: blocked-pending-operator-decision',
    'launchApproved: false',
    'productionReady: false',
    'closesO4: false',
    'closesO5: false',
    'Required before launch candidate:',
    'Forbidden launch-candidate work:',
    'No launch approval.',
  ]) assert(text.includes(line), `text includes ${line}`);
  assert(text.endsWith('\n'), 'text newline');
  assertNoForbiddenOutput(json);
  assertNoForbiddenOutput(text);
});

test('CLI text and JSON modes are static and redaction-safe', () => {
  const env = {
    ...process.env,
    SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
    DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
    TORBOX_TOKEN: 'TOKEN_VALUE_SENTINEL',
    PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL',
    RAW_REF: 'RAW_REF_SENTINEL',
  };
  const text = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/launch-candidate-scope-freeze-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/launch-candidate-scope-freeze-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text.includes('launchApproved: false'), 'text launch false');
  assertPacketShape(JSON.parse(json) as LaunchCandidateScopeFreezePacket);
  assertNoForbiddenOutput(text);
  assertNoForbiddenOutput(json);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:launch-candidate-scope-freeze -- -- --json', {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
    },
    encoding: 'utf8',
  });
  assertPacketShape(JSON.parse(output) as LaunchCandidateScopeFreezePacket);
  assertNoForbiddenOutput(output);
});

test('source and docs preserve static launch-candidate boundary', () => {
  const source = `${read('src/ops/launch-candidate-scope-freeze.ts')}\n${read('src/ops/launch-candidate-scope-freeze-cli.ts')}`;
  const docs = `${read('docs/PHASE_86_LAUNCH_CANDIDATE_SCOPE_FREEZE.md')}\n${read('README.md')}\n${read('package.json')}\n${read('test/deploy.ts')}`;
  for (const forbidden of [
    "from 'pg'",
    'from "pg"',
    'node:https',
    'node:http',
    'node:net',
    'node:fs',
    'globalThis.fetch',
    'fetch(',
    'process.env',
    'readFile',
    'writeFile',
    'createWriteStream',
    'readdirSync',
    'existsSync',
    'execFileSync',
    'spawnSync',
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
    'createRealJellyfinClient',
    'createRealTorBox',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);

  for (const kw of [
    'Phase 86',
    'Launch Candidate Scope Freeze',
    'ops:launch-candidate-scope-freeze',
    'test:launch-candidate-scope-freeze',
    'npm run --silent ops:launch-candidate-scope-freeze -- -- --json',
    'LAUNCH_CANDIDATE_SCOPE_FREEZE_REPORTED',
    'phase-85-launch-decision-record-preflight',
    'phase-84-operator-acceptance-packet',
    'launchApproved: false',
    'productionReady: false',
    'closesO4: false',
    'closesO5: false',
    'O4',
    'O5',
    'FileCustodian',
    'No launch approval',
    'No network calls or live service contact',
  ]) assert(docs.includes(kw), `docs include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
