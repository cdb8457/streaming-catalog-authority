import {
  checkImageIsPubliclyPullable,
  MAKE_PUBLIC_INSTRUCTIONS,
  MANIFEST_ACCEPT_TYPES,
} from './image-pull-preflight.js';
import {
  NPM_FORWARDING_HINT,
  PULL_EXPECT_DIGEST_ENV,
  PULL_REFERENCE_ENV,
  PULL_REPOSITORY_ENV,
  resolvePreflightRequest,
} from './image-pull-preflight-request.js';
import { RELEASE_IMAGE_REPOSITORY } from './release-coordinates.js';
import { RELEASE_IMAGE_TAG } from './consumer-release-bundle.js';

/**
 * Phase 254 — can a stranger pull what this release tells them to pull?
 *
 * HOW TO INVOKE IT, IN ORDER OF RELIABILITY.
 *
 *   1. Environment variables. The only form CI uses, and the only one that cannot be mangled by an argument
 *      parser between the caller and this process:
 *
 *        CATALOG_AUTHORITY_PULL_REFERENCE=v1.1.1 \
 *        CATALOG_AUTHORITY_PULL_EXPECT_DIGEST=sha256:<digest> \
 *          npm run ops:image-pull-preflight
 *
 *      On Windows PowerShell:
 *        $env:CATALOG_AUTHORITY_PULL_REFERENCE="v1.1.1"
 *        $env:CATALOG_AUTHORITY_PULL_EXPECT_DIGEST="sha256:<digest>"
 *        npm run ops:image-pull-preflight
 *
 *   2. Direct invocation with flags, which never passes through npm's argument handling:
 *
 *        npx tsx src/ops/image-pull-preflight-cli.ts --reference v1.1.1 --expect-digest sha256:<digest>
 *
 *   3. `npm run ... -- --reference v1.1.1 …` works on some npm versions and NOT on others. It is supported,
 *      but if your npm eats the flag names this CLI will refuse the leftover values rather than quietly
 *      checking the default reference. That refusal is the feature.
 *
 * Anonymous by design: it uses no credential, because proving that WE can pull proves the wrong thing. It
 * pulls no layers, starts nothing, contacts no provider or media server, and changes nothing anywhere.
 *
 * Exits non-zero on any BLOCKER or on any input it cannot resolve unambiguously.
 */
const resolution = resolvePreflightRequest(process.argv.slice(2), process.env, {
  defaultReference: RELEASE_IMAGE_TAG,
  defaultRepository: RELEASE_IMAGE_REPOSITORY.replace(/^ghcr\.io\//, ''),
});

if (!resolution.ok) {
  // Refusing is the whole point: the alternative is checking something the caller did not ask about and
  // reporting a green tick for it.
  console.error(`image pull preflight: ${resolution.failure.code}`);
  console.error(`  ${resolution.failure.message}`);
  console.error('');
  console.error('  Nothing was checked. No default reference was substituted.');
  console.error(`  ${NPM_FORWARDING_HINT}`);
  process.exit(2);
}

const { repository, reference, expectedDigest, json } = resolution.request;

const report = await checkImageIsPubliclyPullable({ repository, reference, expectedDigest });

if (json) {
  console.log(JSON.stringify(report));
} else {
  console.log('Catalog Authority — anonymous image pull preflight\n');
  console.log(`  repository   ghcr.io/${repository}`);
  console.log(`  reference    ${reference}`);
  // Echoed so a reader can SEE which reference was actually checked. The failure this command was hardened
  // against is one where the reference silently differed from the one the caller asked for.
  console.log(`  expecting    ${expectedDigest ?? '(no digest supplied — identity will not be verified)'}`);
  console.log(`  outcome      ${report.outcome}`);
  console.log(`  digest       ${report.observedDigest ?? '(none returned)'}`);
  console.log('');
  if (report.findings.length === 0) {
    console.log('  OK — an anonymous caller can fetch this image, which is what a consumer does.');
  } else {
    for (const finding of report.findings) {
      console.log(`  ${finding.severity.padEnd(9)} ${finding.code}`);
      console.log(`            ${finding.detail}`);
      console.log(`            Do: ${finding.fix}\n`);
    }
  }
  if (!report.ok && report.outcome === 'NOT_PUBLIC') {
    console.log('\n  Exact steps:');
    for (const step of MAKE_PUBLIC_INSTRUCTIONS) console.log(`    - ${step}`);
  }
  // Stated every run, because the one way this check can lie is by accepting too few media types.
  console.log('\n  Manifest media types accepted (all of these, or a public multi-arch image reads as absent):');
  for (const type of MANIFEST_ACCEPT_TYPES) console.log(`    ${type}`);
  console.log(`\n  Inputs may also be supplied as ${PULL_REPOSITORY_ENV} / ${PULL_REFERENCE_ENV} / ${PULL_EXPECT_DIGEST_ENV}.`);
  console.log(`\n${report.ok ? 'image pull preflight: PASS' : 'image pull preflight: BLOCKED'}`);
  console.log(`\n${report.note}`);
}

process.exit(report.ok ? 0 : 1);
