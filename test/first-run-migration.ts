import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { startEmbedded } from './embedded-pg.js';
import {
  migrateWith,
  MigrationLockUnavailableError,
  MigrationVerificationError,
  MIGRATED_TABLES,
} from '../src/db/pool.js';
import { MIGRATION_ADVISORY_LOCK_KEY, MIGRATION_VERSION } from '../src/db/schema-version.js';
import { parseRuntimeCredential, RUNTIME_PASSWORD_MIN_LENGTH } from '../src/ops/bootstrap.js';
import { probeDatabase } from '../src/ops/operator-ui-database-probe.js';
import { asMap, parseYaml, service, stringList, type YamlMap } from './helpers/compose-yaml.js';

// Phase 253 — the first run, adversarially.
//
// THE DEFECT. v1.1.0's ordinary-computer stack had no migration step. `docker compose up -d` produced a UI
// reporting itself healthy in front of a database with no schema, and the only way forward was a command in
// none of its instructions. Every test here is written against a way that fix could be fake:
//
//   * a migration that "succeeds" without leaving the schema behind
//   * a second migration that corrupts the first, or deadlocks against it
//   * a lock wait that never ends, so a container hangs instead of failing
//   * a readiness probe that only works because the runtime was handed a superuser
//   * Compose ordering that LOOKS fail-closed and is not
//
// MOST OF THIS RUNS AGAINST A REAL POSTGRESQL. Advisory locks, privilege denials and SECURITY DEFINER
// semantics are exactly the things a fake would get wrong, and they are the things being asserted. The
// embedded server is thrown away at the end.

let passed = 0;
let failed = 0;
const failures: Array<[string, unknown]> = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; failures.push([name, err]); console.log(`  FAIL  ${name}: ${(err as Error).message}`); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
async function assertThrows<T>(fn: () => Promise<unknown>, is: new (...args: never[]) => T, msg: string): Promise<T> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof is) return err;
    throw new Error(`${msg}: threw ${(err as Error).name} instead of ${is.name} — ${(err as Error).message}`);
  }
  throw new Error(`${msg}: did not throw at all`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}/${rel}`, 'utf8');
const compose = (rel: string): YamlMap => asMap(parseYaml(read(rel)), rel);

console.log('Running Phase 253 first-run migration suite:\n');

// ---------------------------------------------------------------------------------------------------------
// Static: the Compose ordering IS the fail-closed guarantee, so it is asserted structurally.
// ---------------------------------------------------------------------------------------------------------

/**
 * EVERY stack that starts a long-running operator UI. Named individually rather than globbed, because the
 * point is that a reader can see the list is complete — and because the first pass of this phase fixed only
 * the two consumer stacks and left both Unraid stacks with the very defect the phase exists to close. A glob
 * would have hidden that; an enumeration makes an omission visible.
 *
 * `docker-compose.yml` (the CI harness) and `docker-compose.deploy.yml` (one-shot ops only) are deliberately
 * absent: neither runs an operator UI, so neither has an app to gate.
 */
const STACKS_WITH_AN_APP: readonly string[] = [
  'docker-compose.runtime.yml',        // ordinary computer, the one the release bundle ships
  'docker-compose.arcane.yml',         // Arcane / Unraid, absolute host paths
  'docker-compose.unraid.yml',         // canonical Unraid, builds from the repo
  'docker-compose.unraid.runtime.yml', // Unraid launcher stack, prebuilt image + sidecar custody
];

for (const file of STACKS_WITH_AN_APP) {
  await test(`${file} runs the migration to completion before the app is allowed to start`, () => {
    const doc = compose(file);
    const migrate = service(doc, 'migrate');
    const app = service(doc, 'app');

    assertEq(stringList(migrate.command ?? null, 'migrate command').join(' '), 'ops:bootstrap',
      'the one-shot runs the bootstrap, not a bare migrate that would leave the completion secret unprovisioned');
    assertEq(migrate.restart, 'no',
      'and never restarts — a restarting one-shot races itself and can never satisfy service_completed_successfully');
    assert(migrate.ports === undefined, 'the one-shot publishes nothing');

    const dependsOn = asMap(app.depends_on ?? null, 'app depends_on');
    const onMigrate = asMap(dependsOn.migrate ?? null, 'app depends_on.migrate');
    assertEq(onMigrate.condition, 'service_completed_successfully',
      'the app waits for the migration to EXIT ZERO — not for it to merely start, which would gate on nothing');
    const onPostgres = asMap(dependsOn.postgres ?? null, 'app depends_on.postgres');
    assertEq(onPostgres.condition, 'service_healthy', 'and still waits for the database to be healthy');

    // The migration needs the OWNER credential; a stack that handed it only the runtime role could not
    // create anything, and the failure would arrive as a permission error at first boot.
    const secrets = stringList(migrate.secrets ?? null, 'migrate secrets');
    for (const required of ['admin_database_url', 'database_url']) {
      assert(secrets.includes(required), `the one-shot is given ${required}`);
    }
    // It has no business reading anyone's evidence.
    const volumes = migrate.volumes === undefined || migrate.volumes === null
      ? [] : stringList(migrate.volumes, 'migrate volumes');
    assert(!volumes.some((entry) => entry.includes('promotion-records')),
      'and never mounts the promotion records folder');

    // SCHEMA HEALTH, as well as the ordering. The gate above covers a container Compose starts; this covers
    // one started any other way — `docker run`, or a launcher that ignores depends_on — which is the shape
    // the original defect actually arrived in.
    const env = asMap(app.environment ?? null, 'app environment');
    assertEq(env.OPERATOR_UI_HEALTHZ_REQUIRES_SCHEMA, '1',
      'and the app refuses to report healthy until the schema is at the version this build requires');

    // The migration must run the SAME build as the app, or a stack could migrate with one version and serve
    // with another — which is a schema disagreement nobody would think to look for.
    assertEq(migrate.image ?? null, app.image ?? null, 'the migration and the app run the same image reference');
    assertEq(migrate.build ?? null, app.build ?? null, 'or are built from the same context');
  });
}

// The manual one-shot is a SEPARATE surface and must stay one. Folding the startup gate into it would make
// every hand-run `docker compose run --rm ops ...` a startup gate too, and a change to one would silently
// change the other.
for (const file of ['docker-compose.unraid.yml', 'docker-compose.unraid.runtime.yml']) {
  await test(`${file} keeps its manual ops container separate from the startup migration`, () => {
    const doc = compose(file);
    const ops = service(doc, 'ops');
    const migrate = service(doc, 'migrate');
    assert(ops !== migrate, 'they are two services');
    assertEq(ops.restart, 'no', 'the manual container is still one-shot');
    assert(ops.ports === undefined, 'and still publishes nothing');
    // Unchanged: it still defaults to the bare migration, which is what a maintainer invoking it by hand
    // expects, and it keeps the mounts that make the doctor and backups usable.
    assertEq(stringList(ops.command ?? null, 'ops command').join(' '), 'ops:migrate',
      'the manual container keeps its own default command');
    const opsVolumes = stringList(ops.volumes ?? null, 'ops volumes');
    assert(opsVolumes.some((entry) => entry.includes('/backups')), 'and its backups mount');
    // Nothing depends on `ops`: it is invoked, never started as part of `up`.
    for (const [name, svc] of Object.entries(asMap(doc.services ?? null, 'services'))) {
      const dependsOn = asMap(svc, `service ${name}`).depends_on;
      if (dependsOn === undefined || dependsOn === null) continue;
      assert(!Object.keys(asMap(dependsOn, `${name} depends_on`)).includes('ops'),
        `${name} does not gate startup on the manual ops container`);
    }
  });
}

await test('a bare `ops:migrate` is still available, and is not what the stacks depend on', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assertEq(pkg.scripts['ops:migrate'], 'tsx src/ops/migrate-cli.ts', 'the maintainer command still exists');
  assertEq(pkg.scripts['ops:bootstrap'], 'tsx src/ops/bootstrap-cli.ts', 'and the first-run command is its own entry point');
});

// ---------------------------------------------------------------------------------------------------------
// Pure: the credential parser decides whether a deployment's runtime role is one we may re-credential.
// ---------------------------------------------------------------------------------------------------------

await test('the runtime credential parser reads what the driver reads, and refuses everything else', () => {
  const plain = parseRuntimeCredential('postgresql://app:abcdefghijklmnop@postgres:5432/catalog');
  assertEq(plain?.user, 'app', 'the role is read');
  assertEq(plain?.password, 'abcdefghijklmnop', 'and so is the password');

  // A generated base64 secret routinely contains `/` and `+`, which MUST be percent-encoded in a URL. If this
  // decoded differently from the driver, the bootstrap would set the database to a password the app then
  // could not use — a self-inflicted lockout on exactly the installs that generated a strong secret.
  const encoded = parseRuntimeCredential('postgresql://app:a%2Fb%2Bc%3Dd1234567890@postgres:5432/catalog');
  assertEq(encoded?.password, 'a/b+c=d1234567890', 'percent-encoding is decoded, not passed through');

  for (const [why, url] of [
    ['a non-postgres scheme', 'mysql://app:secret@host/db'],
    ['no user at all', 'postgresql://host:5432/catalog'],
    ['not a URL', 'this is not a url'],
  ] as const) {
    assertEq(parseRuntimeCredential(url), null, `${why} is refused rather than guessed at`);
  }
});

await test('a weak or absent runtime password is never pushed into the database', () => {
  // The SQL guard and the TypeScript guard have to agree, or one of them is decoration.
  assert(/length\(p_password\) < 16/.test(read('src/db/migrations.sql')),
    'the SQL refuses a short password itself, so a caller bypassing the CLI cannot install one');
  assertEq(RUNTIME_PASSWORD_MIN_LENGTH, 16, 'and the caller-side guard is the same number');
});

// ---------------------------------------------------------------------------------------------------------
// Live: a real PostgreSQL. Everything below depends on genuine lock and privilege semantics.
// ---------------------------------------------------------------------------------------------------------

let server: Awaited<ReturnType<typeof startEmbedded>> | null = null;
const external = process.env.DATABASE_URL !== undefined;
if (!external) {
  console.log('\n  Booting embedded PostgreSQL 16 for the live migration proofs ...\n');
  server = await startEmbedded();
}
const adminUrl = process.env.ADMIN_DATABASE_URL!;
const runtimeUrl = process.env.DATABASE_URL!;

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try { return await fn(client); } finally { await client.end().catch(() => undefined); }
}

await test('a first migration creates the schema and records the version this build requires', async () => {
  await migrateWith(adminUrl);
  await withAdmin(async (client) => {
    const version = (await client.query<{ version: number }>('SELECT version FROM public.schema_meta WHERE id = 1')).rows[0]?.version;
    assertEq(version, MIGRATION_VERSION, 'the recorded version is this build\'s');
    for (const table of MIGRATED_TABLES) {
      const present = (await client.query<{ ok: boolean }>(
        `SELECT to_regclass('public.' || $1) IS NOT NULL AS ok`, [table])).rows[0]?.ok;
      assert(present, `${table} exists after migrating`);
    }
  });
});

await test('migrating again changes nothing and still succeeds — it is safe on every `up`, not just the first', async () => {
  const before = await withAdmin(async (client) => (await client.query<{ version: number }>(
    'SELECT version FROM public.schema_meta WHERE id = 1')).rows[0]!.version);
  await migrateWith(adminUrl);
  await migrateWith(adminUrl);
  const after = await withAdmin(async (client) => (await client.query<{ version: number }>(
    'SELECT version FROM public.schema_meta WHERE id = 1')).rows[0]!.version);
  assertEq(after, before, 'a repeated migration leaves the recorded version alone');
});

await test('two migrations racing produce one migration and one no-op, not two half-migrations', async () => {
  // Genuinely concurrent, against one server. Without the advisory lock these two would interleave inside
  // CREATE ROLE / CREATE OR REPLACE FUNCTION and either deadlock or error; with it, one waits.
  const results = await Promise.allSettled([migrateWith(adminUrl), migrateWith(adminUrl), migrateWith(adminUrl)]);
  const rejected = results.filter((r) => r.status === 'rejected');
  assertEq(rejected.length, 0, `all three concurrent migrations succeeded — ${rejected.map((r) => String((r as PromiseRejectedResult).reason)).join(' | ')}`);
  await withAdmin(async (client) => {
    const version = (await client.query<{ version: number }>('SELECT version FROM public.schema_meta WHERE id = 1')).rows[0]?.version;
    assertEq(version, MIGRATION_VERSION, 'and the database is at exactly one version afterwards');
    const rows = (await client.query<{ count: string }>('SELECT count(*) AS count FROM public.schema_meta')).rows[0]!.count;
    assertEq(rows, '1', 'with exactly one version row, not one per racer');
  });
});

await test('a migration blocked by a held lock fails closed and diagnosably, rather than hanging forever', async () => {
  // Hold the exact lock the migration takes, from an unrelated session, and prove the migration gives up
  // with the code that means "someone else is migrating" — not a schema error, and not an infinite wait.
  const holder = new Client({ connectionString: adminUrl });
  await holder.connect();
  await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
  try {
    const started = Date.now();
    const err = await assertThrows(
      () => migrateWith(adminUrl, { lockTimeoutMs: 600, lockPollIntervalMs: 50 }),
      MigrationLockUnavailableError,
      'a blocked migration');
    assertEq(err.code, 'MIGRATION_LOCK_UNAVAILABLE', 'the failure carries a stable code a caller can branch on');
    const waited = Date.now() - started;
    assert(waited >= 500, `it actually waited for the lock before giving up (waited ${waited}ms)`);
    assert(waited < 20_000, `and it gave up rather than blocking forever (waited ${waited}ms)`);
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => undefined);
    await holder.end().catch(() => undefined);
  }
});

await test('the lock is released, so a migration after a blocked one succeeds', async () => {
  await migrateWith(adminUrl, { lockTimeoutMs: 5000 });
  const held = await withAdmin(async (client) => (await client.query<{ count: string }>(
    'SELECT count(*) AS count FROM pg_locks WHERE locktype = $1 AND objid = $2', ['advisory', MIGRATION_ADVISORY_LOCK_KEY])).rows[0]!.count);
  assertEq(held, '0', 'and no advisory lock is left held behind it');
});

/** A throwaway database on the same server, so a destructive proof cannot damage the shared one. */
async function withScratchDatabase<T>(name: string, fn: (url: string) => Promise<T>): Promise<T> {
  await withAdmin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${name}`);
    await client.query(`CREATE DATABASE ${name}`);
  });
  const url = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  try {
    return await fn(url);
  } finally {
    await withAdmin(async (client) => { await client.query(`DROP DATABASE IF EXISTS ${name}`); });
  }
}

await test('a migration whose version write does not take is reported as UNVERIFIED, not as success', async () => {
  // The verification has to be a real read-back rather than a constant returned next to the write. So: a
  // database where the write is silently swallowed. A BEFORE UPDATE trigger returning NULL suppresses the row
  // update without raising, which is exactly the shape of failure a "successful" migration would hide —
  // every statement returns fine and the recorded version never moves.
  //
  // migrations.sql cannot undo this: it creates schema_meta with IF NOT EXISTS and replaces its FUNCTIONS,
  // but it does not drop triggers it never created.
  await withScratchDatabase('catalog_unverified_probe', async (url) => {
    const setup = new Client({ connectionString: url });
    await setup.connect();
    try {
      await setup.query(`CREATE TABLE schema_meta (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0)`);
      await setup.query('INSERT INTO schema_meta (id, version) VALUES (1, 0)');
      await setup.query(`CREATE FUNCTION swallow_version_write() RETURNS TRIGGER
        LANGUAGE plpgsql AS $fn$ BEGIN RETURN NULL; END; $fn$`);
      await setup.query(`CREATE TRIGGER swallow_version BEFORE UPDATE ON schema_meta
        FOR EACH ROW EXECUTE FUNCTION swallow_version_write()`);
    } finally {
      await setup.end().catch(() => undefined);
    }

    const err = await assertThrows(() => migrateWith(url), MigrationVerificationError,
      'a migration whose recorded version never moved');
    assertEq(err.code, 'MIGRATION_VERIFICATION_FAILED', 'with a code that distinguishes it from a lock wait');
    assert(err.message.includes(String(MIGRATION_VERSION)), 'and names the version this build requires');

    // And the lock is not left held by the failed attempt, so a retry after fixing the cause can proceed.
    const held = await withAdmin(async (client) => (await client.query<{ count: string }>(
      'SELECT count(*) AS count FROM pg_locks WHERE locktype = $1 AND objid = $2',
      ['advisory', MIGRATION_ADVISORY_LOCK_KEY])).rows[0]!.count);
    assertEq(held, '0', 'a failed migration releases its lock rather than wedging every later attempt');
  });
});

await test('a database that was never migrated reports SCHEMA_MISSING — an empty one is never reported as fine', async () => {
  await withScratchDatabase('catalog_unmigrated_probe', async (url) => {
    const fact = await probeDatabase({
      env: { ...process.env, DATABASE_URL: url, ADMIN_DATABASE_URL: url },
    });
    assertEq(fact, 'SCHEMA_MISSING', 'a reachable database with no schema is MISSING, which is a setup step');
  });
});

await test('the readiness probe reads the schema version over the LEAST-PRIVILEGED role, not a superuser', async () => {
  // The v1.1.0 bug in one assertion. `schema_meta` is revoked from `app`, so the old direct table read was
  // denied on every correctly-configured deployment and reported SCHEMA_MISSING against a migrated database.
  const runtime = new Client({ connectionString: runtimeUrl });
  await runtime.connect();
  try {
    let denied = false;
    try { await runtime.query('SELECT version FROM public.schema_meta WHERE id = 1'); } catch { denied = true; }
    assert(denied, 'the runtime role genuinely cannot read schema_meta — otherwise this test proves nothing');

    const version = (await runtime.query<{ version: number }>('SELECT public.cat_schema_version() AS version')).rows[0]?.version;
    assertEq(version, MIGRATION_VERSION, 'but it can read the applied version through the owner-defined reader');
  } finally {
    await runtime.end().catch(() => undefined);
  }
  assertEq(await probeDatabase({ env: process.env }), 'OK',
    'so the panel reports OK against a migrated database instead of MISSING');
});

await test('the runtime role still cannot re-credential itself or set the migration version', async () => {
  const runtime = new Client({ connectionString: runtimeUrl });
  await runtime.connect();
  try {
    for (const [what, sql] of [
      ['set its own password', `SELECT public.set_app_role_password('a-password-long-enough')`],
      ['move the schema version', 'SELECT public.set_schema_version(1)'],
      ['read the completion secret', 'SELECT completion_secret FROM public.crypto_config WHERE id = 1'],
    ] as const) {
      let code: string | undefined;
      try { await runtime.query(sql); } catch (err) { code = (err as { code?: string }).code; }
      assertEq(code, '42501', `the runtime role is DENIED permission to ${what}`);
    }
  } finally {
    await runtime.end().catch(() => undefined);
  }
});

await test('a stale database reports SCHEMA_STALE, and an unreachable one is never reported as fine', async () => {
  await withAdmin(async (client) => {
    await client.query('UPDATE public.schema_meta SET version = $1 WHERE id = 1', [MIGRATION_VERSION - 1]);
  });
  assertEq(await probeDatabase({ env: process.env }), 'SCHEMA_STALE',
    'a database behind this build is stale, which is a different problem from an empty one');
  await withAdmin(async (client) => {
    await client.query('SELECT set_schema_version($1)', [MIGRATION_VERSION]);
  });
  assertEq(await probeDatabase({ env: process.env }), 'OK', 'and putting it back is enough to make it OK again');

  // A database that answers nothing at all is UNREACHABLE, never quietly OK.
  const unreachable = await probeDatabase({
    env: { ...process.env, DATABASE_URL: 'postgresql://app:app@127.0.0.1:1/catalog', ADMIN_DATABASE_URL: undefined },
    connectTimeoutMs: 800,
  });
  assertEq(unreachable, 'UNREACHABLE', 'a database that does not answer is never reported as fine');
});

await test('the rollback limit is real: an older build refuses a database migrated past it', async () => {
  // There are no down-migrations, and this is the honest consequence. A v1.1.0 image against a v4 database
  // sees a version it does not recognise; the probe must say so rather than serve against it.
  await withAdmin(async (client) => {
    await client.query('UPDATE public.schema_meta SET version = $1 WHERE id = 1', [MIGRATION_VERSION + 1]);
  });
  try {
    assertEq(await probeDatabase({ env: process.env }), 'SCHEMA_STALE',
      'a database ahead of this build is reported as a version disagreement, not as OK');
  } finally {
    await withAdmin(async (client) => { await client.query('SELECT set_schema_version($1)', [MIGRATION_VERSION]); });
  }
  // And the documentation says the same thing, in the place an operator reads before upgrading.
  const lifecycle = read('docs/LIFECYCLE_MIGRATION_BACKUP_UPGRADE_ROLLBACK.md');
  for (const required of ['no down-migrations', 'restore', 'before you upgrade']) {
    assert(lifecycle.toLowerCase().includes(required.toLowerCase()), `the lifecycle doc states: ${required}`);
  }
});

if (server !== null) {
  await server.stop();
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  - ${name}: ${String(err)}`);
  process.exit(1);
}
