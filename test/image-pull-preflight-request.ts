import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asList, asMap, parseYaml } from './helpers/compose-yaml.js';
import {
  PULL_EXPECT_DIGEST_ENV,
  PULL_REFERENCE_ENV,
  PULL_REPOSITORY_ENV,
  PULL_REQUIRE_EXPLICIT_ENV,
  resolvePreflightRequest,
  type PreflightRequestResolution,
} from '../src/ops/image-pull-preflight-request.js';

// Phase 254 remediation — the CLI must never check a reference nobody asked about.
//
// THE DEFECT, PROVEN ON A REAL MACHINE. `npm run ops:image-pull-preflight -- --reference=v1.1.1 …` asked about
// v1.1.1 and the CLI checked v1.1.2, the unreleased default, reporting ABSENT — without a word about having
// substituted anything. Independent execution on another Windows npm showed a second route to the same place:
// npm consuming the option NAMES and forwarding only their values, or forwarding nothing at all.
//
// All three routes converge on one failure: the flag is not seen, a default is used, and a release gate
// reports a green tick for a question nobody asked. These tests emulate each route directly against the pure
// resolver, and assert the thing that actually matters — that NO check is performed against a wrong default.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

const DIGEST = `sha256:${'3'.repeat(64)}`;
const OPTIONS = { defaultReference: 'v1.1.2', defaultRepository: 'cdb8457/catalog-authority-ops' };
const resolve = (argv: readonly string[], env: NodeJS.ProcessEnv = {}): PreflightRequestResolution =>
  resolvePreflightRequest(argv, env, OPTIONS);

/** The property under test throughout: whatever went wrong, we did NOT quietly check the default. */
function assertRefusedWithoutDefaulting(result: PreflightRequestResolution, why: string): void {
  assert(!result.ok, `${why}: refused rather than resolved`);
  if (result.ok) return;
  assert(!JSON.stringify(result.failure).includes(OPTIONS.defaultReference)
    || /refuses|not fall back/i.test(result.failure.message),
    `${why}: and the refusal does not present the default as what it used`);
}

console.log('Running Phase 254 preflight request-resolution suite:\n');

// ---------------------------------------------------------------------------------------------------------
// The three observed npm manglings.
// ---------------------------------------------------------------------------------------------------------

test('npm stripping the flag NAMES and forwarding bare values is refused, never defaulted', () => {
  // This is the shape independent execution reported: `--reference v1.1.1 --expect-digest sha256:…` arriving
  // as `["v1.1.1", "sha256:…"]`. The old parser saw no flags, used its default, and checked the wrong image.
  const result = resolve(['v1.1.1', DIGEST]);
  assertRefusedWithoutDefaulting(result, 'stripped flag names');
  if (result.ok) return;
  assertEq(result.failure.code, 'PREFLIGHT_UNRECOGNISED_ARGUMENT', 'with a stable code');
  assert(result.failure.message.includes('v1.1.1'), 'naming the argument it refused');
  assert(/will not fall back to a default reference/i.test(result.failure.message),
    'and saying outright that no default was substituted');
  assert(/npm/i.test(result.failure.message), 'and pointing at the likely cause');
});

test('a single orphan value — the "forwarded nothing but one token" case — is also refused', () => {
  for (const argv of [['v1.1.1'], [DIGEST], ['v1.1.1', 'extra'], ['--json', 'v1.1.1']]) {
    assertRefusedWithoutDefaulting(resolve(argv), JSON.stringify(argv));
  }
});

test('`--flag=value` in ONE token resolves correctly — the case that silently checked v1.1.2 here', () => {
  // Reproduced on npm 11.4.2: the `=` form arrives as a single token, an exact-match parser never finds the
  // flag, and the default is used. It must parse, not merely fail loudly.
  const result = resolve([`--reference=v1.1.1`, `--expect-digest=${DIGEST}`]);
  assert(result.ok, 'the equals form resolves');
  if (!result.ok) return;
  assertEq(result.request.reference, 'v1.1.1', 'to the reference the caller actually asked for');
  assertEq(result.request.expectedDigest, DIGEST, 'and the digest they asked for');
});

test('the space-separated form still works, because on many npms it arrives intact', () => {
  const result = resolve(['--reference', 'v1.1.1', '--expect-digest', DIGEST, '--json']);
  assert(result.ok, 'it resolves');
  if (!result.ok) return;
  assertEq(result.request.reference, 'v1.1.1', 'with the right reference');
  assertEq(result.request.json, true, 'and --json is honoured');
});

// ---------------------------------------------------------------------------------------------------------
// The channel CI uses, and the mode that makes a missing channel loud.
// ---------------------------------------------------------------------------------------------------------

test('environment variables resolve with no arguments at all, which is how CI passes inputs', () => {
  const result = resolve([], {
    [PULL_REFERENCE_ENV]: 'v1.1.1',
    [PULL_EXPECT_DIGEST_ENV]: DIGEST,
    [PULL_REPOSITORY_ENV]: 'cdb8457/catalog-authority-ops',
  });
  assert(result.ok, 'the env channel resolves');
  if (!result.ok) return;
  assertEq(result.request.reference, 'v1.1.1', 'with the reference from the environment');
  assertEq(result.request.expectedDigest, DIGEST, 'and the digest');
});

test('a registry-qualified repository is normalised, not turned into a doubled URL', () => {
  // The workflow's `image_repository` output is `ghcr.io/owner/name`, while the probe builds
  // `https://ghcr.io/v2/<repository>/manifests/…`. Passing it through unchanged would request
  // `/v2/ghcr.io/owner/name/…`, which 404s — and this check would then have to interpret that 404.
  const result = resolve([], {
    [PULL_REFERENCE_ENV]: 'v1.1.1',
    [PULL_REPOSITORY_ENV]: 'ghcr.io/cdb8457/catalog-authority-ops',
  });
  assert(result.ok, 'it resolves');
  if (!result.ok) return;
  assertEq(result.request.repository, 'cdb8457/catalog-authority-ops', 'with the registry host stripped');
});

test('a repository on some OTHER registry is refused rather than silently queried against ghcr.io', () => {
  const result = resolve([], { [PULL_REPOSITORY_ENV]: 'docker.io/library/nginx', [PULL_REFERENCE_ENV]: 'latest' });
  assert(!result.ok, 'it is refused');
  if (result.ok) return;
  assertEq(result.failure.code, 'PREFLIGHT_INVALID_VALUE', 'as an invalid value');
  assert(/only talks to ghcr\.io/i.test(result.failure.message), 'saying which registry it can actually ask');
});

test('REQUIRE_EXPLICIT removes every default, so an environment that did not arrive fails loudly', () => {
  // The one mitigation that holds even against an npm which forwards nothing: with no inputs at all, the
  // run must refuse rather than check the active release tag by accident.
  const nothing = resolve([], { [PULL_REQUIRE_EXPLICIT_ENV]: '1' });
  assert(!nothing.ok, 'no inputs is a refusal in this mode');
  if (nothing.ok) return;
  assertEq(nothing.failure.code, 'PREFLIGHT_INPUT_REQUIRED', 'with a stable code');
  assert(/refuses to fall back to the active release tag/i.test(nothing.failure.message),
    'and says exactly what it refused to do');

  const noDigest = resolve([], { [PULL_REQUIRE_EXPLICIT_ENV]: '1', [PULL_REFERENCE_ENV]: 'v1.1.1' });
  assert(!noDigest.ok, 'a reference without a digest is also refused in this mode');

  const complete = resolve([], {
    [PULL_REQUIRE_EXPLICIT_ENV]: '1', [PULL_REFERENCE_ENV]: 'v1.1.1', [PULL_EXPECT_DIGEST_ENV]: DIGEST });
  assert(complete.ok, 'and a complete environment resolves');
});

test('without REQUIRE_EXPLICIT, a bare invocation may still default — that is a convenience, not a gate', () => {
  const result = resolve([]);
  assert(result.ok, 'a no-argument run resolves');
  if (!result.ok) return;
  assertEq(result.request.reference, OPTIONS.defaultReference, 'to the active release tag');
  assertEq(result.request.expectedDigest, null, 'with no digest, so identity is explicitly unverified');
});

// ---------------------------------------------------------------------------------------------------------
// Conflicts and malformed values.
// ---------------------------------------------------------------------------------------------------------

test('two channels that disagree is a refusal, not a precedence puzzle', () => {
  const result = resolve(['--reference', 'v1.1.1'], { [PULL_REFERENCE_ENV]: 'v1.1.0' });
  assert(!result.ok, 'disagreement is refused');
  if (result.ok) return;
  assertEq(result.failure.code, 'PREFLIGHT_CONFLICTING_INPUT', 'as a conflict');
  assert(/say it once/i.test(result.failure.message), 'telling the caller to say it once');

  const agreeing = resolve(['--reference', 'v1.1.1'], { [PULL_REFERENCE_ENV]: 'v1.1.1' });
  assert(agreeing.ok, 'but agreeing channels are fine — there is nothing to disambiguate');
});

test('a flag with no value, and malformed values, are refused', () => {
  assertEq((resolve(['--reference']) as { failure: { code: string } }).failure.code,
    'PREFLIGHT_MISSING_VALUE', 'a trailing flag has no value');
  assertEq((resolve(['--reference', '--json']) as { failure: { code: string } }).failure.code,
    'PREFLIGHT_MISSING_VALUE', 'and a following flag is not its value');
  assertEq((resolve(['--reference=']) as { failure: { code: string } }).failure.code,
    'PREFLIGHT_MISSING_VALUE', 'nor is an empty equals value');
  assertEq((resolve([], { [PULL_EXPECT_DIGEST_ENV]: 'not-a-digest', [PULL_REFERENCE_ENV]: 'v1' }) as { failure: { code: string } }).failure.code,
    'PREFLIGHT_INVALID_VALUE', 'a non-digest is refused');
  assertEq((resolve([], { [PULL_REFERENCE_ENV]: 'not a reference' }) as { failure: { code: string } }).failure.code,
    'PREFLIGHT_INVALID_VALUE', 'and a reference with a space is refused');
});

// ---------------------------------------------------------------------------------------------------------
// The workflow must actually use the safe channel.
// ---------------------------------------------------------------------------------------------------------

test('the release workflow passes inputs as env vars and forwards NO flags through npm', () => {
  const doc = asMap(parseYaml(read('.github/workflows/runtime-image.yml')), 'workflow');
  const publish = asMap(asMap(doc.jobs ?? null, 'jobs').publish ?? null, 'publish job');
  const steps = asList(publish.steps ?? null, 'steps').map((step, i) => asMap(step, `step ${i}`));
  const check = steps.find((step) => String(step.name ?? '').includes('A stranger can actually pull'));
  assert(check !== undefined, 'the pull check step exists');

  const env = asMap(check!.env ?? null, 'pull check env');
  for (const required of [PULL_REFERENCE_ENV, PULL_EXPECT_DIGEST_ENV, PULL_REQUIRE_EXPLICIT_ENV]) {
    assert(env[required] !== undefined, `${required} is wired as an environment variable`);
  }
  assertEq(String(env[PULL_REQUIRE_EXPLICIT_ENV]), '1',
    'and defaults are switched OFF, so a missing input fails loudly instead of checking the wrong reference');

  // The inputs must come from the release/push outputs, not be hand-written constants that can go stale.
  assert(/steps\.release\.outputs\.tag/.test(String(env[PULL_REFERENCE_ENV])),
    'the reference comes from the resolved release tag');
  assert(/steps\.push\.outputs\.digest/.test(String(env[PULL_EXPECT_DIGEST_ENV])),
    'and the digest from the push that produced it');

  // NO forwarded flags. `npm run x -- --flag value` is the construct that is not portable.
  const run = String(check!.run ?? '');
  assert(/npm run ops:image-pull-preflight/.test(run), 'the step runs the preflight');
  assert(!/npm run ops:image-pull-preflight\s+--\s/.test(run),
    'and forwards no flags through npm, because that is the construct that mangles them');
  assert(!/--reference/.test(run) && !/--expect-digest/.test(run),
    'so no flag names appear in the run block at all');
});

test('the CLI refuses unresolved input with a non-zero exit distinct from a failed check', () => {
  const cli = read('src/ops/image-pull-preflight-cli.ts');
  assert(/process\.exit\(2\)/.test(cli), 'an unresolvable request exits 2');
  assert(/process\.exit\(report\.ok \? 0 : 1\)/.test(cli), 'a completed check exits 0 or 1 on its verdict');
  assert(/No default reference was substituted/.test(cli),
    'and the refusal states that nothing was checked against a default');
  // The documented reliable invocations must be in the file a reader opens.
  assert(cli.includes(PULL_REFERENCE_ENV) && cli.includes('npx tsx src/ops/image-pull-preflight-cli.ts'),
    'the header documents both the environment channel and the direct npx invocation');
  assert(/PowerShell/i.test(cli), 'including a Windows-reliable form');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${String(err)}`);
  process.exit(1);
}
