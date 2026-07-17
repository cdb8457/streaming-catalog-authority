import { createHash } from 'node:crypto';

// Local, non-live evidence provenance diff / branch-to-artifact alignment report. It compares a dry-run
// context (branch / base / head / commits) against the generated evidence artifacts -- the review
// transcript and, optionally, the coordinator final summary and review bundle -- and confirms they align:
// the head must equal the reviewed commit, the reviewed commit must be in the branch's commit range, and
// the review bundle must bind the transcript. It reads parsed JSON only; it invokes no git, performs no
// promotion, never touches the real Movies root, never contacts Jellyfin, and authorizes nothing live. It
// fails closed on any mismatch, missing/malformed ref, stale artifact, or path/title leak, and echoes only
// hex shas and counts (never the branch name or commit subjects).

export interface ProvenanceContext {
  readonly branch?: unknown;
  readonly base?: unknown;
  readonly head?: unknown;
  readonly commits?: unknown;
}

export interface ProvenanceDiffInput {
  readonly context?: ProvenanceContext;
  readonly transcript?: unknown;
  readonly finalSummary?: unknown;
  readonly reviewBundle?: unknown;
}

export interface ProvenanceCheck { readonly check: string; readonly ok: boolean; }

export interface ProvenanceDiffReport {
  readonly report: 'phase-230-promotion-provenance-diff';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'PROVENANCE_ALIGNED' | 'PROVENANCE_MISALIGNED';
  readonly base: string | null;
  readonly head: string | null;
  readonly reviewedCommit: string | null;
  readonly commitCount: number;
  readonly checks: readonly ProvenanceCheck[];
  readonly blockers: readonly string[];
  readonly diffDigest: string;
}

export function buildProvenanceDiff(input: ProvenanceDiffInput): ProvenanceDiffReport {
  const blockers: string[] = [];
  const checks: ProvenanceCheck[] = [];
  const ctx = input.context ?? {};

  const branch = pathFreeString(ctx.branch);
  if (branch === null) blockers.push('BRANCH_MISSING');
  checks.push({ check: 'branch-present', ok: branch !== null });

  const base = asSha40(ctx.base) ?? null;
  if (base === null) blockers.push('BASE_MISSING');
  checks.push({ check: 'base-present', ok: base !== null });

  const head = asSha40(ctx.head) ?? null;
  if (head === null) blockers.push('HEAD_MISSING');
  checks.push({ check: 'head-present', ok: head !== null });

  // Commit range: every sha must be well-formed and every subject must be path/title-free.
  const commits = Array.isArray(ctx.commits) ? ctx.commits : [];
  let commitShas: string[] = [];
  let shaMalformed = false;
  let subjectLeak = false;
  for (const c of commits) {
    const o = asObject(c);
    const sha = asSha40(o.sha);
    if (sha === undefined) shaMalformed = true; else commitShas.push(sha);
    if (pathFreeString(o.subject) === null) subjectLeak = true;
  }
  if (commits.length === 0 || shaMalformed) blockers.push('COMMIT_SHA_MALFORMED');
  checks.push({ check: 'commit-shas-well-formed', ok: commits.length > 0 && !shaMalformed });
  if (subjectLeak || branch === null && ctx.branch !== undefined) blockers.push('RAW_PATH_LEAK');
  checks.push({ check: 'no-path-title-leak', ok: !subjectLeak && !(branch === null && ctx.branch !== undefined) });

  // The reviewed commit is taken from the transcript and must equal head and lie in the commit range.
  let reviewedCommit: string | null = null;
  const tr = input.transcript;
  if (tr === undefined) { blockers.push('TRANSCRIPT_MISSING'); checks.push({ check: 'transcript-present', ok: false }); }
  else {
    const o = asObject(tr);
    if (o.report !== 'phase-230-promotion-review-transcript') { blockers.push('TRANSCRIPT_INVALID'); checks.push({ check: 'transcript-present', ok: false }); }
    else {
      reviewedCommit = asSha40(o.reviewedCommit) ?? null;
      checks.push({ check: 'transcript-present', ok: true });
      const headMatch = reviewedCommit !== null && head !== null && reviewedCommit === head;
      if (!headMatch) blockers.push('HEAD_REVIEWED_COMMIT_MISMATCH');
      checks.push({ check: 'head=reviewed-commit', ok: headMatch });
      const inRange = reviewedCommit !== null && commitShas.includes(reviewedCommit);
      if (!inRange) blockers.push('REVIEWED_COMMIT_NOT_IN_RANGE');
      checks.push({ check: 'reviewed-commit-in-range', ok: inRange });

      // A supplied final summary must have been reviewed at the same commit.
      const fs = input.finalSummary;
      if (fs !== undefined) {
        const fo = asObject(fs);
        const fsCommit = asSha40(fo.reviewedCommit);
        const fsMatch = fsCommit !== undefined && fsCommit === reviewedCommit;
        if (!fsMatch) blockers.push('HEAD_REVIEWED_COMMIT_MISMATCH');
        checks.push({ check: 'final-summary.commit=reviewed-commit', ok: fsMatch });
      }

      // A supplied review bundle must bind this transcript (else it is a stale artifact).
      const rb = input.reviewBundle;
      if (rb !== undefined) {
        const bound = componentDigest(asObject(rb), 'transcript');
        const fresh = bound !== undefined && bound === asSha256(o.transcriptDigest);
        if (!fresh) blockers.push('STALE_ARTIFACT');
        checks.push({ check: 'review-bundle-binds-transcript', ok: fresh });
      }
    }
  }

  const overall: ProvenanceDiffReport['overall'] = blockers.length === 0 ? 'PROVENANCE_ALIGNED' : 'PROVENANCE_MISALIGNED';
  const withoutDigest: Omit<ProvenanceDiffReport, 'diffDigest'> = {
    report: 'phase-230-promotion-provenance-diff',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    base,
    head,
    reviewedCommit,
    commitCount: commitShas.length,
    checks,
    blockers: [...new Set(blockers)],
  };
  return { ...withoutDigest, diffDigest: digest('phase-230-provenance-diff', JSON.stringify(withoutDigest)) };
}

function componentDigest(report: Record<string, unknown>, name: string): string | undefined {
  const comps = report.components;
  if (!Array.isArray(comps)) return undefined;
  for (const c of comps) { const co = asObject(c); if (co.component === name) return asSha256(co.digest); }
  return undefined;
}
function pathFreeString(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^\//.test(value) || /[A-Za-z]:[\\/]/.test(value) || /\/mnt\//.test(value) || /\\mnt\\/.test(value)
    || value.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(value)) return null;
  return value;
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asSha256(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
function asSha40(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
