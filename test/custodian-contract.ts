import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { KeyCustodian } from '../src/core/crypto/custodian.js';
import { InMemoryCustodian } from '../src/core/crypto/custodian.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { loadCustodianConfig, createCustodian, custodianFromEnv, type CustodianConfig } from '../src/core/crypto/custodian-factory.js';
import { ConfigError, type Env } from '../src/config/env.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];
const tmpDirs: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }
async function assertThrows(fn: () => Promise<unknown> | unknown, msg: string): Promise<void> {
  try { await fn(); } catch { return; }
  throw new Error(`expected to throw: ${msg}`);
}
function freshKeystore(): string { const d = mkdtempSync(path.join(tmpdir(), 'keystore-')); tmpDirs.push(d); return d; }

/**
 * Shared custodian CONFORMANCE KIT. Any `KeyCustodian` implementation (InMemory, File, and the
 * future managed-KMS / age-file adapters) must pass these. `make()` must return a FRESH, isolated
 * custodian on each call. Tests are written to the interface only — no impl-specific assumptions.
 */
export async function runCustodianContract(label: string, make: () => KeyCustodian): Promise<void> {
  await test(`${label} — provision returns a keyId + 32-byte DEK; status provisional`, async () => {
    const c = make();
    const { keyId, dek } = await c.provision('op1', 'item-a', 0);
    assert(typeof keyId === 'string' && keyId.length > 0, 'keyId present');
    assertEq(dek.length, 32, 'DEK is 32 bytes');
    assertEq(await c.status(keyId), 'provisional', 'status provisional before commit');
  });

  await test(`${label} — commit promotes to active; get returns the same DEK`, async () => {
    const c = make();
    const { keyId, dek } = await c.provision('op1', 'item-a', 0);
    await c.commitProvision('op1');
    assertEq(await c.status(keyId), 'active', 'active after commit');
    const got = await c.get(keyId, 0);
    assert(got.equals(dek), 'get returns the provisioned DEK');
  });

  await test(`${label} — get rejects a wrong epoch`, async () => {
    const c = make();
    const { keyId } = await c.provision('op1', 'item-a', 0);
    await c.commitProvision('op1');
    await assertThrows(() => c.get(keyId, 1), 'epoch mismatch rejected');
  });

  await test(`${label} — get fails while still provisional (not active)`, async () => {
    const c = make();
    const { keyId } = await c.provision('op1', 'item-a', 0);
    await assertThrows(() => c.get(keyId, 0), 'get before commit rejected');
  });

  await test(`${label} — provision is idempotent for an identical operation`, async () => {
    const c = make();
    const a = await c.provision('op1', 'item-a', 0);
    const b = await c.provision('op1', 'item-a', 0);
    assertEq(a.keyId, b.keyId, 'same keyId on retry');
    assert(a.dek.equals(b.dek), 'same DEK on retry');
  });

  await test(`${label} — operation_id reused with different inputs is rejected`, async () => {
    const c = make();
    await c.provision('op1', 'item-a', 0);
    await assertThrows(() => c.provision('op1', 'item-b', 0), 'reuse with different inputs rejected');
  });

  await test(`${label} — destroy yields a receipt, marks destroyed, and get fails closed`, async () => {
    const c = make();
    const { keyId } = await c.provision('op1', 'item-a', 0);
    await c.commitProvision('op1');
    const r = await c.destroy('d1', keyId);
    assert(r.keyId === keyId && !!r.receiptId && !!r.destroyedAt && !!r.attestation, 'receipt fields present');
    assertEq(await c.status(keyId), 'destroyed', 'status destroyed');
    await assertThrows(() => c.get(keyId, 0), 'get after destroy fails closed');
  });

  await test(`${label} — destroy is idempotent on operation_id (stable receipt)`, async () => {
    const c = make();
    const { keyId } = await c.provision('op1', 'item-a', 0);
    await c.commitProvision('op1');
    const r1 = await c.destroy('d1', keyId);
    const r2 = await c.destroy('d1', keyId);
    assertEq(r2.receiptId, r1.receiptId, 'same receipt for the same destroy op');
  });

  await test(`${label} — destroy is idempotent on key_id under a new op (stable receipt)`, async () => {
    const c = make();
    const { keyId } = await c.provision('op1', 'item-a', 0);
    await c.commitProvision('op1');
    const r1 = await c.destroy('d1', keyId);
    const r2 = await c.destroy('d2', keyId); // already destroyed -> same stable receipt
    assertEq(r2.receiptId, r1.receiptId, 'stable receipt across a new destroy op');
  });

  await test(`${label} — destroyed is terminal: a late commit cannot reactivate`, async () => {
    const c = make();
    const { keyId } = await c.provision('op1', 'item-a', 0);
    await c.commitProvision('op1');
    await c.destroy('d1', keyId);
    await assertThrows(() => c.commitProvision('op1'), 'commit after destroy rejected');
  });

  await test(`${label} — destroy refuses an unknown key (no fabricated tombstone)`, async () => {
    const c = make();
    await assertThrows(() => c.destroy('d1', 'key_nope'), 'destroy(unknown) refused');
    assertEq(await c.status('key_nope'), 'not_found', 'no tombstone fabricated');
  });

  await test(`${label} — listStaleProvisioning lists provisional, excludes committed/destroyed`, async () => {
    const c = make();
    const prov = await c.provision('op1', 'item-a', 0);              // stays provisional
    const comm = await c.provision('op2', 'item-b', 0);
    await c.commitProvision('op2');                                  // active
    const dead = await c.provision('op3', 'item-c', 0);
    await c.commitProvision('op3');
    await c.destroy('d3', dead.keyId);                               // destroyed
    const stale = await c.listStaleProvisioning();
    const ids = new Set(stale.map((s) => s.keyId));
    assert(ids.has(prov.keyId), 'provisional listed');
    assert(!ids.has(comm.keyId), 'committed not listed');
    assert(!ids.has(dead.keyId), 'destroyed not listed');
  });

  await test(`${label} — status of an unseen key is not_found`, async () => {
    assertEq(await make().status('key_never'), 'not_found', 'unseen -> not_found');
  });
}

async function main(): Promise<void> {
  console.log('Running Phase 3 custodian conformance + factory suite (Stage 3.2):\n');
  const secret = 'contract-secret';

  // --- conformance kit against the two reference implementations -------------
  await runCustodianContract('InMemoryCustodian', () => new InMemoryCustodian(secret));
  await runCustodianContract('FileCustodian', () => new FileCustodian(freshKeystore(), secret, randomBytes(32)));

  // --- and against custodians built through the factory (proves equivalence) -
  await runCustodianContract('factory(memory)', () => createCustodian({ mode: 'memory', completionSecret: secret }));
  await runCustodianContract('factory(file)', () => createCustodian({ mode: 'file', completionSecret: secret, keystoreDir: freshKeystore(), kek: randomBytes(32) }));

  // --- factory config validation --------------------------------------------
  const kekB64 = randomBytes(32).toString('base64');
  const fileEnv = (extra: Env = {}): Env => ({ CUSTODIAN_MODE: 'file', COMPLETION_SECRET: secret, CUSTODIAN_KEYSTORE_DIR: freshKeystore(), CUSTODIAN_KEK: kekB64, ...extra });

  await test('factory — loadCustodianConfig parses memory mode', () => {
    const cfg = loadCustodianConfig({ CUSTODIAN_MODE: 'memory', COMPLETION_SECRET: secret });
    assertEq(cfg.mode, 'memory', 'mode memory');
    assertEq((cfg as Extract<CustodianConfig, { mode: 'memory' }>).completionSecret, secret, 'secret carried');
  });

  await test('factory — loadCustodianConfig parses file mode (base64 KEK -> 32 bytes)', () => {
    const cfg = loadCustodianConfig(fileEnv());
    assert(cfg.mode === 'file' && cfg.kek.length === 32, 'file mode, 32-byte KEK decoded');
  });

  await test('factory — unknown CUSTODIAN_MODE fails closed (ConfigError)', () => {
    try { loadCustodianConfig({ CUSTODIAN_MODE: 'kms', COMPLETION_SECRET: secret }); assert(false, 'should throw'); }
    catch (e) { assert(e instanceof ConfigError, 'ConfigError'); assert(/CUSTODIAN_MODE must be one of/.test((e as Error).message), 'lists supported modes'); }
  });

  await test('factory — missing COMPLETION_SECRET fails closed', () => {
    try { loadCustodianConfig({ CUSTODIAN_MODE: 'memory' }); assert(false, 'should throw'); }
    catch (e) { assert(e instanceof ConfigError, 'ConfigError'); assert(/COMPLETION_SECRET is required/.test((e as Error).message), 'names the secret var'); }
  });

  await test('factory — file mode missing KEK fails closed', () => {
    try { loadCustodianConfig({ CUSTODIAN_MODE: 'file', COMPLETION_SECRET: secret, CUSTODIAN_KEYSTORE_DIR: freshKeystore() }); assert(false, 'should throw'); }
    catch (e) { assert(/CUSTODIAN_KEK is required/.test((e as Error).message), 'names the KEK var'); }
  });

  await test('factory — KEK of the wrong length fails closed', () => {
    try { loadCustodianConfig(fileEnv({ CUSTODIAN_KEK: randomBytes(16).toString('base64') })); assert(false, 'should throw'); }
    catch (e) { assert(/CUSTODIAN_KEK must decode .* 32 bytes/.test((e as Error).message), 'reports 32-byte requirement'); }
  });

  await test('factory — config errors never leak the secret or KEK value', () => {
    const secretSentinel = 'SUPERSECRET-COMPLETION';
    const kekSentinel = Buffer.alloc(16, 7).toString('base64'); // wrong length -> triggers an error
    try {
      loadCustodianConfig({ CUSTODIAN_MODE: 'file', COMPLETION_SECRET: secretSentinel, CUSTODIAN_KEYSTORE_DIR: freshKeystore(), CUSTODIAN_KEK: kekSentinel });
      assert(false, 'should throw');
    } catch (e) {
      const m = (e as Error).message;
      assert(!m.includes(secretSentinel), 'completion secret value not leaked');
      assert(!m.includes(kekSentinel), 'KEK value not leaked');
    }
  });

  await test('factory — createCustodian fails closed on an unsupported mode', () => {
    try { createCustodian({ mode: 'kms' } as unknown as CustodianConfig); assert(false, 'should throw'); }
    catch (e) { assert(e instanceof ConfigError, 'ConfigError'); assert(/unsupported custodian mode/.test((e as Error).message), 'fail-closed message'); }
  });

  await test('factory — custodianFromEnv builds a working custodian end-to-end', async () => {
    const c = custodianFromEnv(fileEnv());
    const { keyId } = await c.provision('op1', 'item-a', 0);
    await c.commitProvision('op1');
    assertEq(await c.status(keyId), 'active', 'env-built custodian works');
  });

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
