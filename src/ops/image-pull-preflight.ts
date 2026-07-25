// Phase 254 (v1.1.2) — can a STRANGER actually pull the image this release tells them to pull?
//
// WHY THIS EXISTS. Everything else in the release pipeline verifies what we produced: the archive matches its
// digests, the manifest agrees with the packet, the image was pushed and its digest recorded. None of that
// answers the only question a consumer cares about — whether `docker compose up -d` on their machine, with no
// credential, can fetch the image. A registry package is publishable and still not publicly readable, and the
// failure lands on the user as `denied` or `manifest unknown` with nothing in our own troubleshooting table
// that names the real cause. So this asks the question directly, anonymously, the way a consumer's Docker
// would.
//
// IT USES NO CREDENTIAL, ON PURPOSE. Running it with a token would prove the wrong thing: that WE can pull.
// The anonymous token endpoint is the whole point.
//
// THE ACCEPT HEADER IS LOAD-BEARING, AND IS THE REASON THIS MODULE IS CAREFUL ABOUT IT.
// A registry answers 404 — not 406 — when asked for a manifest in a media type the caller did not accept. An
// image published as an OCI image INDEX (which is what a modern `docker buildx` push produces) is therefore
// invisible to a probe that only accepts the two legacy manifest types, and the probe reports a perfectly
// public image as missing. That exact false negative was hit during v1.1.1 verification and briefly reported
// as a product defect. The full set below is not a nicety; a probe missing one of these is a probe that lies,
// so it is a named constant with a test that pins it.
//
// IT DECIDES NOTHING IT CANNOT SEE. No network, an ambiguous status, or a registry that will not issue an
// anonymous token are reported as their own outcomes rather than folded into "not public" — the difference
// between "your image is private" and "I could not tell" is the difference between an operator changing a
// setting and an operator chasing a ghost.

export class ImagePullPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImagePullPreflightError';
  }
}

/**
 * Every manifest media type a registry may legitimately answer with.
 *
 * Ordered widest-first. An OCI index and a Docker manifest list are the multi-arch forms; the two manifest
 * types are the single-arch forms. A probe that omits the index types gets 404 on a public multi-arch image.
 */
export const MANIFEST_ACCEPT_TYPES: readonly string[] = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
];

export const MANIFEST_ACCEPT_HEADER = MANIFEST_ACCEPT_TYPES.join(',');

export type PullOutcome =
  /** An anonymous caller fetched the manifest. This is what a consumer's Docker will do. */
  | 'PUBLICLY_PULLABLE'
  /** The registry answered, and refused an anonymous caller. The package is not public. */
  | 'NOT_PUBLIC'
  /** The registry answered, and there is no such tag or digest in that repository. */
  | 'ABSENT'
  /** Nothing could be established: no network, no anonymous token, or an unexpected status. */
  | 'INDETERMINATE';

export interface PullProbeResult {
  /**
   * HTTP status of the MANIFEST request, or `null` when that request was never made or never completed.
   *
   * Strictly the manifest phase. This used to carry the token endpoint's status when no token was obtained,
   * which meant a 404 from the token endpoint — an endpoint that says nothing about whether a package is
   * public — was read as proof the package was private. Two different requests cannot share one status field
   * and still support an honest verdict.
   */
  readonly status: number | null;
  /** `docker-content-digest`, when the registry supplied one. */
  readonly digest: string | null;
  /** HTTP status of the anonymous TOKEN request, or `null` when it never completed. */
  readonly tokenStatus: number | null;
  /** True when an anonymous pull token was actually obtained. */
  readonly tokenObtained: boolean;
}

export interface ImagePullPreflightInput {
  readonly repository: string;
  /** A tag or a `sha256:…` digest. */
  readonly reference: string;
  /** What the probe observed. Supplied so the derivation is pure and every outcome is testable. */
  readonly probe: PullProbeResult;
  /** The digest the release claims. When given, a mismatch is a BLOCKER even if the pull succeeded. */
  readonly expectedDigest?: string | null;
}

export interface ImagePullFinding {
  readonly code: string;
  readonly severity: 'BLOCKER' | 'ADVISORY';
  readonly detail: string;
  readonly fix: string;
}

export interface ImagePullPreflightReport {
  readonly ok: boolean;
  readonly report: 'phase-254-image-pull-preflight';
  readonly outcome: PullOutcome;
  readonly repository: string;
  readonly reference: string;
  readonly observedDigest: string | null;
  readonly findings: readonly ImagePullFinding[];
  readonly note: string;
}

const NOTE =
  'This checks only that an anonymous caller can fetch the image manifest, which is what a consumer running '
  + '`docker compose up -d` does. It pulls no layers, uses no credential, starts nothing, and says nothing '
  + 'about whether any promotion may proceed.';

/** The exact steps a human must take. Named here so no surface has to invent them. */
export const MAKE_PUBLIC_INSTRUCTIONS: readonly string[] = [
  'This is a GitHub setting, not something this repository can change for you: a workflow token cannot alter '
  + 'its own package visibility, and nothing here will pretend otherwise.',
  'Open https://github.com/users/<owner>/packages/container/<package>/settings (for an organisation, '
  + 'https://github.com/orgs/<org>/packages/container/<package>/settings).',
  'Under "Danger Zone", choose "Change visibility", select Public, and confirm by typing the package name.',
  'Re-run this preflight. It must report PUBLICLY_PULLABLE before the release can be called installable.',
];

/**
 * Turn one probe into a verdict. Pure: no network, no clock, no environment.
 */
export function deriveImagePullPreflight(input: ImagePullPreflightInput): ImagePullPreflightReport {
  const findings: ImagePullFinding[] = [];
  const { status, digest, tokenStatus, tokenObtained } = input.probe;

  // NOT_PUBLIC IS A SERIOUS CLAIM AND IS ONLY MADE ON DIRECT EVIDENCE OF REFUSAL.
  //
  // A registry refusing an anonymous caller says so with 401 or 403 — either on the manifest, or on the
  // anonymous pull-token request itself. Anything else is not proof. In particular a 404 is only meaningful
  // once a token WAS obtained: without one the request never reached the question, and reporting "your
  // package is private" would send an operator to flip a setting that was never wrong.
  //
  // Everything unproven is INDETERMINATE, which blocks. Failing closed on "I could not tell" is right; making
  // up which way it failed is not.
  const refusedDirectly = status === 401 || status === 403 || tokenStatus === 401 || tokenStatus === 403;

  let outcome: PullOutcome;
  if (status === 200) outcome = 'PUBLICLY_PULLABLE';
  else if (refusedDirectly) outcome = 'NOT_PUBLIC';
  else if (status === 404 && tokenObtained) outcome = 'ABSENT';
  else outcome = 'INDETERMINATE';

  if (outcome === 'NOT_PUBLIC') {
    findings.push({
      code: 'IMAGE_NOT_PUBLICLY_PULLABLE',
      severity: 'BLOCKER',
      detail: 'An anonymous caller cannot fetch this image, so an ordinary consumer following the install '
        + 'instructions will fail at `docker compose up -d` with a denied or not-found error.',
      fix: MAKE_PUBLIC_INSTRUCTIONS.join(' '),
    });
  }
  if (outcome === 'ABSENT') {
    findings.push({
      code: 'IMAGE_REFERENCE_ABSENT',
      severity: 'BLOCKER',
      detail: 'The registry answered an anonymous caller, and this repository has no such tag or digest.',
      fix: 'Check that the release actually published, and that the reference being checked is the one the '
        + 'release pins. A reference that never existed is not a visibility problem.',
    });
  }
  if (outcome === 'INDETERMINATE') {
    findings.push({
      code: 'IMAGE_PULLABILITY_INDETERMINATE',
      severity: 'BLOCKER',
      detail: tokenObtained
        ? 'Nothing could be established: the registry answered the manifest request with an unexpected '
          + 'status, or did not answer it at all. This is NOT evidence that the image is fine, and it is not '
          + 'evidence that it is broken.'
        : 'Nothing could be established: no anonymous pull token was obtained, and the registry did not '
          + 'directly refuse one either. Without a token the manifest question was never actually asked, so '
          + 'this says nothing about whether the package is public — it is not evidence that the image is '
          + 'fine, and it is not evidence that it is private.',
      fix: 'Re-run with network access to the registry. Do not record a release as installable on the basis '
        + 'of a check that did not complete, and do not change package visibility on the strength of it '
        + 'either — nothing here has established that visibility is the problem.',
    });
  }

  // A successful anonymous pull of the WRONG bytes is not a success.
  const expected = input.expectedDigest ?? null;
  if (outcome === 'PUBLICLY_PULLABLE' && expected === null) {
    // Nothing was asked, so nothing is unconfirmed and nothing blocks — but "something pullable is there" is
    // a weaker statement than "the thing this release pins is there", and the difference should not have to
    // be inferred from the absence of a line.
    findings.push({
      code: 'IMAGE_IDENTITY_NOT_REQUESTED',
      severity: 'ADVISORY',
      detail: 'An anonymous caller can pull this reference. No expected digest was supplied, so what they '
        + 'would receive was not checked against anything.',
      fix: 'Pass --expect-digest to verify that the reference resolves to the bytes a release pins. A release '
        + 'gate should always supply it.',
    });
  }
  if (outcome === 'PUBLICLY_PULLABLE' && expected !== null) {
    if (digest === null) {
      // FAIL CLOSED. An expected digest was supplied, which means the caller asked this check to CONFIRM the
      // bytes — and it could not. Reporting that as an advisory left `ok` true, so a release gate would pass
      // having verified nothing about the one thing it was asked to verify. "I could not check" and "I
      // checked and it matched" must never produce the same verdict.
      findings.push({
        code: 'IMAGE_DIGEST_UNCONFIRMED',
        severity: 'BLOCKER',
        detail: 'An expected digest was supplied, but the registry returned no content digest, so the bytes '
          + 'served to an anonymous caller could not be matched against the digest this release pins. The '
          + 'pull succeeded; the identity of what was pulled is unverified.',
        fix: 'Do not treat the pin as verified. Re-run the check; if the registry continues to omit the '
          + 'digest header, verify the reference another way before publishing anything that pins it.',
      });
    } else if (digest !== expected) {
      findings.push({
        code: 'IMAGE_DIGEST_MISMATCH',
        severity: 'BLOCKER',
        detail: 'An anonymous caller can pull this reference, but it resolves to different bytes from the '
          + 'digest this release pins.',
        fix: 'Do not move or overwrite anything. Establish which digest is correct first: a reference that '
          + 'has moved under a release is a supply-chain question, not a retag.',
      });
    }
  }

  return {
    ok: !findings.some((f) => f.severity === 'BLOCKER'),
    report: 'phase-254-image-pull-preflight',
    outcome,
    repository: input.repository,
    reference: input.reference,
    observedDigest: digest,
    findings,
    note: NOTE,
  };
}

export interface ProbeOptions {
  readonly registry?: string;
  readonly timeoutMs?: number;
  /** Injected in tests so no suite depends on a network. */
  readonly fetchImpl?: typeof fetch;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

/**
 * Ask the registry, anonymously, exactly what a consumer's Docker asks.
 *
 * Two requests: an anonymous pull token, then the manifest. Every failure becomes a shaped result rather than
 * a throw, because the caller's job is to report an outcome and a probe that explodes reports nothing.
 */
export async function probeAnonymousPull(
  repository: string,
  reference: string,
  options: ProbeOptions = {},
): Promise<PullProbeResult> {
  const registry = options.registry ?? 'ghcr.io';
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const withTimeout = async (url: string, headers: Record<string, string>): Promise<Response | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  let token: string | null = null;
  const tokenResponse = await withTimeout(
    `https://${registry}/token?scope=repository:${repository}:pull&service=${registry}`, {});
  if (tokenResponse !== null && tokenResponse.ok) {
    try {
      const body = await tokenResponse.json() as { token?: unknown };
      if (typeof body.token === 'string' && body.token !== '') token = body.token;
    } catch { /* a token endpoint that is not JSON is a token we do not have */ }
  }
  // The token status is reported in its OWN field. Folding it into `status` would let a token-endpoint 404 —
  // which establishes nothing about visibility — be read downstream as proof of a private package.
  const tokenStatus = tokenResponse?.status ?? null;
  if (token === null) return { status: null, digest: null, tokenStatus, tokenObtained: false };

  const manifest = await withTimeout(
    `https://${registry}/v2/${repository}/manifests/${encodeURIComponent(reference)}`,
    { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT_HEADER });
  if (manifest === null) return { status: null, digest: null, tokenStatus, tokenObtained: true };

  return {
    status: manifest.status,
    digest: manifest.headers.get('docker-content-digest'),
    tokenStatus,
    tokenObtained: true,
  };
}

/** The whole check against a real registry. */
export async function checkImageIsPubliclyPullable(input: {
  readonly repository: string;
  readonly reference: string;
  readonly expectedDigest?: string | null;
  readonly options?: ProbeOptions;
}): Promise<ImagePullPreflightReport> {
  const probe = await probeAnonymousPull(input.repository, input.reference, input.options ?? {});
  return deriveImagePullPreflight({
    repository: input.repository,
    reference: input.reference,
    probe,
    expectedDigest: input.expectedDigest ?? null,
  });
}
