import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkImageIsPubliclyPullable,
  deriveImagePullPreflight,
  MAKE_PUBLIC_INSTRUCTIONS,
  MANIFEST_ACCEPT_HEADER,
  MANIFEST_ACCEPT_TYPES,
  probeAnonymousPull,
  type PullProbeResult,
} from '../src/ops/image-pull-preflight.js';

// Phase 254 (v1.1.2) — "can a stranger actually pull this?", adversarially.
//
// THIS EXISTS BECAUSE THE CHECK ITSELF ALREADY LIED ONCE. During v1.1.1 verification a hand-written probe
// reported the published image as unreachable and it was written up as a limitation. The image was public the
// whole time; the probe sent an Accept header listing only the two legacy manifest types, and a registry
// answers 404 — not 406 — when it holds an OCI image INDEX the caller did not accept. A probe that is wrong in
// exactly the direction of "your release is broken" is worse than no probe, so the media-type set is pinned
// here and every outcome the derivation can reach is asserted, including the ones that must NOT be reported as
// a private package.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

console.log('Running Phase 254 image pull preflight suite:\n');

const probe = (over: Partial<PullProbeResult> = {}): PullProbeResult =>
  ({ status: 200, digest: null, tokenObtained: true, ...over });

const DIGEST = 'sha256:3dcd1ad9832aa7e7275ace9a9a364f6b83f197e4f4c1b68d0ff5d87d08619012';
const OTHER = 'sha256:e7dc58b9c2c5d7c89347d55eb5a82c129dbc9647284fcc48874752c96fd93d28';
const base = { repository: 'cdb8457/catalog-authority-ops', reference: 'v1.1.1' };

// ---------------------------------------------------------------------------------------------------------
// The regression that motivated the whole module.
// ---------------------------------------------------------------------------------------------------------

await test('every manifest media type a registry may answer with is accepted, or a public image reads as absent', () => {
  for (const required of [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ]) {
    assert(MANIFEST_ACCEPT_TYPES.includes(required), `the probe accepts ${required}`);
  }
  // The INDEX types are the ones whose omission caused the false negative: `docker buildx` publishes an index,
  // and a registry 404s a manifest it holds in a type the caller did not accept.
  assert(MANIFEST_ACCEPT_TYPES.some((t) => t.includes('index')), 'including an OCI image index');
  assert(MANIFEST_ACCEPT_TYPES.some((t) => t.includes('manifest.list')), 'including a Docker manifest list');
  assertEq(MANIFEST_ACCEPT_HEADER, MANIFEST_ACCEPT_TYPES.join(','), 'the header is exactly the pinned set');
});

await test('the probe actually SENDS that Accept header, and sends no credential of ours', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fake: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    seen.push({ url: String(url), headers });
    if (String(url).includes('/token')) {
      return { ok: true, status: 200, json: async () => ({ token: 'anonymous-token' }), headers: new Headers() } as unknown as Response;
    }
    return { ok: true, status: 200, headers: new Headers({ 'docker-content-digest': DIGEST }) } as unknown as Response;
  }) as unknown as typeof fetch;

  const result = await probeAnonymousPull('cdb8457/catalog-authority-ops', 'v1.1.1', { fetchImpl: fake });
  assertEq(result.status, 200, 'the manifest request succeeded');
  assertEq(result.digest, DIGEST, 'and the content digest was read');

  const manifestCall = seen.find((c) => c.url.includes('/manifests/'));
  assert(manifestCall !== undefined, 'a manifest request was made');
  assertEq(manifestCall!.headers.accept, MANIFEST_ACCEPT_HEADER,
    'with the full media-type set — a narrower one is how a public image reads as 404');
  // ANONYMOUS. A probe carrying our own credential proves that WE can pull, which is not the question.
  const tokenCall = seen.find((c) => c.url.includes('/token'))!;
  for (const call of seen) {
    for (const [name, value] of Object.entries(call.headers)) {
      if (name.toLowerCase() !== 'authorization') continue;
      assert(value === 'Bearer anonymous-token',
        'the only authorization sent is the anonymous pull token the registry just issued');
    }
  }
  assert(!JSON.stringify(tokenCall.headers).toLowerCase().includes('basic '), 'no basic credential is offered');
});

// ---------------------------------------------------------------------------------------------------------
// Outcomes. Each one must be reachable and must not be confused with another.
// ---------------------------------------------------------------------------------------------------------

await test('an anonymous 200 is the only thing that counts as installable', () => {
  const r = deriveImagePullPreflight({ ...base, probe: probe({ status: 200, digest: DIGEST }) });
  assertEq(r.outcome, 'PUBLICLY_PULLABLE', 'a 200 to an anonymous caller');
  assert(r.ok, 'and nothing blocks');
  assertEq(r.findings.length, 0, 'with nothing to report');
});

await test('a refused anonymous caller is NOT_PUBLIC, and the fix is a human GitHub setting stated exactly', () => {
  for (const status of [401, 403]) {
    const r = deriveImagePullPreflight({ ...base, probe: probe({ status }) });
    assertEq(r.outcome, 'NOT_PUBLIC', `${status} means the package is not public`);
    assert(!r.ok, 'which blocks the release');
    assertEq(r.findings[0]!.code, 'IMAGE_NOT_PUBLICLY_PULLABLE', 'with a stable code');
    assert(/denied or not-found/i.test(r.findings[0]!.detail), 'naming the error a consumer will actually see');
  }
  // The instructions must be actionable and must NOT claim the repository can fix it itself.
  const joined = MAKE_PUBLIC_INSTRUCTIONS.join(' ');
  assert(/cannot alter its own package visibility/i.test(joined), 'it says outright this is not ours to change');
  assert(/Change visibility/.test(joined) && /Public/.test(joined), 'and names the exact setting');
  assert(/packages\/container\/<package>\/settings/.test(joined), 'and where to find it');
  assert(/Re-run this preflight/.test(joined), 'and that the claim is only true once re-checked');
});

await test('a 404 WITHOUT an anonymous token is not "absent" — it is a private package', () => {
  // The distinction that matters: a registry that will not even issue an anonymous pull token has told us
  // about visibility, not about existence. Calling that ABSENT would send someone to look for a lost image.
  const r = deriveImagePullPreflight({ ...base, probe: probe({ status: 404, tokenObtained: false }) });
  assertEq(r.outcome, 'NOT_PUBLIC', 'no anonymous token plus 404 is a visibility answer');
  const withToken = deriveImagePullPreflight({ ...base, probe: probe({ status: 404, tokenObtained: true }) });
  assertEq(withToken.outcome, 'ABSENT', 'but a 404 to a caller who DID get a token is a missing reference');
  assertEq(withToken.findings[0]!.code, 'IMAGE_REFERENCE_ABSENT', 'reported as its own thing');
  assert(/not a visibility problem/i.test(withToken.findings[0]!.fix), 'and says so, so nobody flips a setting');
});

await test('a check that did not complete is INDETERMINATE and never a pass', () => {
  for (const p of [probe({ status: null, tokenObtained: true }), probe({ status: 500 }), probe({ status: 429 })]) {
    const r = deriveImagePullPreflight({ ...base, probe: p });
    assertEq(r.outcome, 'INDETERMINATE', 'an unusable answer establishes nothing');
    assert(!r.ok, 'and blocks rather than passing');
    assert(/NOT evidence that the image is fine/i.test(r.findings[0]!.detail),
      'and refuses to be read as either good or bad news');
  }
});

await test('pulling the WRONG bytes is not a success', () => {
  const mismatch = deriveImagePullPreflight({ ...base, probe: probe({ status: 200, digest: OTHER }), expectedDigest: DIGEST });
  assertEq(mismatch.outcome, 'PUBLICLY_PULLABLE', 'the pull did succeed');
  assert(!mismatch.ok, 'but the release is still blocked');
  assertEq(mismatch.findings[0]!.code, 'IMAGE_DIGEST_MISMATCH', 'because it resolved to different bytes');
  assert(/Do not move or overwrite anything/i.test(mismatch.findings[0]!.fix),
    'and the fix refuses to suggest a retag, which would destroy the evidence');

  const match = deriveImagePullPreflight({ ...base, probe: probe({ status: 200, digest: DIGEST }), expectedDigest: DIGEST });
  assert(match.ok, 'a matching digest passes');

  const unknown = deriveImagePullPreflight({ ...base, probe: probe({ status: 200, digest: null }), expectedDigest: DIGEST });
  assert(unknown.ok, 'a missing content-digest header does not block');
  assertEq(unknown.findings[0]!.code, 'IMAGE_DIGEST_UNCONFIRMED', 'but is reported as unconfirmed, not verified');
  assertEq(unknown.findings[0]!.severity, 'ADVISORY', 'as an advisory');
});

await test('the report authorizes nothing and describes only what it did', () => {
  const r = deriveImagePullPreflight({ ...base, probe: probe({ status: 200, digest: DIGEST }) });
  assert(/pulls no layers/i.test(r.note), 'it says it pulled no layers');
  assert(/uses no credential/i.test(r.note), 'and used no credential');
  assert(/says nothing about whether any promotion may proceed/i.test(r.note), 'and authorizes nothing');
  assertEq(r.report, 'phase-254-image-pull-preflight', 'with a stable report id');
});

// ---------------------------------------------------------------------------------------------------------
// Wiring: the gate has to be reachable, and has to be able to fail.
// ---------------------------------------------------------------------------------------------------------

await test('the preflight is a real command and a real release gate', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['ops:image-pull-preflight'], 'tsx src/ops/image-pull-preflight-cli.ts', 'the command exists');
  const workflow = read('.github/workflows/runtime-image.yml');
  assert(workflow.includes('ops:image-pull-preflight'),
    'and CI runs it, so a package that stops being public is caught by us rather than by a user');
});

await test('the CLI exits non-zero on a blocker, so it cannot be a decorative check', () => {
  const cli = read('src/ops/image-pull-preflight-cli.ts');
  assert(/process\.exit\(report\.ok \? 0 : 1\)/.test(cli), 'the exit code follows the verdict');
  assert(!/--password|--token|GITHUB_TOKEN|secrets\./.test(cli),
    'and it takes no credential — proving WE can pull would prove the wrong thing');
});

// A live check, when the network allows. It must never turn a network problem into a failed suite: an
// INDETERMINATE result here is information about this machine, not about the release.
await test('against the real registry, the published release reads as publicly pullable (skipped offline)', async () => {
  const report = await checkImageIsPubliclyPullable({
    repository: 'cdb8457/catalog-authority-ops',
    reference: 'v1.1.1',
    expectedDigest: DIGEST,
  });
  if (report.outcome === 'INDETERMINATE') {
    console.log('        (skipped: the registry could not be reached from here)');
    return;
  }
  assertEq(report.outcome, 'PUBLICLY_PULLABLE', 'an anonymous caller can fetch the published image');
  assertEq(report.observedDigest, DIGEST, 'and it resolves to exactly the digest the release pins');
  assert(report.ok, 'so the gate passes');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${String(err)}`);
  process.exit(1);
}
