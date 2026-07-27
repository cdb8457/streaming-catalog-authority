import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asMap, parseYaml, stringList, yamlStrings, type YamlMap } from './helpers/compose-yaml.js';
import {
  KEYSTORE_EXPECTED_TOP_LEVEL,
  KEYSTORE_MAX_DEPTH,
  KEYSTORE_ROOT_MODE,
  KeystoreRepairError,
  type KeystoreEntryStat,
  type KeystoreFs,
  type KeystoreOwner,
  inspectKeystore,
  renderKeystoreRepairResult,
  repairKeystore,
  resolveKeystoreOwner,
} from '../src/ops/keystore-repair.js';
import {
  KEYSTORE_EXIT_OK,
  KEYSTORE_EXIT_REFUSED,
  KeystoreUsageError,
  keystoreExitCode,
  parseKeystoreArgs,
} from '../src/ops/keystore-repair-cli.js';

// Phase 263 — the safe repair of a keystore an EXISTING installation already created.
//
// WHAT THIS SUITE PROVES, AND WHY IT CAN PROVE IT ANYWHERE. Ownership is the whole subject, and a test cannot
// create a root-owned file without being root — nor can it create one at all on a platform with no uids. So
// the decision logic runs against an INJECTED filesystem, which can present every ownership state that
// matters exactly, deterministically, on every platform: fresh, already-correct, legacy root-owned, partially
// re-owned, symlinked, mixed-owner, world-writable, over-deep, over-wide, and unreadable.
//
// The real filesystem is exercised too, for the states a real filesystem can produce here — a missing
// directory being created, a repeat run writing nothing — so the injected seam is never the only thing that
// has ever run this code.
//
// AND THE SHIPPED WIRING IS CHECKED AS SHIPPED. The one-shot that runs the repair is asserted to exist in
// every stack that needs it, to be as narrow as it claims (root, no network, three capabilities, only the
// keystore mounted, no secrets), and to GATE the services that would otherwise start against a broken
// keystore — and the long-running app is asserted to be exactly as hardened as it was before this phase.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function assertThrows(fn: () => unknown, msg: string): unknown {
  try { fn(); } catch (err) { return err; }
  throw new Error(`${msg}: expected a throw, got none`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').split('\r\n').join('\n');
const compose = (rel: string): YamlMap => asMap(parseYaml(read(rel)).services!, `${rel} services`);

console.log('Running Phase 263 keystore repair suite:\n');

const OWNER: KeystoreOwner = { uid: 1000, gid: 1000, label: 'node (1000:1000)' };
/** Resolved, because `repairKeystore` resolves what it is given and the injected paths have to match it. */
const ROOT = resolve('/var/lib/catalog/keystore');
/** POSIX permission bits are a POSIX concept. Where they are not one, the injected suite above is the proof. */
const POSIX = process.platform !== 'win32';

// ---------------------------------------------------------------------------------------------------------
// An injectable filesystem that can present any ownership state, on any platform.
// ---------------------------------------------------------------------------------------------------------

interface FakeEntry extends KeystoreEntryStat { readonly children?: readonly string[]; }

class FakeFs implements KeystoreFs {
  readonly writes: string[] = [];
  private readonly entries = new Map<string, FakeEntry>();
  private readonly unreadable = new Set<string>();

  put(path: string, entry: FakeEntry): this { this.entries.set(path, entry); return this; }

  dir(path: string, opts: { uid?: number; gid?: number; mode?: number; children?: readonly string[] } = {}): this {
    return this.put(path, {
      kind: 'dir', uid: opts.uid ?? OWNER.uid, gid: opts.gid ?? OWNER.gid,
      mode: opts.mode ?? 0o700, children: opts.children ?? [],
    });
  }

  file(path: string, opts: { uid?: number; gid?: number; mode?: number } = {}): this {
    return this.put(path, { kind: 'file', uid: opts.uid ?? OWNER.uid, gid: opts.gid ?? OWNER.gid, mode: opts.mode ?? 0o600 });
  }

  breaks(path: string): this { this.unreadable.add(path); return this; }

  lstat(path: string): KeystoreEntryStat | null {
    if (this.unreadable.has(path)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const entry = this.entries.get(path);
    return entry === undefined ? null : { kind: entry.kind, uid: entry.uid, gid: entry.gid, mode: entry.mode };
  }

  readdir(path: string): readonly string[] {
    if (this.unreadable.has(path)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return this.entries.get(path)?.children ?? [];
  }

  mkdir(path: string, mode: number): void {
    this.writes.push(`mkdir ${path} ${mode.toString(8)}`);
    this.dir(path, { uid: 0, gid: 0, mode });
  }

  lchown(path: string, uid: number, gid: number): void {
    this.writes.push(`lchown ${path} ${uid}:${gid}`);
    const entry = this.entries.get(path);
    if (entry !== undefined) this.entries.set(path, { ...entry, uid, gid });
  }

  chmod(path: string, mode: number): void {
    this.writes.push(`chmod ${path} ${mode.toString(8)}`);
    const entry = this.entries.get(path);
    if (entry !== undefined) this.entries.set(path, { ...entry, mode });
  }
}

/** A complete, well-formed keystore owned by `uid`, with one key file in each of the four directories. */
function keystore(uid: number, gid = uid, rootMode = 0o700): FakeFs {
  const fs = new FakeFs().dir(ROOT, { uid, gid, mode: rootMode, children: [...KEYSTORE_EXPECTED_TOP_LEVEL] });
  for (const name of KEYSTORE_EXPECTED_TOP_LEVEL) {
    fs.dir(join(ROOT, name), { uid, gid, mode: 0o700, children: ['0ab1'] });
    fs.file(join(ROOT, name, '0ab1'), { uid, gid });
  }
  return fs;
}

// ---------------------------------------------------------------------------------------------------------
// The states an operator can actually be in
// ---------------------------------------------------------------------------------------------------------

test('a keystore that does not exist yet is CREATE, and creating it is the whole repair', () => {
  const fs = new FakeFs();
  const check = inspectKeystore(ROOT, OWNER, fs);
  assertEq(check.verdict, 'MISSING', 'verdict');
  assertEq(check.action, 'CREATE', 'action');
  assertEq(fs.writes.length, 0, 'an inspection writes nothing');

  const repaired = repairKeystore(ROOT, OWNER, { mode: 'repair' }, fs);
  assertEq(repaired.ok, true, 'the repair succeeded');
  assertEq(repaired.created, true, 'it reports that it created the directory');
  assertEq(repaired.verdict, 'ALREADY_CORRECT', 'and the keystore is correct afterwards');
  assert(fs.writes.some((w) => w.startsWith(`mkdir ${ROOT}`)), 'it created the directory');
  assert(fs.writes.some((w) => w === `lchown ${ROOT} 1000:1000`), 'and gave it to the runtime user');
  assert(fs.writes.some((w) => w === `chmod ${ROOT} ${KEYSTORE_ROOT_MODE.toString(8)}`), 'and made it private');
});

test('a keystore that is already correct is a no-op that touches nothing', () => {
  const fs = keystore(OWNER.uid);
  const result = repairKeystore(ROOT, OWNER, { mode: 'repair' }, fs);
  assertEq(result.verdict, 'ALREADY_CORRECT', 'verdict');
  assertEq(result.action, 'NONE', 'action');
  assertEq(result.ok, true, 'ok');
  assertEq(result.chowned, 0, 'nothing was re-owned');
  assertEq(fs.writes.length, 0, 'and NOTHING was written to the filesystem at all');
});

test('THE PHASE 262 DEFECT: a legacy root-owned keystore is repaired, key material untouched', () => {
  // This is the exact state an installation created before the Dockerfile fix is in: the whole tree owned by
  // root, the container running as node.
  const fs = keystore(0, 0, 0o755);
  const check = inspectKeystore(ROOT, OWNER, fs);
  assertEq(check.verdict, 'REPAIRABLE', 'a legacy keystore is repairable');
  assertEq(check.foreignUid, 0, 'and the foreign owner is named as root');
  assertEq(check.foreignEntries, 9, 'every entry is foreign (root + 4 dirs + 4 files)');
  assertEq(fs.writes.length, 0, 'the CHECK still wrote nothing');

  const result = repairKeystore(ROOT, OWNER, { mode: 'repair' }, fs);
  assertEq(result.ok, true, 'the repair succeeded');
  assertEq(result.chowned, 9, 'every entry was re-owned');
  assertEq(result.tightened, true, 'and the directory was made private');
  assertEq(result.verdict, 'ALREADY_CORRECT', 'the keystore is correct afterwards');
  // The complete list of operations. No read, no write, no unlink, no rename — of anything.
  const kinds = new Set(fs.writes.map((w) => w.split(' ')[0]));
  assertEq([...kinds].sort().join(','), 'chmod,lchown', 'the repair performed ONLY chown and chmod');
  assertEq(fs.writes.filter((w) => w.startsWith('chmod')).length, 1, 'and chmod touched only the root');
});

test('repeating a repair is free: the second run performs no filesystem write', () => {
  const fs = keystore(0, 0, 0o755);
  const first = repairKeystore(ROOT, OWNER, { mode: 'repair' }, fs);
  assert(first.chowned > 0, 'the first run did work');
  const writesAfterFirst = fs.writes.length;
  const second = repairKeystore(ROOT, OWNER, { mode: 'repair' }, fs);
  assertEq(second.verdict, 'ALREADY_CORRECT', 'the second run finds nothing to do');
  assertEq(second.chowned, 0, 'and re-owns nothing');
  assertEq(fs.writes.length, writesAfterFirst, 'and issues no further filesystem call');
});

test('a PARTIALLY repaired keystore — an interrupted earlier run — finishes rather than refusing', () => {
  // Root and `keys` already moved to node; the rest is still root's. Exactly the state a killed container
  // leaves. Two owners are present, but only ONE of them is foreign, so it is understood and finishable.
  const fs = keystore(0, 0, 0o755);
  fs.dir(ROOT, { uid: OWNER.uid, gid: OWNER.gid, mode: 0o700, children: [...KEYSTORE_EXPECTED_TOP_LEVEL] });
  fs.dir(join(ROOT, 'keys'), { uid: OWNER.uid, gid: OWNER.gid, mode: 0o700, children: ['0ab1'] });
  fs.file(join(ROOT, 'keys', '0ab1'), { uid: OWNER.uid, gid: OWNER.gid });

  const result = repairKeystore(ROOT, OWNER, { mode: 'repair' }, fs);
  assertEq(result.ok, true, 'it finished the job');
  assertEq(result.chowned, 6, 'exactly the entries that were still root-owned');
  assertEq(result.tightened, false, 'the root mode was already private, so it was left alone');
});

test('a correctly-owned keystore with a too-open ROOT is TIGHTENED, and does not cry wolf', () => {
  // WHAT THE CI GATE TAUGHT US. Docker re-initialises an EMPTY named volume from the image's directory —
  // ownership and mode included — on every container start. So a keystore that has not been written to yet
  // comes back at the image's 0755 after every `up`, forever. Treating that as "a repair is needed" made
  // `ops:keystore-check` exit non-zero on a perfectly healthy installation, every time, which is the
  // preflight-that-cries-wolf failure. Ownership is what predicts EACCES; the mode is hardening.
  const fs = keystore(OWNER.uid, OWNER.uid, 0o755);
  const check = inspectKeystore(ROOT, OWNER, fs);
  assertEq(check.verdict, 'ALREADY_CORRECT', 'ownership is what the verdict is about');
  assertEq(check.action, 'TIGHTEN', 'and the loose mode is still reported as something a repair would do');
  assertEq(check.rootTooOpen, true, 'the fact is not hidden');
  assert(/re-opens it on every container start/.test(check.detail), 'and the report explains why it recurs');
  assertEq(keystoreExitCode(repairKeystore(ROOT, OWNER, { mode: 'check' }, fs)), KEYSTORE_EXIT_OK,
    'a check on it exits ZERO: nothing here needs a human');

  const repaired = repairKeystore(ROOT, OWNER, { mode: 'repair' }, fs);
  assertEq(repaired.ok, true, 'the repair succeeded');
  assertEq(repaired.tightened, true, 'it tightened the mode');
  assertEq(repaired.chowned, 0, 'and re-owned nothing, because nothing was wrongly owned');
  assertEq(repaired.action, 'NONE', 'afterwards there is nothing left to do');
  assertEq(fs.writes.join(';'), `chmod ${ROOT} 700`, 'the ONLY filesystem call was the one chmod');
});

test('a mode this process cannot tighten is not a failure — the keystore still works', () => {
  const fs = keystore(OWNER.uid, OWNER.uid, 0o755);
  const denied: KeystoreFs = {
    lstat: (p) => fs.lstat(p),
    readdir: (p) => fs.readdir(p),
    mkdir: (p, m) => fs.mkdir(p, m),
    lchown: (p, u, g) => fs.lchown(p, u, g),
    chmod: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
  };
  const result = repairKeystore(ROOT, OWNER, { mode: 'repair' }, denied);
  assertEq(result.ok, true, 'a keystore that WORKS is not reported as broken over hardening');
  assertEq(result.tightened, false, 'and it says the mode was not tightened');
  assertEq(keystoreExitCode(result), KEYSTORE_EXIT_OK, 'so it cannot stop a stack');
});

test('a keystore whose root is correct but whose CONTENTS are not is still repaired', () => {
  // The state `accessSync(W_OK)` reports as healthy and the app then dies on: a writable root over a tree the
  // process does not own.
  const fs = keystore(0, 0, 0o700);
  fs.dir(ROOT, { uid: OWNER.uid, gid: OWNER.gid, mode: 0o700, children: [...KEYSTORE_EXPECTED_TOP_LEVEL] });
  const check = inspectKeystore(ROOT, OWNER, fs);
  assertEq(check.verdict, 'REPAIRABLE', 'the tree below a correct root still needs work');
  assertEq(check.foreignEntries, 8, 'and every entry below it is named');
});

// ---------------------------------------------------------------------------------------------------------
// The states it must REFUSE. Every one of them writes nothing.
// ---------------------------------------------------------------------------------------------------------

const REFUSALS: ReadonlyArray<[string, string, () => FakeFs]> = [
  ['a symlink INSIDE the keystore', 'UNSAFE_SYMLINK', () => {
    const fs = keystore(0);
    fs.put(join(ROOT, 'keys', '0ab1'), { kind: 'symlink', uid: 0, gid: 0, mode: 0o777 });
    return fs;
  }],
  ['a keystore path that is itself a symlink', 'UNSAFE_SYMLINK', () =>
    new FakeFs().put(ROOT, { kind: 'symlink', uid: 0, gid: 0, mode: 0o777 })],
  ['a keystore path that is a regular file', 'UNSAFE_ROOT_NOT_A_DIRECTORY', () => new FakeFs().file(ROOT)],
  ['a device, socket or FIFO in the tree', 'UNSAFE_SPECIAL_FILE', () => {
    const fs = keystore(0);
    fs.put(join(ROOT, 'ops', '0ab1'), { kind: 'other', uid: 0, gid: 0, mode: 0o600 });
    return fs;
  }],
  ['TWO different foreign owners', 'UNSAFE_MIXED_OWNERSHIP', () => {
    const fs = keystore(0);
    fs.file(join(ROOT, 'keys', '0ab1'), { uid: 4242, gid: 4242 });
    return fs;
  }],
  ['a world-writable key file', 'UNSAFE_WORLD_WRITABLE', () => {
    const fs = keystore(0);
    fs.file(join(ROOT, 'keys', '0ab1'), { uid: 0, gid: 0, mode: 0o666 });
    return fs;
  }],
  ['an entry that is not part of a keystore', 'UNSAFE_UNEXPECTED_ENTRY', () => {
    const fs = keystore(0);
    fs.dir(ROOT, { uid: 0, gid: 0, mode: 0o755, children: [...KEYSTORE_EXPECTED_TOP_LEVEL, 'somebody-elses-data'] });
    fs.dir(join(ROOT, 'somebody-elses-data'), { uid: 0, gid: 0, children: [] });
    return fs;
  }],
  ['a tree deeper than a keystore goes', 'UNSAFE_TOO_DEEP', () => {
    const fs = keystore(0);
    fs.dir(join(ROOT, 'keys'), { uid: 0, gid: 0, mode: 0o700, children: ['deeper'] });
    fs.dir(join(ROOT, 'keys', 'deeper'), { uid: 0, gid: 0, mode: 0o700, children: ['deeper'] });
    fs.dir(join(ROOT, 'keys', 'deeper', 'deeper'), { uid: 0, gid: 0, mode: 0o700, children: [] });
    return fs;
  }],
  ['a directory that cannot be listed', 'UNSAFE_UNREADABLE', () => keystore(0).breaks(join(ROOT, 'keys'))],
  ['a root that cannot be examined', 'UNSAFE_UNREADABLE', () => keystore(0).breaks(ROOT)],
];

for (const [what, code, build] of REFUSALS) {
  test(`REFUSES ${what} (${code}) and changes nothing`, () => {
    const fs = build();
    const check = inspectKeystore(ROOT, OWNER, fs);
    assertEq(check.verdict, code, 'the verdict names the state');
    assertEq(check.action, 'REFUSE', 'and refuses');

    const result = repairKeystore(ROOT, OWNER, { mode: 'repair' }, fs);
    assertEq(result.ok, false, 'a REPAIR run also refuses');
    assertEq(result.verdict, code, 'with the same verdict');
    assertEq(fs.writes.length, 0, 'and performs no filesystem write of any kind');
    assert(result.guidance.length > 0, 'and tells the operator what to do instead');
  });
}

test('a refusal is reported honestly by the exit code, and so is "a repair is still needed"', () => {
  const refused = repairKeystore(ROOT, OWNER, { mode: 'check' }, keystore(0).breaks(ROOT));
  assertEq(keystoreExitCode(refused), KEYSTORE_EXIT_REFUSED, 'a refusal is non-zero');
  // The CHECK that finds work is ALSO non-zero: a preflight that says "your keystore is unwritable" and exits
  // 0 is a preflight nothing can gate on.
  const needsWork = repairKeystore(ROOT, OWNER, { mode: 'check' }, keystore(0));
  assertEq(needsWork.ok, true, 'the state is understood');
  assertEq(keystoreExitCode(needsWork), KEYSTORE_EXIT_REFUSED, 'but the check still exits non-zero');
  assertEq(keystoreExitCode(repairKeystore(ROOT, OWNER, { mode: 'check' }, keystore(OWNER.uid))), KEYSTORE_EXIT_OK,
    'and only an already-correct keystore exits zero');
});

test('a chown the process is not permitted to perform fails CLOSED, and says the keystore may be partial', () => {
  const fs = keystore(0);
  const denied: KeystoreFs = {
    lstat: (p) => fs.lstat(p),
    readdir: (p) => fs.readdir(p),
    mkdir: (p, m) => fs.mkdir(p, m),
    chmod: (p, m) => fs.chmod(p, m),
    lchown: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
  };
  const result = repairKeystore(ROOT, OWNER, { mode: 'repair' }, denied);
  assertEq(result.ok, false, 'it is not reported as a success');
  assert(/not permitted/.test(result.detail), 'and it says why');
  assert(result.guidance.some((g) => /root/.test(g)), 'and what to do about it');
});

// ---------------------------------------------------------------------------------------------------------
// Redaction: a report is safe to paste into an issue
// ---------------------------------------------------------------------------------------------------------

test('no report ever carries a file name from inside the keystore, or any content', () => {
  const fs = keystore(0);
  fs.dir(ROOT, { uid: 0, gid: 0, mode: 0o755, children: [...KEYSTORE_EXPECTED_TOP_LEVEL, 'a-very-private-folder-name'] });
  fs.dir(join(ROOT, 'a-very-private-folder-name'), { uid: 0, gid: 0, children: [] });
  const rendered = renderKeystoreRepairResult(repairKeystore(ROOT, OWNER, { mode: 'check' }, fs));
  assert(!rendered.includes('a-very-private-folder-name'), 'the unexpected entry is NOT echoed');
  assert(!rendered.includes('0ab1'), 'and neither is any key file name');
  assert(rendered.includes('UNSAFE_UNEXPECTED_ENTRY'), 'the code is still there to act on');

  const legacy = renderKeystoreRepairResult(repairKeystore(ROOT, OWNER, { mode: 'check' }, keystore(0)));
  assert(!legacy.includes('0ab1'), 'a repairable report names no key file either');
  assert(legacy.includes('uid 0'), 'it names the foreign uid, which is what an operator needs');
  assert(legacy.includes('REFUSED') || legacy.includes('REPAIRABLE'), 'and states its verdict plainly');
});

// ---------------------------------------------------------------------------------------------------------
// Owner resolution
// ---------------------------------------------------------------------------------------------------------

test('an owner is resolved from the system passwd rather than assumed to be uid 1000', () => {
  const passwd = 'root:x:0:0:root:/root:/bin/sh\nnode:x:1000:1000::/home/node:/bin/bash\n';
  const resolved = resolveKeystoreOwner('node', () => passwd);
  assertEq(resolved.uid, 1000, 'uid');
  assertEq(resolved.gid, 1000, 'gid');
  // ...and it really reads the file rather than hard-coding the answer.
  const moved = resolveKeystoreOwner('node', () => 'node:x:2000:3000::/home/node:/bin/bash\n');
  assertEq(moved.uid, 2000, 'a differently-numbered node user resolves to ITS uid');
  assertEq(moved.gid, 3000, 'and its gid');
});

test('a numeric owner is accepted, with or without a group', () => {
  assertEq(resolveKeystoreOwner('1000').uid, 1000, 'uid');
  assertEq(resolveKeystoreOwner('1000').gid, 1000, 'gid defaults to the uid');
  assertEq(resolveKeystoreOwner('1000:2000').gid, 2000, 'an explicit gid is used');
});

test('an unknown, malformed or unresolvable owner is a refusal, not a guess', () => {
  for (const bad of ['', '  ', 'no-such-user-here', '../../etc/passwd', 'root; rm -rf /', '99999999999']) {
    const err = assertThrows(() => resolveKeystoreOwner(bad, () => 'node:x:1000:1000::/home/node:/bin/bash\n'),
      `"${bad}" is refused`);
    assert(err instanceof KeystoreRepairError, `"${bad}" is refused as a repair error`);
  }
  const err = assertThrows(() => resolveKeystoreOwner('node', () => { throw new Error('ENOENT'); }),
    'an unreadable passwd is refused');
  assert(/numerically/.test((err as Error).message), 'and it says how to name the owner instead');
});

// ---------------------------------------------------------------------------------------------------------
// The CLI surface
// ---------------------------------------------------------------------------------------------------------

test('the CLI reports by default and only repairs when asked', () => {
  const env = { CUSTODIAN_KEYSTORE_DIR: ROOT } as NodeJS.ProcessEnv;
  assertEq(parseKeystoreArgs([], env).repair, false, 'the default is a check');
  assertEq(parseKeystoreArgs(['--repair'], env).repair, true, '--repair opts in');
  assertEq(parseKeystoreArgs(['--repair', '--check'], env).repair, false, 'and --check wins back');
  assertEq(parseKeystoreArgs([], env).dir, ROOT, 'the directory comes from the environment');
  assertEq(parseKeystoreArgs(['--dir', '/other'], env).dir, '/other', 'and a flag overrides it');
  assertEq(parseKeystoreArgs([], env).owner, 'node', 'the default owner is the image\'s runtime user');
  assertEq(parseKeystoreArgs([], { ...env, CATALOG_KEYSTORE_OWNER: '1000:1000' } as NodeJS.ProcessEnv).owner,
    '1000:1000', 'and the environment can name a different one');
});

test('the CLI refuses bad usage rather than acting on a guess', () => {
  const env = { CUSTODIAN_KEYSTORE_DIR: ROOT } as NodeJS.ProcessEnv;
  for (const argv of [['--dir'], ['--owner'], ['--dir', '--repair'], ['--nonsense']]) {
    const err = assertThrows(() => parseKeystoreArgs(argv, env), `${argv.join(' ')} is refused`);
    assert(err instanceof KeystoreUsageError, `${argv.join(' ')} is a usage error`);
  }
  const err = assertThrows(() => parseKeystoreArgs([], {} as NodeJS.ProcessEnv), 'no directory at all is refused');
  assert(/CUSTODIAN_KEYSTORE_DIR/.test((err as Error).message), 'and it names the variable to set');
});

test('the package scripts run the check and the repair, and the repair is the one that opts in', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert(pkg.scripts['ops:keystore-check'] !== undefined, 'ops:keystore-check exists');
  assert(pkg.scripts['ops:keystore-repair'] !== undefined, 'ops:keystore-repair exists');
  assert(!pkg.scripts['ops:keystore-check']!.includes('--repair'), 'the check does not repair');
  assert(pkg.scripts['ops:keystore-repair']!.includes('--repair'), 'and the repair does');
  assertEq(pkg.scripts['test:phase263-local'], 'tsx test/keystore-repair.ts', 'this suite is in the scripts');
});

// ---------------------------------------------------------------------------------------------------------
// The REAL filesystem, for the states a real filesystem can produce on any platform
// ---------------------------------------------------------------------------------------------------------

test('against a real filesystem: a missing keystore is created, and real key files survive a repeat run', () => {
  const base = mkdtempSync(join(tmpdir(), 'keystore-repair-'));
  try {
    const dir = join(base, 'keystore');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
    const owner: KeystoreOwner = { uid, gid, label: `this process (${uid}:${gid})` };

    const created = repairKeystore(dir, owner, { mode: 'repair' });
    assertEq(created.created, true, 'the directory was created');
    assert(existsSync(dir), 'and it is really there');

    // A real, well-formed keystore laid out the way FileCustodian lays one out.
    for (const name of KEYSTORE_EXPECTED_TOP_LEVEL) {
      mkdirSync(join(dir, name), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, name, 'abc123'), '{"wrappedHex":"deadbeef"}', { mode: 0o600 });
    }
    const second = repairKeystore(dir, owner, { mode: 'repair' });
    // The material is still exactly where it was, byte for byte, whatever the verdict was. This is the
    // assertion that matters on every platform: a repair never touches key content.
    for (const name of KEYSTORE_EXPECTED_TOP_LEVEL) {
      assertEq(readFileSync(join(dir, name, 'abc123'), 'utf8'), '{"wrappedHex":"deadbeef"}', `${name}/abc123 is untouched`);
    }
    if (!POSIX) {
      // Windows reports SYNTHETIC permission bits — a file created with mode 0600 reads back as 0666, which
      // this code correctly calls world-writable — and has no uids at all. So neither the verdict nor the
      // entry count is a thing that can honestly be asserted against a Windows filesystem. Saying so beats
      // relaxing a real safety rule to make a developer's machine agree with it; the injected-filesystem
      // suite above proves the verdict on every platform, including this one.
      console.log('        (the ownership verdict is asserted on POSIX only — Windows has no uids or real modes)');
      return;
    }
    assertEq(second.entries, 1 + KEYSTORE_EXPECTED_TOP_LEVEL.length * 2, 'every entry was examined');
    assertEq(second.verdict, 'ALREADY_CORRECT', 'a keystore this process owns is already correct');
    assertEq(second.chowned, 0, 'and nothing was re-owned');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('against a real filesystem: an unexpected entry beside a keystore is refused, and nothing is removed', () => {
  const base = mkdtempSync(join(tmpdir(), 'keystore-refuse-'));
  try {
    const dir = join(base, 'keystore');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
    mkdirSync(join(dir, 'keys'), { recursive: true });
    writeFileSync(join(dir, 'not-a-keystore-file'), 'operator data');
    const result = repairKeystore(dir, { uid, gid, label: 'test' }, { mode: 'repair' });
    assertEq(result.ok, false, 'it refused');
    assertEq(result.verdict, 'UNSAFE_UNEXPECTED_ENTRY', 'naming the reason');
    assertEq(readFileSync(join(dir, 'not-a-keystore-file'), 'utf8'), 'operator data', 'and removed nothing');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('against a real filesystem: a created keystore is private to its owner (POSIX only)', () => {
  if (!POSIX) {
    console.log('        (skipped honestly: Windows has no POSIX permission bits to assert)');
    return;
  }
  const base = mkdtempSync(join(tmpdir(), 'keystore-mode-'));
  try {
    const dir = join(base, 'keystore');
    const uid = process.getuid!();
    const gid = process.getgid!();
    repairKeystore(dir, { uid, gid, label: 'test' }, { mode: 'repair' });
    assertEq(statSync(dir).mode & 0o7777, KEYSTORE_ROOT_MODE, 'the keystore is 0700');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------
// The shipped wiring — as shipped
// ---------------------------------------------------------------------------------------------------------

/** Every stack whose long-running app runs as a non-root user over a file-mode keystore. */
const REPAIRED_STACKS = ['docker-compose.runtime.yml', 'docker-compose.arcane.yml'] as const;

for (const file of REPAIRED_STACKS) {
  test(`${file} runs the repair as a one-shot before anything that needs the keystore`, () => {
    const services = compose(file);
    const prepare = asMap(services['keystore-prepare']!, 'keystore-prepare');
    assert(prepare !== undefined, 'the stack has a keystore-prepare service');
    assertEq(String(prepare.restart), 'no', 'it is a one-shot that never restarts');
    assertEq(yamlStrings(prepare.command!).join(' '), 'ops:keystore-repair', 'it runs the repair');
    assertEq(yamlStrings(prepare.entrypoint!).join(' '), 'npm run', 'through the shipped script');

    for (const dependent of ['migrate', 'app']) {
      const deps = asMap(asMap(services[dependent]!, dependent).depends_on!, `${dependent}.depends_on`);
      const gate = asMap(deps['keystore-prepare']!, `${dependent} gate`);
      assertEq(String(gate.condition), 'service_completed_successfully',
        `${dependent} does not start until the repair exits zero`);
    }
  });

  test(`${file}'s repair one-shot is as narrow as it claims`, () => {
    const prepare = asMap(compose(file)['keystore-prepare']!, 'keystore-prepare');
    assertEq(String(prepare.user), '0:0', 'it runs as root — that is the whole point, and it is stated');
    assertEq(String(prepare.network_mode), 'none', 'and has NO network at all');
    assertEq(String(prepare.read_only), 'true', 'its own filesystem is read-only');
    assertEq(stringList(prepare.cap_drop!, 'cap_drop').join(','), 'ALL', 'every capability is dropped');
    assertEq(stringList(prepare.cap_add!, 'cap_add').sort().join(','), 'CHOWN,DAC_OVERRIDE,FOWNER',
      'and exactly the three that changing ownership needs are added back');
    assert(stringList(prepare.security_opt!, 'security_opt').includes('no-new-privileges:true'),
      'it cannot gain privileges');
    assertEq(prepare.secrets, undefined, 'IT IS GIVEN NO SECRET — not the KEK, not the completion secret, not a token');
    const mounts = stringList(prepare.volumes!, 'volumes');
    assertEq(mounts.length, 1, 'it mounts exactly one thing');
    assert(mounts[0]!.endsWith(':/var/lib/catalog/keystore'), 'and that one thing is the keystore');
    const env = asMap(prepare.environment!, 'environment');
    assertEq(String(env.CUSTODIAN_KEYSTORE_DIR), '/var/lib/catalog/keystore', 'it is told which directory');
    assertEq(String(env.CATALOG_KEYSTORE_OWNER), 'node', 'and which user the app runs as');
    assertEq(env.DATABASE_URL_FILE, undefined, 'it is given no database credential');
    assertEq(env.ADMIN_DATABASE_URL_FILE, undefined, 'not even a read-only one');
  });

  test(`${file}'s long-running app is exactly as hardened as it was before this phase`, () => {
    const app = asMap(compose(file).app!, 'app');
    assertEq(String(app.user), 'node', 'the app still runs non-root');
    assertEq(String(app.read_only), 'true', 'still read-only rootfs');
    assertEq(stringList(app.cap_drop!, 'cap_drop').join(','), 'ALL', 'still drops every capability');
    assertEq(app.cap_add, undefined, 'and adds NONE back');
    assert(stringList(app.security_opt!, 'security_opt').includes('no-new-privileges:true'), 'still no-new-privileges');
    assertEq(app.network_mode, undefined, 'and it keeps the network it needs to serve a UI');
  });
}

test('the stacks whose app runs as root are deliberately NOT given a repair one-shot', () => {
  // docker-compose.unraid.yml and docker-compose.deploy.yml run their containers as root over the same
  // keystore, so root ownership is CORRECT there and a chown to `node` would break them. Adding the one-shot
  // everywhere "for consistency" would be the change that turned a working deployment into a broken one.
  for (const file of ['docker-compose.unraid.yml', 'docker-compose.deploy.yml']) {
    const services = compose(file);
    assertEq(services['keystore-prepare'], undefined, `${file} has no repair one-shot`);
    for (const name of Object.keys(services)) {
      const svc = asMap(services[name]!, name);
      assert(svc.user === undefined || String(svc.user) !== 'node',
        `${file}'s ${name} does not run as node, so root ownership of the keystore is correct there`);
    }
  }
});

test('the image still prepares the keystore, so a FRESH volume never needs the repair at all', () => {
  // The Dockerfile fix and the repair one-shot solve different halves of the same problem, and neither
  // replaces the other. This asserts the first half is still in place.
  const dockerfile = read('Dockerfile.runtime');
  const runIndex = dockerfile.indexOf('/var/lib/catalog/keystore');
  const userIndex = dockerfile.indexOf('\nUSER node');
  assert(runIndex >= 0, 'the image creates the keystore directory');
  assert(userIndex > runIndex, 'while it can still chown — before the drop to non-root');
});

test('ops:doctor reports keystore OWNERSHIP, not only whether the directory happens to be writable', () => {
  const doctor = read('src/ops/doctor.ts');
  assert(doctor.includes('keystore-ownership'), 'there is a keystore-ownership check');
  assert(doctor.includes('inspectKeystore'), 'and it uses the same inspection the repair uses');
  assert(/getuid/.test(doctor), 'it asks the process what it actually is');
  assert(doctor.includes('PHASE_263'), 'and points at the document that explains the repair');
});

test('the Phase 263 document states the command, the boundary, the manual fallback and the rollback', () => {
  const doc = read('docs/PHASE_263_KEYSTORE_REPAIR.md');
  for (const required of [
    'Phase 263',
    'ops:keystore-check',
    'ops:keystore-repair',
    'keystore-prepare',
    'Manual fallback',
    'Rollback',
    'Limitations',
  ]) {
    assert(doc.includes(required), `the doc mentions ${required}`);
  }
  assert(/never/i.test(doc) && /delete|remove/i.test(doc), 'it states what the repair will never do');
  assert(doc.includes(`${KEYSTORE_MAX_DEPTH}`), 'and names its bounds');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
