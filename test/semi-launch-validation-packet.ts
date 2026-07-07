import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLaunchCandidateSeal } from '../src/ops/launch-candidate-seal.js';
import {
  buildSemiLaunchValidationPacket,
  formatSemiLaunchValidationPacketJson,
  formatSemiLaunchValidationPacketText,
  type SemiLaunchValidationPacket,
} from '../src/ops/semi-launch-validation-packet.js';

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

function assertPacketShape(packet: SemiLaunchValidationPacket): void {
  assert(packet.ok === true, 'ok');
  assert(packet.report === 'phase-93-semi-launch-validation-packet', 'report');
  assert(packet.version === 1, 'version');
  assert(packet.code === 'SEMI_LAUNCH_VALIDATION_PACKET_RECORDED', 'code');
  assert(packet.status === 'hold-pending-operator-evidence', 'status');
  assert(packet.launchCandidateTagLabel === 'launch-candidate-1', 'launch candidate tag label');
  assert(packet.phaseTagLabel === 'phase-93', 'phase tag label');
  assert(packet.sourceLaunchCandidateSeal === 'phase-92-launch-candidate-seal', 'source seal');
  assert(packet.sourceProductionDecision === 'phase-91-production-time-decision', 'source decision');
  assert(packet.semiLaunchCandidateVerdict === 'hold', 'verdict hold');
  assert(packet.semiLaunchCandidateGo === false, 'no semi-launch GO');
  assert(packet.launchApproved === false, 'no launch approval');
  assert(packet.productionReady === false, 'not production ready');
  assert(packet.releaseCandidateApproved === false, 'no release-candidate approval');
  assert(packet.releaseApproved === false, 'no release approval');
  assert(packet.closesO4 === false, 'does not close O4');
  assert(packet.closesO5 === false, 'does not close O5');
  assert(packet.residualRiskAccepted === true, 'residual risk accepted');
  assert(packet.repoValidationExpected === true, 'repo validation expected');
  assert(packet.operatorEvidenceCollected === false, 'operator evidence not collected');
  assert(packet.independentReviewRequired === true, 'review required');
  assert(packet.allowedClaim.includes('pending operator evidence review'), 'allowed claim');
  assert(packet.forbiddenClaim === 'semi-launch candidate approved', 'forbidden claim');
  assert(packet.requiredOperatorEvidenceLabels.includes('ops-doctor-json-result-label'), 'doctor label');
  assert(packet.requiredOperatorEvidenceLabels.includes('o4-deferred-risk-acceptance-label'), 'O4 label');
  assert(packet.requiredOperatorEvidenceLabels.includes('o5-deferred-risk-acceptance-label'), 'O5 label');
  assert(packet.validationGates.some((gate) => gate.id === 'operator-evidence' && gate.requiredForGo), 'operator gate');
  assert(packet.validationGates.some((gate) => gate.id === 'o4' && gate.status === 'accepted-deferred-risk'), 'O4 deferred');
  assert(packet.validationGates.some((gate) => gate.id === 'o5' && gate.status === 'accepted-deferred-risk'), 'O5 deferred');
  assert(packet.holdTriggers.some((trigger) => trigger.includes('operator evidence label is missing')), 'missing evidence hold');
  assert(packet.goConditions.some((condition) => condition.includes('Independent reviewer records GO')), 'review GO condition');
  assert(packet.remainingProductionIssues.some((issue) => issue.includes('Semi-launch GO cannot be recorded')), 'GO not recorded');
  assert(packet.explicitNonGoals.includes('No semi-launch GO.'), 'semi-launch non-goal');
  assert(packet.explicitNonGoals.includes('No launch approval.'), 'launch non-goal');
  assert(packet.explicitNonGoals.includes('No production-readiness approval.'), 'production non-goal');
  assert(packet.explicitNonGoals.includes('No O4 closure.'), 'O4 non-goal');
  assert(packet.explicitNonGoals.includes('No O5 closure.'), 'O5 non-goal');
}

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

console.log('Running Phase 93 semi-launch validation packet suite:\n');

test('packet defaults to HOLD pending operator evidence and review', () => {
  const packet = buildSemiLaunchValidationPacket();
  assertPacketShape(packet);
  assertNoForbiddenOutput(JSON.stringify(packet));
});

test('packet follows Phase 92 launch candidate seal exactly', () => {
  const phase92 = buildLaunchCandidateSeal();
  const packet = buildSemiLaunchValidationPacket();
  assert(phase92.report === packet.sourceLaunchCandidateSeal, 'Phase 93 references exact Phase 92 report');
  assert(phase92.launchCandidateSealed === true, 'Phase 92 sealed launch candidate');
  assert(phase92.launchApproved === false && phase92.productionReady === false, 'Phase 92 remains non-approving');
  assert(packet.semiLaunchCandidateGo === false, 'Phase 93 does not grant GO');
});

test('formatters emit deterministic text and JSON', () => {
  const packet = buildSemiLaunchValidationPacket();
  const json = formatSemiLaunchValidationPacketJson(packet);
  const text = formatSemiLaunchValidationPacketText(packet);
  assertPacketShape(JSON.parse(json) as SemiLaunchValidationPacket);
  for (const line of [
    'Phase 93 semi-launch validation packet',
    'status: hold-pending-operator-evidence',
    'semiLaunchCandidateVerdict: hold',
    'semiLaunchCandidateGo: false',
    'launchCandidateTagLabel: launch-candidate-1',
    'phaseTagLabel: phase-93',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'releaseApproved: false',
    'closesO4: false',
    'closesO5: false',
    'operatorEvidenceCollected: false',
    'semi-launch candidate approved',
    'GO conditions:',
  ]) assert(text.includes(line), `text includes ${line}`);
  assert(text.endsWith('\n'), 'text newline');
  assertNoForbiddenOutput(json);
  assertNoForbiddenOutput(text);
});

test('CLI text and JSON modes do not read hostile environment values', () => {
  const env = {
    ...process.env,
    SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
    DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
    PROVIDER_TOKEN: 'TOKEN_VALUE_SENTINEL',
    PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL',
    RAW_REF: 'RAW_REF_SENTINEL',
  };
  const text = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/semi-launch-validation-packet-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/semi-launch-validation-packet-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text.includes('semiLaunchCandidateGo: false'), 'text GO false');
  assertPacketShape(JSON.parse(json) as SemiLaunchValidationPacket);
  assertNoForbiddenOutput(text);
  assertNoForbiddenOutput(json);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:semi-launch-validation-packet -- -- --json', {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
    },
    encoding: 'utf8',
  });
  assertPacketShape(JSON.parse(output) as SemiLaunchValidationPacket);
  assertNoForbiddenOutput(output);
});

test('source and docs preserve semi-launch validation boundary', () => {
  const source = `${read('src/ops/semi-launch-validation-packet.ts')}\n${read('src/ops/semi-launch-validation-packet-cli.ts')}`;
  const docs = `${read('docs/PHASE_93_SEMI_LAUNCH_VALIDATION_PACKET.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const forbidden of [
    "from 'pg'",
    'from "pg"',
    'node:https',
    'node:http',
    'node:net',
    'node:dns',
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

  for (const required of [
    'Phase 93',
    'Semi-Launch Validation Packet',
    'ops:semi-launch-validation-packet',
    'test:semi-launch-validation-packet',
    'SEMI_LAUNCH_VALIDATION_PACKET_RECORDED',
    'phase-93-semi-launch-validation-packet',
    'semiLaunchCandidateVerdict: hold',
    'semiLaunchCandidateGo: false',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'releaseApproved: false',
    'closesO4: false',
    'closesO5: false',
    'operatorEvidenceCollected: false',
    'independentReviewRequired: true',
    'launch-candidate-1',
    'phase-93',
    'semi-launch candidate approved',
    'No semi-launch GO',
    'No network calls or live service contact',
  ]) assert(docs.includes(required), `docs include ${required}`);

  for (const forbidden of [
    ['semiLaunchCandidateGo:', 'true'].join(' '),
    ['launchApproved:', 'true'].join(' '),
    ['productionReady:', 'true'].join(' '),
    ['releaseCandidateApproved:', 'true'].join(' '),
    ['releaseApproved:', 'true'].join(' '),
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
  ]) assert(!source.includes(forbidden), `source excludes GO, approval, or closure ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
