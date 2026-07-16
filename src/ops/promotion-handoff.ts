import { createHash } from 'node:crypto';

// Local, non-live coordinator handoff packet generator. It summarizes the offline Phase 230 artifacts
// (a sealed acceptance packet, and optionally the rehearsal matrix/manifest and the artifact-integrity
// report) into a single redaction-safe packet for a coordinator, carrying explicit, prominent language
// that it authorizes NOTHING live. It reads parsed JSON only; it performs no promotion, never touches
// the real Movies root, never contacts Jellyfin, and never authorizes Phase 231 or live promotion.

export interface CoordinatorHandoffInput {
  readonly acceptancePacket?: unknown;
  readonly rehearsalManifest?: unknown;   // optional: a rehearsal or rehearsal-matrix manifest
  readonly integrityReport?: unknown;     // optional: an artifact-integrity report
}

// Explicit, always-present authorization disclaimers. These are constants, never derived from input.
export const HANDOFF_DISCLAIMERS: readonly string[] = [
  'This handoff does NOT authorize Phase 231.',
  'This handoff does NOT authorize live promotion.',
  'No live Jellyfin call or real Movies write is implied or performed by this handoff.',
  'This is a redaction-safe coordinator summary of offline fixture/guard artifacts only.',
];

export interface CoordinatorHandoffPacket {
  readonly report: 'phase-230-promotion-coordinator-handoff';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly handoffState: 'READY_FOR_COORDINATOR' | 'NOT_READY';
  readonly disclaimers: readonly string[];
  readonly acceptance: {
    readonly present: boolean;
    readonly status?: string;
    readonly accepted?: boolean;
    readonly sealDigest?: string;
  };
  readonly boundDigests: Record<string, string>;
  readonly rehearsal?: { readonly outcome?: string; readonly digest?: string };
  readonly integrity?: { readonly ok?: boolean; readonly integrityDigest?: string };
  readonly blockers: readonly string[];
  readonly handoffDigest: string;
}

export function buildCoordinatorHandoff(input: CoordinatorHandoffInput): CoordinatorHandoffPacket {
  const blockers: string[] = [];
  const packet = input.acceptancePacket === undefined ? undefined : asObject(input.acceptancePacket);
  const rehearsal = input.rehearsalManifest === undefined ? undefined : asObject(input.rehearsalManifest);
  const integrity = input.integrityReport === undefined ? undefined : asObject(input.integrityReport);

  const acceptanceValid = packet !== undefined && packet.report === 'phase-230-promotion-acceptance-packet';
  if (!acceptanceValid) blockers.push('ACCEPTANCE_MISSING');
  else if (!(packet!.status === 'ACCEPTED_SEALED' && packet!.accepted === true)) blockers.push('ACCEPTANCE_NOT_SEALED');

  const boundDigests: Record<string, string> = {};
  if (acceptanceValid) {
    const bound = asObject(packet!.boundDigests);
    for (const [k, v] of Object.entries(bound)) if (isSha256(v)) boundDigests[k] = v;
  }

  let rehearsalSummary: CoordinatorHandoffPacket['rehearsal'];
  if (rehearsal !== undefined) {
    const outcome = typeof rehearsal.outcome === 'string' ? rehearsal.outcome : undefined;
    const rDigest = isSha256(rehearsal.manifestDigest) ? rehearsal.manifestDigest as string : (isSha256(rehearsal.matrixDigest) ? rehearsal.matrixDigest as string : undefined);
    rehearsalSummary = { ...(outcome ? { outcome } : {}), ...(rDigest ? { digest: rDigest } : {}) };
    if (outcome !== 'REHEARSAL_PASS' && outcome !== 'MATRIX_PASS') blockers.push('REHEARSAL_NOT_PASSED');
  }

  let integritySummary: CoordinatorHandoffPacket['integrity'];
  if (integrity !== undefined) {
    const ok = integrity.ok === true;
    integritySummary = { ok, ...(isSha256(integrity.integrityDigest) ? { integrityDigest: integrity.integrityDigest as string } : {}) };
    if (!ok) blockers.push('INTEGRITY_NOT_OK');
  }

  const body: Omit<CoordinatorHandoffPacket, 'handoffDigest'> = {
    report: 'phase-230-promotion-coordinator-handoff',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    handoffState: blockers.length === 0 ? 'READY_FOR_COORDINATOR' : 'NOT_READY',
    disclaimers: HANDOFF_DISCLAIMERS,
    acceptance: {
      present: acceptanceValid,
      ...(acceptanceValid && typeof packet!.status === 'string' ? { status: packet!.status as string } : {}),
      ...(acceptanceValid && typeof packet!.accepted === 'boolean' ? { accepted: packet!.accepted as boolean } : {}),
      ...(acceptanceValid && isSha256(packet!.sealDigest) ? { sealDigest: packet!.sealDigest as string } : {}),
    },
    boundDigests,
    ...(rehearsalSummary ? { rehearsal: rehearsalSummary } : {}),
    ...(integritySummary ? { integrity: integritySummary } : {}),
    blockers,
  };

  if (hasRawPathLeak(body)) {
    const leaked = { ...body, handoffState: 'NOT_READY' as const, blockers: [...blockers, 'RAW_PATH_IN_HANDOFF'] };
    return { ...leaked, handoffDigest: digest('phase-230-coordinator-handoff', JSON.stringify(leaked)) };
  }
  return { ...body, handoffDigest: digest('phase-230-coordinator-handoff', JSON.stringify(body)) };
}

function hasRawPathLeak(value: unknown): boolean {
  let leak = false;
  const walk = (v: unknown, key: string | undefined): void => {
    if (leak) return;
    if (typeof v === 'string') {
      if (key === 'disclaimers') return; // fixed constant language may mention "Movies"/"Jellyfin" as words
      if (looksLikePath(v)) leak = true;
      return;
    }
    if (Array.isArray(v)) { for (const e of v) walk(e, key); return; }
    if (v && typeof v === 'object') { for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, k); }
  };
  walk(value, undefined);
  return leak;
}

function looksLikePath(s: string): boolean {
  return s.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(s)
    || s.includes('/mnt/')
    || s.includes('\\mnt\\')
    || s.includes('catalog-authority-test-library')
    || /\.(mkv|mp4|m4v|avi|mov|webm)$/i.test(s);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
