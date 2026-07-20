import { createHash } from 'node:crypto';
import { verifySelfDigests } from './promotion-self-digest-verifier.js';

// Local, non-live operator approval REQUEST packet. Given the authoritative review-authorization scaffold, it
// produces a redaction-safe packet that ASKS a human to approve -- listing the exact reviewed commit, the
// required test labels, the pending human gates, and PENDING placeholders for the item / source / destination
// binding a human must fill. It NEVER accepts or grants approval: `authorization` is the constant NONE, the
// `status` is the constant PENDING, and it fails closed if any input already claims an approval. It reads
// parsed JSON only; it performs no promotion, never touches the real Movies root, never contacts Jellyfin,
// and echoes only a hex commit sha, path-free test labels, fixed-language gates, and the literal PENDING.

export interface ApprovalRequestPacketInput {
  readonly reviewAuthorization?: unknown; // phase-230-promotion-review-authorization (LOCAL_REVIEW_AUTHORIZED)
}

export const APPROVAL_REQUEST_HUMAN_GATES: readonly string[] = [
  'A human must review the reviewed commit and its diff.',
  'A human must confirm the required tests were run and passed.',
  'A human must fill the item / source / destination binding placeholders.',
  'Explicit coordinator ACCEPT must be recorded via the acceptance seal.',
  'The merge / tag / push-to-master action itself is a human operator step NOT performed or requested here.',
  'Phase 231 authorization is NOT requested, implied, or granted by this packet.',
];

export const APPROVAL_REQUEST_DISCLAIMERS: readonly string[] = [
  'This is a REQUEST for human review only; it does NOT accept, grant, or record any approval.',
  'status is PENDING and authorization is NONE.',
  'It does NOT authorize Phase 231, live promotion, or any merge/tag/master action.',
  'No live Jellyfin call or real Movies write is implied or performed by this packet.',
];

export interface ApprovalRequestPacket {
  readonly report: 'phase-230-promotion-approval-request-packet';
  readonly version: 1;
  readonly redactionSafe: true;
  readonly authorization: 'NONE';
  readonly status: 'PENDING';
  readonly overall: 'APPROVAL_REQUEST_READY' | 'APPROVAL_REQUEST_BLOCKED';
  readonly reviewedCommit: string | null;
  readonly requiredTests: readonly string[];
  readonly pendingHumanGates: readonly string[];
  readonly bindings: { readonly item: 'PENDING'; readonly source: 'PENDING'; readonly destination: 'PENDING' };
  readonly blockers: readonly string[];
  readonly disclaimers: readonly string[];
  readonly packetDigest: string;
}

const ALLOWED_AUTHORIZATION: readonly string[] = ['NONE', 'PENDING'];

export function buildApprovalRequestPacket(input: ApprovalRequestPacketInput): ApprovalRequestPacket {
  const blockers: string[] = [];

  // Refuse to build from anything that already claims an approval: authorization other than NONE/PENDING.
  const raw = asObject(input.reviewAuthorization);
  const a = raw.authorization;
  if (typeof a === 'string' && !ALLOWED_AUTHORIZATION.includes(a)) blockers.push('APPROVAL_CLAIM_PRESENT');

  const ra = input.reviewAuthorization;
  let reviewedCommit: string | null = null;
  let requiredTests: string[] = [];
  if (ra === undefined) blockers.push('REVIEW_AUTHORIZATION_MISSING');
  else if (raw.report !== 'phase-230-promotion-review-authorization') blockers.push('REVIEW_AUTHORIZATION_INVALID');
  else {
    const verified = asSha256(raw.authorizationDigest) !== undefined && verifySelfDigests([raw]).results[0]?.verified === true;
    const authoritative = raw.overall === 'LOCAL_REVIEW_AUTHORIZED' && raw.evidenceValid === true && raw.matrixValid === true && raw.contextBound === true;
    if (!verified || !authoritative) blockers.push('REVIEW_AUTHORIZATION_NOT_AUTHORITATIVE');
    else {
      const rows = Array.isArray(raw.placeholders) ? raw.placeholders : [];
      const shas = rows.map((r) => asSha40(asObject(r).sha)).filter((s): s is string => s !== undefined);
      if (shas.length !== rows.length || shas.length === 0) blockers.push('REVIEW_AUTHORIZATION_NOT_AUTHORITATIVE');
      else {
        reviewedCommit = shas[shas.length - 1]!;
        const seen = new Set<string>();
        for (const r of rows) for (const t of (Array.isArray(asObject(r).tests) ? asObject(r).tests as unknown[] : [])) {
          const label = pathFree(asObject(t).test);
          if (label !== null && !seen.has(label)) { seen.add(label); requiredTests.push(label); }
        }
        if (requiredTests.length === 0) blockers.push('REVIEW_AUTHORIZATION_NOT_AUTHORITATIVE');
      }
    }
  }

  const uniqueBlockers = [...new Set(blockers)];
  const overall: ApprovalRequestPacket['overall'] = uniqueBlockers.length === 0 ? 'APPROVAL_REQUEST_READY' : 'APPROVAL_REQUEST_BLOCKED';
  const withoutDigest: Omit<ApprovalRequestPacket, 'packetDigest'> = {
    report: 'phase-230-promotion-approval-request-packet',
    version: 1,
    redactionSafe: true,
    authorization: 'NONE',
    status: 'PENDING',
    overall,
    reviewedCommit: overall === 'APPROVAL_REQUEST_READY' ? reviewedCommit : null,
    requiredTests: overall === 'APPROVAL_REQUEST_READY' ? requiredTests : [],
    pendingHumanGates: APPROVAL_REQUEST_HUMAN_GATES,
    bindings: { item: 'PENDING', source: 'PENDING', destination: 'PENDING' },
    blockers: uniqueBlockers,
    disclaimers: APPROVAL_REQUEST_DISCLAIMERS,
  };
  return { ...withoutDigest, packetDigest: digest('phase-230-approval-request-packet', JSON.stringify(withoutDigest)) };
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
function pathFree(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^\//.test(value) || /[A-Za-z]:[\\/]/.test(value) || /\/mnt\//.test(value) || /\\mnt\\/.test(value)
    || value.includes('catalog-authority-test-library') || /\.(mkv|mp4|avi|mov|m4v|ts|webm)$/i.test(value)) return null;
  return value;
}
function digest(scope: string, value: string): string {
  return createHash('sha256').update(`${scope}:${value}`).digest('hex');
}
