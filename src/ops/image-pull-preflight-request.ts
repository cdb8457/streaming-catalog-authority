// Phase 254 remediation — deciding WHAT to check, without ever silently checking something else.
//
// THE DEFECT THIS EXISTS FOR. `npm run ops:image-pull-preflight -- --reference v1.1.1 --expect-digest sha256:…`
// is not a reliable way to pass arguments. What actually reaches the script depends on the npm version and
// the platform, and three behaviours have been observed:
//
//   * the flags arrive intact                  (npm 11.4.2 here, space-separated form);
//   * `--flag=value` arrives as ONE token       (npm 11.4.2 here — and a parser looking for an exact `--flag`
//                                               match never finds it);
//   * npm consumes the option NAMES and forwards only their values, or forwards nothing at all
//     (independently observed on another Windows npm).
//
// Every one of those ends the same way in a lenient parser: the flag is not seen, the default is used, and
// the check reports on a DIFFERENT reference from the one the caller asked about — silently. That was
// reproduced here: asking for v1.1.1 with `=` syntax checked v1.1.2 and reported ABSENT without ever saying
// it had substituted anything. A release gate that quietly checks the wrong image is worse than no gate,
// because it produces a green tick for a question nobody asked.
//
// SO THIS RESOLVER IS STRICT AND FAILS CLOSED.
//
//   * Environment variables are the primary channel and the only one CI uses. They cannot be reordered,
//     renamed or eaten by an argument parser sitting between the workflow and the process.
//   * Flags still work for a person at a terminal, in BOTH `--flag value` and `--flag=value` spellings.
//   * An argument that is not a recognised flag is a HARD ERROR, never ignored. That is what catches an npm
//     which stripped the names and forwarded bare values: a lone `v1.1.1` is refused rather than dropped in
//     favour of a default.
//   * The same input supplied twice with different values is a hard error, not a precedence puzzle.
//   * `requireExplicit` — which the release workflow sets — removes the defaults entirely, so if the
//     environment somehow did not arrive the run fails loudly instead of checking the active release tag by
//     accident. That is the one mitigation that holds even against an npm that forwards nothing at all.

export const PULL_REPOSITORY_ENV = 'CATALOG_AUTHORITY_PULL_REPOSITORY';
export const PULL_REFERENCE_ENV = 'CATALOG_AUTHORITY_PULL_REFERENCE';
export const PULL_EXPECT_DIGEST_ENV = 'CATALOG_AUTHORITY_PULL_EXPECT_DIGEST';
export const PULL_JSON_ENV = 'CATALOG_AUTHORITY_PULL_JSON';
/** Set by the release workflow: refuse every default, so a missing input can never become a silent one. */
export const PULL_REQUIRE_EXPLICIT_ENV = 'CATALOG_AUTHORITY_PULL_REQUIRE_EXPLICIT';

export type PreflightRequestErrorCode =
  | 'PREFLIGHT_UNRECOGNISED_ARGUMENT'
  | 'PREFLIGHT_MISSING_VALUE'
  | 'PREFLIGHT_CONFLICTING_INPUT'
  | 'PREFLIGHT_INVALID_VALUE'
  | 'PREFLIGHT_INPUT_REQUIRED';

export interface PreflightRequest {
  readonly repository: string;
  readonly reference: string;
  readonly expectedDigest: string | null;
  readonly json: boolean;
}

export interface PreflightRequestFailure {
  readonly code: PreflightRequestErrorCode;
  readonly message: string;
}

export type PreflightRequestResolution =
  | { readonly ok: true; readonly request: PreflightRequest }
  | { readonly ok: false; readonly failure: PreflightRequestFailure };

/** A tag, or a digest. Anything else is not something this check knows how to ask about. */
const REFERENCE_PATTERN = /^(?:sha256:[0-9a-f]{64}|[A-Za-z0-9_][A-Za-z0-9._-]{0,127})$/;
const DIGEST_ONLY_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** `owner/name` or deeper. The registry host is supplied separately, so it is not part of this value. */
const PULL_REPOSITORY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

const FLAGS = ['--repository', '--reference', '--expect-digest'] as const;
type FlagName = (typeof FLAGS)[number];

const isFlagName = (value: string): value is FlagName => (FLAGS as readonly string[]).includes(value);

const fail = (code: PreflightRequestErrorCode, message: string): PreflightRequestResolution =>
  ({ ok: false, failure: { code, message } });

export const NPM_FORWARDING_HINT =
  'If you invoked this through `npm run`, your npm may not forward flags intact. Either set the documented '
  + `environment variables (${PULL_REFERENCE_ENV}, ${PULL_EXPECT_DIGEST_ENV}) or call the CLI directly with `
  + 'npx: npx tsx src/ops/image-pull-preflight-cli.ts --reference <ref> --expect-digest <sha256:...>';

export interface ResolveOptions {
  /** Used only when no reference was supplied AND defaults are permitted. */
  readonly defaultReference: string;
  readonly defaultRepository: string;
}

/**
 * Decide what to check. Pure: argv and env in, a request or a refusal out. It never guesses.
 */
export function resolvePreflightRequest(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  options: ResolveOptions,
): PreflightRequestResolution {
  const fromFlags = new Map<FlagName, string>();
  let jsonFlag = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--json') { jsonFlag = true; continue; }

    const equals = token.indexOf('=');
    const name = equals === -1 ? token : token.slice(0, equals);
    if (!isFlagName(name)) {
      // THE IMPORTANT BRANCH. A bare `v1.1.1` reaching here is almost certainly a value whose flag name an
      // npm consumed. Ignoring it and falling back to a default IS the silent-wrong-reference bug; refusing
      // it is the whole fix.
      return fail('PREFLIGHT_UNRECOGNISED_ARGUMENT',
        `unrecognised argument ${JSON.stringify(token)}. This check refuses to guess what was meant and will `
        + `not fall back to a default reference. ${NPM_FORWARDING_HINT}`);
    }

    let value: string | undefined;
    if (equals === -1) {
      value = argv[index + 1];
      index += 1;
      if (value === undefined || value.startsWith('--')) {
        return fail('PREFLIGHT_MISSING_VALUE', `${name} was given without a value.`);
      }
    } else {
      value = token.slice(equals + 1);
      if (value === '') return fail('PREFLIGHT_MISSING_VALUE', `${name}= was given with an empty value.`);
    }

    const existing = fromFlags.get(name);
    if (existing !== undefined && existing !== value) {
      return fail('PREFLIGHT_CONFLICTING_INPUT', `${name} was given twice with different values.`);
    }
    fromFlags.set(name, value);
  }

  const readEnv = (key: string): string | undefined => {
    const raw = env[key];
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
  };

  /** One input from at most two channels, which must agree if both spoke. */
  const combine = (flag: FlagName, envKey: string): { value?: string } | PreflightRequestFailure => {
    const viaFlag = fromFlags.get(flag);
    const viaEnv = readEnv(envKey);
    if (viaFlag !== undefined && viaEnv !== undefined && viaFlag !== viaEnv) {
      return {
        code: 'PREFLIGHT_CONFLICTING_INPUT',
        message: `${flag} and ${envKey} were both supplied and disagree. Refusing to pick one: say it once.`,
      };
    }
    const value = viaFlag ?? viaEnv;
    return value === undefined ? {} : { value };
  };

  const isFailure = (v: { value?: string } | PreflightRequestFailure): v is PreflightRequestFailure =>
    'code' in v;

  const repositoryInput = combine('--repository', PULL_REPOSITORY_ENV);
  if (isFailure(repositoryInput)) return { ok: false, failure: repositoryInput };
  const referenceInput = combine('--reference', PULL_REFERENCE_ENV);
  if (isFailure(referenceInput)) return { ok: false, failure: referenceInput };
  const digestInput = combine('--expect-digest', PULL_EXPECT_DIGEST_ENV);
  if (isFailure(digestInput)) return { ok: false, failure: digestInput };

  if (readEnv(PULL_REQUIRE_EXPLICIT_ENV) === '1') {
    if (referenceInput.value === undefined) {
      return fail('PREFLIGHT_INPUT_REQUIRED',
        `${PULL_REFERENCE_ENV} (or --reference) is required here and was not supplied. This run refuses to `
        + 'fall back to the active release tag, because checking a different reference from the one being '
        + 'published is the exact failure this mode exists to prevent.');
    }
    if (digestInput.value === undefined) {
      return fail('PREFLIGHT_INPUT_REQUIRED',
        `${PULL_EXPECT_DIGEST_ENV} (or --expect-digest) is required here and was not supplied. Without it the `
        + 'identity of what a consumer would receive is not verified.');
    }
  }

  // The release workflow's `image_repository` output is REGISTRY-QUALIFIED (`ghcr.io/owner/name`), while the
  // probe builds `https://ghcr.io/v2/<repository>/manifests/…` and therefore wants `owner/name`. Passing the
  // qualified form straight through would have produced `…/v2/ghcr.io/owner/name/…` — a URL that 404s, which
  // this check would then have to interpret, badly. It is normalised here rather than at one call site so
  // every caller can pass whichever form it has.
  const rawRepository = repositoryInput.value ?? options.defaultRepository;
  const repository = rawRepository.startsWith('ghcr.io/') ? rawRepository.slice('ghcr.io/'.length) : rawRepository;
  // Any OTHER registry host is refused rather than silently queried against ghcr.io.
  const firstSegment = repository.split('/')[0] ?? '';
  if (firstSegment.includes('.') || firstSegment.includes(':')) {
    return fail('PREFLIGHT_INVALID_VALUE',
      `this check only talks to ghcr.io, and ${JSON.stringify(rawRepository)} names a different registry.`);
  }
  const reference = referenceInput.value ?? options.defaultReference;
  const expectedDigest = digestInput.value ?? null;

  if (!PULL_REPOSITORY_PATTERN.test(repository)) {
    return fail('PREFLIGHT_INVALID_VALUE', `not an image repository: ${JSON.stringify(repository)}`);
  }
  if (!REFERENCE_PATTERN.test(reference)) {
    return fail('PREFLIGHT_INVALID_VALUE', `not a tag or digest: ${JSON.stringify(reference)}`);
  }
  if (expectedDigest !== null && !DIGEST_ONLY_PATTERN.test(expectedDigest)) {
    return fail('PREFLIGHT_INVALID_VALUE', `not a sha256 digest: ${JSON.stringify(expectedDigest)}`);
  }

  return {
    ok: true,
    request: { repository, reference, expectedDigest, json: jsonFlag || readEnv(PULL_JSON_ENV) === '1' },
  };
}
