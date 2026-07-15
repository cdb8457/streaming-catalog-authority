import { buildJellyfinTestLibraryPreflight } from '../src/ops/jellyfin-test-library-preflight.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

console.log('Running Phase 226 Jellyfin test library preflight suite:\n');

test('passes only when the isolated test library is mounted and configured', () => {
  const report = buildJellyfinTestLibraryPreflight({
    hostFolderExists: true,
    mountDestinations: ['/media/catalog-authority-test-library'],
    virtualFolders: [{ Name: 'Catalog Authority Test', Locations: ['/media/catalog-authority-test-library'] }],
    itemCount: 0,
  });
  assert(report.ok, 'preflight passes');
  assert(report.checks.every((check) => check.ok), 'all checks pass');
  assert(report.library.found, 'library found');
});

test('fails if host folder or container mount is missing', () => {
  const report = buildJellyfinTestLibraryPreflight({
    hostFolderExists: false,
    mountDestinations: ['/config'],
    virtualFolders: [{ Name: 'Catalog Authority Test', Locations: ['/media/catalog-authority-test-library'] }],
  });
  assert(!report.ok, 'preflight fails');
  assert(report.checks.some((check) => check.name === 'host-folder' && !check.ok), 'host folder check failed');
  assert(report.checks.some((check) => check.name === 'container-mount' && !check.ok), 'mount check failed');
});

test('fails if the named test library points at Gelato or another path', () => {
  const report = buildJellyfinTestLibraryPreflight({
    hostFolderExists: true,
    mountDestinations: ['/media/catalog-authority-test-library'],
    virtualFolders: [{ Name: 'Catalog Authority Test', Locations: ['/config/gelato/movies'] }],
  });
  assert(!report.ok, 'Gelato path fails');
  assert(report.checks.some((check) => check.name === 'not-gelato' && !check.ok), 'not-gelato guard failed');
});

test('fails if the isolated test library is already populated before the live proof', () => {
  const report = buildJellyfinTestLibraryPreflight({
    hostFolderExists: true,
    mountDestinations: ['/media/catalog-authority-test-library'],
    virtualFolders: [{ Name: 'Catalog Authority Test', Locations: ['/media/catalog-authority-test-library'] }],
    itemCount: 1,
  });
  assert(!report.ok, 'non-empty library fails');
  assert(report.checks.some((check) => check.name === 'empty-or-test-only' && !check.ok), 'empty/test-only guard failed');
});

test('evidence is redaction-safe and keeps write/provider scope forbidden', () => {
  const report = buildJellyfinTestLibraryPreflight({
    hostFolderExists: true,
    mountDestinations: ['/media/catalog-authority-test-library'],
    virtualFolders: [{ Name: 'Catalog Authority Test', Locations: ['/media/catalog-authority-test-library'] }],
  });
  const json = JSON.stringify(report);
  for (const required of ['jellyfin-write-api', 'provider-live-mode', 'downloading', 'scraping', 'playback', 'gelato-path']) {
    assert(json.includes(required), `forbidden list includes ${required}`);
  }
  for (const forbidden of ['JELLYFIN_API_KEY', 'password', 'token:', '/config/gelato/movies']) {
    assert(!json.includes(forbidden), `evidence excludes ${forbidden}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}

