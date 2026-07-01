import { BackupPolicy, type BackupArtifact } from '../src/core/backup/backup-policy.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }
const clone = (a: BackupArtifact): BackupArtifact => JSON.parse(JSON.stringify(a));
const tbl = (a: BackupArtifact, name: string): { table: string; rows: unknown[] } => a.tables.find((t) => t.table === name)!;

// A minimal but well-formed artifact (only the fields verifyStructure inspects need to be real).
function goodArtifact(): BackupArtifact {
  return {
    version: 1,
    tables: [
      { table: 'events', rows: [{ item_id: 'A', seq: 1 }, { item_id: 'B', seq: 2 }] },
      { table: 'items', rows: [{ id: 'A', last_seq: 1 }, { id: 'B', last_seq: 2 }] },
      { table: 'provider_refs', rows: [{ item_id: 'A', ref_type: 'tmdb', present: true }] },
      { table: 'item_key_control', rows: [{ item_id: 'A' }, { item_id: 'B' }] },
      { table: 'aborted_operations', rows: [] },
    ],
  } as unknown as BackupArtifact;
}

console.log('Running Phase 6 offline backup-verify suite (Stage 6.3):\n');

test('verifyStructure — a well-formed artifact passes', () => {
  const r = BackupPolicy.verifyStructure(goodArtifact());
  assert(r.ok, `ok (problems: ${r.problems.join('; ')})`);
});

test('verifyStructure — unsupported/missing version is rejected', () => {
  const a = goodArtifact(); (a as { version: number }).version = 2;
  assertEq(BackupPolicy.verifyStructure(a).ok, false, 'v2 rejected');
  assertEq(BackupPolicy.verifyStructure({} as BackupArtifact).ok, false, 'empty rejected');
});

test('verifyStructure — a missing backed-up table is rejected', () => {
  const a = goodArtifact(); a.tables = a.tables.filter((t) => t.table !== 'item_key_control');
  const r = BackupPolicy.verifyStructure(a);
  assert(!r.ok && r.problems.some((p) => /missing backed-up table: item_key_control/.test(p)), 'missing table reported');
});

test('verifyStructure — an item head not backed by an event is rejected (torn)', () => {
  const a = clone(goodArtifact());
  tbl(a, 'events').rows = (tbl(a, 'events').rows as Array<{ item_id: string }>).filter((e) => e.item_id !== 'A'); // drop A's event
  const r = BackupPolicy.verifyStructure(a);
  assert(!r.ok && r.problems.some((p) => /item A: head seq 1 is not backed/.test(p)), 'torn head reported');
});

test('verifyStructure — a dangling provider_ref is rejected', () => {
  const a = clone(goodArtifact());
  (tbl(a, 'provider_refs').rows as Array<{ item_id: string }>).push({ item_id: 'GHOST' });
  const r = BackupPolicy.verifyStructure(a);
  assert(!r.ok && r.problems.some((p) => /provider_refs references a missing item GHOST/.test(p)), 'dangling ref reported');
});

test('verifyStructure — a dangling item_key_control is rejected', () => {
  const a = clone(goodArtifact());
  (tbl(a, 'item_key_control').rows as Array<{ item_id: string }>).push({ item_id: 'GHOST' });
  const r = BackupPolicy.verifyStructure(a);
  assert(!r.ok && r.problems.some((p) => /item_key_control references a missing item GHOST/.test(p)), 'dangling key-control reported');
});

// --- malformed-but-parseable input must be REPORTED, never thrown (Codex regression) ---------
function rejectsCleanly(name: string, input: unknown): void {
  test(`verifyStructure — rejects (no throw): ${name}`, () => {
    const r = BackupPolicy.verifyStructure(input as BackupArtifact); // must not throw
    assertEq(r.ok, false, 'not ok');
    assert(r.problems.length > 0, 'has a problem message');
  });
}

rejectsCleanly('non-object artifact (string)', 'nope');
rejectsCleanly('non-object artifact (null)', null);
rejectsCleanly('array artifact', [1, 2, 3]);
rejectsCleanly('tables is not an array', { version: 1, tables: 'not-an-array' });
rejectsCleanly('a table entry is not an object', { version: 1, tables: [42] });
rejectsCleanly('a table.table is not a string', { version: 1, tables: [{ table: 5, rows: [] }] });
rejectsCleanly('a table.rows is not an array', (() => { const a = goodArtifact(); (tbl(a, 'events') as { rows: unknown }).rows = 'x'; return a; })());
rejectsCleanly('duplicate table entry', (() => { const a = goodArtifact(); a.tables.push({ table: 'events', rows: [] }); return a; })());
rejectsCleanly('malformed event row (missing seq)', (() => { const a = clone(goodArtifact()); (tbl(a, 'events').rows as unknown[]).push({ item_id: 'Z' }); return a; })());
rejectsCleanly('malformed item row (last_seq not a number)', (() => { const a = clone(goodArtifact()); (tbl(a, 'items').rows as unknown[]).push({ id: 'Z', last_seq: 'oops' }); return a; })());
rejectsCleanly('malformed provider_ref row (item_id not a string)', (() => { const a = clone(goodArtifact()); (tbl(a, 'provider_refs').rows as unknown[]).push({ item_id: 7 }); return a; })());

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
