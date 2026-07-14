import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { closePool } from '../db/pool.js';
import { runJellyfinWriteProof } from './jellyfin-write-proof.js';

function usage(): string {
  return [
    'usage: ops:jellyfin-write-proof --out <evidence.json> --confirm-disposable-write [--limit <n>]',
    '',
    'required env:',
    '  JELLYFIN_ENABLE_NETWORK=true',
    '  JELLYFIN_ALLOW_LIVE_PUBLISH=true',
    '  JELLYFIN_BASE_URL=http://<existing-jellyfin>:8096',
    '  JELLYFIN_API_KEY_FILE=<operator-secret-file>',
    '',
    'This is the Phase 221 rung-3 command. It may only create one test-owned collection,',
    'add existing library items by reference, remove them, delete the collection, and verify absence.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const outFile = valueAfter(args, '--out');
  const limitRaw = valueAfter(args, '--limit');
  const confirmed = args.includes('--confirm-disposable-write');
  if (!outFile || !confirmed) {
    console.error(usage());
    return 2;
  }
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limitRaw !== undefined && (!Number.isInteger(limit) || limit! <= 0)) {
    console.error('invalid --limit: expected a positive integer');
    return 2;
  }

  try {
    const report = await runJellyfinWriteProof({
      ...(limit !== undefined ? { limit } : {}),
      fetch: globalThis.fetch,
    });
    const body = `${JSON.stringify(report, null, 2)}\n`;
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, body, { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify({
      report: 'phase-221-jellyfin-write-proof-capture',
      ok: report.ok,
      status: report.status,
      redactionSafe: true,
      outputFile: outFile,
      outputPathEchoed: true,
      evidenceDigest: report.evidenceDigest,
      selectedCatalogItems: report.selection.selectedCatalogItems,
      mappedJellyfinItems: report.selection.mappedJellyfinItemDigests.length,
      cleanupSuccess: report.cleanup.success,
      libraryStateUnchanged: report.libraryState.unchanged,
      finalResidueCount: report.collection.finalResidueCount,
      bytesWritten: Buffer.byteLength(body, 'utf8'),
    }, null, 2));
    return report.ok ? 0 : 1;
  } finally {
    await closePool();
  }
}

main().then((code) => process.exit(code)).catch(async (err) => {
  await closePool();
  console.error((err as Error).message);
  process.exit(1);
});
