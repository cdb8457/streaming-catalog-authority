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
    const rows = await client.query('SELECT version FROM schema_meta WHERE id = 1');
    const version = rows.rows[0]?.version as number | undefined;
    if (version === undefined) return 'SCHEMA_MISSING';
    return version === MIGRATION_VERSION ? 'OK' : 'SCHEMA_STALE';
  } catch {
    // The connection succeeded, so the server is up; the table simply is not there yet. That is an
    // unmigrated database, which is a setup step rather than a fault.
    return 'SCHEMA_MISSING';
  } finally {
    await client.end().catch(() => undefined);
  }
}
