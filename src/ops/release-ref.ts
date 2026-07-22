import {
  RELEASE_IMAGE_PACKAGE,
  RELEASE_IMAGE_REGISTRY,
  ReleaseCoordinatesError,
  assertRepositoryMatchesCoordinates,
  resolveImageRepository,
} from './release-coordinates.js';

// May this run publish, and if so, as exactly what?
//
// The previous version of this decision was `github.ref_name` interpolated into a shell script. `ref_name`
// means different things on different events — a branch on `push`, a tag on `release`, the dispatched ref on
// `workflow_dispatch` — so a single reading of it is only correct by luck, and nothing checked that the tag
// an image was published under was the tag the release actually announced. A release that publishes
// `v1.2.3` while GitHub shows `v1.2.4` is worse than a failed release.
//
// So the decision is a pure function over the event context, it fails closed on everything it does not
// positively recognise, and it is exercised directly by tests with adversarial inputs rather than only by a
// workflow nobody can run locally.

export class ReleaseRefError extends Error {}

export interface ReleaseEventContext {
  /** `github.event_name`. */
  readonly eventName: string;
  /** `github.ref` — the full ref, not `ref_name`, because only the full ref says what KIND of thing it is. */
  readonly ref?: string;
  /** `github.event.release.tag_name`, present only on a release event. */
  readonly releaseTagName?: string;
  /** `github.event.release.draft` / `.prerelease`. */
  readonly releaseDraft?: boolean;
  /** `inputs.publish` on a manual dispatch. Anything other than a true boolean is a refusal. */
  readonly publishInput?: boolean | string;
  /** `github.repository` — `owner/name`. */
  readonly repository: string;
  /** `github.repository_owner`. */
  readonly repositoryOwner: string;
  /** Optional operator-supplied image repository. */
  readonly imageRepositoryOverride?: string;
}

export interface ReleaseRefused {
  readonly publish: false;
  readonly reason: string;
}

export interface ReleaseApproved {
  readonly publish: true;
  /** The immutable version tag, identical for the image, the bundle and the release asset. */
  readonly tag: string;
  readonly imageRepository: string;
  readonly imageRef: string;
  readonly archiveName: string;
  /** Which event authorised it — recorded so a log says why a publish happened. */
  readonly authority: 'published-release' | 'version-tag-dispatch';
}

export type ReleaseDecision = ReleaseApproved | ReleaseRefused;

/** vX.Y.Z with an optional pre-release suffix. Nothing else is a release. */
const VERSION_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const TAG_REF = /^refs\/tags\/(.+)$/;

export function isVersionTag(tag: string): boolean {
  return tag !== 'latest' && VERSION_TAG.test(tag);
}

function refuse(reason: string): ReleaseRefused {
  return { publish: false, reason };
}

/** The tag a ref names, or null when the ref is not a tag at all (a branch, a PR merge ref, nonsense). */
function tagFromRef(ref: string | undefined): string | null {
  if (ref === undefined || ref.trim() === '') return null;
  const match = TAG_REF.exec(ref.trim());
  return match === null ? null : match[1]!;
}

function isTrue(input: boolean | string | undefined): boolean {
  return input === true || input === 'true';
}

/**
 * Decide whether a run may publish, and under exactly which coordinates.
 *
 * Fails closed: every path that is not a published release of a version tag, or a manual dispatch that
 * explicitly asked to publish FROM a version tag, is a refusal with a reason. A refusal is a normal outcome,
 * not an error — a pull request is supposed to reach this and be told no.
 */
export function decideRelease(context: ReleaseEventContext): ReleaseDecision {
  const refTag = tagFromRef(context.ref);

  let tag: string;
  let authority: ReleaseApproved['authority'];

  switch (context.eventName) {
    case 'release': {
      const announced = context.releaseTagName?.trim() ?? '';
      if (announced === '') return refuse('the release event carried no tag_name');
      if (context.releaseDraft === true) return refuse('a draft release publishes nothing');
      // GitHub sets `github.ref` to the release's tag ref. When a ref is present at all it must BE that tag:
      // a release event running on a branch ref, or on a different tag, is not a run whose meaning is clear,
      // and the safe reading of an unclear release is neither of the two things it might mean.
      if (context.ref !== undefined && context.ref.trim() !== '') {
        if (refTag === null) return refuse(`a release must run on a tag ref, not ${context.ref}`);
        if (refTag !== announced) return refuse(`the release announces ${announced} but the run is on ${refTag}`);
      }
      tag = announced;
      authority = 'published-release';
      break;
    }
    case 'workflow_dispatch': {
      if (!isTrue(context.publishInput)) return refuse('a manual dispatch publishes only when it explicitly asks to');
      if (refTag === null) return refuse(`a manual publish must run from a tag, not ${context.ref ?? '(no ref)'}`);
      tag = refTag;
      authority = 'version-tag-dispatch';
      break;
    }
    default:
      return refuse(`${context.eventName} never publishes`);
  }

  if (tag === 'latest') return refuse('`latest` is not a release: it is a name that moves');
  if (!isVersionTag(tag)) return refuse(`${tag} is not an immutable vX.Y.Z release tag`);

  try {
    assertRepositoryMatchesCoordinates(context.repository);
  } catch (err) {
    return refuse((err as ReleaseCoordinatesError).message);
  }
  // The owner in `github.repository` and the standalone owner context must agree; if they do not, the run is
  // not describing a single repository and nothing should be pushed anywhere.
  const ownerFromRepository = context.repository.split('/')[0] ?? '';
  if (ownerFromRepository.toLowerCase() !== context.repositoryOwner.trim().toLowerCase()) {
    return refuse(`repository ${context.repository} and owner ${context.repositoryOwner} disagree`);
  }

  let imageRepository: string;
  try {
    imageRepository = resolveImageRepository({
      owner: context.repositoryOwner,
      packageName: RELEASE_IMAGE_PACKAGE,
      registry: RELEASE_IMAGE_REGISTRY,
      ...(context.imageRepositoryOverride === undefined ? {} : { override: context.imageRepositoryOverride }),
    });
  } catch (err) {
    return refuse((err as ReleaseCoordinatesError).message);
  }

  return {
    publish: true,
    tag,
    imageRepository,
    imageRef: `${imageRepository}:${tag}`,
    archiveName: releaseArchiveName(tag),
    authority,
  };
}

/** The consumer download's filename. One name, derived from the tag, used by the builder and the workflow. */
export function releaseArchiveName(tag: string): string {
  if (!isVersionTag(tag)) throw new ReleaseRefError(`not a version tag: ${tag}`);
  return `catalog-authority-operator-ui-${tag}.tar.gz`;
}

/**
 * Everything a release publishes must carry the same version.
 *
 * The image tag, the bundle's version metadata and the release asset's name are three copies of one fact,
 * and three copies is how a release ends up half-labelled. This is the single place they are compared.
 */
export function assertReleaseConsistency(input: {
  readonly tag: string;
  readonly bundleVersion: string;
  readonly archiveName: string;
  readonly imageRef: string;
}): void {
  if (!isVersionTag(input.tag)) throw new ReleaseRefError(`not a version tag: ${input.tag}`);
  if (input.bundleVersion !== input.tag) {
    throw new ReleaseRefError(`the bundle says ${input.bundleVersion} but the release is ${input.tag}`);
  }
  if (input.archiveName !== releaseArchiveName(input.tag)) {
    throw new ReleaseRefError(`the archive is named ${input.archiveName}, expected ${releaseArchiveName(input.tag)}`);
  }
  const imageTag = input.imageRef.includes('@') ? null : input.imageRef.slice(input.imageRef.lastIndexOf(':') + 1);
  if (imageTag !== null && imageTag !== input.tag) {
    throw new ReleaseRefError(`the image is tagged ${imageTag} but the release is ${input.tag}`);
  }
}
