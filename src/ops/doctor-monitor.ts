import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DOCTOR_REPORT_VERSION, type CheckState, type DoctorCheck } from './doctor.js';
import {
  MaintenanceRefused,
  acquireLockDirectory,
  assertUsableName,
  readFileNoFollow,
  resolveInsideRoot,
  resolveMaintenanceRoot,
  runGuarded,
  writePrivateFile,
  type CommandLedger,
  type CommandRunner,
} from './maintenance-safety.js';
import { publishTemporary, SnapshotProducePathError } from './catalog-snapshot-produce.js';

// Phase 278 — running the doctor on a schedule without inventing a second definition of healthy.
//
// WHAT THIS IS. A wrapper that runs the EXISTING read-only `ops:doctor --json` inside the running stack,
// validates its stable contract, and writes one small redacted state file. It adds a schedule's two missing
// pieces — a durable record between runs, and a consecutive-failure count — and nothing else.
//
// IT DOES NOT ALERT, AND THAT IS DELIBERATE. It sends nothing outbound by any mechanism at all. An outbound
// alert is a network call made by a product whose whole boundary is that it makes none, and it is also the
// wrong architecture: a monitor that alerts is a monitor whose failures are silent when IT is the thing that
// is broken. This exits with a distinct code per state and writes a state file; the scheduler that already
// runs it — Unraid User Scripts, cron, systemd — is what alerts, from the exit code it already sees.
//
// IT NEVER SOFTENS THE DOCTOR. `warn` stays `warn`, `fail` stays `fail`, and the mapping from the doctor's
// own report to an exit code is a total function over its closed set of states. A monitor that turned a FAIL
// into a WARN because it happened twice would be a monitor that hides exactly what it exists to catch.
//
// THE STATE FILE IS REDACTED AND ATOMIC. Check names and states — which are this project's own closed
// vocabulary — a timestamp, a consecutive-failure count and a digest. No `detail` string is carried, because
// a detail is written for a person reading a terminal and this file is written for a machine and read by
// whoever finds it later. It is published by the same no-clobber primitive Phase 274 uses, so a scheduler
// that fires twice cannot leave a half-written state.

export const DOCTOR_MONITOR_REPORT = 'phase-278-doctor-monitor';
export const DOCTOR_MONITOR_VERSION = 1;
export const DOCTOR_MONITOR_STATE_NAME = 'doctor-monitor-state.json';
export const DOCTOR_MONITOR_LOCK_DIRNAME = '.doctor-monitor.lock';

// -----------------------------------------------------------------------------------------------------------
// WHAT COMES BACK FROM THE STACK IS INPUT, NOT TESTIMONY.
// -----------------------------------------------------------------------------------------------------------
//
// The doctor's JSON arrives from a process inside a container. It is this product's own tool and its contract
// is stable — and it is still the output of something that could have been replaced, misconfigured or wedged,
// and the answer is read on a schedule, written to a durable file, and rendered to a terminal. So every
// field is bounded and every name is checked against a vocabulary before anything is kept.
//
// A CHECK NAME IS AN IDENTIFIER, and this is the shape the shipped doctor emits: lowercase words joined by
// single hyphens. Anything else — a path, a URL, an escape sequence, a fragment of a secret that ended up in
// a name by accident — is not softened, sliced or escaped on the way through. It makes the whole report
// INVALID, because a report carrying a name of a shape this product never emits is not a report this build
// understands.

/** The most checks a doctor report may carry. The shipped doctor emits a dozen; this is room, not a target. */
export const MAX_DOCTOR_CHECKS = 64;
/** The most a check name may be. */
export const MAX_CHECK_NAME_LENGTH = 64;
/** The most a `detail` may be. It is never persisted — this bounds what is parsed at all. */
export const MAX_CHECK_DETAIL_LENGTH = 4096;
/** The most the doctor may say. A report past this is not a report; it is something else on that descriptor. */
export const MAX_DOCTOR_STDOUT_BYTES = 256 * 1024;
/** The most a state file may be. It is this module's own small document; anything larger is not one. */
export const MAX_STATE_FILE_BYTES = 1024 * 1024;

/** Lowercase words joined by single hyphens, and nothing else. */
export const CHECK_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isUsableCheckName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_CHECK_NAME_LENGTH && CHECK_NAME_PATTERN.test(name);
}

/**
 * Exit codes, distinct per state.
 *
 * A scheduler distinguishes them without parsing anything, which is the point: `0` is the only quiet one.
 */
export const DOCTOR_MONITOR_EXIT = Object.freeze({
  HEALTHY: 0,
  FAIL: 1,
  USAGE: 2,
  /** The doctor ran and something is WARN. Not a failure, and not silence either. */
  WARN: 3,
  /** The doctor could not be run, or answered something this build does not understand. */
  INVALID: 4,
});

export type MonitorState = 'HEALTHY' | 'WARN' | 'FAIL' | 'INVALID';

export interface MonitorCheckSummary {
  readonly name: string;
  readonly state: CheckState;
}

export interface DoctorMonitorState {
  readonly report: typeof DOCTOR_MONITOR_REPORT;
  readonly version: typeof DOCTOR_MONITOR_VERSION;
  readonly state: MonitorState;
  readonly at: string;
  /** How many runs in a row have not been HEALTHY. Reset by a healthy run, never by a restart. */
  readonly consecutiveFailures: number;
  readonly checks: readonly MonitorCheckSummary[];
  /** A digest over the check names and states, so two runs are comparable without diffing them. */
  readonly digest: string;
}

export interface DoctorMonitorReport extends DoctorMonitorState {
  readonly exitCode: number;
  readonly wrote: 'the monitor state file only';
  readonly network: 'none';
  readonly alerts: 'none — the scheduler alerts from the exit code';
  readonly notes: readonly string[];
}

export interface DoctorMonitorRequest {
  readonly projectRoot: string;
  /** Where the state file goes, relative to the project root. */
  readonly stateDir: string;
  /** The Compose service to run the doctor in. Named, never guessed. */
  readonly service?: string;
}

export interface DoctorMonitorDeps {
  readonly runner: CommandRunner;
  readonly ledger: CommandLedger;
  readonly now?: () => Date;
}

/**
 * Parse and validate the doctor's own stable JSON contract.
 *
 * ANYTHING UNEXPECTED IS `INVALID`, NOT `HEALTHY`. A monitor that treated an unparseable answer as an absence
 * of problems would report health whenever the thing it monitors is too broken to answer — which is the one
 * moment it matters.
 */
export function parseDoctorJson(text: string): { readonly ok: boolean; readonly checks: readonly DoctorCheck[] } | null {
  // BOUNDED BEFORE IT IS PARSED. `JSON.parse` on an unbounded string is an unbounded allocation, and a monitor
  // that can be made to exhaust memory by whatever is on the other end of a pipe is a monitor that stops
  // reporting exactly when something is wrong.
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCTOR_STDOUT_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const doc = parsed as { reportVersion?: unknown; ok?: unknown; checks?: unknown };
  if (doc.reportVersion !== DOCTOR_REPORT_VERSION) return null;
  if (typeof doc.ok !== 'boolean' || !Array.isArray(doc.checks)) return null;
  if (doc.checks.length > MAX_DOCTOR_CHECKS) return null;
  const checks: DoctorCheck[] = [];
  const seen = new Set<string>();
  for (const raw of doc.checks) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const check = raw as { name?: unknown; state?: unknown; detail?: unknown };
    if (typeof check.name !== 'string' || typeof check.detail !== 'string') return null;
    // THE NAME IS THE ONLY FIELD THAT SURVIVES INTO A DURABLE FILE AND A TERMINAL, so it is the one field
    // checked against a vocabulary rather than merely typed.
    if (!isUsableCheckName(check.name)) return null;
    // DUPLICATES ARE REFUSED, NOT DEDUPLICATED. Two checks of one name mean the report and the count disagree,
    // and a monitor that quietly picks one has decided which of two answers about your installation to keep.
    if (seen.has(check.name)) return null;
    seen.add(check.name);
    if (check.detail.length > MAX_CHECK_DETAIL_LENGTH) return null;
    if (check.state !== 'pass' && check.state !== 'warn' && check.state !== 'fail') return null;
    checks.push({ name: check.name, state: check.state, detail: check.detail });
  }
  if (checks.length === 0) return null;
  return { ok: doc.ok, checks };
}

/**
 * The state a doctor report is in.
 *
 * A TOTAL FUNCTION OVER THE DOCTOR'S CLOSED SET, in the order of severity. `ok` is cross-checked against the
 * checks rather than trusted: a report that says `ok: true` while carrying a `fail` is a report this build
 * does not understand, and `INVALID` is the honest answer to that.
 */
export function classifyDoctor(report: { readonly ok: boolean; readonly checks: readonly DoctorCheck[] }): MonitorState {
  const hasFail = report.checks.some((check) => check.state === 'fail');
  const hasWarn = report.checks.some((check) => check.state === 'warn');
  if (hasFail !== !report.ok) return 'INVALID';
  if (hasFail) return 'FAIL';
  return hasWarn ? 'WARN' : 'HEALTHY';
}

export const EXIT_FOR_STATE: Readonly<Record<MonitorState, number>> = Object.freeze({
  HEALTHY: DOCTOR_MONITOR_EXIT.HEALTHY,
  WARN: DOCTOR_MONITOR_EXIT.WARN,
  FAIL: DOCTOR_MONITOR_EXIT.FAIL,
  INVALID: DOCTOR_MONITOR_EXIT.INVALID,
});

/**
 * What the previous run left, and — where there is nothing usable — WHICH KIND of nothing.
 *
 * THE DIFFERENCE IS THE WHOLE POINT. "No file yet" is a first run. "A file that will not parse" is the
 * monitor's own memory having been lost or altered, and the two must not collapse into the same answer:
 * collapsing them means the consecutive-failure count — the one number that distinguishes a blip from an
 * outage, and the number an alerting threshold is set against — can be reset to zero by corrupting a file.
 */
export type PreviousMonitorState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'state'; readonly state: DoctorMonitorState };

export function readMonitorState(stateFile: string): PreviousMonitorState {
  if (!existsSync(stateFile)) return { kind: 'absent' };
  let parsed: Partial<DoctorMonitorState>;
  try {
    parsed = JSON.parse(
      readFileNoFollow(stateFile, 'monitor state file', MAX_STATE_FILE_BYTES).bytes.toString('utf8'),
    ) as Partial<DoctorMonitorState>;
  } catch {
    return { kind: 'unreadable' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unreadable' };
  if (parsed.report !== DOCTOR_MONITOR_REPORT || parsed.version !== DOCTOR_MONITOR_VERSION) return { kind: 'unreadable' };
  const count = parsed.consecutiveFailures;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return { kind: 'unreadable' };
  if (parsed.state !== 'HEALTHY' && parsed.state !== 'WARN' && parsed.state !== 'FAIL' && parsed.state !== 'INVALID') {
    return { kind: 'unreadable' };
  }
  return { kind: 'state', state: parsed as DoctorMonitorState };
}

/**
 * Run the doctor once, decide the state, and record it.
 *
 * The doctor command is the SHIPPED one, run inside the stack the operator already has, with `--json` — the
 * contract Phase 6 declared stable for exactly this. Nothing here reimplements a check.
 */
export function runDoctorMonitor(request: DoctorMonitorRequest, deps: DoctorMonitorDeps): DoctorMonitorReport {
  const projectRoot = resolveMaintenanceRoot(request.projectRoot, 'project root');
  const service = request.service ?? 'app';
  assertUsableName(service, 'service name');
  const stateDir = resolveInsideRoot(projectRoot, request.stateDir, 'monitor state directory');
  if (!existsSync(stateDir)) {
    throw new MaintenanceRefused('the monitor state directory is not there. Create it once, then schedule this.');
  }
  const now = deps.now ?? (() => new Date());
  const stateFile = join(stateDir, DOCTOR_MONITOR_STATE_NAME);

  // ONE MONITOR AT A TIME, AROUND THE WHOLE READ-MODIFY-WRITE. Two schedulers — or a scheduler and an
  // operator running it by hand — that both read a count of 4 both publish 5, and the run that should have
  // crossed an alerting threshold of 6 never does. The lock is taken BEFORE the previous state is read and
  // released after the new one is published, because it is the pair that has to be atomic, not either half.
  const lock = acquireLockDirectory(join(stateDir, DOCTOR_MONITOR_LOCK_DIRNAME),
    'another doctor-monitor run is in progress for this project, or one was interrupted and left its lock '
    + `behind (${DOCTOR_MONITOR_LOCK_DIRNAME} in the monitor state directory). This run did nothing: the `
    + 'consecutive-failure count is only correct if one run at a time keeps it.');
  try {
    return monitorUnderLock(projectRoot, service, stateFile, now, deps);
  } finally {
    lock.release();
  }
}

function monitorUnderLock(
  projectRoot: string,
  service: string,
  stateFile: string,
  now: () => Date,
  deps: DoctorMonitorDeps,
): DoctorMonitorReport {
  const previous = readMonitorState(stateFile);

  const outcome = runGuarded(deps.runner, deps.ledger, {
    program: 'docker',
    // `--no-deps` is deliberate and is the same flag Phase 257's inspect command carries: a monitor that
    // starts the database in order to check on it has changed what it was measuring.
    args: ['compose', 'exec', '-T', service, 'npm', 'run', '--silent', 'ops:doctor', '--', '--json'],
    cwd: projectRoot,
    purpose: 'run the shipped read-only doctor and read its stable JSON',
  });

  const parsed = parseDoctorJson(outcome.stdout);
  // THE PROCESS AND ITS OUTPUT MUST AGREE. The doctor exits non-zero when it found something; a body that
  // parses as HEALTHY behind a non-zero status means the two disagree about your installation, and there is
  // no honest way to pick one. A monitor that took the JSON and dropped the status would report health from a
  // command that failed — including the case where the JSON never came from the doctor at all.
  const statusOk = outcome.status === 0;
  const classified: MonitorState = parsed === null ? 'INVALID' : classifyDoctor(parsed);
  // A LOST HISTORY IS NOT A ZERO EITHER. Where the previous file existed and could not be read, the monitor's
  // own memory is the thing that failed, and that is a finding about the monitor rather than about the stack.
  const historyLost = previous.kind === 'unreadable';
  const understood = classified !== 'INVALID' && statusOk === (classified === 'HEALTHY' || classified === 'WARN');
  const state: MonitorState = understood && !historyLost ? classified : 'INVALID';

  // NOTHING THIS BUILD DID NOT UNDERSTAND IS EVER PERSISTED. Where the doctor's own answer was understood the
  // validated names are kept even if the RUN is INVALID for a reason outside them (a lost history), because
  // that answer is real and is what an operator needs to read. Where it was not, the durable file records no
  // names at all rather than names of an unknown provenance.
  const checks: readonly MonitorCheckSummary[] = parsed === null || !understood
    ? []
    : parsed.checks.map((check) => ({ name: check.name, state: check.state }));

  // CONSECUTIVE means consecutive. A healthy run resets it; every other state — including INVALID — adds to
  // it, because "I could not tell" happening five times in a row is itself the finding.
  const previousCount = previous.kind === 'state' ? previous.state.consecutiveFailures : 0;
  const consecutiveFailures = state === 'HEALTHY' ? 0 : previousCount + 1;

  // A CANONICAL JSON DOCUMENT RATHER THAN A SEPARATOR. Two fields joined by a delimiter are two fields a
  // value containing that delimiter can blur; JSON quotes them, and it keeps this file free of the control
  // bytes a repository-wide guard (rightly) refuses in source.
  const digest = createHash('sha256')
    .update(JSON.stringify([DOCTOR_MONITOR_REPORT, state, checks.map((c) => [c.name, c.state])]), 'utf8')
    .digest('hex');

  const next: DoctorMonitorState = {
    report: DOCTOR_MONITOR_REPORT,
    version: DOCTOR_MONITOR_VERSION,
    state,
    at: now().toISOString(),
    consecutiveFailures,
    checks,
    digest,
  };
  writeMonitorState(stateFile, next);

  const notes: string[] = [];
  if (state === 'INVALID') {
    notes.push('The doctor did not answer in the shape this build understands. That is not evidence of health: '
      + 'treat it as an outage of the check itself.');
  }
  // THE STATUS AND THE STDERR ARE FACTS ABOUT THE RUN AND ARE REPORTED AS FACTS — a closed sentence and a
  // byte count. The stderr TEXT is never carried: it is written by whatever was on the other end of that pipe
  // and can hold a path, a connection string or a fragment of a secret.
  if (!statusOk) {
    notes.push('The doctor command itself exited non-zero. Whatever it printed was not treated as a healthy '
      + 'answer, whether or not it parsed as one.');
  }
  if (outcome.stderr.length > 0) {
    notes.push(`The doctor wrote ${Buffer.byteLength(outcome.stderr, 'utf8')} bytes to its error stream. The text `
      + 'is deliberately not carried here; run the doctor directly to read it.');
  }
  if (historyLost) {
    notes.push('The previous monitor state file was there and could not be read. The consecutive-failure count '
      + 'could not be continued, so this run counts as one rather than as none, and it is INVALID: a monitor '
      + 'that cannot remember cannot tell you a blip from an outage.');
  }
  if (consecutiveFailures >= 3) {
    notes.push(`This is run ${consecutiveFailures} in a row that was not healthy.`);
  }
  notes.push('No alert was sent and nothing was contacted. Your scheduler decides what a non-zero exit means.');

  return {
    ...next,
    exitCode: EXIT_FOR_STATE[state],
    wrote: 'the monitor state file only',
    network: 'none',
    alerts: 'none — the scheduler alerts from the exit code',
    notes,
  };
}

/**
 * Replace the state file atomically.
 *
 * A scheduler that overlaps itself, or a machine that loses power mid-write, must never leave a state file
 * that parses as something it was not. The bytes go to a private temporary beside it and are published with
 * Phase 274's own primitive, in its replace mode — replacing IS what a state file wants, and saying so
 * explicitly is what stops the no-clobber default from being weakened somewhere it matters.
 */
function writeMonitorState(stateFile: string, state: DoctorMonitorState): void {
  const temporary = `${stateFile}.tmp-${process.pid}`;
  const text = `${JSON.stringify(state, null, 2)}\n`;
  try {
    writePrivateFile(temporary, text, 'monitor state file');
  } catch {
    throw new MaintenanceRefused('the monitor state could not be written; check the state directory is writable');
  }
  try {
    publishTemporary(temporary, stateFile, true);
  } catch (err) {
    throw new MaintenanceRefused(
      err instanceof SnapshotProducePathError ? err.message : 'the monitor state could not be moved into place');
  }
}

/** The human summary. Check names and states, a count, a digest. Never a `detail`, never a path. */
export function renderDoctorMonitor(report: DoctorMonitorReport): string {
  const lines: string[] = [];
  lines.push(`Doctor monitor — ${report.state}`);
  lines.push(`  at                    ${report.at}`);
  lines.push(`  consecutive failures  ${report.consecutiveFailures}`);
  lines.push(`  digest                ${report.digest.slice(0, 16)}`);
  lines.push(`  wrote                 ${report.wrote}`);
  lines.push(`  alerts                ${report.alerts}`);
  if (report.checks.length === 0) lines.push('  checks: none could be read');
  else {
    lines.push('  checks:');
    for (const check of report.checks) lines.push(`    ${check.state.toUpperCase().padEnd(5)} ${check.name}`);
  }
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push(`  EXIT: ${report.exitCode}`);
  return lines.join('\n');
}
