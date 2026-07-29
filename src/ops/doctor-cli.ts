import { Client } from 'pg';
import { loadDbConfig, resolveAppEnv } from '../config/env.js';
import { loadCustodianConfig, createCustodian, requireAppHeldCompletionSecret } from '../core/crypto/custodian-factory.js';
import { probeSidecarHealth } from '../core/crypto/local-sidecar-runtime.js';
import { getPool, closePool } from '../db/pool.js';
import { runDoctor, formatDoctorReport, formatDoctorJson } from './doctor.js';

/**
 * Phase 5/6 — production self-check CLI.
 *
 *   tsx src/ops/doctor-cli.ts [--json]        (or: npm run ops:doctor -- --json)
 *
 * READ-ONLY. Loads + validates config (db + custodian, incl. the Phase 4 memory-in-prod guard),
 * connects, runs the checks, prints a redaction-safe report (text, or the stable JSON contract with
 * `--json`), and exits non-zero if any check FAILED. Safe on a schedule / before serving traffic;
 * the JSON form is the unattended Unraid/monitoring healthcheck contract. Prints no secret values.
 */
const asJson = process.argv.slice(2).includes('--json');
async function main(): Promise<number> {
  const db = loadDbConfig();
  const custodianConfig = loadCustodianConfig(); // throws (fail-closed) on bad/insecure config
  const custodian = createCustodian(custodianConfig);
  const admin = new Client({ connectionString: db.adminDatabaseUrl });
  await admin.connect();
  const pool = getPool();
  try {
    const report = await runDoctor({
      admin,
      pool,
      custodian,
      completionSecret: custodianConfig.mode === 'sidecar'
        ? undefined
        : requireAppHeldCompletionSecret(custodianConfig, 'ops:doctor'),
      custodianMode: custodianConfig.mode,
      appEnv: resolveAppEnv(),
      keystoreDir: custodianConfig.mode === 'file' ? custodianConfig.keystoreDir : undefined,
      // PHASE 283/284. THE ROTATION-AGE CHECK WAS DEAD CODE UNTIL THIS LINE. `runDoctor` has always been able
      // to report whether a KEK rotation is due, and nothing ever supplied the timestamp — so the check never
      // ran on any real deployment. It comes from the sidecar's own health handshake, which is the only
      // process that can open the ring: the app asks over the socket it already has and receives a NUMBER.
      // `undefined` on a deployment with no sidecar, or one whose sidecar does not answer, which leaves the
      // check silent rather than guessing an age.
      ringActiveCreatedAt: custodianConfig.mode === 'sidecar'
        ? (await probeSidecarHealth(custodianConfig.socketPath))?.ringActiveCreatedAt ?? undefined
        : undefined,
    });
    console.log(asJson ? formatDoctorJson(report) : formatDoctorReport(report));
    return report.ok ? 0 : 1;
  } finally {
    await admin.end();
    await closePool();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error('doctor failed:', (err as Error).message); process.exit(1); }); // message only
