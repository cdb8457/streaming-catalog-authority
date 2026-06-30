import type { Client, Pool } from 'pg';
import { existsSync, accessSync, constants as fsConstants } from 'node:fs';
import type { KeyCustodian } from '../core/crypto/custodian.js';

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
const EXPECTED_FUNCTIONS = ['cat_add_item_ct', 'cat_forget_complete', 'cat_rebuild', 'set_completion_secret'];

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
  try { await deps.pool.query('SELECT 1'); add('db-app-reachable', 'pass', 'app connection responds'); }
  catch { add('db-app-reachable', 'fail', 'app connection (DATABASE_URL) is not reachable'); }

  // schema migrated --------------------------------------------------------------
  if (ownerOk) {
    try {
      const t = (await deps.admin.query(
        `SELECT count(*)::int AS c FROM unnest($1::text[]) n WHERE to_regclass('public.' || n) IS NOT NULL`, [EXPECTED_TABLES],
      )).rows[0].c as number;
      const f = (await deps.admin.query(
        `SELECT count(DISTINCT proname)::int AS c FROM pg_proc WHERE proname = ANY($1)`, [EXPECTED_FUNCTIONS],
      )).rows[0].c as number;
      if (t === EXPECTED_TABLES.length && f === EXPECTED_FUNCTIONS.length) add('schema-migrated', 'pass', 'all expected tables + functions present');
      else add('schema-migrated', 'fail', `schema incomplete (${t}/${EXPECTED_TABLES.length} tables, ${f}/${EXPECTED_FUNCTIONS.length} functions) — run ops:migrate / ops:init`);
    } catch { add('schema-migrated', 'fail', 'could not introspect schema'); }

    // app role least-privileged (READ-ONLY: privilege introspection, no write attempted) --------
    try {
      const r = (await deps.admin.query(
        `SELECT has_table_privilege('app','public.events','SELECT') AS sel,
                has_table_privilege('app','public.events','INSERT') AS ins,
                has_table_privilege('app','public.crypto_config','SELECT') AS read_secret,
                has_function_privilege('app','public.set_completion_secret(text)','EXECUTE') AS set_secret`,
      )).rows[0] as { sel: boolean; ins: boolean; read_secret: boolean; set_secret: boolean };
      if (r.sel && !r.ins) add('app-least-privileged', 'pass', 'app can SELECT but not write the tables');
      else add('app-least-privileged', 'fail', 'app role is over-privileged (can write tables) or cannot read');
      if (!r.read_secret && !r.set_secret) add('app-cannot-touch-secret', 'pass', 'app cannot read or set the completion secret');
      else add('app-cannot-touch-secret', 'fail', 'app role can read or set crypto_config (must be revoked)');
    } catch { add('app-least-privileged', 'warn', 'could not introspect app-role privileges (role missing?)'); }

    // completion secret provisioned + matches --------------------------------------
    try {
      const dbSecret = (await deps.admin.query('SELECT completion_secret FROM crypto_config WHERE id = 1')).rows[0]?.completion_secret as string | undefined;
      if (!dbSecret) add('completion-secret', 'fail', 'crypto_config has no completion secret — run ops:init / set_completion_secret');
      else if (dbSecret !== deps.completionSecret) add('completion-secret', 'fail', 'configured completion secret does not match crypto_config (shred completion would never verify)');
      else add('completion-secret', 'pass', 'configured completion secret matches crypto_config');
    } catch { add('completion-secret', 'fail', 'could not read crypto_config to verify the completion secret'); }
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
