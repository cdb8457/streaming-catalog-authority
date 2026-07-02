import {
  CustodianTransportError,
  InMemoryCustodian,
  type DestructionReceipt,
  type KeyCustodian,
  type KeyStatus,
  type ProvisionResult,
  type StaleProvisioning,
} from '../src/core/crypto/custodian.js';
import {
  reportCustodianContractResults,
  resetCustodianContractResults,
  runCustodianContract,
  runCustodianContractTest,
} from './helpers/custodian-contract-kit.js';

class LocalExternalCustodianHarness implements KeyCustodian {
  private readonly inner: InMemoryCustodian;

  constructor() {
    this.inner = new InMemoryCustodian('phase-21-acceptance-secret', () => 1_804_032_000_000);
  }

  fail(op: 'provision' | 'commit' | 'get' | 'destroy' | 'status' | 'list', when: 'before' | 'after' = 'before'): void {
    this.inner.setFault(op, new CustodianTransportError(op), when);
  }

  clear(op: 'provision' | 'commit' | 'get' | 'destroy' | 'status' | 'list', when: 'before' | 'after' = 'before'): void {
    this.inner.setFault(op, null, when);
  }

  provision(operationId: string, itemId: string, epoch: number): Promise<ProvisionResult> {
    return this.inner.provision(operationId, itemId, epoch);
  }

  commitProvision(operationId: string): Promise<void> {
    return this.inner.commitProvision(operationId);
  }

  get(keyId: string, epoch: number): Promise<Buffer> {
    return this.inner.get(keyId, epoch);
  }

  destroy(operationId: string, keyId: string): Promise<DestructionReceipt> {
    return this.inner.destroy(operationId, keyId);
  }

  status(keyId: string): Promise<KeyStatus> {
    return this.inner.status(keyId);
  }

  listStaleProvisioning(): Promise<StaleProvisioning[]> {
    return this.inner.listStaleProvisioning();
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function assertThrowsTransport(fn: () => Promise<unknown>, op: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof CustodianTransportError, `throws CustodianTransportError for ${op}`);
    assert((err as Error).message.includes(op), `transport error names ${op}`);
    return;
  }
  throw new Error(`expected transport failure for ${op}`);
}

async function main(): Promise<void> {
  resetCustodianContractResults();
  console.log('Running Phase 21 external custodian acceptance harness suite:\n');

  await runCustodianContract('LocalExternalCustodianHarness', () => new LocalExternalCustodianHarness());

  await runCustodianContractTest('acceptance - status transport failures are thrown, never status values', async () => {
    const c = new LocalExternalCustodianHarness();
    const { keyId } = await c.provision('op-status', 'item-a', 0);
    c.fail('status');
    await assertThrowsTransport(() => c.status(keyId), 'status');
    c.clear('status');
    assert((await c.status(keyId)) === 'provisional', 'status remains definite after transport recovers');
  });

  await runCustodianContractTest('acceptance - get transport failures throw instead of returning cached key material', async () => {
    const c = new LocalExternalCustodianHarness();
    const { keyId, dek } = await c.provision('op-get', 'item-a', 0);
    await c.commitProvision('op-get');
    c.fail('get');
    await assertThrowsTransport(() => c.get(keyId, 0), 'get');
    c.clear('get');
    const recovered = await c.get(keyId, 0);
    assert(recovered.equals(dek), 'get returns the original DEK only after transport recovers');
  });

  await runCustodianContractTest('acceptance - listStaleProvisioning transport failures throw instead of returning empty', async () => {
    const c = new LocalExternalCustodianHarness();
    const { keyId } = await c.provision('op-list', 'item-a', 0);
    c.fail('list');
    await assertThrowsTransport(() => c.listStaleProvisioning(), 'list');
    c.clear('list');
    const stale = await c.listStaleProvisioning();
    assert(stale.some((s) => s.keyId === keyId), 'stale provisioning remains visible after transport recovers');
  });

  await runCustodianContractTest('acceptance - lost provision ack retries return the same key and DEK', async () => {
    const c = new LocalExternalCustodianHarness();
    c.fail('provision', 'after');
    await assertThrowsTransport(() => c.provision('op-lost-provision', 'item-a', 0), 'provision');
    c.clear('provision', 'after');
    const a = await c.provision('op-lost-provision', 'item-a', 0);
    const b = await c.provision('op-lost-provision', 'item-a', 0);
    assert(a.keyId === b.keyId, 'retry returns stable keyId');
    assert(a.dek.equals(b.dek), 'retry returns stable DEK');
  });

  await runCustodianContractTest('acceptance - lost commit ack retries reach active and preserve the DEK', async () => {
    const c = new LocalExternalCustodianHarness();
    const { keyId, dek } = await c.provision('op-lost-commit', 'item-a', 0);
    c.fail('commit', 'after');
    await assertThrowsTransport(() => c.commitProvision('op-lost-commit'), 'commit');
    c.clear('commit', 'after');
    assert((await c.status(keyId)) === 'active', 'remote commit succeeded before the lost acknowledgement');
    await c.commitProvision('op-lost-commit');
    assert((await c.status(keyId)) === 'active', 'retry leaves the key active');
    const recovered = await c.get(keyId, 0);
    assert(recovered.equals(dek), 'get returns the original DEK after retrying commit');
  });

  await runCustodianContractTest('acceptance - lost destroy ack retries return the durable receipt', async () => {
    const c = new LocalExternalCustodianHarness();
    const { keyId } = await c.provision('op-provision', 'item-a', 0);
    await c.commitProvision('op-provision');
    c.fail('destroy', 'after');
    await assertThrowsTransport(() => c.destroy('op-destroy', keyId), 'destroy');
    c.clear('destroy', 'after');
    const retry = await c.destroy('op-destroy', keyId);
    const newOp = await c.destroy('op-destroy-again', keyId);
    assert(retry.receiptId === newOp.receiptId, 'receipt stable after lost ack and new destroy op');
    assert((await c.status(keyId)) === 'destroyed', 'key remains destroyed after retry');
  });

  reportCustodianContractResults();
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
