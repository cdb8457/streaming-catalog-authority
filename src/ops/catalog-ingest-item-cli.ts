import { randomUUID, createHash } from 'node:crypto';
import { CatalogAuthority } from '../core/catalog/authority.js';
import { createCustodian, loadCustodianConfig } from '../core/crypto/custodian-factory.js';
import { closePool, getPool } from '../db/pool.js';

function usage(): string {
  return [
    'usage: ops:catalog-ingest-item --ref-type <type> --ref-value <value> [--item-id <uuid>] [--title <label>] [--year <year>]',
    '',
    'Creates one Catalog Authority item through CatalogAuthority.addItem().',
    'Output is redaction-safe: raw provider refs and titles are not echoed.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function digest(value: string): string {
  return createHash('sha256').update(`phase-220-ingest:${value}`).digest('hex').slice(0, 16);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const refType = valueAfter(args, '--ref-type');
  const refValue = valueAfter(args, '--ref-value');
  const itemId = valueAfter(args, '--item-id') ?? randomUUID();
  const title = valueAfter(args, '--title') ?? 'Catalog Authority Phase 220 validation item';
  const yearRaw = valueAfter(args, '--year');
  if (!refType || !refValue) {
    console.error(usage());
    return 2;
  }
  const year = yearRaw === undefined ? undefined : Number(yearRaw);
  if (yearRaw !== undefined && (!Number.isInteger(year) || year! < 0)) {
    console.error('invalid --year: expected a non-negative integer');
    return 2;
  }

  const custodian = createCustodian(loadCustodianConfig());
  const auth = new CatalogAuthority(getPool(), custodian);
  try {
    await auth.addItem(itemId, {
      title,
      ...(year !== undefined ? { year } : {}),
      providerRefs: [{ type: refType, value: refValue }],
    });
    console.log(JSON.stringify({
      report: 'phase-220-catalog-ingest-item',
      ok: true,
      redactionSafe: true,
      ingestionPath: 'CatalogAuthority.addItem',
      itemDigest: digest(itemId),
      itemIdEchoed: false,
      titleEchoed: false,
      providerRefValueEchoed: false,
      providerRefType: refType,
      encryptedProviderRefExpected: true,
    }, null, 2));
    return 0;
  } finally {
    await closePool();
  }
}

main().then((code) => process.exit(code)).catch(async (err) => {
  await closePool();
  console.error((err as Error).message);
  process.exit(1);
});
