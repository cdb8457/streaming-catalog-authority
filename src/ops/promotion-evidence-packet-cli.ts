import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildCoordinatorEvidencePacket, type EvidencePacketInput } from './promotion-evidence-packet.js';

// Offline coordinator evidence-packet CLI. Summarizes a fixture evidence bundle (+ optional replay) into
// a redaction-safe packet of digests, test commands, human gates, and no-live language. Never promotes,
// never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-evidence-packet --bundle <bundle.json> [--replay <replay.json>] [--out <packet.json>]',
    '',
    'Local, non-live: EVIDENCE_COMPLETE only when the bundle is BUNDLE_READY and any supplied replay is ok.',
    'It authorizes NOTHING live and does not authorize Phase 231. Exit 0 = COMPLETE, 1 = INCOMPLETE.',
  ].join('\n');
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function readJson(path: string, label: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} file is missing or not valid JSON`); }
}

function main(): number {
  const args = process.argv.slice(2);
  const bundlePath = valueAfter(args, '--bundle');
  const replayPath = valueAfter(args, '--replay');
  const out = valueAfter(args, '--out');
  if (!bundlePath) {
    console.error(usage());
    return 2;
  }
  let input: EvidencePacketInput;
  try {
    input = {
      bundle: readJson(bundlePath, 'bundle'),
      ...(replayPath ? { replay: readJson(replayPath, 'replay') } : {}),
    };
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const packet = buildCoordinatorEvidencePacket(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(packet, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-coordinator-evidence-packet-capture',
    overall: packet.overall,
    authorization: packet.authorization,
    redactionSafe: true,
    digests: packet.digests,
    blockers: packet.blockers,
    packetDigest: packet.packetDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return packet.overall === 'EVIDENCE_COMPLETE' ? 0 : 1;
}

process.exit(main());
