import { randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';

/**
 * Test helper: install a per-run completion secret into the owner-only crypto_config row and
 * return it, so the test's custodian can be constructed with the SAME secret. This mirrors the
 * production wiring (operator sets the secret out-of-band in both the DB and the custodian);
 * application code never holds a shared constant.
 */
export async function installCompletionSecret(admin: Client): Promise<string> {
  const secret = `${randomUUID()}${randomUUID()}`;
  await admin.query('UPDATE crypto_config SET completion_secret = $1 WHERE id = 1', [secret]);
  return secret;
}

/** A fresh 32-byte KEK for the file custodian in tests. */
export function testKek(): Buffer {
  return randomBytes(32);
}
