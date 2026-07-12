import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryCustodian } from '../src/core/crypto/custodian.js';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { loadCustodianConfig, createCustodian, custodianFromEnv, type CustodianConfig } from '../src/core/crypto/custodian-factory.js';
import { startLocalSidecarRuntime } from '../src/core/crypto/local-sidecar-runtime.js';
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
function freshSocketPath(): string {
  const id = `catalog-sidecar-factory-${process.pid}-${randomUUID()}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(tmpdir(), `${id}.sock`);
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

  await runCustodianContractTest('factory — loadCustodianConfig parses memory mode', () => {
    const cfg = loadCustodianConfig({ CUSTODIAN_MODE: 'memory', COMPLETION_SECRET: secret });
    assertEq(cfg.mode, 'memory', 'mode memory');
    assertEq((cfg as Extract<CustodianConfig, { mode: 'memory' }>).completionSecret, secret, 'secret carried');
  });

  await runCustodianContractTest('factory — loadCustodianConfig parses file mode (base64 KEK -> 32 bytes)', () => {
    const cfg = loadCustodianConfig(fileEnv());
    assert(cfg.mode === 'file' && cfg.kek.length === 32, 'file mode, 32-byte KEK decoded');
  });

  await runCustodianContractTest('factory sidecar config parses without app-held secret or KEK', () => {
    const socketPath = freshSocketPath();
    const cfg = loadCustodianConfig({ CUSTODIAN_MODE: 'sidecar', CUSTODIAN_SIDECAR_SOCKET_PATH: socketPath });
    if (cfg.mode !== 'sidecar') throw new Error('mode sidecar');
    assertEq(cfg.socketPath, socketPath, 'socket path carried');
  });

  await runCustodianContractTest('factory sidecar config requires local IPC path and rejects network endpoints', () => {
    try { loadCustodianConfig({ CUSTODIAN_MODE: 'sidecar' }); assert(false, 'should throw missing socket'); }
    catch (e) { assert(e instanceof ConfigError, 'ConfigError'); assert(/CUSTODIAN_SIDECAR_SOCKET_PATH is required/.test((e as Error).message), 'requires socket path'); }
    try { loadCustodianConfig({ CUSTODIAN_MODE: 'sidecar', CUSTODIAN_SIDECAR_SOCKET_PATH: '127.0.0.1:7777' }); assert(false, 'should throw network endpoint'); }
    catch (e) { assert(e instanceof ConfigError, 'ConfigError'); assert(/must be a local Unix socket path or Windows named pipe/.test((e as Error).message), 'rejects network endpoint'); }
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

  await runCustodianContractTest('factory sidecar mode talks to local socket and preserves fail-closed destroy behavior', async () => {
    const socketPath = freshSocketPath();
    const runtime = await startLocalSidecarRuntime({
      socketPath,
      custodian: new InMemoryCustodian('sidecar-factory-secret', () => 1_804_291_200_000),
    });
    try {
      const c = custodianFromEnv({ CUSTODIAN_MODE: 'sidecar', CUSTODIAN_SIDECAR_SOCKET_PATH: socketPath });
      const { keyId, dek } = await c.provision('sidecar-op1', 'sidecar-item-a', 0);
      await c.commitProvision('sidecar-op1');
      assert((await c.get(keyId, 0)).equals(dek), 'sidecar factory get returns provisioned DEK');
      await c.destroy('sidecar-destroy', keyId);
      try { await c.get(keyId, 0); assert(false, 'destroyed get should fail'); }
      catch { /* expected fail-closed path */ }
    } finally {
      await runtime.close();
    }
  });

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  reportCustodianContractResults();
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
