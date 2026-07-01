import type { Client, Pool, PoolClient } from 'pg';
import { existsSync, accessSync, constants as fsConstants } from 'node:fs';
import type { KeyCustodian } from '../core/crypto/custodian.js';
import { MIGRATION_VERSION } from '../db/schema-version.js';

/**
 * Phase 5 Stage 5.1 — production self-check ("ops doctor").
 *
 * READ-ONLY validator: it never mutates the database, keystore, or config. It reports whether a
 * deployment is correctly wired and safe to operate. Every problem references conditions only —
 * NEVER a secret/KEK/connection-string value (redaction-safe, like the Stage 3.1 config errors).
 *
 * The completion-secret match check here is the SAME invariant the restore preflight enforces
 * (Stage 3.3): the configured secret must equal `crypto_config`, or attested shred completion can
 * never verify. The app-privilege checks confirm the least-privileged runtime role cannot write
 * the tables or read/set the secret.
 */

export type CheckState = 'pass' | 'warn' | 'fail';
export interface DoctorCheck { name: string; state: CheckState; detail: string; }
export interface DoctorReport { ok: boolean; checks: DoctorCheck[]; }

const EXPECTED_TABLES = ['events', 'items', 'provider_refs', 'item_key_control', 'crypto_config', 'aborted_operations'];
const EXPECTED_FUNCTIONS = ['cat_add_item_ct', 'cat_forget_complete', 'cat_rebuild', 'set_completion_secret', 'set_schema_version'];

/**
 * Attempt `sql` on the runtime connection inside a SAVEPOINT and roll it back. Returns 'denied'
 * ONLY on a real permission error (SQLSTATE 42501); any other outcome (success, or a constraint
 * error reached only AFTER the permission check) means the connection is permitted the operation.
 * The SAVEPOINT rollback keeps the probe read-only in its final state and lets later probes run.
 */
async function probeForbidden(client: PoolClient, sql: string): Promise<'denied' | 'allowed'> {
  await client.query('SAVEPOINT doctor_probe');
  try {
    await client.query(sql);
    await client.query('ROLLBACK TO SAVEPOINT doctor_probe');
    return 'allowed';
  } catch (err) {
    try { await client.query('ROLLBACK TO SAVEPOINT doctor_probe'); } catch { /* ignore */ }
    return (err as { code?: string }).code === '42501' ? 'denied' : 'allowed';
  }
}

export interface DoctorDeps {
  admin: Client;      // owner/migrator connection
  pool: Pool;         // least-privileged app connection
  custodian: KeyCustodian;
  completionSecret: string;
  custodianMode: 'memory' | 'file' | string;
  appEnv: 'production' | 'development' | 'test' | string;
  keystoreDir?: string;
}

/** Run the read-only production self-check. Never throws for an expected failure. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, state: CheckState, detail: string): void => { checks.push({ name, state, detail }); };

  // environment + custodian mode -------------------------------------------------
  add('environment', 'pass', `APP_ENV=${deps.appEnv}; custodian mode=${deps.custodianMode}`);
  if (deps.custodianMode === 'memory') {
    add('custodian-durability', deps.appEnv === 'production' ? 'fail' : 'warn',
      'memory custodian is in-process and loses all keys on restart (dev/test only)');
  }

  // DB reachability --------------------------------------------------------------
  let ownerOk = false;
  try { await deps.admin.query('SELECT 1'); ownerOk = true; add('db-owner-reachable', 'pass', 'owner/admin connection responds'); }
  catch { add('db-owner-reachable', 'fail', 'owner/admin connection (ADMIN_DATABASE_URL) is not reachable'); }
  let appOk = false;
  try { await deps.pool.query('SELECT 1'); appOk = true; add('db-app-reachable', 'pass', 'app connection responds'); }
  catch { add('db-app-reachable', 'fail', 'app connection (DATABASE_URL) is not reachable'); }

  // schema migrated --------------------------------------------------------------
  let schemaOk = false;
  if (ownerOk) {
    try {
      const t = (await deps.admin.query(
        `SELECT count(*)::int AS c FROM unnest($1::text[]) n WHERE to_regclass('public.' || n) IS NOT NULL`, [EXPECTED_TABLES],
      )).rows[0].c as number;
      const f = (await deps.admin.query(
        `SELECT count(DISTINCT proname)::int AS c FROM pg_proc WHERE proname = ANY($1)`, [EXPECTED_FUNCTIONS],
      )).rows[0].c as number;
      if (t === EXPECTED_TABLES.length && f === EXPECTED_FUNCTIONS.length) { schemaOk = true; add('schema-migrated', 'pass', 'all expected tables + functions present'); }
      else add('schema-migrated', 'fail', `schema incomplete (${t}/${EXPECTED_TABLES.length} tables, ${f}/${EXPECTED_FUNCTIONS.length} functions) — run ops:migrate / ops:init`);
    } catch { add('schema-migrated', 'fail', 'could not introspect schema'); }

    // completion secret provisioned + matches --------------------------------------
    try {
      const dbSecret = (await deps.admin.query('SELECT completion_secret FROM crypto_config WHERE id = 1')).rows[0]?.completion_secret as string | undefined;
      if (!dbSecret) add('completion-secret', 'fail', 'crypto_config has no completion secret — run ops:init / set_completion_secret');
      else if (dbSecret !== deps.completionSecret) add('completion-secret', 'fail', 'configured completion secret does not match crypto_config (shred completion would never verify)');
      else add('completion-secret', 'pass', 'configured completion secret matches crypto_config');
    } catch { add('completion-secret', 'fail', 'could not read crypto_config to verify the completion secret'); }

    // schema/migration version matches what this build expects --------------------
    try {
      const v = (await deps.admin.query('SELECT version FROM schema_meta WHERE id = 1')).rows[0]?.version as number | undefined;
      if (v === undefined) add('schema-version', 'fail', 'schema_meta is missing — run ops:migrate / ops:init');
      else if (v !== MIGRATION_VERSION) add('schema-version', 'fail', `schema version mismatch (db ${v}, expected ${MIGRATION_VERSION}) — run ops:migrate`);
      else add('schema-version', 'pass', `schema version ${v}`);
    } catch { add('schema-version', 'fail', 'could not read schema_meta (run ops:migrate)'); }
  }

  // RUNTIME least-privilege — probe the ACTUAL connection behind DATABASE_URL (not a named role).
  // Rollback-safe: every probe runs in a transaction that is ROLLED BACK, so doctor stays
  // read-only in its final state. A probe is "denied" only on a real permission error (42501);
  // anything else (success, or a constraint error reached past the permission check) means the
  // connection IS permitted that operation -> over-privileged.
  if (appOk && schemaOk) {
    let client: PoolClient | null = null;
    try {
      client = await deps.pool.connect();
      const who = (await client.query('SELECT current_user AS u')).rows[0].u as string;
      await client.query('BEGIN');
      const writes: Record<string, string> = {
        'events INSERT': await probeForbidden(client, `INSERT INTO public.events (item_id, kind, type, payload) VALUES ('00000000-0000-0000-0000-000000000000','structural','ItemAdded','{}'::jsonb)`),
        'items UPDATE': await probeForbidden(client, 'UPDATE public.items SET updated_at = updated_at WHERE false'),
        'item_key_control UPDATE': await probeForbidden(client, 'UPDATE public.item_key_control SET updated_at = updated_at WHERE false'),
      };
      const secret: Record<string, string> = {
        'read crypto_config': await probeForbidden(client, 'SELECT completion_secret FROM public.crypto_config WHERE id = 1'),
        'set_completion_secret': await probeForbidden(client, `SELECT public.set_completion_secret('doctor-probe')`),
      };
      await client.query('ROLLBACK');
      const writable = Object.entries(writes).filter(([, v]) => v !== 'denied').map(([k]) => k);
      add('runtime-least-privileged', writable.length === 0 ? 'pass' : 'fail',
        writable.length === 0 ? `runtime role "${who}" cannot write the tables` : `runtime role "${who}" CAN write [${writable.join(', ')}] — DATABASE_URL is over-privileged`);
      const reachable = Object.entries(secret).filter(([, v]) => v !== 'denied').map(([k]) => k);
      add('runtime-cannot-touch-secret', reachable.length === 0 ? 'pass' : 'fail',
        reachable.length === 0 ? `runtime role "${who}" cannot read or set the completion secret` : `runtime role "${who}" CAN [${reachable.join(', ')}] — DATABASE_URL is over-privileged`);
    } catch {
      try { await client?.query('ROLLBACK'); } catch { /* ignore */ }
      add('runtime-least-privileged', 'warn', 'could not run runtime-privilege probes on the app connection');
    } finally {
      client?.release();
    }
  }

  // custodian reachability -------------------------------------------------------
  try { await deps.custodian.status('doctor-liveness-probe'); add('custodian-reachable', 'pass', 'custodian status probe responds'); }
  catch { add('custodian-reachable', 'fail', 'key custodian is not reachable (status probe failed)'); }

  // file-mode keystore -----------------------------------------------------------
  if (deps.custodianMode === 'file') {
    const dir = deps.keystoreDir;
    if (!dir) add('keystore', 'fail', 'CUSTODIAN_KEYSTORE_DIR is not set for mode=file');
    else if (!existsSync(dir)) add('keystore', 'warn', 'keystore directory does not exist yet (created on first use)');
    else {
      try { accessSync(dir, fsConstants.W_OK); add('keystore', 'pass', 'keystore directory exists and is writable'); }
      catch { add('keystore', 'fail', 'keystore directory exists but is not writable'); }
    }
  }

  const ok = checks.every((c) => c.state !== 'fail');
  return { ok, checks };
}

/** Render a report as redaction-safe text lines (no secret values are ever in a check detail). */
export function formatDoctorReport(report: DoctorReport): string {
  const icon = (s: CheckState): string => (s === 'pass' ? 'PASS' : s === 'warn' ? 'WARN' : 'FAIL');
  const lines = report.checks.map((c) => `  ${icon(c.state)}  ${c.name}: ${c.detail}`);
  lines.push(`\n${report.ok ? 'doctor: OK' : 'doctor: FAILED (one or more checks failed)'}`);
  return lines.join('\n');
}
