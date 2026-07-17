import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildReportSchema } from './promotion-report-schema.js';

// Offline AP-AZ report schema strictness CLI. Validates supplied reports against strict schemas: exact key
// set, fixed literals, overall enum, sha256 self-digest. Never promotes, never touches the real Movies
// root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-report-schema --report <f> [--report <f> ...] [--out <schema.json>]',
    '',
    'Local, non-live: REPORT_SCHEMA_OK only when every supplied AP-AZ report matches its strict schema',
    '(no missing/unknown keys, fixed literals, valid overall enum + digest). It authorizes NOTHING live and',
    'does not authorize Phase 231. Exit 0 = OK, 1 = VIOLATION / NO_REPORTS.',
  ].join('\n');
}

function collectValues(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1]!);
  return out;
}
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}
function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('a --report file is missing or not valid JSON'); }
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  let reports: unknown[];
  try { reports = collectValues(args, '--report').map(readJson); }
  catch (err) { console.error((err as Error).message); return 2; }
  const schema = buildReportSchema(reports);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-report-schema-capture',
    overall: schema.overall,
    authorization: schema.authorization,
    redactionSafe: true,
    count: schema.count,
    results: schema.results,
    violations: schema.violations,
    reportSchemaDigest: schema.reportSchemaDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return schema.overall === 'REPORT_SCHEMA_OK' ? 0 : 1;
}

process.exit(main());
