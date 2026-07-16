import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildAcceptanceDashboard, type DashboardInput } from './promotion-dashboard.js';

// Offline acceptance-dashboard CLI. Renders the matrix + integrity + handoff artifacts into a single
// redaction-safe dashboard that is READY only when all four are green. Never promotes, never touches
// the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-dashboard [--matrix <f>] [--integrity <f>] [--schema <f>] [--handoff <f>] [--out <dashboard.json>]',
    '',
    'Local, non-live: DASHBOARD_READY only when the rehearsal matrix passed, the integrity report is ok,',
    'the artifact-schema report is ok, and the coordinator handoff is READY_FOR_COORDINATOR. Exit 0 = READY,',
    '1 = BLOCKED. Authorizes nothing live.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function readJson(path: string, label: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} file is missing or not valid JSON`); }
}

function main(): number {
  const args = process.argv.slice(2);
  const matrixPath = valueAfter(args, '--matrix');
  const integrityPath = valueAfter(args, '--integrity');
  const schemaPath = valueAfter(args, '--schema');
  const handoffPath = valueAfter(args, '--handoff');
  const out = valueAfter(args, '--out');
  let input: DashboardInput;
  try {
    input = {
      ...(matrixPath ? { matrix: readJson(matrixPath, 'matrix') } : {}),
      ...(integrityPath ? { integrity: readJson(integrityPath, 'integrity') } : {}),
      ...(schemaPath ? { schema: readJson(schemaPath, 'schema') } : {}),
      ...(handoffPath ? { handoff: readJson(handoffPath, 'handoff') } : {}),
    };
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const dashboard = buildAcceptanceDashboard(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(dashboard, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-acceptance-dashboard-capture',
    overall: dashboard.overall,
    authorization: dashboard.authorization,
    redactionSafe: true,
    panels: dashboard.panels.map((p) => ({ source: p.source, present: p.present, ok: p.ok, ...(p.status ? { status: p.status } : {}) })),
    blockers: dashboard.blockers,
    dashboardDigest: dashboard.dashboardDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return dashboard.overall === 'DASHBOARD_READY' ? 0 : 1;
}

process.exit(main());
