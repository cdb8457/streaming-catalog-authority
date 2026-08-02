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
  MEDIA_SERVER_SOAK, PLAYBACK_ENDPOINT_IS_ANONYMOUS, SEEK_PLAN_FRACTIONS, SEEK_SETTLE_MS, ScanBarrier,
  TRANSCODE_SOURCE_VIDEO_CODEC, TRANSCODE_TARGET_VIDEO_CODEC, analysePacedPlayback, analyseTranscodeSoak,
  atLeast, corpusProblems, corpusSelfProblems, directPlayPath, exactly, findRedactionProblems,
  forcedTranscodePath, hasQueryCredential, isInFlightState, mediaServerAuthHeader, movieLibraryRequest,
  analyseSeekSet, opaqueRef, seekPlanProblems, seekPositionsFor, stripQueryCredentials, withinBudget,
  type CorpusExpectation, type CorpusObservation, type PacedSample, type SeekDecode, type SeekObservation,
  type SoakProbe, type SoakSegment, type TranscodeSessionSampleRecord,
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
  // TWO CEILINGS, BECAUSE THERE ARE NOW TWO KINDS OF WAIT. Every deadline that bounds a wait for something
  // that ought to be QUICK stays at five minutes: a scan, a request, a mount appearing. The two that bound a
  // gate which is REQUIRED to last five minutes cannot, and holding them to it would have meant either a
  // paced play that fails at the moment it succeeds, or a five-minute claim with no ceiling at all. They are
  // named individually so that a third one cannot join them by accident.
  const SOAK_DEADLINES = new Set(['PACED_PLAY', 'TRANSCODE_SOAK']);
  for (const [name, value] of entries) {
    assert(Number.isFinite(value) && value > 0, `${name} is a positive finite budget`);
    assert(value <= (SOAK_DEADLINES.has(name) ? 900_000 : 300_000),
      `${name} is at most ${SOAK_DEADLINES.has(name) ? 'fifteen' : 'five'} minutes`);
  }
  for (const name of SOAK_DEADLINES) {
    assert(name in MEDIA_SERVER_DEADLINES_MS, `${name} exists, so the exemption above describes something`);
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

/**
 * Which spelling of a filesystem path the `bash` on this machine understands.
 *
 * THE DEFECT THIS CLOSES, AND IT MADE FIVE TESTS FAIL FOR A REASON THAT HAD NOTHING TO DO WITH THEM. On
 * Windows, `bash` may be Git Bash — which takes `C:\a\b` and `/c/a/b` — or it may be WSL, which takes neither
 * and answers `127`, the status a shell returns for "command not found". Passing a native Windows path to
 * whichever one is on PATH is a coin flip, and when it lost, the wrapper-accounting tests reported that a
 * skipped run looked like a passing one. That is a false alarm about the single most important property in
 * this gate, raised by a path separator.
 *
 * So the shell is ASKED what it can translate with, once, rather than guessed at from `process.platform`.
 */
const bashPathStyle = ((): 'wsl' | 'cygwin' | 'native' => {
  if (!bashAvailable) return 'native';
  const probe = spawnSync('bash', ['-c',
    'if command -v wslpath >/dev/null 2>&1; then echo wsl; '
    + 'elif command -v cygpath >/dev/null 2>&1; then echo cygwin; else echo native; fi'],
  { encoding: 'utf8' });
  const answer = (probe.stdout ?? '').trim();
  return answer === 'wsl' || answer === 'cygwin' ? answer : 'native';
})();

/**
 * A path in the spelling a given `bash` understands. A non-Windows path is already one.
 *
 * IT IS STRING ARITHMETIC RATHER THAN A CALL TO `wslpath`, AND THE FIRST VERSION WAS THE CALL. Shelling out
 * to `bash -c 'wslpath -a "$1"' sh <path>` looks obviously more correct than hard-coding a prefix — and
 * measured from PowerShell, `$1` arrived EMPTY, so `wslpath` translated the working directory instead. The
 * wrapper was then handed the project directory, bash said "Is a directory", and the tests reported `126`:
 * a translation that silently produced a plausible-looking wrong path. The two conventions are one line
 * each and can be checked against literals offline, which the call could not be.
 */
export function toBashPath(path: string, style: 'wsl' | 'cygwin' | 'native'): string {
  if (!/^[A-Za-z]:[\\/]/.test(path)) return path;
  const drive = (path[0] as string).toLowerCase();
  const rest = path.slice(2).replace(/\\/g, '/');
  // WSL mounts Windows drives under /mnt; MSYS, Cygwin and Git Bash put them at the root. A `native` bash on
  // Windows is Git Bash, which takes the second.
  return style === 'wsl' ? `/mnt/${drive}${rest}` : `/${drive}${rest}`;
}

function runWrapper(script: string, stubExit: number, env: Record<string, string> = {}):
{ status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pjd-gate-'));
  const stub = join(dir, 'stub-gate.sh');
  writeFileSync(stub, `#!/usr/bin/env bash\necho "stub gate ran"\nexit ${stubExit}\n`);
  chmodSync(stub, 0o755);
  // BOTH PATHS ARE TRANSLATED. The wrapper is invoked by path and it invokes the stub by path; translating
  // only one of them moves the 127 rather than removing it.
  const wrapperEnv: Record<string, string> = {
    PROJECTION_JELLYFIN_GATE_COMMAND: toBashPath(stub, bashPathStyle),
    ...env,
  };
  // A WIN32 ENVIRONMENT VARIABLE DOES NOT REACH WSL UNLESS `WSLENV` NAMES IT, AND THIS IS THE THIRD LAYER OF
  // THE SAME FAILURE.
  //
  // With the path fixed and the line endings fixed, the wrapper finally RAN — and ignored the stub, because
  // `PROJECTION_JELLYFIN_GATE_COMMAND` never crossed the boundary, so its `:-` default took over and it
  // invoked the REAL gate. The suite then reported 77 (this host cannot host the gate) where it expected 0,
  // which reads exactly like the wrapper mishandling a skip: the defect these tests exist to catch, produced
  // by the harness rather than by the wrapper. `/u` means "pass it in, unchanged" — unchanged because the
  // path was already translated above, and letting WSL translate it a second time would corrupt it.
  const spawnEnv: Record<string, string | undefined> = { ...process.env, ...wrapperEnv };
  if (bashPathStyle === 'wsl') {
    const shared = Object.keys(wrapperEnv).map((name) => `${name}/u`).join(':');
    spawnEnv.WSLENV = process.env.WSLENV ? `${process.env.WSLENV}:${shared}` : shared;
  }
  const result = spawnSync('bash', [toBashPath(join(root, script), bashPathStyle)], {
    encoding: 'utf8',
    env: spawnEnv,
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

await test('the roadmap no longer says the data plane does not exist, because it does', () => {
  // THE STALE SENTENCE THIS REPLACES. The roadmap read "The data plane does not exist. No media server can
  // open a file through this product." That stopped being true when this gate started passing, and a
  // document that disagrees with what runs is this repository's own failure mode pointed the other way.
  const roadmap = read('docs/PROJECTION_ROADMAP.md');
  assert(!/The \*\*data plane\*\* does not exist/.test(roadmap), 'the stale claim is gone');
  assert(!/No media server can open a file through this product/.test(roadmap), 'and so is its second half');
  assert(/data plane exists/i.test(roadmap), 'and it says what is true instead');
});

await test('the roadmap corrects itself WITHOUT declaring Phase 1 closed', () => {
  // The opposite failure, and the more tempting one: a document that reads a passing gate as a passing
  // tranche. The anti-detour rule is what would be quietly repealed by it, so the rule itself has to say so.
  const roadmap = read('docs/PROJECTION_ROADMAP.md');
  assert(/Phase 1 remains open|Phase 1 is open|\*\*Open\.\*\*/.test(roadmap), 'the tranche is still open');
  assert(/has not been satisfied/.test(roadmap), 'and the anti-detour rule says it is not satisfied');
  for (const unproved of ['Plex', 'Emby', 'Unraid']) {
    assert(roadmap.includes(unproved), `and ${unproved} is named among what has not happened`);
  }
});

await test('G8, G9 and G10 are recorded as RUN, and G10 is explicitly not recorded as closed', () => {
  const plan = read('docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md');
  // Trimmed, because a checkout with CRLF line endings leaves a carriage return where the row ends and the
  // anchored match below would fail for a reason that has nothing to do with the table.
  const row = (gate: string): string =>
    (plan.split('\n').find((line) => line.startsWith(`| ${gate} `)) ?? '').trim();
  for (const gate of ['G7 **Scan**', 'G8 **Play**', 'G9 **Seek**', 'G10 **Transcode**']) {
    assert(row(gate).includes('now run'), `${gate} records what is now run`);
    assert(/\| not run \| not run \|$/.test(row(gate)), `${gate} still records Plex and Emby as not run`);
  }
  assert(/NOT closed as five minutes of encoder liveness/.test(row('G10 **Transcode**')),
    'and G10 names the thing it does not claim, in the row that claims the rest');
  assert(plan.includes('6.2'), 'with a section that gives the measurement behind it');
  // AND THE GATES NOBODY HAS RUN ARE STILL LISTED AS NOT RUN. A table that quietly lost a row would read as
  // closure by omission.
  for (const open of ['G18', 'G22', 'G24', 'G27']) {
    assert(plan.includes(`| ${open}`), `${open} is still in the table`);
  }
});

await test('the five-minute documentation states the encoder limitation with its measurement', () => {
  const doc = read('docs/PROJECTION_PHASE_1_JELLYFIN_DATA_PLANE.md');
  assert(/1\.6 seconds/.test(doc), 'the measured encoder time is in the document, not a hand-wave');
  assert(/does not claim|not a claim that an encoder/i.test(doc), 'and what is not claimed is stated');
  assert(/G18|simultaneous/i.test(doc), 'the simultaneous-client gate is named as unproved');
  assert(/Phase 1 is open/i.test(doc), 'and the document does not read as closure');
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(/NOT A CLAIM THAT AN ENCODER WAS BUSY FOR FIVE MINUTES/.test(gate),
    'and the gate prints the same limitation it documents, so the two cannot drift');
});

// ---------------------------------------------------------------------------------------------------------
// The five-minute gates, and every way of passing one without doing it
// ---------------------------------------------------------------------------------------------------------
//
// WHAT THESE ARE FOR. A gate that says "direct play ran for five minutes" is the easiest kind in this
// repository to fake, and the fakes are not exotic — they are the FIRST thing anybody writes: drain the file
// and sleep; sleep and decode nothing; count segments the server generated up front; sample a session once at
// the start. Each of the tests below hands the pure analysis a trace of exactly one of those shapes and
// requires it to come out failing. Without them, the five-minute claims rest on nobody having tried.

/** A trace of a real, paced play: about one record a second, media time tracking wall time. */
function pacedTrace(seconds: number, ratio = 1, startupMs = 1_500): PacedSample[] {
  const samples: PacedSample[] = [];
  for (let second = 1; second <= seconds; second += 1) {
    samples.push({
      wallMs: startupMs + second * 1_000,
      mediaMs: Math.round(second * 1_000 * ratio),
      frames: second * 5,
    });
  }
  return samples;
}

await test('a genuinely paced five-minute play passes every one of the four numbers', () => {
  const analysis = analysePacedPlayback(pacedTrace(300));
  assert(analysis.startupSeconds <= MEDIA_SERVER_SOAK.MAX_STARTUP_SECONDS, 'it started in time');
  assert(analysis.mediaSeconds >= MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS, 'it decoded five minutes');
  assert(analysis.wallSeconds >= MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS, 'over five minutes of wall clock');
  assert(analysis.pacingRatio <= MEDIA_SERVER_SOAK.MAX_PACING_RATIO, 'at about one media second per second');
  assert(analysis.pacingRatio >= MEDIA_SERVER_SOAK.MIN_PACING_RATIO, 'and not near zero either');
  assert(analysis.longestStallSeconds <= MEDIA_SERVER_SOAK.MAX_STALL_SECONDS, 'without stalling');
});

await test('THE FAST DRAIN: a whole file downloaded in seconds cannot pass as five minutes of playback', () => {
  // Five minutes of media delivered in twenty seconds, which is what `fetch` does through this mount, and
  // what a `sleep 300` after it would otherwise turn into a passing five-minute gate.
  const samples: PacedSample[] = [];
  for (let second = 1; second <= 20; second += 1) {
    samples.push({ wallMs: second * 1_000, mediaMs: second * 15_000, frames: second * 75 });
  }
  const analysis = analysePacedPlayback(samples);
  assert(analysis.mediaSeconds >= 300, 'it really did decode five minutes of media');
  assert(analysis.wallSeconds < 300, '...in twenty seconds');
  assert(analysis.pacingRatio > MEDIA_SERVER_SOAK.MAX_PACING_RATIO,
    'and the pacing ratio is what refuses it, because every other number looks correct');
});

await test('THE SLEEP: five minutes of wall clock with nothing decoded cannot pass either', () => {
  const samples: PacedSample[] = [];
  for (let second = 1; second <= 300; second += 1) {
    samples.push({ wallMs: second * 1_000, mediaMs: Math.min(4_000, second * 20), frames: 20 });
  }
  const analysis = analysePacedPlayback(samples);
  assert(analysis.wallSeconds >= 300, 'the wall clock reached five minutes');
  assert(analysis.mediaSeconds < MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS,
    'and the decoded media time is what refuses it');
  assert(analysis.pacingRatio < MEDIA_SERVER_SOAK.MIN_PACING_RATIO, 'as does the pacing floor');
});

await test('THE STALL: a play that froze for a minute and caught up is not a play without a stall', () => {
  // The endpoints of this trace are indistinguishable from a correct run: five minutes of wall clock, five
  // minutes of media, a ratio of one. Only a measurement taken ACROSS the window can see the freeze.
  const samples: PacedSample[] = [];
  let media = 0;
  for (let second = 1; second <= 362; second += 1) {
    if (second < 100 || second > 160) media += 1_000;
    samples.push({ wallMs: second * 1_000, mediaMs: media, frames: Math.round(media / 200) });
  }
  const analysis = analysePacedPlayback(samples);
  assert(analysis.mediaSeconds >= 300, 'it decoded five minutes in the end');
  assert(analysis.wallSeconds >= 300, 'over more than five minutes');
  assert(analysis.pacingRatio <= MEDIA_SERVER_SOAK.MAX_PACING_RATIO, 'and the ratio is unremarkable');
  assert(analysis.longestStallSeconds > MEDIA_SERVER_SOAK.MAX_STALL_SECONDS,
    'the stall measurement is the only one that sees it');
  assert(analysis.longestStallSeconds >= 55 && analysis.longestStallSeconds <= 65,
    `and it reports the freeze once, not once per sample: ${analysis.longestStallSeconds}s`);
});

await test('a slow start is refused however good the rest of the play is', () => {
  const analysis = analysePacedPlayback(pacedTrace(310, 1, 22_000));
  assert(analysis.mediaSeconds >= 300 && analysis.pacingRatio <= MEDIA_SERVER_SOAK.MAX_PACING_RATIO,
    'the play itself is fine');
  assert(analysis.startupSeconds > MEDIA_SERVER_SOAK.MAX_STARTUP_SECONDS,
    'and startup is what refuses it — G8 asks for both');
});

await test('a consumer that produced nothing at all fails rather than reporting nothing', () => {
  // THE CASE THAT MUST NOT BE AN ABSENCE. An empty trace, or one where every record has zero frames, is a
  // consumer that never decoded anything. Reporting "no measurement" would leave the caller to decide, and
  // a caller with no number is a caller that passes.
  for (const samples of [[], [{ wallMs: 1_000, mediaMs: 0, frames: 0 }]] as PacedSample[][]) {
    const analysis = analysePacedPlayback(samples);
    assert(analysis.startupSeconds === Infinity, 'startup is unbounded, so the startup ceiling fails');
    assert(analysis.mediaSeconds === 0, 'no media was decoded, so the media floor fails');
    assert(analysis.pacingRatio === 0, 'and the pacing floor fails too');
  }
});

await test('the stall is measured from the last movement, not between adjacent records', () => {
  // A consumer emitting a record a second while frozen would otherwise report a hundred one-second stalls
  // and never reach any ceiling, however long the freeze lasted.
  const samples: PacedSample[] = [{ wallMs: 1_000, mediaMs: 1_000, frames: 5 }];
  for (let second = 2; second <= 100; second += 1) {
    samples.push({ wallMs: second * 1_000, mediaMs: 1_000, frames: 5 });
  }
  assert(analysePacedPlayback(samples).longestStallSeconds >= 98, 'one long stall, not ninety-nine short ones');
});

await test('a freeze that lasted until the consumer was stopped is still a stall', () => {
  // It has no later record to close it, so a loop that only looked at pairs would miss it entirely.
  const samples = pacedTrace(60);
  const lastMedia = (samples[samples.length - 1] as PacedSample).mediaMs;
  const lastWall = (samples[samples.length - 1] as PacedSample).wallMs;
  samples.push({ wallMs: lastWall + 90_000, mediaMs: lastMedia, frames: 999 });
  assert(analysePacedPlayback(samples).longestStallSeconds >= 89, 'the trailing freeze is counted');
});

/**
 * A five-minute transcode consumed at a player's pace, with everything decoding as it should.
 *
 * `arrivals` is what shapes the cheats: `paced` is a segment every few seconds across the window, `burst`
 * is everything at the start with one straggler at the end, and `frontLoaded` is a dense first two thirds
 * and a thin tail.
 */
function soakFixture(seconds: number, opts: {
  arrivals?: 'paced' | 'burst' | 'front-loaded'; codec?: string; packets?: number;
  encoderSpanSeconds?: number; encoderFiles?: number; active?: number; encoderLive?: number;
  sessionPresent?: number; sameSegment?: boolean;
} = {}): {
  segments: SoakSegment[]; probes: SoakProbe[]; mtimes: number[];
  sessions: TranscodeSessionSampleRecord[];
} {
  const segmentSeconds = 6;
  const count = Math.ceil(seconds / segmentSeconds);
  const arrivals = opts.arrivals ?? 'paced';
  const segments: SoakSegment[] = [];
  const probes: SoakProbe[] = [];
  for (let index = 0; index < count; index += 1) {
    const share = index / Math.max(1, count - 1);
    // A burst puts everything in the first twenty seconds and one last segment five minutes later; a
    // front-loaded run compresses every arrival into the first two thirds of the window.
    const wallMs = arrivals === 'burst'
      ? (index === count - 1 ? 2_000 + seconds * 1_000 : 2_000 + index * 400)
      : arrivals === 'front-loaded'
        ? 2_000 + Math.round(share * seconds * 1_000 * 0.62)
        : 2_000 + Math.round(share * seconds * 1_000);
    segments.push({
      index, wallMs, mediaStartSeconds: index * segmentSeconds, bytes: 150_000,
      sha256: opts.sameSegment ? 'identical' : createHash('sha256').update(`soak-${index}`).digest('hex'),
    });
    probes.push({
      index, codec: opts.codec ?? 'h264', packets: opts.packets ?? 150, seconds: segmentSeconds,
    });
  }
  // A FRONT-LOADED RUN NEEDS A TAIL, or its last arrival IS the end of the window and there is no late third
  // to be empty. One straggler at the end is what a padded run looks like.
  if (arrivals === 'front-loaded') {
    segments.push({
      index: count, wallMs: 2_000 + seconds * 1_000, mediaStartSeconds: count * segmentSeconds,
      bytes: 150_000, sha256: createHash('sha256').update('soak-tail').digest('hex'),
    });
    probes.push({ index: count, codec: opts.codec ?? 'h264', packets: opts.packets ?? 150, seconds: segmentSeconds });
  }
  const encoderFiles = opts.encoderFiles ?? count;
  const encoderSpan = (opts.encoderSpanSeconds ?? 2) * 1_000;
  const mtimes = Array.from({ length: encoderFiles }, (_value, index) =>
    1_700_000_000_000 + Math.round((index / Math.max(1, encoderFiles - 1)) * encoderSpan));
  const sessionCount = 20;
  const method = opts.active ?? sessionCount;
  // THE FIXTURE REPRODUCES WHAT THE PINNED SERVER ACTUALLY DOES: `PlayMethod` stays `Transcode` for the life
  // of the session, and live `TranscodingInfo` vanishes within a sample or two of the encoder exiting.
  const sessions = Array.from({ length: sessionCount }, (_value, index) => ({
    methodIsTranscode: index < method,
    encoderJobLive: index < (opts.encoderLive ?? 1),
    sessionPresent: index < (opts.sessionPresent ?? sessionCount),
  }));
  return { segments, probes, mtimes, sessions };
}

await test('a genuinely five-minute paced transcode passes on continuity, not on an encoder being busy', () => {
  const fixture = soakFixture(306);
  const analysis = analyseTranscodeSoak(fixture.segments, fixture.probes, fixture.mtimes, fixture.sessions);
  assert(analysis.wallSpanSeconds >= MEDIA_SERVER_SOAK.MIN_TRANSCODE_SECONDS, 'the client consumed for five minutes');
  assert(analysis.maxArrivalGapSeconds <= MEDIA_SERVER_SOAK.MAX_SEGMENT_ARRIVAL_GAP_SECONDS,
    'without a gap in the middle of it');
  assert(analysis.decodedMediaSeconds >= MEDIA_SERVER_SOAK.MIN_TRANSCODE_SECONDS, 'five minutes decoded');
  assert(analysis.lateWindowDecodedSeconds
    >= 300 * MEDIA_SERVER_SOAK.MIN_LATE_WINDOW_DECODED_FRACTION, 'with the last third still decoding');
  assertEq(analysis.wrongCodec, 0, 'every segment is the forced codec');
  assertEq(analysis.emptyOfVideo, 0, 'and none is empty');
  assertEq(analysis.unprobed, 0, 'every consumed segment was decoded');
  assertEq(analysis.distinctSegments, analysis.segments, 'and every one is a different segment');
  // AND THE ENCODER RAN AHEAD AND FINISHED, which is what the pinned server actually does and which this
  // fixture reproduces: two seconds of output files behind a five-minute paced consumption. Nothing above
  // depends on it, and that is the correction this test exists to hold in place.
  assert(analysis.encoderAheadSpanSeconds < 10, 'the encoder finished almost immediately');
});

await test('THE SLEEPING TRANSCODE CLIENT: a burst and a straggler cannot pass as five minutes', () => {
  // The single most available fake: consume every segment as fast as the socket allows, wait, fetch one
  // more. Five minutes of wall span, five minutes of decoded h264, every segment distinct and correct.
  const fixture = soakFixture(306, { arrivals: 'burst' });
  const analysis = analyseTranscodeSoak(fixture.segments, fixture.probes, fixture.mtimes, fixture.sessions);
  assert(analysis.wallSpanSeconds >= 300, 'the wall span is five minutes');
  assert(analysis.decodedMediaSeconds >= 300, 'and five minutes of h264 was decoded');
  assertEq(analysis.wrongCodec + analysis.emptyOfVideo + analysis.unprobed, 0, 'and nothing else is wrong');
  assert(analysis.maxArrivalGapSeconds > MEDIA_SERVER_SOAK.MAX_SEGMENT_ARRIVAL_GAP_SECONDS,
    'the arrival gap is the only thing that refuses it');
});

await test('THE FRONT-LOADED TRANSCODE: a dense start and a padded tail cannot pass either', () => {
  const fixture = soakFixture(306, { arrivals: 'front-loaded' });
  const analysis = analyseTranscodeSoak(fixture.segments, fixture.probes, fixture.mtimes, fixture.sessions);
  assert(analysis.wallSpanSeconds >= 300, 'the wall span is five minutes');
  assert(analysis.decodedMediaSeconds >= 300, 'and five minutes of h264 was decoded');
  assert(analysis.lateWindowDecodedSeconds
    < 300 * MEDIA_SERVER_SOAK.MIN_LATE_WINDOW_DECODED_FRACTION,
    'the last third of the window decoded almost nothing, which is what refuses it');
});

await test('ONE SEGMENT DELIVERED FIFTY TIMES IS NOT FIFTY SEGMENTS', () => {
  const fixture = soakFixture(306, { sameSegment: true });
  const analysis = analyseTranscodeSoak(fixture.segments, fixture.probes, fixture.mtimes, fixture.sessions);
  assert(analysis.wallSpanSeconds >= 300 && analysis.decodedMediaSeconds >= 300, 'every total is reached');
  assert(analysis.maxArrivalGapSeconds <= MEDIA_SERVER_SOAK.MAX_SEGMENT_ARRIVAL_GAP_SECONDS, 'paced, even');
  assertEq(analysis.distinctSegments, 1, 'and it is one segment, over and over');
  assert(analysis.distinctSegments < analysis.segments, 'which is what refuses it');
});

await test('a slow first segment is a gap, and it is at the front where a pairwise check would miss it', () => {
  const fixture = soakFixture(306);
  const late = fixture.segments.map((segment) => ({ ...segment, wallMs: segment.wallMs + 120_000 }));
  const analysis = analyseTranscodeSoak(late, fixture.probes, fixture.mtimes, fixture.sessions);
  assert(analysis.maxArrivalGapSeconds > MEDIA_SERVER_SOAK.MAX_SEGMENT_ARRIVAL_GAP_SECONDS,
    'two minutes before the first segment arrived is a gap in the window');
});

await test('a transcode that emitted the wrong codec, or empty segments, is refused', () => {
  const remuxed = soakFixture(306, { codec: TRANSCODE_SOURCE_VIDEO_CODEC });
  assert(analyseTranscodeSoak(remuxed.segments, remuxed.probes, remuxed.mtimes, remuxed.sessions).wrongCodec > 0,
    'a server that remuxed rather than re-encoded is caught by decoding the output');
  const empty = soakFixture(306, { packets: 0 });
  assert(analyseTranscodeSoak(empty.segments, empty.probes, empty.mtimes, empty.sessions).emptyOfVideo > 0,
    'and a segment with no decodable video packets is not transcoded video');
});

await test('segments consumed but never decoded are counted, so the decoded total is never a sample', () => {
  const fixture = soakFixture(306);
  const analysis = analyseTranscodeSoak(fixture.segments, fixture.probes.slice(0, 3), fixture.mtimes,
    fixture.sessions);
  assert(analysis.unprobed > 0, 'the phase that only decoded three of fifty says so');
  assert(analysis.decodedMediaSeconds < 300, 'and its decoded total falls short rather than being scaled up');
});

await test('THE ENCODER SPAN IS REPORTED, AND NOTHING PASSES OR FAILS ON IT', () => {
  // The correction this test pins down. An earlier version required this span to cover most of the window,
  // on the theory that a throttled encoder stays a bounded distance ahead of its client. Measured against
  // the pinned server with throttling on: 115 output files inside 1.6 seconds. Requiring five minutes of it
  // would have been a gate that fails when nothing is wrong; describing 1.6 seconds as proof the encoder ran
  // for five minutes would have been a claim the measurement contradicts. So it is reported as what it is —
  // how far ahead of the paced client the encoder ran — and the five-minute claim rests on continuity.
  const raced = soakFixture(306, { encoderSpanSeconds: 2, encoderFiles: 115 });
  const analysis = analyseTranscodeSoak(raced.segments, raced.probes, raced.mtimes, raced.sessions);
  assertEq(analysis.encoderOutputFiles, 115, 'the files the encoder wrote are counted');
  assert(analysis.encoderAheadSpanSeconds < 5, 'and they span seconds, not minutes');
  assert(analysis.wallSpanSeconds >= 300 && analysis.decodedMediaSeconds >= 300
    && analysis.maxArrivalGapSeconds <= MEDIA_SERVER_SOAK.MAX_SEGMENT_ARRIVAL_GAP_SECONDS
    && analysis.lateWindowDecodedSeconds >= 300 * MEDIA_SERVER_SOAK.MIN_LATE_WINDOW_DECODED_FRACTION,
    'and the run is a passing one anyway, because nothing asserts on the encoder span');
  const cli = readCode('src/ops/projection-jellyfin-dataplane-cli.ts');
  const block = cli.slice(cli.indexOf('JD20-transcode-soak-encoder-ahead-span-seconds'));
  assert(/verdict: 'pass'/.test(block.slice(0, 400)),
    'and the gate records it with a fixed verdict rather than holding it to a threshold');
});

await test('THE TRANSCODE CLAIM IS NOT A CLAIM THIS GATE MADE AND READ BACK', () => {
  // THE CIRCULARITY THIS PINS SHUT. An earlier version asserted that the server reported this session's
  // playback method as `Transcode` at 80% of samples — while the gate's own playback report was SENDING
  // `PlayMethod: 'Transcode'`. A three-arm negative control against a live pinned server, with a real
  // mpeg4-to-h264 transcode serving the segments in EVERY arm, settled what the field is worth:
  //
  //   reporting Transcode  -> read DirectPlay at t=0, Transcode at t=20s
  //   reporting nothing    -> read DirectPlay at t=0, Transcode at t=20s
  //   reporting DirectPlay -> read DirectPlay at BOTH, with the transcode running
  //
  // The third arm is decisive: the client's contrary claim wins, so the field is client-writable and cannot
  // carry an assertion about what the server was doing.
  const driver = readCode('src/ops/projection-jellyfin-dataplane.ts');
  const report = driver.slice(driver.indexOf('async function reportPlayback'),
    driver.indexOf('export async function transcodeSessionNow'));
  assert(!/PlayMethod/.test(report), 'the gate authors no PlayMethod, so it cannot read its own claim back');
  const cli = readCode('src/ops/projection-jellyfin-dataplane-cli.ts');
  assert(!/atLeast\(`JD20-transcode-soak-transcode-method-samples/.test(cli)
    && !/atLeast\(`JD20-transcode-soak-reported-method-samples/.test(cli),
    'and no gate holds the reported method to a floor');
  const block = cli.slice(cli.indexOf('JD20-transcode-soak-reported-method-samples'));
  assert(/verdict: 'pass'/.test(block.slice(0, 400)), 'it is recorded with a fixed verdict');
  // ...AND WHAT CARRIES THE CLAIM INSTEAD IS ANCHORED AT BOTH ENDS INSIDE THE SAME PHASE.
  assert(cli.includes('JD20-transcode-soak-source-codec'),
    'the source codec is asserted in the soak phase, not only in the short transcode step');
  assert(cli.includes('JD20-transcode-soak-wrong-codec'), 'and every consumed segment is decoded');
});

await test('A FAILED SESSION POLL IS NOT AN OBSERVATION THAT THE SERVER REPORTED NOTHING', () => {
  // THE DEFECT THIS PINS. `transcodeSessionNow` ended in `.catch(() => [])` and the caller wrapped it in a
  // second catch producing `{ methodIsTranscode: false, encoderJobLive: false, sessionPresent: false }`. A
  // request that never reached the server therefore became a recorded SAMPLE stating that the server had
  // reported no transcode and no session — a measurement nobody took, wearing the shape of one — and it
  // padded `sessionSamples`, which IS asserted. A run whose every poll failed could satisfy "the session was
  // sampled across the window" out of nothing but its own failures.
  const driver = readCode('src/ops/projection-jellyfin-dataplane.ts');
  const fn = driver.slice(driver.indexOf('export async function transcodeSessionNow'),
    driver.indexOf('export interface TranscodeSoakOptions'));
  assert(!/\.catch\(/.test(fn), 'a failed read throws rather than answering');
  const soak = driver.slice(driver.indexOf('export async function transcodeSoak'));
  assert(/failedSessionPolls \+= 1/.test(soak), 'the caller counts the failure');
  assert(!/methodIsTranscode: false/.test(soak), 'and never synthesizes a sample to stand in for it');
  const cli = readCode('src/ops/projection-jellyfin-dataplane-cli.ts');
  assert(/exactly\(`JD20-transcode-soak-failed-session-polls[\s\S]{0,200}?, 0,/.test(cli),
    'and failed polls are gated at zero rather than merely reported');

  // ...AND THE SAMPLES THAT REMAIN HAVE TO HAVE FOUND THIS GATE'S SESSION. `methodIsTranscode` and
  // `encoderJobLive` are both false for "no session of ours exists" and for "one exists and is neither", so
  // without this the telemetry cannot be told apart from an absence.
  const absent = soakFixture(306, { sessionPresent: 0 });
  const analysis = analyseTranscodeSoak(absent.segments, absent.probes, absent.mtimes, absent.sessions);
  assertEq(analysis.sessionPresentSamples, 0, 'a window that never had our session says so');
  assert(analysis.sessionPresentSamples
    < Math.ceil(analysis.sessionSamples * MEDIA_SERVER_SOAK.MIN_SESSION_PRESENT_SAMPLE_FRACTION),
    'and fails the floor, rather than reading as a quiet server');
  const healthy = soakFixture(306);
  const good = analyseTranscodeSoak(healthy.segments, healthy.probes, healthy.mtimes, healthy.sessions);
  assertEq(good.sessionPresentSamples, good.sessionSamples, 'while a real window finds it every time');
});

await test('a failed playback report is reported, not swallowed', () => {
  // The session numbers are only meaningful if the server was being told a player was still playing. A run
  // whose reports were refused describes this gate's silence, and a reader is entitled to know which of the
  // two they are looking at — even for numbers nothing asserts on.
  const driver = readCode('src/ops/projection-jellyfin-dataplane.ts');
  const report = driver.slice(driver.indexOf('async function reportPlayback'),
    driver.indexOf('export async function transcodeSessionNow'));
  assert(/Promise<boolean>/.test(report), 'the report says whether it landed');
  assert(!/\.catch\(\(\) => undefined\)/.test(report), 'rather than discarding the answer');
  const cli = readCode('src/ops/projection-jellyfin-dataplane-cli.ts');
  assert(/exactly\(`JD20-transcode-soak-failed-playback-reports/.test(cli),
    'and the count of refused reports is a gate of its own');
});

await test('a session sample answers for THIS gate’s device, not for anyone playing the same item', () => {
  // The gate opens several sessions against the same item over one run, and the server keeps finished ones.
  // Matching on the item alone answers for whichever session comes back first — and on any server that is
  // not this gate's private container, for another client entirely.
  const driver = readCode('src/ops/projection-jellyfin-dataplane.ts');
  const fn = driver.slice(driver.indexOf('export async function transcodeSessionNow'),
    driver.indexOf('export interface TranscodeSoakOptions'));
  assert(/DeviceId === GATE_CLIENT\.deviceId/.test(fn), 'the filter is bound to this gate own device');
  assert(/NowPlayingItem\?\.Id === item\.itemId/.test(fn), 'and to the item');
  assert(!/\.find\(/.test(fn), 'and it does not answer from whichever row came back first');
});

await test('LIVE ENCODER SAMPLES ARE RECORDED AND NOT ASSERTED, and the fixture is what the server does', () => {
  // Measured: `TranscodingInfo` is populated immediately after the job starts and is NULL fifteen seconds
  // later, because the encoder finishes the whole source in 1.6 seconds and exits. Asserting a share of it
  // would be asserting encoder liveness — the claim this gate explicitly does not make.
  const fixture = soakFixture(306);
  const analysis = analyseTranscodeSoak(fixture.segments, fixture.probes, fixture.mtimes, fixture.sessions);
  assertEq(analysis.encoderLiveSamples, 1, 'the encoder was live for one sample of twenty');
  assert(analysis.wallSpanSeconds >= 300 && analysis.decodedMediaSeconds >= 300
    && analysis.maxArrivalGapSeconds <= MEDIA_SERVER_SOAK.MAX_SEGMENT_ARRIVAL_GAP_SECONDS,
    'and the run is a passing one anyway, because nothing asserts on it');
  const cli = readCode('src/ops/projection-jellyfin-dataplane-cli.ts');
  assert(!/atLeast\(`JD20-transcode-soak-encoder-live/.test(cli),
    'and no gate holds the live-encoder count to a floor');
  const block = cli.slice(cli.indexOf('JD20-transcode-soak-encoder-live-samples'));
  assert(/verdict: 'pass'/.test(block.slice(0, 300)), 'it is recorded with a fixed verdict');
});


await test('the session only attaches because playback is reported, which is measured and not assumed', () => {
  // The finding: `/Sessions` shows nothing for a raw HLS request. Reporting `Playing` and then progress is
  // what makes the server's own bookkeeping observable at all, so the assertion above has a subject.
  const driver = readCode('src/ops/projection-jellyfin-dataplane.ts');
  assert(driver.includes("'/Sessions/Playing'") || driver.includes('/Sessions/${stage}'),
    'playback is reported to the server');
  for (const stage of ["'Playing'", "'Playing/Progress'", "'Playing/Stopped'"]) {
    assert(driver.includes(stage), `including ${stage}, so a failed run leaves no session behind`);
  }
});

await test('the ten seek positions really do go backwards and really do reach past 90%', () => {
  assertEq(seekPlanProblems(SEEK_PLAN_FRACTIONS).length, 0,
    `the shipped plan is well formed: ${seekPlanProblems(SEEK_PLAN_FRACTIONS).join('; ')}`);
  assertEq(SEEK_PLAN_FRACTIONS.length, MEDIA_SERVER_SOAK.SEEK_COUNT, 'ten of them');
  const deep = SEEK_PLAN_FRACTIONS.filter((f) => f > MEDIA_SERVER_SOAK.DEEP_SEEK_FRACTION);
  assert(deep.length >= 1, `at least one beyond 90% of duration: ${deep.join(', ')}`);
  let backward = 0;
  for (let i = 1; i < SEEK_PLAN_FRACTIONS.length; i += 1) {
    if ((SEEK_PLAN_FRACTIONS[i] as number) < (SEEK_PLAN_FRACTIONS[i - 1] as number)) backward += 1;
  }
  assert(backward >= MEDIA_SERVER_SOAK.MIN_BACKWARD_SEEKS, `and ${backward} backward transitions`);
});

await test('A MONOTONIC SWEEP IS REFUSED, which is what a per-seek assertion could never notice', () => {
  // Ten seeks, every one of which would pass "a decodable segment within ten seconds" — and not one of
  // which asks the server to seek backwards. This is the plan somebody writes when the loop is `i/10`.
  const sweep = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.89];
  const problems = seekPlanProblems(sweep);
  assert(problems.some((p) => p.includes('backwards')), `a sweep never seeks backwards: ${problems.join('; ')}`);
  assert(problems.some((p) => p.includes('90')), 'and it never reaches past 90% of duration');
});

await test('a short, duplicated or out-of-range seek plan is refused', () => {
  assert(seekPlanProblems([0.1, 0.9, 0.2]).some((p) => p.includes('3 positions')), 'too few');
  assert(seekPlanProblems([0.05, 0.93, 0.2, 0.62, 0.02, 0.41, 0.97, 0.15, 0.78, 0.78])
    .some((p) => p.includes('the same')), 'two identical positions measure the same thing twice');
  assert(seekPlanProblems([0.05, 0.93, 0.2, 0.62, 0.02, 0.41, 1.4, 0.15, 0.78, 0.33])
    .some((p) => p.includes('strictly inside')), 'a position past the end of the media is not a seek');
});

await test('a seek plan lands on real second positions inside a real duration', () => {
  const positions = seekPositionsFor(340);
  assertEq(positions.length, 10, 'ten positions');
  assert(positions.every((p) => p > 0 && p < 340), 'all inside the media');
  assert(positions.some((p) => p > 340 * MEDIA_SERVER_SOAK.DEEP_SEEK_FRACTION), 'one past 90% of it');
});

/**
 * Ten seeks as the pinned server actually answers them: a distinct segment per position, and a decoded start
 * timestamp that tracks the position with a CONSTANT offset — measured at +10s on Jellyfin 10.10.7, which is
 * its transport-stream presentation-time base and is deliberately not hard-coded into the assertion.
 */
function seekFixture(opts: {
  duration?: number; segmentSeconds?: number; offset?: number; sameSegment?: boolean;
  frozenPosition?: boolean; slowest?: number; codec?: string; packets?: number; probed?: number;
} = {}): { seeks: SeekObservation[]; decodes: SeekDecode[] } {
  const duration = opts.duration ?? 340;
  const segmentSeconds = opts.segmentSeconds ?? 3;
  const offset = opts.offset ?? 10;
  const seeks: SeekObservation[] = [];
  const decodes: SeekDecode[] = [];
  seekPositionsFor(duration).forEach((requested, index) => {
    const serverPositionSeconds = opts.frozenPosition ? 0
      : Math.floor(requested / segmentSeconds) * segmentSeconds;
    seeks.push({
      index,
      requestedSeconds: requested,
      serverPositionSeconds,
      elapsedMs: index === 0 ? (opts.slowest ?? 900) : 300,
      bytes: 36_000,
      sha256: opts.sameSegment ? 'identical' : createHash('sha256').update(`seg-${index}`).digest('hex'),
    });
    if (opts.probed !== undefined && index >= opts.probed) return;
    decodes.push({
      index,
      codec: opts.codec ?? 'h264',
      packets: opts.packets ?? 36,
      startSeconds: (opts.frozenPosition ? 0 : serverPositionSeconds) + offset,
    });
  });
  return { seeks, decodes };
}

await test('ten genuine seeks pass every property that belongs to the SET, not just to one seek', () => {
  const { seeks, decodes } = seekFixture();
  const analysis = analyseSeekSet(seeks, decodes);
  assertEq(analysis.count, 10, 'ten of them');
  assertEq(analysis.distinctSegments, 10, 'ten different segments came back');
  assertEq(analysis.unprobed, 0, 'every one was decoded');
  assertEq(analysis.wrongCodec, 0, 'every one is the forced codec');
  assertEq(analysis.emptyOfVideo, 0, 'and none is empty');
  assert(analysis.backwardTransitions >= MEDIA_SERVER_SOAK.MIN_BACKWARD_SEEKS, 'the order really went back');
  assert(analysis.deepSeeks >= 1, 'and one went past 90% of the furthest position reached');
  assert(analysis.slowestSeconds <= MEDIA_SERVER_SOAK.MAX_SEEK_SECONDS, 'inside ten seconds each');
  assert(analysis.maxPositionErrorSeconds <= MEDIA_SERVER_SOAK.MAX_SEEK_POSITION_ERROR_SECONDS,
    'landing within a segment of what was asked for');
  assert(analysis.decodedOffsetSpreadSeconds <= MEDIA_SERVER_SOAK.MAX_SEEK_DECODED_OFFSET_SPREAD_SECONDS,
    'with a constant decoded-timestamp offset');
  assert(analysis.decodedSpanSeconds >= 340 * MEDIA_SERVER_SOAK.MIN_SEEK_DECODED_SPAN_FRACTION,
    'and the decoded timestamps span the media');
});

await test('A SERVER PRESENTATION-TIME BASE IS MEASURED, NOT HARD-CODED', () => {
  // The pinned server offsets its transport-stream timestamps by ten seconds. A different server, or a
  // different version, may not — and an assertion that hard-coded ten would fail a perfectly good one. What
  // is universal is that the offset does not CHANGE as the position moves.
  for (const offset of [0, 10, 90]) {
    const { seeks, decodes } = seekFixture({ offset });
    assert(analyseSeekSet(seeks, decodes).decodedOffsetSpreadSeconds
      <= MEDIA_SERVER_SOAK.MAX_SEEK_DECODED_OFFSET_SPREAD_SECONDS, `an offset of ${offset}s is accepted`);
  }
});

await test('THE SAME SEGMENT TEN TIMES IS REFUSED, which every per-seek assertion would have passed', () => {
  // A 200, a non-empty body, decodable h264 and a sub-ten-second response are all satisfied by returning the
  // first three seconds of the file ten times. These are the two properties that are not.
  const { seeks, decodes } = seekFixture({ sameSegment: true, frozenPosition: true });
  const analysis = analyseSeekSet(seeks, decodes);
  assertEq(analysis.wrongCodec, 0, 'the segments decode perfectly');
  assertEq(analysis.emptyOfVideo, 0, 'and are full of video');
  assert(analysis.slowestSeconds <= MEDIA_SERVER_SOAK.MAX_SEEK_SECONDS, 'and arrive quickly');
  assertEq(analysis.distinctSegments, 1, 'and are one segment, ten times over');
  assert(analysis.decodedSpanSeconds < 340 * MEDIA_SERVER_SOAK.MIN_SEEK_DECODED_SPAN_FRACTION,
    'the decoded timestamps cover none of the media');
  assert(analysis.maxPositionErrorSeconds > MEDIA_SERVER_SOAK.MAX_SEEK_POSITION_ERROR_SECONDS,
    'and the server disagrees with the position it was asked for');
});

await test('a server that answered every seek from a position of its own choosing is refused', () => {
  // The positions the server reports agree with what was asked for, but the decoded timestamps do not move
  // with them — which is what a read-ahead buffer being drained ten times would look like.
  const { seeks, decodes } = seekFixture();
  const scrambled = decodes.map((decode, index) => ({ ...decode, startSeconds: 10 + index }));
  assert(analyseSeekSet(seeks, scrambled).decodedOffsetSpreadSeconds
    > MEDIA_SERVER_SOAK.MAX_SEEK_DECODED_OFFSET_SPREAD_SECONDS,
    'the offset spread is what refuses it');
});

await test('a slow seek, a remuxed seek and an undecoded seek are each refused', () => {
  const slow = seekFixture({ slowest: 12_000 });
  assert(analyseSeekSet(slow.seeks, slow.decodes).slowestSeconds > MEDIA_SERVER_SOAK.MAX_SEEK_SECONDS,
    'a seek that took twelve seconds blows G9\'s ten');
  const remuxed = seekFixture({ codec: TRANSCODE_SOURCE_VIDEO_CODEC });
  assert(analyseSeekSet(remuxed.seeks, remuxed.decodes).wrongCodec > 0, 'a remux is not a transcode');
  const emptied = seekFixture({ packets: 0 });
  assert(analyseSeekSet(emptied.seeks, emptied.decodes).emptyOfVideo > 0, 'and no packets is not playable');
  const partial = seekFixture({ probed: 4 });
  assertEq(analyseSeekSet(partial.seeks, partial.decodes).unprobed, 6,
    'six seeks nobody decoded are counted rather than assumed good');
});

await test('an empty seek set fails rather than reporting nothing', () => {
  const analysis = analyseSeekSet([], []);
  assertEq(analysis.count, 0, 'no seeks');
  assert(analysis.slowestSeconds === Infinity, 'the timing ceiling fails');
  assert(analysis.maxPositionErrorSeconds === Infinity, 'the position check fails');
  assert(analysis.decodedOffsetSpreadSeconds === Infinity, 'and the temporal check fails');
});

await test('a Windows path is translated for whichever bash is on PATH', () => {
  // THE DEFECT THIS CLOSES, AND IT WAS A FALSE ALARM ABOUT THE MOST IMPORTANT PROPERTY IN THIS GATE. Run
  // from PowerShell, `bash` is WSL, which takes neither `C:\a\b` nor `/c/a/b` and answers 127 — so the four
  // wrapper-accounting tests reported that a skipped run looked like a passing one, because of a path
  // separator. Run from Git Bash the same tests passed. A gate whose verdict depends on which shell started
  // it is not a gate.
  assertEq(toBashPath('C:\\Users\\a\\b.sh', 'wsl'), '/mnt/c/Users/a/b.sh', 'WSL mounts drives under /mnt');
  assertEq(toBashPath('C:\\Users\\a\\b.sh', 'cygwin'), '/c/Users/a/b.sh', 'MSYS and Cygwin put them at root');
  assertEq(toBashPath('C:\\Users\\a\\b.sh', 'native'), '/c/Users/a/b.sh', 'and a native Windows bash is Git Bash');
  assertEq(toBashPath('D:/x/y', 'wsl'), '/mnt/d/x/y', 'forward slashes and any drive letter');
  // A path that is already POSIX is left exactly alone, which is every non-Windows host.
  for (const style of ['wsl', 'cygwin', 'native'] as const) {
    assertEq(toBashPath('/home/runner/work/x.sh', style), '/home/runner/work/x.sh', 'untouched');
  }
});

await test('the seek settle is a client rate and cannot absorb a slow seek', () => {
  // A wait between seeks is one edit away from being a retry loop, and a retry loop would turn "each seek
  // produced playable video within 10 s" into "each seek eventually did". Two properties keep it honest, and
  // both are checked here rather than promised in the comment beside it.
  assert(SEEK_SETTLE_MS > 0 && SEEK_SETTLE_MS < MEDIA_SERVER_SOAK.MAX_SEEK_SECONDS * 1_000,
    'the settle is shorter than the per-seek ceiling it sits beside');
  // THE RAW SOURCE, NOT `readCode`. Stripping block comments needs a parser to be correct — a `/*` inside a
  // string or a regex literal anywhere above pairs with the next `*/` and silently swallows real code, which
  // is exactly what happened while this test was being written: the slice came back four times too long and
  // the assertion below failed against a loop that was fine. The tokens this test looks for do not occur in
  // prose, so the comments cost it nothing.
  const driver = read('src/ops/projection-jellyfin-dataplane.ts');
  const loopStart = driver.indexOf('for (const [index, wanted] of positions.entries())');
  const loopEnd = driver.indexOf('await stopEncoding(state, playSessionId);', loopStart);
  assert(loopStart > 0 && loopEnd > loopStart, 'the seek loop is where this test thinks it is');
  const loop = driver.slice(loopStart, loopEnd);
  assert(/if \(index > 0\) await sleep\(SEEK_SETTLE_MS\);/.test(loop), 'it waits BEFORE the request');
  // THE TIMER STARTS AFTER THE SETTLE. If `startedAt` were taken before it, every seek would be charged two
  // seconds it did not spend, and — worse — a longer settle could be used to make a slow server look fast by
  // comparison with a ceiling nobody re-derived.
  assert(loop.indexOf('await sleep(SEEK_SETTLE_MS)') < loop.indexOf('const startedAt = now()'),
    'and the per-seek clock starts after it');
  // ONE REQUEST PER SEEK, AND NO LOOP AROUND IT. A retry would turn "each seek produced playable video
  // within 10 s" into "each seek eventually did", which is a different and much weaker claim.
  assertEq((loop.match(/await request\(/g) ?? []).length, 1, 'exactly one request per seek');
  // `while (` rather than the word "while", because the prose above explains WHILE the server is still
  // disposing of the previous job and a word match would fail on its own explanation.
  assert(!/\bwhile\s*\(/.test(loop), 'and no loop wraps it');
});

await test('the measured seek mechanism is recorded, including the spelling that does NOT work', () => {
  // A finding that cost a run: `startTimeTicks` on master.m3u8 does not change the playlist and its
  // propagation into generated segment URLs makes the segment endpoint answer 400. Recording it is what
  // stops the next person reaching for the obvious spelling and concluding the data plane is broken.
  const contract = read('src/core/projection/media-server-dataplane.ts');
  assert(contract.includes('SEEK_IS_A_DIRECT_SEGMENT_REQUEST'), 'the mechanism is named');
  assert(/answers \*\*400\*\*|answers \*\*400/.test(contract) || contract.includes('answers **400**'),
    'and so is what the obvious spelling actually does');
  assert(!read('src/ops/projection-jellyfin-dataplane.ts').includes('startTimeTicks='),
    'and no request is built with it');
});

// ---------------------------------------------------------------------------------------------------------
// The ~50-entry corpus
// ---------------------------------------------------------------------------------------------------------

function corpusFixture(size: number): CorpusExpectation[] {
  return Array.from({ length: size }, (_value, index) => ({
    key: `Projection Corpus ${index} (2026).mp4`,
    sizeBytes: 30_000 + index,
    sha256: createHash('sha256').update(`corpus-${index}`).digest('hex'),
    kind: (index % 5 === 0 ? 'local' : 'http-range') as 'local' | 'http-range',
  }));
}

const seen = (expected: readonly CorpusExpectation[]): CorpusObservation[] =>
  expected.map((entry) => ({ key: entry.key, sizeBytes: entry.sizeBytes, ordinaryFile: true }));

await test('a corpus the server catalogued completely is fully matched', () => {
  const expected = corpusFixture(50);
  const problems = corpusProblems(expected, seen(expected));
  assertEq(problems.matched, 50, 'all fifty published identities were observed');
  assertEq(problems.missing + problems.wrongSize + problems.notOrdinary
    + problems.duplicated + problems.unexpected, 0, 'and nothing else went wrong');
});

await test('FIFTY ARBITRARY ITEMS DO NOT SATISFY A FIFTY-ENTRY CORPUS', () => {
  // The failure an item count cannot see. The library has exactly the right number of things in it, and not
  // one of them is a thing that was published. `matched` is a count of IDENTITIES, which is why it holds.
  const expected = corpusFixture(50);
  const impostors = corpusFixture(50).map((entry) => ({
    key: `Impostor ${entry.key}`, sizeBytes: entry.sizeBytes, ordinaryFile: true,
  }));
  const problems = corpusProblems(expected, impostors);
  assertEq(impostors.length, expected.length, 'the item count is exactly right');
  assertEq(problems.matched, 0, 'and nothing was matched');
  assertEq(problems.missing, 50, 'every published identity is missing');
  assertEq(problems.unexpected, 50, 'and every catalogued item was never published');
});

await test('one entry missing out of fifty is not rounded away', () => {
  const expected = corpusFixture(50);
  const problems = corpusProblems(expected, seen(expected).slice(1));
  assertEq(problems.missing, 1, 'the one missing entry is named as missing');
  assertEq(problems.matched, 49, 'and the match count falls short of the corpus');
});

await test('a right-sized entry the server saw as something other than a file does not count as matched', () => {
  const expected = corpusFixture(50);
  const observed = seen(expected);
  observed[7] = { ...(observed[7] as CorpusObservation), ordinaryFile: false };
  const problems = corpusProblems(expected, observed);
  assertEq(problems.notOrdinary, 1, 'a .strm placeholder or a remote media source is reported');
  assertEq(problems.matched, 49, 'and it does not count toward the corpus');
});

await test('a wrong size, and a duplicated entry, are each reported', () => {
  const expected = corpusFixture(50);
  const resized = seen(expected);
  resized[3] = { ...(resized[3] as CorpusObservation), sizeBytes: 1 };
  assertEq(corpusProblems(expected, resized).wrongSize, 1, 'a size the control plane did not publish');
  const duplicated = [...seen(expected), seen(expected)[9] as CorpusObservation];
  assertEq(corpusProblems(expected, duplicated).duplicated, 1, 'two items for one published file');
});

await test('A CORPUS WITH TWO IDENTICAL ENTRIES IS REFUSED BEFORE A SERVER IS INVOLVED', () => {
  // Two byte-identical entries make every digest comparison in the gate decorative: a read that returned the
  // wrong entry would still match its digest. A fifty-entry corpus is generated by a loop, and a loop is
  // exactly the thing that could quietly start emitting identical parameters.
  assertEq(corpusSelfProblems(corpusFixture(50)).length, 0, 'a well-formed corpus has nothing wrong with it');
  const collided = corpusFixture(50);
  collided[11] = { ...(collided[11] as CorpusExpectation), sha256: (collided[0] as CorpusExpectation).sha256 };
  assert(corpusSelfProblems(collided).some((p) => p.includes('distinct digests')),
    'and two entries with the same bytes are refused');
  const empty = corpusFixture(50);
  empty[2] = { ...(empty[2] as CorpusExpectation), sizeBytes: 0 };
  assert(corpusSelfProblems(empty).some((p) => p.includes('no bytes')), 'as is an entry with no bytes');
});

// ---------------------------------------------------------------------------------------------------------
// The wiring the five-minute gates depend on
// ---------------------------------------------------------------------------------------------------------

await test('the gate generates a ~50-entry corpus and ONE long source, not fifty long ones', () => {
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(/CORPUS_COUNT=\d+/.test(gate), 'the corpus size is a named constant');
  const count = Number(/CORPUS_COUNT=(\d+)/.exec(gate)?.[1]);
  const local = Number(/CORPUS_LOCAL=(\d+)/.exec(gate)?.[1]);
  assert(count + 3 >= 50, `the corpus plus the anchors and the soak source reaches ~50: ${count} + 3`);
  assert(local >= 1 && local < count, 'with clearly identified local controls among the remote entries');
  assert(gate.includes('size=128x96'), 'the corpus entries are tiny');
  assert(/SOAK_SECONDS=(\d+)/.test(gate), 'and the soak source has its own duration');
  assert(Number(/SOAK_SECONDS=(\d+)/.exec(gate)?.[1]) > 300, 'which is longer than five minutes');
  assert(gate.includes('-minrate') && gate.includes('-maxrate'), 'at a pinned low bitrate');
  assert(!gate.includes('curl ') && !gate.includes('wget http'), 'and nothing is downloaded');
});

await test('the gate proves the soak source is long by DECODING it, not by trusting the encoder argument', () => {
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(/SOAK_DURATION="\$\(ffprobe_run/.test(gate), 'the duration is read back from the artifact');
  assert(/SOAK_DURATION_INT.*-gt 300/.test(gate) || /-gt 300/.test(gate),
    'and a source that came out short fails rather than being played for as long as it lasts');
});

await test('the five-minute gates are wired into the gate script and consume paced, not drained', () => {
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  for (const phase of ['drive paced-play ', 'drive media-seeks ', 'drive transcode-soak ',
    'drive transcode-soak-verify ', 'drive seek-verify ', 'drive corpus-check ']) {
    assert(gate.includes(phase), `${phase.trim()} runs`);
  }
  // COMMENTS STRIPPED FIRST. The prose explaining why a five-minute sleep is not a five-minute play contains
  // the construct it is warning about, and it must not be what fails a check on whether one is present —
  // which would leave exactly two ways out, deleting the explanation or weakening the check.
  const driver = readCode('src/ops/projection-jellyfin-dataplane.ts');
  assert(driver.includes("'-re', '-i'"), 'the consumer reads at the media\'s own rate');
  assert(driver.includes("'-progress', 'pipe:1'"), 'and reports its decoder position');
  assert(!/sleep\(\s*3\d\d_?\d\d\d/.test(driver), 'and nothing sleeps for five minutes instead of playing');
});

await test('no wait introduced by the five-minute gates is unbounded', () => {
  for (const budget of [MEDIA_SERVER_DEADLINES_MS.PACED_PLAY, MEDIA_SERVER_DEADLINES_MS.TRANSCODE_SOAK,
    MEDIA_SERVER_DEADLINES_MS.SEEK]) {
    assert(Number.isFinite(budget) && budget > 0, 'every new deadline is a finite ceiling');
  }
  // ...and each is above the thing it bounds, or it would fail a correct run rather than a hung one.
  assert(MEDIA_SERVER_DEADLINES_MS.PACED_PLAY > MEDIA_SERVER_SOAK.MIN_DIRECT_PLAY_SECONDS * 1_000,
    'the paced-play ceiling is above the five minutes it is supposed to allow');
  assert(MEDIA_SERVER_DEADLINES_MS.TRANSCODE_SOAK > MEDIA_SERVER_SOAK.MIN_TRANSCODE_SECONDS * 1_000,
    'and so is the transcode ceiling');
  assert(MEDIA_SERVER_DEADLINES_MS.SEEK >= MEDIA_SERVER_SOAK.MAX_SEEK_SECONDS * 1_000,
    'and the per-seek ceiling is above the ten seconds a seek is allowed');
});

await test('"the generation did not move" is compared against the generation, not against a literal', () => {
  // THE DEFECT THIS PINS. The kill step asserted `pointerSequence = "2"`, which was correct while the gate
  // published exactly two generations before it. Adding the ~50-entry corpus made it three, and the gate
  // failed with "the published generation moved because a daemon died" while the status it had just printed
  // showed a database and a pointer in perfect agreement. A constant that counts how many times an earlier
  // step ran is wrong the moment a step is added — and this one's failure message accused the product of a
  // defect it did not have, which is the most expensive kind of false alarm a gate can raise.
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(gate.includes('SEQUENCE_BEFORE_KILL="$(field pointerSequence'),
    'the sequence is recorded before the kill');
  assert(gate.includes('test "$SEQUENCE_AFTER_KILL" = "$SEQUENCE_BEFORE_KILL"'),
    'and the assertion compares the two, so it cannot go stale behind a new publish');
  assert(!/pointerSequence < "\$WORK\/out\/status-after-kill\.json"\)" = "\d"/.test(gate),
    'and no literal sequence is left in it');
});

await test('a five-minute consumer cannot be left running by a failing gate', () => {
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  assert(/PLAY_CONTAINER="projection-jf-play/.test(gate), 'the paced consumer is named');
  const cleanup = gate.slice(gate.indexOf('cleanup() {'), gate.indexOf('trap cleanup EXIT'));
  assert(cleanup.includes('"$PLAY_CONTAINER"'), 'and the cleanup trap removes it');
  const driver = read('src/ops/projection-jellyfin-dataplane.ts');
  assert(driver.includes("spawn('docker', ['rm', '-f', opts.containerName]"),
    'and the driver kills it by name when its own deadline fires, since killing `docker run` need not');
});

await test('the small-object byte budget names its own denominator instead of relaxing the big one', () => {
  // THE FAILURE THIS PREVENTS. Folding a corpus of tiny entries into the fraction budget would let the large
  // entries pay for the small ones, and a regression in the large read path — the one the product's whole
  // argument rests on — would disappear into the average.
  assert(MEDIA_SERVER_BUDGETS.MAX_SCAN_BYTE_FRACTION < 1,
    'an object big enough to have a middle and a tail is identified from a fraction of itself');
  assert(MEDIA_SERVER_BUDGETS.MAX_SMALL_OBJECT_SCAN_BYTE_MULTIPLIER >= 1,
    'and one below the single-probe threshold is identified by reading it, because its window IS all of it');
  const cli = read('src/ops/projection-jellyfin-dataplane-cli.ts');
  assert(cli.includes('small-bytes'), 'the two denominators are separate flags');
  assert(/denominators: \$\{remoteBytes\}/.test(cli), 'and the report names both');
});

await test('a health probe does not spend the budget it is about to measure', () => {
  // THE DEFECT THIS CLOSES. The endpoint readiness loop used to send a ranged GET for the remote object, up
  // to a hundred and twenty times, before a single assertion had been made — real object reads, counted
  // against the very amplification budgets the gate exists to hold.
  const gate = read('deploy/projection-jellyfin-dataplane-gate.sh');
  const readiness = gate.slice(gate.indexOf('waiting for the endpoint to come up'),
    gate.indexOf('ENDPOINT_SIZE='));
  assert(readiness.includes('alive.sh') && readiness.includes('/counters'),
    'liveness polls the uncounted control surface');
  const pollLoop = readiness.slice(readiness.indexOf('for _ in $(seq'), readiness.indexOf('test "$ready"'));
  assert(!pollLoop.includes('probe.sh'), 'and no ranged object read happens inside a retry loop');
  assert(readiness.includes('probe.sh'), 'the range semantics are still checked, once, as evidence');
  const provider = read('projectiond/internal/fakeprovider/fakeprovider.go');
  assert(/handleCounters serves the snapshot. IT IS NOT COUNTED/.test(provider),
    'and the control surface itself is not counted');
});

await test('the corpus is registered through the same write path, in one process rather than one per row', () => {
  const cli = read('src/ops/projection-register-cli.ts');
  const batch = cli.slice(cli.indexOf("case 'batch'"), cli.indexOf('default:'));
  assert(batch.includes('registerVersion(db'), 'batch calls the ordinary version registration');
  assert(batch.includes('registerEntry(db'), 'and the ordinary entry registration');
  // SQL, not the word "insert" in the comment saying there is none.
  const batchCode = batch.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert(!/\bINSERT\s+INTO\b|\bCOPY\s+\w+\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b/i.test(batchCode),
    'there is no second write path hidden inside it');
  // THE ONLY SQL IT MAY ISSUE ITSELF IS TRANSACTION CONTROL. Anything else would be a write the registry did
  // not validate — which is the whole reason this command routes through `registerVersion`/`registerEntry`.
  const statements = [...batchCode.matchAll(/db\.query\('([^']+)'/g)].map((match) => match[1]);
  assert(statements.length > 0, 'it opens a transaction');
  for (const statement of statements) {
    assert(['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement as string),
      `the only SQL the batch issues is transaction control, not ${statement}`);
  }
  // AND IT IS ACTUALLY A TRANSACTION: a bad later row must not leave the earlier ones registered, because a
  // half-registered corpus is worse than none — the next publish mints a generation out of whatever landed.
  for (const verb of ['BEGIN', 'COMMIT', 'ROLLBACK']) {
    assert(statements.includes(verb), `it issues ${verb}`);
  }
  assert(/catch \(error\)[\s\S]*ROLLBACK[\s\S]*throw error/.test(batchCode),
    'and a refusal rolls back and is re-thrown rather than replaced');
  assert(read('deploy/projection-jellyfin-dataplane-gate.sh').includes('register batch --file'),
    'and the gate uses it for the corpus');
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
