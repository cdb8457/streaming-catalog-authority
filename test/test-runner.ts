import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TEST_RUNNER_EXIT_INVENTORY,
  TEST_RUNNER_EXIT_OK,
  TEST_RUNNER_EXIT_SUITE_FAILURES,
  TEST_RUNNER_EXIT_USAGE,
  TEST_RUNNER_MAX_CONCURRENCY,
  TestInventoryError,
  TestRunnerUsageError,
  auditInventory,
  createSuiteSpawner,
  listTestFiles,
  loadInventory,
  parseSuiteInventory,
  parseTestRunnerArgs,
  planRun,
  renderRunReport,
  repositoryRoot,
  runPlan,
  tsxCliPath,
  type SuiteEntry,
  type SuiteInventory,
  type SpawnedSuite,
} from '../src/ops/test-runner.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';

// Phase 258 — the aggregate test command, proved.
//
// The defects this suite pins are the three that made the old `&&` chain untrustworthy: it exceeded the
// Windows command-line limit, a truncated chain still exited zero, and nothing noticed a suite that was never
// wired in. Each has a test here that fails if the property regresses.
//
// The runner is spawned FOR REAL against throwaway fixture suites (a passing one, a failing one, a hanging
// one), because "captures a non-zero exit code" is a claim about processes and a fake spawner cannot make it.
// The pure planning and inventory logic is exercised directly, without processes, so the adversarial cases
// are exhaustive rather than expensive.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function assertThrows(fn: () => unknown, msg: string): unknown {
  try { fn(); } catch (err) { return err; }
  throw new Error(`${msg}: expected a throw`);
}

const ROOT = repositoryRoot();
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const WORK = mkdtempSync(join(tmpdir(), 'ca-test-runner-'));

function inventory(suites: Array<Partial<SuiteEntry> & { file: string }>, helpers: string[] = []): SuiteInventory {
  return parseSuiteInventory({
    version: 1,
    helpers,
    suites: suites.map((s) => ({ file: s.file, group: s.group ?? 'offline', ...(s.args ? { args: s.args } : {}), ...(s.requires ? { requires: s.requires } : {}) })),
  });
}

function fakeSpawner(byFile: Record<string, Partial<SpawnedSuite>>): (entry: SuiteEntry) => Promise<SpawnedSuite> {
  return (entry) => Promise.resolve({
    exitCode: 0, signal: null, timedOut: false, output: '',
    ...(byFile[entry.file] ?? {}),
  });
}

async function main(): Promise<void> {
  console.log('Phase 258 — repository-owned test runner\n');

  // --- the three original defects ------------------------------------------------------------------------

  console.log('the defects that opened this phase');

  await test('npm test no longer depends on a command line a shell can truncate', () => {
    // Deliberately package.json's OWN string, not the reconstruction: this is the assertion that the shell
    // command is gone, so reading it from anywhere but the file npm executes would test nothing.
    const command = PKG.scripts.test;
    assert(command !== undefined, 'package.json has no test script');
    // 8191 is cmd.exe's hard limit; the old command was 11935 characters and could not run on Windows at all.
    assert(command!.length < 200, `the aggregate test command is ${command!.length} characters — it is a shell string again`);
    assert(!command!.includes('&&'), 'the aggregate test command is a chained shell string again');
    assert(command!.includes('test-runner-cli'), 'npm test does not invoke the repository-owned runner');
  });

  await test('the reconstructed aggregate command still describes what a default run executes', () => {
    // 105 suites assert "I am in the aggregate" (and several assert their position in it) against
    // AGGREGATE_SUITE_COMMAND. That is only a real guarantee while the reconstruction matches the plan the
    // runner actually builds, so the two are compared here rather than assumed equal.
    const plan = planRun(loadInventory(ROOT));
    const fromPlan = plan.selected.map(({ entry }) => `tsx test/${entry.file}`).join(' && ');
    assertEq(AGGREGATE_SUITE_COMMAND, fromPlan, 'the reconstructed aggregate no longer matches the default run');
    assert(AGGREGATE_SUITE_COMMAND.includes('tsx test/config.ts'), 'the reconstruction lost the first suite');
    assert(!AGGREGATE_SUITE_COMMAND.includes('release-candidate-acceptance'),
      'a capability-gated suite leaked into the reconstruction, which would make 105 assertions claim it runs by default');
  });

  await test('every file under test/ is accounted for by the inventory', () => {
    const audit = auditInventory(loadInventory(ROOT), listTestFiles(ROOT));
    assert(audit.ok, `the shipped inventory has drifted: ${audit.problems.join(' | ')}`);
    assert(audit.suiteCount > 280, `only ${audit.suiteCount} suites are wired in; the aggregate has shrunk`);
  });

  await test('a new unwired suite file is a hard failure, not a silent omission', () => {
    const audit = auditInventory(inventory([{ file: 'a.ts' }]), ['a.ts', 'brand-new-suite.ts']);
    assert(!audit.ok, 'an unaccounted file was accepted');
    assertEq(audit.unwired.length, 1, 'wrong unwired count');
    assertEq(audit.unwired[0], 'brand-new-suite.ts', 'wrong unwired file');
    assert(audit.problems[0]!.includes('brand-new-suite.ts'), 'the problem text does not name the file');
  });

  await test('an inventory entry whose file was deleted is a hard failure', () => {
    const audit = auditInventory(inventory([{ file: 'gone.ts' }, { file: 'here.ts' }]), ['here.ts']);
    assert(!audit.ok, 'a missing file was accepted');
    assertEq(audit.missing.join(','), 'gone.ts', 'wrong missing list');
  });

  await test('a file listed twice, or as both suite and helper, is rejected', () => {
    const twice = auditInventory(inventory([{ file: 'a.ts' }, { file: 'a.ts' }]), ['a.ts']);
    assert(!twice.ok && twice.duplicated.join(',') === 'a.ts', 'a duplicated suite was accepted');
    const both = auditInventory(inventory([{ file: 'a.ts' }], ['a.ts']), ['a.ts']);
    assert(!both.ok && both.duplicated.join(',') === 'a.ts', 'a file that is both a suite and a helper was accepted');
  });

  await test('two suites given the same embedded-PostgreSQL port are rejected before they can collide', () => {
    const audit = auditInventory(inventory([
      { file: 'a.ts', args: ['5433'] }, { file: 'b.ts', args: ['5433'] },
    ]), ['a.ts', 'b.ts']);
    assert(!audit.ok, 'a port collision was accepted');
    assert(audit.collidingArgs[0]!.includes('a.ts') && audit.collidingArgs[0]!.includes('b.ts'), 'the collision does not name both suites');
  });

  await test('the shipped inventory gives every database suite its own port', () => {
    const audit = auditInventory(loadInventory(ROOT), listTestFiles(ROOT));
    assertEq(audit.collidingArgs.length, 0, `ports collide: ${audit.collidingArgs.join(', ')}`);
  });

  await test('every suite that boots an embedded PostgreSQL declares its own port and is in the db group', () => {
    // THE COLLISION THE ARGUMENT CHECK CANNOT SEE. `embedded-pg.ts` falls back to port 5433 and a
    // `.pgdata-5433` directory when a suite passes no port. Three suites were relying on that default, so
    // three suites shared one server and one data directory — invisible under the old sequential `&&` chain,
    // which wiped and rebuilt the directory between them, and a guaranteed failure the moment anything ran
    // two of them at once. An implicit port cannot collide in `collidingArgs` because there is no argument to
    // compare, so it is caught here instead, from the suite's own source.
    const inventory = loadInventory(ROOT);
    for (const file of listTestFiles(ROOT)) {
      const source = readFileSync(join(ROOT, 'test', file), 'utf8');
      if (!/from '\.\/embedded-pg\.js'/.test(source)) continue;
      if (file === 'embedded-pg.ts') continue;
      const entry = inventory.suites.find((suite) => suite.file === file);
      if (entry === undefined) continue; // a helper; the audit already accounts for it
      assertEq(entry.args.length > 0, true, `${file} boots an embedded PostgreSQL but declares no port`);
      assert(/^\d{4}$/.test(entry.args[0]!), `${file} declares an unusable port: ${entry.args[0]}`);
      assertEq(entry.group, 'db', `${file} boots a database but is not in the db group`);
    }
  });

  // --- inventory parsing (adversarial) --------------------------------------------------------------------

  console.log('\ninventory parsing refuses anything it cannot execute safely');

  for (const [label, doc] of [
    ['a non-object', []],
    ['a null', null],
    ['a wrong version', { version: 2, helpers: [], suites: [{ file: 'a.ts', group: 'offline' }] }],
    ['an unknown top-level key', { version: 1, helpers: [], suites: [{ file: 'a.ts', group: 'offline' }], run: 'all' }],
    ['an unknown suite key', { version: 1, helpers: [], suites: [{ file: 'a.ts', group: 'offline', shell: true }] }],
    ['no suites at all', { version: 1, helpers: [], suites: [] }],
    ['a suite with no group', { version: 1, helpers: [], suites: [{ file: 'a.ts' }] }],
    ['a path traversal in a file name', { version: 1, helpers: [], suites: [{ file: '../src/ops/doctor.ts', group: 'offline' }] }],
    ['an absolute file name', { version: 1, helpers: [], suites: [{ file: '/etc/passwd.ts', group: 'offline' }] }],
    ['a subdirectory in a file name', { version: 1, helpers: [], suites: [{ file: 'nested/a.ts', group: 'offline' }] }],
    ['a non-.ts file', { version: 1, helpers: [], suites: [{ file: 'a.sh', group: 'offline' }] }],
    ['a helper that traverses', { version: 1, helpers: ['../package.json'], suites: [{ file: 'a.ts', group: 'offline' }] }],
    ['a shell metacharacter in an argument', { version: 1, helpers: [], suites: [{ file: 'a.ts', group: 'offline', args: ['5433; rm -rf /'] }] }],
    ['a shell metacharacter in a group', { version: 1, helpers: [], suites: [{ file: 'a.ts', group: 'off line' }] }],
    ['a non-array args', { version: 1, helpers: [], suites: [{ file: 'a.ts', group: 'offline', args: '5433' }] }],
    ['an over-long argument', { version: 1, helpers: [], suites: [{ file: 'a.ts', group: 'offline', args: ['x'.repeat(65)] }] }],
  ] as Array<[string, unknown]>) {
    await test(`rejects ${label}`, () => {
      const err = assertThrows(() => parseSuiteInventory(doc), `${label} was accepted`);
      assert(err instanceof TestInventoryError, `${label} threw the wrong error type`);
    });
  }

  await test('accepts the shipped inventory and normalizes optional fields', () => {
    const parsed = loadInventory(ROOT);
    assertEq(parsed.version, 1, 'wrong version');
    for (const suite of parsed.suites) {
      assert(Array.isArray(suite.args), `${suite.file} has no normalized args array`);
      assert(Array.isArray(suite.requires), `${suite.file} has no normalized requires array`);
    }
  });

  // --- planning -------------------------------------------------------------------------------------------

  console.log('\nplanning accounts for every entry, in both directions');

  await test('a default run selects everything that declares no requirement', () => {
    const plan = planRun(inventory([
      { file: 'a.ts' }, { file: 'b.ts' }, { file: 'c.ts', group: 'docker', requires: ['docker'] },
    ]));
    assertEq(plan.selected.length, 2, 'wrong selection size');
    assertEq(plan.skipped.length, 1, 'wrong skip size');
    assertEq(plan.skipped[0]!.file, 'c.ts', 'wrong skipped suite');
    assert(plan.skipped[0]!.reason.includes('requires docker'), 'the skip does not name the requirement');
    assert(!plan.skipped[0]!.fatal, 'a default-run capability skip should not be fatal');
  });

  await test('a skip is never counted as a pass', async () => {
    const plan = planRun(inventory([{ file: 'a.ts' }, { file: 'b.ts', group: 'docker', requires: ['docker'] }]));
    const report = await runPlan(plan, fakeSpawner({}), () => {});
    assertEq(report.passed, 1, 'the skipped suite was counted as a pass');
    assertEq(report.skipped, 1, 'the skip was not counted');
    assert(renderRunReport(report).includes('b.ts'), 'the summary does not name the skipped suite');
  });

  await test('--require-capabilities turns a missing capability into a failure', async () => {
    const inv = inventory([{ file: 'a.ts', group: 'docker', requires: ['docker'] }]);
    const lenient = planRun(inv, { groups: ['docker'], capabilities: [] });
    assert(!lenient.skipped[0]!.fatal, 'the lenient skip should not be fatal');
    const strict = planRun(inv, { groups: ['docker'], capabilities: [], requireCapabilities: true });
    assert(strict.skipped[0]!.fatal, 'the strict skip should be fatal');
    const report = await runPlan(strict, fakeSpawner({}), () => {});
    assert(!report.ok, 'a required-but-missing capability produced a passing run');
    assertEq(report.exitCode, TEST_RUNNER_EXIT_SUITE_FAILURES, 'wrong exit code for a fatal skip');
  });

  await test('a satisfied capability selects the suite', () => {
    const plan = planRun(inventory([{ file: 'a.ts', group: 'docker', requires: ['docker'] }]), { groups: ['docker'], capabilities: ['docker'] });
    assertEq(plan.selected.length, 1, 'a satisfied requirement did not select the suite');
  });

  await test('an unknown group is a usage error, not an empty green run', () => {
    const err = assertThrows(() => planRun(inventory([{ file: 'a.ts' }]), { groups: ['nope'] }), 'an unknown group was accepted');
    assert(err instanceof TestRunnerUsageError, 'wrong error type for an unknown group');
  });

  await test('concurrency is bounded on both ends', () => {
    for (const bad of [0, -1, TEST_RUNNER_MAX_CONCURRENCY + 1, 1.5]) {
      const err = assertThrows(() => planRun(inventory([{ file: 'a.ts' }]), { concurrency: bad }), `concurrency ${bad} was accepted`);
      assert(err instanceof TestRunnerUsageError, `concurrency ${bad} threw the wrong error type`);
    }
    assertEq(planRun(inventory([{ file: 'a.ts' }]), { concurrency: TEST_RUNNER_MAX_CONCURRENCY }).concurrency, TEST_RUNNER_MAX_CONCURRENCY, 'the ceiling was rejected');
  });

  await test('the timeout is bounded', () => {
    for (const bad of [0, 999, 3_600_001, 1.5]) {
      assertThrows(() => planRun(inventory([{ file: 'a.ts' }]), { timeoutMs: bad }), `timeout ${bad} was accepted`);
    }
  });

  // --- exit-code discipline --------------------------------------------------------------------------------

  console.log('\nno arrangement of results exits zero while something did not pass');

  await test('one failing suite among many fails the run', async () => {
    const plan = planRun(inventory([{ file: 'a.ts' }, { file: 'b.ts' }, { file: 'c.ts' }]));
    const report = await runPlan(plan, fakeSpawner({ 'b.ts': { exitCode: 1 } }), () => {});
    assert(!report.ok, 'a failing suite produced a passing run');
    assertEq(report.failed, 1, 'wrong failure count');
    assertEq(report.exitCode, TEST_RUNNER_EXIT_SUITE_FAILURES, 'wrong exit code');
    assert(renderRunReport(report).includes('b.ts'), 'the summary does not name the failing suite');
  });

  await test('a suite killed by a signal is a failure even with a null exit code', async () => {
    const plan = planRun(inventory([{ file: 'a.ts' }]));
    const report = await runPlan(plan, fakeSpawner({ 'a.ts': { exitCode: null, signal: 'SIGKILL' } }), () => {});
    assert(!report.ok, 'a signalled suite produced a passing run');
    assert(renderRunReport(report).includes('SIGKILL'), 'the summary does not say what killed it');
  });

  await test('a suite that could not be spawned is a failure, not a skip', async () => {
    const plan = planRun(inventory([{ file: 'a.ts' }]));
    const report = await runPlan(plan, fakeSpawner({ 'a.ts': { exitCode: null, spawnError: 'ENOENT' } }), () => {});
    assert(!report.ok, 'a suite that never started produced a passing run');
    assertEq(report.results[0]!.outcome, 'spawn-error', 'wrong outcome for a spawn failure');
  });

  await test('a timed-out suite is a failure', async () => {
    const plan = planRun(inventory([{ file: 'a.ts' }]));
    const report = await runPlan(plan, fakeSpawner({ 'a.ts': { exitCode: null, timedOut: true } }), () => {});
    assert(!report.ok, 'a timed-out suite produced a passing run');
    assertEq(report.results[0]!.outcome, 'timeout', 'wrong outcome for a timeout');
  });

  await test('--bail reports the suites it never reached as failures, never as passes', async () => {
    const plan = planRun(inventory([{ file: 'a.ts' }, { file: 'b.ts' }, { file: 'c.ts' }]), { bail: true });
    const report = await runPlan(plan, fakeSpawner({ 'a.ts': { exitCode: 1 } }), () => {});
    assert(!report.ok, 'a bailed run reported success');
    assertEq(report.passed, 0, 'an unreached suite was counted as a pass');
    assertEq(report.results.length, 3, 'the report dropped the unreached suites');
    assert(report.results[2]!.detail?.includes('not run'), 'an unreached suite is not labelled as such');
  });

  await test('an all-pass run exits zero and says so', async () => {
    const plan = planRun(inventory([{ file: 'a.ts' }, { file: 'b.ts' }]));
    const report = await runPlan(plan, fakeSpawner({}), () => {});
    assert(report.ok, 'an all-pass run did not report ok');
    assertEq(report.exitCode, TEST_RUNNER_EXIT_OK, 'wrong exit code for an all-pass run');
    assert(renderRunReport(report).includes('RESULT: PASS'), 'the summary does not state the verdict');
  });

  await test('bounded concurrency still runs every suite exactly once', async () => {
    const files = Array.from({ length: 25 }, (_, i) => ({ file: `s${i}.ts` }));
    const seen: string[] = [];
    const plan = planRun(inventory(files), { concurrency: 4 });
    const report = await runPlan(plan, (entry) => {
      seen.push(entry.file);
      return Promise.resolve({ exitCode: 0, signal: null, timedOut: false, output: '' });
    }, () => {});
    assertEq(seen.length, 25, 'wrong number of spawns');
    assertEq(new Set(seen).size, 25, 'a suite was run more than once');
    assertEq(report.passed, 25, 'wrong pass count under concurrency');
    assert(report.ok, 'a concurrent all-pass run did not report ok');
  });

  await test('results stay in inventory order regardless of completion order', async () => {
    const plan = planRun(inventory([{ file: 'slow.ts' }, { file: 'fast.ts' }]), { concurrency: 2 });
    const report = await runPlan(plan, (entry) => new Promise((resolve) => {
      setTimeout(() => resolve({ exitCode: 0, signal: null, timedOut: false, output: '' }), entry.file === 'slow.ts' ? 30 : 1);
    }), () => {});
    assertEq(report.results.map((r) => r.file).join(','), 'slow.ts,fast.ts', 'the report reordered the results');
  });

  // --- argument parsing -------------------------------------------------------------------------------------

  console.log('\nargument parsing is strict');

  await test('an unknown option is a usage error', () => {
    assertThrows(() => parseTestRunnerArgs(['--yolo']), 'an unknown option was accepted');
  });
  await test('a flag that needs a value refuses to swallow the next flag', () => {
    assertThrows(() => parseTestRunnerArgs(['--group', '--audit']), 'a flag was consumed as a value');
    assertThrows(() => parseTestRunnerArgs(['--concurrency']), 'a missing value was accepted');
    assertThrows(() => parseTestRunnerArgs(['--concurrency', 'four']), 'a non-numeric concurrency was accepted');
  });
  await test('repeatable flags accumulate', () => {
    const args = parseTestRunnerArgs(['--group', 'db', '--group', 'offline', '--filter', 'backup']);
    assertEq(args.groups.join(','), 'db,offline', 'groups did not accumulate');
    assertEq(args.filters.join(','), 'backup', 'filters did not accumulate');
  });

  // --- the real thing: spawn actual processes -----------------------------------------------------------------

  console.log('\nthe runner really does capture real exit codes, with no shell');

  const fixtures = join(WORK, 'fixtures');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'ok.ts'), 'console.log("fixture ok"); process.exit(0);\n');
  writeFileSync(join(fixtures, 'bad.ts'), 'console.error("fixture bad"); process.exit(7);\n');
  writeFileSync(join(fixtures, 'hang.ts'), 'setInterval(() => {}, 1000);\n');

  const realSpawner = createSuiteSpawner(WORK, tsxCliPath(ROOT));
  // The spawner joins `test/<file>`, so the fixtures live under a `test` directory inside the work root.
  mkdirSync(join(WORK, 'test'), { recursive: true });
  for (const name of ['ok.ts', 'bad.ts', 'hang.ts']) {
    writeFileSync(join(WORK, 'test', name), readFileSync(join(fixtures, name), 'utf8'));
  }

  await test('a passing fixture suite really exits zero', async () => {
    const result = await realSpawner({ file: 'ok.ts', group: 'offline', args: [], requires: [] }, 60_000, true);
    assertEq(result.exitCode, 0, 'the passing fixture did not exit zero');
    assert(result.output.includes('fixture ok'), 'the runner did not capture stdout');
  });

  await test('a failing fixture suite really surfaces its own exit code', async () => {
    const result = await realSpawner({ file: 'bad.ts', group: 'offline', args: [], requires: [] }, 60_000, true);
    assertEq(result.exitCode, 7, 'the failing fixture exit code was lost');
    assert(result.output.includes('fixture bad'), 'the runner did not capture stderr');
  });

  await test('a hanging fixture suite is killed and reported as a timeout', async () => {
    const result = await realSpawner({ file: 'hang.ts', group: 'offline', args: [], requires: [] }, 3000, true);
    assert(result.timedOut, 'a hanging suite was not timed out');
    assert(result.exitCode !== 0, 'a hanging suite reported a zero exit code');
  });

  await test('suite arguments arrive as argv, not as shell text', async () => {
    writeFileSync(join(WORK, 'test', 'argv.ts'), 'console.log("ARGV:" + process.argv.slice(2).join("|"));\n');
    const result = await realSpawner({ file: 'argv.ts', group: 'db', args: ['5433', 'a-b_c=1'], requires: [] }, 60_000, true);
    assertEq(result.exitCode, 0, 'the argv fixture failed');
    assert(result.output.includes('ARGV:5433|a-b_c=1'), `arguments did not arrive intact: ${result.output.trim()}`);
  });

  // --- the CLI, end to end -------------------------------------------------------------------------------------

  console.log('\nthe CLI exits with the code its verdict implies');

  const cli = fileURLToPath(new URL('../src/ops/test-runner-cli.ts', import.meta.url));
  const runCli = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const res = spawnSync(process.execPath, [tsxCliPath(ROOT), cli, ...args], { cwd: ROOT, encoding: 'utf8', shell: false });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  };

  await test('--audit passes against the shipped repository', () => {
    const res = runCli(['--audit']);
    assertEq(res.status, TEST_RUNNER_EXIT_OK, `the inventory audit failed: ${res.stderr}`);
    const report = JSON.parse(res.stdout) as { ok: boolean; suites: number; groups: string[] };
    assert(report.ok, 'the audit reported not-ok');
    assert(report.groups.includes('offline') && report.groups.includes('db'), 'the expected groups are missing');
  });

  await test('--list plans without running anything, and the plan covers every suite', () => {
    const res = runCli(['--list']);
    assertEq(res.status, TEST_RUNNER_EXIT_OK, `--list failed: ${res.stderr}`);
    const plan = JSON.parse(res.stdout) as { selected: string[]; skipped: Array<{ file: string }> };
    const audit = auditInventory(loadInventory(ROOT), listTestFiles(ROOT));
    assertEq(plan.selected.length + plan.skipped.length, audit.suiteCount, 'the plan does not account for every suite');
    assert(plan.selected.includes('test-runner.ts'), 'this suite is not in the default plan');
  });

  await test('an unknown option exits with the usage code', () => {
    assertEq(runCli(['--nope']).status, TEST_RUNNER_EXIT_USAGE, 'an unknown option did not exit 2');
  });

  await test('a filter that matches nothing fails instead of reporting a green empty run', () => {
    const res = runCli(['--filter', 'this-suite-does-not-exist']);
    assertEq(res.status, TEST_RUNNER_EXIT_USAGE, 'an empty selection exited zero');
    assert(res.stderr.includes('no suite was selected'), 'the empty selection was not explained');
  });

  await test('asking for a group this host cannot run reports a named skip, not a usage error', () => {
    // On a machine with a Docker daemon these suites run and this assertion is about a real run instead; both
    // outcomes are correct, and neither is "nothing was selected, exit 2", which is what a mistyped filter is.
    const res = runCli(['--group', 'docker']);
    assert(res.status === TEST_RUNNER_EXIT_OK || res.status === TEST_RUNNER_EXIT_SUITE_FAILURES,
      `--group docker exited ${res.status}: ${res.stderr}`);
    assert(!res.stderr.includes('no suite was selected'),
      'a capability this host lacks was reported as a mistyped selection');
    const output = res.stdout + res.stderr;
    assert(/release-candidate-acceptance\.ts/.test(output), 'the Docker suites were not named at all');
  });

  await test('--require-capabilities makes a host without Docker a failure rather than a skip', () => {
    const lenient = runCli(['--group', 'docker']);
    const strict = runCli(['--group', 'docker', '--require-capabilities']);
    // The one case this pins: whenever the lenient run SKIPPED, the strict run must FAIL. (If the host has a
    // daemon both actually run, and then they agree for the ordinary reason.)
    if (lenient.stdout.includes('RESULT: SKIPPED')) {
      assertEq(strict.status, TEST_RUNNER_EXIT_SUITE_FAILURES, 'a required-but-missing capability did not fail');
      assert(strict.stdout.includes('[REQUIRED]'), 'the strict run does not mark the skip as required');
    }
  });

  await test('the runner refuses to run against a drifted inventory', () => {
    // Proved against a COPY of the repository layout, so the real test/ is never mutated.
    const drift = join(WORK, 'drift');
    mkdirSync(join(drift, 'test'), { recursive: true });
    writeFileSync(join(drift, 'test', 'suite-inventory.json'), JSON.stringify({
      version: 1, helpers: [], suites: [{ file: 'known.ts', group: 'offline' }],
    }));
    writeFileSync(join(drift, 'test', 'known.ts'), 'process.exit(0);\n');
    writeFileSync(join(drift, 'test', 'sneaked-in.ts'), 'process.exit(0);\n');
    const audit = auditInventory(loadInventory(drift), listTestFiles(drift));
    assert(!audit.ok, 'a drifted inventory was accepted');
    assertEq(audit.unwired.join(','), 'sneaked-in.ts', 'the drift was not identified');
  });

  await test('a run of a real, fast suite reports PASS and exits zero', () => {
    const res = runCli(['--filter', 'cutover-parser.ts']);
    assertEq(res.status, TEST_RUNNER_EXIT_OK, `a known-good suite did not pass: ${res.stderr}${res.stdout}`);
    assert(res.stdout.includes('RESULT: PASS'), 'the run did not print a verdict');
  });

  await test('the seven suites that had drifted out of the aggregate are now in it', () => {
    const inv = loadInventory(ROOT);
    const wired = new Set(inv.suites.filter((s) => s.requires.length === 0).map((s) => s.file));
    for (const file of [
      'cutover-parser.ts', 'production-custody-switch.ts', 'operator-ui-csp-assets.ts',
      'operator-ui-installation-diagnostics.ts', 'release-readiness.ts', 'release-verification.ts',
      'release-rehearsal.ts',
    ]) {
      assert(wired.has(file), `${file} is still outside the default run`);
    }
  });

  await test('the Docker-only acceptance suites are inventoried, grouped and never silently dropped', () => {
    const inv = loadInventory(ROOT);
    for (const file of ['release-candidate-acceptance.ts', 'release-lifecycle-acceptance.ts']) {
      const entry = inv.suites.find((s) => s.file === file);
      assert(entry !== undefined, `${file} is not in the inventory`);
      assertEq(entry!.group, 'docker', `${file} is in the wrong group`);
      assertEq(entry!.requires.join(','), 'docker', `${file} does not declare its requirement`);
    }
    const plan = planRun(inv);
    const skipped = plan.skipped.map((s) => s.file);
    assert(skipped.includes('release-candidate-acceptance.ts'), 'the Docker suite is not reported as skipped');
  });

  await test('the package scripts expose the runner without disturbing the focused phase scripts', () => {
    for (const name of ['test', 'test:inventory', 'test:plan', 'test:offline', 'test:db', 'test:docker-suites', 'test:runner']) {
      assert(typeof PKG.scripts[name] === 'string', `package.json is missing the ${name} script`);
    }
    // The focused per-phase scripts are what CI drives; they must keep working exactly as they did.
    for (const name of ['test:phase257-local', 'test:phase256-local', 'test:operator-ui-service', 'test:config']) {
      assert(PKG.scripts[name]?.startsWith('tsx test/'), `the focused script ${name} was disturbed`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? String(err)}`);
  rmSync(WORK, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
