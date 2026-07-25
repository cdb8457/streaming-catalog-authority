import { Client } from 'pg';
import { loadDbConfig } from '../config/env.js';
import { MIGRATION_VERSION } from '../db/schema-version.js';
import type { DatabaseFact } from './operator-ui-installation-readiness.js';

// Phase 246 — is the database there, and has it been migrated?
//
// Deliberately NOT the doctor. `runDoctor` opens two connections, probes privileges with rollback-wrapped
// writes and answers a dozen questions an installer does not have. This answers one, in one short-lived
// connection, and turns every possible outcome into a single word.
//
// IT CANNOT HANG THE PAGE. A database that is starting, wedged, or behind a firewall answers nothing at all,
// and a readiness panel that waits forever is worse than one that says UNREACHABLE — so the connection and
// the query are both bounded, and the connection is closed on every path including a thrown one.
//
// IT LEAKS NOTHING. `loadDbConfig` is already redaction-safe (variable names, never values), and nothing it
// returns is used here beyond handing the URL straight to the driver. The error is discarded, not formatted:
// a PostgreSQL connection failure message embeds the host, the port, the user and sometimes the database
// name, and none of that belongs on a page or in a support report.

export const DATABASE_PROBE_CONNECT_TIMEOUT_MS = 4000;
export const DATABASE_PROBE_STATEMENT_TIMEOUT_MS = 4000;

export interface DatabaseProbeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly connectTimeoutMs?: number;
}

export async function probeDatabase(options: DatabaseProbeOptions = {}): Promise<DatabaseFact> {
  const env = options.env ?? process.env;

  let connectionString: string;
  try {
    connectionString = loadDbConfig(env).databaseUrl;
  } catch {
    return 'NOT_CONFIGURED';
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: options.connectTimeoutMs ?? DATABASE_PROBE_CONNECT_TIMEOUT_MS,
    statement_timeout: DATABASE_PROBE_STATEMENT_TIMEOUT_MS,
  });

  try {
    await client.connect();
  } catch {
    // Includes bad credentials and a refused socket alike. From an installer's point of view they are the
    // same sentence — "the database did not answer" — and distinguishing them here would mean reporting why.
    await client.end().catch(() => undefined);
    return 'UNREACHABLE';
  }

  try {
    const version = await readSchemaVersion(client);
    if (version === null) return 'SCHEMA_MISSING';
    return version === MIGRATION_VERSION ? 'OK' : 'SCHEMA_STALE';
  } catch {
    // The connection succeeded, so the server is up; neither the reader nor the table is there. That is an
    // unmigrated database, which is a setup step rather than a fault.
    return 'SCHEMA_MISSING';
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The applied schema version, over the LEAST-PRIVILEGED runtime connection.
 *
 * Phase 253 fix. This used to read `schema_meta` directly, which migrations.sql revokes from the runtime role
 * — so on any deployment that actually gave the app its own least-privileged credential, the read was denied,
 * the denial was caught as "no schema", and the panel reported SCHEMA_MISSING against a perfectly migrated
 * database. It only appeared to work because the ordinary-computer stack was handing the runtime a superuser
 * URL. A probe that is wrong on exactly the deployments that are configured correctly is not a probe.
 *
 * `cat_schema_version()` (schema v4) is the owner-defined reader granted to the runtime role; it returns the
 * integer and nothing else. The direct table read remains as a FALLBACK, for two real cases: a v3 database
 * that predates the function (so this reports SCHEMA_STALE, which is the truth, rather than SCHEMA_MISSING),
 * and a single-role deployment whose runtime connection is the owner.
 */
async function readSchemaVersion(client: Client): Promise<number | null> {
  try {
    const rows = await client.query('SELECT public.cat_schema_version() AS version');
    const version = rows.rows[0]?.version as number | null | undefined;
    return version ?? null;
  } catch {
    const rows = await client.query('SELECT version FROM schema_meta WHERE id = 1');
    const version = rows.rows[0]?.version as number | undefined;
    return version ?? null;
  }
}
