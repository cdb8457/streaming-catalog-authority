import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asMap,
  parseYaml,
  yamlStrings,
  type YamlMap,
  type YamlValue,
} from './helpers/compose-yaml.js';
import {
  RELEASE_IMAGE_PACKAGE,
  RELEASE_IMAGE_REGISTRY,
  RELEASE_IMAGE_REPOSITORY,
  RELEASE_REPOSITORY,
  RELEASE_REPOSITORY_NAME,
  RELEASE_REPOSITORY_OWNER,
  ReleaseCoordinatesError,
  assertRepositoryMatchesCoordinates,
  normaliseImageRepository,
  resolveImageRepository,
} from '../src/ops/release-coordinates.js';
import {
  assertReleaseConsistency,
  decideRelease,
  isVersionTag,
  releaseArchiveName,
  type ReleaseDecision,
  type ReleaseEventContext,
} from '../src/ops/release-ref.js';
import {
  buildDeterministicArchive,
  readDeterministicArchive,
  ReleaseArchiveError,
} from '../src/ops/release-archive.js';
import {
  BUNDLE_CHECKSUM_FILENAME,
  BUNDLE_MANIFEST_FILENAME,
  BUNDLE_NAME,
  RELEASE_IMAGE_TAG,
  buildConsumerReleaseArchive,
  buildConsumerReleaseBundle,
  type BundleOptions,
  type BundleSources,
} from '../src/ops/consumer-release-bundle.js';

// Phase 245 remediation — release delivery.
//
// Two defects got through the first pass because every assertion was about the SHAPE of an artifact rather
// than about whether the artifact could work:
//
//   1. The publish target named `ghcr.io/catalog-authority/…`, a namespace this repository does not own and
//      whose GITHUB_TOKEN cannot write to. The tests checked that the string was consistent everywhere,
//      which it was — consistently wrong.
//   2. The release "published" its bundle with actions/upload-artifact, which expires and lives behind a
//      GitHub login. A consumer had no download.
//
// So the tests here check things that can be false: that the coordinates match the repository that actually
// exists, that the tag a release publishes is the tag it announced, that the archive extracts to exactly
// what was verified, and that only the publish job can write anything.

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

console.log('Running Phase 245 release delivery remediation suite:\n');

// The inputs every bundle assertion below is made against.
const sources: BundleSources = {
  runtimeCompose: read('docker-compose.runtime.yml'),
  setupBash: read('deploy/local-runtime-setup.sh'),
  setupPowerShell: read('deploy/local-runtime-setup.ps1'),
};
const options: BundleOptions = {
  image: { repository: RELEASE_IMAGE_REPOSITORY, tag: RELEASE_IMAGE_TAG },
  revision: '60f32e147b929bcf14319d781eb65a00c6a19d9f',
  createdAt: '2026-07-22T00:00:00.000Z',
};

// ---------------------------------------------------------------------------------------------------------
// Where releases actually go
// ---------------------------------------------------------------------------------------------------------

test('the release coordinates are the repository that actually exists', () => {
  // The git remote is the ground truth an editor cannot argue with.
  const remote = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (remote.status !== 0) { console.log('        (note: no git remote on this checkout — coordinates checked against the constant only)'); }
  else {
    const url = (remote.stdout ?? '').trim();
    const match = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    assert(match !== null, `the remote is a GitHub URL: ${url}`);
    assertEq(match![1]!.toLowerCase(), RELEASE_REPOSITORY_OWNER, 'the coordinates name the real owner');
    assertEq(match![2]!.toLowerCase(), RELEASE_REPOSITORY_NAME, 'and the real repository');
  }
  assertEq(RELEASE_IMAGE_REPOSITORY, `${RELEASE_IMAGE_REGISTRY}/${RELEASE_REPOSITORY_OWNER}/${RELEASE_IMAGE_PACKAGE}`,
    'the image repository is derived from the owner, not typed out again');
  assert(!RELEASE_IMAGE_REPOSITORY.includes('ghcr.io/catalog-authority/'),
    'and the unowned placeholder namespace is gone from the publish target');
  assertEq(RELEASE_IMAGE_REPOSITORY, RELEASE_IMAGE_REPOSITORY.toLowerCase(), 'GHCR rejects uppercase, so the target has none');
});

test('every artifact a user touches names that one repository', () => {
  const composeImage = String(asMap(asMap(parseYaml(read('docker-compose.runtime.yml')).services ?? null, 'services').app ?? null, 'app').image);
  assert(composeImage.includes(`${RELEASE_IMAGE_REPOSITORY}:`), `the Compose default pins ${RELEASE_IMAGE_REPOSITORY}`);

  const bundle = buildConsumerReleaseBundle(sources, options);
  for (const path of ['.env', '.env.example', 'VERSION', BUNDLE_MANIFEST_FILENAME]) {
    const contents = bundle.files.find((file) => file.path === path)!.contents;
    assert(contents.includes(RELEASE_IMAGE_REPOSITORY), `the bundle's ${path} names it`);
    assert(!contents.includes('catalog-authority/catalog-authority-ops'), `and ${path} does not name the placeholder`);
  }
  for (const doc of ['README.md', 'docs/PHASE_245_CONSUMER_RELEASE_IMAGE.md']) {
    assert(read(doc).includes(RELEASE_IMAGE_REPOSITORY), `${doc} tells users the real coordinates`);
    assert(!read(doc).includes('ghcr.io/catalog-authority/catalog-authority-ops'),
      `${doc} no longer gives them a pullable reference in a namespace nobody owns`);
  }
  // The historical release notes keep their record, but must not leave the wrong convention uncorrected.
  const release = read('RELEASE.md');
  assert(release.includes(RELEASE_IMAGE_REPOSITORY), 'RELEASE.md records the operative repository');
  assert(/correction|superseded|placeholder/i.test(release), 'and says plainly that the earlier namespace was a placeholder');
});

test('an image reference is validated, lowercased where legal, and refused where not', () => {
  assertEq(normaliseImageRepository('GHCR.IO', 'CDB8457', 'Catalog-Authority-Ops'), 'ghcr.io/cdb8457/catalog-authority-ops',
    'a GitHub owner may contain uppercase; the image reference may not, so it is lowered');
  for (const [registry, owner, name] of [
    ['ghcr.io', '', 'ops'], ['ghcr.io', 'owner', ''], ['ghcr.io', 'own er', 'ops'],
    ['ghcr.io', 'owner/nested', 'ops'], ['not a host', 'owner', 'ops'], ['ghcr.io', '-leading', 'ops'],
  ] as const) {
    assertThrows(() => normaliseImageRepository(registry, owner, name), `refuses ${registry}/${owner}/${name}`);
  }

  assertEq(resolveImageRepository({ owner: RELEASE_REPOSITORY_OWNER }), RELEASE_IMAGE_REPOSITORY, 'no override means the derived value');
  assertEq(resolveImageRepository({ owner: 'someone-else', override: 'ghcr.io/other/catalog-authority-ops' }),
    'ghcr.io/other/catalog-authority-ops', 'an explicit, canonical override is honoured');
  // An override that would be silently rewritten is refused: what an operator typed and what gets published
  // must be the same string.
  assertThrows(() => resolveImageRepository({ owner: 'o', override: 'ghcr.io/Other/Ops' }), 'refuses an override needing repair');
  assertThrows(() => resolveImageRepository({ owner: 'o', override: 'ghcr.io/other' }), 'refuses a two-part override');
  assertThrows(() => resolveImageRepository({ owner: 'o', override: 'ghcr.io/other/ops/extra' }), 'refuses a four-part override');
});

test('a run in the wrong repository is refused rather than published to the wrong place', () => {
  assertRepositoryMatchesCoordinates(RELEASE_REPOSITORY);
  assertRepositoryMatchesCoordinates(RELEASE_REPOSITORY.toUpperCase());
  for (const wrong of ['someone/else', 'cdb8457/other-repo', 'catalog-authority/streaming-catalog-authority', '']) {
    assertThrows(() => assertRepositoryMatchesCoordinates(wrong), `refuses ${wrong || '(empty)'}`);
  }
  try { assertRepositoryMatchesCoordinates('someone/else'); } catch (err) {
    assert(err instanceof ReleaseCoordinatesError, 'it is a coordinates error');
    assert((err as Error).message.includes('release-coordinates.ts'), 'and it says where to fix it');
  }
});

// ---------------------------------------------------------------------------------------------------------
// Which runs may publish, and as what
// ---------------------------------------------------------------------------------------------------------

const baseContext: ReleaseEventContext = {
  eventName: 'release',
  ref: 'refs/tags/v1.2.3',
  releaseTagName: 'v1.2.3',
  repository: RELEASE_REPOSITORY,
  repositoryOwner: RELEASE_REPOSITORY_OWNER,
};
const decide = (overrides: Partial<ReleaseEventContext>): ReleaseDecision => decideRelease({ ...baseContext, ...overrides });

test('a published release of a version tag publishes exactly that tag', () => {
  const decision = decide({});
  assert(decision.publish, 'a published release may publish');
  if (!decision.publish) return;
  assertEq(decision.tag, 'v1.2.3', 'the tag is the one the release announced');
  assertEq(decision.imageRef, `${RELEASE_IMAGE_REPOSITORY}:v1.2.3`, 'and the image reference is built from it');
  assertEq(decision.archiveName, 'catalog-authority-operator-ui-v1.2.3.tar.gz', 'as is the asset name');
  assertEq(decision.authority, 'published-release', 'and the authority is recorded');
  assert(decide({ releaseTagName: 'v2.0.0-rc.1', ref: 'refs/tags/v2.0.0-rc.1' }).publish, 'a pre-release version tag is still a version tag');
});

test('a deliberate dispatch from a version tag publishes; anything less does not', () => {
  const approved = decide({ eventName: 'workflow_dispatch', releaseTagName: undefined, publishInput: true });
  assert(approved.publish && approved.authority === 'version-tag-dispatch', 'an explicit dispatch from a tag may publish');
  for (const [why, overrides] of [
    ['no publish input', { eventName: 'workflow_dispatch', releaseTagName: undefined }],
    ['publish input false', { eventName: 'workflow_dispatch', releaseTagName: undefined, publishInput: false }],
    ['publish input "false"', { eventName: 'workflow_dispatch', releaseTagName: undefined, publishInput: 'false' }],
    ['publish input "yes"', { eventName: 'workflow_dispatch', releaseTagName: undefined, publishInput: 'yes' }],
    ['dispatched from a branch', { eventName: 'workflow_dispatch', releaseTagName: undefined, publishInput: true, ref: 'refs/heads/master' }],
    ['dispatched from no ref', { eventName: 'workflow_dispatch', releaseTagName: undefined, publishInput: true, ref: undefined }],
  ] as const) {
    assert(!decide(overrides as Partial<ReleaseEventContext>).publish, `refused: ${why}`);
  }
});

test('a push, a pull request and every other event are refused', () => {
  for (const eventName of ['push', 'pull_request', 'pull_request_target', 'schedule', 'issue_comment', 'unknown', '']) {
    const decision = decide({ eventName, releaseTagName: undefined });
    assert(!decision.publish, `${eventName || '(empty)'} never publishes`);
    if (!decision.publish) assert(decision.reason.length > 0, 'and says why');
  }
  // Even a push that happens to be sitting on a version tag.
  assert(!decide({ eventName: 'push', releaseTagName: undefined, ref: 'refs/tags/v1.2.3' }).publish,
    'a tag push is not a release: a release event or an explicit dispatch is');
});

test('a tag that is not an immutable version, or that disagrees with the run, is refused', () => {
  for (const [why, overrides] of [
    ['latest', { releaseTagName: 'latest', ref: 'refs/tags/latest' }],
    ['a branch name as a tag', { releaseTagName: 'master', ref: 'refs/tags/master' }],
    ['a bare number', { releaseTagName: 'v1.2', ref: 'refs/tags/v1.2' }],
    ['a leading-zero version', { releaseTagName: 'v01.2.3', ref: 'refs/tags/v01.2.3' }],
    ['no v prefix', { releaseTagName: '1.2.3', ref: 'refs/tags/1.2.3' }],
    ['a commit sha', { releaseTagName: 'a1b2c3d', ref: 'refs/tags/a1b2c3d' }],
    ['an empty tag', { releaseTagName: '' }],
    ['a draft release', { releaseDraft: true }],
    ['a ref that names another tag', { ref: 'refs/tags/v9.9.9' }],
    ['a ref that is a branch', { ref: 'refs/heads/master' }],
  ] as const) {
    assert(!decide(overrides as Partial<ReleaseEventContext>).publish, `refused: ${why}`);
  }
  // The mismatch case is the one that silently ships the wrong version, so its reason must name both.
  const mismatch = decide({ ref: 'refs/tags/v9.9.9' });
  assert(!mismatch.publish && mismatch.reason.includes('v1.2.3') && mismatch.reason.includes('v9.9.9'),
    'a tag mismatch names both tags');
  assert(isVersionTag('v1.0.0') && !isVersionTag('latest') && !isVersionTag('v1.0'), 'the version-tag rule is what it says');
});

test('a run whose repository or owner is not this one is refused', () => {
  for (const [why, overrides] of [
    ['a different repository', { repository: 'someone/else', repositoryOwner: 'someone' }],
    ['the placeholder namespace', { repository: 'catalog-authority/streaming-catalog-authority', repositoryOwner: 'catalog-authority' }],
    ['repository and owner disagreeing', { repositoryOwner: 'someone-else' }],
    ['an uppercase image override', { imageRepositoryOverride: 'ghcr.io/CDB8457/catalog-authority-ops' }],
    ['a malformed image override', { imageRepositoryOverride: 'ghcr.io/only-two' }],
  ] as const) {
    assert(!decide(overrides as Partial<ReleaseEventContext>).publish, `refused: ${why}`);
  }
});

test('the tag, the bundle version, the archive name and the image tag are one fact', () => {
  assertReleaseConsistency({
    tag: 'v1.2.3',
    bundleVersion: 'v1.2.3',
    archiveName: releaseArchiveName('v1.2.3'),
    imageRef: `${RELEASE_IMAGE_REPOSITORY}:v1.2.3`,
  });
  // A digest-pinned reference carries no tag to compare, and that is allowed.
  assertReleaseConsistency({
    tag: 'v1.2.3',
    bundleVersion: 'v1.2.3',
    archiveName: releaseArchiveName('v1.2.3'),
    imageRef: `${RELEASE_IMAGE_REPOSITORY}@sha256:${'0'.repeat(64)}`,
  });
  for (const [why, input] of [
    ['the bundle is a different version', { bundleVersion: 'v1.2.4' }],
    ['the archive is a different version', { archiveName: 'catalog-authority-operator-ui-v1.2.4.tar.gz' }],
    ['the archive is misnamed', { archiveName: 'bundle.tar.gz' }],
    ['the image is a different version', { imageRef: `${RELEASE_IMAGE_REPOSITORY}:v1.2.4` }],
    ['the tag is not a version', { tag: 'latest' }],
  ] as const) {
    const consistent = {
      tag: 'v1.2.3',
      bundleVersion: 'v1.2.3',
      archiveName: releaseArchiveName('v1.2.3'),
      imageRef: `${RELEASE_IMAGE_REPOSITORY}:v1.2.3`,
    };
    assertThrows(() => assertReleaseConsistency({ ...consistent, ...input }), `refused: ${why}`);
  }
  assertThrows(() => releaseArchiveName('latest'), 'there is no archive name for a moving tag');
});

test('the decision is runnable locally, and the CLI refuses exactly what the function refuses', () => {
  const cli = (args: readonly string[]): { status: number; out: string } => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/ops/release-ref-cli.ts'), ...args,
      '--repository', RELEASE_REPOSITORY, '--owner', RELEASE_REPOSITORY_OWNER],
      { cwd: root, encoding: 'utf8', timeout: 300000, env: { ...process.env, GITHUB_OUTPUT: '' } });
    return { status: run.status ?? -1, out: `${run.stdout ?? ''}${run.stderr ?? ''}` };
  };
  const approved = cli(['--event', 'release', '--release-tag', 'v3.1.4', '--ref', 'refs/tags/v3.1.4']);
  assertEq(approved.status, 0, `a published release is approved: ${approved.out}`);
  const parsed = JSON.parse(approved.out) as { tag: string; imageRef: string; archive: string };
  assertEq(parsed.tag, 'v3.1.4', 'the CLI reports the tag');
  assertEq(parsed.imageRef, `${RELEASE_IMAGE_REPOSITORY}:v3.1.4`, 'and the image reference');
  assertEq(parsed.archive, 'catalog-authority-operator-ui-v3.1.4.tar.gz', 'and the asset name');

  for (const args of [
    ['--event', 'push', '--ref', 'refs/heads/master'],
    ['--event', 'pull_request', '--ref', 'refs/pull/9/merge'],
    ['--event', 'workflow_dispatch', '--ref', 'refs/tags/v1.0.0'],
    ['--event', 'release', '--release-tag', 'latest', '--ref', 'refs/tags/latest'],
    ['--event', 'release', '--release-tag', 'v1.0.0', '--ref', 'refs/tags/v1.0.1'],
  ]) {
    const refused = cli(args);
    assertEq(refused.status, 1, `refused: ${args.join(' ')}`);
    assert(refused.out.includes('release refused:'), 'with a reason on stderr');
  }
});

// ---------------------------------------------------------------------------------------------------------
// The consumer download
// ---------------------------------------------------------------------------------------------------------


test('the archive contains the verified bundle and nothing else', () => {
  const bundle = buildConsumerReleaseBundle(sources, options);
  const archive = buildConsumerReleaseArchive(bundle);
  assertEq(archive.filename, `${BUNDLE_NAME}-${RELEASE_IMAGE_TAG}.tar.gz`, 'the asset is named for its version');

  const entries = readDeterministicArchive(archive.bytes);
  const rootDir = `${BUNDLE_NAME}-${RELEASE_IMAGE_TAG}`;
  const directories = entries.filter((entry) => entry.typeflag === '5');
  assertEq(directories.map((entry) => entry.path).join(','), `${rootDir}/`, 'everything lives under one directory');

  const files = entries.filter((entry) => entry.typeflag === '0');
  assertEq(files.map((entry) => entry.path.slice(rootDir.length + 1)).sort().join(','),
    bundle.files.map((file) => file.path).sort().join(','),
    'the archive holds exactly the bundle files that were checksummed');
  for (const file of bundle.files) {
    const entry = files.find((candidate) => candidate.path === `${rootDir}/${file.path}`)!;
    assertEq(createHash('sha256').update(Buffer.from(entry.contents, 'utf8')).digest('hex'), file.sha256,
      `${file.path} is byte-identical inside the archive`);
    assert(!entry.contents.includes('\r'), `${file.path} keeps its LF endings inside the archive`);
  }
  // The scripts a user runs are executable; nothing else is.
  for (const entry of files) {
    assertEq(entry.mode, entry.path.endsWith('.sh') ? 0o755 : 0o644, `${entry.path} has the right mode`);
  }
});

test('the archive is reproducible and carries no build fingerprint', () => {
  const bundle = buildConsumerReleaseBundle(sources, options);
  const first = buildConsumerReleaseArchive(bundle);
  const second = buildConsumerReleaseArchive(buildConsumerReleaseBundle(sources, options));
  assertEq(first.sha256, second.sha256, 'same bundle, same archive bytes');
  assertEq(Buffer.compare(first.bytes, second.bytes), 0, 'byte for byte');

  for (const entry of readDeterministicArchive(first.bytes)) {
    assertEq(entry.mtime, 0, `${entry.path} has no timestamp`);
    assertEq(entry.uid, 0, `${entry.path} records no uid`);
    assertEq(entry.gid, 0, `${entry.path} records no gid`);
  }
  // Ordering must not depend on the order the bundle happened to be assembled in.
  const shuffled = { ...bundle, files: [...bundle.files].reverse() };
  assertEq(buildConsumerReleaseArchive(shuffled).sha256, first.sha256, 'entries are sorted, not appended');

  // gzip must not stamp the archive with a build time either.
  assertEq(first.bytes.readUInt32LE(4), 0, 'the gzip header carries no mtime');
});

test('the archive has a separately verifiable checksum that matches its bytes', () => {
  const archive = buildConsumerReleaseArchive(buildConsumerReleaseBundle(sources, options));
  assertEq(archive.checksumFilename, `${archive.filename}.sha256`, 'the checksum is a sidecar file');
  assertEq(archive.checksum, `${archive.sha256}  ${archive.filename}\n`, 'in sha256sum -c format');
  assertEq(createHash('sha256').update(archive.bytes).digest('hex'), archive.sha256, 'and it is the digest of the bytes');
  assert(/^[0-9a-f]{64}$/.test(archive.sha256), 'a full sha256');
});

test('the archive holds no secrets, no source and no toolchain', () => {
  const entries = readDeterministicArchive(buildConsumerReleaseArchive(buildConsumerReleaseBundle(sources, options)).bytes);
  for (const entry of entries) {
    const name = entry.path.split('/').slice(1).join('/');
    if (name === '') continue;
    for (const forbidden of ['package.json', 'package-lock.json', 'tsconfig.json', 'Dockerfile', 'node_modules']) {
      assert(!name.startsWith(forbidden), `the archive ships no ${forbidden}`);
    }
    assert(!name.endsWith('.ts'), 'and no TypeScript');
    assert(!name.startsWith('secrets/') && name !== 'secrets', 'and no secrets directory');
    assert(!/\b[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/.test(entry.contents), `${name} carries no 32-byte secret`);
    assert(!/-----BEGIN/.test(entry.contents), `${name} carries no key material`);
  }
});

test('the archive writer refuses what it cannot represent honestly', () => {
  assertThrows(() => buildDeterministicArchive('root', [], 'x.tar.gz'), 'an empty archive is refused');
  assertThrows(() => buildDeterministicArchive('../escape', [{ path: 'a', contents: 'a' }], 'x.tar.gz'), 'an unsafe root is refused');
  assertThrows(() => buildDeterministicArchive('root', [{ path: '../a', contents: 'a' }], 'x.tar.gz'), 'a traversing path is refused');
  assertThrows(() => buildDeterministicArchive('root', [{ path: '/a', contents: 'a' }], 'x.tar.gz'), 'an absolute path is refused');
  assertThrows(() => buildDeterministicArchive('root', [{ path: 'a', contents: '1' }, { path: 'a', contents: '2' }], 'x.tar.gz'),
    'a duplicate path is refused');
  assertThrows(() => buildDeterministicArchive('root', [{ path: `${'d/'.repeat(60)}f`, contents: 'a' }], 'x.tar.gz'),
    'a path too long for plain ustar is refused rather than truncated');
  try { buildDeterministicArchive('root', [], 'x.tar.gz'); } catch (err) {
    assert(err instanceof ReleaseArchiveError, 'and the refusal is typed');
  }
});

test('the system tar agrees with the archive this suite reads', () => {
  const tar = spawnSync('tar', ['--version'], { encoding: 'utf8', timeout: 60000 });
  if (tar.status !== 0) { console.log('        (skipped: no tar on this host — CI extracts with the system tar)'); return; }
  const archive = buildConsumerReleaseArchive(buildConsumerReleaseBundle(sources, options));
  const workspace = mkdtempSync(join(tmpdir(), 'phase245-archive-'));
  try {
    writeFileSync(join(workspace, archive.filename), archive.bytes);
    // Run tar INSIDE the workspace with a relative name: a Windows absolute path would be read as
    // `host:path` and tar would try to open a remote archive.
    const listed = spawnSync('tar', ['-tzf', archive.filename], { cwd: workspace, encoding: 'utf8', timeout: 120000 });
    assertEq(listed.status, 0, `the system tar reads the archive: ${listed.stderr ?? ''}`);
    const names = (listed.stdout ?? '').split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => line.replace(/\/$/, ''));
    const rootDir = `${BUNDLE_NAME}-${RELEASE_IMAGE_TAG}`;
    for (const file of buildConsumerReleaseBundle(sources, options).files) {
      assert(names.includes(`${rootDir}/${file.path}`), `tar lists ${file.path}`);
    }
    const extracted = spawnSync('tar', ['-xzf', archive.filename], { cwd: workspace, encoding: 'utf8', timeout: 120000 });
    assertEq(extracted.status, 0, `the system tar extracts it: ${extracted.stderr ?? ''}`);
    assertEq(readdirSync(join(workspace, rootDir)).sort().join(','),
      buildConsumerReleaseBundle(sources, options).files.map((file) => file.path).sort().join(','),
      'and what lands on disk is the bundle');
    const composeText = readFileSync(join(workspace, rootDir, 'docker-compose.yml'), 'utf8');
    assert(composeText.includes(RELEASE_IMAGE_REPOSITORY), 'with the pinned image an extracted user would run');
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------
// The workflow that delivers it
// ---------------------------------------------------------------------------------------------------------

const workflow = parseYaml(read('.github/workflows/runtime-image.yml'));
const jobs = asMap(workflow.jobs ?? null, 'jobs');
const job = (name: string): YamlMap => asMap(jobs[name] ?? null, `job ${name}`);
const steps = (name: string): YamlMap[] => (job(name).steps as YamlValue[]).map((step) => asMap(step, 'step'));
const jobText = (name: string): string => yamlStrings(job(name)).join('\n');

test('only the publish job may write anything, and it is the only one that can', () => {
  assertEq(asMap(workflow.permissions ?? null, 'workflow permissions').contents, 'read',
    'the workflow default is read-only');
  const publish = asMap(job('publish').permissions ?? null, 'publish permissions');
  assertEq(publish.contents, 'write', 'the publish job may attach a release asset');
  assertEq(publish.packages, 'write', 'and push an image');
  for (const name of Object.keys(jobs)) {
    if (name === 'publish') continue;
    assertEq(job(name).permissions, undefined, `${name} inherits read-only`);
    const text = jobText(name);
    assert(!/contents:\s*write/.test(text), `${name} does not grant itself write`);
    assert(!/gh release (upload|create|edit|delete)/.test(text), `${name} cannot touch a release`);
    assert(!/docker\/login-action|push: true|docker push/.test(text), `${name} cannot publish an image`);
    assert(!/git push|git tag|gh pr merge/.test(text), `${name} pushes nothing`);
  }
});

test('the publish job decides its tag once, with the tested gate, and never re-derives it', () => {
  const publishSteps = steps('publish');
  const gate = publishSteps.find((step) => String(step.run ?? '').includes('ops:release-ref'));
  assert(gate !== undefined, 'the release-ref gate runs');
  assertEq(gate!.id, 'release', 'and its outputs are addressable');
  const env = asMap(gate!.env ?? null, 'gate env');
  assert(String(env.RELEASE_TAG_NAME).includes('github.event.release.tag_name'), 'it is given the announced tag');
  assert(String(env.RELEASE_DRAFT).includes('github.event.release.draft'), 'and whether the release is a draft');
  assert(String(env.RELEASE_PUBLISH_INPUT).includes('inputs.publish'), 'and the dispatch input');

  const text = jobText('publish');
  assert(!/github\.ref_name/.test(text), 'nothing in the publish job reads github.ref_name, which means different things per event');
  const push = publishSteps.find((step) => String(step.uses ?? '').startsWith('docker/build-push-action'))!;
  const withBlock = asMap(push.with ?? null, 'push inputs');
  assertEq(String(withBlock.tags), '${{ steps.release.outputs.image_ref }}', 'the image is tagged with the gate output only');
  assert(!/latest/.test(String(withBlock.tags)), 'never latest');

  const upload = publishSteps.find((step) => String(step.run ?? '').includes('release-asset-upload.sh'));
  assert(upload !== undefined, 'the asset upload runs');
  const uploadEnv = asMap(upload!.env ?? null, 'upload env');
  assert(String(uploadEnv.RELEASE_TAG).includes('steps.release.outputs.tag'), 'the upload uses the gate tag');
  assert(String(uploadEnv.ARCHIVE).includes('steps.release.outputs.archive'), 'and the gate archive name');
});

test('the consumer download is a release asset; the Actions artifact is only for inspection', () => {
  const bundleUpload = steps('bundle').find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact'));
  assert(bundleUpload !== undefined, 'CI still keeps a copy for inspection');
  assert(/inspection/i.test(String(asMap(bundleUpload!.with ?? null, 'with').name)),
    'and its name says that is what it is');
  assert(/not the consumer download/i.test(String(bundleUpload!.name ?? '')), 'as does the step name');
  assert(!steps('publish').some((step) => String(step.uses ?? '').startsWith('actions/upload-artifact')),
    'the publish job does not pretend an expiring artifact is the download');

  const script = read('deploy/ci/release-asset-upload.sh');
  for (const required of ['sha256sum -c', 'gh release view', 'gh release upload', 'RELEASE_TAG', 'ARCHIVE']) {
    assert(script.includes(required), `the upload script covers ${required}`);
  }
  assert(!/gh release create|gh release delete|git push|git tag/.test(script), 'it creates, deletes and pushes nothing');
  assert(script.includes('does not carry the release tag'), 'and refuses an asset that is not this release\'s');

  const check = read('deploy/ci/release-bundle-check.sh');
  for (const required of ['tar -xzf', 'diff -r', 'sha256sum -c', 'docker compose config', 'reproducible']) {
    assert(check.includes(required), `the bundle check covers ${required}`);
  }

  // The refusal that protects a release from a mislabelled asset happens before `gh` is ever invoked, so it
  // can be executed here rather than only read.
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8', timeout: 60000 });
  if (probe.status !== 0) { console.log('        (note: upload refusal not executed — no bash on this host)'); return; }
  const workspace = mkdtempSync(join(tmpdir(), 'phase245-upload-'));
  try {
    for (const name of ['catalog-authority-operator-ui-v9.9.9.tar.gz', 'catalog-authority-operator-ui-v9.9.9.tar.gz.sha256']) {
      writeFileSync(join(workspace, name), '');
    }
    const run = spawnSync('bash', [join(root, 'deploy/ci/release-asset-upload.sh').replace(/\\/g, '/'), workspace.replace(/\\/g, '/')],
      { cwd: root, encoding: 'utf8', timeout: 300000,
        env: { ...process.env, RELEASE_TAG: 'v1.2.3', ARCHIVE: 'catalog-authority-operator-ui-v9.9.9.tar.gz' } });
    assertEq(run.status, 1, 'an asset that is not this release\'s is refused');
    assert(`${run.stderr ?? ''}`.includes('does not carry the release tag'), 'and the refusal names the mismatch');
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('the workflow runs the suites that hold all of this together', () => {
  const suites = jobText('suites');
  for (const required of ['npm run typecheck', 'test:phase245-local', 'test:release-delivery', 'test:phase244-local',
    'test:release-guard', 'test:versioned-release-cut', 'ops:release-coordinates']) {
    assert(suites.includes(required), `the suites job runs ${required}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// What the image actually contains
// ---------------------------------------------------------------------------------------------------------

test('the runtime dependency set is exactly pg and tsx, and npm agrees', () => {
  const listed = spawnSync('npm', ['ls', '--omit=dev', '--depth', '0', '--json'],
    { cwd: root, encoding: 'utf8', timeout: 300000, shell: process.platform === 'win32' });
  assertEq(listed.status, 0, `npm ls --omit=dev resolves cleanly: ${listed.stderr ?? ''}`);
  const tree = JSON.parse(listed.stdout ?? '{}') as { dependencies?: Record<string, { version: string }>; problems?: string[] };
  assertEq(Object.keys(tree.dependencies ?? {}).sort().join(','), 'pg,tsx',
    'a production install is pg and tsx — nothing else reaches the image');
  assertEq(tree.problems, undefined, 'with no unmet production dependency');
});

test('the image ships a transpiler on purpose, and the documentation says so rather than implying otherwise', () => {
  const dockerfile = read('Dockerfile.runtime');
  assert(/node_modules/.test(dockerfile) && dockerfile.includes('--omit=dev'), 'the image installs production dependencies only');
  const entrypoint = /ENTRYPOINT (\[[^\]]*\])/.exec(dockerfile);
  assert(entrypoint !== null, 'there is an exec-form entrypoint');
  const argv = JSON.parse(entrypoint![1]!) as string[];
  assert(argv.includes('tsx'), 'which loads tsx — so tsx MUST be present at runtime');

  const doc = read('docs/PHASE_245_CONSUMER_RELEASE_IMAGE.md');
  assert(/tsx/.test(doc), 'the doc names tsx');
  assert(/transpil/i.test(doc), 'and calls it what it is');
  // The claim that must not be made: that the image contains no tooling at all.
  assert(!/ships no toolchain/i.test(doc.slice(doc.indexOf('## Two Dockerfiles'), doc.indexOf('## Image, tag and digest policy'))),
    'the image section does not claim to ship no toolchain');
  // The line it must draw: a transpiler DOES run in production; the compiler and the test toolchain do not.
  assert(/runs in production/i.test(doc), 'it says the transpiler runs in production');
  assert(/TypeScript compiler/.test(doc), 'and names the compiler it does not ship');
  assert(/does \*{0,2}not\*{0,2} contain/i.test(doc), 'in an explicit does-not-contain list');
  assert(/npm ls --omit=dev/.test(doc), 'and points at the command that proves the runtime closure');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
