// Where this project's release artifacts actually live — one canonical answer, derived from the repository
// that actually exists.
//
// Phase 245 shipped a publish target of `ghcr.io/catalog-authority/catalog-authority-ops`, a namespace this
// project does not own. That is not a cosmetic error: a workflow's `GITHUB_TOKEN` is scoped to its own
// repository owner, so publishing into an unrelated namespace fails at the registry, and every artifact that
// repeated the string — the Compose default, the bundle's `.env`, the README — was telling users to pull an
// image that could never exist. Earlier phases wrote the convention as `ghcr.io/OWNER/catalog-authority-ops`
// with OWNER left as a placeholder; the placeholder was later copied as if it were a name.
//
// So the owner lives here, once, and everything else reads it: the Compose default, the bundle generator,
// the release workflow (which additionally verifies at run time that the repository it is running in really
// is this owner), the documentation, and the tests that hold all of those to each other.

export class ReleaseCoordinatesError extends Error {}

/** The GitHub repository these artifacts are published from. */
export const RELEASE_REPOSITORY_OWNER = 'cdb8457';
export const RELEASE_REPOSITORY_NAME = 'streaming-catalog-authority';
export const RELEASE_REPOSITORY = `${RELEASE_REPOSITORY_OWNER}/${RELEASE_REPOSITORY_NAME}`;

export const RELEASE_IMAGE_REGISTRY = 'ghcr.io';
/** The package name inside the owner's namespace — the `catalog-authority-ops` convention Phase 145 set. */
export const RELEASE_IMAGE_PACKAGE = 'catalog-authority-ops';

/**
 * A container repository reference, lowercased.
 *
 * GHCR rejects uppercase, and a GitHub owner may legitimately contain uppercase letters, so the derivation
 * lowercases rather than assuming. Everything else about the name is validated rather than repaired: a
 * silently "fixed" registry name is how an artifact ends up published somewhere nobody intended.
 */
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/;
const REGISTRY_HOST = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d+)?$/;

export function normaliseImageRepository(registry: string, owner: string, packageName: string): string {
  const lowered = { registry: registry.toLowerCase(), owner: owner.toLowerCase(), packageName: packageName.toLowerCase() };
  if (!REGISTRY_HOST.test(lowered.registry)) throw new ReleaseCoordinatesError(`not a registry host: ${registry}`);
  for (const [what, value] of [['owner', lowered.owner], ['package', lowered.packageName]] as const) {
    if (!PATH_COMPONENT.test(value)) throw new ReleaseCoordinatesError(`not a valid image ${what}: ${value || '(empty)'}`);
  }
  return `${lowered.registry}/${lowered.owner}/${lowered.packageName}`;
}

/** The repository every artifact in this project pins to. */
export const RELEASE_IMAGE_REPOSITORY = normaliseImageRepository(
  RELEASE_IMAGE_REGISTRY, RELEASE_REPOSITORY_OWNER, RELEASE_IMAGE_PACKAGE);

/**
 * Validate a caller-supplied image repository override.
 *
 * An override is supported because a fork, a mirror or a private registry is a real need. It is validated
 * exactly as strictly as the derived value, and it is never lowercased-and-accepted silently: an override
 * that differs from its own normalised form is rejected, so what an operator typed and what gets published
 * cannot diverge.
 */
export function resolveImageRepository(input: {
  readonly owner: string;
  readonly packageName?: string;
  readonly registry?: string;
  readonly override?: string;
}): string {
  const derived = normaliseImageRepository(
    input.registry ?? RELEASE_IMAGE_REGISTRY, input.owner, input.packageName ?? RELEASE_IMAGE_PACKAGE);
  const override = input.override?.trim();
  if (override === undefined || override === '') return derived;

  const parts = override.split('/');
  if (parts.length !== 3) {
    throw new ReleaseCoordinatesError(`an image override must be registry/owner/name, got: ${override}`);
  }
  const normalised = normaliseImageRepository(parts[0]!, parts[1]!, parts[2]!);
  if (normalised !== override) {
    throw new ReleaseCoordinatesError(
      `image override must already be lowercase and canonical: ${override} would publish as ${normalised}`);
  }
  return normalised;
}

/**
 * The owner a workflow is really running as must be the owner these artifacts claim.
 *
 * This is the check the previous phase lacked. Constants cannot notice that they have gone stale; a run that
 * compares itself against the repository it is executing in can.
 */
export function assertRepositoryMatchesCoordinates(repository: string): void {
  const actual = repository.trim().toLowerCase();
  if (actual !== RELEASE_REPOSITORY.toLowerCase()) {
    throw new ReleaseCoordinatesError(
      `this workflow is running in ${repository}, but the release coordinates in src/ops/release-coordinates.ts ` +
      `say ${RELEASE_REPOSITORY}. Update the coordinates (and the Compose default, bundle and docs that read ` +
      'them) before publishing, so nothing is pushed to a namespace this repository does not own.');
  }
}
