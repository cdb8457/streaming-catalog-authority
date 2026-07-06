import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildLaunchCandidateMetadataPacket,
  formatLaunchCandidateMetadataJson,
  formatLaunchCandidateMetadataText,
  type LaunchCandidateMetadataPacket,
} from '../src/ops/launch-candidate-metadata-packet.js';

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

function assertPacketShape(packet: LaunchCandidateMetadataPacket): void {
  assert(packet.ok === true, 'ok');
  assert(packet.report === 'phase-87-launch-candidate-metadata-packet', 'report');
  assert(packet.version === 1, 'version');
  assert(packet.code === 'LAUNCH_CANDIDATE_METADATA_PACKET_REPORTED', 'code');
  assert(packet.status === 'review-packet-only', 'status');
  assert(packet.launchApproved === false, 'no launch approval');
  assert(packet.productionReady === false, 'not production ready');
  assert(packet.releaseCandidateApproved === false, 'no release-candidate approval');
  assert(packet.closesO4 === false, 'does not close O4');
  assert(packet.closesO5 === false, 'does not close O5');
  assert(packet.sourceScopeFreeze === 'phase-86-launch-candidate-scope-freeze', 'source scope freeze');
  assert(packet.sourceDecisionRecord === 'phase-85-launch-decision-record-preflight', 'source decision record');
  assert(packet.packetPurpose === 'assemble-static-launch-candidate-review-metadata', 'purpose');
  assert(packet.requiredEvidenceLabels.length === 6, 'six required sections');
  assert(packet.allowedMetadata.length === 2, 'two allowed sections');
  assert(packet.forbiddenMaterial.includes('patch contents'), 'patch contents forbidden');
  assert(packet.reviewerQuestions.some((question) => question.includes('metadata-only')), 'metadata-only question');
  assert(packet.explicitNonGoals.includes('No launch approval.'), 'launch non-goal');
  assert(packet.explicitNonGoals.includes('No production-readiness approval.'), 'production non-goal');
  assert(packet.explicitNonGoals.includes('No release-candidate approval.'), 'release-candidate non-goal');
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

console.log('Running Phase 87 launch candidate metadata packet suite:\n');

test('packet assembles metadata labels without approving launch', () => {
  const packet = buildLaunchCandidateMetadataPacket();
  assertPacketShape(packet);
  const retainLabels = packet.requiredEvidenceLabels.flatMap((section) => section.retainAs);
  for (const label of [
    'launch-candidate-commit-and-tag-target.redacted.md',
    'phase-85-launch-decision-record.redacted.json',
    'phase-86-launch-candidate-scope-freeze.redacted.json',
    '02-external-custodian-o4.redacted.md',
    '03-kek-rotation-o5.redacted.md',
    'torbox-live-validation.redacted.json',
    '07-jellyfin-validation.redacted.md',
    'usenet-fallback-decision.redacted.md',
  ]) assert(retainLabels.includes(label), `retains ${label}`);
  assertNoForbiddenOutput(JSON.stringify(packet));
});

test('allowed metadata is label-name-only, not retained values', () => {
  const packet = buildLaunchCandidateMetadataPacket();
  const output = JSON.stringify(packet);
  for (const labelName of [
    'commit-id-label',
    'tag-name-label',
    'report-name-label',
    'phase-number-label',
    'reviewer-verdict-label',
    'pass-warn-fail-count-label',
    'o4-decision-label',
    'o5-decision-label',
  ]) assert(output.includes(labelName), `label name ${labelName}`);

  for (const forbidden of [
    ['Allowed labels include commit', 'ids'].join(' '),
    ['reviewer verdicts, and pass/warn/fail', 'counts'].join(' '),
    ['reviewed', 'conclusions'].join(' '),
    ['Retain only pass/warn/fail', 'counts'].join(' '),
    ['validation', 'conclusions'].join(' '),
    ['Record whether Usenet', 'fallback'].join('/'),
    ['Record the exact master', 'commit'].join(' '),
    ['Record whether O4 and O5 are', 'proven'].join(' '),
    ['reviewer GO/HOLD', 'label'].join(' '),
    ['date', 's'].join(''),
    ['operator', 'conclusion'].join(' '),
  ]) assert(!output.includes(forbidden), `does not allow retained value class ${forbidden}`);
});

test('formatters emit deterministic redaction-safe text and JSON', () => {
  const packet = buildLaunchCandidateMetadataPacket();
  const json = formatLaunchCandidateMetadataJson(packet);
  const text = formatLaunchCandidateMetadataText(packet);
  assertPacketShape(JSON.parse(json) as LaunchCandidateMetadataPacket);
  for (const line of [
    'Phase 87 launch candidate metadata packet',
    'status: review-packet-only',
    'launchApproved: false',
    'productionReady: false',
    'releaseCandidateApproved: false',
    'closesO4: false',
    'closesO5: false',
    'Required evidence labels:',
    'Forbidden material:',
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
  const text = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/launch-candidate-metadata-packet-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/launch-candidate-metadata-packet-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text.includes('launchApproved: false'), 'text launch false');
  assertPacketShape(JSON.parse(json) as LaunchCandidateMetadataPacket);
  assertNoForbiddenOutput(text);
  assertNoForbiddenOutput(json);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:launch-candidate-metadata-packet -- -- --json', {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
    },
    encoding: 'utf8',
  });
  assertPacketShape(JSON.parse(output) as LaunchCandidateMetadataPacket);
  assertNoForbiddenOutput(output);
});

test('source and docs preserve static launch metadata boundary', () => {
  const source = `${read('src/ops/launch-candidate-metadata-packet.ts')}\n${read('src/ops/launch-candidate-metadata-packet-cli.ts')}`;
  const docs = `${read('docs/PHASE_87_LAUNCH_CANDIDATE_METADATA_PACKET.md')}\n${read('README.md')}\n${read('package.json')}\n${read('test/deploy.ts')}`;
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
    'Phase 87',
    'Launch Candidate Metadata Packet',
    'ops:launch-candidate-metadata-packet',
    'test:launch-candidate-metadata-packet',
    'npm run --silent ops:launch-candidate-metadata-packet -- -- --json',
    'LAUNCH_CANDIDATE_METADATA_PACKET_REPORTED',
    'phase-86-launch-candidate-scope-freeze',
    'phase-85-launch-decision-record-preflight',
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
    ['reviewer verdicts, and pass/warn/fail', 'counts'].join(' '),
    ['Reviewed conclusions', 'that state'].join(' '),
    ['Fixed evidence labels and', 'dates'].join(' '),
    ['only commit ids,', 'tag names'].join(' '),
    ['reviewed', 'conclusions'].join(' '),
    ['Record the exact master', 'commit'].join(' '),
    ['Record whether O4 and O5 are', 'proven'].join(' '),
  ]) assert(!docs.includes(forbidden), `docs exclude broad metadata allowance ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
