import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sealPromotionAcceptance, verifyAcceptanceSeal, type AcceptanceSealInput } from './promotion-acceptance-seal.js';

// Offline acceptance packet/seal CLI. Two subcommands:
//   seal   — seal a READY readiness checklist with a human ACCEPT/REJECT decision
//   verify — recompute and check the seal of an existing acceptance packet
// It never promotes, never touches the real Movies root, never contacts Jellyfin, and grants no
// authorization: it records a coordinator's paperwork acceptance only.

function usage(): string {
  return [
    'usage:',
    '  ops:promotion-acceptance-seal seal --readiness <checklist.json> --acceptor-id <id> --decision <ACCEPT|REJECT> \\',
    '      [--evidence-review <review.json>] [--approval-evidence <approval-evidence.json>] [--out <packet.json>]',
    '',
    '  ops:promotion-acceptance-seal verify --packet <packet.json>',
    '',
    'Local, non-live: seals a READY promotion readiness checklist into a redaction-safe, tamper-evident',
    'acceptance packet, or verifies one. seal exit 0 = ACCEPTED_SEALED, 1 = REFUSED. verify exit 0 = valid, 1 = invalid.',
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
  const sub = args[0];

  if (sub === 'seal') {
    const readinessPath = valueAfter(args, '--readiness');
    const acceptorId = valueAfter(args, '--acceptor-id');
    const decision = valueAfter(args, '--decision');
    const reviewPath = valueAfter(args, '--evidence-review');
    const approvalEvidencePath = valueAfter(args, '--approval-evidence');
    const out = valueAfter(args, '--out');
    if (!readinessPath || !acceptorId || !decision) {
      console.error(usage());
      return 2;
    }
    let input: AcceptanceSealInput;
    try {
      input = {
        readinessChecklist: readJson(readinessPath, 'readiness'),
        ...(reviewPath ? { evidenceReview: readJson(reviewPath, 'evidence-review') } : {}),
        ...(approvalEvidencePath ? { approvalEvidence: readJson(approvalEvidencePath, 'approval-evidence') } : {}),
        acceptance: { acceptorId, decision, accepted: decision === 'ACCEPT' },
      };
    } catch (err) {
      console.error((err as Error).message);
      return 2;
    }
    const packet = sealPromotionAcceptance(input);
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(packet, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    console.log(JSON.stringify({
      report: 'phase-230-promotion-acceptance-capture',
      status: packet.status,
      accepted: packet.accepted,
      redactionSafe: true,
      refusals: packet.refusals,
      sealDigest: packet.sealDigest,
      // Never echo the raw --out path; report only that a file was written.
      ...(out ? { outputWritten: true } : {}),
    }, null, 2));
    return packet.status === 'ACCEPTED_SEALED' ? 0 : 1;
  }

  if (sub === 'verify') {
    const packetPath = valueAfter(args, '--packet');
    if (!packetPath) {
      console.error(usage());
      return 2;
    }
    let candidate: unknown;
    try {
      candidate = readJson(packetPath, 'packet');
    } catch (err) {
      console.error((err as Error).message);
      return 2;
    }
    const verification = verifyAcceptanceSeal(candidate);
    console.log(JSON.stringify({
      report: 'phase-230-promotion-acceptance-verify-capture',
      ok: verification.ok,
      redactionSafe: true,
      problems: verification.problems,
    }, null, 2));
    return verification.ok ? 0 : 1;
  }

  console.error(usage());
  return 2;
}

process.exit(main());
