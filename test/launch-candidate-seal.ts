import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildProductionTimeDecision } from '../src/ops/production-time-decision.js';
import {
  buildLaunchCandidateSeal,
  formatLaunchCandidateSealJson,
  formatLaunchCandidateSealText,
  type LaunchCandidateSeal,
} from '../src/ops/launch-candidate-seal.js';

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

function assertSealShape(seal: LaunchCandidateSeal): void {
  assert(seal.ok === true, 'ok');
  assert(seal.report === 'phase-92-launch-candidate-seal', 'report');
  assert(seal.version === 1, 'version');
  assert(seal.code === 'LAUNCH_CANDIDATE_SEAL_RECORDED', 'code');
  assert(seal.status === 'sealed-for-launch-candidate-review', 'status');
  assert(seal.launchCandidateTagLabel === 'launch-candidate-1', 'launch candidate tag label');
  assert(seal.phaseTagLabel === 'phase-92', 'phase tag label');
  assert(seal.launchCandidateSealed === true, 'launch candidate sealed');
  assert(seal.launchApproved === false, 'no launch approval');
  assert(seal.productionReady === false, 'not production ready');
  assert(seal.releaseCandidateApproved === false, 'no release-candidate approval');
  assert(seal.releaseApproved === false, 'no release approval');
  assert(seal.closesO4 === false, 'does not close O4');
  assert(seal.closesO5 === false, 'does not close O5');
  assert(seal.residualRiskAccepted === true, 'residual risk accepted');
  assert(seal.sourceProductionDecision === 'phase-91-production-time-decision', 'source production decision');
  assert(seal.sourceFinalDisposition === 'phase-90-final-launch-disposition', 'source final disposition');
  assert(seal.sourceReviewHandoff === 'phase-89-launch-candidate-review-handoff', 'source review handoff');
  assert(seal.allowedClaim.includes('launch candidate sealed for review'), 'allowed claim');
  assert(seal.forbiddenClaim === 'production release approved', 'forbidden claim');
  assert(seal.requiredRefChecks.some((check) => check.includes('launch-candidate-1')), 'LC ref check');
  assert(seal.requiredValidationChecks.includes('npm run ci'), 'CI required');
  assert(seal.launchCandidateBoundaries.some((boundary) => boundary.includes('not a production release')), 'production-release boundary');
  assert(seal.launchCandidateBoundaries.some((boundary) => boundary.includes('O4 remains open/deferred')), 'O4 boundary');
  assert(seal.launchCandidateBoundaries.some((boundary) => boundary.includes('O5 remains open/deferred')), 'O5 boundary');
  assert(seal.remainingProductionIssues.some((issue) => issue.includes('O4 still needs')), 'O4 issue visible');
  assert(seal.remainingProductionIssues.some((issue) => issue.includes('O5 still needs')), 'O5 issue visible');
  assert(seal.explicitNonGoals.includes('No launch approval.'), 'launch non-goal');
  assert(seal.explicitNonGoals.includes('No production-readiness approval.'), 'production non-goal');
  assert(seal.explicitNonGoals.includes('No release-candidate approval.'), 'release-candidate non-goal');
  assert(seal.explicitNonGoals.includes('No production release approval.'), 'release non-goal');
  assert(seal.explicitNonGoals.includes('No O4 closure.'), 'O4 non-goal');
  assert(seal.explicitNonGoals.includes('No O5 closure.'), 'O5 non-goal');
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

console.log('Running Phase 92 launch candidate seal suite:\n');

test('seal records launch-candidate state without approval or O4/O5 closure', () => {
  const seal = buildLaunchCandidateSeal();
  assertSealShape(seal);
  assertNoForbiddenOutput(JSON.stringify(seal));
});

test('seal follows Phase 91 production-time decision exactly', () => {
  const phase91 = buildProductionTimeDecision();
  const seal = buildLaunchCandidateSeal();
  assert(phase91.report === seal.sourceProductionDecision, 'Phase 92 references exact Phase 91 report');
  assert(phase91.launchCandidateRequested === true, 'Phase 91 requested launch candidate');
  assert(phase91.launchApproved === false && phase91.productionReady === false, 'Phase 91 remains non-approving');
  assert(seal.launchCandidateSealed === true, 'Phase 92 seal is separate');
});

test('formatters emit deterministic text and JSON', () => {
  const seal = buildLaunchCandidateSeal();
  const json = formatLaunchCandidateSealJson(seal);
  const text = formatLaunchCandidateSealText(seal);
  assertSealShape(JSON.parse(json) as LaunchCandidateSeal);
  for (const line of [
    'Phase 92 launch candidate seal',
    'status: sealed-for-launch-candidate-review',
    'phaseTagLabel: phase-92',
    'launchCandidateTagLabel: launch-candidate-1',
    'launchCandidateSealed: true',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'releaseApproved: false',
    'closesO4: false',
    'closesO5: false',
    'production release approved',
    'Remaining production issues:',
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
    TORBOX_TOKEN: 'TOKEN_VALUE_SENTINEL',
    PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL',
    RAW_REF: 'RAW_REF_SENTINEL',
  };
  const text = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/launch-candidate-seal-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/launch-candidate-seal-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text.includes('launchCandidateSealed: true'), 'text launch candidate true');
  assertSealShape(JSON.parse(json) as LaunchCandidateSeal);
  assertNoForbiddenOutput(text);
  assertNoForbiddenOutput(json);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:launch-candidate-seal -- -- --json', {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
    },
    encoding: 'utf8',
  });
  assertSealShape(JSON.parse(output) as LaunchCandidateSeal);
  assertNoForbiddenOutput(output);
});

test('source and docs preserve launch-candidate seal boundary', () => {
  const source = `${read('src/ops/launch-candidate-seal.ts')}\n${read('src/ops/launch-candidate-seal-cli.ts')}`;
  const docs = `${read('docs/PHASE_92_LAUNCH_CANDIDATE_SEAL.md')}\n${read('README.md')}\n${read('package.json')}`;
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
    'Phase 92',
    'Launch Candidate Seal',
    'ops:launch-candidate-seal',
    'test:launch-candidate-seal',
    'LAUNCH_CANDIDATE_SEAL_RECORDED',
    'phase-92-launch-candidate-seal',
    'launchCandidateSealed: true',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'releaseApproved: false',
    'closesO4: false',
    'closesO5: false',
    'residualRiskAccepted: true',
    'launch-candidate-1',
    'production release approved',
    'No launch approval',
    'No network calls or live service contact',
  ]) assert(docs.includes(required), `docs include ${required}`);

  for (const forbidden of [
    ['launchApproved:', 'true'].join(' '),
    ['productionReady:', 'true'].join(' '),
    ['releaseCandidateApproved:', 'true'].join(' '),
    ['releaseApproved:', 'true'].join(' '),
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
  ]) assert(!source.includes(forbidden), `source excludes approval or closure ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
