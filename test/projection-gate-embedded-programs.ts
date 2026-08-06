import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';

// Projection Phase 1 — the gates' own embedded programs, EXECUTED.
//
// WHY THIS SUITE EXISTS, AND WHY IT IS A SUITE RATHER THAN A SECTION. Every measurement the Phase 1 gates
// make is produced by a small program written into the run directory as a heredoc. There are 131 of them
// across `deploy/projection-*gate*.sh`, and section 6.11 of the acceptance plan records what happened the
// first time anyone RAN one instead of string-matching the shell around it: six defects, three of which made
// a gate's own success unfailable. The programs covered here are shared BETWEEN gates — `leakcheck.sh` is
// byte-identical in five, `cacheceiling.cjs`, `published.cjs` and `counters.cjs` in three, `scan.cjs` in
// three — so a per-gate suite would have to hold each of them five times or hold it once in an arbitrary
// place. Each test below extracts the EXACT shipped bytes and runs them against fixtures.
//
// NOTHING HERE RESTATES THE PROGRAM'S LOGIC. A test that recomputed the ceiling would pass against a program
// that computed it the same wrong way, which is precisely the failure the string-matching tests had.

const HERE = fileURLToPath(new URL('.', import.meta.url));
const root = join(HERE, '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1; console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1; failures.push([name, error]); console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1; console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1; failures.push([name, error]); console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

// ---------------------------------------------------------------------------------------------------------
// Extraction — the exact bytes the gate writes at run time
// ---------------------------------------------------------------------------------------------------------

/** The body of `cat > "$WORK/<name>" <<'DELIM' … DELIM`, verbatim. */
function heredoc(gate: string, name: string): string {
  const text = read(gate);
  const opener = `cat > "$WORK/${name}" <<'`;
  const start = text.indexOf(opener);
  assert(start !== -1, `${gate} does not write ${name}`);
  const delimiterEnd = text.indexOf("'", start + opener.length);
  const delimiter = text.slice(start + opener.length, delimiterEnd);
  const bodyStart = text.indexOf('\n', delimiterEnd) + 1;
  const bodyEnd = text.indexOf(`\n${delimiter}\n`, bodyStart);
  assert(bodyEnd !== -1, `${gate} never closes the heredoc for ${name}`);
  return text.slice(bodyStart, bodyEnd);
}

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pjd-embedded-'));
  scratchDirs.push(dir);
  return dir;
}

/** That program on disk, ready to run, plus the directory it sits in. */
function extract(gate: string, name: string): { dir: string; script: string } {
  const dir = scratch();
  const script = join(dir, name.replace(/^.*\//, ''));
  writeFileSync(script, `${heredoc(gate, name)}\n`, 'utf8');
  return { dir, script };
}

interface Run { readonly code: number; readonly out: string }

function runNode(script: string, args: readonly string[], cwd?: string, asUid?: number): Run {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', cwd, ...(asUid === undefined ? {} : { uid: asUid, gid: asUid }),
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * The uid the "a file the scan could not open" cases must run as, or `undefined` if they cannot run here.
 *
 * ROOT READS EVERYTHING, so on the tranche-closing host — where these gates are run as root — a mode-000
 * fixture proves nothing and the case would pass against the unfixed program just as readily. Returning
 * early there would leave the sharpest measurement in this suite skipped on the only machine that closes
 * anything, so the child is spawned as an unprivileged uid instead. Windows carries no POSIX mode and cannot
 * express the fixture at all; declining to judge a platform that cannot run the check is §6.0's own rule.
 */
const UNPRIVILEGED_UID = ((): number | undefined => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return undefined;
  const uid = process.getuid();
  return uid === 0 ? 65534 : uid;
})();

/** Make a scratch directory and the named files reachable by a uid that did not create them. */
function openTo(dir: string, ...files: readonly string[]): void {
  chmodSync(dir, 0o755);
  for (const file of files) chmodSync(file, 0o644);
}

/**
 * The same, but without blocking this process's event loop.
 *
 * `counters.cjs` FETCHES, and the only listener it can be pointed at offline is one this suite stands up
 * itself. `spawnSync` would hold the loop that has to answer it, so the child would abort on its own timeout
 * and the test would report a refusal the program did not make — a harness deadlock wearing the shape of the
 * defect under test.
 */
async function runNodeAsync(script: string, args: readonly string[]): Promise<Run> {
  return new Promise<Run>((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

/**
 * `bash` is asked whether it exists rather than assumed, and every path handed to it is RELATIVE.
 *
 * `test/projection-jellyfin-dataplane.ts` pays for a three-layer path-translation apparatus because it must
 * hand the wrapper an absolute path. Nothing here needs one: the fixtures and the script live in the same
 * scratch directory, which is passed as `cwd` by Node and never crosses the shell boundary as a string. That
 * removes the whole class of Git-Bash-versus-WSL spelling defects from this suite.
 */
const bashAvailable = spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8' }).status === 0;

function runBash(script: string, args: readonly string[], cwd: string, asUid?: number): Run {
  const result = spawnSync('bash', [script.replace(/^.*[\\/]/, './'), ...args], {
    encoding: 'utf8', cwd, ...(asUid === undefined ? {} : { uid: asUid, gid: asUid }),
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------------------------------------
// `leakcheck.sh` — five gates, fifteen call sites, and the only measurement behind
// "no provider access material reached disk"
// ---------------------------------------------------------------------------------------------------------

const LEAK_GATES = [
  'deploy/projection-jellyfin-dataplane-gate.sh',
  'deploy/projection-emby-dataplane-gate.sh',
  'deploy/projection-plex-dataplane-gate.sh',
  'deploy/projection-three-server-concurrency-gate.sh',
  'deploy/projection-rclone-comparison-gate.sh',
] as const;

const SECRET = 'PJDLEASE0123456789abcdef0123456789ab';

/** A scratch directory holding the shipped helper, a needle list and a scan root. */
function leakFixture(gate: string): { dir: string; script: string; scan: string } {
  const { dir, script } = extract(gate, 'out/leakcheck.sh');
  writeFileSync(join(dir, 'needles.txt'), `${SECRET}\nfakerange\n`, 'utf8');
  mkdirSync(join(dir, 'scan'));
  return { dir, script, scan: './scan' };
}

test('THE FIVE COPIES OF leakcheck.sh ARE ONE PROGRAM, so one correction cannot fix four of them', () => {
  const bodies = LEAK_GATES.map((gate) => heredoc(gate, 'out/leakcheck.sh'));
  for (const [index, body] of bodies.entries()) {
    assertEq(body, bodies[0] as string,
      `${LEAK_GATES[index]} carries a leakcheck.sh that differs from the other four`);
  }
});

test('A SECRET IN A PLAIN FILE IS FOUND, which is the control every case below is measured against', () => {
  if (!bashAvailable) throw new Error('bash is required to execute the shipped helper');
  const { dir, script, scan } = leakFixture(LEAK_GATES[0]);
  writeFileSync(join(dir, 'scan', 'plain.txt'), `hello ${SECRET} world\n`, 'utf8');
  const run = runBash(script, ['the control', 'needles.txt', '1', scan], dir);
  assert(run.code !== 0, `a leak that is there must fail the check: ${run.out}`);
  assert(/1 hit\(s\)/.test(run.out), `and be counted: ${run.out}`);
});

test('A CLEAN ROOT PASSES AND REPORTS WHAT IT LOOKED AT, so a zero is never a bare zero', () => {
  if (!bashAvailable) throw new Error('bash is required to execute the shipped helper');
  const { dir, script, scan } = leakFixture(LEAK_GATES[0]);
  writeFileSync(join(dir, 'scan', 'ok.txt'), 'nothing of interest\n', 'utf8');
  const run = runBash(script, ['the control', 'needles.txt', '1', scan], dir);
  assertEq(run.code, 0, `a clean root passes: ${run.out}`);
  assert(/1 file\(s\) examined for 2 needle\(s\), 0 hit\(s\)/.test(run.out),
    `and the examined count is in the output, so a scan of nothing is visible: ${run.out}`);
});

test('A SCAN ROOT THAT DOES NOT EXIST IS REFUSED, where it used to be reported as clean', () => {
  // THE DEFECT, MEASURED. `grep -rlF "$pattern" /scan 2>/dev/null` sends a missing root down the same path
  // as a clean miss: no output, so no leak, so exit 0. Every verdict about persisted access material in five
  // gates was one renamed directory away from being vacuous, with nothing in the output saying so.
  if (!bashAvailable) throw new Error('bash is required to execute the shipped helper');
  for (const gate of LEAK_GATES) {
    const { dir, script } = leakFixture(gate);
    const run = runBash(script, ['the missing root', 'needles.txt', '1', './not-here'], dir);
    assert(run.code !== 0, `${gate}: a root that does not exist must not read as clean: ${run.out}`);
    assert(/the search never ran/.test(run.out), `${gate}: and must say so: ${run.out}`);
  }
});

test('A FILE THE SEARCH COULD NOT OPEN IS REFUSED, where the secret in it used to be invisible', () => {
  // MEASURED IN THE GATE'S OWN PINNED IMAGE: one readable file with nothing in it and one mode-000 file with
  // the secret in plain text produced `exit 0` and no output at all. The readable file was enough to make the
  // scan look like a scan.
  if (!bashAvailable) throw new Error('bash is required to execute the shipped helper');
  if (UNPRIVILEGED_UID === undefined) return;
  for (const gate of LEAK_GATES) {
    const { dir, script, scan } = leakFixture(gate);
    writeFileSync(join(dir, 'scan', 'ok.txt'), 'nothing of interest\n', 'utf8');
    writeFileSync(join(dir, 'scan', 'locked.txt'), `${SECRET}\n`, 'utf8');
    openTo(dir, script, join(dir, 'needles.txt'), join(dir, 'scan', 'ok.txt'));
    chmodSync(join(dir, 'scan'), 0o755);
    chmodSync(join(dir, 'scan', 'locked.txt'), 0o000);
    const run = runBash(script, ['the unreadable file', 'needles.txt', '1', scan], dir, UNPRIVILEGED_UID);
    assert(run.code !== 0, `${gate}: a file the scan could not open must not read as covered: ${run.out}`);
    assert(/could not be searched for across the whole root/.test(run.out),
      `${gate}: and must say which needle it could not finish: ${run.out}`);
    assert(!run.out.includes(SECRET), `${gate}: and the refusal names no needle: ${run.out}`);
  }
});

test('AN EMPTY NEEDLE LIST AND AN EMPTY NEEDLE ARE BOTH REFUSED', () => {
  if (!bashAvailable) throw new Error('bash is required to execute the shipped helper');
  const { dir, script, scan } = leakFixture(LEAK_GATES[0]);
  writeFileSync(join(dir, 'scan', 'ok.txt'), 'nothing of interest\n', 'utf8');

  writeFileSync(join(dir, 'empty.txt'), '', 'utf8');
  const empty = runBash(script, ['no needles', 'empty.txt', '1', scan], dir);
  assert(empty.code !== 0, `a search for nothing is not a search: ${empty.out}`);

  // AN EMPTY LINE MATCHES EVERY FILE, so it would report a leak in a clean tree — a false positive is not a
  // safe failure here, it is a gate nobody can run.
  writeFileSync(join(dir, 'blank.txt'), `${SECRET}\n\nfakerange\n`, 'utf8');
  const blank = runBash(script, ['a blank needle', 'blank.txt', '1', scan], dir);
  assert(blank.code !== 0 && /needle 2 of 3 is empty/.test(blank.out),
    `a blank line in the needle list is named rather than searched for: ${blank.out}`);
});

test('A NEEDLE LIST WITH NO TRAILING NEWLINE IS REFUSED, where it used to run ZERO searches and pass', () => {
  // THE DEFECT THIS CORRECTION ALMOST SHIPPED WITH, found by review of its own diff and reproduced by
  // running it. `wc -l` counts TERMINATORS and `read` drops an unterminated final record, so a nonempty
  // one-needle file with no trailing newline counted ZERO needles, ran ZERO searches, and then agreed with
  // itself at zero — `0 needles read of 0 expected`, `0 hits`, exit 0. Measured against the same secret in
  // the same tree the terminated list finds it in: "1 file(s) examined for 0 needle(s), 0 hit(s)", clean.
  // A malformed needle list is exactly the thing a caller gets wrong, and it produced the friendliest
  // possible answer.
  if (!bashAvailable) throw new Error('bash is required to execute the shipped helper');
  for (const gate of LEAK_GATES) {
    const { dir, script, scan } = leakFixture(gate);
    writeFileSync(join(dir, 'scan', 'plain.txt'), `leaked ${SECRET} here\n`, 'utf8');

    // The control: the same needle, terminated, finds it.
    writeFileSync(join(dir, 'terminated.txt'), `${SECRET}\n`, 'utf8');
    const control = runBash(script, ['terminated', 'terminated.txt', '1', scan], dir);
    assert(control.code !== 0 && /1 needle\(s\), 1 hit\(s\)/.test(control.out),
      `${gate}: the terminated list finds the leak: ${control.out}`);

    for (const [what, body] of [
      ['one unterminated needle', SECRET],
      ['a last needle left unterminated', `fakerange\n${SECRET}`],
    ] as const) {
      writeFileSync(join(dir, 'needle.txt'), body, 'utf8');
      const run = runBash(script, [what, 'needle.txt', '1', scan], dir);
      assert(run.code !== 0, `${gate}: ${what} must not pass over a tree holding the secret: ${run.out}`);
      assert(/does not end in a newline/.test(run.out), `${gate}: ${what} must say why: ${run.out}`);
      assert(!/0 needle\(s\)/.test(run.out), `${gate}: ${what} still reported a search over no needles`);
    }
  }
});

test('EVERY NEEDLE FILE THE GATES WRITE IS TERMINATED, so the refusal above is a guard and not a trap', () => {
  // `printf '%s\n' a b c` terminates EVERY record including the last, which is why the rule above cannot
  // fail a correct run. Asserted at the writer, because that is the thing a later edit changes.
  for (const gate of LEAK_GATES) {
    const text = read(gate);
    const writers = text.split('> "$WORK/out/leak-needles').length - 1;
    assert(writers >= 3, `${gate}: fewer needle files are written than there are call sites`);
    for (const line of text.split('\n')) {
      if (!line.includes('leak-needles') || !line.includes('printf')) continue;
      assert(line.includes("printf '%s\\n'"),
        `${gate}: a needle file is written by something other than a newline-terminated printf: ${line}`);
    }
  }
});

test('THE MINIMUM FILE COUNT IS THE CALLER\'S, and a root below it cannot pass', () => {
  if (!bashAvailable) throw new Error('bash is required to execute the shipped helper');
  const { dir, script, scan } = leakFixture(LEAK_GATES[0]);
  const required = runBash(script, ['an empty root', 'needles.txt', '1', scan], dir);
  assert(required.code !== 0 && /against a required 1/.test(required.out),
    `an empty root fails where the caller says it cannot be empty: ${required.out}`);
  // ...AND IS RECORDED RATHER THAN REQUIRED WHERE THE CALLER SAYS SO. The rclone client is entitled to write
  // nothing into its own cache, and inventing a floor there would be fitting a threshold to an expectation.
  const recorded = runBash(script, ['an empty root', 'needles.txt', '0', scan], dir);
  assertEq(recorded.code, 0, `and passes where the caller allows it: ${recorded.out}`);
  assert(/0 file\(s\) examined/.test(recorded.out), `while still saying it looked at nothing: ${recorded.out}`);
});

test('NO NEEDLE AND NO PATH REACHES THE OUTPUT, on the failure path as well as the clean one', () => {
  // Section 7 of the acceptance plan: counts, digests and gate ids only. The old helper printed
  // `LEAK: '<the secret>' appears under <label>` and then up to five matched file paths.
  if (!bashAvailable) throw new Error('bash is required to execute the shipped helper');
  const { dir, script, scan } = leakFixture(LEAK_GATES[0]);
  writeFileSync(join(dir, 'scan', 'secret-bearing-name.txt'), `hello ${SECRET} world\n`, 'utf8');
  const run = runBash(script, ['the leak', 'needles.txt', '1', scan], dir);
  assert(run.code !== 0, 'the leak is still found');
  assert(!run.out.includes(SECRET), `the needle must not reach the output: ${run.out}`);
  assert(!run.out.includes('secret-bearing-name'), `nor must the file it was found in: ${run.out}`);
  assert(/needle 1 of 2/.test(run.out), `the needle is named by index instead: ${run.out}`);
});

test('NO CALL SITE PUTS A NEEDLE IN ARGV, which is where `docker inspect` reads it from', () => {
  // MEASURED: `docker inspect -f '{{json .Config.Cmd}}'` on a container started the old way returned
  // ["sh","/out/leakcheck.sh","the mount client cache","PJDDAV…","Authorization:"] — the value verbatim, for
  // the life of the container, and in the host's process table besides. The rclone gate's own comment says
  // its token "is in no argv, no container inspect output and no shell history", and the only place it ever
  // reached argv was the check written to prove it had not leaked.
  for (const gate of LEAK_GATES) {
    const text = read(gate);
    const invocations = text.split('leakcheck.sh "').slice(1);
    assert(invocations.length >= 3, `${gate}: fewer leakcheck invocations than expected`);
    for (const invocation of invocations) {
      const line = invocation.slice(0, invocation.indexOf('\n'));
      assert(!line.includes('$LEASE_MARKER') && !line.includes('$DAV_TOKEN'),
        `${gate}: a secret is still passed to leakcheck.sh as an argument: ${line}`);
      assert(/leak-needles-[a-z]+\.txt/.test(line),
        `${gate}: the needles do not arrive as a file path: ${line}`);
    }
    // AND THE FILE IS REALLY BUILT FROM THE SECRET, or the needles are a list of markers and the search has
    // lost its subject.
    const secretVariable = gate.includes('rclone') ? '$DAV_TOKEN' : '$LEASE_MARKER';
    assert(new RegExp(`printf '%s\\\\n' "\\${secretVariable}"`).test(text),
      `${gate}: no needle file is built from ${secretVariable}`);
    assert(text.includes(`\${#${secretVariable.slice(1)}}" -ge 8`),
      `${gate}: the minted secret is not asserted long enough for a search for it to be decisive`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// `cacheceiling.cjs` and `published.cjs` — section 5.1's budget arithmetic
// ---------------------------------------------------------------------------------------------------------

const CEILING_GATES = [
  'deploy/projection-jellyfin-dataplane-gate.sh',
  'deploy/projection-emby-dataplane-gate.sh',
  'deploy/projection-plex-dataplane-gate.sh',
] as const;

/** A corpus in the shape `expect.cjs` writes: 47 tiny entries, two over the probe threshold, a large one. */
function corpus(): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (let index = 1; index <= 47; index += 1) {
    entries.push({ key: `corpus-${index}`, sizeBytes: 30_000 + index, kind: 'http-range' });
  }
  entries.push({ key: 'local', sizeBytes: 3_670_016, kind: 'local' });
  entries.push({ key: 'remote', sizeBytes: 3_670_017, kind: 'http-range' });
  entries.push({ key: 'large', sizeBytes: 105_000_000, kind: 'http-range' });
  entries.push({ key: 'soak', sizeBytes: 8_594_275, kind: 'http-range' });
  return entries;
}

function withCorpus(gate: string, name: string, entries: unknown): Run {
  const { dir, script } = extract(gate, name);
  const file = join(dir, 'expected.json');
  writeFileSync(file, JSON.stringify(entries), 'utf8');
  return runNode(script, [file]);
}

test('THE CEILING IS THE CONTRACT\'S OWN PROBE PLAN, evaluated rather than restated', () => {
  // The two numbers this program hard-codes are the contract's, and the test compares them to the contract
  // rather than to a literal: a whole-file probe below the threshold, three windows above it.
  const contract = read('src/core/projection/manifest-v1.ts');
  assert(contract.includes('WINDOW_BYTES: 1_048_576'), 'the probe window is a megabyte in the contract');
  assert(contract.includes('SINGLE_PROBE_BELOW_BYTES: 3 * 1_048_576'), 'and the threshold is three of them');
  for (const gate of CEILING_GATES) {
    const body = heredoc(gate, 'cacheceiling.cjs');
    assert(body.includes('const WINDOW = 1048576;'), `${gate}: the window is the contract's`);
    assert(body.includes('const SINGLE_PROBE_BELOW = 3 * WINDOW;'), `${gate}: and so is the threshold`);
  }
  // AND IT COMPUTES SOMETHING, which a program that refused everything would also satisfy.
  const run = withCorpus(CEILING_GATES[0], 'cacheceiling.cjs', corpus());
  assertEq(run.code, 0, `a well-formed corpus produces a ceiling: ${run.out}`);
  assert(Number.isInteger(Number(run.out.trim())) && Number(run.out.trim()) > 0,
    `and it is a positive integer: ${run.out}`);
});

test('A MISSING sizeBytes NO LONGER RAISES THE CEILING, which is the direction it must never move', () => {
  // MEASURED AGAINST THE SHIPPED BYTES: `undefined < SINGLE_PROBE_BELOW` is false, so an entry carrying no
  // size fell through to the three-window branch and bought itself 3 MiB of headroom. On a 51-entry corpus
  // with one size removed the ceiling went from 25,185,364 to 29,858,950 — silently, exit 0. A budget that
  // LOOSENS when its input degrades is exactly what section 5.1 exists to prevent.
  const good = withCorpus(CEILING_GATES[0], 'cacheceiling.cjs', corpus());
  const honest = Number(good.out.trim());
  for (const gate of CEILING_GATES) {
    const broken = corpus();
    delete (broken[3] as Record<string, unknown>).sizeBytes;
    const run = withCorpus(gate, 'cacheceiling.cjs', broken);
    assert(run.code !== 0,
      `${gate}: an entry with no size must be refused, not absorbed — it answered ${run.out.trim()} `
      + `against an honest ${honest}`);
    assert(Number(run.out.trim()) !== honest, `${gate}: and must print no ceiling at all`);
  }
});

test('A NON-INTEGER, NEGATIVE, UNSAFE OR ABSENT CORPUS IS REFUSED BY BOTH PROGRAMS', () => {
  // `Number.isInteger` IS NOT THE CHECK, and the first version of this correction used it. It answers true
  // for 2**53 + 2 and for every integer above it, where `+` has already stopped being exact — so a corpus
  // could carry sizes that each pass while the total is off by an arbitrary amount, in the arithmetic that
  // decides section 5.1's budgets. `Number.isSafeInteger` is what `windowProblems` in `lease-gates.ts`
  // already holds the lease counters to.
  const unsafe = Number.MAX_SAFE_INTEGER + 2;
  const cases: Array<[string, unknown]> = [
    ['a string size', corpus().map((entry, index) => (index === 3 ? { ...entry, sizeBytes: '30003' } : entry))],
    ['a null size', corpus().map((entry, index) => (index === 3 ? { ...entry, sizeBytes: null } : entry))],
    ['a negative size', corpus().map((entry, index) => (index === 3 ? { ...entry, sizeBytes: -1 } : entry))],
    ['a fractional size', corpus().map((entry, index) => (index === 3 ? { ...entry, sizeBytes: 1.5 } : entry))],
    ['an unsafe integer size',
      corpus().map((entry, index) => (index === 3 ? { ...entry, sizeBytes: unsafe } : entry))],
    ['an infinite size',
      corpus().map((entry, index) => (index === 3 ? { ...entry, sizeBytes: 1e400 } : entry))],
    ['an empty corpus', []],
    ['a corpus that is not a list', { entries: corpus() }],
  ];
  for (const gate of CEILING_GATES) {
    for (const [what, entries] of cases) {
      for (const program of ['cacheceiling.cjs', 'published.cjs'] as const) {
        const run = withCorpus(gate, program, entries);
        assert(run.code !== 0, `${gate}: ${program} accepted ${what}: ${run.out}`);
      }
    }
  }
});

test('INDIVIDUALLY SAFE SIZES THAT SUM PAST THE BOUNDARY ARE REFUSED, not silently approximated', () => {
  // Every entry below passes `Number.isSafeInteger` on its own; the RUNNING total does not. Without the
  // cumulative check `published.cjs` prints a number JavaScript cannot represent exactly, and
  // `test "$CACHE_BYTES" -lt "$PUBLISHED_BYTES"` then compares the cache against a denominator nobody
  // computed — the same shape as the concatenation defect, arrived at by arithmetic instead of by `+`.
  const half = Math.floor(Number.MAX_SAFE_INTEGER / 2);
  const summing = [
    { key: 'a', sizeBytes: half, kind: 'http-range' },
    { key: 'b', sizeBytes: half, kind: 'http-range' },
    { key: 'c', sizeBytes: half, kind: 'http-range' },
  ];
  for (const entry of summing) {
    assert(Number.isSafeInteger(entry.sizeBytes), 'each size is individually safe, which is the point');
  }
  for (const gate of CEILING_GATES) {
    const run = withCorpus(gate, 'published.cjs', summing);
    assert(run.code !== 0, `${gate}: published.cjs summed past the exact-integer boundary: ${run.out}`);
    assert(/exact-integer boundary/.test(run.out), `${gate}: and did not say why: ${run.out}`);
  }

  // AND cacheceiling.cjs CANNOT REACH THE BOUNDARY FROM ITS INPUT, WHICH IS WORTH STATING RATHER THAN
  // ASSUMING. Its per-entry contribution is capped at three windows, so the total is bounded by the ENTRY
  // COUNT and would need about three billion of them. The guard is kept because that cap is a property of
  // the program, and a program's own invariant is exactly the thing a later edit removes silently.
  const ceiling = Number(withCorpus(CEILING_GATES[0], 'cacheceiling.cjs', summing).out.trim());
  assert(Number.isSafeInteger(ceiling) && ceiling > 0,
    'three entries above the probe threshold cost three windows each, whatever their size');
  assert(ceiling < 3 * 3 * 1_048_576 * 1.5 + 4 * 1_048_576 + 1,
    `the cap really is the window plan rather than the size: ${ceiling}`);
});

test('published.cjs NO LONGER CONCATENATES, which made its denominator unfailable', () => {
  // MEASURED: with the LAST entry's size arriving as a string, `total + entry.sizeBytes` concatenated and a
  // 122,345,436-byte corpus reported 87511611050000008594275 — a syntactically valid integer `test -lt`
  // accepts without complaint, about 10^15 times the truth. `test "$CACHE_BYTES" -lt "$PUBLISHED_BYTES"`
  // could not then fail whatever the cache held.
  const honest = Number(withCorpus(CEILING_GATES[0], 'published.cjs', corpus()).out.trim());
  assertEq(honest, corpus().reduce((total, entry) => total + (entry.sizeBytes as number), 0),
    'the honest total is the sum of the corpus');
  for (const gate of CEILING_GATES) {
    const tail = corpus();
    (tail[tail.length - 1] as Record<string, unknown>).sizeBytes = '8594275';
    const run = withCorpus(gate, 'published.cjs', tail);
    assert(run.code !== 0, `${gate}: a string size must be refused: ${run.out}`);
    assert(!/\d{20}/.test(run.out), `${gate}: and no concatenated total may be printed: ${run.out}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// `counters.cjs` — the surface every section 5 budget is differenced from
// ---------------------------------------------------------------------------------------------------------

await testAsync('AN ABSENT COUNTER IS REFUSED RATHER THAN PRINTED AS ZERO, measured against a real listener',
  async () => {
    // `?? 0` made "the endpoint carries no such field" and "it did not happen" the same answer, on the
    // surface every section 5 budget is differenced from. Every name the gates ask for exists at the
    // endpoint today — asserted below — so this was latent rather than live; `windowProblems` in
    // `lease-gates.ts` already refuses the same absence on the lease path, and this is that rule applied
    // where the number is fetched rather than where it is compared.
    const provider = read('projectiond/internal/fakeprovider/fakeprovider.go');
    for (const counter of ['heldRequests', 'currentHeldWaiters', 'holdTimeouts', 'rangeRequests',
      'resolutions']) {
      assert(provider.includes(`json:"${counter}"`),
        `the endpoint carries ${counter}, so the gates are not asking for a field that never existed`);
    }

    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ resolutions: 7, rangeRequests: 0, notANumber: 'three' }));
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/counters`;
    try {
      for (const gate of CEILING_GATES) {
        const { script } = extract(gate, 'counters.cjs');
        const present = await runNodeAsync(script, [url, 'resolutions']);
        assertEq(present.code, 0, `${gate}: a counter that is there is read: ${present.out}`);
        assertEq(present.out.trim(), '7', `${gate}: and reported exactly: ${present.out}`);

        // A REAL ZERO IS STILL A ZERO. The refusal must be about absence, not about the value.
        const zero = await runNodeAsync(script, [url, 'rangeRequests']);
        assertEq(zero.code, 0, `${gate}: a genuine zero still succeeds: ${zero.out}`);
        assertEq(zero.out.trim(), '0', `${gate}: and prints zero: ${zero.out}`);

        const absent = await runNodeAsync(script, [url, 'holdTimeouts']);
        assert(absent.code !== 0,
          `${gate}: a counter the endpoint does not carry must not print as zero: ${absent.out}`);
        assert(absent.out.trim() !== '0', `${gate}: and must print no count at all: ${absent.out}`);

        const wrongType = await runNodeAsync(script, [url, 'notANumber']);
        assert(wrongType.code !== 0, `${gate}: a non-numeric counter is refused too: ${wrongType.out}`);
      }
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });

// ---------------------------------------------------------------------------------------------------------
// `scan.cjs` — three gates, six call sites, run on the HOST as the operator
// ---------------------------------------------------------------------------------------------------------

const SCAN_GATES = [
  'deploy/projection-real-provider-gate.sh',
  'deploy/projection-torbox-mount-gate.sh',
  'deploy/projection-torbox-real-gate.sh',
] as const;

test('scan.cjs STILL FINDS A SECRET IN AN ORDINARY FILE, and still prints only a count', () => {
  const { dir, script } = extract(SCAN_GATES[0], 'scan.cjs');
  writeFileSync(join(dir, 'cred'), 'SUPERSECRETVALUE0123456789', 'utf8');
  mkdirSync(join(dir, 'roots'));
  writeFileSync(join(dir, 'roots', 'log.txt'), 'leaked SUPERSECRETVALUE0123456789 here\n', 'utf8');
  const run = runNode(script, [join(dir, 'cred'), join(dir, 'roots')]);
  assertEq(run.code, 0, `a scan that completed exits 0: ${run.out}`);
  assertEq(run.out.trim(), '1', `and prints the hit count and nothing else: ${run.out}`);
});

test('A FILE scan.cjs COULD NOT OPEN IS A REFUSAL, not a silent skip inside a clean zero', () => {
  // THE HALF THE LAST CORRECTION LEFT BEHIND. It closed "a root that did not exist was walked in silence"
  // and left "a file that could not be opened was skipped in silence": `catch { continue; }`, with the
  // readable files beside it keeping `examined` above zero so the guard never fired. Measured as an
  // unprivileged uid over one harmless readable file and one mode-000 file holding the credential in plain
  // text, the shipped program printed `0` and exited `0`. These six call sites run on the HOST as the
  // operator, over directories containers wrote as other uids, so it is live rather than latent.
  if (UNPRIVILEGED_UID === undefined) return;
  for (const gate of SCAN_GATES) {
    const { dir, script } = extract(gate, 'scan.cjs');
    writeFileSync(join(dir, 'cred'), 'SUPERSECRETVALUE0123456789', 'utf8');
    mkdirSync(join(dir, 'roots'));
    writeFileSync(join(dir, 'roots', 'harmless.txt'), 'nothing of interest\n', 'utf8');
    writeFileSync(join(dir, 'roots', 'locked.txt'), 'SUPERSECRETVALUE0123456789\n', 'utf8');
    openTo(dir, script, join(dir, 'cred'), join(dir, 'roots', 'harmless.txt'));
    chmodSync(join(dir, 'roots'), 0o755);
    chmodSync(join(dir, 'roots', 'locked.txt'), 0o000);
    const run = runNode(script, [join(dir, 'cred'), join(dir, 'roots')], undefined, UNPRIVILEGED_UID);
    assert(run.code !== 0, `${gate}: an unopenable file must not be covered by a clean count: ${run.out}`);
    assert(/could not be opened/.test(run.out), `${gate}: and the refusal must say so: ${run.out}`);
    // AND STILL NAMES NO PATH. The redaction rule does not relax because the scan failed.
    assert(!run.out.includes('locked.txt'), `${gate}: the refusal names a file: ${run.out}`);
  }
});

test('A SOCKET OR FIFO IS SKIPPED RATHER THAN READ, which could otherwise block for ever', () => {
  if (process.platform === 'win32') return;
  const { dir, script } = extract(SCAN_GATES[0], 'scan.cjs');
  writeFileSync(join(dir, 'cred'), 'SUPERSECRETVALUE0123456789', 'utf8');
  mkdirSync(join(dir, 'roots'));
  writeFileSync(join(dir, 'roots', 'ok.txt'), 'nothing of interest\n', 'utf8');
  const fifo = spawnSync('mkfifo', [join(dir, 'roots', 'pipe')], { encoding: 'utf8' });
  if (fifo.status !== 0) return;
  const result = spawnSync(process.execPath, [script, join(dir, 'cred'), join(dir, 'roots')],
    { encoding: 'utf8', timeout: 20_000 });
  assert(result.signal === null, 'the scan finished rather than hanging on the fifo');
  assertEq(result.status, 0, `and completed: ${result.stdout}${result.stderr}`);
  assertEq((result.stdout ?? '').trim(), '0', 'with a count over the ordinary files it could read');
});

// ---------------------------------------------------------------------------------------------------------
// `identity.cjs` — G24's seven pinned fields
// ---------------------------------------------------------------------------------------------------------

const LEASE_GATE = 'deploy/projection-lease-gate.sh';

function manifestFixture(): { dir: string; script: string } {
  const { dir, script } = extract(LEASE_GATE, 'identity.cjs');
  mkdirSync(join(dir, 'manifest'));
  mkdirSync(join(dir, 'mnt'));
  writeFileSync(join(dir, 'mnt', 'entry.bin'), 'x', 'utf8');
  return { dir, script };
}

/** `gen_<32 hex>`, the only shape `deriveGenerationId` produces. */
const ID_FIRST = `gen_${'1'.repeat(32)}`;
const ID_SECOND = `gen_${'2'.repeat(32)}`;
const ID_OTHER = `gen_${'3'.repeat(32)}`;
/** `generation-<sequence>-<id minus gen_>.json`, the only shape `artifactNameFor` produces. */
const artifactFor = (id: string, sequence: number): string =>
  `generation-${sequence}-${id.slice('gen_'.length)}.json`;

function generation(id: string, sequence: number, entryId: string, sourceId: string, sourceGeneration: number):
string {
  return JSON.stringify({
    format: 'projection-manifest-v1',
    version: 1,
    generation: { generationId: id, sequence },
    entries: [{
      path: 'entry.bin',
      projectedEntryId: entryId,
      sources: [{ sourceId, sourceGeneration }],
    }],
  });
}

test('THE IDENTITY IS READ OUT OF THE GENERATION THE POINTER NAMES, not the first one on disk', () => {
  // MEASURED AGAINST THE SHIPPED BYTES. `readdirSync(dir).find(name => name.startsWith('generation-'))` takes
  // whichever artifact readdir returns first. With `generation-1-FIRST.json` and `generation-2-SECOND.json`
  // present and the pointer naming the second, it emitted `generationId: gen_SECOND` and `sequence: 2`
  // beside `projectedEntryId: pe_OLD`, `sourceId: src_OLD` and `sourceGeneration: 1` — one record describing
  // two generations. Because the before and the after call read the same wrong file, those three of the
  // seven pinned fields were read out of a document nothing rewrites during the window and could not have
  // differed whatever the daemon did.
  const { dir, script } = manifestFixture();
  writeFileSync(join(dir, 'manifest', artifactFor(ID_FIRST, 1)),
    generation(ID_FIRST, 1, 'pe_OLD', 'src_OLD', 1), 'utf8');
  writeFileSync(join(dir, 'manifest', artifactFor(ID_SECOND, 2)),
    generation(ID_SECOND, 2, 'pe_NEW', 'src_NEW', 9), 'utf8');
  writeFileSync(join(dir, 'manifest', 'pointer.json'), JSON.stringify({
    generationId: ID_SECOND, sequence: 2, artifactName: artifactFor(ID_SECOND, 2),
    artifactBytes: 10, manifestDigest: 'sha256:bb',
  }), 'utf8');

  const run = runNode(script, ['./mnt/entry.bin', './manifest', 'entry.bin', './out.json'], dir);
  assertEq(run.code, 0, `the identity is produced: ${run.out}`);
  const identity = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as Record<string, string>;
  assertEq(identity.projectedEntryId, 'pe_NEW', 'the entry id comes from the generation being served');
  assertEq(identity.sourceId, 'src_NEW', 'and so does the source id');
  assertEq(identity.sourceGeneration, '9', 'and so does the source generation');
  assertEq(identity.generationId, ID_SECOND, 'and the pointer half is unchanged');
  // EVERY FIELD IS A STRING, so a comparison that ever normalised types would treat all seven alike.
  for (const [field, value] of Object.entries(identity)) {
    assertEq(typeof value, 'string', `${field} is recorded as a string like its six siblings`);
  }
});

test('AN ARTIFACT THAT DISAGREES WITH THE POINTER THAT NAMED IT IS REFUSED', () => {
  const { dir, script } = manifestFixture();
  writeFileSync(join(dir, 'manifest', artifactFor(ID_SECOND, 2)),
    generation(ID_OTHER, 2, 'pe_NEW', 'src_NEW', 9), 'utf8');
  writeFileSync(join(dir, 'manifest', 'pointer.json'), JSON.stringify({
    generationId: ID_SECOND, sequence: 2, artifactName: artifactFor(ID_SECOND, 2),
    artifactBytes: 10, manifestDigest: 'sha256:bb',
  }), 'utf8');
  const run = runNode(script, ['./mnt/entry.bin', './manifest', 'entry.bin', './out.json'], dir);
  assert(run.code !== 0, `a mismatched artifact must be refused: ${run.out}`);
  assert(!existsSync(join(dir, 'out.json')), 'and no identity is written');
});

test('A POINTER THAT NAMES NO ARTIFACT, AND A MULTI-SOURCE ENTRY, ARE BOTH REFUSED', () => {
  const nameless = manifestFixture();
  writeFileSync(join(nameless.dir, 'manifest', artifactFor(ID_FIRST, 1)),
    generation(ID_FIRST, 1, 'pe', 'src', 1), 'utf8');
  writeFileSync(join(nameless.dir, 'manifest', 'pointer.json'),
    JSON.stringify({ generationId: ID_FIRST, sequence: 1 }), 'utf8');
  const run = runNode(nameless.script, ['./mnt/entry.bin', './manifest', 'entry.bin', './out.json'],
    nameless.dir);
  assert(run.code !== 0, `a pointer with no artifactName must be refused: ${run.out}`);

  // `sources[0]` IS A POSITION, NOT AN IDENTITY: two sources would report the same first one across a
  // failover, which G3 names as one of the events identity must survive.
  const two = manifestFixture();
  const manifest = JSON.parse(generation(ID_FIRST, 1, 'pe', 'src', 1)) as
    { entries: Array<{ sources: unknown[] }> };
  manifest.entries[0]?.sources.push({ sourceId: 'src-b', sourceGeneration: 2 });
  writeFileSync(join(two.dir, 'manifest', artifactFor(ID_FIRST, 1)), JSON.stringify(manifest), 'utf8');
  writeFileSync(join(two.dir, 'manifest', 'pointer.json'), JSON.stringify({
    generationId: ID_FIRST, sequence: 1, artifactName: artifactFor(ID_FIRST, 1),
    artifactBytes: 10, manifestDigest: 'sha256:aa',
  }), 'utf8');
  const multi = runNode(two.script, ['./mnt/entry.bin', './manifest', 'entry.bin', './out.json'], two.dir);
  assert(multi.code !== 0, `an entry with two sources must be refused: ${multi.out}`);
});

test('A POINTER THAT NAMES A PATH RATHER THAN AN ARTIFACT CANNOT ESCAPE THE MANIFEST DIRECTORY', () => {
  // REFUSING `/` IS NOT ENOUGH AND THE FIRST VERSION OF THIS CORRECTION DID EXACTLY THAT. On Windows `\` is
  // a separator too, so `..\..\elsewhere.json` would have left the manifest directory — out of a file this
  // program is handed rather than one it trusts. The name is now DERIVED from `sequence` and `generationId`
  // and then compared, so traversal is impossible by construction rather than by blacklist.
  // THE DEPTHS ARE THE ONES THAT ACTUALLY ESCAPE, not the ones that merely look hostile. A name that
  // resolves to a path which happens not to exist is refused by `ENOENT` and would pass this test against a
  // program with no rule at all. Measured against the slash-only version: `generation-..\..\..\outside\…`
  // read `pe_ELSEWHERE` out of a file the manifest directory does not contain, and exited 0.
  const hostile = [
    ['a POSIX traversal', '../../../outside/elsewhere.json'],
    ['a Windows traversal', 'generation-..\\..\\..\\outside\\elsewhere.json'],
    ['a mixed traversal', 'generation-..\\../..\\outside/elsewhere.json'],
    ['a name that is not the derived one', `generation-1-${'a'.repeat(32)}.json`],
    ['a name with no extension', `generation-1-${'f'.repeat(32)}`],
  ] as const;
  for (const [what, artifactName] of hostile) {
    const { dir, script } = manifestFixture();
    const id = `gen_${'f'.repeat(32)}`;
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(dir, 'outside', 'elsewhere.json'),
      generation(id, 1, 'pe_ELSEWHERE', 'src_ELSEWHERE', 1), 'utf8');
    writeFileSync(join(dir, 'manifest', `generation-1-${'f'.repeat(32)}.json`),
      generation(id, 1, 'pe_INSIDE', 'src', 1), 'utf8');
    writeFileSync(join(dir, 'manifest', 'pointer.json'), JSON.stringify({
      generationId: id, sequence: 1, artifactName, artifactBytes: 10, manifestDigest: 'sha256:aa',
    }), 'utf8');
    const run = runNode(script, ['./mnt/entry.bin', './manifest', 'entry.bin', './out.json'], dir);
    assert(run.code !== 0, `${what} must be refused: ${run.out}`);
    assert(!existsSync(join(dir, 'out.json')), `${what}: and no identity is written`);
    assert(!run.out.includes('pe_ELSEWHERE'), `${what}: and nothing outside the manifest directory is read`);
    // AND THE REFUSAL IS THE RULE'S, NOT ENOENT'S — otherwise the case would pass against no rule at all.
    assert(/is not the one its own generation id and sequence derive/.test(run.out),
      `${what}: refused for the wrong reason, so this case proves nothing: ${run.out}`);
  }
  // THE DECOY REALLY IS REACHABLE, or every refusal above is a refusal of a path that was not there.
  const proof = manifestFixture();
  mkdirSync(join(proof.dir, 'outside'));
  writeFileSync(join(proof.dir, 'outside', 'elsewhere.json'), 'reachable', 'utf8');
  assert(existsSync(join(proof.dir, 'manifest', '..', 'outside', 'elsewhere.json')),
    'the file the traversals aim at exists, so refusing them is refusing something that would have worked');
});

test('A POINTER WHOSE GENERATION ID OR SEQUENCE IS NOT THE CONTRACT\'S SHAPE IS REFUSED', () => {
  const id = `gen_${'f'.repeat(32)}`;
  const bad: Array<[string, Record<string, unknown>]> = [
    ['a generation id of the wrong shape', { generationId: 'gen_NOTHEX', sequence: 1 }],
    ['a generation id with no prefix', { generationId: 'f'.repeat(32), sequence: 1 }],
    ['a negative sequence', { generationId: id, sequence: -1 }],
    ['a fractional sequence', { generationId: id, sequence: 1.5 }],
    ['an unsafe sequence', { generationId: id, sequence: Number.MAX_SAFE_INTEGER + 2 }],
  ];
  for (const [what, half] of bad) {
    const { dir, script } = manifestFixture();
    writeFileSync(join(dir, 'manifest', `generation-1-${'f'.repeat(32)}.json`),
      generation(id, 1, 'pe', 'src', 1), 'utf8');
    writeFileSync(join(dir, 'manifest', 'pointer.json'), JSON.stringify({
      ...half, artifactName: `generation-1-${'f'.repeat(32)}.json`,
      artifactBytes: 10, manifestDigest: 'sha256:aa',
    }), 'utf8');
    const run = runNode(script, ['./mnt/entry.bin', './manifest', 'entry.bin', './out.json'], dir);
    assert(run.code !== 0, `${what} must be refused: ${run.out}`);
  }
  // AND THE SHAPE IS THE ONE THE PRODUCER ACTUALLY MAKES, checked against the producer rather than asserted.
  const contract = read('src/core/projection/manifest-v1.ts');
  assert(/return `gen_\$\{derive\([\s\S]{0,120}\.slice\(0, 32\)\}`/.test(contract),
    'a generation id is `gen_` followed by 32 hex characters');
  const publisher = read('src/core/projection/publisher.ts');
  assert(publisher.includes('return `generation-${sequence}-${generationId.slice(\'gen_\'.length)}.json`;'),
    'and the artifact name is that id and the sequence, which is what this program now derives');
});

test('THE POINTER FIELD THIS RELIES ON IS THE CONTRACT\'S, not a name invented here', () => {
  const store = read('src/core/projection/artifact-store.ts');
  assert(/interface PointerDocument[\s\S]*?readonly artifactName: string;/.test(store),
    'the pointer document carries the artifact name, so binding to it is using the contract');
  assert(heredoc(LEASE_GATE, 'identity.cjs').includes('pointer.artifactName'),
    'and the program compares it rather than scanning the directory');
  assert(!heredoc(LEASE_GATE, 'identity.cjs').includes('readdirSync'),
    'and no longer walks the manifest directory looking for something that starts with generation-');
});

// ---------------------------------------------------------------------------------------------------------
// `jq.cjs` — ELEVEN gates, and every verdict any of them reads out of a JSON document comes through it
// ---------------------------------------------------------------------------------------------------------
//
// This is the most-copied program in the tranche and the least examined: `field()` is defined as `node
// jq.cjs "$1"` in all eleven gates, and `test "$(field outcome < …)" = "published"` is how a gate learns
// whether its own publish succeeded.

const JQ_GATES = [
  'deploy/projection-emby-dataplane-gate.sh',
  'deploy/projection-jellyfin-dataplane-gate.sh',
  'deploy/projection-lease-gate.sh',
  'deploy/projection-path-lifecycle-gate.sh',
  'deploy/projection-plex-dataplane-gate.sh',
  'deploy/projection-publisher-mount-gate.sh',
  'deploy/projection-rclone-comparison-gate.sh',
  'deploy/projection-real-provider-gate.sh',
  'deploy/projection-three-server-concurrency-gate.sh',
  'deploy/projection-torbox-mount-gate.sh',
  'deploy/projection-torbox-real-gate.sh',
] as const;

/** Run a program that reads stdin, with the payload delivered as BYTES rather than as a string. */
function runNodeStdin(script: string, args: readonly string[], input: Buffer): Run {
  const result = spawnSync(process.execPath, [script, ...args], { input, maxBuffer: 1 << 28 });
  return {
    code: result.status ?? -1,
    out: `${(result.stdout ?? Buffer.alloc(0)).toString('utf8')}`
      + `${(result.stderr ?? Buffer.alloc(0)).toString('utf8')}`,
  };
}

test('THE ELEVEN COPIES OF jq.cjs ARE ONE PROGRAM, so one correction cannot fix ten of them', () => {
  const bodies = JQ_GATES.map((gate) => heredoc(gate, 'jq.cjs'));
  for (const [index, body] of bodies.entries()) {
    assertEq(body, bodies[0] as string,
      `${JQ_GATES[index]} carries a jq.cjs that differs from the other ten`);
  }
});

test('A FIELD IS READ OUT OF AN ORDINARY DOCUMENT, which is the control the cases below are measured against',
  () => {
    const { script } = extract(JQ_GATES[0], 'jq.cjs');
    const run = runNodeStdin(script, ['outcome'], Buffer.from('{"outcome":"published","additions":3}'));
    assertEq(run.code, 0, `an ordinary read must succeed: ${run.out}`);
    assertEq(run.out.trim(), 'published', 'and answer with the field');
  });

test('A MULTI-BYTE VALUE SPLIT ACROSS A READ BOUNDARY SURVIVES, where it used to come back corrupted', () => {
  // THE DEFECT, MEASURED. `raw += chunk` coerces each Buffer with its own `toString()`, so a character
  // whose bytes land on either side of a 64 KiB read boundary decodes as two U+FFFD replacement characters.
  // The merge-base program answered a payload of this shape with 24 of them and exit 0 — a wrong value
  // reported as a success.
  //
  // THE ALIGNMENT IS THE WHOLE FIXTURE, AND MY FIRST DRAFT HAD IT BACKWARDS. Two-byte characters starting at
  // an EVEN offset never straddle a 65 536-byte boundary, so the padded document I wrote first came back
  // perfect from the DEFECTIVE program and the test passed against the very bytes it was written to catch —
  // caught only by running it against the merge base. The pad is therefore chosen to put the first character
  // on an ODD offset, and that offset is asserted rather than assumed.
  const { script } = extract(JQ_GATES[0], 'jq.cjs');
  const title = 'é'.repeat(400_000);
  const build = (pad: string): Buffer => Buffer.from(JSON.stringify({ p: pad, title }), 'utf8');
  const firstCharOffset = (buffer: Buffer): number => buffer.indexOf(Buffer.from('é', 'utf8'));
  let payload = build('');
  if (firstCharOffset(payload) % 2 === 0) payload = build('x');
  assert(firstCharOffset(payload) % 2 === 1,
    'the multi-byte run must start on an odd offset or no read boundary can fall inside a character');
  assert(payload.length > 8 * 65_536, 'the payload must span several read boundaries to prove anything');
  const run = runNodeStdin(script, ['title'], payload);
  assertEq(run.code, 0, `the read must succeed: ${run.out.slice(0, 200)}`);
  const answer = run.out.replace(/\r?\n$/, '');
  assertEq((answer.match(/�/g) ?? []).length, 0,
    'no character may be replaced: a value that decoded wrongly is not the value the document carried');
  assert(answer === title, 'and the answer is the value verbatim');
});

test('A DOCUMENT THAT IS NOT AN OBJECT IS REFUSED rather than answering nothing for every field', () => {
  // '' is the shape of a field that is merely ABSENT. A caller testing for emptiness reads a scalar
  // document as "the field is not set" and carries on.
  const { script } = extract(JQ_GATES[0], 'jq.cjs');
  for (const document of ['null', '42', '"published"', '[1,2]']) {
    const run = runNodeStdin(script, ['outcome'], Buffer.from(document));
    assert(run.code !== 0, `${document} must be refused rather than read as a field: ${run.out}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// `sha.cjs` — EIGHT gates in three forms, and the value every byte-level claim is compared against
// ---------------------------------------------------------------------------------------------------------

const SHA_RANGE_GATES = [
  'deploy/projection-emby-dataplane-gate.sh',
  'deploy/projection-jellyfin-dataplane-gate.sh',
  'deploy/projection-plex-dataplane-gate.sh',
] as const;
const SHA_STREAM_GATES = [
  'deploy/projection-rclone-comparison-gate.sh',
  'deploy/projection-three-server-concurrency-gate.sh',
] as const;
const SHA_SYNC_GATES = [
  'deploy/projection-lease-gate.sh',
  'deploy/projection-path-lifecycle-gate.sh',
  'deploy/projection-publisher-mount-gate.sh',
] as const;

/** The digest of the empty string — the answer a read that returned nothing used to give. */
const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** A deterministic object to digest, and the directory it sits in. */
function shaFixture(gate: string): { dir: string; script: string; bytes: Buffer } {
  const { dir, script } = extract(gate, 'sha.cjs');
  const bytes = Buffer.alloc(100_000);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
  writeFileSync(join(dir, 'object.bin'), bytes);
  return { dir, script, bytes };
}

test('EACH FORM OF sha.cjs IS ONE PROGRAM ACROSS ITS GATES, so one correction cannot fix some of them', () => {
  for (const group of [SHA_RANGE_GATES, SHA_STREAM_GATES, SHA_SYNC_GATES]) {
    const bodies = group.map((gate) => heredoc(gate, 'sha.cjs'));
    for (const [index, body] of bodies.entries()) {
      assertEq(body, bodies[0] as string, `${group[index]} carries a sha.cjs that differs from its siblings`);
    }
  }
});

test('THE HONEST ANSWERS DID NOT MOVE — whole object and in-range window, against the standard library', () => {
  // NOTHING HERE RECOMPUTES WHAT THE PROGRAM COMPUTES. The expectation comes from `node:crypto` over the
  // same bytes, which is the same authority the gate's own comparison rests on.
  for (const gate of [...SHA_RANGE_GATES, ...SHA_STREAM_GATES, ...SHA_SYNC_GATES]) {
    const { dir, script, bytes } = shaFixture(gate);
    const whole = runNode(script, ['./object.bin'], dir);
    assertEq(whole.code, 0, `${gate}: an ordinary whole-object digest must succeed: ${whole.out}`);
    assertEq(whole.out.trim(), createHash('sha256').update(bytes).digest('hex'),
      `${gate}: and be the digest of those bytes`);
    if (!(SHA_RANGE_GATES as readonly string[]).includes(gate)) continue;
    const ranged = runNode(script, ['./object.bin', '1000', '4096'], dir);
    assertEq(ranged.code, 0, `${gate}: an in-range window must succeed: ${ranged.out}`);
    assertEq(ranged.out.trim(), createHash('sha256').update(bytes.subarray(1000, 1000 + 4096)).digest('hex'),
      `${gate}: and be the digest of that window`);
  }
});

test('A WINDOW PAST THE END OF THE OBJECT IS REFUSED, where it used to answer with the EMPTY digest', () => {
  // THE DEFECT, MEASURED, AND WHY THE DIRECTION MATTERS. The merge-base program answered `e3b0c442…b855`
  // and exit 0 for a 100 000-byte object read at offset 5 000 000. The gate computes its EXPECTATION with
  // this program and then has the daemon serve the same window, so a window neither side can satisfy
  // degrades BOTH to that one value and `--expect-sha` compares it against itself. An unfailable assertion
  // is worse than an absent one: it reads as evidence.
  for (const gate of SHA_RANGE_GATES) {
    const { dir, script } = shaFixture(gate);
    const past = runNode(script, ['./object.bin', '5000000', '4096'], dir);
    assert(past.code !== 0, `${gate}: a window past EOF must be refused: ${past.out}`);
    assert(!past.out.includes(EMPTY_DIGEST), `${gate}: and must never print the empty digest: ${past.out}`);
    // AND THE HALF-SATISFIED ONE TOO, which is the quieter of the two: the expectation silently becomes a
    // digest of however many bytes happened to exist.
    const short = runNode(script, ['./object.bin', '99000', '4096'], dir);
    assert(short.code !== 0, `${gate}: a window running past EOF must be refused: ${short.out}`);
  }
});

test('AN OFFSET OR LENGTH THAT IS NOT A SAFE INTEGER IS NAMED, not raised as a stack trace from a stream', () => {
  // THE EXIT CODE ALONE DOES NOT BITE HERE and this test says so rather than pretending otherwise: the
  // merge-base program also exited non-zero for every one of these, because NaN reached `createReadStream`
  // and came back as an ERR_OUT_OF_RANGE throw. What was missing is a statement about the ARGUMENT. So what
  // is asserted is that the program names its own refusal instead of dying inside the standard library —
  // measured against the merge base, which fails this and passed on status alone.
  for (const gate of SHA_RANGE_GATES) {
    const { dir, script } = shaFixture(gate);
    for (const argv of [['./object.bin', 'abc', '10'], ['./object.bin', '0', 'abc'],
      ['./object.bin', '0', '0'], ['./object.bin', '-1', '10'], ['./object.bin', '0', '']]) {
      const run = runNode(script, argv, dir);
      assert(run.code !== 0, `${gate}: ${JSON.stringify(argv)} must be refused: ${run.out}`);
      assert(!run.out.includes(EMPTY_DIGEST), `${gate}: and must not print a digest: ${run.out}`);
      assert(run.out.startsWith('sha: '),
        `${gate}: ${JSON.stringify(argv)} must be refused by name rather than thrown from a stream: ${run.out}`);
      assert(!/ERR_OUT_OF_RANGE|at Object\.<anonymous>/.test(run.out),
        `${gate}: and not as an uncaught exception: ${run.out}`);
    }
  }
});

test('TWO SAFE OFFSETS THAT SUM PAST THE BOUNDARY ARE REFUSED BEFORE THE STREAM, not diagnosed as a short read',
  () => {
    // THE CUMULATIVE-OVERFLOW CLASS, WHICH THE PREVIOUS LOOP ALREADY CORRECTED IN `cacheceiling.cjs` AND
    // WHICH MY FIRST CORRECTION HERE REINTRODUCED. `start` and `length` are each checked for safety
    // individually, and MAX_SAFE_INTEGER with a length of 2 passes both while `start + length - 1` is
    // already approximate.
    //
    // AND THE EXIT CODE ALONE DOES NOT BITE, so this asserts the DIAGNOSIS. Without the cumulative check the
    // program opens the stream anyway, reads nothing, and reports "N bytes were asked for … and the object
    // yielded 0" — which blames the object for an arithmetic fault and would send an operator to look at the
    // wrong thing. A window whose end cannot be represented exactly is refused before anything is opened.
    for (const gate of SHA_RANGE_GATES) {
      const { dir, script } = shaFixture(gate);
      for (const argv of [
        ['./object.bin', String(Number.MAX_SAFE_INTEGER), '2'],
        ['./object.bin', String(Number.MAX_SAFE_INTEGER - 10), '1000'],
      ]) {
        const run = runNode(script, argv, dir);
        assert(run.code !== 0, `${gate}: ${JSON.stringify(argv)} must be refused: ${run.out}`);
        assert(/exact-integer boundary/.test(run.out),
          `${gate}: and must name the arithmetic rather than report a short read: ${run.out}`);
        assert(!/yielded/.test(run.out),
          `${gate}: the object must not be blamed for an offset that cannot be represented: ${run.out}`);
        assert(!run.out.includes(EMPTY_DIGEST), `${gate}: and no digest is printed: ${run.out}`);
      }
    }
  });

test('AN OBJECT THAT YIELDED NO BYTES IS REFUSED BY EVERY FORM, empty file and unreadable path alike', () => {
  for (const gate of [...SHA_RANGE_GATES, ...SHA_STREAM_GATES, ...SHA_SYNC_GATES]) {
    const { dir, script } = shaFixture(gate);
    writeFileSync(join(dir, 'empty.bin'), Buffer.alloc(0));
    const empty = runNode(script, ['./empty.bin'], dir);
    assert(empty.code !== 0, `${gate}: an empty object must be refused: ${empty.out}`);
    assert(!empty.out.includes(EMPTY_DIGEST),
      `${gate}: and the empty digest must never be printed as an answer: ${empty.out}`);
    const missing = runNode(script, ['./nothing-here.bin'], dir);
    assert(missing.code !== 0, `${gate}: an unreadable object must be refused: ${missing.out}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// `out/seekprobe.sh` — the rclone comparison gate's forward-seek, backward-seek and whole-object claim
// ---------------------------------------------------------------------------------------------------------
//
// THIS ONE IS RUN ON BOTH SIDES OF ITS OWN COMPARISON. The gate runs the program inside the mount and again
// outside it and compares line for line; only the third line is checked against a value recorded elsewhere.

const RCLONE_GATE = 'deploy/projection-rclone-comparison-gate.sh';

function seekprobeFixture(): { dir: string; script: string } {
  const { dir, script } = extract(RCLONE_GATE, 'out/seekprobe.sh');
  // THE FILL MUST NOT REPEAT ON A BLOCK BOUNDARY, and my first draft did: `(i * 17 + 3) & 0xff` has a period
  // of 256, so every 64 KiB block of it is byte-identical to every other and the "the two seeks read
  // different bytes" case failed against a correct program. A counter-mode LCG has no period inside a fixture
  // this size, so two blocks differ because the OBJECT differs and not because the reads did.
  const bytes = Buffer.alloc(200_000);
  let state = 0x2545f491;
  for (let i = 0; i < bytes.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = (state >>> 24) & 0xff;
  }
  writeFileSync(join(dir, 'object.bin'), bytes);
  return { dir, script };
}

test('THE THREE READS STILL ANSWER, and the forward and backward seeks are DIFFERENT reads', () => {
  if (!bashAvailable) throw new Error('bash is required to execute the shipped helper');
  const { dir, script } = seekprobeFixture();
  const run = runBash(script, ['./object.bin', '2'], dir);
  assertEq(run.code, 0, `an in-range probe must succeed: ${run.out}`);
  const lines = run.out.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  assertEq(lines.length, 3, `three reads, three digests: ${run.out}`);
  assert(lines[0] !== lines[1],
    'a forward seek into the middle and a backward seek to the start must not return the same bytes');
  assert(!lines.includes(EMPTY_DIGEST), `and none of them is the empty digest: ${run.out}`);
});

test('A SEEK PAST THE END IS REFUSED, where it used to answer the EMPTY digest on BOTH sides at once', () => {
  // THE DEFECT, MEASURED IN THE GATE'S OWN PINNED IMAGE: `dd` reports success for a block that lands past
  // EOF, its status is lost to the pipe either way, and `dd | sha256sum` therefore answered `e3b0c442…b855`
  // for a read that produced nothing. Because the CALLER runs this same program inside the mount and
  // outside it, both sides answer with that one value and the two seek assertions compare it against
  // itself. The whole-object line would still have caught a total failure; the two seek lines — which are
  // what this step exists to prove — would not.
  if (!bashAvailable) throw new Error('bash is required to execute the shipped helper');
  const { dir, script } = seekprobeFixture();
  const run = runBash(script, ['./object.bin', '64'], dir);
  assert(run.code !== 0, `a block past the end of the object must be refused: ${run.out}`);
  assert(!run.out.includes(EMPTY_DIGEST), `and the empty digest must not be printed: ${run.out}`);
});

// ---------------------------------------------------------------------------------------------------------
// `out/baseline.sh` — five gates, and the statement that a projected file is a read-only regular file
// ---------------------------------------------------------------------------------------------------------

const BASELINE_GATES = [
  'deploy/projection-emby-dataplane-gate.sh',
  'deploy/projection-jellyfin-dataplane-gate.sh',
  'deploy/projection-plex-dataplane-gate.sh',
  'deploy/projection-three-server-concurrency-gate.sh',
] as const;

test('THE FOUR DATAPLANE COPIES OF baseline.sh ARE ONE PROGRAM, and the rclone one differs by ONE field', () => {
  const bodies = BASELINE_GATES.map((gate) => heredoc(gate, 'out/baseline.sh'));
  for (const [index, body] of bodies.entries()) {
    assertEq(body, bodies[0] as string,
      `${BASELINE_GATES[index]} carries a baseline.sh that differs from the other three`);
  }
  // THE FIFTH IS NOT BYTE-IDENTICAL AND THAT IS DELIBERATE — it reports no inode. Pinning the ONE line
  // they differ on is what keeps "it is a different program on purpose" from turning into "it drifted".
  const rclone = heredoc(RCLONE_GATE, 'out/baseline.sh');
  assertEq(rclone, (bodies[0] as string).replace(' inode=%i', ''),
    'the rclone copy must differ from the dataplane copies only in dropping the inode field');
});

test('A BASELINE OVER NO TARGETS IS REFUSED, where it used to report success having looked at nothing', () => {
  // THE DEFECT, MEASURED IN THE GATE'S OWN PINNED IMAGE: no arguments, no output, exit 0. `for target in
  // "$@"` runs its body zero times and the script falls off the end, so every property the program exists
  // to establish is reported as holding for a set it never opened. The callers pass shell-expanded paths.
  if (!bashAvailable) throw new Error('bash is required to execute the shipped helper');
  for (const gate of [...BASELINE_GATES, RCLONE_GATE]) {
    const { dir, script } = extract(gate, 'out/baseline.sh');
    const run = runBash(script, [], dir, UNPRIVILEGED_UID);
    assert(run.code !== 0, `${gate}: a baseline over nothing must be refused: ${run.out}`);
    // THE MESSAGE IS ASSERTED, NOT ONLY THE STATUS. Run as root the program refuses for a different reason
    // entirely, and a test that read only the exit code would pass on a host where this case never ran.
    assert(run.out.includes('no targets were named'),
      `${gate}: and must refuse for THAT reason rather than another: ${run.out}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// `objects.cjs` — three forms across six gates, and the endpoint's own account of what it is serving
// ---------------------------------------------------------------------------------------------------------

test('AN OBJECT THE ENDPOINT IS NOT SERVING IS NAMED BY EVERY FORM, not raised as a TypeError in a helper',
  () => {
    const guarded = [
      ['deploy/projection-emby-dataplane-gate.sh', ['./objects.json', 'missing-ref', 'sha256']],
      ['deploy/projection-lease-gate.sh', ['./objects.json', 'missing-ref', 'sha256']],
      ['deploy/projection-publisher-mount-gate.sh', ['./objects.json', 'sha256']],
    ] as const;
    for (const [gate, argv] of guarded) {
      const { dir, script } = extract(gate, 'objects.cjs');
      writeFileSync(join(dir, 'objects.json'), '[]', 'utf8');
      const run = runNode(script, argv, dir);
      assert(run.code !== 0, `${gate}: an unmatched ref must be refused: ${run.out}`);
      assert(!/TypeError/.test(run.out),
        `${gate}: and must say what is wrong rather than crash in a property read: ${run.out}`);
    }
  });

// ---------------------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------------------

test('this suite runs in the aggregate', () => {
  assert(AGGREGATE_SUITE_COMMAND.includes('projection-gate-embedded-programs'),
    'the suite is in the inventory the runner spawns from');
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:projection-gate-embedded-programs'],
    'tsx test/projection-gate-embedded-programs.ts',
    'the suite is wired into package.json under its own name');
});

for (const dir of scratchDirs) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a scratch left behind fails nothing */ }
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
for (const [name, error] of failures) console.log(`  - ${name}: ${(error as Error).message}`);
if (failed > 0) process.exit(1);
