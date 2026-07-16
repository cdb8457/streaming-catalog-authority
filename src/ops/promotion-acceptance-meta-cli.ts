import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAcceptanceMetaCheck } from './promotion-acceptance-meta.js';

// Offline acceptance meta-check CLI. Confirms every Phase 230 local op has a module, CLI, test, doc,
// scripts, gate inclusion, and boundary language. Never promotes, never touches the real Movies root,
// never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-acceptance-meta [--out <meta.json>]',
    '',
    'Local, non-live: emits a redaction-safe meta-check over every local op. Exit 0 = all complete, 1 = a gap.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
  const meta = buildAcceptanceMetaCheck(projectRoot);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-acceptance-meta-capture',
    ok: meta.ok,
    redactionSafe: true,
    opCount: meta.ops.length,
    incomplete: meta.incomplete,
    metaDigest: meta.metaDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return meta.ok ? 0 : 1;
}

process.exit(main());
