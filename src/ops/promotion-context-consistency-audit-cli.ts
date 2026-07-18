import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildContextConsistencyAudit, type ContextConsistencyInput } from './promotion-context-consistency-audit.js';

// Offline cross-component context-consistency audit CLI. Given a bundle (JSON array) of Phase 230 reports
// that carry review context, it fails closed on any inconsistency in the shared branch/base/head/ordered
// commit shas/test set across the independently-green, self-digested components. It authorizes nothing and
// does not authorize Phase 231. Never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-context-consistency-audit --reports <bundle.json> [--out <audit.json>]',
    '',
    'bundle.json is a JSON array of Phase 230 reports (merge-readiness, reviewer-pack, acceptance-preflight,',
    'commit-range-closure, transcript-verification, review-transcript, final-summary, provenance-diff,',
    'review-matrix). Local, non-live: CONTEXT_CONSISTENT only when every verified context-bearing component',
    'agrees on branch/base/head/ordered commits/test set. It authorizes NOTHING and does not authorize Phase',
    '231. Exit 0 = CONTEXT_CONSISTENT, 1 = CONTEXT_INCONSISTENT.',
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
  const input: ContextConsistencyInput = {};
  try {
    const reports = valueAfter(args, '--reports');
    if (reports !== undefined) (input as Record<string, unknown>).reports = JSON.parse(readFileSync(reports, 'utf8'));
  } catch { console.error('reports file is missing or not valid JSON'); return 2; }
  const audit = buildContextConsistencyAudit(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(audit, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-context-consistency-audit-capture',
    overall: audit.overall,
    authorization: audit.authorization,
    redactionSafe: true,
    componentCount: audit.componentCount,
    fieldConsistency: audit.fieldConsistency,
    reconciled: audit.reconciled,
    blockers: audit.blockers,
    auditDigest: audit.auditDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return audit.overall === 'CONTEXT_CONSISTENT' ? 0 : 1;
}

process.exit(main());
