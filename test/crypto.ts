import { randomBytes } from 'node:crypto';
import {
  encrypt, decrypt, encryptUtf8, decryptUtf8, zeroize, SCHEMA_VERSION, type Aad,
} from '../src/core/crypto/envelope.js';
import { InMemoryCustodian, CustodianTransportError } from '../src/core/crypto/custodian.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push([name, err]);
    console.log(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}
async function assertThrows(fn: () => Promise<unknown> | unknown, msg: string, match?: RegExp): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (match && !match.test((e as Error).message)) throw new Error(`threw, message ${JSON.stringify((e as Error).message)} != ${match} (${msg})`);
    return;
  }
  throw new Error(`expected to throw: ${msg}`);
}

const aad = (over: Partial<Aad> = {}): Aad => ({ itemId: 'item-1', keyEpoch: 0, schemaVersion: SCHEMA_VERSION, field: 'identity', ...over });

async function main(): Promise<void> {
  console.log('Running Phase 2 crypto suite (envelope + custodian):\n');

  // --- envelope -------------------------------------------------------------
  await test('envelope — round-trips plaintext', () => {
    const dek = randomBytes(32);
    const env = encryptUtf8(dek, 'The Matrix', aad());
    assert(decryptUtf8(dek, env, aad()) === 'The Matrix', 'decrypt returns plaintext');
  });

  await test('envelope — fresh nonce each time (ciphertexts differ)', () => {
    const dek = randomBytes(32);
    const a = encryptUtf8(dek, 'same', aad());
    const b = encryptUtf8(dek, 'same', aad());
    assert(!a.equals(b), 'two encryptions of identical plaintext differ');
  });

  await test('envelope — tamper is detected', async () => {
    const dek = randomBytes(32);
    const env = encryptUtf8(dek, 'secret', aad());
    const last = env.length - 1;
    env[last] = (env[last] ?? 0) ^ 0x01; // flip a tag byte
    await assertThrows(() => decrypt(dek, env, aad()), 'tampered envelope rejected');
  });

  await test('envelope — AAD swap (field / item / epoch / schema) is detected', async () => {
    const dek = randomBytes(32);
    const env = encryptUtf8(dek, 'secret', aad({ field: 'identity', itemId: 'item-1', keyEpoch: 0 }));
    await assertThrows(() => decrypt(dek, env, aad({ field: 'ref:tmdb' })), 'field swap');
    await assertThrows(() => decrypt(dek, env, aad({ itemId: 'item-2' })), 'item swap');
    await assertThrows(() => decrypt(dek, env, aad({ keyEpoch: 1 })), 'epoch swap');
    await assertThrows(() => decrypt(dek, env, aad({ schemaVersion: 99 })), 'schema swap');
  });

  await test('envelope — wrong key fails; version byte validated', async () => {
    const env = encryptUtf8(randomBytes(32), 'x', aad());
    await assertThrows(() => decrypt(randomBytes(32), env, aad()), 'wrong key');
    const bad = Buffer.from(env); bad[0] = 9;
    await assertThrows(() => decrypt(randomBytes(32), bad, aad()), 'bad version', /version/);
  });

  await test('envelope — zeroize clears the buffer', () => {
    const dek = randomBytes(32);
    zeroize(dek);
    assert(dek.every((b) => b === 0), 'buffer zeroized');
  });

  // --- custodian ------------------------------------------------------------
  let t = 1000;
  const clock = () => t;
  const newCust = () => new InMemoryCustodian(clock);

  await test('custodian — provision is provisional; get denied until commit; then active', async () => {
    const c = newCust();
    const { keyId } = await c.provision('op1', 'item-1', 0);
    assert((await c.status(keyId)) === 'provisional', 'provisional after provision');
    await assertThrows(() => c.get(keyId, 0), 'get denied while provisional', /not active/);
    await c.commitProvision('op1');
    assert((await c.status(keyId)) === 'active', 'active after commit');
    assert((await c.get(keyId, 0)).length === 32, 'get returns 32-byte DEK when active');
  });

  await test('custodian — provision idempotent on same op+inputs; fails on different inputs', async () => {
    const c = newCust();
    const a = await c.provision('op1', 'item-1', 0);
    const b = await c.provision('op1', 'item-1', 0);
    assert(a.keyId === b.keyId, 'same op_id + inputs => same key');
    await assertThrows(() => c.provision('op1', 'item-2', 0), 'op_id reuse with different inputs fails', /different inputs/);
  });

  await test('custodian — destroyed is terminal (no reactivation) and idempotent', async () => {
    const c = newCust();
    const { keyId } = await c.provision('op1', 'item-1', 0);
    await c.commitProvision('op1');
    const r1 = await c.destroy('op-d', keyId);
    assert((await c.status(keyId)) === 'destroyed', 'destroyed after destroy');
    await assertThrows(() => c.get(keyId, 0), 'get denied after destroy');
    await assertThrows(() => c.commitProvision('op1'), 'cannot reactivate destroyed', /terminal/);
    const r2 = await c.destroy('op-d', keyId);
    assert(r1.receiptId === r2.receiptId, 'destroy idempotent on op_id (same receipt)');
    const r3 = await c.destroy('op-d2', keyId);
    assert(r1.receiptId === r3.receiptId, 'destroy idempotent on key_id (same receipt)');
  });

  await test('custodian — status is a value; transport failure is an exception', async () => {
    const c = newCust();
    const { keyId } = await c.provision('op1', 'item-1', 0);
    assert((await c.status('nope')) === 'not_found', 'unknown key => not_found');
    c.setFault('status', new CustodianTransportError('status'));
    await assertThrows(() => c.status(keyId), 'transport failure throws (not a value)', /transport/);
    c.setFault('status', null);
    assert((await c.status(keyId)) === 'provisional', 'recovers after fault cleared');
  });

  await test('custodian — listStaleProvisioning lists provisional, drops committed', async () => {
    const c = newCust();
    await c.provision('op1', 'item-1', 0);
    const { } = await c.provision('op2', 'item-2', 0);
    await c.commitProvision('op2');
    const stale = await c.listStaleProvisioning();
    assert(stale.length === 1 && stale[0]!.operationId === 'op1', 'only the uncommitted provisional is stale');
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
