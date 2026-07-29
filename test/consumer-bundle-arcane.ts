import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeRun, removeQuietly, runScript, usableBash } from '../src/ops/usable-shell.js';
import {
  buildRuntimeVersionView,
  describeImageRef,
  RUNTIME_IMAGE_REF_ENV,
  RUNTIME_REVISION_ENV,
  RUNTIME_VERSION_ENV,
} from '../src/ops/operator-ui-runtime-version.js';
import {
  buildConsumerReleaseArchive,
  buildConsumerReleaseBundle,
  ConsumerReleaseBundleError,
  RELEASE_IMAGE_REPOSITORY,
  RELEASE_IMAGE_TAG,
  type BundleOptions,
  type BundleSources,
} from '../src/ops/consumer-release-bundle.js';
import { readDeterministicArchive } from '../src/ops/release-archive.js';
import { asMap, parseYaml, service, stringList, type YamlMap } from './helpers/compose-yaml.js';

// Phase 254 (v1.1.2) — the archive an Arcane user actually downloads.
//
// v1.1.1 built an Arcane/Unraid install path, documented it, tested it, released it — and shipped a consumer
// archive that did not contain it. The bundle held exactly one Compose file, the ordinary-computer one, whose
// bind sources are RELATIVE: the precise thing a launcher relocation breaks, and the precise reason the Arcane
// file exists. So the one class of user that release was written for got an archive with no way to follow it.
//
// These tests are written against the ways that could be half-fixed: shipping the file but not the setup
// script, shipping a copy that still has relative sources, shipping one that quietly defaults the required
// host path, or shipping one carrying the identity of the machine the release was built on.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function assertThrows(fn: () => unknown, match: RegExp, msg: string): void {
  try { fn(); } catch (err) {
    if (match.test((err as Error).message)) return;
    throw new Error(`${msg}: threw the wrong thing — ${(err as Error).message}`);
  }
  throw new Error(`${msg}: did not throw`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

const sources = (): BundleSources => ({
  runtimeCompose: read('docker-compose.runtime.yml'),
  setupBash: read('deploy/local-runtime-setup.sh'),
  setupPowerShell: read('deploy/local-runtime-setup.ps1'),
  arcaneCompose: read('docker-compose.arcane.yml'),
  arcaneSetupBash: read('deploy/arcane-setup.sh'),
  custodyHelper: read('deploy/write-custody-secret.mjs'),
});
const options: BundleOptions = {
  image: { repository: RELEASE_IMAGE_REPOSITORY, tag: RELEASE_IMAGE_TAG },
  revision: 'abcdef1234567890abcdef1234567890abcdef12',
  createdAt: '2026-01-01T00:00:00.000Z',
};

console.log('Running Phase 254 consumer bundle / Arcane suite:\n');

// ---------------------------------------------------------------------------------------------------------
// The archive contains the path it documents.
// ---------------------------------------------------------------------------------------------------------

await test('the Arcane stack and its setup script are IN the archive a user downloads', () => {
  const bundle = buildConsumerReleaseBundle(sources(), options);
  const archive = buildConsumerReleaseArchive(bundle);
  const entries = readDeterministicArchive(archive.bytes)
    .filter((e) => e.typeflag !== '5' && !e.path.endsWith('/'))
    .map((e) => e.path.slice(e.path.indexOf('/') + 1));
  for (const required of ['docker-compose.arcane.yml', 'arcane-setup.sh']) {
    assert(entries.includes(required), `the extracted archive contains ${required}`);
  }
  // Byte-identical to what the repository ships, so a user is not running a paraphrase of the tested file.
  const inBundle = bundle.files.find((f) => f.path === 'docker-compose.arcane.yml')!.contents;
  assertEq(inBundle.replace(/\r\n/g, '\n'), read('docker-compose.arcane.yml').replace(/\r\n/g, '\n'),
    'and it is the same file the repository tests, not a copy that can drift');
});

await test('the setup script keeps its executable bit, or a user cannot run what the README tells them to', () => {
  const archive = buildConsumerReleaseArchive(buildConsumerReleaseBundle(sources(), options));
  const entries = readDeterministicArchive(archive.bytes);
  const arcane = entries.find((e) => e.path.endsWith('/arcane-setup.sh'));
  assert(arcane !== undefined, 'the script is in the archive');
  assert((arcane!.mode & 0o111) !== 0, 'and is executable');
});

await test('the README tells a launcher user about the file, and does not send them to a checkout for it', () => {
  const readme = buildConsumerReleaseBundle(sources(), options).files.find((f) => f.path === 'README.md')!.contents;
  assert(/docker-compose\.arcane\.yml/.test(readme), 'the README names the Arcane stack');
  assert(/arcane-setup\.sh/.test(readme), 'and the setup script');
  assert(/\/app\/data\/projects/.test(readme), 'and explains the relocation that makes relative paths fail');
  assert(/CATALOG_AUTHORITY_PROJECT_DIR/.test(readme) && /OPERATOR_UI_BIND_ADDRESS/.test(readme),
    'and names both required variables');
  assert(/PROJECTS_DIRECTORY/.test(readme), 'and offers the launcher-side fix as well');
  // The bundle still owes nothing to a toolchain.
  const onTheHost = readme.replace(/docker compose exec [^\n]*/g, '');
  assert(!/npm |node |git clone/.test(onTheHost), 'without asking the user to install a toolchain');
});

// ---------------------------------------------------------------------------------------------------------
// Portability: the shipped Arcane stack must survive relocation and carry nobody's identity.
// ---------------------------------------------------------------------------------------------------------

await test('every bind source in the shipped Arcane stack is built from the declared host path, never relative', () => {
  const bundle = buildConsumerReleaseBundle(sources(), options);
  const text = bundle.files.find((f) => f.path === 'docker-compose.arcane.yml')!.contents;
  const doc = asMap(parseYaml(text), 'arcane') as YamlMap;
  for (const [name, svc] of Object.entries(asMap(doc.services ?? null, 'services'))) {
    const parsed = asMap(svc, `service ${name}`);
    const volumes = parsed.volumes === undefined || parsed.volumes === null ? [] : stringList(parsed.volumes, 'v');
    for (const entry of volumes) {
      assert(!entry.startsWith('./') && !entry.startsWith('../'),
        `${name} has no relative bind source — relocation under /app/data/projects is what breaks those`);
      assert(entry.startsWith('${CATALOG_AUTHORITY_PROJECT_DIR'),
        `${name} builds ${entry.slice(0, 40)} from the declared host project directory`);
    }
  }
  for (const [name, entry] of Object.entries(asMap(doc.secrets ?? null, 'secrets'))) {
    const file = String(asMap(entry, `secret ${name}`).file ?? '');
    assert(file.startsWith('${CATALOG_AUTHORITY_PROJECT_DIR'), `secret ${name} is an absolute host path`);
  }
});

await test('the shipped bundle carries no trace of the machine it was built on', () => {
  const bundle = buildConsumerReleaseBundle(sources(), options);
  for (const file of bundle.files) {
    assert(!/\b(?:10\.\d{1,3}|192\.168\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}\b/.test(file.contents),
      `${file.path} carries no private LAN address`);
    assert(!/\/mnt\/user\/media\//.test(file.contents), `${file.path} names no media library`);
    assert(!/catalog-authority-v1\d+-test/.test(file.contents), `${file.path} names no particular test project`);
    assert(!/\bTower\b/.test(file.contents), `${file.path} names no particular server`);
  }
});

await test('the assembler REFUSES a bundle whose Arcane stack was made unportable or unsafe', () => {
  const relative = (): void => {
    buildConsumerReleaseBundle({
      ...sources(),
      arcaneCompose: sources().arcaneCompose.replace(
        /- \$\{CATALOG_AUTHORITY_PROJECT_DIR[^\n]*\/promotion-records:[^\n]*/, '- ./promotion-records:/var/lib/catalog/promotion-records:ro'),
    }, options);
  };
  assertThrows(relative, /relative bind source/i, 'a relative bind source is refused');

  const defaulted = (): void => {
    buildConsumerReleaseBundle({
      ...sources(),
      arcaneCompose: sources().arcaneCompose.replace(/\$\{CATALOG_AUTHORITY_PROJECT_DIR:\?[^}]*\}/g,
        '${CATALOG_AUTHORITY_PROJECT_DIR:-/mnt/user/projects/catalog-authority}'),
    }, options);
  };
  assertThrows(defaulted, /REQUIRE CATALOG_AUTHORITY_PROJECT_DIR/i, 'a defaulted host path is refused');

  const built = (): void => {
    buildConsumerReleaseBundle({ ...sources(), arcaneCompose: `${sources().arcaneCompose}\n    build: .\n` }, options);
  };
  assertThrows(built, /builds from source/i, 'a bundle that builds from source is refused');

  const hostIdentity = (): void => {
    buildConsumerReleaseBundle({
      ...sources(),
      arcaneSetupBash: `${sources().arcaneSetupBash}\n# example: 192.168.1.31\n`,
    }, options);
  };
  assertThrows(hostIdentity, /private LAN address/i, 'a baked LAN address is refused');

  const mediaPath = (): void => {
    buildConsumerReleaseBundle({
      ...sources(), arcaneSetupBash: `${sources().arcaneSetupBash}\n# /mnt/user/media/Movies\n`,
    }, options);
  };
  assertThrows(mediaPath, /media library path/i, 'a baked media library path is refused');
});

// ---------------------------------------------------------------------------------------------------------
// The setup script behaves differently in a bundle than in a checkout, because a bundle has no Node.js.
// ---------------------------------------------------------------------------------------------------------

await test('run from a bundle root the setup script never tells a Docker-only user to run npm', () => {
  const shell = usableBash();
  if (shell === null) { console.log('        (skipped: no bash on this host)'); return; }
  const workspace = mkdtempSync(join(tmpdir(), 'arcane-bundle-'));
  try {
    // A bundle root: the script sits beside the compose file, with no deploy/ directory and no package.json.
    const bundle = buildConsumerReleaseBundle(sources(), options);
    for (const file of bundle.files) writeFileSync(join(workspace, file.path), file.contents);
    assert(!existsSync(join(workspace, 'package.json')), 'the bundle genuinely has no package.json');

    const run = runScript(shell, join(workspace, 'arcane-setup.sh'), { cwd: workspace, args: [] });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    assertEq(run.status, 2, `no argument is a usage failure — ${describeRun(run)}`);
    assert(/bash \.\/arcane-setup\.sh/.test(output), 'and the usage line is the bundle spelling');
    assert(!/npm run/.test(output), 'with no npm anywhere in what a bundle user is told');
  } finally { removeQuietly(workspace); }
});

await test('run from a checkout it still offers the richer preflight, because there a toolchain exists', () => {
  const shell = usableBash();
  if (shell === null) { console.log('        (skipped: no bash on this host)'); return; }
  const workspace = mkdtempSync(join(tmpdir(), 'arcane-checkout-'));
  try {
    const run = runScript(shell, join(root, 'deploy', 'arcane-setup.sh'), { cwd: workspace, args: [] });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    assertEq(run.status, 2, `no argument is a usage failure — ${describeRun(run)}`);
    assert(/bash deploy\/arcane-setup\.sh/.test(output), 'the usage line is the checkout spelling');
    assertEq(readdirSync(workspace).length, 0, 'and a refused run creates nothing');
  } finally { removeQuietly(workspace); }
});

// ---------------------------------------------------------------------------------------------------------
// Honest classification of image references. A local build is not damage.
// ---------------------------------------------------------------------------------------------------------

await test('a registry-qualified digest reference is a real pin, and reads as one', () => {
  const view = describeImageRef(`${RELEASE_IMAGE_REPOSITORY}@sha256:${'3'.repeat(64)}`);
  assertEq(view.state, 'PARSED', 'a registry-qualified reference parses');
  assert(view.pinnedByDigest, 'and is reported as digest-pinned, which is what Setup & Diagnostics shows');
  assert(!view.movingTag, 'and is not a moving tag');
});

await test('a registry-UNqualified local build is LOCAL, not MALFORMED — it is not damaged, it is just local', () => {
  // These are exactly what this project's own CI smoke and release-candidate runs use, so the old MALFORMED
  // verdict put the word "malformed" on the panel during the runs meant to demonstrate the product working.
  for (const ref of ['catalog-authority-ops:ci', 'catalog-authority-ops:rc-acceptance', 'repo-ops:latest']) {
    const view = describeImageRef(ref);
    assertEq(view.state, 'LOCAL', `${ref} is a local build`);
    assert(!view.pinnedByDigest, 'with no digest pin');
  }
  assertEq(describeImageRef('repo-ops:latest').movingTag, true, 'and a moving tag is still called moving');
  // And the digest survives when a local build has one — losing it was the second half of the same bug.
  const pinned = describeImageRef(`catalog-authority-ops@sha256:${'a'.repeat(64)}`);
  assertEq(pinned.state, 'LOCAL', 'an unqualified digest reference is local');
  assert(pinned.pinnedByDigest, 'and is still honestly reported as digest-pinned');
});

await test('genuine rubbish is still MALFORMED, so the new state did not become a dumping ground', () => {
  for (const ref of ['NOT A REF', '../../etc/passwd', 'ghcr.io/x@sha256:zz', 'UPPER/CASE:v1', '']) {
    const view = describeImageRef(ref);
    assert(view.state === 'MALFORMED' || view.state === 'ABSENT', `${JSON.stringify(ref)} is not accepted`);
    assert(!view.pinnedByDigest, 'and claims no pin');
    assertEq(view.repository, null, 'and echoes nothing back');
  }
});

await test('a local build is still TOLD that nobody else could pull it', () => {
  // The point of the new state is honesty, not reassurance. Introducing LOCAL must not quietly remove the
  // useful half of the old MALFORMED message: a reference naming no registry cannot be pulled by a consumer,
  // and that stays said out loud.
  const local = buildRuntimeVersionView({
    [RUNTIME_VERSION_ENV]: 'v1.1.2',
    [RUNTIME_REVISION_ENV]: 'abcdef1234567',
    [RUNTIME_IMAGE_REF_ENV]: 'catalog-authority-ops:ci',
  });
  assertEq(local.image.state, 'LOCAL', 'the reference is local');
  assert(local.notes.some((n) => /names no registry/i.test(n)), 'and the notes say it names no registry');
  assert(local.notes.some((n) => /Nobody else could pull it/i.test(n)), 'and that nobody else could pull it');
  assert(local.notes.some((n) => /wrong for a release/i.test(n)), 'and that this is wrong for a release');

  // A genuinely unparseable value is described differently, and still echoes nothing back.
  const junk = buildRuntimeVersionView({
    [RUNTIME_VERSION_ENV]: 'v1.1.2',
    [RUNTIME_REVISION_ENV]: 'abcdef1234567',
    [RUNTIME_IMAGE_REF_ENV]: 'NOT A REF <script>',
  });
  assertEq(junk.image.state, 'MALFORMED', 'rubbish is malformed');
  assert(junk.notes.some((n) => /could not be parsed/i.test(n)), 'and is described as unparseable');
  assert(!junk.notes.join(' ').includes('NOT A REF'), 'without repeating the value back');
});

await test('the support report and the page both describe a local build as local', () => {
  assert(read('src/ops/operator-ui-support-report.ts').includes("'LOCAL'"),
    'the support report has a word for it, so a pasted report is not misread as a broken value');
  assert(/local build/.test(read('src/ops/operator-ui-app.js')),
    'and the page says so in words rather than showing a bare state');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${String(err)}`);
  process.exit(1);
}
