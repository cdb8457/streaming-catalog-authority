import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CatalogAuthority } from '../core/catalog/authority.js';
import { createCustodian, loadCustodianConfig } from '../core/crypto/custodian-factory.js';
import { closePool, getPool } from '../db/pool.js';
import {
  defaultLocalMediaLibraryRoot,
  runLocalMediaPipeline,
  type LocalMediaVisibilityClient,
  type LocalMediaVisibilityInput,
  type LocalMediaVisibilityResult,
} from './local-media-pipeline.js';

function usage(): string {
  return [
    'usage: ops:local-media-pipeline --out <evidence.json> --item-id <uuid> --title <title> --source-file <path> [--year <year>] [--library-root <path>] [--ref-type <type> --ref-value <value>] [--await-jellyfin]',
    '',
    'Local media pipeline only: no providers, downloads, scraping, playback, Jellyfin writes, or real-library paths.',
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
  const yearRaw = valueAfter(args, '--year');
  const libraryRoot = valueAfter(args, '--library-root') ?? defaultLocalMediaLibraryRoot();
  const refType = valueAfter(args, '--ref-type');
  const refValue = valueAfter(args, '--ref-value');
  const awaitJellyfin = args.includes('--await-jellyfin');
  const visibilityPollsRaw = valueAfter(args, '--visibility-polls');
  const visibilityPollMsRaw = valueAfter(args, '--visibility-poll-ms');
  if (!out || !itemId || !title || !sourceFile) {
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

  try {
    if ((refType && !refValue) || (!refType && refValue)) throw new Error('both --ref-type and --ref-value are required when either is provided');
    if (refType && refValue) {
      const auth = new CatalogAuthority(getPool(), createCustodian(loadCustodianConfig()));
      await auth.addItem(itemId, {
        title,
        ...(year !== undefined ? { year } : {}),
        providerRefs: [{ type: refType, value: refValue }],
      });
    }
    const report = await runLocalMediaPipeline({
      itemId,
      title,
      ...(year !== undefined ? { year } : {}),
      sourceFile,
      libraryRoot,
      awaitJellyfinVisibility: awaitJellyfin,
      ...(visibilityPolls !== undefined ? { visibilityPolls } : {}),
      ...(visibilityPollMs !== undefined ? { visibilityPollMs } : {}),
      ...(awaitJellyfin ? { visibilityClient: buildJellyfinVisibilityClient() } : {}),
    });
    const body = `${JSON.stringify(report, null, 2)}\n`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, body, { encoding: 'utf8', mode: 0o600 });
    console.log(JSON.stringify({
      report: 'phase-225-local-media-pipeline-capture',
      ok: report.ok,
      status: report.status,
      redactionSafe: true,
      outputFile: out,
      outputPathEchoed: true,
      evidenceDigest: report.evidenceDigest,
      lifecycleState: report.lifecycle.currentState,
      bytesWritten: Buffer.byteLength(body, 'utf8'),
    }, null, 2));
    return report.ok ? 0 : 1;
  } finally {
    await closePool();
  }
}

function buildJellyfinVisibilityClient(): LocalMediaVisibilityClient {
  const env = process.env;
  if (env.JELLYFIN_ENABLE_NETWORK !== 'true') throw new Error('JELLYFIN_ENABLE_NETWORK must be true for Jellyfin visibility');
  if (env.JELLYFIN_ALLOW_LIVE_PUBLISH === 'true') throw new Error('JELLYFIN_ALLOW_LIVE_PUBLISH must not be true');
  const baseUrl = env.JELLYFIN_BASE_URL;
  const keyFile = env.JELLYFIN_API_KEY_FILE;
  if (!baseUrl || !keyFile) throw new Error('JELLYFIN_BASE_URL and JELLYFIN_API_KEY_FILE are required');
  const apiKey = readFileSync(keyFile, 'utf8').trim();
  const triggerLibraryScan = env.JELLYFIN_TRIGGER_LIBRARY_SCAN === 'true';
  const client = new JellyfinPathVisibilityClient(baseUrl, apiKey, triggerLibraryScan);
  return client;
}

class JellyfinPathVisibilityClient implements LocalMediaVisibilityClient {
  private readonly baseUrl: string;
  private scanTriggered = false;
  constructor(baseUrl: string, private readonly apiKey: string, private readonly triggerLibraryScan: boolean) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async findVisibleItem(input: LocalMediaVisibilityInput): Promise<LocalMediaVisibilityResult> {
    if (this.triggerLibraryScan && !this.scanTriggered) {
      this.scanTriggered = true;
      const res = await fetch(`${this.baseUrl}/Library/Refresh`, { method: 'POST', headers: { 'X-Emby-Token': this.apiKey, Accept: 'application/json' } });
      if (!res.ok && res.status !== 204) throw new Error(`jellyfin scan trigger HTTP ${res.status}`);
    }
    for (let start = 0; start < 100_000; start += 500) {
      const url = new URL(`${this.baseUrl}/Items`);
      url.searchParams.set('Recursive', 'true');
      url.searchParams.set('IncludeItemTypes', 'Movie,Episode,Video');
      url.searchParams.set('Fields', 'Path,ProductionYear');
      url.searchParams.set('StartIndex', String(start));
      url.searchParams.set('Limit', '500');
      const res = await fetch(url, { headers: { 'X-Emby-Token': this.apiKey, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`jellyfin visibility HTTP ${res.status}`);
      const body = await res.json() as { Items?: Array<{ Id?: unknown; Name?: unknown; Path?: unknown; ProductionYear?: unknown }> };
      const items = Array.isArray(body.Items) ? body.Items : [];
      for (const item of items) {
        const id = typeof item.Id === 'string' ? item.Id : undefined;
        const path = typeof item.Path === 'string' ? item.Path : undefined;
        const name = typeof item.Name === 'string' ? item.Name : undefined;
        const year = typeof item.ProductionYear === 'number' ? item.ProductionYear : undefined;
        if (id && path && samePath(path, input.destinationPath)) return { visible: true, itemId: id, matchBasis: 'path' };
        if (id && name && name.toLowerCase() === input.title.toLowerCase() && input.year !== undefined && year === input.year) return { visible: true, itemId: id, matchBasis: 'title-year' };
        if (id && name && name.toLowerCase() === input.title.toLowerCase() && input.year === undefined) return { visible: true, itemId: id, matchBasis: 'title' };
      }
      if (items.length < 500) break;
    }
    return { visible: false };
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
  return norm(a) === norm(b) || norm(a).endsWith(`/${norm(b).split('/').slice(-3).join('/')}`);
}

main().then((code) => process.exit(code)).catch(async (err) => {
  await closePool();
  console.error((err as Error).message);
  process.exit(1);
});
