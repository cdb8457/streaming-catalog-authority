import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PROJECTION_MANIFEST_FORMAT,
  PROJECTION_MANIFEST_VERSION,
  PROJECTION_LIMITS,
  PROJECTION_PROBE_PLAN,
  PROJECTION_VISIBILITY_STATES,
  PROJECTION_SOURCE_KINDS,
  PROJECTION_DEGRADED_REASONS,
  PROJECTION_GENERATION_INTENTS,
  PROJECTION_SHRINK_GUARD,
  canonicalJson,
  deletionAcknowledgementDigest,
  deriveInode,
  foldProjectedPath,
  manifestDigestOfBytes,
  normalizeProjectedPath,
  probeOffsetsFor,
  refreshRequestFor,
  validateManifestV1,
  validateSuccession,
  type ProjectionManifestV1,
} from '../src/core/projection/manifest-v1.js';
import {
  PROJECTIOND_ADMISSION_LIMITS,
  PROJECTIOND_CACHE_POLICY,
  PROJECTIOND_CIRCUIT_BREAKER,
  PROJECTIOND_ERROR_MAP,
  PROJECTIOND_HANDLE_BINDING,
  PROJECTIOND_OPERATIONS,
  PROJECTIOND_PLATFORM_SUPPORT,
  PROJECTIOND_RANGE_RULES,
  PROJECTIOND_READ_POLICY,
  PROJECTIOND_READAHEAD_POLICY,
  PROJECTIOND_SECRET_AND_EGRESS_POLICY,
  PROJECTION_PHASE_1_BUDGETS,
} from '../src/core/projection/runtime-contract.js';
import { AGGREGATE_SUITE_COMMAND } from './aggregate-suite.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const readJson = (rel: string): unknown => JSON.parse(read(rel));
const FIXTURES = 'test/fixtures/projection-manifest-v1';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const codes = (problems: readonly { code: string }[]): string[] => problems.map((p) => p.code);

console.log('Running Projection Phase 0 manifest v1 contract suite:\n');

// ---------------------------------------------------------------------------------------------------------
// Path normalization, inode derivation, probe plan
// ---------------------------------------------------------------------------------------------------------

test('a projected path is relative, normalized, and every deviation is a refusal rather than a rewrite', () => {
  assert(normalizeProjectedPath('Movies/A (2020)/A (2020).mkv').ok, 'a well-formed path is accepted');
  for (const [path, code] of [
    ['/Movies/A.mkv', 'PATH_ABSOLUTE'],
    ['Movies/A.mkv/', 'PATH_TRAILING_SLASH'],
    ['Movies//A.mkv', 'PATH_EMPTY_SEGMENT'],
    ['Movies/../etc/passwd', 'PATH_RELATIVE_SEGMENT'],
    ['Movies/./A.mkv', 'PATH_RELATIVE_SEGMENT'],
    ['Movies\\A.mkv', 'PATH_BACKSLASH'],
    ['Movies/A\u0000.mkv', 'PATH_CONTROL_CHARACTER'],
    ['Movies/A\u007f.mkv', 'PATH_CONTROL_CHARACTER'],
    ['Movies/ A.mkv', 'PATH_SEGMENT_PADDED'],
    ['', 'PATH_EMPTY'],
  ] as Array<[string, string]>) {
    const result = normalizeProjectedPath(path);
    assert(!result.ok, `${code}: refused`);
    assertEq(result.code, code, `${code}: reported`);
  }
  assert(!normalizeProjectedPath('Móvies/A.mkv').ok, 'a decomposed path is refused rather than composed');
  assertEq(foldProjectedPath('Movies/A.MKV'), foldProjectedPath('movies/a.mkv'), 'the fold is case-insensitive');
});

test('ino is derived from the projected version and from nothing else, and is stable', () => {
  const version = `pv_${'a'.repeat(64)}`;
  const first = deriveInode(version);
  assertEq(deriveInode(version), first, 'the same version always derives the same ino');
  assert(/^[1-9][0-9]*$/.test(first), 'ino is a positive decimal');
  assert(BigInt(first) >= 1024n, 'the low inode numbers are reserved');
  assert(BigInt(first) <= 0x7fff_ffff_ffff_ffffn, 'ino fits a signed 64-bit inode');
  assert(deriveInode(`pv_${'b'.repeat(64)}`) !== first, 'a different version derives a different ino');
  // The whole point: nothing about a path or a provider is an input, so neither can move an ino.
  const source = read('src/core/projection/manifest-v1.ts');
  const body = source.slice(source.indexOf('export function deriveInode'), source.indexOf('export function probeOffsetsFor'));
  for (const forbidden of ['path', 'locator', 'endpointId', 'sourceId', 'rootId']) {
    assert(!body.includes(forbidden), `deriveInode does not consider ${forbidden}`);
  }
});

test('the probe plan is fixed by size, not chosen by a producer', () => {
  const window = PROJECTION_PROBE_PLAN.WINDOW_BYTES;
  assertEq(probeOffsetsFor(0).length, 0, 'a zero-byte file has nothing to probe');
  assertEq(probeOffsetsFor(1024).length, 1, 'a small file is proved by one whole-file probe');
  assertEq(probeOffsetsFor(1024)[0]?.length, 1024, 'the single probe covers the whole file');
  const big = probeOffsetsFor(8_589_934_592);
  assertEq(big.length, 3, 'a large file gets head, middle and tail');
  assertEq(big[0]?.offset, 0, 'head is at zero');
  assertEq(big[2]?.offset, 8_589_934_592 - window, 'tail ends at EOF');
  assert((big[1]?.offset ?? 0) > (big[0]?.offset ?? 0) + window, 'middle does not overlap head');
});

// ---------------------------------------------------------------------------------------------------------
// The valid corpus
// ---------------------------------------------------------------------------------------------------------

const g1Bytes = read(`${FIXTURES}/generation-1-baseline.json`);
const g2Bytes = read(`${FIXTURES}/generation-2-routine-successor.json`);
const g3Bytes = read(`${FIXTURES}/generation-3-deletion.json`);
const g1Digest = manifestDigestOfBytes(g1Bytes);
const g2Digest = manifestDigestOfBytes(g2Bytes);

let g1!: ProjectionManifestV1;
let g2!: ProjectionManifestV1;
let g3!: ProjectionManifestV1;

test('the generation chain is a digest chain, so the fixture bytes must survive a checkout unaltered', () => {
  // Generation 2 names generation 1 by a sha256 over its EXACT bytes. A checkout that rewrote LF to CRLF
  // would break that chain on Windows only, and the failure would read like a contract defect. `.gitattributes`
  // marks this one directory `-text`; this assertion is what makes a future regression say so by name.
  for (const [label, bytes] of [['1', g1Bytes], ['2', g2Bytes], ['3', g3Bytes]] as Array<[string, string]>) {
    assert(!bytes.includes('\r'), `generation ${label} arrived without CR (check .gitattributes)`);
  }
  const attributes = read('.gitattributes');
  assert(attributes.includes('test/fixtures/projection-manifest-v1/** -text'), 'the fixture directory is marked -text');

  const declared = (JSON.parse(g2Bytes) as ProjectionManifestV1).generation.predecessor?.manifestDigest;
  assertEq(declared, g1Digest, 'generation 2 names generation 1 by the digest of the bytes on disk');
  const declaredThree = (JSON.parse(g3Bytes) as ProjectionManifestV1).generation.predecessor?.manifestDigest;
  assertEq(declaredThree, g2Digest, 'generation 3 names generation 2 the same way');
});

test('the three shipped generations validate, and carry the shapes Phase 1 needs to exercise', () => {
  for (const [label, bytes] of [['1', g1Bytes], ['2', g2Bytes], ['3', g3Bytes]] as Array<[string, string]>) {
    const result = validateManifestV1(JSON.parse(bytes));
    assert(result.ok, `generation ${label} validates (${codes(result.problems).join(', ')})`);
    assert(result.manifest !== null, `generation ${label} returns a manifest`);
  }
  g1 = validateManifestV1(JSON.parse(g1Bytes)).manifest as ProjectionManifestV1;
  g2 = validateManifestV1(JSON.parse(g2Bytes)).manifest as ProjectionManifestV1;
  g3 = validateManifestV1(JSON.parse(g3Bytes)).manifest as ProjectionManifestV1;

  assertEq(g1.format, PROJECTION_MANIFEST_FORMAT, 'format');
  assertEq(g1.version, PROJECTION_MANIFEST_VERSION, 'version');
  assert(g1.entries.some((e) => e.sources.some((s) => s.kind === 'local')), 'a local passthrough source is present');
  assert(g1.entries.some((e) => e.sources.some((s) => s.kind === 'http-range')), 'an HTTP Range source is present');
  assert(g1.entries.some((e) => e.sources.length > 1), 'a multi-source entry is present');
  assert(g1.entries.some((e) => e.visibility === 'degraded'), 'a degraded entry is present');
  assert(g1.entries.some((e) => e.visibility === 'retiring'), 'a retiring entry is present');
  const versions = g1.entries.map((e) => e.projectedVersionId);
  assert(new Set(versions).size < versions.length, 'a projected version shared by two paths is present');
});

test('a shared projected version means one inode, one size and one mtime at every path it appears at', () => {
  const byVersion = new Map<string, typeof g1.entries[number][]>();
  for (const entry of g1.entries) {
    const list = byVersion.get(entry.projectedVersionId) ?? [];
    list.push(entry);
    byVersion.set(entry.projectedVersionId, list);
  }
  let shared = 0;
  for (const [version, entries] of byVersion) {
    if (entries.length < 2) continue;
    shared += 1;
    const first = entries[0];
    assert(first !== undefined, 'shared version has a first entry');
    for (const entry of entries) {
      assertEq(entry.inode, deriveInode(version), 'inode is derived from the version');
      assertEq(entry.sizeBytes, first?.sizeBytes, 'size belongs to the version');
      assertEq(entry.mtime, first?.mtime, 'mtime belongs to the version');
      assertEq(canonicalJson(entry.sources[0]?.byteIdentity), canonicalJson(first?.sources[0]?.byteIdentity),
        'byte identity is proved and identical');
    }
  }
  assert(shared > 0, 'the corpus actually exercises a shared version');
});

test('generation 1 to 2 is a routine succession: an addition, a relocation, a degradation, no removal', () => {
  const result = validateSuccession({ manifest: g1, manifestDigest: g1Digest }, g2, g2.generation.createdAt);
  assert(result.ok, `succession holds (${codes(result.problems).join(', ')})`);
  assertEq(result.additions.length, 1, 'one addition');
  assertEq(result.deletions.length, 0, 'no removal in a routine generation');
  assertEq(result.relocations.length, 1, 'one declared path correction');
  assertEq(result.degradedChanges.length, 2, 'one entry recovered and one degraded');

  const refresh = refreshRequestFor(result);
  assert(refresh.refreshRequired, 'an addition earns a refresh');
  assertEq(refresh.added.length, 1, 'the refresh names the addition');
  assertEq(refresh.removed.length, 0, 'the refresh removes nothing');
});

test('a degraded transition, on its own, asks a media server for nothing at all', () => {
  const onlyDegraded = clone(g2) as unknown as { entries: Array<Record<string, unknown>>; generation: Record<string, unknown> };
  // Strip the addition and the relocation so the ONLY difference from generation 1 is visibility.
  onlyDegraded.entries = onlyDegraded.entries.filter((e) => g1.entries.some((p) => p.projectedEntryId === e['projectedEntryId']));
  for (const entry of onlyDegraded.entries) {
    const previous = g1.entries.find((p) => p.projectedEntryId === entry['projectedEntryId']);
    if (previous !== undefined) entry['path'] = previous.path;
  }
  const admission = onlyDegraded.generation['admission'] as Record<string, unknown>;
  admission['entryCount'] = onlyDegraded.entries.length;
  admission['relocations'] = [];

  const validated = validateManifestV1(onlyDegraded);
  assert(validated.ok, `the degrade-only generation validates (${codes(validated.problems).join(', ')})`);
  const result = validateSuccession(
    { manifest: g1, manifestDigest: g1Digest },
    validated.manifest as ProjectionManifestV1,
    g2.generation.createdAt,
  );
  assert(result.ok, `the degrade-only succession holds (${codes(result.problems).join(', ')})`);
  assert(result.degradedChanges.length > 0, 'visibility really did change');
  const refresh = refreshRequestFor(result);
  assertEq(refresh.refreshRequired, false, 'a degraded entry never triggers a library refresh');
  assertEq(refresh.added.length, 0, 'nothing added');
  assertEq(refresh.removed.length, 0, 'nothing removed');
});

test('generation 2 to 3 removes exactly the entry that was retiring past its grace deadline', () => {
  const result = validateSuccession({ manifest: g2, manifestDigest: g2Digest }, g3, g3.generation.createdAt);
  assert(result.ok, `the deletion succession holds (${codes(result.problems).join(', ')})`);
  assertEq(result.deletions.length, 1, 'one completed deletion');
  assertEq(result.additions.length, 0, 'a deletion generation adds nothing');
  const removed = g2.entries.find((e) => e.projectedEntryId === result.deletions[0]);
  assertEq(removed?.visibility, 'retiring', 'the removed entry was retiring');
  assert(refreshRequestFor(result).refreshRequired, 'a completed deletion earns a refresh');
});

test('a passed grace deadline expires nothing: the entry stays until a deletion generation names it', () => {
  // Generation 2 carries the retiring entry with a grace deadline of 2026-08-01. Re-admit it long after
  // that deadline and nothing changes: it is still present, still readable, still not deleted.
  const later = clone(g2) as unknown as Record<string, unknown>;
  const generation = later['generation'] as Record<string, unknown>;
  generation['generationId'] = 'gen_00000000000000000000000000000099';
  generation['sequence'] = 3;
  generation['createdAt'] = '2026-12-31T00:00:00.000Z';
  generation['predecessor'] = { generationId: g2.generation.generationId, sequence: 2, manifestDigest: g2Digest };
  const validated = validateManifestV1(later);
  assert(validated.ok, `the late generation validates (${codes(validated.problems).join(', ')})`);
  const result = validateSuccession(
    { manifest: g2, manifestDigest: g2Digest },
    validated.manifest as ProjectionManifestV1,
    '2027-06-01T00:00:00.000Z',
  );
  assert(result.ok, `the late succession holds (${codes(result.problems).join(', ')})`);
  assertEq(result.deletions.length, 0, 'an expired grace deadline deletes nothing by itself');
  const stillThere = (validated.manifest as ProjectionManifestV1).entries
    .find((e) => e.visibility === 'retiring');
  assert(stillThere !== undefined, 'the retiring entry is still in the namespace');
});

// ---------------------------------------------------------------------------------------------------------
// The adversarial corpus
// ---------------------------------------------------------------------------------------------------------

interface AdversarialCase {
  readonly file: string;
  readonly kind: 'standalone' | 'succession';
  readonly expectedProblem: string;
  readonly previous?: string;
  readonly nowIso?: string;
}

const corpus = (readJson(`${FIXTURES}/adversarial-index.json`) as { cases: AdversarialCase[] }).cases;

test('the adversarial corpus covers every rule Phase 1 depends on, and covers both kinds', () => {
  assert(corpus.length >= 25, `the corpus is not thin (got ${corpus.length})`);
  assert(corpus.some((c) => c.kind === 'standalone'), 'standalone cases exist');
  assert(corpus.some((c) => c.kind === 'succession'), 'succession cases exist');
  for (const required of [
    'ENTRY_DISAPPEARED_WITHOUT_DELETION',
    'DELETED_ENTRY_WAS_NOT_RETIRING',
    'DELETED_ENTRY_GRACE_NOT_ELAPSED',
    'SHRINK_GUARD_UNACKNOWLEDGED',
    'SUCCESSION_PREDECESSOR_DIGEST_MISMATCH',
    'PROJECTED_VERSION_ID_CHANGED',
    'PATH_CHANGED_WITHOUT_RELOCATION',
    'INODE_COLLISION',
    'ENTRY_INODE_NOT_DERIVED',
    'DUPLICATE_PATH',
    'PATH_CASE_COLLISION',
    'SHARED_VERSION_SIZE_MISMATCH',
    'MULTI_SOURCE_BYTE_IDENTITY_REQUIRED',
    'MULTI_SOURCE_BYTE_IDENTITY_MISMATCH',
    'LOCATOR_VALUE_CREDENTIAL_SHAPED',
    'LOCATOR_VALUE_URL_SHAPED',
    'ADMISSION_ROUTINE_GENERATION_DELETES',
    'ENTRY_SIZE_INVALID',
    'UNKNOWN_FIELD',
  ]) {
    assert(corpus.some((c) => c.expectedProblem === required), `the corpus exercises ${required}`);
  }
});

for (const testCase of corpus) {
  test(`adversarial: ${testCase.file.replace('adversarial/', '')} is refused with ${testCase.expectedProblem}`, () => {
    const document = readJson(`${FIXTURES}/${testCase.file}`);
    if (testCase.kind === 'standalone') {
      const result = validateManifestV1(document);
      assert(!result.ok, 'refused');
      assertEq(result.manifest, null, 'no manifest is handed back from a refusal');
      assert(codes(result.problems).includes(testCase.expectedProblem),
        `names ${testCase.expectedProblem} (got ${codes(result.problems).join(', ')})`);
      return;
    }
    const candidate = validateManifestV1(document);
    assert(candidate.ok, `the candidate is structurally valid (${codes(candidate.problems).join(', ')})`);
    const previousBytes = read(`${FIXTURES}/${testCase.previous}`);
    const previous = validateManifestV1(JSON.parse(previousBytes));
    assert(previous.ok, `the predecessor is structurally valid (${codes(previous.problems).join(', ')})`);
    const result = validateSuccession(
      { manifest: previous.manifest as ProjectionManifestV1, manifestDigest: manifestDigestOfBytes(previousBytes) },
      candidate.manifest as ProjectionManifestV1,
      testCase.nowIso ?? (candidate.manifest as ProjectionManifestV1).generation.createdAt,
    );
    assert(!result.ok, 'refused');
    assert(codes(result.problems).includes(testCase.expectedProblem),
      `names ${testCase.expectedProblem} (got ${codes(result.problems).join(', ')})`);
  });
}

test('a control plane that goes silent removes nothing: there is no code path from absence to deletion', () => {
  // The strongest form of the rule. Take the baseline and hand the daemon an EMPTY generation - the shape a
  // failed, short or timed-out scan would produce - and it must be refused wholesale.
  const empty = clone(g1) as unknown as Record<string, unknown>;
  const generation = empty['generation'] as Record<string, unknown>;
  generation['generationId'] = 'gen_00000000000000000000000000000042';
  generation['sequence'] = 2;
  generation['createdAt'] = '2026-07-15T00:00:00.000Z';
  generation['predecessor'] = { generationId: g1.generation.generationId, sequence: 1, manifestDigest: g1Digest };
  (generation['admission'] as Record<string, unknown>)['entryCount'] = 0;
  empty['entries'] = [];
  const validated = validateManifestV1(empty);
  assert(validated.ok, `an empty generation is structurally legal (${codes(validated.problems).join(', ')})`);
  const result = validateSuccession(
    { manifest: g1, manifestDigest: g1Digest },
    validated.manifest as ProjectionManifestV1,
    '2026-07-15T00:00:00.000Z',
  );
  assert(!result.ok, 'an empty successor is refused');
  assertEq(result.deletions.length, 0, 'and it deletes nothing on its way out');
  for (const entry of g1.entries) {
    assert(codes(result.problems).includes('ENTRY_DISAPPEARED_WITHOUT_DELETION'), 'each absence is named');
    assert(entry.projectedEntryId.startsWith('pe_'), 'entry ids are well formed');
  }
});

test('the shrink guard is satisfiable only by an acknowledgement bound to the exact id set', () => {
  const baseBytes = read(`${FIXTURES}/adversarial/successor-shrink-guard-base.json`);
  const base = validateManifestV1(JSON.parse(baseBytes)).manifest as ProjectionManifestV1;
  const shrunk = readJson(`${FIXTURES}/adversarial/successor-shrink-guard-unacknowledged.json`) as Record<string, unknown>;

  const admission = (shrunk['generation'] as Record<string, unknown>)['admission'] as Record<string, unknown>;
  const deletions = admission['deletions'] as string[];

  const wrong = clone(shrunk);
  const wrongAdmission = (wrong['generation'] as Record<string, unknown>)['admission'] as Record<string, unknown>;
  wrongAdmission['deletionGuardAcknowledged'] = true;
  wrongAdmission['deletionGuardDigest'] = deletionAcknowledgementDigest(deletions.slice(1));
  const wrongResult = validateManifestV1(wrong);
  assert(!wrongResult.ok, 'an acknowledgement over a different id set is refused');
  assert(codes(wrongResult.problems).includes('ADMISSION_DELETION_GUARD_DIGEST_MISMATCH'), 'and says why');

  const right = clone(shrunk);
  const rightAdmission = (right['generation'] as Record<string, unknown>)['admission'] as Record<string, unknown>;
  rightAdmission['deletionGuardAcknowledged'] = true;
  rightAdmission['deletionGuardDigest'] = deletionAcknowledgementDigest(deletions);
  const rightValidated = validateManifestV1(right);
  assert(rightValidated.ok, `a correct acknowledgement validates (${codes(rightValidated.problems).join(', ')})`);
  const succession = validateSuccession(
    { manifest: base, manifestDigest: manifestDigestOfBytes(baseBytes) },
    rightValidated.manifest as ProjectionManifestV1,
    '2026-08-20T00:00:00.000Z',
  );
  assert(succession.ok, `and the succession then holds (${codes(succession.problems).join(', ')})`);
  assert(succession.deletions.length > PROJECTION_SHRINK_GUARD.MAX_DELETIONS_ABSOLUTE, 'it really was a mass deletion');
});

// ---------------------------------------------------------------------------------------------------------
// The JSON Schema and the validator are one contract, not two
// ---------------------------------------------------------------------------------------------------------

const schema = readJson('docs/schemas/projection-manifest-v1.schema.json') as Record<string, never>;
const defs = (schema as unknown as { $defs: Record<string, Record<string, unknown>> }).$defs;

test('the JSON Schema names the same closed sets the validator enforces', () => {
  const entry = defs['entry'] as { properties: Record<string, Record<string, unknown>> };
  assertEq(canonicalJson(entry.properties['visibility']?.['enum']), canonicalJson([...PROJECTION_VISIBILITY_STATES]), 'visibility enum');
  assertEq(canonicalJson(entry.properties['mode']?.['const']), canonicalJson(0o444), 'mode const');
  assertEq(canonicalJson(entry.properties['nodeKind']?.['const']), canonicalJson('file'), 'node kind const');

  const source = defs['source'] as { properties: Record<string, Record<string, unknown>> };
  assertEq(canonicalJson(source.properties['kind']?.['enum']), canonicalJson([...PROJECTION_SOURCE_KINDS]), 'source kind enum');

  const degraded = (entry.properties['degraded']?.['oneOf'] as Array<Record<string, never>>)[1] as unknown as
    { properties: Record<string, Record<string, unknown>> };
  assertEq(canonicalJson(degraded.properties['reason']?.['enum']), canonicalJson([...PROJECTION_DEGRADED_REASONS]), 'degraded reasons');

  const generation = defs['generation'] as { properties: Record<string, Record<string, unknown>> };
  const admission = generation.properties['admission'] as { properties: Record<string, Record<string, unknown>> };
  assertEq(canonicalJson(admission.properties['intent']?.['enum']), canonicalJson([...PROJECTION_GENERATION_INTENTS]), 'intents');

  const provenance = generation.properties['provenance'] as { properties: Record<string, Record<string, unknown>> };
  assertEq(provenance.properties['probeWindowBytes']?.['const'], PROJECTION_PROBE_PLAN.WINDOW_BYTES, 'probe window');
  assertEq((defs['byteIdentity'] as { properties: Record<string, Record<string, unknown>> })
    .properties['probeWindowBytes']?.['const'], PROJECTION_PROBE_PLAN.WINDOW_BYTES, 'byte identity probe window');
});

test('every field the schema requires is a field the validator refuses to do without', () => {
  const cases: Array<[string, string[], (doc: Record<string, never>) => Record<string, unknown>]> = [
    ['entry', (defs['entry'] as { required: string[] }).required,
      (doc) => ((doc as unknown as { entries: Record<string, unknown>[] }).entries[0] as Record<string, unknown>)],
    ['generation', (defs['generation'] as { required: string[] }).required,
      (doc) => (doc as unknown as { generation: Record<string, unknown> }).generation],
  ];
  for (const [label, required, pick] of cases) {
    assert(required.length > 0, `${label} declares required fields`);
    for (const field of required) {
      const doc = clone(JSON.parse(g1Bytes) as Record<string, never>);
      const target = pick(doc);
      assert(field in target, `${label}.${field} is present in the valid fixture`);
      delete target[field];
      const result = validateManifestV1(doc);
      assert(!result.ok, `removing ${label}.${field} is refused by the validator`);
    }
    // And the reverse direction: the fixture carries nothing the schema has not declared.
    const target = pick(clone(JSON.parse(g1Bytes) as Record<string, never>));
    for (const key of Object.keys(target)) {
      assert(required.includes(key), `${label}.${key} is declared required by the schema`);
    }
  }
});

test('the schema forbids the two locator shapes that would carry a secret into a manifest', () => {
  const locator = defs['httpRangeLocator'] as { properties: Record<string, Record<string, unknown>> };
  const objectRef = locator.properties['objectRef'] as { not?: { pattern?: string } };
  assert(typeof objectRef.not?.pattern === 'string', 'objectRef carries a refusal pattern');
  assert(objectRef.not?.pattern?.includes('://') === true, 'a scheme is refused');
  assert(objectRef.not?.pattern?.includes('?') === true, 'a query is refused');
  assert(objectRef.not?.pattern?.includes('@') === true, 'userinfo is refused');
});

// ---------------------------------------------------------------------------------------------------------
// The runtime contract
// ---------------------------------------------------------------------------------------------------------

test('every metadata operation is local, every mutation is absent, and only read touches a source', () => {
  for (const op of ['getattr', 'lookup', 'readdir', 'readdirplus', 'statfs', 'open', 'release'] as const) {
    assertEq(PROJECTIOND_OPERATIONS[op], 'local', `${op} answers from immutable memory`);
  }
  assertEq(PROJECTIOND_OPERATIONS.read, 'source', 'read is the only source-touching operation');
  for (const op of ['write', 'create', 'mkdir', 'unlink', 'rmdir', 'rename', 'truncate', 'setattr',
    'link', 'symlink', 'setxattr', 'removexattr', 'fallocate'] as const) {
    assertEq(PROJECTIOND_OPERATIONS[op], 'refused', `${op} has no v1 surface`);
  }
  const classes = new Set(Object.values(PROJECTIOND_OPERATIONS));
  assertEq(classes.size, 3, 'there are exactly three operation classes');
});

test('nothing transient maps to ENOENT, and nothing maps to a hang', () => {
  const enoent = Object.entries(PROJECTIOND_ERROR_MAP).filter(([, errno]) => errno === 'ENOENT');
  assertEq(enoent.length, 1, 'exactly one condition means ENOENT');
  assertEq(enoent[0]?.[0], 'path-not-in-generation', 'and it is the only one that means the file is not there');
  for (const transient of ['source-unreachable', 'source-auth-refused', 'source-not-found', 'locator-expired',
    'circuit-open', 'read-deadline-exceeded', 'admission-queue-timeout', 'entry-degraded'] as const) {
    assertEq(PROJECTIOND_ERROR_MAP[transient], 'EIO', `${transient} is EIO, never ENOENT`);
  }
  assertEq(PROJECTIOND_ERROR_MAP['mutation-attempted'], 'EROFS', 'a mutation is EROFS');
  assertEq(PROJECTIOND_ERROR_MAP['control-plane-unavailable'], 'served-from-last-generation',
    'a control-plane outage is not an error at all');
  for (const value of Object.values(PROJECTIOND_ERROR_MAP)) {
    assert(!String(value).toLowerCase().includes('block'), 'no condition maps to blocking');
    assert(!String(value).toLowerCase().includes('wait'), 'no condition maps to waiting');
  }
});

test('a degraded entry costs the provider nothing, and an open circuit costs it nothing either', () => {
  assertEq(PROJECTIOND_ERROR_MAP['entry-degraded'], 'EIO', 'degraded fails fast');
  assert(PROJECTIOND_CIRCUIT_BREAKER.WHILE_OPEN.includes('zero-provider-traffic'), 'an open circuit sends nothing');
  assert(PROJECTIOND_CIRCUIT_BREAKER.HALF_OPEN_PROBES === 1, 'half-open lets exactly one request through');
  // The failure that would make `degraded` worthless: a degraded read that still contacts the provider. The
  // module must state the local answer, and it must not describe degraded as a retry state.
  const source = read('src/core/projection/runtime-contract.ts');
  assert(source.includes('fail-fast-locally-zero-provider-traffic'), 'the local answer is stated');
  const retryText = PROJECTIOND_RETRY_CLASSES_TEXT(source);
  assert(!retryText.includes('entry-degraded'), 'degraded is not a retry class');
  // The failure this is really guarding: an "eventually re-probe the degraded entry" backoff, which would
  // make degraded cost MORE provider traffic than available. The contract must forbid it in words too.
  const contract = read('docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md');
  assert(contract.includes('SHALL NOT re-probe a degraded entry'), 'no per-entry re-probe');
  assert(contract.includes('per-entry backoff that ends in a provider request'), 'no per-entry backoff');
});

test('an expired locator is terminal, because only a new generation can supply a fresh one', () => {
  const source = read('src/core/projection/runtime-contract.ts');
  const retryText = PROJECTIOND_RETRY_CLASSES_TEXT(source);
  const terminal = retryText.slice(retryText.indexOf('terminal:'));
  assert(terminal.includes("'locator-expired'"), 'an expired locator is terminal');
  const refresh = retryText.slice(retryText.indexOf('credential-refresh-then-retry'), retryText.indexOf('terminal:'));
  assert(!refresh.includes('locator-expired'), 'and is not something the daemon refreshes for itself');
  assertEq(PROJECTIOND_READ_POLICY.MAX_CREDENTIAL_REFRESH_RETRIES_PER_SOURCE_GENERATION, 1,
    'the one refresh the daemon does is a credential re-read, not a locator request');
});

test('the two manifest bounds are sized against each other, so neither is unreachable', () => {
  // A bound that the other bound always fires before is a bound that says nothing.
  const worstCaseEntryBytes = 1024;
  assert(PROJECTION_LIMITS.MAX_ENTRIES * worstCaseEntryBytes <= PROJECTION_LIMITS.MAX_ARTIFACT_BYTES,
    'a manifest at the entry bound fits inside the byte bound');
  const schemaMaxItems = (schema as unknown as { properties: { entries: { maxItems: number } } }).properties.entries.maxItems;
  assertEq(schemaMaxItems, PROJECTION_LIMITS.MAX_ENTRIES, 'the schema and the validator agree on the entry bound');
});

function PROJECTIOND_RETRY_CLASSES_TEXT(source: string): string {
  const start = source.indexOf('PROJECTIOND_RETRY_CLASSES');
  return source.slice(start, source.indexOf('PROJECTIOND_RANGE_RULES'));
}

test('a full-body answer to a ranged request is a protocol violation, not a slow success', () => {
  assertEq(PROJECTIOND_RANGE_RULES.REQUIRED_STATUS_FOR_PARTIAL, 206, '206 is required');
  assertEq(PROJECTIOND_RANGE_RULES.FULL_BODY_ANSWER_TO_PARTIAL_REQUEST, 'abort-and-fail-source',
    'a 200 to a ranged request is aborted, never buffered');
  assertEq(PROJECTIOND_RANGE_RULES.CONTENT_RANGE_MUST_MATCH_REQUEST_EXACTLY, true, 'Content-Range is checked exactly');
  assertEq(PROJECTIOND_RANGE_RULES.TOTAL_SIZE_MUST_MATCH_MANIFEST, true, 'the total must be the manifest size');
  assertEq(PROJECTIOND_RANGE_RULES.SHORT_BODY, 'fail-source', 'a short body is a truncation, not an EOF');
  assertEq(PROJECTIOND_ERROR_MAP['offset-beyond-eof'], 'EOF-zero-bytes', 'a read past EOF is an EOF, not an error');
});

test('every deadline is bounded and the read deadline dominates the parts it is made of', () => {
  const p = PROJECTIOND_READ_POLICY;
  for (const [name, value] of Object.entries(p)) {
    assert(typeof value === 'number' && value > 0, `${name} is a positive bound`);
  }
  assert(p.CONNECT_DEADLINE_MS < p.READ_DEADLINE_MS, 'connect is inside the read deadline');
  assert(p.FIRST_BYTE_DEADLINE_MS < p.READ_DEADLINE_MS, 'first byte is inside the read deadline');
  assert(p.MAX_HONOURED_RETRY_AFTER_MS < p.READ_DEADLINE_MS, 'a provider cannot extend a read past its deadline');
  assert(p.MAX_ATTEMPTS_PER_READ >= 1 && p.MAX_ATTEMPTS_PER_READ <= 5, 'retries are bounded and small');
  assertEq(p.MAX_CREDENTIAL_REFRESH_RETRIES_PER_SOURCE_GENERATION, 1, 'a rotated credential is retried once');
  assert(PROJECTIOND_ADMISSION_LIMITS.MAX_QUEUE_WAIT_MS < p.READ_DEADLINE_MS, 'a queued read cannot outlive its deadline');
  assert(PROJECTIOND_ADMISSION_LIMITS.PER_ENDPOINT_MAX_INFLIGHT_REQUESTS
    <= PROJECTIOND_ADMISSION_LIMITS.GLOBAL_MAX_INFLIGHT_SOURCE_REQUESTS, 'per-endpoint is inside the global cap');
  assertEq(PROJECTIOND_ADMISSION_LIMITS.CROSS_OPEN_SINGLE_FLIGHT, true, 'two opens of one chunk are one request');
});

test('the two caches answer two different questions, and the probe cache is keyed so failover keeps it', () => {
  assertEq(PROJECTIOND_CACHE_POLICY.probePrefix.PERSISTENT, true, 'the probe cache survives a restart');
  assertEq(PROJECTIOND_CACHE_POLICY.probePrefix.KEY, 'projected-version-id', 'keyed by version, not path or source');
  assertEq(PROJECTIOND_CACHE_POLICY.probePrefix.BYTES_PER_VERSION, PROJECTION_PROBE_PLAN.WINDOW_BYTES,
    'the probe cache holds exactly the probe window');
  assertEq(PROJECTIOND_CACHE_POLICY.playback.PERSISTENT, false, 'the playback cache is ephemeral');
  assertEq(PROJECTIOND_CACHE_POLICY.playback.EVICTION, 'dropped-on-release', 'and goes when the handle does');
  assertEq(PROJECTIOND_READAHEAD_POLICY.SUPPRESSED_WITHIN_BYTES, PROJECTION_PROBE_PLAN.WINDOW_BYTES,
    'a scan never pulls more than the probe window');
  assertEq(PROJECTIOND_READAHEAD_POLICY.ACTIVE_STREAM_PINNING, true, 'an active stream pins what it is using');
});

test('an open binds to one source generation, survives a swap, and fails over only on proof', () => {
  assertEq(canonicalJson(PROJECTIOND_HANDLE_BINDING.BINDS_TO),
    canonicalJson(['projectedEntryId', 'generationId', 'sourceId', 'sourceGeneration']), 'the binding is exact');
  assertEq(PROJECTIOND_HANDLE_BINDING.SURVIVES_MANIFEST_SWAP, true, 'a swap does not disturb an open handle');
  assertEq(PROJECTIOND_HANDLE_BINDING.PRIOR_GENERATION_RECLAIM, 'on-last-handle-release', 'a pinned generation is retained');
  assertEq(PROJECTIOND_HANDLE_BINDING.MID_HANDLE_FAILOVER, 'proven-byte-identical-sources-only', 'no unproven failover');
  assertEq(PROJECTIOND_ERROR_MAP['no-byte-identical-failover'], 'EIO', 'and without proof the read fails');
});

test('a provider token has one home, and the provider allowlist is not the media-server one', () => {
  const policy = PROJECTIOND_SECRET_AND_EGRESS_POLICY;
  assertEq(policy.TOKEN_SOURCE, 'secret-file', 'the token comes from a file');
  assertEq(policy.TOKEN_PLACEMENT, 'authorization-header', 'and never from a URL');
  for (const place of ['argv', 'log', 'manifest', 'error-message'] as const) {
    assert(policy.TOKEN_NEVER_IN.includes(place), `the token is never in ${place}`);
  }
  assertEq(policy.PROVIDER_EGRESS.PUBLIC_HOSTS_PERMITTED, true, 'a provider is a public host by design');
  assertEq(policy.PROVIDER_EGRESS.REDIRECTS_FOLLOWED, false, 'redirects are not followed');
  assertEq(policy.PROVIDER_EGRESS.TLS_VERIFICATION_REQUIRED, true, 'TLS is verified');
  assertEq(policy.MEDIA_SERVER_EGRESS.RULE, 'private-host-url-policy-unchanged', 'the Jellyfin rule is untouched');
  assertEq(policy.MEDIA_SERVER_EGRESS.PROJECTIOND_MAY_CONTACT_MEDIA_SERVER, false, 'the data plane talks to no media server');
  // The Jellyfin policy really is still there and still private-only.
  const urlPolicy = read('src/core/adapters/jellyfin/url-policy.ts');
  assert(urlPolicy.length > 0, 'the Jellyfin URL policy module still exists');
});

test('the platform table says what a Windows box can and cannot prove', () => {
  assert(PROJECTIOND_PLATFORM_SUPPORT.PRODUCTION.includes('linux'), 'production is Linux');
  assert(PROJECTIOND_PLATFORM_SUPPORT.PRODUCTION.includes('unraid'), 'and Unraid');
  assert(PROJECTIOND_PLATFORM_SUPPORT.DEVELOPMENT_ONLY.includes('windows'), 'Windows is development only');
  for (const claim of ['fuse-mount-propagation', 'media-server-scan-behaviour', 'daemon-kill-and-remount-recovery'] as const) {
    assert(PROJECTIOND_PLATFORM_SUPPORT.NOT_PROVABLE_OFF_LINUX.includes(claim), `${claim} needs a real Linux host`);
  }
});

test('the Phase 1 budgets are the numbers the plan states', () => {
  assertEq(PROJECTION_PHASE_1_BUDGETS.MAX_REQUEST_MULTIPLIER, 1.2, 'request multiplier');
  assertEq(PROJECTION_PHASE_1_BUDGETS.MAX_BYTE_MULTIPLIER, 1.2, 'byte multiplier');
  assertEq(PROJECTION_PHASE_1_BUDGETS.MAX_HTTP_429, 0, '429 count');
  assertEq(PROJECTION_PHASE_1_BUDGETS.MAX_LIBRARY_CHURN_ITEMS, 0, 'library churn');
  const plan = read('docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md');
  for (const stated of ['1.2x', '429', 'entry count', 'probe window']) {
    assert(plan.includes(stated), `the plan states ${stated}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// Documents and wiring
// ---------------------------------------------------------------------------------------------------------

test('the Phase 0 documents exist and are normative rather than aspirational', () => {
  const adr = read('docs/ADR_002_PROJECTION_APPLIANCE.md');
  const contract = read('docs/PROJECTION_PHASE_0_PRODUCT_CONTRACT.md');
  const roadmap = read('docs/PROJECTION_ROADMAP.md');
  const plan = read('docs/PROJECTION_PHASE_1_ACCEPTANCE_PLAN.md');

  for (const kw of ['Supersede', 'projectiond', 'control plane', 'data plane', 'FUSE', 'rclone', 'WebDAV', 'SQLite']) {
    assert(adr.includes(kw), `the ADR covers ${kw}`);
  }
  for (const kw of ['MUST', 'SHALL', 'projected version', 'degraded', 'retiring', 'byte-identity',
    'single-flight', 'Circuit breaker', 'EROFS', 'ENOENT', 'EIO', 'probe']) {
    assert(contract.includes(kw), `the contract covers ${kw}`);
  }
  for (const kw of ['anti-detour', 'Phase 1', 'vertical slice']) {
    assert(roadmap.includes(kw), `the roadmap covers ${kw}`);
  }
  for (const kw of ['Plex', 'Jellyfin', 'Emby', 'Unraid', 'Windows', 'fake', 'real-provider']) {
    assert(plan.includes(kw), `the plan covers ${kw}`);
  }
  // No vague future claims. These are the words this repository has had to stop using.
  for (const doc of [adr, contract, plan, roadmap]) {
    for (const vague of ['best effort', 'should eventually', 'will probably', 'in a future phase we may']) {
      assert(!doc.toLowerCase().includes(vague), `no vague claim: ${vague}`);
    }
  }
});

test('the superseded non-goals are named individually, not waved at', () => {
  const adr = read('docs/ADR_002_PROJECTION_APPLIANCE.md');
  for (const superseded of [
    'PHASE_31_TORBOX_BOUNDARY',
    'PHASE_55_PROVIDER_AVAILABILITY_POLICY',
    'PHASE_7_ADAPTER_BOUNDARY',
    'PHASE_203_MEDIA_PLAYER_BOUNDARY_SELECTION',
  ]) {
    assert(adr.includes(superseded), `the ADR names ${superseded}`);
  }
  for (const preserved of ['Crypto-shredding', 'private', 'append-only']) {
    assert(adr.includes(preserved), `the ADR states ${preserved} is unchanged`);
  }
  // History is superseded, never deleted.
  for (const kept of [
    'docs/PHASE_31_TORBOX_BOUNDARY.md',
    'docs/PHASE_55_PROVIDER_AVAILABILITY_POLICY.md',
    'docs/PHASE_7_ADAPTER_BOUNDARY.md',
    'docs/PHASE_203_MEDIA_PLAYER_BOUNDARY_SELECTION.md',
  ]) {
    assert(read(kept).length > 0, `${kept} is still on disk`);
  }
});

test('package, README, inventory and the aggregate run are wired', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['test:projection-manifest-v1'], 'tsx test/projection-manifest-v1.ts', 'test script');
  assert((AGGREGATE_SUITE_COMMAND ?? '').includes('test/projection-manifest-v1.ts'), 'suite in npm test');
  const inventory = JSON.parse(read('test/suite-inventory.json')) as { suites: Array<{ file: string; group: string }> };
  const entry = inventory.suites.find((s) => s.file === 'projection-manifest-v1.ts');
  assert(entry !== undefined, 'suite is inventoried');
  assertEq(entry?.group, 'offline', 'and needs no database');
  const readme = read('README.md');
  for (const kw of ['projection appliance', 'projectiond', 'docs/PROJECTION_ROADMAP.md']) {
    assert(readme.includes(kw), `README mentions ${kw}`);
  }
});

test('the contract modules touch nothing: no network, no filesystem, no database, no clock', () => {
  for (const rel of ['src/core/projection/manifest-v1.ts', 'src/core/projection/runtime-contract.ts']) {
    const source = read(rel);
    for (const forbidden of [
      'globalThis.fetch', 'fetch(', 'process.env', 'readFileSync', 'writeFileSync',
      "from 'node:fs'", "from 'node:http'", "from 'node:https'", "from 'node:net'", "from 'pg'",
      'child_process', 'Date.now(', 'new Date(',
    ]) {
      assert(!source.includes(forbidden), `${rel} excludes ${forbidden}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
