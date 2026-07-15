import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildJellyfinTestLibraryPreflight,
  EXPECTED_TEST_LIBRARY_CONTAINER_PATH,
  EXPECTED_TEST_LIBRARY_HOST_PATH,
} from './jellyfin-test-library-preflight.js';

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function usage(): string {
  return [
    'usage: ops:jellyfin-test-library-preflight --out <evidence.json>',
    '',
    'required env:',
    '  JELLYFIN_ENABLE_NETWORK=true',
    '  JELLYFIN_BASE_URL=http://<jellyfin-host>:8096',
    '  JELLYFIN_API_KEY_FILE=<operator-secret-file>',
    '',
    'optional env:',
    '  JELLYFIN_MOUNT_DESTINATIONS=/media/catalog-authority-test-library[:...]',
    '  CATALOG_AUTHORITY_TEST_LIBRARY_HOST_PATH=/mnt/user/media/catalog-authority-test-library',
  ].join('\n');
}

async function main(): Promise<number> {
  const out = valueAfter(process.argv.slice(2), '--out');
  if (!out) {
    console.error(usage());
    return 2;
  }
  if (process.env.JELLYFIN_ENABLE_NETWORK !== 'true') throw new Error('JELLYFIN_ENABLE_NETWORK must be true');
  if (process.env.JELLYFIN_ALLOW_LIVE_PUBLISH === 'true') throw new Error('JELLYFIN_ALLOW_LIVE_PUBLISH must not be true');
  const baseUrl = process.env.JELLYFIN_BASE_URL;
  const keyFile = process.env.JELLYFIN_API_KEY_FILE;
  if (!baseUrl || !keyFile) throw new Error('JELLYFIN_BASE_URL and JELLYFIN_API_KEY_FILE are required');
  const apiKey = (await import('node:fs')).readFileSync(keyFile, 'utf8').trim();
  const virtualFolders = await getJson(baseUrl, apiKey, '/Library/VirtualFolders');
  const mountDestinations = (process.env.JELLYFIN_MOUNT_DESTINATIONS ?? '')
    .split(':')
    .map((value) => value.trim())
    .filter(Boolean);
  const hostPath = process.env.CATALOG_AUTHORITY_TEST_LIBRARY_HOST_PATH ?? EXPECTED_TEST_LIBRARY_HOST_PATH;
  const report = buildJellyfinTestLibraryPreflight({
    hostFolderExists: existsSync(hostPath),
    mountDestinations,
    virtualFolders: Array.isArray(virtualFolders) ? virtualFolders : [],
    itemCount: undefined,
  });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body, { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify({
    report: 'phase-226-jellyfin-test-library-preflight-capture',
    ok: report.ok,
    redactionSafe: true,
    outputFile: out,
    expectedContainerPath: EXPECTED_TEST_LIBRARY_CONTAINER_PATH,
    evidenceBytes: Buffer.byteLength(body, 'utf8'),
  }, null, 2));
  return report.ok ? 0 : 1;
}

async function getJson(baseUrl: string, apiKey: string, path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    headers: { 'X-Emby-Token': apiKey, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jellyfin preflight GET ${path} HTTP ${res.status}`);
  return await res.json();
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});

