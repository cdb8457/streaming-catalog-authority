import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApprovalRequestPacket, type ApprovalRequestPacketInput } from './promotion-approval-request-packet.js';

// Offline operator approval REQUEST packet CLI. Produces a redaction-safe request for human approval; it never
// accepts or grants approval (status PENDING, authorization NONE). Never touches the real Movies root, never
// contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-approval-request-packet --reviewauthorization <f> [--out <packet.json>]',
    '',
    'Local, non-live: APPROVAL_REQUEST_READY when the review-authorization is authoritative + authorized; the',
    'packet lists the reviewed commit, required tests, pending human gates, and PENDING item/source/destination',
    'placeholders. It does NOT accept or grant approval and does not authorize Phase 231. Exit 0 = READY, 1 =',
    'BLOCKED.',
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
  const input: ApprovalRequestPacketInput = {};
  try {
    const ra = valueAfter(args, '--reviewauthorization');
    if (ra !== undefined) (input as Record<string, unknown>).reviewAuthorization = JSON.parse(readFileSync(ra, 'utf8'));
  } catch { console.error('reviewAuthorization file is missing or not valid JSON'); return 2; }
  const packet = buildApprovalRequestPacket(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(packet, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-approval-request-packet-capture',
    overall: packet.overall,
    authorization: packet.authorization,
    status: packet.status,
    redactionSafe: true,
    reviewedCommit: packet.reviewedCommit,
    requiredTests: packet.requiredTests,
    bindings: packet.bindings,
    blockers: packet.blockers,
    packetDigest: packet.packetDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return packet.overall === 'APPROVAL_REQUEST_READY' ? 0 : 1;
}

process.exit(main());
