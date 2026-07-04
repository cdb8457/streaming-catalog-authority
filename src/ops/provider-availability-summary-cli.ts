import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { summarizeProviderAvailability } from '../core/adapters/provider-availability-summary.js';

const MAX_REPORT_BYTES = 64 * 1024;

type ReadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly report: unknown };

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ops:provider-availability-summary -- <bridge-report.json>... [--json]');
    return 0;
  }

  const normalized = args.filter((arg) => arg !== '--');
  const asJson = normalized.includes('--json');
  const unsupported = normalized.filter((arg) => arg.startsWith('-') && arg !== '--json');
  const paths = normalized.filter((arg) => !arg.startsWith('-'));
  if (unsupported.length > 0 || paths.length === 0) {
    console.error('usage: ops:provider-availability-summary -- <bridge-report.json>... [--json]');
    return 2;
  }

  const reports: unknown[] = [];
  for (const path of paths) {
    const result = readJsonFile(path);
    reports.push(result.ok ? result.value : result.report);
  }

  const summary = summarizeProviderAvailability(reports);
  process.stdout.write(asJson ? `${JSON.stringify(summary, null, 2)}\n` : formatText(summary));
  return summary.counts.hold > 0 ? 1 : 0;
}

function readJsonFile(path: string): ReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, report: invalidBridgeReport() };
    if (stat.size > MAX_REPORT_BYTES) return { ok: false, report: invalidBridgeReport() };

    const buffer = Buffer.alloc(stat.size);
    const bytesRead = readSync(fd, buffer, 0, stat.size, 0);
    const text = stripBom(buffer.subarray(0, bytesRead).toString('utf8'));
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, report: invalidBridgeReport() };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Output remains fixed and redaction-safe.
      }
    }
  }
}

function invalidBridgeReport(): unknown {
  return { decision: { status: 'invalid', action: 'hold' } };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function formatText(summary: ReturnType<typeof summarizeProviderAvailability>): string {
  return [
    'Phase 58 provider availability summary',
    '',
    `Readiness: ${summary.readiness}`,
    `Advisory only: ${summary.advisoryOnly ? 'yes' : 'no'}`,
    `Persisted: ${summary.persisted ? 'yes' : 'no'}`,
    `Redaction-safe: ${summary.redactionSafe ? 'yes' : 'no'}`,
    `Rows included: ${summary.itemRowsIncluded ? 'true' : 'false'}`,
    `Provider details included: ${summary.providerDetailsIncluded ? 'true' : 'false'}`,
    `Raw refs included: ${summary.rawRefsIncluded ? 'true' : 'false'}`,
    `Counts: total=${summary.counts.total} candidate=${summary.counts.candidate} skip=${summary.counts.skip} hold=${summary.counts.hold}`,
    `Statuses: available=${summary.counts.available} unavailable=${summary.counts.unavailable} unknown=${summary.counts.unknown} stale=${summary.counts.stale} invalid=${summary.counts.invalid}`,
    '',
  ].join('\n');
}

process.exit(main());
