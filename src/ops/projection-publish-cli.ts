import { statSync } from 'node:fs';

import { deriveProjectedEntryId, normalizeProjectedPath } from '../core/projection/manifest-v1.js';
import {
  publishGeneration, publishStatus, PublishFaultInjected,
  type PublishFault, type PublishReport,
} from '../core/projection/publish-service.js';

// The production manifest publisher.
//
//   npm run ops:projection-publish -- --manifest-dir /var/lib/projectiond/manifest
//   npm run ops:projection-publish -- --manifest-dir <dir> --status
//   npm run ops:projection-publish -- --manifest-dir <dir> --intent deletion --delete "Movies/A/A.bin" \
//                                     [--acknowledge-deletion-guard]
//
// EXIT CODES ARE THE INTERFACE, because an operator's script reads them and a human reads the JSON.
//   0  published | unchanged | recovered | resumed — the directory and the database agree and a daemon can
//      serve what is there.
//   3  refused — the snapshot cannot produce an admissible generation. NOTHING CHANGED, and the daemon goes
//      on serving what it already admitted.
//   4  concurrent-publisher — another publisher holds the lock. Not an error; try again.
//   1  anything else, including a deliberately injected fault.
//
// `--fault` STOPS A RUN AT A NAMED BOUNDARY. It exists for the gates that prove a crash at each of them is
// survivable, and it is safe to ship: every stage it can stop at is one the design already claims is
// recoverable, so the switch can only demonstrate the property. It skips no durability step and writes nothing
// different — it is the real sequence, halted.

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const exact = argv.indexOf(`--${name}`);
  if (exact !== -1) return argv[exact + 1];
  const inline = argv.find((token) => token.startsWith(`--${name}=`));
  return inline === undefined ? undefined : inline.slice(name.length + 3);
}

function flags(name: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === `--${name}`) {
      const value = argv[++index];
      if (value !== undefined) out.push(value);
    } else if (token.startsWith(`--${name}=`)) out.push(token.slice(name.length + 3));
  }
  return out;
}

function fail(message: string): never {
  console.error(`projection-publish: ${message}`);
  process.exit(2);
}

function requireManifestDir(): string {
  const dir = flag('manifest-dir');
  if (dir === undefined) fail('--manifest-dir is required');
  try {
    if (!statSync(dir).isDirectory()) fail('--manifest-dir must name a directory');
  } catch {
    fail('--manifest-dir must name a directory that exists');
  }
  return dir;
}

const manifestDir = requireManifestDir();

/** A deletion may be named by its projected entry id, or by the path it was derived from. */
function deletionId(raw: string): string {
  if (/^pe_[0-9a-f]{64}$/.test(raw)) return raw;
  const path = normalizeProjectedPath(raw);
  if (!path.ok) fail('a deletion names a projected entry id or a normalized path');
  return deriveProjectedEntryId(path.path as string);
}

async function main(): Promise<void> {
  if (argv.includes('--status')) {
    const status = await publishStatus({ manifestDir });
    console.log(JSON.stringify(status, null, 2));
    process.exit(status.agrees || status.dbSequence === null ? 0 : 3);
  }

  const deletions = flags('delete').map(deletionId);
  const intentFlag = flag('intent') ?? (deletions.length > 0 ? 'deletion' : 'routine');
  if (intentFlag !== 'routine' && intentFlag !== 'deletion') fail('--intent is routine or deletion');

  const nowFlag = flag('now');
  if (nowFlag !== undefined && Number.isNaN(Date.parse(nowFlag))) fail('--now must be an ISO timestamp');

  const faultFlag = flag('fault');
  if (faultFlag !== undefined
    && !['after-prepare', 'after-artifact', 'after-db-pointer'].includes(faultFlag)) {
    fail('--fault is after-prepare, after-artifact or after-db-pointer');
  }

  const report: PublishReport = await publishGeneration({
    manifestDir,
    intent: intentFlag,
    deletions,
    deletionGuardAcknowledged: argv.includes('--acknowledge-deletion-guard'),
    now: nowFlag === undefined ? undefined : () => new Date(nowFlag),
    fault: faultFlag as PublishFault | undefined,
  });

  console.log(JSON.stringify(report, null, 2));
  if (report.outcome === 'refused') process.exit(3);
  if (report.outcome === 'concurrent-publisher') process.exit(4);
  process.exit(0);
}

main().catch((error: unknown) => {
  if (error instanceof PublishFaultInjected) {
    // The whole point: the process dies here, and the next run has to be able to finish what it started.
    console.error(`projection-publish: ${error.message}`);
    process.exit(1);
  }
  console.error(`projection-publish: ${(error as Error).message}`);
  process.exit(1);
});
