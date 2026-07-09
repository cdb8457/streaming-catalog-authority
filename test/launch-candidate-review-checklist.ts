import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildLaunchCandidateReviewChecklist,
  formatLaunchCandidateReviewChecklistJson,
  formatLaunchCandidateReviewChecklistText,
  type LaunchCandidateReviewChecklist,
} from '../src/ops/launch-candidate-review-checklist.js';
import { buildLaunchCandidateMetadataPacket } from '../src/ops/launch-candidate-metadata-packet.js';

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

function assertChecklistShape(checklist: LaunchCandidateReviewChecklist): void {
  assert(checklist.ok === true, 'ok');
  assert(checklist.report === 'phase-88-launch-candidate-review-checklist', 'report');
  assert(checklist.version === 1, 'version');
  assert(checklist.code === 'LAUNCH_CANDIDATE_REVIEW_CHECKLIST_REPORTED', 'code');
  assert(checklist.status === 'hold-pending-human-review', 'status');
  assert(checklist.launchApproved === false, 'no launch approval');
  assert(checklist.productionReady === false, 'not production ready');
  assert(checklist.releaseCandidateApproved === false, 'no release-candidate approval');
  assert(checklist.closesO4 === false, 'does not close O4');
  assert(checklist.closesO5 === false, 'does not close O5');
  assert(checklist.sourceMetadataPacket === 'phase-87-launch-candidate-metadata-packet', 'source metadata packet');
  assert(checklist.sourceScopeFreeze === 'phase-86-launch-candidate-scope-freeze', 'source scope freeze');
  assert(checklist.packetPurpose === 'static-launch-candidate-review-checklist', 'purpose');
  assert(checklist.checklistRows.length === 5, 'five checklist rows');
  assert(checklist.holdRules.length === 4, 'four hold rules');
  assert(checklist.allowedReviewMaterial.includes('fixed label names'), 'fixed labels allowed');
  assert(checklist.forbiddenMaterial.includes('actual commit ids, tag names, dates, verdicts, counts, conclusions, or evidence values'), 'actual values forbidden');
  assert(checklist.explicitNonGoals.includes('No launch approval.'), 'launch non-goal');
  assert(checklist.explicitNonGoals.includes('No production-readiness approval.'), 'production non-goal');
  assert(checklist.explicitNonGoals.includes('No release-candidate approval.'), 'release-candidate non-goal');
  assert(checklist.explicitNonGoals.includes('No O4 closure.'), 'O4 non-goal');
  assert(checklist.explicitNonGoals.includes('No O5 closure.'), 'O5 non-goal');
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

console.log('Running Phase 88 launch candidate review checklist suite:\n');

test('checklist stays approval-free and source-label only', () => {
  const checklist = buildLaunchCandidateReviewChecklist();
  assertChecklistShape(checklist);
  const rowIds = checklist.checklistRows.map((row) => row.id);
  for (const rowId of ['code-target', 'phase-85-86-87-packets', 'security-gates', 'operator-evidence', 'service-validation']) {
    assert(rowIds.includes(rowId), `row ${rowId}`);
  }
  const labels = checklist.checklistRows.flatMap((row) => [...row.sourceLabels, row.passConditionLabel, ...row.holdConditionLabels]);
  for (const label of [
    'commit-id-label',
    'tag-name-label',
    'o4-decision-label',
    'o5-decision-label',
    'filecustodian-boundary-label',
    'torbox-validation-label',
    'jellyfin-validation-label',
    'usenet-fallback-label',
    'packet-retains-actual-values',
  ]) assert(labels.includes(label), `label ${label}`);
  assertNoForbiddenOutput(JSON.stringify(checklist));
});

test('packet-chain label matches Phase 87 retained metadata label', () => {
  const checklist = buildLaunchCandidateReviewChecklist();
  const metadataPacket = buildLaunchCandidateMetadataPacket();
  const phase87Label = metadataPacket.allowedMetadata
    .find((section) => section.id === 'fixed-release-labels')
    ?.retainAs[0];
  if (typeof phase87Label !== 'string') throw new Error('Phase 87 metadata label is present');
  const expectedPhase87Label: string = phase87Label;
  assert(expectedPhase87Label === 'launch-candidate-metadata.redacted.json', 'Phase 87 expected metadata label');
  const chainRow = checklist.checklistRows.find((row) => row.id === 'phase-85-86-87-packets');
  assert(chainRow?.sourceLabels.includes(expectedPhase87Label), 'Phase 88 uses exact Phase 87 metadata label');
  assert(!chainRow?.sourceLabels.includes('phase-87-launch-candidate-metadata.redacted.json'), 'Phase 88 rejects stale Phase 87 metadata label');
});

test('formatters emit deterministic text and JSON', () => {
  const checklist = buildLaunchCandidateReviewChecklist();
  const json = formatLaunchCandidateReviewChecklistJson(checklist);
  const text = formatLaunchCandidateReviewChecklistText(checklist);
  assertChecklistShape(JSON.parse(json) as LaunchCandidateReviewChecklist);
  for (const line of [
    'Phase 88 launch candidate review checklist',
    'status: hold-pending-human-review',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'closesO4: false',
    'closesO5: false',
    'Checklist rows:',
    'Hold rules:',
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
  const text = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/launch-candidate-review-checklist-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/launch-candidate-review-checklist-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text.includes('launchApproved: false'), 'text launch false');
  assertChecklistShape(JSON.parse(json) as LaunchCandidateReviewChecklist);
  assertNoForbiddenOutput(text);
  assertNoForbiddenOutput(json);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:launch-candidate-review-checklist -- -- --json', {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
    },
    encoding: 'utf8',
  });
  assertChecklistShape(JSON.parse(output) as LaunchCandidateReviewChecklist);
  assertNoForbiddenOutput(output);
});

test('source and docs preserve static review boundary', () => {
  const source = `${read('src/ops/launch-candidate-review-checklist.ts')}\n${read('src/ops/launch-candidate-review-checklist-cli.ts')}`;
  const phase88Surface = `${source}\n${read('docs/PHASE_88_LAUNCH_CANDIDATE_REVIEW_CHECKLIST.md')}`;
  const docs = `${read('docs/PHASE_88_LAUNCH_CANDIDATE_REVIEW_CHECKLIST.md')}\n${read('README.md')}\n${read('package.json')}\n${read('test/deploy.ts')}`;
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
    'Phase 88',
    'Launch Candidate Review Checklist',
    'ops:launch-candidate-review-checklist',
    'test:launch-candidate-review-checklist',
    'npm run --silent ops:launch-candidate-review-checklist -- -- --json',
    'LAUNCH_CANDIDATE_REVIEW_CHECKLIST_REPORTED',
    'phase-87-launch-candidate-metadata-packet',
    'phase-86-launch-candidate-scope-freeze',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'closesO4: false',
    'closesO5: false',
    'O4',
    'O5',
    'FileCustodian',
    'No launch approval',
    'No network calls or live service contact',
  ]) assert(docs.includes(kw), `docs include ${kw}`);

  for (const forbidden of [
    ['allows actual', 'values'].join(' '),
    ['actual commit id is', 'allowed'].join(' '),
    ['launchApproved:', 'true'].join(' '),
    ['productionReady:', 'true'].join(' '),
    ['releaseCandidateApproved:', 'true'].join(' '),
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
  ]) assert(!phase88Surface.includes(forbidden), `Phase 88 source/docs exclude ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
