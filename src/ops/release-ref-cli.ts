import { appendFileSync } from 'node:fs';
import { decideRelease, type ReleaseEventContext } from './release-ref.js';

// The gate the release workflow asks before it publishes anything.
//
// It reads the GitHub event context from the environment, runs the pure decision, and either prints a
// refusal and exits non-zero, or writes the resolved tag and image reference to `$GITHUB_OUTPUT` so that
// every later step names the SAME thing. No step downstream is allowed to re-derive a tag from
// `github.ref_name` — the whole point is that the tag is decided once, here, where it can be tested.
//
// It is runnable locally: `--event release --release-tag v1.2.3 --ref refs/tags/v1.2.3` reproduces exactly
// what CI would decide, which is how the adversarial fixtures in the test suite exercise it.

function usage(): string {
  return [
    'usage: ops:release-ref [--event <name>] [--ref <refs/...>] [--release-tag <tag>] [--draft]',
    '                       [--publish-input <true|false>] [--repository <owner/name>] [--owner <owner>]',
    '                       [--image-repository <registry/owner/name>] [--json]',
    '',
    'Decides whether a run may publish, and under exactly which tag and image reference. Exits 0 and prints',
    'the decision when publishing is authorised, 1 with a reason when it is refused. Defaults come from the',
    'GitHub Actions environment, so CI passes no arguments at all.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function contextFromArgs(args: readonly string[]): ReleaseEventContext {
  const repository = valueAfter(args, '--repository') ?? process.env.GITHUB_REPOSITORY ?? '';
  const owner = valueAfter(args, '--owner') ?? process.env.GITHUB_REPOSITORY_OWNER ?? repository.split('/')[0] ?? '';
  const releaseTag = valueAfter(args, '--release-tag') ?? process.env.RELEASE_TAG_NAME;
  const publishInput = valueAfter(args, '--publish-input') ?? process.env.RELEASE_PUBLISH_INPUT;
  const override = valueAfter(args, '--image-repository') ?? process.env.CATALOG_AUTHORITY_IMAGE_REPOSITORY;
  const draft = args.includes('--draft') ? true : process.env.RELEASE_DRAFT === 'true';
  return {
    eventName: valueAfter(args, '--event') ?? process.env.GITHUB_EVENT_NAME ?? 'unknown',
    ...(valueAfter(args, '--ref') ?? process.env.GITHUB_REF ? { ref: valueAfter(args, '--ref') ?? process.env.GITHUB_REF } : {}),
    ...(releaseTag === undefined || releaseTag === '' ? {} : { releaseTagName: releaseTag }),
    releaseDraft: draft,
    ...(publishInput === undefined ? {} : { publishInput }),
    repository,
    repositoryOwner: owner,
    ...(override === undefined || override === '' ? {} : { imageRepositoryOverride: override }),
  };
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }

  const decision = decideRelease(contextFromArgs(args));
  if (!decision.publish) {
    console.error(`release refused: ${decision.reason}`);
    return 1;
  }

  console.log(JSON.stringify({
    report: 'phase-245-release-ref',
    publish: true,
    authority: decision.authority,
    tag: decision.tag,
    imageRepository: decision.imageRepository,
    imageRef: decision.imageRef,
    archive: decision.archiveName,
  }, null, 2));

  const output = process.env.GITHUB_OUTPUT;
  if (output !== undefined && output !== '') {
    appendFileSync(output, [
      `tag=${decision.tag}`,
      `image_repository=${decision.imageRepository}`,
      `image_ref=${decision.imageRef}`,
      `archive=${decision.archiveName}`,
      '',
    ].join('\n'));
  }
  return 0;
}

process.exit(main());
