import {
  checkImageIsPubliclyPullable,
  MAKE_PUBLIC_INSTRUCTIONS,
  MANIFEST_ACCEPT_TYPES,
} from './image-pull-preflight.js';
import { RELEASE_IMAGE_REPOSITORY } from './release-coordinates.js';
import { RELEASE_IMAGE_TAG } from './consumer-release-bundle.js';

/**
 * Phase 254 — can a stranger pull what this release tells them to pull?
 *
 *   npm run ops:image-pull-preflight
 *   npm run ops:image-pull-preflight -- --reference v1.1.1
 *   npm run ops:image-pull-preflight -- --reference sha256:<digest> --expect-digest sha256:<digest>
 *   npm run ops:image-pull-preflight -- --json
 *
 * Anonymous by design: it uses no credential, because proving that WE can pull proves the wrong thing. It
 * pulls no layers, starts nothing, contacts no provider or media server, and changes nothing anywhere.
 *
 * Exits non-zero on any BLOCKER, so it can gate a release.
 */
const args = process.argv.slice(2);
const valueAfter = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const repository = valueAfter('--repository')
  ?? RELEASE_IMAGE_REPOSITORY.replace(/^ghcr\.io\//, '');
const reference = valueAfter('--reference') ?? RELEASE_IMAGE_TAG;
const expectedDigest = valueAfter('--expect-digest') ?? null;
const json = args.includes('--json');

const report = await checkImageIsPubliclyPullable({ repository, reference, expectedDigest });

if (json) {
  console.log(JSON.stringify(report));
} else {
  console.log('Catalog Authority — anonymous image pull preflight\n');
  console.log(`  repository   ghcr.io/${repository}`);
  console.log(`  reference    ${reference}`);
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
  console.log(`\n  Manifest media types accepted (all of these, or a public multi-arch image reads as absent):`);
  for (const type of MANIFEST_ACCEPT_TYPES) console.log(`    ${type}`);
  console.log(`\n${report.ok ? 'image pull preflight: PASS' : 'image pull preflight: BLOCKED'}`);
  console.log(`\n${report.note}`);
}

process.exit(report.ok ? 0 : 1);
