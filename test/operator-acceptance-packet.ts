import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildOperatorAcceptancePacket,
  formatOperatorAcceptancePacketJson,
  formatOperatorAcceptancePacketText,
  type OperatorAcceptancePacket,
} from '../src/ops/operator-acceptance-packet.js';

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

function requireSection(packet: OperatorAcceptancePacket, id: OperatorAcceptancePacket['sections'][number]['id']): OperatorAcceptancePacket['sections'][number] {
  const section = packet.sections.find((candidate) => candidate.id === id);
  if (section === undefined) throw new Error(`missing ${id}`);
  return section;
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
    'postgres://',
    'http://localhost',
    'https://api',
    'credential-file-contents',
    'provider payload body',
    'localStorage',
    'sessionStorage',
    'Authorization',
    'Bearer ',
    'Basic ',
    'OAuth',
  ]) assert(!output.includes(forbidden), `output leaks ${forbidden}`);
}

function assertPacketShape(packet: OperatorAcceptancePacket): void {
  assert(packet.ok === true, 'ok marker');
  assert(packet.report === 'phase-84-operator-acceptance-packet', 'report name');
  assert(packet.version === 1, 'version');
  assert(packet.code === 'OPERATOR_ACCEPTANCE_PACKET_REPORTED', 'code');
  assert(packet.status === 'blocked', 'blocked');
  assert(packet.launchReady === false, 'not launch ready');
  assert(packet.packetPurpose === 'operator-run-redaction-safe-launch-acceptance', 'purpose');
  assert(packet.sourceAudit === 'phase-83-launch-gate-audit', 'source audit');
  assert(packet.sections.length === 4, 'four sections');

  const security = requireSection(packet, 'production-security-decision');
  assert(security.status === 'blocked', 'security decision blocked');
  assert(security.commandPlan.includes('npm run test:custodian-acceptance'), 'custodian command');
  assert(security.reviewQuestions.some((question) => question.includes('O4')), 'O4 question');
  assert(security.reviewQuestions.some((question) => question.includes('O5')), 'O5 question');

  const rehearsal = requireSection(packet, 'unraid-operator-rehearsal');
  assert(rehearsal.status === 'operator-required', 'operator rehearsal required');
  assert(rehearsal.commandPlan.includes('npm run ops:operator-ui-auth-packet-acceptance -- -- --json'), 'Phase 82 command');

  const validation = requireSection(packet, 'live-service-validation');
  assert(validation.status === 'operator-required', 'live validation required');
  assert(validation.commandPlan.some((command) => command.includes('smoke:torbox-readonly')), 'TorBox command');
  assert(validation.commandPlan.some((command) => command.includes('smoke:jellyfin')), 'Jellyfin command');
  assert(validation.reviewQuestions.some((question) => question.includes('Usenet')), 'Usenet decision');

  const launch = requireSection(packet, 'launch-candidate-decision');
  assert(launch.status === 'blocked', 'launch candidate blocked');
  assert(launch.commandPlan.includes('npm run --silent ops:operator-acceptance-packet -- -- --json'), 'self command');

  for (const rule of [
    'O4 and O5 stay blocked unless evidence is reviewed or residual risk is explicitly accepted.',
    'A launch candidate must be a separate phase after this packet is completed by the operator.',
  ]) assert(packet.acceptanceRules.includes(rule), `rule ${rule}`);

  for (const nonGoal of [
    'No DB reads.',
    'No evidence file reads.',
    'No environment or credential reads.',
    'No network calls or live service contact.',
    'No launch approval, O4 closure, O5 closure, or production-readiness closure.',
  ]) assert(packet.explicitNonGoals.includes(nonGoal), `non-goal ${nonGoal}`);
}

console.log('Running Phase 84 operator acceptance packet suite:\n');

test('packet is blocked, operator-run, and covers launch decisions', () => {
  const packet = buildOperatorAcceptancePacket();
  assertPacketShape(packet);
  assertNoForbiddenOutput(JSON.stringify(packet));
});

test('formatters emit deterministic redaction-safe text and JSON', () => {
  const packet = buildOperatorAcceptancePacket();
  const json = formatOperatorAcceptancePacketJson(packet);
  const text = formatOperatorAcceptancePacketText(packet);
  assertPacketShape(JSON.parse(json) as OperatorAcceptancePacket);
  for (const line of [
    'Phase 84 operator acceptance packet',
    'status: blocked',
    'launchReady: false',
    '- production-security-decision: blocked',
    '- unraid-operator-rehearsal: operator-required',
    '- live-service-validation: operator-required',
    '- launch-candidate-decision: blocked',
    'No DB reads.',
  ]) assert(text.includes(line), `text includes ${line}`);
  assert(text.endsWith('\n'), 'text newline');
  assertNoForbiddenOutput(json);
  assertNoForbiddenOutput(text);
});

test('CLI text and direct JSON modes are redaction-safe', () => {
  const env = {
    ...process.env,
    SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
    DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
    TORBOX_TOKEN: 'TOKEN_VALUE_SENTINEL',
    PRIVATE_TITLE: 'PRIVATE_TITLE_SENTINEL',
    RAW_REF: 'RAW_REF_SENTINEL',
  };
  const text = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/operator-acceptance-packet-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/operator-acceptance-packet-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text.includes('launchReady: false'), 'text launch ready false');
  assertPacketShape(JSON.parse(json) as OperatorAcceptancePacket);
  assertNoForbiddenOutput(text);
  assertNoForbiddenOutput(json);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:operator-acceptance-packet -- -- --json', {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
    },
    encoding: 'utf8',
  });
  assertPacketShape(JSON.parse(output) as OperatorAcceptancePacket);
  assertNoForbiddenOutput(output);
});

test('source and docs preserve static packet boundaries', () => {
  const source = `${read('src/ops/operator-acceptance-packet.ts')}\n${read('src/ops/operator-acceptance-packet-cli.ts')}`;
  const docs = `${read('docs/PHASE_84_OPERATOR_ACCEPTANCE_PACKET.md')}\n${read('README.md')}\n${read('package.json')}\n${read('test/deploy.ts')}`;
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
    'localStorage',
    'sessionStorage',
    'Set-Cookie',
    'Authorization',
    'Bearer',
    'Basic',
    'OAuth',
  ]) assert(!source.includes(forbidden), `source excludes ${forbidden}`);
  for (const kw of [
    'Phase 84',
    'Operator Acceptance Packet',
    'ops:operator-acceptance-packet',
    'test:operator-acceptance-packet',
    'npm run --silent ops:operator-acceptance-packet -- -- --json',
    'OPERATOR_ACCEPTANCE_PACKET_REPORTED',
    'operator-run-redaction-safe-launch-acceptance',
    'O4',
    'O5',
    'FileCustodian',
    'TorBox',
    'Jellyfin',
    'Usenet',
    'No DB reads',
    'No launch approval',
  ]) assert(docs.includes(kw), `docs include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
