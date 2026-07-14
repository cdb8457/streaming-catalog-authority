import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJellyfinLiveReadOnlyMapping, selectEligibleCatalogItemIds } from '../src/ops/jellyfin-live-readonly-mapping.js';
import type { Env } from '../src/config/env.js';
import type { CatalogAuthority } from '../src/core/catalog/authority.js';
import type { JellyfinClient } from '../src/core/adapters/jellyfin/client.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');

const SECRET = 'PHASE219-SUPER-SECRET-JELLYFIN-KEY';
const HOST = 'private-jellyfin-hostname';
const RAW_REF = 'phase219-raw-provider-ref';
const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const JELLYFIN_ID = 'jellyfin-raw-item-id';

function fixtureEnv(dir: string, overrides: Env = {}): Env {
  const keyFile = path.join(dir, 'jellyfin_api_key');
  writeFileSync(keyFile, SECRET, 'utf8');
  return {
    JELLYFIN_ENABLE_NETWORK: 'true',
    JELLYFIN_BASE_URL: `http://${HOST}:8096`,
    JELLYFIN_API_KEY_FILE: keyFile,
    CUSTODIAN_MODE: 'sidecar',
    CUSTODIAN_SIDECAR_SOCKET_PATH: '/run/catalog-sidecar/catalog-sidecar.sock',
    ...overrides,
  };
}

function noLeak(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !text.includes(SECRET)
    && !text.includes(HOST)
    && !text.includes(RAW_REF)
    && !text.includes(ITEM_ID)
    && !text.includes(JELLYFIN_ID)
    && !text.includes('192.168.')
    && !text.includes('postgresql://');
}

function fakeAuthority(refs: Array<{ type: string; value: string }>): CatalogAuthority {
  return {
    withPublishableIdentity: async (_itemId: string, requires: readonly string[], fn: (identity: unknown) => unknown) => {
      assert(requires.includes('providerRefs'), 'requires providerRefs only');
      return fn({ itemId: ITEM_ID, providerRefs: refs });
    },
  } as unknown as CatalogAuthority;
}

function fakeClient(matchCount: number): Pick<JellyfinClient, 'findItemsByRefs'> {
  return {
    findItemsByRefs: async () => Array.from({ length: matchCount }, (_, i) => `${JELLYFIN_ID}-${i}`),
  };
}

console.log('Running Phase 219 Jellyfin live read-only mapping suite:\n');

await test('live mapping emits counts-only evidence for selected catalog refs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jf-live-map-219-'));
  try {
    const report = await runJellyfinLiveReadOnlyMapping({
      env: fixtureEnv(dir),
      itemIds: [ITEM_ID],
      authority: fakeAuthority([{ type: 'tmdb', value: RAW_REF }]),
      client: fakeClient(2),
      now: () => new Date('2026-07-14T12:00:00.000Z'),
    });
    assertEq(report.report, 'phase-219-jellyfin-live-readonly-mapping', 'report id');
    assertEq(report.status, 'JELLYFIN_LIVE_READONLY_MAPPING_MATCHED', 'matched status');
    assertEq(report.ok, true, 'ok true');
    assertEq(report.redactionSafe, true, 'redaction marker');
    assertEq(report.selection.mode, 'explicit-item-ids', 'explicit selection');
    assertEq(report.selection.selectedCount, 1, 'selected count');
    assertEq(report.selection.itemIdsEchoed, false, 'item IDs not echoed');
    assertEq(report.mapping.totals.requested, 1, 'requested count');
    assertEq(report.mapping.totals.mapped, 1, 'mapped count');
    assertEq(report.mapping.totals.jellyfinMatches, 2, 'match count');
    assertEq(report.mapping.items[0]?.jellyfinItemDigests?.length, 2, 'jellyfin match digests emitted');
    assertEq(report.dataPositiveMappingEvidence, true, 'data-positive evidence');
    assert(report.evidenceDigest.length === 64, 'digest emitted');
    assert(noLeak(report), 'report redaction-safe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('zero eligible live catalog items produce an accepted boundary result without writes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jf-live-map-219-empty-'));
  try {
    const report = await runJellyfinLiveReadOnlyMapping({
      env: fixtureEnv(dir),
      itemIds: [],
      authority: fakeAuthority([]),
      client: fakeClient(0),
      now: () => new Date('2026-07-14T12:05:00.000Z'),
    });
    assertEq(report.ok, true, 'zero-candidate boundary result is ok');
    assertEq(report.status, 'JELLYFIN_LIVE_READONLY_MAPPING_NO_ELIGIBLE_ITEMS', 'no eligible status');
    assertEq(report.selection.selectedCount, 0, 'selected count');
    assertEq(report.mapping.totals.requested, 0, 'requested count');
    assertEq(report.dataPositiveMappingEvidence, false, 'not data-positive');
    assert(report.operationBoundary.writeMode === false, 'write mode false');
    assert(report.operationBoundary.allowedMethods.length === 1 && report.operationBoundary.allowedMethods[0] === 'GET', 'GET only');
    assert(noLeak(report), 'report redaction-safe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('selector query returns only eligible row ids and keeps raw ids out of evidence layer', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [{ id: ITEM_ID }] };
    },
  };
  const ids = await selectEligibleCatalogItemIds(pool as never, 10);
  const call = calls[0];
  if (!call) throw new Error('selector query was executed');
  assertEq(ids.length, 1, 'one id selected internally');
  assertEq(ids[0], ITEM_ID, 'selector returns internal id to runner');
  assert(call.sql.includes('i.present'), 'query requires present item');
  assert(call.sql.includes('NOT i.forgotten'), 'query excludes forgotten item');
  assert(call.sql.includes("k.shred_state = 'active'"), 'query requires active key state');
  assert(call.sql.includes('pr.ref_value_ct IS NOT NULL'), 'query requires encrypted provider ref');
});

await test('unsafe environment is refused before mapping', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jf-live-map-219-env-'));
  try {
    for (const [name, env] of [
      ['direct api key', fixtureEnv(dir, { JELLYFIN_API_KEY: SECRET })],
      ['write mode', fixtureEnv(dir, { JELLYFIN_ALLOW_LIVE_PUBLISH: 'true' })],
      ['network disabled', fixtureEnv(dir, { JELLYFIN_ENABLE_NETWORK: 'false' })],
    ] as const) {
      let err: unknown;
      try {
        await runJellyfinLiveReadOnlyMapping({ env, itemIds: [], authority: fakeAuthority([]), client: fakeClient(0) });
      } catch (caught) { err = caught; }
      assert(err instanceof Error, `${name} rejected`);
      assert(noLeak((err as Error).message), `${name} rejection redaction-safe`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('launcher and package wiring preserve read-only Unraid boundary', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const launcher = read('deploy/unraid-jellyfin-live-mapping-capture.sh');
  assert(pkg.scripts['ops:jellyfin-live-readonly-mapping'] === 'tsx src/ops/jellyfin-live-readonly-mapping-cli.ts', 'ops script present');
  assert(pkg.scripts['ops:catalog-ingest-item'] === 'tsx src/ops/catalog-ingest-item-cli.ts', 'ingest ops script present');
  assert(pkg.scripts['test:jellyfin-live-readonly-mapping'] === 'tsx test/jellyfin-live-readonly-mapping.ts', 'test script present');
  for (const required of [
    'docker compose -f "$COMPOSE_FILE" run --rm',
    '--entrypoint npm',
    'JELLYFIN_ENABLE_NETWORK=true',
    'JELLYFIN_API_KEY_FILE=$SECRET_MOUNT',
    'JELLYFIN_ALLOW_LIVE_PUBLISH=false',
    'ops:jellyfin-live-readonly-mapping',
    'phase-219-jellyfin-live-readonly-mapping.json',
  ]) assert(launcher.includes(required), `launcher includes ${required}`);
  for (const forbidden of [' --publish', '\n-p ', 'ports:', 'JELLYFIN_ALLOW_LIVE_PUBLISH=true', 'docker run']) {
    assert(!launcher.includes(forbidden), `launcher excludes ${forbidden}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
