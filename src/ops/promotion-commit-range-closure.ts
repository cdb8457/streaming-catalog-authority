import { createHash } from 'node:crypto';

// Local, non-live commit-range closure verifier. Given the base/head and the commit list since base, it
// categorizes every commit by its subject -- a phase op, a remediation, a docs/index change, or a chore --
// and confirms the range is CLOSED: every commit is accounted for, every sha is well-formed, and no subject
// leaks a path/title. It reads parsed JSON only; it invokes no git, performs no promotion, never touches the
// real Movies root, never contacts Jellyfin, and authorizes nothing live. It echoes only shas and category
// enums, never the raw subjects.

export interface CommitRangeInput {
  readonly base?: unknown;
  readonly head?: unknown;
  readonly commits?: unknown;
}

export interface CommitCategory { readonly sha: string; readonly category: string; }

export interface CommitRangeClosure {
  readonly report: 'phase-230-promotion-commit-range-closure';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'RANGE_CLOSED' | 'RANGE_OPEN';
  readonly base: string | null;
  readonly head: string | null;
  readonly commitCount: number;
  readonly categories: Readonly<Record<string, number>>;
  readonly results: readonly CommitCategory[];
  readonly blockers: readonly string[];
  readonly closureDigest: string;
}

function categorize(subject: string): string {
  if (/\(phase [A-Z]{1,2}\)/i.test(subject)) return 'phase-op';
  if (/remediation/i.test(subject)) return 'remediation';
  if (/consolidat|review index|\bindex\b|\bdoc(s|umentation)?\b/i.test(subject)) return 'docs';
  if (/stop tracking|untrack|\bscratch\b|\bchore\b/i.test(subject)) return 'chore';
  return 'uncategorized';
}

export function buildCommitRangeClosure(input: CommitRangeInput): CommitRangeClosure {
  const blockers: string[] = [];
  const base = asSha40(input.base) ?? null;
  if (base === null) blockers.push('BASE_MISSING');
  const head = asSha40(input.head) ?? null;
  if (head === null) blockers.push('HEAD_MISSING');

  const commits = Array.isArray(input.commits) ? input.commits : [];
  if (commits.length === 0) blockers.push('NO_COMMITS');

  const results: CommitCategory[] = [];
  let shaMalformed = false;
  let subjectLeak = false;
  let uncategorized = false;
  for (const c of commits) {
    const o = asObject(c);
    const sha = asSha40(o.sha);
    const subject = pathFreeString(o.subject);
    if (sha === undefined) { shaMalformed = true; continue; }
    if (subject === null) { subjectLeak = true; results.push({ sha, category: 'uncategorized' }); uncategorized = true; continue; }
    const category = categorize(subject);
    if (category === 'uncategorized') uncategorized = true;
    results.push({ sha, category });
  }
  if (shaMalformed) blockers.push('COMMIT_SHA_MALFORMED');
  if (subjectLeak) blockers.push('COMMIT_SUBJECT_LEAK');
  if (uncategorized) blockers.push('COMMIT_UNCATEGORIZED');

  const categories: Record<string, number> = {};
  for (const r of results) categories[r.category] = (categories[r.category] ?? 0) + 1;

  const overall: CommitRangeClosure['overall'] = blockers.length === 0 ? 'RANGE_CLOSED' : 'RANGE_OPEN';
  const withoutDigest: Omit<CommitRangeClosure, 'closureDigest'> = {
    report: 'phase-230-promotion-commit-range-closure',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    base,
    head,
    commitCount: results.length,
    categories,
    results,
    blockers: [...new Set(blockers)],
  };
  return { ...withoutDigest, closureDigest: digest('phase-230-commit-range-closure', JSON.stringify(withoutDigest)) };
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
function asSha40(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
