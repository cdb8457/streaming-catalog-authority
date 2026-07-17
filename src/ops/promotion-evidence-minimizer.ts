import { createHash } from 'node:crypto';

// Local, non-live evidence bundle minimizer + redaction proof. It projects each supplied report down to a
// MINIMAL record -- report id, status enum, self-digest, and numeric counts only -- dropping every free-text
// field (disclaimers, human gates, doc references, commit subjects, etc.). It then PROVES the minimal
// bundle is redaction-safe: a deep scan confirms every packed string is a report id, an UPPER_SNAKE status
// enum, or a hex digest, and every packed number is a count. It reads parsed JSON only; it performs no
// promotion, never touches the real Movies root, never contacts Jellyfin, and authorizes nothing live.

export const PACKED_KINDS: readonly string[] = ['DIGESTS', 'STATUSES', 'COUNTS'];

export interface MinimalRecord {
  readonly report: string;
  readonly status: string | null;
  readonly digest: string | null;
  readonly counts: Readonly<Record<string, number>>;
}

export interface MinimizerReport {
  readonly report: 'phase-230-promotion-evidence-minimizer';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly overall: 'MINIMIZED_CLEAN' | 'MINIMIZED_LEAK' | 'NO_REPORTS';
  readonly count: number;
  readonly packedKinds: readonly string[];
  readonly entries: readonly MinimalRecord[];
  readonly leaks: readonly string[];
  readonly minimizerDigest: string;
}

export function buildEvidenceMinimizer(reports: readonly unknown[]): MinimizerReport {
  const entries: MinimalRecord[] = reports.map((r) => {
    const o = asObject(r);
    const report = typeof o.report === 'string' ? o.report : '<unknown>';
    const status = typeof o.overall === 'string' ? o.overall : (typeof o.ok === 'boolean' ? (o.ok ? 'OK' : 'NOT_OK') : null);
    let digest: string | null = null;
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) {
      if (/Digest$/.test(k) && isHex(v)) digest = v as string;
      else if (isNonNegInt(v)) counts[k] = v as number;
    }
    return { report, status, digest, counts };
  });

  // Redaction proof: every string leaf of the minimal bundle must be a report id, a status enum, or a hex
  // digest; every number a count. Anything else is a leak -- but by construction there is nothing else.
  const leaks: string[] = [];
  for (const e of entries) {
    scanLeaves(e, (s) => { if (!isReportId(s) && !isStatusEnum(s) && !isHex(s)) leaks.push(e.report); });
  }
  const uniqueLeaks = [...new Set(leaks)];

  const overall: MinimizerReport['overall'] =
    reports.length === 0 ? 'NO_REPORTS' : uniqueLeaks.length > 0 ? 'MINIMIZED_LEAK' : 'MINIMIZED_CLEAN';
  const withoutDigest: Omit<MinimizerReport, 'minimizerDigest'> = {
    report: 'phase-230-promotion-evidence-minimizer',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    overall,
    count: reports.length,
    packedKinds: PACKED_KINDS,
    entries,
    leaks: uniqueLeaks,
  };
  return { ...withoutDigest, minimizerDigest: digest('phase-230-evidence-minimizer', JSON.stringify(withoutDigest)) };
}

function scanLeaves(value: unknown, onString: (s: string) => void): void {
  if (typeof value === 'string') { onString(value); return; }
  if (Array.isArray(value)) { for (const v of value) scanLeaves(v, onString); return; }
  if (value !== null && typeof value === 'object') { for (const v of Object.values(value)) scanLeaves(v, onString); }
}
function isReportId(s: string): boolean { return /^(<unknown>|phase-\d+-[a-z0-9-]+)$/.test(s); }
function isStatusEnum(s: string): boolean { return /^[A-Z][A-Z0-9_]*$/.test(s); }
function isHex(v: unknown): boolean { return typeof v === 'string' && (/^[0-9a-f]{64}$/.test(v) || /^[0-9a-f]{40}$/.test(v)); }
function isNonNegInt(v: unknown): boolean { return typeof v === 'number' && Number.isInteger(v) && v >= 0; }
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
