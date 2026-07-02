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
 *
 * Preflight only:
 *   npm run ops:rewrap-kek -- --plan
 *   npm run ops:rewrap-kek -- --plan --json
 */
interface CliArgs {
  plan: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { plan: false, json: false };
  for (const arg of argv) {
    if (arg === '--plan') out.plan = true;
    else if (arg === '--json') out.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { keystoreDir, fromKek, toKek } = loadRewrapConfig();
  try {
    if (args.plan) {
      const res = FileCustodian.planRewrapKeystore(keystoreDir, { fromKek, toKek });
      if (args.json) {
        console.log(JSON.stringify({ mode: 'plan', mutates: false, status: 'ready', ...res }));
      } else {
        console.log(`KEK rewrap plan: ${res.needsRewrap} need rewrap, ${res.alreadyCurrent} already on the new KEK, ${res.total} total. No files changed.`);
      }
      return;
    }

    const res = FileCustodian.rewrapKeystore(keystoreDir, { fromKek, toKek });
    if (args.json) {
      console.log(JSON.stringify({ mode: 'apply', mutates: true, status: 'complete', rewrapped: res.rewrapped, alreadyCurrent: res.skipped, total: res.total }));
    } else {
      console.log(`KEK rewrap complete: ${res.rewrapped} rewrapped, ${res.skipped} already on the new KEK, ${res.total} total.`);
    }
  } finally {
    fromKek.fill(0);
    toKek.fill(0);
  }
}

try {
  main();
} catch (err) {
  console.error('KEK rewrap failed:', (err as Error).message); // message only — no key material
  process.exit(1);
}
