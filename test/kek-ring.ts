import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KEK_RING_VERSION,
  KekRingError,
  activatePendingGeneration,
  activeKek,
  adoptStaticKekAsRing,
  beginPendingGeneration,
  decodeKey,
  initializeKekRing,
  kekForGeneration,
  kekRingExists,
  kekRingPath,
  loadKekRing,
  readRootWrappingKey,
  retireGeneration,
  rootKeyId,
  rotateRootWrappingKey,
  summarizeKekRing,
} from '../src/core/crypto/kek-ring.js';
import { readStateDocument, writeStateDocument } from '../src/core/crypto/custodian-state-io.js';

// Phase 282 — the sidecar-managed KEK ring.
//
// THE CLAIMS THIS FILE HAS TO MAKE GOOD.
//   - THE ROOT WRAPPING KEY COMES FROM A PRIVATE FILE AND NOWHERE ELSE: no environment variable, no argument,
//     no evidence surface; owner-only, no-follow, bounded.
//   - EVERY KEK IS GENERATED INSIDE THIS PROCESS, not read from anything an operator typed.
//   - THE RING IS AEAD-SEALED AND VERSIONED, and its header is bound in — so a wrong root, one altered byte,
//     a re-labelled envelope and an unknown version are each a REFUSAL and never a subtly wrong key.
//   - AN INCOMPLETE RING IS A REFUSAL, not a default.
//   - A RING IS NEVER REPLACED. Initialising over one would be every item in the catalog gone.
//   - THE MIGRATION ADOPTS THE STATIC KEK and says exactly that: it changes custody, not key material.
//   - THE PREVIOUS GENERATION IS RETAINED until it is explicitly retired.
//   - ROOT ROTATION RE-SEALS AND REWRAPS NOTHING.
//   - NO KEY, EVER, IN A SUMMARY, A MESSAGE OR A FILE THAT IS NOT THE SEALED RING.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function refuses(fn: () => unknown, needle: string, msg: string): void {
  try { fn(); } catch (err) {
    assert((err as Error).message.includes(needle), `${msg}: expected "${needle}", got: ${(err as Error).message}`);
    return;
  }
  throw new Error(`${msg}: nothing was refused`);
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');
const WORK = mkdtempSync(join(tmpdir(), 'ca-kek-ring-'));
const POSIX = process.platform !== 'win32';

/** A state directory and a private root key file beside it. */
function world(name: string, key: Buffer = randomBytes(32)): { stateDir: string; rootFile: string; root: Buffer } {
  const stateDir = join(WORK, name, 'state');
  mkdirSync(stateDir, { recursive: true });
  const rootFile = join(WORK, name, 'root_wrapping_key');
  writeFileSync(rootFile, `${key.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  if (POSIX) chmodSync(rootFile, 0o600);
  return { stateDir, rootFile, root: key };
}

console.log('Running Phase 282 sidecar-managed KEK ring suite:\n');

// ---------------------------------------------------------------------------------------------------------
// The root wrapping key
// ---------------------------------------------------------------------------------------------------------

test('the root wrapping key is read from a private file, and from nothing else', () => {
  const w = world('root-read');
  assertEq(readRootWrappingKey(w.rootFile).toString('hex'), w.root.toString('hex'), 'a private hex file reads');

  // BASE64 TOO, and nothing else at all.
  const b64 = join(WORK, 'root-read', 'root_b64');
  writeFileSync(b64, `${w.root.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 });
  assertEq(readRootWrappingKey(b64).toString('hex'), w.root.toString('hex'), 'a base64 file reads');

  const short = join(WORK, 'root-read', 'root_short');
  writeFileSync(short, 'abcd\n', { encoding: 'utf8', mode: 0o600 });
  refuses(() => readRootWrappingKey(short), 'exactly 32 bytes', 'a file that is not a key');

  const huge = join(WORK, 'root-read', 'root_huge');
  writeFileSync(huge, 'x'.repeat(64 * 1024), { encoding: 'utf8', mode: 0o600 });
  refuses(() => readRootWrappingKey(huge), 'larger than a key file could be', 'an enormous file');

  refuses(() => readRootWrappingKey(join(WORK, 'root-read', 'not-there')), 'could not be opened', 'an absent file');

  // NO ENVIRONMENT VARIABLE AND NO ARGUMENT, asserted against the source rather than by absence of a feature.
  const source = readRepo('src/core/crypto/kek-ring.ts');
  for (const forbidden of ['process.env', 'process.argv', 'SIDECAR_ROOT_KEY=', 'rootKeyHex', 'rootKeyBase64']) {
    assert(!source.includes(forbidden), `the ring module must not read a key from ${forbidden}`);
  }
});

test('a root wrapping key file another account can read is refused', () => {
  if (!POSIX) { console.log('        (POSIX-only: modes are not a concept here)'); return; }
  const w = world('root-mode');
  chmodSync(w.rootFile, 0o644);
  refuses(() => readRootWrappingKey(w.rootFile), 'readable by somebody other than its owner', 'a world-readable root key');
});

test('a root wrapping key file that is a symbolic link is never followed', () => {
  if (!POSIX) { console.log('        (POSIX-only)'); return; }
  const w = world('root-link');
  const link = join(WORK, 'root-link', 'linked_root');
  try {
    symlinkSync(w.rootFile, link);
  } catch {
    console.log('        (this session cannot create a symbolic link)');
    return;
  }
  refuses(() => readRootWrappingKey(link), 'symbolic link', 'a linked root key file');
});

// ---------------------------------------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------------------------------------

test('a new installation gets a ring whose key was generated HERE, and never a second one', () => {
  const w = world('init');
  assertEq(kekRingExists(w.stateDir), false, 'there is no ring to begin with');
  const ring = initializeKekRing(w.stateDir, w.root, () => 1_000);
  assertEq(ring.active, 1, 'generation 1 is active');
  assertEq(ring.generations[0]!.origin, 'generated-in-sidecar', 'and it was generated in the sidecar');
  assertEq(decodeKey(ring.generations[0]!.keyHex)!.length, 32, 'it is 32 bytes');
  assertEq(kekRingExists(w.stateDir), true, 'the ring is there now');

  // TWO INITIALISATIONS OF THE SAME DIRECTORY WOULD BE EVERY KEY GONE. There is no force.
  refuses(() => initializeKekRing(w.stateDir, w.root), 'never replaces one', 'a second initialisation');
  const again = loadKekRing(w.stateDir, w.root);
  assertEq(again.generations[0]!.keyHex, ring.generations[0]!.keyHex, 'and the original key is untouched');

  // TWO INSTALLATIONS DO NOT SHARE A KEY.
  const other = world('init-2');
  const otherRing = initializeKekRing(other.stateDir, other.root);
  assert(otherRing.generations[0]!.keyHex !== ring.generations[0]!.keyHex, 'two installations get different keys');
});

// ---------------------------------------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------------------------------------

test('the ring is sealed: a wrong root, an altered byte and a re-labelled envelope are each refused', () => {
  const w = world('sealed');
  initializeKekRing(w.stateDir, w.root);

  // WRONG ROOT — said plainly, because "wrong key" and "corrupt file" have different remedies.
  refuses(() => loadKekRing(w.stateDir, randomBytes(32)), 'DIFFERENT root wrapping key', 'a wrong root key');

  // ONE ALTERED BYTE OF CIPHERTEXT.
  const path = kekRingPath(w.stateDir);
  const sealed = readStateDocument<Record<string, string>>(path)!;
  const flipped = { ...sealed };
  const hex = sealed.ciphertextHex!;
  flipped.ciphertextHex = `${hex[0] === 'a' ? 'b' : 'a'}${hex.slice(1)}`;
  writeStateDocument(path, flipped);
  refuses(() => loadKekRing(w.stateDir, w.root), 'did not authenticate', 'an altered ring');

  // A RE-LABELLED ENVELOPE. The header is in the AAD, so claiming another root's label breaks the tag rather
  // than changing what the ring claims to be.
  writeStateDocument(path, { ...sealed, rootKeyId: rootKeyId(randomBytes(32)) });
  refuses(() => loadKekRing(w.stateDir, w.root), 'DIFFERENT root wrapping key', 'a re-labelled envelope');

  // AN UNKNOWN VERSION IS NEVER GUESSED AT.
  writeStateDocument(path, { ...sealed, version: KEK_RING_VERSION + 1 });
  refuses(() => loadKekRing(w.stateDir, w.root), 'does not understand', 'a future envelope version');
});

test('an INCOMPLETE ring is a refusal, not a default', () => {
  // Every one of these is a ring an interrupted rotation or an edit could produce, and every one of them has
  // a next step that would wrap a key under something.
  const cases: Array<[string, (ring: Record<string, unknown>) => Record<string, unknown>, string]> = [
    ['no active generation', (r) => ({ ...r, active: 9 }), 'does not name an active generation'],
    ['no generations at all', (r) => ({ ...r, generations: [] }), 'holds no generations'],
    // With the closed schema this is caught one rule earlier and more precisely: a ring in which nothing is
    // active does not hold exactly one active generation, which is the structural fact rather than a
    // consequence of it.
    ['an active that is not active', (r) => ({
      ...r,
      generations: (r.generations as Array<Record<string, unknown>>).map((g) => ({ ...g, state: 'retired' })),
    }), 'does not hold exactly one active generation'],
    ['two generations with one number', (r) => ({
      ...r,
      generations: [...(r.generations as unknown[]), (r.generations as unknown[])[0]],
    }), 'two generations with one number'],
    ['a key that is not 32 bytes', (r) => ({
      ...r,
      generations: (r.generations as Array<Record<string, unknown>>).map((g) => ({ ...g, keyHex: 'ab' })),
    }), 'whose key is not 32 bytes'],
    ['a generation with no origin', (r) => ({
      ...r,
      generations: (r.generations as Array<Record<string, unknown>>).map((g) => ({ ...g, origin: 'somewhere' })),
    }), 'with no recorded origin'],
    ['a pending that is not in the ring', (r) => ({ ...r, pending: 7 }), 'pending generation that is not in it'],
  ];
  for (const [what, mutate, needle] of cases) {
    const w = world(`incomplete-${what.replace(/[^a-z]/g, '')}`);
    initializeKekRing(w.stateDir, w.root);
    const ring = loadKekRing(w.stateDir, w.root) as unknown as Record<string, unknown>;
    // Re-seal the MUTATED ring under the real root, so the failure is structural rather than a tag failure.
    reseal(w.stateDir, w.root, mutate({ ...ring }));
    refuses(() => loadKekRing(w.stateDir, w.root), needle, what);
  }
});

/** Seal an arbitrary document under a root, so a structural rule can be tested without a tag failure. */
function reseal(stateDir: string, root: Buffer, doc: unknown): void {
  const label = createHash('sha256')
    .update(JSON.stringify(['catalog-authority.kek-ring', 'root-key-id']), 'utf8')
    .update(root).digest('hex').slice(0, 32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', root, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(['catalog-authority.kek-ring', KEK_RING_VERSION, label]), 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(doc), 'utf8'), cipher.final()]);
  writeStateDocument(kekRingPath(stateDir), {
    document: 'catalog-authority.kek-ring',
    version: KEK_RING_VERSION,
    rootKeyId: label,
    nonceHex: nonce.toString('hex'),
    ciphertextHex: ct.toString('hex'),
    tagHex: cipher.getAuthTag().toString('hex'),
  });
}

test('a ring that is there and UNREADABLE is still there, so nothing initialises over it', () => {
  // The one irreversible mistake in this module: answering "no ring" for a ring that exists and cannot be
  // opened, and then writing a new one over every key the old one held.
  const w = world('unreadable');
  initializeKekRing(w.stateDir, w.root);
  writeStateDocument(kekRingPath(w.stateDir), { document: 'something-else' });
  assertEq(kekRingExists(w.stateDir), true, 'an unreadable ring counts as present');
  refuses(() => initializeKekRing(w.stateDir, w.root), 'already', 'initialising over an unreadable ring');
});

// ---------------------------------------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------------------------------------

test('migration ADOPTS the static KEK, and says that is a change of custody and not of key material', () => {
  const w = world('migrate');
  const staticKek = randomBytes(32);
  const ring = adoptStaticKekAsRing(w.stateDir, w.root, staticKek, () => 5_000);
  assertEq(ring.active, 1, 'the adopted key is generation 1');
  assertEq(ring.generations[0]!.origin, 'adopted-from-static-kek', 'recorded as adopted, not generated');
  // THE POINT OF THE ADOPTION: the ring can open what is already on disk.
  assertEq(activeKek(ring).toString('hex'), staticKek.toString('hex'), 'and it IS the static key');

  const summary = summarizeKekRing(ring, w.root);
  assertEq(summary.origin, 'adopted-from-static-kek', 'the summary says so, so nothing can claim otherwise');
  refuses(() => adoptStaticKekAsRing(w.stateDir, w.root, staticKek), 'already', 'a second migration');
  refuses(() => adoptStaticKekAsRing(world('migrate-2').stateDir, w.root, randomBytes(16)), 'not 32 bytes',
    'a static key that is not a key');
});

// ---------------------------------------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------------------------------------

test('a pending generation exists without being used, and activation RETAINS the previous one', () => {
  const w = world('generations');
  initializeKekRing(w.stateDir, w.root, () => 1_000);
  const first = activeKek(loadKekRing(w.stateDir, w.root)).toString('hex');

  const { generation } = beginPendingGeneration(w.stateDir, w.root, () => 2_000);
  assertEq(generation, 2, 'the next generation is 2');
  const pending = loadKekRing(w.stateDir, w.root);
  assertEq(pending.pending, 2, 'it is pending');
  assertEq(pending.active, 1, 'and the ACTIVE one has not moved — nothing is wrapped under 2 yet');
  assertEq(activeKek(pending).toString('hex'), first, 'so new wraps still use generation 1');
  assert(kekForGeneration(pending, 2).toString('hex') !== first, 'and 2 is a different key');

  refuses(() => beginPendingGeneration(w.stateDir, w.root), 'already has a pending generation', 'a second pending');

  const activated = activatePendingGeneration(w.stateDir, w.root, () => 3_000);
  assertEq(activated.active, 2, 'activation moves the active generation');
  assertEq(activated.pending, null, 'and clears the pending one');
  // RETAINED, DELIBERATELY. Every backup taken before this holds keys under generation 1.
  assertEq(activated.generations.length, 2, 'the previous generation is still in the ring');
  assertEq(kekForGeneration(activated, 1).toString('hex'), first, 'and is still usable');
  refuses(() => activatePendingGeneration(w.stateDir, w.root), 'no pending generation', 'activating nothing');
});

test('retirement is explicit, refuses the active and the pending, and is irreversible', () => {
  const w = world('retire');
  initializeKekRing(w.stateDir, w.root);
  beginPendingGeneration(w.stateDir, w.root);
  refuses(() => retireGeneration(w.stateDir, w.root, 1), 'ACTIVE generation cannot be retired', 'retiring the active');
  refuses(() => retireGeneration(w.stateDir, w.root, 2), 'PENDING generation cannot be retired', 'retiring the pending');
  activatePendingGeneration(w.stateDir, w.root);
  refuses(() => retireGeneration(w.stateDir, w.root, 9), 'no such generation', 'retiring one that is not there');
  const after = retireGeneration(w.stateDir, w.root, 1);
  assertEq(after.generations.length, 1, 'the retained generation is gone');
  refuses(() => kekForGeneration(after, 1), 'no such generation', 'and its key is gone with it');
});

// ---------------------------------------------------------------------------------------------------------
// The root, rotated
// ---------------------------------------------------------------------------------------------------------

test('rotating the ROOT re-seals the ring and rewraps nothing', () => {
  const w = world('root-rotate');
  initializeKekRing(w.stateDir, w.root);
  const before = loadKekRing(w.stateDir, w.root);
  const nextRoot = randomBytes(32);

  const moved = rotateRootWrappingKey(w.stateDir, w.root, nextRoot, () => 9_000);
  assertEq(moved.from, rootKeyId(w.root), 'the label of the root it came from');
  assertEq(moved.to, rootKeyId(nextRoot), 'and of the one it is under now');

  refuses(() => loadKekRing(w.stateDir, w.root), 'DIFFERENT root wrapping key', 'the old root no longer opens it');
  const after = loadKekRing(w.stateDir, nextRoot);
  // NOTHING ABOUT THE KEKS CHANGED. That is the whole distinction from rotating a KEK.
  assertEq(after.generations[0]!.keyHex, before.generations[0]!.keyHex, 'every KEK is byte for byte the same');
  assertEq(after.active, before.active, 'and the active generation has not moved');

  refuses(() => rotateRootWrappingKey(w.stateDir, nextRoot, nextRoot), 'is the current one', 'a no-op re-seal');
  refuses(() => rotateRootWrappingKey(w.stateDir, nextRoot, randomBytes(16)), 'not 32 bytes', 'a short new root');
});

// ---------------------------------------------------------------------------------------------------------
// Non-disclosure
// ---------------------------------------------------------------------------------------------------------

test('no key, wrapped value or root ever reaches a summary, a message or an unsealed file', () => {
  const w = world('disclosure');
  const ring = initializeKekRing(w.stateDir, w.root);
  const key = ring.generations[0]!.keyHex;
  const summary = summarizeKekRing(ring, w.root);
  const printed = JSON.stringify(summary);
  for (const forbidden of [key, w.root.toString('hex'), w.root.toString('base64'), 'keyHex']) {
    assert(!printed.includes(forbidden), `a summary must not carry ${forbidden.slice(0, 24)}`);
  }
  assert(printed.includes(rootKeyId(w.root)), 'it carries the root LABEL, which is what an operator matches on');

  // AND THE ONE FILE ON DISK IS SEALED. Nothing beside it holds a key.
  for (const entry of readdirSync(join(w.stateDir, 'ring'))) {
    const text = readFileSync(join(w.stateDir, 'ring', entry), 'utf8');
    assert(!text.includes(key), `${entry} must not hold the key in the clear`);
    assert(!text.includes(w.root.toString('hex')), `${entry} must not hold the root key`);
  }

  // A REFUSAL NAMES A RULE, NEVER A VALUE.
  try {
    loadKekRing(w.stateDir, randomBytes(32));
    throw new Error('nothing was refused');
  } catch (err) {
    assert(err instanceof KekRingError, 'it is a typed refusal');
    assert(!(err as Error).message.includes(key), 'and carries no key');
    assert(!(err as Error).message.includes(w.stateDir), 'nor a path');
  }
});

test('the ring module claims no cloud KMS and no hardware boundary', () => {
  // The honesty rule for this tranche, checked rather than trusted: "managed" here means the sidecar manages
  // it, and the documents that describe it must not drift into implying a third party or a device does.
  const source = [readRepo('src/core/crypto/kek-ring.ts'), readRepo('src/ops/kek-ring-cli.ts')].join('\n');
  for (const forbidden of ['AWS KMS', 'CloudHSM', 'Azure Key Vault', 'Google Cloud KMS', 'HashiCorp Vault',
    '@aws-sdk', '@azure', '@google-cloud', 'hardware security module', 'FIPS 140']) {
    assert(!source.includes(forbidden), `the ring must not name ${forbidden}`);
  }
  assert(source.includes('not a cloud KMS') || source.includes('NOT a cloud KMS'), 'and says what it is not');
});

rmSync(WORK, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
for (const [name, err] of failures) console.log(`  ${name}: ${(err as Error).stack ?? err}`);
process.exit(failed === 0 ? 0 : 1);
