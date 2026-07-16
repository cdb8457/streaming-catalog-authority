import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildCoordinatorHandoff, type CoordinatorHandoffInput } from './promotion-handoff.js';

// Offline coordinator-handoff CLI. Summarizes the sealed acceptance packet (and optionally the rehearsal
// and integrity artifacts) into a redaction-safe handoff packet with explicit no-Phase-231/no-live
// language. Never promotes, never touches the real Movies root, never contacts Jellyfin.

function usage(): string {
  return [
    'usage: ops:promotion-handoff --acceptance-packet <f> [--rehearsal-manifest <f>] [--integrity-report <f>] [--out <handoff.json>]',
    '',
    'Local, non-live: emits a redaction-safe coordinator handoff packet. It authorizes NOTHING live and',
    'does not authorize Phase 231. Exit 0 = READY_FOR_COORDINATOR, 1 = NOT_READY.',
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
  const acceptancePath = valueAfter(args, '--acceptance-packet');
  const rehearsalPath = valueAfter(args, '--rehearsal-manifest');
  const integrityPath = valueAfter(args, '--integrity-report');
  const out = valueAfter(args, '--out');
  if (!acceptancePath) {
    console.error(usage());
    return 2;
  }
  let input: CoordinatorHandoffInput;
  try {
    input = {
      acceptancePacket: readJson(acceptancePath, 'acceptance-packet'),
      ...(rehearsalPath ? { rehearsalManifest: readJson(rehearsalPath, 'rehearsal-manifest') } : {}),
      ...(integrityPath ? { integrityReport: readJson(integrityPath, 'integrity-report') } : {}),
    };
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const handoff = buildCoordinatorHandoff(input);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(handoff, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify({
    report: 'phase-230-promotion-coordinator-handoff-capture',
    handoffState: handoff.handoffState,
    authorization: handoff.authorization,
    redactionSafe: true,
    disclaimers: handoff.disclaimers,
    blockers: handoff.blockers,
    handoffDigest: handoff.handoffDigest,
    ...(out ? { outputWritten: true } : {}),
  }, null, 2));
  return handoff.handoffState === 'READY_FOR_COORDINATOR' ? 0 : 1;
}

process.exit(main());
