import { createHash } from 'node:crypto';

// Local, non-live release-note / changelog generator. From a caller-provided commit list (sha +
// subject), it produces a redaction-safe changelog with a no-live / no-Phase-231 footer and the
// remaining human gates. It is deterministic (a pure function of its input) and does no git/process I/O
// itself. It performs no promotion, never touches the real Movies root, never contacts Jellyfin, and
// authorizes nothing live.

export interface ChangelogCommit {
  readonly sha: string;
  readonly subject: string;
}

export interface ChangelogInput {
  readonly commits?: readonly ChangelogCommit[];
}

export const CHANGELOG_HUMAN_GATES: readonly string[] = [
  'A human operator authors and independently attests the approval file; this tooling validates it but does not issue it.',
  'The live real-library promotion (the Phase 229 operator-approved launcher writing to the real Movies library) is a human-authorized step, out of scope and not performed by this tooling.',
  'The coordinator records an explicit ACCEPT decision in the acceptance seal.',
  'Phase 231 authorization is a separate human decision, granted by nothing in this changelog.',
];

export const CHANGELOG_DISCLAIMERS: readonly string[] = [
  'This changelog does NOT authorize Phase 231.',
  'This changelog does NOT authorize live promotion.',
  'No live Jellyfin call or real Movies write is implied or performed by this changelog.',
  'This changelog is a redaction-safe, deterministic record of an offline commit range.',
];

export interface ChangelogReport {
  readonly report: 'phase-230-promotion-changelog';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly ok: boolean;
  readonly count: number;
  readonly entries: readonly ChangelogCommit[];
  readonly humanGates: readonly string[];
  readonly disclaimers: readonly string[];
  readonly problems: readonly string[];
  readonly changelogDigest: string;
}

export function buildChangelog(input: ChangelogInput): ChangelogReport {
  const problems: string[] = [];
  const entries: ChangelogCommit[] = [];
  for (const c of input.commits ?? []) {
    const sha = typeof c.sha === 'string' && /^[0-9a-f]{7,64}$/.test(c.sha) ? c.sha : '';
    const subject = typeof c.subject === 'string' ? c.subject : '';
    if (sha.length === 0) problems.push('COMMIT_SHA_INVALID');
    if (subject.length === 0) problems.push('COMMIT_SUBJECT_MISSING');
    if (looksLikePath(subject)) problems.push('RAW_PATH_IN_CHANGELOG');
    entries.push({ sha, subject });
  }

  const ok = problems.length === 0 && entries.length > 0;
  const body: Omit<ChangelogReport, 'changelogDigest'> = {
    report: 'phase-230-promotion-changelog',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    ok,
    count: entries.length,
    entries,
    humanGates: CHANGELOG_HUMAN_GATES,
    disclaimers: CHANGELOG_DISCLAIMERS,
    problems,
  };
  return { ...body, changelogDigest: digest('phase-230-changelog', JSON.stringify(body)) };
}

function looksLikePath(s: string): boolean {
  return s.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(s)
    || s.includes('/mnt/')
    || s.includes('\\mnt\\')
    || s.includes('catalog-authority-test-library')
    || /\.(mkv|mp4|m4v|avi|mov|webm)(\s|$)/i.test(s);
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
