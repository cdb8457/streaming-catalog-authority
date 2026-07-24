import {
  RELEASE_IMAGE_REPOSITORY,
  RELEASE_REPOSITORY,
  ReleaseCoordinatesError,
  assertRepositoryMatchesCoordinates,
} from './release-coordinates.js';

// Does the repository this is running in match the release coordinates checked into it?
//
// Constants go stale silently. A fork, a rename or a copied-in placeholder leaves the source claiming one
// namespace while the runner sits in another, and the first anyone hears of it is a registry rejection
// during a release — or worse, a README telling users to pull an image that will never exist. CI runs this
// on every push, so the drift is a failed check on the change that caused it.

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('usage: ops:release-coordinates [--repository <owner/name>]');
    return 0;
  }
  const repository = valueAfter(args, '--repository') ?? process.env.GITHUB_REPOSITORY ?? RELEASE_REPOSITORY;
  try {
    assertRepositoryMatchesCoordinates(repository);
  } catch (err) {
    console.error(err instanceof ReleaseCoordinatesError ? err.message : 'release coordinates check failed safely');
    return 1;
  }
  console.log(JSON.stringify({
    report: 'phase-245-release-coordinates',
    repository,
    imageRepository: RELEASE_IMAGE_REPOSITORY,
    matches: true,
  }, null, 2));
  return 0;
}

process.exit(main());
