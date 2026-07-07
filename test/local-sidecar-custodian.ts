import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CustodianTransportError,
  InMemoryCustodian,
  type KeyCustodian,
} from '../src/core/crypto/custodian.js';
import {
  buildLocalSidecarCustodianDescriptor,
  dispatchLocalSidecarCustodianRequest,
  LocalSidecarCustodianClient,
  type LocalSidecarCustodianRequest,
  type LocalSidecarCustodianResponse,
  type LocalSidecarCustodianTransport,
} from '../src/core/crypto/local-sidecar-custodian.js';
import { validateProductionCustodianDescriptor } from '../src/core/crypto/production-custodian-contract.js';
import {
  reportCustodianContractResults,
  resetCustodianContractResults,
  runCustodianContract,
  runCustodianContractTest,
} from './helpers/custodian-contract-kit.js';

class InProcessSidecarTransport implements LocalSidecarCustodianTransport {
  constructor(private readonly custodian: KeyCustodian) {}

  dispatch(request: LocalSidecarCustodianRequest): Promise<LocalSidecarCustodianResponse> {
    return dispatchLocalSidecarCustodianRequest(this.custodian, request);
  }
}

class FaultingTransport implements LocalSidecarCustodianTransport {
  private fault: Error | null = null;

  constructor(private readonly inner: LocalSidecarCustodianTransport) {}

  fail(err: Error): void {
    this.fault = err;
  }

  clear(): void {
    this.fault = null;
  }

  dispatch(request: LocalSidecarCustodianRequest): Promise<LocalSidecarCustodianResponse> {
    if (this.fault) throw this.fault;
    return this.inner.dispatch(request);
  }
}

function makeSidecarClient(): LocalSidecarCustodianClient {
  const inner = new InMemoryCustodian('phase-98-local-sidecar-secret', () => 1_804_032_000_000);
  return new LocalSidecarCustodianClient(new InProcessSidecarTransport(inner));
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function assertThrowsTransport(fn: () => Promise<unknown>, op: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof CustodianTransportError, `throws CustodianTransportError for ${op}`);
    assert(!String((err as Error).message).includes('LEAK'), 'transport failure message is sanitized');
    return;
  }
  throw new Error(`expected transport failure for ${op}`);
}

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
}

async function main(): Promise<void> {
  resetCustodianContractResults();
  console.log('Running Phase 98 local sidecar custodian prototype suite:\n');

  await runCustodianContract('LocalSidecarCustodianClient', makeSidecarClient);

  await runCustodianContractTest('sidecar transport failures throw and never return fallback statuses', async () => {
    const inner = new InMemoryCustodian('phase-98-local-sidecar-secret', () => 1_804_032_000_000);
    const transport = new FaultingTransport(new InProcessSidecarTransport(inner));
    const client = new LocalSidecarCustodianClient(transport);
    const { keyId } = await client.provision('op-status', 'item-a', 0);
    transport.fail(new Error('LEAK: https://sidecar.invalid/token SECRET'));
    await assertThrowsTransport(() => client.status(keyId), 'status');
    transport.clear();
    assert((await client.status(keyId)) === 'provisional', 'status is definite after transport recovers');
  });

  await runCustodianContractTest('sidecar protocol serializes DEKs as base64 and validates response shape', async () => {
    const inner = new InMemoryCustodian('phase-98-local-sidecar-secret', () => 1_804_032_000_000);
    const response = await dispatchLocalSidecarCustodianRequest(inner, {
      op: 'provision',
      operationId: 'op-protocol',
      itemId: 'item-a',
      epoch: 0,
    });
    if (response.op !== 'provision') throw new Error('provision response');
    assert(typeof response.dekBase64 === 'string' && !response.dekBase64.includes('item-a'), 'DEK is encoded and identity-free');
    const json = JSON.stringify(response);
    assert(!json.includes('Buffer'), 'protocol response is JSON-shaped, not a Buffer dump');
  });

  await runCustodianContractTest('malformed sidecar responses fail closed as transport errors', async () => {
    const client = new LocalSidecarCustodianClient({
      async dispatch(): Promise<LocalSidecarCustodianResponse> {
        return { op: 'status', status: 'active' };
      },
    });
    await assertThrowsTransport(() => client.get('key-a', 0), 'get');
  });

  await runCustodianContractTest('prototype descriptor is complete but still does not close O4', () => {
    const report = validateProductionCustodianDescriptor(buildLocalSidecarCustodianDescriptor());
    assert(report.findings.every((finding) => finding.level !== 'fail'), 'descriptor has no fail findings');
    assert(report.o4Status === 'open/deferred', 'O4 remains open');
    assert(report.closesO4 === false, 'descriptor closes no gate');
  });

  await runCustodianContractTest('source and docs keep Phase 98 offline and self-hosted only', () => {
    const source = read('src/core/crypto/local-sidecar-custodian.ts');
    const combined = `${source}\n${read('docs/PHASE_98_LOCAL_SIDECAR_CUSTODIAN_PROTOTYPE.md')}\n${read('README.md')}\n${read('package.json')}`;
    for (const forbidden of [
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'node:fs',
      'globalThis.fetch',
      'fetch(',
      'process.env',
      "from 'pg'",
      'docker compose',
      '@aws-sdk',
      '@azure',
      '@google-cloud',
      'express',
      'fastify',
      'koa',
      'setInterval',
      'setTimeout',
      'ProviderAdapter',
      'TorBoxReadOnlyClient',
      'JellyfinHttpClient',
    ]) assert(!source.includes(forbidden), `Phase 98 source excludes ${forbidden}`);
    for (const required of [
      'Phase 98',
      'LocalSidecarCustodianClient',
      'external-self-hosted',
      'injected transport',
      'no sockets',
      'no daemon',
      'no live service contact',
      'O4 remains open/deferred',
      'O5 remains open/deferred',
      'FileCustodian remains a hardened reference harness',
    ]) assert(combined.includes(required), `Phase 98 surface preserves ${required}`);
  });

  reportCustodianContractResults();
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
