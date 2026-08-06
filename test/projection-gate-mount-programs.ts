import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';

// Projection Phase 1 — the gate programs that can only be executed INSIDE a container, EXECUTED.
//
// WHY THIS IS A SECOND SUITE AND NOT MORE OF THE FIRST. `test/projection-gate-embedded-programs.ts` runs the
// gates' embedded programs offline, and it can do that because those programs take the root they work on as
// an ARGUMENT. Three of them do not: `out/verify.sh`, `out/stampede.sh` and `out/baseline.sh` hard-code
// `/mnt` and `/out`, which are the paths their gates bind-mount. There is no honest way to run those on a
// developer's machine — creating `/mnt` on the host to satisfy a test would be modifying the machine to fit
// the measurement — so they run here, in the gates' OWN digest-pinned image, and this suite declares
// `requires: ["docker"]` so a host that cannot provide one is told so rather than reporting a pass.
//
// EVERY CASE BELOW WAS FIRST MEASURED AGAINST THE MERGE BASE, and the two headline ones are the reason this
// file exists: both programs reported success over a read that returned no bytes at all.

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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

/** The body of `cat > "$WORK/<name>" <<'DELIM' … DELIM`, verbatim — the same extraction the sibling suite uses. */
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

// THE IMAGE IS THE GATES' OWN, READ OUT OF A GATE rather than written down here. A suite that pinned its own
// alpine would be measuring a different busybox than the one that ships, and `dd`'s and `grep`'s exact
// behaviour under failure is the whole subject.
const VERIFY_IMAGE = ((): string => {
  const match = read('deploy/projection-publisher-mount-gate.sh').match(/^VERIFY_IMAGE="([^"]+)"/m);
  if (!match) throw new Error('the publisher-mount gate no longer declares VERIFY_IMAGE');
  return match[1] as string;
})();

const dockerAvailable = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'],
  { encoding: 'utf8' }).status === 0;

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pjd-mount-'));
  scratchDirs.push(dir);
  return dir;
}

interface Run { readonly code: number; readonly out: string }

/**
 * Run a setup-and-exec script in the gates' pinned image, with `dir` mounted read-only at /w.
 *
 * THE FIXTURE IS BUILT INSIDE THE CONTAINER, not on the host and bind-mounted in. These programs assert on
 * `stat -c %a` being 444, and a Windows bind mount does not carry a POSIX mode — a fixture built outside
 * would fail the mode check before reaching the behaviour under test, on the one platform this repository is
 * developed on. Building it in the container makes the case identical on every host.
 */
function runInImage(dir: string, script: string): Run {
  const result = spawnSync('docker', [
    'run', '--rm', '-v', `${dir}:/w:ro`, VERIFY_IMAGE, 'sh', `/w/${script}`,
  ], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function requireDocker(): void {
  if (!dockerAvailable) throw new Error('docker is required to execute these gate programs');
}

// ---------------------------------------------------------------------------------------------------------
// `out/verify.sh` — the publisher-mount gate's read-through-the-mount phase
// ---------------------------------------------------------------------------------------------------------

const PUBLISHER_GATE = 'deploy/projection-publisher-mount-gate.sh';

/** The shipped program, plus a harness that builds the mount fixture and drops to an unprivileged uid. */
function verifyFixture(localBytes: number): string {
  const dir = scratch();
  writeFileSync(join(dir, 'verify.sh'), `${heredoc(PUBLISHER_GATE, 'out/verify.sh')}\n`, 'utf8');
  // The program refuses to run as root — that refusal is one of its own assertions — so the fixture is
  // built as root and the program itself is executed as `nobody`, which is how the gate runs it.
  writeFileSync(join(dir, 'case.sh'), [
    'set -u',
    'mkdir -p "/mnt/Movies/Local One" "/mnt/Movies/Remote Two"',
    `head -c ${localBytes} /dev/zero > "/mnt/Movies/Local One/Local One.bin"`,
    'head -c 4194304 /dev/zero > "/mnt/Movies/Remote Two/Remote Two.bin"',
    'chmod 444 "/mnt/Movies/Local One/Local One.bin" "/mnt/Movies/Remote Two/Remote Two.bin"',
    'A=$(sha256sum "/mnt/Movies/Local One/Local One.bin" | cut -d\' \' -f1)',
    'B=$(sha256sum "/mnt/Movies/Remote Two/Remote Two.bin" | cut -d\' \' -f1)',
    'su nobody -s /bin/sh -c "sh /w/verify.sh $A $B"',
    '',
  ].join('\n'), 'utf8');
  return dir;
}

test('THE MOUNT VERIFIER STILL PASSES AN HONEST NAMESPACE, which is the control for the case below', () => {
  requireDocker();
  const run = runInImage(verifyFixture(3_145_728), 'case.sh');
  assertEq(run.code, 0, `an honest read-only namespace must pass: ${run.out}`);
  assert(/matched the digest recorded outside the mount/.test(run.out), `and say so: ${run.out}`);
  assert(/every mutation refused/.test(run.out), `and reach the end of the phase: ${run.out}`);
});

test('A SEEK THAT RETURNS NO BYTES NOW FAILS, where the step\'s own heading was the only assertion', () => {
  // THE DEFECT, MEASURED, AND IT IS LIVE RATHER THAN LATENT. The two seek lines were
  // `dd … 2>/dev/null | wc -c` with nothing reading the number: `dd` reports success for a read past EOF,
  // its status is lost to the pipe anyway, and so the phase PRINTED `0` under the heading "a seek into each
  // file returns bytes" and went on to report every mutation refused and exit 0. Measured against the merge
  // base with a 100 000-byte object whose seek asks for block 512: output `0`, EXIT 0, gate green.
  requireDocker();
  const run = runInImage(verifyFixture(100_000), 'case.sh');
  assert(run.code !== 0, `a seek that returned nothing must fail the phase: ${run.out}`);
  assert(/returned no bytes at all/.test(run.out), `and name what happened: ${run.out}`);
  // AND IT MUST NOT HAVE GOT AS FAR AS THE MUTATION CLAIMS, because a phase that reports the later claims
  // after failing an earlier one is reporting claims it did not establish.
  assert(!/every mutation refused/.test(run.out),
    `and stop rather than go on to report the claims after it: ${run.out}`);
});

// ---------------------------------------------------------------------------------------------------------
// `out/stampede.sh` — the lease gate's twenty concurrent readers, which are G25's denominator
// ---------------------------------------------------------------------------------------------------------

const LEASE_GATE = 'deploy/projection-lease-gate.sh';

/** The shipped program, plus a harness that runs it against an object of the given size and counts outcomes. */
function stampedeFixture(targetBytes: number): string {
  const dir = scratch();
  writeFileSync(join(dir, 'stampede.sh'), `${heredoc(LEASE_GATE, 'out/stampede.sh')}\n`, 'utf8');
  writeFileSync(join(dir, 'case.sh'), [
    'set -u',
    'mkdir -p /out',
    `head -c ${targetBytes} /dev/zero > /tmp/target.bin`,
    'sh /w/stampede.sh /tmp/target.bin >/dev/null 2>&1',
    'echo "started=$(find /out -name \'stampede-*.started\' | wc -l | tr -d \' \')"',
    'echo "ok=$(grep -lx ok /out/stampede-*.done 2>/dev/null | wc -l | tr -d \' \')"',
    'echo "fail=$(grep -lx fail /out/stampede-*.done 2>/dev/null | wc -l | tr -d \' \')"',
    'test -f /out/stampede-complete && echo complete=yes',
    '',
  ].join('\n'), 'utf8');
  return dir;
}

test('TWENTY READERS THAT REALLY READ ARE TWENTY OK, which is the control for the case below', () => {
  requireDocker();
  // The loop reads at 4 MiB intervals from 4 MiB to 80 MiB, so an object that covers all of them is the
  // honest case. `/dev/zero` makes it cheap and the content is irrelevant — only whether bytes arrived is.
  const run = runInImage(stampedeFixture(96 * 1024 * 1024), 'case.sh');
  assertEq(run.code, 0, `the stampede must complete: ${run.out}`);
  assert(/started=20/.test(run.out), `all twenty readers start: ${run.out}`);
  assert(/\nok=20/.test(run.out), `and all twenty return bytes: ${run.out}`);
  assert(/fail=0/.test(run.out), `and none of them fails: ${run.out}`);
  assert(/complete=yes/.test(run.out), `and the run signals completion: ${run.out}`);
});

test('A READER THAT DEMANDED NOTHING IS NOT AN OPEN, where `dd`\'s exit status called it one', () => {
  // THE DEFECT, MEASURED, AND IT IS LIVE. `dd` exits 0 for a read that landed entirely past EOF, so
  // `if dd …; then echo ok` recorded twenty successes over twenty reads that moved no bytes. Measured
  // against the merge base with a 1 MiB object: started=20, ok=20, fail=0. G25 divides ONE resolution by
  // that count, so a stampede that placed no demand at all still produced a single-flight verdict.
  //
  // THE CALLER'S HALF OF THIS IS IN THE GATE and is not reachable from here: `--opens` was counted from the
  // `.started` files, which are written the instant each job is launched, and nothing ever opened a `.done`.
  // That call site is exercised by running the lease gate itself; what this case pins is the program.
  requireDocker();
  const run = runInImage(stampedeFixture(1024 * 1024), 'case.sh');
  assertEq(run.code, 0, `the stampede still completes — the readers fail, not the harness: ${run.out}`);
  assert(/started=20/.test(run.out), `all twenty readers still start: ${run.out}`);
  assert(/\nok=0/.test(run.out), `but none of them may be recorded as having read anything: ${run.out}`);
  assert(/fail=20/.test(run.out), `and all twenty are recorded as failures: ${run.out}`);
});

// ---------------------------------------------------------------------------------------------------------
// `out/baseline.sh` — the honest half, which needs a real POSIX mode and therefore a container
// ---------------------------------------------------------------------------------------------------------

test('THE BASELINE STILL ACCEPTS A READ-ONLY REGULAR FILE AND REFUSES EVERY OTHER SHAPE', () => {
  requireDocker();
  const dir = scratch();
  writeFileSync(join(dir, 'baseline.sh'),
    `${heredoc('deploy/projection-emby-dataplane-gate.sh', 'out/baseline.sh')}\n`, 'utf8');
  writeFileSync(join(dir, 'case.sh'), [
    'set -u',
    'mkdir -p /mnt/Movies',
    'head -c 2048 /dev/zero > "/mnt/Movies/ok.mkv"; chmod 444 "/mnt/Movies/ok.mkv"',
    'head -c 2048 /dev/zero > "/mnt/Movies/writable.mkv"; chmod 644 "/mnt/Movies/writable.mkv"',
    'head -c 2048 /dev/zero > "/mnt/Movies/placeholder.strm"; chmod 444 "/mnt/Movies/placeholder.strm"',
    'ln -s "/mnt/Movies/ok.mkv" "/mnt/Movies/link.mkv"',
    'for c in ok.mkv writable.mkv placeholder.strm link.mkv missing.mkv; do',
    '  su nobody -s /bin/sh -c "sh /w/baseline.sh Movies/$c" >/dev/null 2>&1',
    '  echo "$c=$?"',
    'done',
    '',
  ].join('\n'), 'utf8');
  const run = runInImage(dir, 'case.sh');
  assert(/ok\.mkv=0/.test(run.out), `a read-only regular file is the shape it accepts: ${run.out}`);
  assert(/writable\.mkv=1/.test(run.out), `a writable file is not read-only: ${run.out}`);
  assert(/placeholder\.strm=1/.test(run.out), `a .strm placeholder is not a projected file: ${run.out}`);
  assert(/link\.mkv=1/.test(run.out), `a symlink is what a media server must not see: ${run.out}`);
  assert(/missing\.mkv=1/.test(run.out), `and an absent target is not a baseline: ${run.out}`);
});

// ---------------------------------------------------------------------------------------------------------
// `out/gen-corpus.sh` — the ~50-entry corpus generator, which writes to a hard-coded `/work`
// ---------------------------------------------------------------------------------------------------------
//
// WHY IT IS HERE AND NOT IN THE OFFLINE SUITE. Its argument validation runs before it touches a path, so the
// sibling suite covers that; everything below the first encode writes to `/work/media` and `/work/remote`,
// which are the directories its gate bind-mounts. Creating `/work` on a developer's machine to satisfy a
// test is modifying the machine to fit the measurement, so the encoding path is measured here — in the
// gates' own pinned image, under the busybox `sh` that actually runs it rather than under bash.

const GEN_CORPUS_GATES = [
  'deploy/projection-plex-dataplane-gate.sh',
  'deploy/projection-emby-dataplane-gate.sh',
  'deploy/projection-jellyfin-dataplane-gate.sh',
  'deploy/projection-three-server-concurrency-gate.sh',
  'deploy/projection-rclone-comparison-gate.sh',
] as const;

/**
 * The shipped generator, a stub encoder, and `/work` — built inside the container.
 *
 * THE ENCODER IS A STUB AND THAT IS THE POINT. What is under test is what the generator does with the
 * encoder's OUTCOME, not ffmpeg. `bytes` decides whether the stub leaves a file with content or an empty
 * one, which is the case the merge base could not tell apart from success.
 */
function genCorpusFixture(gate: string, bytes: 'some' | 'none', argv: string): string {
  const dir = scratch();
  writeFileSync(join(dir, 'gen-corpus.sh'), `${heredoc(gate, 'out/gen-corpus.sh')}\n`, 'utf8');
  writeFileSync(join(dir, 'case.sh'), [
    'set -u',
    'mkdir -p /work/media /work/remote',
    "printf '#!/bin/sh\\nout=\"\"\\nfor a in \"$@\"; do out=\"$a\"; done\\n' > /ff",
    bytes === 'some'
      ? `printf 'printf %s > "$out"\\n' 'AAAA' >> /ff`
      : 'printf \': > "$out"\\n\' >> /ff',
    'chmod +x /ff',
    `sh /w/gen-corpus.sh ${argv} /ff`,
    'status=$?',
    'echo "GENERATOR EXITED $status"',
    'echo "MEDIA $(ls /work/media | wc -l) REMOTE $(ls /work/remote | wc -l)"',
    'exit $status',
    '',
  ].join('\n'), 'utf8');
  return dir;
}

test('THE CORPUS GENERATOR STILL GENERATES, and now says how many files it VERIFIED', () => {
  requireDocker();
  for (const gate of GEN_CORPUS_GATES) {
    const run = runInImage(genCorpusFixture(gate, 'some', '3 1'), 'case.sh');
    assertEq(run.code, 0, `${gate}: an honest generation must pass: ${run.out}`);
    assert(/generated 3 corpus files/.test(run.out), `${gate}: and count what it made: ${run.out}`);
    // ONE LOCAL AND TWO REMOTE, OR THE REVERSE ON THE COMPARISON GATE, WHICH PUTS ITS LOCAL ENTRIES LAST.
    // Either way three files exist; asserting the split per gate would be asserting the one line they are
    // allowed to differ on, which the sibling suite already pins.
    assert(/MEDIA [12] REMOTE [12]/.test(run.out), `${gate}: and write three files: ${run.out}`);
  }
});

test('AN ENCODER THAT EXITED 0 AND WROTE NOTHING NOW FAILS, where the generator counted it as generated',
  () => {
    // THE DEFECT, MEASURED. The generator never looked at what the encoder left. Against the merge base a
    // stub that exits 0 having created three EMPTY files produced `generated 3 corpus files` and EXIT 0, and
    // the zero-byte entries then failed their digest comparison forty steps later inside a gate whose
    // subject is a media server. The claim and the artefact disagreed and only the claim was read.
    requireDocker();
    for (const gate of GEN_CORPUS_GATES) {
      const run = runInImage(genCorpusFixture(gate, 'none', '3 1'), 'case.sh');
      assert(run.code !== 0, `${gate}: an empty corpus entry must fail the generation: ${run.out}`);
      assert(/left no bytes in/.test(run.out), `${gate}: and name the file: ${run.out}`);
      assert(!/generated 3 corpus files/.test(run.out),
        `${gate}: and must not also claim it generated them: ${run.out}`);
      // AND IT MUST STOP AT THE FIRST ONE rather than encode forty-seven more into a corpus it has already
      // proved is not fit to be one.
      assert(/MEDIA 1 REMOTE 0|MEDIA 0 REMOTE 1/.test(run.out),
        `${gate}: and stop at the first bad file rather than generate the rest: ${run.out}`);
    }
  });

test('THE BUSYBOX SHELL REFUSES A COUNT THAT IS NOT A COUNT, which is the shell the gates actually use',
  () => {
    // THE OFFLINE SUITE RUNS THIS UNDER BASH. `[` is a builtin whose failure message and status differ
    // between bash and busybox ash, and the defect was that a `[` failure in a `while` CONDITION is exempt
    // from `set -e` — a property of the SHELL. Measuring it in only one shell would leave the claim resting
    // on the one that does not ship.
    requireDocker();
    for (const argv of ['"" 1', 'abc 1', '0 0', '2 4']) {
      const run = runInImage(genCorpusFixture(GEN_CORPUS_GATES[0], 'some', argv), 'case.sh');
      assert(run.code !== 0, `${argv}: must be refused under busybox sh: ${run.out}`);
      assert(/gen-corpus:/.test(run.out), `${argv}: and named: ${run.out}`);
      assert(/MEDIA 0 REMOTE 0/.test(run.out), `${argv}: and nothing generated: ${run.out}`);
      assert(!/generated/.test(run.out), `${argv}: and no corpus claimed: ${run.out}`);
    }
  });

// ---------------------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------------------

test('this suite is wired where a docker-requiring suite belongs, and NOT in the no-requirements chain', () => {
  // THE AGGREGATE IS THE SUITES THAT NEED NOTHING. `AGGREGATE_SUITE_COMMAND` filters on an empty `requires`,
  // so a docker suite appearing in it would mean the chain silently stopped being runnable on a bare host.
  // Asserting its ABSENCE there is the wiring check for a suite of this kind; membership is asserted in the
  // inventory instead, which is what `--group docker` spawns from.
  assert(!AGGREGATE_SUITE_COMMAND.includes('projection-gate-mount-programs'),
    'a suite that requires docker must not be in the chain that is meant to need nothing');
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:projection-gate-mount-programs'],
    'tsx test/projection-gate-mount-programs.ts',
    'the suite is wired into package.json under its own name');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as {
    suites: Array<{ file: string; group: string; requires?: string[] }>;
  };
  const entry = inventory.suites.find((s) => s.file === 'projection-gate-mount-programs.ts');
  assert(entry !== undefined, 'the suite is named in the inventory');
  assertEq(entry.group, 'docker', 'in the docker group, because it cannot run without one');
  assert((entry.requires ?? []).includes('docker'),
    'and declares that requirement, so a host without docker is told rather than reporting a pass');
});

for (const dir of scratchDirs) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* a scratch left behind fails nothing */ }
}

console.log('');
console.log(`${passed} passed, ${failed} failed`);
for (const [name, error] of failures) console.log(`  - ${name}: ${(error as Error).message}`);
if (failed > 0) process.exit(1);
