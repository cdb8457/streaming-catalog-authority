import { captureJellyfinLiveEvidence } from './jellyfin-live-evidence-capture.js';
import type { FetchLike } from '../core/adapters/jellyfin/transport.js';

function usage(): string {
  return [
    'usage: ops:jellyfin-live-evidence-capture --ref-type <type> --ref-value <value> --out <evidence.json>',
    '',
    'required env:',
    '  JELLYFIN_ENABLE_NETWORK=true',
    '  JELLYFIN_BASE_URL=http://<unraid-host>:8096',
    '  JELLYFIN_API_KEY_FILE=/mnt/user/appdata/catalog/secrets/jellyfin_api_key',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const refType = valueAfter(args, '--ref-type');
  const refValue = valueAfter(args, '--ref-value');
  const outFile = valueAfter(args, '--out');
  if (!refType || !refValue || !outFile) {
    console.error(usage());
    return 2;
  }

  const result = await captureJellyfinLiveEvidence({
    fetch: globalThis.fetch as unknown as FetchLike,
    ref: { type: refType, value: refValue },
    outFile,
  });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});

