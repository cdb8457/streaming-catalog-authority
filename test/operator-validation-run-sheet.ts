import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSemiLaunchValidationPacket } from '../src/ops/semi-launch-validation-packet.js';
import {
  buildOperatorValidationRunSheet,
  formatOperatorValidationRunSheetJson,
  formatOperatorValidationRunSheetText,
  type OperatorValidationRunSheet,
} from '../src/ops/operator-validation-run-sheet.js';

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

function assertSheetShape(sheet: OperatorValidationRunSheet): void {
  assert(sheet.ok === true, 'ok');
  assert(sheet.report === 'phase-94-operator-validation-run-sheet', 'report');
  assert(sheet.version === 1, 'version');
  assert(sheet.code === 'OPERATOR_VALIDATION_RUN_SHEET_RECORDED', 'code');
  assert(sheet.status === 'ready-for-operator-validation', 'status');
  assert(sheet.launchCandidateTagLabel === 'launch-candidate-1', 'launch candidate tag');
  assert(sheet.sourceValidationPacket === 'phase-93-semi-launch-validation-packet', 'source packet');
  assert(sheet.operatorActionRequired === true, 'operator action required');
  assert(sheet.semiLaunchCandidateGo === false, 'no semi-launch GO');
  assert(sheet.operatorEvidenceCollected === false, 'no evidence collected');
  assert(sheet.independentReviewRequired === true, 'review required');
  assert(sheet.launchApproved === false, 'no launch approval');
  assert(sheet.productionReady === false, 'not production ready');
  assert(sheet.releaseCandidateApproved === false, 'no release candidate approval');
  assert(sheet.releaseApproved === false, 'no release approval');
  assert(sheet.closesO4 === false, 'does not close O4');
  assert(sheet.closesO5 === false, 'does not close O5');
  assert(sheet.allowedClaim.includes('semi-launch GO awaits retained evidence'), 'allowed claim');
  assert(sheet.forbiddenClaim === 'operator validation complete', 'forbidden claim');
  assert(sheet.runOrder.length === 10, 'ten run steps');
  assert(sheet.runOrder.every((step) => step.requiredForSemiLaunchGo === true), 'all steps required');
  assert(sheet.runOrder.some((step) => step.evidenceLabel === 'ops-doctor-json-result-label'), 'doctor label');
  assert(sheet.runOrder.some((step) => step.evidenceLabel === 'o4-o5-deferred-risk-acceptance-label'), 'O4/O5 label');
  assert(sheet.reviewerHandoffLabels.includes('clean-checkout-ci-result-label'), 'CI handoff label');
  assert(sheet.holdTriggers.some((trigger) => trigger.includes('reviewer GO is missing')), 'reviewer hold trigger');
  assert(sheet.explicitNonGoals.includes('No operator evidence collection by this command.'), 'no evidence collection');
  assert(sheet.explicitNonGoals.includes('No semi-launch GO.'), 'no GO');
  assert(sheet.explicitNonGoals.includes('No O4 closure.'), 'no O4 closure');
  assert(sheet.explicitNonGoals.includes('No O5 closure.'), 'no O5 closure');
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

console.log('Running Phase 94 operator validation run sheet suite:\n');

test('run sheet is ready for operator validation but grants no GO', () => {
  const sheet = buildOperatorValidationRunSheet();
  assertSheetShape(sheet);
  assertNoForbiddenOutput(JSON.stringify(sheet));
});

test('run sheet follows Phase 93 validation packet exactly', () => {
  const phase93 = buildSemiLaunchValidationPacket();
  const sheet = buildOperatorValidationRunSheet();
  assert(phase93.report === sheet.sourceValidationPacket, 'Phase 94 references exact Phase 93 report');
  assert(phase93.semiLaunchCandidateGo === false, 'Phase 93 remains HOLD');
  assert(sheet.operatorActionRequired === true, 'Phase 94 requires operator action');
});

test('formatters emit deterministic text and JSON', () => {
  const sheet = buildOperatorValidationRunSheet();
  const json = formatOperatorValidationRunSheetJson(sheet);
  const text = formatOperatorValidationRunSheetText(sheet);
  assertSheetShape(JSON.parse(json) as OperatorValidationRunSheet);
  for (const line of [
    'Phase 94 operator validation run sheet',
    'status: ready-for-operator-validation',
    'operatorActionRequired: true',
    'semiLaunchCandidateGo: false',
    'operatorEvidenceCollected: false',
    'independentReviewRequired: true',
    'launchApproved: false',
    'productionReady: false',
    'releaseApproved: false',
    'closesO4: false',
    'closesO5: false',
    'operator validation complete',
    'Run order:',
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
  const text = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/operator-validation-run-sheet-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/operator-validation-run-sheet-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text.includes('operatorActionRequired: true'), 'text action required');
  assertSheetShape(JSON.parse(json) as OperatorValidationRunSheet);
  assertNoForbiddenOutput(text);
  assertNoForbiddenOutput(json);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:operator-validation-run-sheet -- -- --json', {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
    },
    encoding: 'utf8',
  });
  assertSheetShape(JSON.parse(output) as OperatorValidationRunSheet);
  assertNoForbiddenOutput(output);
});

test('source and docs preserve operator validation boundary', () => {
  const source = `${read('src/ops/operator-validation-run-sheet.ts')}\n${read('src/ops/operator-validation-run-sheet-cli.ts')}`;
  const docs = `${read('docs/PHASE_94_OPERATOR_VALIDATION_RUN_SHEET.md')}\n${read('README.md')}\n${read('package.json')}`;
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
    'Phase 94',
    'Operator Validation Run Sheet',
    'ops:operator-validation-run-sheet',
    'test:operator-validation-run-sheet',
    'OPERATOR_VALIDATION_RUN_SHEET_RECORDED',
    'phase-94-operator-validation-run-sheet',
    'operatorActionRequired: true',
    'semiLaunchCandidateGo: false',
    'operatorEvidenceCollected: false',
    'independentReviewRequired: true',
    'launchApproved: false',
    'productionReady: false',
    'releaseApproved: false',
    'closesO4: false',
    'closesO5: false',
    'operator validation complete',
    'No operator evidence collection by this command',
    'No network calls or live service contact',
  ]) assert(docs.includes(required), `docs include ${required}`);

  for (const forbidden of [
    ['semiLaunchCandidateGo:', 'true'].join(' '),
    ['operatorEvidenceCollected:', 'true'].join(' '),
    ['launchApproved:', 'true'].join(' '),
    ['productionReady:', 'true'].join(' '),
    ['releaseApproved:', 'true'].join(' '),
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
  ]) assert(!source.includes(forbidden), `source excludes GO, evidence completion, approval, or closure ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
