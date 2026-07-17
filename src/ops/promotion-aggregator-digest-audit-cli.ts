import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAggregatorDigestAudit } from './promotion-aggregator-digest-audit.js';

// Offline aggregator digest fail-open audit CLI. Proves every aggregator that binds component self-digests
// recomputes them rather than only validating shape. Never promotes, never touches the real Movies root,
// never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-aggregator-digest-audit [--out <audit.json>]',
    '',
    'Local, non-live: AGGREGATOR_AUDIT_CLEAN when every component-digest binder recomputes each component',
    'self-digest (delegating to the self-digest verifier), fails closed with COMPONENT_DIGEST_MISMATCH, and',
    'has a test asserting that rejection. It authorizes NOTHING live and does not authorize Phase 231.',
    'Exit 0 = CLEAN, 1 = FAILED.',
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
  const audit = buildAggregatorDigestAudit(projectRoot);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(audit, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-aggregator-digest-audit-capture',
    overall: audit.overall,
    authorization: audit.authorization,
    redactionSafe: true,
    binderCount: audit.binderCount,
    conformantCount: audit.conformantCount,
    aggregators: audit.aggregators,
    gaps: audit.gaps,
    auditDigest: audit.auditDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return audit.overall === 'AGGREGATOR_AUDIT_CLEAN' ? 0 : 1;
}

process.exit(main());
