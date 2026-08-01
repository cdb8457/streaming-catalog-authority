import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  PROJECTION_CONTRACT_EXPORT_PATH,
  renderProjectionContractExport,
} from '../src/ops/projection-contract-export.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const exists = (rel: string): boolean => existsSync(`${root}/${rel}`);

console.log('Running projectiond wiring suite:\n');

// ---------------------------------------------------------------------------------------------------------
// The cross-language contract
// ---------------------------------------------------------------------------------------------------------

test('the committed contract export is current', () => {
  assert(exists(PROJECTION_CONTRACT_EXPORT_PATH), 'the export exists');
  const onDisk = read(PROJECTION_CONTRACT_EXPORT_PATH).replace(/\r\n/g, '\n');
  assertEq(onDisk, renderProjectionContractExport(),
    'the export is stale; run npm run ops:projection-contract-export');
});

test('the export is derived, not authored: every value traces back to a frozen contract', () => {
  const source = read('src/ops/projection-contract-export.ts');
  // A literal number in the exporter would be a value that could be right here and wrong in the contract.
  const body = source.slice(source.indexOf('export function buildProjectionContractExport'));
  assert(!/[:=]\s*\d/.test(body.replace(/version:\s*PROJECTION_\w+/g, '')),
    'the exporter contains a literal number, so it can disagree with the contract it exports');
});

// ---------------------------------------------------------------------------------------------------------
// The Go module
// ---------------------------------------------------------------------------------------------------------

test('the Go module is present, pinned, and isolated from the TypeScript build', () => {
  for (const artifact of [
    'projectiond/go.mod',
    'projectiond/go.sum',
    'projectiond/cmd/projectiond/main.go',
    'projectiond/internal/manifest/manifest.go',
    'projectiond/internal/namespace/store.go',
    'projectiond/internal/source/http.go',
    'projectiond/internal/source/local.go',
    'projectiond/internal/source/resolver.go',
    'projectiond/internal/source/egress.go',
    'projectiond/internal/cache/cache.go',
    'projectiond/internal/readpath/readpath.go',
    'projectiond/internal/fusefs/fusefs.go',
    'projectiond/internal/fakeprovider/fakeprovider.go',
    'projectiond/internal/contract/contract.go',
    'projectiond/Dockerfile',
    'projectiond/build/Dockerfile.smoke',
    'docker-compose.projectiond.yml',
    'deploy/projectiond-gates.sh',
    'deploy/projectiond-fuse-smoke.sh',
    'deploy/projectiond-image-smoke.sh',
  ]) assert(exists(artifact), `projectiond artifact exists: ${artifact}`);

  const goMod = read('projectiond/go.mod');
  for (const pin of ['github.com/hanwen/go-fuse/v2 v2.10.1', 'golang.org/x/sys v', 'golang.org/x/text v']) {
    assert(goMod.includes(pin), `go.mod pins ${pin}`);
  }
  // The daemon is a separate module; nothing in it can be dragged into the TypeScript build.
  assert(read('tsconfig.json').includes('"src/**/*.ts"'), 'the TypeScript build is still scoped to src and test');
  assert(!read('tsconfig.json').includes('projectiond'), 'the TypeScript build does not reach into the Go module');
});

test('the Go gates are wired to a pinned toolchain image and do not touch the TypeScript suites', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  for (const script of ['go:fmt', 'go:build', 'go:vet', 'go:test', 'go:race', 'go:gates', 'go:fuse-smoke',
    'go:image-smoke', 'ops:projection-contract-export']) {
    assert(typeof pkg.scripts[script] === 'string', `package.json defines ${script}`);
  }
  // The aggregate TypeScript run must not have grown a Go dependency: a machine with no Docker still runs it.
  assert(!(AGGREGATE_SUITE_COMMAND ?? '').includes('docker'), 'the aggregate suite needs no Docker');
  assert(!(AGGREGATE_SUITE_COMMAND ?? '').includes('go '), 'the aggregate suite needs no Go toolchain');

  const compose = read('docker-compose.projectiond.yml');
  assert(compose.includes('golang:1.26.5-bookworm'), 'the toolchain image is pinned');
  // The race detector needs cgo; a race gate on a CGO_ENABLED=0 service would silently never run.
  const raceService = compose.slice(compose.indexOf('go-race:'), compose.indexOf('fuse-smoke:'));
  assert(raceService.includes('CGO_ENABLED: "1"'), 'the race gate enables cgo, without which it cannot run');
  assertEq(pkg.scripts['go:race'], 'docker compose -f docker-compose.projectiond.yml run --rm go-race',
    'go:race runs the cgo-enabled service');
  // ...while the shipped binary stays static.
  assert(read('projectiond/Dockerfile').includes('CGO_ENABLED=0'), 'the release build is static');
});

// ---------------------------------------------------------------------------------------------------------
// Properties of the daemon that this repository has decided are load-bearing
// ---------------------------------------------------------------------------------------------------------

test('the mount always starts its request loop: Wait-without-Serve cannot come back', () => {
  const fusefs = read('projectiond/internal/fusefs/fusefs.go');
  assert(fusefs.includes('server.Serve()'), 'the request loop is started');
  assert(fusefs.includes('server.WaitMount()'), 'the mount is awaited before it is handed back');
  // Mount returns a started mount rather than a raw server, so a caller cannot obtain one without the loop.
  assert(/func Mount\([^)]*\) \(\*Mounted, error\)/.test(fusefs), 'Mount hands back a started mount');
  const main = read('projectiond/cmd/projectiond/main.go');
  assert(!/\bserver\.Wait\(\)/.test(main), 'main does not wait on a server it never served');
  assert(main.includes('mount.Wait()'), 'main waits on the started mount');
});

test('end of file is not an error', () => {
  const fusefs = read('projectiond/internal/fusefs/fusefs.go');
  assert(fusefs.includes('errors.Is(err, io.EOF)'), 'io.EOF is recognised');
  assert(fusefs.includes('fuse.ReadResultData(buf[:0]), fuse.OK'), 'and answered as zero bytes with OK');
  assert(exists('projectiond/internal/fusefs/read_linux_test.go'), 'and there is a regression test for it');
  assert(read('projectiond/internal/fusefs/read_linux_test.go').includes('TestReadAtEOFReturnsZeroBytesAndOK'),
    'named so it is obvious what it protects');
});

test('a manifest locator is stable, and no daemon code invents a second manifest model', () => {
  const manifestGo = read('projectiond/internal/manifest/manifest.go');
  assert(!manifestGo.includes('expiresAt'), 'the Go locator carries no lifetime either');
  // The daemon validates against the SHARED fixture corpus rather than a private one.
  const test = read('projectiond/internal/manifest/manifest_test.go');
  assert(test.includes('projection-manifest-v1'), 'the Go suite reads the shared corpus');
  assert(test.includes('adversarial-index.json'), 'including the adversarial index the TypeScript suite uses');
});

test('the scheme switch and the address policy are separate authorities', () => {
  const egress = read('projectiond/internal/source/egress.go');
  assert(egress.includes('AllowLoopback: cfg.AllowPrivateAddresses'),
    'the address policy comes from its own switch');
  assert(!egress.includes('AllowLoopback: cfg.AllowInsecureHTTP'),
    'permitting plaintext must not permit loopback, private or link-local destinations');
});

test('the media-server URL policy is untouched by anything the data plane does', () => {
  assert(exists('src/core/adapters/jellyfin/url-policy.ts'), 'the control plane rule still exists');
  const runtime = read('src/core/projection/runtime-contract.ts');
  assert(runtime.includes('private-host-url-policy-unchanged'), 'the contract still states it');
  assert(runtime.includes('PROJECTIOND_MAY_CONTACT_MEDIA_SERVER: false'), 'the daemon contacts no media server');
  // And nothing in the daemon names a media server at all.
  const walk = (dir: string): string[] => readdirSync(`${root}/${dir}`, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(`${dir}/${entry.name}`)
      : entry.name.endsWith('.go') ? [`${dir}/${entry.name}`] : []));
  for (const file of walk('projectiond')) {
    const source = read(file);
    for (const forbidden of ['jellyfin', 'Jellyfin', 'plex', 'Plex', 'emby', 'Emby', 'torbox', 'TorBox']) {
      assert(!source.includes(forbidden),
        `${file} names ${forbidden}; the data plane is provider- and media-server-agnostic`);
    }
  }
});

test('the daemon holds no database and no second manifest store', () => {
  const walk = (dir: string): string[] => readdirSync(`${root}/${dir}`, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(`${dir}/${entry.name}`)
      : entry.name.endsWith('.go') ? [`${dir}/${entry.name}`] : []));
  for (const file of walk('projectiond')) {
    const source = read(file);
    for (const forbidden of ['database/sql', 'sqlite', 'SQLite', 'lib/pq', 'pgx']) {
      assert(!source.includes(forbidden), `${file} reaches for ${forbidden}; the data plane holds no database`);
    }
  }
});

test('README describes the slice as experimental rather than shipped', () => {
  const readme = read('README.md');
  assert(readme.includes('projectiond'), 'README names the daemon');
  assert(readme.includes('experimental'), 'README calls the slice experimental');
  // The honest limits have to be in the same breath as the capability.
  for (const limit of ['Plex', 'Jellyfin', 'Emby', 'Unraid']) {
    assert(readme.includes(limit), `README names ${limit} among what is not yet proved`);
  }
});

test('package, inventory and the aggregate run are wired', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:projectiond-wiring'], 'tsx test/projectiond-wiring.ts', 'test script');
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projectiond-wiring.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((s) => s.file === 'projectiond-wiring.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry?.group, 'offline', 'and needs no database');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
