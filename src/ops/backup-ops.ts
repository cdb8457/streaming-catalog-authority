import type { Client } from 'pg';
import type { KeyCustodian } from '../core/crypto/custodian.js';
import { BackupPolicy, BackupIntegrityError, type BackupArtifact } from '../core/backup/backup-policy.js';

export type { BackupArtifact } from '../core/backup/backup-policy.js';

/**
 * Phase 3 Stage 3.3 — backup/restore operational guardrails.
 *
 * Thin orchestration around the existing {@link BackupPolicy} (which already does the
 * snapshot-consistent dump and the replay-and-compare restore integrity gate). This adds the
 * OPERATOR-facing safety rails: a restore PREFLIGHT that refuses to proceed unless the inputs a
 * healthy restore needs are present and consistent, and a clear surfacing of the integrity gate.
 *
 * Redaction: every problem string references conditions/var names only — never secret VALUES
 * (completion secret, KEK), matching the Stage 3.1 guarantee.
 *
 * Scope: CLI/library only. No HTTP. No artifact encryption (operator-owned). Age KEK is an
 * operator-side wrapping concern — by the time these run, the KEK/secret arrive through the
 * existing `*_FILE` config, already decrypted/provisioned by the operator.
 */

export type CheckState = 'pass' | 'fail' | 'skip';

export interface PreflightResult {
  ok: boolean;
  problems: string[];
  checks: Record<'db' | 'custodian' | 'completionSecret', CheckState>;
}

/** Raised when a restore is refused (preflight failure or the integrity gate). Non-destructive. */
export class RestoreRefused extends Error {
  readonly preflight?: PreflightResult;
  readonly integrity: boolean;
  constructor(message: string, opts: { preflight?: PreflightResult; integrity?: boolean } = {}) {
    super(message);
    this.name = 'RestoreRefused';
    this.preflight = opts.preflight;
    this.integrity = opts.integrity ?? false;
  }
}

/**
 * Verify the inputs a healthy restore needs:
 *  - DB reachable on the owner connection;
 *  - key custodian reachable (a status probe returns a definite value, not a thrown transport
 *    error) — otherwise the restored system would be permanently fail-closed;
 *  - the configured completion secret MATCHES the DB's `crypto_config` (owner-only), without
 *    which shred completion / self-heal could never verify after restore.
 * Returns all problems at once; never throws for an expected check failure.
 */
export async function restorePreflight(deps: {
  admin: Client;
  custodian: KeyCustodian;
  completionSecret: string;
}): Promise<PreflightResult> {
  const problems: string[] = [];
  const checks: PreflightResult['checks'] = { db: 'fail', custodian: 'fail', completionSecret: 'skip' };

  // 1. DB reachable (owner connection).
  let dbOk = false;
  try {
    await deps.admin.query('SELECT 1');
    checks.db = 'pass';
    dbOk = true;
  } catch {
    problems.push('database is not reachable on the owner/admin connection');
  }

  // 2. Custodian reachable — transport failure is a THROWN error per the contract.
  try {
    await deps.custodian.status('preflight-liveness-probe');
    checks.custodian = 'pass';
  } catch {
    problems.push('key custodian is not reachable (status probe failed) — restore would be fail-closed');
  }

  // 3. Completion secret must match the DB, else attested shred completion can never verify.
  if (dbOk) {
    try {
      const { rows } = await deps.admin.query('SELECT completion_secret FROM crypto_config WHERE id = 1');
      const dbSecret = rows[0]?.completion_secret as string | undefined;
      if (!dbSecret) {
        checks.completionSecret = 'fail';
        problems.push('crypto_config has no completion secret provisioned (set it out-of-band before restore)');
      } else if (dbSecret !== deps.completionSecret) {
        checks.completionSecret = 'fail';
        problems.push('configured completion secret does not match crypto_config (shred completion would never verify)');
      } else {
        checks.completionSecret = 'pass';
      }
    } catch {
      checks.completionSecret = 'fail';
      problems.push('could not read crypto_config to verify the completion secret (owner connection required)');
    }
  }

  return { ok: problems.length === 0, problems, checks };
}

/** Produce a ciphertext-only backup artifact (owner connection). Custodian not required. */
export async function runDump(deps: { admin: Client; label?: string }): Promise<BackupArtifact> {
  return BackupPolicy.dump(deps.admin, deps.label);
}

/**
 * Guarded restore: preflight first, then {@link BackupPolicy.restore} (which runs the
 * replay-and-compare integrity gate and rolls back on mismatch). Refuses — never half-applies —
 * on a preflight failure or an integrity violation.
 */
export async function runRestore(deps: {
  admin: Client;
  custodian: KeyCustodian;
  completionSecret: string;
  artifact: BackupArtifact;
}): Promise<{ restored: true; preflight: PreflightResult }> {
  const preflight = await restorePreflight(deps);
  if (!preflight.ok) {
    throw new RestoreRefused(`restore refused — preflight failed:\n  - ${preflight.problems.join('\n  - ')}`, { preflight });
  }
  try {
    await BackupPolicy.restore(deps.admin, deps.artifact);
  } catch (err) {
    if (err instanceof BackupIntegrityError) {
      throw new RestoreRefused(`restore refused — integrity gate: ${err.message}`, { integrity: true });
    }
    throw err;
  }
  return { restored: true, preflight };
}

export interface BackupArgs {
  command: 'dump' | 'restore';
  file: string;
  label?: string;
}

/** Parse `dump <file> [label]` / `restore <file>`. Throws on an unknown/incomplete invocation. */
export function parseBackupArgs(argv: readonly string[]): BackupArgs {
  const [command, file, label] = argv;
  if (command !== 'dump' && command !== 'restore') {
    throw new Error(`unknown command "${String(command)}" (expected: dump <file> [label] | restore <file>)`);
  }
  if (!file) throw new Error(`${command} requires a file path`);
  return label !== undefined ? { command, file, label } : { command, file };
}
