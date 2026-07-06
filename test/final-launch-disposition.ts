import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLaunchCandidateReviewHandoff } from '../src/ops/launch-candidate-review-handoff.js';
import {
  buildFinalLaunchDisposition,
  formatFinalLaunchDispositionJson,
  formatFinalLaunchDispositionText,
  type FinalLaunchDisposition,
} from '../src/ops/final-launch-disposition.js';

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

function assertDispositionShape(disposition: FinalLaunchDisposition): void {
  assert(disposition.ok === true, 'ok');
  assert(disposition.report === 'phase-90-final-launch-disposition', 'report');
  assert(disposition.version === 1, 'version');
  assert(disposition.code === 'FINAL_LAUNCH_DISPOSITION_REPORTED', 'code');
  assert(disposition.status === 'hold-pending-operator-decision', 'status');
  assert(disposition.launchDecision === 'hold', 'default hold');
  assert(disposition.launchApproved === false, 'no launch approval');
  assert(disposition.productionReady === false, 'not production ready');
  assert(disposition.releaseCandidateApproved === false, 'no release-candidate approval');
  assert(disposition.closesO4 === false, 'does not close O4');
  assert(disposition.closesO5 === false, 'does not close O5');
  assert(disposition.sourceReviewHandoff === 'phase-89-launch-candidate-review-handoff', 'source handoff');
  assert(disposition.sourceReviewChecklist === 'phase-88-launch-candidate-review-checklist', 'source checklist');
  assert(disposition.packetPurpose === 'static-final-launch-disposition-template', 'purpose');
  assert(disposition.requiredDecisionLabels.includes('operator-final-decision-label'), 'operator decision label');
  assert(disposition.requiredDecisionLabels.includes('o4-disposition-label'), 'O4 disposition label');
  assert(disposition.requiredDecisionLabels.includes('o5-disposition-label'), 'O5 disposition label');
  assert(disposition.gateDispositions.length === 2, 'two gate dispositions');
  assert(disposition.gateDispositions.every((gate) => gate.closesGate === false), 'no gate closure');
  assert(disposition.finalHoldTriggers.some((trigger) => trigger.includes('claimed closed')), 'closed gate hold trigger');
  assert(disposition.permittedOperatorDecisions.includes('hold'), 'hold decision allowed');
  assert(disposition.forbiddenMaterial.includes('actual commit ids, tag names, dates, verdicts, counts, conclusions, or evidence values'), 'actual values forbidden');
  assert(disposition.explicitNonGoals.includes('No launch approval.'), 'launch non-goal');
  assert(disposition.explicitNonGoals.includes('No production-readiness approval.'), 'production non-goal');
  assert(disposition.explicitNonGoals.includes('No release-candidate approval.'), 'release-candidate non-goal');
  assert(disposition.explicitNonGoals.includes('No O4 closure.'), 'O4 non-goal');
  assert(disposition.explicitNonGoals.includes('No O5 closure.'), 'O5 non-goal');
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

console.log('Running Phase 90 final launch disposition suite:\n');

test('disposition defaults to HOLD and does not close O4/O5', () => {
  const disposition = buildFinalLaunchDisposition();
  assertDispositionShape(disposition);
  const o4 = disposition.gateDispositions.find((gate) => gate.id === 'o4');
  const o5 = disposition.gateDispositions.find((gate) => gate.id === 'o5');
  assert(o4?.disposition === 'hold' && o4.closesGate === false, 'O4 hold and open');
  assert(o5?.disposition === 'hold' && o5.closesGate === false, 'O5 hold and open');
  assert(o4?.holdIfMissingLabels.includes('o4-operator-risk-decision-label'), 'O4 risk label required');
  assert(o5?.holdIfMissingLabels.includes('o5-operator-risk-decision-label'), 'O5 risk label required');
  assertNoForbiddenOutput(JSON.stringify(disposition));
});

test('disposition references Phase 89 handoff exactly', () => {
  const disposition = buildFinalLaunchDisposition();
  const handoff = buildLaunchCandidateReviewHandoff();
  assert(handoff.report === disposition.sourceReviewHandoff, 'Phase 90 references exact Phase 89 report');
  assert(handoff.sourceReviewChecklist === disposition.sourceReviewChecklist, 'Phase 90 carries Phase 88 checklist label');
});

test('formatters emit deterministic text and JSON', () => {
  const disposition = buildFinalLaunchDisposition();
  const json = formatFinalLaunchDispositionJson(disposition);
  const text = formatFinalLaunchDispositionText(disposition);
  assertDispositionShape(JSON.parse(json) as FinalLaunchDisposition);
  for (const line of [
    'Phase 90 final launch disposition',
    'status: hold-pending-operator-decision',
    'launchDecision: hold',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'closesO4: false',
    'closesO5: false',
    'Gate dispositions:',
    'No launch approval.',
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
  const text = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/final-launch-disposition-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/final-launch-disposition-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text.includes('launchApproved: false'), 'text launch false');
  assertDispositionShape(JSON.parse(json) as FinalLaunchDisposition);
  assertNoForbiddenOutput(text);
  assertNoForbiddenOutput(json);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:final-launch-disposition -- -- --json', {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
    },
    encoding: 'utf8',
  });
  assertDispositionShape(JSON.parse(output) as FinalLaunchDisposition);
  assertNoForbiddenOutput(output);
});

test('source and docs preserve static final disposition boundary', () => {
  const source = `${read('src/ops/final-launch-disposition.ts')}\n${read('src/ops/final-launch-disposition-cli.ts')}`;
  const phase90Doc = read('docs/PHASE_90_FINAL_LAUNCH_DISPOSITION.md');
  const docs = `${phase90Doc}\n${read('README.md')}\n${read('package.json')}`;
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
    'Phase 90',
    'Final Launch Disposition',
    'ops:final-launch-disposition',
    'test:final-launch-disposition',
    'npm run --silent ops:final-launch-disposition -- -- --json',
    'FINAL_LAUNCH_DISPOSITION_REPORTED',
    'phase-89-launch-candidate-review-handoff',
    'phase-88-launch-candidate-review-checklist',
    'launchDecision: hold',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'closesO4: false',
    'closesO5: false',
    'O4',
    'O5',
    'No launch approval',
    'No network calls or live service contact',
  ]) assert(docs.includes(kw), `docs include ${kw}`);

  const phase90Surface = `${source}\n${phase90Doc}`;
  for (const forbidden of [
    ['launchApproved:', 'true'].join(' '),
    ['productionReady:', 'true'].join(' '),
    ['releaseCandidateApproved:', 'true'].join(' '),
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
    ['closesGate:', 'true'].join(' '),
    ['production', 'ready'].join('-'),
    ['allows actual', 'values'].join(' '),
  ]) assert(!phase90Surface.includes(forbidden), `Phase 90 source/docs exclude ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
