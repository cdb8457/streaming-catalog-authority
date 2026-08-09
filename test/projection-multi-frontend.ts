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

test('THE COMPOSE FILE IS COMMITTED AND THE GATE ROOT IS IGNORED, like every other gate here', () => {
  // The harness wrote its compose file into the repository root on every run and never removed it, so a run
  // left an untracked file behind and the only description of the shared Postgres lived inside an
  // 1,800-line script. Every other `docker-compose.projection-*.yml` is a tracked file the gate merely names.
  const gate = read(GATE);
  assert(!/cat > "\$COMPOSE_FILE"/.test(gate),
    'the harness generates its compose file, so a run leaves an untracked file in the working tree');
  assert(gate.includes('COMPOSE_FILE="docker-compose.projection-multi-frontend.yml"'),
    'the harness does not name the committed compose file');
  const compose = read('docker-compose.projection-multi-frontend.yml');
  assert(/name: projection-multi-frontend-comparison/.test(compose), 'the compose project is unnamed');
  assert(/tmpfs:/.test(compose) && /\/var\/lib\/postgresql\/data/.test(compose),
    'the compose Postgres keeps its storage across runs, so an arm can inherit state from a previous one');
  assert(/\$\{PROJECTION_MULTI_FRONTEND_GATE_PG_PORT:-5515\}/.test(compose),
    'the compose file does not take its port from the same variable the harness exports');

  // ...and the run directory, which holds two throwaway credentials and three arms' caches, is ignored.
  assert(read('.gitignore').split('\n').some((line) => line.trim() === '.projection-multi-frontend-comparison-gate/'),
    'the gate root is not gitignored, so an interrupted run leaves credentials where `git add -A` reaches them');
});

test('A CREDENTIAL ASSERTION PROBES THE PATH THE CREDENTIAL ACTUALLY GUARDS', () => {
  // Arm A's credential checks probed `/direct/<ref>` with a wrong bearer token and expected a refusal.
  // `/direct/` is UNAUTHENTICATED BY CONSTRUCTION — `handleDirect` calls `serveRange` with no auth check,
  // because in direct mode the URL is the capability; only `handleResolve` compares the Authorization
  // header. So the endpoint answered 206 to the wrong token exactly as designed, and the harness died with
  // "the endpoint served a ranged request with the wrong credential" on the first real run — an accusation
  // aimed at the one path that never made the promise. /resolve is also what the daemon calls in resolver
  // mode, so it is what R2 rotates: probing it is both correct and the point.
  const gate = read(GATE);
  const body = gate.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  // A /direct/ probe with the RIGHT token is a liveness check and is fine — the path is Range-only and the
  // 206 is the point. What may never live there is a CREDENTIAL assertion: a wrong token expecting refusal,
  // or the rotation checks, both of which /direct/ answers 206 to by design.
  for (const line of body.split('\n')) {
    if (!/probe\.sh "http:\/\/fakerange:8099\/direct\//.test(line)) continue;
    assert(!/not-the-token|ROTATED_TOKEN/.test(line),
      `a credential assertion probes /direct/, which enforces no credential at all: ${line.trim()}`);
  }
  assert(!/\$\(resolve_probe/.test(body) || /ROT_OLD="\$\(resolve_probe "\$ARM_TOKEN"\)"/.test(body),
    'the post-rotation check no longer goes through the credential-guarded path');
  assert(/resolveprobe\.sh/.test(body), 'there is no probe against the credential-guarded /resolve path');
  // ...and it reads the probe's own verdict, with the never-ran case refused rather than folded in.
  for (const token of ['resolve:200', 'resolve:401']) {
    assert(body.includes(token), `the resolve probe's verdict '${token}' is never matched`);
  }
  assert(/the credential probe never ran against the endpoint/.test(body),
    'a resolve probe that produced no status is not refused as a third outcome');
  // The status is parsed by pattern, not by column: busybox prints its own `wget: server returned error:
  // HTTP/1.1 401 ...` diagnostic, and taking $2 of any HTTP-matching line yielded `resolve:server`.
  assert(/grep -oE 'HTTP\/\[0-9\.\]\+ \[0-9\]\{3\}'/.test(gate),
    'the resolve probe no longer extracts the status code by pattern, so busybox\'s own diagnostic line can '
    + 'be misread as the status');
  // The WebDAV endpoint DOES enforce on every request, so arms B/C keep probing /dav.
  assert(/probe\.sh "http:\/\/fakedav:8098\/dav\//.test(body),
    'arms B/C no longer probe the WebDAV path, which does enforce the credential on every request');
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

// -----------------------------------------------------------------------------------------------------------
// DEFECTS 6-8 — THREE WAYS THE HARNESS COULD NOT HAVE RUN AT ALL, pinned as CLASSES rather than as instances.
//
// None of these is subtle and none of them needed a host to find: they are ordinary "the file is not there
// yet" mistakes, and every one of them aborts the harness under `set -e` before an arm exists. They are
// checked generically — every write, every mkdir, every program — because the next one will be in a
// different line than the last one was.
// -----------------------------------------------------------------------------------------------------------

/** Non-comment lines, 1-indexed, with comment lines blanked so line numbers stay true. */
const codeLines = (text: string): string[] =>
  text.split('\n').map((line) => (line.trimStart().startsWith('#') ? '' : line));

/**
 * Logical statements with the line each STARTS on, backslash continuations joined.
 *
 * THIS IS NOT TIDINESS. The `mkdir -p` that made the daemon's config file a directory listed nine paths over
 * three continued lines, and `config.json` was on the third — a per-line scan reads the first line, sees
 * `mkdir -p`, and never looks at the argument that caused the bug. A check that only sees the head of a
 * wrapped command is a check with a blind spot exactly where long argument lists live.
 */
function statements(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const lines = codeLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const start = index;
    let joined = lines[index] as string;
    while (joined.endsWith('\\') && index + 1 < lines.length) {
      index += 1;
      joined = `${joined.slice(0, -1)} ${lines[index] as string}`;
    }
    out.push([start + 1, joined]);
  }
  return out;
}

test('EVERY FILE THE HARNESS WRITES HAS A DIRECTORY TO WRITE IT INTO', () => {
  // `$WORK/out` held every shared program — jq.cjs, sha.cjs, corpus.cjs, probe.sh, leakcheck.sh — and no
  // `mkdir` in the harness ever created it, so the first `cat >` aborted the run on every host before an
  // endpoint started. The two spellings of the run directory ($WORK absolute, $REL relative) are the same
  // place, so they are normalised before comparison.
  const norm = (path: string): string => path.replace('$ARM_REL', '$ARM_DIR').replace('$REL', '$WORK');
  const made: Array<[number, string]> = [];
  for (const [at, statement] of statements(read(GATE))) {
    if (!statement.trimStart().startsWith('mkdir -p')) continue;
    for (const match of statement.matchAll(/"([^"]+)"/g)) made.push([at, norm(match[1] as string)]);
  }
  for (const [at, statement] of statements(read(GATE))) {
    const match = /^cat > "([^"]+)"/.exec(statement.trim());
    if (match === null) continue;
    const target = norm(match[1] as string);
    if (!target.includes('/')) continue; // a file in the repository root needs no directory
    const parent = target.slice(0, target.lastIndexOf('/'));
    // `mkdir -p a/b/c` creates a, a/b and a/b/c, so an earlier mkdir satisfies this parent if it names the
    // parent, an ancestor of it, or a descendant of it.
    assert(made.some(([madeAt, dir]) => madeAt < at
      && (dir === parent || parent.startsWith(`${dir}/`) || dir.startsWith(`${parent}/`))),
    `line ${at}: ${match[1]} is written into ${parent}, which no earlier mkdir creates`);
  }
});

test('NO PATH IS MADE A DIRECTORY AND THEN WRITTEN TO AS A FILE', () => {
  // `mkdir -p "$WORK/arm-a/config.json"` made the daemon's configuration file a DIRECTORY, so the
  // `cat > "$WORK/arm-a/config.json"` below it could not write and arm A could not start.
  const norm = (path: string): string => path.replace('$ARM_REL', '$ARM_DIR').replace('$REL', '$WORK');
  const written = new Set<string>();
  for (const [, statement] of statements(read(GATE))) {
    const match = /^cat > "([^"]+)"/.exec(statement.trim());
    if (match !== null) written.add(norm(match[1] as string));
  }
  for (const [at, statement] of statements(read(GATE))) {
    if (!statement.trimStart().startsWith('mkdir -p')) continue;
    for (const match of statement.matchAll(/"([^"]+)"/g)) {
      const dir = norm(match[1] as string);
      assert(!written.has(dir),
        `line ${at}: mkdir creates ${match[1]} as a directory, but the harness later writes it as a file`);
    }
  }
});

test('EVERY EMBEDDED PROGRAM IS WRITTEN BEFORE THE FIRST THING THAT RUNS IT', () => {
  // `digest` is `node "$REL/out/sha.cjs"`, and the corpus step called it two hundred lines above the heredoc
  // that wrote the program — MODULE_NOT_FOUND, before any arm existed. A function DEFINITION naming a program
  // is fine; a CALL before the write is not.
  const text = read(GATE);
  const lines = codeLines(text);
  const writtenAt = new Map<string, number>();
  lines.forEach((line, index) => {
    const match = /^cat > "([^"]+)"/.exec(line.trim());
    if (match !== null) {
      const path = match[1] as string;
      writtenAt.set(path.slice(path.lastIndexOf('/') + 1), index + 1);
    }
  });
  // Helper name -> the program its body runs. Each is checked at its first CALL site.
  for (const [helper, program] of [['field', 'jq.cjs'], ['digest', 'sha.cjs'], ['wait_ready', 'alive.sh']]) {
    const write = writtenAt.get(program as string);
    assert(write !== undefined, `the harness no longer writes ${program}`);
    const definition = lines.findIndex((line) => new RegExp(`^${helper}\\(\\)`).test(line.trim()));
    assert(definition >= 0, `the harness no longer defines ${helper}()`);
    const call = lines.findIndex((line, index) =>
      index !== definition && new RegExp(`(^|[\\s("$])${helper}(\\s|$)`).test(line));
    if (call === -1) continue;
    assert(call + 1 > (write as number),
      `${helper} is first called at line ${call + 1}, but it runs ${program}, which is not written until line ${write}`);
  }
});

test('NODE IS NEVER HANDED THE ABSOLUTE SPELLING OF THE RUN DIRECTORY', () => {
  // The harness's own header states the rule: docker bind mounts get `$WORK` (absolute), node and tsx get
  // `$REL` (relative), "because an MSYS absolute path is not something a Windows node binary can open".
  // Six call sites broke it — `digest "$WORK/..."` and one `node ... "$WORK/..."` — and a Windows node
  // resolved `/c/Users/…` against the current drive and opened `C:\c\Users\…`, which is not a file.
  // A shell REDIRECTION of the same path is fine: the shell opens it, not node.
  for (const [index, line] of codeLines(read(GATE)).entries()) {
    const stripped = line.replace(/<\s*"\$(WORK|ARM_DIR)[^"]*"/g, '');
    assert(!/\b(node|npx tsx)\b[^|;]*"\$(WORK|ARM_DIR)\//.test(stripped),
      `line ${index + 1} hands node an absolute run-directory path: ${line.trim()}`);
  }
  assert(/digest\(\)\s*{\s*node "\$REL\/out\/sha\.cjs"/.test(read(GATE)),
    'digest() no longer runs the relative spelling of sha.cjs');
});

const shPath = (path: string): string =>
  path.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_m, drive: string) => `/${drive.toLowerCase()}/`);

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/**
 * A POSIX shell that can execute a file through this suite's path spelling, CHOSEN BY RUNNING ONE.
 *
 * A bare `echo` probe accepts WSL Bash on Windows even though the test later supplies MSYS `/c/...` paths.
 * Prefer Git Bash when installed and require every fallback to execute a real temporary script via `shPath`.
 */
function workingShell(): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'phase2b-shell-probe-'));
  const script = join(dir, 'probe.sh');
  writeFileSync(script, [
    '#!/bin/sh',
    'for tool in head tail mv sleep; do command -v "$tool" >/dev/null || exit 1; done',
    'echo shell:path-ok',
  ].join('\n') + '\n');
  chmodSync(script, 0o755);

  for (const candidate of ['C:/Program Files/Git/usr/bin/sh.exe', 'sh', 'bash']) {
    const probe = spawnSync(candidate, ['-c',
      `PATH="/usr/bin:/bin:$PATH" exec ${shellQuote(shPath(script))}`], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (probe.error === undefined && probe.status === 0 && probe.stdout.includes('shell:path-ok')) {
      return candidate;
    }
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

  const runHelper = (dockerBody: string, args: string): {
    status: number | null;
    stdout: string;
    stderr: string;
  } => {
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
      `PATH="${shPath(dir)}:/usr/bin:/bin:$PATH" exec "${shPath(script)}"`],
      { encoding: 'utf8', timeout: 120_000 });
    assert(run.error === undefined, `the shipped helper could not be executed: ${String(run.error)}`);
    assert(run.status !== null && run.status !== 126 && run.status !== 127,
      `the shipped helper was not executed (status ${String(run.status)}): ${run.stderr || '(no stderr)'}`);
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  };

  // 1. The probe RAN and saw nothing: the namespace really is gone.
  const absent = runHelper('echo ns:absent', '"the daemon" 4');
  assertEq(absent.status, 0, `the absent probe failed: ${absent.stderr || absent.stdout}`);
  assert(absent.stdout.includes('helper:gone'),
    `a probe reporting ns:absent must mean the namespace is gone: ${absent.stdout}`);

  // 2. The probe RAN and saw the mount every time: the namespace is still there, and the helper says so
  //    rather than timing out silently.
  const present = runHelper('echo ns:present', '"the daemon" 3');
  assertEq(present.status, 0, `the present probe driver failed: ${present.stderr || present.stdout}`);
  assert(present.stdout.includes('helper:still-there'),
    `a probe reporting ns:present must NOT be read as gone: ${present.stdout}`);

  // 3. THE ONE THAT MATTERS. Docker refused the probe every time — the 125 an unstartable container gives —
  //    and the helper must refuse to draw any conclusion, rather than reporting the namespace gone.
  const refused = runHelper('exit 125', '"the daemon" 3');
  assertEq(refused.status, 1, `a refused docker probe must fail closed: ${refused.stderr || refused.stdout}`);
  assert(refused.stdout.includes('GATE FAILED:'),
    `a refused docker probe did not report the closed failure: ${refused.stdout}`);
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
