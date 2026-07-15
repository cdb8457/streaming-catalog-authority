import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  defaultRealMoviesRoot,
  realLibraryPathMatch,
  runRealLibraryPromotion,
  type RealLibraryVisibilityClient,
  type RealLibraryVisibilityInput,
  type RealLibraryVisibilityResult,
} from './real-library-promotion.js';

function usage(): string {
  return [
    'usage: ops:real-library-promotion --out <evidence.json> --item-id <uuid> --title <title> --source-file <path> --approval-id <id> [--year <year>] [--test-library-root <path>] [--target-root <path>] [--await-jellyfin] [--withdraw-after]',
    '',
    'Real-library promotion only: requires PROMOTION_APPROVED=true, targets /mnt/user/media/Movies, no providers, downloads, scraping, playback, Gelato/AIO, or Jellyfin writes.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const out = valueAfter(args, '--out');
  const itemId = valueAfter(args, '--item-id');
  const title = valueAfter(args, '--title');
  const sourceFile = valueAfter(args, '--source-file');
  const approvalId = valueAfter(args, '--approval-id');
  const yearRaw = valueAfter(args, '--year');
  const testLibraryRoot = valueAfter(args, '--test-library-root') ?? '/mnt/user/media/catalog-authority-test-library';
  const targetRoot = valueAfter(args, '--target-root') ?? defaultRealMoviesRoot();
  const awaitJellyfin = args.includes('--await-jellyfin');
  const withdrawAfter = args.includes('--withdraw-after');
  const visibilityPollsRaw = valueAfter(args, '--visibility-polls');
  const visibilityPollMsRaw = valueAfter(args, '--visibility-poll-ms');
  if (!out || !itemId || !title || !sourceFile || !approvalId) {
    console.error(usage());
    return 2;
  }
  const year = yearRaw === undefined ? undefined : Number(yearRaw);
  if (yearRaw !== undefined && (!Number.isInteger(year) || year! < 0)) {
    console.error('invalid --year: expected a non-negative integer');
    return 2;
  }
  const visibilityPolls = visibilityPollsRaw === undefined ? undefined : Number(visibilityPollsRaw);
  const visibilityPollMs = visibilityPollMsRaw === undefined ? undefined : Number(visibilityPollMsRaw);
  const report = await runRealLibraryPromotion({
    itemId,
    title,
    ...(year !== undefined ? { year } : {}),
    sourceFile,
    testLibraryRoot,
    targetRoot,
    approval: {
      approved: process.env.PROMOTION_APPROVED === 'true',
      approvalId,
    },
    awaitVisibility: awaitJellyfin,
    withdrawAfter,
    ...(visibilityPolls !== undefined ? { visibilityPolls } : {}),
    ...(visibilityPollMs !== undefined ? { visibilityPollMs } : {}),
    ...(awaitJellyfin ? { visibilityClient: buildJellyfinVisibilityClient() } : {}),
  });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body, { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify({
    report: 'phase-230-real-library-promotion-capture',
    ok: report.ok,
    status: report.status,
    redactionSafe: true,
    outputFile: out,
    outputPathEchoed: true,
    evidenceDigest: report.evidenceDigest,
    lifecycleState: report.lifecycle.currentState,
    withdrawn: report.file.withdrawn,
    returnedToBefore: report.realLibrary.returnedToBefore ?? false,
    bytesWritten: Buffer.byteLength(body, 'utf8'),
  }, null, 2));
  return report.ok ? 0 : 1;
}

function buildJellyfinVisibilityClient(): RealLibraryVisibilityClient {
  const env = process.env;
  if (env.JELLYFIN_ENABLE_NETWORK !== 'true') throw new Error('JELLYFIN_ENABLE_NETWORK must be true for Jellyfin visibility');
  if (env.JELLYFIN_ALLOW_LIVE_PUBLISH === 'true') throw new Error('JELLYFIN_ALLOW_LIVE_PUBLISH must not be true');
  const baseUrl = env.JELLYFIN_BASE_URL;
  const keyFile = env.JELLYFIN_API_KEY_FILE;
  if (!baseUrl || !keyFile) throw new Error('JELLYFIN_BASE_URL and JELLYFIN_API_KEY_FILE are required');
  const apiKey = readFileSync(keyFile, 'utf8').trim();
  const triggerLibraryScan = env.JELLYFIN_TRIGGER_LIBRARY_SCAN === 'true';
  return new JellyfinPathVisibilityClient(baseUrl, apiKey, triggerLibraryScan);
}

class JellyfinPathVisibilityClient implements RealLibraryVisibilityClient {
  private readonly baseUrl: string;
  private scanCount = 0;
  constructor(baseUrl: string, private readonly apiKey: string, private readonly triggerLibraryScan: boolean) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async findVisibleItem(input: RealLibraryVisibilityInput): Promise<RealLibraryVisibilityResult> {
    if (this.triggerLibraryScan) {
      this.scanCount += 1;
      const res = await fetch(`${this.baseUrl}/Library/Refresh`, { method: 'POST', headers: { 'X-Emby-Token': this.apiKey, Accept: 'application/json' } });
      if (!res.ok && res.status !== 204) throw new Error(`jellyfin scan trigger HTTP ${res.status}`);
    }
    for (let start = 0; start < 100_000; start += 500) {
      const url = new URL(`${this.baseUrl}/Items`);
      url.searchParams.set('Recursive', 'true');
      url.searchParams.set('IncludeItemTypes', 'Movie,Episode,Video');
      url.searchParams.set('Fields', 'Path');
      url.searchParams.set('StartIndex', String(start));
      url.searchParams.set('Limit', '500');
      const res = await fetch(url, { headers: { 'X-Emby-Token': this.apiKey, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`jellyfin visibility HTTP ${res.status}`);
      const body = await res.json() as { Items?: Array<{ Id?: unknown; Path?: unknown }> };
      const items = Array.isArray(body.Items) ? body.Items : [];
      for (const item of items) {
        const id = typeof item.Id === 'string' ? item.Id : undefined;
        const path = typeof item.Path === 'string' ? item.Path : undefined;
        // Exact promoted-path match only. Title/year are not consulted: a same-title
        // test-library twin must not satisfy real-library visibility or mask absence.
        if (id && path && realLibraryPathMatch(path, input.destinationPath)) return { visible: true, itemId: id, matchBasis: 'path' };
      }
      if (items.length < 500) break;
    }
    return { visible: false };
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
