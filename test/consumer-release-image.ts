import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asMap,
  parseMount,
  parseYaml,
  service,
  stringList,
  yamlStrings,
  type YamlMap,
  type YamlValue,
} from './helpers/compose-yaml.js';
import {
  NO_USABLE_BASH,
  SCRIPT_TIMEOUT_MS,
  SPAWN_DEFAULTS,
  describeRun,
  removeQuietly,
  runScript,
  usableBash,
  usablePowerShell,
  type Shell,
} from '../src/ops/usable-shell.js';
import {
  BUNDLE_CHECKSUM_FILENAME,
  BUNDLE_MANIFEST_FILENAME,
  BUNDLE_NAME,
  ConsumerReleaseBundleError,
  RELEASE_IMAGE_REF,
  RELEASE_IMAGE_REPOSITORY,
  RELEASE_IMAGE_TAG,
  buildConsumerReleaseBundle,
  formatImageRef,
  type BundleOptions,
  type BundleSources,
} from '../src/ops/consumer-release-bundle.js';

// Phase 245 — the consumer-ready image and release bundle.
//
// Everything here is about a person who has Docker and nothing else. The assertions are therefore about
// artifacts as they will be RECEIVED — a parsed Compose file, an assembled bundle, an executed setup script,
// a workflow's trigger conditions — rather than about the text this repository happens to store. The one
// thing that cannot be checked without a Docker daemon (does the built image actually serve the UI?) is
// deliberately left to CI rather than faked here; deploy/ci/runtime-image-smoke.sh is that test, and the
// workflow assertions below are how this suite proves it will run.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function assertThrows(fn: () => unknown, msg: string): void {
  try { fn(); } catch { return; }
  throw new Error(`${msg}: nothing was thrown`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const compose = (name: string): YamlMap => parseYaml(read(name));

console.log('Running Phase 245 consumer release image + bundle suite:\n');

// ---------------------------------------------------------------------------------------------------------
// The image the consumer stack runs
// ---------------------------------------------------------------------------------------------------------

/** `${NAME:-default}` — the shape an operator-overridable Compose value takes. */
function interpolation(value: string): { variable: string; fallback: string } {
  const match = /^\$\{([A-Z0-9_]+):-(.+)\}$/.exec(value);
  if (match === null) throw new Error(`not an overridable interpolation: ${value}`);
  return { variable: match[1]!, fallback: match[2]! };
}

test('the consumer stack runs a prebuilt, version-pinned image and builds nothing', () => {
  const app = service(compose('docker-compose.runtime.yml'), 'app');
  assertEq(app.build, undefined, 'the consumer path has no build section: a bundle has no source to build');
  assert(typeof app.image === 'string', 'the app service names an image');

  const { variable, fallback } = interpolation(app.image as string);
  assertEq(variable, 'CATALOG_AUTHORITY_IMAGE', 'the image is overridable by one documented variable');
  assertEq(fallback, RELEASE_IMAGE_REF, 'and defaults to the pinned release image');

  const [repository, tag] = [fallback.slice(0, fallback.lastIndexOf(':')), fallback.slice(fallback.lastIndexOf(':') + 1)];
  assertEq(repository, RELEASE_IMAGE_REPOSITORY, 'published under the established ghcr convention');
  assert(tag !== 'latest', 'NEVER latest: `up -d` cannot silently move you to another build');
  assert(/^v\d+\.\d+\.\d+$/.test(tag), `the default is an immutable version tag, got ${tag}`);
  assertEq(app.init, true, 'PID 1 reaps orphans');
});

test('the release image convention matches the one the project already documented', () => {
  const release = read('RELEASE.md');
  assert(release.includes(RELEASE_IMAGE_REPOSITORY), 'RELEASE.md names the same registry repository');
  const doc = read('docs/PHASE_245_CONSUMER_RELEASE_IMAGE.md');
  assert(doc.includes(RELEASE_IMAGE_REF), 'the phase doc names the exact pinned reference');
});

test('an operator can override the image, and the documented override is a digest pin', () => {
  const doc = read('docs/PHASE_245_CONSUMER_RELEASE_IMAGE.md');
  assert(doc.includes('CATALOG_AUTHORITY_IMAGE'), 'the doc names the override variable');
  assert(/@sha256:/.test(doc), 'and shows the digest form, which is the stronger pin');
  assert(read('docker-compose.runtime.yml').includes('@sha256:'), 'the Compose file itself shows how to pin by digest');
});

test('maintainers get a documented local-build override that cannot be mistaken for a release', () => {
  const override = compose('docker-compose.runtime.build.yml');
  const app = service(override, 'app');
  const build = asMap(app.build ?? null, 'build');
  assertEq(build.dockerfile, 'Dockerfile.runtime', 'it builds the production Dockerfile, not the test one');
  assertEq(build.context, '.', 'from this checkout');
  assertEq(app.pull_policy, 'build', 'and never pulls a registry copy of a local tag');

  const { variable, fallback } = interpolation(app.image as string);
  assertEq(variable, 'CATALOG_AUTHORITY_DEV_IMAGE', 'the dev tag has its own variable');
  assert(!fallback.includes('/'), `a local tag with no registry host, got ${fallback}`);
  assert(!fallback.endsWith(':latest'), 'and still not latest');

  // The override exists to add a build, not to quietly relax the stack it overrides.
  assertEq(Object.keys(app).sort().join(','), 'build,image,pull_policy', 'the override changes nothing else');
  assertEq(Object.keys(asMap(override.services ?? null, 'services')).join(','), 'app', 'and touches only the app service');

  for (const file of ['docs/PHASE_245_CONSUMER_RELEASE_IMAGE.md', 'docker-compose.runtime.yml']) {
    assert(read(file).includes('-f docker-compose.runtime.yml -f docker-compose.runtime.build.yml'),
      `${file} documents the two-file build command`);
  }
});

test('the CI harness and Unraid stacks keep the Dockerfile they always had', () => {
  const testHarness = read('Dockerfile');
  assert(testHarness.includes('npm ci'), 'the root Dockerfile still installs the full toolchain');
  assert(/CMD \["npm", "run", "ci"\]/.test(testHarness), 'and still runs the suite');
  assertEq(stringList(service(compose('docker-compose.yml'), 'app').command ?? null, 'CI command').join(' '),
    'npm run ci', 'docker-compose.yml is still the CI harness');
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['image:build:local'], 'docker build -t repo-ops:latest .', 'the existing local image build is untouched');
  assert(!read('docker-compose.unraid.runtime.yml').includes('Dockerfile.runtime'), 'the Unraid stack is not repointed by this phase');
});

// ---------------------------------------------------------------------------------------------------------
// The production image itself
// ---------------------------------------------------------------------------------------------------------

interface DockerfileInstruction { readonly keyword: string; readonly rest: string }

/** Join continuations, drop comments — a Dockerfile as the builder reads it, not as it is typed. */
function parseDockerfile(text: string): DockerfileInstruction[] {
  const logical: string[] = [];
  let current = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (current === '' && (line.trim() === '' || line.trimStart().startsWith('#'))) continue;
    if (line.endsWith('\\')) { current += `${line.slice(0, -1).trim()} `; continue; }
    logical.push(`${current}${line.trim()}`);
    current = '';
  }
  if (current !== '') logical.push(current.trim());
  return logical.map((line) => {
    const space = line.indexOf(' ');
    return space < 0 ? { keyword: line.toUpperCase(), rest: '' } : { keyword: line.slice(0, space).toUpperCase(), rest: line.slice(space + 1).trim() };
  });
}

test('the production image is multi-stage, pinned by digest, and ships no toolchain', () => {
  const dockerfile = read('Dockerfile.runtime');
  const instructions = parseDockerfile(dockerfile);
  const froms = instructions.filter((i) => i.keyword === 'FROM');
  assert(froms.length >= 2, `multi-stage, got ${froms.length} FROM`);
  assert(froms.every((from) => from.rest.startsWith('${NODE_IMAGE}')), 'every stage uses the same pinned base');

  const baseArg = instructions.find((i) => i.keyword === 'ARG' && i.rest.startsWith('NODE_IMAGE='));
  assert(baseArg !== undefined, 'the base image is a single declared ARG');
  const base = baseArg!.rest.slice('NODE_IMAGE='.length);
  assert(/@sha256:[0-9a-f]{64}$/.test(base), `the base image is pinned by digest, got ${base}`);
  assert(base.startsWith('node:'), 'and names the tag it corresponds to, for a human reading it');

  const runs = instructions.filter((i) => i.keyword === 'RUN').map((i) => i.rest);
  assert(runs.some((run) => run.includes('npm ci --omit=dev')), 'production dependencies only, from the lockfile');
  assert(runs.some((run) => run.includes('--ignore-scripts')), 'no package install hooks run while building a shipped image');
  assert(!runs.some((run) => /npm (install|i) /.test(run)), 'nothing is installed outside the lockfile');

  const copies = instructions.filter((i) => i.keyword === 'COPY').map((i) => i.rest);
  assert(!copies.some((copy) => /^\.\s/.test(copy)), 'the whole build context is never copied in');
  assert(copies.some((copy) => copy.startsWith('src ')), 'the application source is copied explicitly');
  assert(!copies.some((copy) => copy.includes('secrets')), 'no secrets are ever copied into the image');
});

test('the production image runs as a non-root user that cannot rewrite its own code', () => {
  const instructions = parseDockerfile(read('Dockerfile.runtime'));
  const userIndex = instructions.findIndex((i) => i.keyword === 'USER');
  assert(userIndex >= 0, 'the image sets a USER');
  assertEq(instructions[userIndex]!.rest, 'node', 'the unprivileged user the base image already provides');
  assert(!instructions.slice(userIndex + 1).some((i) => i.keyword === 'USER' && i.rest.startsWith('root')),
    'and never switches back to root');
  assert(!instructions.slice(userIndex + 1).some((i) => i.keyword === 'COPY' && i.rest.includes('--chown=node')),
    'the app does not own its own source tree');
  const entrypointIndex = instructions.findIndex((i) => i.keyword === 'ENTRYPOINT');
  assert(entrypointIndex > userIndex, 'the drop to non-root happens before the entrypoint');
});

test('the production image handles signals, exposes 8099 and keeps the existing health contract', () => {
  const instructions = parseDockerfile(read('Dockerfile.runtime'));
  const entrypoint = instructions.find((i) => i.keyword === 'ENTRYPOINT');
  assert(entrypoint !== undefined, 'there is an entrypoint');
  const argv = JSON.parse(entrypoint!.rest) as string[];
  assertEq(argv[0], 'node', 'node is PID 1 — not npm, not a shell, so SIGTERM reaches the process that handles it');
  assert(argv.includes('--import') && argv.includes('tsx'), 'TypeScript is executed through tsx, as everywhere else');
  assert(argv.some((arg) => arg.endsWith('operator-ui-service-cli.ts')), 'the entrypoint IS the operator UI service');

  // The CLI it points at is the one that installs the shutdown handlers; without them a graceful stop is a
  // 10-second wait followed by a kill.
  const cli = read('src/ops/operator-ui-service-cli.ts');
  assert(cli.includes("process.once('SIGTERM'"), 'the entrypoint CLI closes the server on SIGTERM');

  const cmd = JSON.parse(instructions.find((i) => i.keyword === 'CMD')!.rest) as string[];
  assert(cmd.includes('--serve') && cmd.includes('8099') && cmd.includes('0.0.0.0'), 'the default command serves on 8099');
  assert(instructions.some((i) => i.keyword === 'EXPOSE' && i.rest === '8099'), 'the port is declared');

  const healthcheck = instructions.find((i) => i.keyword === 'HEALTHCHECK');
  assert(healthcheck !== undefined, 'the image carries its own healthcheck for `docker run` users');
  assert(healthcheck!.rest.includes('/healthz'), 'against the same unauthenticated route Compose probes');
  const composeHealth = asMap(service(compose('docker-compose.runtime.yml'), 'app').healthcheck ?? null, 'healthcheck');
  assert(stringList(composeHealth.test ?? null, 'compose healthcheck').some((part) => part.includes('/healthz')),
    'and Compose still probes the same one, so the two cannot drift apart');
});

test('the production image can be built without dev dependencies at all', () => {
  const pkg = JSON.parse(read('package.json')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  // `npm ci --omit=dev` is only minimal if what the app needs to RUN is declared as a runtime dependency.
  // tsx executes every entrypoint this project ships, so it is one.
  assert(pkg.dependencies.tsx !== undefined, 'tsx is a runtime dependency: the image executes TypeScript');
  assert(pkg.dependencies.pg !== undefined, 'pg is a runtime dependency');
  assert(pkg.devDependencies.typescript !== undefined, 'the compiler stays a dev dependency');
  assert(pkg.devDependencies['embedded-postgres'] !== undefined, 'the test PostgreSQL stays a dev dependency');
  assert(pkg.devDependencies.tsx === undefined, 'and tsx is not declared twice');

  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { dev?: boolean }> };
  assertEq(lock.packages['']?.dev, undefined, 'the lockfile root is intact');
  assertEq(lock.packages['node_modules/tsx']?.dev, undefined, 'the lockfile agrees tsx is not dev-only');
  assertEq(lock.packages['node_modules/embedded-postgres']?.dev, true, 'and that the test PostgreSQL is');
});

// ---------------------------------------------------------------------------------------------------------
// The release bundle
// ---------------------------------------------------------------------------------------------------------

const sources: BundleSources = {
  runtimeCompose: read('docker-compose.runtime.yml'),
  setupBash: read('deploy/local-runtime-setup.sh'),
  setupPowerShell: read('deploy/local-runtime-setup.ps1'),
};
const options: BundleOptions = {
  image: { repository: RELEASE_IMAGE_REPOSITORY, tag: RELEASE_IMAGE_TAG },
  revision: '636f67f8bd09df907143cc00d0b58ef517b940e3',
  createdAt: '2026-07-22T00:00:00.000Z',
};
const sha256 = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

test('the bundle contains what an ordinary user needs, and nothing that implies a checkout', () => {
  const bundle = buildConsumerReleaseBundle(sources, options);
  assertEq(bundle.files.map((file) => file.path).join(','),
    ['README.md', 'docker-compose.yml', 'setup.sh', 'setup.ps1', '.env', '.env.example', 'VERSION',
      BUNDLE_MANIFEST_FILENAME, BUNDLE_CHECKSUM_FILENAME].join(','),
    'the bundle is exactly these files');

  for (const forbidden of ['package.json', 'package-lock.json', 'tsconfig.json', 'Dockerfile', 'Dockerfile.runtime']) {
    assert(!bundle.files.some((file) => file.path === forbidden), `the bundle does not ship ${forbidden}`);
  }
  assert(!bundle.files.some((file) => file.path.endsWith('.ts')), 'and ships no TypeScript');
  assert(!bundle.files.some((file) => /(^|\/)(src|node_modules)\//.test(file.path)), 'and no source tree');

  const composeFile = bundle.files.find((file) => file.path === 'docker-compose.yml')!;
  const stack = parseYaml(composeFile.contents);
  assertEq(service(stack, 'app').build, undefined, 'the shipped stack builds nothing');
  assert(String(service(stack, 'app').image).includes('CATALOG_AUTHORITY_IMAGE'), 'and reads the pin');
  assertEq(composeFile.contents.replace(/\r\n/g, '\n'), read('docker-compose.runtime.yml').replace(/\r\n/g, '\n'),
    'the shipped stack IS the tested stack, not a retyped copy');
});

test('every bundle file is LF-terminated even when assembled from a CRLF checkout', () => {
  const crlf = (text: string): string => text.replace(/\r?\n/g, '\r\n');
  const bundle = buildConsumerReleaseBundle({
    runtimeCompose: crlf(sources.runtimeCompose),
    setupBash: crlf(sources.setupBash),
    setupPowerShell: crlf(sources.setupPowerShell),
  }, options);
  for (const file of bundle.files) {
    assert(!file.contents.includes('\r'), `${file.path} carries no carriage return — a CRLF .sh is not a script`);
    assert(file.contents.endsWith('\n'), `${file.path} ends with a newline`);
  }
  // Same bytes as the LF build: the checkout a maintainer happens to have cannot change what ships.
  const fromLf = buildConsumerReleaseBundle(sources, options);
  assertEq(bundle.files.map((f) => f.sha256).join(','), fromLf.files.map((f) => f.sha256).join(','),
    'a Windows checkout and a Linux checkout assemble byte-identical bundles');
});

test('the bundle is verifiable: checksums cover it, the manifest describes it, both agree', () => {
  const bundle = buildConsumerReleaseBundle(sources, options);
  for (const file of bundle.files) {
    assertEq(file.sha256, sha256(file.contents), `${file.path} records its own digest`);
    assertEq(file.bytes, Buffer.byteLength(file.contents, 'utf8'), `${file.path} records its own size`);
  }

  const checksums = bundle.files.find((file) => file.path === BUNDLE_CHECKSUM_FILENAME)!;
  const listed = checksums.contents.trimEnd().split('\n').map((line) => {
    const [digest, path] = line.split('  ');
    return { digest: digest!, path: path! };
  });
  assertEq(listed.map((entry) => entry.path).join(','),
    bundle.files.filter((file) => file.path !== BUNDLE_CHECKSUM_FILENAME).map((file) => file.path).join(','),
    'SHA256SUMS covers every file except itself');
  for (const entry of listed) {
    assertEq(entry.digest, bundle.files.find((file) => file.path === entry.path)!.sha256, `${entry.path} digest matches`);
    assert(/^[0-9a-f]{64}$/.test(entry.digest), `${entry.path} digest is a sha256`);
  }

  const manifest = JSON.parse(bundle.files.find((file) => file.path === BUNDLE_MANIFEST_FILENAME)!.contents) as {
    bundle: string; version: string; sourceRevision: string; createdAt: string; requires: string[];
    image: { repository: string; tag: string; digest: string | null; ref: string };
    files: Array<{ path: string; sha256: string; bytes: number }>;
  };
  assertEq(manifest.bundle, BUNDLE_NAME, 'the manifest names the bundle');
  assertEq(manifest.version, RELEASE_IMAGE_TAG, 'and its version');
  assertEq(manifest.image.ref, RELEASE_IMAGE_REF, 'and the exact image it was built for');
  assertEq(manifest.sourceRevision, options.revision, 'and the source it came from');
  assertEq(manifest.requires.join(','), 'docker', 'and states that Docker is the only requirement');
  assertEq(manifest.files.map((file) => file.path).join(','),
    bundle.files.filter((file) => file.path !== BUNDLE_MANIFEST_FILENAME && file.path !== BUNDLE_CHECKSUM_FILENAME)
      .map((file) => file.path).join(','),
    'the manifest describes the content files');
  for (const entry of manifest.files) {
    assertEq(entry.sha256, bundle.files.find((file) => file.path === entry.path)!.sha256, `manifest digest for ${entry.path}`);
  }
});

test('a bundle is reproducible, and a digest pin reaches the file Compose actually reads', () => {
  const first = buildConsumerReleaseBundle(sources, options);
  const second = buildConsumerReleaseBundle(sources, options);
  assertEq(first.files.map((file) => file.sha256).join(','), second.files.map((file) => file.sha256).join(','),
    'same inputs, same bytes — no clock, no filesystem, no randomness');

  const digest = `sha256:${'a1b2c3d4'.repeat(8)}`;
  const pinned = buildConsumerReleaseBundle(sources, { ...options, image: { ...options.image, digest } });
  assertEq(pinned.imageRef, `${RELEASE_IMAGE_REPOSITORY}@${digest}`, 'a digest pin replaces the tag reference');
  const env = pinned.files.find((file) => file.path === '.env')!.contents;
  assert(env.includes(`CATALOG_AUTHORITY_IMAGE=${RELEASE_IMAGE_REPOSITORY}@${digest}`), '.env carries the digest pin');
  assert(!env.includes(':latest'), 'and never a floating tag');
  const manifest = JSON.parse(pinned.files.find((file) => file.path === BUNDLE_MANIFEST_FILENAME)!.contents) as {
    image: { digest: string | null };
  };
  assertEq(manifest.image.digest, digest, 'and the manifest records it');
  assert(pinned.files.find((file) => file.path === 'VERSION')!.contents.includes(digest), 'as does VERSION');
});

test('the bundle refuses to be assembled around a floating tag, a bad pin, or a secret', () => {
  assertThrows(() => buildConsumerReleaseBundle(sources, { ...options, image: { ...options.image, tag: 'latest' } }),
    '`latest` is refused');
  assertThrows(() => buildConsumerReleaseBundle(sources, { ...options, image: { ...options.image, tag: 'main' } }),
    'a branch name is refused');
  assertThrows(() => buildConsumerReleaseBundle(sources, { ...options, image: { ...options.image, digest: 'sha256:nope' } }),
    'a malformed digest is refused');
  assertThrows(() => buildConsumerReleaseBundle(sources, { ...options, revision: 'not-a-sha' }), 'a bogus revision is refused');

  // The failure that matters is a maintainer's own ./secrets being swept in by a careless change.
  const leaked = `${sources.setupBash}\n# operator token: ${Buffer.alloc(32, 7).toString('base64')}\n`;
  assertThrows(() => buildConsumerReleaseBundle({ ...sources, setupBash: leaked }, options),
    'a base64 32-byte secret is refused');
  const leakedUrl = `${sources.setupBash}\npostgresql://postgres:hunter2hunter2@postgres:5432/catalog\n`;
  assertThrows(() => buildConsumerReleaseBundle({ ...sources, setupBash: leakedUrl }, options),
    'a database URL with a real password is refused');

  // A Compose file that builds from source would leave a bundle user with an error and no way forward.
  const building = sources.runtimeCompose.replace(/(\n\s+)image: \$\{CATALOG_AUTHORITY_IMAGE[^\n]*/, '$1build: .');
  assertThrows(() => buildConsumerReleaseBundle({ ...sources, runtimeCompose: building }, options),
    'a Compose file that builds from source is refused');
});

test('the bundle carries no secrets and no secret VALUES, only the mechanism that generates them', () => {
  const bundle = buildConsumerReleaseBundle(sources, options);
  for (const file of bundle.files) {
    assert(!/\b[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/.test(file.contents), `${file.path} has no base64 32-byte secret`);
    assert(!/-----BEGIN/.test(file.contents), `${file.path} has no key material`);
  }
  const env = bundle.files.find((file) => file.path === '.env.example')!.contents;
  assert(/NO SECRETS BELONG IN THIS FILE/i.test(env), '.env.example says so out loud');
  assert(!/^(?!#).*(PASSWORD|TOKEN|SECRET|KEK)=/m.test(env), 'and sets no secret-shaped variable');
  assert(bundle.files.some((file) => file.path === 'setup.sh') && bundle.files.some((file) => file.path === 'setup.ps1'),
    'the generation mechanism ships instead: one setup script per platform');
});

test('the shipped setup scripts are the tested setup scripts', () => {
  const bundle = buildConsumerReleaseBundle(sources, options);
  const normalise = (text: string): string => text.replace(/\r\n/g, '\n');
  assertEq(bundle.files.find((file) => file.path === 'setup.sh')!.contents, normalise(sources.setupBash),
    'setup.sh is deploy/local-runtime-setup.sh, byte for byte');
  assertEq(bundle.files.find((file) => file.path === 'setup.ps1')!.contents, normalise(sources.setupPowerShell),
    'setup.ps1 is deploy/local-runtime-setup.ps1, byte for byte');
});

test('the bundle documents where the token lives, how to upgrade, and how to roll back', () => {
  const readme = buildConsumerReleaseBundle(sources, options).files.find((file) => file.path === 'README.md')!.contents;
  assert(/## Upgrading/.test(readme), 'there is an upgrade section');
  assert(/## Rolling back/.test(readme), 'and a rollback section');
  assert(readme.includes('secrets/operator_ui_token'), 'the token file is named');
  assert(/never an\s+environment variable/i.test(readme), 'and what it is not is stated');
  assert(readme.includes('CATALOG_AUTHORITY_IMAGE'), 'upgrading is an image pin change');
  assert(/docker compose down/.test(readme) && /docker compose up -d/.test(readme), 'with the exact commands');
  assert(/does not roll data back/i.test(readme), 'and the honest limit of an image rollback is stated');
  assert(readme.includes(`sha256sum -c ${BUNDLE_CHECKSUM_FILENAME}`), 'verification is a one-liner');
  assert(/Get-FileHash/.test(readme), 'including on Windows');
  assert(/Docker Desktop on Windows or macOS; Docker Engine on Linux/.test(readme), 'all three platforms are named');
  // The invariant is that nothing asks the USER to install a toolchain. A `docker compose exec app ...` line
  // runs inside the image, which already contains Node, so it is exempt — but only in that exact form, and
  // the Phase 246 suite pins the support-report command to it so this exemption cannot be widened by
  // accident. Everything outside such a line is still held to "Docker and nothing else".
  const onTheHost = readme.replace(/docker compose exec [^\n]*/g, '');
  assert(!/npm |node |git clone/.test(onTheHost), 'and nothing in the install path needs a toolchain');
});

// ---------------------------------------------------------------------------------------------------------
// The bundle, actually assembled and actually run
// ---------------------------------------------------------------------------------------------------------

// Which interpreter can actually run a script here is decided once, in src/ops/usable-shell.ts — the same
// module the shipped `release:bundle-check` step resolves its bash with. This file used to answer it again,
// and its copy looked only under %ProgramFiles%, so a machine with Git installed under %ProgramW6432% had no
// bash as far as this suite was concerned.
//
// A missing bash is a failure, not a skip: every shell step this project ships is bash, so a host that has
// none cannot run the release either, and quietly passing would hide precisely that. PowerShell is different
// — a Linux CI runner genuinely has none — so that one skips and says so.
const powershell = usablePowerShell();

function bashOrFail(): Shell {
  const shell = usableBash();
  if (shell === null) throw new Error(NO_USABLE_BASH);
  return shell;
}

/** Assemble a real bundle on disk with the shipping CLI, exactly as CI does. */
function assembleBundle(): string {
  const out = join(mkdtempSync(join(tmpdir(), 'phase245-bundle-')), 'bundle');
  const run = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/ops/consumer-release-bundle-cli.ts'),
    '--out', out, '--revision', options.revision, '--created', options.createdAt], { cwd: root, encoding: 'utf8', timeout: 300000 });
  assertEq(run.status, 0, `the bundle CLI succeeds: ${run.stderr ?? ''}`);
  return out;
}

test('the shipping CLI writes the bundle the builder describes, with no CR bytes on disk', () => {
  const out = assembleBundle();
  try {
    const expected = buildConsumerReleaseBundle(sources, options);
    assertEq(readdirSync(out).sort().join(','), expected.files.map((file) => file.path).sort().join(','),
      'the written file set is the described file set');
    for (const file of expected.files) {
      const raw = readFileSync(join(out, file.path));
      assertEq(createHash('sha256').update(raw).digest('hex'), file.sha256, `${file.path} was written verbatim`);
      assert(!raw.includes(0x0d), `${file.path} has no CR byte on disk`);
    }
    // Checksums are the user's tool, so verify them the way the user would.
    const shell = bashOrFail();
    const verified = spawnSync(shell.command, ['-c', 'sha256sum -c SHA256SUMS'],
      { ...SPAWN_DEFAULTS, cwd: out, timeout: SCRIPT_TIMEOUT_MS });
    assertEq(verified.status, 0, `sha256sum -c verifies the bundle — ${describeRun(verified)}`);
  } finally { removeQuietly(join(out, '..')); }
});

for (const [label, script, resolve] of [
  ['Bash', 'setup.sh', bashOrFail],
  ['PowerShell', 'setup.ps1', () => powershell],
] as const) {
  test(`${label} setup runs inside the extracted bundle, where there is no deploy/ directory`, () => {
    const shell = resolve();
    if (shell === null) { console.log(`        (skipped: no interpreter on this host can run ${script})`); return; }
    const out = assembleBundle();
    try {
      const run = runScript(shell, join(out, script), { cwd: out });
      assertEq(run.status, 0, `${script} exits cleanly — ${describeRun(run)}`);
      const stdout = run.stdout ?? '';

      for (const name of ['postgres_password', 'admin_database_url', 'database_url', 'completion_secret',
        'custodian_kek', 'operator_ui_token']) {
        assert(existsSync(join(out, 'secrets', name)), `${label}: ${name} is generated at the bundle root`);
      }
      assert(existsSync(join(out, 'promotion-records')), `${label}: the artifact folder is created`);

      // A bundle user has one Compose file, so the instructions must not tell them to name another.
      assert(/docker compose up -d/.test(stdout), `${label}: the printed start command fits the bundle layout`);
      assert(!stdout.includes('-f docker-compose.runtime.yml'), `${label}: and does not name a file that is not there`);
      const token = readFileSync(join(out, 'secrets', 'operator_ui_token'), 'utf8').trim();
      assert(stdout.includes(token), `${label}: the operator token is printed`);

      // Idempotency, in the layout a user actually has: a re-run must not lock them out.
      writeFileSync(join(out, 'secrets', 'operator_ui_token'), 'kept-token\n');
      const again = runScript(shell, join(out, script), { cwd: out });
      assertEq(again.status, 0, `${script} re-runs cleanly — ${describeRun(again)}`);
      assertEq(readFileSync(join(out, 'secrets', 'operator_ui_token'), 'utf8'), 'kept-token\n', `${label}: the token survives a re-run`);
      assert((again.stdout ?? '').includes('operator_ui_token (already exists)'), `${label}: and the re-run says so`);
    } finally { removeQuietly(join(out, '..')); }
  });
}

// ---------------------------------------------------------------------------------------------------------
// CI: the daemon-backed checks this suite cannot make, and the gate on publishing
// ---------------------------------------------------------------------------------------------------------

const workflow = parseYaml(read('.github/workflows/runtime-image.yml'));
const jobs = asMap(workflow.jobs ?? null, 'jobs');
const job = (name: string): YamlMap => asMap(jobs[name] ?? null, `job ${name}`);
const steps = (name: string): YamlMap[] => (job(name).steps as YamlValue[]).map((step) => asMap(step, 'step'));
const jobText = (name: string): string => yamlStrings(job(name)).join('\n');

test('CI runs the daemon-backed checks this suite deliberately does not fake', () => {
  const smoke = jobText('image');
  assert(smoke.includes('deploy/ci/runtime-image-smoke.sh'), 'the image job runs the smoke script');
  assertEq(job('image')['runs-on'], 'ubuntu-latest', 'on Linux, where a Docker daemon exists');

  const script = read('deploy/ci/runtime-image-smoke.sh');
  for (const required of ['docker build', '--file Dockerfile.runtime', 'up -d', '/healthz', '/api/promotion-chain',
    'down -v', 'X-Operator-UI-Secret']) {
    assert(script.includes(required), `the smoke covers ${required}`);
  }
  assert(script.includes('401'), 'including that an unauthenticated read is refused');
  assert(/docker compose stop/.test(script), 'and that the container stops on a signal rather than being killed');
  assert(script.includes('::add-mask::'), 'and it masks the operator token out of the CI log');
  assert(!script.includes('docker push') && !script.includes('git push') && !script.includes('git tag'),
    'the smoke publishes nothing');

  const bundleJob = jobText('bundle');
  assert(bundleJob.includes('deploy/ci/release-bundle-check.sh'), 'the bundle job assembles and validates the bundle');
  const check = read('deploy/ci/release-bundle-check.sh');
  assert(check.includes('sha256sum -c SHA256SUMS'), 'with the checksum tool a user would use');
  assert(check.includes('docker compose config'), 'and proves the bundle stands alone as a Compose project');
});

test('CI runs the regression suites this phase must not break', () => {
  const suites = jobText('suites');
  for (const required of ['npm run typecheck', 'test:phase245-local', 'test:phase244-local', 'test:phase243-local',
    'test:phase242-local', 'test:operator-ui-local-auth-boundary', 'docker compose -f docker-compose.runtime.yml config --quiet']) {
    assert(suites.includes(required), `the suites job runs ${required}`);
  }
});

test('publishing is gated to a release or a deliberate dispatch from a version tag', () => {
  const publish = job('publish');
  const condition = String(publish.if ?? '');
  assert(condition.includes("github.event_name == 'release'"), 'a published release can publish');
  assert(condition.includes('workflow_dispatch') && condition.includes('inputs.publish'),
    'or a manual dispatch that explicitly asks to');
  assert(!condition.includes('push') || condition.includes('event_name'), 'a branch push is never a publish trigger');
  // The `if:` is only a pre-filter; the binding decision is the tested gate, which the remediation suite
  // exercises against every refusal case (test/release-delivery.ts).
  assert(steps('publish').some((step) => String(step.run ?? '').includes('ops:release-ref')),
    'and the real gate — the tested release-ref decision — runs before anything is pushed');
  assertEq(stringList(publish.needs ?? null, 'needs').sort().join(','), 'bundle,image,suites',
    'nothing publishes before the image and the bundle have been checked');
  assertEq(publish.environment, 'release', 'and it runs in a protected environment');

  const permissions = asMap(publish.permissions ?? null, 'publish permissions');
  assertEq(permissions.packages, 'write', 'the publish job asks for registry write');
  assertEq(permissions.contents, 'write', 'and repository write, solely to attach the release asset');
  assertEq(asMap(workflow.permissions ?? null, 'workflow permissions').contents, 'read',
    'while the workflow default is read-only');
  for (const name of ['suites', 'image', 'bundle']) {
    assertEq(job(name).permissions, undefined, `${name} inherits the read-only default`);
  }
});

test('nothing outside the publish job can push an image, and no job can push code', () => {
  for (const name of Object.keys(jobs)) {
    const text = jobText(name);
    if (name !== 'publish') {
      assert(!/docker push|push: true|docker\/login-action/.test(text), `${name} cannot publish an image`);
    }
    assert(!/git push|git tag|gh release create|gh pr merge/.test(text), `${name} pushes no code, tags nothing, merges nothing`);
    for (const forbidden of ['unraid-real-library-promotion', '/mnt/user/media/Movies', 'jellyfin-write-proof',
      'JELLYFIN_ALLOW_LIVE_PUBLISH', 'PHASE231']) {
      assert(!text.toLowerCase().includes(forbidden.toLowerCase()), `${name} never touches ${forbidden}`);
    }
  }
});

test('a release can only be published under an immutable version tag', () => {
  const push = steps('publish').find((step) => String(step.uses ?? '').startsWith('docker/build-push-action'));
  assert(push !== undefined, 'the publish job pushes with the build-push action');
  const withBlock = asMap(push!.with ?? null, 'push inputs');
  const tags = String(withBlock.tags ?? '');
  assert(!/latest/.test(tags), 'no `latest` tag is ever pushed');
  assert(tags.includes('steps.release.outputs.image_ref'), 'the reference comes from the validating gate, not from a raw ref');
  assertEq(tags.split('\n').filter((line) => line.trim() !== '').length, 1, 'exactly one immutable tag is pushed');
  assert(String(withBlock.file) === 'Dockerfile.runtime', 'and it is the production image that is published');
  assert(String(withBlock.platforms).includes('env.PUBLISH_PLATFORMS'),
    'and the architecture comes from the single declared list, not a second copy that can drift');

  // The gate is a module with a CLI, so it can be executed rather than reasoned about. Every refusal case
  // lives in test/release-delivery.ts; this is the one that matters here — `latest` never resolves.
  const gate = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/ops/release-ref-cli.ts'),
    '--event', 'release', '--release-tag', 'latest', '--ref', 'refs/tags/latest',
    '--repository', 'cdb8457/streaming-catalog-authority', '--owner', 'cdb8457'],
    { cwd: root, encoding: 'utf8', timeout: 300000, env: { ...process.env, GITHUB_OUTPUT: '' } });
  assertEq(gate.status, 1, 'the gate refuses to resolve `latest` into a release');
});

test('the architectures published are the ones CI can actually verify, stated as such', () => {
  const doc = read('docs/PHASE_245_CONSUMER_RELEASE_IMAGE.md');
  assert(doc.includes('linux/amd64'), 'the doc names the published architecture');
  assert(/arm64/i.test(doc), 'and addresses arm64 rather than leaving it ambiguous');
  assert(/not published|unverified|cannot verify|no runner/i.test(doc), 'and says plainly what is not verified');
  assertEq(String(asMap(workflow.env ?? null, 'workflow env').PUBLISH_PLATFORMS), 'linux/amd64',
    'and the workflow publishes exactly that');
});

// ---------------------------------------------------------------------------------------------------------
// Documentation an installer can follow
// ---------------------------------------------------------------------------------------------------------

test('the README gives a short install path for Windows, macOS and Linux', () => {
  const readme = read('README.md');
  const install = readme.slice(0, readme.indexOf('## Run the tests'));
  assert(/Docker Desktop/.test(install), 'it says to install Docker');
  assert(install.includes('setup.sh') || install.includes('local-runtime-setup.sh'), 'then run setup');
  assert(install.includes('docker compose'), 'then start the stack');
  assert(install.includes('http://127.0.0.1:8099/'), 'then open the UI');
  assert(install.includes('secrets/operator_ui_token') || install.includes('operator token'), 'and it says where the token is');
  assert(readme.includes('docs/PHASE_245_CONSUMER_RELEASE_IMAGE.md'), 'and points at the full release documentation');
  assert(readme.includes(BUNDLE_NAME) || /release bundle/i.test(readme), 'and mentions the download-and-run bundle');
});

test('the phase doc states the image, tag and digest policy without hedging', () => {
  const doc = read('docs/PHASE_245_CONSUMER_RELEASE_IMAGE.md');
  for (const required of [RELEASE_IMAGE_REF, 'CATALOG_AUTHORITY_IMAGE', '@sha256:', 'Dockerfile.runtime',
    'docker-compose.runtime.build.yml', BUNDLE_CHECKSUM_FILENAME, 'Rollback', 'Upgrade']) {
    assert(doc.includes(required), `the doc covers ${required}`);
  }
  assert(/never .*latest|not .*latest|no floating/i.test(doc), 'it states the no-latest rule');
  assert(/re-?push|re-?use|immutab/i.test(doc), 'and what a published tag may never become');
  assert(/not (yet )?published|no image has been published/i.test(doc),
    'and is honest that this phase publishes nothing');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
