import { spawnSync } from 'node:child_process';
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
// 7. The mode marker: atomic, unpredictable, and removed by the arm that owns removal
// ---------------------------------------------------------------------------------------------------------

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

await test('the marker temp name is unpredictable, and no process id ever names a file', () => {
  const script = parseShellSource(readRepo('deploy/unraid-custody-mode.sh'), 'deploy/unraid-custody-mode.sh');
  const executable = shellText(shellCode(script).lines);
  // `> "${MARKER}.tmp.$$"` was a name anybody could predict, through a redirection that FOLLOWS a symbolic
  // link — so a link planted at that name was a write wherever it pointed, as whichever account ran the
  // script. On Unraid that is root, in a web terminal.
  assert(!/\$\$/.test(executable), 'no process id names a file');
  assert(!/>\s*"?\$\{MARKER\}\.tmp/.test(executable), 'and nothing is redirected into a predictable name');
  const bootstrap = shellText(caseArm(caseBlock(script, 'ACTION'), 'bootstrap'));
  assert(/mktemp\s+.*XXXXXXXXXX/.test(bootstrap), 'the arm that writes uses mktemp with ten random characters');
  assert(/mv -f "\$\{TEMP\}" "\$\{MARKER\}"/.test(bootstrap), 'and publishes by an atomic rename');
  assert(executable.includes('umask 077'), 'private from the instant it exists');
  assert(/trap cleanup EXIT/.test(executable), 'and cleaned up on every exit path, including a failing one');
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
