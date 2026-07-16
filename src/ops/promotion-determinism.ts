import { createHash } from 'node:crypto';

// Local, non-live determinism stress harness. Given repeated digests of the same deterministic builder
// (produced from identical inputs, or from inputs that should not affect the result such as reordered
// object keys), it confirms every sample of a subject is identical. It is a pure aggregation of digests;
// it performs no promotion, never touches the real Movies root, never contacts Jellyfin, and authorizes
// nothing live.

export interface DeterminismSubject {
  readonly subject: string;
  readonly digests: readonly string[];
}

export interface SubjectResult {
  readonly subject: string;
  readonly samples: number;
  readonly distinct: number;
  readonly deterministic: boolean;
}

export interface DeterminismReport {
  readonly report: 'phase-230-promotion-determinism-stress';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'DETERMINISTIC' | 'NON_DETERMINISTIC' | 'INSUFFICIENT_SAMPLES' | 'NO_SUBJECTS';
  readonly results: readonly SubjectResult[];
  readonly nonDeterministic: readonly string[];
  readonly determinismDigest: string;
}

// Each subject is deterministic only when it has at least two samples and they are all identical.
export function assessDeterminism(subjects: readonly DeterminismSubject[]): DeterminismReport {
  const results: SubjectResult[] = subjects.map((s) => {
    const digests = Array.isArray(s.digests) ? s.digests : [];
    const distinct = new Set(digests).size;
    const samples = digests.length;
    return { subject: s.subject, samples, distinct, deterministic: samples >= 2 && distinct === 1 };
  });
  const nonDeterministic = results.filter((r) => r.samples >= 2 && r.distinct > 1).map((r) => r.subject);
  const insufficient = results.some((r) => r.samples < 2);
  const overall: DeterminismReport['overall'] =
    results.length === 0 ? 'NO_SUBJECTS'
      : nonDeterministic.length > 0 ? 'NON_DETERMINISTIC'
        : insufficient ? 'INSUFFICIENT_SAMPLES'
          : 'DETERMINISTIC';
  const withoutDigest: Omit<DeterminismReport, 'determinismDigest'> = {
    report: 'phase-230-promotion-determinism-stress',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    results,
    nonDeterministic,
  };
  return { ...withoutDigest, determinismDigest: digest('phase-230-determinism-stress', JSON.stringify(withoutDigest)) };
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
