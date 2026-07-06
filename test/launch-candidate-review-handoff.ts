import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLaunchCandidateMetadataPacket } from '../src/ops/launch-candidate-metadata-packet.js';
import { buildLaunchCandidateReviewChecklist } from '../src/ops/launch-candidate-review-checklist.js';
import {
  buildLaunchCandidateReviewHandoff,
  formatLaunchCandidateReviewHandoffJson,
  formatLaunchCandidateReviewHandoffText,
  type LaunchCandidateReviewHandoff,
} from '../src/ops/launch-candidate-review-handoff.js';

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

function assertHandoffShape(handoff: LaunchCandidateReviewHandoff): void {
  assert(handoff.ok === true, 'ok');
  assert(handoff.report === 'phase-89-launch-candidate-review-handoff', 'report');
  assert(handoff.version === 1, 'version');
  assert(handoff.code === 'LAUNCH_CANDIDATE_REVIEW_HANDOFF_REPORTED', 'code');
  assert(handoff.status === 'awaiting-independent-review', 'status');
  assert(handoff.launchApproved === false, 'no launch approval');
  assert(handoff.productionReady === false, 'not production ready');
  assert(handoff.releaseCandidateApproved === false, 'no release-candidate approval');
  assert(handoff.closesO4 === false, 'does not close O4');
  assert(handoff.closesO5 === false, 'does not close O5');
  assert(handoff.sourceReviewChecklist === 'phase-88-launch-candidate-review-checklist', 'source checklist');
  assert(handoff.sourceMetadataPacket === 'phase-87-launch-candidate-metadata-packet', 'source metadata packet');
  assert(handoff.packetPurpose === 'static-independent-review-handoff', 'purpose');
  assert(handoff.handoffSections.length === 5, 'five handoff sections');
  assert(handoff.requiredVerdictLabels.includes('reviewer-go-label'), 'go label');
  assert(handoff.requiredVerdictLabels.includes('reviewer-hold-label'), 'hold label');
  assert(handoff.forbiddenMaterial.includes('actual commit ids, tag names, dates, verdicts, counts, conclusions, or evidence values'), 'actual values forbidden');
  assert(handoff.explicitNonGoals.includes('No launch approval.'), 'launch non-goal');
  assert(handoff.explicitNonGoals.includes('No production-readiness approval.'), 'production non-goal');
  assert(handoff.explicitNonGoals.includes('No release-candidate approval.'), 'release-candidate non-goal');
  assert(handoff.explicitNonGoals.includes('No O4 closure.'), 'O4 non-goal');
  assert(handoff.explicitNonGoals.includes('No O5 closure.'), 'O5 non-goal');
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

console.log('Running Phase 89 launch candidate review handoff suite:\n');

test('handoff stays approval-free and label-only', () => {
  const handoff = buildLaunchCandidateReviewHandoff();
  assertHandoffShape(handoff);
  const sectionIds = handoff.handoffSections.map((section) => section.id);
  for (const id of [
    'sealed-target-review',
    'packet-chain-review',
    'security-boundary-review',
    'operator-evidence-review',
    'service-validation-review',
  ]) assert(sectionIds.includes(id), `section ${id}`);

  const labels = handoff.handoffSections.flatMap((section) => [
    ...section.sourceLabels,
    ...section.reviewerQuestionLabels,
    ...section.holdTriggerLabels,
  ]);
  for (const label of [
    'commit-id-label',
    'tag-name-label',
    'launch-candidate-metadata.redacted.json',
    'phase-88-launch-candidate-review-checklist',
    'o4-decision-label',
    'o5-decision-label',
    'filecustodian-boundary-label',
    'torbox-validation-label',
    'jellyfin-validation-label',
    'usenet-fallback-label',
    'provider-payload-label-present',
  ]) assert(labels.includes(label), `label ${label}`);
  assertNoForbiddenOutput(JSON.stringify(handoff));
});

test('handoff points to exact Phase 88 and Phase 87 labels', () => {
  const handoff = buildLaunchCandidateReviewHandoff();
  const checklist = buildLaunchCandidateReviewChecklist();
  const metadataPacket = buildLaunchCandidateMetadataPacket();
  const phase87Label = metadataPacket.allowedMetadata
    .find((section) => section.id === 'fixed-release-labels')
    ?.retainAs[0];
  if (typeof phase87Label !== 'string') throw new Error('Phase 87 metadata label is present');
  assert(phase87Label === 'launch-candidate-metadata.redacted.json', 'Phase 87 metadata label');
  assert(checklist.report === handoff.sourceReviewChecklist, 'Phase 89 references exact Phase 88 report');
  const packetChain = handoff.handoffSections.find((section) => section.id === 'packet-chain-review');
  assert(packetChain?.sourceLabels.includes(phase87Label), 'Phase 89 uses exact Phase 87 metadata label');
  assert(packetChain?.sourceLabels.includes(checklist.report), 'Phase 89 uses exact Phase 88 checklist label');
  assert(!packetChain?.sourceLabels.includes('phase-87-launch-candidate-metadata.redacted.json'), 'rejects stale Phase 87 metadata label');
});

test('formatters emit deterministic text and JSON', () => {
  const handoff = buildLaunchCandidateReviewHandoff();
  const json = formatLaunchCandidateReviewHandoffJson(handoff);
  const text = formatLaunchCandidateReviewHandoffText(handoff);
  assertHandoffShape(JSON.parse(json) as LaunchCandidateReviewHandoff);
  for (const line of [
    'Phase 89 launch candidate review handoff',
    'status: awaiting-independent-review',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'closesO4: false',
    'closesO5: false',
    'Handoff sections:',
    'Reviewer instructions:',
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
  const text = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/launch-candidate-review-handoff-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/launch-candidate-review-handoff-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text.includes('launchApproved: false'), 'text launch false');
  assertHandoffShape(JSON.parse(json) as LaunchCandidateReviewHandoff);
  assertNoForbiddenOutput(text);
  assertNoForbiddenOutput(json);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:launch-candidate-review-handoff -- -- --json', {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
    },
    encoding: 'utf8',
  });
  assertHandoffShape(JSON.parse(output) as LaunchCandidateReviewHandoff);
  assertNoForbiddenOutput(output);
});

test('source and docs preserve static handoff boundary', () => {
  const source = `${read('src/ops/launch-candidate-review-handoff.ts')}\n${read('src/ops/launch-candidate-review-handoff-cli.ts')}`;
  const phase89Doc = read('docs/PHASE_89_LAUNCH_CANDIDATE_REVIEW_HANDOFF.md');
  const docs = `${phase89Doc}\n${read('README.md')}\n${read('package.json')}`;
  const phase89Surface = `${source}\n${phase89Doc}`;
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
    'Phase 89',
    'Launch Candidate Review Handoff',
    'ops:launch-candidate-review-handoff',
    'test:launch-candidate-review-handoff',
    'npm run --silent ops:launch-candidate-review-handoff -- -- --json',
    'LAUNCH_CANDIDATE_REVIEW_HANDOFF_REPORTED',
    'phase-88-launch-candidate-review-checklist',
    'phase-87-launch-candidate-metadata-packet',
    'launch-candidate-metadata.redacted.json',
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
    'phase-87-launch-candidate-metadata.redacted.json',
    ['closed', 'without'].join(' '),
    ['residual-risk', 'acceptance'].join(' '),
    ['separately reviewed', 'evidence'].join(' '),
    ['allows actual', 'values'].join(' '),
    ['launchApproved:', 'true'].join(' '),
    ['productionReady:', 'true'].join(' '),
    ['releaseCandidateApproved:', 'true'].join(' '),
    ['closesO4:', 'true'].join(' '),
    ['closesO5:', 'true'].join(' '),
  ]) assert(!phase89Surface.includes(forbidden), `Phase 89 source/docs exclude ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
