import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBoundaryAudit } from './promotion-boundary-audit.js';

// Offline final boundary audit CLI. Re-verifies the compiled boundary policy and audits beyond it (network
// endpoints, env reads, gate composition, index-doc drift). Never promotes, never touches the real Movies
// root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-boundary-audit [--out <audit.json>]',
    '',
    'Local, non-live: BOUNDARY_AUDIT_CLEAN when the policy is enforced, no op source carries a network URL',
    'or env read, the local gate references only local suites, and the index docs state the boundary. It',
    'authorizes NOTHING live and does not authorize Phase 231. Exit 0 = CLEAN, 1 = FAILED.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(usage()); return 0; }
  const out = valueAfter(args, '--out');
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
  const audit = buildBoundaryAudit(projectRoot);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(audit, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-boundary-audit-capture',
    overall: audit.overall,
    authorization: audit.authorization,
    redactionSafe: true,
    ruleCount: audit.ruleCount,
    scannedSources: audit.scannedSources,
    scannedDocs: audit.scannedDocs,
    rules: audit.rules,
    violations: audit.violations,
    auditDigest: audit.auditDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return audit.overall === 'BOUNDARY_AUDIT_CLEAN' ? 0 : 1;
}

process.exit(main());
