// Phase 246 — what is actually running, said honestly.
//
// "Which version am I on?" is the first question support asks and the one this stack could not answer. The
// image carried OCI labels, which are build metadata a running process cannot read; the bundle carried a
// VERSION file, which the container never sees; and the UI carried nothing at all. Three artifacts, no shared
// fact, and no way for a user to notice that the image they are running is not the one their bundle
// describes.
//
// So there are now TWO independent declarations and the disagreement between them is itself reported:
//
//   * the IMAGE declares itself. Dockerfile.runtime bakes CATALOG_AUTHORITY_VERSION / _REVISION / _BUILT_AT
//     into the image from build arguments, so the value travels with the layers and cannot be changed by
//     anyone who merely runs the container.
//   * the BUNDLE declares what it believes it deployed. The release bundle writes
//     CATALOG_AUTHORITY_BUNDLE_VERSION into its .env, and Compose passes it in.
//
// Equal is `AGREES`. Different is `MISMATCH`, and a mismatch is a DEGRADED installation rather than a note in
// a corner, because "the bundle you extracted and the image you are running are different releases" is
// exactly the failure that otherwise gets discovered three hours into a support thread.
//
// NOTHING IS EVER INVENTED. There is no fallback to a package.json version, no reading of a git directory, no
// "probably the latest". A value that is absent, malformed, or the development placeholder is reported as
// such. A wrong version is worse than an unknown one: an unknown version makes a person go and look, and a
// confidently wrong one stops them looking.

/** The image's own claim about itself, baked in at build time. */
export const RUNTIME_VERSION_ENV = 'CATALOG_AUTHORITY_VERSION';
export const RUNTIME_REVISION_ENV = 'CATALOG_AUTHORITY_REVISION';
export const RUNTIME_BUILT_AT_ENV = 'CATALOG_AUTHORITY_BUILT_AT';
/** What the release bundle believes it deployed, passed through Compose from the bundle's .env. */
export const RUNTIME_BUNDLE_VERSION_ENV = 'CATALOG_AUTHORITY_BUNDLE_VERSION';
/** The image reference Compose resolved. Parsed, never echoed — see `describeImageRef`. */
export const RUNTIME_IMAGE_REF_ENV = 'CATALOG_AUTHORITY_IMAGE';

/**
 * The values Dockerfile.runtime bakes when nobody passes a build argument — a maintainer's `docker build`
 * with no `--build-arg`. They are deliberately NOT version-shaped in a way that could be mistaken for a
 * release, and they are recognised here so such a build reports DEVELOPMENT rather than a fake release.
 */
export const DEVELOPMENT_VERSION = '0.0.0-dev';
export const UNKNOWN_REVISION = 'unknown';

const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REVISION_PATTERN = /^[0-9a-f]{7,40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
/** `host[:port]/path/segments`, each segment lowercase — the shape a registry actually accepts. */
const REPOSITORY_PATTERN = /^[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

/** How much a declaration can be trusted. Bounded: a consumer switches on these and nothing else. */
export type VersionProvenance = 'RELEASE' | 'DEVELOPMENT' | 'UNKNOWN';

/** Whether the image's claim and the bundle's claim line up. */
export type VersionAgreement = 'AGREES' | 'MISMATCH' | 'UNKNOWN';

export interface ImageRefView {
  readonly state: 'PARSED' | 'ABSENT' | 'MALFORMED';
  /** `ghcr.io/owner/name`, only when it parsed. Never the raw environment value. */
  readonly repository: string | null;
  readonly tag: string | null;
  readonly pinnedByDigest: boolean;
  /** Whether the tag is a moving one. A release must never be pinned to `latest`. */
  readonly movingTag: boolean;
}

export interface RuntimeVersionView {
  readonly report: 'phase-246-runtime-version';
  readonly version: string | null;
  readonly revision: string | null;
  readonly builtAt: string | null;
  readonly provenance: VersionProvenance;
  readonly bundleVersion: string | null;
  readonly agreement: VersionAgreement;
  readonly image: ImageRefView;
  /** Fixed sentences. Never interpolates an environment value. */
  readonly notes: readonly string[];
}

/**
 * Read a declaration, or decide it does not have one.
 *
 * Anything that fails its shape check becomes `null`. That is the whole trick: a malformed value is not
 * repaired, not passed through, and not echoed anywhere a person could mistake it for a fact.
 */
function readShaped(env: NodeJS.ProcessEnv, name: string, pattern: RegExp): string | null {
  const raw = env[name];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > 128) return null;
  return pattern.test(trimmed) ? trimmed : null;
}

/**
 * Describe an image reference by its parts, and never by repeating it.
 *
 * The raw value is an operator-supplied environment string that ends up on an authenticated page and in a
 * support report. Echoing it would put whatever they typed — a private registry host, a typo, a fragment of
 * markup — into both. Parsing it into known-shaped fields means only values this function recognises can be
 * displayed, and an unrecognised one becomes `MALFORMED` with nothing repeated back.
 */
export function describeImageRef(raw: string | undefined): ImageRefView {
  const absent: ImageRefView = { state: 'ABSENT', repository: null, tag: null, pinnedByDigest: false, movingTag: false };
  const malformed: ImageRefView = { state: 'MALFORMED', repository: null, tag: null, pinnedByDigest: false, movingTag: false };
  if (typeof raw !== 'string' || raw.trim() === '') return absent;
  const value = raw.trim();
  if (value.length > 512) return malformed;

  const atIndex = value.indexOf('@');
  if (atIndex !== -1) {
    const repository = value.slice(0, atIndex).split(':')[0] ?? '';
    const digest = value.slice(atIndex + 1);
    if (!REPOSITORY_PATTERN.test(repository) || !DIGEST_PATTERN.test(digest)) return malformed;
    return { state: 'PARSED', repository, tag: null, pinnedByDigest: true, movingTag: false };
  }

  // A colon is only a tag separator when it comes after the last slash; `registry:5000/name` has none.
  const lastSlash = value.lastIndexOf('/');
  const colon = value.indexOf(':', lastSlash === -1 ? 0 : lastSlash);
  if (colon === -1) {
    if (!REPOSITORY_PATTERN.test(value)) return malformed;
    return { state: 'PARSED', repository: value, tag: null, pinnedByDigest: false, movingTag: true };
  }
  const repository = value.slice(0, colon);
  const tag = value.slice(colon + 1);
  if (!REPOSITORY_PATTERN.test(repository) || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) return malformed;
  return { state: 'PARSED', repository, tag, pinnedByDigest: false, movingTag: tag === 'latest' };
}

function provenanceOf(version: string | null, revision: string | null): VersionProvenance {
  if (version === null) return 'UNKNOWN';
  if (version === DEVELOPMENT_VERSION) return 'DEVELOPMENT';
  // A release-shaped version with no commit behind it is not a release we can stand behind.
  return revision === null ? 'UNKNOWN' : 'RELEASE';
}

/** Compare the two declarations without caring whether one of them wrote the leading `v`. */
function sameVersion(left: string, right: string): boolean {
  return left.replace(/^v/, '') === right.replace(/^v/, '');
}

function agreementOf(version: string | null, bundleVersion: string | null): VersionAgreement {
  if (version === null || bundleVersion === null) return 'UNKNOWN';
  return sameVersion(version, bundleVersion) ? 'AGREES' : 'MISMATCH';
}

export function buildRuntimeVersionView(env: NodeJS.ProcessEnv = process.env): RuntimeVersionView {
  const version = readShaped(env, RUNTIME_VERSION_ENV, VERSION_PATTERN);
  const revision = readShaped(env, RUNTIME_REVISION_ENV, REVISION_PATTERN);
  const builtAt = readShaped(env, RUNTIME_BUILT_AT_ENV, TIMESTAMP_PATTERN);
  const bundleVersion = readShaped(env, RUNTIME_BUNDLE_VERSION_ENV, VERSION_PATTERN);
  const image = describeImageRef(env[RUNTIME_IMAGE_REF_ENV]);
  const provenance = provenanceOf(version, revision);
  const agreement = agreementOf(version, bundleVersion);

  const notes: string[] = [];
  if (provenance === 'DEVELOPMENT') {
    notes.push('This image was built locally without release build arguments. It is a development build, not a published release.');
  }
  if (provenance === 'UNKNOWN') {
    notes.push('This image did not declare a usable version. Nothing is guessed here: treat the running version as unidentified.');
  }
  if (agreement === 'MISMATCH') {
    notes.push('The image reports a different version from the bundle that started it. Something upgraded or rolled back only halfway.');
  }
  if (agreement === 'UNKNOWN' && bundleVersion === null) {
    notes.push('The bundle did not declare a version, so the image cannot be checked against it.');
  }
  if (image.state === 'MALFORMED') {
    notes.push('The configured image reference is not a registry-qualified reference. Its value is deliberately not repeated here.');
  }
  if (image.movingTag) {
    notes.push('The image is pinned to a moving tag. A release should be pinned to a version tag or a digest so it cannot change under you.');
  }
  if (image.pinnedByDigest) {
    notes.push('The image is pinned by digest, which is the strongest pin available.');
  }

  return {
    report: 'phase-246-runtime-version',
    version,
    revision,
    builtAt,
    provenance,
    bundleVersion,
    agreement,
    image,
    notes,
  };
}
