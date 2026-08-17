import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAdapter, loadAdapterConfig } from '../src/core/adapters/adapter-factory.js';
import { TorBoxProviderAdapter } from '../src/core/adapters/torbox-provider-adapter.js';
import type { TorBoxTransport, TorBoxTransportRequest } from '../src/core/adapters/torbox-real-client-gate.js';
import { ConfigError, type Env } from '../src/config/env.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

class RecordingTransport implements TorBoxTransport {
  readonly requests: TorBoxTransportRequest[] = [];
  constructor(private readonly availability: 'available' | 'unavailable' | 'unknown' = 'available') {}

  async request(request: TorBoxTransportRequest) {
    this.requests.push(request);
    return { status: 200, body: { availability: this.availability } };
  }
}

console.log('Running Phase 46 TorBox provider adapter suite:\n');

await test('adapter resolves advisory availability through injected transport only', async () => {
  const transport = new RecordingTransport('available');
  const adapter = new TorBoxProviderAdapter({ transport, timeoutMs: 2500 });
  const result = await adapter.resolveRef({
    itemId: '00000000-0000-0000-0000-000000000000',
    refType: 'infohash',
    refValue: '0123456789abcdef0123456789abcdef01234567',
  });

  assertEq(adapter.describe().name, 'torbox-readonly', 'adapter name');
  assertEq(adapter.describe().kind, 'ref-resolver', 'adapter kind');
  assertEq(result.status, 'available', 'available result');
  assertEq(result.detail, 'fixture-advisory-hit', 'safe advisory detail');
  assertEq(transport.requests.length, 1, 'one transport request');
  assertEq(transport.requests[0]!.operation, 'torrent-cache-check', 'mapped operation');
  assertEq(transport.requests[0]!.method, 'GET', 'GET only');
  assertEq(transport.requests[0]!.timeoutMs, 2500, 'clamped timeout preserved');
});

await test('factory builds torbox-readonly only from explicit injected transport config', async () => {
  const transport = new RecordingTransport('unavailable');
  const adapter = createAdapter({ mode: 'torbox-readonly', transport });
  if (adapter === null) throw new Error('adapter created');
  assertEq(adapter.describe().name, 'torbox-readonly', 'factory adapter name');
  const result = await adapter.resolveRef({
    itemId: '00000000-0000-0000-0000-000000000000',
    refType: 'nzb-derived-digest',
    refValue: 'digest-only',
  });
  assertEq(result.status, 'unavailable', 'unavailable result');
  assertEq(transport.requests[0]!.operation, 'usenet-cache-check', 'usenet advisory operation');
});

await test('ADAPTER_MODE=torbox-readonly fails closed without injected transport', () => {
  try {
    loadAdapterConfig({ ADAPTER_MODE: 'torbox-readonly' } as Env);
    assert(false, 'expected ConfigError');
  } catch (err) {
    assert(err instanceof ConfigError, 'ConfigError');
    assert(/requires explicit injected transport/i.test((err as Error).message), 'explicit injected transport error');
  }
});

await test('unsupported or empty refs fail closed before transport request', async () => {
  const transport = new RecordingTransport('available');
  const adapter = new TorBoxProviderAdapter({ transport });
  const unsupported = await adapter.resolveRef({
    itemId: '00000000-0000-0000-0000-000000000000',
    refType: 'tmdb',
    refValue: '123',
  });
  const empty = await adapter.resolveRef({
    itemId: '00000000-0000-0000-0000-000000000000',
    refType: 'infohash',
    refValue: '',
  });

  assertEq(unsupported.status, 'unknown', 'unsupported unknown');
  assertEq(unsupported.detail, 'unsupported-ref-type', 'unsupported detail');
  assertEq(empty.status, 'unknown', 'empty unknown');
  assertEq(empty.detail, 'empty-ref-value', 'empty detail');
  assertEq(transport.requests.length, 0, 'no transport calls');
});

await test('public outputs and logs do not expose raw refs, tokens, URLs, or provider payloads', async () => {
  const transport = new RecordingTransport('available');
  const adapter = new TorBoxProviderAdapter({ transport });
  const logs: string[] = [];
  const secretRef = 'secret-infohash-value';
  const result = await adapter.resolveRef(
    { itemId: 'opaque-item-id', refType: 'infohash', refValue: secretRef },
    { log: (message) => logs.push(message) },
  );

  const publicText = JSON.stringify({ result, logs, describe: adapter.describe() });
  for (const forbidden of [
    secretRef,
    'Bearer',
    'api.torbox.app',
    'token',
    'playback',
    'request-download-link',
    'cdn-url',
  ]) {
    assert(!publicText.includes(forbidden), `public text excludes ${forbidden}`);
  }
});

await test('source has no live transport construction, env reads, credential reads, SDK, DB, or mutating operations', () => {
  const source = read('src/core/adapters/torbox-provider-adapter.ts');
  const factory = read('src/core/adapters/adapter-factory.ts');
  const combined = `${source}\n${factory}`;
  for (const forbidden of [
    '@torbox/torbox-api',
    'globalThis.fetch',
    'fetch(',
    'process.env.TORBOX',
    'readFileSync',
    'from "pg"',
    "from 'pg'",
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'createTorBoxLiveTransport',
    'request-download-link',
    'cdn-url',
  ]) {
    assert(!combined.includes(forbidden), `combined source excludes ${forbidden}`);
  }
});

await test('TorBox source allowlist includes provider adapter but no UI/playback/download implementation', () => {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
  const allowed = new Set([
    // Phase 250. NOT an implementation: this file names TorBox only inside a REDACTION pattern that
    // REFUSES a readiness packet mentioning a live provider. The allowlists predate it; excluding it would
    // mean the guard that forbids the word cannot itself contain the word.
    'src/ops/release-readiness.ts',
    'src/core/adapters/torbox-boundary.ts',
    'src/core/adapters/fake-torbox-adapter.ts',
    'src/core/adapters/torbox-real-client-gate.ts',
    'src/core/adapters/torbox-readonly-client.ts',
    'src/core/adapters/torbox-provider-adapter.ts',
    'src/core/adapters/adapter-factory.ts',
    'src/ops/torbox-smoke-shell.ts',
    'src/ops/torbox-smoke-cli.ts',
    'src/ops/torbox-transport-acceptance.ts',
    'src/ops/torbox-smoke-readiness-preflight.ts',
    'src/ops/torbox-smoke-readiness-preflight-cli.ts',
    'src/ops/torbox-live-smoke-labels.ts',
    'src/ops/torbox-live-transport.ts',
    'src/ops/torbox-live-smoke-runner.ts',
    'src/ops/torbox-live-smoke-evidence-preflight.ts',
    'src/ops/torbox-live-smoke-evidence-preflight-cli.ts',
    'src/ops/torbox-live-smoke-summary-pack.ts',
    'src/ops/torbox-live-smoke-summary-pack-cli.ts',
    'src/ops/torbox-live-smoke-review-gate.ts',
    'src/ops/torbox-live-smoke-review-gate-cli.ts',
    'src/ops/torbox-live-smoke-operator-packet.ts',
    'src/ops/torbox-live-smoke-operator-packet-cli.ts',
    'src/ops/torbox-live-smoke-packet-manifest.ts',
    'src/ops/torbox-live-smoke-packet-manifest-cli.ts',
    'src/ops/torbox-live-smoke-acceptance-record.ts',
    'src/ops/torbox-live-smoke-acceptance-record-cli.ts',
    'src/ops/torbox-live-smoke-plan.ts',
    'src/ops/torbox-live-smoke-plan-cli.ts',
    // PHASE 50 - THE READ-ONLY requestdl RESOLVER. Phase 41 future-gated the three
    // requestdl endpoints and said they require a later explicit phase;
    // docs/PHASE_50_TORBOX_RESOLVER.md is that phase and these are the files it
    // authorises. This list is what stops TorBox knowledge leaking into the rest of
    // the codebase by accident, so a file joins it deliberately or not at all.
    // The Phase 33 smoke client is UNTOUCHED: request-download-link remains
    // future-gated there and torbox-live-transport.ts stays cache-and-status only.
    'src/core/adapters/torbox-resolver.ts',
    'src/ops/torbox-resolver-service.ts',
    'src/ops/torbox-resolver-cli.ts',
    'src/ops/torbox-fixture-service.ts',
    'src/ops/torbox-fixture-cli.ts',
    'test/torbox-resolver.ts',
    // PROJECTION PHASE 9 - TORBOX PLUS USENET. docs/PROJECTION_PHASE_9_TORBOX_USENET.md is the phase that
    // authorises these eight. NONE of them contacts TorBox, implements a TorBox operation, holds a TorBox
    // credential or resolves a TorBox link. They name it because §4's sixth hard refusal is "let a Usenet
    // outage alter the TorBox namespace", and keeping that promise means comparing the TorBox half of the
    // namespace before and after every Usenet publish. A guard that may not name the thing it guards
    // cannot guard it, which is the same argument src/ops/release-readiness.ts is on this list for.
    'src/core/usenet/sab-contract.ts',
    'src/core/usenet/manifest-bridge.ts',
    // admission.ts and status-report.ts joined this list when the drift guard
    // moved INTO the publish path: `admit()` compares the namespace around every
    // publish and refuses `torbox-namespace-drifted`, and status-report.ts is where
    // that refusal is explained to an operator. Neither contacts TorBox, resolves a
    // link or holds a credential; both name it because the guard and its diagnostic
    // have to say what they are guarding.
    'src/core/usenet/admission.ts',
    'src/core/usenet/status-report.ts',
    'src/core/projection/phase9.ts',
    'src/ops/usenet-command.ts',
    'src/ops/usenet-rehearsal.ts',
    'src/ops/usenet-rehearsal-cli.ts',
    // PROJECTION PHASE 10 - THE OPERATOR CONTENT PLANE. docs/PROJECTION_PHASE_10_OPERATOR_CONTENT_PLANE.md
    // is the phase that authorises these four, and §2.1 is why they exist at all: the TorBox drift guard
    // `torBoxDrift` had TWO implementors of `namespaceSnapshot` -- the rehearsal's in-memory publisher and a
    // unit-test fake -- so on a real appliance `before` was always null, the comparison was always skipped,
    // and every real admission was recorded `admittedWithoutDriftCheck`. D10.1 is the repair.
    //
    // NONE OF THE FOUR CONTACTS TORBOX, implements a TorBox operation, holds a TorBox credential or resolves
    // a TorBox link. Phase 10 is PROVIDER-FREE BY CONSTRUCTION and its §4 third hard refusal says endpoint.json
    // is not read, written or touched at any point.
    //
    //   namespace-snapshot.ts  reads the live namespace so the guard has a `before` and an `after` to compare;
    //                          it names TorBox because a guard that may not name what it guards cannot guard it,
    //                          which is the same argument src/ops/release-readiness.ts is on this list for.
    //   phase10.ts             states the claim P10-3 measures, in the words the contract uses.
    //   projection-content.ts  ships the `add-torbox` verb: it REGISTERS an opaque object reference through the
    //   projection-content-cli.ts   existing `http-range` boundary and resolves nothing. Registering a reference is
    //                          not contacting a provider, which is exactly why Phase 10 can close without a window.
    'src/core/projection/namespace-snapshot.ts',
    'src/core/projection/phase10.ts',
    // PHASE 11 JOINS THE LIST, WITH ITS REASON, WHICH THIS COMMENT SAYS IS THE ONLY LEGITIMATE WAY TO
    // WIDEN ONE. It CONTACTS NOTHING, implements no TorBox operation, holds no credential and resolves
    // no link. Phase 11 asks whether the two SOURCE KINDS survive each other under one mount, so the
    // provider appears in exactly two places and both are unavoidable: MIN_TORBOX_ENTRIES, imported
    // from Phase 9 BY PHASE 9'S OWN NAME because renaming a threshold on import is the drift the
    // import discipline exists to prevent; and the tier-two operator-input list, which names what only
    // an operator possesses so that "NOT RUN" says what it is waiting for.
    'src/core/projection/phase11.ts',
    'src/ops/projection-content.ts',
    'src/ops/projection-content-cli.ts',
  ]);

  for (const path of walk(root)) {
    const rel = path.replace(/\\/g, '/').replace(fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/'), '');
    const source = readFileSync(path, 'utf8');
    if (/torbox/i.test(source)) assert(allowed.has(rel), `${rel} is explicitly allowed TorBox source`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
