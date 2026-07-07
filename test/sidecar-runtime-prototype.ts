import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CustodianTransportError,
  InMemoryCustodian,
} from '../src/core/crypto/custodian.js';
import { LocalSidecarCustodianClient } from '../src/core/crypto/local-sidecar-custodian.js';
import {
  assertLocalSocketPath,
  startLocalSidecarRuntime,
  UnixSocketSidecarTransport,
} from '../src/core/crypto/local-sidecar-runtime.js';
import {
  buildSidecarRuntimeEvidencePacket,
  formatSidecarRuntimeEvidencePacketText,
  type SidecarRuntimeEvidencePacket,
} from '../src/ops/sidecar-runtime-evidence.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

function socketPath(): string {
  const id = `catalog-sidecar-test-${process.pid}-${randomUUID()}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

async function assertThrowsTransport(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof CustodianTransportError, `${label} throws CustodianTransportError`);
    assert(!String((err as Error).message).includes('SECRET'), `${label} error message is sanitized`);
    return;
  }
  throw new Error(`${label} should throw`);
}

console.log('Running Phase 101/102 sidecar runtime prototype suite:\n');

await test('local socket runtime supports provision, commit, get, destroy, and status', async () => {
  const path = socketPath();
  const runtime = await startLocalSidecarRuntime({
    socketPath: path,
    custodian: new InMemoryCustodian('phase-101-102-test-secret', () => 1_804_118_400_000),
  });
  try {
    const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(path));
    const { keyId, dek } = await client.provision('op-runtime', 'item-redacted', 0);
    assert((await client.status(keyId)) === 'provisional', 'status provisional');
    await client.commitProvision('op-runtime');
    assert((await client.status(keyId)) === 'active', 'status active');
    assert((await client.get(keyId, 0)).equals(dek), 'get returns same DEK');
    const receipt = await client.destroy('op-destroy', keyId);
    assert(receipt.keyId === keyId && receipt.receiptId.length > 0 && receipt.attestation.length > 0, 'receipt shape');
    assert((await client.status(keyId)) === 'destroyed', 'status destroyed');
    await assertThrowsTransport(() => client.get(keyId, 0), 'destroyed get');
  } finally {
    await runtime.close();
  }
});

await test('unavailable local sidecar fails closed without fallback status', async () => {
  const client = new LocalSidecarCustodianClient(new UnixSocketSidecarTransport(socketPath()));
  await assertThrowsTransport(() => client.status('key-redacted'), 'missing sidecar status');
});

await test('socket path validator rejects network endpoint shapes', () => {
  for (const invalid of ['127.0.0.1:9999', 'http://127.0.0.1:9999', 'https://example.invalid/sidecar']) {
    try {
      assertLocalSocketPath(invalid);
    } catch {
      continue;
    }
    throw new Error(`accepted network endpoint: ${invalid}`);
  }
});

await test('runtime evidence packet is redaction-safe and still closes no gates', async () => {
  const report = await buildSidecarRuntimeEvidencePacket();
  assert(report.ok === true, 'evidence packet ok');
  assert(report.report === 'phase-101-102-sidecar-runtime-evidence', 'report id');
  assert(report.runtimePrototypeImplemented === true, 'runtime prototype implemented');
  assert(report.localSocketExercised === true, 'local socket exercised');
  assert(report.tcpListenerAllowed === false && report.httpApiAllowed === false, 'TCP and HTTP blocked');
  assert(report.serviceInstallAllowed === false && report.liveValidationAllowed === false, 'service install and live validation blocked');
  assert(report.closesO4 === false && report.closesO5 === false, 'no gate closure');
  assert(report.evidenceHarness.reviewReadiness === 'ready-for-review', 'evidence manifest ready for review');
  assert(report.evidenceHarness.closesO4 === false, 'harness does not close O4');
  for (const check of report.checks) assert(check.status === 'pass', `check passes: ${check.id}`);
  assertNoLeak(report);
  assertNoLeak(formatSidecarRuntimeEvidencePacketText(report));
});

await test('source and docs preserve local-only runtime prototype boundary', () => {
  const source = [
    read('src/core/crypto/local-sidecar-runtime.ts'),
    read('src/ops/sidecar-runtime-evidence.ts'),
    read('src/ops/sidecar-runtime-evidence-cli.ts'),
  ].join('\n');
  const combined = `${source}\n${read('docs/PHASE_101_102_SIDECAR_RUNTIME_PROTOTYPE.md')}\n${read('README.md')}\n${read('package.json')}`;
  for (const forbidden of [
    'node:http',
    'node:https',
    'globalThis.fetch',
    'fetch(',
    "from 'pg'",
    'docker compose',
    '@aws-sdk',
    '@azure',
    '@google-cloud',
    'express',
    'fastify',
    'koa',
    'ProviderAdapter',
    'TorBoxReadOnlyClient',
    'JellyfinHttpClient',
  ]) assert(!source.includes(forbidden), `Phase 101/102 source excludes ${forbidden}`);
  for (const required of [
    'phase-101-102-sidecar-runtime-evidence',
    'UnixSocketSidecarTransport',
    'startLocalSidecarRuntime',
    'local socket',
    'tcpListenerAllowed: false',
    'httpApiAllowed: false',
    'serviceInstallAllowed: false',
    'liveValidationAllowed: false',
    'closesO4: false',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian remains a hardened reference harness',
  ]) assert(combined.includes(required), `Phase 101/102 surface preserves ${required}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}

function assertNoLeak(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const sentinel of [
    'phase-101-102-test-secret',
    'phase-101-102-sidecar-runtime-secret',
    'item-redacted',
    'runtime-item',
    'dekBase64',
    'postgres://',
    'http://',
    'https://',
    'PRIVATE',
  ]) assert(!text.includes(sentinel), `evidence leaked ${sentinel}`);
}
