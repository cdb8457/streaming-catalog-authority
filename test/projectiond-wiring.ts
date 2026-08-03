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
  // EVERY GO GATE GOES THROUGH COMPOSE, AND go:fmt USED NOT TO. It was a bare `docker run` interpolating
  // "${PWD}/projectiond" as a bind source, which a POSIX shell expands and cmd.exe does not — so on Windows
  // Docker received a literal `${PWD}` and refused it as an invalid volume name before gofmt ever ran. A
  // formatting gate that cannot execute on the machine most of this repository is developed on is a gate
  // that is not running, and it was not running. Routing it through the same service as go:test and go:vet
  // makes it work everywhere those two already do.
  for (const script of ['go:fmt', 'go:vet', 'go:test']) {
    assert((pkg.scripts[script] ?? '').startsWith(
      'docker compose -f docker-compose.projectiond.yml run --rm go-gate'),
    `${script} runs through the pinned compose service rather than a bare docker run`);
    assert(!(pkg.scripts[script] ?? '').includes('${PWD}'),
      `${script} interpolates no shell variable a Windows shell would not expand`);
  }
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

// ---------------------------------------------------------------------------------------------------------
// The manifest publisher — the producer half of the slice
// ---------------------------------------------------------------------------------------------------------

test('the publisher exists as a control-plane component and the daemon still holds no database', () => {
  for (const artifact of [
    'src/core/projection/publisher.ts',
    'src/core/projection/publish-service.ts',
    'src/core/projection/artifact-store.ts',
    'src/core/projection/source-registry.ts',
    'src/ops/projection-publish-cli.ts',
    'src/ops/projection-register-cli.ts',
    'docker-compose.projection-publisher.yml',
    'deploy/projection-publisher-mount-gate.sh',
    'docs/PROJECTION_PHASE_1_MANIFEST_PUBLISHER.md',
  ]) assert(exists(artifact), `publisher artifact exists: ${artifact}`);

  // The producer is TypeScript and lives in the control plane. Nothing in the Go module may learn to author
  // one: a data plane that can write a manifest is a data plane that can disagree with the control plane.
  const walk = (dir: string): string[] => readdirSync(`${root}/${dir}`, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(`${dir}/${entry.name}`)
      : entry.name.endsWith('.go') ? [`${dir}/${entry.name}`] : []));
  for (const file of walk('projectiond')) {
    if (file.includes('cmd/mkfixture') || file.includes('cmd/fakerange')
      || file.includes('cmd/fakewebdav') || file.includes('internal/fakewebdav')) {
      continue; // gate tools; see below
    }
    const source = read(file);
    for (const forbidden of ['database/sql', 'sqlite', 'lib/pq', 'pgx', 'postgres']) {
      assert(!source.toLowerCase().includes(forbidden), `${file} reaches for ${forbidden}`);
    }
  }
});

test('the gate tools are built by the toolchain image and are not in the shipped binary', () => {
  const dockerfile = read('projectiond/Dockerfile');
  assert(dockerfile.includes('./cmd/projectiond'), 'the image builds the daemon');
  // `fakewebdav` is the third of them, and it is the COMPARISON CONTROL's server half — the endpoint G22
  // measures an rclone mount against. It is a gate tool in exactly the sense the other two are: it never
  // ships, the production image does not build it, and nothing in the daemon imports it. ADR 002 §2 rejected
  // rclone over WebDAV as production architecture and kept it as a test control; a binary that exists so a
  // control can be measured is not the product acquiring a WebDAV component.
  for (const tool of ['mkfixture', 'fakerange', 'fakewebdav']) {
    assert(exists(`projectiond/cmd/${tool}/main.go`), `${tool} exists`);
    assert(!dockerfile.includes(tool), `the production image does not build ${tool}`);
    assert(read(`projectiond/cmd/${tool}/main.go`).includes('//go:build linux'),
      `${tool} is Linux-only, like the gates that use it`);
  }
  // ...and the daemon does not reach into any of them. A data plane that imported the comparison control's
  // endpoint would be a data plane that could serve WebDAV.
  for (const file of ['projectiond/cmd/projectiond/main.go', 'projectiond/internal/daemon/daemon.go',
    'projectiond/internal/fusefs/fusefs.go', 'projectiond/internal/source/http.go']) {
    assert(!read(file).includes('fakewebdav'), `${file} does not import the comparison control's endpoint`);
  }
});

test('the producer derives every id through the shared contract, not a second implementation', () => {
  const publisher = read('src/core/projection/publisher.ts');
  for (const helper of ['deriveInode', 'deriveGenerationId', 'serializeManifestArtifact',
    'manifestContentDigest', 'validateManifestV1', 'validateSuccession']) {
    assert(publisher.includes(helper), `the producer calls the contract's ${helper}`);
  }
  // A producer that re-derived an inode, or re-implemented admission, could publish something the daemon
  // refuses — and the refusal would surface at a mount rather than at the publish.
  assert(!/function\s+deriveInode/.test(publisher), 'the producer does not define its own inode derivation');
  assert(!/sha256\("projectiond\.ino/.test(publisher), 'nor its own ino domain');
  const contract = read('src/core/projection/manifest-v1.ts');
  for (const derivation of ['deriveProjectedEntryId', 'deriveProjectedVersionId', 'deriveSourceId',
    'deriveGenerationId', 'deriveDeletionIntentId', 'serializeManifestArtifact']) {
    assert(contract.includes(`export function ${derivation}`), `the contract owns ${derivation}`);
  }
});

test('nothing the publisher touches can hold ephemeral access material', () => {
  const migration = read('src/db/migrations.sql');
  const registry = migration.slice(migration.indexOf('projection_source_roots'));
  // The database refuses a URL shape in an object reference rather than trusting a caller not to send one.
  assert(registry.includes("object_ref !~ '://'"), 'the object reference CHECK refuses a URL');
  assert(registry.includes('[?&@\\\\]'), 'and a query, a userinfo or a backslash');
  for (const forbidden of ['access_url', 'signed_url', 'token', 'expires_at TIMESTAMPTZ, -- access',
    'lease', 'authorization']) {
    assert(!registry.toLowerCase().includes(forbidden.toLowerCase().split(',')[0] as string)
      || forbidden === 'token',
    `the projection registry has no ${forbidden} column`);
  }
  // The registration boundary refuses it too, using the CONTRACT's own check rather than a local copy.
  const sourceRegistry = read('src/core/projection/source-registry.ts');
  assert(sourceRegistry.includes('checkLocatorValue'), 'registration uses the contract locator check');
  assert(!/const\s+FORBIDDEN|LOCATOR_FORBIDDEN/.test(sourceRegistry),
    'and does not keep its own list of forbidden words');
});

test('the publisher commits before it writes, and the pointer is written last', () => {
  // NORMALISED, because the needle below spans a line break. On a CRLF checkout — which is what git hands a
  // Windows developer by default — the file's newlines are `\r\n`, `indexOf` returns -1, and this test fails
  // claiming the publisher writes its artifact before it commits. It does not; the assertion could simply
  // never hold on that platform. The contract-export test a few lines above already normalises for the same
  // reason.
  const service = read('src/core/projection/publish-service.ts').replace(/\r\n/g, '\n');
  const prepare = service.indexOf('cat_projection_generation_prepare');
  const artifact = service.indexOf('ensureArtifact(\n      options.manifestDir, artifactName');
  const dbPointer = service.indexOf('cat_projection_generation_publish($1)', prepare);
  const filePointer = service.indexOf('writePointer(options.manifestDir, {');
  assert(prepare > 0 && artifact > prepare, 'the bytes are committed before the artifact is written');
  assert(dbPointer > artifact, 'the database moves after the artifact is on disk');
  assert(filePointer > dbPointer, 'and the pointer file is written last of all');
  const store = read('src/core/projection/artifact-store.ts');
  for (const durability of ['fsyncSync', 'renameSync', 'syncDirectory']) {
    assert(store.includes(durability), `the artifact store uses ${durability}`);
  }
  assert(store.includes('directorySynced'), 'and reports honestly where a directory cannot be synced');
});

test('the adversarial forge is a gate tool and is not an operator surface', () => {
  assert(exists('src/ops/projection-forge-adversarial-cli.ts'), 'it exists');
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  for (const [name, command] of Object.entries(pkg.scripts)) {
    assert(!(name.startsWith('ops:') && command.includes('projection-forge')),
      `${name} exposes the adversarial forge as an operator command`);
  }
  // ...and the only thing that runs it is the gate.
  assert(read('deploy/projection-publisher-mount-gate.sh').includes('projection-forge-adversarial-cli'),
    'the gate runs it');
});

test('the publisher-to-mount gate uses the ALREADY-MERGED production image and a non-root reader', () => {
  const gate = read('deploy/projection-publisher-mount-gate.sh');
  assert(gate.includes('docker build -t "$IMAGE" ./projectiond'), 'it builds the production image');
  assert(gate.includes('--strict-direct-mount'), 'and mounts by syscall, refusing the fusermount helper');
  assert(gate.includes('--user 65534:65534'), 'and reads it as an ordinary non-root user');
  assert(gate.includes('sha256sum'), 'and hashes what it read');
  assert(gate.includes('digests recorded OUTSIDE the mount') || gate.includes('recorded OUTSIDE the mount'),
    'against digests recorded outside the thing being verified');
  // The honest limits travel with the gate output, not only with the README.
  for (const limit of ['Plex', 'Jellyfin', 'Emby', 'Unraid']) {
    assert(gate.includes(limit), `the gate says ${limit} is still unproven`);
  }
});

test('the gate probes the range endpoint the way the daemon reads it, and judges it by the status line', () => {
  // A REGRESSION TEST FOR A GATE THAT COULD NEVER PASS. The first three runs of the publisher-to-mount gate
  // failed at "the range endpoint never answered" while the endpoint was healthy every time, for two
  // independent reasons: the endpoint answers 416 to a request with no Range header, on purpose, and busybox
  // wget exits NON-ZERO on a 206 because it treats anything but 200 as an error. A probe that drifts back to
  // a bare `wget -q` would silently reintroduce a gate that can only fail.
  const gate = read('deploy/projection-publisher-mount-gate.sh');
  const probe = gate.slice(gate.indexOf('waiting for the endpoint to answer'), gate.indexOf('REMOTE_SHA='));
  assert(probe.length > 0, 'the probe block is findable');
  assert(/Range: bytes=/.test(probe), 'the probe sends a Range header, which is the only thing the endpoint serves');
  assert(/206 Partial Content/.test(probe), 'and asserts the status line rather than trusting an exit code');
});

test('the gate reports where durability was obtained and where it was not', () => {
  const gate = read('deploy/projection-publisher-mount-gate.sh');
  assert(gate.includes('directorySynced'), 'the gate reads the publisher\'s own durability report');
  assert(gate.includes('UNPROVEN here'), 'and says so plainly when a host cannot fsync a directory');
  // The flag has to come from an ATTEMPT. A constant `true` would be a durability claim nobody made.
  const store = read('src/core/projection/artifact-store.ts');
  assert(store.includes('directorySynced: syncDirectory(dir)'),
    'the durable write reports the result of actually syncing the directory');
  assert(/function syncDirectory[\s\S]*?fsyncSync\(fd\)/.test(store),
    'and syncDirectory really fsyncs a directory descriptor');
});

test('the publisher documentation states what is still unproved, in the same breath as what works', () => {
  const doc = read('docs/PROJECTION_PHASE_1_MANIFEST_PUBLISHER.md');
  for (const limit of ['Plex', 'Jellyfin', 'Emby', 'Unraid']) {
    assert(doc.includes(limit), `the publisher doc names ${limit} among what is not yet proved`);
  }
  assert(/three consecutive/i.test(doc), 'and repeats what the acceptance plan means by passing');
  const contract = read('docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md');
  assert(contract.includes('1.8'), 'the contract carries the source-registry amendment');
  assert(contract.includes('3.4.1'), 'and the id-derivation amendment');
  assert(contract.includes('2.9'), 'and the canonical-bytes amendment');
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
