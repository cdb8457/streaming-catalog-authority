import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
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

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)));
}

console.log('Running Phase 41 TorBox endpoint mapping suite:\n');

const pkg = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const doc = read('docs/PHASE_41_TORBOX_ENDPOINT_MAPPING.md');
const readme = read('README.md');

test('official TorBox source links and reviewed date are recorded', () => {
  for (const source of [
    'https://api.torbox.app/openapi.json',
    'https://api.torbox.app/docs',
    'TorBox-App/torbox-sdk-js',
    'TorrentsService.md',
    'WebDownloadsDebridService.md',
    'UsenetService.md',
    'GeneralService.md',
    'Reviewed on 2026-07-03',
  ]) assert(doc.includes(source), `Phase 41 doc records ${source}`);
});

test('read-only endpoint mapping is explicit and method constrained', () => {
  for (const mapping of [
    ['status-check', 'GeneralService.getUpStatus', '/', 'GET', 'none'],
    ['torrent-cache-check', 'TorrentsService.getTorrentCachedAvailability', '/v1/api/torrents/checkcached', 'GET', 'OAuth2PasswordBearer'],
    ['webdl-cache-check', 'WebDownloadsDebridService.getWebDownloadCachedAvailability', '/v1/api/webdl/checkcached', 'GET', 'OAuth2PasswordBearer'],
    ['usenet-cache-check', 'UsenetService.getUsenetCachedAvailability', '/v1/api/usenet/checkcached', 'GET', 'OAuth2PasswordBearer'],
    ['hoster-list', 'WebDownloadsDebridService.getHosterList', '/v1/api/webdl/hosters', 'GET', 'none for public hoster status'],
  ]) {
    for (const value of mapping) assert(doc.includes(value), `Phase 41 doc includes mapping value ${value}`);
  }
  assert(doc.includes('OpenAPI also exposes `POST` variants for the cache-check paths'), 'POST variants are acknowledged');
  assert(/Phase 41 allows `GET` only for the\s+first future live-smoke transport/.test(doc), 'first live smoke is GET-only');
});

test('authentication and redaction rules are fail-closed', () => {
  for (const kw of [
    'Authorization Bearer header',
    'secret indirection',
    'Query-string tokens are forbidden for cache checks',
    'never retain raw hashes',
    'raw links',
    'raw NZB material',
    'raw endpoint URLs',
    'raw provider response bodies',
    'provider payloads',
    'CDN URLs',
    'permalink URLs',
    'fixed categories, statuses, and counts',
  ]) assert(doc.includes(kw), `Phase 41 redaction/auth rule covers ${kw}`);
});

test('request-download and metadata lookup surfaces remain future-gated', () => {
  for (const gated of [
    '/v1/api/torrents/requestdl',
    '/v1/api/webdl/requestdl',
    '/v1/api/usenet/requestdl',
    'token query parameters',
    'CDN/permalink URLs',
    'create-download',
    'control',
    'delete',
    'user-list',
    'user-data',
    'export-provider-data',
    'downloading',
    'playback',
    '/v1/api/torrents/torrentinfo',
    'authenticated hoster-list user metrics',
  ]) assert(doc.includes(gated), `Phase 41 future-gates ${gated}`);
});

test('Phase 41 is docs/static only with no SDK, live calls, env reads, or provider mode', () => {
  assert(exists('docs/PHASE_41_TORBOX_ENDPOINT_MAPPING.md'), 'Phase 41 doc exists');
  assert(typeof pkg.scripts['test:torbox-endpoint-mapping'] === 'string', 'test script present');
  assert((pkg.scripts.test ?? '').includes('test/torbox-endpoint-mapping.ts'), 'suite is in npm test');
  assert(!(pkg.scripts.test ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm test');
  assert(!(pkg.scripts.ci ?? '').includes('smoke:torbox-readonly'), 'operator smoke command is not in npm ci');

  for (const kw of [
    'no live TorBox calls',
    'no real TorBox transport implementation',
    'no `@torbox/torbox-api` dependency or import',
    'no global fetch',
    'environment-variable reads',
    'no provider mode wiring',
    'does not prove TorBox works against a real account',
    'does not authorize live smoke',
    'O4 remains open/deferred',
    'O5 remains open/deferred',
    'FileCustodian` remains a hardened reference',
  ]) assert(`${doc}\n${readme}`.includes(kw), `Phase 41 docs preserve ${kw}`);

  const allDeps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert(!allDeps.includes('@torbox/torbox-api'), 'TorBox SDK is not installed');
  assert(!exists('src/ops/torbox-live-transport.ts'), 'no live TorBox transport source exists');
  assert(!exists('src/core/adapters/torbox-live-transport.ts'), 'no adapter live TorBox transport source exists');
  assert(!exists('src/core/adapters/torbox-endpoint-mapping.ts'), 'Phase 41 adds no runtime adapter mapping source');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
