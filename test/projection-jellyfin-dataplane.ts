import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  Deadline, GATE_CLIENT, MEDIA_SERVER_BUDGETS, MEDIA_SERVER_DEADLINES_MS, MEDIA_SERVER_POLL_INTERVAL_MS,
  PLAYBACK_ENDPOINT_IS_ANONYMOUS, ScanBarrier, TRANSCODE_SOURCE_VIDEO_CODEC, TRANSCODE_TARGET_VIDEO_CODEC,
  atLeast, directPlayPath, exactly, findRedactionProblems, forcedTranscodePath, hasQueryCredential,
  isInFlightState, mediaServerAuthHeader, movieLibraryRequest, opaqueRef, stripQueryCredentials,
  withinBudget,
} from '../src/core/projection/media-server-dataplane.js';
import {
  absolutePath, awaitScanRunning, openPinnedStream, scanIsRunningNow, scanLibrary,
  type GateState, type ItemRecord,
} from '../src/ops/projection-jellyfin-dataplane.js';

// Projection Phase 1 — the offline half of the media-server data-plane gate.
//
// WHAT THIS SUITE IS FOR. The gate itself needs Docker, /dev/fuse, a real PostgreSQL and a real Jellyfin, and
// it takes minutes. This suite runs everywhere, in seconds, and holds the rules the gate depends on: that
// every wait is bounded, that a skipped run cannot look like a passing one, that the request shapes carry no
// credential, that the scan barrier and the held-open stream BEHAVE as claimed, and that the report cannot
// leak.
//
// SEVERAL OF THESE ARE BEHAVIOURAL, NOT STRUCTURAL, AND DELIBERATELY SO. An independent review found three
// places where a comment described one thing and the code did another — a scan barrier that claimed to
// require two consecutive idles and had no prior-state variable at all, a "held-open stream" that was two
// separate requests, and a skip that exited zero. A regex over the source would have agreed with every one of
// those comments. So the barrier is driven with scripted samples, the stream is driven against a real socket,
// and the skip accounting is driven by running the wrapper with a stub.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

/**
 * Every test runs under a hard deadline.
 *
 * WHY, AND IT IS THE SAME LESSON AS THE GATE'S OWN. A regression in the socket tests below hung this suite:
 * `server.close()` waits for open connections, undici keeps its socket alive after a response completes, and
 * one test forgot to cancel its stream — so the whole OFFLINE suite, the one that is supposed to run
 * anywhere in seconds, sat forever with no output. A suite that can hang is a suite that will one day hang in
 * CI and be diagnosed as "flaky". So the timer is here, it is ref'd only as long as the test is running, and
 * a blown deadline is a NAMED FAILURE rather than silence.
 */
const TEST_DEADLINE_MS = 30_000;

async function withDeadline<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`test deadline of ${TEST_DEADLINE_MS}ms exceeded: ${label}`)),
          TEST_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await withDeadline(name, async () => { await fn(); });
    passed++; console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

/**
 * Run a body against a throwaway HTTP server, and GUARANTEE the server is gone afterwards.
 *
 * `server.close()` alone is not enough and was the hang. It stops accepting and then waits for existing
 * connections to end — and undici holds its socket open for reuse after a response completes, so nothing ends
 * and the callback never fires. `closeAllConnections()` destroys them, which is what makes teardown finite.
 * The responses also ask for `Connection: close` so the ordinary path does not leave a pooled socket at all.
 */
async function withHttpServer(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
  body: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    res.setHeader('Connection', 'close');
    handler(req, res);
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const exists = (rel: string): boolean => existsSync(`${root}/${rel}`);

/**
 * The file with its comments removed.
 *
 * A "this construct is forbidden" check must look at CODE. The first version of the assertions below read the
 * raw source and failed on the comments that explain WHY each construct is forbidden — which would have left
 * exactly two ways out: delete the explanation, or weaken the check. Both are worse than stripping comments.
 */
const readCode = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

console.log('Running projection media-server data-plane suite:\n');

// ---------------------------------------------------------------------------------------------------------
// Deadlines — a hang is a failure
// ---------------------------------------------------------------------------------------------------------

await test('every deadline is a finite, positive number of milliseconds', () => {
  const entries = Object.entries(MEDIA_SERVER_DEADLINES_MS);
  assert(entries.length >= 9, 'there is a deadline for each kind of wait');
  for (const [name, value] of entries) {
    assert(Number.isFinite(value) && value > 0, `${name} is a positive finite budget`);
    assert(value <= 300_000, `${name} is at most five minutes`);
  }
  assert(MEDIA_SERVER_POLL_INTERVAL_MS > 0, 'polling has an interval');
  assert(MEDIA_SERVER_POLL_INTERVAL_MS <= 5_000, 'and it is small enough to be responsive');
});

await test('a deadline is absolute, and its message names the wait it blew', () => {
  const deadline = new Deadline('the library scan', 1_000, 10_000);
  assert(!deadline.expired(10_500), 'not expired before its budget');
  assert(deadline.expired(11_000), 'expired at its budget');
  assertEq(deadline.remaining(10_400), 600, 'remaining is measured from the start, not from the last poll');
  assert(deadline.message().includes('the library scan'),
    'a timeout says what it was waiting for, so a failed run is diagnosable from the log alone');
});

await test('THE DRIVER HAS NO UNBOUNDED WAIT, and no timeout that cannot keep the process alive', () => {
  const driver = readCode('src/ops/projection-jellyfin-dataplane.ts');
  const cli = readCode('src/ops/projection-jellyfin-dataplane-cli.ts');

  assert(/async function until</.test(driver), 'there is a single bounded polling helper');
  assert(!/^\s*while\s*\(\s*true\s*\)/m.test(driver + cli), 'no unbounded `while` loop in the driver or CLI');

  // A REGRESSION TEST FOR A GATE PHASE THAT EXITED 0 HAVING DONE NOTHING. `AbortSignal.timeout()` is backed
  // by an UNREF'D timer; with an idle socket, `await fetch(...)` then has nothing holding the event loop
  // open, Node exits normally with status 0, and buffered stdout is lost — so a phase that never ran reads to
  // its caller exactly like one that passed.
  assert(!driver.includes('AbortSignal.timeout'),
    'the driver uses an explicit AbortController behind a ref\'d setTimeout, never AbortSignal.timeout');
  assert(!cli.includes('AbortSignal.timeout'), 'and neither does the CLI');
  assert(driver.includes('release()') && driver.includes('clearTimeout(timer)'),
    'and the watchdog is cleared when the exchange is done');
});

await test('a phase that ends without completing cannot look like a pass', () => {
  const cli = readCode('src/ops/projection-jellyfin-dataplane-cli.ts');
  assert(cli.includes("process.on('exit'"), 'the CLI watches its own exit');
  assert(/if \(!finished && code === 0\)/.test(cli),
    'an exit-before-completion with status 0 is turned into a failure');
  assert(cli.includes('setInterval'), 'and a keepalive holds the loop open while a phase is running');
});

// ---------------------------------------------------------------------------------------------------------
// The scan barrier — behavioural, over scripted samples
// ---------------------------------------------------------------------------------------------------------

const T0 = '2026-08-01T10:00:00.000Z';
const T1 = '2026-08-01T10:05:00.000Z';

await test('SCAN BARRIER: a stale Idle left over from a previous scan never counts as complete', () => {
  // THE DEFECT THIS REPLACES. The old barrier polled for `State === 'Idle'` and accepted the first one it saw
  // more than three seconds after the trigger. Its comment claimed two consecutive idles and a pre-start
  // guard; there was no prior-state variable in the code at all. A scan slower to START than three seconds
  // was therefore declared COMPLETE before it began.
  const barrier = new ScanBarrier(T0);
  for (let i = 0; i < 10; i++) {
    assertEq(barrier.observe({ State: 'Idle', LastExecutionResult: { StartTimeUtc: T0 } }), 'not-started',
      'an Idle whose last execution is the baseline is the PRE-scan idle, not a completed one');
  }
  assert(!barrier.executionSeen, 'no execution has been observed');
  assert(!barrier.observedInFlight, 'AND a stale idle cannot pass the in-flight gate either');
});

await test('SCAN BARRIER: Running, then a terminal Idle with a new start time, is complete', () => {
  const barrier = new ScanBarrier(T0);
  assertEq(barrier.observe({ State: 'Idle', LastExecutionResult: { StartTimeUtc: T0 } }), 'not-started', 'before');
  assertEq(barrier.observe({ State: 'Running', LastExecutionResult: { StartTimeUtc: T0 } }), 'running', 'in flight');
  assert(barrier.executionSeen && barrier.observedInFlight, 'seen running, so both facts hold');
  assertEq(barrier.observe({ State: 'Running', CurrentProgressPercentage: 40 }), 'running', 'still going');
  assertEq(barrier.observe({ State: 'Idle', LastExecutionResult: { StartTimeUtc: T1 } }), 'complete', 'finished');
  assert(barrier.observedInFlight, 'and having finished does not un-see what was seen');
});

await test('SCAN BARRIER: Idle PLUS A STALE PROGRESS FIGURE IS A FINISHED SCAN, NOT A RUNNING ONE', () => {
  // THE FALSE POSITIVE THIS CLOSES, and it is a fact about the pinned server rather than a guess.
  //
  // A scheduled task's `State` is derived from whether it holds a cancellation token source. Completion
  // clears that token source BEFORE it clears the progress figure — so a response serialized between those
  // two writes reports `Idle` alongside a stale, non-null `CurrentProgressPercentage`. That is a scan that
  // has just ENDED. The predicate used to accept any non-null progress as motion, so that one sample could
  // raise the mid-scan marker, satisfy the pre-publish guard, and licence a publish into a scan that was
  // already over — the precise thing the whole barrier exists to prevent.
  const barrier = new ScanBarrier(T0);
  assertEq(barrier.observe({ State: 'Idle', CurrentProgressPercentage: 97, LastExecutionResult: { StartTimeUtc: T1 } }),
    'complete', 'idle with a new execution recorded is a completion, whatever the progress figure says');
  assert(!barrier.observedInFlight, 'and it is NOT an in-flight observation');

  // The same shape before any new execution is simply the pre-scan world, and still not motion.
  const before = new ScanBarrier(T0);
  assertEq(before.observe({ State: 'Idle', CurrentProgressPercentage: 3, LastExecutionResult: { StartTimeUtc: T0 } }),
    'not-started', 'a stale idle with a progress figure has not started anything');
  assert(!before.observedInFlight, 'and cannot raise the in-flight signal');
  assert(!before.executionSeen, 'nor claim an execution happened');
});

await test('SCAN BARRIER: only Running and Cancelling are accepted as motion', () => {
  for (const state of ['Running', 'Cancelling']) {
    const barrier = new ScanBarrier(T0);
    assertEq(barrier.observe({ State: state }), 'running', `${state} is an execution under way`);
    assert(barrier.observedInFlight, `${state} is in-flight evidence`);
  }
  // Anything else must not be, however suggestive. An unrecognised state with a new execution keeps the wait
  // going — it is not complete either — but claims nothing.
  const unknown = new ScanBarrier(T0);
  assertEq(unknown.observe({ State: 'Restarting', LastExecutionResult: { StartTimeUtc: T1 } }), 'indeterminate',
    'an unrecognised state with a new execution is neither a completion nor motion — it is its own answer');
  assert(!unknown.observedInFlight,
    'it is not evidence of motion, and nothing may be claimed from it');
  assert(unknown.executionSeen, 'though an execution demonstrably happened');
  // AND IT MUST NOT BE THE PHASE THE CALLBACK FIRES ON. That is the whole defect: with only three phases
  // this case was reported as `running`, which raised the mid-scan marker reserved for authoritative states.
  assert(unknown.observe({ State: 'Restarting' }) !== 'running',
    'an unreadable state is never reported as running');
  // A later sample that still says nothing keeps it indeterminate rather than resetting to not-started.
  assertEq(unknown.observe({ State: 'Idle', LastExecutionResult: { StartTimeUtc: T0 } }), 'indeterminate',
    'and an execution once recorded is not forgotten');
  assert(isInFlightState('Running') && isInFlightState('Cancelling'), 'the predicate names exactly those two');
  for (const notMotion of ['Idle', 'Restarting', '', undefined]) {
    assert(!isInFlightState(notMotion), `${String(notMotion) || '(empty)'} is not motion`);
  }
});

await test('SCAN BARRIER: A FAST COMPLETE IS A VALID COMPLETION AND AN INVALID IN-FLIGHT OBSERVATION', () => {
  // THE FALSE POSITIVE THIS SPLIT CLOSES, and it is the whole reason these are two properties.
  //
  // A four-entry scan can start and finish between two polls. That is a perfectly good COMPLETION — anything
  // waiting for the scan to be over is correctly satisfied, and demanding that `Running` be sampled would
  // hang forever on a fast server. It is NOT an observation that the scanner was running, because nobody saw
  // it running. The old barrier set one flag in both cases, so a fast-complete raised the mid-scan gate's
  // marker and licensed a publish that could land after the scan was already finished, under a gate id
  // claiming it had landed during it.
  const barrier = new ScanBarrier(T0);
  assertEq(barrier.observe({ State: 'Idle', LastExecutionResult: { StartTimeUtc: T1 } }), 'complete',
    'a NEW execution start plus idle is a completed scan even though Running was never sampled');
  assert(barrier.executionSeen, 'an execution demonstrably happened');
  assert(!barrier.observedInFlight,
    'but it was NEVER OBSERVED IN FLIGHT, and nothing may claim a mid-scan event on the strength of it');

  // And it stays that way however long anyone keeps looking.
  for (let i = 0; i < 5; i++) {
    assertEq(barrier.observe({ State: 'Idle', LastExecutionResult: { StartTimeUtc: T1 } }), 'complete', 'still over');
    assert(!barrier.observedInFlight, 'and still never seen in flight');
  }
});

await test('SCAN BARRIER: a completed scan is not un-completed by a later ambiguous sample', () => {
  const barrier = new ScanBarrier(T0);
  assertEq(barrier.observe({ State: 'Idle', LastExecutionResult: { StartTimeUtc: T1 } }), 'complete', 'over');
  // A later sample that looks like motion must not resurrect the wait: the NEXT scan's Running is not this
  // scan's, and a barrier that flip-flopped would let a caller wait forever on a scan that already ended.
  assertEq(barrier.observe({ State: 'Running' }), 'complete', 'once ended, ended');
  assertEq(barrier.observe(undefined), 'complete', 'and a missing task does not reopen it');
});

await test('SCAN BARRIER: a slow start is not a completion, and a seen scan stays seen until it ends', () => {
  const barrier = new ScanBarrier(T0);
  assertEq(barrier.observe({ State: 'Idle', LastExecutionResult: { StartTimeUtc: T0 } }), 'not-started', 'idle');
  assertEq(barrier.observe({ State: 'Running' }), 'running', 'the state field is what says it started');
  // Once running has been seen, a bare idle without a new start time is not a completion.
  assertEq(barrier.observe({ State: 'Idle', LastExecutionResult: { StartTimeUtc: T0 } }), 'running',
    'the scan is still considered in flight until a NEW execution start is recorded');
  assertEq(barrier.observe({ State: 'Idle', LastExecutionResult: { StartTimeUtc: T1 } }), 'complete', 'done');
});

await test('SCAN BARRIER: a task that has never run has no baseline, and any recorded start is newer', () => {
  const barrier = new ScanBarrier(undefined);
  assertEq(barrier.observe({ State: 'Idle', LastExecutionResult: null }), 'not-started', 'nothing recorded yet');
  assertEq(barrier.observe(undefined), 'not-started', 'a missing task is not a completed scan');
  assertEq(barrier.observe({ State: 'Idle', LastExecutionResult: { StartTimeUtc: T0 } }), 'complete',
    'the first ever execution is newer than no baseline');
  assert(!barrier.observedInFlight, 'and a first-ever fast-complete is still not an in-flight observation');
});

await test('THE IN-FLIGHT SIGNAL FIRES ONLY FOR A RUNNING SAMPLE, never for a fast complete', () => {
  // The callback the mid-scan gate's marker is written from. Driven here over the two sequences that matter.
  const driver = readCode('src/ops/projection-jellyfin-dataplane.ts');
  const scan = driver.slice(driver.indexOf('export async function scanLibrary'),
    driver.indexOf('export async function awaitScanRunning'));
  assert(/if \(barrier\.observedInFlight && !announced\)/.test(scan),
    'onRunning is keyed on the in-flight FACT, not on a phase that merely tends to imply it');
  assert(!/phase === 'running' && !announced/.test(scan),
    'the phase-keyed form is gone: it was true for an unreadable state as well as an authoritative one');
  assert(scan.includes('observedInFlight: barrier.observedInFlight'),
    'and the outcome reports the in-flight fact, not the weaker "an execution happened"');

  // awaitScanRunning must refuse a fast complete rather than treating it as success.
  const await_ = driver.slice(driver.indexOf('export async function awaitScanRunning'),
    driver.indexOf('export async function scanBaseline'));
  assert(await_.includes("'finished-unseen'"), 'a completion without an in-flight sample is its own outcome');
  assert(/never observed in flight/.test(await_), 'and it fails with a message that says exactly that');
  assert(!/return phase === 'not-started' \? undefined : true/.test(await_),
    'the any-phase-but-not-started acceptance is gone');

  // The present-tense guard used immediately before publishing takes no baseline and no history.
  assert(driver.includes('export async function scanIsRunningNow'), 'a point-in-time check exists');
  const now_ = driver.slice(driver.indexOf('export async function scanIsRunningNow'));
  assert(!now_.slice(0, 400).includes('ScanBarrier'),
    'and it consults no barrier, so a past observation cannot vouch for a present claim');
});

/** Serve a scripted `/ScheduledTasks` sequence, one sample per request, so the observers can be driven. */
async function withScriptedScanTask(
  samples: ReadonlyArray<Record<string, unknown>>,
  body: (baseUrl: string) => Promise<void>,
): Promise<void> {
  let index = 0;
  await withHttpServer(
    (_req, res) => {
      const sample = samples[Math.min(index, samples.length - 1)];
      index += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ Key: 'RefreshLibrary', ...sample }]));
    },
    body,
  );
}

/**
 * A scripted server that `scanLibrary` can be driven against end to end.
 *
 * It answers `/Library/Refresh` with 204 and serves one scripted task sample per `/ScheduledTasks` read, so
 * a test can lay out the exact sequence the real thing would have polled — including the first read, which
 * `scanLibrary` takes as its baseline BEFORE triggering the refresh.
 */
async function withScriptedScanServer(
  samples: ReadonlyArray<Record<string, unknown>>,
  body: (baseUrl: string) => Promise<void>,
): Promise<void> {
  let index = 0;
  await withHttpServer(
    (req, res) => {
      if ((req.url ?? '').startsWith('/Library/Refresh')) {
        res.writeHead(204);
        res.end();
        return;
      }
      const sample = samples[Math.min(index, samples.length - 1)];
      index += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ Key: 'RefreshLibrary', ...sample }]));
    },
    body,
  );
}

await test('BEHAVIOURAL: an unknown state with a new timestamp NEVER fires the in-flight callback', async () => {
  // THE DEFECT THIS CLOSES, driven through the real scanLibrary rather than asserted about the source.
  //
  // `Restarting` plus a new execution timestamp is an execution this code cannot read the state of. It used
  // to be reported as phase `running`, which is what the callback fired on — so it raised the mid-scan
  // marker that only an authoritative Running or Cancelling is allowed to raise, while `observedInFlight`
  // correctly stayed false. The publish guard would have caught it, but the callback contract was false.
  await withScriptedScanServer(
    [
      { State: 'Idle', LastExecutionResult: { StartTimeUtc: T0 } },                 // baseline
      { State: 'Restarting', LastExecutionResult: { StartTimeUtc: T1 } },           // unreadable, mid-execution
      { State: 'Idle', LastExecutionResult: { StartTimeUtc: T1 } },                 // and then it is over
    ],
    async (baseUrl) => {
      let fired = 0;
      const outcome = await scanLibrary({ baseUrl, token: 'x' }, () => { fired += 1; });
      assertEq(fired, 0, 'the in-flight callback must NOT fire for a state this code cannot read');
      assertEq(outcome.observedInFlight, false, 'and nothing was observed in flight');
      assert(outcome.elapsedMs >= 0, 'while ordinary completion still succeeds rather than hanging');
    },
  );
});

await test('BEHAVIOURAL: a genuinely running scan fires the callback exactly once', async () => {
  await withScriptedScanServer(
    [
      { State: 'Idle', LastExecutionResult: { StartTimeUtc: T0 } },  // baseline
      { State: 'Running' },
      { State: 'Running', CurrentProgressPercentage: 50 },
      { State: 'Cancelling' },
      { State: 'Idle', LastExecutionResult: { StartTimeUtc: T1 } },
    ],
    async (baseUrl) => {
      let fired = 0;
      const outcome = await scanLibrary({ baseUrl, token: 'x' }, () => { fired += 1; });
      assertEq(fired, 1, 'exactly once — a historical in-flight observation must not re-fire on every poll');
      assertEq(outcome.observedInFlight, true, 'and the run reports it was seen in flight');
    },
  );
});

await test('BEHAVIOURAL: a fast complete completes without firing the callback', async () => {
  // Preserved from the previous fix: an execution that started and finished between two polls is a valid
  // completion and is not an in-flight observation, so it must not raise the marker either.
  await withScriptedScanServer(
    [
      { State: 'Idle', LastExecutionResult: { StartTimeUtc: T0 } },  // baseline
      { State: 'Idle', LastExecutionResult: { StartTimeUtc: T1 } },  // over already
    ],
    async (baseUrl) => {
      let fired = 0;
      const outcome = await scanLibrary({ baseUrl, token: 'x' }, () => { fired += 1; });
      assertEq(fired, 0, 'a fast complete raises no in-flight signal');
      assertEq(outcome.observedInFlight, false, 'and claims no in-flight observation');
    },
  );
});

await test('BEHAVIOURAL: awaitScanRunning refuses a scan that finished between polls', async () => {
  // The adversarial case, driven against a real socket rather than asserted about the source. The very first
  // sample the observer sees is a terminal Idle with a NEW execution start — a fast complete. That is a
  // completion and it is not an in-flight observation, so a caller that has to act WHILE the scan runs must
  // be told no. The old implementation returned success for any phase but `not-started`.
  await withScriptedScanTask(
    [{ State: 'Idle', LastExecutionResult: { StartTimeUtc: T1 } }],
    async (baseUrl) => {
      const state: GateState = { baseUrl, token: 'x' };
      let threw = '';
      try { await awaitScanRunning(state, T0); } catch (error) { threw = (error as Error).message; }
      assert(threw.includes('never observed in flight'),
        `a fast complete must be refused by name, got: ${threw || '(no throw)'}`);
      assert(!threw.includes('deadline'), 'and refused promptly, not by blowing a 300-second deadline');
    },
  );
});

await test('BEHAVIOURAL: Idle-plus-progress cannot raise the marker or satisfy awaitScanRunning', async () => {
  // The same completing-task sample, driven end to end. It must neither be mistaken for motion nor licence
  // anything: `awaitScanRunning` sees a completion it never observed in flight and refuses by name.
  await withScriptedScanTask(
    [{ State: 'Idle', CurrentProgressPercentage: 88, LastExecutionResult: { StartTimeUtc: T1 } }],
    async (baseUrl) => {
      let threw = '';
      try { await awaitScanRunning({ baseUrl, token: 'x' }, T0); } catch (error) { threw = (error as Error).message; }
      assert(threw.includes('never observed in flight'),
        `Idle with stale progress must be refused, got: ${threw || '(no throw)'}`);
    },
  );
});

await test('BEHAVIOURAL: awaitScanRunning succeeds on a genuinely running scan', async () => {
  await withScriptedScanTask(
    [{ State: 'Idle', LastExecutionResult: { StartTimeUtc: T0 } }, { State: 'Running' }],
    async (baseUrl) => {
      await awaitScanRunning({ baseUrl, token: 'x' }, T0);
    },
  );
});

await test('BEHAVIOURAL: the pre-publish guard reads the present, not the past', async () => {
  // Running now -> may publish.
  await withScriptedScanTask([{ State: 'Running' }], async (baseUrl) => {
    assertEq(await scanIsRunningNow({ baseUrl, token: 'x' }), true, 'a running task is running');
  });
  await withScriptedScanTask([{ State: 'Cancelling' }], async (baseUrl) => {
    assertEq(await scanIsRunningNow({ baseUrl, token: 'x' }), true, 'a cancelling task is still executing');
  });
  // ADVERSARIAL: Idle with a stale progress figure. On the pinned server this is what a task looks like when
  // the response is serialized between clearing its cancellation token source and clearing its progress — a
  // scan that has just FINISHED. It must not pass the pre-publish guard.
  await withScriptedScanTask([{ State: 'Idle', CurrentProgressPercentage: 12 }], async (baseUrl) => {
    assertEq(await scanIsRunningNow({ baseUrl, token: 'x' }), false,
      'Idle plus a stale progress figure is a completing scan, and must NOT licence a mid-scan publish');
  });
  // FINISHED BETWEEN THE MARKER AND THE PUBLISH. This is the race the guard exists for: the marker was
  // legitimately written moments ago, and by now there is no scan to publish into.
  await withScriptedScanTask([{ State: 'Idle', LastExecutionResult: { StartTimeUtc: T1 } }],
    async (baseUrl) => {
      assertEq(await scanIsRunningNow({ baseUrl, token: 'x' }), false,
        'a scan that has just finished is NOT something a publish can land in the middle of');
    });
  // A task the server does not report at all is not a licence to publish either.
  await withHttpServer(
    (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); },
    async (baseUrl) => {
      assertEq(await scanIsRunningNow({ baseUrl, token: 'x' }), false, 'an absent task is not a running one');
    },
  );
});

await test('THE MID-SCAN PUBLISH IS GUARDED BY A FRESH OBSERVATION, not by the marker alone', () => {
  const cli = readCode('src/ops/projection-jellyfin-dataplane-cli.ts');
  assert(cli.includes("case 'assert-scan-in-flight'"), 'there is a pre-publish guard command');
  const guard = cli.slice(cli.indexOf("case 'assert-scan-in-flight'"), cli.indexOf("case 'provider-invariants'"));
  assert(guard.includes('scanIsRunningNow'), 'it asks whether the scan is running NOW');
  assert(/Refusing rather than publishing/.test(guard), 'and refuses rather than publishing a false claim');

  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  const block = gate.slice(gate.indexOf('step "a generation admitted WHILE A SCAN IS RUNNING"'),
    gate.indexOf('step "a source outage is not a deletion'));

  // THE SANDWICH. Running before the publish, running after it: both edges observed, so the publish landed
  // strictly INSIDE the scan window rather than one edge observed and the other assumed.
  const markerAt = block.indexOf('-f "$WORK/out/scan-running"');
  const firstGuard = block.indexOf('drive assert-scan-in-flight');
  const publishAt = block.indexOf('publish > "$WORK/out/publish-midscan.json"');
  const secondGuard = block.indexOf('drive assert-scan-in-flight', publishAt);
  assert(markerAt > 0 && firstGuard > markerAt && publishAt > firstGuard,
    'the order is marker, then a fresh in-flight observation, then the publish');
  assert(secondGuard > publishAt,
    'AND a second present-tense observation AFTER the publish, closing the other edge of the window');
  assertEq((block.match(/drive assert-scan-in-flight/g) ?? []).length, 2,
    'exactly two present-tense checks, one either side of the publish');
  assert(/did not land strictly inside it/.test(block),
    'and a scan that ended during the publish is a named failure, not a quiet false positive');
});

await test('THE MID-SCAN WINDOW IS HELD OPEN DETERMINISTICALLY, not waited for and hoped over', () => {
  // WHY A HOLD AND NOT A RETRY. A four-entry scan takes a couple of seconds and the observe-publish-observe
  // handshake costs about as long, so timing it is a coin flip — and a coin flip with a retry loop around it
  // is still not evidence. The gate instead blocks the scan on something it controls: a BRAND-NEW remote
  // entry whose probe windows are not yet cached, served by an endpoint told to hold that read.
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  const block = gate.slice(gate.indexOf('step "a generation admitted WHILE A SCAN IS RUNNING"'),
    gate.indexOf('step "a source outage is not a deletion'));

  assert(block.includes('/control/hold/'), 'the endpoint is told to hold the read');
  assert(block.includes('/control/release/'), 'and to release it afterwards');
  const holdAt = block.indexOf('/control/hold/');
  const publishAt = block.indexOf('publish > "$WORK/out/publish-midscan.json"');
  const secondGuardAt = block.indexOf('drive assert-scan-in-flight', publishAt);
  // The release is a helper, so what matters is where it is CALLED on its own line, not where it is defined
  // — and the line ending is whatever the checkout happens to use, which is why this is a regex.
  const afterSecondGuard = block.slice(secondGuardAt);
  const releaseCallOffset = afterSecondGuard.search(/\r?\nrelease_hold\r?\n/);
  const releaseCallAt = releaseCallOffset === -1 ? -1 : secondGuardAt + releaseCallOffset;
  assert(holdAt > 0 && holdAt < publishAt, 'the hold is set before the publish');
  assert(secondGuardAt > publishAt && releaseCallAt > secondGuardAt,
    'and released only after the publish AND after the second in-flight check, so the window it holds open '
    + 'covers both observations');

  // The held entry must be NEW. Anything already scanned has cached windows, and JD14 asserts a re-scan costs
  // the provider nothing — so a hold on an existing entry would never be hit and the window would be luck.
  assert(block.includes('--version-key remote-held'), 'a fresh remote entry is registered for the purpose');
  assert(block.includes('publish-holdable.json'), 'and published before the raced scan starts');

  // A WAITER MUST BE BLOCKED RIGHT NOW, BEFORE AND AFTER, WITH NO LAPSE IN BETWEEN.
  //
  // The lifetime `heldRequests` counter says a request entered a hold at some point. It stays up after the
  // bound fires and the request proceeds, so on its own it cannot support "a request was blocked while the
  // successor was published". The live gauge is what does, and a timeout inside the window is what rules out
  // the case where one waiter lapsed and another arrived to take its place.
  const waitAt = block.indexOf('held_now');
  const firstGuardAt = block.indexOf('drive assert-scan-in-flight');
  assert(waitAt > 0 && waitAt < firstGuardAt, 'the gate waits for a LIVE waiter before it claims anything');
  assert(/no provider request ever blocked on the hold/.test(block),
    'and never seeing one blocked is a named failure');
  assert(block.includes('HELD_STILL'), 'the gauge is read again after the publish');
  assert(/the held provider request was no longer blocked after the publish/.test(block),
    'and a waiter that stopped being blocked fails the step');
  assert(block.includes('HOLD_TIMEOUTS_AFTER') && block.includes('HOLD_TIMEOUTS_BEFORE'),
    'hold timeouts are compared across the window');
  assert(/a hold lapsed during the publish window/.test(block),
    'and a lapse inside the window is a failure, because the block would have had a gap in it');
  // Non-wedging: the release must actually drain the waiters.
  assert(/still blocked after the hold was released/.test(block),
    'and the gauge is required to return to zero after the release');

  const provider = read('projectiond/internal/fakeprovider/fakeprovider.go');
  assert(provider.includes('func (s *Server) Hold('), 'the endpoint supports a hold');
  assert(provider.includes('CurrentHeldWaiters'), 'and exposes how many requests are blocked right now');
  assert(provider.includes('HoldTimeouts'), 'and how many holds lapsed rather than being released');
  assert(provider.includes('maxHold'), 'bounded, so a forgotten release degrades into a slow read');
  const goSuite = read('projectiond/internal/fakeprovider/fileobject_test.go');
  assert(goSuite.includes('TestHoldBlocksARangeRequestUntilReleased'), 'that a hold blocks until released');
  assert(goSuite.includes('TestHoldIsBoundedSoAForgottenReleaseCannotWedgeAReader'), 'and that it is bounded');
  assert(goSuite.includes('TestCurrentHeldWaitersTracksLiveWaitersAndReturnsToZero'),
    'that the gauge tracks live waiters concurrently and comes back down');
  assert(goSuite.includes('TestAHoldThatLapsesIsCountedAndFreesItsWaiter'),
    'and that a lapsed hold is visible as a timeout while the lifetime counter stays up');
});

await test('the driver uses the barrier and takes its baseline BEFORE triggering the scan', () => {
  const driver = readCode('src/ops/projection-jellyfin-dataplane.ts');
  const scan = driver.slice(driver.indexOf('export async function scanLibrary'));
  const baselineAt = scan.indexOf('scanTask(state)');
  const triggerAt = scan.indexOf("'/Library/Refresh'");
  assert(baselineAt > 0 && triggerAt > baselineAt,
    'the baseline is read before the refresh is requested, or a stale idle could satisfy it');
  assert(scan.includes('new ScanBarrier'), 'and the decision is the barrier\'s');
  assert(!/3 \* MEDIA_SERVER_POLL_INTERVAL_MS/.test(scan),
    'the three-poll constant that used to BE the barrier is gone');
});

// ---------------------------------------------------------------------------------------------------------
// The held-open stream — behavioural, against a real socket
// ---------------------------------------------------------------------------------------------------------

await test('HELD-OPEN STREAM: one response, paused mid-body, resumed, digest over the whole thing', async () => {
  // THE DEFECT THIS REPLACES. `hold-stream` used to call `rangeRead` for a prefix and `rangeRead` again for
  // the remainder. `rangeRead` drains and releases its response, so the first call ENDED the exchange: the
  // media server closed its file and projectiond saw a RELEASE. The gate proved two requests succeed either
  // side of a swap while claiming an active stream survived one.
  const total = 1 << 20;
  const chunk = 1 << 15;
  const payload = Buffer.alloc(total);
  for (let i = 0; i < total; i += 1) payload[i] = (i * 31 + 7) % 251;
  const expected = createHash('sha256').update(payload).digest('hex');

  let requests = 0;
  let delivered = 0;
  await withHttpServer(
    (_req, res) => {
      requests += 1;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(total) });
      void (async () => {
        for (let offset = 0; offset < total; offset += chunk) {
          const slice = payload.subarray(offset, Math.min(offset + chunk, total));
          // Respect backpressure, which is what makes the pause below observable at all.
          if (!res.write(slice)) await new Promise((r) => res.once('drain', r));
          delivered += slice.byteLength;
          await new Promise((r) => setTimeout(r, 2));
        }
        res.end();
      })();
    },
    async (baseUrl) => {
      const state: GateState = { baseUrl, token: 'x' };
      const item = { itemId: 'i', mediaSourceId: 'm', sizeBytes: total } as ItemRecord;
      const stream = await openPinnedStream(state, item);
      try {
        await stream.readAtLeast(chunk * 2);
        assert(stream.bytesRead >= chunk * 2, 'the opening window was consumed');
        assert(!stream.ended, 'THE BODY IS NOT FINISHED: something is genuinely being held open');
        assert(stream.bytesRead < total, 'and there is more of the file still to come');
        const before = stream.bytesRead;

        // The "event" happens here, with the response still open.
        await new Promise((r) => setTimeout(r, 150));

        const result = await stream.finish();
        assertEq(result.bytes, total, 'the whole body arrived through the one response');
        assertEq(result.sha256, expected, 'and its digest is the digest of everything that was sent');
        assert(result.bytes - before >= total / 4,
          'a substantial share arrived AFTER the pause, so the body was not simply pre-buffered');
        assertEq(requests, 1, 'ONE request served the entire thing — not two either side of the event');
        assertEq(delivered, total, 'and the server was not cut off');
      } finally {
        // Idempotent after finish(); the point is that no path out of this test leaves a reader open.
        await stream.cancel();
      }
    },
  );
});

await test('HELD-OPEN STREAM: a body that ends early is a failure, not a silent short read', async () => {
  await withHttpServer(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.alloc(1024));
    },
    async (baseUrl) => {
      const state: GateState = { baseUrl, token: 'x' };
      const item = { itemId: 'i', mediaSourceId: 'm', sizeBytes: 1 << 20 } as ItemRecord;
      const stream = await openPinnedStream(state, item);
      try {
        let threw = '';
        try { await stream.readAtLeast(1 << 20); } catch (error) { threw = (error as Error).message; }
        assert(threw.includes('ended after'), `a short body is a named failure, got: ${threw || '(no throw)'}`);
      } finally {
        // THE BUG THIS `finally` FIXES. Without it the failed reader was left open, the server's socket never
        // closed, and `server.close()` waited on it forever — hanging the whole offline suite.
        await stream.cancel();
      }
    },
  );
});

await test('the hold-stream phase cannot be two ranged reads, and names an interruption accurately', () => {
  const cli = readCode('src/ops/projection-jellyfin-dataplane-cli.ts');
  const hold = cli.slice(cli.indexOf("case 'hold-stream'"), cli.indexOf("case 'resume'"));
  assert(hold.includes('openPinnedStream'), 'the phase opens one pinned stream');
  assertEq((hold.match(/rangeRead\(/g) ?? []).length, 0,
    'and calls rangeRead ZERO times — two ranged reads is the implementation this replaced');
  assert(hold.includes('stream.finish()'), 'it resumes the same reader rather than opening another');
  assert(hold.includes('JD7-stream-open-at-event'), 'it asserts the body was still open at the event');
  assert(hold.includes('JD7-bytes-after-event'), 'and that bytes arrived after it, defeating pre-buffering');
  // The SIGKILL leg must not be dressed up as open-handle evidence.
  assert(hold.includes('JD7-open-stream-interrupted'), 'an interruption is recorded under its own name');
  assert(hold.includes('evidence of generation pinning'),
    'and says plainly that it is not pinning evidence');
});

// ---------------------------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------------------------

await test('the amplification budgets are numbers with named denominators, and the zeroes are zero', () => {
  assertEq(MEDIA_SERVER_BUDGETS.MAX_HTTP_429, 0, 'a 429 means the admission limits did not hold');
  assertEq(MEDIA_SERVER_BUDGETS.MAX_FULL_BODY_SERVED, 0, 'a full body answering a ranged request is a defect');
  assertEq(MEDIA_SERVER_BUDGETS.MAX_RESCAN_CHURN, 0, 'a re-scan of an unchanged library moves nothing');
  assertEq(MEDIA_SERVER_BUDGETS.MAX_RECOVERY_CHURN, 0, 'and neither does a daemon crash and recovery');
  assert(MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION > 0, 'a scan is allowed to read something');
  assert(MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION < 1,
    'a scan may not be allowed to read the whole object, or the appliance proves nothing');
  assert(MEDIA_SERVER_BUDGETS.MAX_SCAN_RANGE_MULTIPLIER >= 3,
    'the range multiplier leaves room for the contract\'s own three probe windows');
});

await test('a budget check records the number even when it passes, and a floor is not a ceiling', () => {
  assertEq(withinBudget('G', 3, 5).verdict, 'pass', 'three is within five');
  assertEq(withinBudget('G', 3, 5).measured, 3, 'and the measurement is kept');
  assertEq(withinBudget('G', 6, 5).verdict, 'fail', 'six is not');
  assertEq(withinBudget('G', 5, 5).verdict, 'pass', 'the budget is inclusive');
  assertEq(exactly('G', 0, 1).verdict, 'fail', 'under is not "within" when the gate says exactly');
  assertEq(atLeast('G', 0, 1).verdict, 'fail', 'zero requests is not a frugal scan, it is an absent one');
  assertEq(atLeast('G', 2, 1).verdict, 'pass', 'and two clears a floor of one');
});

// ---------------------------------------------------------------------------------------------------------
// Credentials — least exposure
// ---------------------------------------------------------------------------------------------------------

await test('the authorization header is one spelling, with and without a token', () => {
  const anonymous = mediaServerAuthHeader();
  assert(anonymous.startsWith('MediaBrowser '), 'the scheme is the media server\'s own');
  assert(!anonymous.includes('Token='), 'the first-run wizard has no token, and the header does not invent one');
  assert(mediaServerAuthHeader('abc123').includes('Token="abc123"'), 'an authenticated call carries one');
});

await test('NO GATE-AUTHORED URL CARRIES A CREDENTIAL', () => {
  // Measured against the pinned Jellyfin 10.10.7: the Authorization header alone is accepted by every
  // endpoint this gate uses, so a duplicate `api_key` in the query bought nothing and put a live credential
  // into the single most leak-prone place there is — a URL, which lands in access logs, error messages and
  // the playlists the server generates from it.
  const play = directPlayPath('item1', 'src1');
  const transcode = forcedTranscodePath('item1', 'src1', 'sess1');
  for (const [what, path] of [['direct play', play], ['forced transcode', transcode]] as const) {
    assert(!hasQueryCredential(path), `${what} carries no credential parameter`);
    assert(!/api_key|apikey|token/i.test(path), `${what} names no credential at all`);
  }
  assert(play.includes('static=true'), 'direct play still asks for the file\'s own bytes');
  assert(transcode.includes(`videoCodec=${TRANSCODE_TARGET_VIDEO_CODEC}`), 'and the transcode still forces one');

  // The whole driver, too: no request path anywhere may interpolate the token.
  const driver = readCode('src/ops/projection-jellyfin-dataplane.ts');
  assert(!/api_key/.test(driver), 'the driver builds no URL containing an api key');
  const stop = driver.slice(driver.indexOf('/Videos/ActiveEncodings'));
  assert(!/api_key/.test(stop.slice(0, 400)), 'including the call that stops the encoding');
});

await test('a credential a SERVER put in a URL is detected and stripped before the URL is followed', () => {
  assert(hasQueryCredential('/a/b.ts?x=1&api_key=deadbeef'), 'api_key is recognised');
  assert(hasQueryCredential('/a/b.ts?ApiKey=deadbeef'), 'and its other casing');
  assert(hasQueryCredential('/a/b.ts?X-Emby-Token=deadbeef'), 'and the Emby spelling a sibling driver would meet');
  assert(!hasQueryCredential('/a/b.ts?x=1'), 'an ordinary query is not a credential');
  assert(!hasQueryCredential('/a/b.ts'), 'and neither is no query at all');

  assertEq(stripQueryCredentials('/a/b.ts?x=1&api_key=deadbeef&y=2'), '/a/b.ts?x=1&y=2', 'stripped from the middle');
  assertEq(stripQueryCredentials('/a/b.ts?api_key=deadbeef'), '/a/b.ts', 'and the query goes when it was the only one');
  assertEq(stripQueryCredentials('/a/b.ts?x=1'), '/a/b.ts?x=1', 'an innocent query is untouched');

  const driver = readCode('src/ops/projection-jellyfin-dataplane.ts');
  assert(driver.includes('credentialsInGeneratedUrls'), 'the driver counts any it had to strip');
  assert(driver.includes('stripQueryCredentials'), 'and strips before following');
  const cli = readCode('src/ops/projection-jellyfin-dataplane-cli.ts');
  assert(cli.includes('JD6-no-credential-in-generated-urls'), 'and the gate asserts the count is zero');
});

await test('the gate does not claim direct play was AUTHORIZED, because it measured that it was not', () => {
  // Jellyfin 10.10.7 answers `GET /Videos/{id}/stream?static=true` with 200 and the whole file to a request
  // carrying no credential at all, and to one carrying a deliberately invalid token. Every other endpoint
  // this gate uses answers 401. So the direct-play evidence is about BYTES, and reading "authenticated
  // playback" into it would be reading in something that was never measured.
  assertEq(PLAYBACK_ENDPOINT_IS_ANONYMOUS, true, 'the measured fact is recorded in the contract module');
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(/no credential at all/.test(gate), 'and the gate output says so where it reports direct play');
  assert(/evidence about BYTES/i.test(gate), 'and scopes the claim to bytes');
});

// ---------------------------------------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------------------------------------

await test('THE TRANSCODE REQUEST ASKS FOR A CODEC THE SOURCE IS NOT', () => {
  assert(String(TRANSCODE_SOURCE_VIDEO_CODEC) !== String(TRANSCODE_TARGET_VIDEO_CODEC),
    'the source codec and the demanded codec differ, or the transcode gate proves nothing');
  const path = forcedTranscodePath('item1', 'src1', 'sess1');
  assert(!path.includes('static=true'), 'it is not a direct-play request wearing a different name');
  assert(path.includes('master.m3u8'), 'it is the transcoding manifest endpoint');
  assert(path.includes('maxWidth=160'), 'bounded, so a forced transcode cannot become a load test');
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(gate.includes('ffprobe') && gate.includes('OUT_CODEC'), 'the gate decodes what came out');
  assert(/the media server did not transcode/.test(gate), 'and fails with a message that says what it concluded');
});

await test('the library is added with metadata fetching off, and that is not a weakening of the read path', () => {
  const request = movieLibraryRequest('/media/projection/Movies') as {
    LibraryOptions: Record<string, unknown> & {
      PathInfos: Array<{ Path: string }>; TypeOptions: Array<Record<string, unknown[]>>;
    };
  };
  const options = request.LibraryOptions;
  assertEq(options.PathInfos[0]?.Path, '/media/projection/Movies', 'the library root is the projected mount');
  assertEq(options.EnableRealtimeMonitor, false, 'an inotify watch would race the explicit-scan assertions');
  const movie = options.TypeOptions[0] as Record<string, unknown[]>;
  for (const fetcher of ['MetadataFetchers', 'ImageFetchers']) {
    assertEq((movie[fetcher] ?? []).length, 0, `${fetcher} is empty: this gate has no internet and needs none`);
  }
  assert(!('EnableMediaProbe' in options), 'nothing here disables the media probe');
});

await test('a playlist reference resolves against the playlist, and a server-named host is not followed', () => {
  assertEq(absolutePath('/Videos/a/master.m3u8?x=1', 'main.m3u8?y=2'), '/Videos/a/main.m3u8?y=2', 'relative');
  assertEq(absolutePath('/Videos/a/main.m3u8?x=1', 'hls1/main/0.ts?y=2'), '/Videos/a/hls1/main/0.ts?y=2', 'nested');
  assertEq(absolutePath('/Videos/a/master.m3u8', '/abs/path.ts'), '/abs/path.ts', 'absolute is kept');
  assertEq(absolutePath('/Videos/a/master.m3u8', 'http://elsewhere.invalid/x/0.ts?k=1'), '/x/0.ts?k=1',
    'only the path and query of an absolute URL are used, so a host the server named is not followed');
  const driver = readCode('src/ops/projection-jellyfin-dataplane.ts');
  assert(driver.includes('follow(variantPath, segment)'),
    'a segment resolves against the VARIANT playlist that named it, not against the master');
});

// ---------------------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------------------

await test('THE REPORT RULE IS APPLIED, NOT PROMISED: counts, digests and gate ids only', () => {
  assertEq(findRedactionProblems([{ gate: 'JD4', verdict: 'pass', measured: 10, budget: 10 }]).length, 0,
    'a well-formed report has no problems');
  const cases: Array<[unknown, string]> = [
    [{ note: 'http://fakerange:8099/direct/obj' }, 'a URL'],
    [{ note: '/Videos/x/stream?api_key=deadbeef' }, 'an api key'],
    [{ note: 'Authorization: Bearer abc' }, 'a bearer credential'],
    [{ note: 'MediaBrowser Client="x", Token="y"' }, 'an auth header'],
    [{ note: 'read /mnt/Movies/A/A.mp4' }, 'an absolute path'],
    [{ note: 'C:\\Users\\someone\\media' }, 'a Windows path'],
    [{ note: 'connected to 192.168.1.10' }, 'an IP address'],
    [{ expiresAt: 12345 }, 'an expiry, by its key alone'],
  ];
  for (const [value, why] of cases) {
    assert(findRedactionProblems(value).length > 0, `the checker catches ${why}`);
  }
  assertEq(findRedactionProblems({ a: [{ b: { c: 'http://x/' } }] })[0]?.at, '$.a[0].b.c', 'and says where');
});

await test('an opaque reference compares across phases without printing what it stands for', () => {
  const a = opaqueRef('entry', 'Movies/A/A.mp4');
  assertEq(a, opaqueRef('entry', 'Movies/A/A.mp4'), 'stable across calls, which is what makes it comparable');
  assert(a !== opaqueRef('entry', 'Movies/B/B.mp4'), 'a different value is a different reference');
  assert(!a.includes('Movies'), 'and the reference does not contain what it stands for');
  assert(opaqueRef('library', 'x') !== opaqueRef('entry', 'x'), 'two kinds of thing cannot collide');
  assertEq(findRedactionProblems({ note: a }).length, 0, 'and a reference is itself redaction-safe');
});

// ---------------------------------------------------------------------------------------------------------
// Skip semantics — behavioural, by running the wrappers with a stub
// ---------------------------------------------------------------------------------------------------------

const bashAvailable = spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8' }).status === 0;

function runWrapper(script: string, stubExit: number, env: Record<string, string> = {}):
{ status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pjd-gate-'));
  const stub = join(dir, 'stub-gate.sh');
  writeFileSync(stub, `#!/usr/bin/env bash\necho "stub gate ran"\nexit ${stubExit}\n`);
  chmodSync(stub, 0o755);
  const result = spawnSync('bash', [join(root, script)], {
    encoding: 'utf8',
    env: { ...process.env, PROJECTION_JELLYFIN_GATE_COMMAND: stub, ...env },
  });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

await test('SKIP IS NOT A PASS: the gate exits 77, and 77 is not zero', () => {
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(gate.includes('GATE_SKIP_STATUS=77'), 'the skip status is 77');
  assert(/exit "\$GATE_SKIP_STATUS"/.test(gate), 'and the skip path exits with it');
  const skipBlock = gate.slice(gate.indexOf('checking this host can host the gate'),
    gate.indexOf('building the production projectiond image'));
  assert(!/^\s*exit 0\s*$/m.test(skipBlock), 'the skip path does not exit 0 anywhere');
  assert(/closes NO acceptance gate/i.test(skipBlock), 'and says plainly that it closes nothing');
});

if (!bashAvailable) {
  console.log('  SKIP  the wrapper accounting tests need bash, which is not on PATH here');
} else {
  await test('THREE-RUN WRAPPER: a skipped run propagates 77 and reports no completed runs', () => {
    // THE DEFECT THIS CLOSES. The gate used to exit 0 on skip and this wrapper looped over it, so a host with
    // no /dev/fuse produced "3 consecutive runs completed" and status 0 having proved nothing whatsoever.
    const { status, out } = runWrapper('deploy/projection-jellyfin-dataplane-gate-three.sh', 77);
    assertEq(status, 77, 'a skipped run makes the required command exit 77, not 0');
    assert(/SKIPPED at run 1 of 3/.test(out), 'it names the run it skipped at');
    assert(/Runs completed: 0 of 3/.test(out), 'and reports zero completed');
    assert(/CLOSES NOTHING/i.test(out), 'and says the sequence closes nothing');
    assert(!/consecutive runs completed, none skipped/.test(out),
      'and CANNOT emit the completion message it emits on success');
  });

  await test('THREE-RUN WRAPPER: three clean runs report three completed and exit 0', () => {
    const { status, out } = runWrapper('deploy/projection-jellyfin-dataplane-gate-three.sh', 0);
    assertEq(status, 0, 'three passing runs pass');
    assert(/3 of 3 consecutive runs completed, none skipped/.test(out), 'and the count is stated, not implied');
    // The limit travels with the success message. Newlines are collapsed because the message is wrapped.
    assert(/must not be\s+reported as Phase 1 closure/.test(out), 'with the honest limit attached');
  });

  await test('THREE-RUN WRAPPER: an ordinary failure stops the sequence and propagates', () => {
    const { status, out } = runWrapper('deploy/projection-jellyfin-dataplane-gate-three.sh', 3);
    assertEq(status, 3, 'the failing status propagates unchanged');
    assert(/FAILED at run 1 of 3/.test(out), 'it names where it stopped');
    assert(!/consecutive runs completed/.test(out), 'and claims no completed sequence');
  });

  await test('THREE-RUN WRAPPER: zero requested runs cannot announce a completed sequence', () => {
    const { status, out } = runWrapper('deploy/projection-jellyfin-dataplane-gate-three.sh', 0,
      { PROJECTION_JELLYFIN_GATE_RUNS: '0' });
    assert(status !== 0, 'a loop that never ran is not a pass');
    assert(/refusing to report a completed sequence/.test(out), 'and it says why');
  });

  await test('OPTIONAL ENTRY POINT: maps 77 to 0, and nothing else', () => {
    const skipped = runWrapper('deploy/projection-jellyfin-dataplane-gate-optional.sh', 77);
    assertEq(skipped.status, 0, 'a skip is success for a host where the gate is optional');
    assert(/NOTHING WAS PROVED/.test(skipped.out), 'but it says loudly that nothing was proved');
    assert(/No acceptance gate is closed/i.test(skipped.out), 'and that it closes nothing');

    const failedRun = runWrapper('deploy/projection-jellyfin-dataplane-gate-optional.sh', 4);
    assertEq(failedRun.status, 4, 'a REAL failure still fails here');
    const passedRun = runWrapper('deploy/projection-jellyfin-dataplane-gate-optional.sh', 0);
    assertEq(passedRun.status, 0, 'and a pass still passes');
  });
}

await test('the EVIDENCE commands are the ones that propagate a skip, and the optional one is separate', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['go:jellyfin-dataplane-gate'], 'bash deploy/projection-jellyfin-dataplane-gate.sh',
    'the single-run evidence command runs the gate directly, so 77 reaches the caller');
  assertEq(pkg.scripts['go:jellyfin-dataplane-gate:three'],
    'bash deploy/projection-jellyfin-dataplane-gate-three.sh', 'and so does the three-run one');
  assertEq(pkg.scripts['go:jellyfin-dataplane-gate:optional'],
    'bash deploy/projection-jellyfin-dataplane-gate-optional.sh',
    'skip-as-success is its own entry point that a caller must choose deliberately');
  // The acceptance plan must name the command that fails on a host which cannot host it.
  const plan = read('docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md');
  assert(plan.includes('go:jellyfin-dataplane-gate'), 'the acceptance plan names the evidence command');
  assert(!plan.includes('go:jellyfin-dataplane-gate:optional'),
    'and does NOT name the optional one as evidence');
});

// ---------------------------------------------------------------------------------------------------------
// The mid-scan race
// ---------------------------------------------------------------------------------------------------------

await test('THE MID-SCAN PUBLISH WAITS ON AN OBSERVED RUNNING SCAN, never on a sleep', () => {
  // THE DEFECT THIS CLOSES. It used to be `sleep 1` then publish. A publish one second after the trigger can
  // land before the scanner starts or after it finishes, and either way the step passed while claiming a
  // generation had been admitted WHILE a scan was running.
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  const block = gate.slice(gate.indexOf('step "a generation admitted WHILE A SCAN IS RUNNING"'),
    gate.indexOf('step "a source outage is not a deletion'));
  assert(block.length > 0, 'the mid-scan block is findable');
  assert(block.includes('--running-marker'), 'the scanning process signals when it observes the scan in flight');
  assert(block.includes('scan-running'), 'and the publishing half waits on that marker');
  assert(/the scanner was never observed running/.test(block),
    'and the step DIES rather than publishing if the marker never appears');
  // A sleep may exist as a poll interval, but never as the proof itself: the publish must come after the wait.
  const markerWait = block.indexOf('-f "$WORK/out/scan-running"');
  const publishAt = block.indexOf('publish > "$WORK/out/publish-midscan.json"');
  assert(markerWait > 0 && publishAt > markerWait, 'the publish happens strictly after the marker is seen');

  const cli = readCode('src/ops/projection-jellyfin-dataplane-cli.ts');
  assert(cli.includes('scan-observed-in-flight'),
    'and the raced scan asserts it was actually observed IN FLIGHT, or the race was not a race');
  assert(cli.includes('outcome.observedInFlight'),
    'from the explicit in-flight fact, not from the weaker "an execution happened"');
});

// ---------------------------------------------------------------------------------------------------------
// The gate, its isolation, and its claims
// ---------------------------------------------------------------------------------------------------------

await test('the gate exists, is pinned by digest, and isolates every port, name and directory it uses', () => {
  for (const artifact of [
    'deploy/projection-jellyfin-dataplane-gate.sh',
    'deploy/projection-jellyfin-dataplane-gate-three.sh',
    'deploy/projection-jellyfin-dataplane-gate-optional.sh',
    'docker-compose.projection-jellyfin.yml',
    'src/core/projection/media-server-dataplane.ts',
    'src/ops/projection-jellyfin-dataplane.ts',
    'src/ops/projection-jellyfin-dataplane-cli.ts',
    'docs/PROJECTION_PHASE_1_JELLYFIN_DATA_PLANE.md',
  ]) assert(exists(artifact), `data-plane artifact exists: ${artifact}`);

  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  for (const image of ['JELLYFIN_IMAGE=', 'GO_IMAGE=', 'VERIFY_IMAGE=']) {
    const line = gate.split('\n').find((l) => l.startsWith(image)) ?? '';
    assert(/@sha256:[0-9a-f]{64}/.test(line), `${image} is pinned by digest, not by tag`);
  }
  const compose = read('docker-compose.projection-jellyfin.yml');
  assert(compose.includes('name: projection-jellyfin-gate'), 'its own compose project name');
  assert(compose.includes('tmpfs:'), 'and throwaway database storage');

  // EVERY EXTERNAL IMAGE THIS GATE TOUCHES, INCLUDING THE ONE IN THE COMPOSE FILE.
  //
  // The digest check above covers the images the shell script names. The database was declared as
  // `postgres:16` — a moving tag — and slipped through, which would have made "three consecutive runs" three
  // runs against something that can change underneath them. The only image allowed to be unpinned is the
  // one BUILT FROM THIS CHECKOUT, because a digest for a local build would be a digest of whatever was last
  // built rather than of the reviewed source.
  const localBuiltImage = 'projectiond:phase1-local';
  for (const [file, source] of [
    ['docker-compose.projection-jellyfin.yml', compose],
    ['deploy/projection-jellyfin-dataplane-gate.sh', gate],
  ] as const) {
    for (const line of source.split('\n')) {
      // URLs are stripped first. `postgresql://postgres:postgres@host/db` contains `postgres:postgres`,
      // which looks exactly like a tagged image reference and is a database credential.
      const trimmed = line.trim().replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '');
      if (trimmed.startsWith('#')) continue;
      // `image: x`, `IMAGE="x"` and `--image x` all land here; a bare word with a tag and no digest is what
      // this is hunting.
      const refs = trimmed.match(/\b(?:[a-z0-9.-]+\/)*[a-z0-9.-]+:[a-z0-9][a-z0-9._-]*(?:@sha256:[0-9a-f]{64})?/g) ?? [];
      for (const ref of refs) {
        if (!/^(?:[a-z0-9.-]+\/)*[a-z0-9.-]+:[a-z0-9][a-z0-9._-]*$/.test(ref)) continue;
        if (ref.startsWith(localBuiltImage)) continue;
        // Only things that actually look like image references: a known registry path or a known image name.
        if (!/^(postgres|alpine|golang|jellyfin\/jellyfin|ghcr\.io\/|docker\.io\/)/.test(ref)) continue;
        assert(false, `${file} names the mutable image reference "${ref}"; pin it by digest`);
      }
    }
  }
  assert(/postgres:16@sha256:[0-9a-f]{64}/.test(compose), 'the database is pinned by digest');
  assert(!gate.includes(':5432') && !gate.includes(':5470'), 'it takes no other stack\'s port');
  assert(/trap cleanup EXIT/.test(gate), 'it cleans up on success and on failure');
  assert(gate.indexOf('docker rm -f "$JELLYFIN_CONTAINER"') < gate.indexOf('docker rm -f "$MOUNT_CONTAINER"'),
    'and stops the media server BEFORE the daemon, because a live reader blocks an unmount');
});

await test('THE MOUNT IS NOT BOUND READ-ONLY INTO THE MEDIA SERVER, so the daemon is what refuses a write', () => {
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  const jellyfinRun = gate.slice(gate.indexOf('start_jellyfin() {'), gate.indexOf('start_jellyfin\n'));
  assert(/-v "\$WORK\/mnt:\/media\/projection:rslave"/.test(jellyfinRun),
    'the mount is propagated in without :ro — otherwise the mutation assertion is about a Docker flag');
  assert(/--user 1000:1000/.test(jellyfinRun), 'and the media server runs non-root, as one actually does');
  assert(gate.includes('--cap-drop ALL --cap-add SYS_ADMIN'), 'the daemon gets CAP_SYS_ADMIN only');
  assert(gate.includes('--strict-direct-mount'), 'and mounts by syscall, refusing the fusermount helper');
});

await test('the gate generates its media rather than downloading any, and records digests outside the mount', () => {
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(gate.includes('lavfi') && gate.includes('testsrc') && gate.includes('sine='),
    'the media comes from ffmpeg\'s own synthetic sources');
  assert(gate.includes('test "$LOCAL_SHA" != "$REMOTE_SHA"'),
    'the two entries are asserted to differ, which is what makes every later digest comparison discriminating');
  assert(gate.includes('recorded OUTSIDE the mount') || gate.includes('RECORDED OUTSIDE THE MOUNT'),
    'and the expected digests are recorded outside the thing being verified');
  assert(gate.includes('3145728'), 'the entries are over 3 MiB, so the full probe plan applies');
  assert(gate.includes('moov-at-end'), 'and the remote entry\'s index is at the end, so the tail is read');
  assert(gate.includes('--min-range 1'), 'with a floor as well as a ceiling on the scan budget');
});

await test('A REAL PROVIDER LEASE IS MINTED, and the leak check searches for its exact secret', () => {
  // The endpoint used to run in DIRECT mode, so no access lease was ever created — and the step that claimed
  // no access material had been persisted was searching for something that had never existed.
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(gate.includes('"resolverUrl"'), 'the endpoint is configured in resolver mode, so a lease is minted');
  assert(gate.includes('--lease-prefix "$LEASE_MARKER"'), 'the lease carries a per-run secret marker');
  assert(gate.includes('--public-base-url'), 'and the resolved URL names an origin a client can actually dial');
  assert(/LEASE_MARKER="PJDLEASE\$\(node -e/.test(gate), 'the marker is high-entropy, not a fixed string');
  // Searched for by exact value in all three places the product promises it never reaches.
  // Anchored to the leakcheck INVOCATION, not to the first textual mention: the step heading names the same
  // places, and matching that would have checked a sentence instead of a command.
  for (const target of ['the published manifest directory', 'the daemon probe cache',
    'the media server\'s library state']) {
    const at = gate.indexOf(`leakcheck.sh "${target}"`);
    assert(at > 0, `the leak check is invoked for ${target}`);
    assert(gate.slice(at, at + 400).includes('$LEASE_MARKER'),
      `and searches ${target} for the lease secret itself`);
  }
  assert(/RESOLUTIONS.*-ge 1|\-ge 1/.test(gate),
    'and the run asserts a lease was actually minted, or the searches had no subject');

  const provider = read('projectiond/internal/fakeprovider/fakeprovider.go');
  assert(provider.includes('LeasePrefix'), 'the endpoint supports a greppable lease');
  assert(provider.includes('AdvertisedBaseURL'), 'and can advertise an origin other than its listen address');
});

await test('THE LEAK CLAIM IS SCOPED TO PROVIDER MATERIAL, and does not pretend other tokens do not exist', () => {
  // "No access URL, token, header or expiry was persisted anywhere" was FALSE as written. This gate persists
  // a Jellyfin token in its own scratch state file, and Jellyfin persists its own auth records — it must, or
  // it could not survive the restart this gate performs.
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(!/no access URL, token, header or expiry was persisted anywhere/i.test(gate),
    'the unscoped claim is gone from the step heading');
  assert(/no PROVIDER access lease/i.test(gate), 'and the heading names provider material specifically');
  assert(/persists a Jellyfin access token/i.test(gate), 'the harness admits its own scratch token');
  assert(/Jellyfin persists its own device and token records/i.test(gate),
    'and admits the media server keeps its own authentication state');
  const doc = read('docs/PROJECTION_PHASE_1_JELLYFIN_DATA_PLANE.md');
  assert(/PROVIDER/.test(doc) && /Jellyfin persists its own/i.test(doc),
    'and the document scopes it the same way rather than differently');
});

await test('THE GATE SAYS WHAT IT DOES NOT PROVE, in its own output rather than only in a document', () => {
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  for (const limit of ['Plex', 'Emby', 'Unraid']) {
    assert(gate.includes(limit), `the gate names ${limit} among what is still unproven`);
  }
  assert(/Docker Desktop pass is NOT Linux\/Unraid closure/i.test(gate),
    'and states plainly that a Docker Desktop pass is not Phase 1 closure');
  const three = read('deploy/projection-jellyfin-dataplane-gate-three.sh');
  assert(!/^[^#\n]*\|\|\s*true\b/m.test(three), 'a failed run stops the sequence rather than being averaged away');
});

await test('this gate is the REAL-media-server job, and the existing fake-Jellyfin job is untouched', () => {
  assert(exists('test/jellyfin-fake-server.ts'), 'the fake control-plane server still exists');
  assert(!read('test/jellyfin-fake-server.ts').includes('projection'), 'and knows nothing about projection');
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(!gate.includes('jellyfin-fake-server'), 'the data-plane gate does not use the fake server');
  assert(/REAL JELLYFIN|real, digest-pinned Jellyfin/i.test(gate), 'it says which kind of server it starts');
});

await test('the daemon still names no media server, and the driver is control-plane code', () => {
  const walk = (dir: string): string[] => readdirSync(`${root}/${dir}`, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(`${dir}/${entry.name}`)
      : entry.name.endsWith('.go') ? [`${dir}/${entry.name}`] : []));
  for (const file of walk('projectiond')) {
    for (const forbidden of ['jellyfin', 'Jellyfin', 'plex', 'Plex', 'emby', 'Emby']) {
      assert(!read(file).includes(forbidden), `${file} names ${forbidden}`);
    }
  }
  assert(!read('src/core/projection/media-server-dataplane.ts').includes('Jellyfin'),
    'and the contract half is written against a media server, not against one product');
});

await test('the file-backed provider object exists for the one reason that justifies it', () => {
  const provider = read('projectiond/internal/fakeprovider/fakeprovider.go');
  assert(provider.includes('func (s *Server) AddFileObject'), 'a file-backed object can be registered');
  assert(provider.includes('func (s *Server) BytesOf'), 'one accessor decides where an object\'s bytes come from');
  assert(provider.includes('/counters'), 'the counters are readable across a process boundary');
  assert(exists('projectiond/internal/fakeprovider/fileobject_test.go'), 'with a Go suite behind them');
  assert(!read('projectiond/Dockerfile').includes('fakerange'), 'the production image does not build fakerange');
});

await test('the gate\'s own scratch directory is ignored, and no host path is handed to docker cp', () => {
  assert(read('.gitignore').includes('.projection-jellyfin-gate/'), 'the scratch directory is git-ignored');
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(gate.includes('GATE_ROOT="$PWD/.projection-jellyfin-gate"'), 'it lives beside the repository');
  assert(!/^\s*docker cp /m.test(gate), 'nothing hands a host path to docker cp');
});

await test('package, inventory and the aggregate run are wired', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:projection-jellyfin-dataplane'], 'tsx test/projection-jellyfin-dataplane.ts',
    'test script');
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-jellyfin-dataplane.ts'), 'suite in npm test');
  assert(!(AGGREGATE_SUITE_COMMAND ?? '').includes('docker'), 'the aggregate suite needs no Docker');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as {
    suites: Array<{ file: string; group: string }>;
  };
  const entry = inventory.suites.find((s) => s.file === 'projection-jellyfin-dataplane.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry?.group, 'offline', 'and needs no database');
});

await test('the documentation states the limits in the same breath as the capability', () => {
  const doc = read('docs/PROJECTION_PHASE_1_JELLYFIN_DATA_PLANE.md');
  for (const limit of ['Plex', 'Emby', 'Unraid', 'TorBox']) {
    assert(doc.includes(limit), `the doc names ${limit} among what is not yet proved`);
  }
  assert(/Docker Desktop/.test(doc), 'the doc names the environment it has actually been run in');
  assert(/not Phase 1 closure/i.test(doc) && /SHALL NOT be reported as one/.test(doc),
    'and says plainly that a run there is not closure');
  assert(/three consecutive/i.test(doc), 'and repeats what passing means');
  const plan = read('docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md');
  assert(plan.includes('jellyfin-dataplane-gate'), 'the acceptance plan names the gate that now runs');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
}

// AN EXPLICIT EXIT, so "this suite cannot hang" is a guarantee rather than a hope.
//
// The per-test deadline stops a hung test from blocking the RUN, but a body that blew its deadline is still
// out there holding whatever it was holding — a socket, a reader, a ref'd timer — and a natural exit waits
// for exactly those. The deadline would then report the failure and the process would sit there anyway,
// which is the same outcome from the caller's point of view. Every result is decided by this line, so the
// status is complete before the exit.
process.exit(failed > 0 ? 1 : 0);
