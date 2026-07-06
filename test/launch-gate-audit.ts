import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildLaunchGateAuditReport,
  formatLaunchGateAuditJson,
  formatLaunchGateAuditText,
  type LaunchGateAuditReport,
} from '../src/ops/launch-gate-audit.js';

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

function requireStep(report: LaunchGateAuditReport, id: LaunchGateAuditReport['steps'][number]['id']): LaunchGateAuditReport['steps'][number] {
  const step = report.steps.find((candidate) => candidate.id === id);
  if (step === undefined) throw new Error(`missing ${id}`);
  return step;
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
    'real provider payload',
    'credential-file-contents',
    'localStorage',
    'sessionStorage',
    'Authorization',
    'Bearer ',
    'Basic ',
    'OAuth',
  ]) assert(!output.includes(forbidden), `output leaks ${forbidden}`);
}

function assertReportShape(report: LaunchGateAuditReport): void {
  assert(report.ok === true, 'ok marker');
  assert(report.report === 'phase-83-launch-gate-audit', 'report name');
  assert(report.version === 1, 'version');
  assert(report.code === 'LAUNCH_GATE_AUDIT_REPORTED', 'code');
  assert(report.status === 'blocked', 'blocked until external evidence exists');
  assert(report.launchReady === false, 'not launch ready');
  assert(report.scope === 'steps-1-2-3-launch-gap-audit', 'scope');
  assert(report.steps.length === 3, 'three audited steps');
  for (const id of [
    'production-security-gates',
    'operator-launch-rehearsal',
    'real-service-validation',
  ]) assert(report.steps.some((step) => step.id === id), `includes ${id}`);

  const security = requireStep(report, 'production-security-gates');
  assert(security.status === 'blocked', 'security gate is blocked');
  assert(security.safeCommands.includes('npm run test:custodian-acceptance'), 'custodian acceptance command');
  assert(security.safeCommands.includes('npm run ops:doctor -- --json'), 'doctor command');
  assert(security.requiredBeforeLaunch.some((item) => item.includes('O4')), 'O4 requirement');
  assert(security.requiredBeforeLaunch.some((item) => item.includes('O5')), 'O5 requirement');

  const rehearsal = requireStep(report, 'operator-launch-rehearsal');
  assert(rehearsal.status === 'operator-required', 'operator rehearsal required');
  assert(rehearsal.safeCommands.includes('npm run ops:operator-ui-auth-packet-acceptance -- -- --json'), 'Phase 82 command');

  const validation = requireStep(report, 'real-service-validation');
  assert(validation.status === 'operator-required', 'real validation required');
  assert(validation.safeCommands.some((command) => command.includes('smoke:torbox-readonly')), 'TorBox command');
  assert(validation.safeCommands.some((command) => command.includes('smoke:jellyfin')), 'Jellyfin command');
  assert(validation.requiredBeforeLaunch.some((item) => item.includes('Usenet')), 'Usenet decision captured');

  for (const gate of [
    'O4 external/managed production custodian remains open/deferred.',
    'O5 managed KEK custody and rotation/scheduling remains open/deferred.',
  ]) assert(report.openGates.includes(gate), `open gate ${gate}`);

  for (const nonGoal of [
    'No DB reads.',
    'No secret, credential, path, artifact, environment, or evidence-file inspection.',
    'No launch approval, merge approval, production-readiness closure, O4 closure, or O5 closure.',
  ]) assert(report.explicitNonGoals.includes(nonGoal), `non-goal ${nonGoal}`);
}

console.log('Running Phase 83 launch gate audit suite:\n');

test('report marks steps 1-3 as blocked/operator-required and launch not ready', () => {
  const report = buildLaunchGateAuditReport();
  assertReportShape(report);
  assertNoForbiddenOutput(JSON.stringify(report));
});

test('formatters emit stable redaction-safe text and JSON', () => {
  const report = buildLaunchGateAuditReport();
  const json = formatLaunchGateAuditJson(report);
  const text = formatLaunchGateAuditText(report);
  assertReportShape(JSON.parse(json) as LaunchGateAuditReport);
  for (const line of [
    'Phase 83 launch gate audit',
    'status: blocked',
    'launchReady: false',
    '- production-security-gates: blocked',
    '- operator-launch-rehearsal: operator-required',
    '- real-service-validation: operator-required',
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
  const text = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/launch-gate-audit-cli.ts'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  const json = execFileSync(process.execPath, ['--import', 'tsx', 'src/ops/launch-gate-audit-cli.ts', '--json'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert(text.includes('launchReady: false'), 'text launch ready false');
  assertReportShape(JSON.parse(json) as LaunchGateAuditReport);
  assertNoForbiddenOutput(text);
  assertNoForbiddenOutput(json);
});

test('documented npm JSON command is parseable', () => {
  const output = execSync('npm run --silent ops:launch-gate-audit -- -- --json', {
    cwd: root,
    env: {
      ...process.env,
      SECRET_VALUE_SENTINEL: 'SECRET_VALUE_SENTINEL',
      DATABASE_URL: 'postgres://DATABASE_URL_SENTINEL',
    },
    encoding: 'utf8',
  });
  assertReportShape(JSON.parse(output) as LaunchGateAuditReport);
  assertNoForbiddenOutput(output);
});

test('source and docs preserve audit-only boundaries', () => {
  const source = `${read('src/ops/launch-gate-audit.ts')}\n${read('src/ops/launch-gate-audit-cli.ts')}`;
  const docs = `${read('docs/PHASE_83_LAUNCH_GATE_AUDIT.md')}\n${read('README.md')}\n${read('package.json')}\n${read('test/deploy.ts')}`;
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
    'Phase 83',
    'Launch Gate Audit',
    'ops:launch-gate-audit',
    'test:launch-gate-audit',
    'npm run --silent ops:launch-gate-audit -- -- --json',
    'LAUNCH_GATE_AUDIT_REPORTED',
    'steps-1-2-3-launch-gap-audit',
    'O4',
    'O5',
    'FileCustodian remains',
    'No DB reads',
    'does not close O4 or O5',
    'TorBox',
    'Jellyfin',
    'Usenet',
  ]) assert(docs.includes(kw), `docs include ${kw}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
