import { Client, Pool } from 'pg';
import { CatalogAuthority } from '../core/catalog/authority.js';
import { BackupPolicy, BackupIntegrityError, type BackupArtifact } from '../core/backup/backup-policy.js';
import type { KeyCustodian } from '../core/crypto/custodian.js';
import { migrateWith } from '../db/pool.js';

/**
 * Phase 6 Stage 6.4 — restore rehearsal into an operator-provided THROWAWAY database.
 *
 * Proves a backup actually restores + decrypts end-to-end, WITHOUT touching production: it connects
 * ONLY to `REHEARSAL_ADMIN_DATABASE_URL`, migrates it, provisions the completion secret, runs the
 * REAL `BackupPolicy.restore` (including the replay-and-compare integrity gate), and does a sample
 * read through `CatalogAuthority`. Production is never connected for a write.
 *
 * SAFETY: it HARD-REFUSES if the rehearsal database resolves to any production database
 * (same host+port+dbname as ADMIN_DATABASE_URL or DATABASE_URL) — best-effort structural
 * comparison; operators must use a genuinely separate throwaway DB.
 */

export class RehearsalRefused extends Error {
  constructor(message: string) { super(message); this.name = 'RehearsalRefused'; }
}

export interface RehearsalStep { step: string; ok: boolean; detail: string; }
export interface RehearsalReport { ok: boolean; steps: RehearsalStep[]; }

/** Structural identity of a database from its URL: host:port/dbname (best-effort). */
export function dbKey(connectionString: string): string {
  const u = new URL(connectionString);
  return `${u.hostname.toLowerCase()}:${u.port || '5432'}${u.pathname}`;
}

export async function runRehearsal(deps: {
  artifact: BackupArtifact;
  rehearsalAdminUrl: string;
  productionUrls: string[]; // e.g. [ADMIN_DATABASE_URL, DATABASE_URL]
  completionSecret: string;
  custodian: KeyCustodian;
}): Promise<RehearsalReport> {
  // 1. HARD refusal if the rehearsal DB resolves to a production DB.
  const rk = dbKey(deps.rehearsalAdminUrl);
  for (const p of deps.productionUrls) {
    if (dbKey(p) === rk) {
      throw new RehearsalRefused(`refusing: the rehearsal database (${rk}) resolves to a PRODUCTION database — use a separate throwaway DB`);
    }
  }

  const steps: RehearsalStep[] = [];
  // 2. migrate the rehearsal DB (same schema/grants as production).
  await migrateWith(deps.rehearsalAdminUrl);
  steps.push({ step: 'migrate', ok: true, detail: 'rehearsal schema applied' });

  const admin = new Client({ connectionString: deps.rehearsalAdminUrl });
  await admin.connect();
  const pool = new Pool({ connectionString: deps.rehearsalAdminUrl, max: 4 });
  try {
    // 3. provision the completion secret in the rehearsal DB.
    await admin.query('SELECT set_completion_secret($1)', [deps.completionSecret]);
    steps.push({ step: 'provision-secret', ok: true, detail: 'completion secret set' });

    // 4. REAL restore (includes the replay-and-compare integrity gate).
    try {
      await BackupPolicy.restore(admin, deps.artifact);
      steps.push({ step: 'restore', ok: true, detail: 'artifact restored; integrity gate passed' });
    } catch (err) {
      const detail = err instanceof BackupIntegrityError ? `integrity gate rejected the artifact: ${err.message}` : (err as Error).message;
      steps.push({ step: 'restore', ok: false, detail });
      return { ok: false, steps };
    }

    // 5. sample read — proves restore + decrypt end-to-end (real read path + custodian/KEK).
    const items = (deps.artifact.tables.find((t) => t.table === 'items')?.rows ?? []) as Array<{ id: string; present: boolean; forgotten: boolean }>;
    const sample = items.find((i) => i.present && !i.forgotten);
    if (!sample) {
      steps.push({ step: 'sample-read', ok: true, detail: 'no present item to sample (empty/forgotten backup)' });
    } else {
      const identity = await new CatalogAuthority(pool, deps.custodian).readIdentity(sample.id);
      const ok = identity !== null;
      steps.push({ step: 'sample-read', ok, detail: ok ? `item ${sample.id} decrypts + reads OK` : `item ${sample.id} did not read (custodian/KEK unavailable for this DB?)` });
    }

    return { ok: steps.every((s) => s.ok), steps };
  } finally {
    await admin.end();
    await pool.end();
  }
}
