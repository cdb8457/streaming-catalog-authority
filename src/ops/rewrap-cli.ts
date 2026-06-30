import { loadRewrapConfig } from '../core/crypto/custodian-factory.js';
import { FileCustodian } from '../core/crypto/file-custodian.js';

/**
 * Phase 4 Stage 4.2 — KEK rotation / rewrap CLI (one-shot).
 *
 *   tsx src/ops/rewrap-cli.ts        (or: npm run ops:rewrap-kek)
 *
 * Re-wraps every live wrapped DEK in CUSTODIAN_KEYSTORE_DIR from CUSTODIAN_KEK_PREVIOUS (old) to
 * CUSTODIAN_KEK (new). Identity ciphertext is untouched. Resumable + idempotent (safe to re-run).
 * Run with the app quiesced (FileCustodian is single-writer). The operator decrypts both KEKs
 * (age) before mounting them via *_FILE. Prints counts only — never key material.
 *
 * After a successful rewrap, remove CUSTODIAN_KEK_PREVIOUS from the runtime config: normal
 * operation uses only the new CUSTODIAN_KEK.
 */
function main(): void {
  const { keystoreDir, fromKek, toKek } = loadRewrapConfig();
  const res = FileCustodian.rewrapKeystore(keystoreDir, { fromKek, toKek });
  fromKek.fill(0);
  toKek.fill(0);
  console.log(`KEK rewrap complete: ${res.rewrapped} rewrapped, ${res.skipped} already on the new KEK, ${res.total} total.`);
}

try {
  main();
} catch (err) {
  console.error('KEK rewrap failed:', (err as Error).message); // message only — no key material
  process.exit(1);
}
