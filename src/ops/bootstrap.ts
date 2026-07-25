import { Client } from 'pg';
import { loadDbConfig } from '../config/env.js';
import {
  migrateWith,
  MigrationLockUnavailableError,
  MigrationVerificationError,
  type MigrateOptions,
} from '../db/pool.js';
import { MIGRATION_VERSION } from '../db/schema-version.js';
import { loadCustodianConfig, requireAppHeldCompletionSecret } from '../core/crypto/custodian-factory.js';

// Phase 253 — the step a first run was missing.
//
// WHAT WENT WRONG. v1.1.0's ordinary-computer stack had no migration step at all. `docker compose up -d`
// started PostgreSQL and the operator UI, the UI's healthcheck answered 200 because the process was up, and
// the database behind it had no schema. Setup & Diagnostics said `Database: MISSING` and the only way
// forward was a command that appears in no first-run instruction: `docker compose run --rm app ops:migrate`.
// An install that cannot finish itself is not an install.
//
// WHAT THIS IS. One idempotent, fail-closed command that a fresh stack runs to completion BEFORE the app
// container is allowed to start (Compose `depends_on: { migrate: { condition: service_completed_successfully } }`).
// It is the ordering, not a retry loop, that makes the app unable to be healthy against an unmigrated
// database: a non-zero exit here means the app service never starts.
//
// WHY NOT `ops:init`. `ops:init` exists and does adjacent work, but it ends by running the full production
// doctor and exits non-zero on any FAIL. Several of those failures are legitimate states of a
// correctly-installed machine that has not been used yet, and one of them (`production-gate-o4/o5`) is a
// standing WARN by design. Gating container startup on the doctor would mean a fresh, correct install never
// starts. So this command asserts exactly the things that MUST be true for the app to serve, and leaves every
// operational judgement to the doctor, where an operator can read it. `ops:init` is unchanged and still the
// right tool for a maintainer bootstrapping by hand.
//
// EVERY OUTCOME IS A CODE. Stdout is a sequence of stable step codes, never a connection string, a password,
// a secret or a host path. An operator pasting this log into an issue is pasting nothing they would regret.

export class BootstrapError extends Error {
  constructor(readonly code: BootstrapFailureCode, message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

export type BootstrapFailureCode =
  | 'BOOTSTRAP_CONFIG_INVALID'
  | 'BOOTSTRAP_DATABASE_UNREACHABLE'
  | 'BOOTSTRAP_MIGRATION_LOCK_UNAVAILABLE'
  | 'BOOTSTRAP_MIGRATION_FAILED'
  | 'BOOTSTRAP_MIGRATION_UNVERIFIED'
  | 'BOOTSTRAP_RUNTIME_CREDENTIAL_FAILED'
  | 'BOOTSTRAP_COMPLETION_SECRET_FAILED'
  | 'BOOTSTRAP_RUNTIME_ROLE_UNUSABLE';

export type BootstrapStepId =
  | 'config'
  | 'migrate'
  | 'runtime-credential'
  | 'completion-secret'
  | 'runtime-verify';

export type BootstrapStepOutcome = 'DONE' | 'ALREADY_CURRENT' | 'SKIPPED';

export interface BootstrapStep {
  readonly id: BootstrapStepId;
  readonly outcome: BootstrapStepOutcome;
  /** A fixed sentence chosen by (step, outcome). Never interpolated with a value. */
  readonly detail: string;
}

export interface BootstrapResult {
  readonly ok: true;
  readonly report: 'phase-253-bootstrap';
  readonly schemaVersion: number;
  readonly steps: readonly BootstrapStep[];
}

/**
 * The runtime role name migrations.sql creates. A DATABASE_URL whose user is this role is the least-
 * privileged shape this project is designed around; anything else is the operator's own arrangement and is
 * left alone.
 */
export const RUNTIME_ROLE_NAME = 'app';

/** The shortest runtime password `set_app_role_password` will accept. Mirrors the SQL guard exactly. */
export const RUNTIME_PASSWORD_MIN_LENGTH = 16;

export interface ParsedRuntimeCredential {
  readonly user: string;
  readonly password: string | null;
}

/**
 * Pull the role and password out of a PostgreSQL URL, WITHOUT keeping the URL.
 *
 * `new URL` rather than a regular expression, so a percent-encoded password (which is the normal spelling for
 * a generated base64 secret containing `/` or `+`) is decoded exactly the way the driver decodes it. A URL
 * this cannot parse is not repaired or guessed at: the caller treats it as "not the shape we manage" and
 * changes nothing, because silently re-crediting a role the operator did not mean is far worse than leaving
 * a deployment as they configured it.
 */
export function parseRuntimeCredential(databaseUrl: string): ParsedRuntimeCredential | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;
  if (url.username === '') return null;
  let user: string;
  let password: string | null;
  try {
    user = decodeURIComponent(url.username);
    password = url.password === '' ? null : decodeURIComponent(url.password);
  } catch {
    return null;
  }
  return { user, password };
}

const STEP_DETAIL: Record<BootstrapStepId, Record<BootstrapStepOutcome, string>> = {
  config: {
    DONE: 'Database and custodian configuration loaded.',
    ALREADY_CURRENT: 'Database and custodian configuration loaded.',
    SKIPPED: 'Database and custodian configuration loaded.',
  },
  migrate: {
    DONE: 'Schema applied and verified at the version this build requires.',
    ALREADY_CURRENT: 'Schema was already at the version this build requires; nothing changed.',
    SKIPPED: 'Schema migration was skipped.',
  },
  'runtime-credential': {
    DONE: 'The database now holds the generated password for the least-privileged runtime role.',
    ALREADY_CURRENT: 'The runtime role password already matched; nothing changed.',
    SKIPPED: 'DATABASE_URL does not use the managed runtime role, so its credential was left untouched.',
  },
  'completion-secret': {
    DONE: 'The completion secret was provisioned so attested shred completion can verify.',
    ALREADY_CURRENT: 'The completion secret already matched the configured value; nothing changed.',
    SKIPPED: 'The completion secret is held by the sidecar custodian, so this container did not set it.',
  },
  'runtime-verify': {
    DONE: 'The least-privileged runtime connection can reach the database and read the applied schema version.',
    ALREADY_CURRENT: 'The least-privileged runtime connection can reach the database and read the applied schema version.',
    SKIPPED: 'The runtime connection was not verified.',
  },
};

function step(id: BootstrapStepId, outcome: BootstrapStepOutcome): BootstrapStep {
  return { id, outcome, detail: STEP_DETAIL[id][outcome] };
}

export interface BootstrapOptions extends MigrateOptions {
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Run the first-run sequence to completion, or throw with a code.
 *
 * ORDER IS THE POINT. The schema has to exist before a grant on it means anything; the runtime role has to
 * hold its real password before the runtime connection can be verified; and the verification has to be the
 * LAST thing, because it is the only step that proves the app container will be able to do its job. Each step
 * is individually idempotent, so a re-run after a partial failure resumes rather than conflicts.
 */
export async function runBootstrap(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  const env = options.env ?? process.env;
  const steps: BootstrapStep[] = [];

  let db: ReturnType<typeof loadDbConfig>;
  let custodian: ReturnType<typeof loadCustodianConfig>;
  try {
    db = loadDbConfig(env);
    custodian = loadCustodianConfig(env);
  } catch (err) {
    // The config loaders are already redaction-safe: they name variables, never values.
    throw new BootstrapError('BOOTSTRAP_CONFIG_INVALID', (err as Error).message);
  }
  steps.push(step('config', 'DONE'));

  // 1. Schema ------------------------------------------------------------------------------------------
  const before = await readSchemaVersion(db.adminDatabaseUrl);
  try {
    await migrateWith(db.adminDatabaseUrl, options);
  } catch (err) {
    if (err instanceof MigrationLockUnavailableError) {
      throw new BootstrapError('BOOTSTRAP_MIGRATION_LOCK_UNAVAILABLE', err.message);
    }
    if (err instanceof MigrationVerificationError) {
      throw new BootstrapError('BOOTSTRAP_MIGRATION_UNVERIFIED', err.message);
    }
    throw new BootstrapError('BOOTSTRAP_MIGRATION_FAILED', (err as Error).message);
  }
  steps.push(step('migrate', before === MIGRATION_VERSION ? 'ALREADY_CURRENT' : 'DONE'));

  const admin = new Client({ connectionString: db.adminDatabaseUrl });
  try {
    await admin.connect();
  } catch (err) {
    throw new BootstrapError('BOOTSTRAP_DATABASE_UNREACHABLE', (err as Error).message);
  }

  try {
    // 2. Runtime credential ----------------------------------------------------------------------------
    const credential = db.singleRole ? null : parseRuntimeCredential(db.databaseUrl);
    const managed = credential !== null
      && credential.user === RUNTIME_ROLE_NAME
      && credential.password !== null
      && credential.password.length >= RUNTIME_PASSWORD_MIN_LENGTH;
    if (managed) {
      try {
        await admin.query('SELECT set_app_role_password($1)', [credential!.password]);
      } catch (err) {
        throw new BootstrapError('BOOTSTRAP_RUNTIME_CREDENTIAL_FAILED', (err as Error).message);
      }
      steps.push(step('runtime-credential', 'DONE'));
    } else {
      steps.push(step('runtime-credential', 'SKIPPED'));
    }

    // 3. Completion secret -----------------------------------------------------------------------------
    if (custodian.mode === 'sidecar') {
      // The app/ops containers genuinely do not hold it in this mode. Setting it here would mean this
      // container had the secret, which is the property sidecar mode exists to remove.
      steps.push(step('completion-secret', 'SKIPPED'));
    } else {
      let secret: string;
      try {
        secret = requireAppHeldCompletionSecret(custodian, 'ops:bootstrap');
      } catch (err) {
        // A custodian mode that should hold the secret and does not is a CONFIGURATION fault, not a database
        // one, and saying so sends the operator to the secret file rather than to PostgreSQL.
        throw new BootstrapError('BOOTSTRAP_CONFIG_INVALID', (err as Error).message);
      }
      let current: string | undefined;
      try {
        current = (await admin.query<{ completion_secret: string | null }>(
          'SELECT completion_secret FROM public.crypto_config WHERE id = 1')).rows[0]?.completion_secret ?? undefined;
        if (current !== secret) await admin.query('SELECT set_completion_secret($1)', [secret]);
      } catch (err) {
        throw new BootstrapError('BOOTSTRAP_COMPLETION_SECRET_FAILED', (err as Error).message);
      }
      steps.push(step('completion-secret', current === secret ? 'ALREADY_CURRENT' : 'DONE'));
    }
  } finally {
    await admin.end().catch(() => undefined);
  }

  // 4. Prove the runtime connection actually works ------------------------------------------------------
  //
  // This is the step that would have caught the v1.1.0 first run. Everything above ran as the OWNER, and an
  // owner connection succeeding says nothing about whether the least-privileged role the app will actually
  // use can connect and read the schema version. Asserting it here means a green `migrate` container is
  // evidence that the app container will work, not a hope.
  let runtimeVersion: number | null;
  try {
    runtimeVersion = await readRuntimeSchemaVersion(db.databaseUrl);
  } catch (err) {
    throw new BootstrapError('BOOTSTRAP_RUNTIME_ROLE_UNUSABLE', (err as Error).message);
  }
  if (runtimeVersion !== MIGRATION_VERSION) {
    throw new BootstrapError('BOOTSTRAP_RUNTIME_ROLE_UNUSABLE',
      `the runtime connection reports schema version ${runtimeVersion === null ? 'none' : runtimeVersion}, but this build requires ${MIGRATION_VERSION}`);
  }
  steps.push(step('runtime-verify', 'DONE'));

  return { ok: true, report: 'phase-253-bootstrap', schemaVersion: MIGRATION_VERSION, steps };
}

/** The recorded version before migrating, so a no-op run can say so. `null` when there is nothing to read. */
async function readSchemaVersion(connectionString: string): Promise<number | null> {
  const client = new Client({ connectionString });
  try {
    await client.connect();
  } catch (err) {
    throw new BootstrapError('BOOTSTRAP_DATABASE_UNREACHABLE', (err as Error).message);
  }
  try {
    const rows = await client.query<{ version: number }>('SELECT version FROM public.schema_meta WHERE id = 1');
    return rows.rows[0]?.version ?? null;
  } catch {
    return null; // no schema_meta yet: a first run, which is the normal case here
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The applied version as the RUNTIME role sees it, through the owner-defined reader granted to it. */
async function readRuntimeSchemaVersion(connectionString: string): Promise<number | null> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  await client.connect();
  try {
    const rows = await client.query<{ version: number | null }>('SELECT public.cat_schema_version() AS version');
    return rows.rows[0]?.version ?? null;
  } finally {
    await client.end().catch(() => undefined);
  }
}
