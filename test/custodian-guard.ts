import { randomBytes } from 'node:crypto';
import { loadCustodianConfig } from '../src/core/crypto/custodian-factory.js';
import { ConfigError, resolveAppEnv, type Env } from '../src/config/env.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }
function expectReject(env: Env, msg: string, check?: (e: ConfigError) => void): void {
  try { loadCustodianConfig(env); throw new Error(`expected ConfigError: ${msg}`); }
  catch (e) { if (!(e instanceof ConfigError)) throw e; check?.(e); }
}

const secret = 'guard-secret';
const memProd: Env = { CUSTODIAN_MODE: 'memory', COMPLETION_SECRET: secret, APP_ENV: 'production' };

console.log('Running Phase 4 custodian production-guard suite (Stage 4.1):\n');

// resolveAppEnv precedence ---------------------------------------------------
test('resolveAppEnv — APP_ENV overrides NODE_ENV; default is development', () => {
  assertEq(resolveAppEnv({ APP_ENV: 'production', NODE_ENV: 'test' }), 'production', 'APP_ENV wins');
  assertEq(resolveAppEnv({ NODE_ENV: 'production' }), 'production', 'NODE_ENV fallback');
  assertEq(resolveAppEnv({ NODE_ENV: 'test' }), 'test', 'test');
  assertEq(resolveAppEnv({}), 'development', 'default development');
  assertEq(resolveAppEnv({ APP_ENV: 'staging' }), 'development', 'unknown -> development');
});

// memory in production -------------------------------------------------------
test('guard — APP_ENV=production + memory is REJECTED', () => {
  expectReject(memProd, 'memory in production', (e) => {
    assert(/CUSTODIAN_MODE=memory is refused in production/.test(e.message), 'explains the refusal');
  });
});

test('guard — NODE_ENV=production + memory is REJECTED when APP_ENV is absent', () => {
  expectReject({ CUSTODIAN_MODE: 'memory', COMPLETION_SECRET: secret, NODE_ENV: 'production' }, 'memory via NODE_ENV prod');
});

// memory allowed in dev/test -------------------------------------------------
test('guard — memory is allowed in development / test / default', () => {
  for (const env of [
    { CUSTODIAN_MODE: 'memory', COMPLETION_SECRET: secret, APP_ENV: 'development' },
    { CUSTODIAN_MODE: 'memory', COMPLETION_SECRET: secret, APP_ENV: 'test' },
    { CUSTODIAN_MODE: 'memory', COMPLETION_SECRET: secret }, // default development
  ]) {
    const cfg = loadCustodianConfig(env);
    assertEq(cfg.mode, 'memory', 'memory allowed');
  }
});

// escape hatch ---------------------------------------------------------------
test('guard — exact CUSTODIAN_ALLOW_INSECURE_MEMORY=true overrides in production', () => {
  const cfg = loadCustodianConfig({ ...memProd, CUSTODIAN_ALLOW_INSECURE_MEMORY: 'true' });
  assertEq(cfg.mode, 'memory', 'override allows memory');
});

test('guard — non-exact override values do NOT bypass the guard', () => {
  for (const v of ['1', 'TRUE', 'True', 'yes', 'on', ' true']) {
    expectReject({ ...memProd, CUSTODIAN_ALLOW_INSECURE_MEMORY: v }, `override "${v}" must not bypass`);
  }
});

// file mode unaffected -------------------------------------------------------
test('guard — file mode is allowed in production (guard only targets memory)', () => {
  const cfg = loadCustodianConfig({
    CUSTODIAN_MODE: 'file', COMPLETION_SECRET: secret, APP_ENV: 'production',
    CUSTODIAN_KEYSTORE_DIR: '/var/lib/catalog/keystore', CUSTODIAN_KEK: randomBytes(32).toString('base64'),
  });
  assertEq(cfg.mode, 'file', 'file mode allowed in production');
});

// redaction ------------------------------------------------------------------
test('guard — refusal error never leaks the completion secret value', () => {
  const sentinel = 'SUPERSECRET-GUARD-VALUE';
  expectReject({ CUSTODIAN_MODE: 'memory', COMPLETION_SECRET: sentinel, APP_ENV: 'production' }, 'redaction', (e) => {
    assert(!e.message.includes(sentinel), 'secret value not leaked into the guard error');
  });
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
