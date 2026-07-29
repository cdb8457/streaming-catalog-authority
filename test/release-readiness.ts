import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildConsumerReleaseArchive,
  buildConsumerReleaseBundle,
  RELEASE_IMAGE_REPOSITORY,
  RELEASE_IMAGE_TAG,
  type BundleSources,
  type ConsumerReleaseBundle,
} from '../src/ops/consumer-release-bundle.js';
import { RELEASE_REPOSITORY, RELEASE_REPOSITORY_OWNER } from '../src/ops/release-coordinates.js';
import { releaseArchiveName } from '../src/ops/release-ref.js';
import {
  READINESS_CHECK_IDS,
  READINESS_EXIT_CODES,
  READINESS_TAG_CHECK_ID,
  REQUIRED_SUITES_JOB_COMMANDS,
  REQUIRED_SUITES_TYPECHECK_COMMAND,
  REQUIRED_SUITE_SCRIPTS,
  ReleaseReadinessError,
  assertReadinessReportIsRedactionSafe,
  evaluateReleaseReadiness,
  renderReadinessJson,
  renderReadinessText,
  type GitEvidence,
  type ReadinessCheck,
  type ReadinessEvidence,
  type ReadinessOutcome,
} from '../src/ops/release-readiness.js';
import type { ArchiveResult } from '../src/ops/release-archive.js';

// Phase 250 — adversarial semantic tests for the release-readiness proof.
//
// The proof only matters if it FAILS when it should. So the anchor is a healthy baseline that is
// READY_FOR_HUMAN_RELEASE_DECISION, and then every check is attacked in turn with a minimally-weakened
// fixture — a workflow with a gate removed, a floating pin, a leaked secret, a tampered digest, a dirty tree
// — and the corresponding check must turn to BLOCK (or the outcome to INVALID / NOT_RUN). If a weakening did
// not change the verdict, the check is theatre.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

console.log('Running Phase 250 release-readiness adversarial suite:\n');

const AT = '2020-01-01T00:00:00.000Z';

function sources(): BundleSources {
  return {
    runtimeCompose: read('docker-compose.runtime.yml'),
    setupBash: read('deploy/local-runtime-setup.sh'),
    setupPowerShell: read('deploy/local-runtime-setup.ps1'),
    arcaneCompose: read('docker-compose.arcane.yml'),
    arcaneSetupBash: read('deploy/arcane-setup.sh'),
  };
}

function bundleFor(tag: string): ConsumerReleaseBundle {
  return buildConsumerReleaseBundle(sources(), {
    image: { repository: RELEASE_IMAGE_REPOSITORY, tag },
    revision: 'a'.repeat(40),
    createdAt: AT,
  });
}

const HEALTHY_GIT: GitEvidence = { available: true, clean: true, head: 'a'.repeat(40), localTagPresent: true, localTagAtHead: true };

const PRESENT_DOCS = [
  'docs/PHASE_245_CONSUMER_RELEASE_IMAGE.md',
  'docs/PHASE_246_FIRST_RUN_AND_DIAGNOSTICS.md',
  'docs/PHASE_247_CSP_HARDENING.md',
  'docs/PHASE_248_RELEASE_CANDIDATE_ACCEPTANCE.md',
  'docs/PHASE_249_LIFECYCLE_ACCEPTANCE.md',
];

/** A healthy release-readiness evidence set: everything lines up, the checkout is clean and at the tag. */
function healthyEvidence(overrides: Partial<ReadinessEvidence> = {}): ReadinessEvidence {
  const tag = overrides.targetTag ?? RELEASE_IMAGE_TAG;
  const bundle = overrides.bundle ?? bundleFor(tag);
  const archive = overrides.archive ?? buildConsumerReleaseArchive(bundle);
  return {
    targetTag: RELEASE_IMAGE_TAG,
    repository: RELEASE_REPOSITORY,
    repositoryOwner: RELEASE_REPOSITORY_OWNER,
    git: HEALTHY_GIT,
    workflowText: read('.github/workflows/runtime-image.yml'),
    composeText: read('docker-compose.runtime.yml'),
    dockerfileText: read('Dockerfile.runtime'),
    bundle,
    archive,
    presentDocs: PRESENT_DOCS,
    ...overrides,
  };
}

function evalWith(overrides: Partial<ReadinessEvidence> = {}): ReturnType<typeof evaluateReleaseReadiness> {
  return evaluateReleaseReadiness(healthyEvidence(overrides), { generatedAt: AT });
}

function checkOf(report: { checks: readonly ReadinessCheck[] }, id: string): ReadinessCheck {
  const found = report.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no check with id ${id}`);
  return found;
}

/** Assert a single weakening turns exactly the named check to BLOCK and the outcome to BLOCKED. */
function assertBlocks(overrides: Partial<ReadinessEvidence>, checkId: string): void {
  const report = evalWith(overrides);
  assertEq(checkOf(report, checkId).status, 'BLOCK', `${checkId} should BLOCK`);
  assertEq(report.outcome, 'BLOCKED', 'the overall outcome should be BLOCKED');
}

// ---------------------------------------------------------------------------------------------------------
// The baseline is READY, and it is the strongest anchor: everything passes.
// ---------------------------------------------------------------------------------------------------------

test('the exported canonical check IDs match the checks an evaluated report actually emits (drift guard)', () => {
  // READINESS_CHECK_IDS is the set the Phase 252 rehearsal gate proves a readiness summary against. If a check
  // were added, removed, or renamed without updating the constant, the gate could no longer prove completeness
  // — so this pins the two together. The tag check ID is part of that set.
  const report = evalWith();
  assertEq(report.checks.map((c) => c.id).join(','), READINESS_CHECK_IDS.join(','),
    'the evaluated check IDs, in order, equal the exported canonical list');
  assertEq(new Set(READINESS_CHECK_IDS).size, READINESS_CHECK_IDS.length, 'the canonical list has no duplicates');
  assert(READINESS_CHECK_IDS.includes(READINESS_TAG_CHECK_ID), 'the exported tag-check ID is one of the checks');
  assert(report.checks.some((c) => c.id === READINESS_TAG_CHECK_ID), 'and the evaluated report contains it');
});

test('a healthy release is READY_FOR_HUMAN_RELEASE_DECISION, and every check passes', () => {
  const report = evalWith();
  assertEq(report.outcome, 'READY_FOR_HUMAN_RELEASE_DECISION', 'a healthy release is ready');
  for (const check of report.checks) {
    assertEq(check.status, 'PASS', `check ${check.id} passes on a healthy release (${check.detail})`);
  }
  assertEq(report.counts.block, 0, 'no blocks');
  assertEq(report.counts.invalid, 0, 'nothing invalid');
  assertEq(report.counts.notRun, 0, 'nothing skipped');
  // READY is evidence, not approval — the report says so, in a field and in a sentence.
  assertEq(report.outcomeIsEvidenceNotApproval, true, 'the report flags that READY is not approval');
  assert(/not an approval|never does/i.test(report.authorityNote), 'and says so in words');
});

// ---------------------------------------------------------------------------------------------------------
// Weakened WORKFLOW fixtures — each must turn its own check to BLOCK (or the whole thing INVALID).
// ---------------------------------------------------------------------------------------------------------

// Normalise to LF so multi-line `.replace` anchors match on a CRLF (Windows) checkout too. The parser reads
// both endings identically, so passing LF text to the core is faithful.
const WORKFLOW = read('.github/workflows/runtime-image.yml').replace(/\r\n/g, '\n');

const PUBLISH_NEEDS = 'needs: [suites, image, bundle, release-candidate, catalog-acceptance, jellyfin-acceptance, lifecycle, rehearsal]';

test('dropping release-candidate from publish.needs blocks the dependency-graph check', () => {
  const weakened = WORKFLOW.replace(PUBLISH_NEEDS, 'needs: [suites, image, bundle, catalog-acceptance, jellyfin-acceptance, lifecycle, rehearsal]');
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'publish-needs-all-gates');
});

test('dropping lifecycle from publish.needs blocks the dependency-graph check', () => {
  const weakened = WORKFLOW.replace(PUBLISH_NEEDS, 'needs: [suites, image, bundle, release-candidate, catalog-acceptance, jellyfin-acceptance, rehearsal]');
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'publish-needs-all-gates');
});

test('dropping the Phase 252 rehearsal from publish.needs blocks the dependency-graph check', () => {
  // The exact defect this remediation closes: publish must not be able to run when the final rehearsal failed.
  // On the pre-fix graph (no rehearsal in publish.needs) this assertion FAILS; with the fix it BLOCKS.
  const weakened = WORKFLOW.replace(PUBLISH_NEEDS, 'needs: [suites, image, bundle, release-candidate, catalog-acceptance, jellyfin-acceptance, lifecycle]');
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'publish-needs-all-gates');
});

test('dropping the Phase 262 catalog acceptance from publish.needs blocks the dependency-graph check', () => {
  // The gate added in Phase 262: a release must be proved to import and browse a catalog, not only to load.
  // On a graph without it this assertion FAILS; with it, the readiness verifier BLOCKS.
  const weakened = WORKFLOW.replace(PUBLISH_NEEDS, 'needs: [suites, image, bundle, release-candidate, lifecycle, rehearsal]');
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'publish-needs-all-gates');
});

test('giving the release-candidate gate an if: (so it can be skipped) blocks the not-skippable check', () => {
  // Insert an `if:` into the release-candidate job, right after its runs-on.
  const anchor = 'release-candidate:\n    name: Release-candidate acceptance (real browser, real Compose)';
  const weakened = WORKFLOW.replace(anchor, `${anchor}\n    if: github.event_name == 'release'`);
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'acceptance-gates-run-on-every-event');
});

test('giving the lifecycle gate an if: blocks the not-skippable check', () => {
  const anchor = 'lifecycle:\n    name: Release lifecycle acceptance (fresh, restart, upgrade, rollback)';
  const weakened = WORKFLOW.replace(anchor, `${anchor}\n    if: github.event_name == 'release'`);
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'acceptance-gates-run-on-every-event');
});

test('giving the Phase 252 rehearsal gate an if: blocks the not-skippable check', () => {
  const anchor = 'rehearsal:\n    name: Final first-release rehearsal and handoff (Phase 252)';
  const weakened = WORKFLOW.replace(anchor, `${anchor}\n    if: github.event_name == 'release'`);
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'acceptance-gates-run-on-every-event');
});

test('a publish if: that uses always() blocks the fail-closed check', () => {
  const weakened = WORKFLOW.replace(
    "if: github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && inputs.publish)",
    "if: always() && (github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && inputs.publish))");
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'publish-fails-closed');
});

test('a non-publish job that grants itself write blocks both permissions and capability checks', () => {
  // Give the `image` job a write permission — the exact defect the whole design forbids.
  const anchor = 'image:\n    name: Build and smoke the production image\n    runs-on: ubuntu-latest';
  const weakened = WORKFLOW.replace(anchor, `${anchor}\n    permissions:\n      contents: write`);
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  const report = evalWith({ workflowText: weakened });
  assertEq(checkOf(report, 'permissions-least-privilege').status, 'BLOCK', 'a non-publish permissions block is caught');
  assertEq(checkOf(report, 'no-publish-capability-outside-publish').status, 'BLOCK', 'and contents: write is a publish capability');
  assertEq(report.outcome, 'BLOCKED', 'the outcome is BLOCKED');
});

test('a registry login in a non-publish job blocks the capability check', () => {
  const anchor = 'run: bash deploy/ci/runtime-image-smoke.sh';
  const weakened = WORKFLOW.replace(anchor, `${anchor}\n      - uses: docker/login-action@v3`);
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'no-publish-capability-outside-publish');
});

test('a build-push-action with push: true in a non-publish job blocks the capability check', () => {
  // `push: true` is a `key: value` pair the flattened text splits, so this exercises the structural scan.
  const anchor = 'run: bash deploy/ci/runtime-image-smoke.sh';
  const weakened = WORKFLOW.replace(anchor,
    `${anchor}\n      - uses: docker/build-push-action@v6\n        with:\n          push: true`);
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'no-publish-capability-outside-publish');
});

test('changing the workflow default permission away from read blocks the least-privilege check', () => {
  const weakened = WORKFLOW.replace('permissions:\n  contents: read', 'permissions:\n  contents: write');
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'permissions-least-privilege');
});

test('a publish job that could push latest blocks the tag-from-gate check', () => {
  const weakened = WORKFLOW.replace(
    'tags: ${{ steps.release.outputs.image_ref }}',
    'tags: |\n            ${{ steps.release.outputs.image_ref }}\n            ghcr.io/cdb8457/catalog-authority-ops:latest');
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'publish-tag-from-tested-gate');
});

test('changing PUBLISH_PLATFORMS blocks the architecture-claim check', () => {
  const weakened = WORKFLOW.replace('PUBLISH_PLATFORMS: linux/amd64', 'PUBLISH_PLATFORMS: linux/amd64,linux/arm64');
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'architecture-claim-single-source');
});

test('dropping a Phase suite from the suites job blocks the acceptance-suites check', () => {
  const weakened = WORKFLOW.replace('npm run test:phase249-local\n', '');
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'suites-run-the-acceptances');
});

// EVERY required suite, attacked individually, FROM THE CHECK'S OWN LIST.
//
// The check above proved the mechanism on ONE suite, which is exactly how a list grows a hole: a suite added
// to the required set but never attacked is a suite whose removal nobody has watched block anything. This
// table used to be a second hand-typed copy under a comment claiming it was derived from the production one —
// which is the same defect one level up. It now imports `REQUIRED_SUITE_SCRIPTS` and
// `REQUIRED_SUITES_TYPECHECK_COMMAND` from the module under test, so a command added to the check and not
// covered here is impossible rather than merely discouraged.
test('removing ANY required suite from the suites job blocks the acceptance-suites check', () => {
  // The suites job's own text is what the check reads, so the mutation has to change THAT text.
  const jobText = WORKFLOW.slice(WORKFLOW.indexOf('  suites:'), WORKFLOW.indexOf('\n  image:'));
  assert(jobText.length > 0, 'the workflow has a suites job to attack');
  assert(REQUIRED_SUITE_SCRIPTS.length >= 9, `the required list is populated (${REQUIRED_SUITE_SCRIPTS.length})`);
  // The Phase 249 mutation above and the Phase 274/275/276 ones are all inside this loop by construction.
  for (const marker of ['test:phase249-local', 'test:phase274-local', 'test:phase275-local', 'test:phase276-local']) {
    assert(REQUIRED_SUITE_SCRIPTS.includes(marker), `${marker} is one of the suites this loop attacks`);
  }
  for (const suite of REQUIRED_SUITE_SCRIPTS) {
    assert(jobText.includes(suite), `the suites job must actually run ${suite} for its removal to mean anything`);
    const weakened = WORKFLOW.replace(`npm run ${suite}\n`, '');
    assert(weakened !== WORKFLOW, `removing ${suite} actually changed the fixture`);
    assertBlocks({ workflowText: weakened }, 'suites-run-the-acceptances');
  }
  // ...and the typecheck, which the check requires in the same breath and which is not a phase suite: the job
  // runs it as a bare step, so removing it is a different edit and the constant is kept separate to say so.
  assert(jobText.includes(REQUIRED_SUITES_TYPECHECK_COMMAND), 'the suites job must actually run the typecheck');
  const noTypecheck = WORKFLOW.replace(`      - run: ${REQUIRED_SUITES_TYPECHECK_COMMAND}\n`, '');
  assert(noTypecheck !== WORKFLOW, 'removing the typecheck actually changed the fixture');
  assertBlocks({ workflowText: noTypecheck }, 'suites-run-the-acceptances');

  // And the check reads EXACTLY these commands and no others — so the loop above is the whole list, not a
  // prefix of it that happens to pass.
  assertEq(REQUIRED_SUITES_JOB_COMMANDS.length, REQUIRED_SUITE_SCRIPTS.length + 1,
    'the commands the check requires are the suites plus the typecheck, and nothing else');
});

test('the suites job name claims no phase range it does not cover', () => {
  // It said "Phase 242-257" while also running the Phase 258 inventory audit, the Phase 266-272 control plane
  // and the Phase 274-276 suites. A reader checking whether a phase is covered reads the job NAME.
  const jobText = WORKFLOW.slice(WORKFLOW.indexOf('  suites:'), WORKFLOW.indexOf('\n  image:'));
  const name = /^\s+name: (.+)$/m.exec(jobText)?.[1] ?? '';
  assert(name.length > 0, 'the suites job is named');
  assert(!/Phase \d+-\d+/.test(name), `the suites job name states a phase range it cannot keep current: ${name}`);
  for (const suite of ['test:phase274-local', 'test:phase275-local', 'test:phase276-local', 'test:inventory']) {
    assert(jobText.includes(suite), `the suites job runs ${suite}, which is why a narrow name would be a lie`);
  }
});

test('publish depending on a gate job that does not exist is a dangling-dependency block', () => {
  // Rename the lifecycle job so `needs` points at a job that no longer exists.
  const weakened = WORKFLOW.replace('\n  lifecycle:\n', '\n  lifecycle-renamed:\n');
  assert(weakened !== WORKFLOW, 'the fixture actually changed');
  assertBlocks({ workflowText: weakened }, 'publish-needs-all-gates');
});

test('a workflow that does not parse makes the outcome INVALID', () => {
  const broken = 'jobs:\n  publish:\n    needs: [suites, image';   // unterminated flow sequence
  const report = evalWith({ workflowText: broken });
  assertEq(checkOf(report, 'publish-needs-all-gates').status, 'INVALID', 'the graph check is INVALID on unparseable YAML');
  assertEq(report.outcome, 'INVALID', 'and the whole outcome is INVALID');
});

// ---------------------------------------------------------------------------------------------------------
// Weakened COORDINATES — drift, floating pins, tampered digests, mismatched names, leaked secrets.
// ---------------------------------------------------------------------------------------------------------

test('a target tag that differs from the shipped bundle version is version drift', () => {
  // Build the bundle for a DIFFERENT tag than the one being released.
  const report = evaluateReleaseReadiness(
    healthyEvidence({ targetTag: 'v9.9.9', bundle: bundleFor('v1.1.0'), archive: buildConsumerReleaseArchive(bundleFor('v1.1.0')) }),
    { generatedAt: AT });
  assertEq(checkOf(report, 'shipped-version-no-drift').status, 'BLOCK', 'the shipped tag differs from the target');
  assertEq(report.outcome, 'BLOCKED', 'the outcome is BLOCKED');
});

test('a non-version target tag blocks the immutable-tag check', () => {
  const report = evaluateReleaseReadiness(
    healthyEvidence({ targetTag: 'latest', bundle: bundleFor('v1.1.0'), archive: buildConsumerReleaseArchive(bundleFor('v1.1.0')) }),
    { generatedAt: AT });
  assertEq(checkOf(report, 'target-tag-immutable').status, 'BLOCK', 'latest is not an immutable tag');
  assertEq(report.outcome, 'BLOCKED', 'the outcome is BLOCKED');
});

test('a floating :latest in the Compose file blocks the no-floating-pins check', () => {
  // Derived from whatever the file actually pins, rather than a hard-coded version. A fixture that names a
  // specific tag stops mutating anything the moment the release moves on, and then asserts nothing while
  // still reporting PASS — which is how a guard quietly stops guarding.
  const floaty = read('docker-compose.runtime.yml').replace(
    /(image: \$\{CATALOG_AUTHORITY_IMAGE:-[^:}]+):v\d+\.\d+\.\d+\}/g, '$1:latest}');
  assert(floaty !== read('docker-compose.runtime.yml'), 'the fixture actually changed');
  assertBlocks({ composeText: floaty }, 'no-floating-image-pins');
});

test('an un-digest-pinned base image blocks the no-floating-pins check', () => {
  const unpinned = read('Dockerfile.runtime').replace(/ARG NODE_IMAGE=node:22-slim@sha256:[0-9a-f]{64}/, 'ARG NODE_IMAGE=node:22-slim');
  assert(unpinned !== read('Dockerfile.runtime'), 'the fixture actually changed');
  assertBlocks({ dockerfileText: unpinned }, 'no-floating-image-pins');
});

test('a tampered archive digest blocks the checksum check', () => {
  const bundle = bundleFor('v1.1.0');
  const archive = buildConsumerReleaseArchive(bundle);
  const tampered: ArchiveResult = { ...archive, sha256: '0'.repeat(64) };
  assertBlocks({ bundle, archive: tampered }, 'archive-and-checksums-verify');
});

test('a mismatched asset name blocks the checksum check', () => {
  const bundle = bundleFor('v1.1.0');
  const archive = buildConsumerReleaseArchive(bundle);
  const renamed: ArchiveResult = { ...archive, filename: 'catalog-authority-operator-ui-v0.0.1.tar.gz' };
  assertBlocks({ bundle, archive: renamed }, 'archive-and-checksums-verify');
});

test('a bundle file whose contents were altered blocks the checksum check', () => {
  const bundle = bundleFor('v1.1.0');
  // Alter README contents WITHOUT updating its digest or SHA256SUMS — a tampered artifact.
  const tamperedBundle: ConsumerReleaseBundle = {
    ...bundle,
    files: bundle.files.map((f) => (f.path === 'README.md' ? { ...f, contents: `${f.contents}\nTAMPERED\n` } : f)),
  };
  assertBlocks({ bundle: tamperedBundle, archive: buildConsumerReleaseArchive(bundle) }, 'archive-and-checksums-verify');
});

test('a secret smuggled into a bundle file blocks the redaction check', () => {
  const bundle = bundleFor('v1.1.0');
  const withSecret: ConsumerReleaseBundle = {
    ...bundle,
    files: bundle.files.map((f) => (f.path === 'README.md'
      ? { ...f, contents: `${f.contents}\n-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n` }
      : f)),
  };
  // Rebuild digests so the checksum check would pass, isolating the redaction check.
  const rebuilt = rebuildDigests(withSecret);
  assertBlocks({ bundle: rebuilt, archive: buildConsumerReleaseArchive(rebuilt) }, 'bundle-carries-no-secret-or-live-data');
});

test('the Movies library path in a bundle file blocks the redaction check', () => {
  const bundle = bundleFor('v1.1.0');
  const withPath: ConsumerReleaseBundle = {
    ...bundle,
    files: bundle.files.map((f) => (f.path === 'README.md' ? { ...f, contents: `${f.contents}\n/mnt/user/media/Movies\n` } : f)),
  };
  const rebuilt = rebuildDigests(withPath);
  assertBlocks({ bundle: rebuilt, archive: buildConsumerReleaseArchive(rebuilt) }, 'bundle-carries-no-secret-or-live-data');
});

// Recompute each file's sha256 and rebuild the SHA256SUMS + manifest so ONLY the check under test fails.
function rebuildDigests(bundle: ConsumerReleaseBundle): ConsumerReleaseBundle {
  const sha = (t: string): string => createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex');
  const withOwnDigests = bundle.files
    .filter((f) => f.path !== 'SHA256SUMS')
    .map((f) => ({ ...f, sha256: sha(f.contents) }));
  const sumsContents = `${withOwnDigests.map((f) => `${f.sha256}  ${f.path}`).join('\n')}\n`;
  const sumsFile = bundle.files.find((f) => f.path === 'SHA256SUMS');
  const files = [
    ...withOwnDigests,
    ...(sumsFile === undefined ? [] : [{ ...sumsFile, contents: sumsContents, sha256: sha(sumsContents) }]),
  ];
  return { ...bundle, files };
}

test('an image repository outside the owner namespace blocks the owned-repository check', () => {
  const bundle = bundleFor('v1.1.0');
  const wrongRepo: ConsumerReleaseBundle = { ...bundle, image: { ...bundle.image, repository: 'ghcr.io/someone-else/catalog-authority-ops' } };
  assertBlocks({ bundle: wrongRepo, archive: buildConsumerReleaseArchive(bundle) }, 'image-repository-owned');
});

// ---------------------------------------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------------------------------------

test('a README missing the honest rollback note blocks the docs check', () => {
  const bundle = bundleFor('v1.1.0');
  const noNote: ConsumerReleaseBundle = {
    ...bundle,
    files: bundle.files.map((f) => (f.path === 'README.md'
      ? { ...f, contents: f.contents.replace('Rolling the image back does not roll data back', 'rollback is instant') }
      : f)),
  };
  assertBlocks({ bundle: rebuildDigests(noNote), archive: buildConsumerReleaseArchive(rebuildDigests(noNote)) }, 'docs-install-upgrade-rollback');
});

test('a missing release doc blocks the docs-present check', () => {
  assertBlocks({ presentDocs: PRESENT_DOCS.filter((d) => !d.includes('249')) }, 'release-docs-present');
});

// ---------------------------------------------------------------------------------------------------------
// Git checkout state
// ---------------------------------------------------------------------------------------------------------

test('a dirty working tree blocks the clean-checkout check', () => {
  assertBlocks({ git: { ...HEALTHY_GIT, clean: false } }, 'git-clean-checkout');
});

test('a local tag that is not at HEAD blocks the head-at-tag check (wrong ref/tag)', () => {
  assertBlocks({ git: { ...HEALTHY_GIT, localTagPresent: true, localTagAtHead: false } }, 'git-head-at-release-tag');
});

test('no Git makes the checkout checks NOT_RUN, and the outcome NOT_RUN when nothing else blocks', () => {
  const report = evalWith({ git: { available: false, clean: false, head: '', localTagPresent: false, localTagAtHead: false } });
  assertEq(checkOf(report, 'git-clean-checkout').status, 'NOT_RUN', 'clean check is not run without Git');
  assertEq(checkOf(report, 'git-head-at-release-tag').status, 'NOT_RUN', 'tag check is not run without Git');
  assertEq(report.outcome, 'NOT_RUN', 'the whole outcome is NOT_RUN — readiness is not claimed on incomplete evidence');
});

test('a tag not present locally is NOT_RUN, not a false BLOCK', () => {
  const report = evalWith({ git: { ...HEALTHY_GIT, localTagPresent: false, localTagAtHead: false } });
  assertEq(checkOf(report, 'git-head-at-release-tag').status, 'NOT_RUN', 'no local tag -> cannot verify offline -> NOT_RUN');
  assertEq(report.outcome, 'NOT_RUN', 'and the outcome is NOT_RUN');
});

// ---------------------------------------------------------------------------------------------------------
// Outcome precedence
// ---------------------------------------------------------------------------------------------------------

test('precedence is INVALID > BLOCKED > NOT_RUN > READY', () => {
  // BLOCKED beats NOT_RUN: a dirty tree (BLOCK) while a tag is absent (NOT_RUN) -> BLOCKED.
  const blockedAndNotRun = evalWith({
    git: { available: true, clean: false, head: 'a'.repeat(40), localTagPresent: false, localTagAtHead: false },
  });
  assertEq(blockedAndNotRun.outcome, 'BLOCKED', 'BLOCK outranks NOT_RUN');
  // INVALID beats BLOCKED: an unparseable workflow (INVALID) while the tree is dirty (BLOCK) -> INVALID.
  const invalidAndBlocked = evalWith({
    workflowText: 'jobs:\n  publish:\n    needs: [suites',
    git: { ...HEALTHY_GIT, clean: false },
  });
  assertEq(invalidAndBlocked.outcome, 'INVALID', 'INVALID outranks BLOCKED');
});

// ---------------------------------------------------------------------------------------------------------
// Self-digest, redaction, exit codes, rendering
// ---------------------------------------------------------------------------------------------------------

test('the self-digest is deterministic for the same evidence and changes when the verdict changes', () => {
  const a = evalWith();
  const b = evalWith();
  assertEq(a.selfDigest, b.selfDigest, 'same evidence -> same self-digest');
  assert(a.selfDigest.length === 64, 'the self-digest is a sha256');
  const dirty = evalWith({ git: { ...HEALTHY_GIT, clean: false } });
  assert(dirty.selfDigest !== a.selfDigest, 'a changed verdict changes the self-digest');
  // The digest ignores the wall clock, so a report is reproducible.
  const later = evaluateReleaseReadiness(healthyEvidence(), { generatedAt: '2099-12-31T23:59:59.000Z' });
  assertEq(later.selfDigest, a.selfDigest, 'the self-digest is independent of generatedAt');
});

test('the rendered report is redaction-safe, in JSON and text', () => {
  const report = evalWith();
  const json = renderReadinessJson(report);
  const text = renderReadinessText(report);
  for (const rendered of [json, text]) {
    assert(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(rendered), 'no private key');
    assert(!/\bghp_[A-Za-z0-9]{20,}\b/.test(rendered), 'no GitHub token');
    assert(!/postgres(?:ql)?:\/\/[^\s:@/]+:[^\s:@/]{6,}@/.test(rendered), 'no database URL with a password');
    assert(!/\/mnt\/user\/media\/Movies/i.test(rendered), 'no Movies path');
    assert(!/[A-Za-z]:\\Users\\/.test(rendered), 'no Windows user path');
  }
  // The gate refuses genuinely unsafe content.
  let threw = false;
  try { assertReadinessReportIsRedactionSafe('leak: -----BEGIN RSA PRIVATE KEY-----'); } catch (err) {
    threw = err instanceof ReleaseReadinessError;
  }
  assert(threw, 'the redaction gate refuses a private key');
  // But it allows the legitimate 64-hex digests the report is built around.
  assertReadinessReportIsRedactionSafe(`digest ${'a'.repeat(64)}`);
});

test('the exit codes are fixed and distinct', () => {
  assertEq(READINESS_EXIT_CODES.READY_FOR_HUMAN_RELEASE_DECISION, 0, 'READY is 0');
  assertEq(READINESS_EXIT_CODES.BLOCKED, 10, 'BLOCKED is 10');
  assertEq(READINESS_EXIT_CODES.INVALID, 11, 'INVALID is 11');
  assertEq(READINESS_EXIT_CODES.NOT_RUN, 12, 'NOT_RUN is 12');
  const codes = Object.values(READINESS_EXIT_CODES);
  assertEq(new Set(codes).size, codes.length, 'the exit codes are distinct');
});

// ---------------------------------------------------------------------------------------------------------
// The CLI is read-only and non-publishing, and maps outcomes to the fixed exit codes.
// ---------------------------------------------------------------------------------------------------------

test('the CLI source performs no publish, push, tag, login, or network action', () => {
  const cli = read('src/ops/release-readiness-cli.ts');
  for (const forbidden of [
    'docker push', 'docker login', 'docker/login', 'git push', 'git tag ', 'gh release',
    'npm publish', 'git commit', 'git merge', 'fetch(', 'https://', 'http://',
  ]) {
    assert(!cli.includes(forbidden), `the CLI never does: ${forbidden}`);
  }
  // git is used only with read-only subcommands.
  const gitCalls = [...cli.matchAll(/git\(\[([^\]]*)\]/g)].map((m) => m[1]!);
  for (const call of gitCalls) {
    assert(/'(status|rev-parse|rev-list)'/.test(call), `git call is read-only: ${call}`);
  }
});

test('the CLI runs against the real checkout and exits with a fixed readiness code', () => {
  const run = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/ops/release-readiness-cli.ts'), '--generated-at', AT],
    { cwd: root, encoding: 'utf8', timeout: 300000 });
  const outcomes: readonly ReadinessOutcome[] = ['READY_FOR_HUMAN_RELEASE_DECISION', 'BLOCKED', 'INVALID', 'NOT_RUN'];
  assert(outcomes.includes(JSON.parse(run.stdout || '{}').outcome), 'it prints a bounded outcome');
  assert([0, 10, 11, 12].includes(run.status ?? -1), `it exits with a fixed readiness code, got ${String(run.status)}`);
  // Whatever the outcome here, the CLI must never have printed a secret.
  assert(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(run.stdout ?? ''), 'no private key in the output');
});

// ---------------------------------------------------------------------------------------------------------
// Docs and package wiring
// ---------------------------------------------------------------------------------------------------------

test('the Phase 250 doc and package scripts are present and consistent', () => {
  assert(existsSync(join(root, 'docs/PHASE_250_RELEASE_READINESS.md')), 'the Phase 250 doc exists');
  const doc = read('docs/PHASE_250_RELEASE_READINESS.md');
  for (const required of [
    'Phase 250', 'ops:release-readiness', 'READY_FOR_HUMAN_RELEASE_DECISION', 'BLOCKED', 'INVALID', 'NOT_RUN',
    'evidence', 'never', 'exit',
  ]) {
    assert(doc.includes(required), `the doc mentions ${required}`);
  }
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['ops:release-readiness'], 'tsx src/ops/release-readiness-cli.ts', 'the ops script is wired');
  assertEq(pkg.scripts['test:release-readiness'], 'tsx test/release-readiness.ts', 'the test script is wired');
  assertEq(pkg.scripts['test:phase250-local'], 'tsx test/release-readiness.ts', 'the phase250-local alias is wired');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
