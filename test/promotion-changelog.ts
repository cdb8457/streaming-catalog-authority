import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChangelog, CHANGELOG_DISCLAIMERS, CHANGELOG_HUMAN_GATES } from '../src/ops/promotion-changelog.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

function workspace(): string { return mkdtempSync(join(tmpdir(), 'catalog-changelog-')); }
const COMMITS = [
  { sha: '13a7bfb2f95ac8b13b589a83fdc93efe62caae0f', subject: 'Add gate dependency DAG (phase X)' },
  { sha: 'ce50243cee6dbcebe0183f4c21c71de13026b500', subject: 'Add provenance ledger (phase W)' },
];

console.log('Running Phase 230 changelog suite:\n');

await test('builds a changelog with entries, human gates, and disclaimers', () => {
  const cl = buildChangelog({ commits: COMMITS });
  assert(cl.ok, `ok (problems: ${cl.problems.join(',')})`);
  assertEq(cl.authorization, 'NONE', 'authorizes nothing');
  assertEq(cl.count, 2, 'two entries');
  assertEq(cl.humanGates.length, CHANGELOG_HUMAN_GATES.length, 'human gates present');
  assert(cl.disclaimers.some((d) => /does NOT authorize Phase 231/i.test(d)), 'explicit no-Phase-231 language');
  assert(/^[0-9a-f]{64}$/.test(cl.changelogDigest), 'changelog digest present');
});

await test('rejects a commit subject carrying a raw path', () => {
  const cl = buildChangelog({ commits: [{ sha: COMMITS[0]!.sha, subject: 'touched /mnt/user/media/Movies by mistake' }] });
  assert(!cl.ok, 'rejected');
  assert(cl.problems.includes('RAW_PATH_IN_CHANGELOG'), 'raw-path problem');
});

await test('rejects an invalid sha and an empty range', () => {
  const bad = buildChangelog({ commits: [{ sha: 'nope', subject: 'x' }] });
  assert(!bad.ok && bad.problems.includes('COMMIT_SHA_INVALID'), 'invalid sha problem');
  const empty = buildChangelog({ commits: [] });
  assert(!empty.ok, 'empty range is not ok');
});

await test('the changelog is redaction-safe and its digest recomputes deterministically', () => {
  const cl = buildChangelog({ commits: COMMITS });
  assert(cl.redactionSafe === true && !JSON.stringify(cl).includes('/mnt/'), 'redaction-safe');
  const { changelogDigest, ...rest } = cl as unknown as Record<string, unknown> & { changelogDigest: string };
  const recomputed = createHash('sha256').update(`phase-230-changelog:${JSON.stringify(rest)}`).digest('hex');
  assertEq(recomputed, changelogDigest, 'digest recomputes');
  assertEq(JSON.stringify(buildChangelog({ commits: COMMITS })), JSON.stringify(cl), 'deterministic');
});

await test('CLI builds the changelog and never echoes raw paths to stdout', async () => {
  const root = workspace();
  try {
    const dir = join(root, 'artifacts');
    mkdirSync(dir, { recursive: true });
    const inputPath = join(dir, 'commits.json');
    writeFileSync(inputPath, JSON.stringify({ commits: COMMITS }));
    const outPath = join(root, 'catalog-authority-test-library', 'CLMARKER-out', 'changelog.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-changelog-cli.ts', import.meta.url));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--input', inputPath, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `ok exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'changelog file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.ok, true, 'stdout ok');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('CLMARKER') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
