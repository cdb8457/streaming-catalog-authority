import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileCustodian } from '../src/core/crypto/file-custodian.js';
import { loadRewrapConfig } from '../src/core/crypto/custodian-factory.js';
import { ConfigError } from '../src/config/env.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];
const tmpDirs: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }
async function assertThrows(fn: () => Promise<unknown> | unknown, msg: string, check?: (e: Error) => void): Promise<void> {
  try { await fn(); } catch (e) { check?.(e as Error); return; }
  throw new Error(`expected to throw: ${msg}`);
}
const freshKeystore = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'rewrap-')); tmpDirs.push(d); return d; };
const keyFile = (dir: string, keyId: string): string => path.join(dir, 'keys', `${createHash('sha256').update(keyId).digest('hex')}.json`);
const readKf = (dir: string, keyId: string): Record<string, unknown> => JSON.parse(readFileSync(keyFile(dir, keyId), 'utf8'));
const countJson = (dir: string): number => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0);

const secret = 'rewrap-secret';

async function main(): Promise<void> {
  console.log('Running Phase 4 KEK rewrap suite (Stage 4.2):\n');

  // 1. full rewrap: new KEK reads the same DEK, old KEK cannot; fields preserved ----
  await test('rewrap — new KEK reads same DEK; old KEK fails; fields preserved; kekVersion 0->1', async () => {
    const dir = freshKeystore();
    const fromKek = randomBytes(32), toKek = randomBytes(32);
    const c1 = new FileCustodian(dir, secret, fromKek);
    const { keyId, dek } = await c1.provision('op1', 'itm', 0);
    await c1.commitProvision('op1');
    const before = readKf(dir, keyId);

    const res = FileCustodian.rewrapKeystore(dir, { fromKek, toKek });
    assertEq(res.rewrapped, 1, 'one rewrapped'); assertEq(res.skipped, 0, 'none skipped'); assertEq(res.total, 1, 'one total');

    const dek2 = await new FileCustodian(dir, secret, toKek).get(keyId, 0);
    assert(dek2.equals(dek), 'DEK preserved under the new KEK');
    await assertThrows(() => new FileCustodian(dir, secret, fromKek).get(keyId, 0), 'old KEK cannot read after rewrap');

    const after = readKf(dir, keyId);
    for (const k of ['keyId', 'itemId', 'epoch', 'operationId', 'state', 'createdAt']) assertEq(after[k], before[k], `${k} preserved`);
    assert(after.wrappedHex !== before.wrappedHex, 'wrappedHex changed');
    assertEq(after.kekVersion, 1, 'kekVersion 0 -> 1');
  });

  // 2. legacy key file with no kekVersion is treated as 0 --------------------------
  await test('rewrap — legacy key file (no kekVersion) is treated as version 0', async () => {
    const dir = freshKeystore();
    const fromKek = randomBytes(32), toKek = randomBytes(32);
    const c1 = new FileCustodian(dir, secret, fromKek);
    const { keyId } = await c1.provision('op1', 'itm', 0);
    await c1.commitProvision('op1');
    const p = keyFile(dir, keyId);
    const kf = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    delete kf.kekVersion; // simulate a pre-Phase-4 legacy file
    writeFileSync(p, JSON.stringify(kf));

    assertEq(FileCustodian.rewrapKeystore(dir, { fromKek, toKek }).rewrapped, 1, 'legacy file rewrapped');
    assertEq(readKf(dir, keyId).kekVersion, 1, 'absent treated as 0 -> 1');
    assert((await new FileCustodian(dir, secret, toKek).get(keyId, 0)).length === 32, 'readable under new KEK');
  });

  // 3. idempotent: a fully-rewrapped keystore is a no-op ---------------------------
  await test('rewrap — idempotent: re-running on an already-rewrapped keystore changes nothing', async () => {
    const dir = freshKeystore();
    const fromKek = randomBytes(32), toKek = randomBytes(32);
    const c1 = new FileCustodian(dir, secret, fromKek);
    await c1.provision('op1', 'itm', 0); await c1.commitProvision('op1');
    FileCustodian.rewrapKeystore(dir, { fromKek, toKek });
    const res2 = FileCustodian.rewrapKeystore(dir, { fromKek, toKek });
    assertEq(res2.rewrapped, 0, 'nothing rewrapped on re-run'); assertEq(res2.skipped, res2.total, 'all skipped');
  });

  // 4. resumable: a mixed keystore (partial prior run) finishes cleanly ------------
  await test('rewrap — resumable: only files still on the old KEK are rewrapped', async () => {
    const dir = freshKeystore();
    const fromKek = randomBytes(32), toKek = randomBytes(32);
    const cFrom = new FileCustodian(dir, secret, fromKek);
    const a = await cFrom.provision('opA', 'itm', 0); await cFrom.commitProvision('opA');
    const b = await cFrom.provision('opB', 'itm', 0); await cFrom.commitProvision('opB');
    FileCustodian.rewrapKeystore(dir, { fromKek, toKek }); // a, b -> toKek
    // a new key wrapped under the OLD KEK (as if written before a crash mid-rotation)
    const cFrom2 = new FileCustodian(dir, secret, fromKek);
    const cKey = await cFrom2.provision('opC', 'itm', 0); await cFrom2.commitProvision('opC');

    const res = FileCustodian.rewrapKeystore(dir, { fromKek, toKek });
    assertEq(res.rewrapped, 1, 'only the old-KEK file rewrapped'); assertEq(res.skipped, 2, 'two already current');
    const cTo = new FileCustodian(dir, secret, toKek);
    for (const k of [a.keyId, b.keyId, cKey.keyId]) assert((await cTo.get(k, 0)).length === 32, 'all readable under new KEK');
  });

  // 4b. non-mutating preflight classifies a mixed keystore -------------------------
  await test('rewrap plan - mixed keystore reports counts without mutating files', async () => {
    const dir = freshKeystore();
    const fromKek = randomBytes(32), toKek = randomBytes(32);
    const cFrom = new FileCustodian(dir, secret, fromKek);
    const a = await cFrom.provision('opA', 'itm', 0); await cFrom.commitProvision('opA');
    const b = await cFrom.provision('opB', 'itm', 0); await cFrom.commitProvision('opB');
    FileCustodian.rewrapKeystore(dir, { fromKek, toKek });
    const cFrom2 = new FileCustodian(dir, secret, fromKek);
    const c = await cFrom2.provision('opC', 'itm', 0); await cFrom2.commitProvision('opC');
    const before = new Map([a.keyId, b.keyId, c.keyId].map((keyId) => [keyId, JSON.stringify(readKf(dir, keyId))]));

    const plan = FileCustodian.planRewrapKeystore(dir, { fromKek, toKek });

    assertEq(plan.needsRewrap, 1, 'one still needs rewrap');
    assertEq(plan.alreadyCurrent, 2, 'two already current');
    assertEq(plan.total, 3, 'three live key files');
    for (const keyId of [a.keyId, b.keyId, c.keyId]) assertEq(JSON.stringify(readKf(dir, keyId)), before.get(keyId), 'plan did not mutate key files');
  });

  await test('rewrap plan - wrong KEK fails closed without mutating key files', async () => {
    const dir = freshKeystore();
    const fromKek = randomBytes(32), toKek = randomBytes(32);
    const c = new FileCustodian(dir, secret, fromKek);
    const { keyId } = await c.provision('op1', 'itm', 0); await c.commitProvision('op1');
    const before = JSON.stringify(readKf(dir, keyId));

    await assertThrows(() => FileCustodian.planRewrapKeystore(dir, { fromKek: randomBytes(32), toKek }), 'wrong previous KEK', (e) => {
      assert(/does not unwrap/.test(e.message), 'fail-closed message');
      assert(!e.message.includes(keyId), 'does not leak key id');
    });
    assertEq(JSON.stringify(readKf(dir, keyId)), before, 'key file unchanged after failed plan');
  });

  await test('rewrap plan - wrong current KEK fails closed on already-current files', async () => {
    const dir = freshKeystore();
    const fromKek = randomBytes(32), toKek = randomBytes(32);
    const c = new FileCustodian(dir, secret, fromKek);
    const { keyId } = await c.provision('op1', 'itm', 0); await c.commitProvision('op1');
    FileCustodian.rewrapKeystore(dir, { fromKek, toKek });
    const before = JSON.stringify(readKf(dir, keyId));

    await assertThrows(() => FileCustodian.planRewrapKeystore(dir, { fromKek, toKek: randomBytes(32) }), 'wrong current KEK', (e) => {
      assert(/does not unwrap/.test(e.message), 'fail-closed message');
      assert(!e.message.includes(keyId), 'does not leak key id');
    });
    assertEq(JSON.stringify(readKf(dir, keyId)), before, 'key file unchanged after failed plan');
  });

  await test('rewrap CLI --plan --json reports safe counts and does not mutate', async () => {
    const dir = freshKeystore();
    const fromKek = randomBytes(32), toKek = randomBytes(32);
    const c = new FileCustodian(dir, secret, fromKek);
    const { keyId } = await c.provision('op1', 'itm', 0); await c.commitProvision('op1');
    const before = JSON.stringify(readKf(dir, keyId));
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const run = spawnSync(npm, ['run', '-s', 'ops:rewrap-kek', '--', '--plan', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        CUSTODIAN_KEYSTORE_DIR: dir,
        CUSTODIAN_KEK: toKek.toString('base64'),
        CUSTODIAN_KEK_PREVIOUS: fromKek.toString('base64'),
      },
    });
    assertEq(run.status, 0, `CLI exited successfully (${run.stderr})`);
    const out = JSON.parse(run.stdout) as Record<string, unknown>;
    assertEq(out.mode, 'plan', 'plan mode');
    assertEq(out.mutates, false, 'reported non-mutating');
    assertEq(out.needsRewrap, 1, 'one needs rewrap');
    assertEq(out.alreadyCurrent, 0, 'none already current');
    assertEq(out.total, 1, 'one total');
    assert(!run.stdout.includes(keyId) && !run.stderr.includes(keyId), 'CLI output does not leak key id');
    assert(!run.stdout.includes(dir) && !run.stderr.includes(dir), 'CLI output does not leak keystore path');
    assertEq(JSON.stringify(readKf(dir, keyId)), before, 'CLI plan did not mutate key file');
  });

  // 5. wrong previous KEK: fails closed, no mutation -------------------------------
  await test('rewrap — wrong previous KEK throws and mutates nothing', async () => {
    const dir = freshKeystore();
    const fromKek = randomBytes(32), toKek = randomBytes(32);
    const c = new FileCustodian(dir, secret, fromKek);
    const { keyId } = await c.provision('op1', 'itm', 0); await c.commitProvision('op1');
    const before = readKf(dir, keyId);
    await assertThrows(() => FileCustodian.rewrapKeystore(dir, { fromKek: randomBytes(32), toKek }), 'wrong previous KEK', (e) => {
      assert(/does not unwrap/.test(e.message), 'fail-closed message');
    });
    assertEq(JSON.stringify(readKf(dir, keyId)), JSON.stringify(before), 'key file unchanged after the failed rewrap');
    assert((await new FileCustodian(dir, secret, fromKek).get(keyId, 0)).length === 32, 'still readable under the real old KEK');
  });

  // 6. tombstones are neither rewrapped nor fabricated -----------------------------
  await test('rewrap — skips destroyed keys (no key file) and never touches tombstones', async () => {
    const dir = freshKeystore();
    const fromKek = randomBytes(32), toKek = randomBytes(32);
    const c = new FileCustodian(dir, secret, fromKek);
    const dead = await c.provision('opd', 'itm', 0); await c.commitProvision('opd');
    await c.destroy('dd', dead.keyId); // tombstone, key file unlinked
    const live = await c.provision('opl', 'itm', 0); await c.commitProvision('opl');
    const tombBefore = countJson(path.join(dir, 'tombstones'));

    const res = FileCustodian.rewrapKeystore(dir, { fromKek, toKek });
    assertEq(res.rewrapped, 1, 'only the live key rewrapped');
    assertEq(countJson(path.join(dir, 'tombstones')), tombBefore, 'tombstone count unchanged');
    const c2 = new FileCustodian(dir, secret, toKek);
    assertEq(await c2.status(dead.keyId), 'destroyed', 'destroyed key stays destroyed');
    assert((await c2.get(live.keyId, 0)).length === 32, 'live key works under new KEK');
  });

  // 7. no key/secret leakage in errors --------------------------------------------
  await test('rewrap — errors never leak KEK material', async () => {
    const dir = freshKeystore();
    const fromKek = randomBytes(32), toKek = randomBytes(32);
    const c = new FileCustodian(dir, secret, fromKek);
    await c.provision('op1', 'itm', 0); await c.commitProvision('op1');
    const wrong = Buffer.alloc(32, 9);
    await assertThrows(() => FileCustodian.rewrapKeystore(dir, { fromKek: wrong, toKek }), 'leak check', (e) => {
      assert(!e.message.includes(wrong.toString('base64')) && !e.message.includes(wrong.toString('hex')), 'no KEK bytes in message');
    });
    // loadRewrapConfig redaction on a bad KEK value
    const badPrev = Buffer.alloc(16, 7).toString('base64');
    try { loadRewrapConfig({ CUSTODIAN_KEYSTORE_DIR: '/x', CUSTODIAN_KEK: randomBytes(32).toString('base64'), CUSTODIAN_KEK_PREVIOUS: badPrev }); assert(false, 'should throw'); }
    catch (e) {
      assert(e instanceof ConfigError, 'ConfigError');
      assert(/CUSTODIAN_KEK_PREVIOUS must decode/.test((e as Error).message), 'names the var');
      assert(!(e as Error).message.includes(badPrev), 'KEK value not leaked');
    }
  });

  // 8. loadRewrapConfig parsing + required previous KEK ----------------------------
  await test('loadRewrapConfig — parses both KEKs; previous KEK is required', () => {
    const fromKek = randomBytes(32), toKek = randomBytes(32);
    const cfg = loadRewrapConfig({ CUSTODIAN_KEYSTORE_DIR: '/k', CUSTODIAN_KEK: toKek.toString('base64'), CUSTODIAN_KEK_PREVIOUS: fromKek.toString('base64') });
    assert(cfg.fromKek.equals(fromKek) && cfg.toKek.equals(toKek) && cfg.keystoreDir === '/k', 'parsed both KEKs + dir');
    try { loadRewrapConfig({ CUSTODIAN_KEYSTORE_DIR: '/k', CUSTODIAN_KEK: toKek.toString('base64') }); assert(false, 'should throw'); }
    catch (e) { assert(/CUSTODIAN_KEK_PREVIOUS is required/.test((e as Error).message), 'previous KEK required'); }
  });

  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
