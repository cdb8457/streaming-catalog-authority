import type { SpawnSyncReturns } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { removeQuietly } from '../../src/ops/usable-shell.js';

// How the acceptance suites decide whether a Docker-dependent orchestrator behaved, WITHOUT ever predicting
// what that orchestrator is about to observe.
//
// The bug this exists to make impossible: the Phase 248/249 suites used to probe `docker info` from Node,
// and — if that one probe failed — assert that the orchestrator they launched a moment later MUST exit 3
// (SKIP). Those are two separate processes asking two separate daemons-at-a-moment-in-time. In PR 21's
// run 30093160235 (attempt 1) the probe hit a transient `docker info` failure, the orchestrator then reached
// a perfectly healthy daemon, ran the whole lifecycle and exited 0 — and the suite failed the build for
// "expected 3, got 0". The run was correct; the prediction was not.
//
// Two rules follow, and both are enforced here rather than in each suite:
//
//   1. NEVER infer a required outcome from an earlier probe. A run is judged by what IT reported — its exit
//      code and its own output — via `classifyAcceptanceRun`. There is no input for "what we thought Docker
//      was doing beforehand", so no suite can accidentally take one.
//   2. When a suite wants to exercise the no-daemon contract, it does not WAIT for a host that happens to
//      have no daemon: it MAKES the daemon unreachable for that one child process, with `unreachableDocker`.
//      The orchestrator's own preflight then fails for a reason we created, on every host, every time.
//
// The point of (2) is that the honest-skip contract is now actually tested everywhere — including on CI
// runners and developer machines that DO have Docker, where the old suites quietly tested nothing at all.

/**
 * What an acceptance orchestrator did, as it reported it.
 *
 * `RAN_FOR_REAL` is deliberately a first-class, non-failing verdict: a run that really executed is a fact to
 * be read, never a contract violation. That is the whole fix — the old code had no way to say it.
 */
export type AcceptanceVerdict =
  /** exit 3 and it said SKIP: the honest developer-laptop skip. */
  | 'HONEST_SKIP'
  /** exit 1 because REQUIRE_ACCEPTANCE=1 turned a missing prerequisite into a failure. Never a silent skip. */
  | 'REFUSED_TO_SKIP'
  /** exit 0 with no skip announced: the acceptance actually ran. */
  | 'RAN_FOR_REAL'
  /** exit 0 WITH a skip announced: a skip dressed up as a pass. Always a defect, whatever the caller wanted. */
  | 'SKIP_CLAIMED_AS_PASS'
  /** anything else, including a genuine orchestration failure (exit 1 that is not the refusal-to-skip). */
  | 'FAILED';

export interface AcceptanceRun {
  readonly status: number | null;
  /** stdout and stderr together: the orchestrator writes SKIP: to stdout and FAIL: to stderr. */
  readonly output: string;
}

/** Everything the verdict is allowed to depend on, taken from a finished child process. */
export function acceptanceRun(run: SpawnSyncReturns<string>): AcceptanceRun {
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

/**
 * Judge a finished acceptance run by its own exit code and its own words.
 *
 * The pairing matters as much as the codes: exit 3 is only an honest skip if the run SAID it skipped, and
 * exit 1 is only the no-silent-skip refusal if the run said REQUIRE_ACCEPTANCE=1 is why it refused. An exit 1
 * that says neither is a real orchestration failure and is reported as one, so the fix for the flake cannot
 * quietly swallow a broken lifecycle.
 */
export function classifyAcceptanceRun(run: AcceptanceRun): AcceptanceVerdict {
  const announcedSkip = /^SKIP:/m.test(run.output);
  const refusedToSkip = /^FAIL:.*REQUIRE_ACCEPTANCE=1/m.test(run.output);
  switch (run.status) {
    case 0: return announcedSkip ? 'SKIP_CLAIMED_AS_PASS' : 'RAN_FOR_REAL';
    case 3: return announcedSkip ? 'HONEST_SKIP' : 'FAILED';
    case 1: return refusedToSkip && !announcedSkip ? 'REFUSED_TO_SKIP' : 'FAILED';
    default: return 'FAILED';
  }
}

/** A one-line description of a run, for an assertion message that can be acted on without a re-run. */
export function describeAcceptanceRun(run: AcceptanceRun): string {
  return `status=${run.status === null ? 'null' : run.status} verdict=${classifyAcceptanceRun(run)} `
    + `output=${JSON.stringify(run.output.trim().slice(-600))}`;
}

export interface DockerStub {
  /** The environment to run a child with: `docker` on its PATH is the stub, and nothing else changes. */
  readonly env: NodeJS.ProcessEnv;
  /** The directory holding the stub; also where a stateful stub keeps its call counter. */
  readonly dir: string;
  dispose(): void;
}

/**
 * A `docker` on PATH that behaves exactly as `body` says, for one child process and no one else.
 *
 * The stub is a shell script rather than a Node shim so it costs nothing to start, and it is put FIRST on
 * PATH rather than replacing PATH, so the orchestrator still finds node, curl, git and the rest of a normal
 * host. It is scoped to the environment handed to one `runScript` call: no global state, no daemon touched,
 * nothing to unset if the test throws.
 */
export function dockerStub(body: string, base: NodeJS.ProcessEnv = process.env): DockerStub {
  const dir = mkdtempSync(join(tmpdir(), 'docker-stub-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = join(bin, 'docker');
  writeFileSync(stub, body, { mode: 0o755 });
  // writeFileSync's mode is masked by the umask on POSIX and ignored on Windows; chmod after the fact is the
  // part that actually has to hold on a Linux CI runner, where a non-executable stub would silently fall
  // through to the host's real docker — the exact confusion this stub exists to remove.
  try { chmodSync(stub, 0o755); } catch { /* Windows has no execute bit; Git Bash runs the shebang anyway */ }

  // PATH is case-insensitive on Windows but a plain object spread is not: keeping both `Path` and `PATH`
  // would hand CreateProcess two entries and let it pick. Drop every casing, then set one.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) { if (key.toUpperCase() !== 'PATH') env[key] = value; }
  env.PATH = `${bin}${delimiter}${base.PATH ?? ''}`;
  return { env, dir, dispose: () => removeQuietly(dir) };
}

/**
 * A Docker that cannot reach a daemon, here, now, deterministically — on a host with no daemon AND on a host
 * with a perfectly healthy one.
 *
 * Every `docker` invocation fails, so the orchestrator's `docker info` preflight fails for a reason this
 * process created rather than a reason it hoped for. DOCKER_HOST is pointed at a port nothing can be
 * listening on as a second line of defence: if some host ever resolved a different `docker` than the stub,
 * the real CLI still has nowhere to connect, so the test cannot silently start doing real Docker work.
 */
export function unreachableDocker(base: NodeJS.ProcessEnv = process.env): DockerStub {
  const stub = dockerStub([
    '#!/bin/sh',
    '# Test stub: there is no daemon for this child process, and there never will be.',
    'echo "Cannot connect to the Docker daemon (acceptance test stub)" >&2',
    'exit 1',
    '',
  ].join('\n'), base);
  stub.env.DOCKER_HOST = 'tcp://127.0.0.1:1';
  return stub;
}

/**
 * A Docker whose daemon answers every time — so a preflight passes and what happens NEXT is what is under
 * test (a genuine orchestration failure, for instance, which must stay a failure and never become a skip).
 */
export function reachableDocker(base: NodeJS.ProcessEnv = process.env): DockerStub {
  return dockerStub('#!/bin/sh\n# Test stub: a healthy daemon, for every invocation.\nexit 0\n', base);
}

/**
 * A Docker whose daemon is unreachable for the first `failures` invocations and healthy afterwards — the
 * transient failure PR 21 hit, made reproducible.
 *
 * Used to drive the adversarial regression: an earlier probe sees the failure, the orchestrator launched
 * moments later sees a healthy daemon, and the suite must not turn that disagreement into a red build.
 */
export function flakyDocker(failures = 1, base: NodeJS.ProcessEnv = process.env): DockerStub {
  const stub = dockerStub([
    '#!/bin/sh',
    'calls="$(dirname "$0")/../calls"',
    'n=$(cat "${calls}" 2>/dev/null || echo 0)',
    'n=$((n + 1))',
    'echo "${n}" > "${calls}"',
    `if [ "\${n}" -le ${failures} ]; then`,
    '  echo "Cannot connect to the Docker daemon (transient, invocation ${n})" >&2',
    '  exit 1',
    'fi',
    'exit 0',
    '',
  ].join('\n'), base);
  return stub;
}
