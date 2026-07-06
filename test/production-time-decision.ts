import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFinalLaunchDisposition } from '../src/ops/final-launch-disposition.js';
import {
  buildProductionTimeDecision,
  formatProductionTimeDecisionJson,
  formatProductionTimeDecisionText,
  type ProductionTimeDecision,
} from '../src/ops/production-time-decision.js';

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

function assertDecisionShape(decision: ProductionTimeDecision): void {
  assert(decision.ok === true, 'ok');
  assert(decision.report === 'phase-91-production-time-decision', 'report');
  assert(decision.version === 1, 'version');
  assert(decision.code === 'PRODUCTION_TIME_DECISION_RECORDED', 'code');
  assert(decision.status === 'launch-candidate-requested-with-deferred-risk-accepted', 'status');
  assert(decision.launchCandidateDisposition === 'requested-for-review', 'disposition');
  assert(decision.launchCandidateRequested === true, 'launch candidate requested');
  assert(decision.launchApproved === false, 'no launch approval');
  assert(decision.productionReady === false, 'not production ready');
  assert(decision.releaseCandidateApproved === false, 'no release-candidate approval');
  assert(decision.closesO4 === false, 'does not close O4');
  assert(decision.closesO5 === false, 'does not close O5');
  assert(decision.residualRiskAccepted === true, 'residual risk accepted');
  assert(decision.sourceFinalDisposition === 'phase-90-final-launch-disposition', 'source final disposition');
  assert(decision.sourceReviewHandoff === 'phase-89-launch-candidate-review-handoff', 'source handoff');
  assert(decision.sourceReadinessGate === 'phase-22-production-readiness-gate', 'source readiness gate');
  assert(decision.allowedLaunchClaim.includes('launch candidate requested'), 'allowed claim');
  assert(decision.forbiddenLaunchClaim === 'turnkey production ready', 'forbidden claim');
  assert(decision.deferredGates.length === 2, 'two deferred gates');
  assert(decision.deferredGates.every((gate) => gate.closesGate === false), 'no gate closure');
  assert(decision.deferredGates.every((gate) => gate.disposition === 'operator-accepted-deferred-risk'), 'accepted deferred risk');
  assert(decision.requiredOperatorEvidenceLabels.includes('o4-deferred-risk-acceptance-label'), 'O4 label');
  assert(decision.requiredOperatorEvidenceLabels.includes('o5-deferred-risk-acceptance-label'), 'O5 label');
  assert(decision.remainingProductionIssues.some((issue) => issue.includes('O4 is not closed')), 'O4 issue visible');
  assert(decision.remainingProductionIssues.some((issue) => issue.includes('O5 is not closed')), 'O5 issue visible');
  assert(decision.explicitNonGoals.includes('No launch approval.'), 'launch non-goal');
  assert(decision.explicitNonGoals.includes('No production-readiness approval.'), 'production non-goal');
  assert(decision.explicitNonGoals.includes('No release-candidate approval.'), 'release-candidate non-goal');
  assert(decision.explicitNonGoals.includes('No O4 closure.'), 'O4 non-goal');
  assert(decision.explicitNonGoals.includes('No O5 closure.'), 'O5 non-goal');
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

console.log('Running Phase 91 production-time decision suite:\n');

test('decision requests launch-candidate review but never approves launch or closes O4/O5', () => {
  const decision = buildProductionTimeDecision();
  assertDecisionShape(decision);
  const o4 = decision.deferredGates.find((gate) => gate.id === 'o4');
  const o5 = decision.deferredGates.find((gate) => gate.id === 'o5');
  assert(o4?.launchWording.includes('O4 remains open/deferred'), 'O4 wording preserves open gate');
  assert(o5?.launchWording.includes('O5 remains open/deferred'), 'O5 wording preserves open gate');
  assert(o4?.requiredEvidenceToClose.some((item) => item.includes('external custodian')), 'O4 closure evidence listed');
  assert(o5?.requiredEvidenceToClose.some((item) => item.includes('rotation schedule')), 'O5 closure evidence listed');
  assertNoForbiddenOutput(JSON.stringify(decision));
});

test('decision follows Phase 90 and does not mutate the Phase 90 HOLD template', () => {
  const phase90 = buildFinalLaunchDisposition();
  const decision = buildProductionTimeDecision();
  assert(phase90.report === decision.sourceFinalDisposition, 'Phase 91 references exact Phase 90 report');
  assert(phase90.launchDecision === 'hold', 'Phase 90 template remains hold');
  assert(phase90.launchApproved === false && phase90.productionReady === false, 'Phase 90 remains non-approving');
  assert(decision.launchCandidateRequested === true, 'Phase 91 records request separately');
});

test('formatters emit deterministic text and JSON', () => {
  const decision = buildProductionTimeDecision();
  const json = formatProductionTimeDecisionJson(decision);
  const text = formatProductionTimeDecisionText(decision);
  assertDecisionShape(JSON.parse(json) as ProductionTimeDecision);
  for (const line of [
    'Phase 91 production-time decision',
    'status: launch-candidate-requested-with-deferred-risk-accepted',
    'launchCandidateRequested: true',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'closesO4: false',
    'closesO5: false',
    'residualRiskAccepted: true',
    'turnkey production ready',
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
  const text = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/production-time-decision-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/production-time-decision-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text.includes('launchCandidateRequested: true'), 'text launch candidate true');
  assertDecisionShape(JSON.parse(json) as ProductionTimeDecision);
  assertNoForbiddenOutput(text);
  assertNoForbiddenOutput(json);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:production-time-decision -- -- --json', {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
    },
    encoding: 'utf8',
  });
  assertDecisionShape(JSON.parse(output) as ProductionTimeDecision);
  assertNoForbiddenOutput(output);
});

test('source and docs preserve production-time launch boundary', () => {
  const source = `${read('src/ops/production-time-decision.ts')}\n${read('src/ops/production-time-decision-cli.ts')}`;
  const docs = `${read('docs/PHASE_91_PRODUCTION_TIME_DECISION.md')}\n${read('README.md')}\n${read('package.json')}`;
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
    'Phase 91',
    'Production-Time Decision',
    'ops:production-time-decision',
    'test:production-time-decision',
    'PRODUCTION_TIME_DECISION_RECORDED',
    'phase-91-production-time-decision',
    'launchCandidateRequested: true',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'closesO4: false',
    'closesO5: false',
    'residualRiskAccepted: true',
    'turnkey production ready',
    'No launch approval',
    'No network calls or live service contact',
  ]) assert(docs.includes(required), `docs include ${required}`);

  for (const forbidden of [
    ['launchApproved:', 'true'].join(' '),
    ['productionReady:', 'true'].join(' '),
    ['releaseCandidateApproved:', 'true'].join(' '),
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
    ['closesGate:', 'true'].join(' '),
  ]) assert(!source.includes(forbidden), `source excludes approval or closure ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
