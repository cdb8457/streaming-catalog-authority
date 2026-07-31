import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SPAWN_DEFAULTS, SCRIPT_TIMEOUT_MS, describeRun, removeQuietly, runScript, usableBash, usablePowerShell,
} from '../src/ops/usable-shell.js';
import {
  REQUIRED_SECRET_FILES, ROOT_KEY_SECRET_NAME, backupSetHasRing, requiredSecretFilesFor,
} from '../src/ops/backup-components.js';
import { runVerifiedCompleteBackup } from '../src/ops/complete-backup.js';
import { CUSTODY_MODE_FILENAME } from '../src/ops/custody-runtime-mode.js';
import { asMap, parseYaml } from '../src/ops/minimal-yaml.js';
import { fakeDumpText, fakeToolchain } from './helpers/fake-toolchain.js';
import {
  ShellSourceError,
  callSite,
  callSites,
  caseArm,
  caseBlock,
  code as shellCode,
  commandSubstitutions,
  functionBody,
  logicalLines,
  parseShellSource,
  textOf as shellText,
  withoutComment,
  words,
} from './helpers/shell-source.js';

// Phases 329-336 — closing the custody runtime, and closing the way it was being proved.
//
// -----------------------------------------------------------------------------------------------------
// WHY THIS SUITE EXISTS.
// -----------------------------------------------------------------------------------------------------
//
// Four custody gates had been failing in the release baseline for four consecutive tranches, and every one of
// the four reports that recorded them reached the same conclusion: pre-existing, another feature family,
// leave them alone. They were not a product defect. They were four assertions that cut a region out of a
// shell script by searching for a literal with a bare LF in it — `'\n}\n'`, `'\n  root-only)\n'` — and Git's
// default on Windows is `core.autocrlf=true`, so on an ordinary Windows checkout none of those literals is
// present in the bytes of the file.
//
// THE MISS WAS SILENT, AND THAT IS THE DEFECT WORTH A SUITE. `indexOf` answers `-1`, `slice(0, -1)` is a
// perfectly good string, and what came back was not "no match" — it was the rest of the file. One gate
// asserted the `write_custody_secret` helper performs no `chmod`; the region it actually searched ran past
// the helper into `write_secret_if_absent`, which chmods ordinary app secrets by design, and it reported a
// custody violation that did not exist. Another sliced from `-1` to `-1`, searched the empty string, and
// would have reported a violation just as loudly against a deleted file.
//
// These four failed closed. The identical mechanism can fail OPEN — an empty region satisfies every
// `!includes` gate ever written — and that version is the one nobody investigates. So the extractors are now
// parsers that REFUSE rather than return a region they are unsure of, and the first section below holds them
// to that on fixtures typed every way a checkout can be typed.
//
// -----------------------------------------------------------------------------------------------------
// AND ONE REAL PRODUCT DEFECT, FOUND WHILE TRACING THOSE FOUR.
// -----------------------------------------------------------------------------------------------------
//
// `deploy/local-runtime-setup.ps1` created `custodian_root_key` — the root wrapping key of the sidecar-managed
// KEK ring — through its ordinary secret writer, followed by a best-effort ACL whose failure was swallowed by
// an empty `catch`. Its Bash twin refuses: custody there goes through `deploy/write-custody-secret.mjs`, which
// establishes owner and mode on a descriptor and creates NOTHING on a host that cannot make that guarantee,
// naming Windows as such a host in as many words. The same installation step was a refusal on one platform
// and a silent success on the other, and the silent one produced the more dangerous artefact: a real root
// wrapping key with an unverifiable ACL, which every custody check in this project would then read as custody
// established. Section 6 holds both arms of that, on every host this suite runs on.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function refuses(fn: () => unknown, needle: string, msg: string): void {
  try { fn(); } catch (err) {
    assert((err as Error).message.includes(needle), `${msg}: expected "${needle}", got: ${(err as Error).message}`);
    return;
  }
  throw new Error(`${msg}: nothing was refused`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');
const WORK = mkdtempSync(join(tmpdir(), 'ca-custody-closure-'));
const POSIX = process.platform !== 'win32';
const HELPER = join(repoRoot, 'deploy', 'write-custody-secret.mjs');

const schemaVersion = (): number =>
  Number(/MIGRATION_VERSION\s*=\s*([0-9]+)/.exec(readRepo('src/db/schema-version.ts'))![1]);

/** The scripts whose custody behaviour this tranche is responsible for. */
const CUSTODY_SETUP_SCRIPTS = ['deploy/local-runtime-setup.sh', 'deploy/arcane-setup.sh'] as const;

/** A 64-character hex root key, the shape the helper generates. */
const A_ROOT_KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

/**
 * Which signal killed a child, whichever way this host encoded that.
 *
 * THREE ENCODINGS FOR ONE FACT. Node reports `signal: 'SIGTERM'` when it sees the child die of a signal; a
 * POSIX shell that outlives its child reports the conventional `128 + N`; and a Git-Bash/MSYS shell hands
 * back the RAW WAIT STATUS, `N << 8` — 3840 for SIGTERM, which is neither 143 nor obviously wrong-looking.
 * Asserting one of the three would make this suite pass or fail on which shell the host happened to provide,
 * which is exactly the class of accident this whole tranche exists to remove.
 */
function signalOf(run: SpawnSyncReturns<string>): number | null {
  if (run.signal === 'SIGTERM') return 15;
  if (run.signal === 'SIGINT') return 2;
  const status = run.status;
  if (typeof status !== 'number') return null;
  if (status > 128 && status < 256) return status - 128;
  if (status > 255 && status % 256 === 0) return status >> 8;
  return null;
}

/** The same script text, typed the three ways a checkout can type it. */
function eachLineEnding(lf: string): ReadonlyArray<readonly [string, string]> {
  return [
    ['LF (a POSIX checkout)', lf],
    ['CRLF (Git on Windows, core.autocrlf=true)', lf.replace(/\n/g, '\r\n')],
    ['CR (a classic-Mac checkout, and the one nobody tests)', lf.replace(/\n/g, '\r')],
  ] as const;
}

// ---------------------------------------------------------------------------------------------------------
// 1. The extractor cannot silently return the wrong region
// ---------------------------------------------------------------------------------------------------------

const FIXTURE = `#!/usr/bin/env bash
set -euo pipefail

write_custody_secret() {
  local name="$1"
  # This comment mentions chmod, chown and stat, and configures nothing.
  outcome="$(node "\${HELPER}" "\${DIR}/\${name}" --generate \\
    "\${UID}" "\${GID}")" || exit 1
  case "\${outcome}" in
    created*) echo "created" ;;
    *)        echo "kept" ;;
  esac
}

write_secret_if_absent() {
  local name="$1" value="$2"
  printf '%s\\n' "\${value}" > "\${DIR}/\${name}"
  chmod 0644 "\${DIR}/\${name}"
}

case "\${ACTION}" in
  bootstrap)
    TEMP="$(mktemp "\${DIR}/.mode.XXXXXXXXXX")"
    printf 'bootstrap\\n' > "\${TEMP}"
    mv -f "\${TEMP}" "\${MARKER}"
    ;;
  root-only)
    rm -f "\${MARKER}"
    ;;
  *)
    exit 3
    ;;
esac
`;

await test('a region is the same region whatever the checkout used for line endings', () => {
  // THE FOUR BASELINE FAILURES, REPRODUCED AS A UNIT TEST OF THE READER. Every one of them was this: the same
  // script, typed differently, answering differently.
  for (const [what, text] of eachLineEnding(FIXTURE)) {
    const source = parseShellSource(text, `fixture (${what})`);
    const custody = shellText(shellCode({ path: 'x', lines: functionBody(source, 'write_custody_secret') }).lines);
    assert(!/\bchmod\b/.test(custody), `${what}: the custody helper's body carries no chmod`);
    assert(custody.includes('--generate'), `${what}: and the body really is the helper's`);
    const ordinary = shellText(functionBody(source, 'write_secret_if_absent'));
    assert(/\bchmod\b/.test(ordinary), `${what}: while the ordinary writer's body does`);
    const rootOnly = shellText(caseArm(caseBlock(source, 'ACTION'), 'root-only'));
    assert(rootOnly.includes('rm -f'), `${what}: the root-only arm removes the marker`);
    assert(!rootOnly.includes('mktemp'), `${what}: and creates nothing`);
    assertEq(callSites(source, 'write_custody_secret').length, 0, `${what}: the fixture defines but never calls it`);
  }
});

await test('the OLD mechanism is shown failing on the same fixture, so nobody restores it', () => {
  // NOT A HISTORY LESSON — A GUARD. This asserts the precise arithmetic that cost four release baselines, so
  // that anybody tempted to go back to `indexOf` on a literal can see what it answers.
  const crlf = FIXTURE.replace(/\n/g, '\r\n');
  const body = crlf.slice(crlf.indexOf('write_custody_secret() {'));
  assertEq(body.indexOf('\n}\n'), -1, 'the closing brace literal is simply not present in a CRLF checkout');
  const oldRegion = body.slice(0, body.indexOf('\n}\n'));
  // slice(0, -1) — the rest of the file, minus one character. The chmod it then finds belongs to a function
  // three definitions away.
  assert(oldRegion.includes('chmod'), 'so the old region swallowed the NEXT function, and its chmod');
  assert(oldRegion.includes('write_secret_if_absent'), 'which is exactly the function it swallowed');
  // AND THE DIRECTION THAT WOULD HAVE PASSED. Reverse the two ends and the same bug searches nothing.
  const caseLabel = '\n  root-only)\n';
  assertEq(crlf.indexOf(caseLabel), -1, 'a case label literal is not present either');
  assertEq(crlf.slice(crlf.indexOf(caseLabel), crlf.indexOf('\n  *)\n')), '',
    'and slicing between two -1s searches the empty string, which satisfies every "must not contain" gate');
});

await test('an extractor that cannot find its region refuses, and never answers with a wrong one', () => {
  const source = parseShellSource(FIXTURE, 'fixture');
  refuses(() => functionBody(source, 'no_such_function'), 'defines no shell function',
    'a function that is not there');
  refuses(() => functionBody(parseShellSource('open_forever() {\n  echo hi\n', 'x'), 'open_forever'),
    'never closed', 'a function that is never closed');
  refuses(() => caseArm(caseBlock(source, 'ACTION'), 'no-such-arm'), 'has no no-such-arm) case arm',
    'a case arm that is not there');
  refuses(() => caseBlock(source, 'NOT_A_SUBJECT'), 'case statements switching on',
    'a case that switches on nothing by that name');
  // AND THE ONE ANSWER THAT IS ALLOWED TO BE EMPTY, because "no call sites" is a fact rather than a failed
  // search: a list, which a caller can count, and never a region a caller might search.
  assertEq(callSites(parseShellSource('', 'empty'), 'anything').length, 0,
    'an empty script has no call sites, stated as a count rather than as an empty region');
  refuses(() => callSite(source, 'no_such_command'), 'not once', 'asking for the one call site of a command with none');
});

// ---------------------------------------------------------------------------------------------------------
// 1b. Correction 1 — malformed input is a refusal, not a plausible answer
// ---------------------------------------------------------------------------------------------------------

await test('a malformed line is refused rather than answered with a plausible-looking parse', () => {
  // THE FIVE HOLES A HOSTILE REVIEW FOUND IN THE FIRST VERSION OF THIS READER. Every one of them ACCEPTED
  // malformed input and returned something that reads exactly like a correct answer. The module's whole
  // premise is that uncertainty is a refusal, and these were the counter-examples.
  //
  // Each is a way to make a forbidden call INVISIBLE, which is the direction that fails OPEN: a gate asking
  // "does this region contain chmod" gets "no" from a line nobody could parse.
  refuses(() => words('cmd "unterminated'), 'unterminated double quote',
    'a double quote that never closes — it used to return ["cmd","unterminated"]');
  refuses(() => words("cmd 'unterminated"), 'unterminated single quote',
    'a single quote that never closes');
  refuses(() => commandSubstitutions('x="$(node foo'), 'unterminated command substitution',
    'a substitution that never closes — it used to return [], meaning "no command here"');
  refuses(() => callSites(parseShellSource('node "${HELPER}" --generate \\', 'trailing'), 'node'),
    'ends on a line continuation',
    'a file ending mid-continuation — the arguments after it were never written');
  // AND THE WORST OF THE FIVE. Bash runs the LAST definition of a function; this returned the FIRST.
  const duplicated = parseShellSource(
    'write_custody_secret() {\n  node "${H}" "${P}" --generate 1 1\n}\n'
    + 'write_custody_secret() {\n  chmod 0644 "${P}"\n}\n', 'duplicated');
  refuses(() => functionBody(duplicated, 'write_custody_secret'), 'Bash would run the LAST one',
    'a function defined twice — the gate would have read a clean definition and approved a chmod');
});

await test('malformed syntax AROUND the real custody invocation is refused, and the real one is not', () => {
  // NOT A SYNTHETIC FIXTURE. The shipped setup script is taken as it is, mutated one way at a time, and each
  // mutation must be refused — because each one is a way somebody could hide what the custody helper is
  // really handed. The unmutated original must still produce its exact six words, or the strictness has been
  // bought by breaking the thing it protects.
  const path = 'deploy/local-runtime-setup.sh';
  const original = readRepo(path);
  const source = parseShellSource(original, path);
  const helper = callSites(source, 'node').filter((call) => call[1] === '${CUSTODY_HELPER}');
  assertEq(helper.length, 1, 'the real script yields exactly one helper invocation');
  assertEq(helper[0]!.length, 6, `and its six words: ${helper[0]!.join(' ')}`);

  const mutations: ReadonlyArray<readonly [string, string, string]> = [
    // The continuation that carries the two ids. Drop it and the invocation silently loses its last two
    // arguments — an argument-counting gate would read 4 and could not say why.
    ['the helper continuation is dropped', '--generate \\', '--generate'],
    // A quote removed from the middle of the invocation.
    ['a quote in the invocation is unbalanced', '"${SECRETS_DIR}/${name}"', '"${SECRETS_DIR}/${name}'],
    // The substitution that wraps the whole call.
    ['the substitution around the call never closes', ')" || {', '" || {'],
  ];
  for (const [what, from, to] of mutations) {
    assert(original.includes(from), `the mutation anchor is present: ${from}`);
    const mutated = parseShellSource(original.replace(from, to), `${path} (${what})`);
    let refused = '';
    try { callSites(mutated, 'node'); } catch (err) { refused = (err as Error).message; }
    assert(refused !== '', `${what}: must be refused, not parsed into a plausible call`);
    assert(refused.includes(path), `${what}: the refusal names the script — ${refused}`);
  }

  // AND THE FUNCTION ITSELF, DEFINED TWICE IN THE REAL SCRIPT. A second definition anywhere after the first
  // is what bash would actually run.
  const doubled = parseShellSource(
    `${original}\nwrite_custody_secret() {\n  chmod 0644 "${'$'}{SECRETS_DIR}/${'$'}{1}"\n}\n`, path);
  refuses(() => functionBody(doubled, 'write_custody_secret'), 'Bash would run the LAST one',
    'the real script with a second, chmod-ing definition appended');
});

await test('the helper body is read to its END, which the committed reader did not do', () => {
  // A THIRD SILENT WRONG REGION, FOUND BY THIS CORRECTION AND NOT BY A FAILING GATE.
  //
  // The committed extractor matched braces on PHYSICAL lines. The custody helper's invocation spans a `\`
  // continuation, and the second physical line — `"${...}" "${...}")" || {` — carries a stray `"` that pairs
  // with one on the line before. Read alone, that line looks like it OPENS a quote, so the block-opening `{`
  // at its end was treated as quoted text and never counted. The matching `}` six lines later then took the
  // depth to zero, and the "function body" ended at `exit 1` — 17 lines of a 23-line function, with the whole
  // `case ... esac` tail outside the region the custody gate searched.
  //
  // The gate passed, because the truncated part happened to contain no `chmod`. A `chmod` in those six lines
  // would have been invisible. Validating on the LOGICAL line — continuations joined first — is what fixes
  // it, and this asserts the end of the region rather than trusting that it is there.
  const source = parseShellSource(readRepo('deploy/local-runtime-setup.sh'), 'deploy/local-runtime-setup.sh');
  const body = functionBody(source, 'write_custody_secret');
  assertEq(body[body.length - 1]!.trim(), 'esac', 'the body runs to the end of the function');
  const whole = shellText(body);
  assert(whole.includes('case "${outcome}" in'), 'and includes the case the truncated region cut off');
  assert(whole.includes('kept'), 'including the branch that reports an existing secret was kept');
  // The property the custody gate actually asserts, now over the WHOLE function rather than three quarters.
  assert(!/\bchmod\b/.test(shellText(shellCode({ path: 'b', lines: body }).lines)),
    'and the whole function, not part of it, performs no chmod');
});

await test('a quoted terminator cannot end a case arm early and hide what follows it', () => {
  // CORRECTION 1, SECOND ROUND — CONFIRMED FAIL-OPEN. `caseArms` located an arm's end with
  // `line.includes(';;')`, so a `;;` INSIDE A STRING ended the arm. Probed against the working tree, this arm
  // came back as the `echo` line alone, with the `chmod` two lines later OUTSIDE the region the custody gate
  // searches. A confidently wrong region, in the direction that hides the dangerous thing — the module's
  // original defect, reintroduced by the module itself.
  const script = parseShellSource(`case "\${ACTION}" in
  bootstrap)
    echo "a literal ;; inside a string"
    chmod 0644 "\${SECRETS_DIR}/custodian_root_key"
    ;;
  *)
    exit 3
    ;;
esac
`, 'quoted-terminator');
  const arm = shellText(caseArm(caseBlock(script, 'ACTION'), 'bootstrap'));
  assert(arm.includes('chmod 0644'), `the arm runs to its REAL terminator: ${arm}`);
  assert(arm.includes('a literal ;; inside a string'), 'and still contains the string that used to end it');
  assert(!arm.includes('exit 3'), 'while stopping before the next arm');

  // AND THE SAME MISTAKE ONE LEVEL UP: a quoted `esac` used to close the block, truncating it so that a later
  // arm — the one holding the chmod — could not be found at all.
  const withEsac = parseShellSource(`case "\${ACTION}" in
  bootstrap)
    echo "the word esac appears here"
    ;;
  *)
    chmod 0644 /etc/shadow
    ;;
esac
`, 'quoted-esac');
  const fallback = shellText(caseArm(caseBlock(withEsac, 'ACTION'), '*'));
  assert(fallback.includes('chmod 0644 /etc/shadow'),
    `a quoted esac does not truncate the block: ${fallback}`);
});

await test('a nested case does not end the arm that contains it', () => {
  // CORRECTION 1, FINAL ROUND — CONFIRMED FAIL-OPEN. The arm ended at the FIRST `;;` after its pattern, and
  // an inner `case` supplies one long before the outer arm is over. Probed against the working tree, the
  // `bootstrap)` arm below came back as its first two lines — with the `chmod` after the inner `esac` outside
  // the region the custody gate searches. Every fail-open in this module has had the same shape: a region
  // that ends too early, and a `!includes` that reads the shortfall as absence.
  const script = parseShellSource(`case "\${ACTION}" in
  bootstrap)
    case "\${MODE}" in
      a) echo inner-a ;;
      *) echo inner-other ;;
    esac
    chmod 0644 "\${SECRETS_DIR}/custodian_root_key"
    ;;
  *)
    exit 3
    ;;
esac
`, 'nested-case');
  const arm = shellText(caseArm(caseBlock(script, 'ACTION'), 'bootstrap'));
  assert(arm.includes('chmod 0644'), `the arm survives the nested case: ${arm}`);
  assert(arm.includes('esac'), 'and contains the inner case it wraps');
  assert(!arm.includes('exit 3'), 'while still stopping before the next arm');
  // The inner arms are still addressable in their own right, scoped to the case they belong to.
  assert(shellText(caseArm(caseBlock(script, 'MODE'), 'a')).includes('inner-a'),
    'and the inner case is a block of its own');
});

await test('an escaped quote before a hash does not turn the rest of the line into a comment', () => {
  // CORRECTION 1, SECOND ROUND — CONFIRMED FAIL-OPEN. Four separate quote walkers lived in this module and
  // disagreed: `openQuoteAt` honoured a backslash inside a double-quoted string, `withoutComment` and `words`
  // did not. So `withoutComment` decided the string closed at the escaped quote, read the following `#` as a
  // comment, and returned a TRUNCATED line. `code(source)` — which several gates search — is exactly that
  // function mapped over a file, so a `chmod` after such a line was simply not in the text they read.
  const line = 'echo "she said \\"hi\\" # still inside the string"';
  assertEq(withoutComment(line), line, 'the whole line survives, because none of it is a comment');
  assertEq(words(line).length, 2, 'and it is two words: the command and one quoted value');
  assertEq(words(line)[1], 'she said "hi" # still inside the string', 'with the escapes resolved');

  // THE SHAPE THAT HID A REAL COMMAND: a command after a `;` on the same line.
  const hidden = parseShellSource('echo "a \\" # b" ; chmod 0644 /etc/shadow\n', 'escaped-hash');
  assertEq(callSites(hidden, 'chmod').length, 1, 'a command after the string is still a call site');
  assertEq(callSites(hidden, 'echo').length, 1, 'and so is the one before it');
  // A REAL comment is still a comment — the fix must not have removed the ability to ignore prose.
  assertEq(withoutComment('chmod 0644 x # this really is a comment'), 'chmod 0644 x ',
    'an unquoted # still starts a comment');
  assertEq(callSites(parseShellSource('# chmod 0644 /etc/shadow\n', 'commented'), 'chmod').length, 0,
    'and a commented-out command is not a call site');
});

await test('a separator separates whether or not anybody typed a space around it', () => {
  // CORRECTION 1, THIRD ROUND — CONFIRMED FAIL-OPEN, AND THE MOST DIRECT ONE YET. Words were split on
  // WHITESPACE ALONE, so `echo x;chmod 0644 secret` tokenised as `["echo","x;chmod","0644","secret"]`.
  // `chmod` was never the head of a word, never in command position, and `callSites(..., 'chmod')` answered
  // ZERO for a line that really runs it. Five valid shapes all returned zero — every one of them a way to run
  // a forbidden command that the no-chmod and no-docker gates could not see.
  for (const [what, line] of [
    ['a semicolon', 'echo x;chmod 0644 secret'],
    ['an AND list', 'true&&chmod 0644 secret'],
    ['an OR list', 'false||chmod 0644 secret'],
    ['a pipe', 'printf x|chmod 0644 secret'],
    ['a subshell', '(chmod 0644 secret)'],
  ] as const) {
    assertEq(callSites(parseShellSource(`${line}\n`, what), 'chmod').length, 1,
      `${what} puts what follows it in command position: ${line}`);
  }
  assertEq(words('echo x;chmod 0644 secret').join('|'), 'echo|x|;|chmod|0644|secret',
    'the separator is its own token');
  // AND A SEPARATOR INSIDE A STRING IS NOT A SEPARATOR, which is the other half of getting this right.
  assertEq(words('echo "a;b"').join('|'), 'echo|a;b', 'a quoted semicolon is part of the value');
  assertEq(callSites(parseShellSource('echo "x;chmod 0644 secret"\n', 'quoted'), 'chmod').length, 0,
    'and a command named inside a string is not a call site');
  // A DEFINITION IS STILL NOT A CALL. `(` and `)` became tokens for the sake of the subshell case above, and
  // `name() {` puts the name in command position unless a reader knows what a definition looks like.
  assertEq(callSites(parseShellSource('write_custody_secret() {\n  echo hi\n}\n', 'def'),
    'write_custody_secret').length, 0, 'defining a function does not call it');
});

await test('every ordinary way of reaching a command counts as reaching it', () => {
  // CORRECTION 1, THIRD ROUND FOLLOW-UP — FIFTEEN MORE CONFIRMED ZEROES. Emitting `&` as a token without
  // accepting it as a separator left `echo x&chmod` hiding the chmod, which is the worst kind of half-fix: a
  // tokeniser that looks right and a gate that still cannot see. And a command reached through an assignment
  // prefix, a control keyword or a wrapper was never in "command position" at all — so `VAR=x chmod`,
  // `if chmod`, `while chmod`, `! chmod` and `sudo chmod` each ran the command while every gate said zero.
  for (const [what, line] of [
    ['a background separator, unspaced', 'echo x&chmod 0644 secret'],
    ['a background separator, spaced', 'echo x & chmod 0644 secret'],
    ['an assignment prefix', 'VAR=x chmod 0644 secret'],
    ['two assignment prefixes', 'A=1 B=2 chmod 0644 secret'],
    ['an if condition', 'if chmod 0644 secret; then echo y; fi'],
    ['an elif condition', 'elif chmod 0644 secret; then echo y; fi'],
    ['a while condition', 'while chmod 0644 secret; do echo y; done'],
    ['an until condition', 'until chmod 0644 secret; do echo y; done'],
    ['a negation', '! chmod 0644 secret'],
    ['the command builtin', 'command chmod 0644 secret'],
    ['env', 'env chmod 0644 secret'],
    ['sudo', 'sudo chmod 0644 secret'],
    ['time', 'time chmod 0644 secret'],
    ['exec', 'exec chmod 0644 secret'],
    ['xargs', 'xargs chmod 0644 secret'],
  ] as const) {
    assertEq(callSites(parseShellSource(`${line}\n`, what), 'chmod').length, 1,
      `${what} reaches the command: ${line}`);
  }
  // AND THE THINGS THAT MUST STAY ZERO, so the breadth above was not bought with false positives.
  for (const [what, line] of [
    ['a command named inside a string', 'echo "chmod 0644 secret"'],
    ['a commented-out command', '# chmod 0644 secret'],
    ['a different command with the same prefix', 'chmod_helper 0644 secret'],
    ['a command as a bare argument', 'echo chmod 0644 secret'],
  ] as const) {
    assertEq(callSites(parseShellSource(`${line}\n`, what), 'chmod').length, 0,
      `${what} is not a call site: ${line}`);
  }
});

await test('a heredoc opener does not swallow the rest of its line, and its delimiter matches exactly', () => {
  // CORRECTION 1, THIRD ROUND — TWO MORE CONFIRMED FAIL-OPENS.
  //
  // (B) Only the text BEFORE the heredoc operator was kept, so `cat <<'EOF' ; chmod 0644 secret` came back as
  // the single word `cat` and the command after the delimiter word vanished — zero call sites for a line that
  // really runs it. A redirection tail was lost the same way.
  const tail = parseShellSource("cat <<'EOF' ; chmod 0644 secret\nbody\nEOF\n", 'heredoc-tail');
  assertEq(callSites(tail, 'chmod').length, 1, 'a command after a heredoc operator is still a call site');
  assertEq(callSites(tail, 'cat').length, 1, 'and so is the one that opened it');
  const redirected = logicalLines(parseShellSource("cat <<'EOF' > \"${FILE}\"\nbody\nEOF\n", 'heredoc-redir'));
  assert(shellText(redirected.map((entry) => entry.text)).includes('> "${FILE}"'),
    'a redirection on the same line is preserved');
  // The body itself is still data.
  assertEq(callSites(tail, 'body').length, 0, 'while the body is not code');

  // (C) The delimiter was compared with `.trim()`, so a SPACE-indented `  EOF` closed a plain `<<'EOF'` — and
  // the lines after it, still data to the shell, were handed back as executable code. The shell requires an
  // exact match; only `<<-` strips indentation, and only leading TABS.
  const spaced = parseShellSource("cat <<'EOF'\n  EOF\nchmod 0644 secret\nEOF\n", 'space-delimiter');
  assertEq(callSites(spaced, 'chmod').length, 0,
    'a space-indented delimiter does not close a non-dashed heredoc, so the body stays data');
  const dashed = parseShellSource("cat <<-'EOF'\nbody\n\tEOF\nchmod 0644 secret\n", 'tab-delimiter');
  assertEq(callSites(dashed, 'chmod').length, 1,
    'while a tab-indented delimiter DOES close a dashed one, and the code after it is code');
});

await test('a heredoc opened on a continuation line is still a heredoc', () => {
  // CORRECTION 1, SECOND ROUND. Heredocs were detected BEFORE continuations were joined, so an operator
  // introduced on a continuation line was invisible and its body was handed back as executable code. Probed
  // directly, `callSites(..., 'chmod')` returned ONE — a call site reported from inside a heredoc BODY. That
  // is the mirror image of hiding a call, and just as wrong: a gate would refuse a script over a line that
  // is data.
  const onContinuation = parseShellSource(`cat \\
  <<'EOF'
chmod 0644 /etc/shadow
EOF
`, 'heredoc-continuation');
  assertEq(callSites(onContinuation, 'chmod').length, 0, 'the body is data, wherever the operator was written');
  assertEq(callSites(onContinuation, 'cat').length, 1, 'while the command that opened it is still a call site');

  // MORE THAN ONE ON A LINE IS REFUSED, because the bodies pair up with the operators in an order this
  // reader does not model — and a reader that consumed one body would treat the second as code.
  refuses(() => logicalLines(parseShellSource("cat <<'A' <<'B'\nx\nA\ny\nB\n", 'two-heredocs')),
    'more than one heredoc on a line', 'two heredocs on one line');
  // A here-STRING is not a here-document: it consumes no following lines.
  assertEq(callSites(parseShellSource('cat <<< "text"\nchmod 0644 x\n', 'herestring'), 'chmod').length, 1,
    'a here-string does not swallow the line after it');
});

await test('a heredoc body is data, and an unterminated or expanding one is refused', () => {
  // FIVE OF THE SHIPPED SCRIPTS CARRY A HEREDOC — usage banners and exit-code tables — and one of them
  // contains an apostrophe in ordinary English prose ("the underlying command's"), which is quote-unbalanced
  // and entirely harmless. Refusing that would be refusing a comment, so quoted heredoc bodies are skipped.
  const quoted = parseShellSource(
    "usage() {\n  cat <<'EOF'\nit's fine, and \"unbalanced\ntoo\nEOF\n}\nchmod 0644 x\n", 'quoted-heredoc');
  assertEq(logicalLines(quoted).length > 0, true, 'a quoted heredoc body does not stop the reader');
  assertEq(callSites(quoted, 'chmod').length, 1, 'and code after it is still read');
  // BUT AN UNQUOTED HEREDOC REALLY EXPANDS `$( )`, and this reader does not model that. It refuses rather
  // than skipping past a command that would actually run.
  refuses(() => logicalLines(parseShellSource('cat <<EOF\n$(rm -rf /)\nEOF\n', 'expanding')),
    'UNQUOTED heredoc body contains a command substitution', 'a heredoc that really executes something');
  refuses(() => logicalLines(parseShellSource("cat <<'EOF'\nnever closed\n", 'unterminated')),
    'never terminated', 'a heredoc with no terminator');
});

await test('every shipped script still parses, under all three line endings', () => {
  // THE STRICTNESS MUST NOT HAVE BEEN BOUGHT BY BREAKING THE CORPUS. Every `.sh` this repository ships is
  // read end to end, in all three typings, and the custody helper is re-extracted from the two scripts that
  // define it so the answer is compared rather than merely obtained.
  let examined = 0;
  for (const file of readdirSync(join(repoRoot, 'deploy')).filter((name) => name.endsWith('.sh'))) {
    const lf = readRepo(join('deploy', file)).replace(/\r\n|\r/g, '\n');
    let expected: string | null = null;
    for (const [what, text] of eachLineEnding(lf)) {
      const source = parseShellSource(text, `deploy/${file} (${what})`);
      const lines = logicalLines(source);
      assert(lines.length > 0, `deploy/${file} (${what}) yields logical lines`);
      let body: string | null = null;
      try { body = shellText(functionBody(source, 'write_custody_secret')); } catch { body = null; }
      if (expected === null) expected = body ?? '(none)';
      assertEq(body ?? '(none)', expected, `deploy/${file}: ${what} reads the same custody helper`);
    }
    examined += 1;
  }
  assert(examined >= 10, `every shipped shell script was parsed in three typings (${examined})`);
});

await test('an arm is chosen by the case it belongs to, not by which text matches first', () => {
  // THE SHIPPED SCRIPT HAS THREE `root-only)` ARMS: one validating a marker's contents, one printing a compose
  // command, one performing the action. The old gate's own comment worried about exactly this and then had no
  // mechanism for it. An unscoped request is now an error rather than a coin toss.
  const script = parseShellSource(readRepo('deploy/unraid-custody-mode.sh'), 'deploy/unraid-custody-mode.sh');
  refuses(() => caseArm(script, 'root-only'), 'case arms; name the one you mean',
    'an ambiguous arm across the whole script');
  const action = shellText(shellCode({ path: 'a', lines: caseArm(caseBlock(script, 'ACTION'), 'root-only') }).lines);
  assert(action.includes('rm -f "${MARKER}"'), 'scoped to the action case, root-only removes the marker');
  const printer = shellText(caseArm(caseBlock(script, '$1'), 'root-only'));
  assert(printer.includes('docker compose') && !printer.includes('rm -f'),
    'while the printer arm only prints, which is what made the unscoped question ambiguous');
});

await test('a call site is counted in words, across continuations and into command substitutions', () => {
  const source = parseShellSource(FIXTURE, 'fixture');
  // The helper invocation is inside `$( ... )` AND split over a backslash continuation. Both had to be
  // handled for an argument count to mean anything — and an argument count is the whole proof that no key
  // travels on a command line.
  const node = callSites(source, 'node');
  assertEq(node.length, 1, 'the helper invocation is found once');
  assertEq(node[0]!.join(' '), 'node ${HELPER} ${DIR}/${name} --generate ${UID} ${GID}',
    'with every argument the continuation carried');
  assertEq(words('a "b c" \'d e\' f\\ g').join('|'), 'a|b c|d e|f g', 'quoting and escapes split into words');
  assertEq(withoutComment('echo "a # b" # trailing'), 'echo "a # b" ', 'a # inside quotes is not a comment');
  assertEq(commandSubstitutions('x="$(a "$(b)" c)"').length, 1, 'a nested substitution is one outer span');
});

// ---------------------------------------------------------------------------------------------------------
// 2. The shipped scripts, read structurally
// ---------------------------------------------------------------------------------------------------------

await test('no custody function in any shipped script performs a path-based mode, owner or stat operation', () => {
  // BROADER THAN THE GATE IT REPLACES, which asked this of two scripts. A path operation resolves the name
  // again, and every re-resolution is a window in which the name can become a link to somewhere else — with
  // root re-moding and overwriting whatever it then points at. The descriptor-based helper exists so there is
  // exactly one resolution; a shell script that reintroduces one anywhere in a custody function undoes it.
  let checked = 0;
  for (const file of readdirSync(join(repoRoot, 'deploy')).filter((name) => name.endsWith('.sh'))) {
    const source = parseShellSource(readRepo(join('deploy', file)), `deploy/${file}`);
    for (const name of ['write_custody_secret']) {
      let body: readonly string[];
      try { body = functionBody(source, name); } catch (err) {
        assert(err instanceof ShellSourceError, `deploy/${file}: ${(err as Error).message}`);
        continue; // This script does not define it, which is not a violation.
      }
      checked += 1;
      const executable = shellText(shellCode({ path: file, lines: body }).lines);
      for (const forbidden of ['chmod', 'chown', 'stat', 'install', 'touch', 'setfacl']) {
        assert(!new RegExp(`\\b${forbidden}\\b`).test(executable),
          `deploy/${file}: ${name}() performs a path-based ${forbidden}: ${executable}`);
      }
      assert(executable.includes('--generate'), `deploy/${file}: ${name}() delegates to the generating helper`);
    }
  }
  assertEq(checked, CUSTODY_SETUP_SCRIPTS.length, 'and every setup script that ships custody was examined');
});

await test('every custody call site passes a name and no value, in every shipped script', () => {
  for (const script of CUSTODY_SETUP_SCRIPTS) {
    const source = parseShellSource(readRepo(script), script);
    const sites = callSites(source, 'write_custody_secret');
    assertEq(sites.length, 1, `${script} creates custody once`);
    assertEq(sites[0]!.length, 2, `${script} passes a name and nothing else: ${sites[0]!.join(' ')}`);
    // AND THE ARGV THE HELPER REALLY RECEIVES, which is the list `ps` shows to every account on the host.
    const helper = callSites(source, 'node').filter((call) => call[1] === '${CUSTODY_HELPER}');
    assertEq(helper.length, 1, `${script} runs the helper once`);
    assertEq(helper[0]!.length, 6, `${script}: a path, a source word and two ids — ${helper[0]!.join(' ')}`);
    for (const word of helper[0]!) {
      assert(!/randomBytes|random_secret|openssl|\bhead -c\b/.test(word),
        `${script}: no argument is a value-producing substitution — ${word}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------
// 3. The custody writer against a hostile path
// ---------------------------------------------------------------------------------------------------------

interface CustodyHelper {
  writeCustodySecret: (path: string, value: string, uid: number, gid: number,
    write?: (fd: number, b: Buffer, off: number, len: number, pos: number) => number) => string;
  writeAllOrRefuse: (fd: number, bytes: Buffer,
    write?: (fd: number, b: Buffer, off: number, len: number, pos: number) => number) => number;
  assertPlatformCanHoldCustody: (platform?: string) => void;
  CUSTODY_FILE_MODE: number;
}
const helper = await import(pathToFileURL(HELPER).href) as unknown as CustodyHelper;
const ids = (): [number, number] => [process.getuid?.() ?? 0, process.getgid?.() ?? 0];

await test('a symbolic link at the custody path is refused, and what it points at is untouched', async () => {
  if (!POSIX) { console.log('        (POSIX-only: this host refuses custody before it reaches a path at all)'); return; }
  const dir = join(WORK, 'symlink-at-name');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'somebody-elses-file');
  writeFileSync(target, 'THE CONTENTS OF A FILE THIS SCRIPT MUST NOT TOUCH\n', { encoding: 'utf8', mode: 0o644 });
  const before = readFileSync(target, 'utf8');
  const beforeMode = statSync(target).mode & 0o777;
  const link = join(dir, 'custodian_root_key');
  symlinkSync(target, link);

  const [uid, gid] = ids();
  refuses(() => helper.writeCustodySecret(link, A_ROOT_KEY, uid, gid), 'symbolic link',
    'a symbolic link planted at the custody path');
  // THE POINT OF O_NOFOLLOW, STATED AS AN OUTCOME. The target keeps its bytes AND its mode: not overwritten,
  // and not re-moded to 0400 by a chmod that resolved the name a second time.
  assertEq(readFileSync(target, 'utf8'), before, 'the file it pointed at keeps its contents');
  assertEq(statSync(target).mode & 0o777, beforeMode, 'and its mode');
  assert(lstatSync(link).isSymbolicLink(), 'and the link itself is left for the operator to remove deliberately');
});

await test('a directory at the custody path is refused, not written into or around', () => {
  if (!POSIX) { console.log('        (POSIX-only: this host refuses custody before it reaches a path at all)'); return; }
  const dir = join(WORK, 'directory-at-name');
  mkdirSync(join(dir, 'custodian_root_key'), { recursive: true });
  const [uid, gid] = ids();
  refuses(() => helper.writeCustodySecret(join(dir, 'custodian_root_key'), A_ROOT_KEY, uid, gid),
    'could not be created', 'a directory standing at the custody path');
  assertEq(readdirSync(join(dir, 'custodian_root_key')).length, 0, 'and nothing was written inside it');
});

await test('an existing custody file that fails verification is refused and left exactly as it was', () => {
  if (!POSIX) { console.log('        (POSIX-only: modes are not a concept here)'); return; }
  const dir = join(WORK, 'existing-loose');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'custodian_root_key');
  // A key somebody else could read. VERIFIED, NEVER REPAIRED: silently re-moding it would be this script
  // deciding that a key which has been readable by another account is fine to keep using.
  writeFileSync(path, `${A_ROOT_KEY}\n`, { encoding: 'utf8', mode: 0o644 });
  chmodSync(path, 0o644);
  const [uid, gid] = ids();
  refuses(() => helper.writeCustodySecret(path, 'a-different-key', uid, gid), 'not 0400',
    'an existing key that has been readable beyond its owner');
  assertEq(readFileSync(path, 'utf8'), `${A_ROOT_KEY}\n`, 'its value is untouched');
  assertEq(statSync(path).mode & 0o777, 0o644, 'and its mode is untouched — refused, not quietly repaired');
});

// ---------------------------------------------------------------------------------------------------------
// 4. Partial failure leaves nothing behind
// ---------------------------------------------------------------------------------------------------------

await test('a write that fails part-way leaves NO file at the custody path', () => {
  if (!POSIX) { console.log('        (POSIX-only: the create-and-clean-up path needs a real fchown)'); return; }
  const dir = join(WORK, 'partial');
  mkdirSync(dir, { recursive: true });
  const [uid, gid] = ids();

  // A writer that writes the first chunk and then stalls. A root wrapping key truncated this way is bytes
  // that look like a key: the setup exits, the sidecar starts, and the ring is sealed under something nobody
  // can reproduce. The only safe residue is none.
  const path = join(dir, 'stalls');
  let calls = 0;
  refuses(() => helper.writeCustodySecret(path, A_ROOT_KEY, uid, gid, (fd, b, off, _len, pos) => {
    calls += 1;
    return calls === 1 ? require('node:fs').writeSync(fd, b, off, 8, pos) : 0;
  }), 'could not be written in full', 'a writer that stalls after the first chunk');
  assertEq(existsSync(path), false, 'and nothing is left at that name for the next run to adopt');

  // A writer that writes the RIGHT NUMBER of bytes and the WRONG ONES. The length check alone would pass it;
  // the read-back from the same descriptor is what does not.
  const swapped = join(dir, 'swapped');
  refuses(() => helper.writeCustodySecret(swapped, A_ROOT_KEY, uid, gid, (fd, b, off, len, pos) => {
    const forged = Buffer.from(b.subarray(off, off + len));
    forged[0] = forged[0]! ^ 0xff;
    return require('node:fs').writeSync(fd, forged, 0, len, pos);
  }), 'not the value that was written', 'a writer that writes the wrong bytes at the right length');
  assertEq(existsSync(swapped), false, 'and that file is gone too');

  // AND THE SAME PATH SUCCEEDS ONCE THE WRITER IS HONEST, so every refusal above was the failure injected
  // and not the path, the ids or the directory.
  assertEq(helper.writeCustodySecret(path, A_ROOT_KEY, uid, gid), 'created', 'an honest writer creates it');
  assertEq(statSync(path).mode & 0o777, helper.CUSTODY_FILE_MODE, 'owner-read only');
  assertEq(readFileSync(path, 'utf8'), `${A_ROOT_KEY}\n`, 'holding exactly the key and one newline');
});

// ---------------------------------------------------------------------------------------------------------
// 5. The command line, as a process really receives it
// ---------------------------------------------------------------------------------------------------------

await test('the helper process, run for real, carries no key in its argv and prints none in its output', () => {
  // ARGV AS THE OPERATING SYSTEM SEES IT. Everything above reads the scripts; this runs the program and
  // inspects the actual command line, the actual exit code and the actual bytes on both streams. A command
  // line is visible in `ps` to every account on the host for as long as the process lives.
  const dir = join(WORK, 'argv');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'custodian_root_key');
  const [uid, gid] = ids();
  const argv = [HELPER, path, '--generate', String(uid), String(gid)];
  const run = spawnSync(process.execPath, argv, { ...SPAWN_DEFAULTS, timeout: SCRIPT_TIMEOUT_MS });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;

  for (const word of argv) {
    assert(!/^[0-9a-f]{32,}$/i.test(word), `no argument is key-shaped: ${word}`);
  }
  assert(!/[0-9a-f]{32,}/i.test(output), `neither stream carries anything key-shaped: ${output}`);

  if (POSIX) {
    assertEq(run.status, 0, `the helper creates the key — ${describeRun(run)}`);
    assertEq((run.stdout ?? '').trim(), 'created custody secret', 'and reports one closed word');
    const written = readFileSync(path, 'utf8').trim();
    assert(/^[0-9a-f]{64}$/.test(written), 'the file holds a 32-byte key it generated itself');
    assert(!output.includes(written), 'and the value it generated appears in no output at all');
    assertEq(statSync(path).mode & 0o777, 0o400, 'owner-read only on disk');
    // RE-RUN: verified, not regenerated, and still nothing printed.
    const again = spawnSync(process.execPath, argv, { ...SPAWN_DEFAULTS, timeout: SCRIPT_TIMEOUT_MS });
    assertEq(again.status, 0, `a re-run verifies — ${describeRun(again)}`);
    assertEq((again.stdout ?? '').trim(), 'verified existing custody secret', 'and says so');
    assertEq(readFileSync(path, 'utf8').trim(), written, 'without changing the value');
  } else {
    // THE REFUSAL IS THE SHIPPED BEHAVIOUR HERE, and it is a whole outcome: non-zero, named, and no file.
    assert(run.status !== 0, `the helper refuses this platform — ${describeRun(run)}`);
    assert((run.stderr ?? '').includes('NOTHING WAS CREATED'), `and says so: ${run.stderr ?? ''}`);
    assertEq(existsSync(path), false, 'and leaves no root wrapping key behind');
  }
});

await test('a usage error refuses before generating anything, and never echoes what it was given', () => {
  const dir = join(WORK, 'usage');
  mkdirSync(dir, { recursive: true });
  // THE OLD SHAPE OF THE COMMAND LINE — path, VALUE, uid, gid — must not be accepted by mistake now that the
  // second word is a source word. A helper that quietly took a key there again would put one back in `ps`.
  const run = spawnSync(process.execPath,
    [HELPER, join(dir, 'k'), A_ROOT_KEY, '1000', '1000'], { ...SPAWN_DEFAULTS, timeout: SCRIPT_TIMEOUT_MS });
  assert(run.status !== 0, `the old value-carrying form is refused — ${describeRun(run)}`);
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert(output.includes('usage:'), 'with a usage message');
  assert(!output.includes(A_ROOT_KEY), 'that does not echo the value it was wrongly handed');
  assertEq(existsSync(join(dir, 'k')), false, 'and nothing was created');
});

// ---------------------------------------------------------------------------------------------------------
// 6. Windows refusal against POSIX ownership
// ---------------------------------------------------------------------------------------------------------

await test('the platform gate refuses Windows and admits POSIX, asked directly on every host', () => {
  // ASKED DIRECTLY, so both arms are exercised wherever this suite runs rather than only the arm belonging to
  // today's host. A rule that is only ever tested on the platform it permits is not tested.
  refuses(() => helper.assertPlatformCanHoldCustody('win32'), 'no file ownership model', 'Windows');
  refuses(() => helper.assertPlatformCanHoldCustody('win32'), 'NOTHING WAS CREATED', 'and it says what it did not do');
  if (POSIX) {
    helper.assertPlatformCanHoldCustody('linux');
    helper.assertPlatformCanHoldCustody(process.platform);
  } else {
    // On Windows the O_NOFOLLOW arm is the one that would fire for 'linux', which is itself the correct
    // refusal: this host cannot open a file without following a link either.
    refuses(() => helper.assertPlatformCanHoldCustody('linux'), 'NOTHING WAS CREATED',
      'a host with no O_NOFOLLOW, whatever platform string it is asked about');
  }
});

await test('the PowerShell setup refuses the root wrapping key rather than writing an unverifiable one', () => {
  // THE PRODUCT DEFECT THIS TRANCHE FIXES, held structurally. `custodian_root_key` must not reach the generic
  // secret writer: that writer generates a value, writes it, and applies an ACL whose every failure is
  // swallowed by an empty `catch`. On a host with no ownership model that produces a real root wrapping key
  // nobody can prove anything about — and `deploy/write-custody-secret.mjs`, the POSIX path, refuses to
  // create exactly that.
  const ps1 = readRepo('deploy/local-runtime-setup.ps1');
  const calls = ps1.split(/\r\n|\n|\r/).filter((line) => line.includes('custodian_root_key')
    && /^\s*(Write-SecretIfAbsent|Deny-CustodySecret)\b/.test(line));
  assertEq(calls.length, 1, `the root key is handled at exactly one call site: ${calls.join(' | ')}`);
  assert(/^\s*Deny-CustodySecret\b/.test(calls[0]!),
    `and that call site refuses rather than writes: ${calls[0]}`);
  assert(!/Write-SecretIfAbsent\s+-Name\s+'custodian_root_key'/.test(ps1),
    'the generic secret writer is never handed the root wrapping key');
  // AND IT SAYS THE SAME THING THE POSIX HELPER SAYS, in the same words, so an operator reading either one
  // learns the same rule.
  assert(ps1.includes('NOTHING WAS CREATED'), 'the refusal uses the words the helper uses');
  assert(readRepo('deploy/write-custody-secret.mjs').includes('NOTHING WAS CREATED'), 'which the helper does too');
});

await test('the PowerShell setup, EXECUTED, creates every other secret and no root key', () => {
  const shell = usablePowerShell();
  if (shell === null) { console.log('        (skipped: no PowerShell on this host)'); return; }
  const ws = join(WORK, 'ps1-run');
  mkdirSync(join(ws, 'deploy'), { recursive: true });
  writeFileSync(join(ws, 'deploy', 'local-runtime-setup.ps1'), readRepo('deploy/local-runtime-setup.ps1'));
  try {
    const run = runScript(shell, join(ws, 'deploy', 'local-runtime-setup.ps1'), { cwd: ws });
    assertEq(run.status, 0, `the setup completes — ${describeRun(run)}`);
    const stdout = run.stdout ?? '';
    // THE STACK THIS SCRIPT INSTALLS RUNS STATIC KEK CUSTODY and never reads a root wrapping key, so refusing
    // that one secret must not cost the operator the rest of the installation.
    for (const name of ['postgres_password', 'app_password', 'database_url', 'custodian_kek', 'operator_ui_token']) {
      assert(existsSync(join(ws, 'secrets', name)), `${name} is created`);
    }
    assertEq(existsSync(join(ws, 'secrets', 'custodian_root_key')), false,
      'and no root wrapping key it cannot establish the ownership of');
    assert(stdout.includes('NOTHING WAS CREATED'), `it says what it refused and why: ${stdout}`);
    assert(!/[0-9a-f]{64}/i.test(stdout.replace(/[A-Za-z0-9+/=]{40,}/g, '')),
      'and prints no key-shaped value beyond the operator token it must show');
  } finally { removeQuietly(ws); }
});

await test('an installation shaped as the PowerShell setup leaves one can still take a complete backup', () => {
  // THE CONSEQUENCE OF THE REFUSAL, PROVED RATHER THAN ARGUED. `custodian_root_key` is on
  // `REQUIRED_SECRET_FILES`, and a setup that stops creating it could plausibly have made every Windows
  // installation unable to take the one backup that protects it. It does not, and the reason is a rule that
  // already existed for a population this tranche did not invent.
  //
  // `requiredSecretFilesFor` follows THE EVIDENCE IN THE SET, not the declaration in the stack: a keystore
  // with no KEK ring needs no root wrapping key, because nothing in it is sealed under one. That rule was
  // written for released v1.1.4 installations, which have neither a ring nor the file — the population that
  // most needs a rollback set. A Windows install is exactly that shape: `docker-compose.runtime.yml` has no
  // custodian sidecar and runs static KEK custody, so its keystore never holds a ring.
  assert(REQUIRED_SECRET_FILES.includes(ROOT_KEY_SECRET_NAME),
    'the stack still declares the root key as a required secret');
  assert(!requiredSecretFilesFor(false).includes(ROOT_KEY_SECRET_NAME),
    'but a set with no ring does not require it');
  assert(requiredSecretFilesFor(true).includes(ROOT_KEY_SECRET_NAME),
    'while a set that HOLDS a ring still does — the refusal weakens nothing for a migrated installation');

  // AND THE REAL COMMAND, AGAINST A PROJECT WITH EXACTLY THE FILES THE POWERSHELL SETUP LEAVES BEHIND.
  const root = join(WORK, 'windows-shaped');
  mkdirSync(join(root, 'secrets'), { recursive: true });
  mkdirSync(join(root, 'promotion-records'), { recursive: true });
  writeFileSync(join(root, 'promotion-records', 'record-1.json'), '{"a":1}\n', 'utf8');
  for (const file of REQUIRED_SECRET_FILES.filter((name) => name !== ROOT_KEY_SECRET_NAME)) {
    writeFileSync(join(root, 'secrets', file),
      file === 'custodian_kek' ? `${'a'.repeat(64)}\n` : `${file}-value\n`, 'utf8');
  }
  assertEq(existsSync(join(root, 'secrets', ROOT_KEY_SECRET_NAME)), false, 'no root key, as the setup leaves it');
  assertEq(backupSetHasRing(root), false, 'and no ring, because this stack has no sidecar to build one');

  const tools = fakeToolchain({ dumpText: fakeDumpText(schemaVersion()) });
  const outcome = runVerifiedCompleteBackup(
    { projectRoot: root, destination: 'backups', setName: 'windows-set', custodian: 'inline',
      secrets: 'secrets', promotionRecords: 'promotion-records' },
    { runner: tools.runner, fileRunner: tools.fileRunner, ledger: tools.ledger },
  );
  assertEq(outcome.ok, true, `a Windows-shaped installation takes a complete backup: ${JSON.stringify(outcome.failures)}`);
  assertEq(outcome.verification.ok, true, 'and the shipped verifier agrees');
  assertEq(existsSync(join(root, 'backups', 'windows-set', 'secrets-backup', ROOT_KEY_SECRET_NAME)), false,
    'without inventing a file the installation does not have — a placeholder is worse than the absence');
});

await test('the runtime stack the PowerShell setup installs never reads a root wrapping key', () => {
  // THE OTHER HALF OF THE CONSEQUENCE: can the stack still START? The runtime file DECLARES
  // `custodian_root_key` as a top-level secret, and a declared secret whose file is missing would be a
  // stack that cannot come up. It is not, because NO SERVICE CONSUMES IT — Compose only materialises a
  // secret a service asks for. Asserted from the parsed stack rather than from that sentence.
  const doc = parseYaml(readRepo('docker-compose.runtime.yml'));
  const services = asMap(doc.services ?? null, 'services');
  assert(ROOT_KEY_SECRET_NAME in asMap(doc.secrets ?? null, 'secrets'),
    'the stack declares it, from the moment the ring exists as a capability');
  for (const name of Object.keys(services)) {
    const service = asMap(services[name]!, name);
    const wired = `${JSON.stringify(service.secrets ?? [])}${JSON.stringify(service.volumes ?? [])}`;
    assert(!wired.includes(ROOT_KEY_SECRET_NAME), `${name} does not consume the root key, so its absence starts fine`);
    // AND NO SERVICE IN THIS STACK IS THE CUSTODIAN SIDECAR, which is why there is no ring here to seal.
    assert(name !== 'sidecar', 'and this stack has no custodian sidecar at all');
  }
  // The static KEK, which this stack DOES use, is consumed — so the setup must still create that one.
  const consumesKek = Object.keys(services).filter((name) =>
    JSON.stringify(asMap(services[name]!, name).secrets ?? []).includes('custodian_kek'));
  assert(consumesKek.length > 0, `static KEK custody is what this stack runs on: ${consumesKek.join(',')}`);
});

// ---------------------------------------------------------------------------------------------------------
// 7. The mode marker: atomic, unpredictable, removed by the arm that owns removal — and signal-safe
// ---------------------------------------------------------------------------------------------------------

/**
 * A real Catalog Authority project with the shipped mode script beside it, and a way to run that script with
 * one command replaced by a shim on `PATH`.
 *
 * THE SHIM IS THE CLOCK. Signalling a script from outside and hoping to land in the window between "the
 * temporary exists" and "the rename happens" is a race, and a racy test of a signal handler is worse than no
 * test. A shim standing in for a command the arm calls INSIDE that window fires at exactly one point, every
 * time: bash runs a pending trap when the current foreground command completes, so the trap runs after the
 * shim exits and before the next statement.
 *
 * Returns `null` where this cannot be done honestly — a host with no POSIX-shaped shell, or one that cannot
 * deliver a signal between processes. A skip that says so is the correct outcome there; a pass is not.
 */
function stageMarkerProject(name: string): {
  project: string;
  temporaries: () => readonly string[];
  runWithShim: (command: string, body: string, action: string) => SpawnSyncReturns<string>;
} | null {
  const shell = usableBash();
  if (shell === null) return null;
  const project = join(WORK, name);
  const bin = join(project, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const file of ['docker-compose.unraid.runtime.yml', 'docker-compose.unraid.bootstrap.yml']) {
    writeFileSync(join(project, file), readRepo(file));
  }
  const script = join(project, 'unraid-custody-mode.sh');
  writeFileSync(script, readRepo('deploy/unraid-custody-mode.sh'));

  // A POSIX-shell view of a host path. The script requires an absolute path beginning with `/` — deliberately,
  // because it runs on an Unraid box — and a `PATH` entry must be in the same form, since a `C:\ ` drive
  // letter would split on the `:` that separates PATH entries.
  const hostPath = (path: string): string => (POSIX ? path
    : path.replace(/^([A-Za-z]):[\\/]/, (_all, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, '/'));

  return {
    project,
    temporaries: () => readdirSync(project).filter((entry) => entry.startsWith('.custody-mode.')),
    runWithShim: (command, body, action) => {
      writeFileSync(join(bin, command), `#!/usr/bin/env bash\n${body}`, { mode: 0o755 });
      return spawnSync(shell.command, [...shell.args(script), hostPath(project), action], {
        ...SPAWN_DEFAULTS,
        timeout: SCRIPT_TIMEOUT_MS,
        cwd: project,
        env: { ...process.env, PATH: `${hostPath(bin)}${POSIX ? ':' : ':'}${process.env.PATH ?? ''}` },
      });
    },
  };
}

await test('the marker script, EXECUTED, publishes atomically and leaves no temporary behind', () => {
  const shell = usableBash();
  if (shell === null) { console.log('        (skipped: no usable bash on this host)'); return; }
  const project = join(WORK, 'marker-run');
  mkdirSync(project, { recursive: true });
  // The script refuses a directory that is not a Catalog Authority project, so the fixture is one: the two
  // compose files an installation really has, copied from the repository and never edited here.
  for (const file of ['docker-compose.unraid.runtime.yml', 'docker-compose.unraid.bootstrap.yml']) {
    writeFileSync(join(project, file), readRepo(file));
  }
  const script = join(WORK, 'unraid-custody-mode.sh');
  writeFileSync(script, readRepo('deploy/unraid-custody-mode.sh'));

  // THE SCRIPT REQUIRES AN ABSOLUTE HOST PATH BEGINNING WITH `/`, deliberately: it is run on an Unraid box
  // where a relative path would resolve against whatever directory a web terminal happened to be in. A
  // POSIX-shell-on-Windows sees the same directory at its own mount name, so the directory under test is the
  // one Node created either way.
  const hostPath = (path: string): string => (POSIX ? path
    : path.replace(/^([A-Za-z]):[\\/]/, (_all, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, '/'));

  const run = (action: string, dir: string = hostPath(project)) =>
    spawnSync(shell.command, [...shell.args(script), dir, action],
      { ...SPAWN_DEFAULTS, timeout: SCRIPT_TIMEOUT_MS, cwd: project });

  // A RELATIVE PATH IS REFUSED BEFORE ANYTHING IS TOUCHED, which is the check that makes "absolute host path"
  // a rule rather than a docstring.
  const relative = run('bootstrap', 'not/absolute');
  assertEq(relative.status, 2, `a relative project directory is refused — ${describeRun(relative)}`);
  assert((relative.stderr ?? '').includes('ABSOLUTE host path'), 'and says why');

  const before = readdirSync(project);
  const bootstrap = run('bootstrap');
  // THE DEFECT THIS EXECUTION FOUND, AND WHY READING THE SCRIPT COULD NOT HAVE. `cleanup()` ended in a TEST —
  // `[ -n "${TEMP}" ] && rm -f "${TEMP}"` — and the successful path clears `TEMP` before exit, so that test
  // was false and the function returned 1. It is the last command an EXIT trap runs, so the SHELL EXITED 1
  // having done everything correctly: marker written, stack selected, and a non-zero status handed to every
  // caller that reads one. Anything that rolls back on non-zero would have rolled back against a switch that
  // HAD happened. Every source-text gate in this repository read that function and saw nothing wrong with it,
  // because nothing about it is wrong to read.
  assertEq(bootstrap.status, 0, `bootstrap succeeds AND SAYS SO — ${describeRun(bootstrap)}`);
  assert((bootstrap.stdout ?? '').includes('custody mode: bootstrap'), 'and reports the mode it set');
  const after = readdirSync(project).filter((name) => !before.includes(name));
  assertEq(after.length, 1, `exactly one file appears, the marker itself: ${after.join(',')}`);
  // NO TEMPORARY SURVIVES. `mktemp` plus `trap cleanup EXIT` plus an atomic `mv` means a reader either sees
  // the old state or the new one, and never a half-written name an attacker could have planted first.
  assertEq(after.filter((name) => /\.tmp|XXXX|\.[0-9]+$/.test(name)).length, 0, 'and no temporary is left behind');
  if (POSIX) {
    assertEq(statSync(join(project, after[0]!)).mode & 0o077, 0,
      'the marker is private from the instant it exists (umask 077)');
  }

  const status = run('status');
  assertEq(status.status, 0, `status reads it back — ${describeRun(status)}`);
  assert((status.stdout ?? '').includes('custody mode: bootstrap'), 'and reports the mode that was set');

  // ROLLBACK: the steady state is the ABSENCE of a marker, so returning to it removes one and writes none.
  const rootOnly = run('root-only');
  assertEq(rootOnly.status, 0, `root-only succeeds — ${describeRun(rootOnly)}`);
  assertEq(readdirSync(project).filter((name) => !before.includes(name)).length, 0,
    'and the marker is gone, with nothing written on the way there');
  const settled = run('status');
  assertEq(settled.status, 0, `status on the steady state succeeds — ${describeRun(settled)}`);
  assert((settled.stdout ?? '').includes('custody mode: root-only'), 'which reads back as the steady state');
  // AND EVERY ACTION IS IDEMPOTENT IN BOTH STATUS AND EFFECT. A second bootstrap over an existing marker, and
  // a second root-only over an absent one, are both success — an operator re-running a step must not be told
  // something failed, and automation must not be handed a reason to unwind a state that is already correct.
  assertEq(run('root-only').status, 0, 'a second root-only is still success');
  assertEq(run('bootstrap').status, 0, 'and bootstrap is success again from here');
  assertEq(run('bootstrap').status, 0, 'and again over its own marker');
  assertEq(readdirSync(project).filter((name) => !before.includes(name)).length, 1,
    'with still exactly one marker and no accumulated temporaries');
});

await test('a TERM before publication kills the script, publishes nothing, and leaves no temp', () => {
  // CORRECTION 1, AND IT IS A DEFECT THE FIRST FIX INTRODUCED.
  //
  // Phase 329 fixed a successful `bootstrap` exiting 1 by ending the trap handler with `return 0`. That
  // handler was ALSO INSTALLED FOR INT AND TERM — and a signal handler that RETURNS is not a refusal, it is a
  // resumption. Bash ran it and carried on at the next statement, so `kill -TERM` deleted the temporary the
  // script was still about to use, ran on to `mv`, PUBLISHED THE MARKER, printed the success text and exited
  // 0. An operator pressing Ctrl-C, or automation stopping a switch mid-flight, got the switch anyway and was
  // told it had succeeded. A direct probe of that handler shape: `CONTINUED-AFTER-TERM`, exit 0.
  //
  // THE SIGNAL IS DELIVERED BY A REAL PROCESS AT A DETERMINISTIC POINT. A `chmod` shim on PATH signals the
  // script's own shell; the shipped arm calls `chmod` after the temporary exists and before `mv`, and bash
  // runs a pending trap when the foreground command completes — so the window is exact, not a race.
  const shell = usableBash();
  if (shell === null) { console.log('        (skipped: no usable bash on this host)'); return; }
  const staged = stageMarkerProject('sig-before');
  if (staged === null) { console.log('        (skipped: this host cannot deliver a signal between processes)'); return; }
  const run = staged.runWithShim('chmod', 'kill -TERM "$PPID"\nexit 0\n', 'bootstrap');

  assert(run.status !== 0, `the script does not exit 0 after a termination request — ${describeRun(run)}`);
  assertEq(signalOf(run), 15, `and it died of SIGTERM rather than merely failing — ${describeRun(run)}`);
  assertEq(existsSync(join(staged.project, CUSTODY_MODE_FILENAME)), false, 'no marker was published');
  assertEq(staged.temporaries().length, 0, 'and no private temporary was left behind');
  assert(!(run.stdout ?? '').includes('custody mode: bootstrap'),
    `and no success text was printed: ${run.stdout ?? ''}`);
  assert((run.stderr ?? '').includes('terminated by SIGTERM'), `it says what happened: ${run.stderr ?? ''}`);
  assert((run.stderr ?? '').includes('before any custody marker was written'), 'and what the state is');
});

await test('a TERM after publication still fails, and tells the truth about the marker being there', () => {
  // THE OTHER SIDE OF THE SAME HANDLER, because "terminated" and "terminated, and the marker is in place
  // anyway" are different facts and an operator acts differently on each. The shim performs the REAL rename
  // and then signals, so the marker exists when the handler looks.
  //
  // The handler reads the FILESYSTEM rather than a `PUBLISHED=1` flag set on the line after `mv`: that flag
  // has a real window — a signal delivered between the rename returning and the assignment running would
  // report "not published" about a marker that is on disk. The marker has no such window.
  const shell = usableBash();
  if (shell === null) { console.log('        (skipped: no usable bash on this host)'); return; }
  const staged = stageMarkerProject('sig-after');
  if (staged === null) { console.log('        (skipped: this host cannot deliver a signal between processes)'); return; }
  const run = staged.runWithShim('mv', '/usr/bin/mv "$@"\nkill -TERM "$PPID"\nexit 0\n', 'bootstrap');

  assert(run.status !== 0, `a termination request is never a success — ${describeRun(run)}`);
  assertEq(signalOf(run), 15, `and it died of SIGTERM — ${describeRun(run)}`);
  assertEq(existsSync(join(staged.project, CUSTODY_MODE_FILENAME)), true, 'the rename had already happened');
  assertEq(staged.temporaries().length, 0, 'and no temporary survives either way');
  assert((run.stderr ?? '').includes('a custody marker IS present'),
    `the operator is told the marker is there: ${run.stderr ?? ''}`);
  assert((run.stderr ?? '').includes("'status'"), 'and how to find out which mode is in force');
  assert(!(run.stdout ?? '').includes('custody mode: bootstrap'), 'while the run still does not claim success');
});

await test('the marker temp name is unpredictable, and no process id ever names a file', () => {
  const script = parseShellSource(readRepo('deploy/unraid-custody-mode.sh'), 'deploy/unraid-custody-mode.sh');
  const executable = shellText(shellCode(script).lines);
  // `> "${MARKER}.tmp.$$"` was a name anybody could predict, through a redirection that FOLLOWS a symbolic
  // link — so a link planted at that name was a write wherever it pointed, as whichever account ran the
  // script. On Unraid that is root, in a web terminal.
  //
  // THE RULE IS ABOUT NAMING A FILE, NOT ABOUT THE CHARACTERS `$$`. Correction 1 added a signal handler that
  // re-raises the received signal against this very shell — `kill -s "$1" "$$"` — which is the one correct
  // use of a process id in this script and must not be swept up by a blanket ban. So every occurrence is
  // located and required to be an argument of `kill`, which is a claim about what the process id is FOR.
  // COMMENTS ARE EXCLUDED, because the comment three lines above this one QUOTES the old defect verbatim in
  // order to explain it. A gate that could not tell an explanation from an instruction would force the
  // script to stop documenting its own history.
  let signalled = 0;
  for (const logical of logicalLines(script)) {
    const executableLine = withoutComment(logical.text);
    if (!executableLine.includes('$$')) continue;
    const parts = words(executableLine, `${script.path}:${logical.line}`);
    assertEq(parts[0], 'kill',
      `a process id may only be signalled, never used to name a file — ${script.path}:${logical.line}: ${executableLine.trim()}`);
    signalled += 1;
  }
  assertEq(signalled, 1, 'and the one process id in the script is the re-raise in the signal handler');
  assert(!/>\s*"?\$\{MARKER\}\.tmp/.test(executable), 'and nothing is redirected into a predictable name');
  const bootstrap = shellText(caseArm(caseBlock(script, 'ACTION'), 'bootstrap'));
  assert(/mktemp\s+.*XXXXXXXXXX/.test(bootstrap), 'the arm that writes uses mktemp with ten random characters');
  assert(/mv -f "\$\{TEMP\}" "\$\{MARKER\}"/.test(bootstrap), 'and publishes by an atomic rename');
  assert(executable.includes('umask 077'), 'private from the instant it exists');
  // CORRECTION 1: EXIT AND THE SIGNALS ARE HANDLED SEPARATELY, and that separation is the fix. One handler
  // installed for all three ended in `return 0`, which made SIGINT and SIGTERM RESUME the script instead of
  // stopping it. The structural claim here is deliberately narrow — the behaviour is proved by sending a real
  // SIGTERM to the real script two tests above — but a single `trap ... EXIT INT TERM` reappearing is the
  // exact regression, and it is worth failing on the shape alone.
  assert(/trap on_exit EXIT$/m.test(executable), 'EXIT is cleaned up on every exit path, including a failing one');
  assert(/trap 'on_signal INT 2' INT/.test(executable), 'INT has its own handler');
  assert(/trap 'on_signal TERM 15' TERM/.test(executable), 'and so does TERM');
  // `trap - EXIT INT TERM` is the DISARM inside the signal handler, and it must name all three: it is what
  // stops the handler recursing and stops the EXIT trap running a second cleanup behind it. So the forbidden
  // shape is an INSTALL across all three, which is a handler, not a `-`.
  assert(!/trap\s+(?!-\s)\S+\s+EXIT\s+INT/.test(executable),
    'and no one handler serves EXIT and the signals, because a signal handler that returns RESUMES the script');
  assert(/trap - EXIT INT TERM/.test(executable), 'while the signal handler disarms all three before acting');
  assert(/kill -s "\$1" "\$\$"/.test(executable), 'a signal is re-raised with the default disposition');
});

// ---------------------------------------------------------------------------------------------------------
// 8. The boundary this tranche must not cross
// ---------------------------------------------------------------------------------------------------------

await test('nothing in this tranche reaches a network, a media server or an acquisition system', () => {
  for (const file of ['test/helpers/shell-source.ts', 'deploy/local-runtime-setup.ps1',
    'deploy/write-custody-secret.mjs', 'deploy/unraid-custody-mode.sh']) {
    const source = readRepo(file).toLowerCase();
    for (const forbidden of ['jellyfin', 'plex', 'emby', '/mnt/user/media', '.mkv', 'nzb', 'torrent', 'magnet',
      'sabnzbd', 'curl ', 'wget ', 'node:http', 'fetch(', 'invoke-webrequest']) {
      assert(!source.includes(forbidden), `${file} must not name ${forbidden}`);
    }
  }
});

await test('the custody mode script only PRINTS compose commands, and executes none', () => {
  // WHAT THIS SCRIPT IS FOR: reading or setting ONE marker file and showing the operator the command that
  // matches it. "It starts nothing, stops nothing, changes no YAML, touches no secret and contacts no
  // network" is its own header's promise, and a mode switch that also brought the stack up would decide an
  // operator's downtime for them.
  //
  // STRUCTURAL, BECAUSE THE DISTINCTION IS STRUCTURAL. The script's text is full of `docker compose ...`
  // strings — that is the advice it exists to print. What must not exist is one in COMMAND position, and
  // `callSites` answers that question directly. (Whether the commands this project really executes can fetch
  // is proved where those commands are actually built: `custody-cutover.ts` asserts the argv of every leg
  // from the ledger, and `custody-transition.ts` runs the shipped launcher against a fake `docker` and reads
  // back what it handed over. A source-text version of that gate here would be a weaker second copy.)
  const script = parseShellSource(readRepo('deploy/unraid-custody-mode.sh'), 'deploy/unraid-custody-mode.sh');
  assertEq(callSites(script, 'docker').length, 0, 'no docker command is ever in command position');
  assert(shellText(shellCode(script).lines).includes('docker compose'),
    'while the text it prints for the operator does name one, which is the whole point of the script');
  for (const forbidden of ['rm', 'mv', 'mktemp']) {
    const inStatus = shellText(caseArm(caseBlock(script, 'ACTION'), 'status'));
    assert(!new RegExp(`\\b${forbidden}\\b`).test(inStatus), `and status, which only reads, never runs ${forbidden}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`\n--- ${name}\n${(err as Error).stack ?? String(err)}`);
rmSync(WORK, { recursive: true, force: true });
if (failed > 0) process.exit(1);
