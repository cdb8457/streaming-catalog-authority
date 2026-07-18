import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWatchdogHygiene, WATCHDOG_DISCLAIMERS } from '../src/ops/promotion-watchdog-hygiene.js';
import { verifySelfDigests } from '../src/ops/promotion-self-digest-verifier.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void { if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`); }

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const A64 = 'a'.repeat(64);
const B64 = 'b'.repeat(64);
const C64 = 'c'.repeat(64);
const RUN = 'run-2026-07-17';

const SAFE_CONFIG = { debounceMs: 500, idempotent: true, autoPromote: false, respectsLiveBoundary: true, deduplicateBy: 'content-digest' };
function cleanQueue() { return [{ itemDigest: A64, status: 'processed', run: RUN }, { itemDigest: B64, status: 'queued', run: RUN }]; }

console.log('Running Phase 230 watchdog hygiene suite:\n');

await test('WATCHDOG_HYGIENE_CLEAN with a safe config and a deduped, fresh queue', () => {
  const r = buildWatchdogHygiene({ config: SAFE_CONFIG, queue: cleanQueue(), currentRun: RUN });
  assertEq(r.overall, 'WATCHDOG_HYGIENE_CLEAN', `clean (blockers: ${r.blockers.join(',')})`);
  assertEq(r.authorization, 'NONE', 'authorizes nothing');
  assert(r.configSafe, 'config declares the safe invariants');
  assertEq(r.queueCount, 2, 'two entries');
  assertEq(r.uniqueCount, 2, 'no duplicates');
  assert(r.entries.every((e) => e.wellFormed && e.fresh && !e.duplicate), 'every entry well-formed, fresh, unique');
  assertEq(r.disclaimers.length, WATCHDOG_DISCLAIMERS.length, 'disclaimers present');
  assertEq(verifySelfDigests([r]).overall, 'ALL_VERIFIED', 'report self-verifies');
  assert(!JSON.stringify(r).includes('/mnt/'), 'redaction-safe');
});

await test('VIOLATED on an unsafe config (auto-promote enabled, not idempotent, live boundary unguarded)', () => {
  const r = buildWatchdogHygiene({ config: { debounceMs: 0, idempotent: false, autoPromote: true, respectsLiveBoundary: false, deduplicateBy: 'name' }, queue: cleanQueue(), currentRun: RUN });
  assertEq(r.overall, 'WATCHDOG_HYGIENE_VIOLATED', 'violated');
  assert(!r.configSafe, 'config is unsafe');
  for (const code of ['WATCHER_DEBOUNCE_MISSING', 'WATCHER_NOT_IDEMPOTENT', 'WATCHER_AUTO_PROMOTE_ENABLED', 'WATCHER_LIVE_BOUNDARY_UNGUARDED', 'WATCHER_DEDUPE_DISABLED']) {
    assert(r.blockers.includes(code), `${code} raised`);
  }
});

await test('VIOLATED on a duplicate queue entry (dedup failure) and a stale entry', () => {
  const dup = buildWatchdogHygiene({ config: SAFE_CONFIG, queue: [{ itemDigest: A64, status: 'queued', run: RUN }, { itemDigest: A64, status: 'queued', run: RUN }], currentRun: RUN });
  assert(dup.blockers.includes('DUPLICATE_QUEUE_ENTRY'), 'duplicate-queue-entry blocker');
  assert(dup.entries.some((e) => e.duplicate), 'entry flagged duplicate');

  const stale = buildWatchdogHygiene({ config: SAFE_CONFIG, queue: [{ itemDigest: C64, status: 'queued', run: 'run-old' }], currentRun: RUN });
  assert(stale.blockers.includes('STALE_QUEUE_ENTRY'), 'stale-queue-entry blocker');
  assert(stale.entries.some((e) => !e.fresh), 'entry flagged stale');
});

await test('VIOLATED on a malformed entry digest, an invalid status, and a missing queue', () => {
  const bad = buildWatchdogHygiene({ config: SAFE_CONFIG, queue: [{ itemDigest: 'not-a-sha', status: 'exploded', run: RUN }], currentRun: RUN });
  assert(bad.blockers.includes('ENTRY_DIGEST_MALFORMED'), 'entry-digest-malformed blocker');
  assert(bad.blockers.includes('ENTRY_STATUS_INVALID'), 'entry-status-invalid blocker');

  const noQueue = buildWatchdogHygiene({ config: SAFE_CONFIG });
  assert(noQueue.blockers.includes('QUEUE_MISSING'), 'queue-missing blocker');
});

await test('a path-bearing status is rejected AND never echoed (redaction leak closed)', () => {
  const leak = '/mnt/user/media/Movies/leak.mkv';
  const r = buildWatchdogHygiene({ config: SAFE_CONFIG, queue: [{ itemDigest: A64, status: leak, run: RUN }], currentRun: RUN });
  assertEq(r.overall, 'WATCHDOG_HYGIENE_VIOLATED', 'invalid status violates');
  assert(r.blockers.includes('ENTRY_STATUS_INVALID'), 'entry-status-invalid blocker');
  // The raw status must NOT be echoed anywhere in the redaction-safe report.
  assertEq(r.entries[0]!.status, null, 'invalid status surfaced as null, not the raw string');
  assert(!JSON.stringify(r).includes('/mnt/') && !JSON.stringify(r).includes('.mkv'), 'no raw status fragment leaks into the report');
});

await test('VIOLATED on a config that declares the safe fields but smuggles an unknown dangerous directive', () => {
  const dangerous = { ...SAFE_CONFIG, autoPromoteOverride: true };
  const r = buildWatchdogHygiene({ config: dangerous, queue: cleanQueue(), currentRun: RUN });
  assertEq(r.overall, 'WATCHDOG_HYGIENE_VIOLATED', 'a smuggled directive fails closed');
  assert(r.blockers.includes('WATCHER_CONFIG_UNKNOWN_FIELD'), 'unknown-field blocker');
  assert(!r.configSafe, 'config is not certified safe');
});

test('VIOLATED and redaction-safe on empty input (config + queue both missing)', () => {
  const r = buildWatchdogHygiene({});
  assertEq(r.overall, 'WATCHDOG_HYGIENE_VIOLATED', 'violated');
  assert(r.blockers.includes('WATCHER_CONFIG_MISSING') && r.blockers.includes('QUEUE_MISSING'), 'missing blockers');
  assert(r.redactionSafe === true && !JSON.stringify(r).includes('/mnt/'), 'redaction-safe');
});

await test('CLI runs the hygiene check and never echoes raw paths to stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catalog-watchdog-'));
  try {
    const dir = join(root, 'a'); mkdirSync(dir, { recursive: true });
    const w = (n: string, v: unknown): string => { const p = join(dir, n); writeFileSync(p, JSON.stringify(v)); return p; };
    const cfg = w('cfg.json', SAFE_CONFIG); const q = w('q.json', cleanQueue());
    const outPath = join(root, 'catalog-authority-test-library', 'WDMARKER-out', 'watchdog.json');
    const cliPath = fileURLToPath(new URL('../src/ops/promotion-watchdog-hygiene-cli.ts', import.meta.url));
    const res = spawnSync(process.execPath, ['--import', 'tsx', cliPath, '--config', cfg, '--queue', q, '--currentrun', RUN, '--out', outPath], { cwd: projectRoot, encoding: 'utf8' });
    assert(res.error === undefined, `spawn ok: ${res.error?.message ?? ''}`);
    assertEq(res.status, 0, `CLEAN exit (stderr: ${res.stderr ?? ''})`);
    assert(existsSync(outPath), 'watchdog file written');
    const parsed = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    assertEq(parsed.overall, 'WATCHDOG_HYGIENE_CLEAN', 'stdout overall');
    assertEq(parsed.outputWritten, true, 'stdout reports outputWritten');
    assert(!(res.stdout ?? '').includes('WDMARKER') && !(res.stdout ?? '').includes('/mnt/'), 'no path fragments in stdout');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
