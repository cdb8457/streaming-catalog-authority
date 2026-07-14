import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { closePool } from '../db/pool.js';
import { runJellyfinLiveReadOnlyMapping } from './jellyfin-live-readonly-mapping.js';

function usage(): string {
  return [
    'usage: ops:jellyfin-live-readonly-mapping --out <evidence.json> [--limit <n>]',
    '',
    'required env:',
    '  JELLYFIN_ENABLE_NETWORK=true',
    '  JELLYFIN_BASE_URL=http://<unraid-host>:8096',
    '  JELLYFIN_API_KEY_FILE=<operator-secret-file>',
    '',
    'The command auto-selects active catalog items with encrypted provider refs.',
    'It emits only digests and counts; raw item IDs, provider refs, Jellyfin IDs, titles, and API keys are never printed.',
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
  if (!outFile) {
    console.error(usage());
    return 2;
  }
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limitRaw !== undefined && (!Number.isInteger(limit) || limit! <= 0)) {
    console.error('invalid --limit: expected a positive integer');
    return 2;
  }

  try {
    const report = await runJellyfinLiveReadOnlyMapping({
      ...(limit !== undefined ? { limit } : {}),
      fetch: globalThis.fetch,
    });
    const body = `${JSON.stringify(report, null, 2)}\n`;
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, body, { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify({
      report: 'phase-219-jellyfin-live-readonly-mapping-capture',
      ok: report.ok,
      redactionSafe: true,
      outputFile: outFile,
      outputPathEchoed: true,
      evidenceDigest: report.evidenceDigest,
      status: report.status,
      selectedCount: report.selection.selectedCount,
      dataPositiveMappingEvidence: report.dataPositiveMappingEvidence,
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
