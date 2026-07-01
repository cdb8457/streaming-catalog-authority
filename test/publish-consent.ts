import { loadPublishConsent, assertPublishAllowed, PublishConsentError } from '../src/core/publish/consent.js';
import { FakeRevoker } from '../src/core/adapters/fake-revoker.js';
import type { Env } from '../src/config/env.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }
function assertThrows(fn: () => unknown, type: Function, msg: string): void {
  try { fn(); } catch (e) { if (e instanceof type) return; throw new Error(`${msg}: wrong error ${(e as Error).name}`); }
  throw new Error(`${msg}: expected a throw`);
}

async function main(): Promise<void> {
  console.log('Running Phase 9 consent + revoker conformance suite (Stage 9.4):\n');

  // --- consent loading: fail-closed ------------------------------------------
  await test('loadPublishConsent — only exact "allow" permits; everything else denies', () => {
    assertEq(loadPublishConsent({ PUBLISH_EXTERNAL_IDENTITY: 'allow' } as Env), 'allow', 'allow');
    assertEq(loadPublishConsent({ PUBLISH_EXTERNAL_IDENTITY: 'deny' } as Env), 'deny', 'deny');
    assertEq(loadPublishConsent({} as Env), 'deny', 'unset -> deny');
    assertEq(loadPublishConsent({ PUBLISH_EXTERNAL_IDENTITY: 'ALLOW' } as Env), 'deny', 'case-sensitive -> deny');
    assertEq(loadPublishConsent({ PUBLISH_EXTERNAL_IDENTITY: 'yes' } as Env), 'deny', 'garbage -> deny');
    assertEq(loadPublishConsent({ PUBLISH_EXTERNAL_IDENTITY: '' } as Env), 'deny', 'empty -> deny');
  });

  // --- the live-publish policy -----------------------------------------------
  await test('assertPublishAllowed — dry-run is always allowed (both consents)', () => {
    assertPublishAllowed('deny', true); // no throw
    assertPublishAllowed('allow', true);
  });
  await test('assertPublishAllowed — a LIVE publish is refused unless consent is allow', () => {
    assertThrows(() => assertPublishAllowed('deny', false), PublishConsentError, 'deny refuses live');
    assertPublishAllowed('allow', false); // no throw
  });

  // --- fake revoker conformance (opaque handle only) -------------------------
  await test('FakeRevoker — revokes an opaque handle; records only handles', async () => {
    const r = new FakeRevoker();
    assertEq(r.describe().kind, 'revoker', 'kind');
    assertEq((await r.revoke('fake:lib:1')).status, 'revoked', 'revoked');
    assertEq(r.seen.length, 1, 'recorded the handle');
    assertEq(r.seen[0], 'fake:lib:1', 'saw only the opaque handle');
  });
  await test('FakeRevoker — configured failing handle reports failed (retry/visibility path)', async () => {
    const r = new FakeRevoker(['fake:lib:9']);
    assertEq((await r.revoke('fake:lib:9')).status, 'failed', 'failed');
    assertEq((await r.revoke('fake:lib:1')).status, 'revoked', 'others still revoke');
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
