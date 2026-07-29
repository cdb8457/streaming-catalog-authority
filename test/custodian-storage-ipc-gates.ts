import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import {
  CUSTODIAN_RECORD_VERSION,
  MAX_CUSTODIAN_ID_LENGTH,
  MAX_CUSTODIAN_RECORD_BYTES,
  isCanonicalIsoTimestamp,
} from '../src/core/crypto/custodian-records.js';
import {
  CUSTODIAN_WRITER_LOCK, acquireStateLock, readStateFileBytes,
} from '../src/core/crypto/custodian-state-io.js';
import {
  SIDECAR_ERROR_CODES,
  SIDECAR_OPERATIONS,
  SIDECAR_PROTOCOL_VERSION,
  parseSidecarRequest,
  parseSidecarResponse,
  parseSidecarWireResponse,
} from '../src/core/crypto/sidecar-ipc.js';
import {
  LocalSidecarCustodianClient,
  dispatchLocalSidecarCustodianRequest,
} from '../src/core/crypto/local-sidecar-custodian.js';
import {
  UnixSocketSidecarTransport,
  probeSidecarHealth,
  startLocalSidecarRuntime,
} from '../src/core/crypto/local-sidecar-runtime.js';
import { CustodianTransportError } from '../src/core/crypto/custodian.js';

// Phases 285-288 — the custodian's storage boundary and its IPC contract, held to the defects they close.
//
// EVERY ADVERSARIAL TEST HERE FAILED AGAINST THE COMMIT BEING HARDENED. That is the bar: a case that passes
// both before and after proves the code compiles, not that a hole is closed. What each one reproduces is
// written above it, in the state the code was actually in.
//
//   1. THE KEYSTORE WAS READ WITH `existsSync` + `readFileSync` + `JSON.parse` + a CAST. A link was followed,
//      a file of any size was allocated, `{}` became a key file, and a keystore this process could not read
//      answered `not_found` — which a fail-closed reader cannot tell from a correct erasure.
//   2. AN UNREADABLE DESTROY JOURNAL WAS DELETED. `read()` answered `null` for "not there" and for "will not
//      parse", and the recovery loop removed whatever answered `null`. The intent to destroy a key was
//      thrown away, and the key stayed live with nothing recording that it should not have.
//   3. THE REWRAP WALKED WHATEVER `keys` POINTED AT, skipped anything not ending in `.json`, and trusted
//      every file it did read.
//   4. AN IPC REQUEST'S `op` WAS COERCED WITH `String(...)`, so `["get"]` selected the `get` schema and
//      produced a request no dispatcher matched — answered as a SUCCESS carrying nothing, which threw a raw
//      TypeError inside the app.
//   5. AN IPC ANSWER WAS NEVER PARSED. `JSON.parse(...) as WireResponse` and `ok !== true` were the whole
//      check: a frame could be a success and an error at once, could answer a question it was not asked,
//      could carry any extra field, and could be followed by a second message on a one-answer connection.

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
async function refusesAsync(fn: () => Promise<unknown>, needle: string, msg: string): Promise<void> {
  try { await fn(); } catch (err) {
    assert((err as Error).message.includes(needle), `${msg}: expected "${needle}", got: ${(err as Error).message}`);
    return;
  }
  throw new Error(`${msg}: nothing was refused`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), 'ca-custody-gates-'));
const POSIX = process.platform !== 'win32';
const SECRET = 'a-completion-secret-that-must-never-reach-a-report';
const KEK = randomBytes(32);

/** A keystore with one committed key, and the paths a suite needs to reach into it. */
async function keystoreWithOneKey(name: string): Promise<{
  root: string; keyId: string; itemId: string; keyFile: string; tombFile: string; opFile: string;
  journalFile: string; custodian: FileCustodian;
}> {
  const root = join(WORK, name);
  const custodian = new FileCustodian(root, SECRET, KEK, () => 1_800_000_000_000);
  const itemId = randomUUID();
  const { keyId } = await custodian.provision('op-1', itemId, 0);
  await custodian.commitProvision('op-1');
  const hashed = (id: string): string => `${createHash('sha256').update(id).digest('hex')}.json`;
  return {
    root,
    keyId,
    itemId,
    custodian,
    keyFile: join(root, 'keys', hashed(keyId)),
    tombFile: join(root, 'tombstones', hashed(keyId)),
    opFile: join(root, 'ops', hashed('op-1')),
    journalFile: join(root, 'journal', hashed(keyId)),
  };
}

console.log('Running the Phases 285-288 custodian storage and IPC gates:\n');

// ---------------------------------------------------------------------------------------------------------
// 1. A record is read the way the ring is read: bounded, no-follow, regular file, closed schema
// ---------------------------------------------------------------------------------------------------------

await test('a key file that is a link, a directory or oversize is refused rather than read', async () => {
  const world = await keystoreWithOneKey('record-boundary');
  const good = readFileSync(world.keyFile);

  // A DIRECTORY AT A KEY FILE'S NAME. `readFileSync` was handed it as though it were a key file.
  rmSync(world.keyFile, { force: true });
  mkdirSync(world.keyFile, { recursive: true });
  await refusesAsync(() => world.custodian.get(world.keyId, 0), 'not a regular file', 'a directory at a key name');
  rmSync(world.keyFile, { recursive: true, force: true });

  // A FILE LARGER THAN THIS BUILD WILL READ, refused before a byte of it is allocated.
  writeFileSync(world.keyFile, 'x'.repeat(MAX_CUSTODIAN_RECORD_BYTES + 1));
  await refusesAsync(() => world.custodian.get(world.keyId, 0), 'larger than this custodian will read',
    'an oversize key file');
  writeFileSync(world.keyFile, good);
  assertEq((await world.custodian.get(world.keyId, 0)).length, 32, 'and the real key still opens');

  // A SYMBOLIC LINK IS NOT FOLLOWED. This is the one that mattered most: a key file replaced by a link to a
  // file somewhere else was read as a key file, and a wrapped DEK would have been written back THROUGH it.
  if (POSIX) {
    const elsewhere = join(WORK, 'record-boundary-elsewhere.json');
    writeFileSync(elsewhere, good);
    rmSync(world.keyFile, { force: true });
    symlinkSync(elsewhere, world.keyFile);
    await refusesAsync(() => world.custodian.get(world.keyId, 0), 'symbolic link', 'a symlinked key file');
    rmSync(world.keyFile, { force: true });
    writeFileSync(world.keyFile, good);
  }
});

await test('an unreadable key file is a REFUSAL, and never the answer "not_found"', async () => {
  // THE DEFECT, AND THE WHOLE REASON THIS MODULE EXISTS. `existsSync` answers `false` for a permission
  // refusal and `read()` answered `null` for anything that would not parse — both of which became
  // `not_found`. A fail-closed reader treats `not_found` as a key that was correctly erased, so an
  // installation whose keystore had become unreadable reported itself as one that had never held a key.
  const world = await keystoreWithOneKey('not-found-vs-refused');

  // GENUINELY ABSENT IS STILL `not_found`. The distinction only means something if both halves hold.
  assertEq(await world.custodian.status(`key_${randomUUID()}`), 'not_found', 'a key that was never provisioned');

  for (const [what, bytes] of [
    ['an empty document', '{}'],
    ['a document with a field this build does not write', JSON.stringify({
      version: CUSTODIAN_RECORD_VERSION, keyId: world.keyId, itemId: world.itemId, epoch: 0,
      operationId: 'op-1', state: 'active', wrappedHex: 'a'.repeat(120), createdAt: 1, surprise: true,
    })],
    ['a version this build does not read', JSON.stringify({
      version: 2, keyId: world.keyId, itemId: world.itemId, epoch: 0, operationId: 'op-1',
      state: 'active', wrappedHex: 'a'.repeat(120), createdAt: 1,
    })],
    ['a state this build does not define', JSON.stringify({
      keyId: world.keyId, itemId: world.itemId, epoch: 0, operationId: 'op-1',
      state: 'pending', wrappedHex: 'a'.repeat(120), createdAt: 1,
    })],
    ['a wrapped value that is not one', JSON.stringify({
      keyId: world.keyId, itemId: world.itemId, epoch: 0, operationId: 'op-1',
      state: 'active', wrappedHex: 'not-hex', createdAt: 1,
    })],
    ['an id carrying a newline, which is an attestation separator', JSON.stringify({
      keyId: `${world.keyId}\nforged`, itemId: world.itemId, epoch: 0, operationId: 'op-1',
      state: 'active', wrappedHex: 'a'.repeat(120), createdAt: 1,
    })],
    ['an epoch that is not a whole count', JSON.stringify({
      keyId: world.keyId, itemId: world.itemId, epoch: 1.5, operationId: 'op-1',
      state: 'active', wrappedHex: 'a'.repeat(120), createdAt: 1,
    })],
    ['bytes that are not a document at all', 'this is not json'],
  ] as const) {
    writeFileSync(world.keyFile, bytes);
    await refusesAsync(() => world.custodian.status(world.keyId), 'key record', `status refuses ${what}`);
    await refusesAsync(() => world.custodian.get(world.keyId, 0), 'key record', `get refuses ${what}`);
  }

  // A TRUNCATED RECORD IS A REFUSAL, NOT A SHORTER RECORD. A prefix of a JSON object never closes its own
  // brace, which is the property the absence of a length-and-digest envelope rests on.
  const whole = JSON.stringify({
    version: CUSTODIAN_RECORD_VERSION, keyId: world.keyId, itemId: world.itemId, epoch: 0,
    operationId: 'op-1', state: 'active', wrappedHex: 'a'.repeat(120), createdAt: 1,
  });
  writeFileSync(world.keyFile, whole);
  truncateSync(world.keyFile, whole.length - 12);
  await refusesAsync(() => world.custodian.status(world.keyId), 'is not a document this build wrote',
    'a truncated key file');

  if (POSIX && process.getuid!() !== 0) {
    // AND A REAL PERMISSION REFUSAL, which is what `existsSync` used to turn into `not_found`.
    writeFileSync(world.keyFile, whole);
    chmodSync(world.keyFile, 0o000);
    try {
      await refusesAsync(() => world.custodian.status(world.keyId), 'could not be read',
        'a key file this process may not open');
    } finally { chmodSync(world.keyFile, 0o600); }
  }
});

await test('a tombstone that cannot be read never reads as "this key is live"', async () => {
  // A tombstone is the record that says a key is GONE. Answering "no tombstone" for one this build cannot
  // read would resurrect a destroyed key — the one direction this boundary must never fail in.
  const world = await keystoreWithOneKey('tombstone-boundary');
  const receipt = await world.custodian.destroy('op-destroy', world.keyId);
  assertEq(await world.custodian.status(world.keyId), 'destroyed', 'destroyed to begin with');
  const good = readFileSync(world.tombFile);

  writeFileSync(world.tombFile, '{}');
  await refusesAsync(() => world.custodian.status(world.keyId), 'tombstone', 'an empty tombstone');
  await refusesAsync(() => world.custodian.get(world.keyId, 0), 'tombstone', 'and get refuses it too');
  writeFileSync(world.tombFile, JSON.stringify({ keyId: world.keyId, receiptId: receipt.receiptId }));
  await refusesAsync(() => world.custodian.status(world.keyId), 'tombstone', 'a tombstone missing a field');
  writeFileSync(world.tombFile, good);
  assertEq(await world.custodian.status(world.keyId), 'destroyed', 'and the real tombstone still reads');

  // A DESTROY WHOSE RECORDED TOMBSTONE HAS GONE IS A REFUSAL, not a receipt over absent fields. The old
  // code's `this.read<Tombstone>(...)!` produced an attestation over `undefined`.
  rmSync(world.tombFile, { force: true });
  await refusesAsync(() => world.custodian.destroy('op-destroy', world.keyId), 'tombstone is not in this keystore',
    'a replayed destroy whose tombstone is gone');
});

await test('an operation record whose kind and fields disagree is refused', async () => {
  // `OpFile` declared `itemId?` and `epoch?` for both kinds, so a destroy record carrying a provision's
  // fields — or a provision record missing them — was read as whichever the caller happened to ask about.
  const world = await keystoreWithOneKey('op-record-boundary');
  const good = readFileSync(world.opFile);

  writeFileSync(world.opFile, JSON.stringify({ operationId: 'op-1', kind: 'destroy', keyId: world.keyId, itemId: world.itemId, epoch: 0 }));
  await refusesAsync(() => world.custodian.provision('op-1', world.itemId, 0), 'operation record',
    'a destroy record wearing a provision\'s fields');
  writeFileSync(world.opFile, JSON.stringify({ operationId: 'op-1', kind: 'provision', keyId: world.keyId }));
  await refusesAsync(() => world.custodian.provision('op-1', world.itemId, 0), 'operation record',
    'a provision record with no item or epoch');
  writeFileSync(world.opFile, JSON.stringify({ operationId: 'op-1', kind: 'rotate', keyId: world.keyId }));
  await refusesAsync(() => world.custodian.provision('op-1', world.itemId, 0), 'operation kind this build does not perform',
    'an operation kind that does not exist');

  writeFileSync(world.opFile, good);
  const replayed = await world.custodian.provision('op-1', world.itemId, 0);
  assertEq(replayed.keyId, world.keyId, 'and the real record still replays the same key');
});

// ---------------------------------------------------------------------------------------------------------
// 2. The destroy journal: an intent this build cannot read is not an intent to throw away
// ---------------------------------------------------------------------------------------------------------

await test('an unreadable destroy journal is refused at startup instead of being silently deleted', async () => {
  // THE DEFECT, AND IT LOST DATA SILENTLY. `recover()` was `const j = this.read(...); if (!j) { rmSync(...);
  // continue; }` — and `read()` answered `null` both for a file that was not there and for one that would not
  // parse. So an unreadable destroy INTENT was deleted, and the key it named stayed live with nothing left
  // recording that it should not have. A shape that DID parse was worse: `{}` reached `finishDestroy`, which
  // hashed `undefined` into a filename and threw a TypeError out of the CONSTRUCTOR.
  const world = await keystoreWithOneKey('journal-boundary');
  const intact = readFileSync(world.keyFile);

  for (const [what, bytes] of [
    ['bytes that are not a document', 'not json at all'],
    ['a document with no fields', '{}'],
    ['a journal entry missing its receipt', JSON.stringify({ keyId: world.keyId, destroyedAt: 'x' })],
    ['a journal entry with a field this build does not write', JSON.stringify({
      keyId: world.keyId, receiptId: 'rcpt_x', destroyedAt: 'x', because: 'reasons',
    })],
  ] as const) {
    writeFileSync(world.journalFile, bytes);
    refuses(() => new FileCustodian(world.root, SECRET, KEK), 'destroy journal entry',
      `a restart over ${what}`);
    // THE INTENT IS STILL THERE. Refusing to start is a state a human can look at; deleting the record of a
    // destruction is not.
    assert(existsSync(world.journalFile), `and ${what} was not deleted`);
    assertEq(readFileSync(world.keyFile).equals(intact), true, 'and no key file was touched');
  }
  rmSync(world.journalFile, { force: true });
  assertEq((await new FileCustodian(world.root, SECRET, KEK).get(world.keyId, 0)).length, 32,
    'and with the journal gone the custodian starts and the key opens');
});

await test('a journaled destroy is completed on restart, and completing it twice is the same outcome', async () => {
  // THE POSITIVE HALF, which is what the refusals above must not have broken: the crash fence still works.
  const world = await keystoreWithOneKey('journal-recovery');
  const receiptId = `rcpt_${randomUUID()}`;
  const destroyedAt = new Date(1_800_000_000_000).toISOString();
  // Exactly the on-disk state a crash between the fence and the destruction leaves: the intent recorded, the
  // key file untouched, no tombstone. Written in the LEGACY shape, with no `version` — a journal from a build
  // before this phase must still be recoverable by this one.
  writeFileSync(world.journalFile, JSON.stringify({ keyId: world.keyId, receiptId, destroyedAt }));
  assert(existsSync(world.keyFile), 'the key file is still there before the restart');

  const restarted = new FileCustodian(world.root, SECRET, KEK, () => 1_800_000_000_000);
  assertEq(await restarted.status(world.keyId), 'destroyed', 'the restart completed the destruction');
  assert(!existsSync(world.keyFile), 'the key file was removed');
  assert(existsSync(world.tombFile), 'a tombstone was written');
  assert(!existsSync(world.journalFile), 'and the journal entry was cleared');

  // IDEMPOTENT, ACROSS A SECOND RESTART AND A REPLAYED DESTROY. The receipt is the JOURNALED one, not a new
  // one, which is what makes a lost acknowledgement safe to retry.
  const again = new FileCustodian(world.root, SECRET, KEK, () => 1_900_000_000_000);
  assertEq(await again.status(world.keyId), 'destroyed', 'still destroyed after another restart');
  const receipt = await again.destroy(randomUUID(), world.keyId);
  assertEq(receipt.receiptId, receiptId, 'and the recovered tombstone keeps the journaled receipt id');
  assertEq(receipt.destroyedAt, destroyedAt, 'with the journaled timestamp');
  const repeat = await again.destroy(randomUUID(), world.keyId);
  assertEq(repeat.attestation, receipt.attestation, 'a second destroy is the same receipt, attestation and all');
});

await test('a write this build would refuse to read is never one it performs, and leaves no partial state', async () => {
  // "Either the previous valid bytes or the complete new document" put to the one path a caller can reach:
  // an identifier longer than this custodian stores. Nothing is written, nothing is half-written, and no
  // temporary file is left behind for the next walk of the keystore to trip over.
  const world = await keystoreWithOneKey('no-partial-write');
  const before = readFileSync(world.keyFile);
  const beforeKeys = readdirSync(join(world.root, 'keys')).sort().join(',');
  const beforeOps = readdirSync(join(world.root, 'ops')).sort().join(',');

  await refusesAsync(() => world.custodian.provision('op-huge', 'x'.repeat(MAX_CUSTODIAN_ID_LENGTH + 1), 0),
    'key record', 'a provision whose item id is longer than this custodian stores');
  assertEq(readdirSync(join(world.root, 'keys')).sort().join(','), beforeKeys, 'no key file was added');
  assertEq(readdirSync(join(world.root, 'ops')).sort().join(','), beforeOps, 'and no operation record either');
  assertEq(readFileSync(world.keyFile).equals(before), true, 'the existing key file is byte for byte what it was');
  assertEq((await world.custodian.get(world.keyId, 0)).length, 32, 'and it still opens');

  // A KEY FILE IS WRITTEN 0600 BY THE BOUNDARY THAT WRITES IT, on a platform that has modes.
  if (POSIX) assertEq(statSync(world.keyFile).mode & 0o777, 0o600, 'and a key file is owner-only');
});

await test('a legacy keystore written before this phase is still read, and is rewritten in the new shape', async () => {
  // COMPATIBILITY, STATED AS BEHAVIOUR. Records written by earlier builds carry no `version`. They must keep
  // reading — a keystore nobody can open is the one failure this whole area exists to prevent — and a record
  // this build rewrites carries the version from then on.
  const root = join(WORK, 'legacy-shape');
  mkdirSync(join(root, 'keys'), { recursive: true });
  mkdirSync(join(root, 'ops'), { recursive: true });
  mkdirSync(join(root, 'tombstones'), { recursive: true });
  mkdirSync(join(root, 'journal'), { recursive: true });
  // Built by provisioning with THIS build and then stripping the field, so the wrapped value is real.
  const seed = new FileCustodian(root, SECRET, KEK, () => 1_800_000_000_000);
  const itemId = randomUUID();
  const { keyId, dek } = await seed.provision('legacy-op', itemId, 0);
  const hashed = (id: string): string => `${createHash('sha256').update(id).digest('hex')}.json`;
  const keyFile = join(root, 'keys', hashed(keyId));
  const opFile = join(root, 'ops', hashed('legacy-op'));
  for (const file of [keyFile, opFile]) {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete doc.version;
    writeFileSync(file, JSON.stringify(doc));
  }
  assert(!('version' in (JSON.parse(readFileSync(keyFile, 'utf8')) as object)), 'the legacy file carries no version');

  const legacy = new FileCustodian(root, SECRET, KEK, () => 1_800_000_000_000);
  assertEq(await legacy.status(keyId), 'provisional', 'a versionless key file still reads');
  const replayed = await legacy.provision('legacy-op', itemId, 0);
  assertEq(replayed.dek.equals(dek), true, 'a versionless operation record still replays the same DEK');
  await legacy.commitProvision('legacy-op');
  assertEq(await legacy.status(keyId), 'active', 'and it still commits');
  assertEq((JSON.parse(readFileSync(keyFile, 'utf8')) as { version?: number }).version, CUSTODIAN_RECORD_VERSION,
    'and the file this build rewrote carries the version it writes');
  assertEq((await legacy.get(keyId, 0)).equals(dek), true, 'with the same DEK inside it');
});

// ---------------------------------------------------------------------------------------------------------
// 3. The keystore walk: a stated set, one directory, under the writer lock
// ---------------------------------------------------------------------------------------------------------

await test('a keystore holding an entry this custodian did not write cannot be walked', async () => {
  // A `.tmp` left by an interrupted write is precisely the state in which the set is not settled — and both
  // walks used to skip it, then report a count as though it were the whole keystore.
  const world = await keystoreWithOneKey('unstated-set');
  const stray = join(world.root, 'keys', `${'0'.repeat(64)}.json.7f1c.tmp`);
  writeFileSync(stray, '{}');
  refuses(() => FileCustodian.planRewrapKeystore(world.root, { fromKek: KEK, toKek: randomBytes(32) }),
    'not a wrapped key file this custodian wrote', 'a preflight over an unsettled set');
  refuses(() => FileCustodian.rewrapKeystore(world.root, { fromKek: KEK, toKek: randomBytes(32) }),
    'not a wrapped key file this custodian wrote', 'a rewrap over an unsettled set');
  await refusesAsync(() => world.custodian.listStaleProvisioning(), 'not a wrapped key file this custodian wrote',
    'a stale sweep over an unsettled set');
  rmSync(stray, { force: true });

  // AND A DIRECTORY WEARING A KEY FILE'S NAME IS NOT A KEY FILE.
  const impostor = join(world.root, 'keys', `${'a'.repeat(64)}.json`);
  mkdirSync(impostor, { recursive: true });
  refuses(() => FileCustodian.planRewrapKeystore(world.root, { fromKek: KEK, toKek: randomBytes(32) }),
    'not a regular file', 'a directory in the keystore');
  rmSync(impostor, { recursive: true, force: true });

  const plan = FileCustodian.planRewrapKeystore(world.root, { fromKek: KEK, toKek: randomBytes(32) });
  assertEq(plan.total, 1, 'and with the keystore settled the preflight states the whole set');
});

await test('a keystore directory that is a link is never walked, and one that cannot be reached is not "empty"', async () => {
  const world = await keystoreWithOneKey('keys-dir-boundary');
  const next = randomBytes(32);

  if (POSIX) {
    // THE NO-FOLLOW BOUNDARY USED TO ESCAPE THROUGH THE PARENT. Every per-file check was a no-follow check;
    // `readdirSync('<root>/keys')` follows a `keys` that is a link, so a rewrap could rewrite somebody
    // else's directory with every individual file check passing.
    const elsewhere = join(WORK, 'keys-dir-elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const linked = join(WORK, 'keys-dir-linked');
    mkdirSync(linked, { recursive: true });
    symlinkSync(elsewhere, join(linked, 'keys'), 'dir');
    refuses(() => FileCustodian.planRewrapKeystore(linked, { fromKek: KEK, toKek: next }),
      'keystore could not be read', 'a preflight over a symlinked keystore');
    refuses(() => FileCustodian.rewrapKeystore(linked, { fromKek: KEK, toKek: next }),
      'keystore could not be read', 'a rewrap over a symlinked keystore');
  }

  // A DIRECTORY THAT IS NOT THERE IS AN EMPTY KEYSTORE — the one case that legitimately counts zero.
  const bare = join(WORK, 'keys-dir-absent');
  mkdirSync(bare, { recursive: true });
  assertEq(FileCustodian.planRewrapKeystore(bare, { fromKek: KEK, toKek: next }).total, 0,
    'an installation that has stored nothing is an empty set');
  assertEq(FileCustodian.rewrapKeystore(bare, { fromKek: KEK, toKek: next }).total, 0, 'and so is its rewrap');
  assert(!existsSync(join(bare, CUSTODIAN_WRITER_LOCK)), 'and no lock was created to say there is nothing');

  assertEq(FileCustodian.planRewrapKeystore(world.root, { fromKek: KEK, toKek: next }).total, 1,
    'while a real keystore still counts its keys');
});

await test('a rewrap holds the custodian writer lock, and is resumable and idempotent', async () => {
  const world = await keystoreWithOneKey('rewrap-transaction');
  const next = randomBytes(32);

  // THE LOCK IS TAKEN, NOT MERELY DOCUMENTED. Something else holding it refuses the rewrap outright.
  const held = acquireStateLock(world.root, CUSTODIAN_WRITER_LOCK);
  try {
    refuses(() => FileCustodian.rewrapKeystore(world.root, { fromKek: KEK, toKek: next }),
      'another writer holds this custodian state directory', 'a rewrap while another writer holds the lock');
  } finally { held.release(); }
  // AND A PREFLIGHT DOES NOT TAKE IT, because it is run against verified backup sets whose bytes are what a
  // manifest is a digest of.
  const heldAgain = acquireStateLock(world.root, CUSTODIAN_WRITER_LOCK);
  try {
    assertEq(FileCustodian.planRewrapKeystore(world.root, { fromKek: KEK, toKek: next }).needsRewrap, 1,
      'a preflight reads a locked keystore rather than refusing it');
  } finally { heldAgain.release(); }

  const first = FileCustodian.rewrapKeystore(world.root, { fromKek: KEK, toKek: next });
  assertEq(`${first.rewrapped}/${first.skipped}/${first.total}`, '1/0/1', 'the first run moves the key');
  const second = FileCustodian.rewrapKeystore(world.root, { fromKek: KEK, toKek: next });
  assertEq(`${second.rewrapped}/${second.skipped}/${second.total}`, '0/1/1', 'and a re-run is a no-op');
  // THE DEK IS THE SAME VALUE UNDER THE NEW KEK. A rewrap that changed it would be an erasure.
  const rewrapped = new FileCustodian(world.root, SECRET, next, () => 1_800_000_000_000);
  assertEq((await rewrapped.get(world.keyId, 0)).length, 32, 'and every key still opens under the new KEK');
  assertEq(readdirSync(join(world.root, 'keys')).length, 1, 'with no temporary file left behind');
});

// ---------------------------------------------------------------------------------------------------------
// 4. The IPC request contract
// ---------------------------------------------------------------------------------------------------------

await test('a request whose operation is not a string is refused before it is looked up', () => {
  // THE DEFECT: `REQUEST_SHAPES[String(doc.op)]`, and `String(['get'])` is `'get'`. The array selected the
  // `get` schema, every field check passed, and the result was a request whose `op` was an array — which no
  // dispatcher matched, so the daemon answered `{"ok":true}` with no response at all and the client threw a
  // raw TypeError from inside the app.
  for (const hostile of [
    '{"op":["get"],"keyId":"key_1","epoch":0}',
    '{"op":{"toString":"get"},"keyId":"key_1","epoch":0}',
    '{"op":1,"keyId":"key_1","epoch":0}',
    '{"op":null,"keyId":"key_1","epoch":0}',
  ]) {
    const parsed = parseSidecarRequest(hostile);
    assertEq(parsed.ok, false, `an operation that is not a string is refused: ${hostile}`);
    if (!parsed.ok) assertEq(parsed.code, 'SIDECAR_PROTOCOL_MALFORMED', 'with the protocol code');
  }
  // AND THE SHAPE IT WAS IMITATING STILL WORKS.
  const good = parseSidecarRequest('{"op":"get","keyId":"key_1","epoch":0}');
  assertEq(good.ok, true, 'a real get is still a request');
});

await test('the app-to-sidecar surface is exactly the key custody operations, and nothing administrative', () => {
  assertEq(SIDECAR_OPERATIONS.join(','),
    'commitProvision,destroy,get,health,listStaleProvisioning,provision,status',
    'the operation set is closed and is read/write key custody plus a health handshake');
  for (const forbidden of ['rotate', 'retire', 'backup', 'restore', 'exec', 'shell', 'config', 'wipe',
    'rewrapKeystore', 'listKeys', 'export']) {
    assertEq(parseSidecarRequest(JSON.stringify({ op: forbidden })).ok, false,
      `there is no ${forbidden} operation on this boundary`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// 5. The IPC response contract — the half that was never parsed
// ---------------------------------------------------------------------------------------------------------

await test('a frame cannot be a success and a refusal at once, and a code is a closed word', () => {
  // THE DEFECT: `if (parsed.ok !== true) fail` was the whole envelope check. Everything else on the frame was
  // ignored, so one message could read as a success to the client and as a refusal to anything reading the
  // code beside it.
  for (const [what, frame] of [
    ['a success carrying an error code', '{"ok":true,"code":"SIDECAR_BUSY","response":{"op":"status","status":"active"}}'],
    ['a success carrying no response', '{"ok":true}'],
    ['a success whose response is an array', '{"ok":true,"response":[]}'],
    ['a success whose response is not an object', '{"ok":true,"response":"active"}'],
    ['a refusal with no code', '{"ok":false,"op":"status"}'],
    ['a refusal with a code this build does not define', '{"ok":false,"op":"status","code":"SIDECAR_JUST_BECAUSE"}'],
    ['a refusal naming an operation this boundary does not carry', '{"ok":false,"op":"rotate","code":"SIDECAR_BUSY"}'],
    ['a refusal carrying a peer\'s own extra field', '{"ok":false,"op":"status","code":"SIDECAR_BUSY","detail":"/srv/keys"}'],
    ['an ok that is neither true nor false', '{"ok":"true","response":{"op":"status","status":"active"}}'],
    ['a frame that is not an object', '"ok"'],
    ['bytes that are not a document', 'not json'],
  ] as const) {
    const parsed = parseSidecarWireResponse(frame);
    assertEq(parsed.ok, false, `refused: ${what}`);
    if (!parsed.ok) {
      assert((SIDECAR_ERROR_CODES as readonly string[]).includes(parsed.code), 'with a code from the closed set');
    }
  }
  // A REAL REFUSAL STILL CARRIES ITS CODE THROUGH, because a closed word is safe to repeat and is the only
  // thing on this wire that is.
  const refusal = parseSidecarWireResponse('{"ok":false,"op":"get","code":"SIDECAR_BUSY"}');
  assertEq(refusal.ok, false, 'a well-formed refusal parses');
  if (!refusal.ok) assertEq(refusal.code, 'SIDECAR_BUSY', 'as the code the daemon sent');
  const success = parseSidecarWireResponse('{"ok":true,"response":{"op":"status","status":"active"}}');
  assertEq(success.ok, true, 'and a well-formed success parses');
});

await test('an answer must be about the question that was asked, in the shape that operation declares', () => {
  const dek = randomBytes(32).toString('base64');
  const attestation = 'a'.repeat(64);
  // ANSWERING A DIFFERENT QUESTION. Nothing bound the answer to the request beyond the fields a caller
  // happened to look at.
  assertEq(parseSidecarResponse('get', { op: 'status', status: 'active' }), null, 'a status answer to a get');
  assertEq(parseSidecarResponse('status', { op: 'get', dekBase64: dek }), null, 'a get answer to a status');
  assertEq(parseSidecarResponse('destroy', { op: 'commitProvision', ok: true }), null, 'a commit answer to a destroy');

  for (const [what, op, value] of [
    ['a key that is not one', 'provision', { op: 'provision', keyId: 'key one', dekBase64: dek }],
    ['a DEK that is not 32 bytes', 'get', { op: 'get', dekBase64: randomBytes(16).toString('base64') }],
    ['a DEK that is not base64', 'get', { op: 'get', dekBase64: '!'.repeat(44) }],
    ['a field nothing declares', 'get', { op: 'get', dekBase64: dek, extra: '/srv/catalog/keys' }],
    ['a commit that did not commit', 'commitProvision', { op: 'commitProvision', ok: false }],
    ['a status outside the closed set', 'status', { op: 'status', status: 'maybe' }],
    ['a receipt with no attestation', 'destroy', { op: 'destroy', receipt: { keyId: 'key_1', receiptId: 'rcpt_1', destroyedAt: 'now' } }],
    ['an attestation that is prose', 'destroy', { op: 'destroy', receipt: { keyId: 'key_1', receiptId: 'rcpt_1', destroyedAt: 'now', attestation: 'trust me' } }],
    ['a receipt carrying a newline', 'destroy', { op: 'destroy', receipt: { keyId: 'key_1', receiptId: 'rcpt_1', destroyedAt: 'a\nb', attestation } }],
    ['a stale list that is not a list', 'listStaleProvisioning', { op: 'listStaleProvisioning', stale: {} }],
    ['a stale entry with a negative age', 'listStaleProvisioning', { op: 'listStaleProvisioning', stale: [{ operationId: 'o', itemId: 'i', keyId: 'key_1', ageMs: -1 }] }],
    ['a stale entry with a field nothing declares', 'listStaleProvisioning', { op: 'listStaleProvisioning', stale: [{ operationId: 'o', itemId: 'i', keyId: 'key_1', ageMs: 1, path: '/srv' }] }],
    ['a health answer with a contradiction', 'health', { op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: true, custodian: 'file-reference-harness', ringGeneration: null, ringActiveCreatedAt: 5 }],
  ] as const) {
    assertEq(parseSidecarResponse(op, value), null, `refused: ${what}`);
  }

  // AND EVERY LEGITIMATE ANSWER STILL PARSES.
  assert(parseSidecarResponse('provision', { op: 'provision', keyId: 'key_1', dekBase64: dek }) !== null, 'a provision');
  assert(parseSidecarResponse('get', { op: 'get', dekBase64: dek }) !== null, 'a get');
  assert(parseSidecarResponse('commitProvision', { op: 'commitProvision', ok: true }) !== null, 'a commit');
  assert(parseSidecarResponse('status', { op: 'status', status: 'not_found' }) !== null, 'a status');
  assert(parseSidecarResponse('destroy', {
    op: 'destroy', receipt: { keyId: 'key_1', receiptId: 'rcpt_1', destroyedAt: '2026-07-29T00:00:00.000Z', attestation },
  }) !== null, 'a destroy');
  assert(parseSidecarResponse('listStaleProvisioning', {
    op: 'listStaleProvisioning', stale: [{ operationId: 'op-1', itemId: 'item one', keyId: 'key_1', ageMs: 12 }],
  }) !== null, 'a stale list, including an item id the request charset would not carry');
  assert(parseSidecarResponse('health', {
    op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: true, custodian: 'sidecar-managed-ring',
    ringGeneration: 2, ringActiveCreatedAt: 1_800_000_000_000,
  }) !== null, 'and a health handshake');
});

// ---------------------------------------------------------------------------------------------------------
// 6. A hostile peer on the socket
// ---------------------------------------------------------------------------------------------------------

/**
 * A socket this product would actually serve on.
 *
 * ON POSIX IT LIVES IN A PRIVATE DIRECTORY, NOT IN `/tmp` ITSELF. `prepareSocketDirectory` requires the
 * socket's PARENT to be owner-only, because a 0600 socket inside a world-writable directory is a socket
 * anybody can unlink and replace — after which the app connects to their custodian. `/tmp` is `1777` on every
 * Linux host, so a socket placed directly in it is refused by the very rule this product ships. A suite that
 * put one there would pass on Windows, which has no parent directory to own, and fail on the platform this
 * is deployed to.
 */
function socketPath(name: string): string {
  if (!POSIX) {
    return `\\\\.\\pipe\\ca-gate-${name}-${process.pid}-${randomUUID().slice(0, 8)}`;
  }
  const dir = join(WORK, 'run', `${name}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, 's.sock');
}

/** A peer that is not this product's sidecar: it answers with whatever it was told to answer. */
async function hostilePeer(path: string, reply: string | null): Promise<Server> {
  const server = createServer((socket) => {
    socket.on('data', () => { if (reply !== null) socket.write(reply); });
    socket.on('error', () => { /* the client is what is under test */ });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  return server;
}

async function closePeer(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  if (POSIX) rmSync(path, { force: true });
}

await test('a hostile peer cannot make the app act on an answer, and never lends it a word', async () => {
  const secretPath = '/srv/catalog/keystore/keys/deadbeef.json';
  const stack = 'Error: boom\n    at Object.<anonymous> (/srv/catalog/dist/custodian.js:42:7)';
  const hostile = [
    // The exact frame the `String(doc.op)` defect produced: a success with nothing in it.
    '{"ok":true}\n',
    // An answer to a question nobody asked.
    '{"ok":true,"response":{"op":"status","status":"active"}}\n',
    // A success and a refusal at once.
    `{"ok":true,"code":"SIDECAR_BUSY","response":{"op":"get","dekBase64":"${randomBytes(32).toString('base64')}"}}\n`,
    // A well-formed answer followed by a SECOND message on a one-answer connection.
    `{"ok":true,"response":{"op":"get","dekBase64":"${randomBytes(32).toString('base64')}"}}\n{"ok":true,"response":{"op":"get","dekBase64":"${randomBytes(32).toString('base64')}"}}\n`,
    // A refusal carrying a path and a stack trace, which is what a peer that is not this product answers with.
    `{"ok":false,"op":"get","code":"SIDECAR_REQUEST_FAILED","detail":${JSON.stringify(secretPath)},"stack":${JSON.stringify(stack)}}\n`,
    // A frame that is not a document at all.
    'not a document\n',
  ];
  for (const reply of hostile) {
    const path = socketPath('hostile');
    const peer = await hostilePeer(path, reply);
    try {
      const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(path, 1_500));
      let caught: unknown = null;
      try { await client.get('key_1', 0); } catch (err) { caught = err; }
      assert(caught instanceof CustodianTransportError, `a hostile answer fails closed: ${reply.slice(0, 40)}`);
      const message = (caught as Error).message;
      // NOTHING OF THE PEER'S IS REPEATED. Not a path, not a stack, not a wrapped value.
      assert(!message.includes(secretPath), 'and the refusal carries no path the peer supplied');
      assert(!message.includes('custodian.js'), 'nor any part of a stack trace');
      assert(!message.includes('dekBase64'), 'nor anything from the payload');
    } finally { await closePeer(peer, path); }
  }
});

await test('a peer that never terminates a line, or answers with more than the contract allows, is bounded', async () => {
  // NO NEWLINE, EVER: the client must time out rather than buffer forever.
  const silent = socketPath('silent');
  const silentPeer = await hostilePeer(silent, '{"ok":true,"response":{"op":"get"');
  try {
    const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(silent, 1_000));
    await refusesAsync(() => client.get('key_1', 0), 'get', 'a peer that never finishes its line');
  } finally { await closePeer(silentPeer, silent); }

  // AND AN ANSWER LARGER THAN THE CONTRACT CARRIES IS REFUSED RATHER THAN ALLOCATED.
  const huge = socketPath('huge');
  const hugePeer = await hostilePeer(huge, `{"ok":true,"response":{"op":"get","dekBase64":"${'A'.repeat(2 * 1024 * 1024)}"}}\n`);
  try {
    const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(huge, 2_000));
    await refusesAsync(() => client.get('key_1', 0), 'get', 'a peer that answers with more than the bound');
  } finally { await closePeer(hugePeer, huge); }

  // AND A HEALTH PROBE AGAINST A PEER THAT IS NOT THIS PRODUCT'S SIDECAR ANSWERS `null`, which is what the
  // app's startup gate fails closed on.
  const impostor = socketPath('impostor');
  const impostorPeer = await hostilePeer(impostor, '{"ok":true,"response":{"op":"health","protocol":1,"ready":true}}\n');
  try {
    assertEq(await probeSidecarHealth(impostor, 1_000), null, 'an incomplete health answer is not a health answer');
  } finally { await closePeer(impostorPeer, impostor); }
});

await test('the real daemon still answers every custody operation, and refuses to put a bad answer on the wire', async () => {
  // THE POSITIVE HALF: the strictness above must not have narrowed the contract the app actually uses.
  const root = join(WORK, 'daemon-round-trip');
  const custodian = new FileCustodian(root, SECRET, KEK, () => 1_800_000_000_000);
  const path = socketPath('round-trip');
  const runtime = await startLocalSidecarRuntime({
    socketPath: path,
    custodian,
    health: () => ({
      op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: true,
      custodian: 'file-reference-harness', ringGeneration: 1, ringActiveCreatedAt: 1_800_000_000_000,
    }),
  });
  try {
    const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(path));
    const itemId = randomUUID();
    const { keyId, dek } = await client.provision('op-wire', itemId, 0);
    assertEq(await client.status(keyId), 'provisional', 'status before the commit');
    assertEq((await client.listStaleProvisioning()).length, 1, 'the stale sweep answers over the wire');
    await client.commitProvision('op-wire');
    assertEq(await client.status(keyId), 'active', 'status after it');
    assertEq((await client.get(keyId, 0)).equals(dek), true, 'the DEK comes back exactly');
    const receipt = await client.destroy('op-wire-destroy', keyId);
    assertEq(receipt.keyId, keyId, 'the receipt names the key');
    assertEq(/^[0-9a-f]{64}$/.test(receipt.attestation), true, 'and carries a real attestation');
    assertEq(await client.status(keyId), 'destroyed', 'and the key is destroyed');
    const health = await probeSidecarHealth(path, 2_000);
    assert(health !== null && health.ready, 'and the health handshake is answered');

    // A CUSTODIAN THAT ANSWERS IN A SHAPE THIS BOUNDARY DOES NOT DECLARE IS REFUSED BEFORE THE WIRE. The
    // custodian behind this socket is an interface, not necessarily this repository's class.
    const forged = await dispatchLocalSidecarCustodianRequest({
      provision: async () => ({ keyId: 'key_forged', dek: randomBytes(32) }),
      commitProvision: async () => {},
      get: async () => randomBytes(32),
      destroy: async () => ({ keyId: 'key_1', receiptId: 'rcpt_1', destroyedAt: 'now', attestation: 'trust me' }),
      status: async () => 'active' as const,
      listStaleProvisioning: async () => [],
    }, { op: 'destroy', operationId: 'op-x', keyId: 'key_1' });
    assertEq(parseSidecarResponse('destroy', forged), null,
      'a receipt whose attestation is prose is not a response this boundary will carry');
  } finally {
    await runtime.close();
  }
});

// ---------------------------------------------------------------------------------------------------------
// 7. The invariant
// ---------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------
// 8. A record is bound to the NAME it was read under
// ---------------------------------------------------------------------------------------------------------

await test('a well-formed record moved to another valid record\'s name is refused, and acts on neither key', async () => {
  // THE DEFECT: every schema checked that a record was well FORMED and none checked that it was the record
  // ASKED FOR — the id built the path and was then thrown away. A file COPIED from one valid name to another
  // passed everything, and each caller believed the id INSIDE it, which is somebody else's key. No forgery is
  // needed for this: only the ability to copy a file, which anyone who can write the directory has.
  const world = await keystoreWithOneKey('readdressed');
  const second = await world.custodian.provision('op-2', randomUUID(), 0);
  await world.custodian.commitProvision('op-2');
  const name = (id: string): string => `${createHash('sha256').update(id).digest('hex')}.json`;
  const keyFileOf = (id: string): string => join(world.root, 'keys', name(id));
  const victimBytes = readFileSync(keyFileOf(second.keyId));

  // ---- A KEY FILE WEARING ANOTHER KEY'S ADDRESS --------------------------------------------------------
  writeFileSync(keyFileOf(second.keyId), readFileSync(world.keyFile));
  await refusesAsync(() => world.custodian.get(second.keyId, 0), 'filed under',
    'a get against a transplanted key file');
  await refusesAsync(() => world.custodian.status(second.keyId), 'filed under', 'and a status');
  // AND THE WALKS REFUSE IT TOO, where the name comes from a listing rather than from an id.
  await refusesAsync(() => world.custodian.listStaleProvisioning(), 'filed under', 'and the stale sweep');
  refuses(() => FileCustodian.planRewrapKeystore(world.root, { fromKek: KEK, toKek: randomBytes(32) }),
    'filed under', 'and the rewrap preflight');
  refuses(() => FileCustodian.rewrapKeystore(world.root, { fromKek: KEK, toKek: randomBytes(32) }),
    'filed under', 'and the rewrap itself');
  writeFileSync(keyFileOf(second.keyId), victimBytes);
  assertEq((await world.custodian.get(second.keyId, 0)).length, 32, 'and the real key file still opens');

  // ---- AN OPERATION RECORD WEARING ANOTHER OPERATION'S ADDRESS -----------------------------------------
  //
  // The consequence here is a provision REPLAY: a fresh operation id would have found somebody else's
  // operation record and handed back that operation's key and DEK.
  const opFileOf = (id: string): string => join(world.root, 'ops', name(id));
  writeFileSync(opFileOf('op-3'), readFileSync(opFileOf('op-1')));
  await refusesAsync(() => world.custodian.provision('op-3', world.itemId, 0), 'filed under',
    'a provision against a transplanted operation record');
  await refusesAsync(() => world.custodian.commitProvision('op-3'), 'filed under', 'and a commit');
  rmSync(opFileOf('op-3'), { force: true });

  // ---- A TOMBSTONE WEARING ANOTHER KEY'S ADDRESS -------------------------------------------------------
  //
  // The consequence here is a LIVE key reported destroyed, and a receipt issued for it.
  const destroyed = await world.custodian.provision('op-4', randomUUID(), 0);
  await world.custodian.commitProvision('op-4');
  const receipt = await world.custodian.destroy('op-4-destroy', destroyed.keyId);
  const tombOf = (id: string): string => join(world.root, 'tombstones', name(id));
  writeFileSync(tombOf(second.keyId), readFileSync(tombOf(destroyed.keyId)));
  await refusesAsync(() => world.custodian.status(second.keyId), 'filed under',
    'a status against a transplanted tombstone');
  await refusesAsync(() => world.custodian.destroy('op-5', second.keyId), 'filed under',
    'and a destroy, which would have returned somebody else\'s receipt');
  rmSync(tombOf(second.keyId), { force: true });
  assertEq(await world.custodian.status(second.keyId), 'active', 'and the live key is live again');
  assertEq((await world.custodian.destroy('op-4-destroy', destroyed.keyId)).attestation, receipt.attestation,
    'while the real destruction still replays its own receipt');
});

await test('a destroy journal entry moved to another key\'s name destroys NEITHER key', async () => {
  // THE SHARPEST OF THE READDRESSING CASES. Recovery ACTS on the id inside the record, so an entry copied
  // onto another key's journal name would have destroyed the key named INSIDE it — a key nothing asked to
  // destroy — on the strength of a filename somebody else chose.
  const world = await keystoreWithOneKey('readdressed-journal');
  const bystander = await world.custodian.provision('op-bystander', randomUUID(), 0);
  await world.custodian.commitProvision('op-bystander');
  const name = (id: string): string => `${createHash('sha256').update(id).digest('hex')}.json`;

  // An entry that NAMES the first key, filed under the bystander's name.
  writeFileSync(join(world.root, 'journal', name(bystander.keyId)), JSON.stringify({
    keyId: world.keyId, receiptId: `rcpt_${randomUUID()}`, destroyedAt: new Date(1_800_000_000_000).toISOString(),
  }));
  refuses(() => new FileCustodian(world.root, SECRET, KEK), 'filed under', 'a restart over a moved journal entry');

  // NEITHER KEY WAS DESTROYED, and the entry is still there for a human to look at.
  rmSync(join(world.root, 'journal', name(bystander.keyId)), { force: true });
  const restarted = new FileCustodian(world.root, SECRET, KEK, () => 1_800_000_000_000);
  assertEq(await restarted.status(world.keyId), 'active', 'the key named inside the entry is untouched');
  assertEq(await restarted.status(bystander.keyId), 'active', 'and so is the key it was filed under');
  assertEq((await restarted.get(world.keyId, 0)).length, 32, 'and it still opens');
});

// ---------------------------------------------------------------------------------------------------------
// 9. The directories themselves
// ---------------------------------------------------------------------------------------------------------

await test('a custodian will not build on a link, a non-directory, or a directory somebody else can write', async () => {
  // THE DEFECT: `mkdirSync(d, { recursive: true })` establishes NOTHING about a name that already exists — on
  // EEXIST it returns happily. `<root>/keys` as a symbolic link to somebody else's directory was a keystore
  // this class read and wrote every key through, with the no-follow rules on the FILES intact and useless.
  // The static rewrap had been given this check; the class that actually holds the keys had not.
  const base = join(WORK, 'directory-boundary');
  mkdirSync(base, { recursive: true });

  // A NON-DIRECTORY AT ONE OF THE FIVE NAMES, on every platform.
  const fileAtKeys = join(base, 'file-at-keys');
  mkdirSync(fileAtKeys, { recursive: true });
  writeFileSync(join(fileAtKeys, 'keys'), 'not a directory');
  refuses(() => new FileCustodian(fileAtKeys, SECRET, KEK), 'not a directory', 'a file where the keystore goes');

  if (POSIX) {
    // A LINK AT ONE OF THEM.
    const elsewhere = join(base, 'somebody-elses-keystore');
    mkdirSync(elsewhere, { recursive: true });
    const linked = join(base, 'linked');
    mkdirSync(linked, { recursive: true });
    symlinkSync(elsewhere, join(linked, 'keys'), 'dir');
    refuses(() => new FileCustodian(linked, SECRET, KEK), 'symbolic link', 'a symlinked keystore');
    assertEq(readdirSync(elsewhere).length, 0, 'and nothing was written through it');

    if (process.getuid!() !== 0) {
      // A DIRECTORY ANY ACCOUNT ON THE HOST CAN WRITE. An account that can add a file to `keys/` controls
      // which wrapped keys this custodian believes it has.
      const open = join(base, 'world-writable');
      mkdirSync(join(open, 'keys'), { recursive: true });
      chmodSync(join(open, 'keys'), 0o777);
      try {
        refuses(() => new FileCustodian(open, SECRET, KEK), 'writable by somebody other than its owner',
          'a world-writable keystore');
      } finally { chmodSync(join(open, 'keys'), 0o700); }
      // AND THE LEGACY MODE EVERY EXISTING INSTALLATION HAS IS STILL ACCEPTED, deliberately: `0755` is what
      // `mkdir` under the default umask produces, the material in it is wrapped under a key that is not in
      // it, and refusing it would turn an upgrade into an outage. `ops:keystore-repair` is what narrows it.
      const legacy = join(base, 'legacy-mode');
      for (const dir of ['keys', 'ops', 'tombstones', 'journal']) {
        mkdirSync(join(legacy, dir), { recursive: true });
        chmodSync(join(legacy, dir), 0o755);
      }
      const custodian = new FileCustodian(legacy, SECRET, KEK, () => 1_800_000_000_000);
      const provisioned = await custodian.provision('legacy-mode-op', randomUUID(), 0);
      assertEq(provisioned.dek.length, 32, 'a 0755 keystore from an older build still works');
    }
  }
});

await test('a directory swapped after the custodian was built is refused, not walked', async () => {
  const world = await keystoreWithOneKey('directory-swap');
  const keysDir = join(world.root, 'keys');
  const moved = join(world.root, 'keys-moved-aside');
  renameSync(keysDir, moved);
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  try {
    await refusesAsync(() => world.custodian.listStaleProvisioning(), 'was replaced after this custodian was built',
      'a sweep over a directory that is no longer the one that was proved');
  } finally {
    rmSync(keysDir, { recursive: true, force: true });
    renameSync(moved, keysDir);
  }
  assertEq((await world.custodian.listStaleProvisioning()).length, 0, 'and the real directory sweeps again');
});

await test('the destroy journal is a closed set of names, and an entry nobody can account for stops recovery', async () => {
  // It used to be `readdirSync(...).filter(f => f.endsWith('.json'))`, which silently ignored everything else
  // — a `.tmp` from an interrupted write, a directory, a device. "Recover from the ones I recognised" is not
  // a recovery: the directory that decides what gets destroyed has to be one this build can state in full.
  const world = await keystoreWithOneKey('journal-set');
  const stray = join(world.root, 'journal', 'notes.txt');
  writeFileSync(stray, 'an operator left this here');
  refuses(() => new FileCustodian(world.root, SECRET, KEK), 'destroy journal entry this custodian',
    'a restart over a journal holding something unaccountable');
  assertEq(readFileSync(stray, 'utf8'), 'an operator left this here', 'and it was not removed');
  rmSync(stray, { force: true });

  const wrongType = join(world.root, 'journal', `${'b'.repeat(64)}.json`);
  mkdirSync(wrongType, { recursive: true });
  refuses(() => new FileCustodian(world.root, SECRET, KEK), 'not a regular file',
    'a directory wearing a journal entry\'s name');
  rmSync(wrongType, { recursive: true, force: true });
  assertEq(await new FileCustodian(world.root, SECRET, KEK).status(world.keyId), 'active',
    'and with the journal accountable again the custodian builds');
});

// ---------------------------------------------------------------------------------------------------------
// 10. One frame per answer, however the peer chunks it
// ---------------------------------------------------------------------------------------------------------

/** A peer that writes a sequence of chunks with a real gap between them, then ends. */
async function chunkedPeer(path: string, chunks: readonly string[], gapMs: number): Promise<Server> {
  const server = createServer((socket) => {
    socket.on('error', () => { /* the client is what is under test */ });
    socket.on('data', () => {
      let when = 0;
      for (const chunk of chunks) {
        when += gapMs;
        setTimeout(() => { try { socket.write(chunk); } catch { /* the client may have gone */ } }, when);
      }
      setTimeout(() => { try { socket.end(); } catch { /* as above */ } }, when + gapMs);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  return server;
}

await test('a second frame in a LATER chunk is refused, not accepted because the first one arrived alone', async () => {
  // THE DEFECT, AND IT SURVIVED THE FIRST ATTEMPT AT CLOSING IT. The client resolved as soon as it saw a
  // newline and refused a second frame only when that frame happened to arrive IN THE SAME CHUNK. A peer
  // that writes frame one, waits, then writes frame two had its first frame accepted and acted on — the
  // check was against an accident of buffering rather than against what the peer sent.
  const frame = (): string => `{"ok":true,"response":{"op":"get","dekBase64":"${randomBytes(32).toString('base64')}"}}\n`;
  const path = socketPath('fragmented');
  const peer = await chunkedPeer(path, [frame(), frame()], 40);
  try {
    const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(path, 3_000));
    let caught: unknown = null;
    try { await client.get('key_1', 0); } catch (err) { caught = err; }
    assert(caught instanceof CustodianTransportError, `two frames in two chunks fail closed: ${String(caught)}`);
    assert(!(caught as Error).message.includes('dekBase64'), 'and nothing of the payload is repeated');
  } finally { await closePeer(peer, path); }
});

await test('one frame SPLIT across chunks is still accepted, so the rule is about frames and not about chunks', async () => {
  const whole = '{"ok":true,"response":{"op":"status","status":"active"}}\n';
  const path = socketPath('split-frame');
  const peer = await chunkedPeer(path, [whole.slice(0, 20), whole.slice(20, 40), whole.slice(40)], 25);
  try {
    // THE DEFAULT TIMEOUT, DELIBERATELY. This is the one case here that expects a SUCCESS, so a short bound
    // would make a loaded machine look like a protocol failure — and a suite that flakes is a suite nobody
    // reads. Every other case expects a refusal, which a timeout also produces.
    const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(path));
    assertEq(await client.status('key_1'), 'active', 'a legitimately fragmented answer still arrives');
  } finally { await closePeer(peer, path); }
});

await test('an answer that never terminates its only frame is refused when the peer finishes', async () => {
  const path = socketPath('unterminated');
  const peer = await chunkedPeer(path, ['{"ok":true,"response":{"op":"status","status":"active"}}'], 20);
  try {
    const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(path, 3_000));
    await refusesAsync(() => client.status('key_1'), 'status', 'a frame with no terminator');
  } finally { await closePeer(peer, path); }
});

// ---------------------------------------------------------------------------------------------------------
// 11. The health envelope says what it means
// ---------------------------------------------------------------------------------------------------------

/** One raw request over the socket, and whatever line comes back. */
async function rawAsk(path: string, line: string): Promise<string> {
  const { createConnection } = await import('node:net');
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(path);
    let buffered = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('no answer')); }, 15_000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { buffered += chunk; });
    socket.once('error', (err) => { clearTimeout(timer); reject(err); });
    socket.once('connect', () => { socket.write(line); });
    socket.once('close', () => { clearTimeout(timer); resolve(buffered); });
  });
}

await test('a health answer the client contract would reject never travels as a success', async () => {
  // THE DEFECT: `ok: true` was written around ANY health object whose `ready` was false, and around a
  // malformed one as long as it did not claim readiness — but `validateSidecarHealth`, the schema the CLIENT
  // applies, rejects `ready: false` and every malformed field alike. Those were success envelopes carrying a
  // payload the other end refuses by contract, so a reader could not tell "not ready" from "not this
  // product", and those need different responses from an operator.
  const cases: Array<[string, unknown]> = [
    ['a probe that is not ready', {
      op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: false,
      custodian: 'file-reference-harness', ringGeneration: null, ringActiveCreatedAt: null,
    }],
    ['a probe with a contradictory ring', {
      op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: true,
      custodian: 'file-reference-harness', ringGeneration: null, ringActiveCreatedAt: 5,
    }],
    ['a probe with a field nothing declares', {
      op: 'health', protocol: SIDECAR_PROTOCOL_VERSION, ready: true, custodian: 'file-reference-harness',
      ringGeneration: 1, ringActiveCreatedAt: 1_800_000_000_000, uptime: 12,
    }],
    ['a probe from a protocol this build does not speak', {
      op: 'health', protocol: SIDECAR_PROTOCOL_VERSION + 1, ready: true,
      custodian: 'file-reference-harness', ringGeneration: null, ringActiveCreatedAt: null,
    }],
  ];
  for (const [what, answer] of cases) {
    const path = socketPath('health-envelope');
    const runtime = await startLocalSidecarRuntime({
      socketPath: path,
      custodian: new FileCustodian(join(WORK, `health-envelope-${randomUUID().slice(0, 8)}`), SECRET, KEK),
      health: () => answer as never,
    });
    try {
      const raw = await rawAsk(path, `${JSON.stringify({ op: 'health' })}\n`);
      assert(raw.includes('SIDECAR_NOT_READY'), `${what} becomes the closed refusal: ${raw}`);
      assert(raw.includes('"ok":false'), `${what} is not a success envelope: ${raw}`);
      assert(!raw.includes('"ok":true'), `${what} carries no success at all: ${raw}`);
      assertEq(await probeSidecarHealth(path, 5_000), null, `${what} is not readiness to the client either`);
    } finally { await runtime.close(); }
  }
});

// ---------------------------------------------------------------------------------------------------------
// 12. The exact forms this build writes
// ---------------------------------------------------------------------------------------------------------

await test('a destruction time is the one instant format this build writes, in records and on the wire', async () => {
  // EVERY FIELD OF A TOMBSTONE IS ATTESTATION INPUT: the receipt is an HMAC over the key id, the receipt id
  // and this timestamp. "Any text with no control character in it" let a tombstone say `destroyedAt: "soon"`
  // and produced a perfectly valid attestation over it.
  const world = await keystoreWithOneKey('iso-timestamps');
  await world.custodian.destroy('op-destroy', world.keyId);
  const good = readFileSync(world.tombFile, 'utf8');
  const stored = JSON.parse(good) as Record<string, unknown>;
  assertEq(isCanonicalIsoTimestamp(stored.destroyedAt), true, 'what this build wrote is the canonical form');

  for (const [what, value] of [
    ['prose', 'recently'],
    ['a date with no time', '2026-07-29'],
    ['an instant with no milliseconds', '2026-07-29T00:00:00Z'],
    ['a local time', '2026-07-29T00:00:00.000+02:00'],
    ['a day that does not exist', '2026-02-30T00:00:00.000Z'],
    ['a number of milliseconds', '1800000000000'],
  ] as const) {
    writeFileSync(world.tombFile, JSON.stringify({ ...stored, destroyedAt: value }));
    await refusesAsync(() => world.custodian.status(world.keyId), 'destruction time',
      `a tombstone recording ${what}`);
  }
  writeFileSync(world.tombFile, good);
  assertEq(await world.custodian.status(world.keyId), 'destroyed', 'and the real tombstone still reads');

  // THE SAME RULE ON THE WIRE, where a peer supplies the field.
  const attestation = 'a'.repeat(64);
  const receipt = (destroyedAt: string) => ({
    op: 'destroy', receipt: { keyId: 'key_1', receiptId: 'rcpt_1', destroyedAt, attestation },
  });
  assertEq(parseSidecarResponse('destroy', receipt('recently')), null, 'a receipt timed in prose');
  assertEq(parseSidecarResponse('destroy', receipt('2026-02-30T00:00:00.000Z')), null, 'or on a day that is not one');
  assert(parseSidecarResponse('destroy', receipt('2026-07-29T00:00:00.000Z')) !== null, 'while a real instant carries');
});

await test('a stale-provisioning age is a whole number of milliseconds inside exact arithmetic', () => {
  const entry = (ageMs: unknown) => ({
    op: 'listStaleProvisioning', stale: [{ operationId: 'op-1', itemId: 'item-1', keyId: 'key_1', ageMs }],
  });
  for (const [what, value] of [
    ['a float', 1.5],
    ['a negative', -1],
    ['a number past exact arithmetic', Number.MAX_SAFE_INTEGER + 2],
    ['an infinity', Number.POSITIVE_INFINITY],
    ['a NaN', Number.NaN],
    ['a numeral in a string', '12'],
  ] as const) {
    assertEq(parseSidecarResponse('listStaleProvisioning', entry(value)), null, `an age that is ${what}`);
  }
  assert(parseSidecarResponse('listStaleProvisioning', entry(0)) !== null, 'while zero is an age');
  assert(parseSidecarResponse('listStaleProvisioning', entry(86_400_000)) !== null, 'and so is a day of them');
});

// ---------------------------------------------------------------------------------------------------------
// 13. A read that is raced
// ---------------------------------------------------------------------------------------------------------

await test('a state file that grows or shrinks under the read is a refusal, not a prefix', () => {
  // THE DEFECT: the size was taken once, exactly that many bytes were read, and the check afterwards compared
  // the bytes read against THE SIZE FROM BEFORE — which is trivially satisfied and says nothing about what
  // the file became. A writer appending to the same inode during the read left the reader holding a PREFIX,
  // and a prefix that happens to close its own brace parses.
  const dir = join(WORK, 'raced-read');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'record.json');
  const body = JSON.stringify({ document: 'phase-288', value: 'x'.repeat(64) });
  writeFileSync(file, body);

  assertEq(readStateFileBytes(file).toString('utf8'), body, 'an unraced read returns the whole file');
  refuses(() => readStateFileBytes(file, undefined, {
    // A writer holding the same inode open, appending while this read is in flight. The seam makes the race
    // deterministic; the refusal is what is under test.
    afterRead: () => { appendFileSync(file, 'x'.repeat(32)); },
  }), 'changed size while it was being read', 'a file that grew under the read');
  writeFileSync(file, body);
  refuses(() => readStateFileBytes(file, undefined, {
    afterRead: () => { truncateSync(file, 8); },
  }), 'changed size while it was being read', 'a file that shrank under the read');

  writeFileSync(file, body);
  assertEq(readStateFileBytes(file).toString('utf8'), body, 'and the settled file reads again');
});

await test('the tranche document claims only what this tranche proved', () => {
  // A DOCUMENT IS EVIDENCE TOO, AND THE EASIEST PLACE TO OVERSTATE. This tranche hardens code behind claims
  // that were already made; it closes no gate and produces no operator evidence, and the doc has to say so.
  const doc = readFileSync(join(repoRoot, 'docs/PHASES_285_288_CUSTODY_STORAGE_AND_IPC.md'), 'utf8');
  assert(doc.includes('O5 remains'), 'the document restates O5\'s status rather than moving it');
  assert(/NOT live-proven/.test(doc), 'and says plainly that O5 is not live-proven');
  assert(doc.includes('no operator evidence was produced'), 'and that no operator evidence came out of this');
  assert(doc.includes('not a cloud KMS'), 'and what "managed" still does not mean');
  for (const overclaim of ['O5 is closed', 'O5: CLOSED', 'production-proven', 'live-proven on',
    'hardware security module', 'AWS KMS', 'Azure Key Vault', 'Google Cloud KMS']) {
    assert(!doc.includes(overclaim), `the document must not claim ${overclaim}`);
  }
  // AND THE COUNT IT REPORTS IS THE ONE THIS FILE ACTUALLY RUNS. A verification section is evidence, and a
  // number in it that nothing checks is the easiest kind of stale claim to leave behind.
  const declared = /`custodian-storage-ipc-gates` (\d+)/.exec(doc);
  assert(declared !== null, 'the document names this suite and its size');
  const here = (readFileSync(join(repoRoot, 'test/custodian-storage-ipc-gates.ts'), 'utf8')
    .match(/^await test\(/gm) ?? []).length;
  assertEq(Number(declared![1]), here, 'the size the document states is the number of tests in this file');
});

await test('this tranche reaches no network, media server or acquisition system', () => {
  for (const file of ['src/core/crypto/custodian-records.ts', 'src/core/crypto/file-custodian.ts',
    'src/core/crypto/sidecar-ipc.ts', 'src/core/crypto/local-sidecar-runtime.ts',
    'src/core/crypto/local-sidecar-custodian.ts']) {
    const source = readFileSync(join(repoRoot, file), 'utf8').toLowerCase();
    for (const forbidden of ['jellyfin', 'plex', 'emby', '/mnt/user/media', '.mkv', 'nzb', 'torrent', 'magnet',
      'usenet', 'sabnzbd', 'curl ', 'wget ', 'node:http', 'node:https', 'fetch(', 'symlinksync']) {
      assert(!source.includes(forbidden), `${file} must not name ${forbidden}`);
    }
    const bytes = readFileSync(join(repoRoot, file));
    let control = 0;
    for (const byte of bytes) if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) control += 1;
    assertEq(control, 0, `${file} carries no literal control byte`);
  }
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
