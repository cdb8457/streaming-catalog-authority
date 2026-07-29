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
      // PHASE 292. ONE HANDSHAKE, AND THE WHOLE OF IT GOES IN.
      //
      // This used to take a single NUMBER out of the health answer — the active generation's creation time —
      // and throw the rest away, which is why the doctor could say a rotation was due and could not say
      // whether the custodian was running a ring at all. The structured result is passed instead, so every
      // custody check in the report comes from the same answer and none of them can disagree with another.
      //
      // `probeSidecarHealth` already validates against the strict schema and answers `null` for unreachable,
      // not-ready and malformed alike. In sidecar mode the probe is ALWAYS attempted: a missing probe is a
      // FAIL in the report rather than a check that quietly does not appear.
      sidecarCustody: custodianConfig.mode === 'sidecar'
        ? { attempted: true, health: await probeSidecarHealth(custodianConfig.socketPath) }
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
