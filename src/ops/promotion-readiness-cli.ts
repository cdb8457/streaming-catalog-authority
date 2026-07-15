import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildPromotionReadinessChecklist, type PromotionReadinessInput } from './promotion-readiness.js';

// Offline coordinator readiness checklist CLI. Reads the local JSON artifacts and emits a
// redaction-safe READY/BLOCKED checklist. Never promotes, never touches the real Movies root,
// never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-readiness --approval <approval.json> \\',
    '    [--approval-evidence <approval-evidence.json>] [--promotion-evidence <promotion-evidence.json>] \\',
    '    [--evidence-review <review.json>] [--out <checklist.json>]',
    '',
    'Local, non-live: cross-checks that the approval attestation, promotion evidence, and evidence review',
    'describe one consistent, observed, accepted promotion, and emits a redaction-safe READY/BLOCKED checklist.',
    'Exit 0 = READY, 1 = BLOCKED. Grants no authorization; performs no promotion or Jellyfin call.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${label} file is missing or not valid JSON`);
  }
}

function main(): number {
  const args = process.argv.slice(2);
  const approvalPath = valueAfter(args, '--approval');
  const approvalEvidencePath = valueAfter(args, '--approval-evidence');
  const promotionEvidencePath = valueAfter(args, '--promotion-evidence');
  const evidenceReviewPath = valueAfter(args, '--evidence-review');
  const out = valueAfter(args, '--out');
  if (!approvalPath) {
    console.error(usage());
    return 2;
  }
  let input: PromotionReadinessInput;
  try {
    input = {
      approval: readJson(approvalPath, 'approval'),
      ...(approvalEvidencePath ? { approvalEvidence: readJson(approvalEvidencePath, 'approval-evidence') } : {}),
      ...(promotionEvidencePath ? { promotionEvidence: readJson(promotionEvidencePath, 'promotion-evidence') } : {}),
      ...(evidenceReviewPath ? { evidenceReview: readJson(evidenceReviewPath, 'evidence-review') } : {}),
    };
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const checklist = buildPromotionReadinessChecklist(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(checklist, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-readiness-capture',
    verdict: checklist.verdict,
    redactionSafe: true,
    blockers: checklist.blockers,
    items: checklist.items.map((i) => ({ id: i.id, status: i.status, ...(i.mismatches ? { mismatches: i.mismatches } : {}) })),
    checklistDigest: checklist.checklistDigest,
    ...(out ? { outputFile: out } : {}),
  }, null, 2));
  return checklist.verdict === 'READY' ? 0 : 1;
}

process.exit(main());
