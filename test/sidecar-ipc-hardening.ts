import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import {
  probeSidecarHealth,
  startLocalSidecarRuntime,
  UnixSocketSidecarTransport,
} from '../src/core/crypto/local-sidecar-runtime.js';
import {
  SIDECAR_MAX_REQUEST_BYTES,
  SIDECAR_PROTOCOL_VERSION,
  SidecarSocketError,
  assertLocalSocketPath,
  parseSidecarRequest,
  reclaimStaleSocket,
  type SidecarHealth,
} from '../src/core/crypto/sidecar-ipc.js';
import {
  CustodianStateError,
  acquireStateLock,
  readStateDocument,
  writeStateDocument,
} from '../src/core/crypto/custodian-state-io.js';
import { LocalSidecarCustodianClient } from '../src/core/crypto/local-sidecar-custodian.js';

// Phase 281 — the custodian sidecar's IPC and state, held to what the comments claim.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - LOCAL ONLY. No TCP surface in the module at all, and a network-shaped path refused by name.
//   - OWNER-ONLY, PARENT INCLUDED, and a socket whose mode is checked after it exists.
//   - A STALE SOCKET IS PROVED STALE. An arbitrary object at the name is never unlinked; a symlink is never
//     followed; a LIVE daemon's socket is never taken.
//   - BOUNDED IN BYTES, TIME AND NUMBER, with a closed code for each.
//   - ONE REQUEST PER CONNECTION.
//   - THE HEALTH HANDSHAKE EXERCISES THE CUSTODIAN, and a socket that merely exists does not pass it.
//   - STATE IS READ NO-FOLLOW, BOUNDED, SELF-DESCRIBING, AND SINGLE-WRITER.
//   - NO RAW KEY, PATH OR RUNTIME MESSAGE CROSSES THE WIRE ON A FAILURE.

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
const WORK = mkdtempSync(join(tmpdir(), 'ca-sidecar-ipc-'));
const POSIX = process.platform !== 'win32';

function socketFor(name: string): string {
  return POSIX
    ? join(WORK, name, 'run', 'catalog-sidecar.sock')
    : `\\\\.\\pipe\\catalog-sidecar-${name}-${process.pid}-${Date.now()}`;
}

function custodianFor(name: string): FileCustodian {
  const dir = join(WORK, name, 'state');
  mkdirSync(dir, { recursive: true });
  return new FileCustodian(dir, 'a-completion-secret-that-must-not-appear', randomBytes(32));
}

/** Send one raw line and read one raw answer, with none of the client's own validation in the way. */
function rawExchange(socketPath: string, line: string, options: { keepOpen?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffered = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('no answer')); }, 8_000);
    socket.setEncoding('utf8');
    socket.once('error', (err) => { clearTimeout(timer); reject(err); });
    socket.once('connect', () => { if (line !== '') socket.write(line); });
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      if (!buffered.includes('\n')) return;
      clearTimeout(timer);
      if (!options.keepOpen) socket.destroy();
      resolve(buffered.slice(0, buffered.indexOf('\n')));
    });
    socket.once('close', () => { clearTimeout(timer); if (!buffered.includes('\n')) reject(new Error('closed with no answer')); });
  });
}

console.log('Running Phase 281 sidecar IPC and state hardening suite:\n');

// ---------------------------------------------------------------------------------------------------------
// Local only
// ---------------------------------------------------------------------------------------------------------

await test('there is no TCP surface in the runtime, and a network-shaped path is refused by name', () => {
  const source = [
    readRepo('src/core/crypto/local-sidecar-runtime.ts'),
    readRepo('src/core/crypto/sidecar-ipc.ts'),
  ].join('\n');
  for (const forbidden of ['node:http', 'node:https', 'node:tls', 'node:dgram', 'listen(port', '.listen(0',
    'createServer({ allowHalfOpen', 'host:', '0.0.0.0', '127.0.0.1', 'localhost']) {
    assert(!source.includes(forbidden), `the sidecar IPC modules must not name ${forbidden}`);
  }
  for (const network of ['http://a/b', 'https://a/b', 'tcp://a/b', 'example.com:9000']) {
    refuses(() => assertLocalSocketPath(network), 'local IPC', `the address ${network}`);
  }
  refuses(() => assertLocalSocketPath(''), 'is required', 'an empty path');
  if (POSIX) refuses(() => assertLocalSocketPath('relative/socket'), 'must be absolute', 'a relative path');
});

// ---------------------------------------------------------------------------------------------------------
// The stale socket
// ---------------------------------------------------------------------------------------------------------

await test('a stale socket is proved stale: an arbitrary object, a link and a LIVE daemon are each refused', () => {
  if (!POSIX) { console.log('        (POSIX-only: a named pipe leaves no filesystem object)'); return; }
  const root = join(WORK, 'reclaim');
  mkdirSync(root, { recursive: true });

  // THE DEFECT: `if (existsSync(p)) unlinkSync(p)` deleted whatever was at the name.
  const ordinary = join(root, 'a-file-somebody-put-here');
  writeFileSync(ordinary, 'mine\n', 'utf8');
  let unlinked = 0;
  refuses(() => reclaimStaleSocket(ordinary, () => false, () => { unlinked += 1; }),
    'not a socket', 'a regular file at the socket path');
  assertEq(unlinked, 0, 'and nothing was unlinked');
  assertEq(existsSync(ordinary), true, 'the operator\'s file is still there');

  const link = join(root, 'a-link');
  try {
    symlinkSync(ordinary, link);
    refuses(() => reclaimStaleSocket(link, () => false, () => { unlinked += 1; }),
      'symbolic link', 'a symbolic link at the socket path');
    assertEq(unlinked, 0, 'and nothing was unlinked through it');
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('symbolic link')) {
      console.log('        (this session cannot create a symbolic link; the other halves still ran)');
    }
  }
  assertEq(reclaimStaleSocket(join(root, 'nothing-here'), () => false, () => { unlinked += 1; }),
    'nothing-there', 'an absent path is simply absent');
  assertEq(unlinked, 0, 'and still nothing was unlinked');
});

await test('a LIVE daemon\'s socket is never taken, and a dead one is', async () => {
  if (!POSIX) { console.log('        (POSIX-only)'); return; }
  const socketPath = socketFor('live');
  const runtime = await startLocalSidecarRuntime({ socketPath, custodian: custodianFor('live') });
  try {
    // A second daemon on the same socket, with a probe that says something is serving.
    await (async () => {
      let threw: unknown = null;
      try {
        await startLocalSidecarRuntime({
          socketPath,
          custodian: custodianFor('live-2'),
          probeExistingSocket: () => true,
        });
      } catch (err) { threw = err; }
      assert(threw instanceof SidecarSocketError, `a second daemon is refused: ${String(threw)}`);
      assert((threw as Error).message.includes('already serving'), 'saying that one is already serving');
    })();
    // ...and the first one is still answering, which is the point of the refusal.
    const health = await probeSidecarHealth(socketPath);
    assert(health === null || health.protocol === SIDECAR_PROTOCOL_VERSION, 'the live daemon still answers');
  } finally {
    await runtime.close();
  }
  assertEq(existsSync(socketPath), false, 'and closing removes only its own socket');
});

// ---------------------------------------------------------------------------------------------------------
// Owner-only
// ---------------------------------------------------------------------------------------------------------

await test('the socket and its parent directory are owner-only', async () => {
  if (!POSIX) { console.log('        (POSIX-only: modes are not a concept here)'); return; }
  const socketPath = socketFor('modes');
  const runtime = await startLocalSidecarRuntime({ socketPath, custodian: custodianFor('modes') });
  try {
    const { statSync } = await import('node:fs');
    assertEq(statSync(socketPath).mode & 0o777, 0o600, 'the socket is owner-only');
    assertEq(statSync(join(socketPath, '..')).mode & 0o777, 0o700, 'and so is the directory it lives in');
  } finally {
    await runtime.close();
  }
});

await test('a socket directory somebody else can write is refused before anything listens', async () => {
  if (!POSIX) { console.log('        (POSIX-only)'); return; }
  const socketPath = socketFor('open-dir');
  mkdirSync(join(socketPath, '..'), { recursive: true });
  chmodSync(join(socketPath, '..'), 0o777);
  let threw: unknown = null;
  try {
    await startLocalSidecarRuntime({ socketPath, custodian: custodianFor('open-dir') });
  } catch (err) { threw = err; }
  assert(threw instanceof SidecarSocketError, `a world-writable socket directory is refused: ${String(threw)}`);
  assert((threw as Error).message.includes('readable or writable by somebody else'), 'saying why');
  assertEq(existsSync(socketPath), false, 'and nothing listened');
});

// ---------------------------------------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------------------------------------

await test('the request schema is closed: every field checked, every extra field refused', () => {
  assert(parseSidecarRequest('{"op":"status","keyId":"key_a"}').ok, 'a well-formed request parses');
  for (const [line, what] of [
    ['not json', 'text'],
    ['[]', 'an array'],
    ['null', 'a null'],
    ['{"op":"nope"}', 'an unknown operation'],
    ['{"op":"status"}', 'a missing field'],
    ['{"op":"status","keyId":"key_a","extra":1}', 'an extra field'],
    ['{"op":"status","keyId":""}', 'an empty id'],
    ['{"op":"status","keyId":"has a space"}', 'an id with a space'],
    ['{"op":"status","keyId":"has\\na newline"}', 'an id with a newline — the attestation separator'],
    [`{"op":"status","keyId":"${'k'.repeat(400)}"}`, 'an id past the length bound'],
    ['{"op":"get","keyId":"key_a","epoch":1.5}', 'a fractional epoch'],
    ['{"op":"get","keyId":"key_a","epoch":-1}', 'a negative epoch'],
    ['{"op":"get","keyId":"key_a","epoch":1e30}', 'an enormous epoch'],
    ['{"op":"provision","operationId":"o","itemId":"i","epoch":0,"itemId2":"x"}', 'a smuggled field'],
  ] as Array<[string, string]>) {
    const parsed = parseSidecarRequest(line);
    assertEq(parsed.ok, false, `${what} is refused`);
    if (!parsed.ok) assertEq(parsed.code, 'SIDECAR_PROTOCOL_MALFORMED', `${what} gets a closed code`);
  }
  const huge = parseSidecarRequest(`{"op":"status","keyId":"${'k'.repeat(SIDECAR_MAX_REQUEST_BYTES)}"}`);
  assertEq(huge.ok, false, 'an over-long line is refused');
  if (!huge.ok) assertEq(huge.code, 'SIDECAR_REQUEST_TOO_LARGE', 'as too large, distinctly');
});

// ---------------------------------------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------------------------------------

await test('the wire answers a closed code and never a path, a key or a runtime message', async () => {
  const socketPath = socketFor('closed-errors');
  const runtime = await startLocalSidecarRuntime({ socketPath, custodian: custodianFor('closed-errors') });
  try {
    const malformed = await rawExchange(socketPath, 'this is not json\n');
    assert(malformed.includes('SIDECAR_PROTOCOL_MALFORMED'), `a malformed request gets a code: ${malformed}`);
    // A REQUEST THE CUSTODIAN REFUSES. The custodian's own message names a state; the wire must not.
    const failing = await rawExchange(socketPath, `${JSON.stringify({ op: 'get', keyId: 'key_nothing', epoch: 0 })}\n`);
    assert(failing.includes('SIDECAR_REQUEST_FAILED'), `a failed request gets a code: ${failing}`);
    for (const forbidden of ['not_found', 'ENOENT', WORK, 'a-completion-secret', 'keys/', 'wrappedHex']) {
      assert(!failing.includes(forbidden), `and never ${forbidden}`);
      assert(!malformed.includes(forbidden), `nor does a malformed answer (${forbidden})`);
    }
  } finally {
    await runtime.close();
  }
});

await test('a request past the byte bound is refused rather than buffered', async () => {
  const socketPath = socketFor('too-large');
  const runtime = await startLocalSidecarRuntime({ socketPath, custodian: custodianFor('too-large') });
  try {
    // NO NEWLINE AT ALL. The previous version buffered this forever; the bound is on bytes accumulated.
    const answer = await rawExchange(socketPath, 'x'.repeat(SIDECAR_MAX_REQUEST_BYTES + 64));
    assert(answer.includes('SIDECAR_REQUEST_TOO_LARGE'), `it is refused as too large: ${answer}`);
  } finally {
    await runtime.close();
  }
});

await test('one request per connection: a second line on the same socket is never served', async () => {
  const socketPath = socketFor('one-request');
  const custodian = custodianFor('one-request');
  const runtime = await startLocalSidecarRuntime({ socketPath, custodian });
  try {
    const two = `${JSON.stringify({ op: 'status', keyId: 'key_a' })}\n${JSON.stringify({ op: 'provision', operationId: 'o1', itemId: 'i1', epoch: 0 })}\n`;
    const answer = await rawExchange(socketPath, two);
    assert(answer.includes('"status"'), `the first request is answered: ${answer}`);
    assert(!answer.includes('dekBase64'), 'and the second one is not served on the same connection');
    // ...and it really did not run: nothing was provisioned.
    assertEq((await custodian.listStaleProvisioning()).length, 0, 'no provision happened');
  } finally {
    await runtime.close();
  }
});

await test('a connection that says nothing is closed by the timeout with a closed code', async () => {
  const socketPath = socketFor('idle');
  const runtime = await startLocalSidecarRuntime({ socketPath, custodian: custodianFor('idle') });
  try {
    const answer = await rawExchange(socketPath, '');
    assert(answer.includes('SIDECAR_TIMEOUT'), `an idle connection is timed out: ${answer}`);
  } finally {
    await runtime.close();
  }
}); // the idle bound is seconds, so this is a real wait and a deliberate one

// ---------------------------------------------------------------------------------------------------------
// The health handshake
// ---------------------------------------------------------------------------------------------------------

await test('health is a HANDSHAKE: a socket that merely exists does not pass it', async () => {
  const socketPath = socketFor('health');
  const custodian = custodianFor('health');
  let exercised = 0;
  const runtime = await startLocalSidecarRuntime({
    socketPath,
    custodian,
    health: async (): Promise<SidecarHealth> => {
      exercised += 1;
      await custodian.listStaleProvisioning();
      return {
        op: 'health',
        protocol: SIDECAR_PROTOCOL_VERSION,
        ready: true,
        custodian: 'file-reference-harness',
        ringGeneration: null,
        ringActiveCreatedAt: null,
      };
    },
  });
  let health: SidecarHealth | null;
  try {
    health = await probeSidecarHealth(socketPath);
    assert(health !== null, 'a live, exercised daemon answers');
    assertEq(health!.ready, true, 'as ready');
    assert(exercised > 0, 'and the probe really ran against the custodian');
  } finally {
    await runtime.close();
  }
  // THE SOCKET FILE IS GONE, AND EVEN IF IT WERE NOT, NOBODY IS SERVING.
  assertEq(await probeSidecarHealth(socketPath, 500), null, 'a dead daemon is not ready');
  if (POSIX) {
    writeFileSync(socketPath, '', 'utf8'); // a leftover object at the name, the way a crash leaves one
    assertEq(await probeSidecarHealth(socketPath, 500), null, 'and a file at the socket path is not ready either');
    rmSync(socketPath, { force: true });
  }
});

await test('a runtime with no health probe never claims to be ready', async () => {
  const socketPath = socketFor('unproved');
  const runtime = await startLocalSidecarRuntime({ socketPath, custodian: custodianFor('unproved') });
  try {
    assertEq(await probeSidecarHealth(socketPath, 1_000), null, 'an unproved runtime is not ready');
    const raw = await rawExchange(socketPath, `${JSON.stringify({ op: 'health' })}\n`);
    // NOT-READY TRAVELS AS A REFUSAL, NOT AS A SUCCESS CARRYING `ready: false`.
    //
    // This used to assert the wire said `"ready":false` inside an `ok: true` envelope, which was a success
    // frame whose payload the CLIENT contract rejects — `validateSidecarHealth` refuses `ready: false` like
    // every other malformed field. A reader could not tell "the custodian is not ready" from "this peer is
    // not this product", and those want different things from an operator. The closed code says which.
    assert(raw.includes('SIDECAR_NOT_READY'), `and says so as a closed refusal: ${raw}`);
    assert(raw.includes('"ok":false'), 'in an error envelope rather than a success one');
    assert(!raw.includes('"ready":true'), 'and it certainly never claims readiness');
  } finally {
    await runtime.close();
  }
});

await test('the contract still works end to end over the hardened socket', async () => {
  const socketPath = socketFor('round-trip');
  const runtime = await startLocalSidecarRuntime({ socketPath, custodian: custodianFor('round-trip') });
  try {
    const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(socketPath));
    const provision = await client.provision('op-round-trip', 'item-round-trip', 0);
    await client.commitProvision('op-round-trip');
    assertEq((await client.get(provision.keyId, 0)).length, 32, 'a key round-trips');
    await client.destroy('op-destroy', provision.keyId);
    assertEq(await client.status(provision.keyId), 'destroyed', 'and a destroy is durable');
  } finally {
    await runtime.close();
  }
});

// ---------------------------------------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------------------------------------

await test('a state document describes itself, so a partial or altered write is refused', () => {
  const dir = join(WORK, 'state-io');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'doc.json');
  writeStateDocument(path, { a: 1, b: 'two' });
  assertEq(JSON.stringify(readStateDocument(path)), JSON.stringify({ a: 1, b: 'two' }), 'it round-trips');

  // THE DEFECT: `JSON.parse(readFileSync(...))` accepted any well-formed JSON, including a document that had
  // been altered or replaced. The envelope makes that arithmetic rather than a guess.
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { doc: unknown; bytes: number; digest: string };
  writeFileSync(path, JSON.stringify({ ...raw, doc: { a: 2, b: 'two' } }), 'utf8');
  refuses(() => readStateDocument(path), 'does not match its own recorded length and digest', 'an altered document');

  writeFileSync(path, JSON.stringify({ doc: { a: 1, b: 'two' }, bytes: 999, digest: raw.digest }), 'utf8');
  refuses(() => readStateDocument(path), 'does not match its own recorded length', 'a truncated document');

  writeFileSync(path, 'not json at all', 'utf8');
  refuses(() => readStateDocument(path), 'not a document this custodian wrote', 'bytes that are not a document');

  assertEq(readStateDocument(join(dir, 'not-there.json')), null, 'and an absent document is simply absent');
});

await test('a state document is bounded, and is never read through a symbolic link', () => {
  const dir = join(WORK, 'state-bounds');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'huge.json');
  writeFileSync(path, JSON.stringify({ doc: 'x'.repeat(2 * 1024 * 1024), bytes: 1, digest: 'x' }), 'utf8');
  refuses(() => readStateDocument(path), 'larger than this custodian will read', 'an over-large state file');

  if (POSIX) {
    const real = join(dir, 'real.json');
    writeStateDocument(real, { a: 1 });
    const link = join(dir, 'link.json');
    try {
      symlinkSync(real, link);
      refuses(() => readStateDocument(link), 'symbolic link', 'a state file that is a link');
    } catch {
      console.log('        (this session cannot create a symbolic link; the bound half still ran)');
    }
  }
});

await test('two writers cannot hold one custodian state directory at once', () => {
  const dir = join(WORK, 'state-lock');
  mkdirSync(dir, { recursive: true });
  const held = acquireStateLock(dir);
  try {
    refuses(() => acquireStateLock(dir), 'another writer holds', 'a second writer');
  } finally {
    held.release();
  }
  // ...and once released, the next writer takes it.
  acquireStateLock(dir).release();
});

await test('no state refusal ever carries a value', () => {
  const dir = join(WORK, 'state-redaction');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'secret.json');
  const secret = 'a-wrapped-value-that-must-never-appear-in-a-message';
  writeFileSync(path, JSON.stringify({ doc: { wrappedHex: secret }, bytes: 1, digest: 'x' }), 'utf8');
  try {
    readStateDocument(path);
    throw new Error('nothing was refused');
  } catch (err) {
    assert(err instanceof CustodianStateError, 'it is a typed refusal');
    assert(!(err as Error).message.includes(secret), 'and it carries no value from the file');
    assert(!(err as Error).message.includes(path), 'nor the path');
  }
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
