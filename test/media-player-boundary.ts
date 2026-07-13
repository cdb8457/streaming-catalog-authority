import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isJellyfinNetworkEnabled,
  isJellyfinLivePublishAllowed,
  createRealJellyfinClient,
  createRealJellyfinOutboxTarget,
  JellyfinNetworkDisabledError,
  JellyfinLivePublishDisabledError,
} from '../src/core/adapters/jellyfin/real-factory.js';
import { JellyfinHttpClient, JellyfinPublishDisabledError } from '../src/core/adapters/jellyfin/http-client.js';
import type { Env } from '../src/config/env.js';
import type { FetchLike, HttpResponseLike } from '../src/core/adapters/jellyfin/transport.js';

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
const ok = (body: unknown): HttpResponseLike => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const fakeFetch: FetchLike = async () => ok({ Items: [] });

console.log('Running Phase 203 media-player boundary selection suite:\n');

await test('phase record selects Jellyfin and defers Plex/Emby', () => {
  const doc = read('docs/PHASE_203_MEDIA_PLAYER_BOUNDARY_SELECTION.md');
  for (const required of [
    'phase-203-media-player-boundary-selection',
    'JELLYFIN_SELECTED_FOR_BOUNDARY_CONTROLLED_TESTING',
    'Plex status: `DEFERRED`',
    'Emby status: `DEFERRED_LIKELY_FOLLOWS_JELLYFIN_PATTERNS`',
    'existing Jellyfin boundary work',
    'fake/local client coverage',
    'injected-transport HTTP scaffolding',
    'smoke-test concepts',
  ]) assert(doc.includes(required), `doc includes ${required}`);
});

await test('existing Jellyfin scaffolding inventory cites real files', () => {
  const doc = read('docs/PHASE_203_MEDIA_PLAYER_BOUNDARY_SELECTION.md');
  for (const required of [
    'docs/PHASE_8_PUBLISHER_BOUNDARY.md',
    'src/core/adapters/publisher.ts',
    'docs/PHASE_10_JELLYFIN_ADAPTER.md',
    'src/core/adapters/jellyfin/fake-client.ts',
    'src/core/adapters/jellyfin/config.ts',
    'docs/PHASE_11_JELLYFIN_HTTP.md',
    'src/core/adapters/jellyfin/http-client.ts',
    'src/core/adapters/jellyfin/mapping.ts',
    'docs/PHASE_13_JELLYFIN_VALIDATION.md',
    'src/ops/jellyfin-smoke-cli.ts',
    'src/core/adapters/jellyfin/outbox-target.ts',
    'docs/templates/JELLYFIN_VALIDATION_EVIDENCE.md',
  ]) assert(doc.includes(required), `inventory includes ${required}`);
});

await test('four-rung ladder defines read and write boundaries', () => {
  const doc = read('docs/PHASE_203_MEDIA_PLAYER_BOUNDARY_SELECTION.md');
  for (const required of [
    'Rung 1: Phase 204 Read-Only Smoke',
    'GET /System/Info',
    'GET /Items?Recursive=true&Fields=ProviderIds&IncludeItemTypes=Movie,Series&StartIndex=<n>&Limit=<n>',
    'Forbidden in Rung 1',
    'Rung 2: Phase 205 Read-Only Mapping',
    'redaction-safe evidence',
    'Rung 3: Phase 206 Optional Write-Capable Disposable Collection',
    'the collection is created by the test itself',
    'cleanup is verified by a post-delete lookup',
    'Rung 4: Phase 207 Operator Evidence Review And Integration Launch Decision',
  ]) assert(doc.includes(required), `ladder includes ${required}`);
});

await test('current Jellyfin config remains fail-closed for network and writes', async () => {
  assert(isJellyfinNetworkEnabled({} as Env) === false, 'network default off');
  assert(isJellyfinLivePublishAllowed({} as Env) === false, 'live publish default off');
  let networkErr: unknown;
  try { createRealJellyfinClient(fakeFetch, {} as Env); } catch (err) { networkErr = err; }
  assert(networkErr instanceof JellyfinNetworkDisabledError, 'real client requires network gate');
  let publishErr: unknown;
  try {
    createRealJellyfinOutboxTarget(fakeFetch, {
      JELLYFIN_ENABLE_NETWORK: 'true',
      JELLYFIN_BASE_URL: 'http://jellyfin.invalid',
      JELLYFIN_API_KEY: 'redacted-test-key',
    } as Env);
  } catch (err) { publishErr = err; }
  assert(publishErr instanceof JellyfinLivePublishDisabledError, 'outbox target requires live publish gate');

  const client = new JellyfinHttpClient({ baseUrl: 'http://jellyfin.invalid', apiKey: 'redacted-test-key', fetch: fakeFetch });
  let createErr: unknown;
  try { await client.createCollection('test', ['item']); } catch (err) { createErr = err; }
  assert(createErr instanceof JellyfinPublishDisabledError, 'bare create remains disabled');
});

await test('compose and release docs do not enable Jellyfin runtime by default', () => {
  const combined = [
    read('docker-compose.yml'),
    read('docker-compose.unraid.yml'),
    read('docker-compose.unraid.runtime.yml'),
    read('RELEASE.md'),
  ].join('\n');
  for (const forbidden of [
    'JELLYFIN_ENABLE_NETWORK=true',
    'JELLYFIN_ALLOW_LIVE_PUBLISH=true',
    'JELLYFIN_API_KEY=',
    'JELLYFIN_API_KEY_FILE:',
  ]) assert(!combined.includes(forbidden), `default config excludes ${forbidden}`);
});

await test('package and deploy guard pin Phase 203 verification', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const deploy = read('test/deploy.ts');
  assert(pkg.scripts['test:media-player-boundary'] === 'tsx test/media-player-boundary.ts', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/launch-candidate-dry-run.ts && tsx test/media-player-boundary.ts && tsx test/jellyfin-readonly-smoke.ts && tsx test/jellyfin-readonly-mapping.ts && tsx test/jellyfin-disposable-write.ts && tsx test/jellyfin-evidence-review-decision.ts && tsx test/jellyfin-live-evidence-preflight.ts && tsx test/unraid-operator-readiness-bundle.ts'), 'aggregate order present');
  assert(deploy.includes('Phase 203 media-player boundary selection'), 'deploy guard entry');
  assert(deploy.includes('JELLYFIN_SELECTED_FOR_BOUNDARY_CONTROLLED_TESTING'), 'deploy guard status');
});

await test('record is redaction-safe and artifact-only', () => {
  const doc = read('docs/PHASE_203_MEDIA_PLAYER_BOUNDARY_SELECTION.md');
  for (const required of [
    'artifact and test work only',
    'makes no live Jellyfin connection',
    'O4 remains `O4_CLOSED`',
    'O5 remains `O5_DEFERRED_ACCEPTED`',
  ]) assert(doc.includes(required), `boundary includes ${required}`);
  for (const forbidden of [
    'postgres://',
    'postgresql://',
    '-----BEGIN',
    'ssh-ed25519',
    'token:',
    'password:',
    'secret:',
    'kek:',
    'dek:',
    'wrappedHex',
    'dekBase64',
    '192.168.',
    'O5_CLOSED',
  ]) assert(!doc.includes(forbidden), `doc excludes ${forbidden}`);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
