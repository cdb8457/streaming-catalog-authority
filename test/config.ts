import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadDbConfig, ConfigError, type Env } from '../src/config/env.js';

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq(a: unknown, b: unknown, msg: string): void { if (a !== b) throw new Error(`${msg} (expected ${String(b)}, got ${String(a)})`); }
function assertThrows(fn: () => unknown, msg: string, check?: (e: Error) => void): void {
  try { fn(); } catch (e) { if (check) check(e as Error); return; }
  throw new Error(`expected to throw: ${msg}`);
}

const DBU = 'postgresql://app:app@localhost:5432/catalog';
const ADU = 'postgresql://postgres:postgres@localhost:5432/catalog';

console.log('Running Phase 3 config/env validation suite (Stage 3.1):\n');

const tmp = mkdtempSync(path.join(tmpdir(), 'cfg-'));
try {
  // 1. DATABASE_URL required ---------------------------------------------------
  test('loadDbConfig — missing DATABASE_URL is a ConfigError listing the var', () => {
    assertThrows(() => loadDbConfig({} as Env), 'missing DATABASE_URL', (e) => {
      assert(e instanceof ConfigError, 'is ConfigError');
      assert(/DATABASE_URL is required/.test(e.message), 'message names DATABASE_URL');
    });
  });

  // 2. DATABASE_URL only -> single-role fallback ------------------------------
  test('loadDbConfig — DATABASE_URL only -> admin falls back, singleRole=true', () => {
    const c = loadDbConfig({ DATABASE_URL: DBU });
    assertEq(c.databaseUrl, DBU, 'databaseUrl');
    assertEq(c.adminDatabaseUrl, DBU, 'admin falls back to database');
    assertEq(c.singleRole, true, 'singleRole true');
  });

  // 3. both set -> distinct roles ---------------------------------------------
  test('loadDbConfig — distinct admin + database roles', () => {
    const c = loadDbConfig({ DATABASE_URL: DBU, ADMIN_DATABASE_URL: ADU });
    assertEq(c.adminDatabaseUrl, ADU, 'admin url');
    assertEq(c.singleRole, false, 'singleRole false');
  });

  // 4. *_FILE indirection ------------------------------------------------------
  test('resolveVar — *_FILE indirection reads value and strips one trailing newline', () => {
    const f = path.join(tmp, 'dburl');
    writeFileSync(f, `${DBU}\n`);
    const c = loadDbConfig({ DATABASE_URL_FILE: f });
    assertEq(c.databaseUrl, DBU, 'value read from file, newline stripped');
  });

  // 5. NAME and NAME_FILE both set -> conflict --------------------------------
  test('resolveVar — setting both NAME and NAME_FILE is a conflict', () => {
    const f = path.join(tmp, 'dburl2');
    writeFileSync(f, DBU);
    assertThrows(() => loadDbConfig({ DATABASE_URL: DBU, DATABASE_URL_FILE: f }), 'conflict', (e) => {
      assert(/both set/.test(e.message), 'reports conflict');
    });
  });

  // 6. empty value rejected ----------------------------------------------------
  test('resolveVar — empty/whitespace value is rejected', () => {
    assertThrows(() => loadDbConfig({ DATABASE_URL: '   ' }), 'empty value', (e) => {
      assert(/DATABASE_URL is set but empty/.test(e.message), 'reports empty');
    });
  });

  // 7. empty *_FILE target rejected -------------------------------------------
  test('resolveVar — empty file target is rejected', () => {
    const f = path.join(tmp, 'empty');
    writeFileSync(f, '\n');
    assertThrows(() => loadDbConfig({ DATABASE_URL_FILE: f }), 'empty file', (e) => {
      assert(/DATABASE_URL_FILE file is empty/.test(e.message), 'reports empty file');
    });
  });

  // 8. unreadable *_FILE rejected without leaking the path --------------------
  test('resolveVar — unreadable file is reported by var name only (no path leak)', () => {
    const bogus = path.join(tmp, 'does-not-exist-SECRETPATH');
    assertThrows(() => loadDbConfig({ DATABASE_URL_FILE: bogus }), 'unreadable', (e) => {
      assert(/DATABASE_URL_FILE points to a file that could not be read/.test(e.message), 'names the var');
      assert(!e.message.includes('SECRETPATH'), 'does not leak the file path');
    });
  });

  // 9. REDACTION: connection-string secrets never appear in error messages ----
  test('loadDbConfig — secrets in values never leak into ConfigError', () => {
    const secretUrl = 'postgresql://app:SUPERSECRETPW@localhost:5432/catalog';
    const f = path.join(tmp, 'adminfile');
    writeFileSync(f, ADU);
    // trigger an ADMIN conflict while DATABASE_URL holds a secret password
    assertThrows(
      () => loadDbConfig({ DATABASE_URL: secretUrl, ADMIN_DATABASE_URL: ADU, ADMIN_DATABASE_URL_FILE: f }),
      'conflict with secret present',
      (e) => {
        assert(/ADMIN_DATABASE_URL and ADMIN_DATABASE_URL_FILE are both set/.test(e.message), 'reports admin conflict');
        assert(!e.message.includes('SUPERSECRETPW'), 'password value never leaks into the error');
      },
    );
  });

  // 10. aggregate reporting: multiple problems at once ------------------------
  test('loadDbConfig — reports every problem at once (aggregate, not first-throw)', () => {
    const fAdmin = path.join(tmp, 'adminfile2');
    writeFileSync(fAdmin, ADU);
    assertThrows(
      () => loadDbConfig({ ADMIN_DATABASE_URL: ADU, ADMIN_DATABASE_URL_FILE: fAdmin }), // missing DB + admin conflict
      'aggregate',
      (e) => {
        const ce = e as ConfigError;
        assert(ce instanceof ConfigError, 'is ConfigError');
        assertEq(ce.problems.length, 2, 'two problems aggregated');
      },
    );
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${(err as Error).stack ?? err}`);
  process.exit(1);
}
