import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Phase 258 — the aggregate test command, as a program instead of a shell string.
//
// WHAT WAS WRONG. `npm test` was a single 11,935-character `&&` chain naming 282 suite files. Three separate
// defects fell out of that shape, and none of them could be fixed by editing the string:
//
//   1. IT DID NOT RUN ON WINDOWS. npm hands a script to the platform shell, and cmd.exe refuses a command
//      line over 8,191 characters. The whole suite was unreachable on a developer machine that is one of the
//      two platforms this project documents install instructions for.
//   2. A CHAIN CAN STOP EARLY AND STILL LOOK FINE. `a && b && c` reports the exit code of whatever ran last.
//      Anything that truncated or rewrote the string — a shell limit, an editor, a merge — produced a
//      shorter chain that still ended in a zero exit, and a shorter chain is indistinguishable from a
//      complete one when the only evidence is `echo $?`.
//   3. NOTHING NOTICED A SUITE THAT WAS NEVER WIRED IN. Thirteen files under test/ were outside the chain
//      when this was written. Seven of them were real, passing, offline suites that simply never ran in the
//      aggregate. A test that nobody runs is a test that does not exist, and the failure mode is silent.
//
// WHAT THIS IS INSTEAD. An explicit inventory (test/suite-inventory.json) that names every file under test/
// exactly once — as a SUITE that must run, or as a HELPER that is imported rather than executed — plus a
// runner that executes the selected suites one process at a time (or a bounded few), captures each exit code
// individually, and refuses to exit zero unless every selected suite actually ran and passed.
//
// NO SHELL, ANYWHERE. Suites are spawned as `node <tsx-cli> <file> [args]` with an argument ARRAY and
// `shell: false`. There is no command line for a shell to truncate, so the length of the inventory is
// unbounded by the platform and identical on Windows, macOS and Linux.
//
// DRIFT IS A FAILURE, NOT A WARNING. Every run begins by comparing the inventory against the actual contents
// of test/. A new file that is in neither list, or an inventory entry whose file has been deleted, exits
// non-zero before a single suite is spawned. That is the guarantee that a new suite cannot quietly exist
// outside the aggregate and CI graph — the exact defect this phase was opened to close.
//
// A SKIP IS NAMED, COUNTED AND NEVER A PASS. Suites that need something this process cannot assume (a Docker
// daemon) declare it. They are still in the inventory, so they cannot drift; they are reported by name with
// their reason; they are counted separately from passes; and `--require-capabilities` turns any such skip
// into a failure for the CI jobs that must not tolerate one.

export const TEST_INVENTORY_PATH = 'test/suite-inventory.json';
export const TEST_DIR = 'test';

/** Concurrency is bounded on both ends. One is the default; the ceiling keeps a 291-suite run from forking a machine flat. */
export const TEST_RUNNER_MIN_CONCURRENCY = 1;
export const TEST_RUNNER_MAX_CONCURRENCY = 8;
export const TEST_RUNNER_DEFAULT_CONCURRENCY = 1;
/** A suite that has produced nothing for this long is hung, and a hung suite must fail rather than wedge CI. */
export const TEST_RUNNER_DEFAULT_TIMEOUT_MS = 900_000;

export const TEST_RUNNER_EXIT_OK = 0;
export const TEST_RUNNER_EXIT_SUITE_FAILURES = 1;
export const TEST_RUNNER_EXIT_USAGE = 2;
export const TEST_RUNNER_EXIT_INVENTORY = 3;

export interface SuiteEntry {
  /** File name relative to test/. Never a path: the runner joins it to test/ itself. */
  readonly file: string;
  readonly group: string;
  /** Extra argv for the suite. The embedded-PostgreSQL suites take a per-suite port here. */
  readonly args: readonly string[];
  /** Capabilities this suite cannot run without. Empty for everything that is pure and offline. */
  readonly requires: readonly string[];
}

export interface SuiteInventory {
  readonly version: number;
  /** Files under test/ that are imported by suites rather than executed as one. */
  readonly helpers: readonly string[];
  readonly suites: readonly SuiteEntry[];
}

export class TestInventoryError extends Error {
  readonly code = 'TEST_INVENTORY_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'TestInventoryError';
  }
}

/** A file name that is a bare name — no directory part, no traversal, no absolute root. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]+\.ts$/;
const SAFE_GROUP = /^[a-z][a-z0-9-]*$/;
const SAFE_ARG = /^[A-Za-z0-9._=-]+$/;
const SAFE_CAPABILITY = /^[a-z][a-z0-9-]*$/;

/**
 * Parse and fully validate the inventory document.
 *
 * Strict on purpose. This file decides what runs, so a typo in it must be a loud rejection rather than a
 * suite that silently stops being selected. Every field is checked, unknown keys are refused, and the file
 * names are constrained to bare names so an entry can never point outside test/.
 */
export function parseSuiteInventory(raw: unknown): SuiteInventory {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TestInventoryError('the suite inventory must be a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (key !== 'version' && key !== 'helpers' && key !== 'suites') {
      throw new TestInventoryError(`the suite inventory has an unknown top-level key: ${key}`);
    }
  }
  if (doc.version !== 1) throw new TestInventoryError('the suite inventory version must be 1');
  if (!Array.isArray(doc.helpers)) throw new TestInventoryError('the suite inventory helpers must be an array');
  if (!Array.isArray(doc.suites)) throw new TestInventoryError('the suite inventory suites must be an array');
  if (doc.suites.length === 0) throw new TestInventoryError('the suite inventory lists no suites');

  const helpers: string[] = [];
  for (const helper of doc.helpers) {
    if (typeof helper !== 'string' || !SAFE_FILE_NAME.test(helper)) {
      throw new TestInventoryError('every helper must be a bare .ts file name under test/');
    }
    helpers.push(helper);
  }

  const suites: SuiteEntry[] = [];
  for (const entry of doc.suites) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TestInventoryError('every suite entry must be an object');
    }
    const rec = entry as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (key !== 'file' && key !== 'group' && key !== 'args' && key !== 'requires') {
        throw new TestInventoryError(`a suite entry has an unknown key: ${key}`);
      }
    }
    const file = rec.file;
    if (typeof file !== 'string' || !SAFE_FILE_NAME.test(file)) {
      throw new TestInventoryError('every suite entry needs a bare .ts file name under test/');
    }
    const group = rec.group;
    if (typeof group !== 'string' || !SAFE_GROUP.test(group)) {
      throw new TestInventoryError(`suite ${file} needs a lower-case group name`);
    }
    const args = normalizeStringList(rec.args, SAFE_ARG, `suite ${file} has an unusable argument`);
    const requires = normalizeStringList(rec.requires, SAFE_CAPABILITY, `suite ${file} has an unusable requirement`);
    suites.push({ file, group, args, requires });
  }
  return { version: 1, helpers, suites };
}

function normalizeStringList(value: unknown, pattern: RegExp, message: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TestInventoryError(message);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 64 || !pattern.test(item)) {
      throw new TestInventoryError(message);
    }
    out.push(item);
  }
  return out;
}

export interface InventoryAudit {
  readonly ok: boolean;
  /** Files present under test/ that the inventory does not account for at all. This is the drift that matters. */
  readonly unwired: readonly string[];
  /** Inventory entries whose file is not on disk. */
  readonly missing: readonly string[];
  /** A file named more than once (as two suites, or as both a suite and a helper). */
  readonly duplicated: readonly string[];
  /** Two suites that would be given the same extra argument — the embedded-PostgreSQL port collision. */
  readonly collidingArgs: readonly string[];
  readonly suiteCount: number;
  readonly helperCount: number;
  readonly problems: readonly string[];
}

/**
 * Compare the inventory against what is actually on disk.
 *
 * The one check that makes the rest trustworthy. `unwired` is the defect this phase exists to prevent: a
 * suite file that someone added and nobody runs. `missing` is its mirror — an inventory that still names a
 * file that was deleted, which would otherwise fail at spawn time with a confusing error.
 */
export function auditInventory(inventory: SuiteInventory, presentFiles: readonly string[]): InventoryAudit {
  const present = new Set(presentFiles);
  const seen = new Set<string>();
  const duplicated: string[] = [];
  for (const name of [...inventory.suites.map((s) => s.file), ...inventory.helpers]) {
    if (seen.has(name)) duplicated.push(name);
    else seen.add(name);
  }

  const unwired = presentFiles.filter((file) => !seen.has(file)).sort();
  const missing = [...seen].filter((file) => !present.has(file)).sort();

  const argSeen = new Map<string, string>();
  const collidingArgs: string[] = [];
  for (const suite of inventory.suites) {
    for (const arg of suite.args) {
      const owner = argSeen.get(arg);
      if (owner !== undefined) collidingArgs.push(`${arg} (${owner} and ${suite.file})`);
      else argSeen.set(arg, suite.file);
    }
  }

  const problems: string[] = [];
  if (unwired.length > 0) {
    problems.push(
      `${unwired.length} file(s) under ${TEST_DIR}/ are in neither the suite list nor the helper list of `
      + `${TEST_INVENTORY_PATH}: ${unwired.join(', ')}. Add each one as a suite (so it runs) or as a helper `
      + '(if it is imported rather than executed).');
  }
  if (missing.length > 0) {
    problems.push(`${TEST_INVENTORY_PATH} names ${missing.length} file(s) that do not exist: ${missing.join(', ')}.`);
  }
  if (duplicated.length > 0) {
    problems.push(`${TEST_INVENTORY_PATH} names the same file more than once: ${[...new Set(duplicated)].join(', ')}.`);
  }
  if (collidingArgs.length > 0) {
    problems.push(
      `two suites would be given the same argument, which is a port collision when they run concurrently: `
      + `${collidingArgs.join(', ')}.`);
  }

  return {
    ok: problems.length === 0,
    unwired,
    missing,
    duplicated: [...new Set(duplicated)].sort(),
    collidingArgs,
    suiteCount: inventory.suites.length,
    helperCount: inventory.helpers.length,
    problems,
  };
}

export interface RunOptions {
  /** Group names to run. Empty means "every group that declares no requirements". */
  readonly groups?: readonly string[];
  /** Substring filters over suite file names. Empty means no filtering. */
  readonly filters?: readonly string[];
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  /** Turn a capability skip into a failure. The CI jobs that must not silently skip set this. */
  readonly requireCapabilities?: boolean;
  /** Stop spawning after the first failure. Off by default: one full run reports every broken suite at once. */
  readonly bail?: boolean;
  /** Capabilities this host actually has. */
  readonly capabilities?: readonly string[];
}

export interface PlannedSuite {
  readonly entry: SuiteEntry;
}

export interface SkippedSuite {
  readonly file: string;
  readonly group: string;
  readonly reason: string;
  /** True when this skip must be treated as a failure. */
  readonly fatal: boolean;
}

export interface RunPlan {
  readonly selected: readonly PlannedSuite[];
  readonly skipped: readonly SkippedSuite[];
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly groups: readonly string[];
  /** Stop spawning after the first failure. Entries never reached are reported as failures, never as passes. */
  readonly bail: boolean;
}

export class TestRunnerUsageError extends Error {
  readonly code = 'TEST_RUNNER_USAGE_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'TestRunnerUsageError';
  }
}

/**
 * Decide what will run, before anything runs.
 *
 * Selection is explicit in both directions: a suite is either selected or it appears in `skipped` with the
 * reason it did not. Nothing is silently dropped, so the printed plan and the printed summary account for
 * every entry in the inventory.
 */
export function planRun(inventory: SuiteInventory, options: RunOptions = {}): RunPlan {
  const concurrency = options.concurrency ?? TEST_RUNNER_DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < TEST_RUNNER_MIN_CONCURRENCY || concurrency > TEST_RUNNER_MAX_CONCURRENCY) {
    throw new TestRunnerUsageError(
      `concurrency must be an integer between ${TEST_RUNNER_MIN_CONCURRENCY} and ${TEST_RUNNER_MAX_CONCURRENCY}`);
  }
  const timeoutMs = options.timeoutMs ?? TEST_RUNNER_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) {
    throw new TestRunnerUsageError('timeout must be an integer number of milliseconds between 1000 and 3600000');
  }

  const knownGroups = new Set(inventory.suites.map((s) => s.group));
  const requestedGroups = options.groups ?? [];
  for (const group of requestedGroups) {
    if (!knownGroups.has(group)) {
      throw new TestRunnerUsageError(`no suite is in group "${group}" (known groups: ${[...knownGroups].sort().join(', ')})`);
    }
  }
  const filters = options.filters ?? [];
  const capabilities = new Set(options.capabilities ?? []);

  const selected: PlannedSuite[] = [];
  const skipped: SkippedSuite[] = [];
  for (const entry of inventory.suites) {
    if (requestedGroups.length > 0) {
      if (!requestedGroups.includes(entry.group)) {
        skipped.push({ file: entry.file, group: entry.group, reason: `not in the selected group(s): ${requestedGroups.join(', ')}`, fatal: false });
        continue;
      }
    } else if (entry.requires.length > 0) {
      // The DEFAULT run is what an ordinary developer and the ordinary CI gate execute, so it contains only
      // suites that can run anywhere. A suite with a requirement is not hidden — it is reported by name with
      // the group that runs it — but it is not pretended to have passed either.
      skipped.push({
        file: entry.file,
        group: entry.group,
        reason: `requires ${entry.requires.join(', ')}; run it with --group ${entry.group}`,
        fatal: false,
      });
      continue;
    }
    if (filters.length > 0 && !filters.some((f) => entry.file.includes(f))) {
      skipped.push({ file: entry.file, group: entry.group, reason: 'did not match --filter', fatal: false });
      continue;
    }
    const unmet = entry.requires.filter((cap) => !capabilities.has(cap));
    if (unmet.length > 0) {
      skipped.push({
        file: entry.file,
        group: entry.group,
        reason: `this host does not provide: ${unmet.join(', ')}`,
        fatal: options.requireCapabilities === true,
      });
      continue;
    }
    selected.push({ entry });
  }

  return { selected, skipped, concurrency, timeoutMs, groups: [...requestedGroups], bail: options.bail === true };
}

export type SuiteOutcome = 'pass' | 'fail' | 'timeout' | 'spawn-error';

export interface SuiteResult {
  readonly file: string;
  readonly group: string;
  readonly outcome: SuiteOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  /** Captured output, only when the runner captured it (concurrency > 1). */
  readonly output?: string;
  readonly detail?: string;
}

export interface RunReport {
  readonly ok: boolean;
  readonly report: 'phase-258-test-runner';
  readonly selectedCount: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly fatalSkips: number;
  readonly durationMs: number;
  readonly results: readonly SuiteResult[];
  readonly skippedSuites: readonly SkippedSuite[];
  readonly exitCode: number;
}

export interface SpawnedSuite {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly output: string;
  readonly spawnError?: string;
}

export type SuiteSpawner = (entry: SuiteEntry, timeoutMs: number, capture: boolean) => Promise<SpawnedSuite>;

/**
 * Execute the plan.
 *
 * Every suite gets its OWN process and its OWN exit code, and the report is assembled from those codes
 * rather than from the code of whatever ran last. A run in which any suite failed, timed out, could not be
 * spawned, or was fatally skipped is a run that exits non-zero — there is no arrangement of results that
 * produces a zero exit while something did not pass.
 */
export async function runPlan(plan: RunPlan, spawner: SuiteSpawner, sink: (line: string) => void, now: () => number = Date.now): Promise<RunReport> {
  const startedAt = now();
  const capture = plan.concurrency > 1;
  const results: SuiteResult[] = new Array(plan.selected.length);
  let nextIndex = 0;
  let failures = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      const index = nextIndex;
      if (index >= plan.selected.length) return;
      nextIndex += 1;
      const { entry } = plan.selected[index]!;
      const suiteStart = now();
      if (!capture) sink(`--> ${entry.file}${entry.args.length > 0 ? ` ${entry.args.join(' ')}` : ''}`);
      const spawned = await spawner(entry, plan.timeoutMs, capture);
      const durationMs = now() - suiteStart;
      const outcome: SuiteOutcome = spawned.spawnError !== undefined
        ? 'spawn-error'
        : spawned.timedOut
          ? 'timeout'
          : spawned.exitCode === 0 && spawned.signal === null ? 'pass' : 'fail';
      const result: SuiteResult = {
        file: entry.file,
        group: entry.group,
        outcome,
        exitCode: spawned.exitCode,
        signal: spawned.signal,
        durationMs,
        ...(capture ? { output: spawned.output } : {}),
        ...(spawned.spawnError !== undefined ? { detail: spawned.spawnError } : {}),
      };
      results[index] = result;
      if (outcome !== 'pass') failures += 1;
      if (capture) {
        sink(`--> ${entry.file}`);
        if (spawned.output.length > 0) sink(spawned.output.replace(/\n$/, ''));
      }
      sink(`${outcome === 'pass' ? 'PASS' : 'FAIL'} ${entry.file} (${describeExit(result)}, ${durationMs}ms)`);
      if (outcome !== 'pass' && plan.bail) stopped = true;
    }
  };

  const workers = Array.from({ length: Math.min(plan.concurrency, Math.max(plan.selected.length, 1)) }, worker);
  await Promise.all(workers);

  // A bail leaves later entries unrun. They are reported as failures rather than omitted: "we stopped before
  // this one" is not the same claim as "this one passed", and the summary must never imply the second.
  const finalResults: SuiteResult[] = [];
  for (let i = 0; i < plan.selected.length; i += 1) {
    const result = results[i];
    if (result !== undefined) { finalResults.push(result); continue; }
    const { entry } = plan.selected[i]!;
    finalResults.push({
      file: entry.file,
      group: entry.group,
      outcome: 'fail',
      exitCode: null,
      signal: null,
      durationMs: 0,
      detail: 'not run: the runner stopped at the first failure (--bail)',
    });
    failures += 1;
  }

  const fatalSkips = plan.skipped.filter((s) => s.fatal).length;
  const passed = finalResults.filter((r) => r.outcome === 'pass').length;
  const ok = failures === 0 && fatalSkips === 0 && finalResults.length === plan.selected.length;
  return {
    ok,
    report: 'phase-258-test-runner',
    selectedCount: plan.selected.length,
    passed,
    failed: failures,
    skipped: plan.skipped.length,
    fatalSkips,
    durationMs: now() - startedAt,
    results: finalResults,
    skippedSuites: plan.skipped,
    exitCode: ok ? TEST_RUNNER_EXIT_OK : TEST_RUNNER_EXIT_SUITE_FAILURES,
  };
}

function describeExit(result: SuiteResult): string {
  if (result.outcome === 'spawn-error') return `could not start: ${result.detail ?? 'unknown'}`;
  if (result.outcome === 'timeout') return 'timed out';
  if (result.signal !== null) return `killed by ${result.signal}`;
  return `exit ${result.exitCode ?? 'none'}`;
}

/**
 * The end-of-run summary.
 *
 * Deterministic and complete: every selected suite that did not pass is named with its reason, every skip is
 * named with its reason, and the counts add up to the size of the inventory selection. Somebody reading only
 * this block can tell whether the run was whole.
 */
export function renderRunReport(report: RunReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('================ Catalog Authority test run ================');
  const failed = report.results.filter((r) => r.outcome !== 'pass');
  if (failed.length > 0) {
    lines.push(`FAILED (${failed.length}):`);
    for (const result of failed) lines.push(`  ${result.file} — ${describeExit(result)}`);
  }
  if (report.skippedSuites.length > 0) {
    // A suite left out by an explicit `--group` or `--filter` is not news — the operator asked for that. A
    // suite left out for any OTHER reason is, and a required-but-unmet one always is. Parenthesised because
    // the reader should not have to remember that `&&` binds tighter than `||` to check this.
    const shown = report.skippedSuites.filter((s) => s.fatal
      || (!s.reason.startsWith('not in the selected group') && s.reason !== 'did not match --filter'));
    if (shown.length > 0) {
      lines.push(`SKIPPED (${shown.length} of ${report.skippedSuites.length} unselected):`);
      for (const skip of shown) lines.push(`  ${skip.file} — ${skip.reason}${skip.fatal ? ' [REQUIRED]' : ''}`);
    }
  }
  lines.push(
    `suites selected ${report.selectedCount} | passed ${report.passed} | failed ${report.failed} `
    + `| not selected ${report.skipped} | required-but-skipped ${report.fatalSkips} | ${Math.round(report.durationMs / 1000)}s`);
  lines.push(report.ok ? 'RESULT: PASS — every selected suite ran and exited zero.' : 'RESULT: FAIL');
  lines.push('============================================================');
  return lines.join('\n');
}

// --- host-facing plumbing ------------------------------------------------------------------------------

export function repositoryRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

/** The tsx CLI entry point, resolved as a FILE so a suite is spawned as `node <file>` with no shell. */
export function tsxCliPath(root: string = repositoryRoot()): string {
  const path = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(path)) {
    throw new TestRunnerUsageError('tsx is not installed; run `npm ci` before running the test suite');
  }
  return path;
}

export function loadInventory(root: string = repositoryRoot()): SuiteInventory {
  const path = join(root, TEST_INVENTORY_PATH);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new TestInventoryError(`${TEST_INVENTORY_PATH} could not be read`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TestInventoryError(`${TEST_INVENTORY_PATH} is not valid JSON`);
  }
  return parseSuiteInventory(parsed);
}

export function listTestFiles(root: string = repositoryRoot()): string[] {
  return readdirSync(join(root, TEST_DIR), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => e.name)
    .sort();
}

/**
 * Spawn one suite.
 *
 * `shell: false` (the default, stated here because it is the property the whole phase turns on) and an
 * argument ARRAY: there is no command string, so no platform's command-line limit applies and no value in
 * the inventory can be interpreted as shell syntax.
 */
export function createSuiteSpawner(root: string = repositoryRoot(), cli: string = tsxCliPath(root)): SuiteSpawner {
  return (entry, timeoutMs, capture) => new Promise<SpawnedSuite>((resolve) => {
    const child = spawn(process.execPath, [cli, join(TEST_DIR, entry.file), ...entry.args], {
      cwd: root,
      shell: false,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' },
    });
    let output = '';
    let timedOut = false;
    let settled = false;
    if (capture) {
      child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    const finish = (value: SpawnedSuite): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.on('error', (err) => {
      finish({ exitCode: null, signal: null, timedOut, output, spawnError: (err as Error).message });
    });
    child.on('close', (code, signal) => {
      finish({ exitCode: code, signal, timedOut, output });
    });
  });
}

export interface ParsedTestRunnerArgs {
  readonly audit: boolean;
  readonly list: boolean;
  readonly help: boolean;
  readonly groups: readonly string[];
  readonly filters: readonly string[];
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly requireCapabilities: boolean;
  readonly bail: boolean;
  readonly json?: string;
}

/**
 * Strict argument parsing: an unknown flag is a usage error, never a silently ignored token.
 *
 * It lives here rather than in the CLI module so the tests can exercise it without importing a module whose
 * import side effect is to run the entire test suite.
 */
export function parseTestRunnerArgs(argv: readonly string[]): ParsedTestRunnerArgs {
  const groups: string[] = [];
  const filters: string[] = [];
  let audit = false;
  let list = false;
  let help = false;
  let requireCapabilities = false;
  let bail = false;
  let concurrency: number | undefined;
  let timeoutMs: number | undefined;
  let json: string | undefined;

  const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith('--')) throw new TestRunnerUsageError(`${flag} needs a value`);
    return value;
  };
  const requireInt = (flag: string, value: string | undefined): number => {
    const raw = requireValue(flag, value);
    if (!/^\d+$/.test(raw)) throw new TestRunnerUsageError(`${flag} needs a whole number`);
    return Number(raw);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--audit': audit = true; break;
      case '--list': list = true; break;
      case '--help': case '-h': help = true; break;
      case '--require-capabilities': requireCapabilities = true; break;
      case '--bail': bail = true; break;
      case '--group': groups.push(requireValue(arg, argv[i + 1])); i += 1; break;
      case '--filter': filters.push(requireValue(arg, argv[i + 1])); i += 1; break;
      case '--concurrency': concurrency = requireInt(arg, argv[i + 1]); i += 1; break;
      case '--timeout-ms': timeoutMs = requireInt(arg, argv[i + 1]); i += 1; break;
      case '--json': json = requireValue(arg, argv[i + 1]); i += 1; break;
      default: throw new TestRunnerUsageError(`unknown option: ${arg}`);
    }
  }
  return {
    audit, list, help, groups, filters, requireCapabilities, bail,
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(json === undefined ? {} : { json }),
  };
}

/** Probe a capability without asserting anything about the host. Only ever called for a selected requirement. */
export function probeCapability(capability: string): Promise<boolean> {
  if (capability !== 'docker') return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const child = spawn('docker', ['version', '--format', '{{.Server.Version}}'], { shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 10_000);
    timer.unref?.();
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
