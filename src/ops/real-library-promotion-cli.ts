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
    'usage: ops:real-library-promotion --out <evidence.json> --item-id <uuid> --title <title> --source-file <path> --approval-file <approval.json> [--approval-id <id>] [--year <year>] [--test-library-root <path>] [--target-root <path>] [--withdraw-after]',
    '',
    'Real-library promotion only: requires PROMOTION_APPROVED=true and an approval file that binds itemId, targetRoot, sourceRealPath, sourceSha256, and destinationPath. Read-only observed Jellyfin visibility is mandatory. No providers, downloads, scraping, playback, Gelato/AIO, or Jellyfin writes (no scan/refresh trigger).',
  ].join('\n');
}

interface ApprovalFile {
  readonly approvalId?: string;
  readonly itemId?: string;
  readonly targetRoot?: string;
  readonly sourceRealPath?: string;
  readonly sourceSha256?: string;
  readonly destinationPath?: string;
}

function readApprovalFile(path: string): ApprovalFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('approval file must be a JSON object');
  return parsed as ApprovalFile;
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
  const approvalFile = valueAfter(args, '--approval-file');
  const yearRaw = valueAfter(args, '--year');
  const testLibraryRoot = valueAfter(args, '--test-library-root') ?? '/mnt/user/media/catalog-authority-test-library';
  const targetRoot = valueAfter(args, '--target-root') ?? defaultRealMoviesRoot();
  const withdrawAfter = args.includes('--withdraw-after');
  const visibilityPollsRaw = valueAfter(args, '--visibility-polls');
  const visibilityPollMsRaw = valueAfter(args, '--visibility-poll-ms');
  if (!out || !itemId || !title || !sourceFile || !approvalFile) {
    console.error(usage());
    return 2;
  }
  const year = yearRaw === undefined ? undefined : Number(yearRaw);
  if (yearRaw !== undefined && (!Number.isInteger(year) || year! < 0)) {
    console.error('invalid --year: expected a non-negative integer');
    return 2;
  }
  const approvalRecord = readApprovalFile(approvalFile);
  const approvalId = valueAfter(args, '--approval-id') ?? approvalRecord.approvalId;
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
      ...(approvalId !== undefined ? { approvalId } : {}),
      ...(approvalRecord.itemId !== undefined ? { itemId: approvalRecord.itemId } : {}),
      ...(approvalRecord.targetRoot !== undefined ? { targetRoot: approvalRecord.targetRoot } : {}),
      ...(approvalRecord.sourceRealPath !== undefined ? { sourceRealPath: approvalRecord.sourceRealPath } : {}),
      ...(approvalRecord.sourceSha256 !== undefined ? { sourceSha256: approvalRecord.sourceSha256 } : {}),
      ...(approvalRecord.destinationPath !== undefined ? { destinationPath: approvalRecord.destinationPath } : {}),
    },
    withdrawAfter,
    ...(visibilityPolls !== undefined ? { visibilityPolls } : {}),
    ...(visibilityPollMs !== undefined ? { visibilityPollMs } : {}),
    // Read-only observed Jellyfin visibility is mandatory for real-library promotion.
    visibilityClient: buildJellyfinVisibilityClient(),
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
  return new JellyfinPathVisibilityClient(baseUrl, apiKey);
}

// Strictly read-only: this client issues GET /Items only. It never triggers a library
// scan/refresh or any other Jellyfin write — promotion must not mutate the media server.
class JellyfinPathVisibilityClient implements RealLibraryVisibilityClient {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async findVisibleItem(input: RealLibraryVisibilityInput): Promise<RealLibraryVisibilityResult> {
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
