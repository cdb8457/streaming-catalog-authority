import { inspect } from 'node:util';

import { createHarness, assert, assertEq, assertThrows } from './usenet-kit.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';
import {
  SEALED_KINDS,
  SealedValue,
  assertSealedSafe,
  isSealed,
  seal,
  sealedMarkerFor,
  sealedProblems,
} from '../src/core/usenet/sealed.js';

// Projection Phase 9 — the sealed value, which is the tranche's whole redaction story.
//
// WHAT THIS SUITE IS FOR. Closure rule 9 says secrets, NZB/indexer URLs, article ids and completed source
// paths appear in NONE of the preserved evidence. Every other suite in this tranche can only assert that some
// particular function does not leak. This one asserts the property the design rests on: that there is no
// ACCIDENTAL route from a sealed value to text. If any of these fail, every "and it does not leak" assertion
// elsewhere is resting on a discipline rather than on a mechanism.

const h = createHarness('Projection Phase 9 — sealed values');
const { test } = h;

const SECRET = 'https://indexer.example/getnzb?id=abc&apikey=deadbeefdeadbeefdeadbeefdeadbeef';

h.section('the four accidental routes to text');

test('template interpolation yields the marker, not the value', () => {
  const value = seal('nzb-source', SECRET);
  const line = `submitting ${value}`;
  assertEq(line, 'submitting [sealed:nzb-source]', 'interpolation');
  assert(!line.includes('apikey'), 'the interpolated line carries the value');
});

test('string concatenation yields the marker', () => {
  const value = seal('sab-api-key', 'abcdef0123456789');
  // eslint-disable-next-line prefer-template
  const line = 'key=' + value;
  assertEq(line, 'key=[sealed:sab-api-key]', 'concatenation');
});

test('JSON.stringify yields the marker, at any depth and inside an array', () => {
  const value = seal('completed-path', '/downloads/complete/projection/Some.Release/file.mkv');
  const json = JSON.stringify({ job: { outputs: [value] } });
  assertEq(json, '{"job":{"outputs":["[sealed:completed-path]"]}}', 'stringify');
});

test('util.inspect — which is what console.log uses — yields the marker', () => {
  const value = seal('job-ref', 'SABnzbd_nzo_abcdef');
  assertEq(inspect(value), '[sealed:job-ref]', 'inspect');
  assertEq(inspect({ slot: value }), '{ slot: [sealed:job-ref] }', 'inspect nested');
});

test('the four kinds are the whole set, and each has its own marker', () => {
  assertEq(SEALED_KINDS.length, 4, 'four kinds');
  const markers = new Set(SEALED_KINDS.map((kind) => sealedMarkerFor(kind)));
  assertEq(markers.size, 4, 'each kind has its own marker');
});

h.section('the value itself');

test('reveal is the only way back to the bytes', () => {
  const value = seal('nzb-source', SECRET);
  assertEq(value.reveal(), SECRET, 'reveal');
  // No enumerable property, no spread, no Object.keys route.
  assertEq(Object.keys(value).join(','), 'kind', 'the only enumerable property is the kind');
  assertEq(JSON.stringify({ ...value }), '{"kind":"nzb-source"}', 'a spread carries no payload');
});

test('a fingerprint is stable, twelve hex characters, and domain-separated by kind', () => {
  const a = seal('nzb-source', SECRET);
  const b = seal('nzb-source', SECRET);
  const other = seal('completed-path', SECRET);
  assert(/^[0-9a-f]{12}$/.test(a.fingerprint()), 'twelve hex characters');
  assertEq(a.fingerprint(), b.fingerprint(), 'the same value fingerprints the same');
  assert(a.fingerprint() !== other.fingerprint(), 'the same bytes sealed as two kinds must not collide');
  assert(!a.fingerprint().includes(SECRET.slice(0, 8)), 'a fingerprint carries no part of the value');
});

test('equality is by kind and fingerprint, and never returns the value', () => {
  assert(seal('job-ref', 'x1234567').equals(seal('job-ref', 'x1234567')), 'same');
  assert(!seal('job-ref', 'x1234567').equals(seal('nzb-source', 'x1234567')), 'kind matters');
  assert(!seal('job-ref', 'x1234567').equals('x1234567'), 'a bare string is never equal to a sealed value');
});

test('a sealed value is frozen, and its kind cannot be moved after construction', () => {
  const value = seal('sab-api-key', 'abcdef0123456789');
  assert(Object.isFrozen(value), 'frozen');
  try {
    (value as unknown as { kind: string }).kind = 'nzb-source';
  } catch {
    // strict mode throws; sloppy mode silently ignores. Either is acceptable, the read below is the assertion.
  }
  assertEq(value.kind, 'sab-api-key', 'the kind did not move');
});

test('an empty, oversized or unknown-kind seal is a refusal rather than a value', async () => {
  await assertThrows(() => seal('sab-api-key', ''), /SEALED_VALUE_EMPTY/, 'empty');
  await assertThrows(() => seal('sab-api-key', 'x'.repeat(9000)), /SEALED_VALUE_TOO_LARGE/, 'oversized');
  await assertThrows(() => seal('not-a-kind' as never, 'x'), /SEALED_KIND_UNKNOWN/, 'unknown kind');
});

test('isSealed distinguishes a sealed value from anything that merely looks like one', () => {
  assert(isSealed(seal('job-ref', 'abcdef')), 'a sealed value');
  assert(!isSealed({ kind: 'job-ref', reveal: () => 'abcdef' }), 'a look-alike object is not sealed');
  assert(!isSealed('[sealed:job-ref]'), 'the marker string is not a sealed value');
});

h.section('the scanner, which is the last gate before anything is written');

test('a clean document produces no problems', () => {
  assertEq(sealedProblems({ job: 'a1b2c3', state: 'admitted', path: 'usenet/x.mkv' }).length, 0, 'clean');
});

test('every shape a leak would have is named with its position', () => {
  const cases: ReadonlyArray<[unknown, RegExp]> = [
    [{ a: 'https://indexer.example/x' }, /RAW_URL at value\.a/],
    [{ a: 'nntps://news.example:563' }, /RAW_URL at value\.a/],
    [{ a: 'stored at /downloads/complete/x' }, /RAW_ABSOLUTE_PATH at value\.a/],
    [{ a: 'C:\\downloads\\x' }, /RAW_WINDOWS_PATH at value\.a/],
    [{ a: '<part1of9.abcdef@powerpost.local>' }, /RAW_ARTICLE_ID at value\.a/],
    [{ a: '/api?mode=queue&apikey=deadbeef' }, /RAW_API_KEY_QUERY at value\.a/],
    [{ a: 'SABnzbd_nzo_9aB3xY' }, /RAW_NZO_ID at value\.a/],
  ];
  for (const [input, pattern] of cases) {
    const problems = sealedProblems(input).join('; ');
    assert(pattern.test(problems), `expected ${String(pattern)} in "${problems}"`);
  }
});

test('a sealed value inside a document is NOT a problem — that is the whole point', () => {
  const document = { source: seal('nzb-source', SECRET), path: seal('completed-path', '/downloads/complete/x/y.mkv') };
  assertEq(sealedProblems(document).length, 0, 'sealed values are clean');
  assertEq(JSON.stringify(document).includes('indexer.example'), false, 'and stringify carries nothing');
});

test('the scanner walks arrays and nested objects, and reports the position', () => {
  const problems = sealedProblems({ jobs: [{ ok: true }, { detail: 'https://x.example/y' }] });
  assert(problems.some((problem) => problem === 'RAW_URL at value.jobs[1].detail'), problems.join('; '));
});

test('a cyclic structure terminates rather than hanging', () => {
  const node: Record<string, unknown> = { name: 'ok' };
  node['self'] = node;
  assertEq(sealedProblems(node).length, 0, 'a cycle is visited once');
});

test('a structure deeper than the scan bound is refused rather than silently unscanned', () => {
  let deep: unknown = 'https://x.example/y';
  for (let index = 0; index < 40; index += 1) deep = { next: deep };
  const problems = sealedProblems(deep);
  assert(problems.some((problem) => problem.startsWith('SCAN_DEPTH_EXCEEDED')),
    'a structure too deep to scan must say so rather than come back clean');
});

test('assertSealedSafe throws on a leak and returns quietly on a clean document', async () => {
  await assertThrows(() => { assertSealedSafe({ url: 'https://x.example' }); }, /SEALED_LEAK_REFUSED/, 'leak');
  assertSealedSafe({ job: 'a1b2c3d4e5f' });
});

h.section('wiring');

test('this suite is in the offline inventory, so a rename cannot silently end the coverage', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/usenet-sealed.ts'), 'suite in npm test');
  const inventory = JSON.parse(readFileSync(join(repoRoot, 'test/suite-inventory.json'), 'utf8')) as {
    suites: Array<{ file: string; group: string }>;
  };
  const entry = inventory.suites.find((suite) => suite.file === 'usenet-sealed.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry.group, 'offline', 'the suite runs in the offline group');
});

test('SealedValue is exported as a class so `instanceof` is the identity check everywhere', () => {
  assert(seal('job-ref', 'abcdef') instanceof SealedValue, 'instanceof');
});

await h.finish();
