import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOCTOR_MONITOR_EXIT,
  DOCTOR_MONITOR_LOCK_DIRNAME,
  DOCTOR_MONITOR_STATE_NAME,
  EXIT_FOR_STATE,
  MAX_CHECK_DETAIL_LENGTH,
  MAX_CHECK_NAME_LENGTH,
  MAX_DOCTOR_CHECKS,
  MAX_DOCTOR_STDOUT_BYTES,
  classifyDoctor,
  isUsableCheckName,
  parseDoctorJson,
  readMonitorState,
  renderDoctorMonitor,
  runDoctorMonitor,
  type MonitorState,
} from '../src/ops/doctor-monitor.js';
import { DOCTOR_REPORT_VERSION, formatDoctorJson, type DoctorReport } from '../src/ops/doctor.js';
import { parseDoctorMonitorArgs } from '../src/ops/doctor-monitor-cli.js';
import { acquireLockDirectory } from '../src/ops/maintenance-safety.js';
import { assertLedgerIsClean, fakeDoctorJson, fakeToolchain } from './helpers/fake-toolchain.js';

// Phase 278 — the scheduled doctor monitor.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - IT RUNS THE SHIPPED DOCTOR AND NOTHING ELSE, through the same `--json` contract Phase 6 declared
//     stable, and it never reimplements a check.
//   - IT NEVER SOFTENS WHAT THE DOCTOR SAID. A WARN exits WARN and a FAIL exits FAIL, on the first run and on
//     the fiftieth, whatever the consecutive count is.
//   - AN UNREADABLE ANSWER IS `INVALID`, NOT HEALTHY — including a report that contradicts itself.
//   - THE CONSECUTIVE COUNT IS DURABLE AND RESETS ONLY ON HEALTH.
//   - IT WRITES ONE REDACTED FILE, ATOMICALLY, AND CONTACTS NOTHING. No `detail` string is carried and no
//     alert is issued.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function refuses(fn: () => unknown, needle: string, msg: string): void {
  try { fn(); } catch (err) {
    assert((err as Error).message.includes(needle), `${msg}: expected "${needle}", got: ${(err as Error).message}`);
    return;
  }
  throw new Error(`${msg}: nothing was refused`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').split('\r\n').join('\n');

const WORK = mkdtempSync(join(tmpdir(), 'ca-monitor-'));
const SECRET_DETAIL = 'a-detail-string-that-must-never-reach-the-state-file';

function makeProject(name: string): string {
  const root = join(WORK, name);
  mkdirSync(join(root, 'monitor'), { recursive: true });
  return root;
}

console.log('Running Phase 278 doctor monitor suite:\n');

// ---------------------------------------------------------------------------------------------------------
// The doctor's own contract
// ---------------------------------------------------------------------------------------------------------

test('the monitor reads the SHIPPED doctor contract, produced by the shipped formatter', () => {
  // Driven from `formatDoctorJson` rather than a hand-written string, so a change to the contract breaks this
  // rather than leaving the monitor reading a shape nothing produces any more.
  const report: DoctorReport = { ok: true, checks: [{ name: 'db', state: 'pass', detail: 'fine' }] };
  const parsed = parseDoctorJson(formatDoctorJson(report));
  assert(parsed !== null, 'the shipped formatter produces something the monitor understands');
  assertEq(parsed.checks.length, 1, 'and the checks survive');
  assertEq(classifyDoctor(parsed), 'HEALTHY', 'a report with only passes is healthy');
});

test('every doctor state maps to a distinct exit code, and nothing is softened', () => {
  const cases: Array<[readonly ('pass' | 'warn' | 'fail')[], MonitorState, number]> = [
    [['pass', 'pass'], 'HEALTHY', DOCTOR_MONITOR_EXIT.HEALTHY],
    [['pass', 'warn'], 'WARN', DOCTOR_MONITOR_EXIT.WARN],
    [['warn', 'fail'], 'FAIL', DOCTOR_MONITOR_EXIT.FAIL],
    [['fail', 'fail'], 'FAIL', DOCTOR_MONITOR_EXIT.FAIL],
  ];
  for (const [states, expected, code] of cases) {
    const parsed = parseDoctorJson(fakeDoctorJson(states));
    assert(parsed !== null, `${states.join('+')} parses`);
    assertEq(classifyDoctor(parsed), expected, `${states.join('+')} classifies`);
    assertEq(EXIT_FOR_STATE[expected], code, `${states.join('+')} exits distinctly`);
  }
  const distinct = new Set(Object.values(EXIT_FOR_STATE));
  assertEq(distinct.size, Object.keys(EXIT_FOR_STATE).length, 'and no two states share an exit code');
  assert(!distinct.has(DOCTOR_MONITOR_EXIT.USAGE), 'while usage keeps a code of its own');
});

test('anything the monitor cannot read is INVALID, and never healthy', () => {
  for (const text of ['', 'not json', '{}', '[]', '{"reportVersion":999,"ok":true,"checks":[]}',
    '{"reportVersion":1,"ok":true,"checks":[]}', '{"reportVersion":1,"ok":true}',
    '{"reportVersion":1,"ok":true,"checks":[{"name":"x","state":"maybe","detail":"d"}]}']) {
    assertEq(parseDoctorJson(text), null, `${JSON.stringify(text).slice(0, 40)} is not readable`);
  }
  // A REPORT THAT CONTRADICTS ITSELF. `ok: true` with a failing check is not a healthy installation; it is a
  // report this build does not understand, and calling it healthy would be the worst possible reading.
  const contradiction = JSON.stringify({
    reportVersion: DOCTOR_REPORT_VERSION, ok: true,
    checks: [{ name: 'x', state: 'fail', detail: 'd' }],
  });
  const parsed = parseDoctorJson(contradiction);
  assert(parsed !== null, 'it parses structurally');
  assertEq(classifyDoctor(parsed), 'INVALID', 'and is classified INVALID rather than HEALTHY');
});

// ---------------------------------------------------------------------------------------------------------
// A scheduled run
// ---------------------------------------------------------------------------------------------------------

function run(root: string, states: readonly ('pass' | 'warn' | 'fail')[] | string, at = 0) {
  const tools = fakeToolchain({ doctorJson: typeof states === 'string' ? states : fakeDoctorJson(states) });
  const report = runDoctorMonitor({ projectRoot: root, stateDir: 'monitor' },
    { runner: tools.runner, ledger: tools.ledger, now: () => new Date(at) });
  return { report, tools };
}

test('a healthy run exits 0, writes one state file, and contacts nothing', () => {
  const root = makeProject('healthy');
  const { report, tools } = run(root, ['pass', 'pass']);
  assertEq(report.state, 'HEALTHY', 'it is healthy');
  assertEq(report.exitCode, 0, 'and exits 0');
  assertEq(report.consecutiveFailures, 0, 'with no consecutive failures');
  assertEq(report.alerts, 'none — the scheduler alerts from the exit code', 'and it alerts nothing');

  const stateFile = join(root, 'monitor', DOCTOR_MONITOR_STATE_NAME);
  assertEq(existsSync(stateFile), true, 'the state file is there');
  assertEq(assertLedgerIsClean(tools.lines()).join('; '), '', 'and the ledger is clean');
  assertEq(tools.lines().length, 1, 'exactly one command was run');
  assert(tools.lines()[0]!.includes('ops:doctor'), 'and it was the shipped doctor');
  assert(tools.lines()[0]!.includes('--json'), 'in its stable machine-readable form');
});

test('the consecutive count survives runs and resets only on health', () => {
  const root = makeProject('consecutive');
  assertEq(run(root, ['fail']).report.consecutiveFailures, 1, 'one failure');
  assertEq(run(root, ['fail']).report.consecutiveFailures, 2, 'two in a row');
  assertEq(run(root, ['warn']).report.consecutiveFailures, 3, 'a WARN continues the run of non-healthy results');
  assertEq(run(root, 'not json').report.consecutiveFailures, 4, 'and so does an unreadable answer');
  const healthy = run(root, ['pass']);
  assertEq(healthy.report.consecutiveFailures, 0, 'and health resets it');
  // ...and it is DURABLE: read back from the file, not from memory.
  const persisted = readMonitorState(join(root, 'monitor', DOCTOR_MONITOR_STATE_NAME));
  assertEq(persisted.kind, 'state', 'the state file is readable');
  assert(persisted.kind === 'state', 'the state file is readable');
  assertEq(persisted.state.consecutiveFailures, 0, 'and holds the reset count');
});

test('a WARN on the fiftieth consecutive run still exits WARN, never FAIL', () => {
  const root = makeProject('never-escalates');
  for (let index = 0; index < 5; index += 1) run(root, ['warn']);
  const { report } = run(root, ['warn']);
  assertEq(report.state, 'WARN', 'six consecutive warns are still a WARN');
  assertEq(report.exitCode, DOCTOR_MONITOR_EXIT.WARN, 'and the exit code is still the WARN one');
  assertEq(report.consecutiveFailures, 6, 'while the count records how long it has been going on');
  assert(report.notes.some((n) => n.includes('in a row')), 'and the report says so');
});

test('the state file carries check names and states, and no detail, path or secret', () => {
  const root = makeProject('redaction');
  const doctorJson = JSON.stringify({
    reportVersion: DOCTOR_REPORT_VERSION, ok: false,
    checks: [{ name: 'keystore-ownership', state: 'fail', detail: SECRET_DETAIL }],
  });
  const { report } = run(root, doctorJson);
  const raw = readFileSync(join(root, 'monitor', DOCTOR_MONITOR_STATE_NAME), 'utf8');
  const printed = [raw, renderDoctorMonitor(report), JSON.stringify(report)].join('\n');
  for (const forbidden of [SECRET_DETAIL, root, WORK]) {
    assert(!printed.includes(forbidden), `the monitor carried ${forbidden.slice(0, 40)}`);
  }
  assert(raw.includes('keystore-ownership'), 'while the check NAME is carried, which is this project\'s own word');
  assert(raw.includes('"state": "FAIL"'), 'and the state');
});

test('the state file is replaced atomically and leaves no temporary behind', () => {
  const root = makeProject('atomic');
  run(root, ['pass']);
  run(root, ['warn']);
  const entries = readdirSync(join(root, 'monitor'));
  assertEq(entries.filter((n) => n.includes('.tmp-')).length, 0, 'no temporary state file survived');
  assertEq(entries.length, 1, 'and there is exactly one state file');
  const persisted = readMonitorState(join(root, 'monitor', DOCTOR_MONITOR_STATE_NAME));
  assert(persisted.kind === 'state' && persisted.state.state === 'WARN', 'holding the latest run');
  if (process.platform !== 'win32') {
    assertEq(statSync(join(root, 'monitor', DOCTOR_MONITOR_STATE_NAME)).mode & 0o077, 0, 'and it is private');
  }
});

test('a previous state file that is not this build\'s is reported, not silently believed or crashed on', () => {
  const root = makeProject('stale-state');
  writeFileSync(join(root, 'monitor', DOCTOR_MONITOR_STATE_NAME), '{"report":"something-else"}\n', 'utf8');
  const previous = readMonitorState(join(root, 'monitor', DOCTOR_MONITOR_STATE_NAME));
  assertEq(previous.kind, 'unreadable', 'a file that is there and is not state is UNREADABLE, not ABSENT');
  const { report } = run(root, ['fail']);
  assertEq(report.consecutiveFailures, 1, 'the count starts again rather than throwing');
  assertEq(report.state, 'INVALID', 'and the run says the monitor could not account for its own history');
});

test('a missing state directory refuses rather than creating one somewhere', () => {
  const root = join(WORK, 'no-state-dir');
  mkdirSync(root, { recursive: true });
  const tools = fakeToolchain();
  refuses(() => runDoctorMonitor({ projectRoot: root, stateDir: 'monitor' }, { runner: tools.runner, ledger: tools.ledger }),
    'not there', 'a missing state directory');
  assertEq(tools.lines().length, 0, 'and the doctor was not run');
});

test('the monitor issues no alert and no outbound call of any kind', () => {
  const source = readRepo('src/ops/doctor-monitor.ts');
  for (const forbidden of ['fetch(', 'http', 'webhook', 'smtp', 'mail', 'slack', 'notify', 'node:net', 'node:dns']) {
    assert(!source.toLowerCase().includes(forbidden.toLowerCase()), `the monitor must not name ${forbidden}`);
  }
  const cli = readRepo('src/ops/doctor-monitor-cli.ts');
  for (const forbidden of ['fetch(', 'webhook', 'curl']) {
    assert(!cli.toLowerCase().includes(forbidden.toLowerCase()), `the monitor CLI must not name ${forbidden}`);
  }
});

test('the CLI parser is strict and takes no credential', () => {
  const parsed = parseDoctorMonitorArgs(['--project', '/x/y', '--state', 'monitor']);
  assertEq(parsed.request.stateDir, 'monitor', 'the state directory parses');
  for (const [argv, needle] of [
    [['--state', 'monitor'], '--project is required'],
    [['--project', '/x/y'], '--state is required'],
    [['--project', '/x/y', '--state', 'm', '--api-token', 't'], 'looks like a credential'],
    [['--project', '/x/y', '--state', 'm', '--nope'], 'unknown option'],
  ] as Array<[string[], string]>) {
    refuses(() => parseDoctorMonitorArgs(argv), needle, `the arguments ${argv.join(' ')}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The corrections. Every test below FAILS on the first implementation of this tranche.
// ---------------------------------------------------------------------------------------------------------

test('a check name that is not an identifier makes the whole report INVALID, and is never persisted', () => {
  // THE DEFECT: any string at all was accepted as a check name, then written into a durable file and echoed
  // to a terminal. The doctor's output crosses a container boundary — a name is a place a path, a URL, an
  // escape sequence or a fragment of a connection string can arrive, and "it is only a name" is exactly the
  // reasoning that puts one in a support ticket.
  const hostile = [
    '/mnt/user/media/Movies',
    'https://registry.example.invalid/v2/',
    'C:\\Users\\someone\\secrets\\custodian_kek',
    `check${String.fromCharCode(27)}[31m-red`,
    `two${String.fromCharCode(10)}lines`,
    'name with spaces',
    'UPPERCASE',
    'trailing-',
    'x'.repeat(MAX_CHECK_NAME_LENGTH + 1),
    '',
    '../../etc/passwd',
    'postgres://user:hunter2@db/catalog',
  ];
  for (const name of hostile) {
    assertEq(isUsableCheckName(name), false, `${JSON.stringify(name.slice(0, 24))} is not a usable check name`);
    const root = makeProject(`hostile-${hostile.indexOf(name)}`);
    const json = JSON.stringify({
      reportVersion: DOCTOR_REPORT_VERSION, ok: true,
      checks: [{ name: 'environment', state: 'pass', detail: 'd' }, { name, state: 'pass', detail: 'd' }],
    });
    const { report } = run(root, json);
    assertEq(report.state, 'INVALID', `a report carrying ${JSON.stringify(name.slice(0, 24))} is INVALID`);
    assertEq(report.checks.length, 0, 'and nothing from it is kept');
    const raw = readFileSync(join(root, 'monitor', DOCTOR_MONITOR_STATE_NAME), 'utf8');
    assert(!raw.includes(name.slice(0, 12)) || name.length < 4,
      `the durable state file must not carry ${JSON.stringify(name.slice(0, 24))}`);
  }
  // ...and the names the shipped doctor actually emits are all accepted, so the guard is not merely strict.
  for (const real of ['environment', 'db-owner-reachable', 'schema-version', 'runtime-least-privileged']) {
    assertEq(isUsableCheckName(real), true, `${real} is a name the shipped doctor emits`);
  }
});

test('a report that is enormous, or repeats a name, is INVALID rather than absorbed', () => {
  const root = makeProject('bounds');
  const many = JSON.stringify({
    reportVersion: DOCTOR_REPORT_VERSION, ok: true,
    checks: Array.from({ length: MAX_DOCTOR_CHECKS + 1 }, (_unused, index) => ({ name: `check-${index}`, state: 'pass', detail: 'd' })),
  });
  assertEq(run(root, many).report.state, 'INVALID', 'more checks than a report may carry is INVALID');

  const huge = JSON.stringify({
    reportVersion: DOCTOR_REPORT_VERSION, ok: true,
    checks: [{ name: 'environment', state: 'pass', detail: 'x'.repeat(MAX_CHECK_DETAIL_LENGTH + 1) }],
  });
  assertEq(run(makeProject('bounds-detail'), huge).report.state, 'INVALID', 'a detail past the bound is INVALID');

  // Past the stdout bound the answer is refused WITHOUT being parsed at all — the bound exists to stop an
  // unbounded allocation, so it cannot be enforced after the allocation.
  assertEq(parseDoctorJson(`${' '.repeat(MAX_DOCTOR_STDOUT_BYTES + 1)}{"reportVersion":1,"ok":true,"checks":[]}`), null,
    'an answer past the stdout bound is not parsed');

  const duplicated = JSON.stringify({
    reportVersion: DOCTOR_REPORT_VERSION, ok: false,
    checks: [{ name: 'schema-version', state: 'pass', detail: 'd' }, { name: 'schema-version', state: 'fail', detail: 'd' }],
  });
  assertEq(run(makeProject('bounds-dupes'), duplicated).report.state, 'INVALID',
    'two checks of one name is a report that disagrees with itself');
});

test('a doctor that exits non-zero is never HEALTHY, whatever its output says', () => {
  // THE DEFECT: only stdout was read. A doctor that failed, a container that was not running, or anything
  // else on that descriptor could produce a healthy-looking body behind a non-zero status and be believed.
  const root = makeProject('status-mismatch');
  const tools = fakeToolchain({
    doctorJson: fakeDoctorJson(['pass', 'pass']),
    doctorStatus: 7,
    doctorStderr: 'something went wrong in a way that names a path\n',
  });
  const report = runDoctorMonitor({ projectRoot: root, stateDir: 'monitor' },
    { runner: tools.runner, ledger: tools.ledger, now: () => new Date(0) });
  assertEq(report.state, 'INVALID', 'a healthy body behind a failed command is not health');
  assertEq(report.exitCode, DOCTOR_MONITOR_EXIT.INVALID, 'and the exit code says so');
  assert(report.notes.some((n) => n.includes('exited non-zero')), 'and the status is reported as a fact');
  assert(report.notes.some((n) => n.includes('error stream')), 'and so is the presence of error output');
  // The stderr TEXT is never carried anywhere.
  const printed = [renderDoctorMonitor(report), JSON.stringify(report),
    readFileSync(join(root, 'monitor', DOCTOR_MONITOR_STATE_NAME), 'utf8')].join('\n');
  assert(!printed.includes('names a path'), 'while what it actually said is not repeated');
});

test('the inverse also holds: a zero exit that reports a failure is a disagreement, not a pass', () => {
  const root = makeProject('status-inverse');
  const tools = fakeToolchain({ doctorJson: fakeDoctorJson(['fail']), doctorStatus: 0 });
  const report = runDoctorMonitor({ projectRoot: root, stateDir: 'monitor' },
    { runner: tools.runner, ledger: tools.ledger, now: () => new Date(0) });
  assertEq(report.state, 'INVALID', 'a FAIL body behind a successful command is a disagreement');
});

test('a corrupt state file cannot be used to reset the consecutive-failure count', () => {
  // THE DEFECT: an unreadable previous state was treated as "no previous state", so the count restarted at
  // one. That makes the count — the number an alerting threshold is set against — resettable by anything that
  // can write one byte into that file, including a partial write from a machine that lost power.
  const root = makeProject('counter-reset');
  const stateFile = join(root, 'monitor', DOCTOR_MONITOR_STATE_NAME);
  for (let index = 0; index < 4; index += 1) run(root, ['fail']);
  const before = run(root, ['fail']).report;
  assertEq(before.consecutiveFailures, 5, 'five failures in a row');

  writeFileSync(stateFile, '{"report":"phase-278-doctor-monitor","version":1,"consecutiveFailures":', 'utf8');
  const after = run(root, ['pass']).report;
  assertEq(after.state, 'INVALID', 'a corrupt memory is not a healthy run');
  assert(after.notes.some((n) => n.includes('could not be continued')), 'and it says the history was lost');
  assertEq(after.consecutiveFailures, 1, 'and the count does not silently return to zero');

  // A NEGATIVE OR NON-INTEGER COUNT IS NOT A COUNT. The same file is the obvious place to write one.
  for (const forged of ['-5', '1e999', '"3"', 'null', '0.5']) {
    writeFileSync(stateFile,
      `{"report":"phase-278-doctor-monitor","version":1,"state":"FAIL","consecutiveFailures":${forged}}\n`, 'utf8');
    assertEq(readMonitorState(stateFile).kind, 'unreadable', `a count of ${forged} is not a count`);
  }
});

test('two monitor runs cannot both read N and publish N+1', () => {
  // THE DEFECT: the read-modify-write of the count had no lock at all. A schedule that fires while the last
  // run is still going — or an operator running it by hand during one — produced two runs that both read 4
  // and both wrote 5, and the run that should have crossed a threshold of 6 never happened.
  const root = makeProject('overlap');
  run(root, ['fail']);
  const held = acquireLockDirectory(join(root, 'monitor', DOCTOR_MONITOR_LOCK_DIRNAME), 'held for the test');
  try {
    const tools = fakeToolchain();
    refuses(() => runDoctorMonitor({ projectRoot: root, stateDir: 'monitor' },
      { runner: tools.runner, ledger: tools.ledger }), 'another doctor-monitor run', 'an overlapping run');
    assertEq(tools.lines().length, 0, 'and the second run did not even start the doctor');
  } finally {
    held.release();
  }
  // ...and the lock is released by a normal run, so the next one is not blocked by it.
  assertEq(run(root, ['fail']).report.consecutiveFailures, 2, 'the count continues once the lock is free');
  assertEq(existsSync(join(root, 'monitor', DOCTOR_MONITOR_LOCK_DIRNAME)), false, 'and the lock is gone');
});

// ---------------------------------------------------------------------------------------------------------
// The scheduler example
// ---------------------------------------------------------------------------------------------------------

test('the Unraid example locks against overlap, bounds itself, and deletes nothing', () => {
  const script = readRepo('deploy/unraid-catalog-maintenance.sh');
  assert(script.startsWith('#!/usr/bin/env bash'), 'it is a bash script');
  assert(script.includes('set -euo pipefail'), 'it fails on the first error');
  assert(script.includes('flock -n 9'), 'it refuses to overlap rather than queueing');
  assert(script.includes('timeout "${TIMEOUT_SECONDS}"'), 'and every run is bounded');
  assert(script.includes('retention-plan'), 'retention is a plan');
  // PHASES 305-312 REPLACED THE SHELL LOOP WITH THE SHIPPED COMMAND, and did not change what this mode does.
  // It used to enumerate `ls` output, print WOULD REMOVE beside names sorted LEXICALLY, and `sha256sum` that
  // listing; the digest was over names, so a set whose bytes had changed produced the same one. The command
  // it now runs verifies every set, orders by the manifests' own dates, and digests the whole inventory.
  assert(script.includes('ops:backup-retention'), 'and it is the shipped command that makes it');
  assert(script.includes('--plan'), 'in plan mode');
  // THE SCAN IS OVER WHAT THIS SCRIPT RUNS, NOT WHAT IT EXPLAINS. Its commentary names `--confirm` precisely
  // in order to say that a human types it, and an assertion forbidding the word would forbid saying so.
  const executable = script.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert(!executable.includes('--confirm'), 'and no line it executes carries a confirmation');
  assert(!executable.includes('--yes'), 'nor anything else that would remove a backup on a timer');
  for (const forbidden of ['rm -rf', 'rm -r ', 'find ', 'curl', 'wget', 'mail ', 'webhook',
    '--password', '--token', '--secret']) {
    assert(!script.includes(forbidden), `the example must not use ${forbidden}`);
  }
  // Every address it could name is nothing: it names none.
  assertEq((script.match(/https?:\/\//g) ?? []).length, 0, 'and it names no URL at all');
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
