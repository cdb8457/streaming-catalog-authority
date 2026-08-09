/**
 * PROJECTION PHASE 2b — THE MULTI-FRONTEND COMPARISON HARNESS, PINNED OFFLINE.
 *
 * WHAT THIS SUITE IS FOR. The harness itself needs three media servers, two endpoints, three FUSE mounts and
 * a host with /dev/fuse; it has never run. What can be checked everywhere, in seconds, is that the thing is
 * wired, that its skip contract is intact, that its embedded programs parse and RUN, and that the four
 * defects found reading it stay fixed. Every assertion below fails against the harness as it arrived in this
 * worktree and passes after — which is the only form of "fixed" this tranche accepts.
 *
 * AND IT PINS THE HONESTY OF THE DOCUMENT, because that is what went wrong four times in Phase 1: a run
 * record that said more than a run had shown. The bake-off document's rows say NOT RUN, and while they do,
 * nothing else may say otherwise.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logicalLines, parseShellSource } from './helpers/shell-source.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const GATE = 'deploy/projection-multi-frontend-comparison-gate.sh';
const OPTIONAL = 'deploy/projection-multi-frontend-comparison-gate-optional.sh';
const BAKEOFF = 'docs/PROJECTION_PHASE_2_RCLONE_BAKEOFF.md';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];
const skippedBlocks: string[] = [];

const skipBlock = (what: string): void => {
  skippedBlocks.push(what);
  console.log(`  ..  SKIPPED on ${process.platform}: ${what}`);
};

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push([name, error]);
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
}

console.log('Projection Phase 2b — multi-frontend comparison harness (offline)');

// -----------------------------------------------------------------------------------------------------------
// WIRED, AND SHAPED LIKE THE REST.
// -----------------------------------------------------------------------------------------------------------

test('THE HARNESS AND ITS OPTIONAL ENTRY POINT EXIST AND ARE WIRED', () => {
  const gate = read(GATE);
  assert(gate.startsWith('#!/usr/bin/env bash'), 'the harness is not a bash script');
  assert(/^set -Eeuo pipefail$/m.test(gate), 'the harness does not fail fast');
  assert(gate.includes('projection-gate-cleanup.sh'), 'the harness does not source the shared cleanup contract');

  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['go:multi-frontend-comparison'], `bash ${GATE}`, 'the harness has no npm entry point');
  assertEq(pkg.scripts['go:multi-frontend-comparison:optional'], `bash ${OPTIONAL}`,
    'the optional entry point is not wired');

  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string }> };
  assert(inventory.suites.some((suite) => suite.file === 'projection-multi-frontend.ts'),
    'this suite is not in the inventory, so the aggregate run never executes it');
});

test('THERE IS NO :three WRAPPER, because a harness closes nothing', () => {
  // Every acceptance gate has one and this deliberately does not. A `:three` on a thing with no pass
  // threshold would announce a closure it cannot deliver, which is the exact class Phase 1 spent four
  // dispatches removing from documents and from wrappers that PRINTED it.
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['go:multi-frontend-comparison:three'] === undefined,
    'a :three wrapper implies three-run acceptance closure that this harness has no threshold to support');
  assert(read(OPTIONAL).includes('NOTHING WAS MEASURED'),
    'the optional entry point does not say that a skip measured nothing');
});

// -----------------------------------------------------------------------------------------------------------
// DEFECT 1 — THE SKIP PATH COULD NOT SKIP.
// -----------------------------------------------------------------------------------------------------------

test('THE SKIP CONTRACT IS 77, AND THE VARIABLE THAT CARRIES IT IS DEFINED', () => {
  // `$GATE_SKIP_STATUS` was referenced twice and assigned nowhere. Under `set -u` that is not a wrong exit
  // code, it is an abort: on a host with no /dev/fuse the harness died with an unbound-variable error and
  // exit 1 — the status this repository reserves for a gate that RAN AND FAILED — on precisely the hosts the
  // skip exists for.
  const gate = read(GATE);
  // Comments talk ABOUT the variable; only code reads it. The line numbers below are of the code.
  const lines = gate.split('\n').map((line) => (line.trimStart().startsWith('#') ? '' : line));
  const assignment = lines.findIndex((line) => line.includes('GATE_SKIP_STATUS="${GATE_SKIP_STATUS:-77}"'));
  assert(assignment >= 0, 'GATE_SKIP_STATUS is never given a value, so `set -u` aborts the skip path');
  const early = lines.findIndex((line, index) => index < assignment && /\$\{?GATE_SKIP_STATUS/.test(line));
  assert(early === -1,
    `GATE_SKIP_STATUS is read at line ${early + 1}, before it is assigned at line ${assignment + 1}, `
    + 'so the skip path still aborts under `set -u`');
  assert(/exit "\$GATE_SKIP_STATUS"/.test(gate), 'the skip does not exit with the skip status');

  // ...and the -optional entry point is the ONLY place 77 folds to 0.
  assert(!/exit 0/.test(gate.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')),
    'the harness itself folds a status to 0; only the -optional entry point may do that');
  assert(read(OPTIONAL).includes('exit 0'), 'the optional entry point does not fold the skip');
});

// -----------------------------------------------------------------------------------------------------------
// DEFECT 2 — TEARDOWN REMOVED CONTAINERS AND LEFT MOUNTS.
// -----------------------------------------------------------------------------------------------------------

test('TEARDOWN GOES THROUGH THE SHARED HELPER, so a leftover FUSE mount is unmounted and then REPORTED', () => {
  // Removing the container that served a mount does not remove the mount: it stays attached to the host, and
  // three arms times three media servers holding handles is nine chances to leave one behind. The harness's
  // own cleanup removed containers, the compose project and the network, and nothing else — no unmount, no
  // run-directory removal, and no report saying which.
  const gate = read(GATE);
  const cleanup = gate.slice(gate.indexOf('cleanup() {'), gate.indexOf('trap cleanup EXIT'));
  assert(cleanup.length > 0, 'the harness has no cleanup function');
  assert(cleanup.includes('projection_gate_cleanup_run'),
    'cleanup never unmounts the run directory, so every arm can leave a FUSE mount attached to the host');
  assert(cleanup.includes('projection_gate_report_cleanliness'),
    'cleanup never reports what it left behind, so a cleanup that did not work is indistinguishable from one that did');
  assert(/trap cleanup EXIT/.test(gate), 'cleanup is not armed on every exit path');
});

// -----------------------------------------------------------------------------------------------------------
// DEFECT 3 — A PORT BLOCK THAT COLLIDED WITH THE VERY GATE THIS HARNESS EXTENDS.
// -----------------------------------------------------------------------------------------------------------

test('THE HARNESS OWNS ITS PORTS, and the comment that says so is true', () => {
  // The block was 8130/8131/8132/32530/5573 — five ports belonging to `projection-rclone-comparison-gate.sh`,
  // which is the ONE gate an operator would run beside this one, since this harness exists to extend its
  // comparison. The comment above them claimed no other gate could collide.
  const gate = read(GATE);
  const mine = new Set(
    [...gate.matchAll(/^[A-Z_]*PORT="\$\{[A-Z_]+:-([0-9]+)\}"/gm)].map((match) => match[1] as string));
  assert(mine.size >= 9, `expected the harness to declare its own port block, found ${mine.size}`);

  const others = new Map<string, string[]>();
  for (const file of ['projection-rclone-comparison-gate.sh', 'projection-real-provider-gate.sh',
    'projection-serve-death-gate.sh', 'projection-stale-mount-gate.sh', 'projection-sustained-outage-gate.sh',
    'projection-lease-gate.sh', 'projection-publisher-mount-gate.sh', 'projection-plex-dataplane-gate.sh',
    'projection-jellyfin-dataplane-gate.sh', 'projection-emby-dataplane-gate.sh',
    'projection-path-lifecycle-gate.sh', 'projection-three-server-concurrency-gate.sh']) {
    for (const match of read(`deploy/${file}`).matchAll(/:-([0-9]{4,5})\}/g)) {
      const port = match[1] as string;
      others.set(port, [...(others.get(port) ?? []), file]);
    }
  }
  for (const port of mine) {
    assert(!others.has(port),
      `port ${port} is also claimed by ${(others.get(port) ?? []).join(', ')}; running the harness beside `
      + 'that gate binds the same host port twice');
  }
});

// -----------------------------------------------------------------------------------------------------------
// DEFECT 4 — A TEARDOWN ASSERTION THAT PASSED ON DOCKER'S OWN REFUSAL.
// -----------------------------------------------------------------------------------------------------------

test('THE NAMESPACE-GONE CHECK READS THE PROBE\'S VERDICT, not docker run\'s exit status', () => {
  // `if ! docker run ... test -d /mnt/Movies; then gone=1` cannot fail for the reason it states: docker
  // reports its OWN refusals as 125/126/127 before `test` runs, and the leading `!` scores every one of them
  // as "the namespace is gone". The step whose entire subject is whether a mount was left attached therefore
  // passed hardest when nothing had been looked at.
  const gate = read(GATE);
  const body = gate.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert(!/if !\s*docker run[^\n]*test -d \/mnt\/Movies/.test(body),
    'a teardown check is back to branching on docker run\'s exit status');
  for (const token of ['ns:present', 'ns:absent']) {
    assert(gate.includes(token), `the namespace probe does not emit '${token}', so it cannot say what it saw`);
  }
  // ...and the third outcome — the probe never ran — is refused rather than folded into either answer.
  const helper = gate.slice(gate.indexOf('namespace_gone() {'));
  assert(/never ran in .* attempts/.test(helper),
    'a probe that docker refused every time is scored as an observation instead of as no observation');
  // Both arms go through the one helper, so neither can drift back.
  assertEq((gate.match(/^\s*namespace_gone "/gm) ?? []).length, 2,
    'both arms must use the shared namespace_gone helper');
});

// -----------------------------------------------------------------------------------------------------------
// DEFECT 5 — AN EMBEDDED PROGRAM THE SHARED READER COULD NOT PARSE, AND NOW ONE THAT IS RUN.
// -----------------------------------------------------------------------------------------------------------

test('EVERY EMBEDDED PROGRAM IS A QUOTED HEREDOC, and the whole script parses', () => {
  // Both operational-round writers were multi-line `node -e '...'` arguments. `parseShellSource` — the reader
  // `test/custody-runtime-closure.ts` runs over every shipped script — stopped at the unterminated quote,
  // which means the programs were unreadable to every test in this repository and unchecked by all of them.
  const gate = read(GATE);
  // The defect shape is an opening quote with the program on the FOLLOWING lines. A prose mention of
  // `node -e '...'` inside a comment is not one, so the match is anchored to end-of-line.
  assert(!/node -e '\s*$/m.test(gate),
    'an embedded program is inlined as a multi-line single-quoted argument, which the shared reader cannot parse');
  // The same reader `test/custody-runtime-closure.ts` runs, under the same line endings: `logicalLines` is
  // what throws on an unterminated quote or an unclosed heredoc, so it is what has to be called.
  for (const [what, eol] of [['LF (a POSIX checkout)', '\n'], ['CRLF (a Windows checkout)', '\r\n']] as const) {
    const lines = logicalLines(parseShellSource(gate.replace(/\r?\n/g, eol), `${GATE} (${what})`));
    assert(lines.length > 0, `${GATE} (${what}) yields no logical lines`);
  }
  // Unquoted heredoc delimiters let the shell expand the program before it is written.
  assert(!/<<-?[A-Za-z_]/.test(gate), 'an unquoted heredoc lets the shell rewrite an embedded program');
});

/**
 * A POSIX shell that can actually execute a script here, CHOSEN BY RUNNING ONE — never by `process.platform`.
 * `d4f3265` records a figure published twice that was never measured, because a suite picked its shell by
 * name and PATH order decided whether anything was checked.
 */
function workingShell(): string | undefined {
  for (const candidate of ['sh', 'bash', 'C:/Program Files/Git/usr/bin/sh.exe']) {
    const probe = spawnSync(candidate, ['-c', 'echo shell:ok'], { encoding: 'utf8', timeout: 20_000 });
    if (probe.error === undefined && probe.status === 0 && probe.stdout.includes('shell:ok')) return candidate;
  }
  return undefined;
}

/** A program exactly as the harness writes it, taken from the harness rather than restated. */
function extractHeredoc(delimiter: string): string {
  const gate = read(GATE);
  const open = gate.indexOf(`<<'${delimiter}'\n`);
  assert(open >= 0, `the harness no longer writes ${delimiter} through a quoted heredoc`);
  const start = gate.indexOf('\n', open) + 1;
  const end = gate.indexOf(`\n${delimiter}\n`, start);
  assert(end > start, `the ${delimiter} heredoc does not terminate`);
  return gate.slice(start, end);
}

test('THE SHIPPED ROUNDS PROGRAM IS RUN, and it writes the record the comparison reads', () => {
  // The one program this port rewrote. A regex would pass against a version that wrote the wrong shape, and
  // the comparison table at the end of a three-arm run is assembled from three of these files.
  const program = extractHeredoc('ROUNDS');
  const dir = mkdtempSync(join(tmpdir(), 'mf-rounds-'));
  const script = join(dir, 'rounds.cjs');
  writeFileSync(script, program);
  const out = join(dir, 'operational-rounds.json');

  const run = spawnSync(process.execPath, [script, out, 'arm-a', 'true', '4210', '2', '1830', '7'],
    { encoding: 'utf8', timeout: 120_000 });
  assert(run.error === undefined, `the shipped rounds program could not be executed: ${String(run.error)}`);
  assertEq(run.status, 0, `the shipped rounds program exited ${String(run.status)}: ${run.stderr}`);

  const record = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
  assertEq(record['arm'], 'arm-a', 'the record does not name its arm');
  assertEq(JSON.stringify(record['r1']), JSON.stringify({ stallBound: true, stallMs: 4210 }), 'R1 is not recorded');
  assertEq(JSON.stringify(record['r2']), JSON.stringify({ convergedOnRead: 2 }), 'R2 is not recorded');
  assertEq(JSON.stringify(record['r3']), JSON.stringify({ readyMs: 1830 }), 'R3 is not recorded');
  assertEq(record['resolutions'], 7, 'the resolution count is not recorded');

  // `stallBound` is a STRING comparison against 'true' in the shipped program, and that is the whole reason
  // to run it: any other string must be false, not truthy.
  const second = spawnSync(process.execPath, [script, out, 'arm-b', 'false', '0', '1', '900', '0'],
    { encoding: 'utf8', timeout: 120_000 });
  assertEq(second.status, 0, `the shipped rounds program exited ${String(second.status)}: ${second.stderr}`);
  const other = JSON.parse(readFileSync(out, 'utf8')) as { r1: { stallBound: boolean } };
  assertEq(other.r1.stallBound, false, 'a non-"true" stall flag must be recorded as false, not as truthy');
});

test('THE SHIPPED NAMESPACE PROBE IS RUN, against a stub docker that answers, and one that refuses', () => {
  // The fix is only a fix if a docker that cannot start is NOT read as "the namespace is gone". That is a
  // property of the shell, so the shell runs it: the helper is extracted with a stub `docker` on PATH and a
  // `die` that records rather than exits.
  const gate = read(GATE);
  const open = gate.indexOf('namespace_gone() {');
  assert(open >= 0, 'the harness no longer has a namespace_gone helper');
  const helper = gate.slice(open, gate.indexOf('\n}\n', open) + 3);

  const shell = workingShell();
  if (shell === undefined) {
    skipBlock('executing the shipped namespace_gone helper against a stub `docker` '
      + '(no POSIX shell on this host could execute a script)');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'mf-nsgone-'));
  const shPath = (path: string): string =>
    path.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_m, drive: string) => `/${drive.toLowerCase()}/`);

  const runHelper = (dockerBody: string, args: string): { status: number | null; stdout: string } => {
    const stub = join(dir, 'docker');
    writeFileSync(stub, `#!/bin/sh\n${dockerBody}\n`);
    chmodSync(stub, 0o755);
    const script = join(dir, 'drive.sh');
    // `die` here records the refusal and exits non-zero, exactly as the harness's own die does.
    writeFileSync(script, [
      '#!/bin/sh',
      'ARM_MNT=/tmp/mnt', 'VERIFY_IMAGE=stub', 'die() { echo "GATE FAILED: $*"; exit 1; }',
      helper,
      `namespace_gone ${args} && echo helper:gone || echo helper:still-there`,
    ].join('\n') + '\n');
    const run = spawnSync(shell, ['-c',
      `PATH="${shPath(dir)}:$PATH" exec "${shPath(script)}"`], { encoding: 'utf8', timeout: 120_000 });
    assert(run.error === undefined, `the shipped helper could not be executed: ${String(run.error)}`);
    return { status: run.status, stdout: run.stdout };
  };

  // 1. The probe RAN and saw nothing: the namespace really is gone.
  const absent = runHelper('echo ns:absent', '"the daemon" 4');
  assert(absent.stdout.includes('helper:gone'),
    `a probe reporting ns:absent must mean the namespace is gone: ${absent.stdout}`);

  // 2. The probe RAN and saw the mount every time: the namespace is still there, and the helper says so
  //    rather than timing out silently.
  const present = runHelper('echo ns:present', '"the daemon" 3');
  assert(present.stdout.includes('helper:still-there'),
    `a probe reporting ns:present must NOT be read as gone: ${present.stdout}`);

  // 3. THE ONE THAT MATTERS. Docker refused the probe every time — the 125 an unstartable container gives —
  //    and the helper must refuse to draw any conclusion, rather than reporting the namespace gone.
  const refused = runHelper('exit 125', '"the daemon" 3');
  assert(!refused.stdout.includes('helper:gone'),
    `docker's own refusal was scored as the namespace being gone: ${refused.stdout}`);
  assert(/never ran/.test(refused.stdout),
    `a probe that never ran must be refused by name, got: ${refused.stdout}`);
});

// -----------------------------------------------------------------------------------------------------------
// THE DOCUMENT MAY NOT SAY MORE THAN A RUN HAS SHOWN.
// -----------------------------------------------------------------------------------------------------------

test('WHILE THE BAKE-OFF RUN RECORD SAYS NOT RUN, NOTHING MAY CLAIM A FIGURE', () => {
  const doc = read(BAKEOFF);
  const flat = doc.replace(/\s+/g, ' ');
  assert(/\*\*NOT RUN\.\*\*/.test(doc), 'the bake-off document carries no NOT RUN marker');

  // Placeholder rows only: a row with a host or a number in it is a claim, and a claim while the marker
  // above it still says NOT RUN is the contradiction this repository exists to prevent.
  const rows = (doc.match(/^\| [A-C] \|.*$/gm) ?? []).map((row) => row.trim());
  assert(rows.length >= 3, 'the bake-off document has no per-arm run-record rows');
  for (const row of rows) {
    assert(/^\| [A-C] \|( — \|)+$/.test(row), `a bake-off run record is filled while the document says NOT RUN: ${row}`);
  }
  for (const stale of [/the naive path (is|was) (slower|worse|beaten)/i, /projectiond (wins|won|beats)/i,
    /\bmeasured\b[^.|]{0,40}\b(MiB|ms|seconds)\b/i]) {
    assert(!stale.test(flat), `the bake-off document states a figure no run produced: ${String(stale)}`);
  }
  // The harness names three arms and the document must name the same three, including WHY there is no mount2.
  for (const arm of ['projectiond', '--vfs-cache-mode off', '--vfs-cache-mode full']) {
    assert(doc.includes(arm), `the bake-off document does not name the ${arm} arm`);
  }
  assert(/mount2/.test(doc), 'the document does not record why the designed mount2 arm does not exist');
});

console.log(`\nProjection Phase 2b — multi-frontend comparison harness: ${passed} passed, ${failed} failed`
  + (skippedBlocks.length > 0 ? `, ${skippedBlocks.length} block(s) skipped on ${process.platform}` : ''));
for (const what of skippedBlocks) console.log(`  skipped: ${what}`);
if (failed > 0) {
  for (const [name, error] of failures) console.error(`  FAILED: ${name}: ${String(error)}`);
  process.exit(1);
}
