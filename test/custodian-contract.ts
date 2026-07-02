import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryCustodian } from '../src/core/crypto/custodian.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { loadCustodianConfig, createCustodian, custodianFromEnv, type CustodianConfig } from '../src/core/crypto/custodian-factory.js';
import { ConfigError, type Env } from '../src/config/env.js';
import {
  reportCustodianContractResults,
  runCustodianContract,
  runCustodianContractTest,
} from './helpers/custodian-contract-kit.js';

const tmpDirs: string[] = [];

function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }
function freshKeystore(): string { const d = mkdtempSync(path.join(tmpdir(), 'keystore-')); tmpDirs.push(d); return d; }

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

  await runCustodianContractTest('factory — loadCustodianConfig parses memory mode', () => {
    const cfg = loadCustodianConfig({ CUSTODIAN_MODE: 'memory', COMPLETION_SECRET: secret });
    assertEq(cfg.mode, 'memory', 'mode memory');
    assertEq((cfg as Extract<CustodianConfig, { mode: 'memory' }>).completionSecret, secret, 'secret carried');
  });

  await runCustodianContractTest('factory — loadCustodianConfig parses file mode (base64 KEK -> 32 bytes)', () => {
    const cfg = loadCustodianConfig(fileEnv());
    assert(cfg.mode === 'file' && cfg.kek.length === 32, 'file mode, 32-byte KEK decoded');
  });

  await runCustodianContractTest('factory — unknown CUSTODIAN_MODE fails closed (ConfigError)', () => {
    try { loadCustodianConfig({ CUSTODIAN_MODE: 'kms', COMPLETION_SECRET: secret }); assert(false, 'should throw'); }
    catch (e) { assert(e instanceof ConfigError, 'ConfigError'); assert(/CUSTODIAN_MODE must be one of/.test((e as Error).message), 'lists supported modes'); }
  });

  await runCustodianContractTest('factory — missing COMPLETION_SECRET fails closed', () => {
    try { loadCustodianConfig({ CUSTODIAN_MODE: 'memory' }); assert(false, 'should throw'); }
    catch (e) { assert(e instanceof ConfigError, 'ConfigError'); assert(/COMPLETION_SECRET is required/.test((e as Error).message), 'names the secret var'); }
  });

  await runCustodianContractTest('factory — file mode missing KEK fails closed', () => {
    try { loadCustodianConfig({ CUSTODIAN_MODE: 'file', COMPLETION_SECRET: secret, CUSTODIAN_KEYSTORE_DIR: freshKeystore() }); assert(false, 'should throw'); }
    catch (e) { assert(/CUSTODIAN_KEK is required/.test((e as Error).message), 'names the KEK var'); }
  });

  await runCustodianContractTest('factory — KEK of the wrong length fails closed', () => {
    try { loadCustodianConfig(fileEnv({ CUSTODIAN_KEK: randomBytes(16).toString('base64') })); assert(false, 'should throw'); }
    catch (e) { assert(/CUSTODIAN_KEK must decode .* 32 bytes/.test((e as Error).message), 'reports 32-byte requirement'); }
  });

  await runCustodianContractTest('factory — config errors never leak the secret or KEK value', () => {
    const secretSentinel = 'SUPERSECRET-COMPLETION';
    const kekSentinel = Buffer.alloc(16, 7).toString('base64');
    try {
      loadCustodianConfig({ CUSTODIAN_MODE: 'file', COMPLETION_SECRET: secretSentinel, CUSTODIAN_KEYSTORE_DIR: freshKeystore(), CUSTODIAN_KEK: kekSentinel });
      assert(false, 'should throw');
    } catch (e) {
      const m = (e as Error).message;
      assert(!m.includes(secretSentinel), 'completion secret value not leaked');
      assert(!m.includes(kekSentinel), 'KEK value not leaked');
    }
  });

  await runCustodianContractTest('factory — createCustodian fails closed on an unsupported mode', () => {
    try { createCustodian({ mode: 'kms' } as unknown as CustodianConfig); assert(false, 'should throw'); }
    catch (e) { assert(e instanceof ConfigError, 'ConfigError'); assert(/unsupported custodian mode/.test((e as Error).message), 'fail-closed message'); }
  });

  await runCustodianContractTest('factory — custodianFromEnv builds a working custodian end-to-end', async () => {
    const c = custodianFromEnv(fileEnv());
    const { keyId } = await c.provision('op1', 'item-a', 0);
    await c.commitProvision('op1');
    assertEq(await c.status(keyId), 'active', 'env-built custodian works');
  });

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  reportCustodianContractResults();
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
