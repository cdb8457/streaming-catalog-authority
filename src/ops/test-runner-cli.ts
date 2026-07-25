import { writeFileSync } from 'node:fs';
import {
  TEST_INVENTORY_PATH,
  TEST_RUNNER_EXIT_INVENTORY,
  TEST_RUNNER_EXIT_OK,
  TEST_RUNNER_EXIT_USAGE,
  TEST_RUNNER_MAX_CONCURRENCY,
  TestInventoryError,
  parseTestRunnerArgs,
  type ParsedTestRunnerArgs,
  auditInventory,
  createSuiteSpawner,
  listTestFiles,
  loadInventory,
  planRun,
  probeCapability,
  renderRunReport,
  repositoryRoot,
  runPlan,
  tsxCliPath,
} from './test-runner.js';

// Phase 258 — the entry point `npm test` runs.
//
// It is eleven characters long in package.json instead of 11,935, because everything that used to be encoded
// in a shell string now lives in test/suite-inventory.json and in test-runner.ts. See that module's header
// for why the old shape could not be repaired in place.

function usage(): string {
  return [
    'usage: npm test [-- <options>]',
    '',
    'Runs the suites named in ' + TEST_INVENTORY_PATH + ', one process each, capturing every exit code.',
    '',
    'options:',
    '  --audit                 check the inventory against test/ and run nothing',
    '  --list                  print the plan and run nothing',
    '  --group <name>          run only this group (repeatable). Default: every group with no requirements.',
    '  --filter <substring>    run only suites whose file name contains this (repeatable)',
    '  --concurrency <n>       run n suites at once (1-' + TEST_RUNNER_MAX_CONCURRENCY + ', default 1)',
    '  --timeout-ms <n>        per-suite timeout (default 900000)',
    '  --require-capabilities  treat a missing capability as a failure instead of a named skip',
    '  --bail                  stop after the first failing suite',
    '  --json <path>           write the machine-readable run report here',
    '',
    'exit codes: 0 all selected suites passed | 1 a suite failed | 2 bad usage | 3 inventory drift',
  ].join('\n');
}

async function main(): Promise<number> {
  let args: ParsedTestRunnerArgs;
  try {
    args = parseTestRunnerArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error('');
    console.error(usage());
    return TEST_RUNNER_EXIT_USAGE;
  }
  if (args.help) {
    console.log(usage());
    return TEST_RUNNER_EXIT_OK;
  }

  const root = repositoryRoot();
  let inventory: ReturnType<typeof loadInventory>;
  try {
    inventory = loadInventory(root);
  } catch (err) {
    console.error(err instanceof TestInventoryError ? err.message : String(err));
    return TEST_RUNNER_EXIT_INVENTORY;
  }

  // THE DRIFT GATE, ALWAYS, BEFORE ANYTHING RUNS. A green run against an inventory that has silently stopped
  // describing test/ is the failure this phase exists to prevent, so it is checked on every invocation
  // rather than only under --audit.
  const audit = auditInventory(inventory, listTestFiles(root));
  if (!audit.ok) {
    console.error(`${TEST_INVENTORY_PATH} no longer describes ${'test'}/:`);
    for (const problem of audit.problems) console.error(`  - ${problem}`);
    return TEST_RUNNER_EXIT_INVENTORY;
  }
  if (args.audit) {
    console.log(JSON.stringify({
      report: 'phase-258-test-inventory-audit',
      ok: true,
      suites: audit.suiteCount,
      helpers: audit.helperCount,
      groups: [...new Set(inventory.suites.map((s) => s.group))].sort(),
    }, null, 2));
    return TEST_RUNNER_EXIT_OK;
  }

  // Only probe for capabilities a selected suite actually declares. A default run never shells out at all.
  const declared = new Set(
    inventory.suites
      .filter((s) => args.groups.length > 0 && args.groups.includes(s.group))
      .flatMap((s) => s.requires));
  const capabilities: string[] = [];
  for (const capability of [...declared].sort()) {
    if (await probeCapability(capability)) capabilities.push(capability);
  }

  let plan: ReturnType<typeof planRun>;
  try {
    plan = planRun(inventory, {
      groups: args.groups,
      filters: args.filters,
      requireCapabilities: args.requireCapabilities,
      bail: args.bail,
      capabilities,
      ...(args.concurrency === undefined ? {} : { concurrency: args.concurrency }),
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    });
  } catch (err) {
    console.error((err as Error).message);
    return TEST_RUNNER_EXIT_USAGE;
  }

  if (args.list) {
    console.log(JSON.stringify({
      report: 'phase-258-test-run-plan',
      concurrency: plan.concurrency,
      selected: plan.selected.map((s) => s.entry.file),
      skipped: plan.skipped.map((s) => ({ file: s.file, reason: s.reason, fatal: s.fatal })),
    }, null, 2));
    return TEST_RUNNER_EXIT_OK;
  }

  if (plan.selected.length === 0) {
    // A run that selected nothing is not a passing run. It is almost always a mistyped filter, and reporting
    // it as success is precisely the "exited zero without running the suite" behaviour being removed here.
    console.error('no suite was selected; nothing ran. Check --group and --filter.');
    return TEST_RUNNER_EXIT_USAGE;
  }

  let spawner: ReturnType<typeof createSuiteSpawner>;
  try {
    spawner = createSuiteSpawner(root, tsxCliPath(root));
  } catch (err) {
    console.error((err as Error).message);
    return TEST_RUNNER_EXIT_USAGE;
  }

  console.log(
    `Catalog Authority — running ${plan.selected.length} of ${inventory.suites.length} suites `
    + `(concurrency ${plan.concurrency}${plan.groups.length > 0 ? `, group(s) ${plan.groups.join(', ')}` : ''}).`);

  const report = await runPlan(plan, spawner, (line) => { process.stdout.write(`${line}\n`); });
  process.stdout.write(`${renderRunReport(report)}\n`);

  if (args.json !== undefined) {
    // The captured suite output is deliberately dropped from the file: it is unbounded, and a machine-readable
    // verdict does not need to carry every suite's stdout into an artifact.
    writeFileSync(args.json, `${JSON.stringify({
      ...report,
      results: report.results.map(({ output: _output, ...rest }) => rest),
    }, null, 2)}\n`, 'utf8');
  }
  return report.exitCode;
}

main().then((code) => { process.exitCode = code; }).catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = TEST_RUNNER_EXIT_USAGE;
});
